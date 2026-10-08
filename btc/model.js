// BTC Range model: indicators, volatility, direction and backtest.
// Pure functions with no DOM, so they run in the browser and under `node --test`.
//
// Candles are { t, o, h, l, c, v } with t = open time (ms) and v = volume in USD.
//
// How a forecast is made for a horizon of h steps:
// 1. Range width: a GARCH(1,1) model of the step-by-step log returns says how
//    volatile the next h steps are likely to be (sd of the h-step return).
// 2. Range shape: past h-step returns, each divided by the sd the model expected
//    at the time, give the real (fat-tailed, maybe lopsided) shape of the range.
// 3. Direction: a small logistic regression on the indicators gives P(up). It
//    nudges the middle of the range by at most TILT standard deviations.

export const LEVELS = [0.025, 0.1, 0.25, 0.75, 0.9, 0.975];
const NORMAL_Q = [-1.959964, -1.281552, -0.67449, 0.67449, 1.281552, 1.959964];
export const TILT = 0.25; // largest shift of the range centre, in sds (at P(up) 0 or 1)
const SHAPE_PRIOR = 30; // independent samples worth of trust in the normal shape

// ---------- Indicators ----------

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Exponential moving average, seeded with the simple average of the first
// `period` values. Leading NaNs (e.g. from another indicator) are skipped.
export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  let start = 0;
  while (start < values.length && !Number.isFinite(values[start])) start++;
  if (values.length - start < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i];
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const sig = ema(line, signal);
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const pctB = new Array(closes.length).fill(NaN);
  const width = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / period);
    const upper = mid[i] + mult * sd;
    const lower = mid[i] - mult * sd;
    pctB[i] = upper === lower ? 0.5 : (closes[i] - lower) / (upper - lower);
    width[i] = (upper - lower) / mid[i];
  }
  return { mid, pctB, width };
}

// Wilder's average true range.
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) =>
    i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c))
  );
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

// On-balance volume: running total of volume, added on up steps, taken on down steps.
export function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    out[i] = out[i - 1] + (d > 0 ? candles[i].v : d < 0 ? -candles[i].v : 0);
  }
  return out;
}

// How unusual each value is versus the `window` values before it, in sds.
export function rollingZ(values, window = 20) {
  const out = new Array(values.length).fill(NaN);
  for (let i = window; i < values.length; i++) {
    let s = 0;
    let ss = 0;
    for (let j = i - window; j < i; j++) {
      s += values[j];
      ss += values[j] * values[j];
    }
    const m = s / window;
    const sd = Math.sqrt(Math.max(ss / window - m * m, 0));
    out[i] = sd > 0 ? (values[i] - m) / sd : 0;
  }
  return out;
}

export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

// ---------- Volatility: GARCH(1,1) ----------
// sigma²[t+1] = omega + alpha·r[t]² + beta·sigma²[t], with omega set so the
// long-run variance equals the sample variance (variance targeting).

function garchLogLik(returns, v, a, b) {
  const w = v * (1 - a - b);
  let s2 = v;
  let sum = 0;
  for (const r of returns) {
    sum += Math.log(s2) + (r * r) / s2;
    s2 = w + a * r * r + b * s2;
  }
  return -0.5 * sum;
}

export function ewmaModel(returns, lambda = 0.94) {
  const v = returns.reduce((s, r) => s + r * r, 0) / Math.max(returns.length, 1);
  return { kind: 'ewma', omega: 0, alpha: 1 - lambda, beta: lambda, longRun: v };
}

export function fitGarch(returns) {
  const n = returns.length;
  const v = returns.reduce((s, r) => s + r * r, 0) / Math.max(n, 1);
  if (n < 100 || !(v > 0)) return ewmaModel(returns);
  let best = { ll: -Infinity, a: 0, b: 0 };
  const tryAt = (a, b) => {
    if (a <= 0 || b <= 0 || a + b >= 0.998) return;
    const ll = garchLogLik(returns, v, a, b);
    if (ll > best.ll) best = { ll, a, b };
  };
  for (let a = 0.01; a <= 0.3; a += 0.02) for (let b = 0.5; b < 0.99; b += 0.02) tryAt(a, b);
  // Refine around the best point with finer and finer steps.
  for (const step of [0.008, 0.003, 0.001]) {
    const { a: a0, b: b0 } = best;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) tryAt(a0 + i * step, b0 + j * step);
  }
  if (!Number.isFinite(best.ll)) return ewmaModel(returns);
  return { kind: 'garch', omega: v * (1 - best.a - best.b), alpha: best.a, beta: best.b, longRun: v };
}

