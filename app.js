'use strict';

/* =========================================================
 * Dots — a days-left countdown, one dot per day.
 * All state lives in localStorage; everything shown on screen
 * is derived from (task, now), so the UI is always correct
 * no matter how long the app was closed.
 * ========================================================= */

const STORAGE_KEY = 'dots.tasks.v1';
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#e03131', '#0c8599', '#495057'];
const DAY_MS = 86400000;

/* ---------- Date helpers (local time, DST-safe) ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Whole calendar days from a to b (both truncated to midnight). */
function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDateYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function pad2(n) {
  return String(n).padStart(2, '0');
}
function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
function formatLong(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 100) return `${d}d ${h}h`;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return formatClock(ms);
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------- Status: the single source of truth ---------- */

/**
 * Derive everything about a task at a moment in time.
 * currentDay is 1-based (day 1 = start date). daysLeft counts the
 * days after today, so "day 27 of 100" means 73 days left.
 */
function getStatus(task, now = new Date()) {
  const start = parseISODate(task.start);
  const total = task.total;
  const end = addDays(start, total);
  const todayStart = startOfDay(now);
  const tomorrow = addDays(todayStart, 1);
  const idx = daysBetween(start, now);

  if (now < start) {
    return {
      state: 'upcoming', start, end, total,
      currentDay: 0, daysLeft: total, daysUntilStart: idx * -1,
      dayProgress: 0, overall: 0,
      msToNextDay: start - now, msToEnd: end - now,
    };
  }
  if (idx >= total) {
    return {
      state: 'done', start, end, total,
      currentDay: total, daysLeft: 0,
      dayProgress: 1, overall: 1,
      msToNextDay: 0, msToEnd: 0,
    };
  }
  const dayProgress = (now - todayStart) / (tomorrow - todayStart);
  return {
    state: 'active', start, end, total,
    currentDay: idx + 1, daysLeft: total - (idx + 1),
    dayProgress, overall: (idx + dayProgress) / total,
    msToNextDay: tomorrow - now, msToEnd: end - now,
  };
}

/** Changes only when a dot needs to change state. */
function signature(task, st) {
  return `${task.id}:${st.state}:${st.currentDay}`;
}

/* ---------- Storage ---------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const tasks = raw ? JSON.parse(raw) : [];
    return Array.isArray(tasks) ? tasks.filter((t) => t && t.id && t.start && t.total > 0) : [];
  } catch {
    return [];
  }
}
function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
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
const taskList = $('task-list');
const emptyState = $('empty-state');
const grid = $('dot-grid');
const tip = $('dot-tip');
const dialog = $('task-dialog');
const form = $('task-form');

let tasks = loadTasks();
let openId = null; // task shown in the detail view
let editingId = null; // task in the edit sheet (null = new)
let gridSig = '';
let listSig = '';

/* ---------- List view ---------- */

function renderList(now = new Date()) {
  taskList.textContent = '';
  emptyState.hidden = tasks.length > 0;

  const sorted = [...tasks].sort((a, b) => {
    const sa = getStatus(a, now), sb = getStatus(b, now);
    const rank = { active: 0, upcoming: 1, done: 2 };
    return rank[sa.state] - rank[sb.state] || sa.daysLeft - sb.daysLeft;
  });

  for (const task of sorted) {
    const st = getStatus(task, now);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'task-card';
    btn.style.setProperty('--c', task.color);
    btn.addEventListener('click', () => (location.hash = `#/t/${task.id}`));

    const head = document.createElement('div');
    head.className = 'card-head';
    const name = document.createElement('span');
    name.className = 'card-name truncate';
    name.textContent = task.name;
    const left = document.createElement('span');
    left.className = 'card-left';
    if (st.state === 'done') {
      left.textContent = '✓';
    } else {
      left.textContent = st.daysLeft;
      const small = document.createElement('small');
      small.textContent = st.daysLeft === 1 ? 'day left' : 'days left';
      left.append(small);
    }
    head.append(name, left);

    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = subtitle(st);

    const strip = document.createElement('div');
    strip.className = 'card-strip';
    // Compress very long countdowns into ≤100 mini dots.
    const n = Math.min(st.total, 100);
    const per = st.total / n;
    for (let i = 0; i < n; i++) {
      const dot = document.createElement('i');
      const dayIdx = Math.floor(i * per);
      if (st.state === 'done' || dayIdx < st.currentDay - 1) dot.className = 'on';
      else if (st.state === 'active' && dayIdx <= st.currentDay - 1 && st.currentDay - 1 < Math.floor((i + 1) * per)) dot.className = 'now';
      strip.append(dot);
    }

    btn.append(head, sub, strip);
    li.append(btn);
    taskList.append(li);
  }
  listSig = tasks.map((t) => signature(t, getStatus(t, now))).join('|');
}

