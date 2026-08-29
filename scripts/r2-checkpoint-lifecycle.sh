#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
output_root="${SNAPSHOT_OUTPUT_ROOT:-snapshot-output}"
snapshot_version="${SNAPSHOT_VERSION:-2026-08-17-v1}"
release_dir="${output_root}/historical-${snapshot_version%-v1}"
work_dir="${output_root}/historical-${snapshot_version%-v1}.building"
legacy_checkpoint_key="checkpoints/historical/builder.sqlite"
legacy_checksum_key="checksums/historical/builder.sqlite.sha256"
legacy_status_key="jobs/historical/status.json"
legacy_candidate_prefix="checkpoints/historical/candidates/"
versions_prefix="checkpoints/historical/versions/"
uploads_prefix="jobs/historical/uploads/"

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

checkpoint_db_path() {
  if [ -f "$work_dir/historical.sqlite" ]; then
    printf '%s\n' "$work_dir/historical.sqlite"
  else
    printf '%s\n' "$release_dir/historical.sqlite"
  fi
}

resolve_checkpoint_json() {
  local dir pointer list count key checksum status bytes sha manifest
  dir=$(mktemp -d)
  if object_exists "$checkpoint_pointer_key"; then
    pointer="$dir/pointer.json"
    download_object "$checkpoint_pointer_key" "$pointer"
    python3 - "$pointer" <<'PY'
import json, re, sys
p=json.load(open(sys.argv[1])); key=p.get("objectKey")
if p.get("status") == "finalized" and key is None: raise SystemExit("Raw checkpoint has already been finalized")
if not isinstance(key,str) or not re.fullmatch(r"checkpoints/historical/versions/builder-[a-f0-9]{64}\.sqlite",key): raise SystemExit("Invalid raw checkpoint pointer")
print(json.dumps({"source":"versioned-pointer","objectKey":key,"bytes":int(p["bytes"]),"sha256":p["sha256"],"statusKey":p["statusKey"],"manifestKey":p["manifestKey"],"pointer":p},separators=(",", ":")))
PY
    rm -r -- "$dir"
    return
  fi
  if object_exists "$legacy_checkpoint_key"; then
    bytes=$(object_size "$legacy_checkpoint_key")
    sha="-"
    object_exists "$legacy_checksum_key" && sha=$(r2 s3 cp "s3://${bucket}/${legacy_checksum_key}" - --only-show-errors | tr -d '[:space:]')
    python3 - "$legacy_checkpoint_key" "$bytes" "$sha" "$legacy_status_key" <<'PY'
import json,sys
print(json.dumps({"source":"legacy-canonical","objectKey":sys.argv[1],"bytes":int(sys.argv[2]),"sha256":sys.argv[3],"statusKey":sys.argv[4],"manifestKey":None},separators=(",", ":")))
PY
    rm -r -- "$dir"
    return
  fi
  list="$dir/candidates.json"
  r2 s3api list-objects-v2 --bucket "$bucket" --prefix "$legacy_candidate_prefix" --output json > "$list"
  count=$(python3 - "$list" <<'PY'
import json,sys
print(sum(1 for x in json.load(open(sys.argv[1])).get("Contents",[]) if x.get("Key","").endswith("/builder.sqlite")))
PY
)
  test "$count" -le 1 || { rm -r -- "$dir"; echo "::error::Multiple legacy candidates exist; refusing to guess." >&2; return 45; }
  test "$count" -eq 1 || { rm -r -- "$dir"; return 1; }
  key=$(python3 - "$list" <<'PY'
import json,sys
print(next(x["Key"] for x in json.load(open(sys.argv[1])).get("Contents",[]) if x.get("Key","").endswith("/builder.sqlite")))
PY
)
  checksum="${key}.sha256"
  status="${key%/builder.sqlite}/status.json"
  object_exists "$checksum" && object_exists "$status" || { rm -r -- "$dir"; echo "::error::Legacy candidate lacks verified sidecars." >&2; return 46; }
  bytes=$(object_size "$key")
  sha=$(r2 s3 cp "s3://${bucket}/${checksum}" - --only-show-errors | tr -d '[:space:]')
  python3 - "$key" "$bytes" "$sha" "$status" "$checksum" <<'PY'
import json,sys
print(json.dumps({"source":"verified-legacy-candidate","objectKey":sys.argv[1],"bytes":int(sys.argv[2]),"sha256":sys.argv[3],"statusKey":sys.argv[4],"checksumKey":sys.argv[5],"manifestKey":None},separators=(",", ":")))
PY
  rm -r -- "$dir"
}

