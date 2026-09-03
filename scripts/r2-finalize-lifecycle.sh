#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
output_root="${SNAPSHOT_OUTPUT_ROOT:-snapshot-output}"
expected_last_date="${SNAPSHOT_EXPECTED_LAST_DATE:-2025-12-28}"
snapshot_versions_prefix="snapshots/historical/versions/"
snapshot_uploads_prefix="jobs/historical/uploads/"
pending_snapshot_key="jobs/historical/pending-snapshot.json"
local_reserve_bytes="${R2_LOCAL_RESERVE_BYTES:-1000000000}"

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

state_name() {
  local file
  file=$(mktemp)
  if object_exists "$state_key"; then
    download_object "$state_key" "$file"
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("state","BACKFILLING"))' "$file"
  else
    printf 'BACKFILLING\n'
  fi
  rm -f -- "$file"
}

local_space_guard() {
  local required="$1" path="${2:-${RUNNER_TEMP:-/tmp}}" free
  free=$(df --output=avail -B1 "$path" | tail -1 | tr -d ' ')
  echo "Local free bytes: $free"
  echo "Local required bytes: $required"
  test "$free" -gt "$required" || {
    echo "::error::Runner disk is too small for safe finalization." >&2
    return 42
  }
}

validate_raw_100() {
  local db="$1" status="$2" report="$3"
  python3 - "$db" "$status" "$report" "$expected_last_date" <<'PY'
import datetime,hashlib,json,os,sqlite3,sys
db,status_path,out,expected_last=sys.argv[1:]
for suffix in ("-wal","-journal"):
    if os.path.exists(db+suffix) and os.path.getsize(db+suffix): raise SystemExit(f"SQLite {suffix} is not empty")
s=json.load(open(status_path)); progress=float(s.get("progress",-1))
if progress != 100 or s.get("status") != "complete": raise SystemExit("Raw checkpoint is not complete at 100%")
if s.get("currentDate") != expected_last: raise SystemExit("Unexpected final completed date")
if int(s.get("overallCompletedUnits",-1)) != int(s.get("totalUnits",-2)): raise SystemExit("Historical units are incomplete")
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
try:
    integrity=con.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok": raise SystemExit(f"integrity_check failed: {integrity}")
    rows=int(con.execute("SELECT count(*) FROM historical_observations").fetchone()[0])
    duplicates=int(con.execute("SELECT count(*) FROM (SELECT market,code,trading_date,count(*) n FROM historical_observations GROUP BY market,code,trading_date HAVING n>1)").fetchone()[0])
    unresolved_units=int(con.execute("SELECT count(*) FROM builder_checkpoints WHERE status NOT IN ('completed','validated_empty')").fetchone()[0])
    survivor=int(con.execute("SELECT count(*) FROM historical_observations WHERE source_scope!='full_market_daily'").fetchone()[0])
    lookahead=int(con.execute("SELECT count(*) FROM historical_observations WHERE substr(usable_from,1,10)<=trading_date").fetchone()[0])
    schema=int(con.execute("PRAGMA user_version").fetchone()[0])
finally: con.close()
print(f"FINALIZE_SEMANTIC_COUNTS=duplicates:{duplicates},unresolvedUnits:{unresolved_units},survivorshipViolations:{survivor},lookaheadViolations:{lookahead}")
if any((duplicates,unresolved_units,survivor,lookahead)): raise SystemExit("Semantic validation failed")
stored=int(s.get("storedRows",rows)); continuation=int(s.get("continuationRows",0))
if rows+continuation != stored: raise SystemExit("Row count mismatch")
h=hashlib.sha256()
with open(db,"rb") as f:
    for chunk in iter(lambda:f.read(8*1024*1024),b""): h.update(chunk)
d={"format":"wall-explorer-historical-raw-final-v1","rawBytes":os.path.getsize(db),"rawSha256":h.hexdigest(),"rows":stored,"segmentRows":rows,"lastDate":s["currentDate"],"schemaVersion":schema,"progress":100,"integrityCheck":"ok","duplicates":0,"failedUnits":0,"survivorshipViolations":0,"lookaheadViolations":0,"wal":"clean","validatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}
json.dump(d,open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
}

read_raw_pointer() {
  local file="$1"
  object_exists "$checkpoint_pointer_key" || { echo "::error::Raw checkpoint pointer is missing." >&2; return 47; }
  download_object "$checkpoint_pointer_key" "$file"
  python3 - "$file" <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1])); key=p.get("objectKey")
