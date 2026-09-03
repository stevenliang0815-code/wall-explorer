import { getRawDb } from "../db";
import type { NormalizedStock } from "./official-data";

export async function activeOperationalGeneration() {
  const d1 = await getRawDb();
  const state = await d1.prepare(`SELECT active_generation AS generationId,latest_completed_date AS latestCompletedDate,
    freshness_status AS freshnessStatus,updated_at AS updatedAt FROM operational_state WHERE id=1 AND active_generation IS NOT NULL`)
    .first<{ generationId: string; latestCompletedDate: string | null; freshnessStatus: string; updatedAt: string }>();
  return { d1, state };
}

export async function operationalMarketPulse() {
  const { d1, state } = await activeOperationalGeneration();
  if (!state) return null;
  const row = await d1.prepare(`SELECT index_name AS indexName,close,change,change_percent AS changePercent,
    trading_date AS tradingDate,fetched_at AS fetchedAt,source AS sourceUrl FROM operational_market_indices
    WHERE generation_id=? AND index_code='TAIEX'`).bind(state.generationId).first();
  return row ? { ...row, status: "official" as const, freshnessStatus: state.freshnessStatus } : null;
}

export async function operationalStockSearch(query: string) {
  const { d1, state } = await activeOperationalGeneration();
  if (!state) return null;
  const pattern = `%${query.replace(/[%_]/g, "")}%`;
  const rows = await d1.prepare(`SELECT code,name,market,close,change,volume,open,high,low,trade_value AS tradeValue,
    'official' AS dataState,source AS sourceUrl,trading_date AS tradingDate FROM operational_latest_quotes
    WHERE generation_id=? AND (code LIKE ? OR name LIKE ?) ORDER BY code LIMIT 30`)
    .bind(state.generationId, pattern, pattern).all<NormalizedStock & { tradingDate: string }>();
  return { stocks: rows.results, generationId: state.generationId, freshnessStatus: state.freshnessStatus, fetchedAt: state.updatedAt };
}

export async function operationalCandidateStocks() {
  const { d1, state } = await activeOperationalGeneration();
  if (!state) return null;
  const rows = await d1.prepare(`SELECT code,name,market,close,change,volume,open,high,low,trade_value AS tradeValue,
    'official' AS dataState,source AS sourceUrl,trading_date AS tradingDate FROM operational_latest_quotes
    WHERE generation_id=? AND length(code)=4 AND code GLOB '[1-9][0-9][0-9][0-9]'`)
    .bind(state.generationId).all<NormalizedStock & { tradingDate: string }>();
  const tradingDate = rows.results.reduce<string | null>((latest, row) => !latest || row.tradingDate > latest ? row.tradingDate : latest, null);
  return { stocks: rows.results, tradingDate, generationId: state.generationId, freshnessStatus: state.freshnessStatus, fetchedAt: state.updatedAt };
}
