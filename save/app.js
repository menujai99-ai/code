'use strict';

/* =========================================================
 * Stash — save money toward goals, one coin at a time.
 * Every number on screen (saved, XP, level, badges, streak)
 * is derived from the stored goals + transactions, so editing
 * or deleting history always leaves everything consistent.
 *
 * Rewards scale with the size of the intention: bigger goals
 * give more XP per amount saved, bigger milestone bonuses and
 * a bigger treat budget when you reach them.
 * ========================================================= */

const STORAGE_KEY = 'stash.v1';
/** Coin metals: gold, emerald, sapphire, ruby, amethyst, copper, jade, silver. */
const COLORS = ['#c9971c', '#12805c', '#2a62c9', '#c2364a', '#8a55d6', '#c0682b', '#0f8a85', '#7b8494'];
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'NZD', 'SGD', 'MYR', 'PHP', 'IDR', 'THB', 'VND', 'JPY', 'KRW', 'CNY', 'HKD', 'AED', 'ZAR', 'NGN', 'KES', 'BRL', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'TRY'];
const REGION_CURRENCY = {
  US: 'USD', GB: 'GBP', IN: 'INR', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', MY: 'MYR', PH: 'PHP', ID: 'IDR', TH: 'THB',
  VN: 'VND', JP: 'JPY', KR: 'KRW', CN: 'CNY', HK: 'HKD', AE: 'AED', ZA: 'ZAR', NG: 'NGN', KE: 'KES', BR: 'BRL', MX: 'MXN',
  CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', TR: 'TRY', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR',
  IE: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR',
};
/** Default "a big goal starts at" per currency (roughly 1000 USD-ish of effort). */
const BIG_DEFAULT = { JPY: 100000, KRW: 1000000, INR: 50000, IDR: 10000000, VND: 20000000, PHP: 50000, THB: 30000, NGN: 500000, KES: 100000 };

/* ---------- Date helpers (local time) ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
const fmtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtNum = new Intl.NumberFormat();

function plural(n, word) {
  return `${fmtNum.format(n)} ${word}${n === 1 ? '' : 's'}`;
}
function formatSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/* ---------- Storage ---------- */

function guessCurrency() {
  const region = (navigator.language || '').split('-')[1];
  return REGION_CURRENCY[(region || '').toUpperCase()] || 'USD';
}
function freshState() {
  const currency = guessCurrency();
  return { settings: { currency, big: BIG_DEFAULT[currency] || 1000 }, goals: [], tx: [], wants: [] };
}
function cleanState(raw) {
  const s = freshState();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.settings) {
    if (CURRENCIES.includes(raw.settings.currency)) s.settings.currency = raw.settings.currency;
    if (raw.settings.big > 0) s.settings.big = Number(raw.settings.big);
  }
  const arr = (a) => (Array.isArray(a) ? a : []);
  s.goals = arr(raw.goals).filter((g) => g && g.id && g.name && g.target > 0);
  const ids = new Set(s.goals.map((g) => g.id));
  s.tx = arr(raw.tx).filter((t) => t && t.id && ids.has(t.goalId) && t.amount > 0 && ['add', 'skip', 'take'].includes(t.kind));
  s.wants = arr(raw.wants).filter((w) => w && w.id && w.name && w.price > 0 && w.added > 0);
  if (ids.has(raw.lastGoal)) s.lastGoal = raw.lastGoal;
  return s;
}
function loadState() {
  try {
    return cleanState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return freshState();
  }
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode) — keep working in memory */
  }
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let state = loadState();

/* ---------- Money ---------- */

let fmtMoney;
let fmtMoney0;
function setupMoney() {
  const c = state.settings.currency;
  fmtMoney = new Intl.NumberFormat(undefined, { style: 'currency', currency: c });
  fmtMoney0 = new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 0 });
}
function money(n) {
  return Math.abs(n - Math.round(n)) < 0.005 ? fmtMoney0.format(Math.round(n)) : fmtMoney.format(n);
}
/** Round to 1, 2 or 5 × a power of ten — friendly amounts in any currency. */
function niceRound(x) {
  if (x <= 1) return 1;
  const m = 10 ** Math.floor(Math.log10(x));
  const f = x / m;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * m;
}
/** Points scale: with "big = 1000", 1 unit of money = 1 point. */
function unit() {
  return state.settings.big / 1000;
}

/* ---------- Rewards: tiers, XP, levels, badges ---------- */

function tiers() {
  const big = state.settings.big;
  return [
    { key: 'small', icon: '🌱', name: 'Small step', min: 0, mult: 1, treat: 0.02 },
    { key: 'solid', icon: '🌿', name: 'Solid goal', min: big / 4, mult: 1.5, treat: 0.03 },
    { key: 'big', icon: '🌳', name: 'Big intention', min: big, mult: 2, treat: 0.04 },
    { key: 'huge', icon: '🏔️', name: 'Huge intention', min: big * 5, mult: 3, treat: 0.05 },
  ];
}
function tierOf(target) {
  const t = tiers();
  for (let i = t.length - 1; i >= 0; i--) if (target >= t[i].min) return t[i];
  return t[0];
}
/** Bonus for 25 / 50 / 75 %; reaching 100 % pays double. Grows with target AND tier. */
function milestoneXP(goal, quarter) {
  const base = Math.round((goal.target / unit()) * 0.05 * tierOf(goal.target).mult);
  return quarter === 4 ? base * 2 : base;
}
const WAIT_BONUS = 1.5;
function txXP(t, goal) {
  const pts = (t.amount / unit()) * tierOf(goal.target).mult * (t.kind === 'skip' && t.waited ? WAIT_BONUS : 1) / 10;
  return t.kind === 'take' ? -pts : pts;
}

