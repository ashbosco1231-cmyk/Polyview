"""Tests for the execution rules and session helpers.

These constraints are the difference between a backtest and a plan a person can
actually follow, so each one is pinned down explicitly.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from esbt.config import ES
from esbt.data import back_adjust
from esbt.engine import backtest
from esbt.rules import apply_rules
from esbt.session import (
    bar_minutes,
    minutes_since_open,
    opening_range,
    prior_session_levels,
    session_date,
    session_vwap,
    trade_activity,
)
from esbt.strategies import REGISTRY, build_signal
from esbt.synthetic import generate


def session_frame(days: int = 3, freq: str = "5min") -> pd.DataFrame:
    """A few clean NY sessions of flat price, for exercising timing rules."""
    frames = []
    for d in pd.bdate_range("2024-03-04", periods=days, tz="America/New_York"):
        idx = pd.date_range(
            d.replace(hour=9, minute=30), d.replace(hour=15, minute=55), freq=freq,
            tz="America/New_York",
        )
        frames.append(pd.DataFrame({"open": 5000.0, "high": 5001.0, "low": 4999.0,
                                    "close": 5000.0, "volume": 1000}, index=idx))
    out = pd.concat(frames)
    out.index = out.index.tz_convert("UTC")
    return out


@pytest.fixture(scope="module")
def bars():
    return back_adjust(generate(start="2023-01-02", end="2023-06-30", bar="5min", seed=5))


class TestTimeStop:
    def test_position_never_exceeds_max_hold(self):
        df = session_frame()
        always_long = pd.Series(1.0, index=df.index)
        pos = apply_rules(always_long, df, max_hold_bars=4)

        # No run of consecutive non-zero positions may exceed the limit.
        runs, current = [], 0
        for v in pos:
            if v != 0:
                current += 1
            else:
                runs.append(current)
                current = 0
        runs.append(current)
        assert max(runs) <= 4

    def test_thirty_minute_cap_is_respected_end_to_end(self, bars):
        """The headline constraint: no trade may last longer than 30 minutes."""
        bm = bar_minutes(bars)
        for name, strat in REGISTRY.items():
            params = {k: v[len(v) // 2] for k, v in strat.grid.items()}
            params["hold_min"] = 30
            sig = build_signal(strat, bars, **params)
            res = backtest(bars, sig, ES)
            if res.trades.empty:
                continue
            longest = res.trades["bars_held"].max() * bm
            assert longest <= 30, f"{name} held {longest} minutes"

    def test_forced_exit_does_not_immediately_re_enter(self):
        """A time stop must not be undone by the same unchanged signal next bar."""
        df = session_frame(days=1)
        always_long = pd.Series(1.0, index=df.index)
        pos = apply_rules(always_long, df, max_hold_bars=3)
        # With a persistent signal and no reset, exactly one trade should occur.
        entries = int(((pos != 0) & (pos.shift(1).fillna(0) == 0)).sum())
        assert entries == 1


class TestSessionDiscipline:
    def test_flat_before_the_bell(self):
        df = session_frame()
        pos = apply_rules(pd.Series(1.0, index=df.index), df, flatten_at="15:30")
        local = pos.index.tz_convert("America/New_York")
        late = pos[(local.hour * 60 + local.minute) >= (15 * 60 + 30)]
        assert (late == 0).all()

    def test_no_position_survives_overnight(self):
        df = session_frame(days=3)
        pos = apply_rules(pd.Series(1.0, index=df.index), df, flatten_at="15:55")
        day = session_date(df)
        # Last bar of every session must be flat.
        last_of_day = pos.groupby(day).last()
        assert (last_of_day == 0).all()

    def test_entry_window_is_enforced(self):
        df = session_frame()
        pos = apply_rules(
            pd.Series(1.0, index=df.index), df, entry_window=("10:00", "11:00"),
            max_hold_bars=2,
        )
        local = pos.index.tz_convert("America/New_York")
        mins = local.hour * 60 + local.minute
        # Nothing may be opened before the window starts.
        before = pos[mins < 10 * 60]
        assert (before == 0).all()
        # And something should trade inside it.
        inside = pos[(mins >= 10 * 60) & (mins < 11 * 60)]
        assert (inside != 0).any()

    def test_trade_budget_caps_entries_per_session(self):
        df = session_frame(days=3)
        # Alternating signal so entries are always available.
        alt = pd.Series(np.tile([1.0, 0.0], len(df) // 2 + 1)[: len(df)], index=df.index)
        pos = apply_rules(alt, df, max_trades_per_day=2, max_hold_bars=1)
        entries = (pos != 0) & (pos.shift(1).fillna(0) == 0)
        per_day = entries.groupby(session_date(df)).sum()
        assert per_day.max() <= 2


class TestSessionHelpers:
    def test_minutes_since_open_starts_at_zero(self):
        df = session_frame(days=1)
        assert minutes_since_open(df).iloc[0] == 0.0

    def test_opening_range_is_not_known_before_it_forms(self):
        df = session_frame(days=1, freq="5min")
        _, _, formed = opening_range(df, minutes=30)
        elapsed = minutes_since_open(df)
        assert not formed[elapsed < 30].any()
        assert formed[elapsed >= 30].all()

    def test_prior_levels_never_come_from_today(self, bars):
        prior = prior_session_levels(bars)
        day = session_date(bars)
        first_day = day.iloc[0]
        # The first session has no prior session, so its levels must be missing.
        assert prior[day == first_day]["prior_high"].isna().all()

    def test_prior_levels_match_the_previous_session(self, bars):
        day = session_date(bars)
        daily_high = bars["high"].groupby(day).max()
        prior = prior_session_levels(bars)
        days = list(daily_high.index)
        # Pick a day in the middle and check it sees yesterday's high.
        target = days[10]
        got = prior[day == target]["prior_high"].iloc[0]
        assert got == pytest.approx(daily_high.loc[days[9]])

    def test_vwap_resets_each_session(self, bars):
        vwap = session_vwap(bars)
        day = session_date(bars)
        # The first bar of a session has VWAP equal to its own typical price.
        first_idx = bars.groupby(day).head(1).index
        typical = (bars["high"] + bars["low"] + bars["close"]) / 3.0
        assert np.allclose(vwap.loc[first_idx], typical.loc[first_idx], rtol=1e-9)

    def test_grouping_uses_exchange_local_date(self, bars):
        """UTC grouping would splice two trading days together mid-afternoon."""
        day = session_date(bars)
        local = bars.index.tz_convert("America/New_York")
        # Every bar in a group must share one local calendar date.
        assert (pd.Series(local.date, index=bars.index) == day).all()
        # And a session must not span a UTC date boundary silently.
        assert day.nunique() >= 100


class TestSyntheticRealism:
    def test_sessions_gap_overnight(self, bars):
        day = session_date(bars)
        first_open = bars["open"].groupby(day).first()
        last_close = bars["close"].groupby(day).last()
        gaps = (first_open.to_numpy()[1:] - last_close.to_numpy()[:-1])
        assert np.abs(gaps).mean() > 1.0, "generated sessions do not gap"

    def test_gap_strategies_actually_fire(self, bars):
        strat = REGISTRY["gap_fade"]
        sig = build_signal(strat, bars, min_gap_pts=3.0, max_gap_pts=40.0, hold_min=20)
        res = backtest(bars, sig, ES)
        act = trade_activity(res.trades, bars, bar_minutes(bars))
        assert act["days_traded_pct"] > 0.05, "gap_fade almost never triggers"


class TestAllStrategiesAreTradeable:
    @pytest.mark.parametrize("name", sorted(REGISTRY))
    def test_manual_tradeability(self, name, bars):
        strat = REGISTRY[name]
        params = {k: v[len(v) // 2] for k, v in strat.grid.items()}
        sig = build_signal(strat, bars, **params)
        res = backtest(bars, sig, ES)
        act = trade_activity(res.trades, bars, bar_minutes(bars))
        assert act["trades_per_day"] <= 5.0, f"{name} fires {act['trades_per_day']:.1f}x/day"
        if res.trades.empty:
            return
        assert act["max_hold_min"] <= 30