validate_sqlite() {
  local db="$1" status="$2" report="$3"
  python3 - "$db" "$status" "$report" "${SNAPSHOT_EXPECTED_LAST_DATE:-2025-12-28}" <<'PY'
import datetime,hashlib,json,os,sqlite3,sys
db,status_path,out,expected_last=sys.argv[1:]
for suffix in ("-wal","-journal"):
    if os.path.exists(db+suffix) and os.path.getsize(db+suffix): raise SystemExit(f"SQLite {suffix} is not empty")
s=json.load(open(status_path)); progress=float(s.get("progress",-1))
if not 0 <= progress <= 100: raise SystemExit("Progress outside 0..100")
if not s.get("currentDate"): raise SystemExit("Missing last completed date")
if progress == 100:
    if s.get("status") != "complete": raise SystemExit("100% checkpoint status is not complete")
    if s.get("currentDate") != expected_last: raise SystemExit("Unexpected final completed date")
    if int(s.get("overallCompletedUnits",-1)) != int(s.get("totalUnits",-2)): raise SystemExit("100% checkpoint units are incomplete")
    if int(s.get("failedUnits",0)) != 0: raise SystemExit("100% checkpoint contains failed units")
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
try:
    integrity=con.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok": raise SystemExit(f"integrity_check failed: {integrity}")
    rows=int(con.execute("SELECT count(*) FROM historical_observations").fetchone()[0])
    schema=int(con.execute("PRAGMA user_version").fetchone()[0])
finally: con.close()
h=hashlib.sha256()
with open(db,"rb") as f:
    for chunk in iter(lambda:f.read(8*1024*1024),b""): h.update(chunk)
stored=int(s.get("storedRows",rows)); continuation=int(s.get("continuationRows",0))
if rows+continuation != stored: raise SystemExit("Row count does not match durable status")
d={"format":"wall-explorer-historical-checkpoint-manifest-v3","version":h.hexdigest(),"bytes":os.path.getsize(db),"sha256":h.hexdigest(),"rows":stored,"segmentRows":rows,"progress":progress,"lastDate":s["currentDate"],"lastCompletedUnit":int(s.get("overallCompletedUnits",0)),"schemaVersion":schema,"overallCompletedUnits":int(s.get("overallCompletedUnits",0)),"totalUnits":int(s.get("totalUnits",0)),"failedUnits":int(s.get("failedUnits",0)),"integrityCheck":"ok","wal":"clean","status":"validated-before-upload","createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}
json.dump(d,open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
print("CHECKPOINT_PREUPLOAD_VALIDATION="+json.dumps({k:d[k] for k in ("bytes","sha256","rows","progress","lastDate","lastCompletedUnit","totalUnits","failedUnits","schemaVersion","integrityCheck","wal")},separators=(",", ":")))
PY
}

validate_downloaded_checkpoint() {
  local db="$1" status="$2" manifest="$3" report="$4" expected expected_sha expected_bytes
  validate_sqlite "$db" "$status" "$report"
  expected_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$manifest")
  expected_bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$manifest")
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$report")" = "$expected_sha"
  test "$(stat -c '%s' "$db")" -eq "$expected_bytes"
  python3 - "$manifest" "$report" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
for key in ("bytes","sha256","rows","progress","lastDate","schemaVersion","overallCompletedUnits","totalUnits"):
    if a.get(key)!=b.get(key): raise SystemExit(f"Downloaded checkpoint metadata mismatch: {key}")
PY
}

restore() {
  local resolved key bytes sha status actual_sha
  mkdir -p "$work_dir" "$output_root"
  if ! resolved=$(resolve_checkpoint_json); then
    echo "No durable checkpoint exists; starting a fresh historical segment."
    return
  fi
  key=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["objectKey"])' "$resolved")
  bytes=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["bytes"])' "$resolved")
  sha=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sha256"])' "$resolved")
  status=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["statusKey"])' "$resolved")
  download_object "$key" "$work_dir/historical.sqlite"
  test "$(stat -c '%s' "$work_dir/historical.sqlite")" -eq "$bytes"
  if [ "$sha" != "-" ]; then
    actual_sha=$(sha256sum "$work_dir/historical.sqlite" | awk '{print $1}')
    test "$actual_sha" = "$sha"
  fi
  download_object "$status" "$output_root/job-status.json"
  cp "$output_root/job-status.json" "$output_root/restored-status.json"
  printf '%s\n' "$resolved" > "$output_root/restored-source.json"
  echo "Restored: $key"
}

