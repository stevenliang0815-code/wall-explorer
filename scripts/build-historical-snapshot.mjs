#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { auditBiasGuards, BACKFILL_POLICY, fetchHistoricalMarketDay } from "../lib/historical-data.ts";
import { SNAPSHOT_FORMAT, SNAPSHOT_SCHEMA_VERSION } from "../lib/historical-snapshot.ts";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const start = args.get("--start") ?? BACKFILL_POLICY.targetStart;
const end = args.get("--end") ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const outputRoot = resolve(args.get("--output") ?? "snapshot-output");
const chunkRows = Math.max(1_000, Number(args.get("--chunk-rows") ?? 10_000));
const workers = Math.min(4, Math.max(1, Number(args.get("--workers") ?? 2)));
const maxDates = Math.max(1, Number(args.get("--max-dates") ?? Number.MAX_SAFE_INTEGER));
const continuationRows = Math.max(0, Number(args.get("--continuation-rows") ?? 0));
const continuationUnits = Math.max(0, Number(args.get("--continuation-units") ?? 0));
const continuationCursor = args.get("--continuation-cursor") ?? null;
const snapshotCutoff = args.get("--snapshot-cutoff") ?? end;
const declaredTotalUnits = Math.max(0, Number(args.get("--total-units") ?? 0));
const releaseName = `historical-${snapshotCutoff}`;
const workDir = join(outputRoot, `${releaseName}.building`);
const releaseDir = join(outputRoot, releaseName);
const dbPath = join(workDir, "historical.sqlite");
const statusPath = join(outputRoot, "job-status.json");
const markets = ["上市", "上櫃"];

if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotCutoff) || start > end || end > snapshotCutoff) throw new Error("Invalid --start/--end/--snapshot-cutoff range");
await mkdir(workDir, { recursive: true });
await mkdir(join(workDir, "chunks"), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS historical_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, code TEXT NOT NULL,
    name TEXT NOT NULL, trading_date TEXT NOT NULL, security_type TEXT NOT NULL,
    universe_status TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL,
    change REAL, volume INTEGER, trade_value REAL, source TEXT NOT NULL,
    source_scope TEXT NOT NULL, usable_from TEXT NOT NULL,
    UNIQUE(market, code, trading_date)
  );
  CREATE TABLE IF NOT EXISTS builder_checkpoints (
    market TEXT NOT NULL, trading_date TEXT NOT NULL, status TEXT NOT NULL,
    rows_written INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 1,
    last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(market, trading_date)
  );
  CREATE INDEX IF NOT EXISTS historical_date_market_idx ON historical_observations(trading_date, market);
  CREATE INDEX IF NOT EXISTS historical_usable_idx ON historical_observations(usable_from, security_type);
