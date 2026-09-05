import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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

test("operational import checkpoints persist immutable batch parameters and cursors", async () => {
  const migration = await readFile("drizzle/0007_mute_steve_rogers.sql", "utf8");
  const route = await readFile("app/api/operational/rebuild/route.ts", "utf8");
  assert.match(migration, /ADD `chunk_rows` integer DEFAULT 900 NOT NULL/);
  assert.match(migration, /ADD `source_kind` text/);
  assert.match(migration, /ADD `source_last_id` integer/);
  assert.doesNotMatch(migration, /DROP|DELETE|TRUNCATE/i);
  assert.match(route, /different immutable import parameters/);
  assert.match(route, /Operational chunks must be imported sequentially/);
  assert.match(route, /source_kind,source_last_id/);
  assert.match(route, /resumeKind, resumeSourceId/);
});

test("latest-quote planning avoids the former correlated full-table query", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE historical_observations (id INTEGER PRIMARY KEY, market TEXT, trading_date TEXT);
    CREATE INDEX historical_date_market_idx ON historical_observations(trading_date, market);`);
  const formerPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM historical_observations h
    WHERE trading_date=(SELECT max(trading_date) FROM historical_observations WHERE market=h.market)`).all();
  const currentPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT market,max(trading_date)
    FROM historical_observations GROUP BY market`).all();
  assert.match(formerPlan.map((row) => String(row.detail)).join("\n"), /CORRELATED SCALAR SUBQUERY/);
  assert.doesNotMatch(currentPlan.map((row) => String(row.detail)).join("\n"), /CORRELATED/);
  db.close();
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

test("write APIs trust the private Sites dispatch boundary", async () => {
  const rebuild = await readFile("app/api/operational/rebuild/route.ts", "utf8");
  const incremental = await readFile("app/api/incremental/route.ts", "utf8");
  assert.match(rebuild, /x-dispatched-app/);
  assert.match(incremental, /x-dispatched-app/);
  assert.doesNotMatch(rebuild, /OAI-Sites-Authorization/);
  assert.doesNotMatch(incremental, /OAI-Sites-Authorization/);
});

test("operational rebuild is separate and never triggers Historical lifecycle", async () => {
  const workflow = await readFile(".github/workflows/operational-rebuild.yml", "utf8");
  const importer = await readFile("scripts/import-operational-generation.mjs", "utf8");
  assert.match(workflow, /snapshots\/historical\/latest\.json/);
  assert.doesNotMatch(workflow, /push:\n/);
  assert.match(workflow, /Build shadow generation, catch up, and atomically activate/);
  assert.match(workflow, /steps\.operational\.outputs\.continue == 'true'/);
  assert.match(workflow, /gh workflow run operational-rebuild\.yml --ref main/);
  assert.doesNotMatch(workflow, /historical-backfill\.yml|historical-finalize\.yml/);
  assert.match(importer, /action: "validate"/);
  assert.match(importer, /action: "activate"/);
  assert.match(importer, /allowStaleBootstrap: true/);
  assert.doesNotMatch(importer, /post\("\/api\/incremental"/);
  assert.match(importer, /OPERATIONAL_RETENTION\.retentionTradingDays/);
  assert.match(importer, /PRAGMA quick_check/);
  assert.match(importer, /GROUP BY market/);
  assert.doesNotMatch(importer, /WHERE market=h\.market/);
  assert.match(importer, /resumeSourceId/);
  assert.match(importer, /GITHUB_OUTPUT/);
});
