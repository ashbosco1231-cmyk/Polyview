// Kalshi public REST client.
//
// Base: https://api.elections.kalshi.com/trade-api/v2 (public market data, no
// auth — only trading needs keys). Kalshi's live WebSocket *does* require a
// signed handshake, so for a keyless build we poll two public endpoints:
//   GET /markets/trades?limit=N        recent trades across ALL markets
//   GET /markets/{ticker}/orderbook    current book for one market
//   GET /markets/{ticker}              market metadata
//
// Schema notes (the current "_dollars / _fp" variant):
//   - prices are decimal-dollar strings 0..1 (yes_price_dollars = "0.0160")
//   - sizes are decimal strings (count_fp = "290.69")
//   - the book returns BIDS ONLY: yes_dollars are YES bids; no_dollars are NO
//     bids, and a NO bid at p is economically a YES ask at (1 - p).
//   - one ticker == one binary market, so ticker doubles as our token id.

import type { BookLevel, BookSnapshot, MarketMeta, Trade } from "../types.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

/** Recent trades across all markets, newest first. */
export async function fetchRecentTrades(limit = 100): Promise<Trade[]> {
  const data = await getJson(`${BASE}/markets/trades?limit=${limit}`);
  const trades = (data?.trades ?? []) as any[];
  return trades.map((t): Trade => ({
    venue: "kalshi",
    tokenId: String(t.ticker),
    market: String(t.ticker),
    price: num(t.yes_price_dollars),
    size: num(t.count_fp),
    // Taker bought YES => aggressive buy of the YES token; taker bought NO =>
    // aggressive sell of YES.
    side: t.taker_side === "yes" ? "BUY" : "SELL",
    ts: Date.parse(t.created_time) || Date.now(),
    txHash: String(t.trade_id),
  }));
}

/** Current YES-side order book, reconstructed from Kalshi's bids-only response. */
export async function fetchOrderbook(ticker: string): Promise<BookSnapshot> {
  const data = await getJson(`${BASE}/markets/${encodeURIComponent(ticker)}/orderbook?depth=10`);
  const ob = data?.orderbook_fp ?? data?.orderbook ?? {};
  const yesDollars = (ob.yes_dollars ?? ob.yes ?? []) as Array<[string, string]>;
  const noDollars = (ob.no_dollars ?? ob.no ?? []) as Array<[string, string]>;

  const bids: BookLevel[] = yesDollars
    .map(([p, s]) => ({ price: num(p), size: num(s) }))
    .sort((a, b) => b.price - a.price);
  // NO bid at p == YES ask at (1 - p).
  const asks: BookLevel[] = noDollars
    .map(([p, s]) => ({ price: 1 - num(p), size: num(s) }))
    .sort((a, b) => a.price - b.price);

  return { venue: "kalshi", tokenId: ticker, market: ticker, ts: Date.now(), bids, asks };
}

/** Market metadata for one ticker. */
export async function fetchMarket(ticker: string): Promise<MarketMeta | null> {
  try {
    const data = await getJson(`${BASE}/markets/${encodeURIComponent(ticker)}`);
    const m = data?.market;
    if (!m) return null;
    const question = cleanTitle(m.title, m.yes_sub_title, ticker);
    return {
      venue: "kalshi",
      market: String(m.ticker),
      question,
      slug: String(m.ticker),
      category: m.category ?? null,
      tokenIds: [String(m.ticker)],
      active: m.status === "active",
      closed: m.status === "closed" || m.status === "settled",
      volume24hr: num(m.volume_24h_fp) || null,
      lastPrice: num(m.last_price_dollars) || null,
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// Kalshi titles are occasionally empty or machine-concatenated; fall back
// sensibly so the watchlist never shows a blank row.
function cleanTitle(title: unknown, sub: unknown, ticker: string): string {
  const t = typeof title === "string" ? title.trim() : "";
  if (t && t.length < 120 && !t.includes(",yes")) return t;
  const s = typeof sub === "string" ? sub.trim() : "";
  if (s) return s;
  return t || ticker;
}
