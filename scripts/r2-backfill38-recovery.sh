#!/usr/bin/env bash
set -euo pipefail

expected_pointer_key="checkpoints/historical/versions/builder-2f2fffff9ceabec060438aa8d5bbab627adcee1d48ca7c0064536d97a550a355.sqlite"
stale_object_key="checkpoints/historical/versions/builder-49d878fe74fed0981c6fb7401bf23328e1306d59202570ed154c08ce69aef04c.sqlite"
stale_descriptor_key="jobs/historical/uploads/checkpoint-49d878fe74fed0981c6fb7401bf23328e1306d59202570ed154c08ce69aef04c.json"
expected_parts=5
expected_part_bytes=1342177280
expected_new_checkpoint_bytes=10164809728

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

recovery_dir=""
cleanup() {
  [ -z "$recovery_dir" ] || rm -r -- "$recovery_dir"
}
trap cleanup EXIT

assert_paused_pointer() {
  local resolved source key status progress completed total
  object_exists "$stop_key" || { echo "::error::Backfill #38 recovery requires the durable pause marker." >&2; return 43; }
  object_exists "$pending_checkpoint_key" && { echo "::error::Pending promotion exists; refusing Backfill #38 recovery." >&2; return 45; }
  resolved=$(bash scripts/r2-checkpoint-lifecycle.sh resolve)
  source=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["source"])' "$resolved")
  key=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["objectKey"])' "$resolved")
  status=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["statusKey"])' "$resolved")
  [ "$source" = versioned-pointer ] && [ "$key" = "$expected_pointer_key" ] || {
    echo "::error::latest.json no longer points to the expected 99.69% verified checkpoint." >&2
    return 46
  }
  download_object "$status" "$recovery_dir/pointer-status.json"
  read -r progress completed total < <(python3 - "$recovery_dir/pointer-status.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(float(d.get("progress",-1)),int(d.get("overallCompletedUnits",-1)),int(d.get("totalUnits",-1)))
PY
)
  python3 - "$progress" <<'PY'
import sys
raise SystemExit(0 if abs(float(sys.argv[1])-99.69) < 0.001 else 1)
PY
  [ "$completed" -lt "$total" ]
}

assert_lease_inactive() {
  local status expires now
  object_exists "$lease_key" || return 0
  download_object "$lease_key" "$recovery_dir/lease.json"
  read -r status expires < <(python3 - "$recovery_dir/lease.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(d.get("status","active"),int(d.get("expiresEpoch",0)))
PY
)
  now=$(date -u +%s)
  [ "$status" != active ] || [ "$expires" -le "$now" ] || {
    echo "::error::An active lifecycle lease exists; refusing recovery." >&2
    return 45
  }
}

load_exact_stale_upload() {
  local uploads="$recovery_dir/uploads.json" count key upload_id parts descriptor_id descriptor_key descriptor_parts descriptor_bytes
  list_multipart_uploads_to_file "$uploads"
  count=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("Uploads",[])))' "$uploads")
  if [ "$count" -eq 0 ]; then
    return 1
  fi
  [ "$count" -eq 1 ] || { echo "::error::Expected one Backfill #38 multipart upload, found $count." >&2; return 45; }
  key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Uploads"][0]["Key"])' "$uploads")
  upload_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Uploads"][0]["UploadId"])' "$uploads")
  [ "$key" = "$stale_object_key" ] || { echo "::error::The sole multipart upload is not Backfill #38." >&2; return 45; }
  object_exists "$stale_descriptor_key" || { echo "::error::Backfill #38 durable upload record is missing." >&2; return 46; }
  download_object "$stale_descriptor_key" "$recovery_dir/stale-descriptor.json"
  descriptor_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uploadId"])' "$recovery_dir/stale-descriptor.json")
  descriptor_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["objectKey"])' "$recovery_dir/stale-descriptor.json")
  descriptor_parts=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1]))["completedParts"]))' "$recovery_dir/stale-descriptor.json")
  descriptor_bytes=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1]))["completedBytes"]))' "$recovery_dir/stale-descriptor.json")
  [ "$descriptor_id" = "$upload_id" ] && [ "$descriptor_key" = "$key" ] || { echo "::error::Multipart upload does not match its durable Backfill #38 record." >&2; return 46; }
  parts="$recovery_dir/stale-parts.json"
  r2_retry_to_files "$parts" "$recovery_dir/stale-parts.err" s3api list-parts --bucket "$bucket" --key "$key" --upload-id "$upload_id" --output json
  read -r listed_parts listed_bytes < <(python3 - "$parts" <<'PY'
import json,sys
p=json.load(open(sys.argv[1])).get("Parts",[]); print(len(p),sum(int(x.get("Size",0)) for x in p))
PY
)
  [ "$listed_parts" -eq "$expected_parts" ] && [ "$listed_bytes" -eq "$expected_part_bytes" ]
  [ "$descriptor_parts" -eq "$listed_parts" ] && [ "$descriptor_bytes" -eq "$listed_bytes" ]
  printf '%s\n' "$upload_id" > "$recovery_dir/exact-upload-id"
}

mark_descriptor_aborted() {
  local etag
  etag=$(object_etag "$stale_descriptor_key")
  python3 - "$recovery_dir/stale-descriptor.json" "$recovery_dir/aborted-descriptor.json" <<'PY'
import datetime,json,sys
d=json.load(open(sys.argv[1])); d["status"]="aborted"; d["abortedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"); d["recovery"]="backfill-38-explicit-abort"; json.dump(d,open(sys.argv[2],"w"),separators=(",", ":")); open(sys.argv[2],"a").write("\n")
PY
  put_json_cas "$recovery_dir/aborted-descriptor.json" "$stale_descriptor_key" "$etag"
}

