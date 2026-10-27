// Market data, fetched straight from free public APIs in the browser (no keys).
// Price candles come from the first exchange that answers; the extra metrics
// (futures, sentiment, on-chain) are optional and simply left out if blocked.

import { resample } from './live.js';
import { parseLines } from './track.js';

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const STEP = {
  '1m': MINUTE, '5m': 5 * MINUTE, '15m': 15 * MINUTE, '1h': HOUR, '4h': 4 * HOUR, '1d': DAY, '1w': 7 * DAY,
};

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function tidy(candles) {
  const byTime = new Map();
  for (const c of candles) {
    if ([c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0)) byTime.set(c.t, c);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

// ---------- Exchanges ----------
// Each one:
//   candles(interval, count, before?) -> up to `count` candles (oldest first)
//     opening before `before` (ms), or the latest ones. v = volume in USD,
//     vb = volume in BTC.
//   trades(n) -> the latest trades, oldest first: { t, price, qty, side }
//     where side is the taker's side ('buy' or 'sell').
//   price() -> latest trade price.

function binance(base, name) {
  return {
    name,
    async candles(interval, count, before) {
      let out = [];
      let end = before ? `&endTime=${before - 1}` : '';
      while (out.length < count) {
        const limit = Math.min(1000, count - out.length);
        const rows = await getJSON(`${base}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}${end}`);
        if (!Array.isArray(rows) || !rows.length) break;
        out = rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7], vb: +r[5] })).concat(out);
        end = `&endTime=${rows[0][0] - 1}`;
        if (rows.length < limit) break;
      }
      return tidy(out);
    },
    async trades(n) {
      const rows = await getJSON(`${base}/api/v3/aggTrades?symbol=BTCUSDT&limit=${n}`);
      return rows.map((r) => ({ t: r.T, price: +r.p, qty: +r.q, side: r.m ? 'sell' : 'buy' }));
    },
    async price() {
      return +(await getJSON(`${base}/api/v3/ticker/price?symbol=BTCUSDT`)).price;
    },
  };
}

// Coinbase has no 4h or weekly candles: those are built from 1h and 1d ones.
const COINBASE_BUILT = { '4h': ['1h', 4], '1w': ['1d', 7] };

const coinbase = {
  name: 'Coinbase',
  async candles(interval, count, before) {
    if (COINBASE_BUILT[interval]) {
      const [base, k] = COINBASE_BUILT[interval];
      const small = await this.candles(base, (count + 1) * k, before);
      return resample(small, STEP[interval]).slice(-count);
    }
    const step = STEP[interval];
    let end = before ? Math.floor((before - 1) / step) * step : Math.ceil(Date.now() / step) * step;
    const out = [];
    while (out.length < count) {
      const n = Math.min(299, count - out.length); // the API allows 300 per call
      const start = end - n * step;
      const rows = await getJSON(
        `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${step / 1000}` +
          `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`
      );
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] * r[4], vb: r[5] });
      end = start;
    }
    const all = tidy(out);
    return before ? all.filter((c) => c.t < before) : all;
  },
  async trades(n) {
    const rows = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=${n}`);
    // Coinbase reports the maker's side; the taker took the other one.
    return rows
      .map((r) => ({ t: Date.parse(r.time), price: +r.price, qty: +r.size, side: r.side === 'sell' ? 'buy' : 'sell' }))
      .reverse();
  },
  async price() {
    return +(await getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker')).price;
  },
};

const KRAKEN_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

const kraken = {
  name: 'Kraken',
  async candles(interval, count, before) {
    // Kraken only returns the latest 720 candles and can't page further back.
    if (before) return [];
    if (interval === '1w') return resample(await this.candles('1d', 720), STEP['1w']).slice(-count);
    const data = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${KRAKEN_MINUTES[interval]}`);
    if (data.error?.length) throw new Error(data.error.join(', '));
    const key = Object.keys(data.result).find((k) => k !== 'last');
    return tidy(data.result[key].map((r) => ({
      t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] * +r[5], vb: +r[6],
    }))).slice(-count);
  },
  async trades(n) {
    const data = await getJSON(`https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=${n}`);
    const key = Object.keys(data.result).find((k) => k !== 'last');
    return data.result[key].map((r) => ({ t: Math.round(r[2] * 1000), price: +r[0], qty: +r[1], side: r[3] === 's' ? 'sell' : 'buy' }));
  },
  async price() {
    const data = await getJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
    const key = Object.keys(data.result)[0];
    return +data.result[key].c[0];
  },
};

// data-api.binance.vision is Binance's public market-data mirror; it also works
// where api.binance.com is blocked (e.g. the US).
export const EXCHANGES = [
  binance('https://data-api.binance.vision', 'Binance'),
  binance('https://api.binance.com', 'Binance'),
  coinbase,
  kraken,
];

