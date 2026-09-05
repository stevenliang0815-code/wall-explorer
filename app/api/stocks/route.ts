import { operationalStockSearch } from "../../../lib/operational-read";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ stocks: [], error: "請輸入股票代號或名稱" }, { status: 400 });
  try {
    const operational = await operationalStockSearch(query);
    if (operational) return Response.json(operational, { headers: { "Cache-Control": "public, max-age=120" } });
    return Response.json({ status: "operational_unavailable", stocks: [], error: "Operational DB is not available" }, { status: 503 });
  }
  catch { return Response.json({ status: "operational_unavailable", stocks: [], error: "Operational DB is not available" }, { status: 503 }); }
}
