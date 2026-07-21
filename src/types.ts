// Core domain types for Polyview.
//
// These are venue-neutral on purpose: Polymarket is the first source, but the
// same shapes are meant to hold Kalshi (and anything else) later. A `venue`
// tag rides along on every record so multi-venue queries never get ambiguous.

export type Venue = "polymarket" | "kalshi";

export type Side = "BUY" | "SELL";

/** A single executed trade — the atom everything else is reconstructed from. */
export interface Trade {
  venue: Venue;
  /** Outcome token this trade is on (Polymarket CLOB token id / Kalshi ticker). */
  tokenId: string;
  /** Parent market identifier (Polymarket conditionId / Kalshi event). */
  market: string;
  /** Price in probability terms, 0..1. */
  price: number;
  /** Size in shares/contracts. */
  size: number;
  side: Side;
  /** Unix epoch milliseconds. */
  ts: number;
  /** On-chain / venue transaction reference, used for de-duplication. */
  txHash: string;
}

/** One side of the book at a price level. */
export interface BookLevel {
  price: number;
  size: number;
}

/** A point-in-time order book snapshot for a single token. */
export interface BookSnapshot {
  venue: Venue;
  tokenId: string;
  market: string;
  ts: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/** Market catalogue entry (from Polymarket Gamma / Kalshi markets list). */
export interface MarketMeta {
  venue: Venue;
  /** Stable market id (conditionId / event ticker). */
  market: string;
  question: string;
  slug: string;
  category: string | null;
  /** Outcome token ids that trade under this market. */
  tokenIds: string[];
  active: boolean;
  closed: boolean;
  volume24hr: number | null;
  /** Last traded price of the primary (first) outcome token, 0..1. */
  lastPrice: number | null;
  updatedAt: number;
}

/**
 * A reconstructed candle. Works for both time candles (fixed duration) and
 * tick candles (fixed trade count) — `start`/`end` are the time bounds the
 * candle actually spans in either case, and `trades` is how many prints it
 * aggregates.
 */
export interface Candle {
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Total traded size. */
  volume: number;
  /** Size that lifted the ask (aggressive buys). */
  buyVolume: number;
  /** Size that hit the bid (aggressive sells). */
  sellVolume: number;
  /** Number of prints in this candle. */
  trades: number;
}
