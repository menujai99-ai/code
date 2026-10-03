'use strict';

/* =========================================================
 * Years — your life and long goals, one dot per year.
 * Same approach as Dots: everything on screen is derived from
 * (item, now), so the current year's dot fills in day by day
 * and the grid moves on at each birthday / anniversary.
 * ========================================================= */

const STORAGE_KEY = 'years.items.v1';
const COLORS = ['#1c7ed6', '#e8590c', '#2f9e44', '#ae3ec9', '#f08c00', '#e03131', '#0c8599', '#495057'];
const DAY_MS = 86400000;
const YEAR_DAYS = 365.2425;
const MAX_YEARS = 130;

/* ---------- Date helpers (local time) ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
/** Same calendar date n years later; Feb 29 becomes Feb 28 in non-leap years. */
function addYears(d, n) {
  const y = d.getFullYear() + n;
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return new Date(y, d.getMonth(), Math.min(d.getDate(), last));
}
function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}
const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtNum = new Intl.NumberFormat();

function plural(n, word) {
  return `${fmtNum.format(n)} ${word}${n === 1 ? '' : 's'}`;
}
function formatSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${fmtNum.format(d)}d ${h}h` : `${h}h ${m}m`;
}

/* ---------- Status: the single source of truth ---------- */

/** Number of year-dots: one per started year between start and end. */
function dotCount(start, end) {
  let n = 0;
  while (n < MAX_YEARS && addYears(start, n) < end) n++;
  return n;
}

/** Start and end of year-dot i (the last one may be a partial year). */
function yearSpan(item, i) {
  const start = parseISODate(item.start);
  const end = parseISODate(item.end);
  const a = addYears(start, i);
  const b = addYears(start, i + 1);
  return [a, b < end ? b : end];
}

function getStatus(item, now = new Date()) {
  const start = parseISODate(item.start);
  const end = parseISODate(item.end);
  const n = dotCount(start, end);
  const base = { start, end, n, overall: Math.min(1, Math.max(0, (now - start) / (end - start))) };

  if (now < start) {
    return { ...base, state: 'upcoming', idx: -1, frac: 0, msToNext: start - now, msToEnd: end - now, daysLeft: daysBetween(now, end) };
  }
  if (now >= end) {
    return { ...base, state: 'done', idx: n, frac: 1, msToNext: 0, msToEnd: 0, daysLeft: 0 };
  }
  let idx = Math.max(0, now.getFullYear() - start.getFullYear() - 1);
  while (addYears(start, idx + 1) <= now) idx++;
  const [a, b] = yearSpan(item, idx);
  return {
    ...base,
    state: 'active',
    idx, // 0-based year-dot that is in progress (= age for a life)
    frac: (now - a) / (b - a),
    yearEnd: b,
    msToNext: b - now,
    msToEnd: end - now,
    daysLeft: daysBetween(now, end),
  };
}

function yearsLeft(st) {
  return Math.max(0, st.msToEnd / DAY_MS / YEAR_DAYS);
}
/** Changes only when a dot needs to change state. */
function signature(item, st) {
  return `${item.id}:${st.state}:${st.idx}:${st.n}`;
}

/* ---------- Storage ---------- */

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items.filter((t) => t && t.id && t.start && t.end && t.start < t.end) : [];
  } catch {
    return [];
  }
}
function saveItems() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable (private mode) — keep working in memory */
  }
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- DOM refs ---------- */

const $ = (id) => document.getElementById(id);
const listView = $('list-view');
const detailView = $('detail-view');
const itemList = $('item-list');
const emptyState = $('empty-state');
const grid = $('dot-grid');
const tip = $('dot-tip');
const dialog = $('item-dialog');
const form = $('item-form');

let items = loadItems();
let openId = null;
let editingId = null;
let gridSig = '';
let listSig = '';

/* ---------- Text helpers ---------- */

function headline(item, st) {
  if (st.state === 'done') return { num: '✓', label: 'completed' };
  if (st.state === 'upcoming') return { num: yearsLeft({ msToEnd: st.msToNext }).toFixed(1), label: 'years to start' };
  const y = yearsLeft(st);
  return { num: y.toFixed(1), label: y.toFixed(1) === '1.0' ? 'year left' : 'years left' };
}

function subline(item, st) {
  const pct = `${Math.floor(st.frac * 100)}%`;
  if (st.state === 'upcoming') return `Starts ${fmtDate.format(st.start)} · ${plural(st.n, 'year')}`;
  if (st.state === 'done') return `All ${plural(st.n, 'year')} done · ended ${fmtDate.format(addDays(st.end, -1))}`;
  if (item.kind === 'life') return `Age ${st.idx} · year ${st.idx + 1} of ${st.n} is ${pct} done`;
  return `Year ${st.idx + 1} of ${st.n} is ${pct} done · ends ${fmtDate.format(addDays(st.end, -1))}`;
}

/* ---------- List view ---------- */

function renderList(now = new Date()) {
  itemList.textContent = '';
  emptyState.hidden = items.length > 0;

  const sorted = [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'life' ? -1 : 1;
    return a.end.localeCompare(b.end);
  });

  for (const item of sorted) {
    const st = getStatus(item, now);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'task-card';
    btn.style.setProperty('--c', item.color);
    btn.addEventListener('click', () => (location.hash = `#/y/${item.id}`));

    const head = document.createElement('div');
    head.className = 'card-head';
    const name = document.createElement('span');
    name.className = 'card-name truncate';
    const tag = document.createElement('span');
    tag.className = 'card-tag';
    tag.textContent = item.kind === 'life' ? 'Life' : 'Goal';
    name.append(tag, item.name);
    const left = document.createElement('span');
    left.className = 'card-left';
    const { num, label } = headline(item, st);
    left.textContent = num;
    if (st.state !== 'done') {
      const small = document.createElement('small');
      small.textContent = label;
      left.append(small);
    }
    head.append(name, left);

    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = subline(item, st);

    const strip = document.createElement('div');
    strip.className = 'card-strip';
    for (let i = 0; i < st.n; i++) {
      const dot = document.createElement('i');
      if (st.state === 'done' || i < st.idx) dot.className = 'on';
      else if (st.state === 'active' && i === st.idx) dot.className = 'now';
      strip.append(dot);
    }

    btn.append(head, sub, strip);
    li.append(btn);
    itemList.append(li);
  }
  listSig = items.map((t) => signature(t, getStatus(t, now))).join('|');
}