// sig2[i] is the variance expected for returns[i] using only returns before it;
// sig2[n] is the forecast for the next, not yet seen, return.
export function filterVariance(model, returns) {
  const out = new Array(returns.length + 1);
  let s2 = model.longRun;
  for (let i = 0; i < returns.length; i++) {
    out[i] = s2;
    s2 = model.omega + model.alpha * returns[i] ** 2 + model.beta * s2;
  }
  out[returns.length] = s2;
  return out;
}

// Variance of each of the next h steps, given the next step's variance.
export function stepVariances(model, nextVar, h) {
  const phi = model.alpha + model.beta;
  const out = [];
  if (model.kind === 'ewma' || phi >= 0.9999) {
    for (let k = 0; k < h; k++) out.push(nextVar);
    return out;
  }
  const V = model.omega / (1 - phi);
  for (let k = 0; k < h; k++) out.push(V + phi ** k * (nextVar - V));
  return out;
}

export function cumVariance(model, nextVar, h) {
  const phi = model.alpha + model.beta;
  if (model.kind === 'ewma' || phi >= 0.9999) return h * nextVar;
  const V = model.omega / (1 - phi);
  return h * V + ((nextVar - V) * (1 - phi ** h)) / (1 - phi);
}

// ---------- Range shape ----------

export function quantileSorted(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Quantiles (at LEVELS) of past h-step returns in units of the sd expected at the
// time. Only windows that end by `end` are used. With few independent samples
// the shape leans on the normal curve.
export function standardizedQuantiles(closes, sig2, model, h, end) {
  const z = [];
  for (let p = 0; p + h <= end; p++) {
    const sd = Math.sqrt(cumVariance(model, sig2[p], h));
    if (sd > 0) z.push(Math.log(closes[p + h] / closes[p]) / sd);
  }
  z.sort((a, b) => a - b);
  const nEff = z.length / h;
  const w = z.length >= 20 ? nEff / (nEff + SHAPE_PRIOR) : 0;
  return LEVELS.map((q, i) => w * quantileSorted(z, q) + (1 - w) * NORMAL_Q[i]);
}

// ---------- Direction: logistic regression ----------

export function fitLogit(X, y, { l2 = 0.1, iters = 300 } = {}) {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const means = new Array(d).fill(0);
  const sds = new Array(d).fill(1);
  if (n < 50) return { w: new Array(d).fill(0), b: 0, means, sds, n };
  for (let j = 0; j < d; j++) {
    let s = 0;
    let ss = 0;
    for (const row of X) {
      s += row[j];
      ss += row[j] * row[j];
    }
    means[j] = s / n;
    sds[j] = Math.sqrt(Math.max(ss / n - means[j] ** 2, 0)) || 1;
  }
  const Z = X.map((row) => row.map((v, j) => clamp((v - means[j]) / sds[j], -4, 4)));
  const w = new Array(d).fill(0);
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  let b = Math.log(clamp(ybar, 0.05, 0.95) / (1 - clamp(ybar, 0.05, 0.95)));
  const g = new Array(d);
  const lr = 1 / (0.25 * d + l2); // step size the loss's curvature allows
  for (let it = 0; it < iters; it++) {
    g.fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b;
      const zi = Z[i];
      for (let j = 0; j < d; j++) s += w[j] * zi[j];
      const e = sigmoid(s) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) g[j] += e * zi[j];
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b, means, sds, n };
}

export function predictLogit(m, x) {
  let s = m.b;
  for (let j = 0; j < m.w.length; j++) s += m.w[j] * clamp((x[j] - m.means[j]) / m.sds[j], -4, 4);
  return sigmoid(s);
}

// ---------- Features ----------

export const FEATURE_NAMES = [
  'last step', 'last 5 steps', 'last 20 steps', 'vs EMA a', 'vs EMA b', 'vs EMA c', 'vs EMA d',
  'RSI', 'MACD', 'Bollinger %B', 'volume', 'OBV trend',
];

// One feature row per candle, using only that candle and earlier ones.
// Returns are scaled by the volatility expected at the time.
export function buildFeatures(candles, sig2, emaPeriods) {
  const closes = candles.map((c) => c.c);
  const emas = emaPeriods.map((p) => ema(closes, p));
  const r = rsi(closes, 14);
  const m = macd(closes);
  const bb = bollinger(closes, 20);
  const vz = rollingZ(candles.map((c) => Math.log(Math.max(c.v, 1))), 20);
  const ob = obv(candles);
  const warm = Math.max(...emaPeriods, 35);
  return candles.map((c, p) => {
    if (p < warm) return null;
    const sd = Math.sqrt(sig2[Math.max(p - 1, 0)]); // one-step sd known at candle p
    let vol10 = 0;
    for (let j = p - 9; j <= p; j++) vol10 += candles[j].v;
    const row = [
      Math.log(c.c / closes[p - 1]) / sd,
      Math.log(c.c / closes[p - 5]) / (sd * Math.sqrt(5)),
      Math.log(c.c / closes[p - 20]) / (sd * Math.sqrt(20)),
      ...emas.map((e) => Math.log(c.c / e[p]) / sd),
      r[p] / 100 - 0.5,
      m.hist[p] / c.c / sd,
      bb.pctB[p] - 0.5,
      vz[p],
      vol10 > 0 ? (ob[p] - ob[p - 10]) / vol10 : 0,
    ];
    return row.every(Number.isFinite) ? row : null;
  });
}

