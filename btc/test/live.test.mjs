// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBinance, parseCoinbase, parseKraken, applyTick, upsertCandle, bucketStart, resample, WEEK, LiveFeed, FEEDS, BACKOFF_MS,
} from '../live.js';

const H = 3600e3;
const D = 24 * H;

test('Binance messages: trades with size and side, live candles, 24h stats', () => {
  const trade = (m) => parseBinance({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', p: '64000.5', q: '0.1', T: 1700000000000, m } });
  assert.deepEqual(trade(false), [{ type: 'tick', price: 64000.5, t: 1700000000000, qty: 0.1, side: 'buy' }]);
  assert.equal(trade(true)[0].side, 'sell', 'buyer was the maker, so the taker sold');
  const k = parseBinance({
    stream: 'btcusdt@kline_1h',
    data: { e: 'kline', E: 1, k: { t: 1699999200000, i: '1h', o: '1', h: '3', l: '0.5', c: '2', v: '0.5', q: '1000', x: true } },
  });
  assert.deepEqual(k, [{ type: 'kline', interval: '1h', closed: true, candle: { t: 1699999200000, o: 1, h: 3, l: 0.5, c: 2, v: 1000, vb: 0.5 } }]);
  const st = parseBinance({ stream: 'btcusdt@ticker', data: { e: '24hrTicker', P: '0.330', h: '83203.5', l: '82724', o: '82850', v: '1343.66', q: '111600000' } });
  assert.deepEqual(st, [{ type: 'stats', high: 83203.5, low: 82724, open: 82850, change: 0.0033, volBase: 1343.66, volQuote: 111600000 }]);
  assert.deepEqual(parseBinance({ result: null, id: 1 }), []);
  assert.ok(FEEDS[0].url.includes('btcusdt@ticker'), 'the 24h ticker stream is subscribed');
});

test('Coinbase ticker: trade (taker side) and 24h stats', () => {
  const cb = parseCoinbase({
    type: 'ticker', product_id: 'BTC-USD', price: '64100.00', last_size: '0.5', side: 'sell', time: '2026-10-08T12:00:00.000Z',
    open_24h: '64000', high_24h: '64500', low_24h: '63000', volume_24h: '1000',
  });
  assert.deepEqual(cb[0], { type: 'tick', price: 64100, t: Date.parse('2026-10-08T12:00:00Z'), qty: 0.5, side: 'buy' });
  assert.equal(cb[1].type, 'stats');
  assert.equal(cb[1].high, 64500);
  assert.ok(Math.abs(cb[1].change - (64100 / 64000 - 1)) < 1e-12);
  assert.equal(cb[1].volQuote, 1000 * 64100);
  assert.deepEqual(parseCoinbase({ type: 'heartbeat' }), []);
  assert.deepEqual(parseCoinbase({ type: 'ticker', product_id: 'ETH-USD', price: '1' }), []);
});

test('Kraken: trade channel (with snapshot flag) and ticker stats', () => {
  const tr = parseKraken({
    channel: 'trade', type: 'snapshot',
    data: [{ symbol: 'BTC/USD', side: 'sell', price: 64200.1, qty: 0.02, timestamp: '2026-10-08T12:00:01Z' }],
  });
  assert.deepEqual(tr, [{ type: 'tick', price: 64200.1, t: Date.parse('2026-10-08T12:00:01Z'), qty: 0.02, side: 'sell', snapshot: true }]);
  const tk = parseKraken({
    channel: 'ticker', type: 'update', timestamp: '2026-10-08T12:00:02Z',
    data: [{ symbol: 'BTC/USD', last: 64200, high: 64500, low: 63000, change: 200, change_pct: 0.31, volume: 500, vwap: 64000 }],
  });
  assert.deepEqual(tk[0], { type: 'tick', price: 64200, t: Date.parse('2026-10-08T12:00:02Z') });
  assert.deepEqual(tk[1], { type: 'stats', high: 64500, low: 63000, open: 64000, change: 0.0031, volBase: 500, volQuote: 500 * 64000 });
  assert.deepEqual(parseKraken({ channel: 'heartbeat' }), []);
  const channels = FEEDS.find((f) => f.name === 'Kraken').subscribe.map((m) => m.params.channel);
  assert.deepEqual(channels, ['ticker', 'trade']);
});

test('applyTick updates the open candle and starts a new one at the boundary', () => {
  const c = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 0, vb: 0 }];
  assert.equal(applyTick(c, H, 105, 10, 0.5), false);
  assert.deepEqual(c[0], { t: 0, o: 100, h: 105, l: 100, c: 105, v: 52.5, vb: 0.5 });
  assert.equal(applyTick(c, H, 95, 20), false);
  assert.equal(c[0].l, 95);
  assert.equal(applyTick(c, H, 97, H + 5, 2), true, 'crossing the hour closes the candle');
  assert.deepEqual(c[1], { t: H, o: 95, h: 97, l: 95, c: 97, v: 194, vb: 2 });
  assert.equal(applyTick(c, H, 50, 5), false, 'a late trade for an old candle is ignored');
  assert.equal(c[1].c, 97);
  assert.equal(applyTick(c, H, 99, 5 * H + 1), true, 'a gap jumps to the right hour');
  assert.equal(c[2].t, 5 * H);
});

