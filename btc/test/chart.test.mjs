// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { horizonOffsets, MAX_MARKER_BARS } from '../chart.js';

const M = 60e3;
const H = 60 * M;
const at = [1, 4, 24].map((h) => h * H);

test('direction markers: where +1h/+4h/+24h fall on each timeframe', () => {
  const near = (step) => horizonOffsets(step, 0, at).map((o) => !o.far);
  assert.deepEqual(near(15 * M), [true, true, true], '15m: 4, 16, 96 candles ahead');
  assert.deepEqual(near(H), [true, true, true]);
  assert.deepEqual(near(5 * M), [true, true, false], '5m: +24h is 288 candles ahead');
  assert.deepEqual(near(M), [true, false, false]);
  assert.equal(horizonOffsets(4 * H, 0, at)[0].bars, 0.25, '+1h sits inside a 4h candle');
  assert.equal(horizonOffsets(15 * M, 5 * M, [H])[0].bars, 55 / 15, 'measured from the live candle open');
  assert.equal(MAX_MARKER_BARS, 150);
});
