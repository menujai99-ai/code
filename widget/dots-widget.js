// Dots — home-screen widget for iPhone (runs in the free "Scriptable" app).
//
// Recommended: install widget/loader.js in Scriptable instead of this file.
// The loader downloads this script and widget/countdowns.json from GitHub
// Pages on every refresh, so edits on GitHub show up without re-pasting.
//
// This file also still works pasted on its own (named "Dots"), with the
// widget Parameter set to  name|start date|total days|colour,  e.g.
//   Exam prep|2026-09-07|100|#e8590c
//
// Choosing a countdown via the Parameter (when loaded by the loader):
//   empty      → the first countdown in countdowns.json
//   Exam prep  → the countdown with that name (any capitalisation)
//   2          → the second countdown
//   a|b|c|d    → the old pasted format, ignoring countdowns.json

const DEFAULT = 'Exam prep|2026-09-07|100|#e8590c';
// Where GitHub Pages serves this repo (used to re-read countdowns.json leniently).
const REPO_BASE = 'https://menujai99-ai.github.io/code/';
// The same file straight from the repo: new commits show up here at once,
// without waiting for GitHub Pages to rebuild. Public repo, so no token needed.
const REPO_API = 'https://api.github.com/repos/menujai99-ai/code/contents/widget/countdowns.json';
// How often to ask iOS for a refresh (iOS decides the real timing).
const REFRESH_MINUTES = 15;

// Shown on the widget: when the countdowns were last fetched, or that it's offline.
let freshness = '';
const FALLBACK_COLOR = '#e8590c';

const DAY_MS = 86400000;

/* ---------- Pick and parse the countdown ---------- */

function parseDate(str) {
  const [y, m, d] = String(str || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}
function validColor(c) {
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c : FALLBACK_COLOR;
}

/** Old format: "name|YYYY-MM-DD|total|#colour". */
function parseLine(raw) {
  const [name, start, total, color] = String(raw).split('|').map((s) => s.trim());
  const s = parseDate(start);
  const n = parseInt(total, 10);
  if (!s || !(n > 0)) return null;
  return { name: name || 'Countdown', start: s, total: n, color: validColor(color) };
}

/** An entry of countdowns.json: { name, start, total | end, color? }. */
function parseEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const s = parseDate(e.start);
  if (!s) return null;
  let n = parseInt(e.total, 10);
  if (!(n > 0) && e.end) {
    const end = parseDate(e.end);
    if (end) n = Math.round((end - s) / DAY_MS) + 1; // end = last day, inclusive
  }
  if (!(n > 0)) return null;
  return { name: String(e.name || 'Countdown'), start: s, total: n, color: validColor(e.color) };
}

/**
 * Parse countdowns.json, forgiving common hand-editing slips: a missing
 * comma between entries, trailing commas, and curly quotes.
 * Returns { list } or { error }.
 */
function parseCountdowns(text) {
  const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null);
  try {
    const list = asList(JSON.parse(text));
    if (list) return { list };
  } catch (e) {
    /* try the repaired version below */
  }
  const fixed = String(text)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\}(\s*)\{/g, '},$1{')
    .replace(/,(\s*[\]}])/g, '$1');
  try {
    const list = asList(JSON.parse(fixed));
    if (list) return { list };
    return { error: 'countdowns.json should be a list: [ {...}, {...} ]' };
  } catch (e) {
    return { error: `countdowns.json has a typo (${e.message}). Check its commas, quotes and brackets.` };
  }
}

async function fetchText(url, headers) {
  try {
    const req = new Request(url);
    req.timeoutInterval = 15;
    if (headers) req.headers = headers;
    const text = await req.loadString();
    return req.response && req.response.statusCode === 200 ? text : null;
  } catch (e) {
    return null;
  }
}

/**
 * Fresh countdowns.json, or null when offline. Tries the GitHub API first
 * (up to date the moment the app commits), then GitHub Pages.
 */
async function downloadCountdowns() {
  const fromApi = await fetchText(`${REPO_API}?t=${Date.now()}`, {
    Accept: 'application/vnd.github.raw',
    'User-Agent': 'Dots-widget',
  });
  if (fromApi != null) return fromApi;
  return fetchText(`${REPO_BASE}widget/countdowns.json?t=${Date.now()}`);
}

