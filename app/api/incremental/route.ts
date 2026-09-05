import { getRawDb } from "../../../db";
import { auditBiasGuards, fetchHistoricalMarketDay, type HistoricalMarket, type HistoricalObservation } from "../../../lib/historical-data";
import { fetchMarketPulse } from "../../../lib/official-data";
import { freshnessStatus, latestCompletedMarketDate, nextWeekday } from "../../../lib/operational-time";

export const dynamic = "force-dynamic";
const markets: HistoricalMarket[] = ["上市", "上櫃"];

function authorized(request: Request) {
  return request.headers.get("x-dispatched-app")?.startsWith("site---") || request.headers.get("x-wall-incremental-trigger") === "scheduled";
}

function payloads(rows: HistoricalObservation[], target = 1_500_000) {
  const result: string[] = []; let current: HistoricalObservation[] = []; let bytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    if (current.length && bytes + encoded.length + 1 > target) { result.push(JSON.stringify(current)); current = []; bytes = 2; }
    current.push(row); bytes += encoded.length + 1;
  }
  if (current.length) result.push(JSON.stringify(current));
  return result;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function barUpsert(d1: D1Database, generationId: string, payload: string, now: string) {
  return d1.prepare(`INSERT INTO operational_daily_bars
    (generation_id,market,code,trading_date,open,high,low,close,change,volume,trade_value,source,ingested_at)
    SELECT ?,json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.tradingDate'),
      json_extract(value,'$.open'),json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),
      json_extract(value,'$.change'),json_extract(value,'$.volume'),json_extract(value,'$.tradeValue'),json_extract(value,'$.source'),?
    FROM json_each(?) WHERE json_extract(value,'$.securityType')='ordinary_equity_candidate'
    ON CONFLICT(generation_id,market,code,trading_date) DO UPDATE SET open=excluded.open,high=excluded.high,
      low=excluded.low,close=excluded.close,change=excluded.change,volume=excluded.volume,trade_value=excluded.trade_value,
      source=excluded.source,ingested_at=excluded.ingested_at`).bind(generationId, now, payload);
}

function quoteUpsert(d1: D1Database, generationId: string, payload: string, now: string) {
  return d1.prepare(`INSERT INTO operational_latest_quotes
    (generation_id,market,code,name,security_type,trading_date,open,high,low,close,change,volume,trade_value,source,ingested_at)
    SELECT ?,json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),
      json_extract(value,'$.securityType'),json_extract(value,'$.tradingDate'),json_extract(value,'$.open'),
      json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),json_extract(value,'$.change'),
      json_extract(value,'$.volume'),json_extract(value,'$.tradeValue'),json_extract(value,'$.source'),?
    FROM json_each(?) WHERE 1 ON CONFLICT(generation_id,market,code) DO UPDATE SET name=excluded.name,
      security_type=excluded.security_type,trading_date=excluded.trading_date,open=excluded.open,high=excluded.high,
      low=excluded.low,close=excluded.close,change=excluded.change,volume=excluded.volume,trade_value=excluded.trade_value,
      source=excluded.source,ingested_at=excluded.ingested_at WHERE excluded.trading_date>=operational_latest_quotes.trading_date`)
    .bind(generationId, now, payload);
}

function securityUpsert(d1: D1Database, generationId: string, payload: string) {
  return d1.prepare(`INSERT INTO operational_securities
    (generation_id,market,code,name,security_type,first_seen,last_seen)
    SELECT ?,json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),
      json_extract(value,'$.securityType'),json_extract(value,'$.tradingDate'),json_extract(value,'$.tradingDate')
    FROM json_each(?) WHERE 1 ON CONFLICT(generation_id,market,code) DO UPDATE SET name=excluded.name,
      security_type=excluded.security_type,first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen)`)
    .bind(generationId, payload);
}

async function completedThrough(d1: D1Database, generationId: string) {
  const checkpoint = await d1.prepare(`SELECT max(trading_date) AS tradingDate FROM (
    SELECT trading_date FROM operational_ingestion_units WHERE generation_id=? GROUP BY trading_date
    HAVING count(*)=2 AND sum(CASE WHEN status IN ('complete','validated_empty') THEN 1 ELSE 0 END)=2
  )`).bind(generationId).first<{ tradingDate: string | null }>();
  return checkpoint?.tradingDate ?? null;
}

