import { getRawDb } from "../../../db";
import {
  auditBiasGuards,
  BACKFILL_POLICY,
  fetchHistoricalMarketDay,
  historicalSourceUrl,
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
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type FailureRow = { id: number; market: HistoricalMarket; tradingDate: string };

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

async function latestJob() {
  const d1 = await getRawDb();
  return await d1.prepare(`
    SELECT id, version, target_start AS targetStart, target_end AS targetEnd,
      cursor_date AS cursorDate, cursor_market AS cursorMarket, status,
      processed_units AS processedUnits, total_units AS totalUnits,
      stored_rows AS storedRows, empty_units AS emptyUnits, failed_units AS failedUnits,
      started_at AS startedAt, updated_at AS updatedAt, completed_at AS completedAt
    FROM backfill_jobs ORDER BY id DESC LIMIT 1
  `).first<JobRow>();
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
      started_at, updated_at
    ) VALUES (?, ?, ?, ?, '上市', 'running', 0, ?, 0, 0, 0, ?, ?)
  `).bind(BACKFILL_POLICY.version, BACKFILL_POLICY.targetStart, targetEnd, targetEnd, totalUnits, now, now).run();
  const job = await latestJob();
  if (!job) throw new Error("Backfill job could not be created");
  return job;
}

async function alignJobWithPolicy(job: JobRow) {
  if (job.targetStart <= BACKFILL_POLICY.targetStart) return job;
  const d1 = await getRawDb();
  const additionalUnits = calendarDays(BACKFILL_POLICY.targetStart, dayBefore(job.targetStart)) * 2;
  await d1.prepare(`
    UPDATE backfill_jobs SET
      target_start = ?,
      total_units = total_units + ?,
      status = 'running',
      completed_at = NULL,
      updated_at = ?
    WHERE id = ?
  `).bind(BACKFILL_POLICY.targetStart, additionalUnits, new Date().toISOString(), job.id).run();
  return await latestJob() ?? job;
}

function nextCursor(job: JobRow) {
  if (job.cursorMarket === "上市") return { date: job.cursorDate, market: "上櫃" as const };
  return { date: dayBefore(job.cursorDate), market: "上市" as const };
}

async function storeObservations(job: JobRow, observations: HistoricalObservation[]) {
  if (!observations.length) return;
  const d1 = await getRawDb();
  const ingestedAt = new Date().toISOString();
  const statements = observations.map((row) => d1.prepare(`
    INSERT INTO historical_observations (
      market, code, name, trading_date, security_type, universe_status,
      open, high, low, close, change, volume, trade_value, source,
      source_scope, usable_from, ingested_at, backfill_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market, code, trading_date) DO UPDATE SET
      name = excluded.name,
      security_type = excluded.security_type,
      universe_status = excluded.universe_status,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      change = excluded.change,
      volume = excluded.volume,
      trade_value = excluded.trade_value,
      source = excluded.source,
      source_scope = excluded.source_scope,
      usable_from = excluded.usable_from,
      ingested_at = excluded.ingested_at,
      backfill_job_id = excluded.backfill_job_id
  `).bind(
    row.market, row.code, row.name, row.tradingDate, row.securityType, row.universeStatus,
    row.open, row.high, row.low, row.close, row.change, row.volume, row.tradeValue,
    row.source, row.sourceScope, row.usableFrom, ingestedAt, job.id,
  ));

  for (let index = 0; index < statements.length; index += 50) {
    await d1.batch(statements.slice(index, index + 50));
  }
}

async function storeAudits(job: JobRow, market: HistoricalMarket, tradingDate: string, observations: HistoricalObservation[]) {
  const d1 = await getRawDb();
  const checkedAt = new Date().toISOString();
  const audits = auditBiasGuards(observations, tradingDate);
  const rows = [
    ["survivorship", audits.survivorship.status, audits.survivorship.violations, audits.survivorship.rule],
    ["lookahead", audits.lookAhead.status, audits.lookAhead.violations, audits.lookAhead.rule],
  ] as const;
  await d1.batch(rows.map(([type, status, violations, rule]) => d1.prepare(`
    INSERT INTO bias_audits (
      backfill_job_id, market, trading_date, audit_type, status,
      checked_rows, violations, rule, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(backfill_job_id, market, trading_date, audit_type) DO UPDATE SET
      status = excluded.status,
      checked_rows = excluded.checked_rows,
      violations = excluded.violations,
      rule = excluded.rule,
      checked_at = excluded.checked_at
  `).bind(job.id, market, tradingDate, type, status, observations.length, violations, rule, checkedAt)));
  return audits;
}

async function recordFailure(job: JobRow, market: HistoricalMarket, tradingDate: string, error: string) {
  const d1 = await getRawDb();
  const now = new Date().toISOString();
  await d1.prepare(`
    INSERT INTO backfill_failures (
      backfill_job_id, market, trading_date, source, error, attempts, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'open', ?, ?)
    ON CONFLICT(backfill_job_id, market, trading_date) DO UPDATE SET
      error = excluded.error,
      attempts = backfill_failures.attempts + 1,
      status = 'open',
      updated_at = excluded.updated_at
  `).bind(job.id, market, tradingDate, historicalSourceUrl(market, tradingDate), error.slice(0, 500), now, now).run();
}

async function updateJob(job: JobRow, counts: { stored: number; empty: number; failed: number }, forceStatus?: string) {
  const d1 = await getRawDb();
  const cursor = nextCursor(job);
  const finished = cursor.date < job.targetStart;
  const failedTotal = job.failedUnits + counts.failed;
  const status = forceStatus ?? (finished ? (failedTotal ? "complete_with_gaps" : "complete") : "running");
  const now = new Date().toISOString();
  await d1.prepare(`
    UPDATE backfill_jobs SET
      cursor_date = ?, cursor_market = ?, status = ?,
      processed_units = processed_units + 1,
      stored_rows = stored_rows + ?, empty_units = empty_units + ?, failed_units = failed_units + ?,
      updated_at = ?, completed_at = ?
    WHERE id = ?
  `).bind(cursor.date, cursor.market, status, counts.stored, counts.empty, counts.failed, now, finished ? now : null, job.id).run();
}

async function runOneUnit(job: JobRow) {
  try {
    const result = await fetchHistoricalMarketDay(job.cursorMarket, job.cursorDate);
    if (!result.observations.length) {
      await updateJob(job, { stored: 0, empty: 1, failed: 0 });
      return;
    }
    const audits = await storeAudits(job, job.cursorMarket, job.cursorDate, result.observations);
    if (audits.survivorship.status !== "pass" || audits.lookAhead.status !== "pass") {
      await updateJob(job, { stored: 0, empty: 0, failed: 0 }, "blocked_bias_violation");
      return;
    }
    await storeObservations(job, result.observations);
    await updateJob(job, { stored: result.observations.length, empty: 0, failed: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown backfill error";
    await recordFailure(job, job.cursorMarket, job.cursorDate, message);
    await updateJob(job, { stored: 0, empty: 0, failed: 1 });
  }
}

async function retryOneFailure(job: JobRow) {
  const d1 = await getRawDb();
  const failure = await d1.prepare(`
    SELECT id, market, trading_date AS tradingDate
    FROM backfill_failures
    WHERE backfill_job_id = ? AND status = 'open'
    ORDER BY trading_date DESC, market LIMIT 1
  `).bind(job.id).first<FailureRow>();
  if (!failure) {
    const now = new Date().toISOString();
    await d1.prepare("UPDATE backfill_jobs SET status = 'complete', failed_units = 0, updated_at = ?, completed_at = ? WHERE id = ?")
      .bind(now, now, job.id).run();
    return;
  }

  try {
    const result = await fetchHistoricalMarketDay(failure.market, failure.tradingDate);
    if (result.observations.length) {
      const audits = await storeAudits(job, failure.market, failure.tradingDate, result.observations);
      if (audits.survivorship.status !== "pass" || audits.lookAhead.status !== "pass") {
        await d1.prepare("UPDATE backfill_jobs SET status = 'blocked_bias_violation', updated_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), job.id).run();
        return;
      }
      await storeObservations(job, result.observations);
    }
    const now = new Date().toISOString();
    await d1.batch([
      d1.prepare("UPDATE backfill_failures SET status = 'resolved', updated_at = ? WHERE id = ?").bind(now, failure.id),
      d1.prepare(`
        UPDATE backfill_jobs SET
          stored_rows = stored_rows + ?,
          failed_units = max(failed_units - 1, 0),
          updated_at = ?
        WHERE id = ?
      `).bind(result.observations.length, now, job.id),
    ]);
    const remaining = await d1.prepare("SELECT count(*) AS count FROM backfill_failures WHERE backfill_job_id = ? AND status = 'open'")
      .bind(job.id).first<{ count: number }>();
    if ((remaining?.count ?? 0) === 0) {
      await d1.prepare("UPDATE backfill_jobs SET status = 'complete', completed_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, job.id).run();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown retry error";
    await recordFailure(job, failure.market, failure.tradingDate, message);
  }
}

async function healthPayload() {
  const d1 = await getRawDb();
  const job = await latestJob();
  const audits = await d1.prepare(`
    SELECT audit_type AS auditType,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status != 'pass' THEN 1 ELSE 0 END) AS blocked,
      SUM(violations) AS violations
    FROM bias_audits GROUP BY audit_type
  `).all<{ auditType: string; passed: number; blocked: number; violations: number }>();
  const openFailures = await d1.prepare("SELECT count(*) AS count FROM backfill_failures WHERE status = 'open'").first<{ count: number }>();
  return {
    status: job?.status ?? "not_started",
    job,
    progress: job ? Math.min(100, Number(((job.processedUnits / Math.max(job.totalUnits, 1)) * 100).toFixed(2))) : 0,
    audits: audits.results,
    openFailures: openFailures?.count ?? 0,
    policy: BACKFILL_POLICY,
  };
}

export async function GET() {
  try {
    return Response.json(await healthPayload(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable", job: null, progress: 0, audits: [], openFailures: 0, policy: BACKFILL_POLICY }, { status: 503 });
  }
}

export async function POST() {
  try {
    let job = await latestJob();
    if (!job) job = await createJob();
    job = await alignJobWithPolicy(job);
    if (job.status === "running") await runOneUnit(job);
    else if (job.status === "complete_with_gaps") await retryOneFailure(job);
    return Response.json(await healthPayload(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("Official historical source")
      ? "官方歷史資料來源暫時無法取得"
      : "回填資料庫尚未就緒，這次沒有寫入任何資料";
    return Response.json({ status: "unavailable", error: message, policy: BACKFILL_POLICY }, { status: 503 });
  }
}
