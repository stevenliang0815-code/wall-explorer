import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operationalRetentionPolicy, OPERATIONAL_RETENTION, STRATEGY_REQUIREMENTS } from "../lib/operational-policy.ts";
import { freshnessStatus, latestCompletedMarketDate, nextWeekday } from "../lib/operational-time.ts";

test("current implemented strategies fit the 300 trading-day floor", () => {
  assert.deepEqual(STRATEGY_REQUIREMENTS.filter((item) => item.active).map((item) => item.id), ["daily-rule-v1"]);
  assert.equal(OPERATIONAL_RETENTION.strategyMaxLookback, 1);
  assert.equal(OPERATIONAL_RETENTION.forecastMaxHorizon, 0);
  assert.equal(OPERATIONAL_RETENTION.retentionTradingDays, 300);
});

test("retention automatically grows with future strategy lookback and horizon", () => {
  const policy = operationalRetentionPolicy([
    { id: "long-model", active: true, lookbackTradingDays: 252, outputHorizonTradingDays: 20 },
  ]);
  assert.equal(policy.retentionTradingDays, 332);
});

test("market-day helpers use Taiwan close time and skip weekends", () => {
  assert.equal(latestCompletedMarketDate(new Date("2026-09-03T08:59:00Z")), "2026-09-02");
  assert.equal(latestCompletedMarketDate(new Date("2026-09-03T09:01:00Z")), "2026-09-03");
  assert.equal(nextWeekday("2026-09-04"), "2026-09-07");
  assert.equal(freshnessStatus("2026-09-02", "2026-09-03"), "catching_up");
  assert.equal(freshnessStatus("2026-09-03", "2026-09-03"), "fresh");
});

test("operational migration is append-only and generation activation is atomic", async () => {
  const migration = await readFile("drizzle/0006_military_firedrake.sql", "utf8");
  const route = await readFile("app/api/operational/rebuild/route.ts", "utf8");
  assert.doesNotMatch(migration, /DROP|DELETE|TRUNCATE|ALTER TABLE/i);
  assert.match(migration, /CREATE TABLE `operational_generations`/);
  assert.match(migration, /CREATE TABLE `operational_daily_bars`/);
  assert.match(route, /await d1\.batch\(\[/);
  assert.match(route, /UPDATE operational_generations SET status='retired'/);
  assert.match(route, /INSERT INTO operational_state/);
});

test("daily APIs read the active operational generation after bootstrap", async () => {
  const reader = await readFile("lib/operational-read.ts", "utf8");
  const candidates = await readFile("app/api/candidates/route.ts", "utf8");
  const incremental = await readFile("app/api/incremental/route.ts", "utf8");
  assert.match(reader, /FROM operational_latest_quotes/);
  assert.match(reader, /FROM operational_market_indices/);
  assert.match(candidates, /dataMode: "operational_db"/);
  assert.match(incremental, /operational_ingestion_units/);
  assert.match(incremental, /attempts=operational_ingestion_units\.attempts\+1/);
  assert.match(incremental, /DELETE FROM operational_daily_bars/);
  assert.doesNotMatch(incremental, /historical_observations/);
});

test("operational rebuild is separate and never triggers Historical lifecycle", async () => {
  const workflow = await readFile(".github/workflows/operational-rebuild.yml", "utf8");
  const importer = await readFile("scripts/import-operational-generation.mjs", "utf8");
  assert.match(workflow, /snapshots\/historical\/latest\.json/);
  assert.match(workflow, /Build shadow generation, catch up, and atomically activate/);
  assert.doesNotMatch(workflow, /historical-backfill\.yml|historical-finalize\.yml|gh workflow run/);
  assert.match(importer, /action: "validate"/);
  assert.match(importer, /action: "activate"/);
  assert.match(importer, /OPERATIONAL_RETENTION\.retentionTradingDays/);
});
