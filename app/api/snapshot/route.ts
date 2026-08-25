import { getRawDb } from "../../../db";
import { sha256Hex, snapshotAssetUrl, validateSnapshotManifest, validateSnapshotRows } from "../../../lib/historical-snapshot";
import type { HistoricalObservation } from "../../../lib/historical-data";

export const dynamic = "force-dynamic";

type ImportRow = {
  snapshotVersion: string; manifestUrl: string; cutoffDate: string; status: string;
  expectedRows: number; importedRows: number; nextChunk: number; totalChunks: number;
  sqliteSha256: string; lastError: string | null; startedAt: string; updatedAt: string; completedAt: string | null;
};

function configuredManifestUrl() {
  return import("cloudflare:workers").then(({ env }) => {
    const value = (env as Record<string, unknown>).HISTORICAL_SNAPSHOT_MANIFEST_URL;
    return typeof value === "string" && value ? value : null;
  });
}

async function currentImport() {
  const d1 = await getRawDb();
  return await d1.prepare(`SELECT snapshot_version AS snapshotVersion,manifest_url AS manifestUrl,cutoff_date AS cutoffDate,status,
    expected_rows AS expectedRows,imported_rows AS importedRows,next_chunk AS nextChunk,total_chunks AS totalChunks,
    sqlite_sha256 AS sqliteSha256,last_error AS lastError,started_at AS startedAt,updated_at AS updatedAt,completed_at AS completedAt
    FROM historical_snapshot_imports WHERE id=1`).first<ImportRow>();
}

function chunkPayloads(rows: HistoricalObservation[], targetBytes = 700_000) {
  const chunks: string[] = [];
  let current: HistoricalObservation[] = [];
  let bytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    if (current.length && bytes + encoded.length + 1 > targetBytes) {
      chunks.push(JSON.stringify(current)); current = []; bytes = 2;
    }
    current.push(row); bytes += encoded.length + 1;
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}

function observationUpsert(d1: D1Database, payload: string, ingestedAt: string) {
  return d1.prepare(`INSERT INTO historical_observations (
    market,code,name,trading_date,security_type,universe_status,open,high,low,close,change,volume,trade_value,
    source,source_scope,usable_from,ingested_at,backfill_job_id)
    SELECT json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),
      json_extract(value,'$.tradingDate'),json_extract(value,'$.securityType'),json_extract(value,'$.universeStatus'),
      json_extract(value,'$.open'),json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),
      json_extract(value,'$.change'),json_extract(value,'$.volume'),json_extract(value,'$.tradeValue'),
      json_extract(value,'$.source'),json_extract(value,'$.sourceScope'),json_extract(value,'$.usableFrom'),?,0
    FROM json_each(?) WHERE 1
    ON CONFLICT(market,code,trading_date) DO UPDATE SET name=excluded.name,security_type=excluded.security_type,
      universe_status=excluded.universe_status,open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
      change=excluded.change,volume=excluded.volume,trade_value=excluded.trade_value,source=excluded.source,
      source_scope=excluded.source_scope,usable_from=excluded.usable_from,ingested_at=excluded.ingested_at`)
    .bind(ingestedAt, payload);
}

function securityUpsert(d1: D1Database, payload: string) {
  return d1.prepare(`INSERT INTO historical_securities (market,code,name,security_type,first_seen,last_seen)
    SELECT json_extract(value,'$.market'),json_extract(value,'$.code'),json_extract(value,'$.name'),json_extract(value,'$.securityType'),
      json_extract(value,'$.tradingDate'),json_extract(value,'$.tradingDate') FROM json_each(?) WHERE 1
    ON CONFLICT(market,code) DO UPDATE SET name=excluded.name,security_type=excluded.security_type,
      first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen)`).bind(payload);
}

