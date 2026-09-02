import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production artifact schedules only the weekday daily incremental refresh", async () => {
  const config = JSON.parse(await readFile("dist/server/wrangler.json", "utf8"));
  assert.deepEqual(config.triggers?.crons, ["5 9 * * 1-5"]);
});

test("worker scheduled handler invokes incremental, never full historical backfill", async () => {
  const worker = await readFile("worker/index.ts", "utf8");
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /scheduled\.internal\/api\/incremental/);
  assert.doesNotMatch(worker, /scheduled\.internal\/api\/backfill/);
});

test("terminal jobs become scheduler no-ops", async () => {
  const route = await readFile("app/api/backfill/route.ts", "utf8");
  assert.match(route, /\["complete", "blocked_bias_violation"\]\.includes\(existingJob\.status\)/);
});

test("UI uses snapshot-first mode and does not auto-start browser backfill", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(page, /Snapshot優先/);
  assert.match(page, /不再由瀏覽器自動啟動/);
  assert.equal(page.match(/fetch\("\/api\/backfill"/g)?.length, 1, "only the explicit manual rebuild action may call backfill");
});

test("migration enables automation without resetting backfill data", async () => {
  const migration = await readFile("drizzle/0004_chief_bug.sql", "utf8");
  assert.match(migration, /ADD `automation_enabled` integer DEFAULT 1 NOT NULL/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});

test("snapshot builder is an independent resumable SQLite job", async () => {
  const builder = await readFile("scripts/build-historical-snapshot.mjs", "utf8");
  assert.match(builder, /node:sqlite/);
  assert.match(builder, /builder_checkpoints/);
  assert.match(builder, /historical\.sqlite\.gz/);
  assert.match(builder, /manifest\.json/);
  assert.match(builder, /--max-dates/);
  assert.match(builder, /continuationRows/);
  assert.match(builder, /job-status\.json/);
  assert.match(builder, /validated_empty/);
  assert.match(builder, /failed_transient/);
  assert.match(builder, /failed_hard/);
  assert.match(builder, /failedUnitDetails/);
  assert.match(builder, /Cross-market completeness gate/);
});

test("Backfill restores first and uploads one pending immutable checkpoint without promotion", async () => {
  const workflow = await readFile(".github/workflows/historical-backfill.yml", "utf8");
  const restore = workflow.indexOf("r2-checkpoint-lifecycle.sh restore");
  const build = workflow.indexOf("build-historical-snapshot.mjs");
  const checkpoint = workflow.lastIndexOf("r2-checkpoint-lifecycle.sh upload");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /R2_ACCESS_KEY_ID: \$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}/);
  assert.ok(restore >= 0 && restore < build, "R2 checkpoint must restore before the builder starts");
  assert.ok(checkpoint > build, "R2 checkpoint must upload after each builder batch");
  assert.doesNotMatch(workflow, /r2-checkpoint-lifecycle\.sh promote|r2-finalize-lifecycle\.sh|r2-historical-gc\.sh/);
  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /gh workflow run historical-checkpoint-promotion\.yml/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
});

test("Promotion, Finalize, and GC have separate large-object responsibilities", async () => {
  const promotion = await readFile(".github/workflows/historical-checkpoint-promotion.yml", "utf8");
  const finalize = await readFile(".github/workflows/historical-finalize.yml", "utf8");
  const gc = await readFile(".github/workflows/historical-garbage-collection.yml", "utf8");
  for (const workflow of [promotion, finalize, gc]) assert.match(workflow, /group: wall-explorer-historical-snapshot/);
  assert.match(promotion, /r2-checkpoint-lifecycle\.sh promote/);
  assert.match(promotion, /pending-checkpoint\.json/);
  assert.match(promotion, /steps\.pause\.outputs\.pending == 'true'/);
  assert.match(promotion, /paths: \[\.github\/workflows\/historical-checkpoint-promotion\.yml\]/);
  assert.match(promotion, /RAW_100_PERCENT/);
  assert.match(promotion, /gh workflow run historical-finalize\.yml/);
  assert.match(promotion, /steps\.pause\.outputs\.pending \}\}" = true/);
  assert.doesNotMatch(promotion, /build-historical-snapshot|r2-finalize-lifecycle|r2-historical-gc/);
  assert.match(finalize, /r2-finalize-lifecycle\.sh finalize/);
  assert.doesNotMatch(finalize, /build-historical-snapshot|r2-checkpoint-lifecycle\.sh promote|r2-historical-gc/);
  assert.match(gc, /r2-historical-gc\.sh plan/);
  assert.match(gc, /GC_APPLY: "true"/);
  assert.doesNotMatch(gc, /build-historical-snapshot|r2-finalize-lifecycle\.sh finalize/);
});

