#!/usr/bin/env python3
"""Price and download ES data from Databento.

Always prints the cost first. Nothing is downloaded unless you pass --budget,
and anything already cached costs nothing to reuse.

    # See what a year of 1-minute ES would cost, without spending anything
    python scripts/fetch_data.py --start 2023-01-01 --end 2024-01-01 --bar 1m

    # Actually download it, allowing up to $5
    python scripts/fetch_data.py --start 2023-01-01 --end 2024-01-01 --bar 1m --budget 5
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from esbt.data import CostRefused, continuous_symbol, estimate_cost, fetch  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Price and download CME futures data")
    p.add_argument("--root", default="ES", help="contract root, e.g. ES or MES")
    p.add_argument("--start", default="2023-01-01")
    p.add_argument("--end", default="2024-01-01")
    p.add_argument("--bar", default="1m", choices=["1m", "1h", "1d"])
    p.add_argument("--roll", default="volume", choices=["volume", "open_interest", "calendar"])
    p.add_argument(
        "--budget",
        type=float,
        default=0.0,
        help="maximum USD to spend. Default 0 means estimate only, download nothing.",
    )
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    symbol = continuous_symbol(args.root, args.roll)

    try:
        plan = estimate_cost(symbol, args.start, args.end, bar=args.bar)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(plan.describe())

    if plan.cached:
        return 0
    if args.budget <= 0:
        print("\nEstimate only. Re-run with --budget <usd> to download.")
        return 0

    try:
        df = fetch(symbol, args.start, args.end, bar=args.bar, max_cost_usd=args.budget)
    except CostRefused as exc:
        print(f"\nrefused: {exc}", file=sys.stderr)
        return 1

    print(f"\nDownloaded {len(df):,} bars covering {df.index[0]} to {df.index[-1]}")
    if "symbol" in df.columns:
        print(f"Underlying contracts: {', '.join(sorted(df['symbol'].astype(str).unique()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
