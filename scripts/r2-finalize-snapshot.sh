#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
db_path="${2:-${RUNNER_TEMP:-/tmp}/builder.sqlite}"
gzip_path="${3:-${RUNNER_TEMP:-/tmp}/builder.sqlite.gz}"
output_root="${SNAPSHOT_OUTPUT_ROOT:-snapshot-output}"
snapshot_version="${SNAPSHOT_VERSION:-2026-08-17-v1}"
snapshot_date="${SNAPSHOT_DATE:-2026-08-17}"
expected_last_date="${SNAPSHOT_EXPECTED_LAST_DATE:-2025-12-28}"
endpoint="https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}.r2.cloudflarestorage.com"
bucket="${R2_BUCKET:?R2_BUCKET is required}"
hard_stop="${R2_STORAGE_LIMIT_BYTES:-25000000000}"
reserve_bytes="${R2_FINALIZE_RESERVE_BYTES:-100000000}"
legacy_raw_key="checkpoints/historical/builder.sqlite"
checkpoint_pointer_key="checkpoints/historical/latest.json"
checkpoint_versions_prefix="checkpoints/historical/versions/"
raw_candidate_prefix="checkpoints/historical/candidates/"
raw_key="$legacy_raw_key"
raw_checksum_key="checksums/historical/builder.sqlite.sha256"
status_key="jobs/historical/status.json"
final_key="snapshots/historical/historical.sqlite.gz"
manifest_key="manifests/${snapshot_version}.json"
latest_manifest_key="manifests/latest.json"
gzip_checksum_key="checksums/historical/historical.sqlite.gz.sha256"
raw_final_checksum_key="checksums/historical/historical.sqlite.raw.sha256"
latest_pointer_key="snapshots/latest.json"
stop_key="jobs/historical/stop.json"
candidate_prefix="snapshots/historical/candidates/"
candidate_id="${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
candidate_root="${candidate_prefix}${candidate_id}"
candidate_key="${candidate_root}/historical.sqlite.gz"
candidate_manifest_key="${candidate_root}/manifest.json"
candidate_gzip_checksum_key="${candidate_root}/historical.sqlite.gz.sha256"
candidate_raw_checksum_key="${candidate_root}/historical.sqlite.raw.sha256"

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

# Destructive operations are intentionally single-attempt. A transient failure stops
# the workflow with the verified raw or gzip candidate still available.
r2_destructive() {
  AWS_MAX_ATTEMPTS=1 aws --endpoint-url "$endpoint" "$@"
}

object_exists() {
  r2 s3api head-object --bucket "$bucket" --key "$1" >/dev/null 2>&1
}

object_size() {
  r2 s3api head-object --bucket "$bucket" --key "$1" --query ContentLength --output text
}

remote_sha256() {
  r2 s3 cp "s3://${bucket}/$1" - --only-show-errors | sha256sum | awk '{print $1}'
}

