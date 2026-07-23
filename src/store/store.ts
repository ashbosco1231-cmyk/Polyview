// Storage layer.
//
// Phase 0 uses SQLite: zero infrastructure, real persistence, and it captures
// the tick-level trade archive from day one — which is the one genuinely
// defensible asset here (nobody sells you historical tick data after the fact).
// Everything goes through the `Store` interface so the same recorder and API
// can later point at ClickHouse / TimescaleDB without changing callers.

import type { BookSnapshot, MarketMeta, Trade, Venue } from "../types.js";

export interface TradeQuery {
  tokenId: string;
  /** Inclusive lower bound, epoch ms. */
  from?: number;
  /** Exclusive upper bound, epoch ms. */
  to?: number;
  /** Max rows, most-recent-first is applied then re-sorted ascending. */
  limit?: number;
}

export interface Store {
  /** Insert trades, ignoring exact duplicates. Returns count actually written. */
  insertTrades(trades: Trade[]): number;
  /** Trades for a token, ordered ascending by time. */
  getTrades(q: TradeQuery): Trade[];
  /** Upsert the latest book snapshot for a token. */
  putBook(book: BookSnapshot): void;
  /** Latest known book snapshot for a token, if any. */
  getBook(tokenId: string): BookSnapshot | null;
  /** Upsert market catalogue entries. */
  upsertMarkets(markets: MarketMeta[]): void;
  /** List catalogue entries, most 24h volume first. */
  listMarkets(opts?: { limit?: number; activeOnly?: boolean; venue?: Venue }): MarketMeta[];
  /** The catalogue entry that owns a given outcome token, if any. */
  findMarketByToken(tokenId: string): MarketMeta | null;
  /** Total trades recorded (for status / proof of capture). */
  countTrades(): number;
  /** Force the write-ahead log into the main db file (durability on restart). */
  checkpoint(): void;
  close(): void;
}
