// Kalshi market-data source (keyless, polling).
//
// Kalshi's live socket needs a signed handshake, so we poll public REST instead:
// one global trades call surfaces every fresh print across the exchange, which
// we de-duplicate, store, and emit live — exactly the same LiveEvent shape the
// Polymarket recorder produces. Books for recently-active tickers are refreshed
// on a slower cadence so whatever a user is watching stays current.

import { fetchMarket, fetchOpenMarkets, fetchOrderbook, fetchRecentTrades } from "./rest.js";
import { LiveEmitter, type LiveListener, type MarketDataSource } from "../source.js";
import type { Store } from "../store/store.js";
import type { Trade } from "../types.js";

export interface KalshiOptions {
  /** How often to poll the global trades feed (ms). */
  tradePollMs?: number;
  /** How often to refresh order books for hot tickers (ms). */
  bookPollMs?: number;
  /** Max hot tickers to keep books fresh for. */
  hotTickers?: number;
  /** How many open markets to seed the catalogue with at startup. */
  catalogueSize?: number;
  log?: (msg: string) => void;
}

export class KalshiSource implements MarketDataSource {
  readonly name = "kalshi";
  private readonly emitter = new LiveEmitter();
  private readonly log: (msg: string) => void;
  private tradeTimer: ReturnType<typeof setInterval> | null = null;
  private bookTimer: ReturnType<typeof setInterval> | null = null;

  private readonly seen = new Set<string>(); // trade_ids already processed
  private readonly knownMarkets = new Set<string>(); // tickers we've catalogued
  private readonly hot: string[] = []; // recently active tickers, most recent first
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly opts: KalshiOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(`[kalshi] ${m}`));
  }

  onLive(listener: LiveListener): () => void {
    return this.emitter.onLive(listener);
  }

  async start(): Promise<void> {
    this.running = true;
    // Seed the catalogue so the watchlist and cross-venue matcher have breadth
    // immediately, not just markets that trade during the session.
    try {
      const seed = await fetchOpenMarkets(this.opts.catalogueSize ?? 800);
      this.store.upsertMarkets(seed);
      for (const m of seed) this.knownMarkets.add(m.market);
      this.log(`seeded ${seed.length} open markets`);
    } catch (e) {
      this.log(`catalogue seed failed: ${(e as Error).message}`);
    }
    this.log("polling public trades feed…");
    await this.pollTrades();
    this.tradeTimer = setInterval(() => this.pollTrades(), this.opts.tradePollMs ?? 2_000);
    this.bookTimer = setInterval(() => this.pollBooks(), this.opts.bookPollMs ?? 4_000);
  }

  stop(): void {
    this.running = false;
    if (this.tradeTimer) clearInterval(this.tradeTimer);
    if (this.bookTimer) clearInterval(this.bookTimer);
  }

  private async pollTrades(): Promise<void> {
    if (!this.running) return;
    let trades: Trade[];
    try {
      trades = await fetchRecentTrades(100);
    } catch (e) {
      this.log(`trades poll failed: ${(e as Error).message}`);
      return;
    }
    // Newest-first; keep only ones we haven't emitted before.
    const fresh: Trade[] = [];
    for (const t of trades) {
      if (this.seen.has(t.txHash)) continue;
      this.seen.add(t.txHash);
      fresh.push(t);
    }
    if (this.seen.size > 20_000) this.trimSeen();
    if (fresh.length === 0) return;

    this.store.insertTrades(fresh);
    for (const t of fresh) {
      this.emitter.emit({ kind: "trade", trade: t });
      this.markHot(t.tokenId);
    }
    void this.catalogueNew(fresh);
    this.log(`+${fresh.length} trades (total ${this.store.countTrades()})`);
  }

  /** Fetch + store metadata for tickers we haven't seen before. */
  private async catalogueNew(trades: Trade[]): Promise<void> {
    const tickers = [...new Set(trades.map((t) => t.tokenId))].filter((t) => !this.knownMarkets.has(t));
    for (const ticker of tickers) {
      this.knownMarkets.add(ticker); // mark first so we don't refetch on failure
      const meta = await fetchMarket(ticker);
      if (meta) this.store.upsertMarkets([meta]);
    }
  }

  private markHot(ticker: string): void {
    const i = this.hot.indexOf(ticker);
    if (i !== -1) this.hot.splice(i, 1);
    this.hot.unshift(ticker);
    const cap = this.opts.hotTickers ?? 20;
    if (this.hot.length > cap) this.hot.length = cap;
  }

  private async pollBooks(): Promise<void> {
    if (!this.running || this.hot.length === 0) return;
    // Refresh the books of the most-recently-active tickers.
    const targets = this.hot.slice(0, this.opts.hotTickers ?? 20);
    for (const ticker of targets) {
      try {
        const book = await fetchOrderbook(ticker);
        this.store.putBook(book);
        this.emitter.emit({ kind: "book", book });
      } catch {
        /* transient; try again next cycle */
      }
    }
  }

  private trimSeen(): void {
    // Cheap bounded eviction: drop the oldest half. Re-seeing an evicted trade
    // is harmless — the store's unique index still rejects the duplicate.
    let drop = this.seen.size - 10_000;
    for (const id of this.seen) {
      if (drop-- <= 0) break;
      this.seen.delete(id);
    }
  }
}
