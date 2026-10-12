// Puts the model together for the app: fits the hourly and daily series,
// backtests each horizon, and turns it all into price ranges from a live price.

import {
  fitSeries, backtest, pUpAt, shrinkBySkill, interpolateP, bands, cumVariance, stepVariances,
} from './model.js';

export const HOURLY_EMAS = [20, 50, 100, 200]; // hours
export const DAILY_EMAS = [7, 50, 100, 200]; // days
export const HOUR_PATH = [4, 8, 12, 16, 20, 24]; // hours ahead, saved by the background job
export const DAY_PATH = [1, 2, 3, 4, 5, 6, 7]; // days ahead
export const MAX_HOURS = 168; // forecasts reach 7 days
const HOUR_MS = 3600e3;
const EVERY_HOUR = Array.from({ length: 24 }, (_, i) => i + 1);

export const HORIZONS = [
  { key: '1h', label: 'Next hour', hours: 1 },
  { key: '4h', label: 'Next 4 hours', hours: 4 },
  { key: '24h', label: 'Next 24 hours', hours: 24 },
  { key: '7d', label: 'Next 7 days', hours: 168 },
];

// hourly / daily: finished candles only, oldest first.
export function buildModel(hourly, daily) {
  const hFit = fitSeries(hourly, {
    emaPeriods: HOURLY_EMAS,
    quantileHorizons: EVERY_HOUR,
    logitHorizons: [1, 4, 24],
  });
  const dFit = fitSeries(daily, {
    emaPeriods: DAILY_EMAS,
    quantileHorizons: DAY_PATH.slice(1),
    logitHorizons: [7],
  });
  const tests = {
    '1h': backtest(hourly, { emaPeriods: HOURLY_EMAS, h: 1 }),
    '4h': backtest(hourly, { emaPeriods: HOURLY_EMAS, h: 4 }),
    '24h': backtest(hourly, { emaPeriods: HOURLY_EMAS, h: 24, spacing: 3 }),
    '7d': backtest(daily, { emaPeriods: DAILY_EMAS, h: 7 }),
  };
  const hLast = hourly.length - 1;
  const dLast = daily.length - 1;
  const raw = {
    '1h': pUpAt(hFit, hLast, 1),
    '4h': pUpAt(hFit, hLast, 4),
    '24h': pUpAt(hFit, hLast, 24),
    '7d': pUpAt(dFit, dLast, 7),
  };
  const pUp = {};
  for (const k of Object.keys(raw)) pUp[k] = shrinkBySkill(raw[k], tests[k].hitRate);
  return { hFit, dFit, hLast, dLast, tests, raw, pUp };
}

// Blend two range shapes (quantile lists) by fraction f.
const blend = (a, b, f) => a.map((q, i) => q + f * (b[i] - q));

// Price ranges for any time `hours` ahead (about a minute up to 7 days).
// Up to a day the hourly model sets the width; beyond that each extra day adds
// the daily model's variance for that day (pro rata within a day). Shapes are
// blended between whole hours and days so the cone widens smoothly.
export function bandsAt(m, price, hours) {
  const { hFit, dFit, hLast, dLast, pUp } = m;
  const H = Math.min(Math.max(hours, 1 / 60), MAX_HOURS);
  if (H <= 24) {
    const v = cumVariance(hFit.model, hFit.sig2[hLast], H);
    const lo = Math.min(23, Math.max(1, Math.floor(H)));
    const shape = blend(hFit.shapes[lo], hFit.shapes[lo + 1], Math.min(1, Math.max(0, H - lo)));
    const p = interpolateP([[1, pUp['1h']], [4, pUp['4h']], [24, pUp['24h']]], H);
    return bands(price, Math.sqrt(v), shape, p);
  }
  const days = H / 24;
  const whole = Math.floor(days);
  const daySteps = stepVariances(dFit.model, dFit.sig2[dLast], 8);
  let v = cumVariance(hFit.model, hFit.sig2[hLast], 24);
  for (let j = 1; j < whole; j++) v += daySteps[j];
  v += (days - whole) * daySteps[whole];
  const shape = whole < 2
    ? blend(hFit.shapes[24], dFit.shapes[2], days - 1)
    : blend(dFit.shapes[whole], dFit.shapes[Math.min(7, whole + 1)], whole < 7 ? days - whole : 0);
  const p = interpolateP([[1, pUp['24h']], [7, pUp['7d']]], days);
  return bands(price, Math.sqrt(v), shape, p);
}

