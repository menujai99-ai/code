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
  requestSync(); // keep the widget's years.json on GitHub up to date
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

/* ---------- Widget sync: years.json on GitHub ---------- */
// The widget reads years/widget/years.json from GitHub. With a token, every
// add / edit / delete here rewrites that file through the GitHub API. The
// token is shared with Dots (same site), so setting it in either app is enough.

const SYNC_KEY = 'years.sync.v1';
const SHARED_KEY = 'dots.sync.v1'; // repo + token, shared with the Dots app
const SYNC_PATH = 'years/widget/years.json';
const DEFAULT_REPO = 'menujai99-ai/code';
const syncDialog = $('sync-dialog');

let sync = loadSync(); // { repo, token, dirty, lastSynced }
let syncRunning = false;
let syncQueued = false;

function loadSync() {
  try {
    const shared = JSON.parse(localStorage.getItem(SHARED_KEY) || '{}');
    const own = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    // own.off: sync turned off in Years only (the Dots token is left alone).
    const s = { repo: shared.repo || DEFAULT_REPO, token: own.off ? undefined : shared.token, off: own.off, dirty: own.dirty, lastSynced: own.lastSynced };
    // First time with a Dots token already set: start in sync mode and push once.
    if (s.token && own.dirty === undefined) s.dirty = true;
    return s;
  } catch {
    return { repo: DEFAULT_REPO };
  }
}
function saveSync() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ off: Boolean(sync.off), dirty: Boolean(sync.dirty), lastSynced: sync.lastSynced }));
    if (sync.token) {
      const shared = JSON.parse(localStorage.getItem(SHARED_KEY) || '{}');
      localStorage.setItem(SHARED_KEY, JSON.stringify({ ...shared, repo: sync.repo, token: sync.token }));
    }
  } catch {
    /* keep in memory */
  }
}
function syncOn() {
  return Boolean(sync.token && sync.repo);
}

/** The whole years.json, one item per line. */
function itemsFile() {
  const rows = items.map((t) => '  ' + JSON.stringify({ kind: t.kind, name: t.name, start: t.start, end: t.end, color: t.color }));
  return rows.length ? `[\n${rows.join(',\n')}\n]\n` : '[]\n';
}

/** Same forgiving reader as the widget: fixes missing/trailing commas and curly quotes. */
function parseCountdowns(text) {
  const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null);
  try {
    return asList(JSON.parse(text)) || [];
  } catch {
    /* try repaired */
  }
  const fixed = String(text)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\}(\s*)\{/g, '},$1{')
    .replace(/,(\s*[\]}])/g, '$1');
  try {
    return asList(JSON.parse(fixed)) || [];
  } catch {
    return [];
  }
}

function toBase64(str) {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

class SyncError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function github(method, body) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${sync.repo}/contents/${SYNC_PATH}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${sync.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Let a save finish even if the app is closed right after it.
      keepalive: method === 'PUT',
    });
  } catch {
    throw new SyncError(0, 'offline');
  }
  return res;
}

/** Current file on GitHub: { sha, text } (both null if it doesn't exist yet). */
async function readRemote() {
  const res = await github('GET');
  if (res.status === 404) {
    // 404 also means "no access" for a token that can't see the repo.
    const repoRes = await fetch(`https://api.github.com/repos/${sync.repo}`, {
      headers: { Authorization: `Bearer ${sync.token}`, Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    }).catch(() => null);
    if (!repoRes || !repoRes.ok) throw new SyncError(404, `can't see ${sync.repo} — check the repository name and the token's repository access`);
    return { sha: null, text: null };
  }
  if (!res.ok) throw httpError(res.status);
  const data = await res.json();
  return { sha: data.sha, text: fromBase64(data.content) };
}

function httpError(status) {
  if (status === 401) return new SyncError(status, 'token rejected — paste a new one in Widget sync');
  if (status === 403) return new SyncError(status, "the token can't write to the repo — give it Contents: Read and write");
  return new SyncError(status, `GitHub error ${status}`);
}

async function pushFile() {
  const body = itemsFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { sha, text } = await readRemote();
    if (text === body) return; // already up to date
    const res = await github('PUT', {
      message: 'Update years from Years app',
      content: toBase64(body),
      ...(sha ? { sha } : {}),
    });
    if (res.ok) return;
    if ((res.status === 409 || res.status === 422) && attempt === 0) continue; // changed meanwhile: retry once
    throw httpError(res.status);
  }
}

function requestSync() {
  if (!syncOn()) return;
  sync.dirty = true;
  saveSync();
  runSync();
}

