// BTC Range app: loads market data, runs the model and draws the page.
// The price screen borrows its layout and metrics from exchange apps such as
// Binance: price with 24h figures, candlestick chart with indicator tabs, and
// live Market Trades. The forecast shows on the chart as grey ghost candles
// inside a dashed 95% cone.

import { loadMarket, loadExtras, loadBackground, STEP } from './data.js';
import { indicatorSnapshot } from './model.js';
import { buildModel, forecastFrom, forecastBars, signalFor, HORIZONS } from './forecast.js';
import { LiveFeed, applyTick, upsertCandle } from './live.js';
import { createBinanceChart, MAIN_KINDS, SUB_KINDS } from './chart.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RENDER_EVERY = 1000; // live redraws at most once a second
const FULL_EVERY = 30 * 60e3; // full reload from the exchange, as a safety net
const EXTRAS_EVERY = 5 * 60e3; // funding, sentiment, on-chain
const BACKGROUND_EVERY = 15 * 60e3; // background updater results
const AWAY_RELOAD = 5 * 60e3; // hidden longer than this: reload on return
const CHART_BARS = 500; // candles per load (more load when scrolling back)
const MAX_BARS = 5000;
const TRADE_ROWS = 20;
const INTERVAL_KEY = 'btc.interval.v1';
const INDICATORS_KEY = 'btc.indicators.v1';

// Candle lengths, and how many forecast (ghost) candles each one shows.
const INTERVALS = {
  '1m': { label: '1m', ghosts: 30 },
  '5m': { label: '5m', ghosts: 24 },
  '15m': { label: '15m', ghosts: 16 },
  '1h': { label: '1h', ghosts: 24 },
  '4h': { label: '4h', ghosts: 12 },
  '1d': { label: '1D', ghosts: 7 },
  '1w': { label: '1W', ghosts: 0 },
};
const IN_MORE = ['1m', '5m', '1w'];

const $ = (id) => document.getElementById(id);

const savedIndicators = load(INDICATORS_KEY, { main: 'MA', sub: 'VOL', ranges: false });
const MARKER_HOURS = [['1h', 1], ['4h', 4], ['24h', 24]];
const MAX_MARKER_BARS = 150;
const state = {
  market: null, // { exchange, hourly, daily } (daily/hourly include the unfinished candle)
  model: null,
  extras: {},
  price: NaN,
  dir: 0, // direction of the last price change: 1 up, -1 down
  now: Date.now(),
  forecast: null,
  interval: INTERVALS[load(INTERVAL_KEY, '15m')] ? load(INTERVAL_KEY, '15m') : '15m',
  main: MAIN_KINDS.includes(savedIndicators.main) ? savedIndicators.main : null,
  sub: SUB_KINDS.includes(savedIndicators.sub) ? savedIndicators.sub : 'VOL',
  ranges: savedIndicators.ranges === true, // full forecast range (grey candles + cone) on the chart
  bars: [], // chart candles, updated live
  loadedInterval: null, // the interval `bars` holds (differs from `interval` while switching)
  chartToken: 0,
  historyBusy: false,
  historyDone: false,
  ghosts: [],
  trades: [], // latest trades, oldest first
  stats: null, // rolling 24h stats from the live feed
  statsAt: 0,
  lastModel: 0,
  busy: false,
  refitting: false,
  feed: null,
  feedState: 'connecting',
  feedName: null,
  lastTrade: 0, // when the last price update arrived (local clock)
  lastTickAt: 0, // when the last individual trade arrived
  hiddenAt: 0,
  background: null,
};

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: settings just aren't remembered */
  }
}

// ---------- Formatting ----------

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const two = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (x) => (Math.abs(x) >= 1000 ? usd0 : usd2).format(x);
const fmt2 = (x) => (Number.isFinite(x) ? two.format(x) : '—');
const fmtBig = (x) => {
  if (!Number.isFinite(x)) return '—';
  for (const [n, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (Math.abs(x) >= n) return `${(x / n).toFixed(2)}${u}`;
  return x.toFixed(2);
};
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (t) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const signedPct = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

function leanText(p) {
  if (Math.abs(p - 0.5) < 0.03) return { cls: 'flat', text: `No clear lean · ${Math.round(p * 100)}% up` };
  return p > 0.5
    ? { cls: 'up', text: `▲ ${Math.round(p * 100)}% chance up` }
    : { cls: 'down', text: `▼ ${Math.round((1 - p) * 100)}% chance down` };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// ---------- Loading ----------

function finished(candles, step, now) {
  return candles.filter((c) => c.t + step <= now);
}

// Refitting runs in a Web Worker so live updates never stall; browsers
// without module workers fit on the main thread instead.
let worker = null;
let jobId = 0;
const jobs = new Map();
function fitModel(hourly, daily) {
  const direct = () => new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(buildModel(hourly, daily));
      } catch (err) {
        reject(err);
      }
    }, 0);
  });
  if (worker === null) {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const job = jobs.get(e.data.id);
        jobs.delete(e.data.id);
        if (job) e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data.model);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        worker.terminate();
        worker = false;
        for (const job of jobs.values()) job.fallback();
        jobs.clear();
      };
    } catch {
      worker = false;
    }
  }
  if (!worker) return direct();
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject, fallback: () => direct().then(resolve, reject) });
    worker.postMessage({ id, hourly, daily });
  });
}

