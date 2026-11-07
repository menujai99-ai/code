// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVariance, logReturns, ema, predictLogit } from '../model.js';
import {
  directionFeatures, trainDirection, directionSeries, directionReplay, LONG_EMAS, DIRECTION_V,
} from '../direction.js';
import { garchPath, rng } from './synthetic.mjs';

const H = 3600e3;

// ~9 months of hourly candles with taker-buy volume.
function hourlyWithFlow(n = 6500, seed = 4) {
  const rand = rng(seed);
  return garchPath({ n, seed }).map((c) => {
    const vb = c.v / c.c;
    return { ...c, vb, tb: vb * (0.45 + 0.1 * rand()) };
  });
}
const hourly = hourlyWithFlow();
const END = 6400;
const model = trainDirection(hourly, { end: END });

// The pipeline the model was trained with, on the full series.
function fullPipeline(candles, m) {
  const closes = candles.map((c) => c.c);
  const sig2 = filterVariance(m.garch, logReturns(closes));
  return directionFeatures(candles, sig2, LONG_EMAS.map((p) => ema(closes, p)));
}

test('the app, with only its last 2,000 candles, gets the trained model\'s probabilities', () => {
  assert.equal(model.version, DIRECTION_V);
  assert.equal(model.lastT, hourly[END].t);
  assert.ok(model.trainedOn.rows > 1000, `${model.trainedOn.rows} rows`);
  const cols = fullPipeline(hourly, model);
  const recent = hourly.slice(-2000);
  const series = directionSeries(model, recent);
  assert.equal(series.length, hourly.length - END, 'every candle from the last trained one on');
  assert.equal(series[0].t, hourly[END].t + H);
  for (const p of [END, END + 37, hourly.length - 1]) {
    const x = cols.map((c) => c.v[p]);
    const want = predictLogit(model, x);
    const got = series.find((r) => r.t === hourly[p].t + H).pUp;
    assert.ok(Math.abs(got - want) < 1e-4, `candle ${p}: ${got} vs ${want}`);
  }
});

test('features never use later candles', () => {
  const q = 6000;
  const tampered = hourly.map((c, i) => (i > q ? { ...c, c: c.c * 1.3, h: c.h * 1.3, l: c.l * 1.3, tb: c.vb * 0.9 } : c));
  const a = fullPipeline(hourly, model);
  const b = fullPipeline(tampered, model);
  a.forEach((col, j) => {
    for (const p of [q - 500, q - 1, q]) {
      if (Number.isFinite(col.v[p])) assert.equal(b[j].v[p], col.v[p], `${col.name} at ${p}`);
    }
  });
});

test('training uses nothing after its last candle', () => {
  const tampered = hourly.map((c, i) => (i > END ? { ...c, c: c.c * 0.7, h: c.h * 0.7, l: c.l * 0.7 } : c));
  const other = trainDirection(tampered, { end: END });
  assert.deepEqual(other.w, model.w);
  assert.equal(other.b, model.b);
  assert.deepEqual(other.ema, model.ema);
});

test('without taker data (Coinbase, Kraken) the flow features are neutral', () => {
  const plain = hourly.map(({ tb, ...c }) => c);
  const cols = fullPipeline(plain, model);
  for (const col of cols.filter((c) => c.group === 'flow')) {
    for (const p of [500, 3000, 6400]) assert.equal(col.v[p], 0, `${col.name} at ${p}`);
  }
  const series = directionSeries(model, plain.slice(-2000));
  assert.ok(series.every((r) => r.pUp > 0.3 && r.pUp < 0.7), 'still a sensible probability');
});

test('replay rows come from a model trained before them', () => {
  const rows = directionReplay(hourly, 240);
  const cut = hourly[hourly.length - 1 - 240].t; // the replay model's last training candle
  assert.equal(rows.length, 240);
  assert.ok(rows.every((r) => r.t > cut && r.t <= hourly[hourly.length - 1].t));
  assert.equal(rows[0].t, cut + H);
});

test('no probabilities when the model is the wrong version or doesn\'t overlap the candles', () => {
  assert.equal(directionSeries({ ...model, version: DIRECTION_V + 1 }, hourly), null);
  assert.equal(directionSeries(model, hourly.slice(END + 1)), null, 'last trained candle not in the data');
});