// ---------- Fitting and forecasting ----------

// Fit everything for one candle series using only candles up to index `fitEnd`.
//   quantileHorizons: step counts that need a range shape
//   logitHorizons:    step counts that get their own direction model
export function fitSeries(candles, { emaPeriods, quantileHorizons, logitHorizons, fitEnd = candles.length - 1 }) {
  const closes = candles.map((c) => c.c);
  const returns = logReturns(closes);
  const model = fitGarch(returns.slice(0, fitEnd));
  const sig2 = filterVariance(model, returns);
  const features = buildFeatures(candles, sig2, emaPeriods);
  const shapes = {};
  for (const h of quantileHorizons) shapes[h] = standardizedQuantiles(closes, sig2, model, h, fitEnd);
  const logits = {};
  for (const h of logitHorizons) {
    const X = [];
    const y = [];
    for (let p = 0; p + h <= fitEnd; p++) {
      if (!features[p]) continue;
      X.push(features[p]);
      y.push(closes[p + h] > closes[p] ? 1 : 0);
    }
    // Windows of h steps overlap, so there are only about X.length / h
    // independent samples: shrink harder as h grows.
    logits[h] = fitLogit(X, y, { l2: 0.2 * h });
  }
  return { candles, closes, model, sig2, features, shapes, logits };
}

// Variance expected over the next h steps from candle p's close.
export function horizonVariance(fit, p, h) {
  return cumVariance(fit.model, fit.sig2[p], h);
}

export function pUpAt(fit, p, h) {
  const m = fit.logits[h];
  return m && fit.features[p] ? predictLogit(m, fit.features[p]) : 0.5;
}

// Turn sd, shape and P(up) into prices around `price`.
export function bands(price, sd, shape, pUp) {
  const mu = (pUp - 0.5) * 2 * TILT * sd;
  const q = shape.map((z) => price * Math.exp(mu + sd * z));
  return {
    sd,
    pUp,
    mid: price * Math.exp(mu),
    lo95: q[0], lo80: q[1], lo50: q[2], hi50: q[3], hi80: q[4], hi95: q[5],
  };
}

export function predictAt(fit, p, h, price = fit.closes[p]) {
  const sd = Math.sqrt(horizonVariance(fit, p, h));
  return bands(price, sd, fit.shapes[h], pUpAt(fit, p, h));
}

// Pull P(up) toward 50% unless the walk-forward backtest showed the direction
// model beating a coin flip: no edge, no lean; a 10-point edge keeps it all.
export function shrinkBySkill(pUp, hitRate) {
  const skill = Number.isFinite(hitRate) ? clamp((hitRate - 0.5) / 0.1, 0, 1) : 0;
  return 0.5 + (pUp - 0.5) * skill;
}

// P(up) for any horizon, read off the horizons that have their own model.
// `points` are [steps, P(up)] pairs; interpolated in log(steps).
export function interpolateP(points, h) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (h <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i][0]) {
      const [h0, p0] = pts[i - 1];
      const [h1, p1] = pts[i];
      const f = (Math.log(h) - Math.log(h0)) / (Math.log(h1) - Math.log(h0));
      return p0 + f * (p1 - p0);
    }
  }
  return pts[pts.length - 1][1];
}

// ---------- Walk-forward backtest ----------
// For each of the latest `origins` start points (spaced by `spacing` steps),
// predict h steps ahead using only data up to the start point, then compare
// with what happened. Models are refit every `refitEvery` start points.

export function backtest(candles, { emaPeriods, h, origins = 240, spacing = 1, refitEvery = 60 }) {
  const n = candles.length;
  const minStart = Math.max(...emaPeriods, 35) + 150 + h;
  const starts = [];
  for (let p = n - 1 - h; p >= minStart && starts.length < origins; p -= spacing) starts.unshift(p);
  const res = { h, count: 0, in50: 0, in80: 0, in95: 0, called: 0, hits: 0, ups: 0, width80: 0 };
  let fit = null;
  starts.forEach((p, i) => {
    if (i % refitEvery === 0) {
      fit = fitSeries(candles, { emaPeriods, quantileHorizons: [h], logitHorizons: [h], fitEnd: p });
    }
    const f = predictAt(fit, p, h);
    const actual = candles[p + h].c;
    const now = candles[p].c;
    res.count++;
    if (actual >= f.lo50 && actual <= f.hi50) res.in50++;
    if (actual >= f.lo80 && actual <= f.hi80) res.in80++;
    if (actual >= f.lo95 && actual <= f.hi95) res.in95++;
    if (actual > now) res.ups++;
    if (f.pUp !== 0.5) {
      res.called++;
      if ((f.pUp > 0.5) === (actual > now)) res.hits++;
    }
    res.width80 += (f.hi80 - f.lo80) / now;
  });
  if (res.count) {
    for (const k of ['in50', 'in80', 'in95', 'ups', 'width80']) res[k] /= res.count;
  }
  res.hitRate = res.called ? res.hits / res.called : NaN;
  return res;
}

