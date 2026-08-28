#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

export const STATES = Object.freeze([
  "BACKFILLING",
  "CHECKPOINT_UPLOADING",
  "CHECKPOINT_VERIFYING",
  "CHECKPOINT_PROMOTING",
  "CHECKPOINT_CLEANUP",
  "RAW_100_PERCENT",
  "FINALIZING",
  "COMPRESSED_UPLOADING",
  "COMPRESSED_VERIFYING",
  "COMPRESSED_PROMOTED",
  "RAW_CLEANUP",
  "COMPLETE",
]);

const FORWARD = new Map([
  ["BACKFILLING", new Set(["CHECKPOINT_UPLOADING"])],
  ["CHECKPOINT_UPLOADING", new Set(["CHECKPOINT_VERIFYING", "BACKFILLING"])],
  ["CHECKPOINT_VERIFYING", new Set(["CHECKPOINT_PROMOTING", "BACKFILLING"])],
  ["CHECKPOINT_PROMOTING", new Set(["CHECKPOINT_CLEANUP", "BACKFILLING"])],
  ["CHECKPOINT_CLEANUP", new Set(["BACKFILLING", "RAW_100_PERCENT"])],
  ["RAW_100_PERCENT", new Set(["FINALIZING"])],
  ["FINALIZING", new Set(["COMPRESSED_UPLOADING"])],
  ["COMPRESSED_UPLOADING", new Set(["COMPRESSED_VERIFYING", "FINALIZING"])],
  ["COMPRESSED_VERIFYING", new Set(["COMPRESSED_PROMOTED", "FINALIZING"])],
  ["COMPRESSED_PROMOTED", new Set(["RAW_CLEANUP"])],
  ["RAW_CLEANUP", new Set(["COMPLETE"])],
  ["COMPLETE", new Set()],
]);

export function assertTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) {
    throw new Error(`Unknown lifecycle state: ${from} -> ${to}`);
  }
  if (from === to) return true;
  if (!FORWARD.get(from).has(to)) {
    throw new Error(`Illegal lifecycle transition: ${from} -> ${to}`);
  }
  return true;
}

export function transitionState(current, to, patch = {}, now = new Date().toISOString()) {
  assertTransition(current.state, to);
  return {
    ...current,
    ...patch,
    format: "wall-explorer-historical-lifecycle-v1",
    state: to,
    updatedAt: now,
    revision: Number(current.revision ?? 0) + 1,
  };
}

