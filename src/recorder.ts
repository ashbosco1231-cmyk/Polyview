// The recorder: catalogue the busiest markets, subscribe to their tokens, and
// persist every trade + latest book. This is Phase 0's whole point — the sooner
// it runs, the deeper the proprietary tick archive grows.

import { fetchTopMarkets } from "./polymarket/rest.js";
import { PolymarketMarketFeed } from "./polymarket/ws.js";
import { LiveEmitter, type LiveEvent, type LiveListener, type MarketDataSource } from "./source.js";
import type { Store } from "./store/store.js";
import type { Trade } from "./types.js";

// Re-exported for existing importers.
export type { LiveEvent, LiveListener } from "./source.js";

export interface RecorderOptions {
  /** How many top markets (by 24h volume) to record a live WS feed for. */
  marketLimit?: number;
  /** How many markets to catalogue (>= marketLimit) for the watchlist / matcher. */
  catalogueSize?: number;
  /** Flush buffered trades to the store at most this often (ms). */
  flushIntervalMs?: number;
  /** Re-fetch the catalogue and re-point the feed this often (ms). */
  refreshIntervalMs?: number;
  log?: (msg: string) => void;
}

export class Recorder implements MarketDataSource {
  readonly name = "polymarket";
  private feed: PolymarketMarketFeed | null = null;
  private buffer: Trade[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private subscribedKey = "";
  private written = 0;
  private readonly log: (msg: string) => void;
  private readonly emitter = new LiveEmitter();

  constructor(
    private readonly store: Store,
    private readonly opts: RecorderOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(`[recorder] ${m}`));
  }

  onLive(listener: LiveListener): () => void {
    return this.emitter.onLive(listener);
  }

  private emit(ev: LiveEvent): void {
    this.emitter.emit(ev);
  }

  async start(): Promise<void> {
    await this.refreshMarkets(); // catalogue + initial subscription

    const flushMs = this.opts.flushIntervalMs ?? 2_000;
    this.flushTimer = setInterval(() => this.flush(), flushMs);

    // Over a long run, markets resolve and new ones list. Periodically re-fetch
    // the catalogue and re-point the feed at the current busiest markets, so the
    // recorder keeps capturing live activity instead of dead resolved markets.
    const refreshMs = this.opts.refreshIntervalMs ?? 20 * 60_000;
    this.refreshTimer = setInterval(() => {
      this.refreshMarkets().catch((e) => this.log(`refresh failed: ${(e as Error).message}`));
    }, refreshMs);
  }

  /** (Re)fetch the catalogue and (re)subscribe the feed if the token set changed. */
  private async refreshMarkets(): Promise<void> {
    const limit = this.opts.marketLimit ?? 50;
    // Catalogue more markets than we record trades for, so the watchlist and the
    // cross-venue matcher see breadth; only the busiest slice gets a live WS feed.
    const catalogueSize = Math.max(limit, this.opts.catalogueSize ?? 100);
    const markets = await fetchTopMarkets(catalogueSize);
    this.store.upsertMarkets(markets);

    const recorded = markets.slice(0, limit);
    const tokenIds = recorded.flatMap((m) => m.tokenIds);

    // Skip a needless reconnect if the recorded set is unchanged.
    const key = tokenIds.join(",");
    if (key === this.subscribedKey && this.feed) return;
    this.subscribedKey = key;

    this.feed?.stop();
    this.log(`recording ${tokenIds.length} tokens across ${recorded.length} of ${markets.length} markets`);
    this.feed = new PolymarketMarketFeed(tokenIds, {
      onTrade: (t) => {
        this.buffer.push(t); // durable archive, flushed in batches
        this.emit({ kind: "trade", trade: t }); // live, immediate
      },
      onBook: (b) => {
        this.store.putBook(b);
        this.emit({ kind: "book", book: b });
      },
      onStatus: (s) => this.log(s),
    });
    this.feed.start();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const n = this.store.insertTrades(batch);
    this.written += n;
    if (n > 0) this.log(`+${n} trades (total ${this.store.countTrades()})`);
  }

  stop(): void {
    this.feed?.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.flush();
  }

  totalWritten(): number {
    return this.written;
  }
}
