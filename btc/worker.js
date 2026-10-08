// Refits the model off the main thread so the page stays smooth while the
// volatility and direction models (and their backtests) are rebuilt.
import { buildModel } from './forecast.js';

self.onmessage = (e) => {
  const { id, hourly, daily } = e.data;
  try {
    self.postMessage({ id, model: buildModel(hourly, daily) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
