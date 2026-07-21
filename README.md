# Polyview

A clean, multi-venue analytics terminal for prediction markets — the version of
[TruthTick Terminal](./TEARDOWN_AND_BLUEPRINT.md) worth building. This repo is
**Phase 0**: the live-data recorder and the tick-candle reconstruction engine
that everything else stands on.

> Full competitive teardown, strategy, and naming rationale:
> [`TEARDOWN_AND_BLUEPRINT.md`](./TEARDOWN_AND_BLUEPRINT.md).

## Why Phase 0 is the recorder

The market data is public and free — there is no data moat. The one genuinely
defensible asset is **historical tick-level trade data**, which nobody sells you
after the fact: you only have it if you were recording. So the first thing built
is the thing that should have been running yesterday — a service that connects to
Polymarket's public feed and persists every trade.

## What's here

```
src/
  types.ts              venue-neutral domain types (Polymarket first, Kalshi-ready)
  polymarket/
    rest.ts             Gamma catalogue + CLOB price-history (public, no auth)
    ws.ts               reconnecting public market-channel WebSocket client
  aggregate/
    candles.ts          tick + time candle reconstruction (pure, unit-tested)
  store/
    store.ts            storage interface (swap SQLite → ClickHouse later)
    sqlite.ts           SQLite implementation (WAL, dedup, the tick archive)
  recorder.ts           wires the feed into the store
  server.ts             thin read API — the frontend never hits Polymarket directly
  cli/
    record.ts           run the recorder
    serve.ts            run recorder + API together
test/
  candles.test.ts       OHLCV, tick grouping, and orderflow split
```

Data flow: **Polymarket public WS → normalise → SQLite (trade archive) →
on-demand candle reconstruction → JSON API → (future) clean UI.**

## Run it

```bash
npm install

# Record the 50 busiest markets into polyview.db (Ctrl-C to stop)
npm run record

# Stop automatically after 30s, into a scratch db
RECORD_SECONDS=30 DB_PATH=live.db npm run record

# Record + serve the API together on :3000
npm run serve

# API only, over data already captured
RECORD=0 npm run serve

npm test          # unit tests
npm run build     # type-check + emit to dist/
```

### API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | liveness + total trades recorded |
| `GET /api/markets?limit=100` | catalogue, busiest first |
| `GET /api/book/:tokenId` | latest order-book snapshot |
| `GET /api/candles/:tokenId?type=tick&ticks=50` | tick candles (N trades/candle) |
| `GET /api/candles/:tokenId?type=time&interval=1m` | time candles (`1m,5m,15m,1h,1d`) |

Candles include OHLCV plus `buyVolume` / `sellVolume` / `imbalance` — the
orderflow signal behind footprint charts.

### Verified against the live feed

A 30-second recording of 80 markets captured 55 real trades; the API then
served correct tick candles, 1-minute candles, and a live order book (17 bids /
47 asks) reconstructed from that capture. The WebSocket schemas
(`book`, `price_change`, `last_trade_price`) were confirmed against production.

## What's deliberately not here yet

Phase 0 is the foundation, not the product. Next, in order:

1. **Kalshi source** behind the same `Store` / types → multi-venue + cross-venue arbitrage.
2. **Materialised candle cache** + a push WebSocket to the frontend for live updates.
3. **The clean UI** — chart, order book, orderflow, watchlists.
4. **Validated backtesting** (modeled fills, fees, walk-forward) and the market-wide scanner.
5. **Non-custodial execution** (bring-your-own key).

Non-custodial throughout — Polyview never holds user funds.
