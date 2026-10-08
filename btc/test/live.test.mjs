// Run with: node --test btc/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBinance, parseCoinbase, parseKraken, applyTick, upsertCandle, LiveFeed, FEEDS, BACKOFF_MS } from '../live.js';

const H = 3600e3;

test('Binance messages: trades and live candles', () => {
  assert.deepEqual(parseBinance({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', p: '64000.5', q: '0.1', T: 1700000000000 } }), [
    { type: 'tick', price: 64000.5, t: 1700000000000 },
  ]);
  const k = parseBinance({
    stream: 'btcusdt@kline_1h',
    data: { e: 'kline', E: 1, k: { t: 1699999200000, i: '1h', o: '1', h: '3', l: '0.5', c: '2', q: '1000', x: true } },
  });
  assert.deepEqual(k, [{ type: 'kline', interval: '1h', closed: true, candle: { t: 1699999200000, o: 1, h: 3, l: 0.5, c: 2, v: 1000 } }]);
  assert.deepEqual(parseBinance({ result: null, id: 1 }), []);
});

test('Coinbase and Kraken ticker messages', () => {
  const cb = parseCoinbase({ type: 'ticker', product_id: 'BTC-USD', price: '64100.00', last_size: '0.5', time: '2026-10-08T12:00:00.000Z' });
  assert.deepEqual(cb, [{ type: 'tick', price: 64100, t: Date.parse('2026-10-08T12:00:00Z'), volume: 32050 }]);
  assert.deepEqual(parseCoinbase({ type: 'heartbeat' }), []);
  assert.deepEqual(parseCoinbase({ type: 'ticker', product_id: 'ETH-USD', price: '1' }), []);
  const kr = parseKraken({ channel: 'ticker', type: 'update', timestamp: '2026-10-08T12:00:01Z', data: [{ symbol: 'BTC/USD', last: 64200.1 }] });
  assert.deepEqual(kr, [{ type: 'tick', price: 64200.1, t: Date.parse('2026-10-08T12:00:01Z') }]);
  assert.deepEqual(parseKraken({ channel: 'heartbeat' }), []);
});

test('applyTick updates the open candle and starts a new one at the boundary', () => {
  const c = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 0 }];
  assert.equal(applyTick(c, H, 105, 10, 50), false);
  assert.deepEqual(c[0], { t: 0, o: 100, h: 105, l: 100, c: 105, v: 50 });
  assert.equal(applyTick(c, H, 95, 20), false);
  assert.equal(c[0].l, 95);
  assert.equal(applyTick(c, H, 97, H + 5, 7), true, 'crossing the hour closes the candle');
  assert.deepEqual(c[1], { t: H, o: 95, h: 97, l: 95, c: 97, v: 7 });
  assert.equal(applyTick(c, H, 50, 5), false, 'a late trade for an old candle is ignored');
  assert.equal(c[1].c, 97);
  assert.equal(applyTick(c, H, 99, 5 * H + 1), true, 'a gap jumps to the right hour');
  assert.equal(c[2].t, 5 * H);
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
