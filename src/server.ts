// Read API over the recorded data. Deliberately thin: the frontend talks to
// this, never directly to Polymarket. Candles are reconstructed on demand from
// stored trades — correct and simple for Phase 0; a materialised-candle cache
// is the obvious later optimisation.

import express from "express";
import { buildTickCandles, buildTimeCandles, orderFlowImbalance } from "./aggregate/candles.js";
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

  app.get("/api/markets", (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    res.json(store.listMarkets({ limit, activeOnly: true }));
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

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
