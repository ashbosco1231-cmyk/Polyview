import { describe, expect, it } from "vitest";
import { buildTickCandles, buildTimeCandles, orderFlowImbalance } from "../src/aggregate/candles.js";
import type { Trade } from "../src/types.js";

function trade(ts: number, price: number, size: number, side: "BUY" | "SELL" = "BUY"): Trade {
  return { venue: "polymarket", tokenId: "t", market: "m", price, size, side, ts, txHash: `${ts}-${price}` };
}

describe("buildTickCandles", () => {
  it("groups trades into fixed-count candles with correct OHLC", () => {
    const trades = [
      trade(1, 0.5, 10),
      trade(2, 0.55, 5),
      trade(3, 0.48, 8), // closes candle 1 (3 ticks)
      trade(4, 0.6, 2),
      trade(5, 0.62, 4), // candle 2 partial (2 ticks)
    ];
    const candles = buildTickCandles(trades, 3);
    expect(candles).toHaveLength(2);

    const [c1, c2] = candles;
    expect(c1!.open).toBe(0.5);
    expect(c1!.high).toBe(0.55);
    expect(c1!.low).toBe(0.48);
    expect(c1!.close).toBe(0.48);
    expect(c1!.volume).toBe(23);
    expect(c1!.trades).toBe(3);

    // Trailing partial candle is returned as the still-forming bar.
    expect(c2!.trades).toBe(2);
    expect(c2!.close).toBe(0.62);
  });

  it("sorts unsorted input by time before grouping", () => {
    const trades = [trade(3, 0.48, 8), trade(1, 0.5, 10), trade(2, 0.55, 5)];
    const [c] = buildTickCandles(trades, 3);
    expect(c!.open).toBe(0.5); // earliest ts
    expect(c!.close).toBe(0.48); // latest ts
  });

  it("splits buy vs sell volume for orderflow", () => {
    const trades = [trade(1, 0.5, 10, "BUY"), trade(2, 0.5, 6, "SELL"), trade(3, 0.5, 4, "BUY")];
    const [c] = buildTickCandles(trades, 3);
    expect(c!.buyVolume).toBe(14);
    expect(c!.sellVolume).toBe(6);
    expect(orderFlowImbalance(c!)).toBeCloseTo((14 - 6) / 20);
  });

  it("rejects nonsensical tick counts", () => {
    expect(() => buildTickCandles([], 0)).toThrow();
  });

  it("returns nothing for no trades", () => {
    expect(buildTickCandles([], 50)).toEqual([]);
  });
});

describe("buildTimeCandles", () => {
  it("buckets trades into epoch-aligned intervals", () => {
    const minute = 60_000;
    const trades = [
      trade(minute * 2 + 1_000, 0.5, 10),
      trade(minute * 2 + 40_000, 0.52, 5), // same minute bucket
      trade(minute * 4 + 2_000, 0.6, 3), // two buckets later (bucket 3 empty)
    ];
    const candles = buildTimeCandles(trades, minute);
    expect(candles).toHaveLength(2);

    expect(candles[0]!.start).toBe(minute * 2);
    expect(candles[0]!.end).toBe(minute * 3);
    expect(candles[0]!.open).toBe(0.5);
    expect(candles[0]!.close).toBe(0.52);
    expect(candles[0]!.volume).toBe(15);

    expect(candles[1]!.start).toBe(minute * 4);
    expect(candles[1]!.volume).toBe(3);
  });

  it("rejects non-positive intervals", () => {
    expect(() => buildTimeCandles([], 0)).toThrow();
  });
});
