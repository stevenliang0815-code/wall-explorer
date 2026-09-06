import { createHash } from 'node:crypto';
import { STRATEGIES, parameters, features } from './strategies.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const week = date => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
};
const average = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

export function metrics(curve, closedTrades, tradedValue, initialCapital, p) {
  const values = [initialCapital, ...curve.map(r => r.equity)];
  const returns = values.slice(1).map((v, i) => values[i] === 0 ? 0 : v / values[i] - 1);
  const avg = average(returns), variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (returns.length - 1) : 0;
  const sd = Math.sqrt(variance), rf = (1 + p.riskFreeRate) ** (1 / p.annualPeriods) - 1;
  const downside = Math.sqrt(average(returns.map(r => Math.min(0, r - rf) ** 2)));
  let peak = initialCapital, drawdown = 0;
  for (const value of values) { peak = Math.max(peak, value); drawdown = Math.min(drawdown, value / peak - 1); }
  const gains = closedTrades.reduce((s, t) => s + Math.max(0, t.pnl), 0);
  const losses = -closedTrades.reduce((s, t) => s + Math.min(0, t.pnl), 0);
  return { cagr: curve.length ? (values.at(-1) / initialCapital) ** (p.annualPeriods / curve.length) - 1 : null,
    cumulativeReturn: values.at(-1) / initialCapital - 1, maxDrawdown: drawdown,
    sharpe: sd ? (avg - rf) / sd * Math.sqrt(p.annualPeriods) : null,
    sortino: downside ? (avg - rf) / downside * Math.sqrt(p.annualPeriods) : null,
    volatility: sd * Math.sqrt(p.annualPeriods), winRate: closedTrades.length ? closedTrades.filter(t => t.pnl > 0).length / closedTrades.length : null,
    profitFactor: losses ? gains / losses : null, turnover: tradedValue / (2 * average(values)),
    tradeCount: closedTrades.length, averageHoldingPeriod: closedTrades.length ? average(closedTrades.map(t => t.holdingSessions)) : null };
}

function validate(data, p) {
  if (data.schemaVersion !== 'pit_daily_v1' || !data.datasetVersion || !data.provenance
    || data.provenance.pointInTime !== true || data.provenance.corporateActionsComplete !== true
    || data.provenance.delistingsComplete !== true) throw Error('Point-in-time, corporate-action and delisting provenance required');
  if (!Array.isArray(data.sessions) || !data.sessions.length || !Array.isArray(data.bars)) throw Error('Missing data');
  for (let i = 0; i < data.sessions.length; i++) {
    const date = data.sessions[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
      || new Date(date).toISOString().slice(0, 10) !== date || (i && date <= data.sessions[i - 1])) throw Error('Invalid ordered session calendar');
  }
  if (!data.sessions.includes(data.startDate) || !data.sessions.includes(data.endDate) || data.startDate > data.endDate) throw Error('Invalid test interval');
  const required = Math.max(p.momentumDays + 1, p.fastDays, p.slowDays, p.liquidityDays);
  if (data.sessions.indexOf(data.startDate) < required) throw Error('Insufficient pre-period warmup');
  const histories = new Map(), dates = new Set(data.sessions);
  for (const row of data.bars) {
    if (!['TWSE', 'TPEX'].includes(row.market) || !row.code || !dates.has(row.date)
      || typeof row.tradable !== 'boolean' || typeof row.securityType !== 'string'
      || !Number.isFinite(row.splitRatio) || row.splitRatio <= 0 || !Number.isFinite(row.dividend) || row.dividend < 0
      || (row.tradable && (!(row.open > 0) || !(row.close > 0) || !Number.isFinite(row.open) || !Number.isFinite(row.close)))) throw Error('Invalid bar or explicit corporate-action fields missing');
    if (row.settlement !== undefined && (!Number.isFinite(row.settlement) || row.settlement < 0 || row.tradable)) throw Error('Invalid terminal settlement');
    const id = `${row.market}:${row.code}`;
    if (!histories.has(id)) histories.set(id, new Map());
    if (histories.get(id).has(row.date)) throw Error('Duplicate security/date');
    histories.get(id).set(row.date, row);
  }
  if (!data.benchmark?.name || !Array.isArray(data.benchmark.bars) || data.benchmark.totalReturn !== true) throw Error('An explicit total-return buy-and-hold benchmark is required');
  const benchmark = new Map();
  for (const b of data.benchmark.bars) {
    if (benchmark.has(b.date) || !(b.open > 0) || !(b.close > 0) || !Number.isFinite(b.open) || !Number.isFinite(b.close)) throw Error('Invalid benchmark');
    benchmark.set(b.date, b);
  }
  for (const d of data.sessions.filter(d => d >= data.startDate && d <= data.endDate)) if (!benchmark.has(d)) throw Error(`Missing benchmark ${d}`);
  return { histories, benchmark };
}

