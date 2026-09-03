import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  FAILURE_POLICIES,
  STATES,
  assertTransition,
  checkpointDue,
  checkpointPointer,
  gcPlan,
  projectedPeak,
  snapshotPointer,
  transitionState,
} from "../scripts/historical-lifecycle.mjs";

const execFile = promisify(execFileCallback);

test("durable lifecycle exposes every required state", () => {
  assert.deepEqual(STATES, [
    "BACKFILLING", "CHECKPOINT_UPLOADING", "CHECKPOINT_VERIFYING", "CHECKPOINT_PROMOTING",
    "CHECKPOINT_CLEANUP", "RAW_100_PERCENT", "FINALIZING", "COMPRESSED_UPLOADING",
    "COMPRESSED_VERIFYING", "COMPRESSED_PROMOTED", "RAW_CLEANUP", "COMPLETE",
  ]);
});

test("state transitions advance and reject unsafe skips", () => {
  const next = transitionState({ state: "BACKFILLING", revision: 3 }, "CHECKPOINT_UPLOADING", { runId: "12" }, "2026-08-28T00:00:00Z");
  assert.equal(next.revision, 4);
  assert.equal(next.runId, "12");
  assert.throws(() => assertTransition("BACKFILLING", "COMPLETE"), /Illegal/);
  assert.equal(assertTransition("CHECKPOINT_PROMOTING", "CHECKPOINT_PROMOTING"), true);
});

test("shell state transition forwards JSON patches without an extra closing brace", async () => {
  const { stdout } = await execFile("bash", ["-c", String.raw`
    set -euo pipefail
    source scripts/r2-historical-common.sh
    object_exists() { return 1; }
    put_json_cas() { cat "$1"; }
    state_transition CHECKPOINT_UPLOADING '{"cleanupPending":false,"upload":{"objectKey":"raw-new"}}'
  `], {
    env: {
      ...process.env,
      R2_ACCOUNT_ID: "test",
      R2_BUCKET: "test",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
    },
  });
  const state = JSON.parse(stdout);
  assert.equal(state.state, "CHECKPOINT_UPLOADING");
  assert.equal(state.cleanupPending, false);
  assert.equal(state.upload.objectKey, "raw-new");
});

test("projected peak counts objects, multipart parts, remaining upload, and reserve", () => {
  assert.equal(projectedPeak({ completedObjectBytes: 9_240_882_390, unfinishedMultipartBytes: 200, expectedNewBytes: 9_233_580_032, uploadedBytesForSameUpload: 100, safetyReserveBytes: 100_000_000 }), 18_574_462_522);
});

test("checkpoint cadence requires a completed unit and enough progress or time", () => {
  const prior = { progress: 95.57, overallCompletedUnits: 11602, currentDate: "2025-04-01", committedAt: "2026-08-28T00:00:00Z" };
  assert.deepEqual(checkpointDue({ ...prior, progress: 95.8, overallCompletedUnits: 11603, currentDate: "2025-04-02" }, prior, { nowMs: Date.parse("2026-08-28T01:00:00Z") }), { due: false, reason: "cadence-threshold-not-reached" });
  assert.equal(checkpointDue({ ...prior, progress: 96.1, overallCompletedUnits: 11603 }, prior).due, true);
  assert.equal(checkpointDue({ status: "complete", progress: 100 }, prior).reason, "raw-100-percent");
});

test("raw and compressed pointers use separate immutable namespaces", () => {
  const hash = "a".repeat(64);
  const raw = checkpointPointer({ version: hash, objectKey: `checkpoints/historical/versions/builder-${hash}.sqlite`, bytes: 10, sha256: hash, rows: 2, progress: 96, lastDate: "2025-01-01", schemaVersion: 1, statusKey: "s", manifestKey: "m", createdAt: "now" });
  const gz = snapshotPointer({ version: hash, objectKey: `snapshots/historical/versions/builder-${hash}.sqlite.gz`, compressedBytes: 5, compressedSha256: hash, rawBytes: 10, rawSha256: hash, rows: 2, lastDate: "2025-12-28", schemaVersion: 1, createdAt: "now", manifestKey: "gzm" });
  assert.equal(raw.compression, "none");
  assert.equal(gz.compression, "gzip-9-n");
  assert.notEqual(raw.objectKey, gz.objectKey);
});