export function projectedPeak({
  completedObjectBytes,
  unfinishedMultipartBytes,
  expectedNewBytes,
  uploadedBytesForSameUpload = 0,
  safetyReserveBytes,
}) {
  for (const [name, value] of Object.entries({
    completedObjectBytes,
    unfinishedMultipartBytes,
    expectedNewBytes,
    uploadedBytesForSameUpload,
    safetyReserveBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  const remainingUploadBytes = Math.max(0, expectedNewBytes - uploadedBytesForSameUpload);
  return completedObjectBytes + unfinishedMultipartBytes + remainingUploadBytes + safetyReserveBytes;
}

export function checkpointDue(current, previous, options = {}) {
  const minProgressDelta = Number(options.minProgressDelta ?? 0.5);
  const maxElapsedMs = Number(options.maxElapsedMs ?? 4 * 60 * 60 * 1000);
  const nowMs = Number(options.nowMs ?? Date.now());
  const progress = Number(current.progress ?? 0);
  if (progress === 100 || current.status === "complete") return { due: true, reason: "raw-100-percent" };
  if (!previous) return { due: true, reason: "bootstrap" };

  const unitAdvanced = Number(current.overallCompletedUnits ?? 0) > Number(previous.overallCompletedUnits ?? 0);
  const dateAdvanced = String(current.currentDate ?? "") !== String(previous.currentDate ?? "");
  if (!unitAdvanced && !dateAdvanced) return { due: false, reason: "no-new-completed-unit" };

  const progressDelta = progress - Number(previous.progress ?? 0);
  if (progressDelta >= minProgressDelta) return { due: true, reason: "progress-delta" };

  const previousMs = Date.parse(previous.committedAt ?? previous.createdAt ?? "");
  if (Number.isFinite(previousMs) && nowMs - previousMs >= maxElapsedMs) {
    return { due: true, reason: "elapsed-time" };
  }
  return { due: false, reason: "cadence-threshold-not-reached" };
}

export function checkpointPointer(manifest, previous = null) {
  const required = ["version", "objectKey", "bytes", "sha256", "rows", "progress", "lastDate", "schemaVersion", "statusKey", "manifestKey", "createdAt"];
  for (const key of required) if (manifest[key] === undefined || manifest[key] === null) throw new Error(`Checkpoint manifest missing ${key}`);
  if (!/^checkpoints\/historical\/versions\/builder-[a-f0-9]{64}\.sqlite$/.test(manifest.objectKey)) throw new Error("Checkpoint key is not immutable/versioned");
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Invalid checkpoint SHA-256");
  return {
    format: "wall-explorer-historical-checkpoint-pointer-v3",
    version: manifest.version,
    objectKey: manifest.objectKey,
    sha256: manifest.sha256,
    bytes: Number(manifest.bytes),
    rows: Number(manifest.rows),
    progress: Number(manifest.progress),
    lastDate: manifest.lastDate,
    createdAt: manifest.createdAt,
    schemaVersion: Number(manifest.schemaVersion),
    compression: "none",
    status: Number(manifest.progress) === 100 ? "raw-100-percent" : "verified",
    statusKey: manifest.statusKey,
    manifestKey: manifest.manifestKey,
    previousObjectKey: previous?.objectKey ?? null,
  };
}

export function snapshotPointer(manifest) {
  const required = ["version", "objectKey", "compressedBytes", "compressedSha256", "rawBytes", "rawSha256", "rows", "lastDate", "schemaVersion", "createdAt", "manifestKey"];
  for (const key of required) if (manifest[key] === undefined || manifest[key] === null) throw new Error(`Snapshot manifest missing ${key}`);
  if (!/^snapshots\/historical\/versions\/builder-[a-f0-9]{64}\.sqlite\.gz$/.test(manifest.objectKey)) throw new Error("Snapshot key is not immutable/versioned");
  return {
    format: "wall-explorer-historical-snapshot-pointer-v1",
    version: manifest.version,
    objectKey: manifest.objectKey,
    compressedSha256: manifest.compressedSha256,
    compressedBytes: Number(manifest.compressedBytes),
    rawSha256: manifest.rawSha256,
    rawBytes: Number(manifest.rawBytes),
    rows: Number(manifest.rows),
    progress: 100,
    lastDate: manifest.lastDate,
    createdAt: manifest.createdAt,
    schemaVersion: Number(manifest.schemaVersion),
    compression: "gzip-9-n",
    status: "verified",
    manifestKey: manifest.manifestKey,
  };
}

function referencedKeys(doc) {
  if (!doc || typeof doc !== "object") return [];
  return [
    doc.objectKey,
    doc.statusKey,
    doc.manifestKey,
    doc.checksumKey,
    doc.descriptorKey,
    doc.uploadDescriptorKey,
    doc.previousObjectKey,
    doc.upload?.objectKey,
    doc.pendingCheckpoint?.objectKey,
    doc.rollbackObjectKey,
  ].filter(Boolean);
}

export function gcPlan({ objects, checkpointPointer: raw, snapshotPointer: compressed, state, pending, lease, rollback }) {
  const keep = new Set([
    "checkpoints/historical/latest.json",
    "snapshots/historical/latest.json",
    "jobs/historical/state.json",
    "jobs/historical/stop.json",
    "jobs/historical/lease.json",
    "jobs/historical/pending-checkpoint.json",
    ...referencedKeys(raw),
    ...referencedKeys(compressed),
    ...referencedKeys(state),
    ...referencedKeys(pending),
    ...referencedKeys(lease),
    ...referencedKeys(rollback),
  ]);
  for (const key of [...keep]) {
    if (key.endsWith(".sqlite")) {
      keep.add(`${key}.sha256`);
      keep.add(`${key}.status.json`);
      keep.add(`${key}.manifest.json`);
    }
    if (key.endsWith(".sqlite.gz")) {
      keep.add(`${key}.sha256`);
      keep.add(`${key}.manifest.json`);
    }
  }
  const managed = (key) =>
    key.startsWith("checkpoints/historical/versions/") ||
    key.startsWith("checkpoints/historical/candidates/") ||
    key.startsWith("snapshots/historical/versions/") ||
    key.startsWith("snapshots/historical/candidates/") ||
    key.startsWith("jobs/historical/uploads/");
  const keys = objects.map((item) => typeof item === "string" ? item : item.key);
  if (!raw?.objectKey && !compressed?.objectKey) {
    for (const key of keys) {
      if (key.startsWith("checkpoints/historical/candidates/") || key === "checkpoints/historical/builder.sqlite") keep.add(key);
    }
  }
  return {
    keep: keys.filter((key) => keep.has(key)).sort(),
    delete: keys.filter((key) => managed(key) && !keep.has(key)).sort(),
    ignored: keys.filter((key) => !managed(key) && !keep.has(key)).sort(),
  };
}

export const FAILURE_POLICIES = Object.freeze({
  multipart_upload_interrupted: { canonicalMoves: false, abortMultipart: true, deleteNew: true, pause: true, resume: "BACKFILLING" },
  sha256_mismatch: { canonicalMoves: false, abortMultipart: true, deleteNew: true, pause: true, resume: "CHECKPOINT_VERIFYING" },
  pointer_update_failed: { canonicalMoves: false, keepOld: true, keepNew: true, pause: true, resume: "CHECKPOINT_PROMOTING", retry: "pointer-only" },
  cleanup_delete_failed: { canonicalMoves: true, keepNew: true, cleanupPending: true, blockLargeWrites: true, resume: "CHECKPOINT_CLEANUP" },
  runner_died: { canonicalMoves: false, leaseExpires: true, pause: true, resume: "BACKFILLING" },
  workflow_retry: { inspectDurableStateFirst: true, repeatCompletedLargeWrite: false },
  gzip_failed: { rawCanonicalMoves: false, keepRaw: true, pause: true, resume: "FINALIZING" },
  gzip_upload_failed: { rawCanonicalMoves: false, abortMultipart: true, keepRaw: true, pause: true, resume: "COMPRESSED_UPLOADING" },
  finalize_interrupted: { rawCanonicalMoves: false, keepRaw: true, leaseExpires: true, resume: "FINALIZING" },
  hard_limit: { largeWriteStarts: false, keepCanonical: true, pause: true },
});

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "projected-peak") {
    process.stdout.write(`${projectedPeak(JSON.parse(args[0]))}\n`);
    return;
  }
  if (command === "checkpoint-due") {
    const current = await loadJson(args[0]);
    const previous = args[1] === "-" ? null : await loadJson(args[1]);
    process.stdout.write(`${JSON.stringify(checkpointDue(current, previous))}\n`);
    return;
  }
  if (command === "transition") {
    const [input, to, patchJson, output] = args;
    const next = transitionState(await loadJson(input), to, patchJson ? JSON.parse(patchJson) : {});
    await writeFile(output, `${JSON.stringify(next)}\n`);
    return;
  }
  if (command === "gc-plan") {
    const input = await loadJson(args[0]);
    process.stdout.write(`${JSON.stringify(gcPlan(input), null, 2)}\n`);
    return;
  }
  throw new Error("Usage: historical-lifecycle.mjs {projected-peak|checkpoint-due|transition|gc-plan} ...");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