function simulate(data, p, histories, strategy) {
  let cash = p.initialCapital, pending = null, tradedValue = 0;
  const positions = new Map(), tradeLog = [], closedTrades = [], equityCurve = [], signals = [];
  const begin = data.sessions.indexOf(data.startDate), end = data.sessions.indexOf(data.endDate);
  const closePosition = (id, quantity, price, i, reason, signalDate, costRate) => {
    const position = positions.get(id), proceeds = quantity * price * (1 - costRate);
    cash += proceeds;
    tradedValue += quantity * price;
    let remaining = quantity;
    while (remaining > 1e-9 && position.lots.length) {
      const lot = position.lots[0], sold = Math.min(remaining, lot.quantity), portion = sold / lot.quantity;
      const cost = lot.cost * portion, dividends = lot.dividends * portion;
      closedTrades.push({ id, entryDate: lot.date, exitDate: data.sessions[i], quantity: sold,
        pnl: sold * price * (1 - costRate) + dividends - cost, holdingSessions: i - lot.index, reason });
      lot.quantity -= sold; lot.cost -= cost; lot.dividends -= dividends; remaining -= sold;
      if (lot.quantity < 1e-9) position.lots.shift();
    }
    position.quantity -= quantity;
    tradeLog.push({ id, date: data.sessions[i], signalDate, side: 'sell', quantity, price, fees: quantity * price * costRate, reason });
    if (position.quantity < 1e-9) positions.delete(id);
  };
  for (let i = begin - 1; i <= end; i++) {
    const date = data.sessions[i];
    if (i >= begin) {
      // Positions require explicit valuations during suspensions and explicit terminal settlement.
      for (const [id, position] of positions) {
        const bar = histories.get(id).get(date);
        if (!bar) throw Error(`Missing held-security valuation: ${id} ${date}`);
        for (const lot of position.lots) {
          const dividend = lot.quantity * bar.dividend;
          cash += dividend; lot.dividends += dividend; lot.quantity *= bar.splitRatio;
        }
        position.quantity *= bar.splitRatio;
        if (bar.settlement !== undefined) closePosition(id, position.quantity, bar.settlement, i, 'terminal_settlement', null, 0);
        else if (!(bar.close > 0) || !Number.isFinite(bar.close)) throw Error(`Missing held-security close: ${id} ${date}`);
      }
      if (pending) {
        const executable = pending.selected.filter(id => histories.get(id).get(date)?.tradable);
        const openEquity = cash + [...positions].reduce((sum, [id, pos]) => {
          const b = histories.get(id).get(date);
          if (!Number.isFinite(b.open) || b.open <= 0) throw Error(`Missing open valuation: ${id} ${date}`);
          return sum + pos.quantity * b.open;
        }, 0);
        // Unfillable selected names retain a cash allocation; no future-informed replacement.
        const allocation = pending.selected.length ? openEquity / pending.selected.length : 0;
        const target = new Map(executable.map(id => [id, allocation / (histories.get(id).get(date).open * (1 + p.slippageRate) * (1 + p.commissionRate))]));
        for (const [id, pos] of [...positions]) {
          const b = histories.get(id).get(date);
          if (!b.tradable) { tradeLog.push({ id, date, side: 'blocked', reason: 'not_tradable', signalDate: pending.date }); continue; }
          const excess = pos.quantity - (target.get(id) ?? 0);
          if (excess > 1e-9) closePosition(id, excess, b.open * (1 - p.slippageRate), i, 'weekly_rebalance', pending.date, p.commissionRate + p.sellTaxRate);
        }
        const orders = [...target].map(([id, quantity]) => ({ id, quantity: Math.max(0, quantity - (positions.get(id)?.quantity ?? 0)),
          price: histories.get(id).get(date).open * (1 + p.slippageRate) }));
        const budget = orders.reduce((s, o) => s + o.quantity * o.price * (1 + p.commissionRate), 0);
        const scale = budget ? Math.min(1, Math.max(0, cash) / budget) : 0;
        for (const order of orders) {
          const quantity = order.quantity * scale;
          if (quantity < 1e-9) continue;
          const cost = quantity * order.price * (1 + p.commissionRate);
          cash -= cost; tradedValue += quantity * order.price;
          if (!positions.has(order.id)) positions.set(order.id, { quantity: 0, lots: [] });
          const position = positions.get(order.id);
          position.quantity += quantity;
          position.lots.push({ quantity, cost, dividends: 0, date, index: i });
          tradeLog.push({ id: order.id, date, signalDate: pending.date, side: 'buy', quantity, price: order.price,
            fees: quantity * order.price * p.commissionRate, reason: 'weekly_rebalance' });
        }
        pending = null;
      }
      const equity = cash + [...positions].reduce((s, [id, pos]) => s + pos.quantity * histories.get(id).get(date).close, 0);
      equityCurve.push({ date, equity, cash });
    }
    const next = data.sessions[i + 1];
    if (next && week(next) !== week(date) && i < end) {
      const signal = strategy.generate(features(histories, data.sessions, i, p), p);
      pending = { ...signal, date };
      signals.push({ date, earliestExecution: next, ...signal });
    }
  }
  return { strategyId: strategy.id, status: strategy.status, productionEligible: false,
    metrics: metrics(equityCurve, closedTrades, tradedValue, p.initialCapital, p), equityCurve, tradeLog, closedTrades, signals,
    openPositions: [...positions].map(([id, pos]) => ({ id, quantity: pos.quantity })) };
}

