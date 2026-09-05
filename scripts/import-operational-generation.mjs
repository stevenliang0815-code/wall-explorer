#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { OPERATIONAL_RETENTION } from "../lib/operational-policy.ts";

const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;
const sqlitePath = process.env.OPERATIONAL_SQLITE_PATH;
const pointerPath = process.env.OPERATIONAL_POINTER_PATH;
const chunkRows = Math.max(100, Math.min(1_500, Number(process.env.OPERATIONAL_CHUNK_ROWS ?? 900)));
const maxSeconds = Math.max(60, Math.min(14_400, Number(process.env.OPERATIONAL_MAX_SECONDS ?? 2_400)));
const deadline = Date.now() + maxSeconds * 1_000;
if (!baseUrl || !token || !sqlitePath || !pointerPath) throw new Error("Operational rebuild environment is incomplete");

function log(event, details = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function continueLater(generationId, phase, chunkIndex) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "continue=true\n");
  log("operational_batch_paused", { generationId, phase, chunkIndex });
}

function hasTimeForNextRequest() {
  return Date.now() + 120_000 < deadline;
}

const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
if (pointer.status !== "verified" || pointer.progress !== 100 || pointer.compression !== "gzip-9-n" ||
  !/^[a-f0-9]{64}$/.test(pointer.rawSha256 ?? "")) throw new Error("R2 pointer is not a verified 100% compressed Historical Snapshot");

const db = new DatabaseSync(sqlitePath, { readOnly: true });
log("snapshot_preflight_started");
const integrity = db.prepare("PRAGMA quick_check").get()["quick_check"];
if (integrity !== "ok") throw new Error(`Historical Snapshot quick_check failed: ${integrity}`);
const baseLastDate = db.prepare("SELECT max(trading_date) value FROM historical_observations").get().value;
if (!/^\d{4}-\d{2}-\d{2}$/.test(baseLastDate ?? "")) throw new Error("Historical Snapshot has no actual market date");
const cutoff = db.prepare(`SELECT min(trading_date) value FROM (
  SELECT DISTINCT trading_date FROM historical_observations
  WHERE security_type='ordinary_equity_candidate' ORDER BY trading_date DESC LIMIT ?
)`).get(OPERATIONAL_RETENTION.retentionTradingDays).value;
if (!cutoff) throw new Error("Historical Snapshot has no ordinary-equity retention window");

const expectedBars = Number(db.prepare(`SELECT count(*) value FROM historical_observations
  WHERE security_type='ordinary_equity_candidate' AND trading_date>=?`).get(cutoff).value);
const latestMarketDates = db.prepare(`SELECT market,max(trading_date) tradingDate
  FROM historical_observations GROUP BY market ORDER BY market`).all();
if (!latestMarketDates.length || latestMarketDates.some((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.tradingDate ?? ""))) {
  throw new Error("Historical Snapshot has no latest market dates");
}
const latestPredicates = latestMarketDates.map(() => "(market=? AND trading_date=?)").join(" OR ");
const latestBindings = latestMarketDates.flatMap((row) => [row.market, row.tradingDate]);
const expectedQuotes = Number(db.prepare(`SELECT count(*) value FROM historical_observations
  WHERE ${latestPredicates}`).get(...latestBindings).value);
const totalChunks = Math.ceil(expectedBars / chunkRows) + Math.ceil(expectedQuotes / chunkRows);
const generationId = `op-${pointer.rawSha256.slice(0, 24)}-${OPERATIONAL_RETENTION.version}`;
const endpoint = new URL("/api/operational/rebuild", baseUrl);
log("snapshot_preflight_completed", { generationId, baseLastDate, cutoff, expectedBars, expectedQuotes, totalChunks, chunkRows });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function post(path, body, accepted = [200, 201, 202]) {
  const url = new URL(path, baseUrl);
  let last;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(url, { method: "POST", headers: {
        "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${token}`,
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      const result = await response.json();
      if (accepted.includes(response.status)) return result;
      last = new Error(`${url.pathname} returned ${response.status}: ${result.error ?? result.status ?? "unknown"}`);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw last;
    } catch (error) { last = error; }
    if (attempt < 8) await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 750));
  }
  throw last;
}

const started = await post(endpoint.pathname, { action: "start", generationId,
  snapshotVersion: String(pointer.version), sourceSha256: pointer.rawSha256, baseLastDate,
  retentionTradingDays: OPERATIONAL_RETENTION.retentionTradingDays, expectedBars, expectedQuotes, totalChunks, chunkRows });
let status = started.generation?.status;
if (status === "active") {
  log("operational_generation_already_active", { generationId, state: started.state });
  db.close();
  process.exit(0);
}
if (!["shadow", "ready"].includes(status)) throw new Error(`Unexpected generation status: ${status}`);

const selectBars = db.prepare(`SELECT id,market,code,name,trading_date AS tradingDate,security_type AS securityType,
  open,high,low,close,change,volume,trade_value AS tradeValue,source FROM historical_observations
  WHERE security_type='ordinary_equity_candidate' AND trading_date>=? AND id>? ORDER BY id LIMIT ?`);
const selectQuotes = db.prepare(`SELECT id,market,code,name,trading_date AS tradingDate,security_type AS securityType,
  open,high,low,close,change,volume,trade_value AS tradeValue,source FROM historical_observations
  WHERE (${latestPredicates}) AND id>? ORDER BY id LIMIT ?`);
let chunkIndex = Number(started.generation?.importedChunks ?? 0);
let phase = started.generation?.resumeKind ?? "bars";
let cursor = Number(started.generation?.resumeSourceId ?? 0);

async function upload(rows, kind) {
  const canonical = JSON.stringify({ bars: kind === "bars" ? rows : [], quotes: kind === "quotes" ? rows : [] });
  const digest = createHash("sha256").update(canonical).digest("hex");
  const sourceLastId = rows.at(-1).id;
  await post(endpoint.pathname, { action: "chunk", generationId, chunkIndex, sha256: digest, kind, sourceLastId,
    bars: kind === "bars" ? rows : [], quotes: kind === "quotes" ? rows : [] });
  chunkIndex += 1;
  cursor = sourceLastId;
  log("operational_chunk_committed", { generationId, kind, chunkIndex: chunkIndex - 1, sourceLastId, rows: rows.length });
}

if (status === "shadow") {
  if (phase === "bars") {
    while (true) {
      if (!hasTimeForNextRequest()) { continueLater(generationId, "bars", chunkIndex); db.close(); process.exit(0); }
      const rows = selectBars.all(cutoff, cursor, chunkRows);
      if (!rows.length) break;
      await upload(rows, "bars");
    }
    phase = "quotes";
    cursor = 0;
  }
  while (true) {
    if (!hasTimeForNextRequest()) { continueLater(generationId, "quotes", chunkIndex); db.close(); process.exit(0); }
    const rows = selectQuotes.all(...latestBindings, cursor, chunkRows);
    if (!rows.length) break;
    await upload(rows, "quotes");
  }
  if (chunkIndex !== totalChunks) throw new Error(`Operational chunk count changed: ${chunkIndex} != ${totalChunks}`);
  await post(endpoint.pathname, { action: "validate", generationId });
  status = "ready";
  log("operational_generation_validated", { generationId, chunkIndex });
}

const activated = await post(endpoint.pathname, { action: "activate", generationId, allowStaleBootstrap: true });
log("operational_generation_active", { generationId, baseLastDate, cutoff, expectedBars, expectedQuotes,
  retentionTradingDays: OPERATIONAL_RETENTION.retentionTradingDays, state: activated.state });
db.close();
