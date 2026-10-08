// BTC Range app: loads market data, runs the model and draws the page.
// The hero chart follows the original sketch: the blue line is the actual
// price up to Today, red candles are the predicted path, and the red dashed
// cone is the 95% range.

import { loadMarket, loadExtras, loadBackground, STEP } from './data.js';
import { ema, indicatorSnapshot } from './model.js';
import { buildModel, forecastFrom, HORIZONS } from './forecast.js';
import { LiveFeed, applyTick, upsertCandle } from './live.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RENDER_EVERY = 1000; // live redraws at most once a second
const FULL_EVERY = 30 * 60e3; // full reload from the exchange, as a safety net
const EXTRAS_EVERY = 5 * 60e3; // funding, sentiment, on-chain
const BACKGROUND_EVERY = 15 * 60e3; // background updater results
const AWAY_RELOAD = 5 * 60e3; // hidden longer than this: reload on return
const EMA_KEY = 'btc.emas.v1';
const VIEW_KEY = 'btc.view.v1';

const $ = (id) => document.getElementById(id);

const state = {
  market: null, // { exchange, hourly, daily } (daily/hourly include the unfinished candle)
  model: null,
  extras: {},
  price: NaN,
  now: Date.now(),
  forecast: null,
  view: load(VIEW_KEY, 'days'),
  emas: new Set(load(EMA_KEY, [7, 50])),
  lastModel: 0,
  busy: false,
  refitting: false,
  hover: null,
  feed: null,
  feedState: 'connecting',
  feedName: null,
  lastTrade: 0,
  shownPrice: NaN,
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
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const money = (x) => (Math.abs(x) >= 1000 ? usd0 : usd2).format(x);
const signedPct = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayMonth = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'numeric' });
const weekday = (t) => new Date(t).toLocaleDateString([], { weekday: 'short' });
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
  $('chart').classList.add('loading');
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
    $('chart').classList.remove('loading');
  }
}

async function refreshExtras() {
  state.extras = await loadExtras();
  if (state.market) renderIndicators();
}

async function refreshBackground() {
  state.background = await loadBackground().catch(() => null);
  renderTrack();
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
    state.price = ev.price;
    state.lastTrade = Date.now();
    const closedH = applyTick(hourly, HOUR, ev.price, ev.t, ev.volume || 0);
    const closedD = applyTick(daily, DAY, ev.price, ev.t, ev.volume || 0);
    if (closedH || closedD) scheduleRefit(true);
  } else if (ev.type === 'kline') {
    const series = ev.interval === '1h' ? hourly : ev.interval === '1d' ? daily : null;
    if (!series) return;
    const added = upsertCandle(series, ev.candle);
    if (ev.closed || added) scheduleRefit(false);
  }
  scheduleRender();
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
  renderHero();
  renderChart();
  renderPathTable();
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

function renderHero() {
  const { hourly } = state.market;
  const price = state.price;
  const priceEl = $('price');
  priceEl.textContent = money(price);
  if (Number.isFinite(state.shownPrice) && price !== state.shownPrice) {
    priceEl.classList.remove('flash-up', 'flash-down');
    void priceEl.offsetWidth; // restart the animation
    priceEl.classList.add(price > state.shownPrice ? 'flash-up' : 'flash-down');
  }
  state.shownPrice = price;
  const dayAgo = [...hourly].reverse().find((c) => c.t + HOUR <= state.now - DAY);
  const change = $('change');
  if (dayAgo) {
    const ch = price / dayAgo.c - 1;
    change.textContent = `${ch >= 0 ? '▲' : '▼'} ${signedPct(ch, 2)} 24h`;
    change.className = ch >= 0 ? 'up' : 'down';
  }
  const vol = hourly.filter((c) => c.t + HOUR > state.now - DAY).reduce((s, c) => s + c.v, 0);
  $('volume').textContent = `Volume 24h ${compact.format(vol)}`;
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
    rows.push({ name: 'Funding rate (8h)', value: `${(f * 100).toFixed(4)}%`, note, vote });
  }
  if (x.futures && Number.isFinite(x.futures.openInterestChange)) {
    const c = x.futures.openInterestChange;
    let [note, vote] = ['Little change', 0];
    if (c > 0.02) [note, vote] = priceUp ? ['Rising with price: new money behind the move', 1] : ['Rising while price falls: shorts adding', -1];
    else if (c < -0.02) [note, vote] = ['Falling: positions closing', 0];
    rows.push({ name: 'Open interest, 24h', value: signedPct(c), note: `${compact.format(x.futures.openInterest)} · ${note}`, vote });
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
  const path = state.view === 'days' ? state.forecast.dayPath : state.forecast.hourPath;
  const head = el('tr', {}, ...['Time', 'Middle', '80% range', '95% range', 'Up'].map((h) => el('th', {}, h)));
  const rows = path.map((p) =>
    el('tr', {},
      el('td', {}, when(p.t)),
      el('td', {}, money(p.mid)),
      el('td', {}, `${money(p.lo80)} – ${money(p.hi80)}`),
      el('td', {}, `${money(p.lo95)} – ${money(p.hi95)}`),
      el('td', {}, `${Math.round(p.pUp * 100)}%`)));
  $('path-table').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
}

