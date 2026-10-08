// Puts the model together for the app: fits the hourly and daily series,
// backtests each horizon, and turns it all into price ranges from a live price.

import {
  fitSeries, backtest, pUpAt, shrinkBySkill, interpolateP, bands, cumVariance, stepVariances,
} from './model.js';

export const HOURLY_EMAS = [20, 50, 100, 200]; // hours
export const DAILY_EMAS = [7, 50, 100, 200]; // days
export const HOUR_PATH = [4, 8, 12, 16, 20, 24]; // red candles in the Hours view
export const DAY_PATH = [1, 2, 3, 4, 5, 6, 7]; // red candles in the Days view

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
    quantileHorizons: [1, ...HOUR_PATH],
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

// Ranges for the horizon cards and both chart paths, anchored on `price` at `now`.
export function forecastFrom(m, price, now) {
  const { hFit, dFit, hLast, dLast, pUp } = m;
  const hourVar = (h) => cumVariance(hFit.model, hFit.sig2[hLast], h);
  const hourP = (h) => interpolateP([[1, pUp['1h']], [4, pUp['4h']], [24, pUp['24h']]], h);

  const hourPath = HOUR_PATH.map((h) => ({
    t: now + h * 3600e3,
    steps: h,
    ...bands(price, Math.sqrt(hourVar(h)), hFit.shapes[h], hourP(h)),
  }));

  // Day 1 comes from the hourly model (it sees intraday swings); later days add
  // the daily model's variance for each extra day.
  const daySteps = stepVariances(dFit.model, dFit.sig2[dLast], DAY_PATH.length);
  const dayPath = DAY_PATH.map((k) => {
    let v = hourVar(24);
    for (let j = 1; j < k; j++) v += daySteps[j];
    const shape = k === 1 ? hFit.shapes[24] : dFit.shapes[k];
    const p = interpolateP([[1, pUp['24h']], [7, pUp['7d']]], k);
    return { t: now + k * 86400e3, steps: k, ...bands(price, Math.sqrt(v), shape, p) };
  });

  const cards = {
    '1h': { t: now + 3600e3, ...bands(price, Math.sqrt(hourVar(1)), hFit.shapes[1], pUp['1h']) },
    '4h': hourPath[0],
    '24h': hourPath[hourPath.length - 1],
    '7d': dayPath[dayPath.length - 1],
  };
  return { price, now, cards, hourPath, dayPath };
}
