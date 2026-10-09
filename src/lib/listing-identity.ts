/**
 * DEPENDENCIES
 * Consumed by: src/cron/auto-trade.ts, src/app/api/positions/execute/route.ts
 * Consumes: nothing (pure)
 * Risk-sensitive: YES — blocks buys whose price data and broker instrument are different listings
 * Notes: Sizing, entry triggers and stop prices come from the market-data listing
 *        (e.g. RIO.L in pence). If the broker instrument is a different listing
 *        (e.g. RIO_US_EQ in USD), the protective stop is placed in the wrong
 *        units: it can sit above the market and fire at once, or be rejected.
 *        This is a coarse, conservative check (US vs non-US market). It only
 *        ever blocks; it never changes a size or price. A same-market mismatch
 *        between two non-US exchanges is not detectable here.
 */

/** A Yahoo symbol with an exchange suffix (RIO.L, ASML.AS, NOVO-B.CO) is a non-US listing. */
export function isUsPriceListing(priceSymbol: string): boolean {
  return !/\.[A-Z]{1,4}$/.test(priceSymbol.trim());
}

/** Trading 212 US equities are always `<SYMBOL>_US_EQ`; every other code is a non-US listing. */
export function isUsBrokerListing(brokerTicker: string): boolean {
  return /_US_EQ$/.test(brokerTicker.trim());
}

/** Returns a skip/abort reason when the two listings are in different markets, else null. */
export function brokerListingMismatch(priceSymbol: string, brokerTicker: string): string | null {
  const priceUs = isUsPriceListing(priceSymbol);
  const brokerUs = isUsBrokerListing(brokerTicker);
  if (priceUs === brokerUs) return null;
  return `Listing mismatch: prices come from ${priceSymbol} (${priceUs ? 'US' : 'non-US'}) but the broker instrument is ${brokerTicker} (${brokerUs ? 'US' : 'non-US'}). Sizing and stop prices would be in the wrong units; fix the stock's T212 mapping before trading it.`;
}

/**
 * Auto-trade and the manual execute route size UK (.L) instruments and place
 * their stops in pence. Some London lines trade in pounds or dollars at T212
 * (e.g. VUAGl_EQ GBP, CNDXl_EQ USD), where that would mean a ~100x size and a
 * stop in the wrong units. Block unless the broker line is known to be GBX.
 */
export function ukLineUnitsIssue(isUk: boolean, brokerTicker: string, brokerCurrency: string | null | undefined): string | null {
  if (!isUk) return null;
  if (brokerCurrency === 'GBX' || brokerCurrency === 'GBp') return null;
  return `UK listing ${brokerTicker} trades in ${brokerCurrency || 'an unknown currency'} at T212, but UK prices and stops are handled in pence only. Refusing to size it (refresh the T212 instruments cache or fix the listing first).`;
}
