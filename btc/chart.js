// Candlestick chart (layout and indicators as on exchange apps): candles over a volume / indicator pane,
// pinch and scroll zoom, tap a candle for its details, live updates, and the
// forecast drawn as see-through grey "ghost" candles inside a dashed 95% cone.
// Built on TradingView Lightweight Charts (btc/vendor, Apache-2.0).

import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle,
  TickMarkType, TrackingModeExitMode,
} from './vendor/lightweight-charts.mjs';
import { sma, ema, bollinger, macd, rsi } from './model.js';

export const MAIN_KINDS = ['MA', 'EMA', 'BOLL'];
export const SUB_KINDS = ['VOL', 'MACD', 'RSI'];
const FIRST_VIEW = 80; // candles in view when a timeframe opens
const HISTORY_EDGE = 15; // load older candles when scrolled this close to the start

// ---------- Formatting ----------

const price2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPrice = (p) => (Number.isFinite(p) ? price2.format(p) : '—');
const fmtPct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%` : '—');
const fmtVol = (v) => {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(Math.abs(v) >= 100 ? 2 : 3);
};
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms, daily) {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return daily ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  if (d) return `${d}d ${hms}`;
  return s >= 3600 ? hms : hms.slice(3);
}

// ---------- Indicators ----------

export function mainLines(kind, closes) {
  if (kind === 'MA' || kind === 'EMA') {
    const f = kind === 'MA' ? sma : ema;
    return [7, 25, 99].map((p) => ({ name: `${kind}(${p})`, values: f(closes, p) }));
  }
  if (kind === 'BOLL') {
    const b = bollinger(closes, 20, 2);
    return [
      { name: 'BOLL(20,2) MB', values: b.mid },
      { name: 'UP', values: b.mid.map((m, i) => m * (1 + b.width[i] / 2)) },
      { name: 'DN', values: b.mid.map((m, i) => m * (1 - b.width[i] / 2)) },
    ];
  }
  return [];
}

// Lower pane: one histogram and up to three lines.
export function subPanel(kind, candles) {
  const closes = candles.map((c) => c.c);
  if (kind === 'MACD') {
    const m = macd(closes);
    return {
      title: 'MACD(12,26,9)',
      format: fmtPrice,
      hist: { name: 'MACD', values: m.hist, shade: 'macd' },
      lines: [{ name: 'DIF', values: m.line }, { name: 'DEA', values: m.signal }],
    };
  }
  if (kind === 'RSI') {
    return {
      title: '',
      format: (v) => (Number.isFinite(v) ? v.toFixed(2) : '—'),
      hist: null,
      lines: [6, 12, 24].map((p) => ({ name: `RSI(${p})`, values: rsi(closes, p) })),
      guides: [70, 30],
    };
  }
  const vol = candles.map((c) => c.vb ?? 0);
  return {
    title: '',
    format: fmtVol,
    hist: { name: 'Vol(BTC)', values: vol, shade: 'candle' },
    lines: [{ name: 'MA(5)', values: sma(vol, 5) }, { name: 'MA(10)', values: sma(vol, 10) }],
  };
}

// ---------- The 95% cone (a series primitive) ----------

class Cone {
  constructor() {
    this.points = []; // { time, lo, hi }
    this.colors = { line: '#F0B90B', fill: 'rgba(240,185,11,0.08)' };
    this.views = [{ zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target) }) }];
  }
  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.chart = this.series = this.requestUpdate = null;
  }
  set(points, colors) {
    this.points = points;
    if (colors) this.colors = colors;
    this.requestUpdate?.();
  }
  paneViews() {
    return this.views;
  }
  // Keep the cone in view: the price axis stretches to include it.
  autoscaleInfo(from, to) {
    if (!this.chart || !this.points.length) return null;
    const ts = this.chart.timeScale();
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of this.points) {
      const i = ts.timeToIndex(p.time, false);
      if (i == null || i < from || i > to) continue;
      lo = Math.min(lo, p.lo);
      hi = Math.max(hi, p.hi);
    }
    return Number.isFinite(lo) ? { priceRange: { minValue: lo, maxValue: hi } } : null;
  }
  draw(target) {
    if (!this.chart || this.points.length < 2) return;
    const ts = this.chart.timeScale();
    const pts = this.points
      .map((p) => ({ x: ts.timeToCoordinate(p.time), hi: this.series.priceToCoordinate(p.hi), lo: this.series.priceToCoordinate(p.lo) }))
      .filter((p) => p.x != null && p.hi != null && p.lo != null);
    if (pts.length < 2) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.hi) : ctx.moveTo(p.x, p.hi)));
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].lo);
      ctx.closePath();
      ctx.fillStyle = this.colors.fill;
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.colors.line;
      for (const key of ['hi', 'lo']) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p[key]) : ctx.moveTo(p.x, p[key])));
        ctx.stroke();
      }
      ctx.restore();
    });
  }
}

// ---------- Direction markers at +1h / +4h / +24h ----------

export const MAX_MARKER_BARS = 150; // further ahead than this, a horizon shows as a chip instead

// Where each future time falls, in candles after the live candle's open
// (fractional: +1h on a 4h chart is 0.25). Far ones go to chips.
export function horizonOffsets(stepMs, lastOpen, times) {
  return times.map((t) => {
    const bars = (t - lastOpen) / stepMs;
    return { t, bars, far: bars > MAX_MARKER_BARS };
  });
}

// x for a fractional logical index (+1h on a 4h chart sits inside a candle);
// logicalToCoordinate only handles whole bars.
function xAt(ts, logical) {
  const i = Math.floor(logical);
  const a = ts.logicalToCoordinate(i);
  const b = ts.logicalToCoordinate(i + 1);
  return a == null || b == null ? null : a + (b - a) * (logical - i);
}

class HorizonMarkers {
  constructor() {
    this.items = []; // { key, bars, mid, lo50, hi50, pUp, edge }
    this.price = NaN;
    this.lastTime = null; // live candle's time (seconds)
    this.colors = {};
    this.views = [{ zOrder: () => 'top', renderer: () => ({ draw: (target) => this.draw(target) }) }];
  }
  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.chart = this.series = this.requestUpdate = null;
  }
  // origin: bars from the live candle's open to when the prediction was made
  // (negative if before it); the dotted paths start there, at `price`.
  set(items, price, lastTime, colors, origin = 0) {
    this.origin = origin;
    this.items = items;
    this.price = price;
    this.lastTime = lastTime;
    this.colors = colors;
    this.requestUpdate?.();
  }
  paneViews() {
    return this.views;
  }
  lastIndex() {
    return this.chart && this.lastTime != null ? this.chart.timeScale().timeToIndex(this.lastTime, true) : null;
  }
  autoscaleInfo(from, to) {
    const last = this.lastIndex();
    if (last == null) return null;
    const shown = this.items.filter((m) => {
      const i = last + m.bars;
      return i >= from && i <= to;
    });
    if (!shown.length) return null;
    return { priceRange: { minValue: Math.min(...shown.map((m) => m.lo50)), maxValue: Math.max(...shown.map((m) => m.hi50)) } };
  }
  draw(target) {
    const last = this.lastIndex();
    if (last == null || !this.items.length) return;
    const ts = this.chart.timeScale();
    const s = this.series;
    const x0 = xAt(ts, last + (this.origin || 0));
    const y0 = s.priceToCoordinate(this.price);
    const c = this.colors;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const labels = [];
      for (const m of this.items) {
        const x = xAt(ts, last + m.bars);
        const y = s.priceToCoordinate(m.mid);
        const yHi = s.priceToCoordinate(m.hi50);
        const yLo = s.priceToCoordinate(m.lo50);
        if (x == null || y == null || x < -20 || x > mediaSize.width + 20) continue;
        const dir = m.pUp > 0.5 ? 1 : m.pUp < 0.5 ? -1 : 0;
        const col = m.edge ? (dir > 0 ? c.up : dir < 0 ? c.down : c.flat) : c.flat;
        // dotted path from the live price
        if (x0 != null && y0 != null) {
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.setLineDash([]);
        }
        // 50% range
        if (yHi != null && yLo != null) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(x, yHi);
          ctx.lineTo(x, yLo);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x - 4, yHi);
          ctx.lineTo(x + 4, yHi);
          ctx.moveTo(x - 4, yLo);
          ctx.lineTo(x + 4, yLo);
          ctx.stroke();
        }
        // arrow at the middle estimate
        ctx.fillStyle = col;
        ctx.strokeStyle = c.bg;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (dir > 0) {
          ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 4); ctx.lineTo(x - 6, y + 4);
        } else if (dir < 0) {
          ctx.moveTo(x, y + 7); ctx.lineTo(x + 6, y - 4); ctx.lineTo(x - 6, y - 4);
        } else {
          ctx.rect(x - 6, y - 2, 12, 4);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        labels.push({ text: `${m.key} ${dir > 0 ? '▲' : dir < 0 ? '▼' : '–'} ${Math.round(Math.max(m.pUp, 1 - m.pUp) * 100)}%`, x, y: (yHi ?? y) - 6, col });
      }
      // Labels last, on top of every line, nudged up where they would overlap.
      const placed = [];
      for (const l of labels) {
        const w = ctx.measureText(l.text).width + 8;
        const lx = Math.min(Math.max(l.x, w / 2 + 2), mediaSize.width - w / 2 - 2);
        let ly = Math.max(14, l.y);
        while (placed.some((p) => Math.abs(p.x - lx) < (p.w + w) / 2 && Math.abs(p.y - ly) < 15)) ly -= 16;
        placed.push({ x: lx, y: ly, w });
        ctx.fillStyle = this.colors.bg;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(lx - w / 2, ly - 14, w, 15);
        ctx.globalAlpha = 1;
        ctx.fillStyle = l.col;
        ctx.fillText(l.text, lx, ly);
      }
      ctx.restore();
    });
  }
}

// ---------- The chart ----------

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

// Colours come from CSS custom properties, so light and dark themes are set in
// styles.css alone.
function readTheme(node) {
  const css = getComputedStyle(node);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    bg: v('--k-bg'), grid: v('--k-grid'), text: v('--k-text'), cross: v('--k-cross'), label: v('--k-label'),
    up: v('--k-up'), down: v('--k-down'), upSoft: v('--k-up-soft'), downSoft: v('--k-down-soft'),
    ghostFill: v('--k-ghost-fill'), ghostLine: v('--k-ghost-line'), cone: v('--k-cone'), coneFill: v('--k-cone-fill'),
    lines: [v('--k-line-1'), v('--k-line-2'), v('--k-line-3')],
  };
}

const sec = (ms) => Math.floor(ms / 1000);

export function createBinanceChart(container, { onNeedHistory } = {}) {
  container.classList.add('k-chart');
  const host = el('div', 'k-host');
  const legendMain = el('div', 'k-legend');
  const legendSub = el('div', 'k-legend k-legend-sub');
  const details = el('div', 'k-details');
  const countdown = el('div', 'k-countdown');
  const farChips = el('div', 'k-far');
  details.hidden = true;
  countdown.hidden = true;
  container.append(host, legendMain, legendSub, details, countdown, farChips);

  let theme = readTheme(container);
  let bars = []; // the app's candle array (oldest first, times in ms), updated in place
  let step = 15 * 60e3;
  let daily = false;
  let synced = 0;
  let ghosts = []; // forecast bars
  let ghostByTime = new Map();
  let indexByTime = new Map();
  let mainKind = 'MA';
  let subKind = 'VOL';
  let main = [];
  let sub = subPanel('VOL', []);
  let guides = [];
  let pointerType = 'mouse';
  let pinned = null; // time (seconds) of a tapped candle
  let hover = null;

  const chart = createChart(host, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: theme.bg },
      textColor: theme.text,
      fontSize: 11,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
      attributionLogo: true,
      panes: { separatorColor: theme.grid, separatorHoverColor: theme.grid, enableResize: false },
    },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: theme.cross, labelBackgroundColor: theme.label, style: LineStyle.Dashed },
      horzLine: { color: theme.cross, labelBackgroundColor: theme.label, style: LineStyle.Dashed },
    },
    rightPriceScale: { borderColor: theme.grid, scaleMargins: { top: 0.12, bottom: 0.06 } },
    timeScale: {
      borderColor: theme.grid,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 2,
      barSpacing: 7,
      minBarSpacing: 1,
      tickMarkFormatter: (t, type) => {
        const d = new Date(t * 1000);
        if (type === TickMarkType.Year) return String(d.getFullYear());
        if (type === TickMarkType.Month) return d.toLocaleDateString([], { month: 'short' });
        if (type === TickMarkType.DayOfMonth) return `${d.getMonth() + 1}/${d.getDate()}`;
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      },
    },
    localization: { timeFormatter: (t) => fmtTime(t * 1000, daily) },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    kineticScroll: { touch: true, mouse: false },
    trackingMode: { exitMode: TrackingModeExitMode.OnNextTap },
  });

  const priceFormat = { type: 'custom', formatter: fmtPrice, minMove: 0.01 };
  const quiet = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: theme.up, downColor: theme.down, borderVisible: false, wickUpColor: theme.up, wickDownColor: theme.down,
    priceFormat, priceLineStyle: LineStyle.Dashed,
  });
  const ghostSeries = chart.addSeries(CandlestickSeries, {
    ...quiet,
    upColor: theme.ghostFill, downColor: theme.ghostFill, borderVisible: true,
    borderUpColor: theme.ghostLine, borderDownColor: theme.ghostLine, wickUpColor: theme.ghostLine, wickDownColor: theme.ghostLine,
    priceFormat,
  });
  const midLine = chart.addSeries(LineSeries, { ...quiet, color: theme.ghostLine, lineWidth: 1, lineStyle: LineStyle.Dotted, priceFormat });
  const cone = new Cone();
  ghostSeries.attachPrimitive(cone);
  let horizonOrigin = null; // when the prediction on screen was made (ms)
  let planLines = []; // [{ price, title, kind }] for the trade planner
  let planHandles = [];
  const markers = new HorizonMarkers();
  candles.attachPrimitive(markers);
  let horizons = [];
  const mainSeries = [0, 1, 2].map(() => chart.addSeries(LineSeries, { ...quiet, lineWidth: 1, priceFormat }));
  const subHist = chart.addSeries(HistogramSeries, { ...quiet, priceFormat: { type: 'custom', formatter: fmtVol } }, 1);
  const subLines = [0, 1, 2].map(() => chart.addSeries(LineSeries, { ...quiet, lineWidth: 1 }, 1));
  chart.panes()[0].setStretchFactor(3);
  chart.panes()[1].setStretchFactor(1);
  chart.priceScale('right', 1).applyOptions({ scaleMargins: { top: 0.2, bottom: 0.02 } });

  // ----- data helpers -----

  const toCandle = (c) => ({ time: sec(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
  const point = (i, v) => ({ time: sec(bars[i].t), value: v });
  function histColor(kind, values, i) {
    if (kind === 'candle') return bars[i].c >= bars[i].o ? theme.upSoft : theme.downSoft;
    const v = values[i];
    const prev = values[i - 1];
    const rising = !(Number.isFinite(prev)) || v >= prev;
    if (v >= 0) return rising ? theme.up : theme.upSoft;
    return rising ? theme.downSoft : theme.down;
  }

  function computeIndicators() {
    const closes = bars.map((c) => c.c);
    main = mainLines(mainKind, closes);
    sub = subPanel(subKind, bars);
  }

  // Send indicator points from index `from` on (all of them when from = 0).
  function pushIndicators(from) {
    const all = from === 0;
    mainSeries.forEach((s, j) => {
      const line = main[j];
      s.applyOptions({ color: theme.lines[j], visible: !!line });
      if (!line) return all && s.setData([]);
      const pts = [];
      for (let i = from; i < bars.length; i++) if (Number.isFinite(line.values[i])) pts.push(point(i, line.values[i]));
      if (all) s.setData(pts);
      else pts.forEach((p) => s.update(p));
    });
    const h = sub.hist;
    subHist.applyOptions({ visible: !!h, priceFormat: { type: 'custom', formatter: sub.format } });
    if (h) {
      const pts = [];
      for (let i = from; i < bars.length; i++) {
        if (Number.isFinite(h.values[i])) pts.push({ ...point(i, h.values[i]), color: histColor(h.shade, h.values, i) });
      }
      if (all) subHist.setData(pts);
      else pts.forEach((p) => subHist.update(p));
    } else if (all) subHist.setData([]);
    subLines.forEach((s, j) => {
      const line = sub.lines[j];
      s.applyOptions({ color: theme.lines[j], visible: !!line, priceFormat: { type: 'custom', formatter: sub.format } });
      if (!line) return all && s.setData([]);
      const pts = [];
      for (let i = from; i < bars.length; i++) if (Number.isFinite(line.values[i])) pts.push(point(i, line.values[i]));
      if (all) s.setData(pts);
      else pts.forEach((p) => s.update(p));
    });
    if (all) {
      guides.forEach((g) => subLines[0].removePriceLine(g));
      guides = (sub.guides || []).map((price) =>
        subLines[0].createPriceLine({ price, color: theme.cross, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false }));
    }
  }

  function reindex() {
    indexByTime = new Map(bars.map((c, i) => [sec(c.t), i]));
  }

  // Send candles that changed or arrived since the last draw. Returns the index
  // of the first one, from which the indicators need updating too. Indicators
  // are always drawn after this, so they never run ahead of the candles.
  function syncCandles() {
    const from = Math.max(0, Math.min(synced, bars.length) - 1);
    for (let i = from; i < bars.length; i++) {
      indexByTime.set(sec(bars[i].t), i);
      candles.update(toCandle(bars[i]));
    }
    synced = bars.length;
    return from;
  }

  // ----- legends, details box, countdown -----

  function legendSpan(text, color) {
    const s = el('span');
    s.textContent = text;
    if (color) s.style.color = color;
    return s;
  }

  function renderLegends() {
    const t = pinned ?? hover;
    let i = t != null ? indexByTime.get(t) : undefined;
    if (i === undefined) i = bars.length - 1;
    legendMain.replaceChildren(...main.map((l, j) => legendSpan(`${l.name}: ${fmtPrice(l.values[i])}`, theme.lines[j])));
    const parts = [];
    if (sub.title) parts.push(legendSpan(sub.title));
    if (sub.hist) parts.push(legendSpan(`${sub.hist.name}: ${sub.format(sub.hist.values[i])}`, sub.hist.shade === 'macd' ? null : theme.text));
    sub.lines.forEach((l, j) => parts.push(legendSpan(`${l.name}: ${sub.format(l.values[i])}`, theme.lines[j])));
    legendSub.replaceChildren(...parts);
    legendSub.style.top = `${chart.paneSize(0).height + 4}px`;
  }

  function row(label, value, cls) {
    const r = el('div', 'k-row');
    const a = el('span');
    const b = el('b', cls);
    a.textContent = label;
    b.textContent = value;
    r.append(a, b);
    return r;
  }

  function showDetails(t, x) {
    const i = indexByTime.get(t);
    const g = ghostByTime.get(t);
    const rows = [];
    if (i !== undefined) {
      const c = bars[i];
      const ch = c.c - c.o;
      const cls = ch >= 0 ? 'k-up' : 'k-down';
      rows.push(row('Time', fmtTime(c.t, daily)), row('Open', fmtPrice(c.o)), row('High', fmtPrice(c.h)),
        row('Low', fmtPrice(c.l)), row('Close', fmtPrice(c.c)),
        row('Change', `${ch >= 0 ? '+' : ''}${fmtPrice(ch)}`, cls), row('Change%', fmtPct(ch / c.o), cls),
        row('Range', fmtPct((c.h - c.l) / c.o).replace('+', '')), row('Volume', `${fmtVol(c.vb ?? NaN)} BTC`));
    } else if (g) {
      rows.push(row('Forecast', fmtTime(g.end, daily)), row('Middle', fmtPrice(g.mid)),
        row('50%', `${fmtPrice(g.lo50)} – ${fmtPrice(g.hi50)}`), row('80%', `${fmtPrice(g.lo80)} – ${fmtPrice(g.hi80)}`),
        row('95%', `${fmtPrice(g.lo95)} – ${fmtPrice(g.hi95)}`), row('Chance up', `${Math.round(g.pUp * 100)}%`));
    } else {
      details.hidden = true;
      return;
    }
    details.classList.toggle('k-ghost', i === undefined);
    details.replaceChildren(...rows);
    details.hidden = false;
    const left = x == null || x > host.clientWidth / 2;
    details.style.left = left ? '6px' : 'auto';
    details.style.right = left ? 'auto' : `${chart.priceScale('right').width() + 6}px`;
  }

  function priceAt(t) {
    const i = indexByTime.get(t);
    if (i !== undefined) return bars[i].c;
    return ghostByTime.get(t)?.mid;
  }

  function pin(t, x) {
    pinned = t;
    const price = priceAt(t);
    chart.setCrosshairPosition(price, t, indexByTime.has(t) ? candles : ghostSeries);
    showDetails(t, x);
    renderLegends();
  }

  function unpin() {
    pinned = null;
    chart.clearCrosshairPosition();
    details.hidden = true;
    renderLegends();
  }

  function updateCountdown(now = Date.now()) {
    const last = bars[bars.length - 1];
    const y = last ? candles.priceToCoordinate(last.c) : null;
    if (!last || y == null || y < 0 || y > chart.paneSize(0).height - 8) {
      countdown.hidden = true;
      return;
    }
    countdown.hidden = false;
    countdown.textContent = fmtCountdown(last.t + step - now);
    countdown.style.top = `${y + 10}px`;
    countdown.style.width = `${chart.priceScale('right').width()}px`;
    countdown.style.background = last.c >= last.o ? theme.up : theme.down;
  }

  // ----- events -----

  host.addEventListener('pointerdown', (e) => { pointerType = e.pointerType; }, { capture: true });
  chart.subscribeCrosshairMove((p) => {
    hover = p.time ?? null;
    if (pinned != null && hover !== pinned && pointerType !== 'mouse' && p.sourceEvent) pinned = null;
    if (pinned == null) {
      if (hover != null && p.point) showDetails(hover, p.point.x);
      else details.hidden = true;
    }
    renderLegends();
  });
  // Tap a candle to pin its details; tap it again (or elsewhere) to close.
  // A quick second tap arrives as a double-click, so both are handled alike.
  const onTap = (p) => {
    if (pointerType === 'mouse') return; // hovering already shows the details
    if (p.time == null || p.time === pinned) unpin();
    else pin(p.time, p.point?.x);
  };
  chart.subscribeClick(onTap);
  chart.subscribeDblClick(onTap);
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (r && r.from < HISTORY_EDGE && bars.length) onNeedHistory?.();
    updateCountdown();
  });
  new ResizeObserver(() => requestAnimationFrame(() => {
    renderLegends();
    updateCountdown();
  })).observe(host);
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener?.('change', () => api.applyTheme());

  // ----- public API -----

  const api = {
    chart,

    // A new candle array (a new timeframe, or after a full reload).
    setData(list, { stepMs, isDaily = false, future = 20, keepView = false } = {}) {
      const range = keepView ? chart.timeScale().getVisibleLogicalRange() : null;
      bars = list;
      step = stepMs ?? step;
      daily = isDaily;
      chart.applyOptions({ timeScale: { timeVisible: !daily } });
      reindex();
      synced = bars.length;
      candles.setData(bars.map(toCandle));
      computeIndicators();
      pushIndicators(0);
      if (pinned != null) unpin();
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      else if (bars.length) {
        chart.timeScale().setVisibleLogicalRange({ from: bars.length - FIRST_VIEW, to: bars.length + future + 1 });
      }
      renderLegends();
      updateCountdown();
    },

    // Older candles were put in front of the array: redraw without moving the view.
    prepended(added) {
      if (!added) return;
      const range = chart.timeScale().getVisibleLogicalRange();
      reindex();
      synced = bars.length;
      candles.setData(bars.map(toCandle));
      computeIndicators();
      pushIndicators(0);
      if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      renderLegends();
    },

    // The candle array changed at its end (live trades): redraw just that end.
    sync() {
      if (!bars.length) return;
      const from = syncCandles();
      computeIndicators();
      pushIndicators(from);
      renderLegends();
      updateCountdown();
    },

    // Forecast ghost candles after the live candle, anchored on `price`.
    setGhosts(list, price) {
      ghosts = list;
      ghostByTime = new Map(list.map((g) => [sec(g.t), g]));
      ghostSeries.setData(list.map((g) => ({ time: sec(g.t), open: g.lo50, high: g.hi80, low: g.lo80, close: g.hi50 })));
      const last = bars[bars.length - 1];
      const start = last ? [{ time: sec(last.t), value: price }] : [];
      midLine.setData(list.length ? [...start, ...list.map((g) => ({ time: sec(g.t), value: g.mid }))] : []);
      const coneStart = last ? [{ time: sec(last.t), lo: price, hi: price }] : [];
      cone.set(list.length ? [...coneStart, ...list.map((g) => ({ time: sec(g.t), lo: g.lo95, hi: g.hi95 }))] : [],
        { line: theme.cone, fill: theme.coneFill });
      if (pinned != null && ghostByTime.has(pinned)) showDetails(pinned);
    },

    // Likely direction at future times: [{ key, t (ms), mid, lo50, hi50, pUp, edge }].
    // Near ones are drawn on the chart; far ones become chips at the right edge.
    // price / madeAt: the price and time (ms) the prediction was made at.
    setHorizons(list, price, madeAt) {
      horizons = list;
      horizonOrigin = madeAt;
      const last = bars[bars.length - 1];
      if (!last) return;
      const offs = horizonOffsets(step, last.t, list.map((h) => h.t));
      const near = [];
      const far = [];
      list.forEach((h, i) => (offs[i].far ? far : near).push({ ...h, bars: offs[i].bars }));
      const origin = Number.isFinite(madeAt) ? (madeAt - last.t) / step : 0;
      markers.set(near, price, sec(last.t), { up: theme.up, down: theme.down, flat: theme.ghostLine, bg: theme.bg }, origin);
      farChips.replaceChildren(...far.map((h) => {
        const dir = h.pUp > 0.5 ? 1 : h.pUp < 0.5 ? -1 : 0;
        const chip = el('span', `k-chip ${h.edge ? (dir > 0 ? 'k-up' : dir < 0 ? 'k-down' : '') : ''}`);
        chip.textContent = `${h.key} ${dir > 0 ? '▲' : dir < 0 ? '▼' : '–'} ${Math.round(Math.max(h.pUp, 1 - h.pUp) * 100)}% →`;
        return chip;
      }));
    },

    // Trade planner levels as dashed price lines: [{ price, title, kind: 'entry' | 'stop' | 'target' }].
    setPlanLines(list) {
      const next = (list || []).filter((l) => Number.isFinite(l.price));
      const same = next.length === planLines.length && next.every((l, i) => l.price === planLines[i].price && l.title === planLines[i].title && l.kind === planLines[i].kind);
      if (same && planHandles.length === next.length) return;
      for (const h of planHandles) candles.removePriceLine(h);
      planLines = next;
      const color = { entry: theme.ghostLine, stop: theme.down, target: theme.up };
      planHandles = next.map((l) => candles.createPriceLine({
        price: l.price, title: l.title, color: color[l.kind] || theme.ghostLine,
        lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
      }));
    },

    setMain(kind) {
      mainKind = kind;
      if (bars.length) syncCandles();
      computeIndicators();
      pushIndicators(0);
      renderLegends();
    },

    setSub(kind) {
      subKind = kind;
      if (bars.length) syncCandles();
      computeIndicators();
      pushIndicators(0);
      renderLegends();
    },

    tick(now) {
      updateCountdown(now);
    },

    applyTheme() {
      theme = readTheme(container);
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: theme.bg }, textColor: theme.text, panes: { separatorColor: theme.grid, separatorHoverColor: theme.grid } },
        grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
        crosshair: { vertLine: { color: theme.cross, labelBackgroundColor: theme.label }, horzLine: { color: theme.cross, labelBackgroundColor: theme.label } },
        rightPriceScale: { borderColor: theme.grid },
        timeScale: { borderColor: theme.grid },
      });
      candles.applyOptions({ upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down });
      ghostSeries.applyOptions({
        upColor: theme.ghostFill, downColor: theme.ghostFill, borderUpColor: theme.ghostLine, borderDownColor: theme.ghostLine,
        wickUpColor: theme.ghostLine, wickDownColor: theme.ghostLine,
      });
      midLine.applyOptions({ color: theme.ghostLine });
      cone.set(cone.points, { line: theme.cone, fill: theme.coneFill });
      if (bars.length) api.setHorizons(horizons, markers.price, horizonOrigin);
      const lines = planLines;
      planLines = [];
      planHandles.forEach((h) => candles.removePriceLine(h));
      planHandles = [];
      api.setPlanLines(lines);
      if (bars.length) syncCandles();
      computeIndicators();
      pushIndicators(0);
      renderLegends();
    },

    // For tests.
    debug() {
      return {
        bars: candles.data().length,
        ghosts: ghostSeries.data().length,
        cone: cone.points.length,
        markers: markers.items.map((m) => m.key),
        planLines: planLines.map((l) => `${l.title} ${l.price}`),
        markerX: markers.items.map((m) => xAt(chart.timeScale(), markers.lastIndex() + m.bars)),
        lastX: bars.length ? chart.timeScale().timeToCoordinate(sec(bars[bars.length - 1].t)) : null,
        chips: [...farChips.children].map((c) => c.textContent),
        range: chart.timeScale().getVisibleLogicalRange(),
        main: mainKind,
        sub: subKind,
        pinned,
        legend: legendMain.textContent,
        subLegend: legendSub.textContent,
      };
    },
  };
  return api;
}
