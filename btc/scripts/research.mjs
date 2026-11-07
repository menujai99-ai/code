#!/usr/bin/env node
// Research: does anything predict Bitcoin's up/down move over the next hour or
// the next day better than guessing? Walk-forward tests on ~3.6 years of
// Binance hourly candles (with the taker-buy volume, i.e. who pushed: buyers
// or sellers). Every choice (features, training window, regularisation, the
// "strong call" cutoff) is made on year 2; year 3 is predicted only after
// that, once, for the chosen setup and for today's model. Nothing here is
// used by the app; the results decide what the app ships.
//
//   node btc/scripts/research.mjs                 real data (needs Binance)
//   node btc/scripts/research.mjs --synthetic flow  simulated prices where taker
//                                                  flow really predicts the next hour
//   node btc/scripts/research.mjs --synthetic none  simulated prices with no edge at all

import { fitGarch, filterVariance, logReturns, fitLogit, predictLogit, ema } from '../model.js';
import { EXCHANGES } from '../data.js';
import { directionFeatures as features, LONG_EMAS } from '../direction.js';
import { rng, normal } from '../test/synthetic.mjs';

const H = 3600e3;
const YEAR = 8760; // hours
const WARM = 5000; // hours before year 1 so the longest averages are ready
const FOLD = 720; // refit every 30 days
const L2S = [0.01, 0.1, 1, 10];
const CUTOFFS = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1];
const MIN_COVERAGE = 0.1; // a "strong call" rule must call at least 10% of the time
const BOOT = 1000;
const BLOCK = 48; // hours per bootstrap block (errors are correlated in time)
const GROUPS = ['base', 'flow', 'returns', 'range', 'regime', 'time', 'trend'];

// ---------- Data ----------

async function loadReal(hours) {
  const candles = await EXCHANGES[0].candles('1h', hours); // Binance (data-api.binance.vision)
  const now = Date.now();
  return candles.filter((c) => c.t + H <= now);
}

// Simulated hourly prices (GARCH volatility, fat-ish tails). In 'flow' mode the
// taker-buy share of each hour shifts the next hour's mean by 0.08 sd per sd
// of share: a small, realistic-sized edge that a good test should find.
function simulate(n, mode, seed = 5) {
  const rand = rng(seed);
  const omega = 2e-7;
  const alpha = 0.08;
  const beta = 0.9;
  let s2 = omega / (1 - alpha - beta);
  let price = 30000;
  let zPrev = 0;
  const t0 = Date.UTC(2022, 0, 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const sd = Math.sqrt(s2);
    const shock = normal(rand) * (rand() < 0.04 ? 2.5 : 0.93);
    const r = sd * ((mode === 'flow' ? 0.08 * zPrev : 0) + shock);
    const o = price;
    const c = price * Math.exp(r);
    const vb = 1000 * Math.exp(0.3 * normal(rand));
    const z = normal(rand);
    const share = Math.min(0.95, Math.max(0.05, 0.5 + 0.05 * z));
    out.push({
      t: t0 + i * H, o, c,
      h: Math.max(o, c) * Math.exp(Math.abs(normal(rand)) * sd * 0.5),
      l: Math.min(o, c) * Math.exp(-Math.abs(normal(rand)) * sd * 0.5),
      vb, v: vb * c, tb: vb * share,
    });
    zPrev = z;
    s2 = omega + alpha * r * r + beta * s2;
    price = c;
  }
  return out;
}

// ---------- Features ----------
// The candidates live in btc/direction.js, so the model the app ships is
// computed by exactly the code tested here.

// ---------- Models ----------

// name, feature groups, training window (hours; Infinity = everything so far), l2.
function configs() {
  const out = [{ name: 'M1 today (12 features, 2,000h)', groups: ['base'], window: 2000, l2: null }];
  const sets = [['base+flow', ['base', 'flow']], ['all', GROUPS]];
  const windows = [[2000, '2,000h'], [YEAR, '1 year'], [Infinity, 'all so far']];
  for (const [setName, groups] of sets) {
    for (const [window, wName] of windows) {
      for (const l2 of L2S) out.push({ name: `${setName}, ${wName}, l2 ${l2}`, groups, window, l2 });
    }
  }
  return out;
}