`);

const insert = db.prepare(`
  INSERT INTO historical_observations (
    market, code, name, trading_date, security_type, universe_status,
    open, high, low, close, change, volume, trade_value, source, source_scope, usable_from
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(market, code, trading_date) DO UPDATE SET
    name=excluded.name, security_type=excluded.security_type, universe_status=excluded.universe_status,
    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
    change=excluded.change, volume=excluded.volume, trade_value=excluded.trade_value,
    source=excluded.source, source_scope=excluded.source_scope, usable_from=excluded.usable_from
`);
const checkpoint = db.prepare(`
  INSERT INTO builder_checkpoints (market,trading_date,status,rows_written,attempts,last_error,updated_at)
  VALUES (?,?,'completed',?,1,NULL,?)
  ON CONFLICT(market,trading_date) DO UPDATE SET status='completed',rows_written=excluded.rows_written,last_error=NULL,updated_at=excluded.updated_at
`);
const failure = db.prepare(`
  INSERT INTO builder_checkpoints (market,trading_date,status,rows_written,attempts,last_error,updated_at)
  VALUES (?,?,'failed',0,1,?,?)
  ON CONFLICT(market,trading_date) DO UPDATE SET status='failed',attempts=builder_checkpoints.attempts+1,last_error=excluded.last_error,updated_at=excluded.updated_at
`);
const completed = db.prepare("SELECT status FROM builder_checkpoints WHERE market=? AND trading_date=?");
const completedDay = db.prepare("SELECT market,rows_written rowsWritten,status FROM builder_checkpoints WHERE trading_date=?");

async function writeJobStatus(status, currentDate = null, lastError = null) {
  const counts = db.prepare(`SELECT
    sum(CASE WHEN status='completed' THEN 1 ELSE 0 END) completedUnits,
    sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) failedUnits,
    coalesce(sum(CASE WHEN status='completed' THEN rows_written ELSE 0 END),0) rowsWritten
    FROM builder_checkpoints`).get();
  const segmentTotalUnits = allDates.length * markets.length;
  const completedUnits = Number(counts.completedUnits ?? 0);
  const totalUnits = declaredTotalUnits || continuationUnits + segmentTotalUnits;
  const overallCompletedUnits = Math.min(totalUnits, continuationUnits + completedUnits);
  const body = {
    job: "historical-snapshot", status, updatedAt: new Date().toISOString(), currentDate,
    range: { start, end }, snapshotCutoff, continuationCursor,
    continuationRows, continuationUnits, segmentRows: Number(counts.rowsWritten ?? 0),
    storedRows: continuationRows + Number(counts.rowsWritten ?? 0), completedUnits,
    segmentTotalUnits, overallCompletedUnits, totalUnits,
    progress: Number((overallCompletedUnits / Math.max(1, totalUnits) * 100).toFixed(2)),
    failedUnits: Number(counts.failedUnits ?? 0), lastError,
  };
  await writeFile(statusPath, `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

function isWeekend(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
function* datesBetween(first, last) {
  const cursor = new Date(`${first}T12:00:00Z`);
  const finish = Date.parse(`${last}T12:00:00Z`);
  while (cursor.getTime() <= finish) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}
function saveUnit(market, date, rows) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) insert.run(row.market,row.code,row.name,row.tradingDate,row.securityType,row.universeStatus,row.open,row.high,row.low,row.close,row.change,row.volume,row.tradeValue,row.source,row.sourceScope,row.usableFrom);
    checkpoint.run(market, date, rows.length, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function buildUnit(market, date) {
  if (completed.get(market, date)?.status === "completed") return null;
  if (isWeekend(date)) { saveUnit(market, date, []); return null; }
  try {
    const result = await fetchHistoricalMarketDay(market, date);
    const audit = auditBiasGuards(result.observations, date);
    if (audit.survivorship.status !== "pass" || audit.lookAhead.status !== "pass") throw new Error("Bias validation blocked the official batch");
    saveUnit(market, date, result.observations);
    return { rows: result.observations.length, profile: result.profile };
  } catch (error) {
    failure.run(market, date, error instanceof Error ? error.message.slice(0, 800) : "Unknown error", new Date().toISOString());
    return null;
  }
}

const allDates = [...datesBetween(start, end)];
const pendingDates = allDates.filter((date) => markets.some((market) => completed.get(market, date)?.status !== "completed"));
const batchDates = pendingDates.slice(0, maxDates);
const startedAt = Date.now();
const runtime = { datesCompleted: 0, rowsWritten: 0, networkMs: 0, parseMs: 0, retries: 0, throttledMs: 0 };
async function processDate(date) {
  const results = await Promise.all(markets.map((market) => buildUnit(market, date)));
  for (const result of results) {
    if (!result) continue;
    runtime.rowsWritten += result.rows;
    runtime.networkMs += result.profile.networkMs;
    runtime.parseMs += result.profile.parseMs;
    runtime.retries += result.profile.retryCount;
    runtime.throttledMs += result.profile.throttledMs;
  }
  const day = completedDay.all(date);
  if (day.length === markets.length && day.every((unit) => unit.status === "completed")) {
    const positive = day.filter((unit) => unit.rowsWritten > 0);
    if (positive.length === 1) {
      const empty = day.find((unit) => unit.rowsWritten === 0);
      failure.run(empty.market, date, "Cross-market completeness gate: the other market has rows but this market is empty", new Date().toISOString());
    }
  }
  runtime.datesCompleted += 1;
  if (runtime.datesCompleted % 25 === 0 || runtime.datesCompleted === allDates.length) {
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
    console.log(JSON.stringify({ status: "building", currentDate: date, datesCompleted: runtime.datesCompleted, totalDates: allDates.length,
      percent: runtime.datesCompleted / allDates.length * 100, rowsWritten: runtime.rowsWritten,
      rowsPerSecond: runtime.rowsWritten / elapsedSeconds, elapsedSeconds,
      etaSeconds: elapsedSeconds / runtime.datesCompleted * (allDates.length - runtime.datesCompleted),
      networkMs: runtime.networkMs, parseMs: runtime.parseMs, retries: runtime.retries, throttledMs: runtime.throttledMs, workers }));
  }
}

let nextDateIndex = 0;
await Promise.all(Array.from({ length: Math.min(workers, batchDates.length) }, async () => {
  while (nextDateIndex < batchDates.length) {
    const date = batchDates[nextDateIndex];
    nextDateIndex += 1;
    await processDate(date);
  }
}));

const failedAfterBatch = db.prepare("SELECT count(*) count FROM builder_checkpoints WHERE status='failed'").get().count;
if (failedAfterBatch > 0) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const state = await writeJobStatus("failed", batchDates.at(-1) ?? null, `${failedAfterBatch} historical unit(s) failed; automatic continuation is blocked.`);
  db.close();
  console.log(JSON.stringify(state));
  throw new Error(`Historical batch stopped after ${failedAfterBatch} failed unit(s). The last verified R2 checkpoint remains the recovery point.`);
}

