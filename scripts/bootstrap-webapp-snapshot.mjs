#!/usr/bin/env node
const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;
if (!baseUrl || !token) throw new Error("Set WALL_EXPLORER_URL and OAI_SITES_AUTHORIZATION in the server job environment");
const endpoint = new URL("/api/snapshot", baseUrl);
let iterations = 0;
while (iterations < 20_000) {
  const response = await fetch(endpoint, { method: "POST", headers: { "OAI-Sites-Authorization": `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok && response.status !== 202) throw new Error(`Snapshot bootstrap failed (${response.status}): ${body.error ?? "unknown error"}`);
  if (body.status === "complete") {
    console.log(JSON.stringify({ status: body.status, importedRows: body.importedRows, snapshotVersion: body.snapshotVersion }));
    process.exit(0);
  }
  iterations += 1;
}
throw new Error("Snapshot bootstrap exceeded the safety iteration limit");
