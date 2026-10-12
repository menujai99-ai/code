// Refits the model off the main thread so the page stays smooth while the
// volatility and direction models (and their backtests) are rebuilt.
import { buildModel, plannerReplay } from './forecast.js';

self.onmessage = (e) => {
  const { id, hourly, daily } = e.data;
  try {
    const model = buildModel(hourly, daily);
    model.planner = plannerReplay(model);
    delete model.pool; // rebuilt on the page when needed
    self.postMessage({ id, model });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