function xpForLevel(l) {
  return 25 * l * (l - 1);
}
function levelOf(xp) {
  let l = 1;
  while (xpForLevel(l + 1) <= xp) l++;
  return l;
}
const TITLES = [
  [1, 'Seedling Saver'], [3, 'Coin Collector'], [5, 'Penny Pro'], [8, 'Stash Builder'],
  [12, 'Vault Keeper'], [17, 'Money Monk'], [23, 'Wealth Wizard'], [30, 'Legend of Thrift'],
];
function titleOf(level) {
  let t = TITLES[0][1];
  for (const [l, name] of TITLES) if (level >= l) t = name;
  return t;
}

const BADGES = [
  { id: 'first', icon: '💰', name: 'First save', desc: 'Save anything', xp: 10, test: (c) => c.deposits >= 1 },
  { id: 'skip1', icon: '✋', name: 'Resisted', desc: 'Skip a purchase', xp: 10, test: (c) => c.skips >= 1 },
  { id: 'waited', icon: '⏳', name: 'Patient', desc: 'Wait out a want, then skip it', xp: 25, test: (c) => c.waitedSkips >= 1 },
  { id: 'dream', icon: '🎯', name: 'Dream big', desc: 'Set a Big goal', xp: 25, test: (c) => c.maxTier >= 2 },
  { id: 'streak7', icon: '🔥', name: 'On fire', desc: '7-day saving streak', xp: 50, test: (c) => c.bestStreak >= 7 },
  { id: 'half', icon: '🌓', name: 'Halfway', desc: 'Reach 50% of a goal', xp: 25, test: (c) => c.bestPct >= 0.5 },
  { id: 'done', icon: '🏆', name: 'Goal reached', desc: 'Complete a goal', xp: 50, test: (c) => c.completed >= 1 },
  { id: 'skip10', icon: '🛡️', name: 'Iron will', desc: 'Skip 10 purchases', xp: 75, test: (c) => c.skips >= 10 },
  { id: 'stacked', icon: '💎', name: 'Stacked', desc: 'Save a “big” amount in total', xp: 100, test: (c) => c.total >= state.settings.big },
  { id: 'bigdone', icon: '🌳', name: 'Big finisher', desc: 'Complete a Big goal', xp: 150, test: (c) => c.completedTier >= 2 },
  { id: 'streak30', icon: '☄️', name: 'Unstoppable', desc: '30-day saving streak', xp: 200, test: (c) => c.bestStreak >= 30 },
  { id: 'summit', icon: '🏔️', name: 'Summit', desc: 'Complete a Huge goal', xp: 400, test: (c) => c.completedTier >= 3 },
];

function savedFor(goalId) {
  let s = 0;
  for (const t of state.tx) if (t.goalId === goalId) s += t.kind === 'take' ? -t.amount : t.amount;
  return Math.max(0, s);
}

/** Days (local ISO) with money put away, and the current / best runs of consecutive days. */
function streaks(now = new Date()) {
  const days = new Set(state.tx.filter((t) => t.kind !== 'take').map((t) => toISODate(new Date(t.at))));
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev && daysBetween(parseISODate(prev), parseISODate(d)) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  let cur = 0;
  let day = startOfDay(now);
  if (!days.has(toISODate(day))) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  while (days.has(toISODate(day))) {
    cur++;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  }
  return { cur, best, today: days.has(toISODate(now)) };
}

/** Everything reward-related, derived from scratch. */
function computeRewards() {
  const goalById = new Map(state.goals.map((g) => [g.id, g]));
  const tierIdx = (g) => tiers().findIndex((t) => t.key === tierOf(g.target).key);
  const c = { deposits: 0, skips: 0, waitedSkips: 0, skipped: 0, total: 0, maxTier: -1, bestPct: 0, completed: 0, completedTier: -1 };
  let xp = 0;
  for (const t of state.tx) {
    const g = goalById.get(t.goalId);
    xp += txXP(t, g);
    if (t.kind === 'add') c.deposits++;
    if (t.kind === 'skip') {
      c.deposits++;
      c.skips++;
      c.skipped += t.amount;
      if (t.waited) c.waitedSkips++;
    }
  }
  const milestones = new Set();
  for (const g of state.goals) {
    const saved = savedFor(g.id);
    const pct = saved / g.target;
    c.total += saved;
    c.maxTier = Math.max(c.maxTier, tierIdx(g));
    c.bestPct = Math.max(c.bestPct, pct);
    const q = Math.min(4, Math.floor(pct * 4 + 1e-9));
    for (let i = 1; i <= q; i++) {
      milestones.add(`${g.id}:${i}`);
      xp += milestoneXP(g, i);
    }
    if (q === 4) {
      c.completed++;
      c.completedTier = Math.max(c.completedTier, tierIdx(g));
    }
  }
  const st = streaks();
  c.bestStreak = st.best;
  const badges = new Set();
  for (const b of BADGES) {
    if (b.test(c)) {
      badges.add(b.id);
      xp += b.xp;
    }
  }
  xp = Math.max(0, Math.round(xp));
  const level = levelOf(xp);
  return { xp, level, badges, milestones, counts: c, streak: st };
}

