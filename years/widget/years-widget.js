// Years — home-screen widget for iPhone (runs in the free "Scriptable" app).
// One dot per year of your life or of a long goal; this year's dot fills in daily.
//
// Recommended: install years/widget/loader.js in Scriptable (named "Years")
// instead of this file. The loader downloads this script on every refresh,
// and this script reads your items from years/widget/years.json on GitHub,
// which the Years app keeps up to date (Widget sync).
//
// Widget Parameter (with the loader): the item's name (any capitalisation),
// its number in years.json (1 = first), or empty for the first one.
//
// This file also still works pasted on its own, with the Parameter set to
//   life|My life|1999-05-10|2079-05-10|#1c7ed6
// (life or goal | name | start | end | colour).

const DEFAULT = 'life|My life|1999-05-10|2079-05-10|#1c7ed6';
// The items file straight from the repo: new commits show up here at once.
const REPO_API = 'https://api.github.com/repos/menujai99-ai/code/contents/years/widget/years.json';
// How often to ask iOS for a refresh (iOS decides the real timing).
const REFRESH_MINUTES = 15;

const DAY_MS = 86400000;
const YEAR_DAYS = 365.2425;

// Shown on the widget: when the items were last fetched.
let freshness = '';

/* ---------- Pick and parse the item ---------- */

function parseDate(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}
function validColor(c) {
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#1c7ed6';
}

/** Old format: "life|name|YYYY-MM-DD|YYYY-MM-DD|#colour". */
function parseLine(raw) {
  const [kind, name, start, end, color] = String(raw).split('|').map((x) => x.trim());
  return parseEntry({ kind, name, start, end, color });
}

/** An entry of years.json: { kind, name, start, end, color? }. */
function parseEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const s = parseDate(e.start);
  const en = parseDate(e.end);
  if (!s || !en || en <= s) return null;
  const kind = e.kind === 'goal' ? 'goal' : 'life';
  return { kind, name: String(e.name || (kind === 'goal' ? 'Goal' : 'My life')), start: s, end: en, color: validColor(e.color) };
}

/** Parse years.json, forgiving a missing comma, trailing commas and curly quotes. */
function parseItems(text) {
  const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null);
  try {
    const list = asList(JSON.parse(text));
    if (list) return { list };
  } catch (e) {
    /* try the repaired version below */
  }
  const fixed = String(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\}(\s*)\{/g, '},$1{')
    .replace(/,(\s*[\]}])/g, '$1');
  try {
    const list = asList(JSON.parse(fixed));
    return list ? { list } : { error: 'years.json should be a list: [ {...}, {...} ]' };
  } catch (e) {
    return { error: `years.json has a typo (${e.message}).` };
  }
}

/** Fresh years.json from the GitHub API, or null. One quick request. */
async function downloadItems() {
  try {
    const req = new Request(`${REPO_API}?t=${Date.now()}`);
    // Widgets get only a few seconds to run in the background; fail fast.
    req.timeoutInterval = 6;
    req.headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'Years-widget' };
    const text = await req.loadString();
    return req.response && req.response.statusCode === 200 ? text : null;
  } catch (e) {
    return null;
  }
}

/** Returns { item } or { error }. */
function pickItem(list, param) {
  const p = String(param || '').trim();
  if (p.includes('|')) {
    const item = parseLine(p);
    return item ? { item } : { error: 'Parameter format: life|name|YYYY-MM-DD|YYYY-MM-DD|#colour' };
  }
  const items = (Array.isArray(list) ? list : []).map(parseEntry).filter(Boolean);
  if (!items.length) return { error: 'No items yet. In the Years app, turn on Widget sync (the cloud button).' };
  if (!p) return { item: items[0] };
  if (/^\d+$/.test(p)) {
    const it = items[parseInt(p, 10) - 1];
    return it ? { item: it } : { error: `There are only ${items.length} items.` };
  }
  const it = items.find((x) => x.name.toLowerCase() === p.toLowerCase());
  return it ? { item: it } : { error: `No item named "${p}". Available: ${items.map((x) => x.name).join(', ')}` };
}

/* ---------- Same year maths as the app ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function addYears(d, n) {
  const y = d.getFullYear() + n;
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return new Date(y, d.getMonth(), Math.min(d.getDate(), last));
}
function dotCount(item) {
  let n = 0;
  while (n < 130 && addYears(item.start, n) < item.end) n++;
  return n;
}
function getStatus(item, now) {
  const n = dotCount(item);
  if (now < item.start) return { state: 'upcoming', n, idx: -1, frac: 0 };
  if (now >= item.end) return { state: 'done', n, idx: n, frac: 1 };
  let idx = Math.max(0, now.getFullYear() - item.start.getFullYear() - 1);
  while (addYears(item.start, idx + 1) <= now) idx++;
  const a = addYears(item.start, idx);
  const b0 = addYears(item.start, idx + 1);
  const b = b0 < item.end ? b0 : item.end;
  return { state: 'active', n, idx, frac: (now - a) / (b - a), yearsLeft: (item.end - now) / DAY_MS / YEAR_DAYS };
}

/* ---------- Drawing ---------- */

