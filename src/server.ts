// Read API over the recorded data. Deliberately thin: the frontend talks to
// this, never directly to Polymarket. Candles are reconstructed on demand from
// stored trades — correct and simple for Phase 0; a materialised-candle cache
// is the obvious later optimisation.

import express from "express";
import { buildTickCandles, buildTimeCandles, orderFlowImbalance } from "./aggregate/candles.js";
import { findMatches } from "./crossvenue.js";
import type { Store } from "./store/store.js";

const TIME_INTERVALS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

export function createServer(store: Store) {
  const app = express();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, tradesRecorded: store.countTrades() });
  });

  // Capacity + footprint. The archive is the product, so how fast it grows and
  // what each trade costs to keep are numbers worth being able to read directly
  // rather than infer from a hosting dashboard.
  app.get("/api/stats", (_req, res) => {
    const ticks = store.countTrades();
    const bytes = store.sizeOnDisk();
    const mem = process.memoryUsage();
    res.json({
      ticks,
      diskBytes: bytes,
      diskMB: round(bytes / 1048576, 1),
      bytesPerTick: ticks > 0 ? round(bytes / ticks, 1) : null,
      rssMB: round(mem.rss / 1048576, 1),
      heapUsedMB: round(mem.heapUsed / 1048576, 1),
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get("/api/markets", (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const venue = req.query.venue === "polymarket" || req.query.venue === "kalshi" ? req.query.venue : undefined;
    res.json(store.listMarkets({ limit, activeOnly: true, venue }));
  });

  // Cross-venue candidate matches with spread / consensus / arb edge.
  app.get("/api/cross-venue", (req, res) => {
    const minConfidence = clampFloat(req.query.minConfidence, 0.3, 0, 1);
    const limit = clampInt(req.query.limit, 40, 1, 200);
    const polymarket = store.listMarkets({ venue: "polymarket", activeOnly: true, limit: 500 });
    const kalshi = store.listMarkets({ venue: "kalshi", activeOnly: true, limit: 500 });
    const matches = findMatches(polymarket, kalshi, { minConfidence, limit });
    res.json({
      polymarketMarkets: polymarket.length,
      kalshiMarkets: kalshi.length,
      matches,
      note: "Matches are algorithmic candidates ranked by title similarity; confirm before trading. Arb edge is gross of fees and slippage.",
    });
  });

  // Counterparts: the same question on the *other* venue(s), TradingView-style
  // source switching. Returns the viewed market plus confident matches elsewhere.
  app.get("/api/counterparts/:tokenId", (req, res) => {
    const self = store.findMarketByToken(req.params.tokenId);
    if (!self) return res.status(404).json({ error: "unknown token" });
    const minConfidence = clampFloat(req.query.minConfidence, 0.4, 0, 1);

    const otherVenue = self.venue === "polymarket" ? "kalshi" : "polymarket";
    const others = store.listMarkets({ venue: otherVenue, activeOnly: true, limit: 500 });
    // findMatches always takes (polymarket, kalshi); order the args by venue.
    const matches =
      self.venue === "polymarket"
        ? findMatches([self], others, { minConfidence, limit: 3 })
        : findMatches(others, [self], { minConfidence, limit: 3 });

    const counterparts = matches.map((m) => {
      const other = self.venue === "polymarket" ? m.kalshi : m.polymarket;
      return { venue: otherVenue, tokenId: other.tokenId, question: other.question, confidence: m.confidence, lastPrice: other.yes };
    });
    res.json({
      self: { venue: self.venue, tokenId: req.params.tokenId, question: self.question, lastPrice: self.lastPrice },
      counterparts,
    });
  });

  app.get("/api/trades/:tokenId", (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 2000);
    const trades = store.getTrades({ tokenId: req.params.tokenId, limit });
    res.json(trades.slice().reverse()); // most recent first for a tape
  });

  app.get("/api/book/:tokenId", (req, res) => {
    const book = store.getBook(req.params.tokenId);
    if (!book) return res.status(404).json({ error: "no book snapshot yet for this token" });
    res.json(book);
  });

  // Candles: /api/candles/:tokenId?type=tick&ticks=50
  //          /api/candles/:tokenId?type=time&interval=1m
  app.get("/api/candles/:tokenId", (req, res) => {
    const tokenId = req.params.tokenId;
    const type = req.query.type === "time" ? "time" : "tick";
    const limit = clampInt(req.query.limit, 5000, 1, 50_000);
    const trades = store.getTrades({ tokenId, limit });

    if (trades.length === 0) {
      return res.json({ tokenId, type, candles: [], note: "no trades recorded yet" });
    }

    let candles;
    if (type === "time") {
      const interval = String(req.query.interval ?? "1m");
      const ms = TIME_INTERVALS[interval];
      if (!ms) return res.status(400).json({ error: `unknown interval; use ${Object.keys(TIME_INTERVALS).join(", ")}` });
      candles = buildTimeCandles(trades, ms);
    } else {
      const ticks = clampInt(req.query.ticks, 50, 1, 1000);
      candles = buildTickCandles(trades, ticks);
    }

    res.json({
      tokenId,
      type,
      count: candles.length,
      candles: candles.map((c) => ({ ...c, imbalance: round(orderFlowImbalance(c), 4) })),
    });
  });

  return app;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
