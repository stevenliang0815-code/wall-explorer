#!/usr/bin/env bash
set -euo pipefail

# Resume is gated only by the current lifecycle upload. The private full-scan
# classification proves the legacy/current split, while Legacy GC runs under a
# separate concurrency group and never participates in this decision.

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

classification_key="jobs/historical/legacy-multipart-gc/classification.json"
expected_checkpoint_key="${R2_EXPECTED_RESUME_CHECKPOINT_KEY:-checkpoints/historical/versions/builder-2f2fffff9ceabec060438aa8d5bbab627adcee1d48ca7c0064536d97a550a355.sqlite}"
expected_progress="${R2_EXPECTED_RESUME_PROGRESS:-99.69}"
max_report_age_seconds="${R2_CLASSIFICATION_MAX_AGE_SECONDS:-21600}"

write_output() {
  local output_file="$1" key="$2" value="$3"
  if [ -n "$output_file" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$output_file"
  fi
  return 0
}

gate_resume() {
  local output_file="${1:-}" dir report resolved source_type object_key bytes status_key state_file state descriptor_key descriptor_status upload_key
  local current current_count current_bytes
  if ! object_exists "$stop_key"; then
    write_output "$output_file" eligible false
    echo "No durable stop marker exists; resume is already complete or active."
    return 0
  fi
  object_exists "$classification_key" || { echo "::error::Private multipart classification is missing." >&2; return 45; }
  object_exists "$pending_checkpoint_key" && { echo "::error::Pending checkpoint must be promoted before resume." >&2; return 45; }

  dir=$(mktemp -d)
  report="$dir/classification.json"
  download_object "$classification_key" "$report"
  python3 - "$report" "$max_report_age_seconds" <<'PY'
import datetime,json,sys
d=json.load(open(sys.argv[1])); max_age=int(sys.argv[2])
if not d.get("pagination",{}).get("complete"): raise SystemExit("Private classification pagination is incomplete")
c=d.get("currentLifecycle",{})
if int(c.get("unfinishedUploads",-1)) != 0 or int(c.get("unfinishedBytes",-1)) != 0:
    raise SystemExit("Current lifecycle still has unfinished multipart data")
if d.get("leaseActive"): raise SystemExit("Classification observed an active lifecycle lease")
stamp=d.get("classifiedAt") or d.get("createdAt")
if stamp:
    when=datetime.datetime.fromisoformat(stamp.replace("Z","+00:00"))
    age=(datetime.datetime.now(datetime.timezone.utc)-when).total_seconds()
    if age < 0 or age > max_age: raise SystemExit("Private classification report is stale")
PY

  current=$(current_lifecycle_multipart_json)
  read -r current_count current_bytes < <(python3 - "$current" <<'PY'
import json,sys
d=json.loads(sys.argv[1]); print(int(d["multipartUploads"]),int(d["multipartBytes"]))
PY
)
  test "$current_count" -eq 0 && test "$current_bytes" -eq 0 || {
    rm -r -- "$dir"
    echo "::error::Current lifecycle multipart changed after classification." >&2
    return 45
  }

  if object_exists "$lease_key"; then
    download_object "$lease_key" "$dir/lease.json"
    python3 - "$dir/lease.json" <<'PY'
import datetime,json,sys
d=json.load(open(sys.argv[1])); now=int(datetime.datetime.now(datetime.timezone.utc).timestamp())
if d.get("status","active")=="active" and int(d.get("expiresEpoch",0))>now:
    raise SystemExit("An active lifecycle lease exists")
PY
  fi

  resolved=$(bash scripts/r2-checkpoint-lifecycle.sh resolve)
  read -r source_type object_key bytes status_key < <(python3 - "$resolved" <<'PY'
import base64,json,sys
d=json.loads(sys.argv[1]); enc=lambda x:base64.b64encode(str(x).encode()).decode()
print(d.get("source",""),enc(d.get("objectKey","")),int(d.get("bytes",0)),enc(d.get("statusKey","")))
PY
)
  object_key=$(printf '%s' "$object_key" | base64 --decode)
  status_key=$(printf '%s' "$status_key" | base64 --decode)
  test "$source_type" = versioned-pointer
  test "$object_key" = "$expected_checkpoint_key" || { rm -r -- "$dir"; echo "::error::Verified resume pointer changed." >&2; return 46; }
  download_object "$status_key" "$dir/status.json"
  python3 - "$dir/status.json" "$expected_progress" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); expected=float(sys.argv[2])
if abs(float(d.get("progress",-1))-expected)>0.0001: raise SystemExit("Unexpected resume progress")
if not d.get("currentDate"): raise SystemExit("Verified checkpoint has no last completed date")
if int(d.get("overallCompletedUnits",-1)) >= int(d.get("totalUnits",-1)): raise SystemExit("Checkpoint is not a partial resume source")
if int(d.get("failedUnits",0)) != 0: raise SystemExit("Verified checkpoint contains failed units")
PY

  state_file="$dir/state.json"
  if object_exists "$state_key"; then download_object "$state_key" "$state_file"; else printf '{"state":"BACKFILLING"}\n' > "$state_file"; fi
  read -r state upload_key descriptor_key < <(python3 - "$state_file" <<'PY'
import base64,json,sys
d=json.load(open(sys.argv[1])); u=d.get("upload") or {}; enc=lambda x:base64.b64encode(str(x).encode()).decode()
print(d.get("state","BACKFILLING"),enc(u.get("objectKey","")),enc(u.get("descriptorKey","")))
PY
)
  upload_key=$(printf '%s' "$upload_key" | base64 --decode)
  descriptor_key=$(printf '%s' "$descriptor_key" | base64 --decode)
  case "$state" in
    BACKFILLING) ;;
    CHECKPOINT_UPLOADING)
      test -n "$descriptor_key" && test "$upload_key" != "$object_key"
      object_exists "$descriptor_key" || { rm -r -- "$dir"; echo "::error::Stale upload descriptor is missing." >&2; return 46; }
      download_object "$descriptor_key" "$dir/descriptor.json"
      descriptor_status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$dir/descriptor.json")
      case "$descriptor_status" in aborted|abort-failed) ;; *) rm -r -- "$dir"; echo "::error::Stale upload descriptor is not in an abort terminal state." >&2; return 46 ;; esac
      ;;
    *) rm -r -- "$dir"; echo "::error::Lifecycle state $state is not resumable." >&2; return 45 ;;
  esac

  projected_peak_guard "$bytes"
  write_output "$output_file" eligible true
  write_output "$output_file" source_type "$source_type"
  write_output "$output_file" checkpoint_bytes "$bytes"
  write_output "$output_file" lifecycle_state "$state"
  rm -r -- "$dir"
}

prepare_resume() {
  local state
  gate_resume "${1:-}"
  state=$(read_state_name)
  if [ "$state" = CHECKPOINT_UPLOADING ]; then
    state_transition BACKFILLING '{"cleanupPending":false,"upload":null}'
  fi
  return 0
}

main() {
  case "${1:-gate}" in
    gate) gate_resume "${2:-}" ;;
    prepare) prepare_resume "${2:-}" ;;
    *) echo "Usage: $0 {gate|prepare} [GITHUB_OUTPUT]" >&2; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
