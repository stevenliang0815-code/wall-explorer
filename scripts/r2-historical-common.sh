#!/usr/bin/env bash

# Shared R2 control-plane primitives for the Historical Snapshot lifecycle.
# Callers must enable `set -euo pipefail` before sourcing this file.

endpoint="https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}.r2.cloudflarestorage.com"
bucket="${R2_BUCKET:?R2_BUCKET is required}"
hard_stop_bytes="${R2_STORAGE_LIMIT_BYTES:-25000000000}"
safety_reserve_bytes="${R2_SAFETY_RESERVE_BYTES:-100000000}"
state_key="jobs/historical/state.json"
stop_key="jobs/historical/stop.json"
lease_key="jobs/historical/lease.json"
pending_checkpoint_key="jobs/historical/pending-checkpoint.json"
checkpoint_pointer_key="checkpoints/historical/latest.json"
snapshot_pointer_key="snapshots/historical/latest.json"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
export AWS_PAGER=""
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-3}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"

r2() {
  aws --endpoint-url "$endpoint" "$@"
}

r2_destructive() {
  AWS_MAX_ATTEMPTS=1 aws --endpoint-url "$endpoint" "$@"
}

is_transient_r2_error() {
  local error_file="$1"
  grep -Eiq '(\((408|429|500|502|503|504)\)|HTTP([ /]+)(408|429|500|502|503|504)|status code[:= ]+(408|429|500|502|503|504)|RequestTimeout|TooManyRequests|Throttl|SlowDown|InternalError|ServiceUnavailable|Gateway Timeout|connection (reset|closed|aborted)|broken pipe|timed[ -]?out|timeout|temporarily unavailable|endpoint connection)' "$error_file"
}

r2_retry_to_files() {
  local stdout_file="$1" stderr_file="$2"
  shift 2
  local max_attempts="${R2_TRANSIENT_MAX_ATTEMPTS:-8}"
  local base_delay="${R2_RETRY_BASE_DELAY_SECONDS:-2}"
  local max_delay="${R2_RETRY_MAX_DELAY_SECONDS:-60}"
  local attempt=1 code delay jitter_ms sleep_for
  test "$max_attempts" -ge 1 && test "$max_attempts" -le 8
  while :; do
    : > "$stdout_file"
    : > "$stderr_file"
    set +e
    AWS_MAX_ATTEMPTS=1 aws --endpoint-url "$endpoint" "$@" > "$stdout_file" 2> "$stderr_file"
    code=$?
    set -e
    if [ "$code" -eq 0 ]; then
      return 0
    fi
    if ! is_transient_r2_error "$stderr_file" || [ "$attempt" -ge "$max_attempts" ]; then
      cat "$stderr_file" >&2
      return "$code"
    fi
    delay=$((base_delay * (1 << (attempt - 1))))
    [ "$delay" -le "$max_delay" ] || delay="$max_delay"
    if [ "$base_delay" -eq 0 ]; then jitter_ms=0; else jitter_ms=$((RANDOM % 1000)); fi
    sleep_for="${delay}.$(printf '%03d' "$jitter_ms")"
    echo "Transient R2 error; retrying the same request (attempt $((attempt + 1))/$max_attempts) after ${sleep_for}s." >&2
    sleep "$sleep_for"
    attempt=$((attempt + 1))
  done
}

list_multipart_uploads_to_file() {
  local output="$1" stderr_file
  stderr_file=$(mktemp)
  if ! r2_retry_to_files "$output" "$stderr_file" s3api list-multipart-uploads --bucket "$bucket" --output json; then
    rm -f -- "$stderr_file"
    return 1
  fi
  rm -f -- "$stderr_file"
}

