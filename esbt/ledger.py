"""A persistent record of every hypothesis this project has tested.

The reason this exists: searching harder makes good results easier to find by
luck, and the correction for that depends on how much searching you have done in
total — not how much you did in the last command you ran.

A single screen of six strategies at 36 combinations each is 216 hypotheses, and
:func:`esbt.walkforward.noise_floor_sharpe` accounts for that within the run. But
a research program is iterative by nature. Adjust a threshold, add a filter, try
a different date range, re-run: after a fortnight of that you may have tested
twenty thousand variants, and the best one you have seen is drawn from twenty
thousand draws, not 216. Judged against the single-run floor it will look
convincing. Judged against the real one it usually does not.

Every screen appends here, and the cumulative trial count feeds a second, higher
bar that a result must clear. It only counts what it is told about, so it is a
floor on your true search effort rather than an exact figure — but a floor is
enough to make the effect visible, and visible is the whole point.

Nothing here blocks you. It only makes the cost of looking harder explicit at
the moment you look.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LEDGER = Path(__file__).resolve().parent.parent / "data" / "ledger.json"


@dataclass
class Entry:
    """One tested hypothesis: a strategy, a grid, a dataset, an outcome."""

    timestamp: str
    strategy: str
    n_combos: int
    n_folds: int
    data_start: str
    data_end: str
    n_bars: int
    timeframe: str
    oos_sharpe: float
    verdict: str
    note: str = ""

    @property
    def trials(self) -> int:
        """Hypotheses represented by this entry: combinations tried per fold."""
        return int(self.n_combos) * max(int(self.n_folds), 1)


@dataclass
class Ledger:
    """Append-only history of tested hypotheses."""

    path: Path = field(default=DEFAULT_LEDGER)
    entries: list[Entry] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | str | None = None) -> "Ledger":
        p = Path(path or DEFAULT_LEDGER)
        if not p.exists():
            return cls(path=p, entries=[])
        try:
            raw = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            # A corrupt ledger must never take down a research run.
            return cls(path=p, entries=[])
        return cls(path=p, entries=[Entry(**e) for e in raw.get("entries", [])])

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"entries": [asdict(e) for e in self.entries]}
        self.path.write_text(json.dumps(payload, indent=2))

    def record(
        self,
        strategy: str,
        n_combos: int,
        n_folds: int,
        data_start: str,
        data_end: str,
        n_bars: int,
        timeframe: str,
        oos_sharpe: float,
        verdict: str,
        note: str = "",
    ) -> Entry:
        entry = Entry(
            timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            strategy=strategy,
            n_combos=int(n_combos),
            n_folds=int(n_folds),
            data_start=str(data_start),
            data_end=str(data_end),
            n_bars=int(n_bars),
            timeframe=str(timeframe),
            oos_sharpe=float(oos_sharpe) if oos_sharpe == oos_sharpe else float("nan"),
            verdict=str(verdict),
            note=note,
        )
        self.entries.append(entry)
        return entry

    def total_trials(self, strategy: str | None = None) -> int:
        """Cumulative hypotheses tested, optionally for one strategy family."""
        if strategy is None:
            return sum(e.trials for e in self.entries)
        base = strategy.split("[")[0]
        return sum(e.trials for e in self.entries if e.strategy.split("[")[0] == base)

    def best_seen(self, strategy: str | None = None) -> float:
        vals = [
            e.oos_sharpe
            for e in self.entries
            if (strategy is None or e.strategy.split("[")[0] == strategy.split("[")[0])
            and e.oos_sharpe == e.oos_sharpe
        ]
        return max(vals) if vals else float("nan")

    def summary(self) -> str:
        if not self.entries:
            return "Ledger empty: no hypotheses recorded yet."
        n_runs = len(self.entries)
        strategies = len({e.strategy for e in self.entries})
        first = min(e.timestamp for e in self.entries)
        return (
            f"Ledger: {self.total_trials():,} hypotheses across {n_runs} runs "
            f"and {strategies} strategy variants since {first[:10]}"
        )


def cumulative_noise_floor(
    total_trials: int, n_obs: int, periods_per_year: float
) -> float:
    """Noise floor computed against the *whole* research program's trial count.

    Same estimator as the per-run floor, fed the cumulative number instead. This
    is the bar that matters once you have been iterating for a while.
    """
    from .walkforward import noise_floor_sharpe

    return noise_floor_sharpe(max(total_trials, 2), n_obs, periods_per_year)


def haircut(observed_sharpe: float, total_trials: int, n_obs: int, ppy: float) -> float:
    """Observed Sharpe minus what the search alone would be expected to produce.

    Negative means the result is fully explained by how hard you looked.
    """
    if not math.isfinite(observed_sharpe):
        return float("nan")
    return observed_sharpe - cumulative_noise_floor(total_trials, n_obs, ppy)
