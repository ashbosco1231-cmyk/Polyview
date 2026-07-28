# esbt — a free ES futures backtesting harness

A Python harness for building and testing intraday strategies on CME equity index
futures (ES / MES), using real exchange data from Databento.

It is built around one uncomfortable idea: **a fast optimizer is an efficient
machine for manufacturing false confidence.** If you evaluate 500 parameter
combinations against one price series and keep the best, you get a great-looking
equity curve whether or not any edge exists, because the maximum of 500 noisy
estimates is large by construction. Everything here exists to answer a single
question — *is this result distinguishable from what luck would have produced,
given how hard I looked?*

The harness is designed to say "no" convincingly.

---

## Why not TradingView

For this specific job, TradingView's free tier blocks exactly what you need:

| | TradingView Free | esbt |
|---|---|---|
| Backtest history | ~5,000 bars | all the data you fetch |
| Deep backtesting | Premium only | yes |
| Parameter optimization | not available on free | yes, thousands of combos |
| Walk-forward validation | no | yes |
| Cost per run | — | free after data |

Pine Script is a fine language and TradingView is a fine charting product. It is
just the wrong tool for systematic parameter research on a budget.

---

## Setup

```bash
pip install -r requirements.txt
export DATABENTO_API_KEY=db-xxxxxxxxxxxxxxxxxxxx
```

New Databento accounts include free credits, which goes a long way on OHLCV bars.
The key is only ever read from the environment, never from a file.

## Try it with no API key and no data

Everything except the download runs offline against generated random-walk data:

```bash
python scripts/optimize.py --strategy ma_crossover --synthetic
```

This is worth doing before anything else. The synthetic series contains **no edge
by construction**, so it shows you what "nothing" looks like coming out of this
harness — which is the reference point for judging a real result.

## Fetch real ES data

Every download is priced before it runs, and nothing is spent without an explicit
budget:

```bash
# Estimate only, spends nothing
python scripts/fetch_data.py --start 2023-01-01 --end 2024-01-01 --bar 1m

# Download, allowing up to $5
python scripts/fetch_data.py --start 2023-01-01 --end 2024-01-01 --bar 1m --budget 5
```

Results are cached to Parquet in `data/`, so you pay for a date range once.

## Run a walk-forward optimization

```bash
python scripts/optimize.py --strategy rsi_reversion \
    --start 2023-01-01 --end 2024-12-31 --resample 15min --splits 5
```

---

## What the harness refuses to let you do

**Look ahead.** A strategy emits a target position from information available at
each bar's *close*. The engine shifts that by one bar and fills at the *next
bar's open*. There is no code path where a decision can consult a price it could
not have seen. This is enforced once, in the engine, rather than trusted to every
strategy — see `TestNoLookahead`.

**Ignore the roll.** Databento's continuous contracts (`ES.v.0`) stitch contracts
together but do **not** price-adjust across the roll — adjusted continuous
contracts are still an open item on their roadmap. Raw, the series contains a
step change of several index points four times a year, and a trend strategy will
happily "profit" from those steps. `back_adjust()` removes them by measuring the
gap at each contract change. This is the single most effective way to fool
yourself on futures data.

**Trade for free.** ES is 0.25 pt/tick at $12.50/tick ($50/point). Commission and
a full tick of slippage are charged on every contract, on entry and on exit. The
report shows `cost drag` — the share of gross profit consumed by frictions.
Above ~50% means you are mostly trading for your broker.

**Believe an in-sample number.** `sweep()` prints a warning that the best row in
its own table is the most overfit row in its own table. The only equity curve the
report treats as real is the stitched out-of-sample one from `walk_forward()`.

---

## The four diagnostics

Reported on every walk-forward run, roughly in order of how often they kill a
strategy:

1. **Noise floor** — the annualized Sharpe expected from the luckiest of N random
   trials (Bailey & López de Prado's expected-maximum estimator). It *rises* with
   the number of combinations you try: looking harder means you need stronger
   evidence, not weaker. If your out-of-sample Sharpe doesn't clear it, you found
   nothing.
2. **IS→OOS decay** — how much of the in-sample edge survived contact with unseen
   data. Above ~70% is a fitting artifact.
3. **Plateau, not peak** — the fraction of neighbouring grid points that are also
   profitable. Robust parameters have profitable neighbours; an isolated spike
   surrounded by losers will not survive live.
4. **Cost sensitivity** — the winner replayed at double slippage. Real edges
   degrade; imaginary ones invert.

The `VERDICT` line collapses these into one of: `SURVIVES`, `DEAD`,
`INDISTINGUISHABLE FROM NOISE`, `FRAGILE`, or `OVERFIT`.

Expect `SURVIVES` to be rare. That is the harness working, not the harness broken.

---

## Known limitations

These are deliberate, and you should know about them before trusting a number.

- **No intrabar stops.** Accounting is open-to-open. Modelling a stop-loss on
  OHLC bars requires guessing whether the high or the low came first, and the
  optimistic guess is exactly the error that makes backtests look profitable.
  If you need stop-level precision, fetch finer bars.
- **Back-adjustment absorbs one bar of real move.** The roll gap is measured as
  the close-to-close change across the contract change, which also contains that
  bar's genuine move. Correcting this properly needs both contracts quoted
  simultaneously. The residual is a few points against a roll gap of ~12, so it
  is small, but it is not zero.
- **RTH only by default.** ES trades nearly 24h, but overnight books are thin and
  backtests that fill at 3am midpoints are fiction. Pass `rth_only=False` if you
  genuinely want the overnight session.
- **Fills assume you get the open.** For 1-2 contracts on ES this is reasonable.
  It stops being reasonable as size grows.
- **Single contract, no position sizing or portfolio logic.**

## Layout

```
esbt/
  config.py       contract specs and cost models (ES, MES)
  data.py         Databento loader, cost gating, caching, back-adjustment
  engine.py       vectorized backtest core; lookahead impossible by construction
  strategies.py   starter signal generators and their parameter grids
  walkforward.py  parameter sweep, walk-forward, overfitting diagnostics
  report.py       terminal reporting
  synthetic.py    random-walk data generator for offline calibration
scripts/
  fetch_data.py   price and download data
  optimize.py     run a walk-forward optimization
tests/            20 tests, focused on what would silently corrupt results
```

```bash
python -m pytest tests/ -q
```

## Not financial advice

The included strategies are there to exercise the harness. Two of them are
near-coin-flips on ES after costs, which is the useful lesson. Nothing here is a
recommendation to trade.