// Walk forward over [from, to): refit at the start of every fold, using only
// targets known by then; predict each hour of the fold.
function walk(candles, from, to, h, list, onFoldFit) {
  const closes = candles.map((c) => c.c);
  const returns = logReturns(closes);
  const emaLong = LONG_EMAS.map((p) => ema(closes, p));
  const preds = list.map(() => []);
  for (let S = from; S < to; S += FOLD) {
    const end = Math.min(S + FOLD, to);
    const sig2 = filterVariance(fitGarch(returns.slice(0, S)), returns);
    const cols = features(candles, sig2, emaLong);
    list.forEach((cfg, k) => {
      const use = cols.filter((c) => cfg.groups.includes(c.group));
      const row = (p) => {
        const x = use.map((c) => c.v[p]);
        return x.every(Number.isFinite) ? x : null;
      };
      const X = [];
      const y = [];
      const first = cfg.window === Infinity ? 0 : Math.max(0, S - h - cfg.window + 1);
      for (let p = first; p <= S - h; p++) {
        const x = row(p);
        if (!x) continue;
        X.push(x);
        y.push(closes[p + h] > closes[p] ? 1 : 0);
      }
      const p0 = y.reduce((s, v) => s + v, 0) / Math.max(y.length, 1);
      const m = fitLogit(X, y, { l2: cfg.l2 ?? 0.2 * h });
      onFoldFit?.(k, m, use.map((c) => c.name));
      for (let p = S; p < end; p++) {
        const x = row(p);
        preds[k].push({ p, prob: x ? predictLogit(m, x) : p0, p0, y: closes[p + h] > closes[p] ? 1 : 0 });
      }
    });
  }
  return preds;
}

// ---------- Scoring ----------

const ll = (prob, y) => -(y ? Math.log(Math.max(prob, 1e-9)) : Math.log(Math.max(1 - prob, 1e-9)));
const strongOf = (preds, c) => preds.filter((r) => Math.abs(r.prob - 0.5) >= c);
const right = (r) => (r.prob > 0.5) === (r.y === 1);
const baseRight = (r) => (r.p0 >= 0.5) === (r.y === 1); // always guess the training majority

function summary(preds, c) {
  const strong = strongOf(preds, c);
  const acc = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : NaN);
  return {
    n: preds.length,
    logloss: preds.reduce((s, r) => s + ll(r.prob, r.y), 0) / preds.length,
    baseLogloss: preds.reduce((s, r) => s + ll(r.p0, r.y), 0) / preds.length,
    acc: acc(preds, right),
    baseAcc: acc(preds, baseRight),
    strongN: strong.length,
    coverage: strong.length / preds.length,
    strongAcc: acc(strong, right),
    strongBaseAcc: acc(strong, baseRight),
  };
}

// Picks the strong-call cutoff on year 2: the best accuracy gain over always
// guessing, weighed by how many calls it makes, calling at least 10% of the time.
function pickCutoff(preds) {
  let best = null;
  for (const c of CUTOFFS) {
    const s = summary(preds, c);
    if (s.coverage < MIN_COVERAGE) continue;
    const score = (s.strongAcc - s.strongBaseAcc) * Math.sqrt(s.strongN);
    if (!best || score > best.score) best = { c, score };
  }
  return best ? best.c : CUTOFFS[0];
}

