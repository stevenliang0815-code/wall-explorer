import { getRawDb } from "../../../../db";
import { assertRetentionCoversStrategies, OPERATIONAL_RETENTION } from "../../../../lib/operational-policy";
import { freshnessStatus, latestCompletedMarketDate } from "../../../../lib/operational-time";

export const dynamic = "force-dynamic";

type OperationalRow = {
  id: number;
  market: "上市" | "上櫃";
  code: string;
  name: string;
  tradingDate: string;
  securityType: "ordinary_equity_candidate" | "other_security";
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  change: number | null;
  volume: number | null;
  tradeValue: number | null;
  source: string;
};

type StartRequest = {
  action: "start";
  generationId: string;
  snapshotVersion: string;
  sourceSha256: string;
  baseLastDate: string;
  retentionTradingDays: number;
  expectedBars: number;
  expectedQuotes: number;
  totalChunks: number;
  chunkRows: number;
};

type ChunkRequest = {
  action: "chunk";
  generationId: string;
  chunkIndex: number;
  sha256: string;
  kind: "bars" | "quotes";
  sourceLastId: number;
  bars: OperationalRow[];
  quotes: OperationalRow[];
};

type GenerationRequest = { action: "validate" | "activate" | "cleanup"; generationId: string; allowStaleBootstrap?: boolean };

function authorized(request: Request) {
  return request.headers.get("x-dispatched-app")?.startsWith("site---") ||
    request.headers.get("x-wall-operational-trigger") === "scheduled";
}

function validId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{7,127}$/i.test(value);
}

function validDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateRows(rows: unknown, bars: boolean): asserts rows is OperationalRow[] {
  if (!Array.isArray(rows) || rows.length > 2_000) throw new Error("Operational chunk must contain at most 2,000 rows");
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Operational chunk contains an invalid row");
    const item = row as Record<string, unknown>;
    if (!Number.isSafeInteger(item.id) || Number(item.id) < 1 ||
      !(["上市", "上櫃"] as unknown[]).includes(item.market) || typeof item.code !== "string" ||
      typeof item.name !== "string" || !validDate(item.tradingDate) || typeof item.source !== "string") {
      throw new Error("Operational chunk row identity is invalid");
    }
    if (bars && !/^[1-9]\d{3}$/.test(item.code)) throw new Error("Rolling history accepts only four-digit ordinary equities");
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function barsUpsert(d1: D1Database, generationId: string, payload: string, now: string) {
  return d1.prepare(`INSERT INTO operational_daily_bars
    (generation_id,market,code,trading_date,open,high,low,close,change,volume,trade_value,source,ingested_at)
    SELECT ?,json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.tradingDate'),
      json_extract(value,'$.open'),json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),
      json_extract(value,'$.change'),json_extract(value,'$.volume'),json_extract(value,'$.tradeValue'),json_extract(value,'$.source'),?
    FROM json_each(?) WHERE 1 ON CONFLICT(generation_id,market,code,trading_date) DO UPDATE SET
      open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,change=excluded.change,
      volume=excluded.volume,trade_value=excluded.trade_value,source=excluded.source,ingested_at=excluded.ingested_at`)
    .bind(generationId, now, payload);
}

function quotesUpsert(d1: D1Database, generationId: string, payload: string, now: string) {
  return d1.prepare(`INSERT INTO operational_latest_quotes
    (generation_id,market,code,name,security_type,trading_date,open,high,low,close,change,volume,trade_value,source,ingested_at)
    SELECT ?,json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),
      json_extract(value,'$.securityType'),json_extract(value,'$.tradingDate'),json_extract(value,'$.open'),
      json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),json_extract(value,'$.change'),
      json_extract(value,'$.volume'),json_extract(value,'$.tradeValue'),json_extract(value,'$.source'),?
    FROM json_each(?) WHERE 1 ON CONFLICT(generation_id,market,code) DO UPDATE SET
      name=excluded.name,security_type=excluded.security_type,trading_date=excluded.trading_date,open=excluded.open,
      high=excluded.high,low=excluded.low,close=excluded.close,change=excluded.change,volume=excluded.volume,
      trade_value=excluded.trade_value,source=excluded.source,ingested_at=excluded.ingested_at
    WHERE excluded.trading_date>=operational_latest_quotes.trading_date`).bind(generationId, now, payload);
}

function securitiesUpsert(d1: D1Database, generationId: string, payload: string) {
  return d1.prepare(`INSERT INTO operational_securities
    (generation_id,market,code,name,security_type,first_seen,last_seen)
    SELECT ?,json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),
      json_extract(value,'$.securityType'),json_extract(value,'$.tradingDate'),json_extract(value,'$.tradingDate')
    FROM json_each(?) WHERE 1 ON CONFLICT(generation_id,market,code) DO UPDATE SET
      name=excluded.name,security_type=excluded.security_type,first_seen=min(first_seen,excluded.first_seen),
      last_seen=max(last_seen,excluded.last_seen)`).bind(generationId, payload);
}

async function generationStatus(d1: D1Database, generationId?: string) {
  const state = await d1.prepare(`SELECT active_generation AS activeGeneration,retention_trading_days AS retentionTradingDays,
    policy_version AS policyVersion,strategy_max_lookback AS strategyMaxLookback,forecast_max_horizon AS forecastMaxHorizon,
    safety_buffer_days AS safetyBufferDays,latest_completed_date AS latestCompletedDate,freshness_status AS freshnessStatus,
    last_incremental_at AS lastIncrementalAt,updated_at AS updatedAt FROM operational_state WHERE id=1`).first();
  const generation = generationId ? await d1.prepare(`SELECT generation_id AS generationId,snapshot_version AS snapshotVersion,
    source_sha256 AS sourceSha256,base_last_date AS baseLastDate,status,retention_trading_days AS retentionTradingDays,
    expected_bars AS expectedBars,expected_quotes AS expectedQuotes,expected_chunks AS expectedChunks,
    imported_bars AS importedBars,imported_quotes AS importedQuotes,imported_chunks AS importedChunks,
    chunk_rows AS chunkRows,
    created_at AS createdAt,updated_at AS updatedAt,activated_at AS activatedAt,last_error AS lastError
    FROM operational_generations WHERE generation_id=?`).bind(generationId).first<{
      importedBars: number; expectedBars: number; importedChunks: number; chunkRows: number;
    }>() : null;
  const lastChunk = generationId && generation ? await d1.prepare(`SELECT source_kind AS sourceKind,
    source_last_id AS sourceLastId FROM operational_import_chunks WHERE generation_id=?
    ORDER BY chunk_index DESC LIMIT 1`).bind(generationId).first<{ sourceKind: string | null; sourceLastId: number | null }>() : null;
  const resumeKind = generation && generation.importedBars < generation.expectedBars ? "bars" : "quotes";
  const resumeSourceId = lastChunk?.sourceKind === resumeKind ? Number(lastChunk.sourceLastId ?? 0) : 0;
  return { mode: "operational_generation", policy: OPERATIONAL_RETENTION, state,
    generation: generation ? { ...generation, resumeKind, resumeSourceId } : null };
}

export async function GET(request: Request) {
  try {
    const generationId = new URL(request.url).searchParams.get("generation") ?? undefined;
    return Response.json(await generationStatus(await getRawDb(), generationId), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ mode: "operational_generation", policy: OPERATIONAL_RETENTION, state: null, generation: null }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ status: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as StartRequest | ChunkRequest | GenerationRequest;
    if (!validId(body.generationId)) throw new Error("Invalid operational generation ID");
    const d1 = await getRawDb();
    const now = new Date().toISOString();

    if (body.action === "start") {
      if (!validId(body.snapshotVersion) || !/^[a-f0-9]{64}$/.test(body.sourceSha256) || !validDate(body.baseLastDate)) throw new Error("Invalid snapshot identity");
      assertRetentionCoversStrategies(body.retentionTradingDays);
      for (const value of [body.expectedBars, body.expectedQuotes, body.totalChunks, body.chunkRows]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid operational import count");
      }
      if (body.chunkRows > 1_500) throw new Error("Operational chunk size exceeds the API limit");
      const existing = await d1.prepare(`SELECT status,source_sha256 AS sourceSha256,snapshot_version AS snapshotVersion,
        base_last_date AS baseLastDate,retention_trading_days AS retentionTradingDays,expected_bars AS expectedBars,
        expected_quotes AS expectedQuotes,expected_chunks AS expectedChunks,chunk_rows AS chunkRows
        FROM operational_generations WHERE generation_id=?`).bind(body.generationId).first<{
          status: string; sourceSha256: string; snapshotVersion: string; baseLastDate: string;
          retentionTradingDays: number; expectedBars: number; expectedQuotes: number; expectedChunks: number; chunkRows: number;
        }>();
      if (existing) {
        if (existing.sourceSha256 !== body.sourceSha256 || existing.snapshotVersion !== body.snapshotVersion ||
          existing.baseLastDate !== body.baseLastDate || existing.retentionTradingDays !== body.retentionTradingDays ||
          existing.expectedBars !== body.expectedBars || existing.expectedQuotes !== body.expectedQuotes ||
          existing.expectedChunks !== body.totalChunks || existing.chunkRows !== body.chunkRows) {
          throw new Error("Generation ID already belongs to different immutable import parameters");
        }
        return Response.json(await generationStatus(d1, body.generationId));
      }
      await d1.prepare(`INSERT INTO operational_generations
        (generation_id,snapshot_version,source_sha256,base_last_date,status,retention_trading_days,
         expected_bars,expected_quotes,expected_chunks,chunk_rows,created_at,updated_at)
        VALUES (?,?,?,?,'shadow',?,?,?,?,?,?,?)`)
        .bind(body.generationId, body.snapshotVersion, body.sourceSha256, body.baseLastDate,
          body.retentionTradingDays, body.expectedBars, body.expectedQuotes, body.totalChunks, body.chunkRows, now, now).run();
      return Response.json(await generationStatus(d1, body.generationId), { status: 201 });
    }

    if (body.action === "chunk") {
      if (!Number.isSafeInteger(body.chunkIndex) || body.chunkIndex < 0 || !/^[a-f0-9]{64}$/.test(body.sha256) ||
        !["bars", "quotes"].includes(body.kind) || !Number.isSafeInteger(body.sourceLastId) || body.sourceLastId < 1) {
        throw new Error("Invalid operational chunk identity");
      }
      validateRows(body.bars, true); validateRows(body.quotes, false);
      if (body.bars.length + body.quotes.length < 1) throw new Error("Operational chunk is empty");
      const rows = body.kind === "bars" ? body.bars : body.quotes;
      if ((body.kind === "bars" && body.quotes.length) || (body.kind === "quotes" && body.bars.length) ||
        rows.at(-1)?.id !== body.sourceLastId || rows.some((row, index) => index > 0 && row.id <= rows[index - 1].id)) {
        throw new Error("Operational chunk cursor is invalid");
      }
      const canonical = JSON.stringify({ bars: body.bars, quotes: body.quotes });
      if (await sha256(canonical) !== body.sha256) throw new Error("Operational chunk checksum mismatch");
      const generation = await d1.prepare(`SELECT status,expected_chunks AS expectedChunks,expected_bars AS expectedBars,
        expected_quotes AS expectedQuotes,imported_bars AS importedBars,imported_quotes AS importedQuotes,
        imported_chunks AS importedChunks FROM operational_generations WHERE generation_id=?`).bind(body.generationId).first<{
          status: string; expectedChunks: number; expectedBars: number; expectedQuotes: number;
          importedBars: number; importedQuotes: number; importedChunks: number;
        }>();
      if (!generation || generation.status !== "shadow" || body.chunkIndex >= generation.expectedChunks) throw new Error("Operational generation is not accepting chunks");
      const prior = await d1.prepare(`SELECT sha256,source_kind AS sourceKind,source_last_id AS sourceLastId
        FROM operational_import_chunks WHERE generation_id=? AND chunk_index=?`).bind(body.generationId, body.chunkIndex)
        .first<{ sha256: string; sourceKind: string | null; sourceLastId: number | null }>();
      if (prior) {
        if (prior.sha256 !== body.sha256 || prior.sourceKind !== body.kind || prior.sourceLastId !== body.sourceLastId) {
          throw new Error("Chunk index was already imported with different immutable metadata");
        }
        return Response.json({ status: "already_imported", generationId: body.generationId, chunkIndex: body.chunkIndex });
      }
      if (body.chunkIndex !== generation.importedChunks) throw new Error("Operational chunks must be imported sequentially");
      const expectedKind = generation.importedBars < generation.expectedBars ? "bars" : "quotes";
      if (body.kind !== expectedKind || generation.importedBars + body.bars.length > generation.expectedBars ||
        generation.importedQuotes + body.quotes.length > generation.expectedQuotes) throw new Error("Operational chunk exceeds its manifest phase");
      const previous = await d1.prepare(`SELECT source_kind AS sourceKind,source_last_id AS sourceLastId
        FROM operational_import_chunks WHERE generation_id=? ORDER BY chunk_index DESC LIMIT 1`).bind(body.generationId)
        .first<{ sourceKind: string | null; sourceLastId: number | null }>();
      if (previous?.sourceKind === body.kind && body.sourceLastId <= Number(previous.sourceLastId ?? 0)) {
        throw new Error("Operational chunk cursor did not advance");
      }
      const statements: D1PreparedStatement[] = [];
      if (body.bars.length) {
        const payload = JSON.stringify(body.bars);
        statements.push(barsUpsert(d1, body.generationId, payload, now), securitiesUpsert(d1, body.generationId, payload));
      }
      if (body.quotes.length) {
        const payload = JSON.stringify(body.quotes);
        statements.push(quotesUpsert(d1, body.generationId, payload, now), securitiesUpsert(d1, body.generationId, payload));
      }
      statements.push(d1.prepare(`INSERT INTO operational_import_chunks
        (generation_id,chunk_index,sha256,bars_written,quotes_written,source_kind,source_last_id,imported_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(body.generationId, body.chunkIndex, body.sha256, body.bars.length, body.quotes.length,
          body.kind, body.sourceLastId, now));
      statements.push(d1.prepare(`UPDATE operational_generations SET imported_bars=imported_bars+?,
        imported_quotes=imported_quotes+?,imported_chunks=imported_chunks+1,updated_at=?,last_error=NULL WHERE generation_id=?`)
        .bind(body.bars.length, body.quotes.length, now, body.generationId));
      await d1.batch(statements);
      return Response.json({ status: "imported", generationId: body.generationId, chunkIndex: body.chunkIndex }, { status: 202 });
    }

    const generation = await d1.prepare(`SELECT status,base_last_date AS baseLastDate,retention_trading_days AS retentionTradingDays,
      expected_bars AS expectedBars,expected_quotes AS expectedQuotes,expected_chunks AS expectedChunks
      FROM operational_generations WHERE generation_id=?`).bind(body.generationId)
      .first<{ status: string; baseLastDate: string; retentionTradingDays: number; expectedBars: number; expectedQuotes: number; expectedChunks: number }>();
    if (!generation) throw new Error("Operational generation does not exist");

    if (body.action === "validate") {
      const [bars, quotes, chunks, dates] = await Promise.all([
        d1.prepare("SELECT count(*) count FROM operational_daily_bars WHERE generation_id=?").bind(body.generationId).first<{ count: number }>(),
        d1.prepare("SELECT count(*) count FROM operational_latest_quotes WHERE generation_id=?").bind(body.generationId).first<{ count: number }>(),
        d1.prepare("SELECT count(*) count FROM operational_import_chunks WHERE generation_id=?").bind(body.generationId).first<{ count: number }>(),
        d1.prepare("SELECT count(DISTINCT trading_date) count FROM operational_daily_bars WHERE generation_id=?").bind(body.generationId).first<{ count: number }>(),
      ]);
      if (bars?.count !== generation.expectedBars || quotes?.count !== generation.expectedQuotes || chunks?.count !== generation.expectedChunks) throw new Error("Shadow generation row or chunk counts do not match the manifest");
      if ((dates?.count ?? 0) > generation.retentionTradingDays) throw new Error("Shadow generation exceeds its retention policy");
      await d1.prepare("UPDATE operational_generations SET status='ready',updated_at=?,last_error=NULL WHERE generation_id=? AND status='shadow'").bind(now, body.generationId).run();
      return Response.json(await generationStatus(d1, body.generationId));
    }

    if (body.action === "activate") {
      if (!(["ready", "active"] as string[]).includes(generation.status)) throw new Error("Generation must be validated before activation");
      const checkpoint = await d1.prepare(`SELECT max(trading_date) tradingDate FROM (
        SELECT trading_date FROM operational_ingestion_units WHERE generation_id=? GROUP BY trading_date
        HAVING count(*)=2 AND sum(CASE WHEN status IN ('complete','validated_empty') THEN 1 ELSE 0 END)=2
      )`).bind(body.generationId).first<{ tradingDate: string | null }>();
      const throughDate = checkpoint?.tradingDate ?? generation.baseLastDate;
      const targetDate = latestCompletedMarketDate();
      if (throughDate < targetDate && body.allowStaleBootstrap !== true) {
        throw new Error(`Shadow generation is only caught up through ${throughDate}; target is ${targetDate}`);
      }
      const freshness = freshnessStatus(throughDate, targetDate);
      await d1.batch([
        d1.prepare("UPDATE operational_generations SET status='retired',updated_at=? WHERE status='active' AND generation_id<>?").bind(now, body.generationId),
        d1.prepare("UPDATE operational_generations SET status='active',activated_at=coalesce(activated_at,?),updated_at=? WHERE generation_id=?").bind(now, now, body.generationId),
        d1.prepare(`INSERT INTO operational_state
          (id,active_generation,retention_trading_days,policy_version,strategy_max_lookback,forecast_max_horizon,
           safety_buffer_days,latest_completed_date,freshness_status,last_incremental_at,updated_at)
          VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active_generation=excluded.active_generation,
          retention_trading_days=excluded.retention_trading_days,policy_version=excluded.policy_version,
          strategy_max_lookback=excluded.strategy_max_lookback,forecast_max_horizon=excluded.forecast_max_horizon,
          safety_buffer_days=excluded.safety_buffer_days,latest_completed_date=excluded.latest_completed_date,
          freshness_status=excluded.freshness_status,last_incremental_at=excluded.last_incremental_at,updated_at=excluded.updated_at`)
          .bind(body.generationId, generation.retentionTradingDays, OPERATIONAL_RETENTION.version,
            OPERATIONAL_RETENTION.strategyMaxLookback, OPERATIONAL_RETENTION.forecastMaxHorizon,
            OPERATIONAL_RETENTION.safetyBufferDays, throughDate, freshness, now, now),
      ]);
      return Response.json(await generationStatus(d1, body.generationId));
    }

    if (body.action === "cleanup") {
      const active = await d1.prepare("SELECT active_generation AS generationId FROM operational_state WHERE id=1").first<{ generationId: string | null }>();
      if (active?.generationId === body.generationId) throw new Error("The active generation cannot be cleaned up");
      await d1.batch([
        d1.prepare("DELETE FROM operational_import_chunks WHERE generation_id=?").bind(body.generationId),
        d1.prepare("DELETE FROM operational_ingestion_units WHERE generation_id=?").bind(body.generationId),
        d1.prepare("DELETE FROM operational_market_indices WHERE generation_id=?").bind(body.generationId),
        d1.prepare("DELETE FROM operational_latest_quotes WHERE generation_id=?").bind(body.generationId),
        d1.prepare("DELETE FROM operational_daily_bars WHERE generation_id=?").bind(body.generationId),
        d1.prepare("DELETE FROM operational_securities WHERE generation_id=?").bind(body.generationId),
        d1.prepare("DELETE FROM operational_generations WHERE generation_id=? AND status<>'active'").bind(body.generationId),
      ]);
      return Response.json({ status: "cleaned", generationId: body.generationId });
    }
    throw new Error("Unknown operational rebuild action");
  } catch (error) {
    return Response.json({ status: "error", error: error instanceof Error ? error.message : "Unknown operational rebuild error" }, { status: 400 });
  }
}