const BG = Color.dynamic(new Color('#ffffff'), new Color('#181b21'));
const TEXT = Color.dynamic(new Color('#17181c'), new Color('#eceef2'));
const MUTED = Color.dynamic(new Color('#6b6d75'), new Color('#9196a1'));

/** Draw the year dots as an image that fits w×h points. */
function drawDots(item, st, w, h, dark) {
  const n = st.n;
  const fit = (cols) => Math.min(w / cols, h / Math.ceil(n / cols));
  let best = { cols: 1, cell: 0 };
  for (let cols = 1; cols <= n; cols++) {
    if (fit(cols) > best.cell) best = { cols, cell: fit(cols) };
  }
  // Prefer rows of 10 (decades) when they are nearly as big.
  if (n > 20 && fit(10) >= best.cell * 0.9) best = { cols: 10, cell: fit(10) };
  const { cols, cell } = best;
  const rows = Math.ceil(n / cols);
  const size = Math.min(cell * 0.66, 22);
  const ox = (w - cols * cell) / 2;
  const oy = (h - rows * cell) / 2;

  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const solid = new Color(item.color);
  const soft = new Color(item.color, dark ? 0.22 : 0.16);

  for (let i = 0; i < n; i++) {
    const cx = ox + (i % cols) * cell + cell / 2;
    const cy = oy + Math.floor(i / cols) * cell + cell / 2;
    const rect = new Rect(cx - size / 2, cy - size / 2, size, size);
    const isPast = st.state === 'done' || i < st.idx;
    const isNow = st.state === 'active' && i === st.idx;

    ctx.setFillColor(isPast ? solid : soft);
    ctx.fillEllipse(rect);
    if (isNow) {
      if (st.frac > 0.01) {
        const r = size / 2;
        const steps = Math.max(2, Math.ceil(st.frac * 40));
        const pts = [new Point(cx, cy)];
        for (let s = 0; s <= steps; s++) {
          const a = -Math.PI / 2 + (s / steps) * st.frac * 2 * Math.PI;
          pts.push(new Point(cx + r * Math.cos(a), cy + r * Math.sin(a)));
        }
        const path = new Path();
        path.addLines(pts);
        path.closeSubpath();
        ctx.addPath(path);
        ctx.setFillColor(solid);
        ctx.fillPath();
      }
      const pad = Math.max(1.5, size * 0.22);
      ctx.setStrokeColor(solid);
      ctx.setLineWidth(Math.max(1, size * 0.12));
      ctx.strokeEllipse(new Rect(rect.x - pad, rect.y - pad, size + pad * 2, size + pad * 2));
    }
  }
  return ctx.getImage();
}

function headline(item, st) {
  if (st.state === 'done') return { num: '✓', label: 'completed' };
  if (st.state === 'upcoming') return { num: String(st.n), label: 'years ahead' };
  const y = st.yearsLeft.toFixed(1);
  return { num: y, label: y === '1.0' ? 'year left' : 'years left' };
}

function subline(item, st) {
  if (st.state !== 'active') return `${st.n} years`;
  const pct = `${Math.floor(st.frac * 100)}%`;
  return item.kind === 'life' ? `Age ${st.idx} · ${pct}` : `Year ${st.idx + 1} of ${st.n} · ${pct}`;
}

function addText(stack, text, font, color, lines = 1) {
  const t = stack.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.6;
  return t;
}

/* ---------- Widget ---------- */

