#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
output_root="${SNAPSHOT_OUTPUT_ROOT:-snapshot-output}"
snapshot_version="${SNAPSHOT_VERSION:-2026-08-17-v1}"
release_dir="${output_root}/historical-${snapshot_version%-v1}"
work_dir="${output_root}/historical-${snapshot_version%-v1}.building"
endpoint="https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}.r2.cloudflarestorage.com"
bucket="${R2_BUCKET:?R2_BUCKET is required}"
storage_limit_bytes="${R2_STORAGE_LIMIT_BYTES:-25000000000}"
next_batch_reserve_bytes="${R2_NEXT_BATCH_RESERVE_BYTES:-100000000}"
checkpoint_key="checkpoints/historical/builder.sqlite"
candidate_prefix="checkpoints/historical/candidates/"
candidate_id="${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
candidate_root="${candidate_prefix}${candidate_id}"
candidate_key="${candidate_root}/builder.sqlite"
candidate_checksum_key="${candidate_root}/builder.sqlite.sha256"
candidate_status_key="${candidate_root}/status.json"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"
export AWS_PAGER=""
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-3}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"

r2() {
  aws --endpoint-url "$endpoint" "$@"
}

r2_usage_json() {
  local inventory_dir objects_json uploads_json object_bytes multipart_bytes
  local key64 upload64 object_key upload_id parts_json part_bytes index

  inventory_dir=$(mktemp -d)
  objects_json="$inventory_dir/objects.json"
  uploads_json="$inventory_dir/uploads.json"

  r2 s3api list-objects-v2 --bucket "$bucket" --output json > "$objects_json"
  r2 s3api list-multipart-uploads --bucket "$bucket" --output json > "$uploads_json"

  object_bytes=$(python3 - "$objects_json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print(sum(int(item.get("Size", 0)) for item in data.get("Contents", [])))
PY
)

  multipart_bytes=0
  index=0
  while IFS=$'\t' read -r key64 upload64; do
    [ -n "$key64" ] || continue
    object_key=$(printf '%s' "$key64" | base64 --decode)
    upload_id=$(printf '%s' "$upload64" | base64 --decode)
    parts_json="$inventory_dir/parts-$index.json"
    r2 s3api list-parts \
      --bucket "$bucket" \
      --key "$object_key" \
      --upload-id "$upload_id" \
      --output json > "$parts_json"
    part_bytes=$(python3 - "$parts_json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print(sum(int(item.get("Size", 0)) for item in data.get("Parts", [])))
PY
)
    multipart_bytes=$((multipart_bytes + part_bytes))
    index=$((index + 1))
  done < <(python3 - "$uploads_json" <<'PY'
import base64, json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
for upload in data.get("Uploads", []):
    key = base64.b64encode(upload["Key"].encode()).decode()
    upload_id = base64.b64encode(upload["UploadId"].encode()).decode()
    print(f"{key}\t{upload_id}")
PY
)

  python3 - "$object_bytes" "$multipart_bytes" "$index" <<'PY'
import json, sys
objects, multipart, uploads = map(int, sys.argv[1:])
print(json.dumps({
    "objectBytes": objects,
    "multipartBytes": multipart,
    "multipartUploads": uploads,
    "totalBytes": objects + multipart,
}, separators=(",", ":")))
PY
  rm -r -- "$inventory_dir"
}

r2_usage_bytes() {
  r2_usage_json | python3 -c 'import json,sys; print(json.load(sys.stdin)["totalBytes"])'
}

candidate_db_keys() {
  local candidates_json
  candidates_json=$(mktemp)
  r2 s3api list-objects-v2 \
    --bucket "$bucket" \
    --prefix "$candidate_prefix" \
    --output json > "$candidates_json"
  python3 - "$candidates_json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
for item in data.get("Contents", []):
    key = item.get("Key", "")
    if key.endswith("/builder.sqlite"):
        print(key)
PY
  rm -f -- "$candidates_json"
}

checkpoint_db_path() {
  local checkpoint_db="$work_dir/historical.sqlite"
  if [ ! -f "$checkpoint_db" ]; then
    checkpoint_db="$release_dir/historical.sqlite"
  fi
  printf '%s\n' "$checkpoint_db"
}

remote_sha256() {
  local key="$1"
  r2 s3 cp "s3://${bucket}/${key}" - --only-show-errors | sha256sum | awk '{print $1}'
}