/* ---------- Detail view ---------- */

function renderDetail(now = new Date(), { animate = false } = {}) {
  const item = items.find((t) => t.id === openId);
  if (!item) return;
  const st = getStatus(item, now);

  $('detail-title').textContent = item.name;
  detailView.style.setProperty('--c', item.color);
  grid.setAttribute('aria-label', `${st.n} years: ${Math.max(0, st.idx)} done, ${yearsLeft(st).toFixed(1)} left`);

  const prevNow = grid.querySelector('.dot.today');
  const prevIdx = prevNow ? Number(prevNow.dataset.i) : -1;

  grid.textContent = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < st.n; i++) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.dataset.i = i;
    let cls = 'future';
    if (st.state === 'done' || i < st.idx) cls = 'past';
    else if (st.state === 'active' && i === st.idx) cls = 'today';
    dot.className = `dot ${cls}`;
    if (animate && ((i === prevIdx && cls === 'past') || (cls === 'today' && i !== prevIdx))) dot.classList.add('flip');
    frag.append(dot);
  }
  grid.append(frag);
  gridSig = signature(item, st);
  layoutGrid(st.n);
  updateLive(now);
}

function dotSize(n) {
  if (n <= 12) return 22;
  if (n <= 30) return 18;
  if (n <= 60) return 15;
  if (n <= 100) return 13;
  return 11;
}