async function runSync() {
  if (!syncOn() || !sync.dirty) return showSyncStatus();
  if (syncRunning) {
    syncQueued = true;
    return;
  }
  if (!navigator.onLine) return showSyncStatus('offline');
  syncRunning = true;
  showSyncStatus('syncing');
  try {
    sync.dirty = false; // edits made while pushing set it again
    await pushFile();
    sync.lastSynced = Date.now();
    saveSync();
    showSyncStatus();
  } catch (e) {
    sync.dirty = true;
    saveSync();
    showSyncStatus(e.status === 0 ? 'offline' : 'error', e.message);
  } finally {
    syncRunning = false;
    if (syncQueued) {
      syncQueued = false;
      runSync();
    }
  }
}

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function showSyncStatus(state, message) {
  const box = $('sync-status');
  $('sync-btn').classList.toggle('on', syncOn());
  box.hidden = !syncOn();
  box.classList.toggle('error', state === 'error');
  $('sync-retry').hidden = state !== 'error' && state !== 'offline';
  if (!syncOn()) return;
  if (state === 'syncing') $('sync-text').textContent = 'Syncing widget…';
  else if (state === 'offline') $('sync-text').textContent = 'Offline · the widget will update when you are back online.';
  else if (state === 'error') $('sync-text').textContent = `Widget sync failed: ${message}.`;
  else if (sync.dirty) $('sync-text').textContent = 'Widget sync pending…';
  else if (sync.lastSynced) $('sync-text').textContent = `Widget synced ✓ ${fmtTime.format(sync.lastSynced)}`;
  else $('sync-text').textContent = 'Widget sync on';
}

/** First connect: bring in items that exist only on GitHub (matched by name). */
function importRemote(text) {
  const have = new Set(items.map((t) => t.name.trim().toLowerCase()));
  let added = 0;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const e of parseCountdowns(text)) {
    if (!e || !e.name || !iso.test(e.start || '') || !iso.test(e.end || '') || e.end <= e.start) continue;
    if (have.has(String(e.name).trim().toLowerCase())) continue;
    items.push({
      id: uid(),
      createdAt: Date.now(),
      kind: e.kind === 'goal' ? 'goal' : 'life',
      name: String(e.name).slice(0, 60),
      start: e.start,
      end: e.end,
      color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : COLORS[items.length % COLORS.length],
    });
    have.add(String(e.name).trim().toLowerCase());
    added++;
  }
  return added;
}

function openSyncSheet() {
  $('s-repo').value = sync.repo || DEFAULT_REPO;
  $('s-token').value = sync.token || '';
  $('sync-off').hidden = !syncOn();
  $('s-hint').textContent = 'The token is stored only in this app on this phone.';
  syncDialog.showModal();
}

$('sync-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const repo = $('s-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  const token = $('s-token').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return ($('s-hint').textContent = 'Repository should look like owner/repo.');
  if (!token) return ($('s-hint').textContent = 'Paste your GitHub token.');
  const wasOn = syncOn() && sync.repo === repo;
  const previous = sync;
  sync = { ...sync, repo, token, off: false };
  $('sync-save').disabled = true;
  $('s-hint').textContent = 'Connecting…';
  try {
    const { text } = await readRemote();
    let added = 0;
    if (!wasOn && text) {
      added = importRemote(text);
      if (added) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch {
          /* in memory */
        }
      }
    }
    sync.dirty = true;
    saveSync();
    syncDialog.close();
    route();
    await runSync();
    if (added) $('sync-text').textContent += ` · added ${added} from GitHub`;
  } catch (err) {
    sync = previous; // keep the old settings until a working token is saved
    $('s-hint').textContent = `Couldn't connect: ${err.message}.`;
  } finally {
    $('sync-save').disabled = false;
  }
});
$('sync-off').addEventListener('click', () => {
  sync = { repo: sync.repo, off: true };
  saveSync();
  syncDialog.close();
  showSyncStatus();
});
$('sync-cancel').addEventListener('click', () => syncDialog.close());
syncDialog.addEventListener('click', (e) => {
  if (e.target === syncDialog) syncDialog.close();
});
$('sync-btn').addEventListener('click', openSyncSheet);
$('sync-retry').addEventListener('click', () => {
  sync.dirty = true;
  runSync();
});
window.addEventListener('online', () => runSync());
// Leaving the app: push anything unsynced now. Coming back: retry what's pending.
document.addEventListener('visibilitychange', () => runSync());
window.addEventListener('pagehide', () => runSync());

/* ---------- Home-screen widget (Scriptable) ---------- */

const widgetDialog = $('widget-dialog');

let widgetScript = '';
function loadWidgetScript() {
  if (widgetScript) return;
  fetch('widget/loader.js')
    .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
    .then((text) => {
      widgetScript = text;
      $('copy-script').textContent = 'Copy widget loader';
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
  $('widget-param').textContent = item.name;
  $('sync-step-on').hidden = !syncOn();
  $('sync-step-off').hidden = syncOn();
  loadWidgetScript();
  widgetDialog.showModal();
});
$('copy-param').addEventListener('click', (e) => copyText($('widget-param').textContent, e.currentTarget));
$('copy-script').addEventListener('click', (e) => {
  // Copy synchronously inside the tap — iOS rejects clipboard writes after an await.
  if (widgetScript) copyText(widgetScript, e.currentTarget);
  else e.currentTarget.textContent = 'Loading… tap again';
});
$('open-sync').addEventListener('click', () => {
  widgetDialog.close();
  openSyncSheet();
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
runSync(); // push anything changed while offline (or first time with a Dots token)

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