function subtitle(st) {
  if (st.state === 'upcoming') return `Starts in ${plural(st.daysUntilStart, 'day')} · ${plural(st.total, 'day')}`;
  if (st.state === 'done') return `Completed ${fmtDateYear.format(addDays(st.end, -1))} · ${plural(st.total, 'day')}`;
  return `Day ${st.currentDay} of ${st.total} · ends ${fmtDate.format(addDays(st.end, -1))}`;
}

/* ---------- Detail view ---------- */

function renderDetail(now = new Date(), { animate = false } = {}) {
  const task = tasks.find((t) => t.id === openId);
  if (!task) return;
  const st = getStatus(task, now);

  $('detail-title').textContent = task.name;
  detailView.style.setProperty('--c', task.color);
  grid.setAttribute('aria-label', `${st.total} days: ${st.currentDay} reached, ${st.daysLeft} left`);

  const prevToday = grid.querySelector('.dot.today');
  const prevTodayIdx = prevToday ? Number(prevToday.dataset.i) : -1;

  grid.textContent = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < st.total; i++) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.dataset.i = i;
    let cls = 'future';
    if (st.state === 'done' || i < st.currentDay - 1) cls = 'past';
    else if (st.state === 'active' && i === st.currentDay - 1) cls = 'today';
    dot.className = `dot ${cls}`;
    if (animate && i === prevTodayIdx && cls === 'past') dot.classList.add('flip');
    if (animate && cls === 'today' && i !== prevTodayIdx) dot.classList.add('flip');
    frag.append(dot);
  }
  grid.append(frag);
  gridSig = signature(task, st);
  layoutGrid();
  updateLive(now);
}

/** Small, evenly spaced dots: size shrinks as the total grows. */
function dotSize(total) {
  if (total <= 30) return 18;
  if (total <= 60) return 15;
  if (total <= 120) return 13;
  if (total <= 250) return 11;
  if (total <= 500) return 9;
  return 7;
}

/** Pick a column count so the grid is roughly square and fits the width. */
function layoutGrid() {
  const task = tasks.find((t) => t.id === openId);
  if (!task || detailView.hidden) return;
  const total = task.total;
  const W = grid.clientWidth || window.innerWidth - 64;
  let size = dotSize(total);
  let gap = Math.round(size * 0.7);
  const fit = () => Math.max(1, Math.floor((W + gap) / (size + gap)));
  // Very long countdowns on narrow screens: shrink until a sensible grid fits.
  while (size > 5 && Math.ceil(total / fit()) > fit() * 2.2) {
    size -= 1;
    gap = Math.round(size * 0.7);
  }
  const maxCols = fit();
  let cols = Math.min(maxCols, total, Math.ceil(Math.sqrt(total)));
  // Prefer a nearby column count that divides the total evenly (tidy last row).
  for (let d = 0; d <= 2; d++) {
    if (cols + d <= maxCols && total % (cols + d) === 0) { cols += d; break; }
    if (cols - d > 0 && total % (cols - d) === 0) { cols -= d; break; }
  }
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--size', `${size}px`);
  grid.style.setProperty('--gap', `${gap}px`);
}

