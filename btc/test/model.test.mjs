// Run with: node --test btc/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ema, sma, rsi, macd, bollinger, logReturns, fitGarch, filterVariance, cumVariance, stepVariances,
  standardizedQuantiles, fitLogit, predictLogit, fitSeries, predictAt, backtest, interpolateP,
  shrinkBySkill, indicatorSnapshot, bands,
} from '../model.js';
import { buildModel, forecastFrom } from '../forecast.js';
import { garchPath, rng, normal } from './synthetic.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('sma and ema match hand-computed values', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).slice(2), [2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5, 6], 3); // seed = mean(1,2,3) = 2, k = 0.5
  assert.ok(Number.isNaN(e[1]));
  assert.deepEqual(e.slice(2), [2, 3, 4, 5]);
  // Leading NaNs are skipped.
  const e2 = ema([NaN, NaN, 1, 2, 3, 4], 3);
  assert.deepEqual(e2.slice(4), [2, 3]);
});

test('rsi: all-up is 100, all-down is 0, flat is 50', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up).at(-1), 100);
  const down = up.slice().reverse();
  close(rsi(down).at(-1), 0, 1e-9);
  assert.equal(rsi(new Array(30).fill(5)).at(-1), 50);
});

test('macd histogram is positive in a steady climb', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 * 1.01 ** i);
  const m = macd(up);
  assert.ok(m.line.at(-1) > 0);
  assert.ok(m.hist.at(-1) > 0);
});

test('bollinger %B is 0.5 at the middle and above 1 past the upper band', () => {
  const vals = [...new Array(19).fill(10), 10];
  assert.equal(bollinger(vals).pctB.at(-1), 0.5);
  const b = bollinger([...Array.from({ length: 19 }, (_, i) => (i % 2 ? 9 : 11)), 20]);
  assert.ok(b.pctB.at(-1) > 1, 'a jump far above recent prices is above the band');
});

test('GARCH fit recovers known parameters', () => {
  const c = garchPath({ n: 6000, omega: 2e-7, alpha: 0.08, beta: 0.9, seed: 11 });
  const m = fitGarch(logReturns(c.map((x) => x.c)));
  assert.equal(m.kind, 'garch');
  close(m.alpha, 0.08, 0.04, 'alpha');
  close(m.beta, 0.9, 0.05, 'beta');
  close(m.alpha + m.beta, 0.98, 0.02, 'persistence');
});

test('variance forecasts: steps decay to the long-run level and sum to the total', () => {
  const m = { kind: 'garch', omega: 1e-6, alpha: 0.1, beta: 0.8, longRun: 1e-5 };
  const steps = stepVariances(m, 4e-5, 200);
  close(steps.at(-1), 1e-5, 1e-7, 'long run');
  close(steps.reduce((s, v) => s + v, 0), cumVariance(m, 4e-5, 200), 1e-12, 'sum');
  const ew = { kind: 'ewma', omega: 0, alpha: 0.06, beta: 0.94, longRun: 1e-5 };
  assert.equal(cumVariance(ew, 2e-5, 24), 24 * 2e-5);
});

test('filterVariance uses only earlier returns', () => {
  const m = { kind: 'garch', omega: 1e-6, alpha: 0.1, beta: 0.8, longRun: 1e-5 };
  const r = [0.01, -0.02, 0.03];
  const a = filterVariance(m, r);
  const b = filterVariance(m, [...r.slice(0, 2), 0.5]);
  assert.deepEqual(a.slice(0, 3), b.slice(0, 3), 'changing r[2] must not change sig2[0..2]');
  assert.notEqual(a[3], b[3]);
});

test('ranges are calibrated on simulated GARCH data', () => {
  // Out of sample: fit on the first part, check coverage on the rest.
  for (const h of [1, 24]) {
    const c = garchPath({ n: 5000, seed: 21 + h });
    const fit = fitSeries(c, { emaPeriods: [20, 50, 100, 200], quantileHorizons: [h], logitHorizons: [], fitEnd: 3000 });
    let n = 0;
    let in50 = 0;
    let in80 = 0;
    let in95 = 0;
    for (let p = 3000; p + h < c.length; p += h) {
      const f = predictAt(fit, p, h);
      const a = c[p + h].c;
      n++;
      if (a >= f.lo50 && a <= f.hi50) in50++;
      if (a >= f.lo80 && a <= f.hi80) in80++;
      if (a >= f.lo95 && a <= f.hi95) in95++;
    }
    const tol = h === 1 ? 0.04 : 0.1; // fewer independent windows at 24h
    close(in50 / n, 0.5, tol + 0.02, `50% band h=${h}`);
    close(in80 / n, 0.8, tol, `80% band h=${h}`);
    close(in95 / n, 0.95, tol / 2 + 0.02, `95% band h=${h}`);
  }
});

test('standardized quantiles are ordered and lean on the normal shape when data is scarce', () => {
  const c = garchPath({ n: 400, seed: 3 });
  const closes = c.map((x) => x.c);
  const r = logReturns(closes);
  const m = fitGarch(r);
  const q = standardizedQuantiles(closes, filterVariance(m, r), m, 24, closes.length - 1);
  for (let i = 1; i < q.length; i++) assert.ok(q[i] > q[i - 1]);
  close(q[0], -1.96, 0.5, 'mostly normal');
});