resolve_raw_checkpoint() {
  local pointer_file key bytes sha status candidates_file candidate_count
  if object_exists "$checkpoint_pointer_key"; then
    pointer_file=$(mktemp)
    r2 s3 cp "s3://${bucket}/${checkpoint_pointer_key}" "$pointer_file" --only-show-errors
    IFS=$'\t' read -r key bytes sha status < <(
      python3 - "$pointer_file" "$checkpoint_versions_prefix" <<'PY'
import json, sys
pointer = json.load(open(sys.argv[1], encoding="utf-8"))
prefix = sys.argv[2]
key = str(pointer.get("objectKey", ""))
if not key.startswith(prefix + "builder-") or not key.endswith(".sqlite"):
    raise SystemExit("checkpoint pointer does not reference an immutable versioned SQLite object")
sha = str(pointer.get("sha256", ""))
if len(sha) != 64:
    raise SystemExit("checkpoint pointer SHA-256 is invalid")
print(key, int(pointer["bytes"]), sha, str(pointer["statusKey"]), sep="\t")
PY
    )
    rm -f -- "$pointer_file"
    object_exists "$key" || {
      echo "::error::Checkpoint pointer references a missing raw object: $key" >&2
      return 47
    }
    printf '%s\t%s\t%s\t%s\n' "$key" "$bytes" "$sha" "$status"
    return
  fi

  if object_exists "$legacy_raw_key"; then
    bytes=$(object_size "$legacy_raw_key")
    sha="-"
    if object_exists "$raw_checksum_key"; then
      sha=$(r2 s3 cp "s3://${bucket}/${raw_checksum_key}" - --only-show-errors | tr -d '[:space:]')
    fi
    printf '%s\t%s\t%s\t%s\n' "$legacy_raw_key" "$bytes" "$sha" "$status_key"
    return
  fi

  candidates_file=$(mktemp)
  r2 s3api list-objects-v2 --bucket "$bucket" --prefix "$raw_candidate_prefix" --output json > "$candidates_file"
  IFS=$'\t' read -r candidate_count key < <(
    python3 - "$candidates_file" <<'PY'
import json, sys
keys = [
    item["Key"]
    for item in json.load(open(sys.argv[1], encoding="utf-8")).get("Contents", [])
    if item.get("Key", "").endswith("/builder.sqlite")
]
print(len(keys), keys[0] if len(keys) == 1 else "-", sep="\t")
PY
  )
  rm -f -- "$candidates_file"
  if [ "$candidate_count" -eq 1 ]; then
    local candidate_checksum="${key}.sha256"
    status="${key%/builder.sqlite}/status.json"
    object_exists "$candidate_checksum" && object_exists "$status" || return 46
    bytes=$(object_size "$key")
    sha=$(r2 s3 cp "s3://${bucket}/${candidate_checksum}" - --only-show-errors | tr -d '[:space:]')
    printf '%s\t%s\t%s\t%s\n' "$key" "$bytes" "$sha" "$status"
    return
  fi
  [ "$candidate_count" -eq 0 ] || {
    echo "::error::Multiple raw candidates exist; refusing to guess a recovery point." >&2
    return 45
  }
  return 1
}

inventory_json() {
  local dir objects uploads object_bytes multipart_bytes upload_count index key64 upload64 key upload_id parts part_bytes
  dir=$(mktemp -d)
  trap 'rm -rf -- "$dir"' RETURN
  objects="$dir/objects.json"
  uploads="$dir/uploads.json"
  r2 s3api list-objects-v2 --bucket "$bucket" --output json > "$objects"
  r2 s3api list-multipart-uploads --bucket "$bucket" --output json > "$uploads"
  object_bytes=$(python3 - "$objects" <<'PY'
import json, sys
print(sum(int(x.get("Size", 0)) for x in json.load(open(sys.argv[1], encoding="utf-8")).get("Contents", [])))
PY
)
  multipart_bytes=0
  upload_count=0
  index=0
  while IFS=$'\t' read -r key64 upload64; do
    [ -n "$key64" ] || continue
    key=$(printf '%s' "$key64" | base64 --decode)
    upload_id=$(printf '%s' "$upload64" | base64 --decode)
    parts="$dir/parts-$index.json"
    r2 s3api list-parts --bucket "$bucket" --key "$key" --upload-id "$upload_id" --output json > "$parts"
    part_bytes=$(python3 - "$parts" <<'PY'
import json, sys
print(sum(int(x.get("Size", 0)) for x in json.load(open(sys.argv[1], encoding="utf-8")).get("Parts", [])))
PY
)
    multipart_bytes=$((multipart_bytes + part_bytes))
    upload_count=$((upload_count + 1))
    index=$((index + 1))
  done < <(python3 - "$uploads" <<'PY'
import base64, json, sys
for upload in json.load(open(sys.argv[1], encoding="utf-8")).get("Uploads", []):
    print(base64.b64encode(upload["Key"].encode()).decode() + "\t" + base64.b64encode(upload["UploadId"].encode()).decode())
PY
)
  python3 - "$object_bytes" "$multipart_bytes" "$upload_count" <<'PY'
import json, sys
objects, multipart, uploads = map(int, sys.argv[1:])
print(json.dumps({"objectBytes": objects, "multipartBytes": multipart, "multipartUploads": uploads, "totalBytes": objects + multipart}, separators=(",", ":")))
PY
  trap - RETURN
  rm -rf -- "$dir"
}

candidate_count() {
  local tmp
  tmp=$(mktemp)
  r2 s3api list-objects-v2 --bucket "$bucket" --prefix "$candidate_prefix" --output json > "$tmp"
  python3 - "$tmp" <<'PY'
import json, sys
print(sum(1 for x in json.load(open(sys.argv[1], encoding="utf-8")).get("Contents", []) if x.get("Key", "").endswith("/historical.sqlite.gz")))
PY
  rm -f -- "$tmp"
}

