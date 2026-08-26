import { getRawDb } from "../../../db";
import { getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

const EXPORT_FORMAT = "wall-explorer-legacy-d1-checkpoint-v1";
const PAGE_SIZE = 5_000;

type ExportTable = {
  name: string;
  key: string;
};

type ExportRow = Record<string, unknown>;
type RawDb = Awaited<ReturnType<typeof getRawDb>>;

const EXPORT_TABLES: ExportTable[] = [
  { name: "backfill_jobs", key: "id" },
  { name: "backfill_runner", key: "id" },
  { name: "backfill_batches", key: "rowid" },
  { name: "backfill_checkpoints", key: "id" },
  { name: "backfill_failures", key: "id" },
  { name: "bias_audits", key: "id" },
  { name: "historical_observations", key: "id" },
];

function line(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function* exportCheckpoint(
  d1: RawDb,
  tableCounts: Record<string, number>,
) {
  const encoder = new TextEncoder();
  const exportedAt = new Date().toISOString();
  const checkpoint = (await d1.prepare(`
    SELECT id, version, target_start AS targetStart, target_end AS targetEnd,
      cursor_date AS cursorDate, cursor_market AS cursorMarket, status,
      processed_units AS processedUnits, total_units AS totalUnits,
      stored_rows AS storedRows, failed_units AS failedUnits,
      last_checkpoint_at AS lastCheckpointAt
    FROM backfill_jobs
    ORDER BY id DESC
    LIMIT 1
  `).first()) as ExportRow | null;

  yield encoder.encode(line({
    type: "manifest",
    format: EXPORT_FORMAT,
    exportedAt,
    checkpoint,
    tableCounts,
  }));

  const exportedCounts: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    let cursor: number | string = 0;
    let exported = 0;

    while (true) {
      const keyExpression = table.key === "rowid" ? "rowid" : `\`${table.key}\``;
      const result = await d1.prepare(
        `SELECT *, ${keyExpression} AS __export_key FROM \`${table.name}\` WHERE ${keyExpression} > ? ORDER BY ${keyExpression} LIMIT ?`,
      ).bind(cursor, PAGE_SIZE).all() as { results?: ExportRow[] };
      const rows: ExportRow[] = result.results ?? [];
      if (!rows.length) break;

      let payload = "";
      for (const sourceRow of rows) {
        const { __export_key: nextCursor, ...row } = sourceRow;
        if (typeof nextCursor !== "number" && typeof nextCursor !== "string") {
          throw new Error(`Missing export cursor for ${table.name}`);
        }
        cursor = nextCursor;
        payload += line({ type: "row", table: table.name, row });
      }
      exported += rows.length;
      yield encoder.encode(payload);
    }

    if (exported !== tableCounts[table.name]) {
      throw new Error(
        `Export count changed for ${table.name}: expected ${tableCounts[table.name]}, received ${exported}`,
      );
    }
    exportedCounts[table.name] = exported;
  }

  yield encoder.encode(line({
    type: "complete",
    format: EXPORT_FORMAT,
    exportedAt,
    exportedCounts,
  }));
}

export async function GET() {
  const user = await getChatGPTUser();
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env as unknown as Record<string, unknown>;
  const allowedOwner = typeof runtimeEnv.LEGACY_CHECKPOINT_EXPORT_OWNER === "string"
    ? runtimeEnv.LEGACY_CHECKPOINT_EXPORT_OWNER.trim().toLowerCase()
    : "";

  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!allowedOwner || user.email.trim().toLowerCase() !== allowedOwner) {
    return Response.json({ error: "Legacy checkpoint export is disabled" }, { status: 403 });
  }

  const d1 = await getRawDb();
  const countResults = await d1.batch(
    EXPORT_TABLES.map((table) => d1.prepare(`SELECT count(*) AS count FROM \`${table.name}\``)),
  );
  const tableCounts = Object.fromEntries(EXPORT_TABLES.map((table, index) => [
    table.name,
    Number((countResults[index].results?.[0] as { count?: unknown } | undefined)?.count ?? 0),
  ]));

  const iterator = exportCheckpoint(d1, tableCounts);
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const compressed = source.pipeThrough(
    new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const cursorDate = (await d1.prepare(
    "SELECT cursor_date AS cursorDate FROM backfill_jobs ORDER BY id DESC LIMIT 1",
  ).first()) as { cursorDate?: string } | null;
  const suffix = cursorDate?.cursorDate ?? new Date().toISOString().slice(0, 10);

  return new Response(compressed, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="wall-explorer-legacy-d1-${suffix}.ndjson.gz"`,
      "Content-Type": "application/gzip",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