// Ranges for the horizon cards and the saved paths, anchored on `price` at `now`.
export function forecastFrom(m, price, now) {
  const at = (hours) => ({ t: now + hours * HOUR_MS, ...bandsAt(m, price, hours) });
  const hourPath = HOUR_PATH.map((h) => ({ ...at(h), steps: h }));
  const dayPath = DAY_PATH.map((k) => ({ ...at(k * 24), steps: k }));
  const cards = { '1h': at(1), '4h': hourPath[0], '24h': hourPath[hourPath.length - 1], '7d': dayPath[dayPath.length - 1] };
  return { price, now, cards, hourPath, dayPath };
}

// Ghost candles for the chart: one for each future candle of length stepMs
// after the candle that opened at barOpen, up to maxBars and 7 days ahead.
// Each covers the price expected when that candle closes.
export function forecastBars(m, price, now, barOpen, stepMs, maxBars) {
  const out = [];
  for (let k = 1; k <= maxBars; k++) {
    const t = barOpen + k * stepMs;
    const end = t + stepMs;
    const hours = (end - now) / HOUR_MS;
    if (hours > MAX_HOURS) break;
    out.push({ t, end, hours, ...bandsAt(m, price, hours) });
  }
  return out;
}

// ---------- Buy / sell signal ----------
// The app only leans buy or sell when the direction model has a record of
// beating the simplest rule — "always guess whichever direction is more
// common" — and it currently leans away from 50/50. Otherwise: no clear edge.

export const SIGNAL_MIN_EDGE = 0.02; // beat the baseline by at least 2 points
export const SIGNAL_MIN_LEAN = 0.03; // and lean at least 3 points away from 50%
export const SIGNAL_MIN_LIVE = 30; // checked live predictions before trusting them over the replay

// pUp: chance of going up now. replay: the backtest row (hitRate, ups share,
// called). live: the background job's track row (hits, called, ups, count), if any.
export function signalFor({ pUp, replay, live }) {
  const useLive = live && live.called >= SIGNAL_MIN_LIVE && live.count > 0 && Number.isFinite(live.ups);
  const ev = useLive
    ? { source: 'live', n: live.called, right: live.hits / live.called, upShare: live.ups / live.count }
    : { source: 'replay', n: replay?.called ?? 0, right: replay?.hitRate ?? NaN, upShare: replay?.ups ?? NaN };
  const baseline = Math.max(ev.upShare, 1 - ev.upShare);
  const edge = ev.right - baseline;
  const leans = Math.abs(pUp - 0.5) >= SIGNAL_MIN_LEAN;
  const lean = Number.isFinite(edge) && edge >= SIGNAL_MIN_EDGE && leans ? (pUp > 0.5 ? 'buy' : 'sell') : 'none';
  return { lean, pUp, ...ev, baseline, edge };
}

// ---------- Trade planner ----------
// Turns the ranges into trade numbers: for a stop and a target, how often the
// price reaches the target first, the stop first, or neither within the time
// window, and what that is worth after fees. Price paths are simulated in
// 5-minute steps. Each hour's move is drawn from Bitcoin's own past hourly
// moves (in units of the volatility expected at the time, so the big
// surprises are kept), scaled by the GARCH forecast for that hour, and filled
// in within the hour as a random walk that ends on that move.

