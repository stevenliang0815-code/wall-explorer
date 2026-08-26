import { getRawDb } from "../../../db";
import { auditBiasGuards, fetchHistoricalMarketDay, type HistoricalMarket, type HistoricalObservation } from "../../../lib/historical-data";

export const dynamic = "force-dynamic";
const markets: HistoricalMarket[] = ["上市", "上櫃"];

function latestCompletedMarketDate() {
  const taipei = new Date(Date.now() + 8 * 60 * 60_000);
  if (taipei.getUTCHours() < 17) taipei.setUTCDate(taipei.getUTCDate() - 1);
  while ([0, 6].includes(taipei.getUTCDay())) taipei.setUTCDate(taipei.getUTCDate() - 1);
  return taipei.toISOString().slice(0, 10);
}

function nextWeekday(date: string) {
  const cursor = new Date(`${date}T12:00:00Z`);
  do cursor.setUTCDate(cursor.getUTCDate() + 1);
  while ([0, 6].includes(cursor.getUTCDay()));
  return cursor.toISOString().slice(0, 10);
}

function payloads(rows: HistoricalObservation[], target = 700_000) {
  const result: string[] = []; let current: HistoricalObservation[] = []; let bytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    if (current.length && bytes + encoded.length + 1 > target) { result.push(JSON.stringify(current)); current = []; bytes = 2; }
    current.push(row); bytes += encoded.length + 1;
  }
  if (current.length) result.push(JSON.stringify(current));
  return result;
}

function observationUpsert(d1: D1Database, payload: string, now: string) {
  return d1.prepare(`INSERT INTO historical_observations (market,code,name,trading_date,security_type,universe_status,open,high,low,close,change,volume,trade_value,source,source_scope,usable_from,ingested_at,backfill_job_id)
    SELECT json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),json_extract(value,'$.tradingDate'),json_extract(value,'$.securityType'),json_extract(value,'$.universeStatus'),json_extract(value,'$.open'),json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),json_extract(value,'$.change'),json_extract(value,'$.volume'),json_extract(value,'$.tradeValue'),json_extract(value,'$.source'),json_extract(value,'$.sourceScope'),json_extract(value,'$.usableFrom'),?,-2 FROM json_each(?) WHERE 1
    ON CONFLICT(market,code,trading_date) DO UPDATE SET name=excluded.name,security_type=excluded.security_type,universe_status=excluded.universe_status,open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,change=excluded.change,volume=excluded.volume,trade_value=excluded.trade_value,source=excluded.source,source_scope=excluded.source_scope,usable_from=excluded.usable_from,ingested_at=excluded.ingested_at`).bind(now,payload);
}

async function state() {
  const d1 = await getRawDb();
  const snapshot = await d1.prepare("SELECT status,cutoff_date AS cutoffDate,snapshot_version AS snapshotVersion FROM historical_snapshot_imports WHERE id=1").first<{ status: string; cutoffDate: string; snapshotVersion: string }>();
  const checkpoint = await d1.prepare(`SELECT max(trading_date) AS tradingDate FROM (
    SELECT trading_date FROM daily_incremental_runs GROUP BY trading_date
    HAVING count(*)=2 AND sum(CASE WHEN status IN ('complete','empty') THEN 1 ELSE 0 END)=2
  )`).first<{ tradingDate: string | null }>();
  const runs = await d1.prepare("SELECT market,trading_date AS tradingDate,status,rows_written AS rowsWritten,attempts,last_error AS lastError,updated_at AS updatedAt FROM daily_incremental_runs ORDER BY trading_date DESC,market LIMIT 4").all();
  return { snapshot, lastCompletedDate: checkpoint?.tradingDate ?? null, runs: runs.results };
}

export async function GET() {
  try { return Response.json(await state(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ snapshot: null, runs: [] }, { status: 503 }); }
}

export async function POST() {
  try {
    const d1 = await getRawDb();
    const current = await state();
    if (current.snapshot?.status !== "complete") return Response.json({ status: "waiting_for_snapshot", error: "每日增量必須等Snapshot完整驗證與匯入完成。" }, { status: 409 });
    const targetDate = latestCompletedMarketDate();
    const anchor = current.lastCompletedDate && current.lastCompletedDate > current.snapshot.cutoffDate
      ? current.lastCompletedDate : current.snapshot.cutoffDate;
    const tradingDate = nextWeekday(anchor);
    if (tradingDate > targetDate) {
      return Response.json({ status: "caught_up", throughDate: anchor, targetDate });
    }
    const fetched = await Promise.all(markets.map(async (market) => {
      try {
        const result = await fetchHistoricalMarketDay(market, tradingDate);
        const audit = auditBiasGuards(result.observations, tradingDate);
        if (audit.survivorship.status !== "pass" || audit.lookAhead.status !== "pass") throw new Error("Bias validation blocked incremental data");
        return { market, rows: result.observations, error: null };
      } catch (error) { return { market, rows: [] as HistoricalObservation[], error: error instanceof Error ? error.message : "Unknown error" }; }
    }));
    const nonEmptyMarkets = fetched.filter((unit) => unit.rows.length > 0).length;
    if (nonEmptyMarkets === 1) {
      const empty = fetched.find((unit) => unit.rows.length === 0 && !unit.error);
      if (empty) empty.error = "同日另一市場有資料，但本市場為空；保留checkpoint並等待官方資料完整。";
    }
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const unit of fetched) {
      for (const payload of payloads(unit.rows)) statements.push(observationUpsert(d1,payload,now));
      statements.push(d1.prepare(`INSERT INTO daily_incremental_runs (market,trading_date,status,rows_written,attempts,last_error,updated_at)
        VALUES (?,?,?,?,1,?,?) ON CONFLICT(market,trading_date) DO UPDATE SET status=excluded.status,rows_written=excluded.rows_written,
          attempts=daily_incremental_runs.attempts+1,last_error=excluded.last_error,updated_at=excluded.updated_at`)
        .bind(unit.market,tradingDate,unit.error ? "failed" : unit.rows.length ? "complete" : "empty",unit.error ? 0 : unit.rows.length,unit.error?.slice(0,500) ?? null,now));
    }
    await d1.batch(statements);
    const hasGap = fetched.some((unit) => unit.error);
    return Response.json({ status: hasGap ? "complete_with_gaps" : tradingDate < targetDate ? "continue" : "caught_up", tradingDate, targetDate, rowsWritten: fetched.reduce((sum, unit) => sum + unit.rows.length, 0), markets: fetched.map((unit) => ({ market: unit.market, rowsWritten: unit.rows.length, error: unit.error })) }, { status: hasGap ? 503 : tradingDate < targetDate ? 202 : 200 });
  } catch (error) {
    return Response.json({ status: "error", error: error instanceof Error ? error.message : "Unknown incremental error" }, { status: 503 });
  }
}