async function loadManifest(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Snapshot manifest returned ${response.status}`);
  return validateSnapshotManifest(await response.json());
}

async function decompressJson(bytes: Uint8Array) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as unknown;
}

export async function GET() {
  try {
    const [state, manifestUrl] = await Promise.all([currentImport(), configuredManifestUrl()]);
    return Response.json({ mode: "snapshot_first", configured: Boolean(manifestUrl), status: state?.status ?? (manifestUrl ? "ready" : "awaiting_snapshot_publish"), ...(state ?? {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ mode: "snapshot_first", configured: false, status: "unavailable" }, { status: 503 });
  }
}

export async function POST() {
  const manifestUrl = await configuredManifestUrl();
  if (!manifestUrl) return Response.json({ status: "awaiting_snapshot_publish", error: "Historical Snapshot尚未發布；Web App不會退回瀏覽器長時間回填。" }, { status: 409 });
  try {
    const manifest = await loadManifest(manifestUrl);
    const d1 = await getRawDb();
    const now = new Date().toISOString();
    let state = await currentImport();
    if (!state || state.snapshotVersion !== manifest.snapshotVersion) {
      await d1.prepare(`INSERT INTO historical_snapshot_imports (id,snapshot_version,manifest_url,cutoff_date,status,expected_rows,imported_rows,next_chunk,total_chunks,sqlite_sha256,started_at,updated_at)
        VALUES (1,?,?,?,'importing',?,0,0,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET snapshot_version=excluded.snapshot_version,manifest_url=excluded.manifest_url,cutoff_date=excluded.cutoff_date,
          status='importing',expected_rows=excluded.expected_rows,imported_rows=0,next_chunk=0,total_chunks=excluded.total_chunks,
          sqlite_sha256=excluded.sqlite_sha256,last_error=NULL,started_at=excluded.started_at,updated_at=excluded.updated_at,completed_at=NULL`)
        .bind(manifest.snapshotVersion,manifestUrl,manifest.cutoffDate,manifest.rowCount,manifest.chunks.length,manifest.sqlite.sha256,now,now).run();
      state = await currentImport();
    }
    if (!state) throw new Error("Snapshot import state could not be initialized");
    if (state.status === "complete") return Response.json({ ...state, mode: "snapshot_first" });
    const chunk = manifest.chunks[state.nextChunk];
    if (!chunk) throw new Error("Snapshot checkpoint points beyond the manifest");
    const response = await fetch(snapshotAssetUrl(manifestUrl, chunk.path), { signal: AbortSignal.timeout(30_000), cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot chunk returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (await sha256Hex(bytes) !== chunk.sha256) throw new Error("Snapshot chunk checksum mismatch");
    const rows = validateSnapshotRows(await decompressJson(bytes), manifest.cutoffDate);
    if (rows.length !== chunk.rows) throw new Error("Snapshot chunk row count mismatch");
    const statements: D1PreparedStatement[] = [];
    for (const payload of chunkPayloads(rows)) {
      statements.push(observationUpsert(d1, payload, now), securityUpsert(d1, payload));
    }
    const nextChunk = state.nextChunk + 1;
    const finished = nextChunk >= manifest.chunks.length;
    statements.push(d1.prepare(`INSERT INTO historical_snapshot_chunks (snapshot_version,chunk_index,status,rows_written,sha256,imported_at)
      VALUES (?,?,'complete',?,?,?) ON CONFLICT(snapshot_version,chunk_index) DO UPDATE SET status='complete',rows_written=excluded.rows_written,sha256=excluded.sha256,imported_at=excluded.imported_at`)
      .bind(manifest.snapshotVersion,chunk.index,rows.length,chunk.sha256,now));
    statements.push(d1.prepare(`UPDATE historical_snapshot_imports SET status=?,imported_rows=imported_rows+?,next_chunk=?,last_error=NULL,updated_at=?,completed_at=? WHERE id=1`)
      .bind(finished ? "complete" : "importing",rows.length,nextChunk,now,finished ? now : null));
    await d1.batch(statements);
    if (finished) {
      const actual = await d1.prepare("SELECT count(*) count FROM historical_observations WHERE trading_date<=?").bind(manifest.cutoffDate).first<{ count: number }>();
      if ((actual?.count ?? 0) < manifest.rowCount) throw new Error("Imported snapshot did not reach its validated row count");
      await d1.prepare("UPDATE backfill_jobs SET status='complete',phase='daily_incremental',updated_at=?,completed_at=coalesce(completed_at,?) WHERE id=(SELECT max(id) FROM backfill_jobs)").bind(now,now).run();
    }
    return Response.json({ ...(await currentImport()), mode: "snapshot_first" }, { status: finished ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown snapshot import error";
    try { const d1 = await getRawDb(); await d1.prepare("UPDATE historical_snapshot_imports SET status='error',last_error=?,updated_at=? WHERE id=1").bind(message.slice(0,500),new Date().toISOString()).run(); } catch { /* Preserve the original error. */ }
    return Response.json({ status: "error", error: message }, { status: 503 });
  }
}