require_no_multipart() {
  local usage uploads parts
  usage=$(inventory_json)
  read -r uploads parts < <(python3 - "$usage" <<'PY'
import json, sys
u=json.loads(sys.argv[1]); print(u["multipartUploads"], u["multipartBytes"])
PY
)
  if [ "$uploads" -ne 0 ] || [ "$parts" -ne 0 ]; then
    echo "::error::Unfinished multipart data exists ($uploads uploads, $parts bytes)." >&2
    return 45
  fi
}

capacity_guard() {
  local added_bytes="$1" label="$2" usage object_bytes multipart_bytes total projected
  usage=$(inventory_json)
  read -r object_bytes multipart_bytes total < <(python3 - "$usage" <<'PY'
import json, sys
u=json.loads(sys.argv[1]); print(u["objectBytes"],u["multipartBytes"],u["totalBytes"])
PY
)
  projected=$((total + added_bytes + reserve_bytes))
  echo "R2 completed object bytes: $object_bytes"
  echo "R2 unfinished multipart bytes: $multipart_bytes"
  echo "$label bytes: $added_bytes"
  echo "Finalize reserve bytes: $reserve_bytes"
  echo "Projected peak bytes: $projected"
  echo "Hard stop bytes: $hard_stop"
  if [ "$projected" -ge "$hard_stop" ]; then
    echo "::error::Projected peak reaches the 25 GB hard stop." >&2
    return 42
  fi
}

verify_remote_gzip() {
  local key="$1" expected_size="$2" expected_gzip_sha="$3" expected_raw_sha="$4" tmp remote_size gzip_sha raw_sha
  remote_size=$(object_size "$key")
  test "$remote_size" -eq "$expected_size" || {
    echo "::error::Remote size mismatch for $key" >&2
    return 46
  }
  tmp=$(mktemp --suffix=.sqlite.gz)
  r2 s3 cp "s3://${bucket}/${key}" "$tmp" --only-show-errors
  gzip_sha=$(sha256sum "$tmp" | awk '{print $1}')
  test "$gzip_sha" = "$expected_gzip_sha" || {
    rm -f -- "$tmp"
    echo "::error::Compressed SHA-256 mismatch for $key" >&2
    return 46
  }
  gzip -t "$tmp"
  raw_sha=$(gzip -dc "$tmp" | sha256sum | awk '{print $1}')
  rm -f -- "$tmp"
  test "$raw_sha" = "$expected_raw_sha" || {
    echo "::error::Decompressed SHA-256 mismatch for $key" >&2
    return 46
  }
  echo "Verified R2 gzip: $key ($remote_size bytes; compressed and decompressed SHA-256 pass)"
}

download_raw() {
  local resolved expected_size expected_sha resolved_status actual_size actual_sha
  mkdir -p "$output_root"
  resolved=$(resolve_raw_checkpoint) || {
    echo "::error::Canonical raw SQLite is missing." >&2
    exit 47
  }
  IFS=$'\t' read -r raw_key expected_size expected_sha resolved_status <<< "$resolved"
  require_no_multipart
  r2 s3 cp "s3://${bucket}/${raw_key}" "$db_path" --only-show-errors
  r2 s3 cp "s3://${bucket}/${resolved_status}" "$output_root/job-status.json" --only-show-errors
  actual_size=$(stat -c '%s' "$db_path")
  test "$actual_size" -eq "$expected_size"
  if [ "$expected_sha" != "-" ]; then
    actual_sha=$(sha256sum "$db_path" | awk '{print $1}')
    test "$actual_sha" = "$expected_sha" || {
      echo "::error::Downloaded raw SQLite does not match the checkpoint pointer SHA-256." >&2
      exit 46
    }
  fi
}

is_finalized() {
  if object_exists "$final_key" && object_exists "$manifest_key" && object_exists "$latest_pointer_key"; then
    echo "finalized=true"
    return 0
  fi
  echo "finalized=false"
  return 1
}

