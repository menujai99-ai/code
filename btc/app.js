// BTC Range app: loads market data, runs the model and draws the page.
// The price screen borrows its layout and metrics from exchange apps such as
// Binance: price with 24h figures, candlestick chart with indicator tabs, and
// live Market Trades. The forecast shows on the chart as grey ghost candles
// inside a dashed 95% cone.

import { loadMarket, loadExtras, loadBackground, STEP } from './data.js';
import { indicatorSnapshot } from './model.js';
import {
  buildModel, forecastFrom, forecastBars, signalFor, HORIZONS, touchOdds, suggestLevels, plannerReplay, PLAN_HOURS,
} from './forecast.js';
import { LiveFeed, applyTick, upsertCandle } from './live.js';
import { createBinanceChart, MAIN_KINDS, SUB_KINDS } from './chart.js';
import { predictionEntry, cardsOf, scoreHistory, predictionRows, tally, trimLog, replayLog } from './track.js';

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
const PLAN_KEY = 'btc.plan.v1';
const HISTORY_KEY = 'btc.history.v1'; // predictions made on this device
const SCORES_KEY = 'btc.scores.v1'; // ... and how they turned out
const HISTORY_VIEW_KEY = 'btc.historyView.v1';
const SLOT = 15 * 60e3; // a new prediction every 15 minutes; it stays fixed in between
const REFIT_WAIT = 2 * 60e3; // at the top of the hour, wait this long at most for the refit

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
  plan: planFrom(load(PLAN_KEY, {})),
  snap: null, // the prediction on screen: { slot, t, price, model }
  refitPending: false,
  device: {
    history: listFrom(load(HISTORY_KEY, [])),
    scores: listFrom(load(SCORES_KEY, [])),
  },
  historyView: viewFrom(load(HISTORY_VIEW_KEY, {})),
};

function listFrom(x) {
  return Array.isArray(x) ? x.filter((r) => r && Number.isFinite(r.t)) : [];
}

function viewFrom(saved) {
  return {
    source: ['background', 'replay'].includes(saved.source) ? saved.source : 'device',
    key: HORIZONS.some((hz) => hz.key === saved.key) ? saved.key : '1h',
  };
}

// Trade planner settings. entry / stop / target are null while they follow
// the live price and the suggested levels; only the settings are remembered.
function planFrom(saved) {
  const num = (x, lo, hi, d) => (Number.isFinite(x) && x >= lo && x <= hi ? x : d);
  return {
    side: saved.side === 'short' ? 'short' : 'long',
    hours: PLAN_HOURS.includes(saved.hours) ? saved.hours : 4,
    risk: num(saved.risk, 0.01, 1e9, 100),
    fee: num(saved.fee, 0, 5, 0.1),
    lines: saved.lines !== false,
    entry: null,
    stop: null,
    target: null,
  };
}

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
const signedPct = (x, d = 1) => {
  const v = Math.abs(x * 100).toFixed(d);
  return `${Number(v) === 0 ? '' : x > 0 ? '+' : '−'}${v}%`;
};
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
        const model = buildModel(hourly, daily);
        model.planner = plannerReplay(model);
        resolve(model);
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
  if (state.historyView.source === 'background') renderHistory(); // otherwise nothing it shows has changed
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
  state.refitPending = true;
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
    state.refitPending = false;
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
  if (state.snap && Math.floor(now / SLOT) !== state.snap.slot) scheduleRender(); // time for a new prediction
  chart.tick(now);
  renderLive();
  renderSnapLine();
}

function setStatus(text) {
  $('status').textContent = text;
}

// ---------- Rendering ----------

function render(full = false) {
  if (!state.market || !state.model) return;
  lastRender = Date.now();
  state.now = lastRender;
  takeSnapshot(state.now);
  renderHeader();
  renderChartLive();
  renderPathTable();
  renderSignal();
  renderPlanner();
  renderCards();
  renderIndicators();
  if (full) {
    renderBacktest();
    if (state.historyView.source === 'replay') renderHistory(); // new replays after a refit
  }
  renderLive();
  renderSnapLine();
}

