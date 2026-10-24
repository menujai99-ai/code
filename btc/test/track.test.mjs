// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, forecastFrom } from '../forecast.js';
import {
  predictionEntry, cardsOf, priceAt, scoreHistory, tally, predictionRows, trimLog, parseLines,
} from '../track.js';
import { garchPath } from './synthetic.mjs';

const M = 60e3;
const H = 3600e3;
const D = 24 * H;

const hourly = garchPath({ n: 2000, seed: 1 });
const daily = garchPath({ n: 1000, stepMs: D, omega: 2e-5, alpha: 0.1, beta: 0.85, seed: 2 });
const model = buildModel(hourly, daily);
const price = hourly[hourly.length - 1].c;
const now = hourly[hourly.length - 1].t + H;

test('a saved prediction keeps every number shown, and gives the same cards back', () => {
  const f = forecastFrom(model, price, now);
  const entry = predictionEntry(f.cards, price, now, 'device');
  assert.deepEqual(Object.keys(entry.h), ['1h', '4h', '24h', '7d']);
  assert.deepEqual(Object.keys(entry.h['1h']).sort(), ['hi50', 'hi80', 'hi95', 'lo50', 'lo80', 'lo95', 'mid', 'pUp', 'target'].sort());
  assert.equal(entry.h['4h'].target, now + 4 * H);
  // The app shows a reopened prediction from its saved copy: it must match.
  const back = JSON.parse(JSON.stringify(entry));
  const cards = cardsOf(back);
  for (const key of ['1h', '4h', '24h', '7d']) {
    for (const k of ['t', 'mid', 'lo50', 'hi50', 'lo80', 'hi80', 'lo95', 'hi95', 'pUp']) assert.equal(cards[key][k], f.cards[key][k], `${key}.${k}`);
  }
});

test('priceAt works on 15-minute candles too', () => {
  const step = 15 * M;
  const candles = [{ t: 0, c: 100 }, { t: step, c: 110 }, { t: 2 * step, c: 120 }];
  assert.equal(priceAt(candles, step, step), 100); // first candle closes at 15 min
  assert.equal(priceAt(candles, 1.5 * step, step), 105);
  assert.equal(priceAt(candles, 3 * step, step), 120);
  assert.equal(priceAt(candles, 4 * step, step), null);
});

test('predictions that matured while the app was closed are checked on the next pass, once', () => {
  const step = 15 * M;
  const t0 = Date.UTC(2026, 9, 20, 10);
  const candles = Array.from({ length: 40 }, (_, i) => ({ t: t0 + i * step, c: 100 + i }));
  const p = (target) => ({ target, mid: 100, lo50: 99, hi50: 120, lo80: 95, hi80: 130, lo95: 90, hi95: 140, pUp: 0.6 });
  const history = [
    { t: t0 + 7 * M, price: 100, source: 'device', h: { '1h': p(t0 + 67 * M), '24h': p(t0 + 7 * M + D) } },
    { t: t0 + 20 * M, price: 101, source: 'device', h: { '1h': p(t0 + 80 * M) } },
  ];
  // At 11:25 the last closed candle ends at 11:15: the 1h prediction from 10:07
  // (due 11:07) can be checked, the one from 10:20 (due 11:20) can't yet.
  const closedBy = (t) => candles.filter((c) => c.t + step <= t);
  const first = scoreHistory(history, [], closedBy(t0 + 85 * M), t0 + 85 * M, step);
  assert.deepEqual(first.map((s) => `${s.t}|${s.h}`), [`${t0 + 7 * M}|1h`]);
  close(first[0].actual, priceAt(candles, t0 + 67 * M, step));
  assert.ok(first[0].hit, 'went up as called');
  // Hours later (app reopened): the rest of what's due, and nothing twice.
  const second = scoreHistory(history, first, closedBy(t0 + 9 * H), t0 + 9 * H, step);
  assert.deepEqual(second.map((s) => `${s.t}|${s.h}`), [`${t0 + 20 * M}|1h`]);
  assert.equal(scoreHistory(history, [...first, ...second], closedBy(t0 + 9 * H), t0 + 9 * H, step).length, 0);
});

test('predictionRows joins each prediction with its score, oldest target first', () => {
  const hist = [
    { t: 3, price: 10, h: { '1h': { target: 30, mid: 1 } } },
    { t: 1, price: 10, h: { '1h': { target: 10, mid: 1 }, '4h': { target: 40, mid: 1 } } },
    { t: 2, price: 10, h: { '4h': { target: 50, mid: 1 } } },
  ];
  const rows = predictionRows(hist, [{ t: 1, h: '1h', actual: 11 }], '1h');
  assert.deepEqual(rows.map((r) => r.target), [10, 30]);
  assert.equal(rows[0].score.actual, 11);
  assert.equal(rows[1].score, null, 'still waiting');
  assert.equal(rows[0].price, 10);
});

test('tally counts ranges, calls and ups', () => {
  const s = (o) => ({ in50: false, in80: false, in95: false, called: true, hit: false, price: 100, actual: 99, ...o });
  const t = tally([s({ in50: true, in80: true, in95: true, hit: true, actual: 101 }), s({ in95: true }), s({ called: false })]);
  assert.deepEqual(t, { count: 3, in50: 1, in80: 1, in95: 2, called: 2, hits: 1, ups: 1 });
});

test('trimLog keeps the newest predictions within the age and count limits, with their scores', () => {
  const now = 100 * D;
  const history = Array.from({ length: 10 }, (_, i) => ({ t: now - (9 - i) * 10 * D, h: {} }));
  const scores = history.map((r) => ({ t: r.t, h: '1h' }));
  const aged = trimLog(history, scores, now, { maxAge: 35 * D });
  assert.deepEqual(aged.history.map((r) => (now - r.t) / D), [30, 20, 10, 0]);
  assert.equal(aged.scores.length, 4);
  const counted = trimLog(history, scores, now, { maxEntries: 2 });
  assert.deepEqual(counted.history.map((r) => (now - r.t) / D), [10, 0]);
  assert.deepEqual(counted.scores.map((s) => s.t), counted.history.map((r) => r.t));
});

test('parseLines skips damaged lines', () => {
  assert.deepEqual(parseLines('{"a":1}\nnot json\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseLines(''), []);
});

function close(a, b) {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
}