is_ready() {
  local status_json status progress current_date overall total resolved resolved_status
  status_json=$(mktemp)
  if ! resolved=$(resolve_raw_checkpoint); then
    rm -f -- "$status_json"
    echo "ready=false"
    return 1
  fi
  IFS=$'\t' read -r _ _ _ resolved_status <<< "$resolved"
  if ! r2 s3 cp "s3://${bucket}/${resolved_status}" "$status_json" --only-show-errors; then
    rm -f -- "$status_json"
    echo "ready=false"
    return 1
  fi
  read -r status progress current_date overall total < <(
    jq -r '[.status,.progress,.currentDate,.overallCompletedUnits,.totalUnits] | @tsv' "$status_json"
  )
  rm -f -- "$status_json"
  if [ "$status" = "complete" ] && [ "$progress" = "100" ] && [ "$current_date" = "$expected_last_date" ] && [ "$overall" -eq "$total" ]; then
    echo "ready=true"
    return 0
  fi
  echo "ready=false"
  return 1
}

is_stopped() {
  if object_exists "$stop_key"; then
    echo "stopped=true"
    return 0
  fi
  echo "stopped=false"
  return 1
}

record_stop() {
  local reason="${2:-unspecified failure}" stop_json
  if object_exists "$stop_key"; then
    echo "A durable stop marker already exists; leaving it unchanged."
    return 0
  fi
  stop_json=$(mktemp)
  jq -n \
    --arg status "stopped" \
    --arg reason "$reason" \
    --arg workflow "${GITHUB_WORKFLOW:-unknown}" \
    --arg runId "${GITHUB_RUN_ID:-unknown}" \
    --arg runAttempt "${GITHUB_RUN_ATTEMPT:-unknown}" \
    --arg stoppedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{status:$status,reason:$reason,workflow:$workflow,runId:$runId,runAttempt:$runAttempt,stoppedAt:$stoppedAt,automaticResumeBlocked:true}' > "$stop_json"
  r2 s3 cp "$stop_json" "s3://${bucket}/${stop_key}" --content-type application/json --cache-control no-store --only-show-errors
  rm -f -- "$stop_json"
  echo "Recorded durable stop marker: $stop_key"
}

preflight() {
  local count raw_size resolved
  require_no_multipart
  count=$(candidate_count)
  test "$count" -eq 0 || {
    echo "::error::A gzip candidate already exists; refusing to create an orphan chain." >&2
    return 45
  }
  resolved=$(resolve_raw_checkpoint) || {
    echo "::error::Canonical raw SQLite is missing." >&2
    return 47
  }
  IFS=$'\t' read -r raw_key raw_size _ _ <<< "$resolved"
  if object_exists "$final_key"; then
    echo "::error::Final gzip key already exists while raw SQLite is still present; refusing to overwrite." >&2
    return 45
  fi
  capacity_guard "$raw_size" "Conservative gzip allowance"
}

