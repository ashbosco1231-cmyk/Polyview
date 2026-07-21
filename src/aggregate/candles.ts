// Candle reconstruction — the heart of the terminal.
//
// Prediction markets trade in bursts: nothing for an hour, then fifty prints in
// ten seconds around a headline. Fixed-time candles smear that burst into one
// bar and leave dead air everywhere else. Tick candles — one bar per N executed
// trades — put detail exactly where the activity is. We support both, from the
// same trade stream, plus the buy/sell split that powers orderflow.
//
// Everything here is a pure function of a trade array so it can be unit-tested
// without a network or a database.

import type { Candle, Trade } from "../types.js";

/** Trades must be sorted ascending by time before aggregation. */
function sortedByTime(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => a.ts - b.ts);
}

function seedCandle(t: Trade): Candle {
  return {
    start: t.ts,
    end: t.ts,
    open: t.price,
    high: t.price,
    low: t.price,
    close: t.price,
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    trades: 0,
  };
}

function applyTrade(c: Candle, t: Trade): void {
  c.high = Math.max(c.high, t.price);
  c.low = Math.min(c.low, t.price);
  c.close = t.price;
  c.end = t.ts;
  c.volume += t.size;
  if (t.side === "BUY") c.buyVolume += t.size;
  else c.sellVolume += t.size;
  c.trades += 1;
}

/**
 * Tick candles: one candle per `ticksPerCandle` executed trades. The final
 * candle may be partial (fewer than `ticksPerCandle` prints) — that is the
 * live, still-forming bar and is returned as-is.
 */
export function buildTickCandles(trades: Trade[], ticksPerCandle: number): Candle[] {
  if (ticksPerCandle < 1) throw new Error("ticksPerCandle must be >= 1");
  const sorted = sortedByTime(trades);
  const out: Candle[] = [];
  let current: Candle | null = null;

  for (const t of sorted) {
    if (current === null) current = seedCandle(t);
    applyTrade(current, t);
    if (current.trades >= ticksPerCandle) {
      out.push(current);
      current = null;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * Time candles: fixed-duration OHLCV bars. Buckets are aligned to the epoch
 * (a 60s bucket always starts on a whole minute), so bars line up across
 * tokens and across sessions. Empty intervals produce no candle — callers that
 * need a gapless axis can forward-fill using the previous close.
 */
export function buildTimeCandles(trades: Trade[], intervalMs: number): Candle[] {
  if (intervalMs <= 0) throw new Error("intervalMs must be > 0");
  const sorted = sortedByTime(trades);
  const out: Candle[] = [];
  let current: Candle | null = null;
  let bucketStart = -1;

  for (const t of sorted) {
    const start = Math.floor(t.ts / intervalMs) * intervalMs;
    if (current === null || start !== bucketStart) {
      if (current !== null) out.push(current);
      bucketStart = start;
      current = seedCandle(t);
      current.start = start;
      current.end = start + intervalMs;
    }
    applyTrade(current, t);
    // For time candles, end stays pinned to the bucket boundary.
    current.end = bucketStart + intervalMs;
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * Order-flow imbalance per candle: +1 means every share was an aggressive buy,
 * -1 every share an aggressive sell, 0 balanced. This is the signal behind a
 * footprint chart.
 */
export function orderFlowImbalance(c: Candle): number {
  if (c.volume === 0) return 0;
  return (c.buyVolume - c.sellVolume) / c.volume;
}