test("current-only resume is independent from Legacy GC and dispatches only the final segment", async () => {
  const resume = await readFile(".github/workflows/historical-resume.yml", "utf8");
  const gateScript = await readFile("scripts/r2-historical-resume-current.sh", "utf8");
  const remove = resume.indexOf('delete-object --bucket "$bucket" --key "$stop_key"');
  const dispatch = resume.indexOf("gh workflow run historical-backfill.yml");

  assert.match(resume, /workflow_run:/);
  assert.match(resume, /push:\n\s+branches: \[main\]/);
  assert.match(resume, /Historical Multipart Private Classification/);
  assert.match(resume, /group: wall-explorer-historical-snapshot/);
  assert.match(gateScript, /current_lifecycle_multipart_json/);
  assert.match(gateScript, /unfinishedUploads/);
  assert.match(gateScript, /projected_peak_guard/);
  assert.match(gateScript, /99\.69/);
  assert.ok(remove >= 0 && remove < dispatch, "the stop marker is removed only immediately before final-segment dispatch");
  const deleteLines = resume.split("\n").filter((line) => line.includes("delete-object")).join("\n");
  assert.doesNotMatch(deleteLines, /builder\.sqlite|candidate|checkpoint/);
  assert.match(resume, /--field batch_dates=2 --field max_cycles=0/);
  assert.doesNotMatch(resume, /r2-legacy-multipart-gc\.sh gc/);
});

test("CI wrappers do not require the environment helper to have an executable bit", async () => {
  for (const script of ["install-ci.sh", "build-verified.sh", "validate-artifact.sh"]) {
    const source = await readFile(`scripts/${script}`, "utf8");
    assert.match(source, /exec bash "\$\{script_dir\}\/sites-env\.sh" -- bash "\$0" "\$@"/);
    assert.doesNotMatch(source, /exec "\$\{script_dir\}\/sites-env\.sh"/);
  }
  const build = await readFile("scripts/build-verified.sh", "utf8");
  assert.match(build, /bash "\$\{script_dir\}\/validate-artifact\.sh"/);
  assert.doesNotMatch(build, /^"\$\{script_dir\}\/validate-artifact\.sh"/m);
});

