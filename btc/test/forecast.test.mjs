// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModel, forecastFrom, bandsAt, forecastBars, signalFor, MAX_HOURS, touchOdds, suggestLevels, plannerReplay,
} from '../forecast.js';
import { garchPath } from './synthetic.mjs';

const H = 3600e3;
const D = 24 * H;

const hourly = garchPath({ n: 2000, seed: 1 });
const daily = garchPath({ n: 1000, stepMs: D, omega: 2e-5, alpha: 0.1, beta: 0.85, seed: 2 });
const model = buildModel(hourly, daily);
const price = hourly[hourly.length - 1].c;
const now = hourly[hourly.length - 1].t + H;

const width = (b) => b.hi95 / b.lo95;
const sameBands = (a, b) => {
  for (const k of ['mid', 'lo95', 'lo80', 'lo50', 'hi50', 'hi80', 'hi95', 'pUp', 'sd']) assert.equal(a[k], b[k], k);
};

test('bandsAt matches the cards and saved paths at whole horizons', () => {
  const f = forecastFrom(model, price, now);
  sameBands(bandsAt(model, price, 1), f.cards['1h']);
  sameBands(bandsAt(model, price, 4), f.cards['4h']);
  sameBands(bandsAt(model, price, 24), f.cards['24h']);
  sameBands(bandsAt(model, price, 168), f.cards['7d']);
  f.dayPath.forEach((p) => sameBands(bandsAt(model, price, p.steps * 24), p));
});

test('ranges widen steadily with time, including between whole hours and days', () => {
  let prev = 0;
  for (const hours of [1 / 60, 0.25, 0.5, 1, 1.5, 3, 12, 23, 24, 30, 47, 48, 100, 167, 168]) {
    const w = width(bandsAt(model, price, hours));
    assert.ok(w > prev, `${hours}h: ${w} > ${prev}`);
    prev = w;
  }
  assert.equal(bandsAt(model, price, 500).sd, bandsAt(model, price, MAX_HOURS).sd, 'capped at 7 days');
});

test('forecastBars: one ghost candle per future candle, aligned to the timeframe', () => {
  const barOpen = Math.floor(now / (15 * 60e3)) * 15 * 60e3;
  const bars = forecastBars(model, price, now, barOpen, 15 * 60e3, 16);
  assert.equal(bars.length, 16);
  bars.forEach((b, i) => {
    assert.equal(b.t, barOpen + (i + 1) * 15 * 60e3);
    assert.equal(b.end, b.t + 15 * 60e3);
    assert.ok(b.lo95 < b.lo80 && b.lo80 < b.lo50 && b.lo50 < b.hi50 && b.hi50 < b.hi80 && b.hi80 < b.hi95);
    if (i) assert.ok(width(b) > width(bars[i - 1]));
  });
  // The bar ending 4 hours after the current one opened is the 4h forecast from then.
  sameBands(bars[15], bandsAt(model, price, (bars[15].end - now) / H));
});

test('forecastBars stops at 7 days: daily bars up to a week, none for weekly bars', () => {
  const dayOpen = Math.floor(now / D) * D;
  const days = forecastBars(model, price, now, dayOpen, D, 7);
  assert.ok(days.length >= 6 && days.length <= 7, `${days.length} daily ghost candles`);
  for (const b of days) assert.ok((b.end - now) / H <= MAX_HOURS);
  assert.equal(forecastBars(model, price, now, dayOpen, 7 * D, 3).length, 0);
});

test('signal: no edge when the model only matches "always guess up"', () => {
  // Right 57% of the time, but prices rose 57% of the time: no skill.
  const s = signalFor({ pUp: 0.6, replay: { hitRate: 0.57, ups: 0.57, called: 240 } });
  assert.equal(s.lean, 'none');
  assert.equal(s.source, 'replay');
  assert.ok(Math.abs(s.baseline - 0.57) < 1e-12);
});

test('signal: leans buy or sell only with an edge and a lean', () => {
  const replay = { hitRate: 0.6, ups: 0.52, called: 240 };
  assert.equal(signalFor({ pUp: 0.56, replay }).lean, 'buy');
  assert.equal(signalFor({ pUp: 0.43, replay }).lean, 'sell');
  assert.equal(signalFor({ pUp: 0.51, replay }).lean, 'none', 'too close to 50/50');
  // A falling market sets a "always guess down" baseline too.
  assert.equal(signalFor({ pUp: 0.4, replay: { hitRate: 0.6, ups: 0.4, called: 240 } }).lean, 'none');
  assert.equal(signalFor({ pUp: 0.6, replay: { hitRate: NaN, ups: NaN, called: 0 } }).lean, 'none', 'no record');
});

test('signal: the live track record wins once it has enough checked predictions', () => {
  const replay = { hitRate: 0.62, ups: 0.5, called: 240 };
  const few = { count: 20, called: 20, hits: 8, ups: 10 };
  assert.equal(signalFor({ pUp: 0.6, replay, live: few }).source, 'replay', 'too few live checks');
  const poor = { count: 100, called: 80, hits: 41, ups: 55 };
  const s = signalFor({ pUp: 0.6, replay, live: poor });
  assert.equal(s.source, 'live');
  assert.equal(s.lean, 'none', 'live record shows no edge, so no lean even though the replay looked good');
  const good = { count: 100, called: 80, hits: 52, ups: 50 };
  assert.equal(signalFor({ pUp: 0.6, replay, live: good }).lean, 'buy');
  const oldFormat = { count: 100, called: 80, hits: 52 }; // track.json from before `ups` was saved
  assert.equal(signalFor({ pUp: 0.6, replay, live: oldFormat }).source, 'replay');
});

