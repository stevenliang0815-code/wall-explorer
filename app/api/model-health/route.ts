import { desc, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { modelRuns, stockSnapshots } from "../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    const [summary] = await db.select({
      historicalRows: sql<number>`count(*)`,
      stockCount: sql<number>`count(distinct ${stockSnapshots.market} || ':' || ${stockSnapshots.code})`,
      earliestDate: sql<string | null>`min(${stockSnapshots.tradingDate})`,
      latestDate: sql<string | null>`max(${stockSnapshots.tradingDate})`,
    }).from(stockSnapshots);
    const runs = await db.select().from(modelRuns).orderBy(desc(modelRuns.createdAt)).limit(3);
    return Response.json({ status: "collecting", ...summary, modelRuns: runs });
  } catch {
    return Response.json({ status: "not_started", historicalRows: 0, stockCount: 0, earliestDate: null, latestDate: null, modelRuns: [] });
  }
}