if p.get("status") != "raw-100-percent" or float(p.get("progress",-1)) != 100: raise SystemExit("Finalize accepts only a 100% verified raw pointer")
if not isinstance(key,str) or not re.fullmatch(r"checkpoints/historical/versions/builder-[a-f0-9]{64}\.sqlite",key): raise SystemExit("Raw pointer is not immutable/versioned")
PY
}

download_and_validate_raw() {
  local dir="$1" pointer="$dir/raw-pointer.json" key status manifest expected_bytes expected_sha
  read_raw_pointer "$pointer"
  key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pointer")
  status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["statusKey"])' "$pointer")
  manifest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifestKey"])' "$pointer")
  expected_bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$pointer")
  expected_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$pointer")
  local_space_guard $((expected_bytes + local_reserve_bytes)) "$dir"
  verify_remote_object "$key" "$expected_bytes" "$expected_sha"
  download_object "$key" "$dir/raw.sqlite"
  download_object "$status" "$dir/raw-status.json"
  download_object "$manifest" "$dir/raw-manifest.json"
  validate_raw_100 "$dir/raw.sqlite" "$dir/raw-status.json" "$dir/raw-validation.json"
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rawSha256"])' "$dir/raw-validation.json")" = "$expected_sha"
}

verify_remote_gzip() {
  local key="$1" expected_bytes="$2" expected_gzip_sha="$3" expected_raw_sha="$4" actual_bytes actual_gzip_sha actual_raw_sha
  actual_bytes=$(object_size "$key")
  test "$actual_bytes" -eq "$expected_bytes"
  actual_gzip_sha=$(remote_sha256 "$key")
  test "$actual_gzip_sha" = "$expected_gzip_sha"
  r2 s3 cp "s3://${bucket}/${key}" - --only-show-errors | gzip -t
  actual_raw_sha=$(r2 s3 cp "s3://${bucket}/${key}" - --only-show-errors | gzip -dc | sha256sum | awk '{print $1}')
  test "$actual_raw_sha" = "$expected_raw_sha"
}

verify_remote_gzip_sqlite() {
  local dir="$1" key="$2" status="$3" expected_raw_sha="$4"
  rm -f -- "$dir/raw.sqlite" "$dir/final-roundtrip.sqlite"
  r2 s3 cp "s3://${bucket}/${key}" - --only-show-errors | gzip -dc > "$dir/final-roundtrip.sqlite"
  test "$(sha256sum "$dir/final-roundtrip.sqlite" | awk '{print $1}')" = "$expected_raw_sha"
  validate_raw_100 "$dir/final-roundtrip.sqlite" "$status" "$dir/final-roundtrip-validation.json"
}

finalize_raw_pointer() {
  local dir etag raw snapshot finalized raw_sha snapshot_raw_sha
  dir=$(mktemp -d)
  raw="$dir/raw-pointer.json"
  snapshot="$dir/snapshot-pointer.json"
  finalized="$dir/finalized-raw-pointer.json"
  download_object "$checkpoint_pointer_key" "$raw"
  if [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$raw")" = finalized ]; then
    rm -r -- "$dir"
    return 0
  fi
  download_object "$snapshot_pointer_key" "$snapshot"
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$raw")" = raw-100-percent
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$snapshot")" = verified
  raw_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$raw")
  snapshot_raw_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rawSha256"])' "$snapshot")
  test "$raw_sha" = "$snapshot_raw_sha" || { rm -r -- "$dir"; echo "::error::Snapshot does not supersede the current raw pointer." >&2; return 48; }
  etag=$(object_etag "$checkpoint_pointer_key")
  python3 - "$raw" "$finalized" "$snapshot_pointer_key" <<'PY'
import datetime,json,sys
p=json.load(open(sys.argv[1])); old_key=p["objectKey"]; old_status=p["statusKey"]; old_manifest=p["manifestKey"]
p.update({"objectKey":None,"statusKey":None,"manifestKey":None,"status":"finalized","compression":"none","supersededBy":sys.argv[3],"previousRawObjectKey":old_key,"previousStatusKey":old_status,"previousManifestKey":old_manifest,"finalizedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")})
json.dump(p,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  put_json_cas "$finalized" "$checkpoint_pointer_key" "$etag"
  rm -r -- "$dir"
}

