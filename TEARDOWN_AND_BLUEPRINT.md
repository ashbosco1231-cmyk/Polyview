# Polyview — TruthTick Terminal Teardown & Product Blueprint

*A competitive teardown of [truthtickterminal.com](https://truthtickterminal.com) and a plan to do it better.*

---

## 1. What TruthTick actually is

TruthTick ("TruthTick Terminal") is a **read-only charting and analytics layer on top of Polymarket** — marketed as "the terminal for prediction markets" and, in its own words, "TradingView for prediction markets." It does **not** hold funds, execute trades, or affiliate with Polymarket. Users still place trades on Polymarket itself.

### How it works (mechanics)

1. **Data layer.** Reads Polymarket's *public* data — order book, executed-trade history, and market metadata — across **20,000+ markets**. Independent, unaffiliated, non-custodial, read-only.
2. **Reconstruction.** Aggregates raw executed trades into **OHLC candlesticks** and **tick candles** — a candle per *N executed trades* rather than per fixed time window. This suits prediction markets' bursty, uneven activity far better than time candles.
3. **Analytics.** TradingView-style **technical indicators**, **orderflow / footprint charts** (buy vs. sell volume at each price level), and **volume profile**.
4. **Pro backtesting.** Users write strategy logic in **TypeScript** against historical trade data. A **scanner runs a strategy across all 20,000+ markets in under three minutes, ranked by net P&L**.
5. **No execution.** Explicitly a research/analysis tool. "Trade execution still happens on Polymarket itself." Automation is "planned, not live." Kalshi is "on the roadmap," not live.
6. **Business model.** Freemium. **Free**: charts, live trades, built-in indicators, email/Google login, no credit card. **Pro — $19.99/mo**: custom indicators + strategy backtesting.

### Inferred architecture

WebSocket ingest for live trades + order book, REST for history → time-series store → candle-aggregation service → canvas/lightweight-charts frontend → sandboxed TypeScript backtest runner + batch market-wide scanner.

---

## 2. Strong points — **KEEP THESE**

| # | Strength | Why it matters |
|---|----------|----------------|
| 1 | **Legible positioning** — "TradingView for prediction markets" | Instantly understood by the target user; no explanation needed. |
| 2 | **Tick candles** | Genuinely the right primitive for bursty markets. Smart and defensible. |
| 3 | **Orderflow / footprint + volume profile** | Real professional tooling that Polymarket's native UI does not provide. |
| 4 | **Market-wide scanner ranked by P&L** | The actual moat. Turns a charting toy into an *edge-finding engine*. |
| 5 | **Freemium, no credit card** | Low-friction acquisition; the free tier is a genuine hook. |
| 6 | **Non-custodial / read-only / unaffiliated** | No custody of funds → minimal regulatory and legal surface. A major de-risker. **Do not give this up.** |

---

## 3. Weak points — **KILL OR FIX THESE**

1. **Brand collision + baggage.** "Truth Terminal" is already a well-known AI/crypto entity (Andy Ayrey's viral bot). "TruthTickTerminal" is confusing, three words long, awkward to type, and "truth" is politically loaded. → **Rebrand** (see §5).
2. **Polymarket-only.** Narrows the market and — worse — forfeits the single richest source of edge: **cross-venue** pricing (Polymarket vs. Kalshi) for arbitrage and consensus odds. → **Multi-venue early.**
3. **No execution.** "Research tool — go trade somewhere else" breaks the workflow and betrays the word *terminal*. Competitors (Kalshi Pro, predic.tools) execute. → **Non-custodial one-click execution** (bring-your-own API key / wallet).
4. **Backtesting gated behind writing TypeScript.** Locks the killer feature to people who can code — most bettors can't and won't. → **No-code visual strategy builder + natural-language / AI strategies**; keep TypeScript as a power-user escape hatch.
5. **The scanner invites overfitting.** Ranking 20,000 strategies by P&L is a multiple-comparisons machine — the top result is frequently noise. Reconstructed OHLC also ignores slippage, liquidity, and fees, so backtests overstate returns. → **Model fills/fees/liquidity; walk-forward + out-of-sample validation; explicit overfit warnings and a confidence score.** (This rigor is itself a trust differentiator.)
6. **Unverifiable "zero delay" claims.** Reconstructed feeds can lag; the claim is unprovable. → **Show data freshness / latency transparently.**
7. **No alerts, no mobile.** Sharps live on alerts (odds swings, mispricing, whale prints) and on their phones. Both absent. → **Alerting engine + mobile / PWA.**
8. **No smart-money tracking or copy signals.** Among the most-used features in the prediction-market tool ecosystem. Missing. → **Whale tracker + copy/signal feed** (public wallets, leaderboards).
9. **Thin free→pro ladder.** Flat $19.99 with fuzzy gating. → **Clearer tiers + usage metering** on the expensive features (scanner runs).

---

## 4. The better product — blueprint

**Positioning:** *The professional analytics **and execution** terminal for prediction markets — across venues.* Not just charting; the whole loop, from signal to fill.

**Keep** (from TruthTick): tick candles, orderflow/footprint, volume profile, live feeds, the market-wide scanner, the non-custodial stance, freemium.

**Add / fix:**

- **Multi-venue** (Polymarket + Kalshi) → unified market view, a **cross-venue arbitrage finder**, and **consensus odds**.
- **Non-custodial one-click execution** (BYO key/wallet) → completes the terminal.
- **No-code + AI strategy builder** with rigorous validation (slippage, fees, walk-forward, overfit/confidence scoring).
- **Alerts** (mispricing, odds swings, whale prints, resolution deadlines) + **mobile/PWA**.
- **Smart-money tracking + copy signals** (public wallets, leaderboards).
- **Transparent data** (visible latency/freshness indicators).

### Phased roadmap

- **Phase 1 — MVP (Free):** Polymarket OHLC + tick charts, orderflow, volume profile, live trades, watchlists, basic alerts.
- **Phase 2 — Pro:** No-code strategy builder + *validated* backtesting + market-wide scanner. Non-custodial one-click execution on Polymarket.
- **Phase 3 — Multi-venue:** Kalshi integration → cross-venue arbitrage + consensus odds. Whale tracking + copy signals. Mobile/PWA.
- **Phase 4 — Automation:** Strategy automation, public API, team/workspace features.

### Business model (better tiers)

| Tier | Price | Includes |
|------|-------|----------|
| **Free** | $0 | Charts, live data, one venue, basic alerts, limited watchlists |
| **Pro** | ~$19–29/mo | All indicators, orderflow, unlimited alerts, validated backtesting (metered scanner runs), multi-venue |
| **Edge** | ~$79+/mo | Market-wide scanner at scale, whale tracking, execution automation, API |

Non-custodial at every tier — **never hold user funds.**

### Risks & mitigations

- **Regulatory** (US prediction-market law is contested) → stay read-only + BYO-key, no custody, clear "not financial advice," geofence execution features where needed.
- **Data ToS** (Polymarket/Kalshi API terms) → use official/public APIs within their terms.
- **Backtest credibility** → validation rigor (above); turn it into a trust asset, not a liability.

---

## 5. A better name

**Problem with "TruthTick Terminal":** collides with the famous "Truth Terminal" crypto-AI bot, is three words, is hard to type, and carries loaded "truth" connotations.

**Recommendation: `Sharpline`**

- **"Sharp"** is the trade term for a professional, informed bettor — *exactly* the target user, and it echoes the existing "trade like a pro" pitch without the political baggage.
- **"Line"** is both the betting line and the chart line.
- One word, ownable, easy to say and type, **platform-agnostic** (works for Polymarket *and* Kalshi), and no brand collision.

**Alternates:**

| Name | Angle |
|------|-------|
| **Oddscope** | Odds + scope — analytical, scannable, neutral. |
| **Edgewire** | "Edge" (the trader's edge) + "wire" (a live feed). |
| **Vane** | Weathervane — reads which way the market is turning. Short, modern, brandable. |

*(The repo is currently named `Polyview`, which is fine as a working title but is Polymarket-specific — it undercuts the multi-venue strategy. Prefer a platform-agnostic name.)*

---

*Sources: truthtickterminal.com (home + FAQ), predic.tools, Kalshi Pro, and the prediction-market tooling ecosystem (Oddpool, Predly, aarora4/Awesome-Prediction-Market-Tools).*
