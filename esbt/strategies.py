"""Starter strategies.

Each is a plain function from (bars, params) to a target-position series in
{-1, 0, +1}, using only data available up to and including each bar's close. The
engine handles the one-bar execution delay, so these can be written naturally
without worrying about shifting.

These exist to exercise the harness, not as trade recommendations. Two of them
are near-coin-flips on ES after costs, which is itself the useful lesson.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Strategy:
    """A named signal generator plus the parameter grid worth searching."""

    name: str
    fn: Callable[..., pd.Series]
    grid: dict[str, Iterable]

    def __call__(self, df: pd.DataFrame, **params) -> pd.Series:
        return self.fn(df, **params)


def ma_crossover(df: pd.DataFrame, fast: int = 20, slow: int = 100) -> pd.Series:
    """Long when the fast average is above the slow one, short when below.

    The canonical trend template. On intraday ES it is usually a loser after
    costs, which makes it a good honesty check on the harness.
    """
    if fast >= slow:
        return pd.Series(0.0, index=df.index)
    close = df["close"]
    f = close.rolling(fast).mean()
    s = close.rolling(slow).mean()
    return np.sign(f - s).fillna(0.0)


def rsi_reversion(
    df: pd.DataFrame, length: int = 14, low: float = 30.0, high: float = 70.0
) -> pd.Series:
    """Buy oversold, sell overbought, flatten in the middle band.

    Mean reversion is the structurally more plausible intraday equity-index edge,
    but it is also the one most sensitive to slippage.
    """
    close = df["close"]
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / length, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / length, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)

    sig = pd.Series(0.0, index=df.index)
    sig[rsi < low] = 1.0
    sig[rsi > high] = -1.0
    # Hold the position until the opposite band, rather than flip-flopping in the middle.
    return sig.replace(0.0, np.nan).ffill().fillna(0.0)


def opening_range_breakout(
    df: pd.DataFrame, minutes: int = 30, stretch: float = 0.0
) -> pd.Series:
    """Trade the break of the first N minutes of the cash session.

    A genuinely ES-specific pattern, and one where session handling matters: the
    range must reset every day, so this groups by exchange-local date.
    """
    local = df.index.tz_convert("America/New_York")
    day = pd.Series(local.date, index=df.index)
    # Seconds via pandas, not raw integer views: the index resolution differs
    # between pandas versions and a wrong unit here silently changes how many
    # bars make up the opening range.
    bar_seconds = float(pd.Series(df.index).diff().dropna().dt.total_seconds().median())
    bar_min = max(int(round(bar_seconds / 60.0)), 1)
    n_bars = max(minutes // bar_min, 1)

    high = df["high"]
    low = df["low"]
    close = df["close"]

    # Rolling position within each day, so we know when the opening range closes.
    seq = day.groupby(day).cumcount()
    or_high = high.where(seq < n_bars).groupby(day).cummax().ffill()
    or_low = low.where(seq < n_bars).groupby(day).cummin().ffill()

    pad = stretch * (or_high - or_low)
    sig = pd.Series(0.0, index=df.index)
    active = seq >= n_bars
    sig[active & (close > or_high + pad)] = 1.0
    sig[active & (close < or_low - pad)] = -1.0
    # Flatten into the close rather than carrying overnight risk.
    sig = sig.groupby(day).ffill().fillna(0.0)
    sig[~active] = 0.0
    return sig


REGISTRY: dict[str, Strategy] = {
    "ma_crossover": Strategy(
        name="ma_crossover",
        fn=ma_crossover,
        grid={"fast": [5, 10, 20, 30, 50], "slow": [50, 100, 150, 200]},
    ),
    "rsi_reversion": Strategy(
        name="rsi_reversion",
        fn=rsi_reversion,
        grid={"length": [7, 14, 21], "low": [20.0, 25.0, 30.0], "high": [70.0, 75.0, 80.0]},
    ),
    "opening_range_breakout": Strategy(
        name="opening_range_breakout",
        fn=opening_range_breakout,
        grid={"minutes": [15, 30, 60], "stretch": [0.0, 0.1, 0.25]},
    ),
}


def get(name: str) -> Strategy:
    if name not in REGISTRY:
        raise KeyError(f"unknown strategy {name!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[name]