multipart_upload_exists() {
  local key="$1" upload_id="$2" uploads code
  uploads=$(mktemp)
  if ! list_multipart_uploads_to_file "$uploads"; then
    rm -f -- "$uploads"
    return 47
  fi
  if python3 - "$uploads" "$key" "$upload_id" <<'PY'
import json,sys
data,key,upload_id=sys.argv[1:]
raise SystemExit(0 if any(u.get("Key")==key and u.get("UploadId")==upload_id for u in json.load(open(data)).get("Uploads",[])) else 1)
PY
  then code=0; else code=$?; fi
  rm -f -- "$uploads"
  return "$code"
}

abort_multipart_upload_exact() {
  local key="$1" upload_id="$2" dir out err exists_code
  if multipart_upload_exists "$key" "$upload_id"; then
    :
  else
    exists_code=$?
    [ "$exists_code" -eq 1 ] && return 0
    return 47
  fi
  dir=$(mktemp -d)
  out="$dir/abort.out"
  err="$dir/abort.err"
  if ! r2_retry_to_files "$out" "$err" s3api abort-multipart-upload --bucket "$bucket" --key "$key" --upload-id "$upload_id"; then
    if is_transient_r2_error "$err"; then
      echo "::error::Explicit multipart abort exhausted transient retries." >&2
    else
      echo "::error::Explicit multipart abort failed with a non-transient error." >&2
    fi
    rm -r -- "$dir"
    return 47
  fi
  if multipart_upload_exists "$key" "$upload_id"; then
    echo "::error::Multipart upload still exists after explicit abort." >&2
    rm -r -- "$dir"
    return 47
  else
    exists_code=$?
    if [ "$exists_code" -ne 1 ]; then
      echo "::error::Could not verify multipart disappearance after explicit abort." >&2
      rm -r -- "$dir"
      return 47
    fi
  fi
  rm -r -- "$dir"
}

object_exists() {
  r2 s3api head-object --bucket "$bucket" --key "$1" >/dev/null 2>&1
}

object_head_json() {
  r2 s3api head-object --bucket "$bucket" --key "$1" --output json
}

object_size() {
  r2 s3api head-object --bucket "$bucket" --key "$1" --query ContentLength --output text
}

object_etag() {
  r2 s3api head-object --bucket "$bucket" --key "$1" --query ETag --output text
}

download_object() {
  r2 s3 cp "s3://${bucket}/$1" "$2" --only-show-errors
}

remote_sha256() {
  r2 s3 cp "s3://${bucket}/$1" - --only-show-errors | sha256sum | awk '{print $1}'
}

verify_remote_object() {
  local key="$1" expected_bytes="$2" expected_sha="$3" actual_bytes actual_sha
  actual_bytes=$(object_size "$key")
  test "$actual_bytes" -eq "$expected_bytes" || {
    echo "::error::Size mismatch for $key: expected $expected_bytes, got $actual_bytes" >&2
    return 46
  }
  actual_sha=$(remote_sha256 "$key")
  test "$actual_sha" = "$expected_sha" || {
    echo "::error::SHA-256 mismatch for $key" >&2
    return 46
  }
}

put_json_cas() {
  local file="$1" key="$2" expected_etag="$3"
  local dir out err
  local args=(s3api put-object --bucket "$bucket" --key "$key" --body "$file" --content-type application/json --cache-control no-store)
  if [ "$expected_etag" = "ABSENT" ]; then
    args+=(--if-none-match '*')
  else
    args+=(--if-match "$expected_etag")
  fi
  dir=$(mktemp -d)
  out="$dir/out"
  err="$dir/err"
  r2_retry_to_files "$out" "$err" "${args[@]}"
  rm -r -- "$dir"
}

write_durable_stop() {
  local reason="$1" file etag
  file=$(mktemp)
  python3 - "$reason" "$file" <<'PY'
import datetime,json,os,sys
json.dump({"status":"paused","reason":sys.argv[1],"runId":os.getenv("GITHUB_RUN_ID","manual"),"recordedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")},open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  if object_exists "$stop_key"; then etag=$(object_etag "$stop_key"); else etag=ABSENT; fi
  put_json_cas "$file" "$stop_key" "$etag"
  rm -f -- "$file"
}