/** Rows of 10 read as decades; short goals get fewer, bigger dots. */
function layoutGrid(n) {
  if (detailView.hidden) return;
  const W = grid.clientWidth || window.innerWidth - 64;
  const size = dotSize(n);
  const gap = Math.round(size * 0.7);
  const maxCols = Math.max(1, Math.floor((W + gap) / (size + gap)));
  const want = n <= 6 ? n : n <= 20 ? 5 : 10;
  const cols = Math.max(1, Math.min(want, maxCols));
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--size', `${size}px`);
  grid.style.setProperty('--gap', `${gap}px`);
}

/** Per-second update: numbers, timers and this year's fill. */
function updateLive(now = new Date()) {
  const item = items.find((t) => t.id === openId);
  if (!item) return;
  const st = getStatus(item, now);
  const { num, label } = headline(item, st);

  $('big-num').textContent = num;
  $('big-label').textContent = label;
  $('sub-line').textContent = subline(item, st);

  const nextLabel = $('next-label');
  if (st.state === 'upcoming') {
    nextLabel.textContent = 'Starts in';
    $('next-timer').textContent = formatSpan(st.msToNext);
  } else if (st.state === 'done') {
    nextLabel.textContent = item.kind === 'life' ? 'Birthday in' : 'Next year in';
    $('next-timer').textContent = '—';
  } else {
    const last = +st.yearEnd === +st.end;
    nextLabel.textContent = last ? 'Ends in' : item.kind === 'life' ? 'Birthday in' : 'Next year in';
    $('next-timer').textContent = formatSpan(st.msToNext);
  }
  $('days-left').textContent = st.state === 'done' ? 'Done' : fmtNum.format(st.daysLeft);
  $('progress-fill').style.width = `${(st.overall * 100).toFixed(2)}%`;

  const cur = grid.querySelector('.dot.today');
  if (cur) cur.style.setProperty('--p', st.frac.toFixed(4));
}

/* ---------- Tooltip for a tapped dot ---------- */

