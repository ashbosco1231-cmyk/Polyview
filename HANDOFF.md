# SHARPLINE — PROJECT HANDOFF / CONTEXT

_Last updated: 2026-07-27. Supersedes the previous handoff._

## WHAT THIS IS
Sharpline is a multi-venue analytics terminal for prediction markets — "TradingView
for prediction markets." It started as a competitive teardown of a small competitor,
truthtickterminal.com (TruthTick Terminal), which we decided to build better and
rename. "Sharpline" = a "sharp" is a pro bettor; a "line" is both the odds and the
chart. Product goal: one clean terminal that charts prediction markets across venues
(Polymarket + Kalshi), lets you compare the same question across venues, and — the
long-term moat — records tick-level trade history 24/7 for backtesting (nobody sells
historical tick data after the fact).

## REPO / GIT
- GitHub repo: `ashbosco1231-cmyk/Polyview` (still named for the old working title;
  the product is "Sharpline". Fine to leave the repo name.)
- ACTIVE BRANCH: `claude/sharpline-terminal` <-- do all work here, push here
- A stale branch `claude/truthtickterminal-analysis-bela27` exists on the remote;
  ignore it / delete via GitHub UI.
- No open PR.
- GOTCHA: `git commit` hangs on a git hook. Commit with:
  `git -c core.hooksPath=/dev/null commit -m "..."`

## LOCAL DEV ENVIRONMENT (READ THIS FIRST)
The repo is cloned at **`/Users/ab2/Sharpline`** on Ashton's Mac. GitHub SSH auth
works (key `~/.ssh/id_ed25519`, user `ashbosco1231-cmyk`).

