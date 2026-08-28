# Historical Snapshot lifecycle

This design replaces fixed-key raw checkpoint replacement with immutable data objects and conditional small-pointer updates. The durable pause marker remains authoritative; deploying this code does not resume Backfill.

## Object layout

| Purpose | Key |
|---|---|
| Immutable raw SQLite | `checkpoints/historical/versions/builder-<raw-sha256>.sqlite` |
| Raw sidecars | `<raw-key>.sha256`, `<raw-key>.status.json`, `<raw-key>.manifest.json` |
| Raw canonical pointer | `checkpoints/historical/latest.json` |
| Pending raw operation | `jobs/historical/pending-checkpoint.json` |
| Immutable gzip | `snapshots/historical/versions/builder-<raw-sha256>.sqlite.gz` |
| Gzip sidecars | `<gzip-key>.sha256`, `<gzip-key>.manifest.json` |
| Published gzip pointer | `snapshots/historical/latest.json` |
| Pending gzip operation | `jobs/historical/pending-snapshot.json` |
| State / lease / pause | `jobs/historical/state.json`, `jobs/historical/lease.json`, `jobs/historical/stop.json` |
| Multipart state | `jobs/historical/uploads/<kind>-<version>.json` |

`ETag` and SHA-256 are separate fields. Multipart ETags are never treated as content hashes.

## Raw pointer schema

```json
{
  "format": "wall-explorer-historical-checkpoint-pointer-v3",
  "version": "<raw-sha256>",
  "objectKey": "checkpoints/historical/versions/builder-<raw-sha256>.sqlite",
  "sha256": "<raw-sha256>",
  "bytes": 0,
  "rows": 0,
  "progress": 0,
  "lastDate": "YYYY-MM-DD",
  "createdAt": "ISO-8601",
  "schemaVersion": 0,
  "compression": "none",
  "status": "verified",
  "statusKey": "<raw-key>.status.json",
  "manifestKey": "<raw-key>.manifest.json",
  "previousObjectKey": null
}
```

At 100%, `status` is `raw-100-percent`. After compressed publication, the raw pointer becomes `status: finalized`, `objectKey: null`, and records `supersededBy: snapshots/historical/latest.json` plus the previous raw keys for idempotent cleanup.

## Compressed pointer schema

```json
{
  "format": "wall-explorer-historical-snapshot-pointer-v1",
  "version": "<raw-sha256>",
  "objectKey": "snapshots/historical/versions/builder-<raw-sha256>.sqlite.gz",
  "compressedBytes": 0,
  "compressedSha256": "<gzip-sha256>",
  "rawBytes": 0,
  "rawSha256": "<raw-sha256>",
  "rows": 0,
  "progress": 100,
  "lastDate": "2025-12-28",
  "schemaVersion": 0,
  "compression": "gzip-9-n",
  "status": "verified",
  "manifestKey": "<gzip-key>.manifest.json",
  "createdAt": "ISO-8601"
}
```

## State and ownership

The state sequence is:

`BACKFILLING → CHECKPOINT_UPLOADING → CHECKPOINT_VERIFYING → CHECKPOINT_PROMOTING → CHECKPOINT_CLEANUP → BACKFILLING|RAW_100_PERCENT → FINALIZING → COMPRESSED_UPLOADING → COMPRESSED_VERIFYING → COMPRESSED_PROMOTED → RAW_CLEANUP → COMPLETE`.

All large-object workflows share GitHub Actions concurrency and also acquire a conditional R2 lease with owner, purpose, start time, and expiry. Pointer/state/lease writes use `If-Match` or `If-None-Match`; a precondition conflict stops instead of overwriting newer state.

## Capacity and cadence

The only R2 usage value used for safety is:

```text
real_r2_usage = completed_object_bytes + unfinished_multipart_part_bytes
projected_peak = completed_object_bytes
               + unfinished_multipart_part_bytes
               + max(0, expected_new_bytes - uploaded_bytes_for_same_upload)
               + safety_reserve_bytes
```

Every `ListObjects`, `ListMultipartUploads`, and `ListParts` call is paginated by the AWS CLI. A large write is rejected before multipart creation if the projected peak reaches 25,000,000,000 bytes or unrelated unfinished multipart exists.

Within one runner, small batches continue without uploading the full SQLite until at least one date/unit advanced and either progress increased by 0.5 percentage point or four hours elapsed. A 100% checkpoint is always due. Runner death before cadence loses only the uncommitted in-run delta and resumes from the last verified R2 checkpoint.

## Workflow responsibilities

- Historical Snapshot Backfill: restore, run small batches, locally validate, capacity-check, and upload exactly one immutable pending raw checkpoint. It never moves a pointer or deletes a checkpoint.
- Historical Checkpoint Promotion: fresh-download verification, conditional pointer switch, second fresh-download verification, and previous raw cleanup. A cleanup failure leaves the new canonical active and blocks another large write.
- Historical Snapshot Finalize: only accepts a 100% raw pointer; validates data semantics, creates deterministic `gzip -9n`, uploads one immutable gzip, verifies the remote gzip and decompressed SQLite, promotes the compressed pointer, finalizes the raw pointer, then removes raw objects.
- Historical Snapshot Garbage Collection: prints keep/delete/abort lists first. Apply is manual, lease-protected, blocked while paused by default, and deletes only managed objects not referenced by a pointer, pending operation, active state/upload, lease, or rollback target.

## Failure and retry rules

| Failure | Durable result | Retry |
|---|---|---|
| Multipart interrupted | Explicit abort; partial/new object removed; old pointer unchanged; paused | Resume upload state after inspecting durable state |
| Uploaded SHA/size/SQLite mismatch | Pointer unchanged; failed object/sidecars safely removed; failure descriptor retained | Rebuild from current canonical |
| Pointer CAS/update failure | Old canonical and verified new object retained | Retry only verification and small pointer write |
| Previous cleanup failure | New canonical remains valid; `cleanupPending=true` | Cleanup only; no new Backfill upload |
| Runner death | Lease expires; last verified pointer remains | Continue from recorded state |
| Gzip/compressed upload failure | Raw 100% pointer/object retained; multipart aborted | Resume Finalize state |
| Finalize interrupted after compressed promotion | Published gzip retained; raw retained until pointer finalization and cleanup resume | Pointer/raw-cleanup only |
| Hard limit reached | No multipart begins | Cleanup or raise the reviewed limit before retry |

The invariant is: never delete the last verified recoverable copy, and never begin a third large object while cleanup is pending.
