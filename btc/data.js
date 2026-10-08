// Market data, fetched straight from free public APIs in the browser (no keys).
// Price candles come from the first exchange that answers; the extra metrics
// (futures, sentiment, on-chain) are optional and simply left out if blocked.

const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const STEP = { '1h': HOUR, '1d': DAY };

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
// Each one: candles(interval, count) -> oldest-first candles with USD volume,
// and price() -> latest trade price.

function binance(base, name) {
  return {
    name,
    async candles(interval, count) {
      let out = [];
      let end = '';
      while (out.length < count) {
        const limit = Math.min(1000, count - out.length);
        const rows = await getJSON(`${base}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}${end}`);
        if (!Array.isArray(rows) || !rows.length) break;
        out = rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })).concat(out);
        end = `&endTime=${rows[0][0] - 1}`;
        if (rows.length < limit) break;
      }
      return tidy(out);
    },
    async price() {
      return +(await getJSON(`${base}/api/v3/ticker/price?symbol=BTCUSDT`)).price;
    },
  };
}

const coinbase = {
  name: 'Coinbase',
  async candles(interval, count) {
    const step = STEP[interval];
    let end = Math.ceil(Date.now() / step) * step;
    const out = [];
    while (out.length < count) {
      const n = Math.min(299, count - out.length); // the API allows 300 per call
      const start = end - n * step;
      const rows = await getJSON(
        `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${step / 1000}` +
          `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`
      );
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] * r[4] });
      end = start;
    }
    return tidy(out);
  },
  async price() {
    return +(await getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker')).price;
  },
};

const kraken = {
  name: 'Kraken',
  async candles(interval) {
    // Kraken only returns the latest 720 candles.
    const data = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${interval === '1h' ? 60 : 1440}`);
    if (data.error?.length) throw new Error(data.error.join(', '));
    const key = Object.keys(data.result).find((k) => k !== 'last');
    return tidy(data.result[key].map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] * +r[5] })));
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

async function futures() {
  const base = 'https://fapi.binance.com';
  const [premium, oi] = await Promise.all([
    getJSON(`${base}/fapi/v1/premiumIndex?symbol=BTCUSDT`),
    getJSON(`${base}/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=25`).catch(() => null),
  ]);
  const out = { fundingRate: +premium.lastFundingRate };
  if (Array.isArray(oi) && oi.length > 1) {
    const first = +oi[0].sumOpenInterestValue;
    const last = +oi[oi.length - 1].sumOpenInterestValue;
    out.openInterest = last;
    out.openInterestChange = first > 0 ? last / first - 1 : NaN;
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

export async function loadBackground(base = BACKGROUND_URL) {
  const [forecast, track] = await Promise.allSettled([
    getJSON(`${base}/forecast.json`),
    getJSON(`${base}/track.json`),
  ]);
  return {
    forecast: forecast.status === 'fulfilled' ? forecast.value : null,
    track: track.status === 'fulfilled' ? track.value : null,
  };
}
