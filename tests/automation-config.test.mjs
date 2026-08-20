import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production artifact carries the one-minute backfill cron", async () => {
  const config = JSON.parse(await readFile("dist/server/wrangler.json", "utf8"));
  assert.deepEqual(config.triggers?.crons, ["* * * * *"]);
});

test("worker exposes a scheduled handler that invokes the internal route", async () => {
  const worker = await readFile("worker/index.ts", "utf8");
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /scheduled\.internal\/api\/backfill/);
  assert.match(worker, /x-wall-backfill-trigger/);
});

test("terminal jobs become scheduler no-ops", async () => {
  const route = await readFile("app/api/backfill/route.ts", "utf8");
  assert.match(route, /\["complete", "blocked_bias_violation"\]\.includes\(existingJob\.status\)/);
});

test("UI claims full automation only after a real scheduler heartbeat", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(page, /schedulerHealthy/);
  assert.match(page, /未偵測到 scheduled 事件，不顯示假成功/);
});

test("migration enables automation without resetting backfill data", async () => {
  const migration = await readFile("drizzle/0004_chief_bug.sql", "utf8");
  assert.match(migration, /ADD `automation_enabled` integer DEFAULT 1 NOT NULL/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});