// ---------- Trade planner ----------

// A copy of the model with no direction lean, so long and short are mirror images.
const flat = { ...model, pUp: { '1h': 0.5, '4h': 0.5, '24h': 0.5, '7d': 0.5 } };

test('touchOdds: probabilities add up, and the same seed gives the same answer', () => {
  const lv = suggestLevels(model, price, 'long', 4);
  const a = touchOdds(model, { side: 'long', entry: price, ...lv, hours: 4 });
  const b = touchOdds(model, { side: 'long', entry: price, ...lv, hours: 4 });
  close(a.pTarget + a.pStop + a.pNeither, 1, 1e-9);
  assert.deepEqual(a, b);
  assert.equal(touchOdds(model, { side: 'long', entry: price, stop: price * 1.01, target: price * 1.02, hours: 4 }), null, 'a long needs its stop below the entry');
  assert.equal(touchOdds(model, { side: 'short', entry: price, stop: price * 0.99, target: price * 0.98, hours: 4 }), null, 'a short needs its stop above the entry');
});

test('touchOdds: equal distances with no lean are close to a coin flip', () => {
  const d = bandsAt(flat, price, 4).sd * price;
  const o = touchOdds(flat, { side: 'long', entry: price, stop: price - d, target: price + d, hours: 4, feePct: 0, n: 20000 });
  assert.ok(Math.abs(o.pTarget - o.pStop) < 0.03, `${o.pTarget} vs ${o.pStop}`);
  assert.ok(Math.abs(o.expR) < 0.04, `no fees, no lean: about zero (${o.expR})`);
});

test('touchOdds: a wider stop is hit less often, fees lower the expected result, longer windows reach more', () => {
  const d = bandsAt(flat, price, 4).sd * price;
  const base = { side: 'long', entry: price, target: price + d, hours: 4, feePct: 0 };
  const near = touchOdds(flat, { ...base, stop: price - 0.5 * d });
  const far = touchOdds(flat, { ...base, stop: price - 2 * d });
  assert.ok(far.pStop < near.pStop, `${far.pStop} < ${near.pStop}`);
  const fees = touchOdds(flat, { ...base, stop: price - d, feePct: 0.001 });
  const free = touchOdds(flat, { ...base, stop: price - d });
  assert.ok(fees.expR < free.expR - 0.05, `${fees.expR} < ${free.expR}`);
  const short = touchOdds(flat, { ...base, stop: price - d, hours: 1 });
  assert.ok(short.pNeither > free.pNeither, 'less time: more trades end with neither level reached');
});

test('suggestLevels: stop past the 80% range, target at the 50% edge, mirrored for a short', () => {
  for (const h of [1, 4, 24]) {
    const b = bandsAt(model, price, h);
    const L = suggestLevels(model, price, 'long', h);
    const S = suggestLevels(model, price, 'short', h);
    assert.ok(L.stop <= b.lo80 && L.stop > b.lo95 && L.target >= b.hi50 && L.target < b.hi80, `long ${h}h`);
    assert.ok(S.stop >= b.hi80 && S.stop < b.hi95 && S.target <= b.lo50 && S.target > b.lo80, `short ${h}h`);
  }
});

test('plannerReplay: the predicted odds match what happened on the GARCH path', () => {
  const r = plannerReplay(model);
  for (const key of ['4h', '24h']) {
    const x = r[key];
    assert.ok(x.n >= 300, `${key}: ${x.n} trades`);
    close(x.target + x.stop + x.neither, 1, 1e-9);
    assert.ok(Math.abs(x.target - x.predTarget) < 0.08, `${key} target first: ${x.target} vs ${x.predTarget}`);
    assert.ok(Math.abs(x.stop - x.predStop) < 0.08, `${key} stop first: ${x.stop} vs ${x.predStop}`);
  }
});

function close(a, b, tol) {
  assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
}

// ---------- Replays ----------

test('replays reach back at most 30 days; 4h windows don\'t overlap', () => {
  const lastClose = hourly[hourly.length - 1].t + H;
  const dayClose = daily[daily.length - 1].t + D;
  const r4 = model.tests['4h'].rows;
  assert.ok(r4.length > 150);
  r4.slice(1).forEach((x, i) => {
    assert.equal(x.t - r4[i].t, 4 * H, 'every 4 hours');
    assert.ok(x.t >= r4[i].target, 'no shared window');
  });
  assert.ok(lastClose - r4[0].t <= 30 * D, '4h: within 30 days');
  const r7 = model.tests['7d'].rows;
  assert.equal(r7.length, 23);
  assert.ok(dayClose - r7[0].t <= 30 * D && r7.at(-1).target <= dayClose, '7d: made within 30 days, all checked');
  assert.ok(lastClose - model.tests['24h'].rows[0].t <= 30 * D, '24h: within 30 days');
});
