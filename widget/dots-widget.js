// Dots — home-screen widget for iPhone (runs in the free "Scriptable" app).
//
// Setup:
//   1. Install Scriptable from the App Store.
//   2. In Scriptable tap +, paste this whole file, name it "Dots".
//   3. On your home screen add a Scriptable widget (small, medium or large),
//      long-press it → Edit Widget → Script: Dots.
//   4. Parameter: paste the line from Dots → your countdown → "Home-screen widget",
//      e.g.  Exam prep|2026-09-07|100|#e8590c
//      (name | start date | total days | colour). One widget per countdown.
//
// If the parameter is empty, the DEFAULT below is used.

const DEFAULT = 'Exam prep|2026-09-07|100|#e8590c';

const DAY_MS = 86400000;

/* ---------- Parse the widget parameter ---------- */

function parseTask(raw) {
  const [name, start, total, color] = String(raw || DEFAULT).split('|').map((s) => s.trim());
  const [y, m, d] = (start || '').split('-').map(Number);
  const n = parseInt(total, 10);
  if (!y || !m || !d || !(n > 0)) return null;
  return {
    name: name || 'Countdown',
    start: new Date(y, m - 1, d),
    total: n,
    color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#e8590c',
  };
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
  w.refreshAfterDate = new Date(Math.min(addDays(startOfDay(now), 1).getTime() + 5000, now.getTime() + 30 * 60000));
  w.url = 'scriptable:///run/' + encodeURIComponent(Script.name());

  if (family === 'small') {
    const top = w.addStack();
    top.centerAlignContent();
    addText(top, num, Font.heavySystemFont(26), accent);
    top.addSpacer(4);
    addText(top, label, Font.semiboldSystemFont(11), MUTED);
    w.addSpacer(6);
    w.addImage(drawDots(task, st, 130, 82, dark)).centerAlignImage();
    w.addSpacer(4);
    addText(w, task.name, Font.semiboldSystemFont(11), TEXT);
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

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  addText(w, 'Dots', Font.boldSystemFont(14), TEXT);
  w.addSpacer(4);
  addText(w, msg, Font.systemFont(11), MUTED, 4);
  return w;
}

const raw = config.runsInWidget ? args.widgetParameter : (args.widgetParameter || DEFAULT);
const task = parseTask(raw);
const family = config.widgetFamily || 'large';
const widget = task
  ? buildWidget(task, family)
  : errorWidget('Set the widget Parameter to: name|YYYY-MM-DD|total|#colour (copy it from the Dots app).');

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
