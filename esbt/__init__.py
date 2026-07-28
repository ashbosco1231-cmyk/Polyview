"""esbt - a free, honest backtesting harness for CME equity index futures.

Deliberately not a trading system. It is a machine for finding out whether an
idea is distinguishable from luck, and it is built to say "no" convincingly.
"""

from .config import ES, MES, Instrument, get_instrument
from .engine import Result, backtest
from .walkforward import WalkForwardResult, sweep, walk_forward

__version__ = "0.1.0"

__all__ = [
    "ES",
    "MES",
    "Instrument",
    "get_instrument",
    "backtest",
    "Result",
    "sweep",
    "walk_forward",
    "WalkForwardResult",
]