/* ---------- Goal status ---------- */

function goalStatus(g, now = new Date()) {
  const saved = savedFor(g.id);
  const left = Math.max(0, g.target - saved);
  const pct = Math.min(1, saved / g.target);
  const st = { saved, left, pct, done: saved >= g.target };

  const created = startOfDay(new Date(g.created));
  if (g.deadline) {
    const end = parseISODate(g.deadline);
    st.daysLeft = daysBetween(now, end);
    if (!st.done && st.daysLeft > 0) {
      st.perDay = left / st.daysLeft;
      st.perWeek = st.perDay * 7;
    }
    const total = Math.max(1, daysBetween(created, end));
    const elapsed = Math.min(total, Math.max(0, daysBetween(created, now) + 1));
    st.expected = (g.target * elapsed) / total;
  } else {
    const weeks = Math.max(1, (startOfDay(now) - created) / DAY_MS / 7);
    st.avgWeek = saved / weeks;
    if (!st.done && saved > 0) {
      st.eta = new Date(startOfDay(now).getTime() + (left / st.avgWeek) * 7 * DAY_MS);
    }
  }
  return st;
}

/** Short pace line for cards and the detail view. */
function paceLine(g, st) {
  if (st.done) return `Reached ${money(g.target)} 🎉`;
  if (g.deadline) {
    if (st.daysLeft < 0) return `Target date passed · ${money(st.left)} to go`;
    if (st.daysLeft === 0) return `Due today · ${money(st.left)} to go`;
    return st.daysLeft < 14
      ? `${money(st.perDay)}/day for ${plural(st.daysLeft, 'day')}`
      : `${money(st.perWeek)}/week until ${fmtShort.format(parseISODate(g.deadline))}`;
  }
  return `${money(st.left)} to go`;
}

/* ---------- DOM refs ---------- */

const $ = (id) => document.getElementById(id);
const listView = $('list-view');
const detailView = $('detail-view');

let openId = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------- Home ---------- */

function renderHome() {
  const r = computeRewards();
  $('level-badge').textContent = r.level;
  $('level-title').textContent = titleOf(r.level);
  const lo = xpForLevel(r.level);
  const hi = xpForLevel(r.level + 1);
  $('level-next').textContent = `${fmtNum.format(r.xp - lo)} / ${fmtNum.format(hi - lo)} XP to level ${r.level + 1}`;
  $('xp-fill').style.width = `${(((r.xp - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  $('stat-saved').textContent = money(r.counts.total);
  $('stat-streak').textContent = `${r.streak.cur} ${r.streak.cur === 1 ? 'day' : 'days'}${r.streak.cur && !r.streak.today ? ' ⏳' : r.streak.cur ? ' 🔥' : ''}`;
  $('stat-streak').title = r.streak.cur && !r.streak.today ? 'Save something today to keep the streak' : '';
  $('stat-skipped').textContent = money(r.counts.skipped);

  // Goals
  const list = $('goal-list');
  list.textContent = '';
  $('empty-state').hidden = state.goals.length > 0;
  const goals = [...state.goals].sort((a, b) => goalStatus(a).done - goalStatus(b).done || (a.deadline || '9').localeCompare(b.deadline || '9'));
  for (const g of goals) {
    const st = goalStatus(g);
    const tier = tierOf(g.target);
    const li = el('li');
    const btn = el('button', 'task-card');
    btn.style.setProperty('--c', g.color);
    btn.addEventListener('click', () => (location.hash = `#/g/${g.id}`));
    const head = el('div', 'card-head');
    const name = el('span', 'card-name truncate');
    name.append(el('span', 'card-tag', `${tier.icon} ×${tier.mult}`), g.name);
    const left = el('span', 'card-left', `${Math.floor(st.pct * 100)}%`);
    head.append(name, left);
    const sub = el('div', 'card-sub', `${money(st.saved)} of ${money(g.target)} · ${paceLine(g, st)}`);
    const body = el('div', 'card-body');
    body.append(head, sub);
    const mini = el('div', 'mini-jar');
    mini.innerHTML = jarSVG(st.pct, { mini: true });
    btn.classList.add('with-jar');
    btn.append(mini, body);
    li.append(btn);
    list.append(li);
  }

  renderWants();

  // Badges
  const box = $('badges');
  box.textContent = '';
  for (const b of BADGES) {
    const got = r.badges.has(b.id);
    const d = el('div', `badge${got ? '' : ' locked'}`);
    d.append(el('span', 'b-icon', b.icon), el('b', null, b.name), el('small', null, got ? `+${b.xp} XP` : b.desc));
    box.append(d);
  }
}