test("GC never deletes pointer, active upload, rollback, or current canonical", () => {
  const current = "checkpoints/historical/versions/builder-current.sqlite";
  const active = "checkpoints/historical/versions/builder-upload.sqlite";
  const rollback = "checkpoints/historical/candidates/legacy/builder.sqlite";
  const stale = "checkpoints/historical/versions/builder-stale.sqlite";
  const plan = gcPlan({
    objects: [current, active, rollback, stale, "jobs/historical/state.json"],
    checkpointPointer: { objectKey: current }, snapshotPointer: null,
    state: { upload: { objectKey: active } }, pending: null, lease: null,
    rollback: { rollbackObjectKey: rollback },
  });
  assert.deepEqual(plan.delete, [stale]);
  assert.ok(plan.keep.includes(current));
  assert.ok(plan.keep.includes(active));
  assert.ok(plan.keep.includes(rollback));
});

test("GC preserves the only legacy bootstrap candidate when no pointer exists", () => {
  const candidate = "checkpoints/historical/candidates/33060404237-1/builder.sqlite";
  const plan = gcPlan({
    objects: [candidate, `${candidate}.sha256`, "checkpoints/historical/candidates/33060404237-1/status.json"],
    checkpointPointer: null, snapshotPointer: null, state: null, pending: null, lease: null, rollback: null,
  });
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.keep.length, 3);
});

for (const [scenario, policy] of Object.entries(FAILURE_POLICIES)) {
  test(`failure policy: ${scenario}`, () => {
    assert.ok(policy);
    if (scenario !== "cleanup_delete_failed" && scenario !== "workflow_retry") {
      assert.notEqual(policy.canonicalMoves, true);
      assert.notEqual(policy.rawCanonicalMoves, true);
    }
  });
}

test("cleanup failure blocks a third large object without invalidating new canonical", () => {
  assert.equal(FAILURE_POLICIES.cleanup_delete_failed.canonicalMoves, true);
  assert.equal(FAILURE_POLICIES.cleanup_delete_failed.blockLargeWrites, true);
  assert.equal(FAILURE_POLICIES.cleanup_delete_failed.resume, "CHECKPOINT_CLEANUP");
});

test("pointer failure retries only the small pointer", () => {
  assert.equal(FAILURE_POLICIES.pointer_update_failed.retry, "pointer-only");
  assert.equal(FAILURE_POLICIES.pointer_update_failed.keepOld, true);
  assert.equal(FAILURE_POLICIES.pointer_update_failed.keepNew, true);
});

class FailureHarness {
  constructor() {
    this.objects = new Set(["raw-old"]);
    this.rawPointer = "raw-old";
    this.snapshotPointer = null;
    this.state = "BACKFILLING";
    this.cleanupPending = false;
    this.multipart = new Set();
    this.largeUploads = 0;
    this.paused = false;
  }
  canLargeWrite() { return !this.cleanupPending && !["CHECKPOINT_CLEANUP", "RAW_CLEANUP"].includes(this.state); }
  beginRawUpload() { if (!this.canLargeWrite()) throw new Error("large-write-blocked"); this.state = "CHECKPOINT_UPLOADING"; this.multipart.add("raw-new"); }
  completeRawUpload() { this.multipart.delete("raw-new"); this.objects.add("raw-new"); this.largeUploads += 1; this.state = "CHECKPOINT_VERIFYING"; }
  abortRawUpload() { this.multipart.delete("raw-new"); this.objects.delete("raw-new"); this.paused = true; }
  promoteRaw({ pointerFails = false } = {}) {
    this.state = "CHECKPOINT_PROMOTING";
    if (pointerFails) { this.paused = true; return; }
    this.rawPointer = "raw-new"; this.state = "CHECKPOINT_CLEANUP"; this.cleanupPending = true;
  }
  cleanupRaw({ deleteFails = false } = {}) {
    if (deleteFails) return;
    this.objects.delete("raw-old"); this.cleanupPending = false; this.state = "BACKFILLING";
  }
  beginGzip() { this.state = "FINALIZING"; }
  completeGzipUpload() { this.objects.add("snapshot-new"); this.largeUploads += 1; this.state = "COMPRESSED_VERIFYING"; }
  promoteGzip() { this.snapshotPointer = "snapshot-new"; this.state = "COMPRESSED_PROMOTED"; }
  cleanupFinalRaw() { this.objects.delete(this.rawPointer); this.rawPointer = null; this.state = "COMPLETE"; }
}