test("R2 lifecycle uses CAS, explicit multipart abort, cleanup gate, and immutable keys", async () => {
  const common = await readFile("scripts/r2-historical-common.sh", "utf8");
  const checkpoint = await readFile("scripts/r2-checkpoint-lifecycle.sh", "utf8");
  const finalize = await readFile("scripts/r2-finalize-lifecycle.sh", "utf8");
  assert.match(common, /--if-match/);
  assert.match(common, /--if-none-match/);
  assert.match(common, /abort-multipart-upload/);
  assert.match(common, /R2_TRANSIENT_MAX_ATTEMPTS:-8/);
  assert.match(common, /408\|429\|500\|502\|503\|504/);
  assert.match(common, /connection \(reset\|closed\|aborted\)/);
  assert.match(common, /write_multipart_state_file/);
  assert.match(common, /wall-explorer-multipart-v3/);
  assert.match(common, /sourceChecksum/);
  assert.match(common, /current_lifecycle_multipart_json/);
  assert.match(common, /"parts":\[/);
  assert.match(common, /abort_multipart_upload_exact "\$key" "\$upload_id"/);
  assert.match(common, /write_durable_stop/);
  assert.match(common, /cleanupPending/);
  assert.match(checkpoint, /versions_prefix="checkpoints\/historical\/versions\/"/);
  assert.match(checkpoint, /key="\$\{versions_prefix\}builder-\$\{version\}\.sqlite"/);
  assert.match(finalize, /snapshot_versions_prefix="snapshots\/historical\/versions\/"/);
  assert.match(finalize, /key="\$\{snapshot_versions_prefix\}builder-\$\{version\}\.sqlite\.gz"/);
  assert.match(finalize, /gzip -9n/);
  assert.doesNotMatch(`${checkpoint}\n${finalize}`, /copy-object|s3 cp "s3:\/\/[^ ]+" "s3:\//);
});

test("Backfill 38 recovery is decommissioned and Legacy GC is an independent bounded workflow", async () => {
  const workflow = await readFile(".github/workflows/historical-backfill38-recovery.yml", "utf8");
  const classification = await readFile(".github/workflows/historical-multipart-classification.yml", "utf8");
  const scanner = await readFile("scripts/r2-legacy-multipart-gc.sh", "utf8");
  const gc = await readFile(".github/workflows/historical-legacy-multipart-gc.yml", "utf8");
  const lifecycleRule = await readFile("scripts/r2-historical-lifecycle-rule.sh", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /schedule:|actions: write|abort-multipart-upload|gh workflow run/);
  assert.match(classification, /Full paginated private classification/);
  assert.doesNotMatch(classification, /actions\/upload-artifact|fingerprints\.ndjson/);
  assert.doesNotMatch(classification, /abort-multipart-upload|delete-object|gh workflow run|current lifecycle unfinished|legacy currently listed/i);
  assert.match(scanner, /--key-marker/);
  assert.match(scanner, /--upload-id-marker/);
  assert.match(scanner, /declare -A seen_uploads/);
  assert.match(scanner, /IsTruncated=false/);
  assert.match(scanner, /classification_key="jobs\/historical\/legacy-multipart-gc\/classification\.json"/);
  assert.match(scanner, /put_json_cas "\$report_file" "\$classification_key"/);
  assert.match(scanner, /abort_legacy_upload_exact/);
  assert.match(scanner, /R2_LEGACY_ABORT_CONCURRENCY/);
  assert.match(scanner, /NoSuchUpload/);
  assert.match(scanner, /cursor_key="jobs\/historical\/legacy-multipart-gc\/cursor\.json"/);
  assert.doesNotMatch(scanner, /delete-object/);
  assert.match(gc, /group: wall-explorer-historical-legacy-multipart-gc/);
  assert.match(gc, /Full paginated Legacy Multipart GC/);
  assert.doesNotMatch(gc, /actions: write|gh workflow run|historical-backfill\.yml|historical-finalize\.yml/);
  assert.match(lifecycleRule, /AbortIncompleteMultipartUpload/);
  assert.match(lifecycleRule, /checkpoints\/historical\/versions\//);
  assert.match(lifecycleRule, /get-bucket-lifecycle-configuration/);
});

test("dry-run measures pending promotion without simulating a forbidden third raw", async () => {
  const workflow = await readFile(".github/workflows/r2-checkpoint-dry-run.yml", "utf8");
  assert.match(workflow, /pending-checkpoint\.json/);
  assert.match(workflow, /expected_bytes=0/);
  assert.match(workflow, /forbidden third raw/);
  assert.doesNotMatch(workflow, /r2-backfill38-recovery\.sh preflight/);
  assert.match(workflow, /current lifecycle/i);
  assert.match(workflow, /r2-checkpoint-lifecycle\.sh projected-peak/);
  assert.match(workflow, /tests\/automation-config\.test\.mjs/);
});

test("watchdog measurement failure warns without cancelling a running Backfill", async () => {
  const watchdog = await readFile(".github/workflows/r2-capacity-watchdog.yml", "utf8");
  assert.match(watchdog, /Stop historical jobs only when measured usage is unsafe/);
  assert.match(watchdog, /if: steps\.usage\.outputs\.over_limit == 'true'/);
  assert.doesNotMatch(watchdog, /steps\.usage\.outcome == 'failure' \|\|/);
});

test("daily GitHub Action updates both markets through the server API", async () => {
  const workflow = await readFile(".github/workflows/daily-incremental.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron: "5 9 \* \* 1-5"/);
  assert.match(workflow, /npm run incremental:run/);
});

test("PWA cloud job endpoint exposes status and GitHub start or retry controls", async () => {
  const route = await readFile("app/api/cloud-job/route.ts", "utf8");
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(route, /HISTORICAL_JOB_STATUS_URL/);
  assert.match(route, /historical-backfill\.yml/);
  assert.match(page, /GitHub Actions 雲端 Snapshot Job/);
});

test("daily incremental has an external server runner", async () => {
  const runner = await readFile("scripts/run-daily-incremental.mjs", "utf8");
  assert.match(runner, /\/api\/incremental/);
  assert.match(runner, /OAI_SITES_AUTHORIZATION/);
  assert.doesNotMatch(runner, /window|navigator|serviceWorker/i);
  assert.match(runner, /while \(iterations < 5_000\)/);
});

test("legacy D1 checkpoint export is owner-gated, compressed, and read-only", async () => {
  const route = await readFile("app/api/legacy-checkpoint/route.ts", "utf8");
  assert.match(route, /getChatGPTUser/);
  assert.match(route, /LEGACY_CHECKPOINT_EXPORT_OWNER/);
  assert.match(route, /historical_observations/);
  assert.match(route, /backfill_checkpoints/);
  assert.match(route, /CompressionStream\("gzip"\)/);
  assert.match(route, /Content-Disposition/);
  assert.doesNotMatch(route, /\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i);
});