function renderWants(now = Date.now()) {
  const list = $('want-list');
  list.textContent = '';
  const wants = [...state.wants].sort((a, b) => a.added + a.hours * HOUR_MS - (b.added + b.hours * HOUR_MS));
  for (const w of wants) {
    const end = w.added + w.hours * HOUR_MS;
    const ready = now >= end;
    const li = el('li', 'want');
    li.dataset.id = w.id;
    const head = el('div', 'want-head');
    head.append(el('b', null, w.name), el('span', 'mono', money(w.price)));
    const timer = el('div', `want-timer${ready ? ' ready' : ''}`);
    timer.dataset.end = end;
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-fill');
    bar.append(fill);
    const acts = el('div', 'want-actions');
    const skip = el('button', 'btn small primary', ready ? `Skip it → save ${money(w.price)}` : 'Skip it now');
    skip.addEventListener('click', () => openMoney({ kind: 'skip', amount: w.price, note: w.name, waited: Date.now() >= end, wantId: w.id }));
    acts.append(skip);
    if (ready) {
      const bought = el('button', 'btn small', 'I bought it');
      bought.addEventListener('click', () => {
        if (!confirm(`Bought “${w.name}”? That's fine — you waited and decided. It comes off the list.`)) return;
        state.wants = state.wants.filter((x) => x.id !== w.id);
        saveState();
        renderHome();
      });
      acts.append(bought);
    } else {
      const rm = el('button', 'btn small', 'Remove');
      rm.addEventListener('click', () => {
        state.wants = state.wants.filter((x) => x.id !== w.id);
        saveState();
        renderHome();
      });
      acts.append(rm);
    }
    li.append(head, timer, bar, acts);
    list.append(li);
  }
  updateWantTimers(now);
}

function updateWantTimers(now = Date.now()) {
  let flipped = false;
  for (const li of document.querySelectorAll('#want-list .want')) {
    const w = state.wants.find((x) => x.id === li.dataset.id);
    if (!w) continue;
    const end = w.added + w.hours * HOUR_MS;
    const timer = li.querySelector('.want-timer');
    const ready = now >= end;
    if (ready !== timer.classList.contains('ready')) flipped = true;
    timer.textContent = ready
      ? 'Cool-off over. Still want it?'
      : `Wait ${formatSpan(end - now)} · skipping after the wait earns ×${WAIT_BONUS} XP`;
    li.querySelector('.progress-fill').style.width = `${Math.min(100, ((now - w.added) / (end - w.added)) * 100).toFixed(2)}%`;
  }
  if (flipped) renderWants(now);
}

/* ---------- Goal detail ---------- */

function renderDetail(now = new Date()) {
  const g = state.goals.find((x) => x.id === openId);
  if (!g) return;
  const st = goalStatus(g, now);
  const tier = tierOf(g.target);
  const r = computeRewards();

  $('detail-title').textContent = g.name;
  detailView.style.setProperty('--c', g.color);
  $('big-num').textContent = money(st.saved);
  $('big-label').textContent = `of ${money(g.target)}`;
  $('sub-line').textContent = `${Math.floor(st.pct * 100)}% saved`;
  $('progress-fill').style.width = `${(st.pct * 100).toFixed(2)}%`;

  const track = $('track');
  track.className = 'track';
  if (st.done) {
    $('pace-label').textContent = 'Status';
    $('pace-value').textContent = 'Done 🎉';
    $('left-label').textContent = 'Saved';
    $('left-value').textContent = money(st.saved);
    track.textContent = '';
  } else if (g.deadline) {
    const short = st.daysLeft >= 0 && st.daysLeft < 14;
    $('pace-label').textContent = short ? 'Save per day' : 'Save per week';
    $('pace-value').textContent = st.daysLeft > 0 ? money(short ? st.perDay : st.perWeek) : money(st.left);
    $('left-label').textContent = 'Days left';
    $('left-value').textContent = st.daysLeft >= 0 ? fmtNum.format(st.daysLeft) : 'Overdue';
    const diff = st.saved - st.expected;
    if (diff >= -0.005) {
      track.classList.add('good');
      track.textContent = diff >= 1 ? `On track ✓ · ${money(diff)} ahead of schedule` : 'On track ✓';
    } else {
      track.classList.add('behind');
      track.textContent = `Behind by ${money(-diff)} — add it this week to catch up`;
    }
  } else {
    $('pace-label').textContent = 'Avg per week';
    $('pace-value').textContent = money(st.avgWeek);
    $('left-label').textContent = 'To go';
    $('left-value').textContent = money(st.left);
    track.textContent = st.eta ? `At this pace you'll get there around ${fmtDate.format(st.eta)}` : 'Add a target date to get a weekly pace.';
  }

  // Rewards
  $('tier-icon').textContent = tier.icon;
  $('tier-name').textContent = `${tier.name} · ×${tier.mult} XP`;
  const next = tiers().find((t) => t.min > g.target);
  $('tier-desc').textContent = next
    ? `Aim for ${money(next.min)} to make it a ${next.name} (×${next.mult} XP, bigger treat).`
    : 'Top tier — the biggest rewards in the app.';
  const budget = niceRound(g.target * tier.treat);
  const treat = $('treat');
  const what = g.treat ? `“${g.treat}”` : 'a treat of your choice';
  treat.className = `treat${st.done ? ' won' : ''}`;
  treat.textContent = st.done
    ? `🎁 You earned it: ${what} — guilt-free budget ${money(budget)}.`
    : `🎁 Reward at 100%: ${what} · treat budget ${money(budget)} (${Math.round(tier.treat * 100)}% of the goal — bigger goals earn a bigger share).`;
  const ms = $('milestones');
  ms.textContent = '';
  for (let q = 1; q <= 4; q++) {
    const li = el('li', r.milestones.has(`${g.id}:${q}`) ? 'hit' : '');
    li.append(el('b', null, `${q * 25}%`), `+${fmtNum.format(milestoneXP(g, q))} XP`);
    ms.append(li);
  }

  renderJar(g, st);

  // History
  const hist = $('history');
  hist.textContent = '';
  const txs = state.tx.filter((t) => t.goalId === g.id).sort((a, b) => b.at - a.at);
  if (!txs.length) hist.append(el('li', 'empty-row', 'Nothing yet — add your first amount.'));
  for (const t of txs) {
    const li = el('li');
    const text = el('div', 'h-text');
    const label = t.kind === 'skip' ? `Skipped${t.note ? `: ${t.note}` : ''}${t.waited ? ' ⏳' : ''}` : t.note || (t.kind === 'take' ? 'Took out' : 'Saved');
    const xp = Math.round(txXP(t, g));
    text.append(el('span', null, label), el('small', null, `${fmtDate.format(new Date(t.at))} · ${xp >= 0 ? '+' : ''}${xp} XP`));
    const amt = el('span', `h-amt mono${t.kind === 'take' ? ' neg' : ''}`, `${t.kind === 'take' ? '−' : '+'}${money(t.amount)}`);
    const del = el('button', 'h-del', '×');
    del.setAttribute('aria-label', 'Delete entry');
    del.addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      state.tx = state.tx.filter((x) => x.id !== t.id);
      saveState();
      renderDetail();
    });
    li.append(text, amt, del);
    hist.append(li);
  }
}

