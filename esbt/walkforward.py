"""Parameter search, walk-forward validation and overfitting diagnostics.

A fast optimizer is an efficient machine for manufacturing false confidence. If
you evaluate 500 parameter combinations against one price series and keep the
best, you will get an excellent-looking equity curve whether or not any edge
exists, because the maximum of 500 noisy estimates is large by construction.

Everything in this module exists to answer one question: *is this result
distinguishable from what pure luck would have produced given how hard I looked?*

The four checks, in rough order of how often they kill a strategy:

1. **Walk-forward.** Parameters are chosen on in-sample data and scored only on
   data that came after. The stitched out-of-sample curve is the only equity
   curve worth looking at.
2. **Noise floor.** The expected best Sharpe from N trials on random data. If
   your best does not clear this, you found nothing.
3. **Plateau, not peak.** Robust parameters have profitable neighbours. An
   isolated spike surrounded by losers is a fitting artifact.
4. **Cost sensitivity.** Re-run the winner with double the slippage. Real edges
   degrade; imaginary ones invert.
"""

from __future__ import annotations

import itertools
import logging
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import Instrument
from .engine import backtest
from .strategies import Strategy

log = logging.getLogger(__name__)

_EULER_MASCHERONI = 0.5772156649015329


def param_combos(grid: dict) -> list[dict]:
    """Expand a parameter grid into a list of concrete keyword dicts."""
    if not grid:
        return [{}]
    keys = list(grid)
    return [dict(zip(keys, vals)) for vals in itertools.product(*(grid[k] for k in keys))]


def sweep(
    df: pd.DataFrame,
    strategy: Strategy,
    instrument: Instrument,
    grid: dict | None = None,
    contracts: int = 1,
) -> pd.DataFrame:
    """Evaluate every parameter combination on one dataset.

    Returns one row per combination with its stats. This is *in-sample* by
    definition -- never report the top row of this table as a result.
    """
    grid = grid if grid is not None else strategy.grid
    rows = []
    for combo_id, params in enumerate(param_combos(grid)):
        try:
            sig = strategy(df, **params)
        except Exception as exc:  # a bad param combo should not kill the sweep
            log.debug("params %s failed: %s", params, exc)
            continue
        res = backtest(df, sig, instrument, contracts=contracts)
        # combo_id lets callers recover the exact original parameter values
        # instead of reading them back out of the DataFrame, where numpy would
        # have silently coerced ints to floats.
        rows.append({"combo_id": combo_id, **params, **res.stats})
    out = pd.DataFrame(rows)
    return out.sort_values("sharpe", ascending=False).reset_index(drop=True) if len(out) else out


def noise_floor_sharpe(n_trials: int, n_obs: int, periods_per_year: float) -> float:
    """Annualized Sharpe expected from the luckiest of ``n_trials`` random strategies.

    Uses the Bailey & Lopez de Prado expected-maximum estimator: the expected
    maximum of N independent standard-normal draws, scaled by the sampling error
    of a per-bar Sharpe estimate over ``n_obs`` observations, then annualized.

    This is the bar your best result has to clear before it means anything. Note
    that it *rises* with the number of parameter combinations you try -- looking
    harder makes the evidence you need stronger, not weaker.
    """
    if n_trials < 2 or n_obs < 2:
        return 0.0
    from statistics import NormalDist

    nd = NormalDist()
    a = nd.inv_cdf(1 - 1.0 / n_trials)
    b = nd.inv_cdf(1 - 1.0 / (n_trials * math.e))
    expected_max_z = (1 - _EULER_MASCHERONI) * a + _EULER_MASCHERONI * b
    per_bar_se = math.sqrt(1.0 / n_obs)
    return expected_max_z * per_bar_se * math.sqrt(periods_per_year)


def plateau_score(results: pd.DataFrame, param_names: list[str], top: dict) -> float:
    """How well the winning parameters are supported by their neighbours.

    Returns the fraction of adjacent grid points (one step away in any single
    dimension) that are also profitable. Near 1.0 means a broad plateau you can
    actually trade; near 0.0 means a needle that will not survive live data.
    """
    if results.empty or not param_names:
        return float("nan")

    # Rank each parameter's distinct values so "adjacent" is well defined.
    levels = {p: sorted(results[p].unique().tolist()) for p in param_names}
    pos = {p: levels[p].index(top[p]) for p in param_names if top[p] in levels[p]}
    if len(pos) != len(param_names):
        return float("nan")

    neighbours = []
    for p in param_names:
        for step in (-1, 1):
            j = pos[p] + step
            if 0 <= j < len(levels[p]):
                query = dict(top)
                query[p] = levels[p][j]
                mask = np.ones(len(results), dtype=bool)
                for k, v in query.items():
                    if k in results.columns:
                        mask &= (results[k] == v).to_numpy()
                match = results[mask]
                if len(match):
                    neighbours.append(float(match.iloc[0]["sharpe"]))

    if not neighbours:
        return float("nan")
    return float(np.mean([s > 0 for s in neighbours]))


