"""Contract specifications and cost models for CME equity index futures.

Every number here directly scales your backtested PnL. Getting the tick value or
commission wrong is the most common reason a paper edge evaporates in live trading,
so these are explicit rather than buried in the engine.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

# CME equity index futures roll on the quarterly cycle.
QUARTERLY_MONTHS = (3, 6, 9, 12)

# Databento continuous-contract roll rules (the middle token in e.g. "ES.v.0").
#   c -> calendar:      nearest contract by expiration date
#   n -> open interest: contract with the highest open interest
#   v -> volume:        contract with the highest traded volume
# Volume is the closest match to where liquidity actually is during roll week,
# which is what you would be filled against.
ROLL_RULES = {"calendar": "c", "open_interest": "n", "volume": "v"}


@dataclass(frozen=True)
class Instrument:
    """Contract spec plus the trading frictions applied to every fill."""

    root: str
    name: str
    tick_size: float          # minimum price increment, in index points
    tick_value: float         # dollar value of one tick, per contract
    commission_per_side: float  # dollars per contract per side (in or out)
    slippage_ticks: float     # ticks of adverse fill assumed on every entry and exit

    @property
    def point_value(self) -> float:
        """Dollar value of a one-point move, per contract."""
        return self.tick_value / self.tick_size

    @property
    def round_turn_cost(self) -> float:
        """All-in dollar cost of one complete trade: both commissions plus both slips."""
        return 2.0 * self.commission_per_side + 2.0 * self.slippage_ticks * self.tick_value

    def with_stress(self, slippage_multiple: float = 2.0) -> "Instrument":
        """Return a copy with inflated slippage, for cost-sensitivity testing.

        An edge that survives on paper but dies here was never an edge; it was
        sitting inside the bid-ask spread.
        """
        return replace(self, slippage_ticks=self.slippage_ticks * slippage_multiple)


# ES: the full-size E-mini. 0.25 pt tick = $12.50, so $50 per index point.
ES = Instrument(
    root="ES",
    name="E-mini S&P 500",
    tick_size=0.25,
    tick_value=12.50,
    commission_per_side=1.25,
    slippage_ticks=1.0,
)

# MES: the micro, one tenth the size. Same tick grid, so costs are proportionally
# far heavier -- a strategy that only works on ES may be pure loss on MES.
MES = Instrument(
    root="MES",
    name="Micro E-mini S&P 500",
    tick_size=0.25,
    tick_value=1.25,
    commission_per_side=0.35,
    slippage_ticks=1.0,
)

INSTRUMENTS = {"ES": ES, "MES": MES}

# Regular US cash-session hours in exchange-local time. ES itself trades nearly
# 24h, but overnight books are thin and backtests that fill at 3am midpoints are
# fiction, so RTH is the default research window.
EXCHANGE_TZ = "America/New_York"
RTH_START = "09:30"
RTH_END = "16:00"


def get_instrument(root: str) -> Instrument:
    key = root.upper()
    if key not in INSTRUMENTS:
        raise KeyError(f"unknown instrument {root!r}; known: {sorted(INSTRUMENTS)}")
    return INSTRUMENTS[key]
