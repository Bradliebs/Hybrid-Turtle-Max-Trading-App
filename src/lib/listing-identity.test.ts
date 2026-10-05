import { describe, expect, it } from 'vitest';
import { brokerListingMismatch, isUsBrokerListing, isUsPriceListing } from './listing-identity';
import { toYahooTicker } from './ticker-maps';
import { categorizeSkipReason } from './skip-reason-category';

describe('listing identity guard', () => {
  it('classifies price and broker listings by market', () => {
    expect(isUsPriceListing('AAPL')).toBe(true);
    expect(isUsPriceListing('BRK-B')).toBe(true);
    expect(isUsPriceListing('RIO.L')).toBe(false);
    expect(isUsPriceListing('NOVO-B.CO')).toBe(false);
    expect(isUsBrokerListing('AAPL_US_EQ')).toBe(true);
    expect(isUsBrokerListing('RIOl_EQ')).toBe(false);
    expect(isUsBrokerListing('BA_LSE_EQ')).toBe(false);
  });

  it('allows matching listings', () => {
    expect(brokerListingMismatch('AAPL', 'AAPL_US_EQ')).toBeNull();
    expect(brokerListingMismatch('RIO.L', 'RIO_UK_EQ')).toBeNull();
    expect(brokerListingMismatch('BA.L', 'BA_LSE_EQ')).toBeNull();
  });

  it('blocks the real mismatched mappings found in the live universe', () => {
    // Foreign price listing, US broker instrument (stop would be in pence/DKK/EUR on a USD share)
    for (const [db, broker] of [['RIO', 'RIO_US_EQ'], ['NVO', 'NVO_US_EQ'], ['ASML', 'ASML_US_EQ']]) {
      expect(brokerListingMismatch(toYahooTicker(db), broker)).toContain('Listing mismatch');
    }
    // US price listing, London broker instrument (e.g. a different UCITS fund)
    for (const [db, broker] of [['REMX', 'REGBL_EQ'], ['PICK', 'GIGBL_EQ'], ['FCX', 'FCXL_EQ'], ['MP', 'MPL_EQ']]) {
      expect(brokerListingMismatch(toYahooTicker(db), broker)).toContain('Listing mismatch');
    }
  });

  it('groups the skip under broker mapping in Telegram summaries', () => {
    expect(categorizeSkipReason(brokerListingMismatch('RIO.L', 'RIO_US_EQ')!)).toBe('BROKER_MAPPING');
  });
});
