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
