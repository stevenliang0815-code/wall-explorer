import test from 'node:test';
import assert from 'node:assert/strict';
import { runComparison, metrics } from '../lib/backtest/engine.mjs';
import { STRATEGIES, parameters } from '../lib/backtest/strategies.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function fixture() {
  const sessions = [], date = new Date('2024-01-01T00:00:00Z');
  while (sessions.length < 180) {
    if (![0, 6].includes(date.getUTCDay())) sessions.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  const bars = sessions.flatMap((date, i) => Array.from({ length: 5 }, (_, k) => ({ date, code: `${1101 + k}`,
    market: 'TWSE', tradable: true, securityType: 'ordinary_equity', open: 100 + i * (k + 1) * 0.1,
    close: 100 + i * (k + 1) * 0.1, tradeValue: (k + 1) * 100_000,
    splitRatio: 1, dividend: 0 })));
  return { schemaVersion: 'pit_daily_v1', datasetVersion: 'synthetic_v1', split: 'test_fixture',
    provenance: { pointInTime: true, corporateActionsComplete: true, delistingsComplete: true },
    sessions, bars, startDate: sessions[120], endDate: sessions[169],
    benchmark: { name: 'Synthetic total return baseline', totalReturn: true,
      bars: sessions.map((date, i) => ({ date, open: 100 + i, close: 100 + i })) } };
}

test('three reproducible experimental strategies share universe, dates, costs; signal executes strictly later', () => {
  const data = fixture(), result = runComparison(data);
  assert.deepEqual(result, runComparison(data));
  assert.equal(result.productionEligible, false);
  assert.equal(result.results.length, 3);
  for (const strategy of result.results) {
    assert.equal(strategy.productionEligible, false);
    assert.equal(strategy.equityCurve.length, 50);
    assert.ok(strategy.tradeLog.some(t => t.side === 'buy'));
    for (const trade of strategy.tradeLog) if (trade.signalDate) assert.ok(trade.date > trade.signalDate);
    assert.deepEqual(strategy.signals.map(s => s.diagnostics.universeCount), result.results[0].signals.map(s => s.diagnostics.universeCount));
    for (const name of ['cagr','cumulativeReturn','maxDrawdown','sharpe','sortino','volatility','winRate','profitFactor','turnover','tradeCount','averageHoldingPeriod']) {
      assert.ok(name in strategy.metrics);
    }
  }
});

test('future changes cannot alter past signals, trades or equity', () => {
  const data = fixture(), cut = data.sessions[150], base = runComparison(data);
  for (const bar of data.bars) if (bar.date > cut) { bar.open *= 2; bar.close *= 2; bar.tradeValue *= 7; bar.splitRatio = 2; }
  const changed = runComparison(data);
  for (let k = 0; k < 3; k++) for (const field of ['signals','tradeLog','equityCurve']) {
    assert.deepEqual(base.results[k][field].filter(r => r.date <= cut), changed.results[k][field].filter(r => r.date <= cut));
  }
});

test('insufficient history, missing turnover and nonordinary/nontradable members excluded without filling', () => {
  const data = fixture();
  data.bars = data.bars.filter(r => r.code !== '1105' || r.date >= data.sessions[110]);
  for (const bar of data.bars) {
    if (bar.code === '1104') bar.tradeValue = null;
    if (bar.code === '1103') bar.securityType = 'etf';
    if (bar.code === '1102') bar.tradable = false;
  }
  const result = runComparison(data);
  assert.deepEqual(result.results[0].signals[0].selected, ['TWSE:1101']);
});

test('trend and additional liquidity layers are distinct and report before/after counts', () => {
  const p = parameters({ universeLiquidityPercentile: 0, strategyLiquidityPercentile: 0.5, selection: { mode: 'count', value: 10 } });
  const rows = [
    { id:'a', momentum:1, close:120, maFast:100, maSlow:90, averageTradeValue:1 },
    { id:'b', momentum:0.5, close:120, maFast:100, maSlow:90, averageTradeValue:10 },
    { id:'c', momentum:0.2, close:80, maFast:100, maSlow:90, averageTradeValue:100 },
  ];
  assert.deepEqual(STRATEGIES[0].generate(rows,p).selected,['a','b','c']);
  assert.deepEqual(STRATEGIES[1].generate(rows,p).selected,['a','b']);
  const c = STRATEGIES[2].generate(rows,p);
  assert.deepEqual(c.selected,['b']);
  assert.equal(c.diagnostics.beforeLiquidityCount,2);
  assert.equal(c.diagnostics.afterLiquidityCount,1);
});

test('fees and slippage reduce equity, cash never goes negative and ranking ties are deterministic', () => {
  const data = fixture(), paid = runComparison(data), free = runComparison(data, { commissionRate:0, sellTaxRate:0, slippageRate:0 });
  assert.ok(paid.results[0].equityCurve.at(-1).equity < free.results[0].equityCurve.at(-1).equity);
  assert.ok(paid.results[0].equityCurve.every(r => r.cash > -1e-6));
  const rows = ['b','a'].map(id => ({ id, momentum:1, averageTradeValue:1 }));
  assert.deepEqual(STRATEGIES[0].generate(rows,parameters({ selection:{mode:'count',value:1} })).selected,['a']);
});

