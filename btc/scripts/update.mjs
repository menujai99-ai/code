#!/usr/bin/env node
// Background updater: pulls the market data, runs the same model as the app,
// and saves the forecast plus a running log of predictions. Predictions whose
// time has come are checked against the real price, building a live track
// record. Run by .github/workflows/btc-forecast.yml (scheduled twice an hour).
//
//   node btc/scripts/update.mjs [--out dir] [--fixture dir] [--now ms]
//
// Files in the output folder:
//   forecast.json  the latest forecast (what the app shows)
//   history.jsonl  one line per run: the ranges predicted for 1h/4h/24h/7d
//   scores.jsonl   one line per prediction once its time has passed
//   track.json     totals of scores.jsonl per horizon
//   direction.json the 1h up/down model trained on years of hourly candles,
//                  which the app applies to its own candles (btc/direction.js)

import fs from 'node:fs';
import path from 'node:path';
import { loadMarket, loadExtras, EXCHANGES } from '../data.js';
import { buildModel, forecastFrom } from '../forecast.js';
import { indicatorSnapshot } from '../model.js';
import { predictionEntry, scoreHistory, summarize, parseLines } from '../track.js';
import {
  trainDirection, directionSeries, directionReplay, DIRECTION_HOURS, DIRECTION_MIN_HOURS,
} from '../direction.js';

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

// Years of Binance hourly candles (with taker-buy volume) for the 1h up/down
// model; null if they can't be had.
async function loadLongHourly(fixture) {
  if (fixture) {
    const file = path.join(fixture, 'hourly-long.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }
  try {
    return await EXCHANGES[0].candles('1h', DIRECTION_HOURS);
  } catch (err) {
    console.warn(`No long history for the 1h model: ${err.message || err}`);
    return null;
  }
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
  fs.mkdirSync(out, { recursive: true });

  // Up/down: the tested 1h model when its history is available, and no 24h
  // lean, since nothing tested beat guessing there (btc/README.md).
  const long = (await loadLongHourly(fixture))?.filter((c) => c.t + HOUR <= t) ?? [];
  let direction = null;
  if (long.length >= DIRECTION_MIN_HOURS) {
    direction = { ...trainDirection(long), trainedAt: t, replay: directionReplay(long, 240) };
    model.pUp['1h'] = directionSeries(direction, long).at(-1).pUp;
    fs.writeFileSync(path.join(out, 'direction.json'), `${JSON.stringify(direction)}\n`);
  }
  model.pUp['24h'] = 0.5;

  const f = forecastFrom(model, price, t);
  const snap = indicatorSnapshot(daily, daily[daily.length - 1].t + DAY > t);

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
    direction: direction ? { model: '1h, trained on years of hourly candles', trainedOn: direction.trainedOn } : null,
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
  return { forecast, entry, fresh, track, direction };
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
