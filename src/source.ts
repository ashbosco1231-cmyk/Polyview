// A market-data source feeds normalised trades and book snapshots into the same
// store and the same live hub, regardless of venue. Polymarket (WebSocket push)
// and Kalshi (REST polling) both implement this, so everything downstream —
// storage, candle reconstruction, the API, the UI — stays venue-agnostic.

import type { BookSnapshot, Trade } from "./types.js";

export type LiveEvent =
  | { kind: "trade"; trade: Trade }
  | { kind: "book"; book: BookSnapshot };

export type LiveListener = (ev: LiveEvent) => void;

export interface MarketDataSource {
  /** Human name for logs (e.g. "polymarket", "kalshi"). */
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  /** Subscribe to the live feed; returns an unsubscribe function. */
  onLive(listener: LiveListener): () => void;
}

/** Shared listener bookkeeping so each source doesn't re-implement it. */
export class LiveEmitter {
  private readonly listeners = new Set<LiveListener>();

  onLive(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: LiveEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a broken listener must never take down ingestion */
      }
    }
  }
}
