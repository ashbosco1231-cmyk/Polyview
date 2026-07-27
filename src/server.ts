// Read API over the recorded data. Deliberately thin: the frontend talks to
// this, never directly to Polymarket. Candles are reconstructed on demand from
// stored trades — correct and simple for Phase 0; a materialised-candle cache
// is the obvious later optimisation.

import express from "express";
import { buildTickCandles, buildTimeCandles, orderFlowImbalance } from "./aggregate/candles.js";
import { findMatches } from "./crossvenue.js";
import type { Store } from "./store/store.js";
import type { Candle } from "./types.js";

const TIME_INTERVALS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** Ceiling on ticks read to build one page of candles. */
const MAX_TICKS_PER_PAGE = 200_000;

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

  // Candles.
  //   /api/candles/:tokenId?type=time&interval=1m&count=400[&to=<epoch ms>]
  //   /api/candles/:tokenId?type=tick&ticks=50&count=400
  //
  // Time candles page backwards: `to` is the exclusive right edge of the window,
  // so scrolling left is just a re-request with `to` set to the oldest bar
  // already on screen. `hasMore` says whether anything exists before the page,
  // which is what lets the chart stop asking instead of spinning at the archive
  // boundary.
  app.get("/api/candles/:tokenId", (req, res) => {
    const tokenId = req.params.tokenId;
    const type = req.query.type === "tick" ? "tick" : "time";
    const count = clampInt(req.query.count, 400, 1, 5000);

    if (type === "tick") {
      const ticks = clampInt(req.query.ticks, 50, 1, 1000);
      const trades = store.getTrades({ tokenId, limit: Math.min(ticks * count, MAX_TICKS_PER_PAGE) });
      const candles = buildTickCandles(trades, ticks);
      return res.json({ tokenId, type, ticks, count: candles.length, hasMore: false, candles: candles.map(withFlow) });
    }

    const interval = String(req.query.interval ?? "1m");
    const ms = TIME_INTERVALS[interval];
    if (!ms) {
      return res.status(400).json({ error: `unknown interval; use ${Object.keys(TIME_INTERVALS).join(", ")}` });
    }

    // Default the right edge to now so the first request needs no cursor.
    const requestedTo = clampInt(req.query.to, Date.now(), 0, Number.MAX_SAFE_INTEGER);

    // Anchor the window to the newest print at or before the cursor rather than
    // to the cursor itself. Markets go quiet for stretches far longer than one
    // page, so a fixed-width window can land entirely inside a gap and come back
    // empty while older history still exists — which reads to the chart as "the
    // archive ends here" and strands the user mid-scroll. One indexed lookup
    // skips the gap instead. It also means a stale market opens on its last real
    // bar instead of an empty window.
    const [newest] = store.getTrades({ tokenId, to: requestedTo, limit: 1 });
    const to = newest ? newest.ts + 1 : requestedTo;
    const from = to - count * ms;

    const trades = store.getTrades({ tokenId, from, to, limit: MAX_TICKS_PER_PAGE });
    const candles = buildTimeCandles(trades, ms);

    // One row is enough to know whether scrolling further left is worthwhile.
    const hasMore = store.getTrades({ tokenId, to: from, limit: 1 }).length > 0;

    res.json({
      tokenId,
      type,
      interval,
      from,
      to,
      count: candles.length,
      hasMore,
      candles: candles.map(withFlow),
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

/** Attach the buy/sell split readout the chart's orderflow pane draws from. */
function withFlow(c: Candle) {
  return { ...c, imbalance: round(orderFlowImbalance(c), 4) };
}