export const PLAN_HOURS = [1, 4, 24];
const SUB_STEPS = 12; // 5-minute steps per hour
// Prices are only looked at every 5 minutes, which misses some touches in
// between; moving each level closer by 0.5826 step sds corrects for that
// (Broadie, Glasserman & Kou, 1997).
const TOUCH_SHIFT = 0.5826;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Past hourly moves in units of the sd expected at the time, rescaled to mean 0
// and sd 1 (the lean and the size come from the model, the shape from here).
function shockPool(m) {
  if (m.pool) return m.pool;
  const { closes, sig2 } = m.hFit;
  const z = [];
  for (let i = 1; i <= m.hLast; i++) {
    if (sig2[i - 1] > 0) z.push(Math.log(closes[i] / closes[i - 1]) / Math.sqrt(sig2[i - 1]));
  }
  const mean = z.reduce((s, x) => s + x, 0) / z.length;
  const sd = Math.sqrt(z.reduce((s, x) => s + (x - mean) ** 2, 0) / z.length) || 1;
  m.pool = Float64Array.from(z, (x) => (x - mean) / sd);
  return m.pool;
}

// Simulates `n` paths and scores one trade on them. vars: the variance of each
// hour's log move; mu: the total expected log move (the model's lean).
function simulateTrade({ vars, mu, pool, dir, entry, stop, target, feePct, n, rand }) {
  const total = vars.reduce((s, v) => s + v, 0);
  const lnStop = Math.log(stop / entry);
  const lnTarget = Math.log(target / entry);
  const levels = vars.map((v) => {
    const shift = TOUCH_SHIFT * Math.sqrt(v / SUB_STEPS);
    return {
      stop: lnStop + dir * Math.min(shift, Math.abs(lnStop) / 2),
      target: lnTarget - dir * Math.min(shift, Math.abs(lnTarget) / 2),
    };
  });
  const risk = Math.abs(entry - stop) + feePct * (entry + stop); // loss at the stop, fees included
  const e = new Float64Array(SUB_STEPS);
  let hitT = 0;
  let hitS = 0;
  let sumR = 0;
  for (let k = 0; k < n; k++) {
    let x = 0;
    let out = 0;
    for (let h = 0; h < vars.length && !out; h++) {
      const move = Math.sqrt(vars[h]) * pool[Math.floor(rand() * pool.length)] + (mu * vars[h]) / total;
      const sub = Math.sqrt(vars[h] / SUB_STEPS);
      let sum = 0;
      for (let j = 0; j < SUB_STEPS; j += 2) {
        const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12)));
        const a = 2 * Math.PI * rand();
        e[j] = sub * r * Math.cos(a);
        e[j + 1] = sub * r * Math.sin(a);
        sum += e[j] + e[j + 1];
      }
      const fix = (move - sum) / SUB_STEPS; // make the hour end on its drawn move
      const lv = levels[h];
      for (let j = 0; j < SUB_STEPS; j++) {
        x += e[j] + fix;
        if (dir * (x - lv.stop) <= 0) { out = -1; break; }
        if (dir * (x - lv.target) >= 0) { out = 1; break; }
      }
    }
    const exit = out > 0 ? target : out < 0 ? stop : entry * Math.exp(x);
    if (out > 0) hitT++;
    else if (out < 0) hitS++;
    sumR += (dir * (exit - entry) - feePct * (entry + exit)) / risk;
  }
  return { pTarget: hitT / n, pStop: hitS / n, pNeither: (n - hitT - hitS) / n, expR: sumR / n, risk };
}

const validTrade = (dir, entry, stop, target) =>
  entry > 0 && stop > 0 && target > 0 && dir * (target - entry) > 0 && dir * (entry - stop) > 0;

