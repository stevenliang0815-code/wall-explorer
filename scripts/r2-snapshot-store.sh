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
legacy_checkpoint_key="checkpoints/historical/builder.sqlite"
checkpoint_versions_prefix="checkpoints/historical/versions/"
checkpoint_commits_prefix="checkpoints/historical/commits/"
latest_pointer_key="checkpoints/historical/latest.json"
candidate_prefix="checkpoints/historical/candidates/"
candidate_id="${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
candidate_root="${candidate_prefix}${candidate_id}"
candidate_key="${candidate_root}/builder.sqlite"
candidate_checksum_key="${candidate_root}/builder.sqlite.sha256"
candidate_status_key="${candidate_root}/status.json"
legacy_checksum_key="checksums/historical/builder.sqlite.sha256"
legacy_status_key="jobs/historical/status.json"

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

object_exists() {
  r2 s3api head-object --bucket "$bucket" --key "$1" >/dev/null 2>&1
}

object_size() {
  r2 s3api head-object \
    --bucket "$bucket" \
    --key "$1" \
    --query ContentLength \
    --output text
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

read_latest_pointer() {
  local pointer_file
  pointer_file=$(mktemp)
  if ! r2 s3 cp "s3://${bucket}/${latest_pointer_key}" "$pointer_file" --only-show-errors 2>/dev/null; then
    rm -f -- "$pointer_file"
    return 1
  fi
  python3 - "$pointer_file" "$checkpoint_versions_prefix" <<'PY'
import json, sys

path, prefix = sys.argv[1:]
pointer = json.load(open(path, encoding="utf-8"))
required = ("objectKey", "bytes", "sha256", "statusKey", "manifestKey")
missing = [key for key in required if key not in pointer]
if missing:
    raise SystemExit("latest checkpoint pointer is missing: " + ", ".join(missing))
key = str(pointer["objectKey"])
if not key.startswith(prefix + "builder-") or not key.endswith(".sqlite"):
    raise SystemExit("latest checkpoint pointer references a non-versioned key")
sha = str(pointer["sha256"])
if len(sha) != 64 or any(ch not in "0123456789abcdef" for ch in sha):
    raise SystemExit("latest checkpoint pointer has an invalid SHA-256")
print(
    key,
    int(pointer["bytes"]),
    sha,
    str(pointer["statusKey"]),
    str(pointer["manifestKey"]),
    sep="\t",
)
PY
  rm -f -- "$pointer_file"
}

resolve_checkpoint() {
  local pointer_fields key bytes sha status_key manifest_key
  if object_exists "$latest_pointer_key"; then
    pointer_fields=$(read_latest_pointer)
    IFS=$'\t' read -r key bytes sha status_key manifest_key <<< "$pointer_fields"
    object_exists "$key" || {
      echo "::error::The latest checkpoint pointer references a missing object: $key" >&2
      return 47
    }
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$key" "$bytes" "$sha" "$status_key" "$manifest_key" "versioned-pointer"
    return
  fi

  if object_exists "$legacy_checkpoint_key"; then
    bytes=$(object_size "$legacy_checkpoint_key")
    sha="-"
    if object_exists "$legacy_checksum_key"; then
      sha=$(r2 s3 cp "s3://${bucket}/${legacy_checksum_key}" - --only-show-errors | tr -d '[:space:]')
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$legacy_checkpoint_key" "$bytes" "$sha" "$legacy_status_key" "-" "legacy-canonical"
    return
  fi

  local candidate_list candidate_count candidate_checkpoint candidate_checksum candidate_status
  candidate_list=$(candidate_db_keys)
  candidate_count=$(printf '%s\n' "$candidate_list" | sed '/^$/d' | wc -l)
  if [ "$candidate_count" -eq 1 ]; then
    candidate_checkpoint=$(printf '%s\n' "$candidate_list" | sed '/^$/d')
    candidate_checksum="${candidate_checkpoint}.sha256"
    candidate_status="${candidate_checkpoint%/builder.sqlite}/status.json"
    object_exists "$candidate_checksum" || {
      echo "::error::The retained candidate has no checksum sidecar." >&2
      return 46
    }
    object_exists "$candidate_status" || {
      echo "::error::The retained candidate has no status sidecar." >&2
      return 46
    }
    bytes=$(object_size "$candidate_checkpoint")
    sha=$(r2 s3 cp "s3://${bucket}/${candidate_checksum}" - --only-show-errors | tr -d '[:space:]')
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$candidate_checkpoint" "$bytes" "$sha" "$candidate_status" "-" "verified-legacy-candidate"
    return
  fi
  if [ "$candidate_count" -gt 1 ]; then
    echo "::error::Multiple retained candidates exist; refusing to guess the active checkpoint." >&2
    return 45
  fi

  return 1
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

upload_small_immutable() {
  local local_path="$1" key="$2" content_type="$3" expected_sha actual_sha
  expected_sha=$(sha256sum "$local_path" | awk '{print $1}')
  if object_exists "$key"; then
    actual_sha=$(remote_sha256 "$key")
    test "$actual_sha" = "$expected_sha" || {
      echo "::error::Immutable metadata collision at $key" >&2
      return 46
    }
    return
  fi
  r2 s3 cp "$local_path" "s3://${bucket}/${key}" \
    --content-type "$content_type" --cache-control no-store --only-show-errors
  actual_sha=$(remote_sha256 "$key")
  test "$actual_sha" = "$expected_sha"
}

checkpoint_preflight() {
  local enforce="${1:-true}" checkpoint_db local_bytes usage_json
  local object_bytes multipart_bytes multipart_uploads current_bytes projected_peak
  local resolved="" active_key="none" active_bytes=0 active_source="none" candidate_count safe=true

  if resolved=$(resolve_checkpoint); then
    IFS=$'\t' read -r active_key active_bytes _ _ _ active_source <<< "$resolved"
  fi

  checkpoint_db=$(checkpoint_db_path)
  if [ -f "$checkpoint_db" ]; then
    local_bytes=$(stat -c '%s' "$checkpoint_db")
  else
    local_bytes=$active_bytes
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
  echo "Active checkpoint source: $active_source"
  echo "Active checkpoint key: $active_key"
  echo "Retained legacy candidate checkpoints: $candidate_count"
  echo "Next immutable checkpoint bytes: $local_bytes"
  echo "Next-batch reserve bytes: $next_batch_reserve_bytes"
  echo "Projected immutable-upload peak: $projected_peak"
  echo "Hard stop bytes: $storage_limit_bytes"
  echo "Large server-side promotion copy: disabled"
  echo "Existing checkpoint deletion during promotion: disabled"

  if [ "$current_bytes" -ge "$storage_limit_bytes" ]; then
    safe=false
    [ "$enforce" != "true" ] || {
      echo "::warning::R2 is already at or above the 25 GB hard stop." >&2
      return 42
    }
  fi
  if [ "$projected_peak" -ge "$storage_limit_bytes" ]; then
    safe=false
    [ "$enforce" != "true" ] || {
      echo "::warning::The next immutable checkpoint projected peak reaches the 25 GB hard stop." >&2
      return 42
    }
  fi
  if [ "$multipart_uploads" -gt 0 ] || [ "$multipart_bytes" -gt 0 ]; then
    safe=false
    [ "$enforce" != "true" ] || {
      echo "::warning::Unfinished multipart data exists; refusing to create another upload." >&2
      return 45
    }
  fi
  echo "Storage-safe for one immutable checkpoint upload: $safe"
}

validate_local_checkpoint() {
  local checkpoint_db="$1" status_file="$2" report_file="$3"
  python3 - "$checkpoint_db" "$status_file" "$report_file" <<'PY'
import hashlib
import json
import os
import sqlite3
import sys

db_path, status_path, report_path = sys.argv[1:]
if os.path.exists(db_path + "-wal") and os.path.getsize(db_path + "-wal") != 0:
    raise SystemExit("SQLite WAL is not empty at checkpoint boundary")

status = json.load(open(status_path, encoding="utf-8"))
progress = float(status.get("progress", -1))
if not 0 <= progress <= 100:
    raise SystemExit("checkpoint progress is outside 0..100")
if not status.get("currentDate"):
    raise SystemExit("checkpoint currentDate is missing")

con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
try:
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise SystemExit(f"SQLite integrity_check failed: {integrity}")
    row_count = int(con.execute("SELECT count(*) FROM historical_observations").fetchone()[0])
finally:
    con.close()

size = os.path.getsize(db_path)
digest = hashlib.sha256()
with open(db_path, "rb") as src:
    for chunk in iter(lambda: src.read(8 * 1024 * 1024), b""):
        digest.update(chunk)

report = {
    "format": "wall-explorer-historical-checkpoint-manifest-v2",
    "bytes": size,
    "sha256": digest.hexdigest(),
    "integrityCheck": "ok",
    "wal": "clean",
    "segmentRowCount": row_count,
    "storedRows": int(status.get("storedRows", row_count)),
    "progress": progress,
    "currentDate": status["currentDate"],
    "status": status.get("status"),
    "overallCompletedUnits": int(status.get("overallCompletedUnits", 0)),
    "totalUnits": int(status.get("totalUnits", 0)),
}
json.dump(report, open(report_path, "w", encoding="utf-8"), separators=(",", ":"))
open(report_path, "a", encoding="utf-8").write("\n")
PY
}

restore_checkpoint() {
  local resolved key expected_size expected_sha status_key _ source actual_size actual_sha
  mkdir -p "$work_dir" "$output_root"

  if ! resolved=$(resolve_checkpoint); then
    echo "No R2 builder checkpoint exists yet; starting the missing historical segment."
    return
  fi
  IFS=$'\t' read -r key expected_size expected_sha status_key _ source <<< "$resolved"
  r2 s3 cp "s3://${bucket}/${key}" "$work_dir/historical.sqlite" --only-show-errors
  actual_size=$(stat -c '%s' "$work_dir/historical.sqlite")
  test "$actual_size" -eq "$expected_size" || {
    echo "::error::Restored checkpoint size mismatch." >&2
    exit 46
  }
  if [ "$expected_sha" != "-" ]; then
    actual_sha=$(sha256sum "$work_dir/historical.sqlite" | awk '{print $1}')
    test "$actual_sha" = "$expected_sha" || {
      echo "::error::Restored checkpoint SHA-256 mismatch." >&2
      exit 46
    }
  fi
  if object_exists "$status_key"; then
    r2 s3 cp "s3://${bucket}/${status_key}" "$output_root/job-status.json" --only-show-errors
  fi
  echo "Restored checkpoint from $source: $key"
}

write_checkpoint() {
  local checkpoint_db status_file validation_file local_size expected_sha version_id
  local version_key version_checksum_key version_status_key version_manifest_key commit_key
  local pointer_file pointer_sha expected_pointer_sha usage_after resolved previous_key="none"
  local previous_source="none"

  checkpoint_preflight true
  checkpoint_db=$(checkpoint_db_path)
  status_file="$output_root/job-status.json"
  validation_file="$output_root/checkpoint-validation.json"
  test -f "$checkpoint_db"
  test -f "$status_file"
  validate_local_checkpoint "$checkpoint_db" "$status_file" "$validation_file"
  local_size=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$validation_file")
  expected_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$validation_file")
  version_id="$expected_sha"
  version_key="${checkpoint_versions_prefix}builder-${version_id}.sqlite"
  version_checksum_key="${version_key}.sha256"
  version_status_key="${version_key}.status.json"
  version_manifest_key="${version_key}.manifest.json"
  commit_key="${checkpoint_commits_prefix}builder-${version_id}.json"
  pointer_file="$output_root/latest-checkpoint.json"
  printf '%s\n' "$expected_sha" > "$output_root/builder.sqlite.sha256"

  if resolved=$(resolve_checkpoint); then
    IFS=$'\t' read -r previous_key _ _ _ _ previous_source <<< "$resolved"
  fi

  python3 - "$validation_file" "$version_key" "$version_status_key" "$version_manifest_key" <<'PY'
import datetime
import json
import sys

path, object_key, status_key, manifest_key = sys.argv[1:]
manifest = json.load(open(path, encoding="utf-8"))
manifest.update({
    "objectKey": object_key,
    "statusKey": status_key,
    "manifestKey": manifest_key,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
})
json.dump(manifest, open(path, "w", encoding="utf-8"), separators=(",", ":"))
open(path, "a", encoding="utf-8").write("\n")
PY

  # The runner uploads directly to the immutable final version key. There is no
  # R2-to-R2 copy and no deletion of the previous checkpoint in this operation.
  if object_exists "$version_key"; then
    verify_remote_object "$version_key" "$local_size" "$expected_sha"
  else
    r2 s3 cp "$checkpoint_db" "s3://${bucket}/${version_key}" --only-show-errors
    verify_remote_object "$version_key" "$local_size" "$expected_sha"
  fi
  upload_small_immutable "$output_root/builder.sqlite.sha256" "$version_checksum_key" text/plain
  upload_small_immutable "$status_file" "$version_status_key" application/json
  upload_small_immutable "$validation_file" "$version_manifest_key" application/json
  validate_local_checkpoint "$checkpoint_db" "$status_file" "$output_root/checkpoint-post-upload-validation.json"
  test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$output_root/checkpoint-post-upload-validation.json")" = "$expected_sha"

  python3 - "$validation_file" "$previous_key" "$previous_source" "$pointer_file" <<'PY'
import json
import sys

manifest_path, previous_key, previous_source, pointer_path = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding="utf-8"))
pointer = {
    "format": "wall-explorer-historical-checkpoint-pointer-v2",
    "objectKey": manifest["objectKey"],
    "bytes": manifest["bytes"],
    "sha256": manifest["sha256"],
    "statusKey": manifest["statusKey"],
    "manifestKey": manifest["manifestKey"],
    "progress": manifest["progress"],
    "currentDate": manifest["currentDate"],
    "storedRows": manifest["storedRows"],
    "integrityCheck": manifest["integrityCheck"],
    "previousObjectKey": previous_key,
    "previousSource": previous_source,
    "committedAt": manifest["createdAt"],
}
json.dump(pointer, open(pointer_path, "w", encoding="utf-8"), separators=(",", ":"))
open(pointer_path, "a", encoding="utf-8").write("\n")
PY

  # Updating this small object is the only canonical promotion operation.
  r2 s3 cp "$pointer_file" "s3://${bucket}/${latest_pointer_key}" \
    --content-type application/json --cache-control no-store --only-show-errors
  expected_pointer_sha=$(sha256sum "$pointer_file" | awk '{print $1}')
  pointer_sha=$(remote_sha256 "$latest_pointer_key")
  test "$pointer_sha" = "$expected_pointer_sha"
  read_latest_pointer | grep -F -- "$version_key" >/dev/null
  verify_remote_object "$version_key" "$local_size" "$expected_sha"

  upload_small_immutable "$pointer_file" "$commit_key" application/json
  r2 s3 cp "$status_file" "s3://${bucket}/${legacy_status_key}" \
    --content-type application/json --cache-control no-store --only-show-errors
  r2 s3 cp "$output_root/builder.sqlite.sha256" "s3://${bucket}/${legacy_checksum_key}" \
    --content-type text/plain --only-show-errors

  usage_after=$(r2_usage_bytes)
  echo "R2 bytes after immutable checkpoint commit: $usage_after"
  echo "Committed checkpoint pointer: $latest_pointer_key -> $version_key"
  echo "Previous checkpoint retained: $previous_key"
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
    checkpoint_preflight true
    ;;
  promotion-dry-run)
    checkpoint_preflight false
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
    echo "Usage: $0 {restore|checkpoint-preflight|promotion-dry-run|checkpoint|publish|status|usage-json|usage-bytes}" >&2
    exit 2
    ;;
esac