test('weekly candles open on Monday 00:00 UTC', () => {
  const monday = Date.UTC(2026, 9, 5); // Monday 5 October 2026
  assert.equal(new Date(monday).getUTCDay(), 1);
  assert.equal(bucketStart(monday + 3 * D + 5 * H, WEEK), monday);
  assert.equal(bucketStart(monday - 1, WEEK), monday - WEEK);
  const c = [{ t: monday, o: 1, h: 1, l: 1, c: 1, v: 0, vb: 0 }];
  assert.equal(applyTick(c, WEEK, 2, monday + 7 * D + 1), true);
  assert.equal(c[1].t, monday + WEEK);
  assert.equal(bucketStart(Date.UTC(2026, 9, 8, 13, 47), 15 * 60e3), Date.UTC(2026, 9, 8, 13, 45));
});

test('resample merges candles: 1h into 4h, 1d into weeks', () => {
  const start = Date.UTC(2026, 9, 8, 0);
  const hourly = Array.from({ length: 8 }, (_, i) => ({ t: start + i * H, o: 10 + i, h: 20 + i, l: 5 - i, c: 11 + i, v: 1, vb: 0.1 }));
  const four = resample(hourly, 4 * H);
  assert.equal(four.length, 2);
  assert.deepEqual(four[0], { t: start, o: 10, h: 23, l: 2, c: 14, v: 4, vb: 0.4 });
  assert.equal(four[1].t, start + 4 * H);
  const monday = Date.UTC(2026, 9, 5);
  const daily = Array.from({ length: 10 }, (_, i) => ({ t: monday - 2 * D + i * D, o: i, h: i + 1, l: i - 1, c: i, v: 1, vb: 1 }));
  const weeks = resample(daily, WEEK);
  assert.deepEqual(weeks.map((w) => w.t), [monday - WEEK, monday, monday + WEEK]);
  assert.equal(weeks[1].vb, 7);
});

test('upsertCandle replaces, inserts in order, and appends', () => {
  const c = [{ t: 0, c: 1 }, { t: 2 * H, c: 3 }];
  assert.equal(upsertCandle(c, { t: 2 * H, c: 4 }), false);
  assert.equal(c[1].c, 4);
  assert.equal(upsertCandle(c, { t: H, c: 2 }), true);
  assert.deepEqual(c.map((x) => x.t), [0, H, 2 * H]);
  assert.equal(upsertCandle(c, { t: 3 * H, c: 5 }), true);
  assert.equal(c.length, 4);
});

// ---------- LiveFeed with fake sockets and timers ----------

