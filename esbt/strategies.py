"""New York session day-trading strategies for ES.

Each function returns a *raw* signal in {-1, 0, +1} meaning "the setup is present
in this direction right now", using only information available at that bar's
close. Timing constraints -- time stops, entry windows, going flat into the bell,
trade budgets -- are not baked into the strategies; they are applied uniformly by
:mod:`esbt.rules`, so every strategy is held to the same execution discipline and
the constraints themselves can be searched as parameters.

The six setups are deliberately different *mechanisms* rather than six variations
on a moving average, because six flavours of the same idea tested against one
dataset produce six correlated results and one illusion of confirmation.

None of these is a recommendation. Several are likely to fail on real data, and
finding that out cheaply is the point.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable

import numpy as np
import pandas as pd

from .rules import apply_rules
from .session import (
    bar_minutes,
    minutes_since_open,
    opening_range,
    prior_session_levels,
    session_date,
    session_open_price,
    session_vwap,
    vwap_bands,
)

# Parameters consumed by the execution-rule layer rather than the signal itself.
RULE_PARAMS = {"hold_min", "max_trades_per_day", "cooldown_bars"}


@dataclass(frozen=True)
class Strategy:
    """A signal generator, its search grid, and its default execution rules."""

    name: str
    fn: Callable[..., pd.Series]
    grid: dict[str, Iterable]
    entry_window: tuple[str, str] = ("09:30", "16:00")
    flatten_at: str = "15:55"
    description: str = ""
    rules: dict = field(default_factory=dict)


def build_signal(strategy: Strategy, df: pd.DataFrame, **params) -> pd.Series:
    """Generate a strategy's signal and apply its execution rules.

    Splits ``params`` into signal parameters and rule parameters, so a walk-forward
    search can optimize the holding time alongside the setup's own thresholds.
    """
    sig_params = {k: v for k, v in params.items() if k not in RULE_PARAMS}
    rule_params = {k: v for k, v in params.items() if k in RULE_PARAMS}

    raw = strategy.fn(df, **sig_params)

    hold_min = rule_params.pop("hold_min", None)
    max_hold = None
    if hold_min is not None:
        max_hold = max(int(round(float(hold_min) / bar_minutes(df))), 1)

    merged = {**strategy.rules, **rule_params}
    return apply_rules(
        raw,
        df,
        max_hold_bars=max_hold,
        entry_window=strategy.entry_window,
        flatten_at=strategy.flatten_at,
        **merged,
    )


# --------------------------------------------------------------------------- #
# Signal generators
# --------------------------------------------------------------------------- #


def opening_range_breakout(
    df: pd.DataFrame, or_minutes: int = 30, buffer_ticks: float = 2.0
) -> pd.Series:
    """Break of the first N minutes' range.

    The most-traded index day-trade template. The buffer exists because the exact
    range edge is where stop orders cluster and where a break is most likely to be
    a wick rather than a move.
    """
    or_high, or_low, formed = opening_range(df, or_minutes)
    pad = buffer_ticks * 0.25
    close = df["close"]

    sig = pd.Series(0.0, index=df.index)
    sig[formed & (close > or_high + pad)] = 1.0
    sig[formed & (close < or_low - pad)] = -1.0
    return sig.fillna(0.0)


def vwap_reversion(df: pd.DataFrame, n_sigma: float = 2.0, exit_sigma: float = 0.5) -> pd.Series:
    """Fade a stretch away from session VWAP, targeting a return toward it.

    Structurally the more plausible intraday index edge -- the cash session spends
    most of its time rotating around VWAP -- and also the one most sensitive to
    slippage, since it trades against short-term momentum.
    """
    vwap, upper, lower = vwap_bands(df, n_sigma)
    close = df["close"]
    dev = close - vwap
    scale = (upper - vwap).replace(0, np.nan)
    z = dev / scale * n_sigma

    sig = pd.Series(np.nan, index=df.index)
    sig[close < lower] = 1.0
    sig[close > upper] = -1.0
    # Flatten once price has come back within the inner band.
    sig[z.abs() < exit_sigma] = 0.0
    return sig.ffill().fillna(0.0)


def gap_fade(df: pd.DataFrame, min_gap_pts: float = 5.0, max_gap_pts: float = 40.0) -> pd.Series:
    """Fade the overnight gap back toward the prior session's close.

    Large gaps are excluded rather than treated as stronger versions of small
    ones: a 60-point gap is usually news, and news gaps trend rather than fill.
    """
    prior = prior_session_levels(df)
    open_px = session_open_price(df)
    gap = open_px - prior["prior_close"]

    tradable = gap.abs().between(min_gap_pts, max_gap_pts)
    close = df["close"]

    sig = pd.Series(0.0, index=df.index)
    # Gap up -> fade short until price has filled back to the prior close.
    sig[tradable & (gap > 0) & (close > prior["prior_close"])] = -1.0
    sig[tradable & (gap < 0) & (close < prior["prior_close"])] = 1.0
    return sig.fillna(0.0)


def prior_day_break(df: pd.DataFrame, buffer_ticks: float = 4.0) -> pd.Series:
    """Break of the previous session's high or low.

    Yesterday's extremes are the levels most visible to everyone, which is the
    argument both for the setup working and for it being crowded.
    """
    prior = prior_session_levels(df)
    pad = buffer_ticks * 0.25
    close = df["close"]

    sig = pd.Series(0.0, index=df.index)
    sig[close > prior["prior_high"] + pad] = 1.0
    sig[close < prior["prior_low"] - pad] = -1.0
    return sig.fillna(0.0)


def opening_drive(df: pd.DataFrame, drive_minutes: int = 15, min_move_pts: float = 4.0) -> pd.Series:
    """Continuation in the direction of the session's first move.

    Requires the initial move to clear a threshold, so a flat, directionless open
    produces no trade rather than a coin flip.
    """
    day = session_date(df)
    elapsed = minutes_since_open(df)

    in_drive = elapsed < drive_minutes
    # Close at the end of the drive window, and the session's opening print.
    drive_close = df["close"].where(in_drive).groupby(day).last()
    open_first = df["open"].groupby(day).first()
    move_by_day = drive_close - open_first

    drive_move = pd.Series(
        move_by_day.reindex(day.to_numpy()).to_numpy(), index=df.index
    )

    sig = pd.Series(0.0, index=df.index)
    active = ~in_drive
    sig[active & (drive_move >= min_move_pts)] = 1.0
    sig[active & (drive_move <= -min_move_pts)] = -1.0
    return sig.fillna(0.0)


def vwap_trend(df: pd.DataFrame, pullback_ticks: float = 8.0, slope_bars: int = 10) -> pd.Series:
    """Buy pullbacks to a rising VWAP, sell rallies to a falling one.

    The trend-following counterpart to :func:`vwap_reversion`. Both cannot be
    right in the same regime, which makes the pair a useful check on whether a
    result reflects the market or the search.
    """
    vwap = session_vwap(df)
    close = df["close"]
    slope = vwap.diff(slope_bars)
    dist = close - vwap
    pad = pullback_ticks * 0.25

    sig = pd.Series(0.0, index=df.index)
    sig[(slope > 0) & (dist < 0) & (dist > -pad)] = 1.0
    sig[(slope < 0) & (dist > 0) & (dist < pad)] = -1.0
    return sig.fillna(0.0)


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #

_HOLDS = [10, 15, 20, 30]  # minutes; the day-trade holding window under test

REGISTRY: dict[str, Strategy] = {
    "opening_range_breakout": Strategy(
        name="opening_range_breakout",
        fn=opening_range_breakout,
        grid={
            "or_minutes": [15, 30, 60],
            "buffer_ticks": [0.0, 2.0, 4.0],
            "hold_min": _HOLDS,
        },
        entry_window=("09:45", "12:00"),
        description="Break of the first N minutes' range",
        rules={"max_trades_per_day": 2, "cooldown_bars": 2},
    ),
    "vwap_reversion": Strategy(
        name="vwap_reversion",
        fn=vwap_reversion,
        grid={
            "n_sigma": [1.5, 2.0, 2.5],
            "exit_sigma": [0.0, 0.5, 1.0],
            "hold_min": _HOLDS,
        },
        entry_window=("10:00", "15:00"),
        description="Fade a stretch from session VWAP",
        rules={"max_trades_per_day": 3, "cooldown_bars": 4},
    ),
    "gap_fade": Strategy(
        name="gap_fade",
        fn=gap_fade,
        grid={
            "min_gap_pts": [3.0, 5.0, 10.0],
            "max_gap_pts": [25.0, 40.0],
            "hold_min": _HOLDS,
        },
        entry_window=("09:30", "11:00"),
        description="Fade the overnight gap toward prior close",
        rules={"max_trades_per_day": 1, "cooldown_bars": 0},
    ),
    "prior_day_break": Strategy(
        name="prior_day_break",
        fn=prior_day_break,
        grid={
            "buffer_ticks": [0.0, 4.0, 8.0],
            "hold_min": _HOLDS,
        },
        entry_window=("09:30", "14:00"),
        description="Break of prior session high/low",
        rules={"max_trades_per_day": 2, "cooldown_bars": 4},
    ),
    "opening_drive": Strategy(
        name="opening_drive",
        fn=opening_drive,
        grid={
            "drive_minutes": [5, 15, 30],
            "min_move_pts": [2.0, 4.0, 8.0],
            "hold_min": _HOLDS,
        },
        entry_window=("09:35", "11:00"),
        description="Continuation of the session's first move",
        rules={"max_trades_per_day": 1, "cooldown_bars": 0},
    ),
    "vwap_trend": Strategy(
        name="vwap_trend",
        fn=vwap_trend,
        grid={
            "pullback_ticks": [4.0, 8.0, 12.0],
            "slope_bars": [5, 10, 20],
            "hold_min": _HOLDS,
        },
        entry_window=("10:00", "15:00"),
        description="Buy pullbacks to a rising VWAP",
        rules={"max_trades_per_day": 3, "cooldown_bars": 4},
    ),
}


def get(name: str) -> Strategy:
    if name not in REGISTRY:
        raise KeyError(f"unknown strategy {name!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[name]
