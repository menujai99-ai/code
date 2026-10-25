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
import { buildModel, forecastFrom } from '../forecast.js';
import { indicatorSnapshot } from '../model.js';
import { predictionEntry, scoreHistory, summarize, parseLines } from '../track.js';

export { priceAt, scoreHistory, summarize } from '../track.js';

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
  return fs.existsSync(file) ? parseLines(fs.readFileSync(file, 'utf8')) : [];
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
    backtest: Object.fromEntries(Object.entries(model.tests).map(([k, { rows, ...totals }]) => [k, totals])), // totals only
    indicators: snap.rows,
    extras,
  };
  fs.writeFileSync(path.join(out, 'forecast.json'), `${JSON.stringify(forecast, null, 1)}\n`);

  const entry = predictionEntry(f.cards, price, t, market.exchange.name);
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