put_small_immutable() {
  local file="$1" key="$2" content_type="$3" local_sha remote_sha
  local_sha=$(sha256sum "$file" | awk '{print $1}')
  if object_exists "$key"; then
    remote_sha=$(remote_sha256 "$key")
    test "$remote_sha" = "$local_sha" || {
      echo "::error::Immutable metadata collision: $key" >&2
      return 46
    }
    return
  fi
  r2 s3 cp "$file" "s3://${bucket}/${key}" --content-type "$content_type" --cache-control no-store --only-show-errors
  test "$(remote_sha256 "$key")" = "$local_sha"
}

r2_usage_json() {
  local dir objects uploads object_bytes multipart_bytes index key64 upload64 object_key upload_id parts part_bytes
  dir=$(mktemp -d)
  objects="$dir/objects.json"
  uploads="$dir/uploads.json"
  r2 s3api list-objects-v2 --bucket "$bucket" --output json > "$objects"
  r2 s3api list-multipart-uploads --bucket "$bucket" --output json > "$uploads"
  object_bytes=$(python3 - "$objects" <<'PY'
import json, sys
print(sum(int(x.get("Size", 0)) for x in json.load(open(sys.argv[1])).get("Contents", [])))
PY
)
  multipart_bytes=0
  index=0
  while IFS=$'\t' read -r key64 upload64; do
    [ -n "$key64" ] || continue
    object_key=$(printf '%s' "$key64" | base64 --decode)
    upload_id=$(printf '%s' "$upload64" | base64 --decode)
    parts="$dir/parts-${index}.json"
    r2 s3api list-parts --bucket "$bucket" --key "$object_key" --upload-id "$upload_id" --output json > "$parts"
    part_bytes=$(python3 - "$parts" <<'PY'
import json, sys
print(sum(int(x.get("Size", 0)) for x in json.load(open(sys.argv[1])).get("Parts", [])))
PY
)
    multipart_bytes=$((multipart_bytes + part_bytes))
    index=$((index + 1))
  done < <(python3 - "$uploads" <<'PY'
import base64, json, sys
for upload in json.load(open(sys.argv[1])).get("Uploads", []):
    print(base64.b64encode(upload["Key"].encode()).decode(), base64.b64encode(upload["UploadId"].encode()).decode(), sep="\t")
PY
)
  python3 - "$object_bytes" "$multipart_bytes" "$index" <<'PY'
import json, sys
objects, multipart, uploads = map(int, sys.argv[1:])
print(json.dumps({"objectBytes":objects,"multipartBytes":multipart,"multipartUploads":uploads,"totalBytes":objects+multipart}, separators=(",", ":")))
PY
  rm -r -- "$dir"
}

projected_peak_guard() {
  local expected_bytes="$1" same_upload_bytes="${2:-0}" usage peak total uploads multipart
  usage=$(r2_usage_json)
  read -r total uploads multipart < <(python3 - "$usage" <<'PY'
import json, sys
u=json.loads(sys.argv[1]); print(u["totalBytes"],u["multipartUploads"],u["multipartBytes"])
PY
)
  peak=$(node scripts/historical-lifecycle.mjs projected-peak "$(python3 - "$usage" "$expected_bytes" "$same_upload_bytes" "$safety_reserve_bytes" <<'PY'
import json, sys
u=json.loads(sys.argv[1])
print(json.dumps({"completedObjectBytes":u["objectBytes"],"unfinishedMultipartBytes":u["multipartBytes"],"expectedNewBytes":int(sys.argv[2]),"uploadedBytesForSameUpload":int(sys.argv[3]),"safetyReserveBytes":int(sys.argv[4])}, separators=(",", ":")))
PY
)")
  echo "R2 measured bytes: $total"
  echo "Unfinished multipart: $uploads upload(s), $multipart bytes"
  echo "Projected peak: $peak"
  echo "Hard limit: $hard_stop_bytes"
  if [ "$uploads" -gt 0 ] && [ "$same_upload_bytes" -eq 0 ]; then
    echo "::error::Unfinished multipart data exists; abort/GC must resolve it before a new large upload." >&2
    return 45
  fi
  test "$peak" -lt "$hard_stop_bytes" || {
    echo "::error::Projected peak reaches the R2 hard limit; no large upload started." >&2
    return 42
  }
}

