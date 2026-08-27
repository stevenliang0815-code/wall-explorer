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
});

test("GitHub Actions persists every historical batch to R2 and resumes before rebuilding", async () => {
  const workflow = await readFile(".github/workflows/historical-backfill.yml", "utf8");
  const restore = workflow.indexOf("r2-snapshot-store.sh restore");
  const build = workflow.indexOf("build-historical-snapshot.mjs");
  const checkpoint = workflow.lastIndexOf("r2-snapshot-store.sh checkpoint");
  const checkpointStore = await readFile("scripts/r2-snapshot-store.sh", "utf8");
  const promotion = checkpointStore.slice(
    checkpointStore.indexOf("write_checkpoint()"),
    checkpointStore.indexOf('case "$operation"'),
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /R2_ACCESS_KEY_ID: \$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}/);
  assert.ok(restore >= 0 && restore < build, "R2 checkpoint must restore before the builder starts");
  assert.ok(checkpoint > build, "R2 checkpoint must upload after each builder batch");
  assert.match(promotion, /checkpoint_versions_prefix/);
  assert.match(promotion, /latest_pointer_key/);
  assert.doesNotMatch(promotion, /delete-object|copy-object/);
  assert.match(workflow, /if: failure\(\)/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
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