// ---------- Fixed predictions ----------
// A prediction is made once per 15-minute slot (:00, :15, :30, :45) and then
// held: the numbers on screen don't move with every trade. Each one is saved
// to this device's history, so what you see is exactly what gets checked.

function takeSnapshot(now) {
  const slot = Math.floor(now / SLOT);
  if (state.snap?.slot === slot) return;
  // At the top of the hour the model refits on the candle that just closed:
  // keep the old prediction a little longer so the new one uses it.
  if (state.snap && (state.refitPending || state.refitting) && now - slot * SLOT < REFIT_WAIT) return;
  // Reopened within the same slot: show the prediction already made.
  const saved = state.device.history[state.device.history.length - 1];
  if (saved?.source === 'device' && Math.floor(saved.t / SLOT) === slot) {
    state.snap = { slot, t: saved.t, price: saved.price, model: state.model };
    state.forecast = { price: saved.price, now: saved.t, cards: cardsOf(saved) };
  } else {
    state.snap = { slot, t: now, price: state.price, model: state.model };
    state.forecast = forecastFrom(state.model, state.price, now);
    state.device.history.push(predictionEntry(state.forecast.cards, state.price, now, 'device'));
    saveDevice();
  }
  renderHistory();
  scoreDevice();
}

// Saves the device log, dropping the oldest predictions if storage is full.
function saveDevice() {
  let { history, scores } = trimLog(state.device.history, state.device.scores, Date.now());
  for (let tries = 0; tries < 6; tries++) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
      break;
    } catch {
      ({ history, scores } = trimLog(history, scores, Date.now(), { maxEntries: Math.floor(history.length / 2) }));
    }
  }
  state.device.history = history;
  state.device.scores = scores;
}

// Checks this device's predictions whose time has come, against 15-minute
// candles (hourly ones for anything older than those reach).
let candles15 = { at: 0, list: [] };
let scoring = false;
async function scoreDevice() {
  if (scoring || !state.market) return;
  const { history, scores } = state.device;
  const now = Date.now();
  const done = new Set(scores.map((x) => `${x.t}|${x.h}`));
  const due = history.some((run) => Object.entries(run.h || {}).some(([h, p]) => p.target <= now && !done.has(`${run.t}|${h}`)));
  if (!due) return;
  scoring = true;
  try {
    if (now - candles15.at > 5 * 60e3) {
      try {
        candles15 = { at: now, list: await state.market.exchange.candles('15m', 1000) };
      } catch {
        candles15 = { at: now, list: [] };
      }
    }
    const fine = scoreHistory(history, scores, finished(candles15.list, STEP['15m'], now), now, STEP['15m']);
    const coarse = scoreHistory(history, [...scores, ...fine], finished(state.market.hourly, HOUR, now), now, HOUR);
    if (fine.length || coarse.length) {
      state.device.scores = [...scores, ...fine, ...coarse];
      saveDevice();
      renderHistory();
    }
  } finally {
    scoring = false;
  }
}

// "Prediction made 14:15 at 83,100.00 · next update 14:30 (in 7 min)"
function renderSnapLine() {
  const line = $('snap-line');
  if (!state.snap) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  const next = (state.snap.slot + 1) * SLOT;
  const left = Math.max(0, Math.ceil((next - Date.now()) / 60e3));
  line.textContent = `Prediction made ${time(state.snap.t)} at ${fmt2(state.snap.price)} · fixed until ${time(next)} (${left} min)`;
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
    s: signalFor({ pUp: state.forecast.cards[hz.key].pUp, replay: state.model.tests[hz.key], live: track[hz.key] }),
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
    `If you bought at ${fmt2(state.forecast.price)} (the price when this prediction was made, ${time(state.forecast.now)}): within 24h there's about a 10% chance it's below ${money(d.lo80)} and 2.5% below ${money(d.lo95)} ` +
    `(within 7 days: 10% below ${money(w.lo80)}). If you sold then: 10% chance it's above ${money(d.hi80)} and 2.5% above ${money(d.hi95)} within 24h.`;
  $('signal-trend').textContent = trendMomentum();
  const mini = $('signal-mini');
  mini.hidden = false;
  mini.className = `signal-mini ${head.className.replace('signal-head', '').trim()}`;
  mini.textContent = !leaning.length ? 'Signal: no clear edge ›' : sides.size > 1 ? 'Signal: mixed ›'
    : `Signal: leaning ${SIDE[[...sides][0]].word.toLowerCase()} (${leaning.map((x) => x.hz.key).join(', ')}) ›`;
}

