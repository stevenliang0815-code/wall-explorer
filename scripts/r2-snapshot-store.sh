#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint. Large-object lifecycle work is delegated to the
# split Backfill/Checkpoint Promotion implementation. Fixed-key publishing and
# candidate-to-canonical copy promotion are permanently blocked.
operation="${1:-}"
case "$operation" in
  restore) exec bash scripts/r2-checkpoint-lifecycle.sh restore ;;
  checkpoint) exec bash scripts/r2-checkpoint-lifecycle.sh upload ;;
  promote) exec bash scripts/r2-checkpoint-lifecycle.sh promote ;;
  usage-json) exec bash scripts/r2-checkpoint-lifecycle.sh usage-json ;;
  usage-bytes)
    bash scripts/r2-checkpoint-lifecycle.sh usage-json | python3 -c 'import json,sys; print(json.load(sys.stdin)["totalBytes"])'
    ;;
  status)
    # shellcheck source=scripts/r2-historical-common.sh
    source scripts/r2-historical-common.sh
    r2 s3 cp "s3://${bucket}/jobs/historical/state.json" - --only-show-errors
    ;;
  publish)
    echo "::error::Legacy fixed-key publish is disabled. Use Historical Snapshot Finalize." >&2
    exit 43
    ;;
  *)
    echo "Usage: $0 {restore|checkpoint|promote|usage-json|usage-bytes|status|publish}" >&2
    exit 2
    ;;
esac
