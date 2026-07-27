import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import type { Trade } from "../src/types.js";

function store(): SqliteStore {
  return new SqliteStore(":memory:");
}

function trade(over: Partial<Trade> = {}): Trade {
  return {
    venue: "polymarket",
    tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    market: "0x9dd7b2a3f1e04c8a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2",
    price: 0.512,
    size: 100,
    side: "BUY",
    ts: 1_785_000_000_000,
    txHash: "0x94482d9e7b9678c4d05ee560fc32b0cbbc17f0e70dfa0f11857e393e4c21b8af",
    ...over,
  };
}

describe("tick storage fidelity", () => {
  // The archive is the product: a price or size that changes on the way through
  // storage is corruption we would never notice. These bounds are the real ones
  // measured off both venues' live feeds.
  it("round-trips prices and sizes exactly at the venues' full precision", () => {
    const s = store();
    const cases: Array<{ price: number; size: number }> = [
      { price: 0.001, size: 0.000001 }, // finest of each
      { price: 0.999, size: 90909.09 }, // Kalshi's largest observed size
      { price: 0.5, size: 14616.55 }, // Polymarket's largest observed size
      { price: 0.123, size: 1.234567 }, // 3dp price, 6dp size
      { price: 0.007, size: 29.51 },
    ];
    s.insertTrades(cases.map((c, i) => trade({ ...c, ts: 1_785_000_000_000 + i, txHash: `tx-${i}` })));

    const got = s.getTrades({ tokenId: trade().tokenId });
    expect(got).toHaveLength(cases.length);
    for (let i = 0; i < cases.length; i++) {
      expect(got[i].price).toBe(cases[i].price);
      expect(got[i].size).toBe(cases[i].size);
    }
    s.close();
  });

  it("preserves venue, token, market and side across the interning round-trip", () => {
    const s = store();
    const pm = trade({ side: "SELL" });
    const k = trade({
      venue: "kalshi",
      tokenId: "KXTESTMATCH-26JUL251100PAKWI-WI",
      market: "KXTESTMATCH-26JUL251100PAKWI-WI",
      txHash: "e00b04fb-c5f4-44f4-85d9-6a1e8f099fc7",
    });
    s.insertTrades([pm, k]);

    const [gotPm] = s.getTrades({ tokenId: pm.tokenId });
    const [gotK] = s.getTrades({ tokenId: k.tokenId });
    expect({ ...gotPm, txHash: pm.txHash }).toEqual(pm);
    expect({ ...gotK, txHash: k.txHash }).toEqual(k);
    s.close();
  });

  it("rejects a re-broadcast of the same fill", () => {
    const s = store();
    expect(s.insertTrades([trade()])).toBe(1);
    expect(s.insertTrades([trade()])).toBe(0); // websocket reconnect replays it
    expect(s.countTrades()).toBe(1);
    s.close();
  });

  it("keeps two distinct fills that collide on token, millisecond, price and size", () => {
    // The case a (tok, ts, price, size) key would silently swallow: two separate
    // prints of the same size at the same price in the same millisecond are real
    // volume, not a duplicate. Only the venue's own trade id separates them.
    const s = store();
    const written = s.insertTrades([trade({ txHash: "fill-a" }), trade({ txHash: "fill-b" })]);
    expect(written).toBe(2);
    expect(s.getTrades({ tokenId: trade().tokenId })).toHaveLength(2);
    s.close();
  });

  it("returns a token's trades oldest-first, honouring range and limit", () => {
    const s = store();
    const base = 1_785_000_000_000;
    s.insertTrades(
      [0, 1, 2, 3, 4].map((i) => trade({ ts: base + i * 60_000, price: 0.1 + i / 100, txHash: `t${i}` })),
    );

    const all = s.getTrades({ tokenId: trade().tokenId });
    expect(all.map((t) => t.ts)).toEqual([0, 1, 2, 3, 4].map((i) => base + i * 60_000));

    const windowed = s.getTrades({ tokenId: trade().tokenId, from: base + 60_000, to: base + 180_000 });
    expect(windowed.map((t) => t.ts)).toEqual([base + 60_000, base + 120_000]);

    // A limit keeps the most recent rows, still handed back ascending.
    const recent = s.getTrades({ tokenId: trade().tokenId, limit: 2 });
    expect(recent.map((t) => t.ts)).toEqual([base + 180_000, base + 240_000]);
    s.close();
  });

  it("keeps different venues' trades separate even for identical token ids", () => {
    const s = store();
    s.insertTrades([
      trade({ venue: "polymarket", tokenId: "SHARED", market: "pm-market", price: 0.4, txHash: "a" }),
      trade({ venue: "kalshi", tokenId: "SHARED-K", market: "k-market", price: 0.6, txHash: "b" }),
    ]);
    expect(s.getTrades({ tokenId: "SHARED" })[0].venue).toBe("polymarket");
    expect(s.getTrades({ tokenId: "SHARED-K" })[0].venue).toBe("kalshi");
    s.close();
  });

  it("reports an empty result for a token it has never seen", () => {
    const s = store();
    expect(s.getTrades({ tokenId: "nope" })).toEqual([]);
    s.close();
  });
});