@dataclass
class WalkForwardResult:
    """Out-of-sample performance, plus the evidence for trusting or discarding it."""

    oos_equity: pd.Series
    oos_pnl: pd.Series
    folds: pd.DataFrame            # per-fold chosen params and IS/OOS stats
    oos_stats: dict
    n_trials: int
    diagnostics: dict = field(default_factory=dict)

    def verdict(self) -> str:
        """A blunt one-word read on whether this is worth pursuing."""
        d = self.diagnostics
        sharpe = self.oos_stats.get("sharpe", float("nan"))
        if not np.isfinite(sharpe) or sharpe <= 0:
            return "DEAD"
        if sharpe < d.get("noise_floor", 0.0):
            return "INDISTINGUISHABLE FROM NOISE"
        if d.get("stress_sharpe", float("-inf")) <= 0:
            return "FRAGILE (dies on realistic costs)"
        if d.get("plateau", 0.0) < 0.5:
            return "FRAGILE (isolated parameter peak)"
        if d.get("is_oos_decay", 1.0) > 0.7:
            return "OVERFIT (large in-sample to out-of-sample decay)"
        return "SURVIVES"


def walk_forward(
    df: pd.DataFrame,
    strategy: Strategy,
    instrument: Instrument,
    grid: dict | None = None,
    n_splits: int = 5,
    anchored: bool = True,
    contracts: int = 1,
    select_by: str = "sharpe",
) -> WalkForwardResult:
    """Optimize in-sample, score out-of-sample, repeat forward through time.

    Parameters
    ----------
    n_splits
        Number of out-of-sample folds. The first fold is used only for training.
    anchored
        If True, each training window starts at the beginning of the data and
        grows. If False, a rolling window of one fold's length is used, which
        adapts faster but has less data per fit.
    select_by
        Statistic used to pick the winning parameters in-sample.
    """
    grid = grid if grid is not None else strategy.grid
    combos = param_combos(grid)
    bounds = np.linspace(0, len(df), n_splits + 1).astype(int)

    fold_rows = []
    oos_chunks = []

    for k in range(1, n_splits):
        train_start = 0 if anchored else bounds[k - 1]
        train = df.iloc[train_start : bounds[k]]
        test = df.iloc[bounds[k] : bounds[k + 1]]
        if len(train) < 50 or len(test) < 10:
            continue

        is_table = sweep(train, strategy, instrument, grid, contracts)
        if is_table.empty:
            continue
        best = is_table.iloc[0]
        params = combos[int(best["combo_id"])]

        sig = strategy(test, **params)
        oos = backtest(test, sig, instrument, contracts=contracts)
        oos_chunks.append(oos.pnl)

        fold_rows.append(
            {
                "fold": k,
                "train_start": train.index[0],
                "train_end": train.index[-1],
                "test_start": test.index[0],
                "test_end": test.index[-1],
                "combo_id": int(best["combo_id"]),
                **{f"param_{k2}": v for k2, v in params.items()},
                "is_sharpe": float(best[select_by]),
                "oos_sharpe": oos.stats["sharpe"],
                "oos_net_pnl": oos.stats["net_pnl"],
                "oos_trades": oos.stats["n_trades"],
            }
        )

    if not oos_chunks:
        raise RuntimeError("no usable folds; try fewer splits or more data")

    oos_pnl = pd.concat(oos_chunks).sort_index()
    oos_equity = oos_pnl.cumsum()
    folds = pd.DataFrame(fold_rows)

    from .engine import _bars_per_year, compute_stats

    # Rebuild stats over the stitched out-of-sample series.
    empty_trades = pd.DataFrame(
        columns=["net_pnl", "gross_pnl"], dtype=float
    )
    oos_stats = compute_stats(
        oos_pnl, oos_equity, pd.Series(0.0, index=oos_pnl.index), empty_trades, instrument
    )
    oos_stats["n_trades"] = int(folds["oos_trades"].sum())

    ppy = _bars_per_year(oos_pnl.index)
    diagnostics = {
        "noise_floor": noise_floor_sharpe(len(combos), len(oos_pnl), ppy),
        "n_trials_per_fold": len(combos),
        "mean_is_sharpe": float(folds["is_sharpe"].mean()),
        "mean_oos_sharpe": float(folds["oos_sharpe"].mean()),
        "folds_profitable": float((folds["oos_net_pnl"] > 0).mean()),
    }
    # How much of the in-sample edge survived. 1.0 means all of it vanished.
    mis = diagnostics["mean_is_sharpe"]
    diagnostics["is_oos_decay"] = (
        float((mis - diagnostics["mean_oos_sharpe"]) / abs(mis)) if mis else float("nan")
    )

    # Parameter stability: how often the optimizer picked the same values.
    param_cols = [c for c in folds.columns if c.startswith("param_")]
    if param_cols and len(folds) > 1:
        stability = np.mean([folds[c].nunique() == 1 for c in param_cols])
        diagnostics["param_stability"] = float(stability)

    # Cost sensitivity: replay the most-recently-chosen parameters at double slippage.
    if len(folds):
        params = combos[int(folds.iloc[-1]["combo_id"])]
        stressed = instrument.with_stress(2.0)
        sig = strategy(df, **params)
        diagnostics["stress_sharpe"] = backtest(df, sig, stressed, contracts).stats["sharpe"]

        # Plateau check on the full sample, using the same grid.
        full_table = sweep(df, strategy, instrument, grid, contracts)
        if len(full_table):
            top = {k2: full_table.iloc[0][k2] for k2 in grid}
            diagnostics["plateau"] = plateau_score(full_table, list(grid), top)

    return WalkForwardResult(
        oos_equity=oos_equity,
        oos_pnl=oos_pnl,
        folds=folds,
        oos_stats=oos_stats,
        n_trials=len(combos) * max(len(folds), 1),
        diagnostics=diagnostics,
    )