upload_checkpoint() {
  local db status manifest version key checksum_key status_key manifest_key descriptor_key pending pointer_etag previous previous_key previous_source
  local bytes sha owner patch
  require_not_stopped
  require_large_write_allowed
  db=$(checkpoint_db_path)
  status="$output_root/job-status.json"
  test -f "$db" && test -f "$status"
  mkdir -p "$output_root"
  manifest="$output_root/checkpoint-manifest.json"
  validate_sqlite "$db" "$status" "$manifest"
  version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest")
  bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$manifest")
  sha="$version"
  key="${versions_prefix}builder-${version}.sqlite"
  checksum_key="${key}.sha256"
  status_key="${key}.status.json"
  manifest_key="${key}.manifest.json"
  descriptor_key="${uploads_prefix}checkpoint-${version}.json"
  printf '%s\n' "$sha" > "$output_root/checkpoint.sha256"

  previous='{}'
  if previous=$(resolve_checkpoint_json); then :; else previous='{}'; fi
  previous_key=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("objectKey","none"))' "$previous")
  previous_source=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("source","none"))' "$previous")
  if object_exists "$checkpoint_pointer_key"; then pointer_etag=$(object_etag "$checkpoint_pointer_key"); else pointer_etag=ABSENT; fi
  python3 - "$manifest" "$key" "$checksum_key" "$status_key" "$manifest_key" "$descriptor_key" <<'PY'
import json,sys
p,key,checksum,status,manifest,upload=sys.argv[1:]
d=json.load(open(p)); d.update({"objectKey":key,"checksumKey":checksum,"statusKey":status,"manifestKey":manifest,"uploadDescriptorKey":upload}); json.dump(d,open(p,"w"),separators=(",", ":")); open(p,"a").write("\n")
PY
  projected_peak_guard "$bytes"
  patch=$(python3 - "$key" "$bytes" "$sha" "$descriptor_key" <<'PY'
import json,sys
print(json.dumps({"cleanupPending":False,"upload":{"objectKey":sys.argv[1],"expectedSize":int(sys.argv[2]),"sha256":sys.argv[3],"descriptorKey":sys.argv[4]}},separators=(",", ":")))
PY
)
  state_transition CHECKPOINT_UPLOADING "$patch"
  explicit_multipart_upload "$db" "$key" "$descriptor_key" "$sha"
  state_transition CHECKPOINT_VERIFYING "$patch"
  put_small_immutable "$output_root/checkpoint.sha256" "$checksum_key" text/plain
  put_small_immutable "$status" "$status_key" application/json
  put_small_immutable "$manifest" "$manifest_key" application/json
  pending="$output_root/pending-checkpoint.json"
  python3 - "$manifest" "$previous" "$previous_key" "$previous_source" "$pointer_etag" "$pending" <<'PY'
import json,sys
manifest,previous,previous_key,source,etag,out=sys.argv[1:]
d=json.load(open(manifest)); d.update({"format":"wall-explorer-pending-checkpoint-v1","status":"awaiting-remote-verification","previous":json.loads(previous),"previousObjectKey":previous_key,"previousSource":source,"expectedPointerEtag":etag}); json.dump(d,open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
  put_json_cas "$pending" "$pending_checkpoint_key" ABSENT
  echo "Uploaded immutable checkpoint; pointer unchanged: $key"
}

verify_pending_to_dir() {
  local dir="$1" pending key status manifest bytes sha
  pending="$dir/pending.json"
  download_object "$pending_checkpoint_key" "$pending"
  key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pending")
  status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["statusKey"])' "$pending")
  manifest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifestKey"])' "$pending")
  bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$pending")
  sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$pending")
  verify_remote_object "$key" "$bytes" "$sha"
  download_object "$key" "$dir/checkpoint.sqlite"
  download_object "$status" "$dir/status.json"
  download_object "$manifest" "$dir/manifest.json"
  validate_downloaded_checkpoint "$dir/checkpoint.sqlite" "$dir/status.json" "$dir/manifest.json" "$dir/verification.json"
}

