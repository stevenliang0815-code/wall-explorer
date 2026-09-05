#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { auditBiasGuards, fetchHistoricalMarketDay, HistoricalUnitError } from "../lib/historical-data.ts";
import { nextWeekday } from "../lib/operational-time.ts";

const baseUrl = process.env.WALL_EXPLORER_URL;
const token = process.env.OAI_SITES_AUTHORIZATION;

if (!baseUrl || !token) {
  throw new Error("Set WALL_EXPLORER_URL and OAI_SITES_AUTHORIZATION in the server job environment");
}

const endpoint = new URL("/api/incremental", baseUrl);
const generationId = process.env.OPERATIONAL_GENERATION_ID;
let iterations = 0;
let rowsWritten = 0;
const maxIterations = Math.max(1, Number(process.env.INCREMENTAL_BATCH_DATES ?? 20));
const deferredAttempt = Math.max(0, Number(process.env.INCREMENTAL_DEFERRED_ATTEMPT ?? 0));
const maxDeferredAttempts = 6;

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

let transientAttempts = 0;
while (iterations < maxIterations) {
  const stateResponse = await fetch(endpoint, {
    headers: { "OAI-Sites-Authorization": `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!stateResponse.ok) throw new Error(`Could not read incremental state (${stateResponse.status})`);
  const state = await stateResponse.json();
  if (!state.generation) throw new Error("No operational generation is available");
  const anchor = state.lastCompletedDate ?? state.generation.baseLastDate;
  const tradingDate = nextWeekday(anchor);
  const saved = new Map((state.runs ?? []).filter((unit) => unit.tradingDate === tradingDate).map((unit) => [unit.market, unit]));
  const units = [];
  if (tradingDate <= state.targetDate) {
    for (const market of ["上市", "上櫃"]) {
      if (["complete", "validated_empty"].includes(saved.get(market)?.status)) continue;
      let result;
      try {
        result = await fetchHistoricalMarketDay(market, tradingDate, {
          maxAttempts: 5,
          timeoutMs: 15_000,
          maxBackoffMs: 15_000,
        });
      } catch (error) {
        if (error instanceof HistoricalUnitError && error.retryable && deferredAttempt < maxDeferredAttempts) {
          output("continue", "true");
          output("deferred_attempt", String(deferredAttempt + 1));
          console.log(JSON.stringify({
            status: "source_deferred",
            market,
            tradingDate,
            deferredAttempt: deferredAttempt + 1,
            reason: error.message,
            rowsWritten,
            iterations,
          }));
          process.exit(0);
        }
        throw error;
      }
      const audit = auditBiasGuards(result.observations, tradingDate);
      if (audit.survivorship.status !== "pass" || audit.lookAhead.status !== "pass") {
        throw new Error(`Bias validation blocked ${market} ${tradingDate}`);
      }
      units.push({ market, tradingDate, observations: result.observations });
    }
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${token}` },
    body: JSON.stringify({ ...(generationId ? { generationId } : {}), units }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json();
  if (!response.ok && response.status !== 202) {
    if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && transientAttempts < 2) {
      transientAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** transientAttempts) + Math.floor(Math.random() * 750)));
      continue;
    }
    throw new Error(`Daily incremental update failed (${response.status}): ${body.error ?? body.status ?? "unknown error"}`);
  }
  transientAttempts = 0;
  rowsWritten += body.barsStored ?? 0;
  iterations += 1;
  if (body.status === "caught_up") {
    output("continue", "false");
    output("deferred_attempt", "0");
    console.log(JSON.stringify({ status: body.status, generationId: body.generationId, throughDate: body.tradingDate ?? body.throughDate, rowsWritten, iterations }));
    process.exit(0);
  }
}

output("continue", "true");
output("deferred_attempt", "0");
console.log(JSON.stringify({ status: "batch_complete", rowsWritten, iterations }));
