import { getRawDb } from "../../../db";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  auditBiasGuards,
  BACKFILL_POLICY,
  fetchHistoricalMarketDay,
  historicalSourceUrl,
  type FetchProfile,
  type HistoricalMarket,
  type HistoricalObservation,
} from "../../../lib/historical-data";

export const dynamic = "force-dynamic";

type JobRow = {
  id: number;
  version: string;
  targetStart: string;
  targetEnd: string;
  cursorDate: string;
  cursorMarket: HistoricalMarket;
  status: string;
  processedUnits: number;
  totalUnits: number;
  storedRows: number;
  emptyUnits: number;
  failedUnits: number;
  phase: string;
  estimatedTotalRows: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type FailureRow = { id: number; market: HistoricalMarket; tradingDate: string };
type RunnerRow = {
  status: string;
  leaseUntil: string | null;
  lastStartedAt: string | null;
  lastHeartbeatAt: string | null;
  lastFinishedAt: string | null;
  completedBatches: number;
  completedUnits: number;
  activeRuntimeMs: number;
  lastBatchRows: number;
  lastBatchDurationMs: number;
  recentRowsPerSecond: number;
  apiRetryCount: number;
  throttledMs: number;
  networkMs: number;
  parseMs: number;
  dbWriteMs: number;
  workerWaitMs: number;
  rateLimited: number;
  checkpointStatus: string;
  automationEnabled: number;
  schedulerIntervalMinutes: number;
  schedulerLastTriggeredAt: string | null;
  schedulerNextExpectedAt: string | null;
  lastTriggerSource: string;
  lastError: string | null;
};

type UnitResult = {
  market: HistoricalMarket;
  tradingDate: string;
  source: string;
  observations: HistoricalObservation[];
  profile: FetchProfile;
  error: string | null;
  audit: ReturnType<typeof auditBiasGuards> | null;
};

type BatchProfile = {
  completedUnits: number;
  rowsFetched: number;
  rowsWritten: number;
  networkMs: number;
  parseMs: number;
  dbWriteMs: number;
  apiRetryCount: number;
  throttledMs: number;
  rateLimited: boolean;
};

const SERVER_BATCH = Object.freeze({
  maxTradingDates: 18,
  maxRuntimeMs: 24_000,
  leaseMs: 90_000,
  bulkTargetBytes: 700_000,
  workers: 2,
});

const EMPTY_PROFILE: FetchProfile = {
  networkMs: 0,
  parseMs: 0,
  retryCount: 0,
  throttledMs: 0,
  rateLimited: false,
  attempts: 0,
};

function taipeiYesterday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1_000 - 86_400_000).toISOString().slice(0, 10);
}

