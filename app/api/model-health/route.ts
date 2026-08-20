import { desc } from "drizzle-orm";
import { getDb, getRawDb } from "../../../db";
import { modelRuns } from "../../../db/schema";
import { BACKFILL_POLICY } from "../../../lib/historical-data";

export const dynamic = "force-dynamic";

type BackfillJob = {
  id: number; status: string; targetStart: string; targetEnd: string; cursorDate: string; cursorMarket: string;
  processedUnits: number; totalUnits: number; storedRows: number; emptyUnits: number; failedUnits: number; updatedAt: string;
  phase: string; estimatedTotalRows: number; lastBatchId: string | null; lastBatchRows: number;
  lastCheckpointAt: string | null; apiRetryCount: number; throttledMs: number; startedAt: string;
};
type Runner = {
  status: string; leaseUntil: string | null; lastStartedAt: string | null; lastHeartbeatAt: string | null;
  lastFinishedAt: string | null; completedBatches: number; completedUnits: number; lastError: string | null;
  activeRuntimeMs: number; lastBatchRows: number; lastBatchDurationMs: number; recentRowsPerSecond: number;
  apiRetryCount: number; throttledMs: number; networkMs: number; parseMs: number; dbWriteMs: number;
  workerWaitMs: number; rateLimited: number; checkpointStatus: string;
  automationEnabled: number; schedulerIntervalMinutes: number;
  schedulerLastTriggeredAt: string | null; schedulerNextExpectedAt: string | null;
  lastTriggerSource: string; schedulerHealthy?: boolean;
};

function weekdayMarketUnits(start: string, end: string) {
  let units = 0;
  const cursor = new Date(`${start}T12:00:00Z`);
  const finish = Date.parse(`${end}T12:00:00Z`);
  while (cursor.getTime() <= finish) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) units += 2;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return units;
}

function estimateTotalRows(job: BackfillJob) {
  const successfulUnits = Math.max(1, job.processedUnits - job.emptyUnits - job.failedUnits);
  const observedAverage = job.storedRows / successfulUnits;
  const blendedAverage = job.failedUnits > successfulUnits ? (observedAverage + 850) / 2 : observedAverage;
  return Math.max(job.storedRows, Math.round(blendedAverage * weekdayMarketUnits(job.targetStart, job.targetEnd)));
}

