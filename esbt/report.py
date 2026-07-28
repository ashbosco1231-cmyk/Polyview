"""Terminal reporting.

Deliberately blunt. The headline number is the out-of-sample Sharpe next to the
noise floor, because that comparison is the one that decides whether anything
else on the page is worth reading.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .engine import Result
from .walkforward import WalkForwardResult

_LINE = "-" * 62


def _fmt(v, spec="{:.2f}") -> str:
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "n/a"
    return spec.format(v)


def format_stats(stats: dict, title: str = "Backtest") -> str:
    rows = [
        ("Net PnL", f"${stats.get('net_pnl', 0):,.0f}"),
        ("Sharpe (annualized)", _fmt(stats.get("sharpe"))),
        ("Sortino", _fmt(stats.get("sortino"))),
        ("Max drawdown", f"${stats.get('max_drawdown', 0):,.0f}"),
        ("Calmar", _fmt(stats.get("calmar"))),
        ("Trades", f"{stats.get('n_trades', 0):,}"),
        ("Win rate", _fmt(stats.get("win_rate", float('nan')) * 100, "{:.1f}%")),
        ("Profit factor", _fmt(stats.get("profit_factor"))),
        ("Avg trade", f"${stats.get('avg_trade', float('nan')):,.2f}"
         if np.isfinite(stats.get("avg_trade", float("nan"))) else "n/a"),
        ("Time in market", _fmt(stats.get("exposure", float('nan')) * 100, "{:.1f}%")),
        ("Cost drag on gross", _fmt(stats.get("cost_drag", float('nan')) * 100, "{:.1f}%")),
    ]
    out = [_LINE, title, _LINE]
    out += [f"  {k:<24} {v:>16}" for k, v in rows]
    return "\n".join(out)


def format_result(result: Result, title: str = "Backtest") -> str:
    return format_stats(result.stats, title)


def format_walk_forward(wf: WalkForwardResult, title: str = "Walk-forward") -> str:
    """Full out-of-sample report with the overfitting verdict up front."""
    d = wf.diagnostics
    oos_sharpe = wf.oos_stats.get("sharpe", float("nan"))
    floor = d.get("noise_floor", 0.0)

    out = [_LINE, f"{title}: OUT-OF-SAMPLE RESULTS ONLY", _LINE]
    out.append(f"  VERDICT: {wf.verdict()}")
    out.append("")
    out.append(f"  {'OOS Sharpe':<28} {_fmt(oos_sharpe):>12}")
    out.append(f"  {'Noise floor (must beat)':<28} {_fmt(floor):>12}")
    margin = oos_sharpe - floor if np.isfinite(oos_sharpe) else float("nan")
    out.append(f"  {'Margin over noise':<28} {_fmt(margin):>12}")
    out.append("")
    out.append(f"  {'OOS net PnL':<28} {'$' + format(wf.oos_stats.get('net_pnl', 0), ',.0f'):>12}")
    out.append(f"  {'OOS max drawdown':<28} {'$' + format(wf.oos_stats.get('max_drawdown', 0), ',.0f'):>12}")
    out.append(f"  {'OOS trades':<28} {wf.oos_stats.get('n_trades', 0):>12,}")
    out.append("")
    out.append("  Overfitting diagnostics")
    out.append(f"  {'  Parameter combos tried':<28} {d.get('n_trials_per_fold', 0):>12,}")
    out.append(f"  {'  Mean in-sample Sharpe':<28} {_fmt(d.get('mean_is_sharpe')):>12}")
    out.append(f"  {'  Mean OOS Sharpe':<28} {_fmt(d.get('mean_oos_sharpe')):>12}")
    out.append(f"  {'  IS->OOS decay':<28} {_fmt(d.get('is_oos_decay', float('nan')) * 100, '{:.0f}%'):>12}")
    out.append(f"  {'  Profitable folds':<28} {_fmt(d.get('folds_profitable', float('nan')) * 100, '{:.0f}%'):>12}")
    out.append(f"  {'  Parameter stability':<28} {_fmt(d.get('param_stability', float('nan')) * 100, '{:.0f}%'):>12}")
    out.append(f"  {'  Plateau (neighbours +ve)':<28} {_fmt(d.get('plateau', float('nan')) * 100, '{:.0f}%'):>12}")
    out.append(f"  {'  Sharpe at 2x slippage':<28} {_fmt(d.get('stress_sharpe')):>12}")
    out.append("")
    out.append("  Per-fold detail")
    if len(wf.folds):
        cols = ["fold"] + [c for c in wf.folds.columns if c.startswith("param_")] + [
            "is_sharpe", "oos_sharpe", "oos_net_pnl", "oos_trades"
        ]
        table = wf.folds[cols].to_string(index=False, float_format=lambda x: f"{x:,.2f}")
        out += ["    " + ln for ln in table.splitlines()]
    out.append(_LINE)
    return "\n".join(out)


def format_sweep(table: pd.DataFrame, top_n: int = 10) -> str:
    """Show the top of an in-sample sweep, with the mandatory health warning."""
    if table.empty:
        return "(no results)"
    cols = [c for c in table.columns if c not in ("combo_id",)]
    view = table[cols].head(top_n)
    out = [
        _LINE,
        f"In-sample parameter sweep (top {min(top_n, len(table))} of {len(table)})",
        "WARNING: in-sample only. The best row here is the most overfit row here.",
        _LINE,
    ]
    out += ["  " + ln for ln in view.to_string(index=False,
                                               float_format=lambda x: f"{x:,.2f}").splitlines()]
    out.append(_LINE)
    return "\n".join(out)
