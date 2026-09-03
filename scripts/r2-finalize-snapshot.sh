#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint for callers created before the versioned compressed
# Snapshot lifecycle. No fixed gzip key or raw-delete/copy promotion remains.
operation="${1:-}"
case "$operation" in
  finalize|migrate) exec bash scripts/r2-finalize-lifecycle.sh finalize ;;
  is-ready) exec bash scripts/r2-finalize-lifecycle.sh is-ready ;;
  raw-cleanup) exec bash scripts/r2-finalize-lifecycle.sh raw-cleanup ;;
  *)
    echo "Usage: $0 {finalize|is-ready|raw-cleanup}" >&2
    exit 2
    ;;
esac
