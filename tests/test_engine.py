"""Tests for the parts that would silently corrupt results if wrong."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from esbt.config import ES, MES
from esbt.data import back_adjust, restrict_to_rth
from esbt.engine import backtest
from esbt.synthetic import generate


@pytest.fixture(scope="module")
def bars():
    return generate(start="2023-01-02", end="2023-06-30", bar="5min", seed=3)


def _ma_crossover(df, fast=20, slow=100):
    """A plain trend signal, local to these tests.

    The engine must be testable independently of whichever strategies happen to
    live in the registry, so this deliberately does not import one. It is also
    free of session/timing rules, which is what makes it a clean probe for the
    engine's own accounting.
    """
    if fast >= slow:
        return pd.Series(0.0, index=df.index)
    close = df["close"]
    return np.sign(close.rolling(fast).mean() - close.rolling(slow).mean()).fillna(0.0)


def _flat_frame(prices):
    idx = pd.date_range("2024-01-02 14:30", periods=len(prices), freq="1min", tz="UTC")
    return pd.DataFrame(
        {"open": prices, "high": prices, "low": prices, "close": prices, "volume": 1},
        index=idx,
    )


class TestNoLookahead:
    def test_signal_is_delayed_one_bar(self):
        """A signal on bar i must not capture bar i's own move."""
        # Price jumps only between bar 1 and bar 2.
        df = _flat_frame([100.0, 100.0, 110.0, 110.0])
        # A clairvoyant signal: go long exactly on the bar before the jump.
        sig = pd.Series([0.0, 1.0, 0.0, 0.0], index=df.index)
        res = backtest(df, sig, ES)
        # Position is held during bar 2, capturing open[2]->open[3] = 0, not the jump.
        assert res.position.tolist() == [0.0, 0.0, 1.0, 0.0]

    def test_cannot_profit_from_same_bar_information(self):
        """Signalling off the current bar's close must not print free money."""
        df = _flat_frame([100.0, 100.0, 110.0, 110.0])
        # Signal derived from the close of the very bar that moved.
        sig = (df["close"].diff() > 0).astype(float)
        res = backtest(df, sig, ES)
        # The move is already over by the time the position exists.
        assert res.equity.iloc[-1] <= 0


class TestCosts:
    def test_round_turn_charges_both_sides(self):
        df = _flat_frame([100.0] * 5)
        sig = pd.Series([1.0, 1.0, 0.0, 0.0, 0.0], index=df.index)
        res = backtest(df, sig, ES)
        expected = 2 * (ES.commission_per_side + ES.slippage_ticks * ES.tick_value)
        assert res.costs == pytest.approx(expected)

    def test_flat_market_loses_exactly_the_costs(self):
        df = _flat_frame([100.0] * 10)
        sig = pd.Series([1.0] * 5 + [0.0] * 5, index=df.index)
        res = backtest(df, sig, ES)
        assert res.equity.iloc[-1] == pytest.approx(-ES.round_turn_cost)

    def test_micro_contract_scales_pnl_down(self):
        df = _flat_frame([100.0, 100.0, 110.0, 110.0])
        sig = pd.Series([1.0] * 4, index=df.index)
        es = backtest(df, sig, ES).pnl.sum()
        mes = backtest(df, sig, MES).pnl.sum()
        # MES is 1/10 the notional; after its own costs it must be far smaller.
        assert mes < es

    def test_point_value_is_correct(self):
        assert ES.point_value == pytest.approx(50.0)
        assert MES.point_value == pytest.approx(5.0)

    def test_ten_point_move_is_500_dollars(self):
        # Opens are [100, 100, 110, 110]. A signal on bar 0 is held through bar 1,
        # which is the bar that captures open[1] -> open[2] = +10 points.
        df = _flat_frame([100.0, 100.0, 110.0, 110.0])
        sig = pd.Series([1.0, 0.0, 0.0, 0.0], index=df.index)
        res = backtest(df, sig, ES)
        gross = res.pnl.sum() + res.costs
        assert gross == pytest.approx(500.0)