/* ---------- The jar ---------- */

/* Glass jar in a 200 × 260 box. The liquid runs from the bottom (JAR_BOTTOM)
 * up to the shoulder (JAR_TOP) at 100%. */
const JAR_PATH = 'M62 34 H138 V46 C138 54 146 58 154 64 C172 78 180 96 180 120 V226 C180 244 168 254 150 254 H50 C32 254 20 244 20 226 V120 C20 96 28 78 46 64 C54 58 62 54 62 46 Z';
const JAR_TOP = 72;
const JAR_BOTTOM = 254;
const WAVE = 'M0 0 Q25 -7 50 0 T100 0 T150 0 T200 0 T250 0 T300 0 T350 0 T400 0 V300 H0 Z';
let jarSeq = 0;

function levelY(pct) {
  // Leave a sliver of liquid at 0% so the jar never looks broken, and let 100% brim over the shoulder.
  return JAR_BOTTOM - Math.max(0.025, Math.min(1, pct)) * (JAR_BOTTOM - JAR_TOP) - (pct >= 1 ? 8 : 0);
}

/** The jar as an SVG string. Colour comes from --c on a parent. */
function jarSVG(pct, { mini = false } = {}) {
  const id = `jar${++jarSeq}`;
  const ticks = mini
    ? ''
    : [0.25, 0.5, 0.75]
        .map((q) => {
          const y = levelY(q);
          return `<line class="jar-tick" x1="150" x2="172" y1="${y}" y2="${y}"/>`;
        })
        .join('');
  const label = mini ? '' : `<text class="jar-pct" x="100" y="176" text-anchor="middle">${Math.floor(pct * 100)}%</text>`;
  return `<svg class="jar${mini ? ' mini' : ''}" viewBox="0 0 200 262" aria-hidden="true">
  <defs>
    <clipPath id="${id}-clip"><path d="${JAR_PATH}"/></clipPath>
    <linearGradient id="${id}-liquid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="liq-top"/><stop offset="1" class="liq-bottom"/>
    </linearGradient>
  </defs>
  <path class="jar-glass" d="${JAR_PATH}"/>
  <g clip-path="url(#${id}-clip)">
    <g class="jar-level" style="transform: translateY(${levelY(pct)}px)">
      <g class="wave back"><path d="${WAVE}" transform="translate(-50 -6)"/></g>
      <g class="wave front"><path d="${WAVE}" fill="url(#${id}-liquid)"/></g>
      <circle class="bubble b1" cx="60" cy="60" r="4"/><circle class="bubble b2" cx="120" cy="90" r="3"/><circle class="bubble b3" cx="95" cy="40" r="2.5"/>
    </g>
    ${ticks}
  </g>
  <path class="jar-rim" d="${JAR_PATH}"/>
  <path class="jar-shine" d="M38 118 C38 98 44 86 56 76"/>
  <path class="jar-shine thin" d="M36 140 V200"/>
  <rect class="jar-lid" x="54" y="12" width="92" height="24" rx="7"/>
  <line class="jar-lid-line" x1="58" x2="142" y1="24" y2="24"/>
  ${label}
  <circle class="jar-coin" cx="100" cy="-20" r="13"/>
</svg>`;
}

/** Level drawn last time per goal, so the liquid can rise and a coin can drop in. */
const lastPct = new Map();