async function refreshAll() {
  if (state.busy) return;
  state.busy = true;
  $('refresh').classList.add('spin');
  try {
    const market = await loadMarket();
    state.market = market;
    const now = Date.now();
    if (!(state.feedState === 'live' && state.price > 0)) state.price = market.hourly[market.hourly.length - 1].c;
    $('error').hidden = true;
    if (!state.model) setStatus('Calculating forecast…');
    state.model = await fitModel(finished(market.hourly, HOUR, now), finished(market.daily, DAY, now));
    state.lastModel = Date.now();
    startFeed();
    if (!state.trades.length) loadTrades();
    await loadChart(state.interval, { merge: true });
    render(true);
    refreshExtras();
  } catch (err) {
    console.warn(err);
    $('error-text').textContent = `Couldn't load Bitcoin prices. ${err.message || err}`;
    $('error').hidden = false;
    if (!state.market) showBackgroundForecast();
    else setStatus('Showing the last data loaded.');
  } finally {
    state.busy = false;
    $('refresh').classList.remove('spin');
  }
}

async function refreshExtras() {
  state.extras = await loadExtras();
  if (state.market) renderIndicators();
}

async function refreshBackground() {
  state.background = await loadBackground().catch(() => null);
  renderTrack();
  if (state.model && state.forecast && state.market) renderSignal();
  if (!state.market) showBackgroundForecast();
}

// ---------- Live feed ----------

function startFeed() {
  if (!state.feed) {
    state.feed = new LiveFeed({
      prefer: state.market.exchange.name,
      onEvent: onLive,
      onState: (s, name) => {
        state.feedState = s;
        state.feedName = name;
        renderLive();
        scheduleTrades();
      },
      poll: async () => ({ price: await state.market.exchange.price(), source: state.market.exchange.name }),
    });
  }
  state.feed.start();
}

function onLive(ev) {
  if (!state.market) return;
  const { hourly, daily } = state.market;
  if (ev.type === 'tick') {
    if (ev.qty > 0) addTrade(ev);
    if (ev.snapshot) return; // recent trades sent on subscribing: list only
    setPrice(ev.price);
    state.lastTrade = state.lastTickAt = Date.now();
    const qty = ev.qty || 0;
    const closedH = applyTick(hourly, HOUR, ev.price, ev.t, qty);
    const closedD = applyTick(daily, DAY, ev.price, ev.t, qty);
    if (state.bars.length) applyTick(state.bars, STEP[state.loadedInterval], ev.price, ev.t, qty);
    if (closedH || closedD) scheduleRefit(true);
  } else if (ev.type === 'kline') {
    const series = ev.interval === '1h' ? hourly : ev.interval === '1d' ? daily : null;
    if (!series) return;
    const added = upsertCandle(series, ev.candle);
    if (ev.closed || added) scheduleRefit(false);
    // The open candle's close is the latest trade price, so it keeps the price
    // moving even if individual trades stop arriving.
    if (!ev.closed && Date.now() - state.lastTickAt > 3000) {
      setPrice(ev.candle.c);
      state.lastTrade = Date.now();
      if (state.bars.length) applyTick(state.bars, STEP[state.loadedInterval], ev.candle.c, Date.now());
    }
  } else if (ev.type === 'stats') {
    state.stats = ev;
    state.statsAt = Date.now();
  }
  scheduleRender();
}

function setPrice(p) {
  if (p > state.price) state.dir = 1;
  else if (p < state.price) state.dir = -1;
  state.price = p;
}

// When a candle closes the model is refit on the new data. Ticks build the new
// candles as they arrive; `sync` also re-reads the latest candles from the
// exchange so the closed candle has exact values.
let refitTimer = 0;
let needSync = false;
function scheduleRefit(sync) {
  needSync ||= sync;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refit, 4000);
}

async function refit() {
  if (!state.market) return;
  if (state.refitting || state.busy) return scheduleRefit(false);
  state.refitting = true;
  document.body.classList.add('refitting');
  const { hourly, daily, exchange } = state.market;
  try {
    if (needSync) {
      needSync = false;
      for (const [interval, series] of [['1h', hourly], ['1d', daily]]) {
        try {
          for (const c of await exchange.candles(interval, 5)) upsertCandle(series, c);
        } catch {
          /* keep the candles built from live trades */
        }
      }
    }
    const now = Date.now();
    state.model = await fitModel(finished(hourly, HOUR, now), finished(daily, DAY, now));
    state.lastModel = Date.now();
    render(true);
  } catch (err) {
    console.warn('Refit failed', err);
  } finally {
    state.refitting = false;
    document.body.classList.remove('refitting');
  }
}