test('missing held stock fails instead of disappearing; explicit delisting loss remains in equity and trade log', () => {
  const data = fixture(), first = runComparison(data).results[0].tradeLog.find(t => t.side === 'buy');
  const failureDate = data.sessions[data.sessions.indexOf(first.date)+1];
  const missing = structuredClone(data);
  missing.bars = missing.bars.filter(r => !(r.date === failureDate && `TWSE:${r.code}` === first.id));
  assert.throws(() => runComparison(missing), /Missing held-security/);
  for (const r of data.bars) if (`TWSE:${r.code}` === first.id && r.date >= failureDate) {
    r.tradable = false; r.settlement = 0;
  }
  const result = runComparison(data).results[0];
  assert.ok(result.closedTrades.some(t => t.reason === 'terminal_settlement' && t.pnl < 0));
  assert.ok(result.equityCurve.find(r => r.date === failureDate).equity < 100);
});

test('split has no artificial profit, cash dividends enter NAV', () => {
  const data = fixture(), base = runComparison(data), splitDay = data.sessions[130];
  for (const r of data.bars) if (r.code === '1105' && r.date >= splitDay) {
    r.open /= 2; r.close /= 2; if (r.date === splitDay) r.splitRatio = 2;
  }
  const split = runComparison(data);
  assert.ok(Math.abs(base.results[0].equityCurve.at(-1).equity - split.results[0].equityCurve.at(-1).equity) < 1e-6);
  data.bars.find(r => r.code === '1105' && r.date === splitDay).dividend = 1;
  assert.ok(runComparison(data).results[0].equityCurve.at(-1).equity > split.results[0].equityCurve.at(-1).equity);
});

test('metrics use net FIFO P&L, zero denominators are null, drawdown includes initial capital', () => {
  const m = metrics([{equity:90},{equity:99}], [{pnl:9,holdingSessions:2},{pnl:-3,holdingSessions:4}], 100, 100, parameters());
  assert.ok(Math.abs(m.maxDrawdown + 0.1) < 1e-12);
  assert.equal(m.profitFactor,3); assert.equal(m.winRate,0.5); assert.equal(m.averageHoldingPeriod,3);
  const flat = metrics([{equity:100}], [], 0, 100, parameters());
  assert.equal(flat.sharpe,null); assert.equal(flat.profitFactor,null);
});

test('unverified provenance, duplicate bars, absent benchmark and insufficient warmup fail closed', () => {
  const data = fixture(); data.provenance.pointInTime = false;
  assert.throws(() => runComparison(data), /provenance/);
  data.provenance.pointInTime = true; data.bars.push(data.bars[0]);
  assert.throws(() => runComparison(data), /Duplicate/);
  data.bars.pop(); data.benchmark = null;
  assert.throws(() => runComparison(data), /benchmark/);
  data.startDate = data.sessions[50];
  assert.throws(() => runComparison(data), /warmup/);
});

test('negative momentum exits at the next weekly open and deducts sell fees and tax', () => {
  const data = fixture(), crash = data.sessions[130];
  for (const bar of data.bars) if (bar.code === '1105' && bar.date >= crash) { bar.open = 10; bar.close = 10; }
  const result = runComparison(data).results[0];
  const sale = result.tradeLog.find(t => t.side === 'sell' && t.date > crash && t.id === 'TWSE:1105');
  assert.ok(sale);
  assert.ok(Math.abs(sale.fees - sale.quantity * sale.price * (0.001425 + 0.003)) < 1e-8);
  assert.ok(result.closedTrades.some(t => t.id === 'TWSE:1105' && t.pnl < 0));
});

test('next-open suspension does not use another future winner to replace a selected name', () => {
  const data = fixture();
  const first = runComparison(data).results[0].tradeLog.find(t => t.side === 'buy');
  data.bars.find(r => r.date === first.date && `TWSE:${r.code}` === first.id).tradable = false;
  const result = runComparison(data).results[0];
  assert.equal(result.tradeLog.filter(t => t.date === first.date && t.side === 'buy').length, 0);
  assert.equal(result.equityCurve[0].equity, parameters().initialCapital);
});

test('CLI writes a complete reproducible report and refuses to overwrite one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wall-backtest-test-'));
  try {
    const input = join(dir, 'synthetic.json'), output = join(dir, 'report.json');
    await writeFile(input, JSON.stringify(fixture()));
    execFileSync(process.execPath, ['scripts/run-strategy-backtest.mjs', input, '-', output]);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(report, runComparison(fixture()));
    assert.throws(() => execFileSync(process.execPath, ['scripts/run-strategy-backtest.mjs', input, '-', output], { stdio:'pipe' }), /Command failed/);
  } finally { await rm(dir, { recursive:true, force:true }); }
});