cleanup_previous() {
  local pending="$1" current_pointer="$2" new_key previous_key previous_source previous_status previous_checksum previous_manifest
  new_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pending")
  previous_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("previousObjectKey","none"))' "$pending")
  previous_source=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("previousSource","none"))' "$pending")
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$current_pointer")" = "$new_key"
  [ "$previous_key" != "$new_key" ] || { echo "::error::Refusing to delete current canonical." >&2; return 45; }
  [ "$previous_key" != "none" ] || return 0
  case "$previous_source" in
    versioned-pointer)
      previous_status="${previous_key}.status.json"
      previous_checksum="${previous_key}.sha256"
      previous_manifest="${previous_key}.manifest.json"
      ;;
    verified-legacy-candidate)
      previous_status="${previous_key%/builder.sqlite}/status.json"
      previous_checksum="${previous_key}.sha256"
      previous_manifest=""
      ;;
    legacy-canonical)
      previous_status="$legacy_status_key"
      previous_checksum="$legacy_checksum_key"
      previous_manifest=""
      ;;
    *) echo "::error::Unknown previous checkpoint source; refusing cleanup." >&2; return 45 ;;
  esac
  for key in "$previous_key" "$previous_status" "$previous_checksum" "$previous_manifest"; do
    [ -n "$key" ] || continue
    object_exists "$key" || continue
    r2_destructive s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
  done
}

delete_failed_pending() {
  local dir="$1" pending="$dir/pending.json" new_key version pointer_key failed
  new_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pending")
  version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$pending")
  if object_exists "$checkpoint_pointer_key"; then
    download_object "$checkpoint_pointer_key" "$dir/current-pointer.json"
    pointer_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("objectKey",""))' "$dir/current-pointer.json")
    [ "$pointer_key" != "$new_key" ] || {
      echo "::error::Verification failed after pointer commit; current canonical will not be deleted." >&2
      return 48
    }
  fi
  failed="$dir/failed.json"
  python3 - "$pending" "$failed" <<'PY'
import datetime,json,sys
d=json.load(open(sys.argv[1])); d["status"]="failed-verification"; d["failedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"); json.dump(d,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  put_small_immutable "$failed" "jobs/historical/failed/checkpoint-${version}.json" application/json
  abort_uploads_for_key "$new_key" || true
  for key in "$new_key" "${new_key}.sha256" "${new_key}.status.json" "${new_key}.manifest.json"; do
    object_exists "$key" || continue
    r2_destructive s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
  done
  r2_destructive s3api delete-object --bucket "$bucket" --key "$pending_checkpoint_key" >/dev/null
  state_transition BACKFILLING '{"cleanupPending":false,"upload":null}'
}

finish_checkpoint_cleanup() {
  local dir="$1" pending="$dir/pending.json" pointer="$dir/committed-pointer.json" new_key progress promoted_status
  [ -f "$pending" ] || download_object "$pending_checkpoint_key" "$pending"
  download_object "$checkpoint_pointer_key" "$pointer"
  new_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pending")
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pointer")" = "$new_key"
  verify_remote_object "$new_key" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$pending")" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$pending")"
  cleanup_previous "$pending" "$pointer"
  promoted_status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["statusKey"])' "$pending")
  download_object "$promoted_status" "$dir/promoted-status.json"
  r2 s3 cp "$dir/promoted-status.json" "s3://${bucket}/${legacy_status_key}" --content-type application/json --cache-control no-store --only-show-errors
  r2_destructive s3api delete-object --bucket "$bucket" --key "$pending_checkpoint_key" >/dev/null
  progress=$(python3 -c 'import json,sys; print(float(json.load(open(sys.argv[1]))["progress"]))' "$pending")
  if [ "$progress" = "100.0" ]; then
    state_transition RAW_100_PERCENT '{"cleanupPending":false,"upload":null}'
  else
    state_transition BACKFILLING '{"cleanupPending":false,"upload":null}'
  fi
  echo "Promoted and cleaned previous checkpoint: $new_key"
}

