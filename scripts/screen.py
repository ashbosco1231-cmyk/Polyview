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
from esbt.report import format_walk_forward  # noqa: E402
from esbt.synthetic import generate  # noqa: E402
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

    for name in names:
        strat = strategies.get(name)
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

        reports[name] = wf
        d = wf.diagnostics
        rows.append(
            {
                "strategy": name,
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
