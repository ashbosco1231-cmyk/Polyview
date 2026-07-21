// Polymarket public market-channel WebSocket client.
//
// wss://ws-subscriptions-clob.polymarket.com/ws/market — no auth. You subscribe
// with outcome-token ids and receive three message shapes (confirmed live):
//
//   book              full snapshot: { asset_id, market, ts, bids[], asks[] }
//   price_change      batched deltas: { market, price_changes: [{ asset_id, price, size, side, best_bid, best_ask }] }
//   last_trade_price  a fill:        { asset_id, market, price, size, side, ts, transaction_hash }
//
// This client normalises those into typed callbacks and reconnects with
// exponential backoff. It also sends a periodic ping so idle connections on
// quiet markets don't get culled.

import type { BookLevel, BookSnapshot, Trade } from "../types.js";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface IngestHandlers {
  onTrade?: (t: Trade) => void;
  onBook?: (b: BookSnapshot) => void;
  onStatus?: (s: string) => void;
}

export class PolymarketMarketFeed {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 1_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tokenIds: string[],
    private readonly handlers: IngestHandlers,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private status(s: string): void {
    this.handlers.onStatus?.(s);
  }

  private connect(): void {
    this.status(`connecting (${this.tokenIds.length} tokens)`);
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = 1_000;
      this.status("connected");
      ws.send(JSON.stringify({ type: "market", assets_ids: this.tokenIds }));
      // Keep-alive: Polymarket drops idle sockets after ~30s of silence.
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
    });

    ws.addEventListener("message", (ev) => this.handleMessage(String((ev as MessageEvent).data)));

    ws.addEventListener("error", () => this.status("socket error"));

    ws.addEventListener("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closed) return;
      this.status(`disconnected — retrying in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  private handleMessage(raw: string): void {
    if (raw === "PONG" || raw === "") return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const msg of messages) this.route(msg as Record<string, unknown>);
  }

  private route(msg: Record<string, unknown>): void {
    // Trades carry an explicit event_type.
    if (msg["event_type"] === "last_trade_price") {
      const t = this.toTrade(msg);
      if (t) this.handlers.onTrade?.(t);
      return;
    }
    // Book snapshots have bids/asks.
    if (Array.isArray(msg["bids"]) || Array.isArray(msg["asks"])) {
      const b = this.toBook(msg);
      if (b) this.handlers.onBook?.(b);
      return;
    }
    // price_change batches carry best bid/ask movement; we surface the implied
    // trades' venue side but rely on last_trade_price for the print archive.
    // (Intentionally not treated as trades to avoid double-counting.)
  }

  private toTrade(msg: Record<string, unknown>): Trade | null {
    const price = Number(msg["price"]);
    const size = Number(msg["size"]);
    const tokenId = String(msg["asset_id"] ?? "");
    if (!tokenId || !Number.isFinite(price) || !Number.isFinite(size)) return null;
    return {
      venue: "polymarket",
      tokenId,
      market: String(msg["market"] ?? ""),
      price,
      size,
      side: msg["side"] === "SELL" ? "SELL" : "BUY",
      ts: Number(msg["timestamp"]) || Date.now(),
      txHash: String(msg["transaction_hash"] ?? ""),
    };
  }

  private toBook(msg: Record<string, unknown>): BookSnapshot | null {
    const tokenId = String(msg["asset_id"] ?? "");
    if (!tokenId) return null;
    return {
      venue: "polymarket",
      tokenId,
      market: String(msg["market"] ?? ""),
      ts: Number(msg["timestamp"]) || Date.now(),
      bids: toLevels(msg["bids"]),
      asks: toLevels(msg["asks"]),
    };
  }
}

function toLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({ price: Number((l as any).price), size: Number((l as any).size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
}
