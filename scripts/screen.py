#!/usr/bin/env python3
"""Walk-forward every strategy in the registry and rank what survives.

This is the "find the best ones" step. It runs each setup through the same
out-of-sample validation, applies the same tradeability filter, and prints a
league table with the survivors at the top.

    # Offline dry run on random-walk data -- everything should be rejected
    python scripts/screen.py --synthetic

    # Against real ES data
    python scripts/screen.py --start 2023-01-01 --end 2024-12-31 --resample 5min

Expect most rows to be rejected. A screen that passes everything is broken.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402

from esbt import strategies  # noqa: E402
from esbt.config import get_instrument  # noqa: E402
from esbt.data import back_adjust, load  # noqa: E402
from esbt.ledger import Ledger, cumulative_noise_floor  # noqa: E402
from esbt.report import format_walk_forward  # noqa: E402
from esbt.synthetic import generate  # noqa: E402
from esbt.engine import _bars_per_year  # noqa: E402
from esbt.walkforward import walk_forward  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Rank ES day-trading strategies out-of-sample")
    p.add_argument("--root", default="ES", choices=["ES", "MES"])
    p.add_argument("--start", default="2023-01-01")
    p.add_argument("--end", default="2024-12-31")
    p.add_argument("--bar", default="1m", choices=["1m", "1h", "1d"])
    p.add_argument("--resample", default="5min")
    p.add_argument("--splits", type=int, default=5)
    p.add_argument("--contracts", type=int, default=1)
    p.add_argument("--max-trades-per-day", type=float, default=4.0)
    p.add_argument("--only", nargs="*", help="restrict to named strategies")
    p.add_argument("--filters", nargs="*", default=[],
                   help="regime filters to gate every strategy with, e.g. volatility_regime trend_day")
    p.add_argument("--no-ledger", action="store_true", help="do not record this run")
    p.add_argument("--synthetic", action="store_true")
    p.add_argument("--detail", action="store_true", help="print the full report for survivors")
    p.add_argument("--budget", type=float, default=0.0)
    args = p.parse_args()

    logging.basicConfig(level=logging.WARNING, format="%(message)s")

    if args.synthetic:
        print("SYNTHETIC random-walk data: no edge exists here by construction.")
        print("Every strategy should be rejected. Anything that passes is a bug.\n")
        df = back_adjust(generate(start=args.start, end=args.end, bar=args.resample))
    else:
        df = load(
            root=args.root,
            start=args.start,
            end=args.end,
            bar=args.bar,
            rth_only=True,
            resample_to=args.resample,
            max_cost_usd=args.budget,
        )

    inst = get_instrument(args.root)
    print(f"{len(df):,} bars  {df.index[0]:%Y-%m-%d} .. {df.index[-1]:%Y-%m-%d}  "
          f"@ {args.resample}  on {inst.root}\n")

    names = args.only or list(strategies.REGISTRY)
    rows, reports = [], {}

    ledger = Ledger.load()
    if not args.no_ledger:
        print(ledger.summary() + "\n")

    for name in names:
        strat = strategies.get(name)
        if args.filters:
            strat = strategies.with_filters(strat, *args.filters)
        t0 = time.time()
        print(f"  running {name:<24}", end="", flush=True)
        try:
            wf = walk_forward(
                df,
                strat,
                inst,
                n_splits=args.splits,
                contracts=args.contracts,
                max_trades_per_day_allowed=args.max_trades_per_day,
            )
        except Exception as exc:
            print(f"  FAILED: {exc}")
            continue

        reports[strat.name] = wf
        d = wf.diagnostics
        rows.append(
            {
                "strategy": strat.name,
                "verdict": wf.verdict(),
                "oos_sharpe": wf.oos_stats.get("sharpe", float("nan")),
                "noise_floor": d.get("noise_floor", float("nan")),
                "margin": wf.oos_stats.get("sharpe", float("nan")) - d.get("noise_floor", 0.0),
                "oos_pnl": wf.oos_stats.get("net_pnl", float("nan")),
                "max_dd": wf.oos_stats.get("max_drawdown", float("nan")),
                "trades_day": d.get("trades_per_day", float("nan")),
                "hold_min": d.get("avg_hold_min", float("nan")),
                "stress": d.get("stress_sharpe", float("nan")),
            }
        )
        print(f"  {time.time() - t0:5.1f}s   {wf.verdict()}")
        if not args.no_ledger:
            ledger.record(
                strategy=strat.name,
                n_combos=d.get("n_trials_per_fold", 0),
                n_folds=max(len(wf.folds), 1),
                data_start=str(df.index[0].date()),
                data_end=str(df.index[-1].date()),
                n_bars=len(df),
                timeframe=args.resample,
                oos_sharpe=wf.oos_stats.get("sharpe", float("nan")),
                verdict=wf.verdict(),
                note="synthetic" if args.synthetic else "",
            )

    if not rows:
        print("\nNothing ran.")
        return 1

    table = pd.DataFrame(rows)
    survivors = table["verdict"] == "SURVIVES"
    table = table.sort_values(["margin"], ascending=False).reset_index(drop=True)

    print("\n" + "=" * 100)
    print("LEAGUE TABLE  (out-of-sample only, sorted by margin over the noise floor)")
    print("=" * 100)
    print(
        table.to_string(
            index=False,
            float_format=lambda x: f"{x:,.2f}",
            columns=["strategy", "verdict", "oos_sharpe", "noise_floor", "margin",
                     "oos_pnl", "max_dd", "trades_day", "hold_min", "stress"],
        )
    )
    print("=" * 100)

    # The bar that matters once you have been iterating: the noise floor computed
    # against every hypothesis this project has recorded, not just this run's.
    if not args.no_ledger:
        ledger.save()
        ppy = _bars_per_year(df.index)
        total = ledger.total_trials()
        cum_floor = cumulative_noise_floor(total, len(df), ppy)
        print(f"\nCumulative search: {total:,} hypotheses recorded to date.")
        print(f"Noise floor against that total: {cum_floor:.2f} Sharpe")
        beat = table[table["oos_sharpe"] > cum_floor]["strategy"].tolist()
        if beat:
            print(f"Clearing it: {', '.join(beat)}")
        else:
            print("Nothing clears it. Every result so far is within what the search"
                  " alone would produce.")

    n_ok = int(survivors.sum())
    if n_ok == 0:
        print("\nNo strategy survived. On random data that is the correct answer.")
        print("On real data it means these setups, as specified, are not tradeable edges.")
    else:
        print(f"\n{n_ok} strategy(ies) survived. Treat that as a hypothesis, not a result:")
        print("re-run on a different date range before risking money on it.")

    if args.detail:
        for name in table.loc[survivors.reindex(table.index, fill_value=False), "strategy"]:
            print("\n" + format_walk_forward(reports[name], title=name))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
