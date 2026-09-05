#!/usr/bin/env node

const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;
const candidateGenerationId = process.env.OPERATIONAL_GENERATION_ID;
if (!baseUrl || !token || !candidateGenerationId) throw new Error("Operational rollback verification environment is incomplete");

const headers = { "OAI-Sites-Authorization": `Bearer ${token}` };
async function get(path) {
  const response = await fetch(new URL(path, baseUrl), { headers, signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.error ?? body.status}`);
  return body;
}
async function post(body) {
  const response = await fetch(new URL("/api/operational/rebuild", baseUrl), { method: "POST",
    headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Operational action returned ${response.status}: ${result.error ?? result.status}`);
  return result;
}
function assert(condition, message) { if (!condition) throw new Error(message); }

const before = await get("/api/model-health");
const previousGenerationId = before.operational?.state?.generationId;
const previousChecksum = before.operational?.generation?.sourceSha256;
assert(previousGenerationId && previousGenerationId !== candidateGenerationId, "A different verified active generation is required");
assert(before.status === "fresh" && before.tradingDayCount === before.operational.state.retentionTradingDays, "Previous generation is not fresh with exact retention");

const candidate = await get(`/api/operational/rebuild?generation=${encodeURIComponent(candidateGenerationId)}`);
assert(candidate.generation?.status === "ready", "Candidate generation is not ready");
assert(candidate.generation.metrics?.tradingDayCount === candidate.generation.retentionTradingDays, "Candidate retention count is invalid");
assert(candidate.generation.metrics?.latestDate === before.latestDate, "Candidate latest date does not match production");

await post({ action: "activate", generationId: candidateGenerationId });
const switched = await get("/api/model-health");
const switchedWeb = await get("/api/candidates");
assert(switched.operational.state.generationId === candidateGenerationId, "Atomic switch did not update the active pointer");
assert(switched.status === "fresh" && switched.tradingDayCount === switched.operational.state.retentionTradingDays, "Switched generation failed health checks");
assert(switchedWeb.dataMode === "operational_db" && switchedWeb.tradingDate === switched.latestDate, "Web App did not read the switched generation");

const rolledBack = await post({ action: "rollback", generationId: previousGenerationId,
  failureReason: "Production acceptance injected failure after successful atomic switch" });
const restored = await get("/api/model-health");
const restoredWeb = await get("/api/candidates");
assert(restored.operational.state.generationId === previousGenerationId, "Rollback did not restore the previous pointer");
assert(restored.historicalRows === before.historicalRows && restored.stockCount === before.stockCount, "Rollback row counts changed");
assert(restored.latestDate === before.latestDate && restored.tradingDayCount === before.tradingDayCount, "Rollback dates changed");
assert(restored.operational.generation.sourceSha256 === previousChecksum && rolledBack.restoredSourceSha256 === previousChecksum,
  "Rollback checksum did not match the verified generation");
assert(restored.status === "fresh" && restoredWeb.dataMode === "operational_db" && restoredWeb.tradingDate === before.latestDate,
  "Web App did not recover through the restored operational generation");

console.log(JSON.stringify({ status: "accepted", previousGenerationId, candidateGenerationId,
  switched: { rowCount: switched.historicalRows, quoteCount: switched.stockCount, latestDate: switched.latestDate,
    tradingDayCount: switched.tradingDayCount, sourceSha256: switched.operational.generation.sourceSha256 },
  restored: { rowCount: restored.historicalRows, quoteCount: restored.stockCount, latestDate: restored.latestDate,
    tradingDayCount: restored.tradingDayCount, sourceSha256: restored.operational.generation.sourceSha256,
    webDataMode: restoredWeb.dataMode } }));
