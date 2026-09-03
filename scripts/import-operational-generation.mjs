#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { OPERATIONAL_RETENTION } from "../lib/operational-policy.ts";

const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;
const sqlitePath = process.env.OPERATIONAL_SQLITE_PATH;
const pointerPath = process.env.OPERATIONAL_POINTER_PATH;
const chunkRows = Math.max(100, Math.min(1_500, Number(process.env.OPERATIONAL_CHUNK_ROWS ?? 900)));
if (!baseUrl || !token || !sqlitePath || !pointerPath) throw new Error("Operational rebuild environment is incomplete");

const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
if (pointer.status !== "verified" || pointer.progress !== 100 || pointer.compression !== "gzip-9-n" ||
  !/^[a-f0-9]{64}$/.test(pointer.rawSha256 ?? "")) throw new Error("R2 pointer is not a verified 100% compressed Historical Snapshot");

const db = new DatabaseSync(sqlitePath, { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get()["integrity_check"];
if (integrity !== "ok") throw new Error(`Historical Snapshot integrity_check failed: ${integrity}`);
const baseLastDate = db.prepare("SELECT max(trading_date) value FROM historical_observations").get().value;
if (!/^\d{4}-\d{2}-\d{2}$/.test(baseLastDate ?? "")) throw new Error("Historical Snapshot has no actual market date");
const cutoff = db.prepare(`SELECT min(trading_date) value FROM (
  SELECT DISTINCT trading_date FROM historical_observations
  WHERE security_type='ordinary_equity_candidate' ORDER BY trading_date DESC LIMIT ?
)`).get(OPERATIONAL_RETENTION.retentionTradingDays).value;
if (!cutoff) throw new Error("Historical Snapshot has no ordinary-equity retention window");

const expectedBars = Number(db.prepare(`SELECT count(*) value FROM historical_observations
  WHERE security_type='ordinary_equity_candidate' AND trading_date>=?`).get(cutoff).value);
const expectedQuotes = Number(db.prepare(`SELECT count(*) value FROM historical_observations h
  WHERE trading_date=(SELECT max(trading_date) FROM historical_observations WHERE market=h.market)`).get().value);
const totalChunks = Math.ceil(expectedBars / chunkRows) + Math.ceil(expectedQuotes / chunkRows);
const generationId = `op-${pointer.rawSha256.slice(0, 24)}-${OPERATIONAL_RETENTION.version}`;
const endpoint = new URL("/api/operational/rebuild", baseUrl);

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
  retentionTradingDays: OPERATIONAL_RETENTION.retentionTradingDays, expectedBars, expectedQuotes, totalChunks });
const startingStatus = started.generation?.status;
if (startingStatus === "active") {
  console.log(JSON.stringify({ status: "already_active", generationId, state: started.state }));
  db.close();
  process.exit(0);
}
if (!["shadow", "ready"].includes(startingStatus)) throw new Error(`Unexpected generation status: ${startingStatus}`);

const selectBars = db.prepare(`SELECT id,market,code,name,trading_date AS tradingDate,security_type AS securityType,
  open,high,low,close,change,volume,trade_value AS tradeValue,source FROM historical_observations
  WHERE security_type='ordinary_equity_candidate' AND trading_date>=? AND id>? ORDER BY id LIMIT ?`);
const selectQuotes = db.prepare(`SELECT id,market,code,name,trading_date AS tradingDate,security_type AS securityType,
  open,high,low,close,change,volume,trade_value AS tradeValue,source FROM historical_observations h
  WHERE trading_date=(SELECT max(trading_date) FROM historical_observations WHERE market=h.market)
    AND id>? ORDER BY id LIMIT ?`);
let chunkIndex = 0;
async function upload(rows, kind) {
  const canonical = JSON.stringify({ bars: kind === "bars" ? rows : [], quotes: kind === "quotes" ? rows : [] });
  const digest = createHash("sha256").update(canonical).digest("hex");
  await post(endpoint.pathname, { action: "chunk", generationId, chunkIndex, sha256: digest,
    bars: kind === "bars" ? rows : [], quotes: kind === "quotes" ? rows : [] });
  chunkIndex += 1;
}

if (startingStatus === "shadow") {
  let cursor = 0;
  while (true) {
    const rows = selectBars.all(cutoff, cursor, chunkRows);
    if (!rows.length) break;
    await upload(rows, "bars"); cursor = rows.at(-1).id;
  }
  cursor = 0;
  while (true) {
    const rows = selectQuotes.all(cursor, chunkRows);
    if (!rows.length) break;
    await upload(rows, "quotes"); cursor = rows.at(-1).id;
  }
  if (chunkIndex !== totalChunks) throw new Error(`Operational chunk count changed: ${chunkIndex} != ${totalChunks}`);
  await post(endpoint.pathname, { action: "validate", generationId });
}

let increments = 0;
while (increments < 600) {
  const result = await post("/api/incremental", { generationId });
  increments += 1;
  if (result.status === "caught_up") break;
  if (result.status !== "continue") throw new Error(`Unexpected incremental status: ${result.status}`);
}
if (increments >= 600) throw new Error("Operational shadow catch-up exceeded 600 market days");
const activated = await post(endpoint.pathname, { action: "activate", generationId });
console.log(JSON.stringify({ status: "active", generationId, baseLastDate, cutoff, expectedBars, expectedQuotes,
  retentionTradingDays: OPERATIONAL_RETENTION.retentionTradingDays, increments, state: activated.state }));
db.close();
