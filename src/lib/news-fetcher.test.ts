import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above imports, so we hoist the mock fns too.
const { mockSearch, mockQuoteSummary } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockQuoteSummary: vi.fn(),
}));

vi.mock('yahoo-finance2', () => {
  function YahooFinanceMock(this: any) {
    this.search = mockSearch;
    this.quoteSummary = mockQuoteSummary;
  }
  return { default: YahooFinanceMock };
});

import { fetchNewsContext, clearNewsCache } from './news-fetcher';

describe('fetchNewsContext', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockQuoteSummary.mockReset();
    clearNewsCache();
  });

  it('returns headlines and earnings when both succeed', async () => {
    const publishedAt = new Date(Date.now() - 2 * 3600000); // 2h ago
    const earningsDate = new Date(Date.now() + 3 * 86400000); // 3 days from now

    mockSearch.mockResolvedValue({
      news: [
        {
          title: 'Apple appoints new chief hardware officer',
          publisher: 'Reuters',
          link: 'https://example.com/news/1',
          providerPublishTime: publishedAt,
        },
      ],
    });
    mockQuoteSummary.mockResolvedValue({
      calendarEvents: {
        earnings: {
          earningsDate: [earningsDate],
          isEarningsDateEstimate: false,
        },
      },
    });

    const result = await fetchNewsContext('AAPL', 5);

    expect(result.ticker).toBe('AAPL');
    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0].title).toContain('Apple appoints');
    expect(result.headlines[0].publisher).toBe('Reuters');
    expect(result.headlines[0].ageHours).toBeGreaterThan(1.5);
    expect(result.headlines[0].ageHours).toBeLessThan(2.5);
    expect(result.earnings.daysUntil).toBeGreaterThanOrEqual(2);
    expect(result.earnings.daysUntil).toBeLessThanOrEqual(3);
    expect(result.earnings.isEstimate).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns empty headlines + warning when news fetch fails but earnings succeed', async () => {
    mockSearch.mockRejectedValue(new Error('Yahoo 503'));
    mockQuoteSummary.mockResolvedValue({
      calendarEvents: { earnings: { earningsDate: [] } },
    });

    const result = await fetchNewsContext('MSFT');

    expect(result.headlines).toEqual([]);
    expect(result.earnings.nextEarningsDate).toBeNull();
    expect(result.warnings.some(w => w.includes('news fetch failed'))).toBe(true);
  });

  it('returns empty earnings + warning when earnings fetch fails but news succeeds', async () => {
    mockSearch.mockResolvedValue({ news: [] });
    mockQuoteSummary.mockRejectedValue(new Error('not found'));

    const result = await fetchNewsContext('TSLA');

    expect(result.headlines).toEqual([]);
    expect(result.earnings.nextEarningsDate).toBeNull();
    expect(result.warnings.some(w => w.includes('earnings fetch failed'))).toBe(true);
  });

  it('never throws — both failures still resolve to a NewsContext with warnings', async () => {
    mockSearch.mockRejectedValue(new Error('boom'));
    mockQuoteSummary.mockRejectedValue(new Error('also boom'));

    const result = await fetchNewsContext('XYZ');

    expect(result.ticker).toBe('XYZ');
    expect(result.headlines).toEqual([]);
    expect(result.earnings.nextEarningsDate).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });

  it('respects the requested news count', async () => {
    const headlines = Array.from({ length: 10 }, (_, i) => ({
      title: `Headline ${i}`,
      publisher: 'Publisher',
      link: `https://example.com/${i}`,
      providerPublishTime: new Date(),
    }));
    mockSearch.mockResolvedValue({ news: headlines });
    mockQuoteSummary.mockResolvedValue({ calendarEvents: { earnings: { earningsDate: [] } } });

    const result = await fetchNewsContext('AAPL', 3);

    // We pass newsCount to Yahoo; even if it returns more, we slice to the requested count
    expect(result.headlines.length).toBeLessThanOrEqual(3);
  });

  it('filters out headlines missing title or link', async () => {
    mockSearch.mockResolvedValue({
      news: [
        { title: 'Good headline', publisher: 'P', link: 'https://x', providerPublishTime: new Date() },
        { title: 'No link', publisher: 'P', providerPublishTime: new Date() },
        { publisher: 'P', link: 'https://x', providerPublishTime: new Date() },
      ],
    });
    mockQuoteSummary.mockResolvedValue({ calendarEvents: { earnings: { earningsDate: [] } } });

    const result = await fetchNewsContext('AAPL');

    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0].title).toBe('Good headline');
  });
});
