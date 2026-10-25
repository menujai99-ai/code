// Prediction history: saving predictions, checking them against the price
// once their time has come, and adding up how often they were right. Used by
// the background updater (btc/scripts/update.mjs) and by the app, which keeps
// its own log of the predictions shown on this device.

import { HORIZONS } from './forecast.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const KEEP = ['t', 'mid', 'lo50', 'hi50', 'lo80', 'hi80', 'lo95', 'hi95', 'pUp'];

// One saved prediction: the price and time it was made at, and for each
// horizon its target time, middle estimate, ranges and chance of going up.
export function predictionEntry(cards, price, t, source) {
  const h = {};
  for (const hz of HORIZONS) {
    const c = cards[hz.key];
    if (c) h[hz.key] = Object.fromEntries(KEEP.map((k) => [k === 't' ? 'target' : k, c[k]]));
  }
  return { t, price, source, h };
}

// The cards of a saved prediction, in the shape forecastFrom() gives them.
export function cardsOf(entry) {
  const cards = {};
  for (const [key, p] of Object.entries(entry.h || {})) {
    const { target, ...rest } = p;
    cards[key] = { t: target, ...rest };
  }
  return cards;
}

// Price at time t, read off candle closes of length `step` (straight line
// between the two closes either side of t). null if t is outside the data.
export function priceAt(candles, t, step = HOUR) {
  const closes = candles.map((c) => ({ t: c.t + step, c: c.c }));
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (t >= a.t && t <= b.t) return a.c + ((b.c - a.c) * (t - a.t)) / (b.t - a.t);
  }
  return null;
}

// Score every saved prediction whose target time has passed and that hasn't
// been scored yet. `candles` (of length `step`) supply the actual prices.
export function scoreHistory(history, scored, candles, now, step = HOUR) {
  if (!candles.length) return [];
  const done = new Set(scored.map((s) => `${s.t}|${s.h}`));
  const lastClose = Math.min(now, candles[candles.length - 1].t + step);
  const fresh = [];
  for (const run of history) {
    for (const [h, p] of Object.entries(run.h || {})) {
      if (done.has(`${run.t}|${h}`) || p.target > lastClose) continue;
      const actual = priceAt(candles, p.target, step);
      if (actual == null) continue;
      fresh.push({
        t: run.t, h, target: p.target, price: run.price, actual,
        in50: actual >= p.lo50 && actual <= p.hi50,
        in80: actual >= p.lo80 && actual <= p.hi80,
        in95: actual >= p.lo95 && actual <= p.hi95,
        called: p.pUp !== 0.5,
        hit: p.pUp !== 0.5 && (p.pUp > 0.5) === (actual > run.price),
      });
    }
  }
  return fresh;
}

// The backtests' replayed predictions (model.tests[key].rows) as a log, in
// the same shape as the saved ones: what the model would have said at each
// past start point, using only the data it had then, and how it turned out.
export function replayLog(tests) {
  const runs = new Map();
  const scores = [];
  for (const hz of HORIZONS) {
    for (const r of tests?.[hz.key]?.rows || []) {
      const run = runs.get(r.t) ?? { t: r.t, price: r.price, source: 'replay', h: {} };
      runs.set(r.t, run);
      run.h[hz.key] = Object.fromEntries(KEEP.map((k) => (k === 't' ? ['target', r.target] : [k, r[k]])));
      scores.push({
        t: r.t, h: hz.key, target: r.target, price: r.price, actual: r.actual,
        in50: r.actual >= r.lo50 && r.actual <= r.hi50,
        in80: r.actual >= r.lo80 && r.actual <= r.hi80,
        in95: r.actual >= r.lo95 && r.actual <= r.hi95,
        called: r.pUp !== 0.5,
        hit: r.pUp !== 0.5 && (r.pUp > 0.5) === (r.actual > r.price),
      });
    }
  }
  return { history: [...runs.values()].sort((a, b) => a.t - b.t), scores };
}

// Totals for a list of scores (one horizon).
export function tally(rows) {
  return {
    count: rows.length,
    in50: rows.filter((s) => s.in50).length,
    in80: rows.filter((s) => s.in80).length,
    in95: rows.filter((s) => s.in95).length,
    called: rows.filter((s) => s.called).length,
    hits: rows.filter((s) => s.hit).length,
    ups: rows.filter((s) => s.actual > s.price).length, // for the "always guess up" baseline
  };
}

export function summarize(scores, now) {
  const horizons = {};
  for (const hz of HORIZONS) horizons[hz.key] = tally(scores.filter((s) => s.h === hz.key));
  const since = scores.length ? Math.min(...scores.map((s) => s.t)) : now;
  return { updatedAt: now, since, horizons };
}

// Every prediction for one horizon, oldest target first, each with its score
// once it has one (score: null while it waits).
export function predictionRows(history, scores, key) {
  const byRun = new Map(scores.filter((s) => s.h === key).map((s) => [s.t, s]));
  return history
    .filter((run) => run.h?.[key])
    .map((run) => ({ t: run.t, price: run.price, ...run.h[key], score: byRun.get(run.t) ?? null }))
    .sort((a, b) => a.target - b.target);
}

// Keep the log to a size the browser can store: the last `maxAge` and at most
// `maxEntries` predictions, and only the scores that belong to them.
export function trimLog(history, scores, now, { maxAge = 60 * DAY, maxEntries = 1500 } = {}) {
  const kept = history.filter((run) => run.t >= now - maxAge).slice(-maxEntries);
  const runs = new Set(kept.map((run) => run.t));
  return { history: kept, scores: scores.filter((s) => runs.has(s.t)) };
}

// JSON Lines (one object per line); damaged lines are skipped.
export function parseLines(text) {
  return String(text || '').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