assert_zero_unfinished_and_no_orphan() {
  local usage uploads bytes key_count
  usage=$(r2_usage_json)
  read -r uploads bytes < <(python3 - "$usage" <<'PY'
import json,sys
d=json.loads(sys.argv[1]); print(d["multipartUploads"],d["multipartBytes"])
PY
)
  [ "$uploads" -eq 0 ] && [ "$bytes" -eq 0 ] || { echo "::error::Unfinished multipart data remains after abort." >&2; return 47; }
  object_exists "$stale_object_key" && { echo "::error::An incomplete/orphan completed object exists at the Backfill #38 target key." >&2; return 47; }
  r2_retry_to_files "$recovery_dir/stale-prefix.json" "$recovery_dir/stale-prefix.err" s3api list-objects-v2 --bucket "$bucket" --prefix "$stale_object_key" --output json
  key_count=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("Contents",[])))' "$recovery_dir/stale-prefix.json")
  [ "$key_count" -eq 0 ] || { echo "::error::Incomplete/orphan Backfill #38 object or sidecar remains." >&2; return 47; }
  object_exists "$pending_checkpoint_key" && { echo "::error::Unexpected pending checkpoint exists after abort." >&2; return 47; }
  echo "Backfill #38 multipart cleanup verified: unfinished count=0, unfinished bytes=0, incomplete/orphan object=none."
}

reset_upload_state_while_paused() {
  local state current upload_key
  state=$(mktemp)
  download_object "$state_key" "$state"
  read -r current upload_key < <(python3 - "$state" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(d.get("state",""),(d.get("upload") or {}).get("objectKey",""))
PY
)
  rm -f -- "$state"
  if [ "$current" = CHECKPOINT_UPLOADING ]; then
    [ "$upload_key" = "$stale_object_key" ] || { echo "::error::Active upload state does not belong to Backfill #38." >&2; return 46; }
    state_transition BACKFILLING '{"upload":null,"cleanupPending":false,"recoveredFrom":"backfill-38-explicit-abort"}'
  else
    [ "$current" = BACKFILLING ] || { echo "::error::Unexpected lifecycle state after Backfill #38 abort: $current" >&2; return 46; }
  fi
}

resume_last_slice() {
  local stop_backup pointer_etag pointer_etag_after
  assert_paused_pointer
  assert_lease_inactive
  assert_zero_unfinished_and_no_orphan
  pointer_etag=$(object_etag "$checkpoint_pointer_key")
  projected_peak_guard "$expected_new_checkpoint_bytes" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  stop_backup=$(mktemp)
  download_object "$stop_key" "$stop_backup"
  restore_stop_on_error() {
    local code=$?
    if ! object_exists "$stop_key"; then put_json_cas "$stop_backup" "$stop_key" ABSENT || true; fi
    rm -f -- "$stop_backup"
    exit "$code"
  }
  trap restore_stop_on_error ERR
  r2_destructive s3api delete-object --bucket "$bucket" --key "$stop_key" >/dev/null
  object_exists "$stop_key" && return 43
  pointer_etag_after=$(object_etag "$checkpoint_pointer_key")
  [ "$pointer_etag_after" = "$pointer_etag" ] || { echo "::error::latest.json changed during recovery." >&2; return 48; }
  gh workflow run historical-backfill.yml --repo "$GITHUB_REPOSITORY" --ref main --field batch_dates=2 --field max_cycles=0
  trap - ERR
  rm -f -- "$stop_backup"
  echo "Backfill #38 recovery dispatched only the final slice from the verified 99.69% checkpoint."
}

recover() {
  recovery_dir=$(mktemp -d)
  assert_paused_pointer
  assert_lease_inactive
  if load_exact_stale_upload; then
    abort_multipart_upload_exact "$stale_object_key" "$(cat "$recovery_dir/exact-upload-id")"
    mark_descriptor_aborted
  fi
  assert_zero_unfinished_and_no_orphan
  reset_upload_state_while_paused
  assert_paused_pointer
  resume_last_slice
}

preflight() {
  local usage uploads bytes
  recovery_dir=$(mktemp -d)
  assert_paused_pointer
  assert_lease_inactive
  usage=$(r2_usage_json)
  read -r uploads bytes < <(python3 - "$usage" <<'PY'
import json,sys
d=json.loads(sys.argv[1]); print(d["multipartUploads"],d["multipartBytes"])
PY
)
  [ "$uploads" -eq 1 ] && [ "$bytes" -eq "$expected_part_bytes" ] || {
    echo "::error::Backfill #38 recovery preflight expected exactly one unfinished multipart with ${expected_part_bytes} bytes; found ${uploads} upload(s) and ${bytes} bytes." >&2
    return 45
  }
  load_exact_stale_upload || {
    echo "::error::The unfinished multipart does not exactly match Backfill #38's durable recovery record." >&2
    return 45
  }
  object_exists "$stale_object_key" && {
    echo "::error::A completed object already exists at the Backfill #38 recovery target." >&2
    return 47
  }
  projected_peak_guard "$expected_new_checkpoint_bytes" "$expected_part_bytes"
  echo "Read-only recovery preflight passed: exact Backfill #38 upload matched; no pointer, object, state, lease, or multipart was mutated."
}

case "${1:-recover}" in
  recover) recover ;;
  preflight) preflight ;;
  *) echo "Usage: $0 {recover|preflight}" >&2; exit 2 ;;
esac
