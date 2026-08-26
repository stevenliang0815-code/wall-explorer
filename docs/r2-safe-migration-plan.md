# R2 Safe Snapshot Migration Plan

Status: design only. No R2 deletion, replacement, compression upload, or legacy publish is authorized by this document.

## Current verified state

- R2 objects: 7
- R2 total: 9,145,801,044 bytes
- Active checkpoint: `checkpoints/historical/builder.sqlite`
- Active checkpoint size: 9,138,499,584 bytes
- Backfill progress: 95.16%
- Stored rows including the legacy continuation: 23,095,530
- SQLite integrity check: pass
- Stored SHA-256: match
- Measured gzip size at 95.16%: 1,092,097,819 bytes
- Gzip round-trip SHA-256: match
- Direct R2 replacement peak: 10,237,898,863 bytes
- R2 hard stop: 9,700,000,000 bytes

A direct upload-before-delete migration is prohibited because its measured peak exceeds both the 9.70 GB hard stop and the 10 GB absolute limit.

## Safety invariants

1. The existing R2 `builder.sqlite` is immutable until every deletion gate passes.
2. No GitHub ephemeral runner may be the only copy after the R2 source is deleted.
3. No public GitHub Release, repository file, Actions cache, or short-lived artifact is an approved durable staging destination.
4. Secrets remain in GitHub Actions Secrets and are never printed.
5. R2 usage includes completed objects and all incomplete multipart parts.
6. No operation may start when its projected peak is at or above 9,700,000,000 bytes.
7. Snapshot validation must retain the look-ahead and survivorship-bias gates.
8. `snapshots/latest` must be a small pointer/manifest only; it must not duplicate snapshot data.
9. The final R2 snapshot contains compressed canonical data, manifests, checksums, and required job state only.
10. A failed operation always leaves at least one independently restorable durable copy.

## Required external staging

Before continuation, provision two independently recoverable durable copies:

- Stage A: private, durable object storage with versioning or immutability enabled.
- Stage B: a separate failure domain, such as another provider/account or a verified cross-region replica with independent recovery.
- Each stage must have at least 3 GB free for the expected final compressed database, manifest, and validation records.
- Both stages must support exact byte size, SHA-256 metadata, private access, and retention long enough to complete import and a restore drill.
- Credentials must be stored as GitHub Actions Secrets.
- Neither stage may expose the snapshot publicly.

A single ephemeral runner, one unreplicated object, or a temporary GitHub Artifact does not satisfy this requirement.

## Phase 1: Code readiness before data movement

Implement and test without deleting R2 data:

1. Restore supports:
   `R2 .sqlite.gz -> download/stream -> gzip -t -> decompress -> SHA-256 -> SQLite`.
2. Checkpoint output is gzip only; no raw SQLite is uploaded to R2.
3. Manifest records:
   - compressed filename
   - compressed and uncompressed bytes
   - compression type
   - compressed SHA-256
   - uncompressed SHA-256
   - snapshot date
   - row count
   - schema/version
   - bias-audit results
4. Publishing writes one canonical version only.
5. `manifests/latest.json` points to the canonical version and contains no duplicate payload.
6. All destructive commands require an explicit migration mode and verified gate file.

## Phase 2: Complete the remaining backfill safely

The active 95.16% R2 checkpoint remains unchanged.

1. Download the R2 checkpoint to an ephemeral runner.
2. Verify the stored SHA-256 before opening SQLite.
3. Run the remaining backfill locally.
4. After every logical batch:
   - measure the real R2 total, including incomplete multipart parts;
   - stop if R2 is at or above 9.70 GB;
   - do not upload a replacement raw SQLite to R2;
   - write a compressed durable continuation checkpoint to both Stage A and Stage B;
   - verify remote size and checksum on both stages before continuing.
5. If the runner fails, restore from the newest matching Stage A/Stage B checkpoint. If those are unavailable, restore the unchanged 95.16% R2 checkpoint.
6. At 100%, run:
   - `PRAGMA wal_checkpoint(TRUNCATE)`
   - confirm no active transaction or WAL dependency
   - `PRAGMA integrity_check`
   - row counts and duplicate checks
   - survivorship-bias audit
   - look-ahead audit
   - raw SHA-256
   - gzip level 9
   - `gzip -t`
   - streamed decompression SHA-256 comparison

## Phase 3: External durability and independent restore gate

Upload the final compressed snapshot, manifest, and checksums to both Stage A and Stage B.

Deletion remains blocked until all checks pass:

- Stage A object size matches the local compressed size.
- Stage B object size matches the local compressed size.
- Stage A compressed SHA-256 matches.
- Stage B compressed SHA-256 matches.
- A fresh runner restores from Stage A and passes gzip, SHA-256, SQLite integrity, row-count, schema, and bias audits.
- A second fresh restore path verifies Stage B independently.
- A migration gate record contains both object versions, checksums, validation timestamps, and recovery commands.
- The runner copy is treated as disposable and is not counted as a backup.

## Phase 4: R2 replacement

Only after Phase 3 succeeds:

1. Measure R2 completed objects and incomplete multipart parts again.
2. Confirm the expected compressed upload plus all multipart parts remains below 9.70 GB after the raw object is removed.
3. Confirm Stage A and Stage B are still readable.
4. Delete only `checkpoints/historical/builder.sqlite`.
5. Confirm R2 usage decreased by the exact raw object size.
6. Upload the verified final `.sqlite.gz` to one canonical R2 key.
7. Upload its checksum and manifest.
8. Download the R2 gzip to a fresh runner and repeat the full restore verification.
9. Publish only a small latest pointer.
10. Do not remove either external staging copy yet.

Expected R2 size after the current measured replacement is approximately 1.10 GB. The final 100% snapshot must be measured again; projections are not deletion evidence.

## Rollback matrix

| Failure | Recovery |
|---|---|
| Runner fails before staging | R2 95.16% raw checkpoint remains unchanged |
| One external upload fails | Keep R2 raw; retry the failed stage |
| Stage A restore fails | Keep R2 raw; Stage B is tested but deletion remains blocked |
| Stage B restore fails | Keep R2 raw; Stage A is tested but deletion remains blocked |
| R2 raw deletion succeeds but gzip upload fails | Restore verified gzip from Stage A or Stage B |
| R2 gzip verification fails | Remove no external copies; upload again from a verified stage |
| Web import fails | R2 gzip and both external stages remain available |
| Capacity cannot be measured | Fail closed and perform no write or deletion |

## Cleanup gate

External staging and obsolete metadata may be removed only after:

- R2 gzip passes an independent restore,
- the Web App import completes,
- row counts and bias audits pass in the Web App,
- at least one scheduled daily update succeeds,
- a documented rollback window expires,
- the user explicitly approves cleanup.

The empty prefix marker and old small job-state files provide negligible savings and are not part of the migration critical path.