export function runComparison(data, overrides = {}) {
  const p = parameters(overrides), { histories, benchmark } = validate(data, p);
  const results = STRATEGIES.map(strategy => simulate(data, p, histories, strategy));
  const dates = data.sessions.filter(d => d >= data.startDate && d <= data.endDate);
  const purchase = benchmark.get(dates[0]).open * (1 + p.slippageRate);
  const units = p.initialCapital / (purchase * (1 + p.commissionRate));
  const equityCurve = dates.map(date => ({ date, equity: units * benchmark.get(date).close }));
  return { engineVersion: 'daily_open_backtest_v1', status: 'experimental/baseline', productionEligible: false,
    datasetVersion: data.datasetVersion, provenance: data.provenance,
    datasetSha256: hash(data), parameterSha256: hash(p), parameters: p,
    startDate: data.startDate, endDate: data.endDate, split: data.split ?? 'unspecified',
    assumptions: ['Long-only equal weight, fractional shares, weekly closing signal / next-session open execution',
      'Open positions marked to close; no forced final liquidation; closed trade metrics use FIFO matched lots',
      'Costs are fixed research assumptions, not a verified broker tariff; dividends credited on supplied event date',
      'Turnover = (buy + sell notional) / (2 * mean NAV), not annualized; holding period in trading sessions',
      'Benchmark total-return units use same buy fee/slippage, held without terminal sale',
      'No optimization; no claim of out-of-sample value without independent held-out data'], results,
    benchmark: { name: data.benchmark.name, equityCurve, metrics: metrics(equityCurve, [], units * purchase, p.initialCapital, p) } };
}
