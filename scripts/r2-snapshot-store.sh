#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
output_root="${SNAPSHOT_OUTPUT_ROOT:-snapshot-output}"
snapshot_version="${SNAPSHOT_VERSION:-2026-08-17-v1}"
release_dir="${output_root}/historical-${snapshot_version%-v1}"
work_dir="${output_root}/historical-${snapshot_version%-v1}.building"
endpoint="https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}.r2.cloudflarestorage.com"
bucket="${R2_BUCKET:?R2_BUCKET is required}"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"
export AWS_PAGER=""

r2() {
  aws --endpoint-url "$endpoint" "$@"
}

case "$operation" in
  restore)
    mkdir -p "$work_dir"
    if r2 s3api head-object --bucket "$bucket" --key checkpoints/historical/builder.sqlite >/dev/null 2>&1; then
      r2 s3 cp "s3://${bucket}/checkpoints/historical/builder.sqlite" "$work_dir/historical.sqlite" --only-show-errors
      echo "Restored the durable historical checkpoint from R2."
    else
      echo "No R2 builder checkpoint exists yet; starting the missing historical segment."
    fi
    ;;
  checkpoint)
    checkpoint_db="$work_dir/historical.sqlite"
    if [ ! -f "$checkpoint_db" ]; then checkpoint_db="$release_dir/historical.sqlite"; fi
    test -f "$checkpoint_db"
    test -f "$output_root/job-status.json"
    sha256sum "$checkpoint_db" | awk '{print $1}' > "$output_root/builder.sqlite.sha256"
    r2 s3 cp "$checkpoint_db" "s3://${bucket}/checkpoints/historical/builder.sqlite" --only-show-errors
    r2 s3 cp "$output_root/builder.sqlite.sha256" "s3://${bucket}/checksums/historical/builder.sqlite.sha256" --content-type text/plain --only-show-errors
    r2 s3 cp "$output_root/job-status.json" "s3://${bucket}/jobs/historical/status.json" --content-type application/json --cache-control no-store --only-show-errors
    ;;
  publish)
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
  *)
    echo "Usage: $0 {restore|checkpoint|publish|status}" >&2
    exit 2
    ;;
esac
