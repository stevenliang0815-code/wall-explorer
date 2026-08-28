#!/usr/bin/env bash
set -euo pipefail

operation="${1:-plan}"
gc_owner="${GC_OWNER:-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}-gc}"

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

optional_json() {
  local key="$1" path="$2"
  if object_exists "$key"; then
    download_object "$key" "$path"
  else
    printf 'null\n' > "$path"
  fi
}

control_fingerprint() {
  local key
  for key in "$checkpoint_pointer_key" "$snapshot_pointer_key" "$state_key" "$pending_checkpoint_key" "$lease_key"; do
    if object_exists "$key"; then printf '%s\t%s\n' "$key" "$(object_etag "$key")"; else printf '%s\tABSENT\n' "$key"; fi
  done
  printf 'multipart\t%s\n' "$(r2 s3api list-multipart-uploads --bucket "$bucket" --output json | sha256sum | awk '{print $1}')"
}

make_plan() {
  local dir="$1" objects="$dir/objects.json" uploads="$dir/uploads.json" input="$dir/input.json" plan="$dir/plan.json"
  r2 s3api list-objects-v2 --bucket "$bucket" --output json > "$objects"
  r2 s3api list-multipart-uploads --bucket "$bucket" --output json > "$uploads"
  printf '[]\n' > "$dir/multipart.json"
  python3 - "$uploads" <<'PY' > "$dir/upload-pairs.tsv"
import base64,json,sys
for u in json.load(open(sys.argv[1])).get("Uploads",[]): print(base64.b64encode(u["Key"].encode()).decode(),base64.b64encode(u["UploadId"].encode()).decode(),sep="\t")
PY
  local key64 upload64 key upload_id parts bytes
  printf '' > "$dir/multipart.ndjson"
  while IFS=$'\t' read -r key64 upload64; do
    [ -n "$key64" ] || continue
    key=$(printf '%s' "$key64" | base64 --decode)
    upload_id=$(printf '%s' "$upload64" | base64 --decode)
    parts="$dir/parts-$(wc -l < "$dir/multipart.ndjson").json"
    r2 s3api list-parts --bucket "$bucket" --key "$key" --upload-id "$upload_id" --output json > "$parts"
    bytes=$(python3 -c 'import json,sys; print(sum(int(p.get("Size",0)) for p in json.load(open(sys.argv[1])).get("Parts",[])))' "$parts")
    python3 - "$key" "$upload_id" "$bytes" >> "$dir/multipart.ndjson" <<'PY'
import json,sys
print(json.dumps({"key":sys.argv[1],"uploadId":sys.argv[2],"bytes":int(sys.argv[3])},separators=(",", ":")))
PY
  done < "$dir/upload-pairs.tsv"
  python3 - "$dir/multipart.ndjson" "$dir/multipart.json" <<'PY'
import json,sys
items=[json.loads(x) for x in open(sys.argv[1]) if x.strip()]; json.dump(items,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  optional_json "$checkpoint_pointer_key" "$dir/raw.json"
  optional_json "$snapshot_pointer_key" "$dir/snapshot.json"
  optional_json "$state_key" "$dir/state.json"
  optional_json "$pending_checkpoint_key" "$dir/pending.json"
  optional_json "$lease_key" "$dir/lease.json"
  printf 'null\n' > "$dir/rollback.json"
  python3 - "$objects" "$dir/raw.json" "$dir/snapshot.json" "$dir/state.json" "$dir/pending.json" "$dir/lease.json" "$dir/rollback.json" "$input" <<'PY'
import json,sys
objects,raw,snapshot,state,pending,lease,rollback,out=sys.argv[1:]
d={"objects":[{"key":x["Key"],"bytes":int(x.get("Size",0))} for x in json.load(open(objects)).get("Contents",[])],"checkpointPointer":json.load(open(raw)),"snapshotPointer":json.load(open(snapshot)),"state":json.load(open(state)),"pending":json.load(open(pending)),"lease":json.load(open(lease)),"rollback":json.load(open(rollback))}
json.dump(d,open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
  node scripts/historical-lifecycle.mjs gc-plan "$input" > "$plan"
  cp "$plan" "$dir/plan-output.json"
}

print_plan() {
  local plan="$1" multipart="${2:-}"
  python3 - "$plan" "$multipart" <<'PY'
import json,sys
p=json.load(open(sys.argv[1])); print("KEEP LIST")
for key in p["keep"]: print(f"KEEP\t{key}")
print("DELETE LIST")
for key in p["delete"]: print(f"DELETE\t{key}")
uploads=json.load(open(sys.argv[2])) if sys.argv[2] else []
print("ABORT MULTIPART LIST")
for upload in uploads: print(f"ABORT\t{upload['key']}\t{upload['uploadId']}\t{upload['bytes']}")
print(f"keep={len(p['keep'])} delete={len(p['delete'])} ignored={len(p['ignored'])}")
PY
}

run_gc() {
  local dir fingerprint_before fingerprint_after key
  dir=$(mktemp -d)
  fingerprint_before=$(control_fingerprint)
  make_plan "$dir"
  print_plan "$dir/plan.json" "$dir/multipart.json"
  if [ "$operation" = plan ]; then rm -r -- "$dir"; return 0; fi
  [ "$operation" = apply ] || { rm -r -- "$dir"; echo "Usage: $0 {plan|apply}" >&2; return 2; }
  [ "${GC_APPLY:-false}" = true ] || { rm -r -- "$dir"; echo "::error::GC apply requires GC_APPLY=true." >&2; return 43; }
  if object_exists "$stop_key" && [ "${GC_ALLOW_WHILE_PAUSED:-false}" != true ]; then
    rm -r -- "$dir"
    echo "::error::GC deletion is blocked while the durable pause marker exists." >&2
    return 43
  fi
  state=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print((d or {}).get("state","BACKFILLING"))' "$dir/state.json")
  case "$state" in CHECKPOINT_UPLOADING|COMPRESSED_UPLOADING) rm -r -- "$dir"; echo "::error::GC cannot abort multipart while an upload state is active." >&2; return 45 ;; esac
  fingerprint_after=$(control_fingerprint)
  test "$fingerprint_before" = "$fingerprint_after" || { rm -r -- "$dir"; echo "::error::Control plane changed after GC planning; delete list discarded." >&2; return 48; }
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    r2_destructive s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
  done < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["delete"]))' "$dir/plan.json")
  while IFS=$'\t' read -r key upload_id; do
    [ -n "$key" ] || continue
    r2_destructive s3api abort-multipart-upload --bucket "$bucket" --key "$key" --upload-id "$upload_id" >/dev/null
  done < <(python3 - "$dir/multipart.json" <<'PY'
import json,sys
for u in json.load(open(sys.argv[1])): print(u["key"],u["uploadId"],sep="\t")
PY
)
  rm -r -- "$dir"
}

run_gc
