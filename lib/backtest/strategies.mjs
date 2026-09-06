// Research-only contract: all inputs are an as-of-close, point-in-time cross-section.
export const DEFAULT_PARAMETERS = Object.freeze({
  version: 'baseline_parameters_v1', momentumDays: 60, fastDays: 60, slowDays: 120,
  liquidityDays: 20, universeLiquidityPercentile: 0.10, strategyLiquidityPercentile: 0.30,
  selection: Object.freeze({ mode: 'fraction', value: 0.10 }),
  initialCapital: 1_000_000, commissionRate: 0.001425, sellTaxRate: 0.003,
  slippageRate: 0.001, annualPeriods: 252, riskFreeRate: 0,
});

export function parameters(overrides = {}) {
  const p = { ...DEFAULT_PARAMETERS, ...overrides,
    selection: { ...DEFAULT_PARAMETERS.selection, ...overrides.selection } };
  for (const key of Object.keys(overrides)) if (!(key in DEFAULT_PARAMETERS)) throw Error(`Unknown parameter: ${key}`);
  for (const key of ['momentumDays', 'fastDays', 'slowDays', 'liquidityDays', 'annualPeriods']) {
    if (!Number.isInteger(p[key]) || p[key] < 1) throw Error(`Invalid ${key}`);
  }
  for (const key of ['universeLiquidityPercentile', 'strategyLiquidityPercentile', 'commissionRate', 'sellTaxRate', 'slippageRate']) {
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] >= 1) throw Error(`Invalid ${key}`);
  }
  if (p.commissionRate + p.sellTaxRate >= 1 || !(p.initialCapital > 0) || !Number.isFinite(p.initialCapital)
    || !Number.isFinite(p.riskFreeRate) || p.riskFreeRate <= -1 || typeof p.version !== 'string' || !p.version) throw Error('Invalid parameters');
  if (!['fraction', 'count'].includes(p.selection.mode) || !(p.selection.value > 0)
    || (p.selection.mode === 'fraction' ? p.selection.value > 1 : !Number.isInteger(p.selection.value))) throw Error('Invalid selection');
  return p;
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function features(histories, sessions, index, p) {
  const required = Math.max(p.momentumDays + 1, p.fastDays, p.slowDays, p.liquidityDays);
  if (index + 1 < required) return [];
  const dates = sessions.slice(index - required + 1, index + 1);
  const result = [];
  for (const [id, history] of histories) {
    const rows = dates.map(date => history.get(date));
    if (rows.some(row => !row || !row.tradable || row.securityType !== 'ordinary_equity'
      || !(row.close > 0))) continue;
    const liquidityRows = rows.slice(-p.liquidityDays);
    if (liquidityRows.some(row => !Number.isFinite(row.tradeValue) || row.tradeValue <= 0)) continue;
    // Local split adjustment uses only events observed by this signal date; no future-adjusted series.
    let factor = 1;
    const closes = new Array(rows.length);
    for (let k = rows.length - 1; k >= 0; k--) {
      closes[k] = rows[k].close / factor;
      factor *= rows[k].splitRatio;
    }
    const close = closes.at(-1);
    result.push({ id, close, momentum: close / closes.at(-p.momentumDays - 1) - 1,
      maFast: mean(closes.slice(-p.fastDays)), maSlow: mean(closes.slice(-p.slowDays)),
      averageTradeValue: mean(liquidityRows.map(row => row.tradeValue)) });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function generate(crossSection, p, trend, liquidity) {
  const commonThreshold = quantile(crossSection.map(r => r.averageTradeValue), p.universeLiquidityPercentile);
  const universe = crossSection.filter(r => r.averageTradeValue >= commonThreshold);
  const threshold = quantile(universe.map(r => r.averageTradeValue), p.strategyLiquidityPercentile);
  const eligible = universe.filter(r => r.momentum > 0 && (!trend || (r.close > r.maFast && r.maFast > r.maSlow)));
  const filtered = eligible.filter(r => !liquidity || r.averageTradeValue >= threshold);
  filtered.sort((a, b) => b.momentum - a.momentum || a.id.localeCompare(b.id, 'en'));
  const n = p.selection.mode === 'count' ? p.selection.value : Math.ceil(universe.length * p.selection.value);
  return { selected: filtered.slice(0, n).map(r => r.id), diagnostics: {
    sufficientHistoryCount: crossSection.length, universeCount: universe.length,
    beforeLiquidityCount: eligible.length, afterLiquidityCount: filtered.length,
    commonThreshold, strategyThreshold: liquidity ? threshold : null,
  } };
}

// Strategy interface: id, status, productionEligible, generate(asOfFeatures, parameters).
export const STRATEGIES = Object.freeze([
  { id: 'momentum_v1', status: 'experimental/baseline', productionEligible: false,
    generate: (rows, p) => generate(rows, p, false, false) },
  { id: 'trend_momentum_v1', status: 'experimental/baseline', productionEligible: false,
    generate: (rows, p) => generate(rows, p, true, false) },
  { id: 'trend_momentum_liquidity_v1', status: 'experimental/baseline', productionEligible: false,
    generate: (rows, p) => generate(rows, p, true, true) },
]);
