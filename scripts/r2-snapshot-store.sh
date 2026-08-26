#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
output_root="${SNAPSHOT_OUTPUT_ROOT:-snapshot-output}"
snapshot_version="${SNAPSHOT_VERSION:-2026-08-17-v1}"
release_dir="${output_root}/historical-${snapshot_version%-v1}"
work_dir="${output_root}/historical-${snapshot_version%-v1}.building"
endpoint="https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}.r2.cloudflarestorage.com"
bucket="${R2_BUCKET:?R2_BUCKET is required}"
storage_limit_bytes="${R2_STORAGE_LIMIT_BYTES:-9700000000}"
next_batch_reserve_bytes="${R2_NEXT_BATCH_RESERVE_BYTES:-100000000}"
immutable_raw_checkpoint="${R2_IMMUTABLE_RAW_CHECKPOINT:-true}"
checkpoint_key="checkpoints/historical/builder.sqlite"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"
export AWS_PAGER=""

r2() {
  aws --endpoint-url "$endpoint" "$@"
}

r2_usage_bytes() {
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
    r2 s3api list-parts       --bucket "$bucket"       --key "$object_key"       --upload-id "$upload_id"       --output json > "$parts_json"
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

  rm -r -- "$inventory_dir"
  echo $((object_bytes + multipart_bytes))
}

checkpoint_db_path() {
  local checkpoint_db="$work_dir/historical.sqlite"
  if [ ! -f "$checkpoint_db" ]; then
    checkpoint_db="$release_dir/historical.sqlite"
  fi
  printf '%s\n' "$checkpoint_db"
}

checkpoint_preflight() {
  local checkpoint_db current_bytes local_bytes projected_peak remote_exists remote_size

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

  current_bytes=$(r2_usage_bytes)
  projected_peak=$((current_bytes + local_bytes + next_batch_reserve_bytes))

  echo "R2 current bytes: $current_bytes"
  echo "Checkpoint local bytes: $local_bytes"
  echo "Next-batch reserve bytes: $next_batch_reserve_bytes"
  echo "Projected multipart replacement peak: $projected_peak"
  echo "Hard stop bytes: $storage_limit_bytes"
  echo "Existing raw checkpoint: $remote_exists"

  if [ "$current_bytes" -ge "$storage_limit_bytes" ]; then
    echo "::warning::R2 is already at or above the 9.70 GB hard stop." >&2
    return 42
  fi
  if [ "$projected_peak" -ge "$storage_limit_bytes" ]; then
    echo "::warning::The next raw checkpoint upload could reach the 9.70 GB hard stop; stopping before the batch." >&2
    return 42
  fi
  if [ "$immutable_raw_checkpoint" = "true" ] && [ "$remote_exists" = "true" ]; then
    echo "::warning::The existing builder.sqlite is immutable until an externally durable migration is verified." >&2
    return 42
  fi
}

case "$operation" in
  restore)
    mkdir -p "$work_dir"
    if r2 s3api head-object --bucket "$bucket" --key "$checkpoint_key" >/dev/null 2>&1; then
      r2 s3 cp "s3://${bucket}/${checkpoint_key}" "$work_dir/historical.sqlite" --only-show-errors
      echo "Restored the durable historical checkpoint from R2."
    else
      echo "No R2 builder checkpoint exists yet; starting the missing historical segment."
    fi
    ;;
  checkpoint-preflight)
    checkpoint_preflight
    ;;
  checkpoint)
    checkpoint_preflight
    checkpoint_db=$(checkpoint_db_path)
    test -f "$checkpoint_db"
    test -f "$output_root/job-status.json"
    sha256sum "$checkpoint_db" | awk '{print $1}' > "$output_root/builder.sqlite.sha256"
    r2 s3 cp "$checkpoint_db" "s3://${bucket}/${checkpoint_key}" --only-show-errors
    r2 s3 cp "$output_root/builder.sqlite.sha256" "s3://${bucket}/checksums/historical/builder.sqlite.sha256" --content-type text/plain --only-show-errors
    r2 s3 cp "$output_root/job-status.json" "s3://${bucket}/jobs/historical/status.json" --content-type application/json --cache-control no-store --only-show-errors
    usage_after=$(r2_usage_bytes)
    echo "R2 bytes after checkpoint: $usage_after"
    if [ "$usage_after" -ge "$storage_limit_bytes" ]; then
      echo "::error::R2 reached the 9.70 GB hard stop after checkpoint; no further writes are permitted." >&2
      exit 44
    fi
    ;;
  publish)
    if [ "${R2_ALLOW_LEGACY_PUBLISH:-false}" != "true" ]; then
      echo "::error::Legacy publish is blocked because it duplicates the raw SQLite under version and latest prefixes." >&2
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
  usage-bytes)
    r2_usage_bytes
    ;;
  *)
    echo "Usage: $0 {restore|checkpoint-preflight|checkpoint|publish|status|usage-bytes}" >&2
    exit 2
    ;;
esac