function renderJar(g, st) {
  const box = $('jar-box');
  const prev = lastPct.has(g.id) ? lastPct.get(g.id) : st.pct;
  lastPct.set(g.id, st.pct);
  box.innerHTML = jarSVG(prev);
  box.setAttribute('aria-label', `Jar ${Math.floor(st.pct * 100)}% full: ${money(st.saved)} of ${money(g.target)}`);
  const svg = box.querySelector('svg');
  const level = svg.querySelector('.jar-level');
  const pctText = svg.querySelector('.jar-pct');
  if (st.pct !== prev) {
    // Let the browser paint the old level first, then animate to the new one.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        level.style.transform = `translateY(${levelY(st.pct)}px)`;
        pctText.textContent = `${Math.floor(st.pct * 100)}%`;
        if (st.pct > prev) {
          const coin = svg.querySelector('.jar-coin');
          coin.style.setProperty('--fall', `${levelY(st.pct) + 22}px`);
          coin.classList.add('falling');
        }
      })
    );
  }

  // What the next milestone needs.
  const next = [0.25, 0.5, 0.75, 1].find((q) => st.saved < g.target * q - 1e-9);
  $('jar-next').textContent = next
    ? `${money(g.target * next - st.saved)} to the ${next * 100}% mark (+${fmtNum.format(milestoneXP(g, next * 4))} XP)`
    : 'Full jar — goal reached! 🎉';
}

/* ---------- Routing ---------- */

function route() {
  const m = location.hash.match(/^#\/g\/(.+)$/);
  const g = m && state.goals.find((x) => x.id === m[1]);
  if (g) {
    openId = g.id;
    listView.hidden = true;
    detailView.hidden = false;
    window.scrollTo(0, 0);
    renderDetail();
  } else {
    openId = null;
    detailView.hidden = true;
    listView.hidden = false;
    renderHome();
  }
}
function rerender() {
  if (openId) renderDetail();
  else renderHome();
}
window.addEventListener('hashchange', route);
$('back-btn').addEventListener('click', () => {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = '';
});

/* ---------- Sheets: shared ---------- */

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}

/** Wrap a state change: anything newly earned gets celebrated. */
function withRewards(change) {
  const before = computeRewards();
  change();
  saveState();
  const after = computeRewards();
  rerender();
  celebrate(before, after);
}

/* ---------- Goal sheet ---------- */

const goalDialog = $('goal-dialog');
const goalForm = $('goal-form');
let editingGoal = null;

for (const [i, c] of COLORS.entries()) {
  const label = el('label');
  label.style.setProperty('--c', c);
  const input = el('input');
  input.type = 'radio';
  input.name = 'color';
  input.value = c;
  input.setAttribute('aria-label', ['Gold', 'Emerald', 'Sapphire', 'Ruby', 'Amethyst', 'Copper', 'Jade', 'Silver'][i] || `Coin ${i + 1}`);
  label.append(input, el('span'));
  $('g-colors').append(label);
}

function updateGoalForm() {
  const target = parseFloat($('g-target').value);
  const prev = $('g-tier');
  if (!(target > 0)) {
    prev.textContent = '';
    return;
  }
  const tier = tierOf(target);
  const next = tiers().find((t) => t.min > target);
  const budget = niceRound(target * tier.treat);
  prev.textContent = `${tier.icon} ${tier.name}: ×${tier.mult} XP on every save, +${fmtNum.format(milestoneXP({ target }, 1))} XP per 25% milestone, ${money(budget)} treat budget.` +
    (next ? ` Go to ${money(next.min)} for ${next.icon} ×${next.mult}.` : '');
  const d = $('g-date').value;
  const hint = $('g-hint');
  hint.textContent = '';
  if (d) {
    const days = daysBetween(new Date(), parseISODate(d));
    const saved = editingGoal ? savedFor(editingGoal) : 0;
    if (days > 0) hint.textContent = `That's about ${money(((target - saved) / days) * 7)} a week (${money((target - saved) / days)} a day).`;
    else hint.textContent = 'Pick a date in the future.';
  }
}
goalForm.addEventListener('input', updateGoalForm);

function openGoal(g) {
  editingGoal = g ? g.id : null;
  $('goal-title').textContent = g ? 'Edit goal' : 'New goal';
  $('goal-delete').hidden = !g;
  $('g-name').value = g ? g.name : '';
  $('g-target').value = g ? g.target : '';
  $('g-date').value = g ? g.deadline || '' : '';
  $('g-date').min = toISODate(new Date());
  $('g-treat').value = g ? g.treat || '' : '';
  const color = g ? g.color : COLORS[state.goals.length % COLORS.length];
  for (const r of goalForm.elements.color) r.checked = r.value === color;
  updateGoalForm();
  goalDialog.showModal();
}

goalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('g-name').value.trim();
  const target = Math.round(parseFloat($('g-target').value) * 100) / 100;
  const hint = $('g-hint');
  if (!name) return void (hint.textContent = 'Give your goal a name.');
  if (!(target > 0)) return void (hint.textContent = 'Enter a target amount.');
  const deadline = $('g-date').value || null;
  if (deadline && daysBetween(new Date(), parseISODate(deadline)) < 0) return void (hint.textContent = 'Pick a date in the future.');
  const data = { name, target, deadline, treat: $('g-treat').value.trim(), color: goalForm.elements.color.value || COLORS[0] };
  let id = editingGoal;
  withRewards(() => {
    if (id) Object.assign(state.goals.find((g) => g.id === id), data);
    else {
      id = uid();
      state.goals.push({ id, created: Date.now(), ...data });
    }
  });
  goalDialog.close();
  if (location.hash !== `#/g/${id}`) location.hash = `#/g/${id}`;
});

