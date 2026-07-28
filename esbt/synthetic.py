"""Synthetic ES-like bars, for validating the harness without spending credits.

Two uses:

1. **Development.** Everything except the Databento call can be exercised offline.
2. **Calibration, which matters more.** Synthetic data is generated from a random
   walk, so it contains *no* edge by construction. Any strategy that shows a
   positive out-of-sample Sharpe here is measuring a bug in the harness or the
   luck of the search, not a discovery. Running your idea against this before
   running it against real data tells you what "nothing" looks like.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import QUARTERLY_MONTHS

_MONTH_CODES = {3: "H", 6: "M", 9: "U", 12: "Z"}


def _contract_symbol(ts: pd.Timestamp) -> str:
    """Front-month contract label for a timestamp, on the quarterly cycle."""
    year, month = ts.year, ts.month
    for m in QUARTERLY_MONTHS:
        if month <= m:
            return f"ES{_MONTH_CODES[m]}{year % 100:02d}"
    return f"ES{_MONTH_CODES[3]}{(year + 1) % 100:02d}"


def generate(
    start: str = "2023-01-02",
    end: str = "2024-12-31",
    bar: str = "5min",
    start_price: float = 4000.0,
    annual_vol: float = 0.18,
    seed: int = 7,
    roll_gap: float = 12.0,
    drift: float = 0.0,
    overnight_gap_pts: float = 8.0,
) -> pd.DataFrame:
    """Generate RTH bars following a random walk, with realistic gaps.

    ``roll_gap`` reproduces the price step between expiring and incoming
    contracts that appears in unadjusted continuous data, so ``back_adjust`` has
    something real to correct.

    ``overnight_gap_pts`` is the standard deviation of the gap between one
    session's close and the next session's open. It is drawn with zero mean, so
    it adds no edge -- a gap-fade strategy still has nothing to find here -- but
    it lets gap-based setups actually trigger.
    """
    rng = np.random.default_rng(seed)

    # Cash-session timestamps only, matching what restrict_to_rth would produce.
    days = pd.bdate_range(start, end, tz="America/New_York")
    stamps = []
    for d in days:
        session = pd.date_range(
            d.replace(hour=9, minute=30), d.replace(hour=15, minute=59), freq=bar, tz="America/New_York"
        )
        stamps.append(session)
    index = pd.DatetimeIndex(np.concatenate([s.values for s in stamps])).tz_localize("UTC")
    index = index.tz_convert("America/New_York").tz_convert("UTC")
    n = len(index)

    bars_per_year = 390 * 252 / (pd.Timedelta(bar).total_seconds() / 60)
    sigma = annual_vol / np.sqrt(bars_per_year)
    # Ito correction. Exponentiating a zero-mean log-step series does *not* give a
    # driftless price series: E[S_t] = S_0 * exp(sigma^2 * t / 2), an upward drift
    # that hands free money to any strategy which happens to be net long. Since
    # the entire point of this generator is data with no edge in it, subtract that
    # term so the price process is a true martingale.
    mu = drift / bars_per_year - 0.5 * sigma**2

    steps = rng.normal(mu, sigma, n)
    close = start_price * np.exp(np.cumsum(steps))

    # Build OHLC around the closes with plausible intrabar range, *before* the
    # roll offset is applied.
    noise = np.abs(rng.normal(0, sigma * start_price * 0.6, n))
    open_ = np.empty(n)
    open_[0] = close[0]
    open_[1:] = close[:-1]
    high = np.maximum(open_, close) + noise
    low = np.minimum(open_, close) - noise

    # Overnight gaps. The cash session does not reopen where it closed -- ES trades
    # all night and reacts to Asia, Europe and overnight news before 09:30. Without
    # this the generated series is one continuous intraday walk, and any setup that
    # references the gap or the prior session's close never fires at all.
    local_dates = np.asarray(index.tz_convert("America/New_York").date)
    day_starts = np.flatnonzero(local_dates[1:] != local_dates[:-1]) + 1
    overnight = rng.normal(0.0, overnight_gap_pts, len(day_starts))
    gap_offset = np.zeros(n)
    for start_i, g in zip(day_starts, overnight):
        gap_offset[start_i:] += g
    open_ = open_ + gap_offset
    high = high + gap_offset
    low = low + gap_offset
    close = close + gap_offset

    symbols = np.array([_contract_symbol(ts) for ts in index.tz_convert("America/New_York")])
    changes = np.flatnonzero(symbols[1:] != symbols[:-1]) + 1
    offset = np.zeros(n)
    for i, c in enumerate(changes):
        offset[c:] += roll_gap * (1 if i % 2 == 0 else -1)

    # The offset lands on every price in the bar, not just the close: once the
    # front month changes, the whole bar belongs to the new contract and trades
    # at its level. Offsetting only the close would leave the open stranded at
    # the old level, manufacturing a phantom gap that no real feed contains.
    open_ = open_ + offset
    high = high + offset
    low = low + offset
    close = close + offset

    tick = 0.25
    frame = pd.DataFrame(
        {
            "open": np.round(open_ / tick) * tick,
            "high": np.round(high / tick) * tick,
            "low": np.round(low / tick) * tick,
            "close": np.round(close / tick) * tick,
            "volume": rng.integers(500, 20000, n),
            "symbol": symbols,
        },
        index=index,
    )
    return frame
