"""
Shared helpers for the read-only research scripts: the app's Yahoo symbol mapping
and a daily-bar fetch. Public market data only; no account or broker access.

to_yahoo mirrors toYahooTicker in src/lib/ticker-maps.ts (override, then the
static map parsed from that file, then the T212 'l' suffix rule, then the ticker
itself), so research prices come from the same listing as the live system.
"""
import datetime as dt
import json
import pathlib
import re
import time
import urllib.request

_MAP_FILE = pathlib.Path(__file__).resolve().parents[2] / 'src' / 'lib' / 'ticker-maps.ts'
_YAHOO_MAP = dict(re.findall(r"\{\s*db:\s*'([^']+)',\s*yahoo:\s*'([^']+)'", _MAP_FILE.read_text(encoding='utf-8')))


def to_yahoo(ticker, override=None):
    if override:
        return override
    if ticker in _YAHOO_MAP:
        return _YAHOO_MAP[ticker]
    if re.fullmatch(r'[A-Z]{2,5}l', ticker):
        return ticker[:-1] + '.L'
    return ticker


def fetch_daily(symbol, first_day, lookback_days=45, pause=0.4):
    """Daily bars from Yahoo as a list of dicts keyed by UTC date, oldest first."""
    begin = int(dt.datetime.combine(first_day - dt.timedelta(days=lookback_days), dt.time(), dt.UTC).timestamp())
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d'
           f'&period1={begin}&period2={int(time.time())}')
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)['chart']['result'][0]
    time.sleep(pause)
    quote = result['indicators']['quote'][0]
    adjusted = result['indicators'].get('adjclose', [{}])[0].get('adjclose', quote['close'])
    bars = {}
    for stamp, o, h, l, c, a in zip(result['timestamp'], quote['open'], quote['high'], quote['low'], quote['close'], adjusted):
        if None not in (o, h, l, c):
            bars[dt.datetime.fromtimestamp(stamp, dt.UTC).date()] = {'open': o, 'high': h, 'low': l, 'close': c, 'adj': a or c}
    return [dict(date=day, **values) for day, values in sorted(bars.items())]
