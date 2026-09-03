import { searchOfficialStocks } from "../../../lib/official-data";
import { operationalStockSearch } from "../../../lib/operational-read";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ stocks: [], error: "請輸入股票代號或名稱" }, { status: 400 });
  try {
    const operational = await operationalStockSearch(query);
    if (operational) return Response.json(operational, { headers: { "Cache-Control": "public, max-age=120" } });
    return Response.json({ stocks: await searchOfficialStocks(query), fetchedAt: new Date().toISOString() }, { headers: { "Cache-Control": "public, max-age=120", "X-Data-Mode": "bootstrap-fallback" } });
  }
  catch { return Response.json({ stocks: [], fetchedAt: new Date().toISOString() }); }
}