verify_remote_object() {
  local key="$1" expected_size="$2" expected_sha="$3" remote_size actual_sha
  remote_size=$(r2 s3api head-object \
    --bucket "$bucket" \
    --key "$key" \
    --query ContentLength \
    --output text)
  if [ "$remote_size" -ne "$expected_size" ]; then
    echo "::error::Remote size mismatch for $key: expected $expected_size, got $remote_size" >&2
    return 46
  fi
  actual_sha=$(remote_sha256 "$key")
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "::error::Remote SHA-256 mismatch for $key" >&2
    return 46
  fi
  echo "Verified remote object: $key ($remote_size bytes, SHA-256 $actual_sha)"
}

checkpoint_preflight() {
  local checkpoint_db local_bytes remote_size usage_json object_bytes multipart_bytes multipart_uploads current_bytes projected_peak
  local remote_exists candidate_count

  remote_exists=false
  remote_size=0
  if remote_size=$(r2 s3api head-object \
    --bucket "$bucket" \
    --key "$checkpoint_key" \
    --query ContentLength \
    --output text 2>/dev/null); then
    remote_exists=true
  else
    remote_size=0
  fi

  checkpoint_db=$(checkpoint_db_path)
  if [ -f "$checkpoint_db" ]; then
    local_bytes=$(stat -c '%s' "$checkpoint_db")
  else
    local_bytes=$remote_size
  fi

  usage_json=$(r2_usage_json)
  read -r object_bytes multipart_bytes multipart_uploads current_bytes < <(
    python3 - "$usage_json" <<'PY'
import json, sys
u = json.loads(sys.argv[1])
print(u["objectBytes"], u["multipartBytes"], u["multipartUploads"], u["totalBytes"])
PY
  )
  candidate_count=$(candidate_db_keys | wc -l)
  projected_peak=$((current_bytes + local_bytes + next_batch_reserve_bytes))

  echo "R2 completed object bytes: $object_bytes"
  echo "R2 unfinished multipart bytes: $multipart_bytes"
  echo "R2 unfinished multipart uploads: $multipart_uploads"
  echo "R2 total measured bytes: $current_bytes"
  echo "Next checkpoint raw bytes: $local_bytes"
  echo "Next-batch reserve bytes: $next_batch_reserve_bytes"
  echo "Projected replacement peak: $projected_peak"
  echo "Hard stop bytes: $storage_limit_bytes"
  echo "Existing canonical checkpoint: $remote_exists"
  echo "Existing candidate checkpoints: $candidate_count"

  if [ "$current_bytes" -ge "$storage_limit_bytes" ]; then
    echo "::warning::R2 is already at or above the 25 GB hard stop." >&2
    return 42
  fi
  if [ "$projected_peak" -ge "$storage_limit_bytes" ]; then
    echo "::warning::The next checkpoint projected peak reaches the 25 GB hard stop." >&2
    return 42
  fi
  if [ "$multipart_uploads" -gt 0 ] || [ "$multipart_bytes" -gt 0 ]; then
    echo "::warning::Unfinished multipart data exists; refusing to create another upload." >&2
    return 45
  fi
  if [ "$candidate_count" -gt 0 ]; then
    echo "::warning::A candidate checkpoint already exists; refusing to create an orphan chain." >&2
    return 45
  fi
}

restore_checkpoint() {
  local candidate_list candidate_count fallback_key checksum_key expected_sha actual_sha
  mkdir -p "$work_dir"

  if r2 s3api head-object --bucket "$bucket" --key "$checkpoint_key" >/dev/null 2>&1; then
    r2 s3 cp "s3://${bucket}/${checkpoint_key}" "$work_dir/historical.sqlite" --only-show-errors
    echo "Restored the canonical historical checkpoint from R2."
    return
  fi

  candidate_list=$(candidate_db_keys)
  candidate_count=$(printf '%s\n' "$candidate_list" | sed '/^$/d' | wc -l)
  if [ "$candidate_count" -eq 1 ]; then
    fallback_key=$(printf '%s\n' "$candidate_list" | sed '/^$/d')
    checksum_key="${fallback_key}.sha256"
    expected_sha=$(r2 s3 cp "s3://${bucket}/${checksum_key}" - --only-show-errors | tr -d '[:space:]')
    r2 s3 cp "s3://${bucket}/${fallback_key}" "$work_dir/historical.sqlite" --only-show-errors
    actual_sha=$(sha256sum "$work_dir/historical.sqlite" | awk '{print $1}')
    if [ "$actual_sha" != "$expected_sha" ]; then
      echo "::error::The only candidate checkpoint failed SHA-256 verification." >&2
      exit 46
    fi
    echo "Canonical checkpoint was absent; restored the single verified candidate checkpoint."
    return
  fi

  if [ "$candidate_count" -gt 1 ]; then
    echo "::error::Multiple candidate checkpoints exist; refusing to guess a recovery point." >&2
    exit 45
  fi
  echo "No R2 builder checkpoint exists yet; starting the missing historical segment."
}

