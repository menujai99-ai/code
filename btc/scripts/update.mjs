#!/usr/bin/env node
// Background updater: pulls the market data, runs the same model as the app,
// and saves the forecast plus a running log of predictions. Predictions whose
// time has come are checked against the real price, building a live track
// record. Run hourly by .github/workflows/btc-forecast.yml.
//
//   node btc/scripts/update.mjs [--out dir] [--fixture dir] [--now ms]
//
// Files in the output folder:
//   forecast.json  the latest forecast (what the app shows)
//   history.jsonl  one line per run: the ranges predicted for 1h/4h/24h/7d
//   scores.jsonl   one line per prediction once its time has passed
//   track.json     totals of scores.jsonl per horizon

import fs from 'node:fs';
import path from 'node:path';
import { loadMarket, loadExtras } from '../data.js';
import { buildModel, forecastFrom, HORIZONS } from '../forecast.js';
import { indicatorSnapshot } from '../model.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

function parseArgs(argv) {
  const args = { out: 'out', fixture: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key in args) args[key] = argv[++i];
  }
  if (args.now) args.now = +args.now;
  return args;
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // skip a damaged line rather than stop
    }
  });
}

// Price at time t, read off the hourly closes (straight line between the two
// closes either side of t). null if t is outside the data.
export function priceAt(hourly, t) {
  const closes = hourly.map((c) => ({ t: c.t + HOUR, c: c.c }));
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (t >= a.t && t <= b.t) return a.c + ((b.c - a.c) * (t - a.t)) / (b.t - a.t);
  }
  return null;
}

// Score every saved prediction whose target time has passed and that hasn't
// been scored yet.
export function scoreHistory(history, scored, hourly, now) {
  const done = new Set(scored.map((s) => `${s.t}|${s.h}`));
  const lastClose = Math.min(now, hourly[hourly.length - 1].t + HOUR);
  const fresh = [];
  for (const run of history) {
    for (const [h, p] of Object.entries(run.h || {})) {
      if (done.has(`${run.t}|${h}`) || p.target > lastClose) continue;
      const actual = priceAt(hourly, p.target);
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

export function summarize(scores, now) {
  const horizons = {};
  for (const hz of HORIZONS) {
    const rows = scores.filter((s) => s.h === hz.key);
    horizons[hz.key] = {
      count: rows.length,
      in50: rows.filter((s) => s.in50).length,
      in80: rows.filter((s) => s.in80).length,
      in95: rows.filter((s) => s.in95).length,
      called: rows.filter((s) => s.called).length,
      hits: rows.filter((s) => s.hit).length,
    };
  }
  const since = scores.length ? Math.min(...scores.map((s) => s.t)) : now;
  return { updatedAt: now, since, horizons };
}

async function loadFixture(dir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return { exchange: { name: 'Fixture' }, hourly: read('hourly.json'), daily: read('daily.json') };
}

export async function run({ out = 'out', fixture = null, now = null } = {}) {
  const market = fixture ? await loadFixture(fixture) : await loadMarket();
  const extras = fixture ? {} : await loadExtras();
  const t = now ?? Date.now();
  const hourly = market.hourly.filter((c) => c.t <= t);
  const daily = market.daily.filter((c) => c.t <= t);
  const price = hourly[hourly.length - 1].c; // latest trade (the open candle's close)
  const doneH = hourly.filter((c) => c.t + HOUR <= t);
  const doneD = daily.filter((c) => c.t + DAY <= t);

  const model = buildModel(doneH, doneD);
  const f = forecastFrom(model, price, t);
  const snap = indicatorSnapshot(daily, daily[daily.length - 1].t + DAY > t);

  fs.mkdirSync(out, { recursive: true });
  const forecast = {
    version: 1,
    generatedAt: t,
    source: market.exchange.name,
    price,
    cards: f.cards,
    hourPath: f.hourPath,
    dayPath: f.dayPath,
    pUp: model.pUp,
    rawPUp: model.raw,
    backtest: model.tests,
    indicators: snap.rows,
    extras,
  };
  fs.writeFileSync(path.join(out, 'forecast.json'), `${JSON.stringify(forecast, null, 1)}\n`);

  const keep = ['t', 'mid', 'lo50', 'hi50', 'lo80', 'hi80', 'lo95', 'hi95', 'pUp'];
  const entry = { t, price, source: market.exchange.name, h: {} };
  for (const hz of HORIZONS) {
    const c = f.cards[hz.key];
    entry.h[hz.key] = Object.fromEntries(keep.map((k) => [k === 't' ? 'target' : k, c[k]]));
  }
  const historyFile = path.join(out, 'history.jsonl');
  fs.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`);

  const scoresFile = path.join(out, 'scores.jsonl');
  const scored = readLines(scoresFile);
  const fresh = scoreHistory(readLines(historyFile), scored, hourly, t);
  if (fresh.length) fs.appendFileSync(scoresFile, fresh.map((s) => JSON.stringify(s)).join('\n') + '\n');
  const track = summarize([...scored, ...fresh], t);
  fs.writeFileSync(path.join(out, 'track.json'), `${JSON.stringify(track, null, 1)}\n`);
  return { forecast, entry, fresh, track };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  run(args)
    .then(({ forecast, fresh, track }) => {
      const c = forecast.cards['24h'];
      console.log(`${forecast.source}: $${forecast.price.toFixed(0)} · 24h 80% range $${c.lo80.toFixed(0)}–$${c.hi80.toFixed(0)}`);
      console.log(`Scored ${fresh.length} matured predictions; 1h checked so far: ${track.horizons['1h'].count}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
