// The recorder: catalogue the busiest markets, subscribe to their tokens, and
// persist every trade + latest book. This is Phase 0's whole point — the sooner
// it runs, the deeper the proprietary tick archive grows.

import { fetchTopMarkets } from "./polymarket/rest.js";
import { PolymarketMarketFeed } from "./polymarket/ws.js";
import type { Store } from "./store/store.js";
import type { BookSnapshot, Trade } from "./types.js";

/** A real-time event for anything downstream that wants the feed as it happens. */
export type LiveEvent =
  | { kind: "trade"; trade: Trade }
  | { kind: "book"; book: BookSnapshot };

export type LiveListener = (ev: LiveEvent) => void;

export interface RecorderOptions {
  /** How many top markets (by 24h volume) to record. */
  marketLimit?: number;
  /** Flush buffered trades to the store at most this often (ms). */
  flushIntervalMs?: number;
  log?: (msg: string) => void;
}

export class Recorder {
  private feed: PolymarketMarketFeed | null = null;
  private buffer: Trade[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private written = 0;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<LiveListener>();

  constructor(
    private readonly store: Store,
    private readonly opts: RecorderOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(`[recorder] ${m}`));
  }

  /** Subscribe to the live feed. Returns an unsubscribe function. */
  onLive(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: LiveEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a broken listener must never take down ingestion */
      }
    }
  }

  async start(): Promise<void> {
    const limit = this.opts.marketLimit ?? 50;
    this.log(`fetching top ${limit} markets…`);
    const markets = await fetchTopMarkets(limit);
    this.store.upsertMarkets(markets);

    const tokenIds = markets.flatMap((m) => m.tokenIds);
    this.log(`recording ${tokenIds.length} tokens across ${markets.length} markets`);

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

    const flushMs = this.opts.flushIntervalMs ?? 2_000;
    this.flushTimer = setInterval(() => this.flush(), flushMs);
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
    this.flush();
  }

  totalWritten(): number {
    return this.written;
  }
}