const MIN_HOURLY = 600;
const MIN_DAILY = 400;

// Hourly and daily candles from the first exchange that has enough history.
export async function loadMarket({ hours = 2000, days = 1000 } = {}) {
  const errors = [];
  for (const ex of EXCHANGES) {
    try {
      const [hourly, daily] = await Promise.all([ex.candles('1h', hours), ex.candles('1d', days)]);
      if (hourly.length < MIN_HOURLY || daily.length < MIN_DAILY) {
        throw new Error(`${ex.name}: not enough history`);
      }
      return { exchange: ex, hourly, daily };
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  throw new Error(`No price data. ${errors.join(' · ')}`);
}

// ---------- Optional extras ----------

// Futures positioning from OKX: one of the few derivatives exchanges whose
// public API both web pages (CORS) and US servers (the background job) can use.
async function futures() {
  const base = 'https://www.okx.com/api/v5';
  const [funding, swap, history] = await Promise.all([
    getJSON(`${base}/public/funding-rate?instId=BTC-USDT-SWAP`),
    getJSON(`${base}/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP`).catch(() => null),
    // OKX's history endpoint blocks web pages (CORS), so only servers ask for it.
    typeof window === 'undefined'
      ? getJSON(`${base}/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H`).catch(() => null)
      : null,
  ]);
  const out = { source: 'OKX', fundingRate: +funding.data[0].fundingRate };
  const level = +swap?.data?.[0]?.oiUsd;
  if (level > 0) out.openInterest = level;
  // Hourly history, newest first: [time, open interest (USD), volume (USD)].
  const rows = history?.data;
  if (Array.isArray(rows) && rows.length > 24) {
    const latest = +rows[0][1];
    const dayAgo = +rows[24][1];
    if (latest > 0 && dayAgo > 0) out.openInterestChange = latest / dayAgo - 1;
  }
  return out;
}

async function fearGreed() {
  const data = await getJSON('https://api.alternative.me/fng/?limit=8');
  const list = data.data.map((d) => ({ value: +d.value, label: d.value_classification }));
  return { now: list[0], weekAgo: list[list.length - 1] };
}

async function mempool() {
  const base = 'https://mempool.space/api';
  const [fees, pool, hash] = await Promise.all([
    getJSON(`${base}/v1/fees/recommended`),
    getJSON(`${base}/mempool`),
    getJSON(`${base}/v1/mining/hashrate/1m`).catch(() => null),
  ]);
  const out = { fastestFee: fees.fastestFee, hourFee: fees.hourFee, mempoolTx: pool.count, mempoolVsize: pool.vsize };
  const rates = hash?.hashrates;
  if (Array.isArray(rates) && rates.length > 8) {
    const avg = (arr) => arr.reduce((s, r) => s + r.avgHashrate, 0) / arr.length;
    out.hashrate = hash.currentHashrate || rates[rates.length - 1].avgHashrate;
    out.hashrateChange = avg(rates.slice(-7)) / avg(rates.slice(0, 7)) - 1;
  }
  return out;
}

async function transactions() {
  const data = await getJSON('https://api.blockchain.info/charts/n-transactions?timespan=60days&format=json&cors=true');
  const ys = data.values.map((v) => v.y);
  if (ys.length < 37) throw new Error('short tx history');
  const avg = (arr) => arr.reduce((s, y) => s + y, 0) / arr.length;
  const week = avg(ys.slice(-7));
  const month = avg(ys.slice(-37, -7));
  return { perDay: week, change: week / month - 1 };
}

// Every extra that answered; the rest are left out.
export async function loadExtras() {
  const names = ['futures', 'fearGreed', 'mempool', 'transactions'];
  const results = await Promise.allSettled([futures(), fearGreed(), mempool(), transactions()]);
  const out = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[names[i]] = r.value;
  });
  return out;
}

// ---------- Background updater output ----------
// A scheduled GitHub Action runs the same model every hour and saves the
// results on the repo's btc-data branch (see btc/scripts/update.mjs).

export const BACKGROUND_URL = 'https://raw.githubusercontent.com/menujai99-ai/code/btc-data';

async function getText(url, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// The latest forecast, the totals, and the full logs: every saved prediction
// (history) and every checked one (scores).
export async function loadBackground(base = BACKGROUND_URL) {
  const [forecast, track, history, scores] = await Promise.allSettled([
    getJSON(`${base}/forecast.json`),
    getJSON(`${base}/track.json`),
    getText(`${base}/history.jsonl`),
    getText(`${base}/scores.jsonl`),
  ]);
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  return {
    forecast: ok(forecast),
    track: ok(track),
    history: history.status === 'fulfilled' ? parseLines(history.value) : null,
    scores: scores.status === 'fulfilled' ? parseLines(scores.value) : null,
  };
}
