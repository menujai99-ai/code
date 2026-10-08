// Live price feed over WebSocket, with fallbacks:
// Binance (public mirror, then main site) → Coinbase → Kraken → REST polling.
// Messages from every exchange are turned into the same small events:
//   { type: 'tick', price, t, volume? }              a trade / ticker update
//   { type: 'kline', interval, candle, closed }      Binance's own live candle

const BINANCE_STREAMS = 'streams=btcusdt@aggTrade/btcusdt@kline_1h/btcusdt@kline_1d';

export function parseBinance(msg) {
  const d = msg?.data ?? msg;
  if (d?.e === 'aggTrade') return [{ type: 'tick', price: +d.p, t: d.T }];
  if (d?.e === 'kline') {
    const k = d.k;
    return [{
      type: 'kline',
      interval: k.i,
      closed: !!k.x,
      candle: { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q },
    }];
  }
  return [];
}

export function parseCoinbase(msg) {
  if (msg?.type !== 'ticker' || msg.product_id !== 'BTC-USD') return [];
  const price = +msg.price;
  const t = Date.parse(msg.time) || Date.now();
  const size = +msg.last_size;
  return [{ type: 'tick', price, t, volume: Number.isFinite(size) ? size * price : 0 }];
}

export function parseKraken(msg) {
  if (msg?.channel !== 'ticker' || !Array.isArray(msg.data)) return [];
  const t = Date.parse(msg.timestamp) || Date.now();
  return msg.data.filter((d) => d.symbol === 'BTC/USD').map((d) => ({ type: 'tick', price: +d.last, t }));
}

export const FEEDS = [
  { name: 'Binance', url: `wss://data-stream.binance.vision/stream?${BINANCE_STREAMS}`, parse: parseBinance },
  { name: 'Binance', url: `wss://stream.binance.com:9443/stream?${BINANCE_STREAMS}`, parse: parseBinance },
  {
    name: 'Coinbase',
    url: 'wss://ws-feed.exchange.coinbase.com',
    subscribe: { type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] },
    parse: parseCoinbase,
  },
  {
    name: 'Kraken',
    url: 'wss://ws.kraken.com/v2',
    subscribe: { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } },
    parse: parseKraken,
  },
];

// ---------- Candles from live data ----------

// Fold a trade into the candle series (oldest first). When the trade falls past
// the last candle, a new candle is started. Returns true if a candle closed.
export function applyTick(candles, step, price, t, volume = 0) {
  if (!candles.length || !(price > 0)) return false;
  const last = candles[candles.length - 1];
  if (t < last.t) return false; // late trade for a candle already replaced
  if (t < last.t + step) {
    last.c = price;
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.v += volume;
    return false;
  }
  const start = Math.floor(t / step) * step;
  candles.push({ t: start, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price, v: volume });
  return true;
}

// Put a candle into the series, keeping it in time order: replace the one with
// the same start time, otherwise insert it. Returns true if it was added.
export function upsertCandle(candles, candle) {
  let i = candles.length;
  while (i > 0 && candles[i - 1].t > candle.t) i--;
  if (i > 0 && candles[i - 1].t === candle.t) {
    candles[i - 1] = { ...candle };
    return false;
  }
  candles.splice(i, 0, { ...candle });
  return true;
}

// ---------- Connection ----------
// States reported through onState: 'connecting', 'live', 'reconnecting',
// 'polling', 'stopped'.

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const TRIES_PER_FEED = 3;
const SILENCE_MS = 30000; // reconnect when a socket goes quiet this long
const POLL_MS = 10000;
const RETRY_STREAMS_MS = 120000; // while polling, try the sockets again this often

export class LiveFeed {
  constructor({ onEvent, onState = () => {}, poll = null, prefer = null, feeds = FEEDS, WebSocketImpl = globalThis.WebSocket, timers = globalThis } = {}) {
    this.onEvent = onEvent;
    this.onState = onState;
    this.poll = poll;
    this.WS = WebSocketImpl;
    this.timers = timers;
    this.feeds = prefer ? [...feeds.filter((f) => f.name === prefer), ...feeds.filter((f) => f.name !== prefer)] : [...feeds];
    this.state = 'stopped';
    this.feed = null;
    this.index = 0;
    this.tries = 0;
    this.ws = null;
    this.lastMessage = 0;
    this.timer = null;
    this.watchdog = null;
    this.pollTimer = null;
  }

  start() {
    if (this.state !== 'stopped') return;
    this.index = 0;
    this.tries = 0;
    if (!this.WS) return this.startPolling();
    this.connect();
    this.watchdog = this.timers.setInterval(() => {
      if (this.state === 'live' && Date.now() - this.lastMessage > SILENCE_MS) this.ws?.close();
    }, 5000);
  }

  stop() {
    this.setState('stopped');
    this.clearTimers();
    this.timers.clearInterval(this.watchdog);
    this.watchdog = null;
    this.dropSocket();
  }

  setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.onState(s, this.feed?.name ?? null);
  }

  clearTimers() {
    this.timers.clearTimeout(this.timer);
    this.timers.clearInterval(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
  }

  dropSocket() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  connect() {
    this.dropSocket();
    this.feed = this.feeds[this.index];
    this.setState(this.tries ? 'reconnecting' : 'connecting');
    let ws;
    try {
      ws = new this.WS(this.feed.url);
    } catch {
      return this.failed(false);
    }
    this.ws = ws;
    let gotData = false;
    ws.onopen = () => {
      if (this.feed.subscribe) ws.send(JSON.stringify(this.feed.subscribe));
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.lastMessage = Date.now();
      const events = this.feed.parse(msg).filter((ev) => ev.type !== 'tick' || ev.price > 0);
      if (!events.length) return;
      if (!gotData) {
        gotData = true;
        this.tries = 0;
        this.timers.clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.setState('live');
      }
      for (const ev of events) this.onEvent(ev, this.feed.name);
    };
    ws.onerror = () => {}; // onclose follows
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failed(gotData);
    };
  }

  // A socket closed or never opened. A socket that had been working is simply
  // retried; one that keeps failing hands over to the next exchange.
  failed(hadData) {
    if (this.state === 'stopped') return;
    if (hadData) this.tries = 0;
    this.tries++;
    if (this.tries >= TRIES_PER_FEED) {
      this.index++;
      this.tries = 0;
      if (this.index >= this.feeds.length) {
        this.index = 0;
        this.tries = 0;
        this.startPolling();
        this.timer = this.timers.setTimeout(() => this.connect(), RETRY_STREAMS_MS);
        return;
      }
      return this.connect();
    }
    const wait = BACKOFF_MS[Math.min(this.tries - 1, BACKOFF_MS.length - 1)];
    this.setState('reconnecting');
    this.timer = this.timers.setTimeout(() => this.connect(), wait);
  }

  startPolling() {
    this.feed = null;
    this.setState('polling');
    if (!this.poll || this.pollTimer) return;
    const run = async () => {
      try {
        const { price, source } = await this.poll();
        if (price > 0) this.onEvent({ type: 'tick', price, t: Date.now() }, source);
      } catch {
        /* try again next round */
      }
    };
    run();
    this.pollTimer = this.timers.setInterval(run, POLL_MS);
  }
}