// ---------- Trade planner ----------

const plainNum = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const parseNum = (text) => {
  const x = parseFloat(String(text).replace(/[,$\s]/g, ''));
  return Number.isFinite(x) ? x : null;
};
const signedR = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`;
const signedMoney = (x) => `${x >= 0 ? '+' : '−'}${money(Math.abs(x))}`;

// Shows a value in an input unless the user is typing in it.
function showInput(id, value, edited) {
  const input = $(id);
  input.classList.toggle('edited', edited);
  if (document.activeElement !== input) input.value = Number.isFinite(value) ? plainNum.format(value) : '';
}

function planRow(name, value, note, cls = '') {
  return el('tr', {},
    el('td', {}, el('div', { class: 'r-name' }, name), note ? el('div', { class: 'r-note' }, note) : null),
    el('td', { class: `r-val ${cls}` }, el('b', {}, value)));
}

function savePlan() {
  const { side, hours, risk, fee, lines } = state.plan;
  save(PLAN_KEY, { side, hours, risk, fee, lines });
}

function renderPlanner() {
  const card = $('plan-card');
  const m = state.model;
  if (!m || !state.market || !Number.isFinite(state.price)) {
    card.hidden = true;
    chart.setPlanLines([]);
    return;
  }
  card.hidden = false;
  const p = state.plan;
  const key = `${p.hours}h`;
  for (const b of card.querySelectorAll('[data-side]')) b.setAttribute('aria-pressed', String(b.dataset.side === p.side));
  for (const b of card.querySelectorAll('[data-ph]')) b.setAttribute('aria-pressed', String(Number(b.dataset.ph) === p.hours));
  const entry = p.entry ?? state.price;
  const sug = suggestLevels(m, entry, p.side, p.hours);
  const stop = p.stop ?? sug.stop;
  const target = p.target ?? sug.target;
  showInput('plan-entry', entry, p.entry != null);
  showInput('plan-stop', stop, p.stop != null);
  showInput('plan-target', target, p.target != null);
  showInput('plan-risk', p.risk, false);
  showInput('plan-fee', p.fee, false);
  $('plan-lines').checked = p.lines;
  $('plan-reset').hidden = p.entry == null && p.stop == null && p.target == null;

  const odds = touchOdds(m, { side: p.side, entry, stop, target, hours: p.hours, feePct: p.fee / 100 });
  const err = $('plan-error');
  err.hidden = !!odds;
  if (!odds) {
    err.textContent = p.side === 'long'
      ? 'For a long, the stop must be below the entry and the target above it.'
      : 'For a short, the stop must be above the entry and the target below it.';
    $('plan-rows').replaceChildren();
    $('plan-verdict').textContent = '';
    chart.setPlanLines([]);
    return;
  }
  const size = p.risk / odds.risk; // BTC
  const gain = Math.abs(target - entry);
  const loss = Math.abs(entry - stop);
  const evCls = odds.expR > 0.05 ? 'up' : odds.expR < -0.05 ? 'down' : '';
  $('plan-rows').replaceChildren(el('tbody', {},
    planRow('Target first', pct0(odds.pTarget), `the price reaches ${money(target)} before the stop`, 'up'),
    planRow('Stop first', pct0(odds.pStop), `the price reaches ${money(stop)} before the target`, 'down'),
    planRow(`Neither within ${key}`, pct0(odds.pNeither), 'you close at the market price then'),
    planRow('Reward : risk', `${odds.rr.toFixed(2)} : 1`, `+${money(gain)} vs −${money(loss)} per BTC, before fees`),
    planRow('Position size', `${size >= 1 ? size.toFixed(3) : size.toPrecision(3)} BTC`,
      `≈ ${money(size * entry)}; a stop-out loses ${money(p.risk)} including fees`),
    planRow('Expected result', signedR(odds.expR),
      `≈ ${signedMoney(odds.expR * p.risk)} per trade on average, after ${plainNum.format(p.fee)}% fees each way`, evCls)));

  // Verdict: positive expectation only counts where the model has beaten guessing.
  const track = state.background?.track?.horizons || {};
  const sig = signalFor({ pUp: m.pUp[key], replay: m.tests[key], live: track[key] });
  const wanted = p.side === 'long' ? 'buy' : 'sell';
  const feeR = ((p.fee / 100) * 2 * entry) / odds.risk;
  let verdict;
  let vCls = '';
  if (odds.expR < -0.05) {
    verdict = `Skip: after fees this loses about ${Math.abs(odds.expR).toFixed(2)}R per trade on average.`;
    if (feeR > 0.15) verdict += ` Fees alone cost ${feeR.toFixed(2)}R here; a longer window or wider levels make them matter less.`;
    vCls = 'down';
  } else if (odds.expR <= 0.05) {
    verdict = 'About break-even after fees: no edge either way.';
  } else if (sig.lean === wanted) {
    verdict = `Positive expectation (${signedR(odds.expR)}), and the model has beaten guessing at ${key}. Still a small edge: keep the size small.`;
    vCls = 'up';
  } else {
    verdict = `Slightly positive on paper (${signedR(odds.expR)}), but the model hasn’t beaten guessing at ${key}: treat it as break-even at best.`;
  }
  const v = $('plan-verdict');
  v.textContent = verdict;
  v.className = `plan-verdict ${vCls}`;

  const r = m.planner?.[key];
  $('plan-check').textContent = r && r.n
    ? `Checked on ${r.n} past ${key} trades with the suggested levels (long and short, ${plainNum.format(r.feePct * 100)}% fees, no direction lean): ` +
      `target first ${pct0(r.target)} (predicted ${pct0(r.predTarget)}), stop first ${pct0(r.stop)} (predicted ${pct0(r.predStop)}), ` +
      `average ${signedR(r.r)} (predicted ${signedR(r.predR)}). Stops are assumed to fill at the stop price.`
    : '';

  chart.setPlanLines(p.lines ? [
    ...(p.entry != null ? [{ price: entry, title: 'Entry', kind: 'entry' }] : []),
    { price: stop, title: 'Stop', kind: 'stop' },
    { price: target, title: 'Target', kind: 'target' },
  ] : []);
}

function setupPlanner() {
  const p = state.plan;
  const card = $('plan-card');
  const again = () => {
    savePlan();
    renderPlanner();
  };
  for (const b of card.querySelectorAll('[data-side]')) {
    b.addEventListener('click', () => {
      p.side = b.dataset.side;
      p.stop = p.target = null;
      again();
    });
  }
  for (const b of card.querySelectorAll('[data-ph]')) {
    b.addEventListener('click', () => {
      p.hours = Number(b.dataset.ph);
      p.stop = p.target = null;
      again();
    });
  }
  for (const [id, field] of [['plan-entry', 'entry'], ['plan-stop', 'stop'], ['plan-target', 'target']]) {
    const input = $(id);
    input.addEventListener('input', () => {
      const x = parseNum(input.value);
      p[field] = x != null && x > 0 ? x : null; // cleared: back to automatic
      renderPlanner();
    });
    input.addEventListener('change', renderPlanner);
  }
  for (const [id, field, lo, hi] of [['plan-risk', 'risk', 0.01, 1e9], ['plan-fee', 'fee', 0, 5]]) {
    const input = $(id);
    input.addEventListener('input', () => {
      const x = parseNum(input.value);
      if (x != null && x >= lo && x <= hi) {
        p[field] = x;
        again();
      }
    });
    input.addEventListener('change', renderPlanner);
  }
  $('plan-reset').addEventListener('click', () => {
    p.entry = p.stop = p.target = null;
    renderPlanner();
  });
  $('plan-lines').addEventListener('change', (e) => {
    p.lines = e.target.checked;
    again();
  });
}

function renderCards() {
  const wrap = $('cards');
  wrap.replaceChildren();
  const base = state.forecast.price ?? state.price; // the price the prediction was made at
  const price = state.price; // live
  const made = state.forecast.now;
  for (const hz of HORIZONS) {
    const f = state.forecast.cards[hz.key];
    const lean = leanText(f.pUp);
    const span = f.hi95 - f.lo95;
    const pos = (x) => `${((x - f.lo95) / span) * 100}%`;
    const seg = (cls, a, b) => el('i', { class: `seg ${cls}`, style: `left:${pos(a)};width:calc(${pos(b)} - ${pos(a)})` });
    const midCh = f.mid / base - 1;
    const row = (label, lo, hi) =>
      el('tr', {},
        el('td', {}, label),
        el('td', {}, `${money(lo)} – ${money(hi)}`),
        el('td', {}, `${signedPct(lo / base - 1)} / ${signedPct(hi / base - 1)}`));
    // Where the live price sits against this (fixed) prediction so far.
    const inside = price >= f.lo50 && price <= f.hi50 ? 'inside the 50% range'
      : price >= f.lo80 && price <= f.hi80 ? 'inside the 80% range'
        : price >= f.lo95 && price <= f.hi95 ? 'inside the 95% range' : 'outside the 95% range';
    const card = el('article', { class: 'card' },
      el('div', { class: 'h-head' },
        el('span', { class: 'h-name' }, hz.label),
        el('span', { class: `lean ${lean.cls}` }, lean.text)),
      el('div', { class: 'h-mid num' }, money(f.mid), el('small', { class: Math.abs(midCh) < 5e-5 ? 'flat' : midCh > 0 ? 'up' : 'down' }, signedPct(midCh, 2))),
      el('div', { class: 'h-sub' }, `Middle estimate for ${when(f.t)}${Number.isFinite(made) ? ` · made ${time(made)} at ${fmt2(base)}` : ''}`),
      el('div', { class: 'rangebar', 'aria-hidden': 'true' },
        seg('s95', f.lo95, f.hi95), seg('s80', f.lo80, f.hi80), seg('s50', f.lo50, f.hi50),
        el('i', { class: 'now', style: `left:${pos(price)}` })),
      el('table', { class: 'ranges' },
        el('tbody', {}, row('50%', f.lo50, f.hi50), row('80%', f.lo80, f.hi80), row('95%', f.lo95, f.hi95))),
      Number.isFinite(price) ? el('div', { class: 'h-now' }, `Now ${fmt2(price)} · ${inside} so far`) : null);
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
  const snap = state.snap;
  state.ghosts = snap && cfg.ghosts
    ? forecastBars(snap.model, snap.price, snap.t, last.t, STEP[state.interval], cfg.ghosts)
    : [];
  chart.setGhosts(state.ranges ? state.ghosts : [], snap?.price ?? state.price);
  // Likely direction at +1h / +4h / +24h. Coloured only where the model has
  // shown an edge (the same rule as the signal panel); grey otherwise.
  const track = state.background?.track?.horizons || {};
  const cards = snap && state.forecast?.cards;
  chart.setHorizons(cards ? MARKER_HOURS.map(([key]) => {
    const c = cards[key];
    const s = signalFor({ pUp: c.pUp, replay: state.model.tests[key], live: track[key] });
    return { key, t: c.t, mid: c.mid, lo50: c.lo50, hi50: c.hi50, pUp: c.pUp, edge: s.lean !== 'none' };
  }) : [], snap?.price, snap?.t);
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

// ---------- Prediction history ----------
// The predictions saved on this device (or by the background job), checked
// against the price once their time came: totals, a chart of the predicted
// ranges with where the price actually landed, and a table.

const HISTORY_SHOW = 40; // checked predictions in the chart
const HISTORY_WAITING = 12; // and the next ones still waiting
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const shortWhen = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? time(t) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

const landedIn = (p, x) => (x >= p.lo50 && x <= p.hi50 ? '50%' : x >= p.lo80 && x <= p.hi80 ? '80%' : x >= p.lo95 && x <= p.hi95 ? '95%' : 'outside');

function callText(r) {
  if (r.pUp === 0.5) return '–';
  const up = r.pUp > 0.5;
  const sym = `${up ? '▲' : '▼'}${pct0(up ? r.pUp : 1 - r.pUp)}`;
  return r.score ? `${sym} ${r.score.hit ? '✓' : '✗'}` : sym;
}

let replayed = { model: null, log: { history: [], scores: [] } };
function historySource() {
  if (state.historyView.source === 'device') return state.device;
  if (state.historyView.source === 'replay') {
    if (state.model && replayed.model !== state.model) replayed = { model: state.model, log: replayLog(state.model.tests) };
    return replayed.log;
  }
  return { history: state.background?.history || [], scores: state.background?.scores || [] };
}

function niceStep(span, n) {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
}

function renderHistory() {
  const v = state.historyView;
  const card = $('history-card');
  for (const b of card.querySelectorAll('[data-hsrc]')) b.setAttribute('aria-pressed', String(b.dataset.hsrc === v.source));
  for (const b of card.querySelectorAll('[data-hkey]')) b.setAttribute('aria-pressed', String(b.dataset.hkey === v.key));
  const device = v.source === 'device';
  const replay = v.source === 'replay';
  const { history, scores } = historySource();
  const rows = predictionRows(history, scores, v.key);
  const checked = rows.filter((r) => r.score);
  const waiting = rows.filter((r) => !r.score);
  const track = state.background?.track;
  let note = replay
    ? `The model re-run ${{ '1h': 'every hour', '4h': 'every 4 hours', '24h': 'every 3 hours', '7d': 'every day' }[v.key]} over the last ${v.key === '1h' ? 10 : 30} days, using only the data it had then, and checked against what happened next: the same replays as “How well has it worked?”. The up/down chance is the model’s own lean; the live app pulls it toward 50% where it hasn’t beaten guessing.`
    : device
    ? 'Saved on this device every 15 minutes while the app is open (the fixed prediction shown above the chart), then checked against the price when its time comes.'
    : `Saved by the background job on GitHub, which runs a few times a day even when nobody has the app open; the same for everyone.${track ? ` Last run ${when(track.updatedAt)}.` : ''}`;
  if (!rows.length) {
    note += replay
      ? ' Calculating…'
      : device
      ? ' Nothing saved yet: the first prediction is saved once the forecast has loaded, and checked after an hour.'
      : state.background?.history ? ' Nothing saved yet.' : ' Its log couldn’t be loaded right now.';
  }
  $('history-note').textContent = note;
  $('history-body').hidden = !rows.length;
  if (!rows.length) return;

  // Totals: all checked, and the last 20.
  const all = tally(checked.map((r) => r.score));
  const last = tally(checked.slice(-20).map((r) => r.score));
  const upShare = all.ups / all.count;
  const tile = (label, value, sub) => el('div', { class: 'tile' },
    el('div', { class: 'tile-label' }, label), el('div', { class: 'tile-value' }, value), el('div', { class: 'tile-sub' }, sub));
  const held = (label, k, aim) => tile(`${label} range held`, pctOf(all[k], all.count),
    `aim ${aim} · last ${last.count}: ${pctOf(last[k], last.count)}`);
  $('history-tiles').replaceChildren(...(checked.length ? [
    tile('Direction right', all.called ? pctOf(all.hits, all.called) : '—', all.called
      ? `of ${all.called} calls · always guessing ${upShare >= 0.5 ? 'up' : 'down'}: ${pct0(Math.max(upShare, 1 - upShare))}`
      : 'no calls yet (all 50/50)'),
    held('50%', 'in50', '50%'),
    held('80%', 'in80', '80%'),
    held('95%', 'in95', '95%'),
  ] : [el('p', { class: 'note' }, `None checked yet: the first ${v.key} prediction is checked after ${shortWhen(waiting[0].target)}.`)]));

  renderHistoryChart([...checked.slice(-HISTORY_SHOW), ...waiting.slice(0, HISTORY_WAITING)], v.key);

  const next = waiting[0];
  $('history-pending').textContent = `${checked.length} checked · ${waiting.length} waiting` + (next
    ? next.target <= Date.now() ? ' (checked on the next update)' : ` · next check after ${shortWhen(next.target)}`
    : '');

  const head = el('tr', {}, ...['Made', 'Price then', `Price at +${v.key}`, 'Landed in', 'Call'].map((h) => el('th', {}, h)));
  const body = checked.slice(-20).reverse().map((r) => el('tr', {},
    el('td', {}, shortWhen(r.t)),
    el('td', {}, money(r.price)),
    el('td', {}, money(r.score.actual)),
    el('td', { class: landedIn(r, r.score.actual) === 'outside' ? 'miss' : '' }, landedIn(r, r.score.actual)),
    el('td', {}, callText(r))));
  $('history-table').replaceChildren(el('thead', {}, head), el('tbody', {}, ...body));
  $('history-table').hidden = !body.length;
}

// The predicted 80% and 50% ranges, one column per prediction (oldest left),
// with a dot where the price actually was at the target time.
function renderHistoryChart(items, key) {
  const box = $('history-chart');
  const W = Math.max(280, box.clientWidth || 340);
  const H = 190;
  const m = { l: 62, r: 6, t: 10, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const prices = items.flatMap((r) => [r.lo80, r.hi80, ...(r.score ? [r.score.actual] : [])]);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || hi * 0.001;
  lo -= pad;
  hi += pad;
  const n = items.length;
  const bw = pw / n;
  const x = (i) => m.l + bw * (i + 0.5);
  const y = (p) => m.t + ((hi - p) / (hi - lo)) * ph;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Predicted ${key} ranges and actual prices for the last ${n} predictions` });
  const hover = svgEl('rect', { class: 'hc-hover', y: m.t, height: ph, width: bw, x: -bw });
  svg.append(hover);
  const step = niceStep(hi - lo, 3);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    svg.append(svgEl('line', { class: 'hc-grid', x1: m.l, x2: W - m.r, y1: y(p), y2: y(p) }),
      svgEl('text', { class: 'hc-tick', x: m.l - 6, y: y(p) + 4, 'text-anchor': 'end' }, money(p)));
  }
  const firstWaiting = items.findIndex((r) => !r.score);
  if (firstWaiting > 0) {
    const xs = m.l + bw * firstWaiting;
    svg.append(svgEl('line', { class: 'hc-grid', x1: xs, x2: xs, y1: m.t, y2: H - m.b }));
    if (W - m.r - xs >= 52) svg.append(svgEl('text', { class: 'hc-tick', x: xs + 4, y: m.t + 9 }, 'waiting'));
  }
  for (const i of [...new Set([0, Math.floor((n - 1) / 2), n - 1])]) {
    const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const tx = anchor === 'start' ? m.l : anchor === 'end' ? W - m.r : x(i);
    svg.append(svgEl('text', { class: 'hc-tick', x: tx, y: H - 6, 'text-anchor': anchor }, shortWhen(items[i].target)));
  }
  const w50 = Math.max(4, Math.min(10, bw * 0.55));
  items.forEach((r, i) => {
    const cx = x(i);
    const g = svgEl('g', { class: r.score ? 'hc-item' : 'hc-item wait' },
      svgEl('rect', { class: 'hc-r80', x: cx - 1, width: 2, y: y(r.hi80), height: Math.max(1, y(r.lo80) - y(r.hi80)), rx: 1 }),
      svgEl('rect', { class: 'hc-r50', x: cx - w50 / 2, width: w50, y: y(r.hi50), height: Math.max(2, y(r.lo50) - y(r.hi50)), rx: Math.min(3, w50 / 2) }),
      svgEl('line', { class: 'hc-mid', x1: cx - w50 / 2, x2: cx + w50 / 2, y1: y(r.mid), y2: y(r.mid) }));
    if (r.score) {
      g.append(svgEl('circle', { class: r.score.in80 ? 'hc-hit' : 'hc-miss', cx, cy: y(r.score.actual), r: 4 }));
    }
    svg.append(g);
  });
  // Hover or tap a column for that prediction's numbers.
  const tip = el('div', { class: 'hc-tip', hidden: '' });
  const show = (i) => {
    const r = items[i];
    hover.setAttribute('x', m.l + bw * i);
    const lines = [
      `${key} prediction made ${shortWhen(r.t)} at ${fmt2(r.price)}`,
      `For ${shortWhen(r.target)}: middle ${money(r.mid)}`,
      `50%: ${money(r.lo50)} – ${money(r.hi50)} · 80%: ${money(r.lo80)} – ${money(r.hi80)}`,
      r.pUp === 0.5 ? 'No up/down call (50/50)' : `${r.pUp > 0.5 ? '▲' : '▼'} ${pct0(Math.max(r.pUp, 1 - r.pUp))} chance ${r.pUp > 0.5 ? 'up' : 'down'}`,
      r.score
        ? `Actual ${fmt2(r.score.actual)}: ${landedIn(r, r.score.actual) === 'outside' ? 'outside the 95% range' : `inside the ${landedIn(r, r.score.actual)} range`}` +
          (r.pUp === 0.5 ? '' : ` · call ${r.score.hit ? 'right ✓' : 'wrong ✗'}`)
        : `Waiting: checked after ${shortWhen(r.target)}`,
    ];
    tip.replaceChildren(...lines.map((t, k) => el('div', k === 0 ? { class: 'hc-tip-head' } : {}, t)));
    tip.hidden = false;
    const cx = x(i);
    tip.style.left = `${cx}px`;
    tip.classList.toggle('flip', cx > W / 2);
  };
  const hide = () => {
    tip.hidden = true;
    hover.setAttribute('x', -bw);
  };
  items.forEach((_, i) => {
    const hit = svgEl('rect', { class: 'hc-hitbox', x: m.l + bw * i, y: m.t, width: bw, height: ph });
    hit.addEventListener('pointerenter', () => show(i));
    hit.addEventListener('click', () => show(i));
    svg.append(hit);
  });
  svg.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide());
  box.replaceChildren(svg, tip);
}

function setupHistory() {
  const card = $('history-card');
  const pick = (field, value) => {
    state.historyView[field] = value;
    save(HISTORY_VIEW_KEY, state.historyView);
    renderHistory();
  };
  for (const b of card.querySelectorAll('[data-hsrc]')) b.addEventListener('click', () => pick('source', b.dataset.hsrc));
  for (const b of card.querySelectorAll('[data-hkey]')) b.addEventListener('click', () => pick('key', b.dataset.hkey));
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHistory, 150);
  });
}

// No exchange reachable from this device: show the background job's forecast.
function showBackgroundForecast() {
  const f = state.background?.forecast;
  if (!f || state.market) return;
  state.price = f.price;
  state.forecast = { price: f.price, now: f.generatedAt, cards: f.cards };
  $('price').textContent = fmt2(f.price);
  $('fiat').textContent = `≈${usdCents.format(f.price)}`;
  renderCards();
  setStatus(`Exchanges unreachable from this device · showing the background forecast from ${when(f.generatedAt)} (${f.source})`);
}

// ---------- Start ----------

setupControls();
setupPlanner();
setupHistory();
renderHistory();
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