// ---------- Indicator snapshot ("why" table) ----------
// Daily candles; the last one may be today's unfinished candle at the live price.
// vote: 1 bullish, -1 bearish, 0 neutral / information only.

export function indicatorSnapshot(daily, todayOpen = true) {
  const closes = daily.map((c) => c.c);
  const price = closes[closes.length - 1];
  const last = (arr) => arr[arr.length - 1];
  const rows = [];
  const emas = {};
  for (const p of [7, 50, 100, 200]) {
    const e = last(ema(closes, p));
    if (!Number.isFinite(e)) continue;
    emas[p] = e;
    rows.push({ key: `ema${p}`, name: `EMA ${p}-day`, value: e, unit: 'usd', note: `${pct(price / e - 1)} ${price >= e ? 'above' : 'below'}`, vote: price >= e ? 1 : -1 });
  }
  if (emas[50] && emas[200]) {
    const golden = emas[50] > emas[200];
    rows.push({ key: 'cross', name: 'EMA 50 vs 200', value: emas[50] / emas[200] - 1, unit: 'pct', note: golden ? 'Golden cross (50 above 200)' : 'Death cross (50 below 200)', vote: golden ? 1 : -1 });
  }
  const r = last(rsi(closes, 14));
  if (Number.isFinite(r)) {
    const [note, vote] = r >= 70 ? ['Overbought', -1] : r <= 30 ? ['Oversold', 1] : r >= 55 ? ['Upward momentum', 1] : r <= 45 ? ['Downward momentum', -1] : ['Neutral', 0];
    rows.push({ key: 'rsi', name: 'RSI 14-day', value: r, unit: 'num', note, vote });
  }
  const m = macd(closes);
  const hist = last(m.hist);
  if (Number.isFinite(hist)) {
    rows.push({ key: 'macd', name: 'MACD (12, 26, 9)', value: hist, unit: 'usd', note: hist >= 0 ? 'Above signal line' : 'Below signal line', vote: hist >= 0 ? 1 : -1 });
  }
  const b = last(bollinger(closes, 20).pctB);
  if (Number.isFinite(b)) {
    const [note, vote] = b > 1 ? ['Above upper band (stretched)', -1] : b < 0 ? ['Below lower band (stretched)', 1] : ['Inside the bands', 0];
    rows.push({ key: 'bb', name: 'Bollinger %B (20-day)', value: b, unit: 'num2', note, vote });
  }
  // Volume: judge the last finished day, since today's volume is still building.
  const doneIdx = todayOpen ? daily.length - 2 : daily.length - 1;
  const vz = rollingZ(daily.map((c) => Math.log(Math.max(c.v, 1))), 20)[doneIdx];
  if (Number.isFinite(vz)) {
    const day = daily[doneIdx];
    const upDay = day.c >= day.o;
    const strong = vz > 1;
    rows.push({
      key: 'volume', name: 'Volume (last full day)', value: day.v, unit: 'usd',
      note: `${vz >= 0 ? '+' : ''}${vz.toFixed(1)} sd vs 20-day${strong ? (upDay ? ', heavy buying' : ', heavy selling') : ''}`,
      vote: strong ? (upDay ? 1 : -1) : 0,
    });
  }
  const ob = obv(daily);
  if (ob.length > 11) {
    const slope = ob[ob.length - 1] - ob[ob.length - 11];
    rows.push({ key: 'obv', name: 'On-balance volume, 10-day', value: slope, unit: 'usd', note: slope >= 0 ? 'Volume flowing in' : 'Volume flowing out', vote: slope >= 0 ? 1 : -1 });
  }
  const a = last(atr(daily, 14));
  if (Number.isFinite(a)) {
    rows.push({ key: 'atr', name: 'ATR 14-day', value: a, unit: 'usd', note: `${pct(a / price)} typical daily range`, vote: 0 });
  }
  return { price, emas, rows };
}

// ---------- helpers ----------

function sigmoid(s) {
  return 1 / (1 + Math.exp(-s));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function pct(x) {
  return `${(Math.abs(x) * 100).toFixed(1)}%`;
}