export async function GET() {
  try {
    const healthStarted = performance.now();
    const [db, d1] = await Promise.all([getDb(), getRawDb()]);
    const [job, audits, failures, runs, runner, securities] = await Promise.all([
      d1.prepare(`
        SELECT id, status, target_start AS targetStart, target_end AS targetEnd,
          cursor_date AS cursorDate, cursor_market AS cursorMarket,
          processed_units AS processedUnits, total_units AS totalUnits,
          stored_rows AS storedRows, empty_units AS emptyUnits, failed_units AS failedUnits,
          phase, estimated_total_rows AS estimatedTotalRows,
          last_batch_id AS lastBatchId, last_batch_rows AS lastBatchRows,
          last_checkpoint_at AS lastCheckpointAt, api_retry_count AS apiRetryCount,
          throttled_ms AS throttledMs, started_at AS startedAt, updated_at AS updatedAt
        FROM backfill_jobs ORDER BY id DESC LIMIT 1
      `).first<BackfillJob>(),
      d1.prepare(`
        SELECT audit_type AS auditType,
          SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed,
          SUM(CASE WHEN status != 'pass' THEN 1 ELSE 0 END) AS blocked,
          SUM(violations) AS violations
        FROM bias_audits GROUP BY audit_type
      `).all<{ auditType: string; passed: number; blocked: number; violations: number }>(),
      d1.prepare("SELECT count(*) AS count FROM backfill_failures WHERE status = 'open'").first<{ count: number }>(),
      db.select().from(modelRuns).orderBy(desc(modelRuns.createdAt)).limit(3),
      d1.prepare(`
        SELECT CASE WHEN status = 'running' AND lease_until < ? THEN 'stale' ELSE status END AS status,
          lease_until AS leaseUntil, last_started_at AS lastStartedAt,
          last_heartbeat_at AS lastHeartbeatAt, last_finished_at AS lastFinishedAt,
          completed_batches AS completedBatches, completed_units AS completedUnits,
          active_runtime_ms AS activeRuntimeMs, last_batch_rows AS lastBatchRows,
          last_batch_duration_ms AS lastBatchDurationMs,
          recent_rows_per_second AS recentRowsPerSecond,
          api_retry_count AS apiRetryCount, throttled_ms AS throttledMs,
          network_ms AS networkMs, parse_ms AS parseMs, db_write_ms AS dbWriteMs,
          worker_wait_ms AS workerWaitMs, rate_limited AS rateLimited,
          checkpoint_status AS checkpointStatus,
          automation_enabled AS automationEnabled,
          scheduler_interval_minutes AS schedulerIntervalMinutes,
          scheduler_last_triggered_at AS schedulerLastTriggeredAt,
          scheduler_next_expected_at AS schedulerNextExpectedAt,
          last_trigger_source AS lastTriggerSource, last_error AS lastError
        FROM backfill_runner WHERE id = 1
      `).bind(new Date().toISOString()).first<Runner>(),
      d1.prepare("SELECT count(*) AS count, min(first_seen) AS earliestDate, max(last_seen) AS latestDate FROM historical_securities")
        .first<{ count: number; earliestDate: string | null; latestDate: string | null }>(),
    ]);
    const estimatedTotalRows = job ? estimateTotalRows(job) : 0;
    const activeRuntimeMs = runner?.activeRuntimeMs ?? 0;
    const averageRowsPerSecond = job && activeRuntimeMs > 0 ? job.storedRows / (activeRuntimeMs / 1_000) : 0;
    const recentRowsPerSecond = runner?.recentRowsPerSecond ?? 0;
    const etaRate = recentRowsPerSecond > 0 ? recentRowsPerSecond : averageRowsPerSecond;
    const etaSeconds = job && etaRate > 0 ? Math.max(0, (estimatedTotalRows - job.storedRows) / etaRate) : null;
    const schedulerHealthy = Boolean(
      runner?.schedulerLastTriggeredAt &&
      Date.now() - Date.parse(runner.schedulerLastTriggeredAt) < 3 * 60_000,
    );
    return Response.json({
      status: job?.status ?? "not_started",
      historicalRows: job?.storedRows ?? 0,
      stockCount: securities?.count ?? 0,
      earliestDate: securities?.earliestDate ?? null,
      latestDate: securities?.latestDate ?? null,
      modelRuns: runs,
      backfill: job ? {
        ...job, estimatedTotalRows,
        progress: Math.min(100, Number(((job.processedUnits / Math.max(job.totalUnits, 1)) * 100).toFixed(2))),
        rowProgress: Math.min(100, Number(((job.storedRows / Math.max(estimatedTotalRows, 1)) * 100).toFixed(2))),
        openFailures: failures?.count ?? 0,
        audits: audits.results,
      } : null,
      runner: runner ? { ...runner, schedulerHealthy } : null,
      performance: {
        recentRowsPerSecond, averageRowsPerSecond, activeRuntimeMs, etaSeconds,
        abnormal: etaSeconds !== null && etaSeconds > 86_400,
        apiRetryCount: runner?.apiRetryCount ?? 0,
        throttledMs: runner?.throttledMs ?? 0,
        rateLimited: Boolean(runner?.rateLimited),
        networkMs: runner?.networkMs ?? 0, parseMs: runner?.parseMs ?? 0,
        dbWriteMs: runner?.dbWriteMs ?? 0, workerWaitMs: runner?.workerWaitMs ?? 0,
        featureMs: 0, healthQueryMs: Math.round(performance.now() - healthStarted),
      },
      currentStage: "下載原始行情 → 正規化 → 驗證 → 批次寫入",
      nextStages: ["資料清洗／公司事件／除權息", "Feature Engineering", "Walk-Forward 樣本外回測", "機率校準", "解鎖研究候選"],
      policy: BACKFILL_POLICY,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({
      status: "not_started", historicalRows: 0, stockCount: 0, earliestDate: null, latestDate: null,
      modelRuns: [], backfill: null, runner: null, policy: BACKFILL_POLICY,
      performance: {
        recentRowsPerSecond: 0, averageRowsPerSecond: 0, activeRuntimeMs: 0, etaSeconds: null,
        abnormal: false, apiRetryCount: 0, throttledMs: 0, rateLimited: false,
        networkMs: 0, parseMs: 0, dbWriteMs: 0, workerWaitMs: 0, featureMs: 0, healthQueryMs: 0,
      },
      currentStage: "下載原始行情 → 正規化 → 驗證 → 批次寫入", nextStages: [],
    });
  }
}
