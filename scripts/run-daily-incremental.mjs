#!/usr/bin/env node

const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;

if (!baseUrl || !token) {
  throw new Error("Set WALL_EXPLORER_URL and OAI_SITES_AUTHORIZATION in the server job environment");
}

const endpoint = new URL("/api/incremental", baseUrl);
let iterations = 0;
let rowsWritten = 0;

while (iterations < 5_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "OAI-Sites-Authorization": `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok && response.status !== 202) {
    throw new Error(`Daily incremental update failed (${response.status}): ${body.error ?? body.status ?? "unknown error"}`);
  }
  rowsWritten += body.rowsWritten ?? 0;
  iterations += 1;
  if (body.status === "caught_up") {
    console.log(JSON.stringify({ status: body.status, throughDate: body.tradingDate ?? body.throughDate, rowsWritten, iterations }));
    process.exit(0);
  }
}

throw new Error("Daily incremental catch-up exceeded the safety iteration limit");
