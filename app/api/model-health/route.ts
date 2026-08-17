import { desc } from "drizzle-orm";
import { getDb, getRawDb } from "../../../db";
import { modelRuns } from "../../../db/schema";
import { BACKFILL_POLICY } from "../../../lib/historical-data";

export const dynamic = "force-dynamic";

type Summary = { historicalRows: number; stockCount: number; earliestDate: string | null; latestDate: string | null };
type BackfillJob = {
  id: number; status: string; targetStart: string; targetEnd: string; cursorDate: string; cursorMarket: string;
  processedUnits: number; totalUnits: number; storedRows: number; emptyUnits: number; failedUnits: number; updatedAt: string;
};

export async function GET() {
  try {
    const [db, d1] = await Promise.all([getDb(), getRawDb()]);
    const [summary, job, audits, failures, runs] = await Promise.all([
      d1.prepare(`
        SELECT count(*) AS historicalRows,
          count(distinct market || ':' || code) AS stockCount,
          min(trading_date) AS earliestDate,
          max(trading_date) AS latestDate
        FROM historical_observations
      `).first<Summary>(),
      d1.prepare(`
        SELECT id, status, target_start AS targetStart, target_end AS targetEnd,
          cursor_date AS cursorDate, cursor_market AS cursorMarket,
          processed_units AS processedUnits, total_units AS totalUnits,
          stored_rows AS storedRows, empty_units AS emptyUnits, failed_units AS failedUnits,
          updated_at AS updatedAt
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
    ]);
    const safeSummary = summary ?? { historicalRows: 0, stockCount: 0, earliestDate: null, latestDate: null };
    return Response.json({
      status: job?.status ?? "not_started",
      ...safeSummary,
      modelRuns: runs,
      backfill: job ? {
        ...job,
        progress: Math.min(100, Number(((job.processedUnits / Math.max(job.totalUnits, 1)) * 100).toFixed(2))),
        openFailures: failures?.count ?? 0,
        audits: audits.results,
      } : null,
      policy: BACKFILL_POLICY,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({
      status: "not_started", historicalRows: 0, stockCount: 0, earliestDate: null, latestDate: null,
      modelRuns: [], backfill: null, policy: BACKFILL_POLICY,
    });
  }
}