promote_pending() {
  local dir pending pointer pointer_etag expected_etag new_key patch current
  require_not_stopped
  object_exists "$pending_checkpoint_key" || { echo "No pending checkpoint; promotion is idempotently complete."; return 0; }
  dir=$(mktemp -d)
  pending="$dir/pending.json"
  download_object "$pending_checkpoint_key" "$pending"
  current=$(read_state_name)
  if [ "$current" = CHECKPOINT_CLEANUP ]; then
    finish_checkpoint_cleanup "$dir"
    rm -r -- "$dir"
    return 0
  fi
  case "$current" in CHECKPOINT_VERIFYING|CHECKPOINT_PROMOTING) ;; *) rm -r -- "$dir"; echo "::error::Promotion cannot resume from state $current" >&2; return 45 ;; esac
  if ! verify_pending_to_dir "$dir"; then
    delete_failed_pending "$dir" || true
    rm -r -- "$dir"
    return 46
  fi
  if [ "$current" = CHECKPOINT_VERIFYING ]; then state_transition CHECKPOINT_PROMOTING '{}'; fi
  new_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$pending")
  expected_etag=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["expectedPointerEtag"])' "$pending")
  pointer="$dir/latest.json"
  python3 - "$pending" "$pointer" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); p={"format":"wall-explorer-historical-checkpoint-pointer-v3","version":m["version"],"objectKey":m["objectKey"],"sha256":m["sha256"],"bytes":m["bytes"],"rows":m["rows"],"progress":m["progress"],"lastDate":m["lastDate"],"createdAt":m["createdAt"],"schemaVersion":m["schemaVersion"],"compression":"none","status":"raw-100-percent" if float(m["progress"])==100 else "verified","statusKey":m["statusKey"],"manifestKey":m["manifestKey"],"previousObjectKey":m.get("previousObjectKey")}; json.dump(p,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  if object_exists "$checkpoint_pointer_key"; then
    download_object "$checkpoint_pointer_key" "$dir/current-pointer.json"
    if [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("objectKey",""))' "$dir/current-pointer.json")" != "$new_key" ]; then
      pointer_etag=$(object_etag "$checkpoint_pointer_key")
      test "$pointer_etag" = "$expected_etag" || { rm -r -- "$dir"; echo "::error::Checkpoint pointer CAS conflict." >&2; return 48; }
      put_json_cas "$pointer" "$checkpoint_pointer_key" "$expected_etag"
    fi
  else
    test "$expected_etag" = ABSENT
    put_json_cas "$pointer" "$checkpoint_pointer_key" ABSENT
  fi
  download_object "$checkpoint_pointer_key" "$dir/committed-pointer.json"
  test "$(sha256sum "$dir/committed-pointer.json" | awk '{print $1}')" = "$(sha256sum "$pointer" | awk '{print $1}')"

  # Final post-pointer verification is a fresh download, not reuse of the first copy.
  rm -f -- "$dir/checkpoint.sqlite"
  if ! verify_pending_to_dir "$dir"; then
    echo "::error::Post-pointer verification failed; both old and new recovery objects are retained." >&2
    rm -r -- "$dir"
    return 46
  fi
  patch=$(python3 - "$new_key" <<'PY'
import json,sys
print(json.dumps({"cleanupPending":True,"currentCanonical":sys.argv[1]},separators=(",", ":")))
PY
  )
  state_transition CHECKPOINT_CLEANUP "$patch"
  finish_checkpoint_cleanup "$dir"
  rm -r -- "$dir"
}

record_stop() {
  write_durable_stop "${1:-Historical lifecycle stopped}"
}

case "$operation" in
  restore) restore ;;
  resolve) resolve_checkpoint_json ;;
  upload) upload_checkpoint ;;
  promote) promote_pending ;;
  usage-json) r2_usage_json ;;
  projected-peak) projected_peak_guard "${2:?expected bytes required}" "${3:-0}" ;;
  acquire-lease) acquire_lease "${2:?owner required}" "${3:?purpose required}" ;;
  release-lease) release_lease "${2:?owner required}" ;;
  record-stop) record_stop "${2:-Historical lifecycle stopped}" ;;
  *) echo "Usage: $0 {restore|resolve|upload|promote|usage-json|projected-peak|acquire-lease|release-lease|record-stop}" >&2; exit 2 ;;
esac
