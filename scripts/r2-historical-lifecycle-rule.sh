#!/usr/bin/env bash
set -euo pipefail

# Install a narrowly-scoped safety-net rule while preserving every unrelated
# bucket lifecycle rule.

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

rule_id="${R2_HISTORICAL_MULTIPART_RULE_ID:-historical-checkpoint-abort-incomplete}"
rule_prefix="${R2_HISTORICAL_CHECKPOINT_PREFIX:-checkpoints/historical/versions/}"
abort_days="${R2_HISTORICAL_MULTIPART_ABORT_DAYS:-2}"
test "$abort_days" -ge 1

apply_rule_cloudflare_api() {
  local dir response current next verify api
  test -n "${CLOUDFLARE_API_TOKEN:-}" || {
    echo "::error::S3 credentials cannot manage bucket lifecycle and CLOUDFLARE_API_TOKEN is unavailable." >&2
    return 49
  }
  dir=$(mktemp -d); response="$dir/response.json"; current="$dir/current.json"; next="$dir/next.json"; verify="$dir/verify.json"
  api="https://api.cloudflare.com/client/v4/accounts/${R2_ACCOUNT_ID}/r2/buckets/${bucket}/lifecycle"
  curl --fail-with-body --silent --show-error --retry 7 --retry-all-errors --connect-timeout 20 \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$api" > "$response"
  python3 - "$response" "$current" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); result=d.get("result") or {}; rules=result.get("rules",[]) if isinstance(result,dict) else result
json.dump({"rules":rules or []},open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  python3 - "$current" "$next" "$rule_id" "$rule_prefix" "$abort_days" <<'PY'
import json,sys
source,out,rule_id,prefix,days=sys.argv[1:]
rules=[r for r in json.load(open(source)).get("rules",[]) if r.get("id")!=rule_id]
rules.append({"id":rule_id,"enabled":True,"conditions":{"prefix":prefix},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":int(days)*86400}}})
json.dump({"rules":rules},open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
  curl --fail-with-body --silent --show-error --retry 7 --retry-all-errors --connect-timeout 20 \
    -X PUT -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json' --data-binary "@${next}" "$api" > "$response"
  curl --fail-with-body --silent --show-error --retry 7 --retry-all-errors --connect-timeout 20 \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$api" > "$verify"
  python3 - "$verify" "$rule_id" "$rule_prefix" "$abort_days" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); result=d.get("result") or {}; rules=result.get("rules",[]) if isinstance(result,dict) else result
matches=[r for r in (rules or []) if r.get("id")==sys.argv[2]]
if len(matches)!=1: raise SystemExit("Cloudflare lifecycle rule was not uniquely installed")
r=matches[0]; c=(r.get("abortMultipartUploadsTransition") or {}).get("condition") or {}
if not r.get("enabled") or (r.get("conditions") or {}).get("prefix")!=sys.argv[3] or int(c.get("maxAge",-1))!=int(sys.argv[4])*86400:
    raise SystemExit("Cloudflare lifecycle rule verification mismatch")
PY
  rm -r -- "$dir"
}

apply_rule() {
  local dir current next verify out err
  dir=$(mktemp -d); current="$dir/current.json"; next="$dir/next.json"; verify="$dir/verify.json"; out="$dir/out"; err="$dir/err"
  if ! r2_retry_to_files "$current" "$err" s3api get-bucket-lifecycle-configuration --bucket "$bucket" --output json; then
    if grep -Eiq 'NoSuchLifecycleConfiguration|does not exist' "$err"; then
      printf '{"Rules":[]}\n' > "$current"
    elif grep -Eiq 'AccessDenied|Access Denied' "$err"; then
      rm -r -- "$dir"
      apply_rule_cloudflare_api
      echo "Historical incomplete multipart lifecycle rule is enabled through the Cloudflare API."
      return 0
    else
      rm -r -- "$dir"
      return 47
    fi
  fi
  python3 - "$current" "$next" "$rule_id" "$rule_prefix" "$abort_days" <<'PY'
import json,sys
source,out,rule_id,prefix,days=sys.argv[1:]
try: data=json.load(open(source))
except Exception: data={"Rules":[]}
rules=[r for r in data.get("Rules",[]) if r.get("ID")!=rule_id]
rules.append({
  "ID":rule_id,
  "Status":"Enabled",
  "Filter":{"Prefix":prefix},
  "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":int(days)},
})
json.dump({"Rules":rules},open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
  r2_retry_to_files "$out" "$err" s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration "file://${next}"
  r2_retry_to_files "$verify" "$err" s3api get-bucket-lifecycle-configuration --bucket "$bucket" --output json
  python3 - "$verify" "$rule_id" "$rule_prefix" "$abort_days" <<'PY'
import json,sys
d,rule_id,prefix,days=json.load(open(sys.argv[1])),sys.argv[2],sys.argv[3],int(sys.argv[4])
matches=[r for r in d.get("Rules",[]) if r.get("ID")==rule_id]
if len(matches)!=1: raise SystemExit("Historical multipart lifecycle rule was not uniquely installed")
r=matches[0]
if r.get("Status")!="Enabled" or (r.get("Filter") or {}).get("Prefix")!=prefix:
    raise SystemExit("Historical multipart lifecycle rule scope mismatch")
if int((r.get("AbortIncompleteMultipartUpload") or {}).get("DaysAfterInitiation",-1))!=days:
    raise SystemExit("Historical multipart lifecycle rule age mismatch")
PY
  echo "Historical incomplete multipart lifecycle rule is enabled for the checkpoint prefix."
  rm -r -- "$dir"
}

case "${1:-apply}" in
  apply) apply_rule ;;
  *) echo "Usage: $0 apply" >&2; exit 2 ;;
esac