/** Returns { task } or { error }. */
function pickTask(countdowns, param) {
  const p = String(param || '').trim();
  if (p.includes('|')) {
    const task = parseLine(p);
    return task ? { task } : { error: 'Parameter format: name|YYYY-MM-DD|total|#colour' };
  }
  const list = (Array.isArray(countdowns) ? countdowns : []).map(parseEntry).filter(Boolean);
  if (!list.length) return { error: 'No countdowns found. Add one to widget/countdowns.json on GitHub.' };
  if (!p) return { task: list[0] };
  if (/^\d+$/.test(p)) {
    const t = list[parseInt(p, 10) - 1];
    return t ? { task: t } : { error: `There are only ${list.length} countdowns.` };
  }
  const t = list.find((x) => x.name.toLowerCase() === p.toLowerCase());
  return t ? { task: t } : { error: `No countdown named "${p}". Available: ${list.map((x) => x.name).join(', ')}` };
}

/* ---------- Same day maths as the app ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function getStatus(task, now) {
  const idx = Math.round((startOfDay(now) - task.start) / DAY_MS);
  const todayStart = startOfDay(now);
  const tomorrow = addDays(todayStart, 1);
  if (now < task.start) {
    return { state: 'upcoming', currentDay: 0, daysLeft: task.total, daysUntilStart: -idx, dayProgress: 0 };
  }
  if (idx >= task.total) {
    return { state: 'done', currentDay: task.total, daysLeft: 0, dayProgress: 1 };
  }
  return {
    state: 'active',
    currentDay: idx + 1,
    daysLeft: task.total - (idx + 1),
    dayProgress: (now - todayStart) / (tomorrow - todayStart),
  };
}

/* ---------- Drawing ---------- */

const BG = Color.dynamic(new Color('#ffffff'), new Color('#181b21'));
const TEXT = Color.dynamic(new Color('#17181c'), new Color('#eceef2'));
const MUTED = Color.dynamic(new Color('#6b6d75'), new Color('#9196a1'));

