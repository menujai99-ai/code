# Dots & Years

Two tiny mobile apps (installable PWAs) that count down what matters, one dot at a time. The site's start page (`https://menujai99-ai.github.io/code/`) links to both:

- **Dots** (`…/code/dots/`): one dot per day for countdowns and deadlines.
- **Years** (`…/code/years/`): one dot per year for your life and long goals.

## Dots — Days Left

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
# open http://localhost:8000 (start page), /dots/ or /years/
```

## Put it on your phone

1. Host the folder on any static host — e.g. enable **GitHub Pages** for this repo (Settings → Pages → deploy from branch).
2. On your phone, open the app's own address (`…/code/dots/` or `…/code/years/`), not the start page, so the home-screen icon opens straight into that app.
3. **iPhone (Safari):** Share → *Add to Home Screen*. **Android (Chrome):** ⋮ → *Install app* / *Add to Home screen*.

It then opens full-screen like a native app and works offline.

## Home-screen widget (iPhone)

Web apps can't add home-screen widgets by themselves, so the widget runs in the free **Scriptable** app. It loads its code and your countdowns from GitHub Pages on every refresh, so **changes you make on GitHub show up on the widget by themselves**.

**Your countdowns live in [`widget/countdowns.json`](widget/countdowns.json), and the app keeps that file up to date for you.** Turn on **Widget sync** once (the cloud button next to **+**):

1. On GitHub, create a [fine-grained token](https://github.com/settings/personal-access-tokens/new): *Repository access* → only this repo; *Permissions* → *Contents* → **Read and write**.
2. In Dots, tap the cloud button, paste the token, and tap **Save & sync**. Countdowns already in the file are added to the app the first time.

From then on, every countdown you add, edit or delete in the app is written to `countdowns.json` automatically, and the widget shows it. The token is stored only in the app on your phone. A line under the title shows the sync status, with **Retry** if something went wrong; changes made offline sync when you're back online.

You can still edit the file by hand on GitHub. The widget forgives common slips such as a missing comma between entries. Each entry needs a `name`, a `start` date, and either `total` (days) or `end` (the last day); `color` is optional.

**Set up (once):**

1. Install **Scriptable** from the App Store.
2. In Dots, open a countdown → **Add as home-screen widget** → **Copy widget loader**. In Scriptable tap **+**, paste, and name it **Dots**. You never need to paste it again.
3. On your home screen: long-press → **+** → **Scriptable** → pick small, medium or large.
4. Long-press the widget → **Edit Widget** → Script **Dots**, and set **Parameter** to the countdown's name (or its number, 1 = first; empty = first).

**How fast does the widget update?** The app saves to GitHub the moment you tap Save (even if you close the app straight away), and the widget reads straight from the repo, so a new countdown is ready on the widget's very next refresh. *When* that refresh happens is up to iOS: the widget asks for one every 15 minutes, but iOS may wait longer to save battery. **Tap the widget** to update it right away. Larger and medium widgets show "Updated 2:41 PM" so you can see when it last refreshed. Offline, the widget shows the last version it downloaded. The old setup (pasting [`widget/dots-widget.js`](widget/dots-widget.js) with a `name|start|total|colour` parameter) still works.

## Years — one dot per year

A second app in [`years/`](years/), same look as Dots, where **each dot is a year**:

- **My life:** enter your birthday and an expected lifespan (default 80). Lived years are solid, this year's dot fills in day by day, and the rest are soft. Rows of 10 read as decades.
- **Goals:** a name, a start date, and a length in years or a target date. A target that isn't a whole number of years ends with a partial-year dot.
- Shows years left, age or year number, time until your next birthday or anniversary, and days left. It moves to the next dot on the birthday or anniversary by itself.
- It has its own iPhone widget that updates itself, just like Dots:
  1. In Years, tap the cloud button to turn on **Widget sync**. If it's already on in Dots, the same token is used automatically. Your items are saved to [`years/widget/years.json`](years/widget/years.json).
  2. Open an item → **Add as home-screen widget** → **Copy widget loader**. In Scriptable tap **+**, paste, and name it **Years** (once).
  3. Add a Scriptable widget, set Script **Years**, When Interacting **Run Script**, and Parameter to the item's name (or its number; empty = first).

  The widget shows the year dots, years left, a live "Birthday in …" / "Ends in …" line, and "Updated 3:07 PM". The old pasted `life|name|start|end|colour` parameter still works.

It lives at `https://menujai99-ai.github.io/code/years/`. Install it to the home screen separately from Dots; the two keep separate data.

## BTC Range — Bitcoin price ranges

