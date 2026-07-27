// Indicator math. Pure functions over candles, no chart or DOM knowledge, so
// each one is independently checkable against a hand-worked example.
//
// Every function takes candles as `[{ time, open, high, low, close, volume }]`
// (time in seconds, ascending) and returns `[{ time, value }]` ready to hand
// straight to a line series. Leading bars where an indicator isn't defined yet
// are omitted rather than emitted as zero — a zero would draw a cliff down to
// the axis and read as real signal.

/** Simple moving average of closes. */
export function sma(candles, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

/**
 * Exponential moving average of closes, seeded with the SMA of the first
 * `period` bars so the series doesn't inherit a long warm-up bias from bar one.
 */
export function ema(candles, period) {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let acc = 0;
  for (let i = 0; i < period; i++) acc += candles[i].close;
  let prev = acc / period;
  out.push({ time: candles[period - 1].time, value: prev });
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

/**
 * Volume-weighted average price, reset at each UTC day boundary.
 *
 * VWAP is only meaningful within a session — carried across days it drifts into
 * a number nobody trades against. Prediction markets run continuously, so the
 * UTC date is the closest thing to a session boundary available.
 */
export function vwap(candles) {
  const out = [];
  let day = null;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const d = Math.floor(c.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    if (vol > 0) out.push({ time: c.time, value: pv / vol });
  }
  return out;
}

/** Bollinger bands: an SMA with a population-stddev envelope. */
export function bollinger(candles, period = 20, mult = 2) {
  const upper = [];
  const middle = [];
  const lower = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (candles[j].close - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    const t = candles[i].time;
    upper.push({ time: t, value: mean + mult * sd });
    middle.push({ time: t, value: mean });
    lower.push({ time: t, value: mean - mult * sd });
  }
  return { upper, middle, lower };
}

/**
 * Relative strength index, Wilder-smoothed.
 *
 * Wilder's smoothing (not a plain average of the last N changes) is what makes
 * this agree with the RSI every other terminal draws.
 */
export function rsi(candles, period = 14) {
  if (candles.length <= period) return [];
  const out = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const push = (i) => {
    // All-gain stretches have no downside to divide by; RSI is 100 by definition.
    const value = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    out.push({ time: candles[i].time, value });
  };
  push(period);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    push(i);
  }
  return out;
}

/** MACD line, signal line and histogram. */
export function macd(candles, fast = 12, slow = 26, signal = 9) {
  const fastLine = ema(candles, fast);
  const slowLine = ema(candles, slow);
  if (!slowLine.length) return { macd: [], signal: [], histogram: [] };

  // The two EMAs start at different bars; align on the slower one.
  const fastAt = new Map(fastLine.map((p) => [p.time, p.value]));
  const line = [];
  for (const p of slowLine) {
    const f = fastAt.get(p.time);
    if (f !== undefined) line.push({ time: p.time, value: f - p.value });
  }

  // The signal line is an EMA *of the MACD line*, so reuse ema() by presenting
  // the line as candles whose close is the MACD value.
  const sig = ema(line.map((p) => ({ time: p.time, close: p.value })), signal);
  const sigAt = new Map(sig.map((p) => [p.time, p.value]));
  const histogram = [];
  for (const p of line) {
    const s = sigAt.get(p.time);
    if (s !== undefined) histogram.push({ time: p.time, value: p.value - s });
  }
  return { macd: line, signal: sig, histogram };
}