let renderTimer = 0;
let lastRender = 0;
function scheduleRender() {
  if (renderTimer) return;
  const wait = Math.max(0, RENDER_EVERY - (Date.now() - lastRender));
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    render();
  }, wait);
}

// Once a second: keep the clock-driven parts current even when no trades
// arrive, and close candles on time if the feed is quiet.
function everySecond() {
  if (document.hidden || !state.market || !state.model) return;
  const now = Date.now();
  const { hourly, daily } = state.market;
  const closedH = applyTick(hourly, HOUR, state.price, now);
  const closedD = applyTick(daily, DAY, state.price, now);
  if (closedH || closedD) {
    scheduleRefit(true);
    scheduleRender();
  }
  if (state.bars.length && applyTick(state.bars, STEP[state.loadedInterval], state.price, now)) scheduleRender();
  chart.tick(now);
  renderLive();
}

function setStatus(text) {
  $('status').textContent = text;
}

// ---------- Rendering ----------

function render(full = false) {
  if (!state.market || !state.model) return;
  lastRender = Date.now();
  state.now = lastRender;
  state.forecast = forecastFrom(state.model, state.price, state.now);
  renderHeader();
  renderChartLive();
  renderPathTable();
  renderSignal();
  renderCards();
  renderIndicators();
  if (full) renderBacktest();
  renderLive();
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

function renderLive() {
  const badge = $('live');
  const text = $('live-text');
  const st = state.feedState;
  badge.dataset.state = st;
  text.textContent = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', polling: 'Every 10 s', stopped: 'Paused' }[st] || st;
  // The dot blinks once for every price update that arrives.
  if (state.lastTrade && state.lastTrade !== state.blinked) {
    state.blinked = state.lastTrade;
    badge.classList.remove('beat');
    void badge.offsetWidth;
    badge.classList.add('beat');
  }
  if (!state.market || !state.model) return;
  const parts = [];
  if (st === 'live') parts.push(`Live · ${state.feedName}`, state.lastTrade ? `last trade ${ago(Date.now() - state.lastTrade)}` : 'waiting for a trade');
  else if (st === 'polling') parts.push(`Live feed unavailable · checking ${state.market.exchange.name} every 10 s`);
  else if (st === 'reconnecting') parts.push('Reconnecting to the live feed…');
  else parts.push(state.market.exchange.name);
  const m = state.model;
  parts.push(`model ${state.refitting ? 'refitting…' : `refit ${time(state.lastModel)}`} on ${m.hFit.closes.length.toLocaleString()} hourly + ${m.dFit.closes.length.toLocaleString()} daily candles`);
  setStatus(parts.join(' · '));
}

// Price card (layout and metrics as on exchange apps): last price coloured by its last move, ≈ USD value,
// 24h change, and the 24h high, low and volumes.
function renderHeader() {
  const price = state.price;
  const priceEl = $('price');
  priceEl.textContent = fmt2(price);
  priceEl.className = `ticker-price${state.dir > 0 ? ' up' : state.dir < 0 ? ' down' : ''}`;
  $('fiat').textContent = Number.isFinite(price) ? `≈${usdCents.format(price)}` : '';
  const s = dayStats();
  const ch = $('change');
  ch.textContent = Number.isFinite(s.change) ? `${s.change >= 0 ? '+' : ''}${(s.change * 100).toFixed(2)}%` : '';
  ch.className = s.change >= 0 ? 'up' : 'down';
  $('high').textContent = fmt2(s.high);
  $('low').textContent = fmt2(s.low);
  $('vol-base').textContent = fmt2(s.volBase);
  $('vol-quote').textContent = fmtBig(s.volQuote);
  const source = state.feedName || state.market?.exchange.name;
  const usdt = source === 'Binance';
  $('pair').textContent = usdt ? 'BTC/USDT' : 'BTC/USD';
  $('source').textContent = source ? ` · ${source}` : '';
  $('quote').textContent = usdt ? 'USDT' : 'USD';
  $('vol-quote').previousElementSibling.textContent = usdt ? '24h Vol(USDT)' : '24h Vol(USD)';
}

// Rolling 24h figures: from the live feed when it sends them, otherwise worked
// out from the hourly candles.
function dayStats() {
  if (state.stats && Date.now() - state.statsAt < 60e3) return state.stats;
  const now = Date.now();
  const recent = state.market ? state.market.hourly.filter((c) => c.t + HOUR > now - DAY) : [];
  const dayAgo = state.market && [...state.market.hourly].reverse().find((c) => c.t + HOUR <= now - DAY);
  return {
    high: Math.max(...recent.map((c) => c.h), state.price),
    low: Math.min(...recent.map((c) => c.l), state.price),
    volBase: recent.reduce((sum, c) => sum + (c.vb || 0), 0),
    volQuote: recent.reduce((sum, c) => sum + (c.v || 0), 0),
    change: dayAgo ? state.price / dayAgo.c - 1 : NaN,
  };
}

// ---------- Buy / sell signal ----------

const SIDE = {
  buy: { cls: 'up', chip: '▲ Lean buy', word: 'BUY' },
  sell: { cls: 'down', chip: '▼ Lean sell', word: 'SELL' },
  none: { cls: 'flat', chip: 'No edge', word: '' },
};
const pct0 = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');

// Trend (long averages) and momentum (short-term signals) in plain words.
function trendMomentum() {
  const snap = indicatorSnapshot(state.market.daily, state.market.daily[state.market.daily.length - 1].t + DAY > Date.now());
  const by = Object.fromEntries(snap.rows.map((r) => [r.key, r]));
  const sum = (keys) => keys.reduce((n, k) => n + (by[k]?.vote ?? 0), 0);
  const trend = sum(['ema50', 'ema100', 'ema200', 'cross']);
  const momentum = sum(['ema7', 'rsi', 'macd', 'obv']);
  const reasons = (keys, sign) => keys.filter((k) => by[k] && by[k].vote === sign).map((k) => ({
    ema7: sign > 0 ? 'above its 7-day average' : 'below its 7-day average',
    rsi: by.rsi.note.toLowerCase(),
    macd: sign > 0 ? 'MACD above its signal' : 'MACD under its signal',
    obv: sign > 0 ? 'volume flowing in' : 'volume flowing out',
  })[k]);
  const t = trend > 1 ? 'up (price above its 50/100/200-day averages)' : trend < -1 ? 'down (price below its 50/100/200-day averages)' : 'sideways';
  const mWord = momentum > 0 ? 'strengthening' : momentum < 0 ? 'weakening' : 'mixed';
  const why = reasons(['ema7', 'rsi', 'macd', 'obv'], Math.sign(momentum) || 1);
  return `Trend: ${t}. Momentum: ${mWord}${momentum && why.length ? ` (${why.join(', ')})` : ''}.`;
}

function renderSignal() {
  const card = $('signal-card');
  if (!state.model || !state.forecast || !state.market) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const track = state.background?.track?.horizons || {};
  const sigs = HORIZONS.map((hz) => ({
    hz,
    s: signalFor({ pUp: state.model.pUp[hz.key], replay: state.model.tests[hz.key], live: track[hz.key] }),
  }));
  const leaning = sigs.filter((x) => x.s.lean !== 'none');
  const head = $('signal-head');
  const sides = new Set(leaning.map((x) => x.s.lean));
  if (!leaning.length) {
    head.textContent = 'No clear edge right now: the model can’t call the direction better than guessing. Use the ranges below to judge your risk.';
    head.className = 'signal-head flat';
  } else if (sides.size > 1) {
    head.textContent = `Mixed: ${leaning.map((x) => `${SIDE[x.s.lean].word} on ${x.hz.key}`).join(', ')}. No single direction.`;
    head.className = 'signal-head flat';
  } else {
    const side = [...sides][0];
    head.textContent = `${side === 'buy' ? '▲' : '▼'} Leaning ${SIDE[side].word} (${leaning.map((x) => x.hz.key).join(', ')}) — a small edge, not a sure thing.`;
    head.className = `signal-head ${SIDE[side].cls}`;
  }
  const rows = sigs.map(({ hz, s }) => {
    const guess = s.upShare >= 0.5 ? 'up' : 'down';
    const evidence = Number.isFinite(s.right)
      ? `right ${pct0(s.right)} vs ${pct0(s.baseline)} by always guessing ${guess} (${s.n} ${s.source === 'live' ? 'live' : 'replayed'})`
      : 'no record yet';
    return el('tr', {},
      el('td', { class: 'sig-h' }, hz.key),
      el('td', {},
        el('div', { class: 'sig-line' },
          el('span', { class: `sig-chip ${SIDE[s.lean].cls}` }, SIDE[s.lean].chip),
          el('span', { class: 'sig-p' }, `${pct0(s.pUp)} chance up`)),
        el('div', { class: 'sig-ev' }, evidence)));
  });
  $('signal-rows').replaceChildren(el('tbody', {}, ...rows));
  const d = state.forecast.cards['24h'];
  const w = state.forecast.cards['7d'];
  $('signal-risk').textContent =
    `If you buy now at ${fmt2(state.price)}: within 24h there's about a 10% chance it's below ${money(d.lo80)} and 2.5% below ${money(d.lo95)} ` +
    `(within 7 days: 10% below ${money(w.lo80)}). If you sell now: 10% chance it's above ${money(d.hi80)} and 2.5% above ${money(d.hi95)} within 24h.`;
  $('signal-trend').textContent = trendMomentum();
  const mini = $('signal-mini');
  mini.hidden = false;
  mini.className = `signal-mini ${head.className.replace('signal-head', '').trim()}`;
  mini.textContent = !leaning.length ? 'Signal: no clear edge ›' : sides.size > 1 ? 'Signal: mixed ›'
    : `Signal: leaning ${SIDE[[...sides][0]].word.toLowerCase()} (${leaning.map((x) => x.hz.key).join(', ')}) ›`;
}

function renderCards() {
  const wrap = $('cards');
  wrap.replaceChildren();
  const price = state.price;
  for (const hz of HORIZONS) {
    const f = state.forecast.cards[hz.key];
    const lean = leanText(f.pUp);
    const span = f.hi95 - f.lo95;
    const pos = (x) => `${((x - f.lo95) / span) * 100}%`;
    const seg = (cls, a, b) => el('i', { class: `seg ${cls}`, style: `left:${pos(a)};width:calc(${pos(b)} - ${pos(a)})` });
    const midCh = f.mid / price - 1;
    const row = (label, lo, hi) =>
      el('tr', {},
        el('td', {}, label),
        el('td', {}, `${money(lo)} – ${money(hi)}`),
        el('td', {}, `${signedPct(lo / price - 1)} / ${signedPct(hi / price - 1)}`));
    const card = el('article', { class: 'card' },
      el('div', { class: 'h-head' },
        el('span', { class: 'h-name' }, hz.label),
        el('span', { class: `lean ${lean.cls}` }, lean.text)),
      el('div', { class: 'h-mid num' }, money(f.mid), el('small', { class: Math.abs(midCh) < 5e-5 ? 'flat' : midCh > 0 ? 'up' : 'down' }, signedPct(midCh, 2))),
      el('div', { class: 'h-sub' }, `Middle estimate for ${when(f.t)}`),
      el('div', { class: 'rangebar', 'aria-hidden': 'true' },
        seg('s95', f.lo95, f.hi95), seg('s80', f.lo80, f.hi80), seg('s50', f.lo50, f.hi50),
        el('i', { class: 'now', style: `left:${pos(price)}` })),
      el('table', { class: 'ranges' },
        el('tbody', {}, row('50%', f.lo50, f.hi50), row('80%', f.lo80, f.hi80), row('95%', f.lo95, f.hi95))));
    wrap.append(card);
  }
}

function voteCell(vote) {
  const [cls, sym, label] = vote > 0 ? ['vote-up', '▲', 'bullish'] : vote < 0 ? ['vote-down', '▼', 'bearish'] : ['vote-flat', '–', 'neutral'];
  return el('td', { class: `r-vote ${cls}`, title: label, 'aria-label': label }, sym);
}

function indicatorRow(name, value, note, vote) {
  return el('tr', {},
    el('td', {}, el('div', { class: 'r-name' }, name), el('div', { class: 'r-note' }, note)),
    el('td', { class: 'r-val' }, value),
    voteCell(vote));
}

function formatValue(r) {
  if (r.unit === 'usd') return Math.abs(r.value) >= 1e6 ? compact.format(r.value) : money(r.value);
  if (r.unit === 'pct') return signedPct(r.value);
  if (r.unit === 'num2') return r.value.toFixed(2);
  return r.value.toFixed(1);
}

function extraRows() {
  const x = state.extras;
  const rows = [];
  const dayAgo = state.market && [...state.market.hourly].reverse().find((c) => c.t + HOUR <= state.now - DAY);
  const priceUp = dayAgo ? state.price >= dayAgo.c : true;
  if (x.futures && Number.isFinite(x.futures.fundingRate)) {
    const f = x.futures.fundingRate;
    const [note, vote] = f > 0.0003 ? ['Longs paying a lot: crowded', -1] : f < 0 ? ['Shorts paying longs', 1] : ['Normal', 0];
    rows.push({ name: `Funding rate (8h, ${x.futures.source})`, value: `${(f * 100).toFixed(4)}%`, note, vote });
  }
  if (x.futures && Number.isFinite(x.futures.openInterest)) {
    const c = x.futures.openInterestChange;
    let [note, vote] = ['Bets open on BTC perpetual futures', 0];
    if (c > 0.02) [note, vote] = priceUp ? ['Rising with price: new money behind the move', 1] : ['Rising while price falls: shorts adding', -1];
    else if (c < -0.02) [note, vote] = ['Falling: positions closing', 0];
    else if (Number.isFinite(c)) note = 'Little change';
    rows.push({
      name: `Open interest (${x.futures.source})`,
      value: Number.isFinite(c) ? `${signedPct(c)} 24h` : compact.format(x.futures.openInterest),
      note: Number.isFinite(c) ? `${compact.format(x.futures.openInterest)} · ${note}` : note,
      vote,
    });
  }
  if (x.fearGreed) {
    const { now, weekAgo } = x.fearGreed;
    const vote = now.value <= 25 ? 1 : now.value >= 75 ? -1 : 0;
    const why = vote > 0 ? ' (fear often marks lows)' : vote < 0 ? ' (greed often marks highs)' : '';
    rows.push({ name: 'Fear & Greed index', value: String(now.value), note: `${now.label}${why} · a week ago ${weekAgo.value}`, vote });
  }
  if (x.transactions) {
    const c = x.transactions.change;
    const vote = c > 0.05 ? 1 : c < -0.05 ? -1 : 0;
    rows.push({ name: 'Transactions per day', value: Math.round(x.transactions.perDay).toLocaleString(), note: `${signedPct(c)} last 7 days vs the 30 before`, vote });
  }
  if (x.mempool) {
    const m = x.mempool;
    rows.push({ name: 'Waiting transactions (mempool)', value: m.mempoolTx.toLocaleString(), note: `Fast fee ${m.fastestFee} sat/vB · 1-hour fee ${m.hourFee} sat/vB`, vote: 0 });
    if (Number.isFinite(m.hashrateChange)) {
      rows.push({ name: 'Hashrate', value: `${(m.hashrate / 1e18).toFixed(0)} EH/s`, note: `${signedPct(m.hashrateChange)} over the month · miners' commitment`, vote: 0 });
    }
  }
  return rows;
}

function renderIndicators() {
  if (!state.market) return;
  const snap = indicatorSnapshot(state.market.daily, state.market.daily[state.market.daily.length - 1].t + DAY > state.now);
  const why = $('why');
  why.replaceChildren(el('tbody', {}, ...snap.rows.map((r) => indicatorRow(r.name, formatValue(r), r.note, r.vote))));
  const extras = extraRows();
  $('extras-card').hidden = !extras.length;
  $('extras').replaceChildren(el('tbody', {}, ...extras.map((r) => indicatorRow(r.name, r.value, r.note, r.vote))));
  const votes = [...snap.rows, ...extras].map((r) => r.vote);
  const up = votes.filter((v) => v > 0).length;
  const down = votes.filter((v) => v < 0).length;
  const flat = votes.length - up - down;
  const tally = $('tally');
  const verdict = up > down + 1 ? 'Mostly bullish' : down > up + 1 ? 'Mostly bearish' : 'Mixed';
  tally.textContent = `${verdict}: ${up} bullish · ${down} bearish · ${flat} neutral`;
}

function renderBacktest() {
  const t = state.model.tests;
  const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
  const head = el('tr', {}, ...['Horizon', '50% held', '80% held', '95% held', 'Direction right', 'Tests'].map((h) => el('th', {}, h)));
  const rows = HORIZONS.map((hz) => {
    const r = t[hz.key];
    return el('tr', {},
      el('td', {}, hz.key),
      el('td', {}, pct(r.in50)), el('td', {}, pct(r.in80)), el('td', {}, pct(r.in95)),
      el('td', {}, pct(r.hitRate)),
      el('td', {}, String(r.count)));
  });
  $('backtest').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
}

function renderPathTable() {
  const head = el('tr', {}, ...['Candle closes', 'Middle', '50% range', '95% range', 'Up'].map((h) => el('th', {}, h)));
  const rows = state.ghosts.map((g) =>
    el('tr', {},
      el('td', {}, when(g.end)),
      el('td', {}, money(g.mid)),
      el('td', {}, `${money(g.lo50)} – ${money(g.hi50)}`),
      el('td', {}, `${money(g.lo95)} – ${money(g.hi95)}`),
      el('td', {}, `${Math.round(g.pUp * 100)}%`)));
  $('path-table').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
}

// ---------- Chart ----------

const chart = createBinanceChart($('chart'), { onNeedHistory: loadOlder });
chart.setMain(state.main);
chart.setSub(state.sub);

// Candles for a timeframe. `merge` (periodic reloads) folds fresh candles into
// the ones on screen so the view and loaded history stay put.
async function loadChart(interval, { merge = false } = {}) {
  const token = ++state.chartToken;
  const same = interval === state.loadedInterval;
  state.interval = interval;
  save(INTERVAL_KEY, interval);
  markIntervals();
  if (!state.market) return;
  const box = $('chart');
  box.classList.add('loading');
  try {
    const fresh = await state.market.exchange.candles(interval, CHART_BARS);
    if (token !== state.chartToken) return; // a newer choice won
    if (!fresh.length) throw new Error('no candles');
    // Room on the right for the +24h arrow (or as far as arrows are drawn).
    const future = Math.max(10, Math.min(MAX_MARKER_BARS, Math.ceil(DAY / STEP[interval])) + 2);
    const opts = { stepMs: STEP[interval], isDaily: interval === '1d' || interval === '1w', future };
    if (merge && same && state.bars.length) {
      for (const c of fresh) upsertCandle(state.bars, c);
      chart.setData(state.bars, { ...opts, keepView: true });
    } else {
      state.bars = fresh;
      state.historyDone = false;
      chart.setData(fresh, opts);
    }
    state.loadedInterval = interval;
    if (state.model) {
      renderChartLive();
      renderPathTable();
    }
  } catch (err) {
    console.warn('Chart candles', err);
    if (token === state.chartToken) setStatus(`Couldn't load ${INTERVALS[interval].label} candles. ${err.message || err}`);
  } finally {
    if (token === state.chartToken) box.classList.remove('loading');
  }
}

// Scrolled back to the start of the loaded candles: fetch older ones.
async function loadOlder() {
  if (state.historyBusy || state.historyDone || !state.market || !state.bars.length) return;
  if (state.bars.length >= MAX_BARS) return;
  state.historyBusy = true;
  const token = state.chartToken;
  try {
    const first = state.bars[0].t;
    const older = (await state.market.exchange.candles(state.interval, CHART_BARS, first)).filter((c) => c.t < first);
    if (token !== state.chartToken) return;
    if (!older.length) {
      state.historyDone = true;
      return;
    }
    state.bars.unshift(...older);
    chart.prepended(older.length);
  } catch (err) {
    console.warn('Older candles', err);
    state.historyDone = true;
  } finally {
    state.historyBusy = false;
  }
}

// Live candle, indicators and the forecast ghost candles.
function renderChartLive() {
  if (!state.bars.length || state.loadedInterval !== state.interval) return;
  chart.sync();
  const cfg = INTERVALS[state.interval];
  const last = state.bars[state.bars.length - 1];
  state.ghosts = state.model && cfg.ghosts
    ? forecastBars(state.model, state.price, Date.now(), last.t, STEP[state.interval], cfg.ghosts)
    : [];
  chart.setGhosts(state.ranges ? state.ghosts : [], state.price);
  // Likely direction at +1h / +4h / +24h. Coloured only where the model has
  // shown an edge (the same rule as the signal panel); grey otherwise.
  const track = state.background?.track?.horizons || {};
  const cards = state.forecast?.cards;
  chart.setHorizons(cards ? MARKER_HOURS.map(([key]) => {
    const c = cards[key];
    const s = signalFor({ pUp: c.pUp, replay: state.model.tests[key], live: track[key] });
    return { key, t: c.t, mid: c.mid, lo50: c.lo50, hi50: c.hi50, pUp: c.pUp, edge: s.lean !== 'none' };
  }) : [], state.price);
  const word = (c) => (c.pUp > 0.5 ? `up (${pct0(c.pUp)})` : c.pUp < 0.5 ? `down (${pct0(1 - c.pUp)})` : 'flat (50/50)');
  let caption = cards
    ? `Arrows: the likely direction in 1h ${word(cards['1h'])}, 4h ${word(cards['4h'])} and 24h ${word(cards['24h'])}. ` +
      'Coloured where the model has an edge; grey means close to a coin flip.'
    : '';
  const g = state.ghosts[state.ghosts.length - 1];
  if (state.ranges && g) caption += ` Grey candles: the full range for the next ${state.ghosts.length} ${cfg.label} candles (95%: ${money(g.lo95)} – ${money(g.hi95)} by ${when(g.end)}).`;
  else if (!state.ranges) caption += ' Turn on Ranges to see the full forecast range.';
  $('chart-caption').textContent = caption;
  $('chart').setAttribute('aria-label', `Bitcoin ${cfg.label} candlestick chart, last price ${fmt2(state.price)}. ${caption}`);
}

function markIntervals() {
  for (const b of document.querySelectorAll('[data-iv]')) b.setAttribute('aria-pressed', String(b.dataset.iv === state.interval));
  const inMore = IN_MORE.includes(state.interval);
  $('more').textContent = inMore ? `${INTERVALS[state.interval].label} ▾` : 'More ▾';
  $('more').classList.toggle('active', inMore);
}

function markIndicators() {
  for (const b of document.querySelectorAll('[data-main]')) b.setAttribute('aria-pressed', String(b.dataset.main === state.main));
  for (const b of document.querySelectorAll('[data-sub]')) b.setAttribute('aria-pressed', String(b.dataset.sub === state.sub));
  $('ranges').setAttribute('aria-pressed', String(state.ranges));
  $('legend-ranges').hidden = !state.ranges;
  save(INDICATORS_KEY, { main: state.main, sub: state.sub, ranges: state.ranges });
}

// ---------- Full-screen chart ----------

function setFull(on) {
  const card = $('chart-card');
  if (card.classList.contains('full') === on) return;
  card.classList.toggle('full', on);
  document.body.classList.toggle('no-scroll', on);
  $('fs').hidden = on;
  $('fs-close').hidden = !on;
  if (on) {
    history.pushState({ chartFull: true }, '');
    // Real full screen and landscape where the browser allows it (Android);
    // elsewhere the chart simply fills the window.
    card.requestFullscreen?.().then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  } else {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (history.state?.chartFull) history.back();
  }
}

// ---------- Market trades ----------

function addTrade(ev) {
  state.trades.push({ t: ev.t, price: ev.price, qty: ev.qty, side: ev.side });
  if (state.trades.length > 3 * TRADE_ROWS) state.trades.splice(0, state.trades.length - 3 * TRADE_ROWS);
  scheduleTrades();
}

async function loadTrades() {
  try {
    const list = await state.market.exchange.trades(TRADE_ROWS);
    const firstLive = state.trades.length ? state.trades[0].t : Infinity;
    state.trades = [...list.filter((t) => t.t < firstLive), ...state.trades];
    scheduleTrades();
  } catch {
    /* the live feed fills the list */
  }
}

let tradesTimer = 0;
function scheduleTrades() {
  if (!tradesTimer) tradesTimer = setTimeout(renderTrades, 250); // at most 4 redraws a second
}

function renderTrades() {
  tradesTimer = 0;
  const body = $('trades-body');
  while (body.rows.length < TRADE_ROWS) {
    const tr = body.insertRow();
    for (let i = 0; i < 3; i++) tr.insertCell();
  }
  const list = state.trades.slice(-TRADE_ROWS).reverse();
  [...body.rows].forEach((tr, i) => {
    const t = list[i];
    tr.hidden = !t;
    if (!t) return;
    tr.cells[0].textContent = clock(t.t);
    tr.cells[1].textContent = fmt2(t.price);
    tr.cells[1].className = t.side === 'sell' ? 'down' : 'up';
    tr.cells[2].textContent = t.qty.toFixed(5);
  });
  const note = $('trades-note');
  const polling = state.feedState === 'polling';
  note.hidden = list.length > 0 && !polling;
  note.textContent = polling ? 'Live trades are unavailable while the price is checked every 10 s.' : 'Waiting for trades…';
}

// ---------- Controls ----------

function setupControls() {
  markIntervals();
  markIndicators();
  const menu = $('more-menu');
  const closeMenu = () => {
    menu.hidden = true;
    $('more').setAttribute('aria-expanded', 'false');
  };
  for (const b of document.querySelectorAll('[data-iv]')) {
    b.addEventListener('click', () => {
      closeMenu();
      if (b.dataset.iv !== state.interval || state.loadedInterval !== b.dataset.iv) loadChart(b.dataset.iv);
    });
  }
  $('more').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('more').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  for (const b of document.querySelectorAll('[data-main]')) {
    b.addEventListener('click', () => {
      state.main = state.main === b.dataset.main ? null : b.dataset.main; // tap again to hide
      chart.setMain(state.main);
      markIndicators();
    });
  }
  for (const b of document.querySelectorAll('[data-sub]')) {
    b.addEventListener('click', () => {
      state.sub = b.dataset.sub;
      chart.setSub(state.sub);
      markIndicators();
    });
  }
  $('ranges').addEventListener('click', () => {
    state.ranges = !state.ranges;
    markIndicators();
    if (state.model) renderChartLive();
  });
  $('fs').addEventListener('click', () => setFull(true));
  $('fs-close').addEventListener('click', () => setFull(false));
  window.addEventListener('popstate', () => setFull(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setFull(false);
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) setFull(false);
  });
  $('refresh').addEventListener('click', refreshAll);
  $('retry').addEventListener('click', refreshAll);
}

