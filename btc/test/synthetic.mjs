// Synthetic BTC-like candles for tests: a GARCH(1,1) price path with fat
// (Student-t) shocks. A seeded generator keeps every run identical.

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Student-t with `df` degrees of freedom, scaled to unit variance.
function studentT(rand, df) {
  let chi = 0;
  for (let i = 0; i < df; i++) chi += normal(rand) ** 2;
  return (normal(rand) / Math.sqrt(chi / df)) * Math.sqrt((df - 2) / df);
}

export function garchPath({ n = 2000, omega = 2e-7, alpha = 0.08, beta = 0.9, start = 60000, seed = 7, stepMs = 3600e3, t0 = Date.UTC(2026, 0, 1), df = 6, drift = 0 } = {}) {
  const rand = rng(seed);
  let s2 = omega / (1 - alpha - beta);
  let price = start;
  const candles = [];
  for (let i = 0; i < n; i++) {
    const r = drift + Math.sqrt(s2) * studentT(rand, df);
    const o = price;
    const c = price * Math.exp(r);
    const wig = Math.sqrt(s2) * 0.5;
    const h = Math.max(o, c) * Math.exp(Math.abs(normal(rand)) * wig);
    const l = Math.min(o, c) * Math.exp(-Math.abs(normal(rand)) * wig);
    candles.push({ t: t0 + i * stepMs, o, h, l, c, v: 1e9 * Math.exp(0.3 * normal(rand)) });
    s2 = omega + alpha * r * r + beta * s2;
    price = c;
  }
  return candles;
}