let tipTimer = 0;
grid.addEventListener('click', (e) => {
  const dot = e.target.closest('.dot');
  const item = items.find((t) => t.id === openId);
  if (!dot || !item) return;
  const i = Number(dot.dataset.i);
  const [a, b] = yearSpan(item, i);
  const age = item.kind === 'life' ? ` · age ${i}` : '';
  tip.textContent = `Year ${i + 1}${age} · ${fmtDate.format(a)} → ${fmtDate.format(addDays(b, -1))}`;
  const r = dot.getBoundingClientRect();
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(window.innerWidth - half - 8, Math.max(half + 8, r.left + r.width / 2))}px`;
  tip.style.top = `${r.top}px`;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => (tip.hidden = true), 2200);
});
window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });

/* ---------- Routing ---------- */

function route() {
  const m = location.hash.match(/^#\/y\/(.+)$/);
  const item = m && items.find((t) => t.id === m[1]);
  tip.hidden = true;
  if (item) {
    openId = item.id;
    listView.hidden = true;
    detailView.hidden = false;
    window.scrollTo(0, 0);
    renderDetail();
  } else {
    openId = null;
    detailView.hidden = true;
    listView.hidden = false;
    renderList();
  }
}
window.addEventListener('hashchange', route);
$('back-btn').addEventListener('click', () => {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = '';
});

/* ---------- Add / edit sheet ---------- */

const fName = $('f-name');
const fBirthday = $('f-birthday');
const fLifespan = $('f-lifespan');
const fStart = $('f-start');
const fYears = $('f-years');
const fEnd = $('f-end');
const fHint = $('f-hint');

for (const [i, c] of COLORS.entries()) {
  const label = document.createElement('label');
  label.style.background = c;
  label.title = c;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'color';
  input.value = c;
  input.setAttribute('aria-label', `Colour ${i + 1}`);
  label.append(input, document.createElement('span'));
  $('f-colors').append(label);
}

const kind = () => form.elements.kind.value;
const lenMode = () => form.elements.len.value;

/** { start, end } implied by the form, or an { error }. */
function formRange() {
  if (kind() === 'life') {
    if (!fBirthday.value) return { error: 'Pick your birthday.' };
    const span = parseInt(fLifespan.value, 10);
    if (!(span >= 1 && span <= MAX_YEARS)) return { error: `Lifespan must be 1–${MAX_YEARS} years.` };
    const start = parseISODate(fBirthday.value);
    return { start, end: addYears(start, span) };
  }
  if (!fStart.value) return { error: 'Pick a start date.' };
  const start = parseISODate(fStart.value);
  if (lenMode() === 'years') {
    const n = parseInt(fYears.value, 10);
    if (!(n >= 1 && n <= MAX_YEARS)) return { error: `Length must be 1–${MAX_YEARS} years.` };
    return { start, end: addYears(start, n) };
  }
  if (!fEnd.value) return { error: 'Pick a target date.' };
  const end = parseISODate(fEnd.value);
  if (end <= start) return { error: 'Target date must be after the start date.' };
  if (end > addYears(start, MAX_YEARS)) return { error: `Target date is more than ${MAX_YEARS} years away.` };
  return { start, end };
}

function updateForm() {
  const life = kind() === 'life';
  $('life-fields').hidden = !life;
  $('goal-fields').hidden = life;
  fName.placeholder = life ? 'My life' : 'e.g. 10-year plan';
  const byYears = lenMode() === 'years';
  fYears.hidden = !byYears;
  fEnd.hidden = byYears;

  const r = formRange();
  if (r.error) {
    fHint.textContent = r.error;
    return;
  }
  const st = getStatus({ start: toISODate(r.start), end: toISODate(r.end) });
  const days = daysBetween(r.start, r.end);
  if (life) {
    const age = st.state === 'active' ? `age ${st.idx} · ` : '';
    fHint.textContent = `${age}${plural(st.n, 'dot')}, until ${fmtDate.format(r.end)}`;
  } else {
    fHint.textContent = `${fmtDate.format(r.start)} → ${fmtDate.format(addDays(r.end, -1))} · ${plural(st.n, 'dot')} · ${plural(days, 'day')}`;
  }
}
form.addEventListener('input', updateForm);
form.addEventListener('change', updateForm);

function openSheet(item, presetKind) {
  editingId = item ? item.id : null;
  const k = item ? item.kind : presetKind || (items.some((t) => t.kind === 'life') ? 'goal' : 'life');
  $('dialog-title').textContent = item ? 'Edit' : k === 'life' ? 'My life' : 'New goal';
  $('delete-btn').hidden = !item;
  form.elements.kind.value = k;
  fName.value = item ? item.name : '';
  const color = item ? item.color : COLORS[items.length % COLORS.length];
  for (const r of form.elements.color) r.checked = r.value === color;

  const today = startOfDay(new Date());
  if (item) {
    const start = parseISODate(item.start);
    const end = parseISODate(item.end);
    const whole = dotCount(start, end);
    const exact = +addYears(start, whole) === +end;
    fBirthday.value = item.start;
    fLifespan.value = whole;
    fStart.value = item.start;
    fYears.value = whole;
    fEnd.value = item.end;
    form.elements.len.value = item.kind === 'goal' && !exact ? 'until' : 'years';
  } else {
    fBirthday.value = '';
    fLifespan.value = 80;
    fStart.value = toISODate(today);
    fYears.value = 10;
    fEnd.value = toISODate(addYears(today, 10));
    form.elements.len.value = 'years';
  }
  updateForm();
  dialog.showModal();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const r = formRange();
  if (r.error) {
    fHint.textContent = r.error;
    return;
  }
  const name = fName.value.trim() || (kind() === 'life' ? 'My life' : 'Goal');
  const data = {
    kind: kind(),
    name,
    start: toISODate(r.start),
    end: toISODate(r.end),
    color: form.elements.color.value || COLORS[0],
  };
  if (editingId) {
    Object.assign(items.find((t) => t.id === editingId), data);
  } else {
    const item = { id: uid(), createdAt: Date.now(), ...data };
    items.push(item);
    editingId = item.id;
  }
  saveItems();
  dialog.close();
  if (location.hash === `#/y/${editingId}`) route();
  else location.hash = `#/y/${editingId}`;
});

