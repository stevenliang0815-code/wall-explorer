import { rankDailyCandidates } from "../../../lib/official-data";
import { operationalCandidateStocks } from "../../../lib/operational-read";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const operational = await operationalCandidateStocks();
    if (operational) {
      return Response.json({
        status: "official",
        layer: "v1_rule_engine",
        dataMode: "operational_db",
        tradingDate: operational.tradingDate,
        fetchedAt: operational.fetchedAt,
        freshnessStatus: operational.freshnessStatus,
        candidates: rankDailyCandidates(operational.stocks),
        disclosure: "每日研究候選讀取 operational DB 的官方最新價量及公開規則，不是已校準的漲跌預測。",
      }, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    return Response.json({ status: "operational_unavailable", layer: "v1_rule_engine", dataMode: "operational_db",
      tradingDate: null, fetchedAt: new Date().toISOString(), candidates: [],
      disclosure: "Operational DB 暫時無法讀取，因此今日不產生候選。" }, { status: 503 });
  } catch {
    return Response.json({ status: "operational_unavailable", layer: "v1_rule_engine", dataMode: "operational_db", tradingDate: null,
      fetchedAt: new Date().toISOString(), candidates: [], disclosure: "Operational DB 暫時無法讀取，因此今日不產生候選。" }, { status: 503 });
  }
}