function dayBefore(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function calendarDays(start: string, end: string) {
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

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

function isWeekend(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function unitsAtCursor(job: JobRow) {
  return job.cursorMarket === "上市" ? (["上市", "上櫃"] as HistoricalMarket[]) : (["上櫃"] as HistoricalMarket[]);
}

function emptyBatchProfile(): BatchProfile {
  return { completedUnits: 0, rowsFetched: 0, rowsWritten: 0, networkMs: 0, parseMs: 0, dbWriteMs: 0, apiRetryCount: 0, throttledMs: 0, rateLimited: false };
}

function mergeProfile(target: BatchProfile, unit: UnitResult) {
  target.completedUnits += 1;
  target.rowsFetched += unit.observations.length;
  target.networkMs += unit.profile.networkMs;
  target.parseMs += unit.profile.parseMs;
  target.apiRetryCount += unit.profile.retryCount;
  target.throttledMs += unit.profile.throttledMs;
  target.rateLimited ||= unit.profile.rateLimited;
}

async function latestJob() {
  const d1 = await getRawDb();
  return await d1.prepare(`
    SELECT id, version, target_start AS targetStart, target_end AS targetEnd,
      cursor_date AS cursorDate, cursor_market AS cursorMarket, status,
      processed_units AS processedUnits, total_units AS totalUnits,
      stored_rows AS storedRows, empty_units AS emptyUnits, failed_units AS failedUnits,
      phase, estimated_total_rows AS estimatedTotalRows,
      started_at AS startedAt, updated_at AS updatedAt, completed_at AS completedAt
    FROM backfill_jobs ORDER BY id DESC LIMIT 1
  `).first<JobRow>();
}

async function runnerState() {
  const d1 = await getRawDb();
  return await d1.prepare(`
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
  `).bind(new Date().toISOString()).first<RunnerRow>();
}

async function ensureRunnerState() {
  const d1 = await getRawDb();
  await d1.prepare(`
    INSERT OR IGNORE INTO backfill_runner (id, status, completed_batches, completed_units)
    VALUES (1, 'idle', 0, 0)
  `).run();
}

async function acquireRunnerLease(token: string, triggerSource: "scheduled" | "manual") {
  const d1 = await getRawDb();
  await ensureRunnerState();
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + SERVER_BATCH.leaseMs).toISOString();
  const nextExpectedAt = triggerSource === "scheduled" ? new Date(now.getTime() + 60_000).toISOString() : null;
  const result = await d1.prepare(`
    UPDATE backfill_runner SET
      status = 'running', lease_token = ?, lease_until = ?,
      last_started_at = ?, last_heartbeat_at = ?, last_error = NULL,
      checkpoint_status = 'writing', last_trigger_source = ?,
      scheduler_last_triggered_at = CASE WHEN ? = 'scheduled' THEN ? ELSE scheduler_last_triggered_at END,
      scheduler_next_expected_at = CASE WHEN ? = 'scheduled' THEN ? ELSE scheduler_next_expected_at END
    WHERE id = 1 AND (status != 'running' OR lease_until IS NULL OR lease_until < ?)
  `).bind(
    token, leaseUntil, nowIso, nowIso, triggerSource,
    triggerSource, nowIso, triggerSource, nextExpectedAt, nowIso,
  ).run();
  return (result.meta.changes ?? 0) > 0;
}

async function createJob() {
  const d1 = await getRawDb();
  const now = new Date().toISOString();
  const targetEnd = taipeiYesterday();
  const totalUnits = Math.max(0, calendarDays(BACKFILL_POLICY.targetStart, targetEnd) * 2);
  await d1.prepare(`
    INSERT INTO backfill_jobs (
      version, target_start, target_end, cursor_date, cursor_market, status,
      processed_units, total_units, stored_rows, empty_units, failed_units,
      phase, estimated_total_rows, started_at, updated_at
    ) VALUES (?, ?, ?, ?, '上市', 'running', 0, ?, 0, 0, 0, 'raw_history', 0, ?, ?)
  `).bind(BACKFILL_POLICY.version, BACKFILL_POLICY.targetStart, targetEnd, targetEnd, totalUnits, now, now).run();
  const job = await latestJob();
  if (!job) throw new Error("Backfill job could not be created");
  return job;
}

async function alignJobWithPolicy(job: JobRow) {
  const d1 = await getRawDb();
  const additionalUnits = job.targetStart > BACKFILL_POLICY.targetStart
    ? calendarDays(BACKFILL_POLICY.targetStart, dayBefore(job.targetStart)) * 2
    : 0;
  await d1.prepare(`
    UPDATE backfill_jobs SET
      version = ?, target_start = CASE WHEN target_start > ? THEN ? ELSE target_start END,
      total_units = total_units + ?, phase = 'raw_history', updated_at = ?
    WHERE id = ?
  `).bind(BACKFILL_POLICY.version, BACKFILL_POLICY.targetStart, BACKFILL_POLICY.targetStart, additionalUnits, new Date().toISOString(), job.id).run();
  return await latestJob() ?? job;
}

function chunkByEncodedSize(rows: HistoricalObservation[]) {
  const chunks: string[] = [];
  let current: HistoricalObservation[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const bytes = new TextEncoder().encode(encoded).byteLength + 1;
    if (current.length && currentBytes + bytes > SERVER_BATCH.bulkTargetBytes) {
      chunks.push(JSON.stringify(current));
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}

function observationUpsert(d1: D1Database, payload: string, ingestedAt: string, jobId: number) {
  return d1.prepare(`
    INSERT INTO historical_observations (
      market, code, name, trading_date, security_type, universe_status,
      open, high, low, close, change, volume, trade_value, source,
      source_scope, usable_from, ingested_at, backfill_job_id
    )
    SELECT
      json_extract(value, '$.market'), json_extract(value, '$.code'),
      json_extract(value, '$.name'), json_extract(value, '$.tradingDate'),
      json_extract(value, '$.securityType'), json_extract(value, '$.universeStatus'),
      json_extract(value, '$.open'), json_extract(value, '$.high'),
      json_extract(value, '$.low'), json_extract(value, '$.close'),
      json_extract(value, '$.change'), json_extract(value, '$.volume'),
      json_extract(value, '$.tradeValue'), json_extract(value, '$.source'),
      json_extract(value, '$.sourceScope'), json_extract(value, '$.usableFrom'), ?, ?
    FROM json_each(?) WHERE 1
    ON CONFLICT(market, code, trading_date) DO UPDATE SET
      name = excluded.name, security_type = excluded.security_type,
      universe_status = excluded.universe_status, open = excluded.open,
      high = excluded.high, low = excluded.low, close = excluded.close,
      change = excluded.change, volume = excluded.volume,
      trade_value = excluded.trade_value, source = excluded.source,
      source_scope = excluded.source_scope, usable_from = excluded.usable_from,
      ingested_at = excluded.ingested_at, backfill_job_id = excluded.backfill_job_id
  `).bind(ingestedAt, jobId, payload);
}

function securityUpsert(d1: D1Database, payload: string) {
  return d1.prepare(`
    INSERT INTO historical_securities (market, code, name, security_type, first_seen, last_seen)
    SELECT
      json_extract(value, '$.market'), json_extract(value, '$.code'),
      json_extract(value, '$.name'), json_extract(value, '$.securityType'),
      json_extract(value, '$.tradingDate'), json_extract(value, '$.tradingDate')
    FROM json_each(?) WHERE 1
    ON CONFLICT(market, code) DO UPDATE SET
      name = excluded.name, security_type = excluded.security_type,
      first_seen = min(first_seen, excluded.first_seen),
      last_seen = max(last_seen, excluded.last_seen)
  `).bind(payload);
}

async function fetchUnit(market: HistoricalMarket, tradingDate: string): Promise<UnitResult> {
  if (isWeekend(tradingDate)) {
    return { market, tradingDate, source: historicalSourceUrl(market, tradingDate), observations: [], profile: { ...EMPTY_PROFILE }, error: null, audit: auditBiasGuards([], tradingDate) };
  }
  try {
    const result = await fetchHistoricalMarketDay(market, tradingDate);
    return {
      market, tradingDate, source: result.source, observations: result.observations,
      profile: result.profile, error: null, audit: auditBiasGuards(result.observations, tradingDate),
    };
  } catch (error) {
    const profiled = error as Error & { fetchProfile?: FetchProfile };
    return {
      market, tradingDate, source: historicalSourceUrl(market, tradingDate), observations: [],
      profile: profiled.fetchProfile ?? { ...EMPTY_PROFILE }, error: profiled.message || "Unknown backfill error", audit: null,
    };
  }
}

async function writeDateTransaction(job: JobRow, batchId: string, token: string, units: UnitResult[], advanceCursor = true) {
  const d1 = await getRawDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  let stored = 0;
  let empty = 0;
  let failed = 0;
  let blocked = false;

  for (const unit of units) {
    const auditBlocked = unit.audit && (unit.audit.survivorship.status !== "pass" || unit.audit.lookAhead.status !== "pass");
    blocked ||= Boolean(auditBlocked);
    if (unit.error) failed += 1;
    else if (!unit.observations.length) empty += 1;
    else if (!auditBlocked) stored += unit.observations.length;

    if (!unit.error && !auditBlocked) {
      for (const payload of chunkByEncodedSize(unit.observations)) {
        statements.push(observationUpsert(d1, payload, nowIso, job.id));
        statements.push(securityUpsert(d1, payload));
      }
      statements.push(d1.prepare(`
        UPDATE backfill_failures SET status = 'resolved', updated_at = ?
        WHERE backfill_job_id = ? AND market = ? AND trading_date = ? AND status = 'open'
      `).bind(nowIso, job.id, unit.market, unit.tradingDate));
    }

    if (unit.audit) {
      const auditRows = [
        ["survivorship", unit.audit.survivorship.status, unit.audit.survivorship.violations, unit.audit.survivorship.rule],
        ["lookahead", unit.audit.lookAhead.status, unit.audit.lookAhead.violations, unit.audit.lookAhead.rule],
      ] as const;
      for (const [type, status, violations, rule] of auditRows) {
        statements.push(d1.prepare(`
          INSERT INTO bias_audits (
            backfill_job_id, market, trading_date, audit_type, status,
            checked_rows, violations, rule, checked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(backfill_job_id, market, trading_date, audit_type) DO UPDATE SET
            status = excluded.status, checked_rows = excluded.checked_rows,
            violations = excluded.violations, rule = excluded.rule, checked_at = excluded.checked_at
        `).bind(job.id, unit.market, unit.tradingDate, type, status, unit.observations.length, violations, rule, nowIso));
      }
    }

    if (unit.error) {
      statements.push(d1.prepare(`
        INSERT INTO backfill_failures (
          backfill_job_id, market, trading_date, source, error, attempts, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'open', ?, ?)
        ON CONFLICT(backfill_job_id, market, trading_date) DO UPDATE SET
          source = excluded.source, error = excluded.error,
          attempts = backfill_failures.attempts + 1, status = 'open', updated_at = excluded.updated_at
      `).bind(job.id, unit.market, unit.tradingDate, unit.source, unit.error.slice(0, 500), nowIso, nowIso));
    }

    const checkpointStatus = unit.error ? "failed" : auditBlocked ? "blocked" : unit.observations.length ? "completed" : "completed_empty";
    statements.push(d1.prepare(`
      INSERT INTO backfill_checkpoints (
        backfill_job_id, market, trading_date, status, batch_id,
        rows_fetched, rows_written, attempts, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backfill_job_id, market, trading_date) DO UPDATE SET
        status = excluded.status, batch_id = excluded.batch_id,
        rows_fetched = excluded.rows_fetched, rows_written = excluded.rows_written,
        attempts = backfill_checkpoints.attempts + excluded.attempts,
        last_error = excluded.last_error, updated_at = excluded.updated_at
    `).bind(
      job.id, unit.market, unit.tradingDate, checkpointStatus, batchId,
      unit.observations.length, unit.error || auditBlocked ? 0 : unit.observations.length,
      Math.max(1, unit.profile.attempts), unit.error?.slice(0, 500) ?? null, nowIso,
    ));
  }

  const cursorDate = dayBefore(job.cursorDate);
  const finished = cursorDate < job.targetStart;
  const status = blocked ? "blocked_bias_violation" : advanceCursor
    ? finished ? (job.failedUnits + failed > 0 ? "complete_with_gaps" : "complete") : "running"
    : job.status;
  const retryCount = units.reduce((sum, unit) => sum + unit.profile.retryCount, 0);
  const throttledMs = Math.round(units.reduce((sum, unit) => sum + unit.profile.throttledMs, 0));
  if (advanceCursor) {
    statements.push(d1.prepare(`
      UPDATE backfill_jobs SET
        cursor_date = ?, cursor_market = '上市', status = ?,
        processed_units = processed_units + ?, stored_rows = stored_rows + ?,
        empty_units = empty_units + ?, failed_units = failed_units + ?,
        last_batch_id = ?, last_batch_rows = ?, last_checkpoint_at = ?,
        api_retry_count = api_retry_count + ?, throttled_ms = throttled_ms + ?,
        updated_at = ?, completed_at = ?
      WHERE id = ?
    `).bind(
      cursorDate, status, units.length, stored, empty, failed, batchId, stored, nowIso,
      retryCount, throttledMs, nowIso, finished ? nowIso : null, job.id,
    ));
  } else {
    statements.push(d1.prepare(`
      UPDATE backfill_jobs SET
        status = ?, stored_rows = stored_rows + ?, last_batch_id = ?,
        last_batch_rows = ?, last_checkpoint_at = ?, api_retry_count = api_retry_count + ?,
        throttled_ms = throttled_ms + ?, updated_at = ? WHERE id = ?
    `).bind(status, stored, batchId, stored, nowIso, retryCount, throttledMs, nowIso, job.id));
  }
  statements.push(d1.prepare(`
    UPDATE backfill_runner SET lease_until = ?, last_heartbeat_at = ?,
      completed_units = completed_units + ?, checkpoint_status = ?
    WHERE id = 1 AND lease_token = ?
  `).bind(new Date(now.getTime() + SERVER_BATCH.leaseMs).toISOString(), nowIso, units.length, blocked ? "blocked" : "saved", token));

  const started = performance.now();
  await d1.batch(statements);
  return { stored, dbWriteMs: performance.now() - started, status };
}

async function retryOneFailure(job: JobRow, batchId: string, token: string, profile: BatchProfile) {
  const d1 = await getRawDb();
  const failure = await d1.prepare(`
    SELECT id, market, trading_date AS tradingDate
    FROM backfill_failures WHERE backfill_job_id = ? AND status = 'open'
    ORDER BY trading_date DESC, market LIMIT 1
  `).bind(job.id).first<FailureRow>();
  if (!failure) {
    const now = new Date().toISOString();
    await d1.prepare("UPDATE backfill_jobs SET status = 'complete', failed_units = 0, updated_at = ?, completed_at = ? WHERE id = ?")
      .bind(now, now, job.id).run();
    return;
  }
  const unit = await fetchUnit(failure.market, failure.tradingDate);
  mergeProfile(profile, unit);
  if (unit.error) {
    const now = new Date().toISOString();
    await d1.batch([
      d1.prepare("UPDATE backfill_failures SET error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .bind(unit.error.slice(0, 500), now, failure.id),
      d1.prepare("UPDATE backfill_runner SET last_heartbeat_at = ?, checkpoint_status = 'retry_failed' WHERE id = 1 AND lease_token = ?")
        .bind(now, token),
    ]);
    return;
  }
  const retriedJob = { ...job, cursorDate: failure.tradingDate, cursorMarket: failure.market };
  const write = await writeDateTransaction(retriedJob, batchId, token, [unit], false);
  profile.rowsWritten += write.stored;
  profile.dbWriteMs += write.dbWriteMs;
  const now = new Date().toISOString();
  await d1.batch([
    d1.prepare("UPDATE backfill_failures SET status = 'resolved', updated_at = ? WHERE id = ?").bind(now, failure.id),
    d1.prepare("UPDATE backfill_jobs SET failed_units = max(failed_units - 1, 0), status = 'complete_with_gaps', updated_at = ? WHERE id = ?")
      .bind(now, job.id),
  ]);
}

async function finishBatch(token: string, batchId: string, startedAtMs: number, profile: BatchProfile, error: string | null) {
  const d1 = await getRawDb();
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(1, Math.round(performance.now() - startedAtMs));
  const recentRowsPerSecond = profile.rowsWritten / (durationMs / 1_000);
  const workerWaitMs = Math.max(0, durationMs - profile.networkMs - profile.parseMs - profile.dbWriteMs);
  await d1.batch([
    d1.prepare(`
      UPDATE backfill_batches SET finished_at = ?, status = ?, completed_units = ?,
        rows_fetched = ?, rows_written = ?, network_ms = ?, parse_ms = ?, db_write_ms = ?,
        api_retry_count = ?, throttled_ms = ?, worker_wait_ms = ?, error = ? WHERE batch_id = ?
    `).bind(
      finishedAt, error ? "error" : "complete", profile.completedUnits, profile.rowsFetched, profile.rowsWritten,
      Math.round(profile.networkMs), Math.round(profile.parseMs), Math.round(profile.dbWriteMs),
      profile.apiRetryCount, Math.round(profile.throttledMs), Math.round(workerWaitMs), error?.slice(0, 500) ?? null, batchId,
    ),
    d1.prepare(`
      UPDATE backfill_runner SET status = ?, lease_token = NULL, lease_until = NULL,
        last_finished_at = ?, last_heartbeat_at = ?, completed_batches = completed_batches + 1,
        active_runtime_ms = active_runtime_ms + ?, last_batch_rows = ?, last_batch_duration_ms = ?,
        recent_rows_per_second = ?, api_retry_count = api_retry_count + ?, throttled_ms = throttled_ms + ?,
        network_ms = network_ms + ?, parse_ms = parse_ms + ?, db_write_ms = db_write_ms + ?,
        worker_wait_ms = worker_wait_ms + ?, rate_limited = ?, checkpoint_status = ?, last_error = ?
      WHERE id = 1 AND lease_token = ?
    `).bind(
      error ? "error" : "idle", finishedAt, finishedAt, durationMs, profile.rowsWritten, durationMs,
      recentRowsPerSecond, profile.apiRetryCount, Math.round(profile.throttledMs), Math.round(profile.networkMs),
      Math.round(profile.parseMs), Math.round(profile.dbWriteMs), Math.round(workerWaitMs), profile.rateLimited ? 1 : 0,
      error ? "error" : "saved", error?.slice(0, 500) ?? null, token,
    ),
  ]);
}

async function runServerBatch(maxTradingDates = SERVER_BATCH.maxTradingDates, triggerSource: "scheduled" | "manual" = "manual") {
  const existingJob = await latestJob();
  if (existingJob && ["complete", "blocked_bias_violation"].includes(existingJob.status)) return;
  const token = globalThis.crypto.randomUUID();
  if (!(await acquireRunnerLease(token, triggerSource))) return;
  const batchId = globalThis.crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const deadline = Date.now() + SERVER_BATCH.maxRuntimeMs;
  const profile = emptyBatchProfile();
  let batchError: string | null = null;
  let job = await latestJob();
  if (!job) job = await createJob();
  job = await alignJobWithPolicy(job);
  const d1 = await getRawDb();
  await d1.prepare(`INSERT INTO backfill_batches (batch_id, backfill_job_id, started_at, status) VALUES (?, ?, ?, 'running')`)
    .bind(batchId, job.id, startedAt).run();

  try {
    let completedDates = 0;
    while (completedDates < maxTradingDates && Date.now() < deadline) {
      job = await latestJob() ?? job;
      if (job.status === "running") {
        const units = await Promise.all(unitsAtCursor(job).map((market) => fetchUnit(market, job.cursorDate)));
        for (const unit of units) mergeProfile(profile, unit);
        const write = await writeDateTransaction(job, batchId, token, units);
        profile.rowsWritten += write.stored;
        profile.dbWriteMs += write.dbWriteMs;
        completedDates += 1;
        if (write.status === "blocked_bias_violation") break;
      } else if (job.status === "complete_with_gaps") {
        await retryOneFailure(job, batchId, token, profile);
        completedDates += 1;
      } else break;
    }
  } catch (error) {
    batchError = error instanceof Error ? error.message : "Unknown server runner error";
  } finally {
    await finishBatch(token, batchId, startedAtMs, profile, batchError);
  }
}

function estimateTotalRows(job: JobRow) {
  const successfulUnits = Math.max(1, job.processedUnits - job.emptyUnits - job.failedUnits);
  const observedAverage = job.storedRows / successfulUnits;
  const blendedAverage = job.failedUnits > successfulUnits ? (observedAverage + 850) / 2 : observedAverage;
  return Math.max(job.storedRows, Math.round(blendedAverage * weekdayMarketUnits(job.targetStart, job.targetEnd)));
}

async function healthPayload() {
  const healthStarted = performance.now();
  const d1 = await getRawDb();
  const job = await latestJob();
  const [audits, openFailures, runner, securities] = await Promise.all([
    d1.prepare(`
      SELECT audit_type AS auditType,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN status != 'pass' THEN 1 ELSE 0 END) AS blocked,
        SUM(violations) AS violations FROM bias_audits GROUP BY audit_type
    `).all<{ auditType: string; passed: number; blocked: number; violations: number }>(),
    d1.prepare("SELECT count(*) AS count FROM backfill_failures WHERE status = 'open'").first<{ count: number }>(),
    runnerState(),
    d1.prepare("SELECT count(*) AS count, min(first_seen) AS earliestDate, max(last_seen) AS latestDate FROM historical_securities")
      .first<{ count: number; earliestDate: string | null; latestDate: string | null }>(),
  ]);
  const estimatedTotalRows = job ? estimateTotalRows(job) : 0;
  const activeRuntimeMs = runner?.activeRuntimeMs ?? 0;
  const averageRowsPerSecond = job && activeRuntimeMs > 0 ? job.storedRows / (activeRuntimeMs / 1_000) : 0;
  const recentRowsPerSecond = runner?.recentRowsPerSecond ?? 0;
  const etaRate = recentRowsPerSecond > 0 ? recentRowsPerSecond : averageRowsPerSecond;
  const etaSeconds = job && etaRate > 0 ? Math.max(0, (estimatedTotalRows - job.storedRows) / etaRate) : null;
  return {
    status: job?.status ?? "not_started",
    job: job ? { ...job, estimatedTotalRows } : null,
    progress: job ? Math.min(100, Number(((job.processedUnits / Math.max(job.totalUnits, 1)) * 100).toFixed(2))) : 0,
    rowProgress: job ? Math.min(100, Number(((job.storedRows / Math.max(estimatedTotalRows, 1)) * 100).toFixed(2))) : 0,
    performance: {
      recentRowsPerSecond, averageRowsPerSecond, activeRuntimeMs, etaSeconds,
      abnormal: etaSeconds !== null && etaSeconds > 86_400,
      apiRetryCount: runner?.apiRetryCount ?? 0, throttledMs: runner?.throttledMs ?? 0,
      rateLimited: Boolean(runner?.rateLimited), networkMs: runner?.networkMs ?? 0,
      parseMs: runner?.parseMs ?? 0, dbWriteMs: runner?.dbWriteMs ?? 0,
      workerWaitMs: runner?.workerWaitMs ?? 0, featureMs: 0,
      healthQueryMs: Math.round(performance.now() - healthStarted),
    },
    currentStage: "下載原始行情 → 正規化 → 驗證 → 批次寫入",
    nextStages: ["資料清洗／公司事件／除權息", "Feature Engineering", "Walk-Forward 樣本外回測", "機率校準", "解鎖研究候選"],
    audits: audits.results, openFailures: openFailures?.count ?? 0,
    historicalRows: job?.storedRows ?? 0, stockCount: securities?.count ?? 0,
    earliestDate: securities?.earliestDate ?? null, latestDate: securities?.latestDate ?? null,
    runner: runner ?? null, serverBatch: SERVER_BATCH, policy: BACKFILL_POLICY,
  };
}

export async function GET() {
  try {
    return Response.json(await healthPayload(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable", job: null, progress: 0, rowProgress: 0, audits: [], openFailures: 0, runner: null, serverBatch: SERVER_BATCH, policy: BACKFILL_POLICY }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const scheduled = request.headers.get("x-wall-backfill-trigger") === "scheduled";
    if (scheduled) {
      await runServerBatch(SERVER_BATCH.maxTradingDates, "scheduled");
      return Response.json({ accepted: true, mode: "scheduled", ...(await healthPayload()) }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    const executionContext = getRequestExecutionContext();
    if (executionContext) {
      executionContext.waitUntil(runServerBatch(SERVER_BATCH.maxTradingDates, "manual"));
      return Response.json({ accepted: true, mode: "server_background", ...(await healthPayload()) }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    await runServerBatch(1, "manual");
    return Response.json({ accepted: true, mode: "server_foreground_fallback", ...(await healthPayload()) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable", error: "回填資料庫尚未就緒，這次沒有寫入任何資料", policy: BACKFILL_POLICY }, { status: 503 });
  }
}