function buildWidget(item, family) {
  const now = new Date();
  const st = getStatus(item, now);
  const dark = Device.isUsingDarkAppearance();
  const accent = new Color(item.color);
  const { num, label } = headline(item, st);

  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(14, 14, 14, 14);
  // Refresh at least daily (just after midnight) and every REFRESH_MINUTES for new items.
  w.refreshAfterDate = new Date(Math.min(addDays(startOfDay(now), 1).getTime() + 60000, now.getTime() + REFRESH_MINUTES * 60000));
  w.url = 'scriptable:///run/' + encodeURIComponent(Script.name());

  // Heights are tight (about 130pt of content in small/medium); anything that
  // doesn't fit is cut off by iOS, so keep these stacks within budget.
  if (family === 'small') {
    w.setPadding(12, 12, 12, 12);
    const top = w.addStack();
    top.centerAlignContent();
    addText(top, num, Font.heavySystemFont(24), accent);
    top.addSpacer(4);
    addText(top, label, Font.semiboldSystemFont(11), MUTED);
    w.addSpacer(4);
    w.addImage(drawDots(item, st, 130, 56, dark)).centerAlignImage();
    w.addSpacer(4);
    addText(w, subline(item, st), Font.semiboldSystemFont(11), TEXT);
    addEnds(w, item, st, 10, accent);
    if (freshness) addText(w, freshness, Font.systemFont(9), MUTED);
    return w;
  }

  if (family === 'medium') {
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const col = row.addStack();
    col.layoutVertically();
    col.size = new Size(116, 0);
    addText(col, item.name, Font.semiboldSystemFont(13), TEXT);
    col.addSpacer(2);
    const big = col.addStack();
    big.layoutHorizontally();
    big.bottomAlignContent();
    addText(big, num, Font.heavySystemFont(30), accent);
    big.addSpacer(4);
    addText(big, label, Font.semiboldSystemFont(11), MUTED);
    col.addSpacer(2);
    addText(col, subline(item, st), Font.systemFont(11), MUTED);
    col.addSpacer(2);
    addEnds(col, item, st, 11, accent, { stacked: true });
    if (freshness) {
      col.addSpacer(2);
      addText(col, freshness, Font.systemFont(9), MUTED);
    }
    row.addSpacer(10);
    row.addImage(drawDots(item, st, 176, 124, dark));
    return w;
  }

  const head = w.addStack();
  head.layoutHorizontally();
  head.bottomAlignContent();
  const left = head.addStack();
  left.layoutVertically();
  addText(left, item.name, Font.semiboldSystemFont(15), TEXT);
  addText(left, subline(item, st), Font.systemFont(12), MUTED);
  addEnds(left, item, st, 12, accent);
  if (freshness) addText(left, freshness, Font.systemFont(10), MUTED);
  head.addSpacer();
  const right = head.addStack();
  right.layoutVertically();
  addText(right, num, Font.heavySystemFont(32), accent).rightAlignText();
  addText(right, label, Font.semiboldSystemFont(11), MUTED).rightAlignText();
  w.addSpacer(10);
  w.addImage(drawDots(item, st, 310, 250, dark)).centerAlignImage();
  w.addSpacer();
  return w;
}

/**
 * "Ends in 52 years, 7 months" — drawn by iOS in relative style, so it keeps
 * counting down between widget refreshes. A life reads "Birthday in …".
 */
function addEnds(stack, item, st, size, color, { stacked = false } = {}) {
  const row = stack.addStack();
  if (stacked) row.layoutVertically();
  else {
    row.layoutHorizontally();
    row.centerAlignContent();
    row.spacing = 3;
  }
  if (st.state === 'done') {
    addText(row, 'Completed', Font.semiboldSystemFont(size), color);
    return row;
  }
  let label = 'Ends in';
  let date = item.end;
  if (st.state === 'upcoming') {
    label = 'Starts in';
    date = item.start;
  } else if (item.kind === 'life') {
    label = 'Birthday in';
    date = addYears(item.start, st.idx + 1);
  }
  addText(row, label, Font.systemFont(size), MUTED);
  const d = row.addDate(date);
  d.applyRelativeStyle();
  d.font = Font.semiboldSystemFont(size);
  d.textColor = color;
  d.lineLimit = 1;
  d.minimumScaleFactor = 0.6;
  return row;
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  addText(w, 'Years', Font.boldSystemFont(14), TEXT);
  w.addSpacer(4);
  addText(w, msg, Font.systemFont(11), MUTED, 4);
  return w;
}

/* ---------- Entry points ---------- */

/** Build and show the widget. Called by loader.js, or below when pasted directly. */
async function main({ items, param } = {}) {
  let list = items;
  let fileError = null;
  if (globalThis.__YEARS_VIA_LOADER && !String(param || '').includes('|')) {
    const text = await downloadItems();
    if (text != null) {
      const parsed = parseItems(text);
      if (parsed.list) list = parsed.list;
      else fileError = parsed.error;
      freshness = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      freshness = 'Saved copy';
    }
  }
  let { item, error } = pickItem(list, param);
  if (!item && fileError) error = fileError;
  const widget = item ? buildWidget(item, config.widgetFamily || 'large') : errorWidget(error);
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentLarge();
  }
  Script.complete();
}

module.exports = { main };

// Pasted straight into Scriptable (no loader): use the Parameter line, or DEFAULT.
if (!globalThis.__YEARS_VIA_LOADER) {
  main({ param: args.widgetParameter || DEFAULT });
}
