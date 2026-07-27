import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ES module shared with the browser, no types.
import { bollinger, ema, macd, rsi, sma, vwap } from "../web/indicators.js";

/** Bars at one-minute spacing with only the fields each indicator reads. */
function bars(closes: number[], volumes?: number[], startSec = 1_785_000_000) {
  return closes.map((close, i) => ({
    time: startSec + i * 60,
    open: close,
    high: close,
    low: close,
    close,
    volume: volumes ? volumes[i] : 1,
  }));
}

describe("sma", () => {
  it("averages a trailing window and omits the warm-up bars", () => {
    const out = sma(bars([1, 2, 3, 4, 5]), 3);
    expect(out.map((p: any) => p.value)).toEqual([2, 3, 4]);
    // First value lands on the third bar, not the first.
    expect(out[0].time).toBe(1_785_000_000 + 2 * 60);
  });

  it("returns nothing when there aren't enough bars to fill the window", () => {
    expect(sma(bars([1, 2]), 5)).toEqual([]);
  });
});

describe("ema", () => {
  it("seeds from the SMA of the first period, then decays", () => {
    // period 3 -> seed = mean(1,2,3) = 2, k = 0.5
    //   bar4: 4*0.5 + 2*0.5 = 3     bar5: 5*0.5 + 3*0.5 = 4
    expect(ema(bars([1, 2, 3, 4, 5]), 3).map((p: any) => p.value)).toEqual([2, 3, 4]);
  });

  it("returns nothing below the seeding length", () => {
    expect(ema(bars([1, 2]), 5)).toEqual([]);
  });
});

describe("vwap", () => {
  it("weights price by volume", () => {
    // (10*1 + 20*3) / 4 = 17.5
    const out = vwap(bars([10, 20], [1, 3]));
    expect(out.map((p: any) => p.value)).toEqual([10, 17.5]);
  });

  it("resets at the UTC day boundary", () => {
    // Carrying VWAP across days drifts it into a level nobody trades against.
    const day1 = bars([10, 10], [1, 1], 1_785_000_000);
    const day2 = bars([50], [1], 1_785_000_000 + 86_400 * 2);
    const out = vwap([...day1, ...day2]);
    expect(out[out.length - 1].value).toBe(50);
  });
});

describe("bollinger", () => {
  it("collapses the envelope onto the mean when price is flat", () => {
    const b = bollinger(bars([5, 5, 5, 5]), 3, 2);
    expect(b.upper[0].value).toBe(5);
    expect(b.middle[0].value).toBe(5);
    expect(b.lower[0].value).toBe(5);
  });

  it("places the bands symmetrically around the mean", () => {
    const b = bollinger(bars([1, 2, 3, 4, 5]), 3, 2);
    for (let i = 0; i < b.middle.length; i++) {
      const spread = b.upper[i].value - b.middle[i].value;
      expect(b.middle[i].value - b.lower[i].value).toBeCloseTo(spread, 12);
      expect(spread).toBeGreaterThan(0);
    }
  });
});

describe("rsi", () => {
  it("is 100 when every bar closes higher", () => {
    const out = rsi(bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 14);
    expect(out[0].value).toBe(100);
  });

  it("stays within 0..100 on a mixed series", () => {
    const closes = [44, 44.3, 44.1, 44.6, 44.4, 44.8, 45.1, 45.4, 45.4, 45.6, 46.2, 46.3, 46.4, 46.2, 46.6, 46.8, 46.4, 46.2];
    const out = rsi(bars(closes), 14);
    expect(out.length).toBe(closes.length - 14);
    for (const p of out) {
      expect(p.value).toBeGreaterThan(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
    // Predominantly rising input should sit in the upper half.
    expect(out[0].value).toBeGreaterThan(50);
  });

  it("returns nothing below the period", () => {
    expect(rsi(bars([1, 2, 3]), 14)).toEqual([]);
  });
});

describe("macd", () => {
  it("aligns the histogram to macd minus signal on shared timestamps", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 50 + Math.sin(i / 4) * 5);
    const m = macd(bars(closes), 12, 26, 9);
    expect(m.macd.length).toBeGreaterThan(0);
    expect(m.histogram.length).toBe(m.signal.length);

    const macdAt = new Map(m.macd.map((p: any) => [p.time, p.value]));
    const sigAt = new Map(m.signal.map((p: any) => [p.time, p.value]));
    for (const h of m.histogram) {
      expect(h.value).toBeCloseTo(macdAt.get(h.time) - sigAt.get(h.time), 10);
    }
  });

  it("degrades to empty series when there aren't enough bars", () => {
    const m = macd(bars([1, 2, 3]), 12, 26, 9);
    expect(m).toEqual({ macd: [], signal: [], histogram: [] });
  });
});
