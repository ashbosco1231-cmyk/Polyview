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

## Day trading the New York session

The harness is set up for short intraday holds in the US cash session, executed
by hand. Three constraints are enforced by :mod:`esbt.rules` rather than by each
strategy, so every setup is held to the same discipline:

- **Time stop** — exit after N minutes regardless of the signal. A day trade that
  has not worked inside its window is a losing trade that has not been closed yet.
  The holding limit is a *searchable parameter* (10/15/20/30 min by default), so
  the walk-forward picks it rather than you guessing.
- **Entry window** — each strategy only initiates inside its own local-time
  window. Most index intraday edges live in the first two hours; the lunch lull
  is a different regime and blending them averages one into the other.
- **Flat into the bell** — nothing is held past 15:55 ET. Carrying ES overnight
  makes it a different strategy with different risk.

After a forced exit, re-entry is blocked until the signal actually resets.
Without that a persistent signal re-enters on the next bar and the time stop
accomplishes nothing except extra commission.

### The six setups

| Strategy | Mechanism | Entry window (ET) |
|---|---|---|
| `opening_range_breakout` | Break of the first N minutes' range | 09:45–12:00 |
| `opening_drive` | Continuation of the session's first move | 09:35–11:00 |
| `gap_fade` | Fade the overnight gap toward prior close | 09:30–11:00 |
| `prior_day_break` | Break of prior session high/low | 09:30–14:00 |
| `vwap_reversion` | Fade a stretch from session VWAP | 10:00–15:00 |
| `vwap_trend` | Buy pullbacks to a rising VWAP | 10:00–15:00 |

These are six distinct *mechanisms*, not six variations on a moving average.
Six flavours of one idea tested against one dataset produce six correlated
results and a false sense of confirmation. Note that `vwap_reversion` and
`vwap_trend` directly contradict each other — if both "work", the search is
fitting noise.

### Screening them

```bash
# Dry run with no data and no API key -- everything should be rejected
python scripts/screen.py --synthetic

# The real thing
python scripts/screen.py --start 2023-01-01 --end 2024-12-31 --resample 5min
```

This walk-forwards every strategy and prints a league table sorted by margin over
the noise floor. **Tradeability is checked before performance**: a setup firing
nine times a session is rejected outright regardless of its Sharpe, because it is
not something a person can execute.

Reference output on random-walk data, which is what "nothing" looks like:

```
              strategy                      verdict  oos_sharpe  noise_floor  margin  trades_day  hold_min
              gap_fade INDISTINGUISHABLE FROM NOISE        0.49         1.84   -1.35        0.33     15.64
       prior_day_break                         DEAD       -1.55         1.55   -3.09        1.08     14.08
        vwap_reversion                         DEAD       -3.18         1.99   -5.17        2.14     26.52
```

---

## Beating the textbook version: regime filters

The standard setups fail on ES largely because they are applied
*unconditionally*. An opening-range break is a different trade on a quiet
Tuesday than on a CPI morning; fading VWAP is sound on a rotational day and
ruinous on a trend day. Filtering is where an edge beyond common belief actually
lives, so any strategy can be gated by any combination of regime conditions:

| Filter | Condition |
|---|---|
| `volatility_regime` | ATR percentile band, ranked against recent history |
| `opening_range_size` | Today's opening range width vs recent days |
| `trend_day` | Trending vs rotational session, measured causally |
| `gap_size` | Overnight gap size band |
| `minutes_into_session` | Slice of the session |
| `day_of_week` | Weekday restriction (usually a trap) |

```bash
python scripts/screen.py --filters volatility_regime trend_day
```

Filters compose with any strategy and their grids merge into the search, so the
walk-forward optimizes the setup and the conditions together.

**Every filter is strictly causal**, and this is tested rather than asserted.
`trend_day` in particular classifies a session from the running share of bars
that have closed above VWAP — *not* from where the session eventually closed,
which is the canonical intraday lookahead bug and produces magnificent fictional
results. Note that a lookahead filter cheats identically in-sample and
out-of-sample, so walk-forward alone will not catch it; the test suite truncates
the data mid-session and requires the filter's earlier values to be unchanged,
and a deliberately cheating filter is included to prove that probe actually
fires.

### Filters are not free

Each filter multiplies the search space, and the noise floor rises with it.
Adding two filters to a 36-combination grid takes it to 576, which moved the
floor from 1.99 to 2.87 Sharpe in testing. You need a proportionally better
result to claim the same thing.

## The ledger: iterating *is* multiple testing

Adjust a threshold, add a filter, try a different range, re-run. After a
fortnight of that you may have tested twenty thousand variants, and the best one
you have seen is drawn from twenty thousand draws — not from the 216 in your last
command. Judged against the single-run floor it will look convincing.

Every screen appends to `data/ledger.json`, and the cumulative trial count feeds
a second, higher bar:

```
Cumulative search: 3,456 hypotheses recorded to date.
Noise floor against that total: 2.89 Sharpe
Nothing clears it. Every result so far is within what the search alone would produce.
```

It counts only what it is told about, so it is a floor on your true search effort
rather than an exact figure. Nothing here blocks you; it makes the cost of
looking harder visible at the moment you look.

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
  strategies.py   six NY-session day-trade setups and their grids
  rules.py        time stops, entry windows, flat-into-the-bell, trade budgets
  session.py      session VWAP, opening range, prior-day levels, activity stats
  filters.py      causal regime filters and strategy composition
  ledger.py       cumulative record of every hypothesis tested
  walkforward.py  parameter sweep, walk-forward, overfitting diagnostics
  report.py       terminal reporting
  synthetic.py    random-walk data generator for offline calibration
scripts/
  fetch_data.py   price and download data
  optimize.py     run a walk-forward optimization on one strategy
  screen.py       walk-forward every strategy and rank the survivors
tests/            59 tests, focused on what would silently corrupt results
```

```bash
python -m pytest tests/ -q
```

## Not financial advice

The included strategies are there to exercise the harness. Two of them are
near-coin-flips on ES after costs, which is the useful lesson. Nothing here is a
recommendation to trade.
