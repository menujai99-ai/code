// The 1-hour up/down model chosen by btc/scripts/research.mjs: a logistic
// regression on price, indicator, taker-flow, multi-span return, range,
// volatility-regime, time-of-day and long-trend features, trained on years of
// hourly candles. The background job trains it (it can fetch years of data;
// a phone can't) and publishes it as direction.json; the app applies it to its
// own recent candles. Research, job and app all use the functions here, so
// what ships is exactly what was tested.

import { fitGarch, filterVariance, logReturns, buildFeatures, FEATURE_NAMES, fitLogit, predictLogit, ema } from './model.js';
import { HOURLY_EMAS } from './forecast.js';

const H = 3600e3;
export const DIRECTION_V = 1; // bump when the features or their order change
export const DIRECTION_L2 = 1;
export const DIRECTION_MAX_AGE = 7 * 24 * H; // older than this: the app falls back to its own model
export const LONG_EMAS = [1200, 4800]; // ~50 and ~200 days, in hours
export const DIRECTION_HOURS = 31300; // history the job trains on (~3.6 years)
export const DIRECTION_MIN_HOURS = 6000; // less than this and the long averages can't be trusted

// What the research found on its untouched test year (see btc/README.md).
export const RESEARCH_1H = {
  from: '2025-11-05', to: '2026-11-05', n: 8760,
  right: 0.5203, // calls made (P(up) at least 0.5 points from 50%; 84% of hours)
  baseline: 0.5012, // always guessing the usual direction, same hours
  oldModel: 0.5128, // the app's previous 1h model, same year
  cutoff: 0.005,
};
export const RESEARCH_24H = { from: '2025-11-05', to: '2026-11-05', oldModel: 0.4857 };

// ---------- Features ----------
// Every value at candle p uses only candles up to and including p. sig2 is
// the GARCH variance series; emaLong the 1,200h and 4,800h averages.

export function directionFeatures(candles, sig2, emaLong) {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const cols = [];
  const col = (group, name, fill) => {
    const v = new Float64Array(n).fill(NaN);
    for (let p = 0; p < n; p++) v[p] = fill(p);
    cols.push({ group, name, v });
  };
  const sd = (p) => Math.sqrt(sig2[Math.max(p - 1, 0)]); // one-step sd known at candle p

  // The app's original 12 (price, indicators, volume).
  const base = buildFeatures(candles, sig2, HOURLY_EMAS);
  FEATURE_NAMES.forEach((name, j) => col('base', name, (p) => (base[p] ? base[p][j] : NaN)));

  // Taker-buy share (who pushed) over the last 1/4/24 hours, against the past
  // week. Without taker data (Coinbase, Kraken) the share is flat: 0, neutral.
  const share = candles.map((c) => (c.vb > 0 && Number.isFinite(c.tb) ? c.tb / c.vb : 0.5));
  const pre = [0];
  const pre2 = [0];
  for (const x of share) {
    pre.push(pre[pre.length - 1] + x);
    pre2.push(pre2[pre2.length - 1] + x * x);
  }
  const mean = (a, b) => (pre[b + 1] - pre[a]) / (b - a + 1);
  for (const k of [1, 4, 24]) {
    col('flow', `taker buys ${k}h`, (p) => {
      if (p < 168 + k) return NaN;
      const m = mean(p - 168, p - 1);
      const v = (pre2[p] - pre2[p - 168]) / 168 - m * m;
      return v > 1e-12 ? (mean(p - k + 1, p) - m) / Math.sqrt(v / k) : 0;
    });
  }

  // Returns over several spans, in sds.
  for (const k of [1, 3, 6, 12, 24, 72, 168]) {
    col('returns', `return ${k}h`, (p) => (p >= k ? Math.log(closes[p] / closes[p - k]) / (sd(p) * Math.sqrt(k)) : NaN));
  }

  // Where the price sits in the last 24 hours' range.
  col('range', '24h range position', (p) => {
    if (p < 23) return NaN;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = p - 23; j <= p; j++) {
      lo = Math.min(lo, candles[j].l);
      hi = Math.max(hi, candles[j].h);
    }
    return hi > lo ? (closes[p] - lo) / (hi - lo) - 0.5 : 0;
  });

  // Calm or wild market, and momentum in each.
  const lsd = Array.from({ length: n }, (_, p) => Math.log(sd(p)));
  const lpre = [0];
  for (const x of lsd) lpre.push(lpre[lpre.length - 1] + x);
  const regime = (p) => (p >= 720 ? lsd[p] - (lpre[p] - lpre[p - 720]) / 720 : NaN);
  col('regime', 'volatility regime', regime);
  col('regime', 'regime × 24h return', (p) => (p >= 720 ? regime(p) * Math.log(closes[p] / closes[p - 24]) / (sd(p) * Math.sqrt(24)) : NaN));

  // Hour of day and day of week (UTC, at the candle's close).
  const when = (p) => new Date(candles[p].t + H);
  col('time', 'hour sin', (p) => Math.sin((2 * Math.PI * when(p).getUTCHours()) / 24));
  col('time', 'hour cos', (p) => Math.cos((2 * Math.PI * when(p).getUTCHours()) / 24));
  col('time', 'weekday sin', (p) => Math.sin((2 * Math.PI * when(p).getUTCDay()) / 7));
  col('time', 'weekday cos', (p) => Math.cos((2 * Math.PI * when(p).getUTCDay()) / 7));

  // Long trend: price against ~50-day and ~200-day averages.
  col('trend', 'vs 50-day average', (p) => Math.log(closes[p] / emaLong[0][p]) / sd(p));
  col('trend', 'vs 200-day average', (p) => Math.log(closes[p] / emaLong[1][p]) / sd(p));
  return cols;
}