// ---------- Chart ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function niceStep(range, count) {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

function priceTick(v, step) {
  if (step >= 1000) return `$${Math.round(v / 1000)}k`;
  if (step >= 100) return `$${(v / 1000).toFixed(1)}k`;
  return `$${Math.round(v).toLocaleString()}`;
}

// The series behind the chart for the current view.
function chartData() {
  const { hourly, daily } = state.market;
  const days = state.view === 'days';
  const candles = days ? daily : hourly;
  const step = days ? DAY : HOUR;
  const span = days ? 30 * DAY : 72 * HOUR;
  // Each finished candle is plotted at its close time; the unfinished one at now.
  const pts = candles.map((c, i) => ({ t: Math.min(c.t + step, state.now), c: c.c, i }));
  const start = state.now - span;
  const hist = pts.filter((p) => p.t >= start);
  hist[hist.length - 1] = { ...hist[hist.length - 1], t: state.now, c: state.price };

  const dailyCloses = daily.map((c) => c.c);
  const emaLines = [];
  for (const period of [...state.emas].sort((a, b) => a - b)) {
    const series = ema(dailyCloses, period);
    if (days) {
      const line = hist.map((p) => ({ t: p.t, v: series[p.i] })).filter((p) => Number.isFinite(p.v));
      if (line.length) emaLines.push({ period, line });
    } else {
      const v = series[series.length - 1];
      if (Number.isFinite(v)) emaLines.push({ period, line: [{ t: hist[0].t, v }, { t: state.now, v }] });
    }
  }
  const path = days ? state.forecast.dayPath : state.forecast.hourPath;
  return { days, step: days ? DAY : 4 * HOUR, hist, emaLines, path };
}

