import { fetchMarketPulse, TWSE_INDEX_URL } from "../../../lib/official-data";
import { operationalMarketPulse } from "../../../lib/operational-read";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const operational = await operationalMarketPulse();
    if (operational) return Response.json(operational, { headers: { "Cache-Control": "public, max-age=120" } });
    return Response.json(await fetchMarketPulse(), { headers: { "Cache-Control": "public, max-age=120", "X-Data-Mode": "bootstrap-fallback" } });
  }
  catch { return Response.json({ indexName: "發行量加權股價指數", close: null, change: null, changePercent: null, tradingDate: null, fetchedAt: new Date().toISOString(), status: "unavailable", sourceUrl: TWSE_INDEX_URL }); }
}