A third app in [`btc/`](btc/) (`https://menujai99-ai.github.io/code/btc/`) that shows where the Bitcoin price is **likely** to be in the next **hour, 4 hours, 24 hours and 7 days**, compared with the current market price.

- **The chart** works like a hand-drawn forecast: the **blue line** is the real price up to the **Today** dot, the **red candles** after it are the prediction (box = 50% range, thin line = 80% range, tick = middle estimate), and the **red dashed cone** is the 95% range. Switch between **Days** (last 30 days + next 7) and **Hours** (last 3 days + next 24 hours in 4-hour steps), and turn the 7/50/100/200-day EMA lines on or off. Tap a candle for its numbers.
- **A card per horizon** gives the middle estimate and the 50% / 80% / 95% price ranges, plus the chance of finishing higher.
- **What the indicators say:** EMA 7/50/100/200, golden/death cross, RSI, MACD, Bollinger %B, volume, on-balance volume and ATR, each marked bullish ▲, bearish ▼ or neutral. Funding rate, open interest, Fear & Greed, transactions per day, mempool and hashrate are added when those services can be reached.
- **How well has it worked?** The model is replayed on recent history (using only the data it would have had) to show how often the ranges actually held and how often the up/down lean was right.

**Live.** While the app is open it streams every trade over a WebSocket from Binance (falling back to Coinbase, then Kraken, then checking the price every 10 s). The price, chart and ranges move in real time, and a **● Live** badge shows the connection. When an hourly or daily candle closes, the model refits itself on the new data in the background (a Web Worker, so the page never freezes).

**Background updater.** [`.github/workflows/btc-forecast.yml`](.github/workflows/btc-forecast.yml) runs [`btc/scripts/update.mjs`](btc/scripts/update.mjs) every hour on GitHub, even when nobody has the app open. It saves the forecast to the **`btc-data`** branch (`forecast.json`) and logs every prediction (`history.jsonl`). Once a prediction's time has passed it is checked against the real price (`scores.jsonl`, `track.json`), and the app shows the result as the **Live track record**. If a phone can't reach the exchanges, the app shows that background forecast instead. GitHub only runs scheduled workflows from the default branch, so the hourly job starts once this is merged to `main`. To run it straight away, use **Actions → BTC forecast → Run workflow**. Scheduled runs can be a few minutes late, and GitHub pauses them after 60 days without activity in the repo.

**How it predicts.** A GARCH(1,1) volatility model decides how wide each range is, the real (fat-tailed) shape of past moves sets its shape, and a small logistic-regression model on the indicators gives the up/down lean, which can only shift the range a little and is pulled back to 50% when the backtest shows no edge. Everything runs in your browser on live data from Binance (or Coinbase / Kraken if Binance is blocked where you are); no account, key or server. Model tests: `node --test btc/test/*.test.mjs`.

**Not financial advice.** The ranges are estimates of what is likely, not promises; the price can and does move outside them.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `manifest.webmanifest` | Start page linking to Dots, Years and BTC Range |
| `sw.js` | Retired root service worker: clears the old cache from when Dots lived at the root |
| `dots/index.html` | Dots app shell: list view, detail view, add/edit sheet |
| `dots/styles.css` | Mobile-first styles, light & dark mode |
| `dots/app.js` | State, dot grid, timer, storage, widget sync |
| `dots/sw.js` | Service worker for offline use |
| `widget/loader.js` | The script you paste into Scriptable once; loads the widget from GitHub |
| `widget/dots-widget.js` | The widget itself (downloaded by the loader) |
| `widget/countdowns.json` | Your countdowns for the widget, edited on GitHub |
| `years/` | The Years app (its own HTML, CSS, JS, service worker, manifest and widget) |
| `years/widget/loader.js` | The script you paste into Scriptable once for Years |
| `years/widget/years.json` | Your Years items for the widget, kept up to date by the app |
| `dots/manifest.webmanifest`, `dots/icon.svg` | Makes Dots installable |
| `btc/index.html`, `btc/styles.css`, `btc/app.js` | BTC Range page, chart and cards |
| `btc/data.js` | Fetches prices and extra metrics from public APIs, with fallbacks |
| `btc/model.js`, `btc/forecast.js` | Indicators, volatility model, direction model, backtest |
| `btc/live.js`, `btc/worker.js` | Live WebSocket feed with fallbacks; model refits off the main thread |
| `btc/scripts/update.mjs`, `.github/workflows/btc-forecast.yml` | Hourly background forecast and live track record (saved on the `btc-data` branch) |
| `btc/test/` | Model tests on simulated prices (`node --test btc/test/*.test.mjs`) |
