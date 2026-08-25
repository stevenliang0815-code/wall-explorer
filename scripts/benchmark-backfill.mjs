import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const ROWS = 100_000;
const rows = Array.from({ length: ROWS }, (_, index) => {
  const day = String(Math.floor(index / 1_000) + 1).padStart(3, "0");
  const symbol = String(1000 + (index % 1_000));
  return {
    market: index % 2 ? "上櫃" : "上市",
    code: symbol,
    name: `樣本${symbol}`,
    tradingDate: `2026-${day.slice(0, 1).padStart(2, "0")}-${day.slice(1).padStart(2, "0")}`,
    securityType: "ordinary_equity_candidate",
    universeStatus: "traded_or_quoted",
    open: 100, high: 102, low: 99, close: 101, change: 1,
    volume: 1_000_000, tradeValue: 101_000_000,
    source: "https://official.example/day", sourceScope: "full_market_daily",
    usableFrom: "2026-01-02T00:00:00+08:00", ingestedAt: "2026-08-20T00:00:00.000Z", backfillJobId: 1,
  };
});

const columns = ["market", "code", "name", "trading_date", "security_type", "universe_status", "open", "high", "low", "close", "change", "volume", "trade_value", "source", "source_scope", "usable_from", "ingested_at", "backfill_job_id"];

function database(includeSecondaryIndexes = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE historical_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, code TEXT NOT NULL,
      name TEXT NOT NULL, trading_date TEXT NOT NULL, security_type TEXT NOT NULL,
      universe_status TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL,
      change REAL, volume INTEGER, trade_value REAL, source TEXT NOT NULL,
      source_scope TEXT NOT NULL, usable_from TEXT NOT NULL, ingested_at TEXT NOT NULL,
      backfill_job_id INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX historical_observation_market_code_date_uq ON historical_observations (market,code,trading_date);
  `);
  if (includeSecondaryIndexes) db.exec(`
    CREATE INDEX historical_observation_date_market_idx ON historical_observations (trading_date,market);
    CREATE INDEX historical_observation_usable_idx ON historical_observations (usable_from,security_type);
  `);
  return db;
}

const upsertSql = `INSERT INTO historical_observations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
  ON CONFLICT(market,code,trading_date) DO UPDATE SET close=excluded.close,volume=excluded.volume,ingested_at=excluded.ingested_at`;

const bulkSql = `INSERT INTO historical_observations (${columns.join(",")})
  SELECT json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),json_extract(value,'$.tradingDate'),
    json_extract(value,'$.securityType'),json_extract(value,'$.universeStatus'),json_extract(value,'$.open'),json_extract(value,'$.high'),
    json_extract(value,'$.low'),json_extract(value,'$.close'),json_extract(value,'$.change'),json_extract(value,'$.volume'),
    json_extract(value,'$.tradeValue'),json_extract(value,'$.source'),json_extract(value,'$.sourceScope'),json_extract(value,'$.usableFrom'),
    json_extract(value,'$.ingestedAt'),json_extract(value,'$.backfillJobId') FROM json_each(?) WHERE 1
  ON CONFLICT(market,code,trading_date) DO UPDATE SET close=excluded.close,volume=excluded.volume,ingested_at=excluded.ingested_at`;

function oldBatched50() {
  const db = database(true);
  const statement = db.prepare(upsertSql);
  const started = performance.now();
  for (let offset = 0; offset < rows.length; offset += 50) {
    db.exec("BEGIN");
    for (const row of rows.slice(offset, offset + 50)) {
      statement.run(row.market, row.code, row.name, row.tradingDate, row.securityType, row.universeStatus, row.open, row.high, row.low, row.close, row.change, row.volume, row.tradeValue, row.source, row.sourceScope, row.usableFrom, row.ingestedAt, row.backfillJobId);
    }
    db.exec("COMMIT");
  }
  return performance.now() - started;
}

function jsonBulk(includeSecondaryIndexes) {
  const db = database(includeSecondaryIndexes);
  const statement = db.prepare(bulkSql);
  const started = performance.now();
  for (let offset = 0; offset < rows.length; offset += 2_000) {
    db.exec("BEGIN");
    statement.run(JSON.stringify(rows.slice(offset, offset + 2_000)));
    db.exec("COMMIT");
  }
  return performance.now() - started;
}

const oldMs = oldBatched50();
const bulkWithIndexesMs = jsonBulk(true);
const bulkUniqueOnlyMs = jsonBulk(false);
console.log(JSON.stringify({
  rows: ROWS,
  oldBatched50: { ms: Math.round(oldMs), rowsPerSecond: Math.round(ROWS / (oldMs / 1_000)) },
  jsonBulk2000: { ms: Math.round(bulkWithIndexesMs), rowsPerSecond: Math.round(ROWS / (bulkWithIndexesMs / 1_000)) },
  jsonBulkUniqueOnly: { ms: Math.round(bulkUniqueOnlyMs), rowsPerSecond: Math.round(ROWS / (bulkUniqueOnlyMs / 1_000)) },
  speedup: Number((oldMs / bulkWithIndexesMs).toFixed(2)),
  secondaryIndexCostPercent: Number((((bulkWithIndexesMs / bulkUniqueOnlyMs) - 1) * 100).toFixed(1)),
}, null, 2));