// Moving-block bootstrap: 95% interval for a statistic of the predictions.
function bootstrap(preds, stat, seed = 9) {
  const rand = rng(seed);
  const n = preds.length;
  const blocks = Math.ceil(n / BLOCK);
  const vals = [];
  for (let b = 0; b < BOOT; b++) {
    const sample = [];
    for (let k = 0; k < blocks; k++) {
      const s = Math.floor(rand() * (n - BLOCK + 1));
      for (let j = s; j < s + BLOCK; j++) sample.push(preds[j]);
    }
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]];
}

function calibration(preds) {
  const edges = [0, 0.01, 0.02, 0.04, 0.08, 1];
  return edges.slice(0, -1).map((lo, i) => {
    const rows = preds.filter((r) => Math.abs(r.prob - 0.5) >= lo && Math.abs(r.prob - 0.5) < edges[i + 1]);
    return {
      band: edges[i + 1] < 1 ? `${(50 + lo * 100).toFixed(0)}–${(50 + edges[i + 1] * 100).toFixed(0)}%` : `≥${(50 + lo * 100).toFixed(0)}%`,
      n: rows.length,
      said: rows.length ? rows.reduce((s, r) => s + Math.max(r.prob, 1 - r.prob), 0) / rows.length : NaN,
      right: rows.length ? rows.filter(right).length / rows.length : NaN,
    };
  });
}

// ---------- Run ----------

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const pts = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : '—');

