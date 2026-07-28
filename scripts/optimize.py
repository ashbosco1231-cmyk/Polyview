#!/usr/bin/env python3
"""Walk-forward optimize a strategy and report whether the result is real.

Runs entirely on synthetic data by default, so you can see the whole pipeline
before spending a cent:

    python scripts/optimize.py --strategy ma_crossover --synthetic

Against real data once you have fetched some:

    python scripts/optimize.py --strategy rsi_reversion --start 2023-01-01 --end 2024-01-01
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from esbt import strategies  # noqa: E402
from esbt.config import get_instrument  # noqa: E402
from esbt.data import back_adjust, load, resample  # noqa: E402
from esbt.report import format_sweep, format_walk_forward  # noqa: E402
from esbt.synthetic import generate  # noqa: E402
from esbt.walkforward import sweep, walk_forward  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Walk-forward optimize an ES strategy")
    p.add_argument("--strategy", default="ma_crossover", choices=sorted(strategies.REGISTRY))
    p.add_argument("--root", default="ES", choices=["ES", "MES"])
    p.add_argument("--start", default="2023-01-01")
    p.add_argument("--end", default="2024-12-31")
    p.add_argument("--bar", default="1m", choices=["1m", "1h", "1d"])
    p.add_argument("--resample", default="5min", help="target timeframe, e.g. 5min, 15min, 1h")
    p.add_argument("--splits", type=int, default=5)
    p.add_argument("--contracts", type=int, default=1)
    p.add_argument("--rolling", action="store_true", help="rolling instead of anchored train window")
    p.add_argument("--synthetic", action="store_true", help="use generated random-walk data")
    p.add_argument("--show-sweep", action="store_true", help="also print the in-sample sweep")
    p.add_argument("--budget", type=float, default=0.0, help="max USD for any needed download")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.synthetic:
        print("Using SYNTHETIC random-walk data. There is no edge here by construction;")
        print("a positive out-of-sample result would indicate a bug or pure luck.\n")
        df = generate(start=args.start, end=args.end, bar=args.resample)
        df = back_adjust(df)
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

    print(f"Loaded {len(df):,} bars: {df.index[0]} .. {df.index[-1]}\n")

    strat = strategies.get(args.strategy)
    inst = get_instrument(args.root)

    if args.show_sweep:
        print(format_sweep(sweep(df, strat, inst, contracts=args.contracts)))
        print()

    wf = walk_forward(
        df,
        strat,
        inst,
        n_splits=args.splits,
        anchored=not args.rolling,
        contracts=args.contracts,
    )
    print(format_walk_forward(wf, title=f"{strat.name} on {inst.root} @ {args.resample}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
