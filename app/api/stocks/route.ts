import { searchOfficialStocks } from "../../../lib/official-data";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ stocks: [], error: "請輸入股票代號或名稱" }, { status: 400 });
  try { return Response.json({ stocks: await searchOfficialStocks(query), fetchedAt: new Date().toISOString() }, { headers: { "Cache-Control": "public, max-age=120" } }); }
  catch { return Response.json({ stocks: [], fetchedAt: new Date().toISOString() }); }
}
