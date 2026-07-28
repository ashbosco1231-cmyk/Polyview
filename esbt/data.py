"""Databento loader for CME futures, with cost gating, caching and back-adjustment.

Three things in here matter more than the rest of the codebase combined:

1. Every download is priced with ``metadata.get_cost`` before a byte is fetched,
   and refused unless the caller opts in. Free credits are finite.
2. Results are cached to Parquet, so you pay for a date range exactly once.
3. Continuous contracts are back-adjusted. Databento's ``ES.v.0`` stitches
   contracts together but does *not* price-adjust across the roll (adjusted
   continuous contracts are still an open roadmap item for them). The raw series
   therefore contains a step change of several index points four times a year.
   Backtested on raw data, a trend strategy "profits" from those steps. This is
   the single most effective way to fool yourself on futures data.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .config import EXCHANGE_TZ, ROLL_RULES, RTH_END, RTH_START

log = logging.getLogger(__name__)

DATASET = "GLBX.MDP3"  # CME Globex MDP 3.0
DEFAULT_CACHE = Path(__file__).resolve().parent.parent / "data"

# Databento OHLCV schemas, mapped from the bar sizes you'd actually research on.
SCHEMAS = {
    "1m": "ohlcv-1m",
    "1h": "ohlcv-1h",
    "1d": "ohlcv-1d",
}


class CostRefused(RuntimeError):
    """Raised when a download would cost money and the caller has not opted in."""


@dataclass
class FetchPlan:
    """What a download would cost, before committing to it."""

    symbol: str
    schema: str
    start: str
    end: str
    cost_usd: float
    cached: bool

    def describe(self) -> str:
        if self.cached:
            return f"{self.symbol} {self.schema} {self.start}..{self.end}: cached, $0.00"
        return (
            f"{self.symbol} {self.schema} {self.start}..{self.end}: "
            f"${self.cost_usd:.4f} to download"
        )


def continuous_symbol(root: str, roll: str = "volume", rank: int = 0) -> str:
    """Build a Databento continuous-contract symbol, e.g. ES.v.0.

    Format is [ROOT].[ROLL_RULE].[RANK]; rank 0 is the front month.
    """
    if roll not in ROLL_RULES:
        raise KeyError(f"unknown roll rule {roll!r}; known: {sorted(ROLL_RULES)}")
    return f"{root.upper()}.{ROLL_RULES[roll]}.{rank}"


def _cache_path(cache_dir: Path, symbol: str, schema: str, start: str, end: str) -> Path:
    safe = symbol.replace(".", "_")
    return cache_dir / f"{safe}__{schema}__{start}__{end}.parquet"


def _client(api_key: str | None = None):
    """Construct a Databento historical client.

    The key is read from the DATABENTO_API_KEY environment variable by default so
    it never has to be written into a file that might get committed.
    """
    import databento as db

    key = api_key or os.environ.get("DATABENTO_API_KEY")
    if not key:
        raise RuntimeError(
            "No Databento API key. Set DATABENTO_API_KEY in your environment "
            "(get one at https://databento.com -- new accounts include free credits)."
        )
    return db.Historical(key)


def estimate_cost(
    symbol: str,
    start: str,
    end: str,
    bar: str = "1m",
    cache_dir: Path | None = None,
    api_key: str | None = None,
) -> FetchPlan:
    """Price a download without performing it."""
    cache_dir = Path(cache_dir or DEFAULT_CACHE)
    schema = SCHEMAS[bar]
    path = _cache_path(cache_dir, symbol, schema, start, end)
    if path.exists():
        return FetchPlan(symbol, schema, start, end, 0.0, cached=True)

    cost = _client(api_key).metadata.get_cost(
        dataset=DATASET,
        symbols=[symbol],
        schema=schema,
        stype_in="continuous",
        start=start,
        end=end,
    )
    return FetchPlan(symbol, schema, start, end, float(cost), cached=False)


def fetch(
    symbol: str,
    start: str,
    end: str,
    bar: str = "1m",
    cache_dir: Path | None = None,
    api_key: str | None = None,
    max_cost_usd: float = 0.0,
) -> pd.DataFrame:
    """Download (or load from cache) OHLCV bars for a continuous contract.

    Refuses to spend more than ``max_cost_usd``; pass an explicit budget to allow
    a paid download. Returns a UTC-indexed frame with an added ``symbol`` column
    identifying which underlying contract each bar came from.
    """
    cache_dir = Path(cache_dir or DEFAULT_CACHE)
    cache_dir.mkdir(parents=True, exist_ok=True)
    schema = SCHEMAS[bar]
    path = _cache_path(cache_dir, symbol, schema, start, end)

    if path.exists():
        log.info("cache hit: %s", path.name)
        return pd.read_parquet(path)

    client = _client(api_key)
    cost = float(
        client.metadata.get_cost(
            dataset=DATASET,
            symbols=[symbol],
            schema=schema,
            stype_in="continuous",
            start=start,
            end=end,
        )
    )
    if cost > max_cost_usd:
        raise CostRefused(
            f"download would cost ${cost:.4f} but max_cost_usd is ${max_cost_usd:.4f}. "
            f"Re-run with a higher budget to proceed."
        )

    log.info("downloading %s %s %s..%s (cost $%.4f)", symbol, schema, start, end, cost)
    store = client.timeseries.get_range(
        dataset=DATASET,
        symbols=[symbol],
        schema=schema,
        stype_in="continuous",
        start=start,
        end=end,
    )

    df = store.to_df()
    if df.empty:
        raise RuntimeError(f"Databento returned no rows for {symbol} {start}..{end}")

    df = df.rename(columns=str.lower)
    keep = [c for c in ("open", "high", "low", "close", "volume", "symbol") if c in df.columns]
    df = df[keep].copy()
    df.index = pd.to_datetime(df.index, utc=True)
    df = df.sort_index()
    df.to_parquet(path)
    log.info("cached %d bars -> %s", len(df), path.name)
    return df


def back_adjust(df: pd.DataFrame, method: str = "difference") -> pd.DataFrame:
    """Remove roll discontinuities from a stitched continuous contract.

    At each roll the underlying contract changes, and the new contract trades at a
    different absolute price. Left uncorrected those steps look like real returns.

    We locate rolls via the ``symbol`` column, measure the gap across each
    boundary, and shift all *earlier* history so the most recent segment keeps
    true current prices. ``difference`` preserves point moves (correct for a
    fixed-multiplier futures contract); ``ratio`` preserves percentage moves.

    Adds a ``roll`` boolean column marking the first bar of each new contract.
    """
    if "symbol" not in df.columns:
        raise ValueError("back_adjust needs a 'symbol' column to locate rolls")
    if method not in ("difference", "ratio"):
        raise ValueError(f"unknown method {method!r}")

    out = df.copy()
    sym = out["symbol"].astype(str)
    is_roll = sym.ne(sym.shift(1)) & sym.shift(1).notna()
    out["roll"] = is_roll

    roll_idx = np.flatnonzero(is_roll.to_numpy())
    if len(roll_idx) == 0:
        return out

    price_cols = [c for c in ("open", "high", "low", "close") if c in out.columns]
    close = out["close"].to_numpy(dtype=float)

    # Walk rolls newest-first, accumulating the correction applied to older data.
    if method == "difference":
        adjustment = np.zeros(len(out), dtype=float)
        cum = 0.0
        for i in reversed(roll_idx):
            # Gap between the old contract's last close and the new one's first open.
            gap = close[i] - close[i - 1]
            cum += gap
            adjustment[:i] += gap
        for col in price_cols:
            out[col] = out[col].to_numpy(dtype=float) + adjustment
    else:
        factor = np.ones(len(out), dtype=float)
        for i in reversed(roll_idx):
            prev = close[i - 1]
            if prev == 0:
                continue
            ratio = close[i] / prev
            factor[:i] *= ratio
        for col in price_cols:
            out[col] = out[col].to_numpy(dtype=float) * factor

    return out


def restrict_to_rth(df: pd.DataFrame, start: str = RTH_START, end: str = RTH_END) -> pd.DataFrame:
    """Keep only bars inside the US cash session, handling DST correctly.

    Timestamps are converted to exchange-local time before filtering, so the
    window tracks the 09:30-16:00 ET cash open across daylight-saving changes
    rather than drifting by an hour for half the year.
    """
    local = df.tz_convert(EXCHANGE_TZ)
    mask = (local.index.time >= pd.Timestamp(start).time()) & (
        local.index.time < pd.Timestamp(end).time()
    )
    # Weekdays only; the cash session never opens on a weekend.
    mask &= local.index.dayofweek < 5
    return df[mask]


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Aggregate bars to a coarser timeframe, e.g. '5min', '15min', '1h'."""
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    agg = {k: v for k, v in agg.items() if k in df.columns}
    out = df.resample(rule, label="left", closed="left").agg(agg).dropna(subset=["close"])
    return out


def load(
    root: str = "ES",
    start: str = "2023-01-01",
    end: str = "2025-01-01",
    bar: str = "1m",
    roll: str = "volume",
    adjust: str = "difference",
    rth_only: bool = True,
    resample_to: str | None = None,
    max_cost_usd: float = 0.0,
    cache_dir: Path | None = None,
) -> pd.DataFrame:
    """End-to-end: fetch, back-adjust, session-filter and optionally resample."""
    symbol = continuous_symbol(root, roll)
    raw = fetch(symbol, start, end, bar=bar, cache_dir=cache_dir, max_cost_usd=max_cost_usd)
    adjusted = back_adjust(raw, method=adjust)
    if rth_only:
        adjusted = restrict_to_rth(adjusted)
    if resample_to:
        adjusted = resample(adjusted, resample_to)
    return adjusted
