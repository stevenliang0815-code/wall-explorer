#!/usr/bin/env node

const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;

if (!baseUrl || !token) {
  throw new Error("Set WALL_EXPLORER_URL and OAI_SITES_AUTHORIZATION in the server job environment");
}

const endpoint = new URL("/api/incremental", baseUrl);
const generationId = process.env.OPERATIONAL_GENERATION_ID;
let iterations = 0;
let rowsWritten = 0;

let transientAttempts = 0;
while (iterations < 5_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${token}` },
    body: JSON.stringify(generationId ? { generationId } : {}),
  });
  const body = await response.json();
  if (!response.ok && response.status !== 202) {
    if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && transientAttempts < 7) {
      transientAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** transientAttempts) + Math.floor(Math.random() * 750)));
      continue;
    }
    throw new Error(`Daily incremental update failed (${response.status}): ${body.error ?? body.status ?? "unknown error"}`);
  }
  transientAttempts = 0;
  rowsWritten += body.rowsWritten ?? 0;
  iterations += 1;
  if (body.status === "caught_up") {
      console.log(JSON.stringify({ status: body.status, generationId: body.generationId, throughDate: body.tradingDate ?? body.throughDate, rowsWritten, iterations }));
    process.exit(0);
  }
}

throw new Error("Daily incremental catch-up exceeded the safety iteration limit");
