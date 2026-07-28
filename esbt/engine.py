"""Vectorized position-based backtest core.

Design notes, because the details are the whole point:

*Lookahead is structurally impossible.* A strategy emits a target position from
the information available at each bar's **close**. The engine shifts that target
by one bar and fills it at the **next bar's open**. There is no code path in
which a decision can consult a price it could not have seen. This is enforced
here, once, rather than trusted to every individual strategy.

*Accounting is open-to-open.* A position established at ``open[i]`` earns
``open[i+1] - open[i]``. No intrabar path is assumed, because a bar's OHLC does
not tell you the order in which the high and low occurred. Intrabar stop-losses
are deliberately not modeled: doing so on OHLC bars requires guessing that
ordering, and the optimistic guess is exactly the error that makes backtests
look profitable. Trade at bar granularity or fetch finer bars.

*Costs are charged on every contract that changes hands*, in both commission and
slippage, at entry and at exit.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import Instrument

# Approximate number of RTH minutes in a trading year: 390 per day * 252 days.
_RTH_MINUTES_PER_YEAR = 390 * 252


@dataclass
class Result:
    """Outcome of a single backtest run."""

    equity: pd.Series          # cumulative net PnL in dollars
    pnl: pd.Series             # per-bar net PnL in dollars
    position: pd.Series        # contracts held during each bar
    trades: pd.DataFrame       # one row per position change
    costs: float               # total dollars paid in commission + slippage
    stats: dict = field(default_factory=dict)

    def __repr__(self) -> str:  # pragma: no cover - display only
        s = self.stats
        return (
            f"<Result net=${s.get('net_pnl', 0):,.0f} "
            f"sharpe={s.get('sharpe', float('nan')):.2f} "
            f"maxdd=${s.get('max_drawdown', 0):,.0f} "
            f"trades={s.get('n_trades', 0)}>"
        )


def _bars_per_year(index: pd.DatetimeIndex) -> float:
    """Infer annualization factor from the actual bar spacing.

    Uses the median gap so that overnight and weekend breaks in a session-filtered
    series don't inflate the estimate.
    """
    if len(index) < 3:
        return float(_RTH_MINUTES_PER_YEAR)
    # Measure the gap in seconds through pandas rather than viewing the backing
    # integers. The index resolution is not fixed -- pandas 3 defaults to
    # microseconds where pandas 2 used nanoseconds -- and hardcoding either one
    # rescales every Sharpe ratio in the codebase by a factor of ~31.6 without
    # any other visible symptom.
    deltas = pd.Series(index).diff().dropna().dt.total_seconds()
    median_seconds = float(deltas.median())
    if not np.isfinite(median_seconds) or median_seconds <= 0:
        return float(_RTH_MINUTES_PER_YEAR)
    minutes = median_seconds / 60.0
    return _RTH_MINUTES_PER_YEAR / max(minutes, 1e-9)


def backtest(
    df: pd.DataFrame,
    signal: pd.Series | np.ndarray,
    instrument: Instrument,
    contracts: int = 1,
) -> Result:
    """Run a backtest.

    Parameters
    ----------
    df
        Bars with at least an ``open`` column, indexed by timestamp.
    signal
        Target position per bar, in units of ``contracts``: +1 long, -1 short,
        0 flat. Fractional values are allowed and are rounded toward zero.
        Interpreted as the decision made using data through that bar's close.
    instrument
        Contract spec supplying point value and trading costs.
    contracts
        Position size multiplier.
    """
    if "open" not in df.columns:
        raise ValueError("df must contain an 'open' column")

    sig = pd.Series(signal, index=df.index).fillna(0.0)

    # The one line that makes lookahead impossible: a signal formed at the close
    # of bar i can only be held starting from the open of bar i+1.
    # np.fix is applied to the underlying array rather than through Series.apply,
    # which dispatches once per element in Python and dominated sweep runtime.
    position = pd.Series(
        np.fix(sig.shift(1).fillna(0.0).to_numpy(dtype=float) * contracts), index=df.index
    )

    open_px = df["open"].to_numpy(dtype=float)
    pos = position.to_numpy(dtype=float)

    # Open-to-open move captured by the position held during each bar. The final
    # bar has no subsequent open, so it earns nothing and is left flat.
    move = np.zeros_like(open_px)
    move[:-1] = open_px[1:] - open_px[:-1]
    gross = pos * instrument.point_value * move

    # Contracts changing hands at each bar's open.
    turnover = np.abs(np.diff(pos, prepend=0.0))
    cost_per_contract = instrument.commission_per_side + (
        instrument.slippage_ticks * instrument.tick_value
    )
    cost = turnover * cost_per_contract

    net = gross - cost
    pnl = pd.Series(net, index=df.index)
    equity = pnl.cumsum()

    trades = _extract_trades(df, position, instrument)
    stats = compute_stats(pnl, equity, position, trades, instrument)

    return Result(
        equity=equity,
        pnl=pnl,
        position=position,
        trades=trades,
        costs=float(cost.sum()),
        stats=stats,
    )


def _extract_trades(
    df: pd.DataFrame, position: pd.Series, instrument: Instrument
) -> pd.DataFrame:
    """Collapse the position series into discrete round-turn trades.

    A trade runs from the bar where a position is opened from flat (or flipped)
    to the bar where it returns to flat or reverses.
    """
    pos = position.to_numpy(dtype=float)
    open_px = df["open"].to_numpy(dtype=float)
    idx = df.index

    rows = []
    entry_i = None
    entry_pos = 0.0

    # Only bars where the position actually changes can open or close a trade.
    # Scanning every bar re-checks millions of no-ops during a parameter sweep.
    change_points = np.flatnonzero(np.diff(pos, prepend=0.0) != 0.0)

    for i in change_points:
        i = int(i)
        prev = pos[i - 1] if i > 0 else 0.0
        cur = pos[i]
        # Close any open position first.
        if entry_i is not None and (np.sign(cur) != np.sign(entry_pos) or cur == 0):
            points = (open_px[i] - open_px[entry_i]) * np.sign(entry_pos)
            qty = abs(entry_pos)
            gross = points * instrument.point_value * qty
            fees = 2.0 * qty * (
                instrument.commission_per_side + instrument.slippage_ticks * instrument.tick_value
            )
            rows.append(
                {
                    "entry_time": idx[entry_i],
                    "exit_time": idx[i],
                    "direction": "long" if entry_pos > 0 else "short",
                    "contracts": qty,
                    "entry_price": open_px[entry_i],
                    "exit_price": open_px[i],
                    "points": points,
                    "gross_pnl": gross,
                    "net_pnl": gross - fees,
                    "bars_held": i - entry_i,
                }
            )
            entry_i = None
            entry_pos = 0.0
        # Then open a new one if we are not flat.
        if cur != 0 and entry_i is None:
            entry_i = i
            entry_pos = cur

    return pd.DataFrame(rows)


def compute_stats(
    pnl: pd.Series,
    equity: pd.Series,
    position: pd.Series,
    trades: pd.DataFrame,
    instrument: Instrument,
) -> dict:
    """Summary metrics. Dollar-denominated, since futures have no natural capital base."""
    ann = _bars_per_year(pnl.index)
    sd = float(pnl.std())
    sharpe = float(pnl.mean() / sd * np.sqrt(ann)) if sd > 0 else float("nan")

    downside = pnl[pnl < 0]
    dsd = float(downside.std()) if len(downside) > 1 else 0.0
    sortino = float(pnl.mean() / dsd * np.sqrt(ann)) if dsd > 0 else float("nan")

    running_max = equity.cummax()
    drawdown = equity - running_max
    max_dd = float(-drawdown.min()) if len(drawdown) else 0.0

    net = float(equity.iloc[-1]) if len(equity) else 0.0

    n_trades = len(trades)
    if n_trades:
        wins = trades[trades["net_pnl"] > 0]["net_pnl"]
        losses = trades[trades["net_pnl"] <= 0]["net_pnl"]
        win_rate = len(wins) / n_trades
        gross_win = float(wins.sum())
        gross_loss = float(-losses.sum())
        profit_factor = gross_win / gross_loss if gross_loss > 0 else float("inf")
        avg_trade = float(trades["net_pnl"].mean())
    else:
        win_rate = profit_factor = avg_trade = float("nan")

    span_years = 0.0
    if len(pnl.index) > 1:
        span_years = (pnl.index[-1] - pnl.index[0]).total_seconds() / (365.25 * 86400)

    return {
        "net_pnl": net,
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown": max_dd,
        "calmar": (net / span_years / max_dd) if max_dd > 0 and span_years > 0 else float("nan"),
        "n_trades": n_trades,
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "avg_trade": avg_trade,
        "exposure": float((position != 0).mean()),
        "years": span_years,
        # How much of the gross edge is eaten by frictions. Above ~50% means the
        # strategy is mostly paying the broker.
        "cost_drag": float(
            (trades["gross_pnl"].sum() - trades["net_pnl"].sum()) / abs(trades["gross_pnl"].sum())
        )
        if n_trades and float(trades["gross_pnl"].sum()) != 0
        else float("nan"),
    }