raw_cleanup() {
  local dir pointer snapshot raw_key status_key manifest_key checksum_key snapshot_key snapshot_bytes snapshot_sha
  dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/raw-cleanup.XXXXXX")
  pointer="$dir/raw-pointer.json"
  snapshot="$dir/snapshot-pointer.json"
  download_object "$checkpoint_pointer_key" "$pointer"
  download_object "$snapshot_pointer_key" "$snapshot"
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$pointer")" = finalized
  raw_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["previousRawObjectKey"])' "$pointer")
  status_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["previousStatusKey"])' "$pointer")
  manifest_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["previousManifestKey"])' "$pointer")
  checksum_key="${raw_key}.sha256"
  snapshot_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$snapshot")
  snapshot_bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compressedBytes"])' "$snapshot")
  snapshot_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compressedSha256"])' "$snapshot")
  verify_remote_object "$snapshot_key" "$snapshot_bytes" "$snapshot_sha"
  test "$raw_key" != "$snapshot_key"
  for key in "$raw_key" "$status_key" "$manifest_key" "$checksum_key"; do
    object_exists "$key" || continue
    r2_destructive s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
  done
  object_exists "$pending_snapshot_key" && r2_destructive s3api delete-object --bucket "$bucket" --key "$pending_snapshot_key" >/dev/null
  state_transition COMPLETE '{"cleanupPending":false,"upload":null}'
  rm -r -- "$dir"
}

finalize() {
  local current dir raw_sha raw_bytes gzip_sha gzip_bytes version key checksum_key manifest_key descriptor_key
  local manifest pointer state_patch
  require_not_stopped
  current=$(state_name)
  if [ "$current" = COMPLETE ]; then echo "Final snapshot is already complete."; return 0; fi
  if [ "$current" = RAW_CLEANUP ]; then raw_cleanup; return 0; fi
  if [ "$current" = COMPRESSED_PROMOTED ]; then
    finalize_raw_pointer
    state_transition RAW_CLEANUP '{"cleanupPending":true}'
    raw_cleanup
    return 0
  fi
  case "$current" in
    RAW_100_PERCENT) state_transition FINALIZING '{}'; current=FINALIZING ;;
    FINALIZING|COMPRESSED_UPLOADING|COMPRESSED_VERIFYING) ;;
    *) echo "::error::Finalize cannot resume from state $current" >&2; return 45 ;;
  esac
  dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/historical-finalize.XXXXXX")
  download_and_validate_raw "$dir"
  raw_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rawSha256"])' "$dir/raw-validation.json")
  raw_bytes=$(stat -c '%s' "$dir/raw.sqlite")
  local_space_guard $((raw_bytes + local_reserve_bytes)) "$dir"
  gzip -9n -c "$dir/raw.sqlite" > "$dir/raw.sqlite.gz"
  gzip -t "$dir/raw.sqlite.gz"
  test "$(gzip -dc "$dir/raw.sqlite.gz" | sha256sum | awk '{print $1}')" = "$raw_sha"
  gzip_sha=$(sha256sum "$dir/raw.sqlite.gz" | awk '{print $1}')
  gzip_bytes=$(stat -c '%s' "$dir/raw.sqlite.gz")
  version="$raw_sha"
  key="${snapshot_versions_prefix}builder-${version}.sqlite.gz"
  checksum_key="${key}.sha256"
  manifest_key="${key}.manifest.json"
  descriptor_key="${snapshot_uploads_prefix}snapshot-${version}.json"
  manifest="$dir/snapshot-manifest.json"
  python3 - "$dir/raw-validation.json" "$manifest" "$key" "$manifest_key" "$gzip_sha" "$gzip_bytes" <<'PY'
