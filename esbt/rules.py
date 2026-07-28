"""Execution rules that turn a raw signal into something a human can trade.

A signal generator says "the setup is present". It does not say when to give up,
when to stop trading for the day, or when to go home flat. Those decisions are
what separate a backtest from a tradeable plan, and they belong here rather than
being reinvented inside every strategy.

Applied on top of any signal:

- **Time stop.** Exit after N bars regardless of what the signal still says. A
  day trade that has not worked within its holding window is a losing trade that
  has not been closed yet.
- **Entry window.** Only initiate inside a local-time window. Most intraday
  edges in the index live in the first two hours; the lunch lull is a different
  regime and mixing them averages one into the other.
- **End-of-day flat.** Force the position closed before the bell. Carrying an
  index-futures position overnight makes it a different strategy with different
  risk, and holding through the close is the fastest way to turn a good day into
  a gap-driven bad one.
- **Trade budget.** Cap trades per session. Beyond a handful a day a strategy
  stops being manually executable, whatever its Sharpe.

After a forced exit -- a time stop or the bell -- re-entry is blocked until the
signal actually resets. Without that, a persistent signal re-enters on the very
next bar and the time stop does nothing except add commission.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import EXCHANGE_TZ


def apply_rules(
    signal: pd.Series,
    df: pd.DataFrame,
    max_hold_bars: int | None = None,
    entry_window: tuple[str, str] | None = None,
    flatten_at: str = "15:55",
    max_trades_per_day: int | None = None,
    cooldown_bars: int = 0,
) -> pd.Series:
    """Constrain a raw signal into an executable target-position series.

    Parameters
    ----------
    signal
        Raw target position per bar, in {-1, 0, +1}.
    df
        The bars the signal was generated from.
    max_hold_bars
        Force an exit once a position has been held this many bars. ``None``
        holds until the signal itself changes.
    entry_window
        ``(start, end)`` local times bounding *new* entries, e.g.
        ``("09:30", "11:30")``. Exits are always permitted.
    flatten_at
        Local time after which no position may be held.
    max_trades_per_day
        Maximum entries per session.
    cooldown_bars
        Bars to wait after any exit before a new entry is allowed.
    """
    sig = pd.Series(signal, index=df.index).fillna(0.0).to_numpy(dtype=float)
    local = df.index.tz_convert(EXCHANGE_TZ)
    n = len(sig)

    day_key = np.asarray(local.date)
    minutes = np.asarray(local.hour * 60 + local.minute, dtype=int)

    flat_t = pd.Timestamp(flatten_at).time()
    flat_min = flat_t.hour * 60 + flat_t.minute

    if entry_window is not None:
        w0, w1 = (pd.Timestamp(t).time() for t in entry_window)
        win_lo = w0.hour * 60 + w0.minute
        win_hi = w1.hour * 60 + w1.minute
    else:
        win_lo, win_hi = -1, 24 * 60 + 1

    out = np.zeros(n, dtype=float)

    position = 0.0
    held = 0
    trades_today = 0
    cooldown = 0
    blocked_dir = 0.0  # direction locked out until the signal resets
    current_day = day_key[0] if n else None

    for i in range(n):
        if day_key[i] != current_day:
            current_day = day_key[i]
            trades_today = 0
            cooldown = 0
            blocked_dir = 0.0
            # A position can never survive the session boundary; the bell already
            # flattened it, but reset defensively in case of a data gap.
            position = 0.0
            held = 0

        desired = sig[i]
        past_bell = minutes[i] >= flat_min

        # Release the lockout as soon as the signal stops asserting that direction.
        if blocked_dir != 0.0 and desired != blocked_dir:
            blocked_dir = 0.0

        if position != 0.0:
            held += 1
            time_stop = max_hold_bars is not None and held >= max_hold_bars
            signal_exit = desired == 0.0 or np.sign(desired) != np.sign(position)

            if past_bell or time_stop:
                # Forced out. Lock this direction until the signal resets, so the
                # stop cannot be undone by the same unchanged signal next bar.
                blocked_dir = np.sign(position) if desired != 0.0 else 0.0
                position = 0.0
                held = 0
                cooldown = cooldown_bars
            elif signal_exit:
                position = 0.0
                held = 0
                cooldown = cooldown_bars
        else:
            if cooldown > 0:
                cooldown -= 1
            can_enter = (
                desired != 0.0
                and not past_bell
                and cooldown <= 0
                and win_lo <= minutes[i] < win_hi
                and np.sign(desired) != blocked_dir
                and (max_trades_per_day is None or trades_today < max_trades_per_day)
            )
            if can_enter:
                position = np.sign(desired)
                held = 0
                trades_today += 1

        out[i] = position

    return pd.Series(out, index=df.index)


def max_hold_bars_for(df: pd.DataFrame, minutes: int) -> int:
    """Convert a holding limit in minutes into bars for this frame's timeframe."""
    from .session import bar_minutes

    return max(int(round(minutes / bar_minutes(df))), 1)