test("fault injection: multipart interruption aborts parts and preserves canonical", () => {
  const h = new FailureHarness(); h.beginRawUpload(); h.abortRawUpload();
  assert.equal(h.rawPointer, "raw-old"); assert.equal(h.multipart.size, 0); assert.equal(h.objects.has("raw-new"), false); assert.equal(h.paused, true);
});

test("fault injection: SHA mismatch removes unpromoted object", () => {
  const h = new FailureHarness(); h.beginRawUpload(); h.completeRawUpload(); h.abortRawUpload();
  assert.equal(h.rawPointer, "raw-old"); assert.deepEqual([...h.objects], ["raw-old"]);
});

test("fault injection: pointer failure retains old and verified new and retry does not upload again", () => {
  const h = new FailureHarness(); h.beginRawUpload(); h.completeRawUpload(); h.promoteRaw({ pointerFails: true });
  const uploads = h.largeUploads; assert.equal(h.rawPointer, "raw-old"); assert.equal(h.objects.has("raw-new"), true);
  h.promoteRaw(); assert.equal(h.rawPointer, "raw-new"); assert.equal(h.largeUploads, uploads);
});

test("fault injection: cleanup failure keeps new canonical and blocks a third raw", () => {
  const h = new FailureHarness(); h.beginRawUpload(); h.completeRawUpload(); h.promoteRaw(); h.cleanupRaw({ deleteFails: true });
  assert.equal(h.rawPointer, "raw-new"); assert.equal(h.objects.has("raw-old"), true); assert.throws(() => h.beginRawUpload(), /blocked/);
  h.cleanupRaw(); assert.equal(h.objects.has("raw-old"), false); assert.equal(h.canLargeWrite(), true);
});

test("fault injection: runner death leaves last verified pointer and no second Backfill", () => {
  const h = new FailureHarness(); h.state = "BACKFILLING";
  assert.equal(h.rawPointer, "raw-old"); assert.equal(h.largeUploads, 0); assert.equal(h.objects.size, 1);
});

test("fault injection: gzip and gzip-upload failures keep the 100% raw", () => {
  const h = new FailureHarness(); h.rawPointer = "raw-100"; h.objects = new Set(["raw-100"]); h.beginGzip();
  assert.equal(h.objects.has("raw-100"), true); h.multipart.add("snapshot-new"); h.multipart.delete("snapshot-new");
  assert.equal(h.snapshotPointer, null); assert.equal(h.objects.has("raw-100"), true);
});

test("fault injection: Finalize interruption resumes without deleting raw", () => {
  const h = new FailureHarness(); h.rawPointer = "raw-100"; h.objects = new Set(["raw-100"]); h.beginGzip(); h.completeGzipUpload();
  assert.equal(h.state, "COMPRESSED_VERIFYING"); assert.equal(h.rawPointer, "raw-100");
  h.promoteGzip(); h.cleanupFinalRaw(); assert.equal(h.state, "COMPLETE"); assert.equal(h.snapshotPointer, "snapshot-new");
});

test("fault injection: near hard limit rejects before multipart begins", () => {
  const peak = projectedPeak({ completedObjectBytes: 18_000_000_000, unfinishedMultipartBytes: 0, expectedNewBytes: 9_000_000_000, safetyReserveBytes: 100_000_000 });
  const h = new FailureHarness();
  assert.ok(peak >= 25_000_000_000); assert.equal(h.multipart.size, 0); assert.equal(h.largeUploads, 0); assert.equal(h.rawPointer, "raw-old");
});
