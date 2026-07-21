# Sharpline

A clean, multi-venue analytics terminal for prediction markets — the version of
[TruthTick Terminal](./TEARDOWN_AND_BLUEPRINT.md) worth building. (A *sharp* is a
professional bettor; a *line* is both the odds and the chart. Naming rationale in
the [blueprint](./TEARDOWN_AND_BLUEPRINT.md#5-a-better-name).)

> The GitHub repo is still named `Polyview` — the original working title. The
> product is **Sharpline**.

- **Phase 0** — the live-data recorder + tick-candle reconstruction engine.
- **Phase 1** — the terminal UI: a live chart, order book, and trade tape that
  update in real time over a push WebSocket. Run `npm run serve` and open
  `http://localhost:3000`.
- **Phase 2 (multi-venue)** — **Kalshi** alongside Polymarket, behind the same
  store, types, and live hub. Filter the watchlist by venue; the cross-venue
  arbitrage / consensus view is the next build on top of this.

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
  types.ts              venue-neutral domain types (a `venue` tag on every record)
  source.ts             MarketDataSource interface + live event bus (both venues)
  polymarket/
    rest.ts             Gamma catalogue + CLOB price-history (public, no auth)
    ws.ts               reconnecting public market-channel WebSocket client
  kalshi/
    rest.ts             public REST client (trades / orderbook / market, no auth)
    source.ts           keyless polling source: global trades feed + hot-ticker books
  aggregate/
    candles.ts          tick + time candle reconstruction (pure, unit-tested)
  store/
    store.ts            storage interface (swap SQLite → ClickHouse later)
    sqlite.ts           SQLite implementation (WAL, dedup, the tick archive)
  recorder.ts           Polymarket source: WS feed → store + live bus
  live.ts               push hub: fans trades/book to subscribed frontend clients
  server.ts             thin read API — the frontend never hits a venue directly
  cli/
    record.ts           run the Polymarket recorder standalone
    serve.ts            run both venues + API + UI + live push together
web/
  index.html style.css app.js   the terminal UI (vanilla, no build step)
test/
  candles.test.ts       OHLCV, tick grouping, and orderflow split
```

Data flow: **Polymarket WS + Kalshi REST polling → normalise (one `venue`-tagged
shape) → SQLite (trade archive) → on-demand candle reconstruction → JSON API +
live push socket → terminal UI.**

Adding a venue means implementing one `MarketDataSource` — nothing downstream
(store, candles, API, UI) changes. Polymarket pushes over WebSocket; Kalshi's
live socket needs a signed handshake, so that source polls Kalshi's *public*
REST (a single global trades call surfaces every fresh print exchange-wide) and
reconstructs the YES book from Kalshi's bids-only response (a NO bid at *p* is a
YES ask at *1 − p*).

## The terminal

`npm run serve` records live *and* serves the UI on `http://localhost:3000`:
a venue-filterable watchlist (Polymarket + Kalshi, with live prices), a canvas
candlestick chart (tick or time candles, with a volume histogram and orderflow
readout), a depth-laddered order book, and a live trade tape. Everything ticks
in real time — the page holds one WebSocket, subscribes to the market you're
viewing, and receives that token's prints the instant a source sees them.

## Run it

```bash
npm install

# Record the 50 busiest markets into sharpline.db (Ctrl-C to stop)
npm run record

# Stop automatically after 30s, into a scratch db
RECORD_SECONDS=30 DB_PATH=live.db npm run record

# Record + serve the API together on :3000
npm run serve

# API only, over data already captured
RECORD=0 npm run serve

# Pick venues (both on by default)
KALSHI=0 npm run serve        # Polymarket only
POLYMARKET=0 npm run serve    # Kalshi only

npm test          # unit tests
npm run build     # type-check + emit to dist/
```

### API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | liveness + total trades recorded |
| `GET /api/markets?limit=100&venue=kalshi` | catalogue, busiest first; optional `venue` filter |
| `GET /api/book/:tokenId` | latest order-book snapshot |
| `GET /api/candles/:tokenId?type=tick&ticks=50` | tick candles (N trades/candle) |
| `GET /api/candles/:tokenId?type=time&interval=1m` | time candles (`1m,5m,15m,1h,1d`) |

Candles include OHLCV plus `buyVolume` / `sellVolume` / `imbalance` — the
orderflow signal behind footprint charts.

### Verified against the live feed

Both venues have been run live: a ~40s multi-venue session recorded **2,458
Kalshi + 90 Polymarket trades** and auto-catalogued 425 Kalshi markets from the
trade feed. The UI rendered both venues with working filters, live tapes, and a
correctly reconstructed Kalshi YES book (asks derived from NO bids). Polymarket
WebSocket schemas (`book`, `price_change`, `last_trade_price`) and Kalshi's
`_dollars`/`_fp` REST schema were confirmed against production.

## What's deliberately not here yet

Phases 0–2 are the foundation, the live terminal, and multi-venue. Next, in order:

1. **Cross-venue view** — now that both venues share one store, surface the same
   real-world question across Polymarket and Kalshi side by side: consensus odds
   and an arbitrage finder. This is the thing no single-venue tool can do.
2. **Materialised candle cache** — reconstructing from raw trades per request is
   fine now; precompute once markets get deep.
3. **Orderflow / footprint chart** — the buy/sell split is already stored per
   candle; render it as a proper footprint.
4. **Validated backtesting** (modeled fills, fees, walk-forward) and the market-wide scanner.
5. **Non-custodial execution** (bring-your-own key).

Non-custodial throughout — Sharpline never holds user funds.