import datetime,json,sys
raw,out,key,manifest_key,gzip_sha,gzip_bytes=sys.argv[1:]
r=json.load(open(raw)); d={"format":"wall-explorer-historical-compressed-manifest-v1","version":r["rawSha256"],"objectKey":key,"compressedBytes":int(gzip_bytes),"compressedSha256":gzip_sha,"rawBytes":r["rawBytes"],"rawSha256":r["rawSha256"],"rows":r["rows"],"lastDate":r["lastDate"],"schemaVersion":r["schemaVersion"],"progress":100,"compression":"gzip-9-n","gzipTest":"pass","roundtripSha256":"match","integrityCheck":"ok","manifestKey":manifest_key,"createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}; json.dump(d,open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
  printf '%s\n' "$gzip_sha" > "$dir/snapshot.sha256"
  projected_peak_guard "$gzip_bytes"
  state_patch=$(python3 - "$key" "$gzip_bytes" "$gzip_sha" "$descriptor_key" <<'PY'
import json,sys
print(json.dumps({"upload":{"objectKey":sys.argv[1],"expectedSize":int(sys.argv[2]),"sha256":sys.argv[3],"descriptorKey":sys.argv[4]}},separators=(",", ":")))
PY
)
  if [ "$current" = FINALIZING ]; then
    state_transition COMPRESSED_UPLOADING "$state_patch"
    current=COMPRESSED_UPLOADING
  elif [ "$current" = COMPRESSED_UPLOADING ]; then
    state_transition COMPRESSED_UPLOADING "$state_patch"
  fi
  explicit_multipart_upload "$dir/raw.sqlite.gz" "$key" "$descriptor_key" "$gzip_sha"
  if [ "$current" = COMPRESSED_UPLOADING ]; then
    state_transition COMPRESSED_VERIFYING '{}'
    current=COMPRESSED_VERIFYING
  fi
  verify_remote_gzip "$key" "$gzip_bytes" "$gzip_sha" "$raw_sha"
  rm -f -- "$dir/raw.sqlite" "$dir/raw.sqlite.gz"
  verify_remote_gzip_sqlite "$dir" "$key" "$dir/raw-status.json" "$raw_sha"
  put_small_immutable "$dir/snapshot.sha256" "$checksum_key" text/plain
  put_small_immutable "$manifest" "$manifest_key" application/json
  if object_exists "$pending_snapshot_key"; then
    download_object "$pending_snapshot_key" "$dir/existing-pending-snapshot.json"
    test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$dir/existing-pending-snapshot.json")" = "$key"
    test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compressedSha256"])' "$dir/existing-pending-snapshot.json")" = "$gzip_sha"
  else
    put_json_cas "$manifest" "$pending_snapshot_key" ABSENT
  fi

  pointer="$dir/snapshot-pointer.json"
  python3 - "$manifest" "$pointer" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); p={k:m[k] for k in ("format","version","objectKey","compressedBytes","compressedSha256","rawBytes","rawSha256","rows","lastDate","schemaVersion","progress","compression","manifestKey","createdAt")}; p["format"]="wall-explorer-historical-snapshot-pointer-v1"; p["status"]="verified"; json.dump(p,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  if object_exists "$snapshot_pointer_key"; then
    download_object "$snapshot_pointer_key" "$dir/existing-snapshot-pointer.json"
    if [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("objectKey",""))' "$dir/existing-snapshot-pointer.json")" != "$key" ]; then
      echo "::error::A different final snapshot pointer already exists." >&2; return 48
    fi
  else
    put_json_cas "$pointer" "$snapshot_pointer_key" ABSENT
  fi
  download_object "$snapshot_pointer_key" "$dir/committed-snapshot-pointer.json"
  test "$(sha256sum "$dir/committed-snapshot-pointer.json" | awk '{print $1}')" = "$(sha256sum "$pointer" | awk '{print $1}')"
  verify_remote_gzip "$key" "$gzip_bytes" "$gzip_sha" "$raw_sha"
  state_transition COMPRESSED_PROMOTED '{}'
  finalize_raw_pointer
  state_transition RAW_CLEANUP '{"cleanupPending":true,"upload":null}'
  rm -r -- "$dir"
  raw_cleanup
}

is_ready() {
  local file state
  file=$(mktemp)
  read_raw_pointer "$file" >/dev/null 2>&1 || { rm -f -- "$file"; return 1; }
  state=$(state_name)
  rm -f -- "$file"
  [ "$state" = RAW_100_PERCENT ] || [ "$state" = FINALIZING ] || [ "$state" = COMPRESSED_UPLOADING ] || [ "$state" = COMPRESSED_VERIFYING ] || [ "$state" = COMPRESSED_PROMOTED ] || [ "$state" = RAW_CLEANUP ]
}

case "$operation" in
  finalize) finalize ;;
  is-ready) is_ready ;;
  raw-cleanup) raw_cleanup ;;
  *) echo "Usage: $0 {finalize|is-ready|raw-cleanup}" >&2; exit 2 ;;
esac
