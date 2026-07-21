import { describe, expect, it } from "vitest";
import { findMatches, scoreMatch, tokenize } from "../src/crossvenue.js";
import type { MarketMeta } from "../src/types.js";

function mkt(over: Partial<MarketMeta>): MarketMeta {
  return {
    venue: "polymarket",
    market: over.market ?? "m",
    question: over.question ?? "",
    slug: "s",
    category: over.category ?? null,
    tokenIds: over.tokenIds ?? ["tok"],
    active: true,
    closed: false,
    volume24hr: over.volume24hr ?? null,
    lastPrice: over.lastPrice ?? null,
    updatedAt: 0,
    ...over,
  };
}

describe("tokenize", () => {
  it("drops boilerplate and keeps signal words + numbers", () => {
    const t = tokenize("Will the Fed decrease interest rates by 25 bps after the July 2026 meeting?");
    expect(t.has("fed")).toBe(true);
    expect(t.has("25")).toBe(true);
    expect(t.has("2026")).toBe(true);
    expect(t.has("will")).toBe(false); // stopword
    expect(t.has("the")).toBe(false);
  });
});

describe("scoreMatch", () => {
  it("scores same-event titles higher than unrelated ones", () => {
    const pmFed = mkt({ question: "Will the Fed decrease interest rates by 25 bps in 2026?" });
    const kFed = mkt({ venue: "kalshi", question: "Fed decreases rates 25 bps in 2026?" });
    const kTennis = mkt({ venue: "kalshi", question: "Will Sara Bejlek win the Round Of 32 match?" });
    expect(scoreMatch(pmFed, kFed).confidence).toBeGreaterThan(scoreMatch(pmFed, kTennis).confidence);
    expect(scoreMatch(pmFed, kFed).sharedTokens).toEqual(expect.arrayContaining(["fed", "rates", "25", "2026"]));
  });
});

describe("findMatches", () => {
  const pm = [
    mkt({ market: "pm-fed", question: "Will the Fed decrease interest rates by 25 bps in 2026?", lastPrice: 0.40, volume24hr: 1000 }),
    mkt({ market: "pm-lol", question: "LoL: Gen.G vs T1 KeSPA Cup", lastPrice: 0.5 }),
  ];
  const kalshi = [
    mkt({ venue: "kalshi", market: "k-fed", question: "Fed decreases interest rates 25 bps in 2026?", lastPrice: 0.46, volume24hr: 3000 }),
    mkt({ venue: "kalshi", market: "k-weather", question: "High temp in Chicago 86 degrees?", lastPrice: 0.3 }),
  ];

  it("pairs the Fed markets and computes spread, consensus, arb", () => {
    const matches = findMatches(pm, kalshi, { minConfidence: 0.2 });
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.polymarket.market).toBe("pm-fed");
    expect(m.kalshi.market).toBe("k-fed");
    expect(m.spread).toBeCloseTo(0.06); // 0.46 - 0.40
    expect(m.arbEdge).toBeCloseTo(0.06);
    // YES cheaper on Polymarket (0.40 < 0.46) => buy YES there.
    expect(m.arbDirection).toBe("buy-yes-polymarket");
    // Volume-weighted consensus leans toward the higher-volume Kalshi price.
    expect(m.consensus!).toBeGreaterThan(0.43);
    expect(m.consensus!).toBeLessThan(0.46);
  });

  it("does not flag arbitrage below the threshold", () => {
    const near = findMatches(
      [mkt({ market: "pm", question: "Fed cuts rates 25 bps 2026", lastPrice: 0.45 })],
      [mkt({ venue: "kalshi", market: "k", question: "Fed cuts rates 25 bps 2026", lastPrice: 0.455 })],
      { minConfidence: 0.2, arbThreshold: 0.02 },
    );
    expect(near[0]!.arbDirection).toBe("none");
  });

  it("claims each market at most once (greedy best-first)", () => {
    const matches = findMatches(pm, kalshi, { minConfidence: 0.2 });
    const pmIds = matches.map((m) => m.polymarket.market);
    expect(new Set(pmIds).size).toBe(pmIds.length);
  });

  it("leaves prices null when a side hasn't traded", () => {
    const matches = findMatches(
      [mkt({ market: "pm", question: "Fed cuts rates 25 bps 2026", lastPrice: null })],
      [mkt({ venue: "kalshi", market: "k", question: "Fed cuts rates 25 bps 2026", lastPrice: 0.5 })],
      { minConfidence: 0.2 },
    );
    expect(matches[0]!.spread).toBeNull();
    expect(matches[0]!.arbDirection).toBe("none");
  });
});