/** Cheap per-second update: numbers, timers and today's fill ring. */
function updateLive(now = new Date()) {
  const task = tasks.find((t) => t.id === openId);
  if (!task) return;
  const st = getStatus(task, now);

  if (st.state === 'upcoming') {
    $('days-left').textContent = st.daysUntilStart;
    $('days-left-label').textContent = st.daysUntilStart === 1 ? 'day to start' : 'days to start';
    $('day-of').textContent = `Starts ${fmtDate.format(st.start)} · ${plural(st.total, 'day')}`;
    $('next-day-timer').previousElementSibling.textContent = 'Starts in';
    $('next-day-timer').textContent = formatLong(st.msToNextDay);
  } else if (st.state === 'done') {
    $('days-left').textContent = '✓';
    $('days-left-label').textContent = 'completed';
    $('day-of').textContent = `All ${st.total} days done · finished ${fmtDateYear.format(addDays(st.end, -1))}`;
    $('next-day-timer').previousElementSibling.textContent = 'Next day in';
    $('next-day-timer').textContent = '—';
  } else {
    $('days-left').textContent = st.daysLeft;
    $('days-left-label').textContent = st.daysLeft === 1 ? 'day left' : 'days left';
    $('day-of').textContent = `Day ${st.currentDay} of ${st.total} · last day ${fmtDate.format(addDays(st.end, -1))}`;
    $('next-day-timer').previousElementSibling.textContent = 'Next day in';
    $('next-day-timer').textContent = formatClock(st.msToNextDay);
  }
  $('deadline-timer').textContent = st.state === 'done' ? 'Done' : formatLong(st.msToEnd);
  $('progress-fill').style.width = `${(st.overall * 100).toFixed(2)}%`;

  const today = grid.querySelector('.dot.today');
  if (today) today.style.setProperty('--p', st.dayProgress.toFixed(4));
}

/* ---------- Tooltip for a tapped dot ---------- */

let tipTimer = 0;
grid.addEventListener('click', (e) => {
  const dot = e.target.closest('.dot');
  const task = tasks.find((t) => t.id === openId);
  if (!dot || !task) return;
  const i = Number(dot.dataset.i);
  const date = addDays(parseISODate(task.start), i);
  const state = dot.classList.contains('today') ? ' · today' : dot.classList.contains('past') ? ' · done' : '';
  tip.textContent = `Day ${i + 1} · ${fmtDate.format(date)}${state}`;
  const r = dot.getBoundingClientRect();
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(window.innerWidth - half - 8, Math.max(half + 8, r.left + r.width / 2))}px`;
  tip.style.top = `${r.top}px`;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => (tip.hidden = true), 1800);
});
window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });

/* ---------- Routing (hash, so Android back button works) ---------- */

function route() {
  const m = location.hash.match(/^#\/t\/(.+)$/);
  const task = m && tasks.find((t) => t.id === m[1]);
  tip.hidden = true;
  if (task) {
    openId = task.id;
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
const fTotal = $('f-total');
const fCurrent = $('f-current');
const fStart = $('f-start');
const fHint = $('f-hint');

// Colour swatches
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

function mode() {
  return form.elements.mode.value;
}

/** Start date implied by the form, or null if invalid. */
function formStart() {
  if (mode() === 'date') return fStart.value ? parseISODate(fStart.value) : null;
  const day = parseInt(fCurrent.value, 10);
  if (!(day >= 1)) return null;
  return addDays(startOfDay(new Date()), -(day - 1));
}

function updateHint() {
  const isDay = mode() === 'day';
  fCurrent.hidden = !isDay;
  fStart.hidden = isDay;
  const total = parseInt(fTotal.value, 10);
  fCurrent.max = total > 0 ? total : '';
  const start = formStart();
  if (!start || !(total > 0)) {
    fHint.textContent = '';
    return;
  }
  const last = addDays(start, total - 1);
  const st = getStatus({ start: toISODate(start), total }, new Date());
  const left = st.state === 'done' ? 'already finished' : st.state === 'upcoming' ? `starts in ${plural(st.daysUntilStart, 'day')}` : `${plural(st.daysLeft, 'day')} left`;
  fHint.textContent = `${fmtDate.format(start)} → ${fmtDate.format(last)} · ${left}`;
}
form.addEventListener('input', updateHint);
form.addEventListener('change', updateHint);

function openSheet(task) {
  editingId = task ? task.id : null;
  $('dialog-title').textContent = task ? 'Edit countdown' : 'New countdown';
  $('delete-btn').hidden = !task;
  fName.value = task ? task.name : '';
  fTotal.value = task ? task.total : 100;
  const color = task ? task.color : COLORS[tasks.length % COLORS.length];
  for (const r of form.elements.color) r.checked = r.value === color;

  const st = task ? getStatus(task) : null;
  fStart.value = task ? task.start : toISODate(new Date());
  fCurrent.value = st && st.state === 'active' ? st.currentDay : 1;
  const useDate = st && st.state !== 'active';
  form.elements.mode.value = useDate ? 'date' : 'day';
  updateHint();
  dialog.showModal();
  if (!task) fName.focus();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = fName.value.trim();
  const total = parseInt(fTotal.value, 10);
  const start = formStart();
  if (!name) return fName.focus();
  if (!(total >= 1 && total <= 3650)) return fTotal.focus();
  if (!start) return (mode() === 'day' ? fCurrent : fStart).focus();
  if (mode() === 'day' && parseInt(fCurrent.value, 10) > total) {
    fHint.textContent = `Current day can't be more than ${total}.`;
    return fCurrent.focus();
  }
  const data = { name, total, start: toISODate(start), color: form.elements.color.value || COLORS[0] };

  if (editingId) {
    Object.assign(tasks.find((t) => t.id === editingId), data);
  } else {
    const task = { id: uid(), createdAt: Date.now(), ...data };
    tasks.push(task);
    editingId = task.id;
  }
  saveTasks();
  dialog.close();
  if (location.hash === `#/t/${editingId}`) route();
  else location.hash = `#/t/${editingId}`;
});