class TestBackAdjustment:
    def test_removes_roll_discontinuities(self, bars):
        adj = back_adjust(bars, method="difference")
        rolls = adj.index[adj["roll"]]
        assert len(rolls) > 0, "fixture should span at least one roll"
        # Across every roll boundary the adjusted close change should be a normal
        # bar move, not the injected 12-point step.
        pos = np.flatnonzero(adj["roll"].to_numpy())
        jumps = np.abs(adj["close"].to_numpy()[pos] - adj["close"].to_numpy()[pos - 1])
        assert jumps.max() < 5.0

    def test_preserves_recent_prices(self, bars):
        """Back-adjustment must not alter the most recent contract's real prices."""
        adj = back_adjust(bars, method="difference")
        last_roll = np.flatnonzero(adj["roll"].to_numpy())[-1]
        assert adj["close"].iloc[last_roll:].equals(bars["close"].iloc[last_roll:])

    def test_raw_data_creates_phantom_edge(self, bars):
        """The reason back-adjustment is not optional."""
        raw_res = backtest(bars, _ma_crossover(bars, 10, 50), ES)
        adj = back_adjust(bars)
        adj_res = backtest(adj, _ma_crossover(adj, 10, 50), ES)
        # The roll steps are pure artifact; they must move the result.
        assert raw_res.equity.iloc[-1] != pytest.approx(adj_res.equity.iloc[-1])

    def test_requires_symbol_column(self):
        df = _flat_frame([100.0] * 3)
        with pytest.raises(ValueError, match="symbol"):
            back_adjust(df)


class TestAnnualization:
    """Guards a bug that inflated every Sharpe by ~31.6x without other symptoms."""

    @pytest.mark.parametrize(
        "freq,expected",
        [("1min", 390 * 252), ("5min", 390 * 252 / 5), ("15min", 390 * 252 / 15),
         ("1h", 390 * 252 / 60)],
    )
    def test_bars_per_year_is_resolution_independent(self, freq, expected):
        from esbt.engine import _bars_per_year

        idx = pd.date_range("2024-01-02 14:30", periods=200, freq=freq, tz="UTC")
        assert _bars_per_year(idx) == pytest.approx(expected, rel=0.01)

    def test_sharpe_does_not_depend_on_index_unit(self):
        """The same series stored at us and ns resolution must score identically."""
        from esbt.engine import _bars_per_year

        idx = pd.date_range("2024-01-02 14:30", periods=500, freq="5min", tz="UTC")
        as_us = idx.astype("datetime64[us, UTC]")
        as_ns = idx.astype("datetime64[ns, UTC]")
        assert _bars_per_year(as_us) == pytest.approx(_bars_per_year(as_ns))

    def test_sharpe_is_physically_plausible(self):
        """A trend strategy on random data must not report a Sharpe above ~5."""
        b = back_adjust(generate(start="2023-01-02", end="2023-12-29", bar="15min", seed=11))
        res = backtest(b, _ma_crossover(b, 20, 100), ES)
        assert abs(res.stats["sharpe"]) < 5.0, (
            f"implausible Sharpe {res.stats['sharpe']:.1f} -- check annualization"
        )


class TestSessionFilter:
    def test_keeps_only_rth_weekdays(self):
        idx = pd.date_range("2024-01-01", "2024-01-08", freq="1h", tz="UTC")
        df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0}, index=idx)
        out = restrict_to_rth(df)
        local = out.index.tz_convert("America/New_York")
        assert (local.dayofweek < 5).all()
        assert local.hour.min() >= 9
        assert local.hour.max() < 16


class TestNoEdgeOnRandomData:
    """The harness must report 'nothing here' when there is nothing here.

    These assertions are deliberately statistical. A single backtest on a random
    walk has an enormous spread -- tens of thousands of dollars either way -- so
    asserting that any one run loses money would be a flaky test that also
    misrepresents how noisy this measurement is. What must hold is that the
    *average* result across many independent samples shows no edge.
    """

    def test_no_systematic_edge_across_seeds(self):
        results = []
        for seed in range(24):
            b = generate(start="2023-01-02", end="2023-06-30", bar="5min", seed=seed)
            a = back_adjust(b)
            results.append(backtest(a, _ma_crossover(a, 20, 100), ES).equity.iloc[-1])

        arr = np.array(results, dtype=float)
        stderr = arr.std(ddof=1) / np.sqrt(len(arr))
        # Mean PnL must be within noise of zero (and is expected to be slightly
        # negative, since costs are paid on every trade).
        assert abs(arr.mean()) < 2.5 * stderr, (
            f"random-walk data produced a systematic edge: "
            f"mean ${arr.mean():,.0f} vs stderr ${stderr:,.0f}"
        )

    def test_price_series_is_a_martingale(self):
        """No upward drift in price space, or net-long strategies get free money."""
        finals = []
        for seed in range(40):
            b = generate(start="2023-01-02", end="2023-06-30", bar="1h", seed=seed)
            finals.append(b["close"].iloc[-1] / b["close"].iloc[0] - 1.0)
        arr = np.array(finals)
        stderr = arr.std(ddof=1) / np.sqrt(len(arr))
        assert abs(arr.mean()) < 2.5 * stderr, (
            f"synthetic prices drift: mean return {arr.mean():.4%}"
        )