/** Draw the dot grid as an image that fits w×h points. */
function drawDots(task, st, w, h, dark) {
  const total = task.total;
  // Pick the column count that gives the biggest dots in this box.
  let best = { cols: 1, cell: 0 };
  for (let cols = 1; cols <= total; cols++) {
    const rows = Math.ceil(total / cols);
    const cell = Math.min(w / cols, h / rows);
    if (cell > best.cell) best = { cols, cell };
  }
  const { cols, cell } = best;
  const rows = Math.ceil(total / cols);
  const size = Math.min(cell * 0.68, 18);
  const gridW = cols * cell;
  const gridH = rows * cell;
  const ox = (w - gridW) / 2;
  const oy = (h - gridH) / 2;

  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const solid = new Color(task.color);
  const soft = new Color(task.color, dark ? 0.22 : 0.16);
  const ring = new Color(task.color);

  for (let i = 0; i < total; i++) {
    const cx = ox + (i % cols) * cell + cell / 2;
    const cy = oy + Math.floor(i / cols) * cell + cell / 2;
    const rect = new Rect(cx - size / 2, cy - size / 2, size, size);
    const isPast = st.state === 'done' || i < st.currentDay - 1;
    const isToday = st.state === 'active' && i === st.currentDay - 1;

    if (isPast) {
      ctx.setFillColor(solid);
      ctx.fillEllipse(rect);
    } else if (isToday) {
      ctx.setFillColor(soft);
      ctx.fillEllipse(rect);
      // Pie slice showing how much of today has passed.
      if (st.dayProgress > 0.01) {
        const r = size / 2;
        const steps = Math.max(2, Math.ceil(st.dayProgress * 40));
        const pts = [new Point(cx, cy)];
        for (let s = 0; s <= steps; s++) {
          const a = -Math.PI / 2 + (s / steps) * st.dayProgress * 2 * Math.PI;
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
      ctx.setStrokeColor(ring);
      ctx.setLineWidth(Math.max(1, size * 0.12));
      ctx.strokeEllipse(new Rect(rect.x - pad, rect.y - pad, size + pad * 2, size + pad * 2));
    } else {
      ctx.setFillColor(soft);
      ctx.fillEllipse(rect);
    }
  }
  return ctx.getImage();
}

function headline(st) {
  if (st.state === 'done') return { num: '✓', label: 'completed' };
  if (st.state === 'upcoming') return { num: String(st.daysUntilStart), label: st.daysUntilStart === 1 ? 'day to start' : 'days to start' };
  return { num: String(st.daysLeft), label: st.daysLeft === 1 ? 'day left' : 'days left' };
}

function subline(task, st) {
  if (st.state === 'active') return `Day ${st.currentDay} of ${task.total}`;
  return `${task.total} days`;
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

function buildWidget(task, family) {
  const now = new Date();
  const st = getStatus(task, now);
  const dark = Device.isUsingDarkAppearance();
  const accent = new Color(task.color);
  const { num, label } = headline(st);

  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(14, 14, 14, 14);
  // Refresh at midnight (dot flips) and every ~30 min for today's fill.
  w.refreshAfterDate = new Date(Math.min(addDays(startOfDay(now), 1).getTime() + 5000, now.getTime() + REFRESH_MINUTES * 60000));
  w.url = 'scriptable:///run/' + encodeURIComponent(Script.name());

  if (family === 'small') {
    const top = w.addStack();
    top.centerAlignContent();
    addText(top, num, Font.heavySystemFont(26), accent);
    top.addSpacer(4);
    addText(top, label, Font.semiboldSystemFont(11), MUTED);
    w.addSpacer(6);
    w.addImage(drawDots(task, st, 130, 68, dark)).centerAlignImage();
    w.addSpacer(4);
    addText(w, task.name, Font.semiboldSystemFont(11), TEXT);
    addDeadline(w, task, st, 10, accent, { label: 'Ends in' });
    return w;
  }

  if (family === 'medium') {
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const col = row.addStack();
    col.layoutVertically();
    col.size = new Size(110, 0);
    addText(col, task.name, Font.semiboldSystemFont(13), TEXT, 2);
    col.addSpacer(4);
    addText(col, num, Font.heavySystemFont(38), accent);
    addText(col, label, Font.semiboldSystemFont(12), MUTED);
    col.addSpacer(4);
    addText(col, subline(task, st), Font.systemFont(11), MUTED);
    col.addSpacer(2);
    addDeadline(col, task, st, 11, accent, { stacked: true });
    if (freshness) addText(col, freshness, Font.systemFont(9), MUTED);
    row.addSpacer(10);
    row.addImage(drawDots(task, st, 180, 128, dark));
    return w;
  }

  // large (and the app preview)
  const head = w.addStack();
  head.layoutHorizontally();
  head.bottomAlignContent();
  const left = head.addStack();
  left.layoutVertically();
  addText(left, task.name, Font.semiboldSystemFont(15), TEXT);
  addText(left, subline(task, st), Font.systemFont(12), MUTED);
  addDeadline(left, task, st, 12, accent);
  if (freshness) addText(left, freshness, Font.systemFont(10), MUTED);
  head.addSpacer();
  const right = head.addStack();
  right.layoutVertically();
  addText(right, num, Font.heavySystemFont(34), accent).rightAlignText();
  addText(right, label, Font.semiboldSystemFont(11), MUTED).rightAlignText();
  w.addSpacer(10);
  w.addImage(drawDots(task, st, 310, 250, dark)).centerAlignImage();
  w.addSpacer();
  return w;
}

/**
 * "Deadline in 73 days, 2 hr" — the date is drawn by iOS in relative
 * style, so it keeps counting down live between widget refreshes.
 */
function addDeadline(stack, task, st, size, color, { label = 'Deadline in', stacked = false } = {}) {
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
  const upcoming = st.state === 'upcoming';
  addText(row, upcoming ? 'Starts in' : label, Font.systemFont(size), MUTED);
  const d = row.addDate(upcoming ? task.start : addDays(task.start, task.total));
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
  addText(w, 'Dots', Font.boldSystemFont(14), TEXT);
  w.addSpacer(4);
  addText(w, msg, Font.systemFont(11), MUTED, 4);
  return w;
}

/* ---------- Entry points ---------- */

/** Build and show the widget. Called by loader.js, or below when pasted directly. */
async function main({ countdowns, param } = {}) {
  // The loader drops countdowns.json if it isn't strict JSON, so re-read it here
  // leniently. This file updates itself, so even old loaders get the fix.
  let list = countdowns;
  let fileError = null;
  if (globalThis.__DOTS_VIA_LOADER && !String(param || '').includes('|')) {
    const text = await downloadCountdowns();
    if (text != null) {
      const parsed = parseCountdowns(text);
      if (parsed.list) list = parsed.list;
      else fileError = parsed.error;
      freshness = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      freshness = 'Offline · last saved copy';
    }
  }
  let { task, error } = pickTask(list, param);
  if (!task && fileError) error = fileError;
  const widget = task ? buildWidget(task, config.widgetFamily || 'large') : errorWidget(error);
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentLarge();
  }
  Script.complete();
}

module.exports = { main };

// Pasted straight into Scriptable (no loader): use the Parameter line, or DEFAULT.
if (!globalThis.__DOTS_VIA_LOADER) {
  main({ param: args.widgetParameter || DEFAULT });
}