async function state(d1: D1Database, requestedGeneration?: string | null) {
  const active = await d1.prepare(`SELECT active_generation AS activeGeneration,retention_trading_days AS retentionTradingDays,
    latest_completed_date AS latestCompletedDate,freshness_status AS freshnessStatus,last_incremental_at AS lastIncrementalAt,
    updated_at AS updatedAt FROM operational_state WHERE id=1`).first<{
      activeGeneration: string | null; retentionTradingDays: number; latestCompletedDate: string | null;
      freshnessStatus: string; lastIncrementalAt: string | null; updatedAt: string;
    }>();
  const generationId = requestedGeneration ?? active?.activeGeneration ?? null;
  const generation = generationId ? await d1.prepare(`SELECT generation_id AS generationId,status,base_last_date AS baseLastDate,
    retention_trading_days AS retentionTradingDays FROM operational_generations WHERE generation_id=?`).bind(generationId)
    .first<{ generationId: string; status: string; baseLastDate: string; retentionTradingDays: number }>() : null;
  const throughDate = generation ? (await completedThrough(d1, generation.generationId)) ?? generation.baseLastDate : null;
  const runs = generation ? await d1.prepare(`SELECT market,trading_date AS tradingDate,status,rows_stored AS rowsStored,
    attempts,last_error AS lastError,updated_at AS updatedAt FROM operational_ingestion_units
    WHERE generation_id=? ORDER BY trading_date DESC,market LIMIT 8`).bind(generation.generationId).all() : { results: [] };
  return { mode: "operational_incremental", active, generation, lastCompletedDate: throughDate,
    targetDate: latestCompletedMarketDate(), runs: runs.results };
}

