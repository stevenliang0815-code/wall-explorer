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
});

test("daily incremental has an external server runner", async () => {
  const runner = await readFile("scripts/run-daily-incremental.mjs", "utf8");
  assert.match(runner, /\/api\/incremental/);
  assert.match(runner, /OAI_SITES_AUTHORIZATION/);
  assert.doesNotMatch(runner, /window|navigator|serviceWorker/i);
  assert.match(runner, /while \(iterations < 5_000\)/);
});