**There is no Homebrew and `node` is NOT on PATH.** Node 22.23.1 exists only under
nvm at `~/.nvm/versions/node/v22.23.1/bin`. Running `npm` directly fails with
`env: node: No such file or directory` (npm's shebang is `#!/usr/bin/env node`).

Use the repo's `./run.sh` launcher for every node/npm command. It prepends the nvm
bin dir to PATH and `cd`s to the repo root, so it works from any directory:

    ./run.sh npm install
    ./run.sh npm test          # 33 vitest tests
    ./run.sh npm run build     # typecheck (tsc, no emit needed to run)
    ./run.sh npm run serve     # records both venues + serves UI/API on :3000

`run.sh` is gitignored (machine-specific absolute path). If it is missing, recreate:

    #!/bin/zsh
    export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
    cd "${0:A:h}"
    exec "$@"

**Dev-server launch config** lives at `/Users/ab2/.claude/launch.json` (NOT in the
repo) — it is read from the primary working directory `/Users/ab2`. It contains two
entries: `life-calendar` (a different project — do not remove) and `sharpline`.

## STACK
TypeScript + Node (MUST run on Node 20+), better-sqlite3, express, ws, tsx (runs TS
directly, no build step), vitest. Frontend is vanilla HTML/CSS/JS in `web/` — no
framework, no bundler, no build step. ES modules load natively via
`<script type="module">`.

## ARCHITECTURE (venue-neutral by design)
- `src/types.ts` — domain types; every record carries a `venue` tag
- `src/source.ts` — MarketDataSource interface + LiveEmitter (both venues implement)
- `src/polymarket/ws.ts` — Polymarket public WebSocket client
- `src/polymarket/rest.ts` — Gamma catalogue + CLOB price history
- `src/kalshi/rest.ts` — Kalshi public REST client
- `src/kalshi/source.ts` — Kalshi source: KEYLESS polling (global trades feed + hot
  ticker books); seeds ~800 open markets at startup
- `src/recorder.ts` — Polymarket source: WS feed -> store + live bus; catalogue
  refresh (~20min) + re-subscribe
- `src/aggregate/candles.ts` — tick candles (N trades/candle) + time candles +
  orderflow (buy/sell split). Pure, unit-tested.
- `src/store/store.ts` + `sqlite.ts` — Store interface + SQLite impl (see STORAGE)
- `src/live.ts` — LiveHub: browser WS at `/live`, multi-token subscribe per client
- `src/server.ts` — REST API (express)
- `src/crossvenue.ts` — cross-venue matching (title similarity + confidence) +
  spread/consensus/arb math. Pure, unit-tested.
- `src/cli/serve.ts` — MAIN entry (`npm run serve` / `npm start`)
- `src/cli/record.ts` — headless recorder only (`npm run record`)
- `web/index.html`, `style.css`, `app.js`, `chart.js`, `indicators.js`,
  `favicon.svg`, `vendor/lightweight-charts.js` — the terminal UI
- `TEARDOWN_AND_BLUEPRINT.md` + `teardown.html` — competitive analysis / product plan
- `Dockerfile`, `docker-compose.yml`, `fly.toml`, `railway.json`, `DEPLOY.md`

## STORAGE ARCHITECTURE (rewritten 2026-07-27 — commit `a447d1e`)

### Why it changed
The tick table is the only thing that grows without bound (every other table is an
upsert keyed by token or market, so it plateaus). Measured against real recorded
data, the old schema cost **297 bytes per trade**, and at ~50 prints/sec across both
venues that is ~4.3M rows/day = **~1.2 GB/day**. The Railway volume is 5 GB and was
already 2 GB full — roughly **two days from writes failing and the archive dying**.

The indexes cost more per trade than the row they pointed at. For Kalshi,
`token_id` and `market` are byte-identical, so the same 31-char string was stored
four times per trade (twice in the row, twice more across the two indexes). The
36-char dedup UUID was stored twice and never read back for anything.

### Current schema

```sql
CREATE TABLE tokens (
  id       INTEGER PRIMARY KEY,
  venue    TEXT NOT NULL,
  token_id TEXT NOT NULL,
  market   TEXT NOT NULL,
  UNIQUE (venue, token_id)
);
CREATE INDEX idx_tokens_token ON tokens (token_id);  -- reads arrive without a venue

CREATE TABLE ticks (
  tok   INTEGER NOT NULL,   -- FK -> tokens.id
  ts    INTEGER NOT NULL,   -- epoch ms
  dedup INTEGER NOT NULL,   -- 32-bit FNV-1a of `${txHash}|${price}|${size}|${side}`
  px    INTEGER NOT NULL,   -- price * 1_000_000
  sz    INTEGER NOT NULL,   -- size  * 1_000_000
  side  INTEGER NOT NULL,   -- 1 = BUY, 0 = SELL
  PRIMARY KEY (tok, ts, dedup)
) WITHOUT ROWID;
```

Three ideas do the work:
1. **Token interning** — `venue`/`token_id`/`market` live once in `tokens`; each tick
   keeps a small integer reference. Both maps are warmed into memory at startup, so
   neither the read nor the write path does a lookup.
2. **Fixed-point integers** — live data carries at most 3 decimals of price and 6 of
   size, so a 1e6 scale is exact for both. SQLite varint-encodes small integers in
   1–3 bytes where every REAL costs a flat 8.
3. **`WITHOUT ROWID` clustered on `(tok, ts, dedup)`** — that one B-tree *is* the
   storage, the dedup constraint, AND the index range queries walk. There are no
   secondary indexes on `ticks` at all.

**Result: 297 -> 29.3 B/trade (10.1x). 1.19 -> 0.12 GB/day. Volume life 4 -> 42 days.**
Verified by migrating all 73,871 real recorded trades and comparing every field of
every trade against the original: **identical**.

### Things to know
- **`txHash` is no longer retained.** It was only ever a dedup key (grep confirmed
  nothing read it back) and cost more per row than the trade itself. `getTrades()`
  returns `txHash: ""`. The 32-bit dedup width is deliberate: because the key is
  `(tok, ts, dedup)`, two hashes are only ever compared when their trades share a
  token AND a millisecond, so collision odds are ~2.3e-10 per pair.
- **`countTrades()` is cached in memory.** Both recorders logged a running total
  after every flush — that was a `COUNT(*)` full scan of the largest table every two
  seconds.
- **Migration**: `store.migrateLegacyTrades(log)` is async, idempotent, and folds any
  pre-existing `trades` table into `ticks`. It yields to the event loop between 20k
  batches (better-sqlite3 is synchronous; without yields the server accepts
  connections and answers none, which looks exactly like a hang). Then it drops the
  legacy table and VACUUMs. **`SKIP_VACUUM=1`** skips the one blocking compaction
  step — freed pages get reused either way, the file just won't shrink.
- It is called from `serve.ts`'s `boot()` **after `http.listen()`** and **before**
  the sources start.

## FRONTEND ARCHITECTURE (rewritten 2026-07-27 — commit `b1e0990`)

The old chart was a hand-rolled canvas. It could not be polished into what was
wanted: it had **no viewport concept** (`slot = plotW / n` crushed every candle into
the visible width, so there was nothing to pan or zoom and no way to see back), and
it reserved 34px at the bottom for a time axis that it then **never drew**.

Rendering is now **TradingView's own `lightweight-charts` v5.2.0** (Apache-2.0),
vendored as a single 192 KB standalone file at `web/vendor/lightweight-charts.js`,
which keeps the no-build-step setup. It exposes the global `window.LightweightCharts`.

- `web/indicators.js` — pure ES module, no chart/DOM knowledge: `sma`, `ema`, `vwap`
  (resets at UTC day), `bollinger`, `rsi` (Wilder-smoothed), `macd`. Each takes
  `[{time, open, high, low, close, volume}]` and returns `[{time, value}]`. Leading
  undefined bars are omitted, never emitted as zero.
- `web/chart.js` — `PriceChart` class + exported `INDICATORS` list. Owns panes,
  indicator wiring, cents formatting, live trade folding, compare overlay, and
  history paging.
- `web/app.js` — app wiring (watchlist, book, tape, source switch, cross-venue).

### lightweight-charts v5 API notes (v4 tutorials will mislead you)
- `LC.createChart(el, opts)` — use `autoSize: true`.
- `chart.addSeries(LC.CandlestickSeries, opts, paneIndex)`. **Not** `addCandlestickSeries()`
  (that's the v4 API). Series definitions: `CandlestickSeries`, `LineSeries`,
  `HistogramSeries`, `AreaSeries`, `BaselineSeries`, `BarSeries`.
- **Pane sizing: use `pane.setStretchFactor(n)` on EVERY pane.** Calling
  `setHeight()` on a single pane leaves the others at their default stretch factor of
  1 — this caused a real bug where the volume strip claimed 431px of a 490px chart
  and squeezed price to 30px with a zero-height bitmap, so nothing drew at all.
  Current weights: `[100, 18, 26]` for price / volume / oscillator.
- `time` must be **seconds** (UTCTimestamp), strictly ascending, no duplicates. Tick
  candles can close several bars inside one second, so `normalise()` nudges
  collisions forward by a second.

## DATA SOURCES (all FREE + PUBLIC, no API keys)
**Polymarket**
- Gamma: `https://gamma-api.polymarket.com/markets` (catalogue; `clobTokenIds` is a
  JSON *string* of the outcome token ids; `lastTradePrice`/`outcomePrices` for price)
- CLOB: `https://clob.polymarket.com` (`/book`, `/prices-history`, `/last-trade-price`)
- Public WS: `wss://ws-subscriptions-clob.polymarket.com/ws/market` — subscribe with
  `{type:"market", assets_ids:[...tokenIds]}`. Message types: `book` (snapshot),
  `price_change` (batched deltas), `last_trade_price` (a fill: asset_id, price, size,
  side, timestamp, transaction_hash). No auth.

**Kalshi**
- Base: `https://api.elections.kalshi.com/trade-api/v2` (public, no auth for market data)
- `/markets?status=open` — fields use `_dollars` strings 0..1 for price, `count_fp`/
  `volume_fp` for size
- `/markets/trades?limit=N` = GLOBAL recent trades across ALL markets (newest first);
  we poll this every 2s and dedup. Fields: `yes_price_dollars`, `count_fp`,
  `taker_side` ("yes" => BUY of YES, "no" => SELL), `created_time`, `trade_id`, `ticker`.
  **Note: this returns `+100` on nearly every poll, i.e. we are polling at the page
  limit and are probably losing trades between polls.** Worth investigating.
- `/markets/{ticker}/orderbook` returns **BIDS ONLY**: `orderbook_fp.yes_dollars`
  (YES bids) and `no_dollars` (NO bids). A NO bid at price p == a YES ASK at (1 - p).
  We reconstruct the YES book that way.
- `/markets/{ticker}` — single market metadata.
- Kalshi's LIVE WebSocket requires a signed handshake (API key), so we DO NOT use it.
  One ticker == one binary market, so ticker is the token id.

## API ENDPOINTS (`src/server.ts`)
- `GET /api/health` -> `{ok, tradesRecorded}`
- `GET /api/stats` -> `{ticks, diskBytes, diskMB, bytesPerTick, rssMB, heapUsedMB, uptimeSec}`
  — capacity/footprint, so growth is measurable instead of inferred from a dashboard
- `GET /api/markets?limit=&venue=` -> catalogue (venue filter optional)
- `GET /api/book/:tokenId` -> latest order-book snapshot
- `GET /api/trades/:tokenId?limit=` -> recent trades (newest first)
- `GET /api/candles/:tokenId?type=time&interval=1m|5m|15m|1h|4h|1d&count=400&to=<ms>`
  -> `{tokenId, type, interval, from, to, count, hasMore, candles:[...]}`
  Candles carry `{start, end, open, high, low, close, volume, buyVolume, sellVolume,
  trades, imbalance}`.
  **Paging:** `to` is the exclusive right edge, so scrolling left is a re-request with
  `to` set to the oldest bar on screen. `hasMore` tells the chart when to stop asking.
  The window **anchors to the newest print at or before the cursor**, not to the
  cursor itself — markets go quiet for stretches longer than one page, and a fixed
  window can land entirely inside a gap, return zero bars, and strand the chart while
  older history still exists. Verified against a real 20-minute dead zone: paging
  jumps 03:46 -> 03:28 and terminates cleanly at the archive boundary, no overlaps.
- `GET /api/candles/:tokenId?type=tick&ticks=50&count=400` (tick candles don't page)
- `GET /api/cross-venue?minConfidence=&limit=` -> candidate matches w/ spread/consensus/arb
- `GET /api/counterparts/:tokenId` -> same question on the other venue(s)

## WHAT'S BUILT
0. Recorder + tick-candle engine (records every trade to SQLite = the archive)
1. Live terminal UI: candlestick chart, depth order book, live trade tape, orderflow
   readout; real-time via `/live` push WebSocket
2. Multi-venue: Kalshi alongside Polymarket, venue filter tabs, venue badges
3. Cross-Venue view: same question on both venues w/ spread, consensus, arbitrage
   edge; similarity-ranked CANDIDATES w/ confidence (honest framing — not confirmed
   arb, because venues word events differently)
4. Unified symbols: on a matched market a SOURCE switcher appears (Polymarket /
   Kalshi w/ price + match confidence); a COMPARE toggle overlays both venues' price
   lines
5. **Storage rewrite** (10.1x smaller ticks) — see STORAGE ARCHITECTURE
6. **Real charting engine + redesign** — pan/zoom/scroll-back, real time axis,
   crosshair with OHLC legend, stacked panes, six indicators, market filter, logo,
   neutral near-black theme with tabular numerics

**Tests: 33** (`candles` 7, `crossvenue` 6, `store` 7, `indicators` 13).
Storage tests assert exact round-trip at the venues' real precision bounds and that
two distinct fills sharing token+ms+price+size are both kept (a naive key would
silently swallow one). Indicator tests check against hand-worked values.

## DEPLOYMENT STATUS (Railway)
- Deployed using the Dockerfile (`railway.json` pins `builder=DOCKERFILE`).
- Env vars set: `DB_PATH=/data/sharpline.db`, `MARKET_LIMIT=80`.
- Persistent Railway VOLUME mounted at `/data` — CONFIRMED WORKING (data survives
  redeploys).
- App listens on `process.env.PORT` (Railway injects 8080).

### OPEN ITEMS — DO THESE
1. **REDEPLOY to pick up the storage rewrite.** The migration runs automatically on
   boot and is idempotent, but the live instance is still on the old schema and still
   burning ~1.2 GB/day against a 5 GB volume that was ~2 GB full. If the deploy times
   out during compaction, set `SKIP_VACUUM=1`.
2. **UNVERIFIED: does the public domain load?** A previous session hit "Application
   failed to respond" because the domain's target port didn't match the app's actual
   port (8080). The fix is a Railway UI setting (set the public domain's target port
   to 8080, or delete+regenerate the domain so it auto-detects). Ashton was applying
   this, but **it was never confirmed working.** Check first.

## GOTCHAS (keep these true)
1. Node 20 has NO global WebSocket (only 21+). `src/polymarket/ws.ts` MUST
   `import WebSocket from "ws"` — do not rely on the global.
2. Do NOT hard-code PORT in the Dockerfile; the app reads `process.env.PORT`
   (default 3000 local). Hosts inject their own and route to it.
3. `serve.ts` must call `http.listen()` BEFORE awaiting source startup or the
   migration. Sources fetch hundreds of markets (seconds) and the migration walks the
   whole archive (minutes) — blocking the port on either means a health check hits a
   dead port = "application failed to respond".
4. Railway's Docker builder REJECTS the Dockerfile `VOLUME` instruction — removed;
   we `mkdir -p /data` and attach the volume via the Railway UI.
5. Railway needs a package.json `start` script + `railway.json {build:{builder:DOCKERFILE}}`.
6. `git commit` hangs on a hook — use `git -c core.hooksPath=/dev/null commit ...`
7. **No node on PATH on this Mac — use `./run.sh` for every node/npm command.**
8. **`tsx` does NOT hot-reload.** After editing anything in `src/`, restart the server
   or you will test stale code (this cost real time once).
9. **lightweight-charts pane sizing: `setStretchFactor` on every pane, never
   `setHeight` on one.**
10. `launch.json` is read from `/Users/ab2`, not the repo.

## NEXT STEPS / TODO (priority order)

1. **COLD TIER STORAGE — the real answer to "store vastly more."**
   The schema rewrite bought 10x (42 days of volume). The next 10-20x is rolling
   ticks older than ~7 days into compressed per-token-per-day columnar blobs:
   delta-encoded timestamps + repeated prices gzip extremely well (gzip is in Node
   stdlib, no new dependency). The read path would check the hot `ticks` table first
   and fall back to inflating a cold blob.
   **Be honest about the ceiling:** schema + cold tier gets ~100x total. Ashton asked
   for "hundreds of thousands of times" — no encoding achieves that on real trade
   data. Past ~100x it stops being a format problem and becomes a "move cold data to
   S3/R2 object storage" problem, which is cheaper per byte anyway. That is a
   deliberate architectural decision to put to him, not to assume.

2. **CANDIDATE-LEVEL MATCH PRECISION** (was #1 before storage became urgent; still open)
   The matcher pairs on title similarity, so a binary "Will Rodri win the Ballon
   d'Or?" (Polymarket) pairs with a generic multi-outcome "Who will win the Ballon
   d'Or?" (Kalshi) whose shown price is for a DIFFERENT candidate. The arb/divergence
   numbers are therefore **indicative, not exact**. Fix: match the specific
   candidate/outcome inside Kalshi multi-outcome markets. This makes both the
   Cross-Venue table and the Compare overlay actually trustworthy.

3. **BOOK-BASED ARB** — compute edge from executable best bid/ask plus each venue's
   fees, instead of last-trade prices.

4. **KALSHI POLL SATURATION** — `/markets/trades?limit=100` returns `+100` on nearly
   every 2s poll, which means we're at the page limit and likely dropping trades. For
   an archive that sells completeness, this matters. Investigate paging with a cursor
   or a shorter interval.

5. **FOOTPRINT / ORDERFLOW CHART** — buy/sell split is already stored per candle.

6. **VALIDATED BACKTESTING** (modeled fills, fees, walk-forward) + market-wide scanner.

7. **NON-CUSTODIAL ONE-CLICK EXECUTION** (bring-your-own key). Stay non-custodial always.

### Chart/UX ideas worth considering
- Drawing tools (trendlines, horizontal levels) — lightweight-charts supports custom
  series/primitives for this
- More chart types: line, area, Heikin-Ashi
- Price alerts (the live socket already exists)
- Saved layouts + user watchlists
- Server-side market search across the whole catalogue (the filter box currently only
  filters the ~150 markets already loaded)
- Materialized candles — `/api/candles` currently rebuilds from raw ticks on every
  request. Fine now; the obvious optimization when the archive is large.

## STARTING INSTRUCTION FOR THE NEW CHAT
Read this file, then the repo at `/Users/ab2/Sharpline` on branch
`claude/sharpline-terminal`. Use `./run.sh` for all node/npm commands. Confirm the
two OPEN ITEMS under DEPLOYMENT STATUS (redeploy for the storage migration; verify
the public domain actually loads) before starting new work — then continue with the
TODO list above.
