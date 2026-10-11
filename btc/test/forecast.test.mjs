// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, forecastFrom, bandsAt, forecastBars, signalFor, MAX_HOURS } from '../forecast.js';
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