read_state_name() {
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

require_not_stopped() {
  if object_exists "$stop_key"; then
    echo "::error::Durable stop marker exists; Historical Snapshot remains paused." >&2
    return 43
  fi
}

require_large_write_allowed() {
  local state_file state cleanup
  if object_exists "$pending_checkpoint_key"; then
    echo "::error::A pending checkpoint already exists; promotion/cleanup must finish first." >&2
    return 45
  fi
  state_file=$(mktemp)
  if object_exists "$state_key"; then
    download_object "$state_key" "$state_file"
    read -r state cleanup < <(python3 - "$state_file" <<'PY'
import json, sys
d=json.load(open(sys.argv[1])); print(d.get("state","BACKFILLING"),str(bool(d.get("cleanupPending",False))).lower())
PY
)
    if [ "$cleanup" = "true" ] || [ "$state" = "CHECKPOINT_CLEANUP" ] || [ "$state" = "RAW_CLEANUP" ]; then
      rm -f -- "$state_file"
      echo "::error::Cleanup is pending; a third large object is forbidden." >&2
      return 45
    fi
  fi
  rm -f -- "$state_file"
}

state_transition() {
  local to="$1" patch_json="${2-}" dir current next etag
  [ -n "$patch_json" ] || patch_json='{}'
  dir=$(mktemp -d)
  current="$dir/current.json"
  next="$dir/next.json"
  if object_exists "$state_key"; then
    etag=$(object_etag "$state_key")
    download_object "$state_key" "$current"
  else
    etag=ABSENT
    printf '{"format":"wall-explorer-historical-lifecycle-v1","state":"BACKFILLING","revision":0}\n' > "$current"
  fi
  node scripts/historical-lifecycle.mjs transition "$current" "$to" "$patch_json" "$next"
  put_json_cas "$next" "$state_key" "$etag"
  rm -r -- "$dir"
}

acquire_lease() {
  local owner="$1" purpose="$2" ttl="${R2_LEASE_TTL_SECONDS:-21600}" dir lease etag now expires active_owner active_status active_expires
  dir=$(mktemp -d)
  lease="$dir/lease.json"
  now=$(date -u +%s)
  expires=$((now + ttl))
  if object_exists "$lease_key"; then
    etag=$(object_etag "$lease_key")
    download_object "$lease_key" "$dir/old.json"
    read -r active_owner active_status active_expires < <(python3 - "$dir/old.json" <<'PY'
import json, sys
d=json.load(open(sys.argv[1])); print(d.get("owner","-"),d.get("status","active"),int(d.get("expiresEpoch",0)))
PY
)
    if [ "$active_status" = "active" ] && [ "$active_expires" -gt "$now" ] && [ "$active_owner" != "$owner" ]; then
      rm -r -- "$dir"
      echo "::error::Another lifecycle owner holds the durable lease: $active_owner" >&2
      return 45
    fi
  else
    etag=ABSENT
  fi
  python3 - "$lease" "$owner" "$purpose" "$now" "$expires" <<'PY'
import datetime, json, sys
path,owner,purpose,now,expires=sys.argv[1:]
json.dump({"format":"wall-explorer-historical-lease-v1","owner":owner,"purpose":purpose,"status":"active","startedAt":datetime.datetime.fromtimestamp(int(now),datetime.timezone.utc).isoformat().replace("+00:00","Z"),"expiresAt":datetime.datetime.fromtimestamp(int(expires),datetime.timezone.utc).isoformat().replace("+00:00","Z"),"expiresEpoch":int(expires)},open(path,"w"),separators=(",", ":"))
open(path,"a").write("\n")
PY
  put_json_cas "$lease" "$lease_key" "$etag"
  rm -r -- "$dir"
}

release_lease() {
  local owner="$1" dir etag current released active_owner
  object_exists "$lease_key" || return 0
  dir=$(mktemp -d)
  current="$dir/current.json"
  released="$dir/released.json"
  etag=$(object_etag "$lease_key")
  download_object "$lease_key" "$current"
  active_owner=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("owner",""))' "$current")
  test "$active_owner" = "$owner" || {
    rm -r -- "$dir"
    echo "::error::Refusing to release a lease owned by $active_owner" >&2
    return 45
  }
  python3 - "$current" "$released" <<'PY'
import datetime,json,sys
d=json.load(open(sys.argv[1])); d["status"]="released"; d["releasedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"); d["expiresEpoch"]=0
json.dump(d,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  put_json_cas "$released" "$lease_key" "$etag"
  rm -r -- "$dir"
}

write_multipart_state_file() {
  local state_file="$1" descriptor_key="$2" key="$3" upload_id="$4" expected_bytes="$5" expected_parts="$6" completed_parts="$7" status="$8"
  python3 - "$state_file" "$descriptor_key" "$key" "$upload_id" "$expected_bytes" "$expected_parts" "$completed_parts" "$status" <<'PY'
import datetime,json,os,sys
out,descriptor,key,upload_id,expected,parts_total,parts_file,status=sys.argv[1:]
parts=[json.loads(x) for x in open(parts_file) if x.strip()]
now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
existing={}
if os.path.exists(out):
    try: existing=json.load(open(out))
    except Exception: existing={}
doc={
    "format":"wall-explorer-multipart-v2",
    "descriptorKey":descriptor,
    "objectKey":key,
    "uploadId":upload_id,
    "startedAt":existing.get("startedAt",now),
    "updatedAt":now,
    "expectedSize":int(expected),
    "expectedParts":int(parts_total),
    "completedParts":len(parts),
    "completedBytes":sum(int(p["Size"]) for p in parts),
    "parts":[{"partNumber":int(p["PartNumber"]),"etag":p["ETag"],"bytes":int(p["Size"])} for p in parts],
    "status":status,
}
if status in ("aborted","abort-failed","completed","failed-verification"):
    doc[f"{status.replace('-', '')}At"]=now
json.dump(doc,open(out,"w"),separators=(",", ":")); open(out,"a").write("\n")
PY
}

persist_multipart_state() {
  local state_file="$1" descriptor_key="$2" dir out err
  dir=$(mktemp -d)
  out="$dir/out"
  err="$dir/err"
  r2_retry_to_files "$out" "$err" s3 cp "$state_file" "s3://${bucket}/${descriptor_key}" --content-type application/json --cache-control no-store --only-show-errors
  rm -r -- "$dir"
}

explicit_multipart_upload() {
  local file="$1" key="$2" descriptor_key="$3" expected_sha="$4" bytes part_mib part_bytes expected_parts
  local dir create create_err upload_id part=1 offset_blocks=0 temp response response_err etag completed_parts state_file
  bytes=$(stat -c '%s' "$file")
  if object_exists "$key"; then
    verify_remote_object "$key" "$bytes" "$expected_sha"
    return
  fi
  part_mib="${R2_MULTIPART_PART_MIB:-256}"
  part_bytes=$((part_mib * 1024 * 1024))
  expected_parts=$(((bytes + part_bytes - 1) / part_bytes))
  dir=$(mktemp -d)
  create="$dir/create.json"
  create_err="$dir/create.err"
  r2_retry_to_files "$create" "$create_err" s3api create-multipart-upload --bucket "$bucket" --key "$key" --output json
  upload_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["UploadId"])' "$create")
  completed_parts="$dir/parts.ndjson"
  state_file="$dir/upload-state.json"
  : > "$completed_parts"

  upload_failed() {
    local code=$? abort_code=0
    trap - ERR
    if abort_multipart_upload_exact "$key" "$upload_id"; then
      write_multipart_state_file "$state_file" "$descriptor_key" "$key" "$upload_id" "$bytes" "$expected_parts" "$completed_parts" aborted
      persist_multipart_state "$state_file" "$descriptor_key" || true
      write_durable_stop "Multipart upload failed after bounded retries and was explicitly aborted; the verified canonical checkpoint was retained." || true
    else
      abort_code=47
      write_multipart_state_file "$state_file" "$descriptor_key" "$key" "$upload_id" "$bytes" "$expected_parts" "$completed_parts" abort-failed
      persist_multipart_state "$state_file" "$descriptor_key" || true
      write_durable_stop "Multipart upload abort failed; manual recovery is required and the verified canonical checkpoint was retained." || true
    fi
    rm -r -- "$dir"
    [ "$abort_code" -eq 0 ] || return "$abort_code"
    return "$code"
  }
  trap upload_failed ERR

  write_multipart_state_file "$state_file" "$descriptor_key" "$key" "$upload_id" "$bytes" "$expected_parts" "$completed_parts" uploading
  persist_multipart_state "$state_file" "$descriptor_key"

  while [ $((offset_blocks * 8 * 1024 * 1024)) -lt "$bytes" ]; do
    temp="$dir/part-${part}.bin"
    dd if="$file" of="$temp" bs=8M skip="$offset_blocks" count=$((part_mib / 8)) status=none
    response="$dir/part-${part}.json"
    response_err="$dir/part-${part}.err"
    r2_retry_to_files "$response" "$response_err" s3api upload-part --bucket "$bucket" --key "$key" --upload-id "$upload_id" --part-number "$part" --body "$temp" --output json
    etag=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$response")
    printf '{"PartNumber":%s,"ETag":%s,"Size":%s}\n' "$part" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$etag")" "$(stat -c '%s' "$temp")" >> "$completed_parts"
    write_multipart_state_file "$state_file" "$descriptor_key" "$key" "$upload_id" "$bytes" "$expected_parts" "$completed_parts" uploading
    persist_multipart_state "$state_file" "$descriptor_key"
    rm -f -- "$temp"
    offset_blocks=$((offset_blocks + part_mib / 8))
    part=$((part + 1))
  done
  python3 - "$completed_parts" "$dir/complete.json" <<'PY'
import json,sys
parts=[json.loads(x) for x in open(sys.argv[1]) if x.strip()]
json.dump({"Parts":[{"ETag":p["ETag"],"PartNumber":p["PartNumber"]} for p in parts]},open(sys.argv[2],"w"),separators=(",", ":"))
PY
  r2_retry_to_files "$dir/complete.out" "$dir/complete.err" s3api complete-multipart-upload --bucket "$bucket" --key "$key" --upload-id "$upload_id" --multipart-upload "file://${dir}/complete.json"
  trap - ERR
  if ! verify_remote_object "$key" "$bytes" "$expected_sha"; then
    r2_destructive s3api delete-object --bucket "$bucket" --key "$key" >/dev/null 2>&1 || true
    write_multipart_state_file "$state_file" "$descriptor_key" "$key" "$upload_id" "$bytes" "$expected_parts" "$completed_parts" failed-verification
    persist_multipart_state "$state_file" "$descriptor_key" || true
    write_durable_stop "Completed multipart object failed verification and was removed; the verified canonical checkpoint was retained." || true
    rm -r -- "$dir"
    return 46
  fi
  write_multipart_state_file "$state_file" "$descriptor_key" "$key" "$upload_id" "$bytes" "$expected_parts" "$completed_parts" completed
  persist_multipart_state "$state_file" "$descriptor_key"
  rm -r -- "$dir"
}
