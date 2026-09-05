import { desc } from "drizzle-orm";
import { getDb, getRawDb } from "../../../db";
import { modelRuns } from "../../../db/schema";
import { OPERATIONAL_RETENTION } from "../../../lib/operational-policy";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  try {
    const [db, d1] = await Promise.all([getDb(), getRawDb()]);
    const state = await d1.prepare(`SELECT active_generation AS generationId,retention_trading_days AS retentionTradingDays,
      policy_version AS policyVersion,strategy_max_lookback AS strategyMaxLookback,forecast_max_horizon AS forecastMaxHorizon,
      safety_buffer_days AS safetyBufferDays,latest_completed_date AS latestCompletedDate,freshness_status AS freshnessStatus,
      last_incremental_at AS lastIncrementalAt,updated_at AS updatedAt FROM operational_state WHERE id=1`).first<{
        generationId: string | null; retentionTradingDays: number; policyVersion: string; strategyMaxLookback: number;
        forecastMaxHorizon: number; safetyBufferDays: number; latestCompletedDate: string | null;
        freshnessStatus: string; lastIncrementalAt: string | null; updatedAt: string;
      }>();
    const generation = state?.generationId ? await d1.prepare(`SELECT generation_id AS generationId,snapshot_version AS snapshotVersion,
      source_sha256 AS sourceSha256,base_last_date AS baseLastDate,status,expected_bars AS expectedBars,
      expected_quotes AS expectedQuotes,expected_chunks AS expectedChunks,imported_bars AS importedBars,
      imported_quotes AS importedQuotes,imported_chunks AS importedChunks,created_at AS createdAt,
      updated_at AS updatedAt,activated_at AS activatedAt,last_error AS lastError FROM operational_generations WHERE generation_id=?`)
      .bind(state.generationId).first<{
        generationId: string; snapshotVersion: string; sourceSha256: string; baseLastDate: string; status: string;
        expectedBars: number; expectedQuotes: number; expectedChunks: number; importedBars: number; importedQuotes: number;
        importedChunks: number; createdAt: string; updatedAt: string; activatedAt: string | null; lastError: string | null;
      }>() : null;
    const [bars, quotes, gaps, runs] = await Promise.all([
      state?.generationId ? d1.prepare(`SELECT count(*) AS count,count(DISTINCT trading_date) AS tradingDayCount,min(trading_date) AS earliestDate,max(trading_date) AS latestDate
        FROM operational_daily_bars WHERE generation_id=?`).bind(state.generationId).first<{ count: number; tradingDayCount: number; earliestDate: string | null; latestDate: string | null }>() : null,
      state?.generationId ? d1.prepare("SELECT count(*) AS count FROM operational_latest_quotes WHERE generation_id=?").bind(state.generationId).first<{ count: number }>() : null,
      state?.generationId ? d1.prepare("SELECT count(*) AS count FROM operational_ingestion_units WHERE generation_id=? AND status='failed'").bind(state.generationId).first<{ count: number }>() : null,
      db.select().from(modelRuns).orderBy(desc(modelRuns.createdAt)).limit(3),
    ]);
    return Response.json({
      status: state?.freshnessStatus ?? "not_initialized",
      historicalRows: bars?.count ?? 0,
      stockCount: quotes?.count ?? 0,
      earliestDate: bars?.earliestDate ?? null,
      latestDate: bars?.latestDate ?? null,
      tradingDayCount: bars?.tradingDayCount ?? 0,
      modelRuns: runs,
      backfill: null,
      runner: null,
      snapshot: generation ? {
        snapshotVersion: generation.snapshotVersion,
        cutoffDate: generation.baseLastDate,
        status: generation.status === "active" ? "complete" : generation.status,
        expectedRows: generation.expectedBars + generation.expectedQuotes,
        importedRows: generation.importedBars + generation.importedQuotes,
        nextChunk: generation.importedChunks,
        totalChunks: generation.expectedChunks,
        lastError: generation.lastError,
        startedAt: generation.createdAt,
        updatedAt: generation.updatedAt,
        completedAt: generation.activatedAt,
      } : null,
      operational: { state, generation, missingOrFailedUnits: gaps?.count ?? 0, policy: OPERATIONAL_RETENTION },
      performance: {
        recentRowsPerSecond: 0, averageRowsPerSecond: 0, activeRuntimeMs: 0, etaSeconds: null,
        abnormal: false, apiRetryCount: 0, throttledMs: 0, rateLimited: false,
        networkMs: 0, parseMs: 0, dbWriteMs: 0, workerWaitMs: 0, featureMs: 0,
        healthQueryMs: Math.round(performance.now() - started),
      },
      currentStage: state?.freshnessStatus === "fresh" ? "Operational DB 每日增量" : "Operational generation 建立／追趕",
      nextStages: ["每日上市＋上櫃增量", "缺口自動重試", "Feature Engineering", "Walk-Forward 樣本外回測", "機率校準"],
      policy: OPERATIONAL_RETENTION,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({
      status: "not_initialized", historicalRows: 0, stockCount: 0, earliestDate: null, latestDate: null, tradingDayCount: 0,
      modelRuns: [], backfill: null, runner: null, snapshot: null,
      operational: { state: null, generation: null, missingOrFailedUnits: 0, policy: OPERATIONAL_RETENTION },
      performance: { recentRowsPerSecond: 0, averageRowsPerSecond: 0, activeRuntimeMs: 0, etaSeconds: null,
        abnormal: false, apiRetryCount: 0, throttledMs: 0, rateLimited: false, networkMs: 0, parseMs: 0,
        dbWriteMs: 0, workerWaitMs: 0, featureMs: 0, healthQueryMs: Math.round(performance.now() - started) },
      currentStage: "Operational generation 尚未初始化", nextStages: [], policy: OPERATIONAL_RETENTION,
    });
  }
}