// ---------- Background updater ----------

function pctOf(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : '—';
}

function renderTrack() {
  const track = state.background?.track;
  const card = $('track-card');
  const rows = track ? HORIZONS.filter((hz) => track.horizons?.[hz.key]?.count) : [];
  card.hidden = !rows.length;
  if (!rows.length) return;
  const head = el('tr', {}, ...['Horizon', '50% held', '80% held', '95% held', 'Direction right', 'Checked'].map((h) => el('th', {}, h)));
  const body = rows.map((hz) => {
    const r = track.horizons[hz.key];
    return el('tr', {},
      el('td', {}, hz.key),
      el('td', {}, pctOf(r.in50, r.count)), el('td', {}, pctOf(r.in80, r.count)), el('td', {}, pctOf(r.in95, r.count)),
      el('td', {}, pctOf(r.hits, r.called)),
      el('td', {}, String(r.count)));
  });
  $('track').replaceChildren(el('thead', {}, head), el('tbody', {}, ...body));
  $('track-note').textContent =
    `Real predictions saved every hour by the background updater since ${new Date(track.since).toLocaleDateString()}, ` +
    `checked against the price once their time came. Last update ${when(track.updatedAt)}.`;
}

// No exchange reachable from this device: show the background job's forecast.
function showBackgroundForecast() {
  const f = state.background?.forecast;
  if (!f || state.market) return;
  state.price = f.price;
  state.forecast = { cards: f.cards };
  $('price').textContent = fmt2(f.price);
  $('fiat').textContent = `≈${usdCents.format(f.price)}`;
  renderCards();
  setStatus(`Exchanges unreachable from this device · showing the background forecast from ${when(f.generatedAt)} (${f.source})`);
}

// ---------- Start ----------

setupControls();
refreshAll();
refreshBackground();
setInterval(everySecond, 1000);
setInterval(() => !document.hidden && refreshExtras(), EXTRAS_EVERY);
setInterval(() => !document.hidden && refreshBackground(), BACKGROUND_EVERY);
setInterval(() => !document.hidden && refreshAll(), FULL_EVERY);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.hiddenAt = Date.now();
    state.feed?.stop();
    return;
  }
  if (Date.now() - state.hiddenAt > AWAY_RELOAD) refreshAll();
  else if (state.feed) state.feed.start();
});

// Exposed for tests.
window.__btc = { state, STEP, chart };
