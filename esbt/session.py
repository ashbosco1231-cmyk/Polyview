"""Session-aware helpers for New York cash-session day trading.

Everything a discretionary intraday trader actually references off the chart --
where the session opened, where VWAP is, yesterday's high and low, how far into
the day we are -- computed so that no value is ever available before the moment
it would genuinely be known.

All grouping is done on the **exchange-local date**, not UTC. A UTC date boundary
falls in the middle of the US afternoon session, so grouping on UTC would splice
two different trading days together and silently corrupt every per-day level.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import EXCHANGE_TZ

NY_OPEN = pd.Timestamp("09:30").time()
NY_CLOSE = pd.Timestamp("16:00").time()


def local_index(df: pd.DataFrame) -> pd.DatetimeIndex:
    """The frame's index in exchange-local (New York) time."""
    return df.index.tz_convert(EXCHANGE_TZ)


def session_date(df: pd.DataFrame) -> pd.Series:
    """Exchange-local calendar date for each bar, as the day-grouping key."""
    return pd.Series(local_index(df).date, index=df.index, name="session_date")


def minutes_since_open(df: pd.DataFrame) -> pd.Series:
    """Minutes elapsed since 09:30 ET on each bar's own session."""
    local = local_index(df)
    mins = (local.hour * 60 + local.minute) - (9 * 60 + 30)
    return pd.Series(np.asarray(mins, dtype=float), index=df.index)


def bar_minutes(df: pd.DataFrame) -> int:
    """Bar size in minutes, inferred from the index."""
    secs = float(pd.Series(df.index).diff().dropna().dt.total_seconds().median())
    return max(int(round(secs / 60.0)), 1)


def in_window(df: pd.DataFrame, start: str, end: str) -> pd.Series:
    """Boolean mask for bars falling inside a local-time window, e.g. 09:30-11:30."""
    local = local_index(df)
    t0, t1 = pd.Timestamp(start).time(), pd.Timestamp(end).time()
    mask = (local.time >= t0) & (local.time < t1)
    return pd.Series(mask, index=df.index)


def session_vwap(df: pd.DataFrame) -> pd.Series:
    """Volume-weighted average price, re-anchored at each session open.

    This is the intraday VWAP a trader watches: it resets at 09:30 rather than
    running continuously, so it means the same thing here as it does on a chart.
    """
    day = session_date(df)
    typical = (df["high"] + df["low"] + df["close"]) / 3.0
    pv = (typical * df["volume"]).groupby(day).cumsum()
    vol = df["volume"].groupby(day).cumsum()
    return pv / vol.replace(0, np.nan)


def vwap_bands(df: pd.DataFrame, n_sigma: float = 2.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Session VWAP plus bands at +/- n_sigma of the running dispersion from it."""
    day = session_date(df)
    vwap = session_vwap(df)
    dev = df["close"] - vwap
    sigma = dev.groupby(day).expanding().std().reset_index(level=0, drop=True)
    sigma = sigma.reindex(df.index)
    return vwap, vwap + n_sigma * sigma, vwap - n_sigma * sigma


def opening_range(df: pd.DataFrame, minutes: int = 30) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Rolling high and low of the first ``minutes`` of each session.

    Returns (or_high, or_low, is_formed). Before the range completes the levels
    are the running extremes so far and ``is_formed`` is False -- entries must be
    gated on ``is_formed`` or the strategy is reading a level it cannot yet know.
    """
    day = session_date(df)
    elapsed = minutes_since_open(df)
    forming = elapsed < minutes

    or_high = df["high"].where(forming).groupby(day).cummax().groupby(day).ffill()
    or_low = df["low"].where(forming).groupby(day).cummin().groupby(day).ffill()
    return or_high, or_low, ~forming


def prior_session_levels(df: pd.DataFrame) -> pd.DataFrame:
    """Previous session's high, low and close, aligned onto every bar of today.

    Computed from completed sessions only and shifted forward by one day, so a
    bar never sees levels drawn from its own session.
    """
    day = session_date(df)
    daily = df.groupby(day).agg(high=("high", "max"), low=("low", "min"), close=("close", "last"))
    prior = daily.shift(1)
    prior.columns = ["prior_high", "prior_low", "prior_close"]
    return prior.reindex(day.to_numpy()).set_index(df.index)


def session_open_price(df: pd.DataFrame) -> pd.Series:
    """The 09:30 opening print of each bar's own session."""
    day = session_date(df)
    return df["open"].groupby(day).transform("first")


def trade_activity(trades: pd.DataFrame, df: pd.DataFrame, bar_min: int) -> dict:
    """Whether a strategy is realistically executable by hand.

    A backtest that averages eleven trades a day is not a manual strategy no
    matter what its Sharpe says, and one that holds for six hours is not a day
    trade. These numbers decide whether a result is usable before its returns
    are worth discussing.
    """
    if trades.empty:
        return {
            "trades_per_day": 0.0,
            "avg_hold_min": float("nan"),
            "max_hold_min": float("nan"),
            "busiest_day": 0,
            "days_traded_pct": 0.0,
        }

    n_sessions = max(session_date(df).nunique(), 1)
    per_day = trades.groupby(pd.Series(trades["entry_time"]).dt.tz_convert(EXCHANGE_TZ).dt.date).size()
    holds = trades["bars_held"] * bar_min

    return {
        "trades_per_day": len(trades) / n_sessions,
        "avg_hold_min": float(holds.mean()),
        "max_hold_min": float(holds.max()),
        "busiest_day": int(per_day.max()),
        "days_traded_pct": float(len(per_day) / n_sessions),
    }
