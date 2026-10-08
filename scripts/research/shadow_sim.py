"""
Shared trade-path simulation for the research scripts (daily bars, no costs).

simulate() models the live exit (src/lib/stop-manager.ts): initial stop = entry
- risk, nightly trail = highest close since entry - m x ATR(14) from the entry
day, the R-ladder (>= +1.5R breakeven, >= +2.5R entry + 0.5R, >= +3R max(entry +
1R, close - m x ATR)), stops recomputed after each close and applied from the
next session (gap through the stop fills at the open). Variants are described in
prospective_shadow_tests.py. Moved here unchanged on 2026-10-08 so the live-buy
replay uses the same engine; HORIZON is now a parameter (default 40).
"""
import numpy as np
import pandas as pd

from yahoo_daily import fetch_daily

HORIZON = 40
def fetch(symbol, first_day):
    bars = pd.DataFrame(fetch_daily(symbol, first_day, pause=0))
    return bars.set_index('date')[['open', 'high', 'low', 'close', 'adj']]


def atr(bars, end_index, length):
    window = bars.iloc[end_index - length:end_index + 1]
    previous = window.close.shift(1)
    true_range = np.maximum(window.high - window.low,
                            np.maximum((window.high - previous).abs(), (window.low - previous).abs()))
    return true_range.iloc[1:].mean()


def simulate(bars, entry_index, entry_price, risk, variant, trigger=None, horizon=HORIZON, intraday_entry=False):
    """R multiple of one trade, or None while the window is incomplete.

    intraday_entry: the fill happened during the entry-day session (live buys), so
    that day's low may predate the fill and is not treated as a stop hit.
    """
    m = 2.0 if variant == 'W20' else 1.5
    stop = entry_price - risk
    highest = entry_price
    last = entry_index + horizon - 1
    if last >= len(bars):
        return None
    entry_day = bars.index[entry_index]
    for i in range(entry_index, last + 1):
        bar = bars.iloc[i]
        if i > entry_index and bar.open <= stop:
            return (bar.open - entry_price) / risk
        if bar.low <= stop and not (intraday_entry and i == entry_index):
            return (stop - entry_price) / risk
        highest = max(highest, bar.close)
        r_close = (bar.close - entry_price) / risk
        # FAILX: the live breakout-failure rule (breakout-failure-detector.ts) acted on:
        # within 5 calendar days of entry, a close below the trigger with less than
        # +0.5R open profit sells at the next session's open.
        if (variant == 'FAILX' and trigger and i < last and (bars.index[i] - entry_day).days <= 5
                and bar.close < trigger and r_close < 0.5):
            return (bars.open.iloc[i + 1] - entry_price) / risk
        current_atr = atr(bars, i, 14)
        if variant == 'CHAND':
            trail = bars.high.iloc[max(0, i - 21):i + 1].max() - 3 * atr(bars, i, 22)
        elif variant == 'LATE' and (highest - entry_price) / risk < 1:
            trail = -np.inf
        else:
            trail = highest - m * current_atr
        ladder = -np.inf
        if r_close >= 3:
            ladder = max(entry_price + risk, bar.close - m * current_atr)
        elif r_close >= 2.5:
            ladder = entry_price + 0.5 * risk
        elif r_close >= 1.5:
            ladder = entry_price
        stop = max(stop, trail, ladder)
    return (bars.close.iloc[last] - entry_price) / risk