$('goal-delete').addEventListener('click', () => {
  const g = state.goals.find((x) => x.id === editingGoal);
  if (!g || !confirm(`Delete “${g.name}” and its history?`)) return;
  state.goals = state.goals.filter((x) => x.id !== g.id);
  state.tx = state.tx.filter((t) => t.goalId !== g.id);
  saveState();
  goalDialog.close();
  location.hash = '';
  route();
});

$('add-btn').addEventListener('click', () => openGoal(null));
$('empty-add-btn').addEventListener('click', () => openGoal(null));
$('edit-btn').addEventListener('click', () => openGoal(state.goals.find((g) => g.id === openId)));

/* ---------- Money sheet ---------- */

const moneyDialog = $('money-dialog');
const moneyForm = $('money-form');
let moneyCtx = {};

function moneyKind() {
  return moneyForm.elements.kind.value;
}

function updateMoneyForm() {
  const kind = moneyKind();
  $('money-title').textContent = kind === 'take' ? 'Take money out' : kind === 'skip' ? 'I skipped a buy' : 'Add money';
  $('m-note-label').textContent = kind === 'skip' ? 'What did you skip?' : 'Note';
  $('m-note').placeholder = kind === 'skip' ? 'e.g. Takeaway coffee' : 'optional';

  const g = state.goals.find((x) => x.id === $('m-goal').value);
  const amount = parseFloat($('m-amount').value);
  const chips = $('m-chips');
  chips.textContent = '';
  if (g && kind !== 'take') {
    const st = goalStatus(g);
    const options = new Set([5, 10, 20, 50, 100].map((x) => niceRound(x * unit())));
    if (st.perWeek) options.add(Math.ceil(st.perWeek));
    if (st.left > 0 && st.left <= 1000 * unit()) options.add(Math.ceil(st.left * 100) / 100);
    for (const v of [...options].sort((a, b) => a - b)) {
      const b = el('button', null, v === Math.ceil(st.perWeek) ? `${money(v)} · weekly pace` : v === Math.ceil(st.left * 100) / 100 ? `${money(v)} · finish it` : money(v));
      b.type = 'button';
      b.addEventListener('click', () => {
        $('m-amount').value = v;
        updateMoneyForm();
      });
      chips.append(b);
    }
  }
  const hint = $('m-hint');
  hint.textContent = '';
  if (g && amount > 0) {
    if (kind === 'take') {
      const saved = savedFor(g.id);
      hint.textContent = amount > saved + 1e-9 ? `Only ${money(saved)} saved in this goal.` : `−${Math.round(txXP({ kind, amount }, g) * -1)} XP. It's okay — life happens.`;
    } else {
      const xp = Math.round(txXP({ kind, amount, waited: moneyCtx.waited }, g));
      const tier = tierOf(g.target);
      hint.textContent = `+${xp} XP (${tier.icon} ×${tier.mult}${kind === 'skip' && moneyCtx.waited ? `, ⏳ ×${WAIT_BONUS} for waiting` : ''})`;
    }
  }
}
moneyForm.addEventListener('input', updateMoneyForm);
moneyForm.addEventListener('change', updateMoneyForm);

function openMoney(ctx = {}) {
  if (!state.goals.length) {
    alert('Create a goal first, so your money has somewhere to go.');
    openGoal(null);
    return;
  }
  moneyCtx = ctx;
  const sel = $('m-goal');
  sel.textContent = '';
  const goals = [...state.goals].sort((a, b) => goalStatus(a).done - goalStatus(b).done);
  for (const g of goals) {
    const o = el('option', null, `${tierOf(g.target).icon} ${g.name}`);
    o.value = g.id;
    sel.append(o);
  }
  sel.value = ctx.goalId || openId || state.lastGoal || goals[0].id;
  if (!sel.value) sel.value = goals[0].id;
  moneyForm.elements.kind.value = ctx.kind || 'add';
  $('m-amount').value = ctx.amount || '';
  $('m-note').value = ctx.note || '';
  updateMoneyForm();
  moneyDialog.showModal();
  if (!ctx.amount) $('m-amount').focus();
}

moneyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const kind = moneyKind();
  const amount = Math.round(parseFloat($('m-amount').value) * 100) / 100;
  const goalId = $('m-goal').value;
  if (!(amount > 0)) return void ($('m-hint').textContent = 'Enter an amount.');
  if (kind === 'take' && amount > savedFor(goalId) + 1e-9) return void ($('m-hint').textContent = `Only ${money(savedFor(goalId))} saved in this goal.`);
  const { wantId, waited } = moneyCtx;
  withRewards(() => {
    state.tx.push({ id: uid(), goalId, kind, amount, note: $('m-note').value.trim(), at: Date.now(), waited: kind === 'skip' && !!waited });
    state.lastGoal = goalId;
    if (wantId && kind === 'skip') state.wants = state.wants.filter((w) => w.id !== wantId);
  });
  moneyDialog.close();
});

$('quick-add').addEventListener('click', () => openMoney({ kind: 'add' }));
$('quick-skip').addEventListener('click', () => openMoney({ kind: 'skip' }));
$('detail-add').addEventListener('click', () => openMoney({ kind: 'add', goalId: openId }));
$('detail-take').addEventListener('click', () => openMoney({ kind: 'take', goalId: openId }));

/* ---------- Want sheet ---------- */

