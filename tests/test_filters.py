"""Tests for regime filters and strategy composition.

Filters are the easiest place in this codebase to introduce lookahead. A filter
that classifies a session using where it eventually closed will produce a
magnificent and entirely fictional equity curve, and nothing else in the harness
would catch it -- the walk-forward split is on time, and a lookahead filter
cheats identically in-sample and out-of-sample, so it survives every other
check. Hence these tests.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from esbt import filters
from esbt.config import ES
from esbt.data import back_adjust
from esbt.engine import backtest
from esbt.session import session_date
from esbt.strategies import REGISTRY, build_signal, with_filters
from esbt.synthetic import generate


@pytest.fixture(scope="module")
def bars():
    return back_adjust(generate(start="2023-01-02", end="2023-09-29", bar="5min", seed=9))


def _cheating_filter(df, **_kwargs):
    """A deliberately non-causal filter, used to prove the probe below works.

    Classifies each session using where it *closed* -- information unavailable
    until the session is over. This is the canonical intraday lookahead bug.
    """
    day = session_date(df)
    close = df["close"]
    span = close.groupby(day).transform("last") - close.groupby(day).transform("first")
    return span.abs() > 3.0


def _probe_causality(fn, params, bars, n_probes: int = 12):
    """Cut the series mid-session repeatedly; compare only the truncated session.

    Truncating on a session boundary is not sufficient: a filter that peeks at a
    completed session's close produces identical values either way, so
    boundary-aligned truncation cannot detect intra-session lookahead -- which is
    precisely the kind that matters for day trading. Cutting halfway through a
    session and comparing that session's bars is what exposes it.

    Returns ``(differing, checked)``.
    """
    day = session_date(bars)
    days = list(pd.unique(day))
    rng = np.random.default_rng(0)
    differing = checked = 0

    for target in rng.choice(days[60:-2], size=n_probes, replace=False):
        idx = np.flatnonzero((day == target).to_numpy())
        cut = idx[len(idx) // 2]
        truncated = bars.iloc[: cut + 1]

        full_vals = fn(bars, **params).iloc[idx[0] : cut + 1]
        trunc_vals = fn(truncated, **params).iloc[idx[0] : cut + 1]

        both = full_vals.notna() & trunc_vals.notna()
        differing += int((full_vals[both] != trunc_vals[both]).sum())
        checked += int(both.sum())

    return differing, checked


class TestCausality:
    """Every filter must be computable from the past alone."""

    @pytest.mark.parametrize("name", sorted(filters.REGISTRY))
    def test_filter_does_not_depend_on_the_future(self, name, bars):
        f = filters.REGISTRY[name]
        params = {k: list(v)[0] for k, v in f.grid.items()}
        differing, checked = _probe_causality(f.fn, params, bars)
        assert checked > 0, "probe checked nothing"
        assert differing == 0, (
            f"{name} changed on {differing}/{checked} bars when future data "
            f"was removed -- it is reading ahead"
        )

    def test_the_probe_actually_detects_lookahead(self, bars):
        """A guard that never fires is not a guard.

        Without this, the causality test above could be silently vacuous -- and
        an earlier version of it was: it truncated on session boundaries and
        passed a filter that read each session's closing price.
        """
        differing, checked = _probe_causality(_cheating_filter, {}, bars)
        assert differing > 0, (
            "the causality probe failed to detect a filter that reads the "
            "session's closing price -- the probe itself is broken"
        )

    def test_trend_day_uses_only_bars_seen_so_far(self, bars):
        """The classic lookahead trap, tested explicitly."""
        mask = filters.trend_day(bars, min_share=0.5, max_share=1.0)
        day = session_date(bars)
        # The first bar of a session cannot yet know the session is trending in
        # any meaningful sense; it is trivially 100% one-sided.
        # What must hold is that truncating a session changes nothing before the cut.
        one_day = bars[day == day.iloc[len(bars) // 2]]
        half = one_day.iloc[: len(one_day) // 2]
        full_mask = filters.trend_day(one_day, 0.5, 1.0).iloc[: len(half)]
        half_mask = filters.trend_day(half, 0.5, 1.0)
        assert full_mask.equals(half_mask)

    def test_opening_range_size_is_false_before_range_forms(self, bars):
        mask = filters.opening_range_size(bars, or_minutes=30, low=0.0, high=1.0)
        from esbt.session import minutes_since_open

        early = minutes_since_open(bars) < 30
        assert not mask[early].any()


class TestFilterBehaviour:
    def test_filters_only_ever_reduce_trading(self, bars):
        """A filter may forbid trades; it must never create them."""
        strat = REGISTRY["opening_range_breakout"]
        params = {k: list(v)[len(list(v)) // 2] for k, v in strat.grid.items()}

        base = build_signal(strat, bars, **params)
        filtered_strat = with_filters(strat, "volatility_regime")
        fparams = dict(params)
        fparams["f__volatility_regime__low"] = 0.5
        fparams["f__volatility_regime__high"] = 1.0
        filtered = build_signal(filtered_strat, bars, **fparams)

        base_entries = ((base != 0) & (base.shift(1).fillna(0) == 0)).sum()
        filt_entries = ((filtered != 0) & (filtered.shift(1).fillna(0) == 0)).sum()
        assert filt_entries <= base_entries

    def test_permissive_filter_changes_little(self, bars):
        """A filter set to allow everything should barely alter the signal."""
        strat = REGISTRY["prior_day_break"]
        params = {k: list(v)[0] for k, v in strat.grid.items()}
        base = build_signal(strat, bars, **params)

        wide = with_filters(strat, "gap_size")
        wparams = dict(params)
        wparams["f__gap_size__min_pts"] = 0.0
        wparams["f__gap_size__max_pts"] = 1e9
        gated = build_signal(wide, bars, **wparams)
        assert (base != gated).mean() < 0.02

    def test_combine_is_conjunctive(self, bars):
        a = filters.volatility_regime(bars, low=0.0, high=0.5)
        b = filters.trend_day(bars, min_share=0.0, max_share=0.3)
        both = filters.combine(
            bars,
            {"volatility_regime": {"low": 0.0, "high": 0.5},
             "trend_day": {"min_share": 0.0, "max_share": 0.3}},
        )
        assert both.equals(a & b)


class TestComposition:
    def test_with_filters_expands_the_grid(self):
        strat = REGISTRY["vwap_reversion"]
        base_combos = np.prod([len(list(v)) for v in strat.grid.values()])
        filtered = with_filters(strat, "volatility_regime")
        new_combos = np.prod([len(list(v)) for v in filtered.grid.values()])
        assert new_combos > base_combos
        assert filtered.filters == ("volatility_regime",)

    def test_filtered_strategy_still_obeys_execution_rules(self, bars):
        strat = with_filters(REGISTRY["opening_range_breakout"], "trend_day")
        params = {k: list(v)[0] for k, v in strat.grid.items()}
        params["hold_min"] = 15
        sig = build_signal(strat, bars, **params)
        res = backtest(bars, sig, ES)
        if res.trades.empty:
            return
        from esbt.session import bar_minutes

        assert res.trades["bars_held"].max() * bar_minutes(bars) <= 15
        # Still flat overnight.
        assert (sig.groupby(session_date(bars)).last() == 0).all()

    def test_filter_names_are_namespaced(self):
        """Two filters sharing a parameter name must not collide."""
        strat = with_filters(REGISTRY["gap_fade"], "volatility_regime", "opening_range_size")
        keys = [k for k in strat.grid if k.startswith("f__")]
        assert "f__volatility_regime__low" in keys
        assert "f__opening_range_size__low" in keys
        assert len({k for k in keys}) == len(keys)


class TestLedger:
    def test_trials_accumulate_across_runs(self, tmp_path):
        from esbt.ledger import Ledger

        led = Ledger.load(tmp_path / "l.json")
        led.record("a", n_combos=36, n_folds=4, data_start="2023-01-01",
                   data_end="2023-12-31", n_bars=1000, timeframe="5min",
                   oos_sharpe=1.0, verdict="DEAD")
        led.record("b", n_combos=100, n_folds=4, data_start="2023-01-01",
                   data_end="2023-12-31", n_bars=1000, timeframe="5min",
                   oos_sharpe=2.0, verdict="DEAD")
        led.save()

        reloaded = Ledger.load(tmp_path / "l.json")
        assert reloaded.total_trials() == 36 * 4 + 100 * 4

    def test_noise_floor_rises_with_search_effort(self):
        from esbt.ledger import cumulative_noise_floor

        small = cumulative_noise_floor(100, 10_000, 6552)
        large = cumulative_noise_floor(100_000, 10_000, 6552)
        assert large > small, "looking harder must raise the bar, not lower it"

    def test_corrupt_ledger_does_not_break_a_run(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text("{not valid json")
        from esbt.ledger import Ledger

        assert Ledger.load(p).entries == []
