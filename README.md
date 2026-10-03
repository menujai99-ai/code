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

Web apps can't add home-screen widgets by themselves, so the widget runs in the free **Scriptable** app.

1. Install **Scriptable** from the App Store.
2. In Dots, open a countdown → **Add as home-screen widget** → **Copy widget script**. In Scriptable tap **+**, paste, and name it **Dots** (one time only).
3. On your home screen: long-press → **+** → **Scriptable** → pick small, medium or large.
4. Long-press the widget → **Edit Widget** → Script **Dots**, and paste the **Parameter** line copied from the app (e.g. `Exam prep|2026-09-07|100|#e8590c`).

Add one widget per countdown. It draws the same dot grid, flips to the next dot after midnight, and refreshes about every 30 minutes so today's dot fills in. The script lives in [`widget/dots-widget.js`](widget/dots-widget.js).

## Years — one dot per year

A second app in [`years/`](years/), same look as Dots, where **each dot is a year**:

- **My life:** enter your birthday and an expected lifespan (default 80). Lived years are solid, this year's dot fills in day by day, and the rest are soft. Rows of 10 read as decades.
- **Goals:** a name, a start date, and a length in years or a target date. A target that isn't a whole number of years ends with a partial-year dot.
- Shows years left, age or year number, time until your next birthday or anniversary, and days left. It moves to the next dot on the birthday or anniversary by itself.
- It has its own iPhone widget, set up exactly like the Dots one (script name **Years**, parameter copied from the app).

Once GitHub Pages is on, it lives at `…/sss/years/`. Install it to the home screen separately from Dots; the two keep separate data.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell: list view, detail view, add/edit sheet |
| `styles.css` | Mobile-first styles, light & dark mode |
| `app.js` | State, dot grid, timer, storage |
| `sw.js` | Service worker for offline use |
| `widget/dots-widget.js` | iPhone home-screen widget (Scriptable) |
| `years/` | The Years app (its own HTML, CSS, JS, service worker, manifest and widget) |
| `manifest.webmanifest`, `icon.svg` | Makes it installable |