migrate() {
  local manifest_path="${4:?manifest path is required}" status_path="${5:?status path is required}"
  local gzip_size gzip_sha raw_sha current_raw_sha count latest_pointer final_status resolved
  test -f "$db_path"
  test -f "$gzip_path"
  test -f "$manifest_path"
  test -f "$status_path"
  gzip -t "$gzip_path"
  gzip_size=$(stat -c '%s' "$gzip_path")
  gzip_sha=$(sha256sum "$gzip_path" | awk '{print $1}')
  raw_sha=$(sha256sum "$db_path" | awk '{print $1}')
  test "$(gzip -dc "$gzip_path" | sha256sum | awk '{print $1}')" = "$raw_sha"

  require_no_multipart
  count=$(candidate_count)
  test "$count" -eq 0 || {
    echo "::error::A gzip candidate already exists; stopping without changing raw SQLite." >&2
    exit 45
  }
  resolved=$(resolve_raw_checkpoint)
  IFS=$'\t' read -r raw_key _ _ _ <<< "$resolved"
  object_exists "$raw_key"
  ! object_exists "$final_key" || {
    echo "::error::Final gzip already exists; refusing to overwrite it." >&2
    exit 45
  }
  capacity_guard "$gzip_size" "Gzip candidate"

  # Raw SQLite remains canonical until every candidate check passes.
  r2 s3 cp "$gzip_path" "s3://${bucket}/${candidate_key}" --only-show-errors
  printf '%s\n' "$gzip_sha" > "$output_root/historical.sqlite.gz.sha256"
  printf '%s\n' "$raw_sha" > "$output_root/historical.sqlite.raw.sha256"
  r2 s3 cp "$output_root/historical.sqlite.gz.sha256" "s3://${bucket}/${candidate_gzip_checksum_key}" --content-type text/plain --only-show-errors
  r2 s3 cp "$output_root/historical.sqlite.raw.sha256" "s3://${bucket}/${candidate_raw_checksum_key}" --content-type text/plain --only-show-errors
  r2 s3 cp "$manifest_path" "s3://${bucket}/${candidate_manifest_key}" --content-type application/json --only-show-errors
  verify_remote_gzip "$candidate_key" "$gzip_size" "$gzip_sha" "$raw_sha"
  require_no_multipart

  # Reconfirm that the raw object has not changed since local verification.
  current_raw_sha=$(remote_sha256 "$raw_key")
  test "$current_raw_sha" = "$raw_sha" || {
    echo "::error::Canonical raw SQLite changed during finalization; candidate retained, raw untouched." >&2
    exit 46
  }

  # Candidate is now the durable recovery copy. Destructive calls never retry.
  r2_destructive s3api delete-object --bucket "$bucket" --key "$raw_key" >/dev/null
  object_exists "$raw_key" && {
    echo "::error::Raw deletion did not complete; verified gzip candidate retained." >&2
    exit 48
  }

  capacity_guard "$gzip_size" "Final gzip copy"
  r2_destructive s3api copy-object --bucket "$bucket" --copy-source "${bucket}/${candidate_key}" --key "$final_key" >/dev/null
  verify_remote_gzip "$final_key" "$gzip_size" "$gzip_sha" "$raw_sha"

  r2 s3 cp "$manifest_path" "s3://${bucket}/${manifest_key}" --content-type application/json --only-show-errors
  r2 s3 cp "$manifest_path" "s3://${bucket}/${latest_manifest_key}" --content-type application/json --cache-control no-store --only-show-errors
  r2 s3 cp "$output_root/historical.sqlite.gz.sha256" "s3://${bucket}/${gzip_checksum_key}" --content-type text/plain --only-show-errors
  r2 s3 cp "$output_root/historical.sqlite.raw.sha256" "s3://${bucket}/${raw_final_checksum_key}" --content-type text/plain --only-show-errors

  latest_pointer=$(mktemp)
  final_status=$(mktemp)
  jq -n --arg key "$final_key" --arg manifest "$manifest_key" --arg version "$snapshot_version" --arg snapshotDate "$snapshot_date" \
    '{snapshotKey:$key,manifestKey:$manifest,version:$version,snapshotDate:$snapshotDate,compression:"gzip"}' > "$latest_pointer"
  jq --arg key "$final_key" --arg manifest "$manifest_key" --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {status:"complete",progress:100,finalized:true,finalSnapshotKey:$key,finalManifestKey:$manifest,finalizedAt:$completedAt}' \
    "$status_path" > "$final_status"
  r2 s3 cp "$latest_pointer" "s3://${bucket}/${latest_pointer_key}" --content-type application/json --cache-control no-store --only-show-errors
  r2 s3 cp "$final_status" "s3://${bucket}/${status_key}" --content-type application/json --cache-control no-store --only-show-errors

  # Verify small formal metadata before cleaning raw-only metadata and candidate files.
  test "$(remote_sha256 "$manifest_key")" = "$(sha256sum "$manifest_path" | awk '{print $1}')"
  test "$(remote_sha256 "$latest_pointer_key")" = "$(sha256sum "$latest_pointer" | awk '{print $1}')"
  verify_remote_gzip "$final_key" "$gzip_size" "$gzip_sha" "$raw_sha"

  if object_exists "$raw_checksum_key"; then
    r2_destructive s3api delete-object --bucket "$bucket" --key "$raw_checksum_key" >/dev/null
  fi
  r2_destructive s3 rm "s3://${bucket}/${candidate_root}/" --recursive --only-show-errors
  rm -f -- "$latest_pointer" "$final_status"

  require_no_multipart
  is_finalized
  echo "Final gzip Snapshot promoted safely; raw SQLite was removed only after all verification gates passed."
}

case "$operation" in
  is-finalized) is_finalized ;;
  is-ready) is_ready ;;
  is-stopped) is_stopped ;;
  record-stop) record_stop "$@" ;;
  preflight) preflight ;;
  download-raw) download_raw ;;
  migrate) migrate "$@" ;;
  *)
    echo "Usage: $0 {is-finalized|is-ready|is-stopped|record-stop reason|preflight|download-raw [db]|migrate db gzip manifest status}" >&2
    exit 2
    ;;
esac