// Odds and expected result for one trade, entered now at `entry` and closed at
// the target, the stop, or the market price when the window ends.
// expR is in units of the planned loss (R), fees included; `risk` is the loss
// per BTC at the stop, fees included, so position size = amount ÷ risk.
export function touchOdds(m, { side = 'long', entry, stop, target, hours, feePct = 0.001, n = 4000, seed = 1 }) {
  const dir = side === 'short' ? -1 : 1;
  if (!validTrade(dir, entry, stop, target)) return null;
  const H = Math.min(Math.max(Math.round(hours), 1), 24);
  const vars = stepVariances(m.hFit.model, m.hFit.sig2[m.hLast], H);
  const mu = Math.log(bandsAt(m, entry, H).mid / entry);
  const res = simulateTrade({ vars, mu, pool: shockPool(m), dir, entry, stop, target, feePct, n, rand: seeded(seed) });
  return { ...res, rr: Math.abs(target - entry) / Math.abs(entry - stop), hours: H, side };
}

// Suggested levels: the stop just past the 80% range, where normal swings
// rarely reach, and the target at the edge of the 50% range in the trade's
// direction, a move that often happens within the window.
const levelsFrom = (b, dir) => (dir > 0
  ? { stop: Math.floor(b.lo80), target: Math.ceil(b.hi50) }
  : { stop: Math.ceil(b.hi80), target: Math.floor(b.lo50) });

export function suggestLevels(m, price, side, hours) {
  return levelsFrom(bandsAt(m, price, hours), side === 'short' ? -1 : 1);
}

// The planner replayed on past hours: at each start the suggested long and
// short are scored against what the hourly highs and lows did next. When the
// stop and the target both fall inside one candle the stop is counted, since
// the order isn't known. No direction lean is used, so this checks the odds
// that come from the ranges alone.
export function plannerReplay(m, { origins = 200, paths = 150, feePct = 0.001 } = {}) {
  const { candles, closes, model, sig2, shapes } = m.hFit;
  const pool = shockPool(m);
  const rand = seeded(11);
  const out = {};
  for (const H of PLAN_HOURS) {
    const spacing = H === 1 ? 1 : H === 4 ? 2 : 6;
    const last = m.hLast - H;
    const first = Math.max(250, last - (origins - 1) * spacing);
    const tally = { n: 0, predTarget: 0, predStop: 0, predR: 0, target: 0, stop: 0, neither: 0, r: 0 };
    for (let p = first; p <= last; p += spacing) {
      const entry = closes[p];
      const vars = stepVariances(model, sig2[p], H);
      const b = bands(entry, Math.sqrt(cumVariance(model, sig2[p], H)), shapes[H], 0.5);
      for (const dir of [1, -1]) {
        const { stop, target } = levelsFrom(b, dir);
        if (!validTrade(dir, entry, stop, target)) continue;
        const sim = simulateTrade({ vars, mu: 0, pool, dir, entry, stop, target, feePct, n: paths, rand });
        let res = 0;
        let exit = closes[p + H];
        for (let k = p + 1; k <= p + H; k++) {
          const c = candles[k];
          const stopHit = dir > 0 ? c.l <= stop : c.h >= stop;
          const targetHit = dir > 0 ? c.h >= target : c.l <= target;
          if (stopHit) { res = -1; exit = stop; break; }
          if (targetHit) { res = 1; exit = target; break; }
        }
        tally.n++;
        tally.predTarget += sim.pTarget;
        tally.predStop += sim.pStop;
        tally.predR += sim.expR;
        if (res > 0) tally.target++;
        else if (res < 0) tally.stop++;
        else tally.neither++;
        tally.r += (dir * (exit - entry) - feePct * (entry + exit)) / sim.risk;
      }
    }
    const k = Math.max(tally.n, 1);
    out[`${H}h`] = {
      n: tally.n,
      feePct,
      predTarget: tally.predTarget / k,
      predStop: tally.predStop / k,
      predR: tally.predR / k,
      target: tally.target / k,
      stop: tally.stop / k,
      neither: tally.neither / k,
      r: tally.r / k,
    };
  }
  return out;
}
