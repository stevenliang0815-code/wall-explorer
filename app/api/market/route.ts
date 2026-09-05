import { operationalMarketPulse } from "../../../lib/operational-read";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const operational = await operationalMarketPulse();
    if (operational) return Response.json(operational, { headers: { "Cache-Control": "public, max-age=120" } });
    return Response.json({ status: "operational_unavailable", error: "Operational DB is not available" }, { status: 503 });
  }
  catch { return Response.json({ status: "operational_unavailable", error: "Operational DB is not available" }, { status: 503 }); }
}
