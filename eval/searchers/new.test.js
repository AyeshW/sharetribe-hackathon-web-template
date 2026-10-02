const { createNewSearcher } = require('./new');
const { runOne } = require('../run');
const { recordIntent } = require('../intent-cache');
const {
  config,
  listing,
  fakeSdk,
  fakeAnthropic,
  rawIntent,
} = require('../../server/api/smart-search/test-data');

const VECTORS = { model: 'Xenova/bge-small-en-v1.5', listings: {} };
const catalog = [
  listing({ id: 'sweater', title: 'Wool sweater' }),
  listing({ id: 'boots', title: 'Black boots' }),
];

// A cache entry made the same way eval/run.js makes it, from a fake Claude reply.
const cachedEntry = () =>
  recordIntent({
    text: 'jumper',
    config,
    anthropic: fakeAnthropic(rawIntent({ terms: ['sweater'] })),
    logUsage: () => {},
  });

const searcher = (intentCache, sdk = fakeSdk(catalog)) =>
  createNewSearcher({ sdk, config, vectors: VECTORS, embedQuery: null, intentCache });

describe('createNewSearcher', () => {
  it('replays the cached intent and returns ids and titles, best first', async () => {
    const entry = await cachedEntry();
    const results = await searcher({ entries: { jumper: entry } })('jumper');

    expect(results[0]).toEqual({ id: 'sweater', title: 'Wool sweater' });
  });

  it('reports a query without a cache entry instead of fetching it', async () => {
    const sdk = fakeSdk(catalog);
    const run = await runOne(searcher({ entries: {} }, sdk), { text: 'y2k', relevant: [] });

    expect(run.error).toContain('no cached intent for "y2k"');
    expect(run.passes).toBe(false);
    expect(sdk.listings.query).not.toHaveBeenCalled();
  });
});
