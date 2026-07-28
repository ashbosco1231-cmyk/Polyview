"""Regime filters — the layer where an edge beyond the textbook version lives.

The standard setups fail on ES largely because they are applied unconditionally.
An opening-range break is a different trade on a quiet Tuesday than on a CPI
morning; fading VWAP is sound on a rotational day and ruinous on a trend day.
Filtering is what separates "the setup fired" from "the setup fired under the
conditions where it works".

Every filter returns a boolean Series meaning *trading is permitted on this bar*,
and every one is strictly causal — computed from information available at that
bar's close and no later. Several of these are trivially easy to write with
lookahead (classifying a "trend day" from its own closing range is the classic
version) and such a filter produces spectacular, entirely fictional results.
Where a value is only knowable after some point in the session, the filter is
False until then rather than back-filled.

A caution that matters more here than anywhere else in the codebase: filters
multiply the search space. Two filters with three settings each turn a 36-combo
grid into 324, and the noise floor rises with every one of them. Use the ledger
in :mod:`esbt.ledger` to keep count.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable

import numpy as np
import pandas as pd

from .session import minutes_since_open, opening_range, prior_session_levels, session_date, session_vwap


@dataclass(frozen=True)
class Filter:
    """A named regime condition plus the settings worth searching."""

    name: str
    fn: Callable[..., pd.Series]
    grid: dict[str, Iterable] = field(default_factory=dict)
    description: str = ""


def true_range(df: pd.DataFrame) -> pd.Series:
    """Classic true range, including the overnight gap in the first bar of a session."""
    prev_close = df["close"].shift(1)
    a = df["high"] - df["low"]
    b = (df["high"] - prev_close).abs()
    c = (df["low"] - prev_close).abs()
    return pd.concat([a, b, c], axis=1).max(axis=1)


# --------------------------------------------------------------------------- #
# Filters
# --------------------------------------------------------------------------- #


def volatility_regime(
    df: pd.DataFrame, lookback: int = 20, window: int = 500, low: float = 0.0, high: float = 1.0
) -> pd.Series:
    """Permit trading only when short-term volatility sits in a percentile band.

    ATR is ranked against its own recent history rather than compared to an
    absolute point value, because ES volatility in 2023 and 2025 are different
    scales and a fixed threshold silently becomes a date filter.
    """
    atr = true_range(df).rolling(lookback).mean()
    pct = atr.rolling(window).rank(pct=True)
    return ((pct >= low) & (pct <= high)).fillna(False)


def opening_range_size(
    df: pd.DataFrame, or_minutes: int = 30, low: float = 0.0, high: float = 1.0, history: int = 60
) -> pd.Series:
    """Permit trading based on how wide today's opening range is versus recent days.

    A narrow opening range preceding a break is a different setup from a wide one;
    lumping them together averages a compression breakout into an exhaustion fade.
    Only available once the range has formed, so the filter is False before then.
    """
    or_high, or_low, formed = opening_range(df, or_minutes)
    day = session_date(df)
    width = (or_high - or_low).groupby(day).last()

    # Percentile of today's range width within the trailing distribution. Today's
    # own width is legitimately part of the comparison -- it is known the moment
    # the range completes -- but nothing beyond today enters the window.
    rank = width.rolling(history, min_periods=10).rank(pct=True)
    mapped = pd.Series(rank.reindex(day.to_numpy()).to_numpy(), index=df.index)
    return (formed & (mapped >= low) & (mapped <= high)).fillna(False)


def trend_day(df: pd.DataFrame, min_share: float = 0.0, max_share: float = 1.0) -> pd.Series:
    """Classify the session so far as trending or rotational, causally.

    Measured as the running share of bars that have closed above session VWAP. A
    day that has spent 90% of its bars above VWAP is trending; one near 50% is
    rotating. Crucially this uses only bars *already seen* — classifying a trend
    day from where it eventually closed is lookahead, and it is the single most
    seductive bug in intraday research because the resulting equity curve is
    magnificent.
    """
    vwap = session_vwap(df)
    above = (df["close"] > vwap).astype(float)
    day = session_date(df)
    share = above.groupby(day).expanding().mean().reset_index(level=0, drop=True)
    share = share.reindex(df.index)
    # Distance from balance: 0.0 = perfectly rotational, 0.5 = one-way day.
    imbalance = (share - 0.5).abs() * 2.0
    return ((imbalance >= min_share) & (imbalance <= max_share)).fillna(False)


def gap_size(df: pd.DataFrame, min_pts: float = 0.0, max_pts: float = 1e9) -> pd.Series:
    """Permit trading only when the overnight gap falls in a size band."""
    prior = prior_session_levels(df)
    day = session_date(df)
    open_px = df["open"].groupby(day).transform("first")
    gap = (open_px - prior["prior_close"]).abs()
    return ((gap >= min_pts) & (gap <= max_pts)).fillna(False)


def day_of_week(df: pd.DataFrame, allowed: tuple[int, ...] = (0, 1, 2, 3, 4)) -> pd.Series:
    """Restrict to specific weekdays (0 = Monday).

    Included mainly as a cautionary instrument: day-of-week effects are the
    canonical example of a pattern that is abundant in-sample and absent
    thereafter. If a strategy only works on Wednesdays, it does not work.
    """
    local = df.index.tz_convert("America/New_York")
    return pd.Series(np.isin(local.dayofweek, allowed), index=df.index)


def minutes_into_session(df: pd.DataFrame, after: int = 0, before: int = 390) -> pd.Series:
    """Restrict to a slice of the session, measured in minutes after 09:30."""
    elapsed = minutes_since_open(df)
    return ((elapsed >= after) & (elapsed < before)).fillna(False)


REGISTRY: dict[str, Filter] = {
    "volatility_regime": Filter(
        name="volatility_regime",
        fn=volatility_regime,
        grid={"low": [0.0, 0.5], "high": [0.5, 1.0]},
        description="ATR percentile band",
    ),
    "opening_range_size": Filter(
        name="opening_range_size",
        fn=opening_range_size,
        grid={"low": [0.0, 0.5], "high": [0.5, 1.0]},
        description="Opening range width vs recent days",
    ),
    "trend_day": Filter(
        name="trend_day",
        fn=trend_day,
        grid={"min_share": [0.0, 0.3], "max_share": [0.3, 1.0]},
        description="Trending vs rotational session, measured causally",
    ),
    "gap_size": Filter(
        name="gap_size",
        fn=gap_size,
        grid={"min_pts": [0.0, 5.0], "max_pts": [15.0, 1e9]},
        description="Overnight gap size band",
    ),
    "day_of_week": Filter(
        name="day_of_week",
        fn=day_of_week,
        grid={"allowed": [(0, 1, 2, 3, 4), (1, 2, 3)]},
        description="Weekday restriction (usually a trap)",
    ),
    "minutes_into_session": Filter(
        name="minutes_into_session",
        fn=minutes_into_session,
        grid={"after": [0, 30, 60], "before": [120, 390]},
        description="Slice of the session",
    ),
}


def get(name: str) -> Filter:
    if name not in REGISTRY:
        raise KeyError(f"unknown filter {name!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[name]


def combine(df: pd.DataFrame, filters: dict[str, dict]) -> pd.Series:
    """Evaluate several filters and AND them together."""
    mask = pd.Series(True, index=df.index)
    for name, params in filters.items():
        mask &= get(name).fn(df, **params).reindex(df.index).fillna(False)
    return mask
