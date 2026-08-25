import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { watchlist } from "../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get("owner")?.trim() ?? "";
  if (!owner) return Response.json({ codes: [] });
  try {
    const db = await getDb();
    const rows = await db.select({ code: watchlist.code }).from(watchlist).where(eq(watchlist.ownerKey, owner));
    return Response.json({ codes: rows.map((row) => row.code) });
  } catch { return Response.json({ codes: [] }); }
}

export async function POST(request: Request) {
  const body = (await request.json()) as { owner?: string; code?: string; market?: string };
  const owner = body.owner?.trim() ?? "";
  const code = body.code?.trim() ?? "";
  const market = body.market?.trim() ?? "";
  if (!owner || !code || !market) return Response.json({ error: "missing fields" }, { status: 400 });
  try {
    const db = await getDb();
    await db.insert(watchlist).values({ ownerKey: owner, code, market, createdAt: new Date().toISOString() }).onConflictDoNothing();
    return Response.json({ ok: true });
  } catch { return Response.json({ ok: false }, { status: 503 }); }
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { owner?: string; code?: string };
  const owner = body.owner?.trim() ?? "";
  const code = body.code?.trim() ?? "";
  if (!owner || !code) return Response.json({ error: "missing fields" }, { status: 400 });
  try {
    const db = await getDb();
    await db.delete(watchlist).where(and(eq(watchlist.ownerKey, owner), eq(watchlist.code, code)));
    return Response.json({ ok: true });
  } catch { return Response.json({ ok: false }, { status: 503 }); }
}