$('cancel-btn').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
$('delete-btn').addEventListener('click', () => {
  const item = items.find((t) => t.id === editingId);
  if (!item || !confirm(`Delete “${item.name}”?`)) return;
  items = items.filter((t) => t.id !== editingId);
  saveItems();
  dialog.close();
  location.hash = '';
});

$('add-btn').addEventListener('click', () => openSheet(null));
$('empty-life-btn').addEventListener('click', () => openSheet(null, 'life'));
$('empty-goal-btn').addEventListener('click', () => openSheet(null, 'goal'));
$('edit-btn').addEventListener('click', () => openSheet(items.find((t) => t.id === openId)));

/* ---------- Home-screen widget (Scriptable) ---------- */

const widgetDialog = $('widget-dialog');

/** The line pasted into the widget's Parameter field. */
function widgetParam(item) {
  return [item.kind, item.name.replace(/\|/g, '/'), item.start, item.end, item.color].join('|');
}

let widgetScript = '';
function loadWidgetScript() {
  if (widgetScript) return;
  fetch('widget/years-widget.js')
    .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
    .then((text) => {
      widgetScript = text;
      $('copy-script').textContent = 'Copy widget script';
    })
    .catch(() => ($('copy-script').textContent = 'Could not load script'));
}

function copyText(text, btn) {
  const label = btn.textContent;
  const done = (ok) => {
    btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => (btn.textContent = label), 1600);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    widgetDialog.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    done(ok);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => done(true), fallback);
  } else {
    fallback();
  }
}

$('widget-btn').addEventListener('click', () => {
  const item = items.find((t) => t.id === openId);
  if (!item) return;
  $('widget-param').textContent = widgetParam(item);
  loadWidgetScript();
  widgetDialog.showModal();
});
$('copy-param').addEventListener('click', (e) => copyText($('widget-param').textContent, e.currentTarget));
$('copy-script').addEventListener('click', (e) => {
  // Copy synchronously inside the tap — iOS rejects clipboard writes after an await.
  if (widgetScript) copyText(widgetScript, e.currentTarget);
  else e.currentTarget.textContent = 'Loading… tap again';
});
$('widget-close').addEventListener('click', () => widgetDialog.close());
widgetDialog.addEventListener('click', (e) => {
  if (e.target === widgetDialog) widgetDialog.close();
});

/* ---------- The timer ---------- */

function tick() {
  const now = new Date();
  if (openId && !detailView.hidden) {
    const item = items.find((t) => t.id === openId);
    if (item && signature(item, getStatus(item, now)) !== gridSig) {
      renderDetail(now, { animate: true }); // a birthday / anniversary passed
    } else {
      updateLive(now);
    }
  } else if (!listView.hidden) {
    const sig = items.map((t) => signature(t, getStatus(t, now))).join('|');
    if (sig !== listSig) renderList(now);
  }
}

function scheduleTick() {
  setTimeout(() => {
    tick();
    scheduleTick();
  }, 1000 - (Date.now() % 1000) + 5);
}
scheduleTick();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});
window.addEventListener('focus', tick);
window.addEventListener('pageshow', tick);

let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const item = items.find((t) => t.id === openId);
    if (item) layoutGrid(getStatus(item).n);
  });
});

/* ---------- Empty-state decoration ---------- */

(function decorateEmpty() {
  const box = document.querySelector('.empty-dots');
  for (let i = 0; i < 21; i++) {
    const d = document.createElement('i');
    if (i < 9) d.className = 'on';
    box.append(d);
  }
})();

/* ---------- Boot ---------- */

route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
