# R2 Safe Snapshot Migration Plan

Status: 25 GB guard implementation and read-only dry-run only. Backfill remains paused until the dry-run result is reviewed. No R2 deletion, replacement, compression upload, or legacy publish is authorized by this document.

## Current verified state

- R2 completed objects: 9,145,801,044 bytes
- Unfinished multipart parts: 0 bytes
- Active checkpoint: `checkpoints/historical/builder.sqlite`
- Active checkpoint size: 9,138,499,584 bytes
- Backfill progress: 95.16%
- Stored rows including the legacy continuation: 23,095,530
- SQLite integrity check: pass
- Stored SHA-256: match
- Measured gzip size at 95.16%: 1,092,097,819 bytes
- Gzip round-trip SHA-256: match
- R2 hard stop: exactly 25,000,000,000 bytes

## Capacity formula

Before every batch and checkpoint:

```text
projected_peak = completed_object_bytes
               + unfinished_multipart_part_bytes
               + next_checkpoint_raw_bytes
               + 100,000,000-byte reserve
```

An operation must not start when `projected_peak >= 25,000,000,000`.

Using the current checkpoint as the next-checkpoint estimate:

```text
9,145,801,044 + 0 + 9,138,499,584 + 100,000,000
= 18,384,300,628 bytes
```

This is below the 25 GB hard stop, but it is only permission to consider resuming after the read-only dry-run is reviewed. It does not start the backfill automatically.

## Safe checkpoint replacement

Directly overwriting `builder.sqlite` and checking its checksum afterward is not sufficient because the old object has already been replaced when multipart completion succeeds. Each checkpoint therefore uses one bounded candidate chain:

1. Refuse to start if any unfinished multipart upload or existing candidate checkpoint is present.
2. Upload the new SQLite to one run-scoped candidate key.
3. Upload candidate checksum and status metadata.
4. Stream the candidate back and verify exact bytes and SHA-256.
5. Only after candidate verification, delete the old canonical `builder.sqlite`.
6. Copy the verified candidate to the canonical key.
7. Stream and verify the new canonical object again.
8. Update checksum and job status metadata.
9. Delete the candidate only after the canonical verification succeeds.

At every failure point, at least one of the following remains restorable:

- the old canonical checkpoint;
- the verified candidate checkpoint;
- the new verified canonical checkpoint.

If the canonical key is absent, restore may use exactly one candidate only after its SHA-256 passes. Multiple candidates cause a fail-closed stop; the workflow never guesses.

## Retry and orphan protection

- AWS client attempts are bounded at 3 with standard retry mode.
- Workflow concurrency prevents two historical backfills from running simultaneously.
- No new checkpoint starts while unfinished multipart data exists.
- No new checkpoint starts while a candidate checkpoint exists.
- Candidate objects use a single run/attempt namespace and are removed only after successful promotion.
- Failed-run handlers do not upload another raw SQLite.
- Legacy duplicate publishing remains disabled.

## Remaining 4.84% peak estimate

Linear projection from 95.16% gives an estimated final raw SQLite size of approximately 9,603,299,269 bytes. Near completion, the conservative checkpoint peak is:

```text
small metadata and other R2 objects
+ previous raw canonical
+ new raw candidate / multipart parts
+ 100,000,000-byte reserve
```

Using a previous and new raw checkpoint both near 9.60 GB gives approximately 19.31 GB. A 20% growth stress case is approximately 23.15 GB. Both remain below 25 GB; every real checkpoint still recalculates using live completed and multipart bytes.

## Completion validation

At 100%, before any raw-to-gzip replacement:

1. Finish and close the SQLite writer.
2. Run `PRAGMA wal_checkpoint(TRUNCATE)`.
3. Run `PRAGMA integrity_check` and require exactly `ok`.
4. Verify job status, progress, last completed unit/date, row count, duplicate gates, look-ahead audit, and survivorship-bias audit.
5. Calculate raw SHA-256 and raw bytes.
6. Create deterministic gzip level 9 output with `gzip -9n`.
7. Run `gzip -t`.
8. Stream-decompress and require the decompressed SHA-256 to match the raw SQLite SHA-256.

The completed-backfill workflow validates these properties locally but does not automatically delete or replace the R2 raw checkpoint.

## Final raw-to-gzip migration

The final gzip migration uses the same candidate principle:

1. Upload one gzip candidate while the raw canonical remains present.
2. Verify compressed bytes, compressed SHA-256, `gzip -t`, and decompressed raw SHA-256 from R2.
3. Delete the raw canonical only after the gzip candidate passes every check.
4. Copy/promote the verified gzip candidate to one canonical `.sqlite.gz` key.
5. Verify the canonical R2 gzip again from a fresh runner.
6. Write the manifest, checksums, job state, and a small latest pointer.
7. Delete the candidate only after the canonical gzip is independently verified.

The measured 95.16% gzip is 1,092,097,819 bytes. Linear final projection is approximately 1,147,643,778 bytes, so the final raw-plus-gzip migration peak is expected near 10.8 GB, safely below 25 GB. Actual final sizes are mandatory inputs to the migration preflight.

## Billing estimate

Cloudflare R2 Standard storage includes 10 GB-month per month. Additional Standard storage is currently US$0.015 per GB-month; egress is free. Storage is based on average daily peak usage, not the single highest instantaneous byte measurement.

Temporary checkpoint peaks therefore cost only for the fraction of the month that the extra candidate exists. The operation-count free tiers are far above this workflow's expected request count, but actual account-wide usage must still be considered.