$('cancel-btn').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // tap on backdrop
});
$('delete-btn').addEventListener('click', () => {
  const task = tasks.find((t) => t.id === editingId);
  if (!task || !confirm(`Delete “${task.name}”?`)) return;
  tasks = tasks.filter((t) => t.id !== editingId);
  saveTasks();
  dialog.close();
  location.hash = '';
});

$('add-btn').addEventListener('click', () => openSheet(null));
$('empty-add-btn').addEventListener('click', () => openSheet(null));
$('edit-btn').addEventListener('click', () => openSheet(tasks.find((t) => t.id === openId)));

/* ---------- Home-screen widget (Scriptable) ---------- */

const widgetDialog = $('widget-dialog');

/** The line pasted into the widget's Parameter field. */
function widgetParam(task) {
  return [task.name.replace(/\|/g, '/'), task.start, task.total, task.color].join('|');
}

let widgetScript = '';
function loadWidgetScript() {
  if (widgetScript) return;
  fetch('widget/dots-widget.js')
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
    // Clipboard API blocked (e.g. not https): use a hidden textarea.
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
  const task = tasks.find((t) => t.id === openId);
  if (!task) return;
  $('widget-param').textContent = widgetParam(task);
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

/* ---------- The timer: keeps everything in sync with the clock ---------- */

function tick() {
  const now = new Date();
  if (openId && !detailView.hidden) {
    const task = tasks.find((t) => t.id === openId);
    if (task && signature(task, getStatus(task, now)) !== gridSig) {
      renderDetail(now, { animate: true }); // a day passed → dots shift
    } else {
      updateLive(now);
    }
  } else if (!listView.hidden) {
    const sig = tasks.map((t) => signature(t, getStatus(t, now))).join('|');
    if (sig !== listSig) renderList(now);
  }
}

// Align ticks to the wall-clock second so the countdown never skips.
function scheduleTick() {
  setTimeout(() => {
    tick();
    scheduleTick();
  }, 1000 - (Date.now() % 1000) + 5);
}
scheduleTick();

// Phones freeze timers in the background — catch up the moment we're visible.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});
window.addEventListener('focus', tick);
window.addEventListener('pageshow', tick);

let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(layoutGrid);
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