test('logistic regression learns a planted signal and stays near 50% on noise', () => {
  const rand = rng(5);
  const X = [];
  const y = [];
  for (let i = 0; i < 3000; i++) {
    const a = normal(rand);
    const b = normal(rand);
    X.push([a, b]);
    y.push(rand() < 1 / (1 + Math.exp(-1.5 * a)) ? 1 : 0);
  }
  const m = fitLogit(X, y, { l2: 0.01 });
  assert.ok(m.w[0] > 1, `signal weight ${m.w[0]}`);
  close(m.w[1], 0, 0.15, 'noise weight');
  assert.ok(predictLogit(m, [2, 0]) > 0.85);
  const tiny = fitLogit(X.slice(0, 20), y.slice(0, 20));
  assert.equal(predictLogit(tiny, [2, 0]), 0.5, 'too little data: no opinion');
});

test('backtest uses no future data', () => {
  const c = garchPath({ n: 1200, seed: 9 });
  const base = backtest(c, { emaPeriods: [20, 50, 100, 200], h: 4, origins: 30, refitEvery: 10 });
  // Wreck everything after the last tested window: results must not change.
  const lastNeeded = c.length - 1; // last origin + h
  const tampered = c.map((x, i) => (i > lastNeeded ? { ...x, c: x.c * 3 } : x));
  assert.deepEqual(backtest(tampered, { emaPeriods: [20, 50, 100, 200], h: 4, origins: 30, refitEvery: 10 }), base);
  // And a fit that ends at p ignores data after p.
  const p = 900;
  const f1 = fitSeries(c, { emaPeriods: [20, 50, 100, 200], quantileHorizons: [4], logitHorizons: [4], fitEnd: p });
  const later = c.map((x, i) => (i > p ? { ...x, c: x.c * (1 + 0.05 * Math.sin(i)) } : x));
  const f2 = fitSeries(later, { emaPeriods: [20, 50, 100, 200], quantileHorizons: [4], logitHorizons: [4], fitEnd: p });
  assert.deepEqual(predictAt(f1, p, 4), predictAt(f2, p, 4));
});

test('P(up) helpers', () => {
  close(interpolateP([[1, 0.6], [4, 0.4]], 2), 0.5, 1e-9, 'halfway in log time');
  assert.equal(interpolateP([[1, 0.6], [4, 0.4]], 10), 0.4);
  assert.equal(shrinkBySkill(0.7, 0.48), 0.5);
  close(shrinkBySkill(0.7, 0.55), 0.6, 1e-9);
  assert.equal(shrinkBySkill(0.7, 0.65), 0.7);
  assert.equal(shrinkBySkill(0.7, NaN), 0.5);
});

test('bands are ordered and centred on the price when there is no lean', () => {
  const b = bands(100, 0.02, [-1.96, -1.28, -0.67, 0.67, 1.28, 1.96], 0.5);
  assert.equal(b.mid, 100);
  const order = [b.lo95, b.lo80, b.lo50, b.hi50, b.hi80, b.hi95];
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1]);
  assert.ok(bands(100, 0.02, [-1, -1, -1, 1, 1, 1], 0.9).mid > 100);
});

test('indicator snapshot covers the EMAs and core indicators', () => {
  const d = garchPath({ n: 400, stepMs: 86400e3, omega: 2e-5, alpha: 0.1, beta: 0.85, seed: 4 });
  const snap = indicatorSnapshot(d);
  const keys = snap.rows.map((r) => r.key);
  for (const k of ['ema7', 'ema50', 'ema100', 'ema200', 'cross', 'rsi', 'macd', 'bb', 'volume', 'obv', 'atr']) {
    assert.ok(keys.includes(k), k);
  }
  for (const r of snap.rows) assert.ok([1, 0, -1].includes(r.vote));
});

test('full forecast: cards and paths widen with time and stay ordered', () => {
  const hourly = garchPath({ n: 2000, seed: 1 });
  const daily = garchPath({ n: 1000, stepMs: 86400e3, omega: 2e-5, alpha: 0.1, beta: 0.85, seed: 2 });
  const m = buildModel(hourly, daily);
  const price = hourly.at(-1).c;
  const f = forecastFrom(m, price, hourly.at(-1).t + 3600e3);
  const width = (b) => b.hi95 / b.lo95;
  assert.ok(width(f.cards['1h']) < width(f.cards['4h']));
  assert.ok(width(f.cards['4h']) < width(f.cards['24h']));
  assert.ok(width(f.cards['24h']) < width(f.cards['7d']));
  for (const path of [f.hourPath, f.dayPath]) {
    for (let i = 1; i < path.length; i++) assert.ok(width(path[i]) > width(path[i - 1]));
    for (const b of path) assert.ok(b.lo95 < b.lo80 && b.lo80 < b.lo50 && b.lo50 < b.mid && b.mid < b.hi50 && b.hi50 < b.hi80 && b.hi80 < b.hi95);
  }
  assert.equal(f.cards['24h'], f.hourPath.at(-1));
  for (const k of ['1h', '4h', '24h', '7d']) assert.ok(m.tests[k].count > 100, k);
});