export async function GET() {
  try { return Response.json(await state(await getRawDb()), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ mode: "operational_incremental", active: null, generation: null, runs: [] }, { status: 503 }); }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ status: "unauthorized" }, { status: 401 });
  try {
    const input = await request.json().catch(() => ({})) as { generationId?: string; units?: Array<{
      market: HistoricalMarket; tradingDate: string; observations: HistoricalObservation[];
    }> };
    const d1 = await getRawDb();
    const current = await state(d1, input.generationId);
    const generation = current.generation;
    if (!generation || !(["shadow", "ready", "active"] as string[]).includes(generation.status)) {
      return Response.json({ status: "waiting_for_operational_generation", error: "尚無可更新的 operational generation。" }, { status: 409 });
    }
    if (input.generationId && generation.generationId !== input.generationId) throw new Error("Requested generation does not exist");
    const targetDate = latestCompletedMarketDate();
    const anchor = current.lastCompletedDate ?? generation.baseLastDate;
    const tradingDate = nextWeekday(anchor);
    if (tradingDate > targetDate) {
      if (current.active?.activeGeneration === generation.generationId) {
        const now = new Date().toISOString();
        await d1.prepare("UPDATE operational_state SET latest_completed_date=?,freshness_status='fresh',last_incremental_at=?,updated_at=? WHERE id=1 AND active_generation=?")
          .bind(anchor, now, now, generation.generationId).run();
      }
      return Response.json({ status: "caught_up", generationId: generation.generationId, throughDate: anchor, targetDate });
    }

    const savedUnits = await d1.prepare(`SELECT market,status,rows_fetched AS rowsFetched
      FROM operational_ingestion_units WHERE generation_id=? AND trading_date=?`)
      .bind(generation.generationId, tradingDate).all<{ market: HistoricalMarket; status: string; rowsFetched: number }>();
    const savedByMarket = new Map(savedUnits.results.map((unit) => [unit.market, unit]));
    const suppliedByMarket = new Map((input.units ?? []).map((unit) => [unit.market, unit]));
    const marketResults = await Promise.all(markets.map(async (market) => {
      const saved = savedByMarket.get(market);
      if (saved && ["complete", "validated_empty"].includes(saved.status)) {
        return { market, rows: [] as HistoricalObservation[], rowsFetched: saved.rowsFetched, checksum: null,
          error: null as string | null, skipped: true };
      }
      try {
        const supplied = suppliedByMarket.get(market);
        if (supplied && (supplied.tradingDate !== tradingDate || supplied.observations.some((row) => row.market !== market || row.tradingDate !== tradingDate))) {
          throw new Error("Supplied official market unit does not match the requested market date");
        }
        const rows = supplied?.observations ?? (await fetchHistoricalMarketDay(market, tradingDate,
          { maxAttempts: 1, timeoutMs: market === "上櫃" ? 12_000 : 8_000 })).observations;
        const audit = auditBiasGuards(rows, tradingDate);
        if (audit.survivorship.status !== "pass" || audit.lookAhead.status !== "pass") throw new Error("Bias validation blocked incremental data");
        return { market, rows, rowsFetched: rows.length, checksum: await sha256(JSON.stringify(rows)),
          error: null as string | null, skipped: false };
      } catch (error) {
        return { market, rows: [] as HistoricalObservation[], rowsFetched: 0, checksum: null,
          error: error instanceof Error ? error.message : "Unknown error", skipped: false };
      }
    }));
    const nonEmpty = marketResults.filter((unit) => unit.rowsFetched > 0).length;
    if (nonEmpty === 1) {
      const empty = marketResults.find((unit) => unit.rowsFetched === 0 && !unit.error);
      if (empty) { empty.error = "同日另一市場有資料，但本市場為空；等待兩市場資料完整。"; empty.skipped = false; }
    }

    const now = new Date().toISOString();
    const unitStatements: D1PreparedStatement[] = [];
    for (const unit of marketResults) {
      if (unit.skipped) continue;
      for (const payload of payloads(unit.rows)) {
        await d1.batch([
          barUpsert(d1, generation.generationId, payload, now),
          quoteUpsert(d1, generation.generationId, payload, now),
          securityUpsert(d1, generation.generationId, payload),
        ]);
      }
      const stored = unit.rows.filter((row) => row.securityType === "ordinary_equity_candidate").length;
      unitStatements.push(d1.prepare(`INSERT INTO operational_ingestion_units
        (generation_id,market,trading_date,status,rows_fetched,rows_stored,source_checksum,attempts,last_error,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?,?) ON CONFLICT(generation_id,market,trading_date) DO UPDATE SET
        status=excluded.status,rows_fetched=excluded.rows_fetched,rows_stored=excluded.rows_stored,
        source_checksum=excluded.source_checksum,attempts=operational_ingestion_units.attempts+1,
        last_error=excluded.last_error,updated_at=excluded.updated_at`)
        .bind(generation.generationId, unit.market, tradingDate,
          unit.error ? "failed" : unit.rows.length ? "complete" : "validated_empty",
          unit.error ? 0 : unit.rowsFetched, unit.error ? 0 : stored, unit.checksum,
          unit.error?.slice(0, 500) ?? null, now));
    }
    if (unitStatements.length) await d1.batch(unitStatements);
    const hasGap = marketResults.some((unit) => unit.error);
    if (hasGap) {
      return Response.json({ status: "retry_required", generationId: generation.generationId, tradingDate, targetDate,
        markets: marketResults.map((unit) => ({ market: unit.market, rowsFetched: unit.rowsFetched, resumed: unit.skipped, error: unit.error })) }, { status: 503 });
    }

    const cutoff = await d1.prepare(`SELECT min(trading_date) AS cutoff FROM (
      SELECT DISTINCT trading_date FROM operational_daily_bars WHERE generation_id=? ORDER BY trading_date DESC LIMIT ?
    )`).bind(generation.generationId, generation.retentionTradingDays).first<{ cutoff: string | null }>();
    if (cutoff?.cutoff) await d1.prepare("DELETE FROM operational_daily_bars WHERE generation_id=? AND trading_date<?").bind(generation.generationId, cutoff.cutoff).run();

    try {
      const pulse = await fetchMarketPulse();
      if (pulse.tradingDate) {
        await d1.prepare(`INSERT INTO operational_market_indices
          (generation_id,index_code,index_name,trading_date,close,change,change_percent,source,fetched_at)
          VALUES (?,'TAIEX',?,?,?,?,?,?,?) ON CONFLICT(generation_id,index_code) DO UPDATE SET index_name=excluded.index_name,
          trading_date=excluded.trading_date,close=excluded.close,change=excluded.change,change_percent=excluded.change_percent,
          source=excluded.source,fetched_at=excluded.fetched_at WHERE excluded.trading_date>=operational_market_indices.trading_date`)
          .bind(generation.generationId, pulse.indexName, pulse.tradingDate, pulse.close, pulse.change, pulse.changePercent, pulse.sourceUrl, pulse.fetchedAt).run();
      }
    } catch { /* Stock data remains valid; index freshness is independent. */ }

    const status = tradingDate < targetDate ? "continue" : "caught_up";
    if (current.active?.activeGeneration === generation.generationId) {
      await d1.prepare(`UPDATE operational_state SET latest_completed_date=?,freshness_status=?,last_incremental_at=?,updated_at=?
        WHERE id=1 AND active_generation=?`).bind(tradingDate, freshnessStatus(tradingDate, targetDate), now, now, generation.generationId).run();
    }
    return Response.json({ status, generationId: generation.generationId, tradingDate, targetDate,
      rowsFetched: marketResults.reduce((sum, unit) => sum + unit.rows.length, 0),
      barsStored: marketResults.reduce((sum, unit) => sum + unit.rows.filter((row) => row.securityType === "ordinary_equity_candidate").length, 0),
      markets: marketResults.map((unit) => ({ market: unit.market, rowsFetched: unit.rowsFetched, resumed: unit.skipped })) }, { status: status === "continue" ? 202 : 200 });
  } catch (error) {
    return Response.json({ status: "error", error: error instanceof Error ? error.message : "Unknown incremental error" }, { status: 503 });
  }
}