const remainingUnits = db.prepare("SELECT count(*) count FROM builder_checkpoints WHERE status!='completed'").get().count
  + allDates.reduce((sum, date) => sum + markets.filter((market) => !completed.get(market, date)).length, 0);
const completedUnits = db.prepare("SELECT count(*) count FROM builder_checkpoints WHERE status='completed'").get().count;
if (completedUnits < allDates.length * markets.length) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const state = await writeJobStatus(remainingUnits > 0 ? "retrying" : "running", batchDates.at(-1) ?? null);
  db.close();
  console.log(JSON.stringify(state));
  process.exit(0);
}

const openFailures = db.prepare("SELECT count(*) count FROM builder_checkpoints WHERE status='failed'").get().count;
const duplicates = db.prepare("SELECT count(*) count FROM (SELECT market,code,trading_date,count(*) n FROM historical_observations GROUP BY market,code,trading_date HAVING n>1)").get().count;
const survivorshipViolations = db.prepare("SELECT count(*) count FROM historical_observations WHERE source_scope!='full_market_daily'").get().count;
const lookAheadViolations = db.prepare("SELECT count(*) count FROM historical_observations WHERE substr(usable_from,1,10)<=trading_date").get().count;
if (openFailures || duplicates || survivorshipViolations || lookAheadViolations) {
  db.close();
  throw new Error(`Snapshot validation blocked: failures=${openFailures}, duplicates=${duplicates}, survivorship=${survivorshipViolations}, lookAhead=${lookAheadViolations}. Re-run the same command to resume checkpoints.`);
}

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const integrityRows = db.prepare("PRAGMA integrity_check").all();
if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== "ok") {
  db.close();
  throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrityRows.slice(0, 10))}`);
}
const rowCount = db.prepare("SELECT count(*) count FROM historical_observations").get().count;
const securityCount = db.prepare("SELECT count(*) count FROM (SELECT market,code FROM historical_observations GROUP BY market,code)").get().count;
const marketStats = Object.fromEntries(markets.map((market) => {
  const value = db.prepare("SELECT count(*) rows,count(DISTINCT trading_date) dates FROM historical_observations WHERE market=?").get(market);
  return [market, value];
}));

const chunks = [];
let afterId = 0;
let chunkIndex = 0;
const selectRows = db.prepare(`SELECT id,market,code,name,trading_date tradingDate,security_type securityType,universe_status universeStatus,open,high,low,close,change,volume,trade_value tradeValue,source,source_scope sourceScope,usable_from usableFrom FROM historical_observations WHERE id>? ORDER BY id LIMIT ?`);
while (true) {
  const rows = selectRows.all(afterId, chunkRows);
  if (!rows.length) break;
  afterId = rows.at(-1).id;
  const payload = rows.map((row) => ({
    market: row.market, code: row.code, name: row.name, tradingDate: row.tradingDate,
    securityType: row.securityType, universeStatus: row.universeStatus,
    open: row.open, high: row.high, low: row.low, close: row.close, change: row.change,
    volume: row.volume, tradeValue: row.tradeValue, source: row.source,
    sourceScope: row.sourceScope, usableFrom: row.usableFrom,
  }));
  const compressed = gzipSync(JSON.stringify(payload), { level: 9 });
  const name = `chunk-${String(chunkIndex).padStart(5, "0")}.json.gz`;
  const path = join(workDir, "chunks", name);
  await writeFile(path, compressed);
  chunks.push({ index: chunkIndex, path: `chunks/${name}`, rows: payload.length, bytes: compressed.byteLength, sha256: createHash("sha256").update(compressed).digest("hex"), encoding: "gzip", contentType: "application/json" });
  chunkIndex += 1;
}
const finalStatus = await writeJobStatus("publishing", end);
db.close();

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const rawSqliteInfo = await stat(dbPath);
const rawSqliteSha256 = await sha256File(dbPath);
const sqliteGzipPath = join(workDir, "historical.sqlite.gz");
await pipeline(createReadStream(dbPath), createGzip({ level: 9 }), createWriteStream(sqliteGzipPath));

const sqliteInfo = await stat(sqliteGzipPath);
const manifest = {
  format: SNAPSHOT_FORMAT, schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  snapshotVersion: `${snapshotCutoff}-v1`, generatedAt: new Date().toISOString(), cutoffDate: snapshotCutoff,
  range: { start, end }, rowCount, securityCount, markets: marketStats,
  sqlite: { path: basename(sqliteGzipPath), bytes: sqliteInfo.size, sha256: await sha256File(sqliteGzipPath), encoding: "gzip", uncompressedBytes: rawSqliteInfo.size, uncompressedSha256: rawSqliteSha256 },
  chunks,
  validation: { status: "pass", openFailures: 0, duplicates: 0, survivorshipViolations: 0, lookAheadViolations: 0 },
  mergeStrategy: "upsert",
  continuation: continuationCursor ? { source: "sites-d1", cursorDate: continuationCursor, storedRows: continuationRows, processedUnits: continuationUnits } : null,
  sources: ["https://www.twse.com.tw/zh/trading/historical/mi-index.html", "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/pricing.html"],
};
await writeFile(join(workDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(releaseDir, { recursive: true, force: true });
await rename(workDir, releaseDir);
const check = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8"));
await writeFile(statusPath, `${JSON.stringify({
  ...finalStatus,
  status: "complete",
  updatedAt: new Date().toISOString(),
  snapshotVersion: check.snapshotVersion,
  manifestPath: `snapshots/${check.snapshotVersion}/manifest.json`,
  releaseDir,
}, null, 2)}\n`);
console.log(JSON.stringify({ status: "complete", releaseDir, snapshotVersion: check.snapshotVersion, rows: check.rowCount, chunks: check.chunks.length, sqliteBytes: check.sqlite.bytes }));

