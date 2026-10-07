# Dots — Days Left

A tiny mobile app (installable PWA) that counts down the days of any goal, **one dot per day**.

- A 100-day task shows 100 dots. On day 27 you see 26 filled dots, today's dot filling up like a clock, and 73 hollow dots.
- A live timer shows the time until the next day ticks over and until the final deadline.
- The layout updates itself as time passes: at midnight today's dot becomes "done" and the next one lights up — no refresh needed. Reopen the app days later and it's already correct.
- Track multiple countdowns, each with its own colour.
- Works offline, stores everything locally on your device (no account, no server).

## Adding a countdown

Tap **+**, give it a name and the total number of days, then either:

- **I'm on day…** — e.g. `27` if you're already 27 days in (the start date is worked out for you), or
- **Start date** — pick the date day 1 was (or will be).

For the length, type a **Number of days** or pick a **Target date** (the last day, up to 10 years ahead) and the days are counted for you. You can change the name, start and target any time with the pencil button.

Tap a countdown to see the full dot grid. Tap any dot to see its date.

## Run it

It's plain HTML/CSS/JS — no build step.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Put it on your phone

1. Host the folder on any static host — e.g. enable **GitHub Pages** for this repo (Settings → Pages → deploy from branch).
2. Open the URL on your phone.
3. **iPhone (Safari):** Share → *Add to Home Screen*. **Android (Chrome):** ⋮ → *Install app* / *Add to Home screen*.

It then opens full-screen like a native app and works offline.

## Home-screen widget (iPhone)

Web apps can't add home-screen widgets by themselves, so the widget runs in the free **Scriptable** app. It loads its code and your countdowns from GitHub Pages on every refresh, so **changes you make on GitHub show up on the widget by themselves**.

**Your countdowns live in [`widget/countdowns.json`](widget/countdowns.json):**

```json
[
  { "name": "Exam prep", "start": "2026-09-07", "total": 100, "color": "#e8590c" },
  { "name": "Ship the app", "start": "2026-10-03", "end": "2026-12-31", "color": "#1c7ed6" }
]
```

Each entry needs a `name`, a `start` date, and either `total` (days) or `end` (the last day). `color` is optional.

The widget shows the dots, days left, and a live "Deadline in 73 days, 2 hr" line that iOS keeps counting down between refreshes. Edit the file on github.com (the pencil icon) and commit. In the app, **Add as home-screen widget** shows the current countdown as a ready-made entry to copy in.

**Set up (once):**

1. Install **Scriptable** from the App Store.
2. In Dots, open a countdown → **Add as home-screen widget** → **Copy widget loader**. In Scriptable tap **+**, paste, and name it **Dots**. You never need to paste it again.
3. On your home screen: long-press → **+** → **Scriptable** → pick small, medium or large.
4. Long-press the widget → **Edit Widget** → Script **Dots**, and set **Parameter** to the countdown's name (or its number, 1 = first; empty = first).

After you commit a change, GitHub Pages takes about a minute to publish it, then the widget picks it up on its next refresh (about every 30 minutes; iOS decides exactly when). Offline, the widget shows the last version it downloaded. The old setup (pasting [`widget/dots-widget.js`](widget/dots-widget.js) with a `name|start|total|colour` parameter) still works.

## Years — one dot per year

A second app in [`years/`](years/), same look as Dots, where **each dot is a year**:

- **My life:** enter your birthday and an expected lifespan (default 80). Lived years are solid, this year's dot fills in day by day, and the rest are soft. Rows of 10 read as decades.
- **Goals:** a name, a start date, and a length in years or a target date. A target that isn't a whole number of years ends with a partial-year dot.
- Shows years left, age or year number, time until your next birthday or anniversary, and days left. It moves to the next dot on the birthday or anniversary by itself.
- It has its own iPhone widget, set up exactly like the Dots one (script name **Years**, parameter copied from the app).

Once GitHub Pages is on, it lives at `https://menujai99-ai.github.io/code/years/`. Install it to the home screen separately from Dots; the two keep separate data.

## Stash — save money, earn rewards

A third app in [`save/`](save/), with its own banknote-and-gold look, for **building a saving habit**:

- **A jar for every goal.** Give a goal a target (and optionally a date). Its glass jar fills with liquid in the goal's colour, with dashed marks at 25 / 50 / 75%. Each time you save, a gold coin drops in and the level rises. Goal cards show a mini jar.
- **Bigger intentions, bigger rewards.** Every goal has a tier set by its size: 🌱 Small step ×1, 🌿 Solid ×1.5, 🌳 Big ×2, 🏔️ Huge ×3. The multiplier applies to XP on every save. Bigger goals also pay bigger 25/50/75/100% milestone bonuses and a bigger **treat budget** (2–5% of the goal) for the reward you choose. Set what counts as "big" for you in Settings.
- **XP, levels and badges.** Level up from Seedling Saver to Legend of Thrift. Badges for streaks, skipping purchases, halfway, finishing a Big or Huge goal and more. New ones show up with confetti.
- **I skipped a buy.** Didn't buy the coffee? Log it, and the money goes to a goal.
- **Want list (cool-off).** Add something you're tempted by and wait 24h to 30 days. If you skip it after the wait, it earns ×1.5 XP. If you still want it, buy it guilt-free.
- **Streaks** for each day you put money away. Withdrawals are allowed, but they take back their XP.
- Everything stays on your device. Use **Export / Import backup** in Settings to move it. Lives at `https://menujai99-ai.github.io/code/save/`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell: list view, detail view, add/edit sheet |
| `styles.css` | Mobile-first styles, light & dark mode |
| `app.js` | State, dot grid, timer, storage |
| `sw.js` | Service worker for offline use |
| `widget/loader.js` | The script you paste into Scriptable once; loads the widget from GitHub |
| `widget/dots-widget.js` | The widget itself (downloaded by the loader) |
| `widget/countdowns.json` | Your countdowns for the widget, edited on GitHub |
| `years/` | The Years app (its own HTML, CSS, JS, service worker, manifest and widget) |
| `save/` | The Stash savings app (its own HTML, CSS, JS, service worker and manifest) |
| `manifest.webmanifest`, `icon.svg` | Makes it installable |