write_checkpoint() {
  local checkpoint_db local_size expected_sha canonical_sha usage_after

  checkpoint_preflight
  checkpoint_db=$(checkpoint_db_path)
  test -f "$checkpoint_db"
  test -f "$output_root/job-status.json"
  local_size=$(stat -c '%s' "$checkpoint_db")
  expected_sha=$(sha256sum "$checkpoint_db" | awk '{print $1}')
  printf '%s\n' "$expected_sha" > "$output_root/builder.sqlite.sha256"

  # The old canonical object remains untouched throughout candidate upload and validation.
  r2 s3 cp "$checkpoint_db" "s3://${bucket}/${candidate_key}" --only-show-errors
  r2 s3 cp "$output_root/builder.sqlite.sha256" "s3://${bucket}/${candidate_checksum_key}" \
    --content-type text/plain --only-show-errors
  r2 s3 cp "$output_root/job-status.json" "s3://${bucket}/${candidate_status_key}" \
    --content-type application/json --cache-control no-store --only-show-errors
  verify_remote_object "$candidate_key" "$local_size" "$expected_sha"

  # From this point the verified candidate is a durable recovery point.
  r2 s3api delete-object --bucket "$bucket" --key "$checkpoint_key" >/dev/null
  r2 s3 cp "s3://${bucket}/${candidate_key}" "s3://${bucket}/${checkpoint_key}" --only-show-errors
  verify_remote_object "$checkpoint_key" "$local_size" "$expected_sha"

  r2 s3 cp "$output_root/builder.sqlite.sha256" \
    "s3://${bucket}/checksums/historical/builder.sqlite.sha256" \
    --content-type text/plain --only-show-errors
  r2 s3 cp "$output_root/job-status.json" \
    "s3://${bucket}/jobs/historical/status.json" \
    --content-type application/json --cache-control no-store --only-show-errors

  canonical_sha=$(remote_sha256 "$checkpoint_key")
  if [ "$canonical_sha" != "$expected_sha" ]; then
    echo "::error::Canonical checkpoint verification changed unexpectedly; candidate retained." >&2
    exit 46
  fi

  r2 s3 rm "s3://${bucket}/${candidate_root}/" --recursive --only-show-errors
  usage_after=$(r2_usage_bytes)
  echo "R2 bytes after verified checkpoint promotion: $usage_after"
  if [ "$usage_after" -ge "$storage_limit_bytes" ]; then
    echo "::error::R2 reached the 25 GB hard stop; no further writes are permitted." >&2
    exit 44
  fi
}

case "$operation" in
  restore)
    restore_checkpoint
    ;;
  checkpoint-preflight)
    checkpoint_preflight
    ;;
  checkpoint)
    write_checkpoint
    ;;
  publish)
    if [ "${R2_ALLOW_LEGACY_PUBLISH:-false}" != "true" ]; then
      echo "::error::Legacy publish is blocked because it duplicates raw SQLite under version and latest prefixes." >&2
      exit 43
    fi
    test -f "$release_dir/manifest.json"
    r2 s3 sync "$release_dir" "s3://${bucket}/snapshots/${snapshot_version}/" --only-show-errors
    r2 s3 sync "$release_dir" "s3://${bucket}/snapshots/latest/" --only-show-errors
    r2 s3 cp "$release_dir/manifest.json" "s3://${bucket}/manifests/${snapshot_version}.json" --content-type application/json --only-show-errors
    r2 s3 cp "$release_dir/manifest.json" "s3://${bucket}/manifests/latest.json" --content-type application/json --cache-control no-store --only-show-errors
    find "$release_dir" -type f -print0 | sort -z | xargs -0 sha256sum > "$output_root/${snapshot_version}.sha256sums.txt"
    r2 s3 cp "$output_root/${snapshot_version}.sha256sums.txt" "s3://${bucket}/checksums/${snapshot_version}/sha256sums.txt" --content-type text/plain --only-show-errors
    r2 s3 cp "$output_root/job-status.json" "s3://${bucket}/jobs/historical/status.json" --content-type application/json --cache-control no-store --only-show-errors
    ;;
  status)
    r2 s3 cp "s3://${bucket}/jobs/historical/status.json" - --only-show-errors
    ;;
  usage-json)
    r2_usage_json
    ;;
  usage-bytes)
    r2_usage_bytes
    ;;
  *)
    echo "Usage: $0 {restore|checkpoint-preflight|checkpoint|publish|status|usage-json|usage-bytes}" >&2
    exit 2
    ;;
esac