const wantDialog = $('want-dialog');
$('want-add').addEventListener('click', () => {
  $('w-name').value = '';
  $('w-price').value = '';
  $('w-hint').textContent = '';
  wantDialog.showModal();
});
$('want-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('w-name').value.trim();
  const price = Math.round(parseFloat($('w-price').value) * 100) / 100;
  if (!name) return void ($('w-hint').textContent = 'What is it?');
  if (!(price > 0)) return void ($('w-hint').textContent = 'Enter the price.');
  state.wants.push({ id: uid(), name, price, hours: Number($('w-hours').value), added: Date.now() });
  saveState();
  wantDialog.close();
  renderHome();
});

/* ---------- Settings ---------- */

const settingsDialog = $('settings-dialog');
for (const c of CURRENCIES) {
  const o = el('option', null, c);
  o.value = c;
  $('s-currency').append(o);
}
$('settings-btn').addEventListener('click', () => {
  $('s-currency').value = state.settings.currency;
  $('s-big').value = state.settings.big;
  settingsDialog.showModal();
});
$('s-currency').addEventListener('change', () => {
  const big = $('s-big');
  if (Number(big.value) === (BIG_DEFAULT[state.settings.currency] || 1000)) big.value = BIG_DEFAULT[$('s-currency').value] || 1000;
});
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const big = parseFloat($('s-big').value);
  state.settings.currency = $('s-currency').value;
  if (big > 0) state.settings.big = big;
  saveState();
  setupMoney();
  settingsDialog.close();
  rerender();
});
$('s-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stash-backup-${toISODate(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('s-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  file.text().then((text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return alert('That file is not a Stash backup.');
    }
    const next = cleanState(data);
    if (!confirm(`Replace everything here with this backup (${plural(next.goals.length, 'goal')}, ${plural(next.tx.length, 'entry')})?`)) return;
    state = next;
    saveState();
    setupMoney();
    settingsDialog.close();
    location.hash = '';
    route();
  });
});

/* ---------- Celebration ---------- */

const partyDialog = $('party-dialog');

function celebrate(before, after) {
  const items = [];
  let big = false;
  let icon = '🎉';
  for (const key of after.milestones) {
    if (before.milestones.has(key)) continue;
    const [id, q] = key.split(':');
    const g = state.goals.find((x) => x.id === id);
    if (!g) continue;
    const xp = milestoneXP(g, Number(q));
    if (q === '4') {
      const tier = tierOf(g.target);
      const budget = niceRound(g.target * tier.treat);
      items.push(`🏆 ${g.name} reached! +${fmtNum.format(xp)} XP`);
      items.push(`🎁 Your reward: ${g.treat ? `“${g.treat}”` : 'a treat of your choice'} — guilt-free budget ${money(budget)}.`);
      icon = tier.icon === '🏔️' ? '🏔️' : '🏆';
      big = true;
    } else {
      items.push(`${tierOf(g.target).icon} ${g.name}: ${Number(q) * 25}% milestone! +${fmtNum.format(xp)} XP`);
    }
  }
  for (const b of BADGES) {
    if (after.badges.has(b.id) && !before.badges.has(b.id)) items.push(`${b.icon} Badge: ${b.name} — +${b.xp} XP`);
  }
  if (after.level > before.level) {
    items.unshift(`⭐ Level ${after.level}: ${titleOf(after.level)}`);
    big = true;
  }
  if (!items.length) return;
  $('party-icon').textContent = icon;
  $('party-title').textContent = big ? 'Huge win!' : 'Nice one!';
  const list = $('party-list');
  list.textContent = '';
  for (const t of items) list.append(el('li', null, t));
  partyDialog.showModal();
  confetti(big ? 220 : 90);
}

function confetti(count) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('confetti');
  try {
    canvas.showPopover();
  } catch {
    /* popover unsupported — canvas still draws under the dialog */
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // A shower of spinning gold coins with a little emerald and cream paper.
  const colors = ['#0f6b4a', '#f3e7c4', '#c9971c'];
  const parts = Array.from({ length: count }, (_, i) => ({
    coin: i % 3 !== 0,
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.45,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 14 - 4,
    r: Math.random() * 6 + 4,
    a: Math.random() * Math.PI,
    va: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.a += p.va;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.coin) {
        const w = Math.abs(Math.cos(p.a * 2)) * p.r + 0.6;
        const grad = ctx.createLinearGradient(-w, -p.r, w, p.r);
        grad.addColorStop(0, '#fff1b8');
        grad.addColorStop(0.5, '#e0ad2c');
        grad.addColorStop(1, '#9a6c0c');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(0, 0, w, p.r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(122, 82, 6, 0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.rotate(p.a);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      }
      ctx.restore();
    }
    if (t - t0 < 2600) requestAnimationFrame(frame);
    else {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      try {
        canvas.hidePopover();
      } catch {
        /* ignore */
      }
    }
  })(t0);
}

/* ---------- Timer (want-list countdowns, day rollover) ---------- */

let lastDay = toISODate(new Date());
setInterval(() => {
  const today = toISODate(new Date());
  if (today !== lastDay) {
    lastDay = today;
    rerender();
  } else if (!listView.hidden) {
    updateWantTimers();
  }
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) rerender();
});

/* ---------- Empty-state decoration ---------- */

$('empty-jar').innerHTML = jarSVG(0.35, { mini: true });

/* ---------- Boot ---------- */

setupMoney();
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
