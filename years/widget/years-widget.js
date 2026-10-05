// Years — home-screen widget for iPhone (runs in the free "Scriptable" app).
// One dot per year of your life or of a long goal; this year's dot fills in daily.
//
// Setup:
//   1. Install Scriptable from the App Store.
//   2. In Scriptable tap +, paste this whole file, name it "Years".
//   3. On your home screen add a Scriptable widget (small, medium or large),
//      long-press it → Edit Widget → Script: Years.
//   4. Parameter: paste the line from Years → your item → "Home-screen widget",
//      e.g.  life|My life|1999-05-10|2079-05-10|#1c7ed6
//      (life or goal | name | start | end | colour). One widget per item.
//
// If the parameter is empty, the DEFAULT below is used.

const DEFAULT = 'life|My life|1999-05-10|2079-05-10|#1c7ed6';

const DAY_MS = 86400000;
const YEAR_DAYS = 365.2425;

/* ---------- Parse the widget parameter ---------- */

function parseDate(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

function parseItem(raw) {
  const [kind, name, start, end, color] = String(raw || DEFAULT).split('|').map((s) => s.trim());
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e || e <= s) return null;
  return {
    kind: kind === 'goal' ? 'goal' : 'life',
    name: name || (kind === 'goal' ? 'Goal' : 'My life'),
    start: s,
    end: e,
    color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#1c7ed6',
  };
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
  // A year's dot only needs a daily refresh: just after midnight.
  w.refreshAfterDate = new Date(addDays(startOfDay(now), 1).getTime() + 60000);
  w.url = 'scriptable:///run/' + encodeURIComponent(Script.name());

  if (family === 'small') {
    const top = w.addStack();
    top.centerAlignContent();
    addText(top, num, Font.heavySystemFont(24), accent);
    top.addSpacer(4);
    addText(top, label, Font.semiboldSystemFont(11), MUTED);
    w.addSpacer(6);
    w.addImage(drawDots(item, st, 130, 82, dark)).centerAlignImage();
    w.addSpacer(4);
    addText(w, subline(item, st), Font.semiboldSystemFont(11), TEXT);
    return w;
  }

  if (family === 'medium') {
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const col = row.addStack();
    col.layoutVertically();
    col.size = new Size(116, 0);
    addText(col, item.name, Font.semiboldSystemFont(13), TEXT, 2);
    col.addSpacer(4);
    addText(col, num, Font.heavySystemFont(36), accent);
    addText(col, label, Font.semiboldSystemFont(12), MUTED);
    col.addSpacer(4);
    addText(col, subline(item, st), Font.systemFont(11), MUTED);
    row.addSpacer(10);
    row.addImage(drawDots(item, st, 176, 128, dark));
    return w;
  }

  const head = w.addStack();
  head.layoutHorizontally();
  head.bottomAlignContent();
  const left = head.addStack();
  left.layoutVertically();
  addText(left, item.name, Font.semiboldSystemFont(15), TEXT);
  addText(left, subline(item, st), Font.systemFont(12), MUTED);
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

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  addText(w, 'Years', Font.boldSystemFont(14), TEXT);
  w.addSpacer(4);
  addText(w, msg, Font.systemFont(11), MUTED, 4);
  return w;
}

const item = parseItem(args.widgetParameter);
const family = config.widgetFamily || 'large';
const widget = item
  ? buildWidget(item, family)
  : errorWidget('Set the widget Parameter to: life|name|YYYY-MM-DD|YYYY-MM-DD|#colour (copy it from the Years app).');

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