export async function research({ synthetic = null, log = console.log } = {}) {
  const need = WARM + 3 * YEAR + 24;
  const candles = synthetic ? simulate(need, synthetic) : await loadReal(need + 48);
  const n = candles.length;
  if (n < need) throw new Error(`only ${n} hours of data (need ${need})`);
  const end = n - 24; // last decision hour whose 24h target is known
  const y2 = [end - 2 * YEAR, end - YEAR];
  const y3 = [end - YEAR, end];
  const day = (p) => new Date(candles[p].t).toISOString().slice(0, 10);
  log(`Data: ${n} hourly candles, ${day(0)} → ${day(n - 1)} (${synthetic ? `simulated, ${synthetic}` : 'Binance BTC/USDT'}).`);
  log(`Taker-buy volume present on ${pct(candles.filter((c) => Number.isFinite(c.tb)).length / n)} of candles.`);
  log(`Year 2 (choose): ${day(y2[0])} → ${day(y2[1] - 1)} · Year 3 (test, once): ${day(y3[0])} → ${day(y3[1] - 1)}`);
  const all = configs();
  const results = {};
  for (const h of [1, 24]) {
    const t0 = Date.now();
    // 1) Year 2: every setup.
    const p2 = walk(candles, y2[0], y2[1], h, all);
    const scored = all.map((cfg, k) => ({ cfg, k, s: summary(p2[k], 0) }));
    const best = scored.reduce((a, b) => (b.s.logloss < a.s.logloss ? b : a));
    const cutoff = pickCutoff(p2[best.k]);
    const chosen = { ...best.cfg };
    const y2s = summary(p2[best.k], cutoff);
    const m1y2 = summary(p2[0], cutoff);
    log(`\n=== ${h}h ahead ===  (year 2 took ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    log('Year 2, best setups by log-loss (lower is better; base = always the training up-share):');
    for (const { cfg, s } of [...scored].sort((a, b) => a.s.logloss - b.s.logloss).slice(0, 6)) {
      log(`  ${cfg.name.padEnd(36)} logloss ${s.logloss.toFixed(5)} (base ${s.baseLogloss.toFixed(5)}) · right ${pct(s.acc)} vs ${pct(s.baseAcc)}`);
    }
    log(`  ${all[0].name.padEnd(36)} logloss ${scored[0].s.logloss.toFixed(5)} · right ${pct(scored[0].s.acc)}`);
    log(`Chosen: ${chosen.name} · strong-call cutoff ${pct(cutoff)} away from 50% → year 2: calls ${pct(y2s.coverage)} of hours, right ${pct(y2s.strongAcc)} vs ${pct(y2s.strongBaseAcc)} by always guessing`);

    // 2) Year 3: the chosen setup and today's model, once.
    let weights = null;
    const p3 = walk(candles, y3[0], y3[1], h, [chosen, all[0]], (k, m, names) => {
      if (k === 0) weights = names.map((name, j) => ({ name, w: m.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    });
    const test = summary(p3[0], cutoff);
    const today = summary(p3[1], cutoff);
    const llGain = bootstrap(p3[0], (rows) => rows.reduce((s, r) => s + ll(r.p0, r.y) - ll(r.prob, r.y), 0) / rows.length);
    const strongGain = bootstrap(p3[0], (rows) => {
      const s = strongOf(rows, cutoff);
      return s.length ? (s.filter(right).length - s.filter(baseRight).length) / s.length : NaN;
    });
    const half = Math.floor(p3[0].length / 2);
    const halves = [p3[0].slice(0, half), p3[0].slice(half)].map((rows) => summary(rows, cutoff));
    const daily = summary(p3[0].filter((r) => new Date(candles[r.p].t + H).getUTCHours() === 0), cutoff);
    const gates = {
      logloss: test.logloss < test.baseLogloss && llGain[0] > 0,
      strongCalls: test.strongAcc - test.strongBaseAcc >= 0.02 && strongGain[0] > 0,
      bothHalves: halves.every((s) => s.strongAcc - s.strongBaseAcc > 0),
    };
    const pass = Object.values(gates).every(Boolean);
    log(`Year 3 (test): all calls right ${pct(test.acc)} vs ${pct(test.baseAcc)} by always guessing; log-loss gain ${(1e3 * (test.baseLogloss - test.logloss)).toFixed(2)}‰ (95% ${(1e3 * llGain[0]).toFixed(2)} to ${(1e3 * llGain[1]).toFixed(2)})`);
    log(`  strong calls: ${pct(test.coverage)} of hours (${test.strongN}), right ${pct(test.strongAcc)} vs ${pct(test.strongBaseAcc)} by always guessing → ${pts(test.strongAcc - test.strongBaseAcc)} pts (95% ${pts(strongGain[0])} to ${pts(strongGain[1])})`);
    log(`  halves: ${halves.map((s) => `${pct(s.strongAcc)} vs ${pct(s.strongBaseAcc)} (${s.strongN})`).join(' · ')}`);
    if (h === 24) log(`  one call a day (00:00 UTC, no overlap): strong ${daily.strongN}, right ${pct(daily.strongAcc)} vs ${pct(daily.strongBaseAcc)}; all ${pct(daily.acc)} vs ${pct(daily.baseAcc)}`);
    log(`  today's model, same test: all right ${pct(today.acc)}; strong (same cutoff) ${pct(today.strongAcc)} vs ${pct(today.strongBaseAcc)} (${today.strongN})`);
    log('  calibration (said → right): ' + calibration(p3[0]).map((b) => `${b.band}: ${pct(b.said)} → ${pct(b.right)} (${b.n})`).join(' · '));
    log('  heaviest features (last fit): ' + (weights || []).slice(0, 10).map((f) => `${f.name} ${f.w >= 0 ? '+' : ''}${f.w.toFixed(3)}`).join(', '));
    log(`  GATES: log-loss ${gates.logloss ? 'pass' : 'FAIL'} · strong calls ≥ +2 pts ${gates.strongCalls ? 'pass' : 'FAIL'} · both halves ${gates.bothHalves ? 'pass' : 'FAIL'} → ${pass ? 'SHIP' : 'DO NOT SHIP'}`);
    results[`${h}h`] = { chosen: { ...chosen, window: chosen.window === Infinity ? 'all' : chosen.window }, cutoff, year2: y2s, m1Year2: m1y2, test, today, llGain, strongGain, halves, daily, weights: weights?.slice(0, 15), gates, pass };
  }
  log(`\nRESULT ${JSON.stringify(results)}`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--synthetic');
  research({ synthetic: i > 0 ? process.argv[i + 1] : null }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