function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { pending.set(++id, { fn, ms, repeat: false }); return id; },
    setInterval(fn, ms) { pending.set(++id, { fn, ms, repeat: true }); return id; },
    clearTimeout(i) { pending.delete(i); },
    clearInterval(i) { pending.delete(i); },
    // Run the pending one-shot timers (not intervals) shorter than maxMs.
    flush(maxMs = Infinity) {
      for (const [i, t] of [...pending]) if (!t.repeat && t.ms < maxMs) { pending.delete(i); t.fn(); }
    },
    intervals() { return [...pending.values()].filter((t) => t.repeat); },
    timeouts() { return [...pending.values()].filter((t) => !t.repeat); },
  };
}

function fakeSockets(behaviour) {
  const made = [];
  class WS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      made.push(this);
      queueMicrotask(() => {
        if (behaviour(url) === 'fail') this.onclose?.();
        else this.onopen?.();
      });
    }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { this.onclose?.(); }
    push(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  }
  return { WS, made };
}

const tick = () => new Promise((r) => setImmediate(r));

test('LiveFeed prefers the REST exchange, goes live on the first message, and subscribes', async () => {
  const timers = fakeTimers();
  const { WS, made } = fakeSockets(() => 'ok');
  const events = [];
  const states = [];
  const feed = new LiveFeed({ WebSocketImpl: WS, timers, prefer: 'Coinbase', onEvent: (e, src) => events.push([e, src]), onState: (s, n) => states.push([s, n]) });
  feed.start();
  await tick();
  assert.equal(made[0].url, 'wss://ws-feed.exchange.coinbase.com');
  assert.equal(made[0].sent[0].type, 'subscribe');
  made[0].push({ type: 'subscriptions' });
  assert.equal(feed.state, 'connecting', 'not live until real data arrives');
  made[0].push({ type: 'ticker', product_id: 'BTC-USD', price: '64000', last_size: '1', time: '2026-10-08T00:00:00Z' });
  assert.equal(feed.state, 'live');
  assert.equal(events[0][0].price, 64000);
  assert.equal(events[0][1], 'Coinbase');
  assert.deepEqual(states.at(-1), ['live', 'Coinbase']);
  feed.stop();
  assert.equal(feed.state, 'stopped');
});

test('LiveFeed backs off, falls through every exchange, then polls', async () => {
  const timers = fakeTimers();
  const { WS, made } = fakeSockets(() => 'fail');
  const events = [];
  const feed = new LiveFeed({
    WebSocketImpl: WS, timers,
    onEvent: (e, src) => events.push([e, src]),
    poll: async () => ({ price: 63000, source: 'Kraken' }),
  });
  feed.start();
  const waits = [];
  for (let i = 0; i < 40 && feed.state !== 'polling'; i++) {
    await tick();
    for (const t of timers.timeouts()) waits.push(t.ms);
    timers.flush(60000); // leave the 2-minute "try the sockets again" timer
  }
  assert.equal(feed.state, 'polling');
  assert.deepEqual([...new Set(made.map((w) => w.url))], FEEDS.map((f) => f.url), 'tried every feed in order');
  assert.equal(made.length, FEEDS.length * 3, 'three tries per feed');
  assert.deepEqual(waits.slice(0, 2), BACKOFF_MS.slice(0, 2));
  await tick();
  assert.deepEqual(events[0], [{ type: 'tick', price: 63000, t: events[0][0].t }, 'Kraken']);
  assert.ok(timers.intervals().some((t) => t.ms === 10000), 'keeps polling every 10 s');
  assert.ok(timers.timeouts().some((t) => t.ms === 120000), 'tries the sockets again later');
  feed.stop();
});

test('LiveFeed retries a socket that had been working without giving up on it', async () => {
  const timers = fakeTimers();
  const { WS, made } = fakeSockets(() => 'ok');
  const feed = new LiveFeed({ WebSocketImpl: WS, timers, onEvent: () => {} });
  feed.start();
  for (let round = 0; round < 5; round++) {
    await tick();
    made.at(-1).push({ data: { e: 'aggTrade', p: '1', T: 1 } });
    assert.equal(feed.state, 'live');
    made.at(-1).close(); // drops after working
    assert.equal(feed.state, 'reconnecting');
    timers.flush();
  }
  assert.ok(made.every((w) => w.url === FEEDS[0].url), 'stays on the working exchange');
  feed.stop();
});
