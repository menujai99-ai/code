// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, priceAt, scoreHistory } from '../scripts/update.mjs';
import { garchPath } from './synthetic.mjs';

const H = 3600e3;
const D = 24 * H;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-fixture-'));
  const end = Date.UTC(2026, 9, 8, 12);
  const hourly = garchPath({ n: 2100, t0: end - 2099 * H, seed: 3 });
  let daily = garchPath({ n: 1000, stepMs: D, t0: Date.UTC(2026, 9, 8) - 999 * D, omega: 2e-5, alpha: 0.1, beta: 0.85, seed: 8 });
  const k = hourly.at(-1).c / daily.at(-1).c;
  daily = daily.map((c) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  fs.writeFileSync(path.join(dir, 'hourly.json'), JSON.stringify(hourly));
  fs.writeFileSync(path.join(dir, 'daily.json'), JSON.stringify(daily));
  return { dir, end, hourly };
}

test('priceAt reads between hourly closes', () => {
  const hourly = [{ t: 0, c: 100 }, { t: H, c: 200 }];
  assert.equal(priceAt(hourly, H), 100); // first candle closes at 1h
  assert.equal(priceAt(hourly, 1.5 * H), 150);
  assert.equal(priceAt(hourly, 2 * H), 200);
  assert.equal(priceAt(hourly, 3 * H), null);
});

test('updater writes a forecast, logs it, and scores predictions once they mature', async () => {
  const { dir, end, hourly } = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-out-'));
  const t1 = end - 30 * H + 7 * 60e3; // 30 hours before the data ends, at :07
  const first = await run({ out, fixture: dir, now: t1 });
  const forecast = JSON.parse(fs.readFileSync(path.join(out, 'forecast.json'), 'utf8'));
  assert.equal(forecast.generatedAt, t1);
  assert.deepEqual(Object.keys(forecast.cards), ['1h', '4h', '24h', '7d']);
  assert.ok(forecast.cards['24h'].lo95 < forecast.price && forecast.price < forecast.cards['24h'].hi95);
  assert.equal(first.fresh.length, 0, 'nothing has matured yet');

  const t2 = end - 2 * H + 7 * 60e3; // 28 hours later: 1h, 4h and 24h from run 1 have matured
  const second = await run({ out, fixture: dir, now: t2 });
  assert.deepEqual(second.fresh.map((s) => s.h).sort(), ['1h', '24h', '4h']);
  const s1h = second.fresh.find((s) => s.h === '1h');
  assert.equal(s1h.target, t1 + H);
  close(s1h.actual, priceAt(hourly, t1 + H));
  assert.equal(second.track.horizons['1h'].count, 1);
  assert.equal(second.track.horizons['7d'].count, 0);

  const third = await run({ out, fixture: dir, now: t2 + 30 * 60e3 });
  assert.equal(third.fresh.length, 0, 'no prediction is scored twice');
  assert.equal(fs.readFileSync(path.join(out, 'history.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(fs.readFileSync(path.join(out, 'scores.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('scoring counts ranges and direction', () => {
  const hourly = [{ t: 0, c: 100 }, { t: H, c: 110 }, { t: 2 * H, c: 120 }];
  const run1 = { t: H, price: 100, h: { '1h': { target: 2 * H, lo50: 105, hi50: 115, lo80: 100, hi80: 120, lo95: 90, hi95: 130, pUp: 0.6 } } };
  const [s] = scoreHistory([run1], [], hourly, 10 * H);
  assert.equal(s.actual, 110);
  assert.deepEqual([s.in50, s.in80, s.in95, s.called, s.hit], [true, true, true, true, true]);
});

function close(a, b) {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
}
