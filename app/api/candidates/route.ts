import { fetchMarketPulse, fetchOfficialStocks, rankDailyCandidates, type NormalizedStock } from "../../../lib/official-data";
import { getDb } from "../../../db";
import { stockSnapshots } from "../../../db/schema";

export const dynamic = "force-dynamic";

async function archive(stocks: NormalizedStock[], tradingDate: string | null) {
  if (!tradingDate || !stocks.length) return;
  try {
    const db = await getDb();
    const rows = stocks.filter((stock) => /^\d{4}$/.test(stock.code)).map((stock) => ({
      market: stock.market, code: stock.code, name: stock.name, tradingDate,
      open: stock.open ?? null, high: stock.high ?? null, low: stock.low ?? null,
      close: stock.close, change: stock.change, volume: stock.volume,
      tradeValue: stock.tradeValue ?? null, source: stock.sourceUrl, fetchedAt: new Date().toISOString(),
    }));
    for (let index = 0; index < rows.length; index += 40) {
      await db.insert(stockSnapshots).values(rows.slice(index, index + 40)).onConflictDoNothing();
    }
  } catch {
    // The research list remains usable when archival storage is temporarily unavailable.
  }
}

export async function GET() {
  try {
    const [stocks, pulse] = await Promise.all([fetchOfficialStocks(), fetchMarketPulse()]);
    const candidates = rankDailyCandidates(stocks);
    await archive(stocks, pulse.tradingDate);
    return Response.json({
      status: "official",
      layer: "v1_rule_engine",
      tradingDate: pulse.tradingDate,
      fetchedAt: new Date().toISOString(),
      candidates,
      disclosure: "每日研究候選使用官方當日價量及公開規則，不是已校準的漲跌預測。",
    }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch {
    return Response.json({ status: "unavailable", layer: "v1_rule_engine", tradingDate: null, fetchedAt: new Date().toISOString(), candidates: [], disclosure: "官方資料不足，因此今日不產生候選。" });
  }
}