const rowAt = (cols, p) => {
  const x = cols.map((c) => c.v[p]);
  return x.every(Number.isFinite) ? x : null;
};

// ---------- Training (background job, research) ----------

// Trains on finished hourly candles up to index `end` (every hour whose next
// hour had closed by then). The result is everything the app needs to apply
// the model to its own candles: the GARCH volatility parameters, the state of
// the long averages at the last candle, and the regression.
export function trainDirection(hourly, { end = hourly.length - 1, l2 = DIRECTION_L2 } = {}) {
  const closes = hourly.map((c) => c.c);
  const returns = logReturns(closes);
  const garch = fitGarch(returns.slice(0, end));
  const sig2 = filterVariance(garch, returns);
  const emaLong = LONG_EMAS.map((p) => ema(closes, p));
  const cols = directionFeatures(hourly, sig2, emaLong);
  const X = [];
  const y = [];
  for (let p = 0; p < end; p++) {
    const x = rowAt(cols, p);
    if (!x) continue;
    X.push(x);
    y.push(closes[p + 1] > closes[p] ? 1 : 0);
  }
  const fit = fitLogit(X, y, { l2 });
  return {
    version: DIRECTION_V,
    horizon: '1h',
    lastT: hourly[end].t, // the last candle trained on (its open time)
    garch,
    ema: emaLong.map((e) => e[end]),
    names: cols.map((c) => c.name),
    w: fit.w, b: fit.b, means: fit.means, sds: fit.sds,
    l2,
    trainedOn: { from: hourly[0].t, to: hourly[end].t, rows: X.length },
  };
}

// ---------- Applying it (app, job) ----------

// P(next hour closes higher) at the close of every candle from the model's
// last training candle on: [{ t (decision time = that candle's close), pUp }].
// None of these hours were trained on. `hourly` are finished candles that must
// include the model's last training candle (else null: too old or too new).
export function directionSeries(model, hourly) {
  if (!model || model.version !== DIRECTION_V) return null;
  const k0 = hourly.findIndex((c) => c.t === model.lastT);
  if (k0 < 0) return null;
  const closes = hourly.map((c) => c.c);
  const sig2 = filterVariance(model.garch, logReturns(closes));
  // Roll the published long averages forward over the newer candles.
  const emaLong = LONG_EMAS.map((period, j) => {
    const e = new Array(hourly.length).fill(NaN);
    const k = 2 / (period + 1);
    e[k0] = model.ema[j];
    for (let p = k0 + 1; p < hourly.length; p++) e[p] = closes[p] * k + e[p - 1] * (1 - k);
    return e;
  });
  const cols = directionFeatures(hourly, sig2, emaLong);
  const out = [];
  for (let p = k0; p < hourly.length; p++) {
    const x = rowAt(cols, p);
    if (x) out.push({ t: hourly[p].t + H, pUp: predictLogit(model, x) });
  }
  return out;
}

// An honest replay of the last `hours` hours: trained only on what came
// before them, then applied to each. For the app's "Replayed" history.
export function directionReplay(hourly, hours = 240) {
  const end = hourly.length - 1 - hours;
  const model = trainDirection(hourly, { end });
  return (directionSeries(model, hourly) || [])
    .filter((r) => r.t <= hourly[hourly.length - 1].t) // outcome known
    .map((r) => ({ t: r.t, pUp: Math.round(r.pUp * 1e5) / 1e5 }));
}