function renderChart() {
  const box = $('chart');
  const svg = $('chart-svg');
  const W = Math.max(box.clientWidth, 280);
  const H = box.clientHeight || 300;
  const M = { top: 26, right: 10, bottom: 26, left: 46 };
  const d = chartData();
  const { hist, path, emaLines } = d;
  const price = state.price;

  // Scales
  const t0 = hist[0].t;
  const t1 = path[path.length - 1].t + d.step * 0.6;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of hist) { lo = Math.min(lo, p.c); hi = Math.max(hi, p.c); }
  for (const p of path) { lo = Math.min(lo, p.lo95); hi = Math.max(hi, p.hi95); }
  for (const e of emaLines) for (const p of e.line) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const yStep = niceStep(hi - lo, H < 260 ? 4 : 5);
  const x = (t) => M.left + ((t - t0) / (t1 - t0)) * (W - M.left - M.right);
  const y = (v) => M.top + (1 - (v - lo) / (hi - lo)) * (H - M.top - M.bottom);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();

  // Grid + price axis
  const grid = s('g');
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
    grid.append(s('line', { class: 'grid', x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }));
    grid.append(s('text', { x: M.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, priceTick(v, yStep)));
  }
  grid.append(s('line', { class: 'axis', x1: M.left, x2: W - M.right, y1: H - M.bottom, y2: H - M.bottom }));
  svg.append(grid);

  // Time axis: dates like the sketch (Days) or midnights (Hours).
  const ticks = s('g');
  const tickEvery = d.days ? 7 * DAY : DAY;
  const first = new Date(t0);
  first.setHours(0, 0, 0, 0);
  let lastX = -Infinity;
  for (let t = first.getTime(); t <= t1; t += tickEvery) {
    const date = new Date(t);
    date.setHours(0, 0, 0, 0); // stay on local midnight across DST changes
    const tt = date.getTime();
    if (tt < t0) continue;
    const xx = x(tt);
    if (xx - lastX < 44 || xx > W - M.right - 10) continue;
    lastX = xx;
    ticks.append(s('line', { class: 'axis', x1: xx, x2: xx, y1: H - M.bottom, y2: H - M.bottom + 4 }));
    ticks.append(s('text', { x: xx, y: H - M.bottom + 16, 'text-anchor': 'middle' }, d.days ? dayMonth(tt) : `${weekday(tt)} ${new Date(tt).getDate()}`));
  }
  svg.append(ticks);

  // Today divider
  const xNow = x(state.now);
  svg.append(s('line', { class: 'now-line', x1: xNow, x2: xNow, y1: M.top - 6, y2: H - M.bottom }));

  // EMA lines with labels at their left end
  const labels = [];
  for (const e of emaLines) {
    const dash = { 7: 'none', 50: '6 4', 100: '2 3', 200: '10 3 2 3' }[e.period] ?? '4 4';
    svg.append(s('polyline', {
      class: 'ema', points: e.line.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '),
      'stroke-dasharray': dash,
    }));
    labels.push({ text: `EMA ${e.period}`, y: y(e.line[0].v) - 4 });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 12);
  for (const l of labels) {
    const ly = Math.min(Math.max(l.y, M.top + 8), H - M.bottom - 4);
    svg.append(s('rect', { class: 'ema-label-bg', x: M.left + 2, y: ly - 9, width: 44, height: 12, rx: 3 }));
    svg.append(s('text', { class: 'ema-label', x: M.left + 4, y: ly }, l.text));
  }

  // Forecast cone (95%), dashed edges like the sketch
  const upper = [[xNow, y(price)], ...path.map((p) => [x(p.t), y(p.hi95)])];
  const lower = [[xNow, y(price)], ...path.map((p) => [x(p.t), y(p.lo95)])];
  const ptsStr = (arr) => arr.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  svg.append(s('polygon', { class: 'cone', points: ptsStr([...upper, ...lower.slice(1).reverse()]) }));
  svg.append(s('polyline', { class: 'cone-edge', points: ptsStr(upper) }));
  svg.append(s('polyline', { class: 'cone-edge', points: ptsStr(lower) }));

  // Red forecast candles, one per step: the box is the 50% range, the thin
  // line the 80% range, and the tick across the box the middle estimate.
  const stepPx = x(state.now + d.step) - xNow;
  const bw = Math.max(4, Math.min(16, stepPx * 0.5));
  const candles = s('g');
  path.forEach((p, i) => {
    const cx = x(p.t);
    const g = s('g', { class: `candle${state.hover?.kind === 'f' && state.hover.i === i ? ' active' : ''}` });
    g.append(s('line', { class: 'wick', x1: cx, x2: cx, y1: y(p.hi80), y2: y(p.lo80) }));
    g.append(s('rect', { class: 'body', x: cx - bw / 2, y: y(p.hi50), width: bw, height: Math.max(y(p.lo50) - y(p.hi50), 2), rx: 1.5 }));
    g.append(s('line', { class: 'mid', x1: cx - bw / 2 - 2, x2: cx + bw / 2 + 2, y1: y(p.mid), y2: y(p.mid) }));
    candles.append(g);
  });
  svg.append(candles);

  // Actual price line (blue) and the Today dot
  svg.append(s('polyline', { class: 'actual', points: hist.map((p) => `${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ') }));
  svg.append(s('circle', { class: 'today-dot', cx: xNow, cy: y(price), r: 5 }));
  const labelAbove = y(price) - M.top > 30;
  svg.append(s('text', {
    class: 'today-label', x: xNow, y: labelAbove ? y(price) - 12 : y(price) + 22, 'text-anchor': 'middle',
  }, d.days ? 'Today' : 'Now'));

  // Hover layer
  const hover = state.hover;
  if (hover) {
    const hx = hover.kind === 'h' ? x(hist[hover.i].t) : x(path[hover.i].t);
    svg.append(s('line', { class: 'cross', x1: hx, x2: hx, y1: M.top - 6, y2: H - M.bottom }));
    if (hover.kind === 'h') svg.append(s('circle', { class: 'hover-dot', cx: hx, cy: y(hist[hover.i].c), r: 4.5 }));
  }

  state.chart = { x, y, hist, path, emaLines, W, M, xNow };
  renderTip();
  $('legend-ema').hidden = !emaLines.length;
  const last = path[path.length - 1];
  $('chart-caption').textContent =
    `${d.days ? 'Last 30 days and the next 7' : 'Last 3 days and the next 24 hours, in 4-hour steps'}. ` +
    `By ${when(last.t)}, the model gives 95% odds of ${money(last.lo95)} – ${money(last.hi95)}.`;
  box.setAttribute('aria-label', `Bitcoin price ${money(price)}. ${$('chart-caption').textContent}`);
}

function renderTip() {
  const tip = $('tip');
  const h = state.hover;
  const c = state.chart;
  if (!h || !c) {
    tip.hidden = true;
    return;
  }
  const rows = [];
  const row = (keyCls, value, label) =>
    el('div', { class: 't-row' }, el('i', { class: `key ${keyCls}` }), el('b', {}, value), el('span', {}, label));
  let t;
  if (h.kind === 'h') {
    const p = c.hist[h.i];
    t = p.t;
    rows.push(el('div', { class: 't-head' }, h.i === c.hist.length - 1 ? `Now · ${when(t)}` : when(t)));
    rows.push(row('', money(p.c), 'price'));
    for (const e of c.emaLines) {
      const pt = e.line.find((q) => q.t === p.t) || e.line[e.line.length - 1];
      rows.push(row('ema', money(pt.v), `EMA ${e.period}`));
    }
  } else {
    const p = c.path[h.i];
    t = p.t;
    rows.push(el('div', { class: 't-head' }, `Forecast · ${when(t)}`));
    rows.push(row('pred', money(p.mid), 'middle'));
    rows.push(row('pred', `${money(p.lo50)} – ${money(p.hi50)}`, '50%'));
    rows.push(row('pred', `${money(p.lo80)} – ${money(p.hi80)}`, '80%'));
    rows.push(row('pred', `${money(p.lo95)} – ${money(p.hi95)}`, '95%'));
    rows.push(el('div', { class: 't-row' }, el('span', {}, `Chance it's higher than now: ${Math.round(p.pUp * 100)}%`)));
  }
  tip.replaceChildren(...rows);
  tip.hidden = false;
  const xx = c.x(t);
  const w = tip.offsetWidth;
  const left = xx + 12 + w > c.W ? xx - 12 - w : xx + 12;
  tip.style.left = `${Math.max(0, left)}px`;
}

function pointsForHover() {
  const c = state.chart;
  return [
    ...c.hist.map((p, i) => ({ kind: 'h', i, px: c.x(p.t) })),
    ...c.path.map((p, i) => ({ kind: 'f', i, px: c.x(p.t) })),
  ];
}

function setupChartEvents() {
  const box = $('chart');
  const move = (e) => {
    if (!state.chart) return;
    const rect = box.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * state.chart.W;
    let best = null;
    for (const p of pointsForHover()) if (!best || Math.abs(p.px - px) < Math.abs(best.px - px)) best = p;
    if (best && (state.hover?.kind !== best.kind || state.hover?.i !== best.i)) {
      state.hover = { kind: best.kind, i: best.i };
      renderChart();
    }
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerdown', move);
  box.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') {
      state.hover = null;
      renderChart();
    }
  });
  box.addEventListener('keydown', (e) => {
    if (!state.chart || !['ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      state.hover = null;
      renderChart();
      return;
    }
    const all = pointsForHover();
    let idx = state.hover ? all.findIndex((p) => p.kind === state.hover.kind && p.i === state.hover.i) : state.chart.hist.length - 1;
    idx = Math.min(all.length - 1, Math.max(0, idx + (e.key === 'ArrowRight' ? 1 : -1)));
    state.hover = { kind: all[idx].kind, i: all[idx].i };
    renderChart();
  });
  box.addEventListener('blur', () => {
    state.hover = null;
    if (state.chart) renderChart();
  });
}

function setupControls() {
  for (const input of document.querySelectorAll('input[name="view"]')) {
    input.checked = input.value === state.view;
    input.addEventListener('change', () => {
      state.view = input.value;
      state.hover = null;
      save(VIEW_KEY, state.view);
      if (state.market && state.forecast) {
        renderChart();
        renderPathTable();
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-ema]')) {
    const period = +btn.dataset.ema;
    btn.setAttribute('aria-pressed', String(state.emas.has(period)));
    btn.addEventListener('click', () => {
      if (state.emas.has(period)) state.emas.delete(period);
      else state.emas.add(period);
      btn.setAttribute('aria-pressed', String(state.emas.has(period)));
      save(EMA_KEY, [...state.emas]);
      if (state.market && state.forecast) renderChart();
    });
  }
  $('refresh').addEventListener('click', refreshAll);
  $('retry').addEventListener('click', refreshAll);
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => state.market && state.forecast && renderChart());
  }).observe($('chart'));
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
  $('price').textContent = money(f.price);
  renderCards();
  setStatus(`Exchanges unreachable from this device · showing the background forecast from ${when(f.generatedAt)} (${f.source})`);
}

// ---------- Start ----------

setupControls();
setupChartEvents();
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
window.__btc = { state, STEP };
