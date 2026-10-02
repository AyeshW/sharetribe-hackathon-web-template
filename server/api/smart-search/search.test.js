const os = require('os');
const path = require('path');
const { types } = require('sharetribe-flex-sdk');
const { deserialize } = require('../../api-util/sdk');
const { runSearch, createSmartSearchHandler } = require('./index');
const { loadVectors } = require('./startup');
const {
  config,
  listing,
  fakeSdk,
  filter,
  state,
  fakeAnthropic,
  rawIntent,
} = require('./test-data');

const VECTORS = { model: 'Xenova/bge-small-en-v1.5', listings: {} };
// Fake query embedding: tests never load the real model. A plain function, because the Jest
// config resets mock implementations between tests.
const embedQuery = () => Promise.resolve([1, 0]);

const catalog = [
  listing({ id: 'men-l', price: 3000, publicData: { categoryLevel1: 'men', size: 'l' } }),
  listing({ id: 'men-m', price: 5000, publicData: { categoryLevel1: 'men', size: 'm' } }),
  listing({ id: 'women-m', price: 2000, publicData: { categoryLevel1: 'women', size: 'm' } }),
];
const uuids = entities => entities.map(e => e.id.uuid);
const logUsage = jest.fn();

describe('runSearch', () => {
  beforeEach(() => logUsage.mockClear());

  it('starts a new search for text, keeping only the buyer filters', async () => {
    const sdk = fakeSdk(catalog);
    const incoming = state(
      [
        filter('categoryLevel1', 'men', { source: 'user' }),
        filter('size', 'l'),
        filter('price', { max: 4000 }, { locked: true }),
      ],
      { preferences: ['vintage'], removed: ['color'], terms: ['coat'] }
    );

    const anthropic = fakeAnthropic(rawIntent({ terms: ['sneakers'] }));
    const body = await runSearch(
      { q: 'something new', state: incoming },
      { sdk, config, vectors: VECTORS, anthropic, logUsage }
    );

    expect(body.state).toEqual({
      q: 'something new',
      filters: [incoming.filters[0]],
      preferences: [],
      removed: [],
      similarTo: null,
      terms: ['sneakers'],
    });
    const [params] = sdk.listings.query.mock.calls[0];
    expect(params).toMatchObject({
      pub_listingType: 'sell-used-products',
      pub_categoryLevel1: 'men',
    });
    expect(params.price).toBeUndefined();
  });

  it('searches all sell listings for text without any filters', async () => {
    const anthropic = fakeAnthropic(rawIntent({ terms: ['anything'] }));
    const body = await runSearch(
      { q: 'anything' },
      { sdk: fakeSdk(catalog), config, anthropic, logUsage, embedQuery }
    );
    expect(uuids(body.results)).toEqual(['men-l', 'men-m', 'women-m']);
    expect(body.results.every(r => r.tier === 'best' && r.reason === null)).toBe(true);
    expect(body.notices).toEqual([]);
    expect(body.meta).toMatchObject({ reranked: false, warnings: [] });
    expect(body.meta.intent).toMatchObject({ mode: 'new', terms: ['anything'] });
  });

  it('applies the filters Claude read from the text', async () => {
    const anthropic = fakeAnthropic(
      rawIntent({
        filters: [
          { key: 'size', op: 'eq', value: 'm' },
          { key: 'color', op: 'eq', value: 'purple' },
        ],
      })
    );
    const body = await runSearch(
      { q: 'purple jeans size M' },
      { sdk: fakeSdk(catalog), config, anthropic, logUsage }
    );
    expect(body.state.filters.map(f => [f.key, f.label, f.mode])).toEqual([
      ['size', 'Size M', 'hard'],
      ['color', 'Purple', 'soft'],
    ]);
    // size M is applied in memory; the soft colour hides nothing
    expect(uuids(body.results)).toEqual(['men-m', 'women-m']);
  });

  it('returns USER_FILTER_KEPT when the text conflicts with a buyer filter', async () => {
    const anthropic = fakeAnthropic(
      rawIntent({ filters: [{ key: 'size', op: 'eq', value: 'l' }] })
    );
    const userSize = filter('size', 'm', { source: 'user', label: 'Size M' });
    const sdk = fakeSdk(catalog);
    const body = await runSearch(
      { q: 'size L please', state: state([userSize]) },
      { sdk, config, anthropic, logUsage }
    );
    expect(body.state.filters).toEqual([userSize]);
    expect(body.notices).toEqual([{ code: 'USER_FILTER_KEPT', params: { label: 'Size M' } }]);
    // the buyer's size M goes into the Marketplace query, not the text's size L
    expect(sdk.listings.query.mock.calls[0][0].pub_size).toBe('m');
  });

  it('sets a cheaper price from the fetched candidates after the query', async () => {
    const anthropic = fakeAnthropic(rawIntent({ mode: 'refine', priceIntent: 'cheaper' }));
    const previous = state([filter('categoryLevel1', 'men')], { q: 'jackets' });
    const body = await runSearch(
      { q: 'cheaper', state: previous },
      { sdk: fakeSdk(catalog), config, anthropic, logUsage }
    );
    // men listings cost 30 € and 50 €: median 40 €, 80% is 32 €
    const price = body.state.filters.find(f => f.key === 'price');
    expect(price).toMatchObject({ value: { max: 3200 }, label: 'Under €32' });
    expect(uuids(body.results)).toEqual(['men-l']);
  });

  it('lowers the existing price max for "cheaper"', async () => {
    const anthropic = fakeAnthropic(rawIntent({ mode: 'refine', priceIntent: 'cheaper' }));
    const previous = state([filter('price', { max: 4000 })], { q: 'jackets' });
    const body = await runSearch(
      { q: 'cheaper', state: previous },
      { sdk: fakeSdk(catalog), config, anthropic, logUsage }
    );
    expect(body.state.filters[0].value).toEqual({ max: 3200 });
  });

  it('does not call Claude without text', async () => {
    const anthropic = fakeAnthropic(rawIntent());
    const body = await runSearch(
      { q: null, state: state([filter('size', 'm')]) },
      { sdk: fakeSdk(catalog), config, anthropic, logUsage, embedQuery }
    );
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
    expect(body.meta).toMatchObject({ intent: null, warnings: [] });
  });

  it('adds INTENT_FALLBACK and still searches when Claude fails', async () => {
    const anthropic = { messages: { create: jest.fn(() => Promise.reject(new Error('529'))) } };
    const state0 = state([filter('size', 'm', { source: 'user' })]);
    const sdk = fakeSdk(catalog);
    const body = await runSearch(
      { q: 'black jeans', state: state0 },
      { sdk, config, anthropic, logUsage, embedQuery }
    );
    expect(body.meta.warnings).toEqual(['INTENT_FALLBACK']);
    expect(body.state).toMatchObject({ q: 'black jeans', terms: ['black', 'jeans'] });
    expect(body.state.filters).toEqual(state0.filters);
    expect(sdk.listings.query.mock.calls[0][0].pub_size).toBe('m');
  });

  it('uses the state as it is without text, applying inferred filters in memory', async () => {
    const incoming = state([filter('size', 'm')], { q: '' });
    const sdk = fakeSdk(catalog);
    const body = await runSearch({ q: null, state: incoming }, { sdk, config });

    expect(body.state).toEqual(incoming);
    expect(sdk.listings.query.mock.calls[0][0].pub_size).toBeUndefined();
    expect(uuids(body.results)).toEqual(['men-m', 'women-m']);
    expect(body.relaxation.suggestions).toEqual([{ key: 'size', label: 'size label', extra: 1 }]);
  });

  it('removes an auto-dropped filter from the returned state', async () => {
    const incoming = state([filter('size', 'xl'), filter('price', { max: 2500 })], { q: '' });
    const body = await runSearch({ q: null, state: incoming }, { sdk: fakeSdk(catalog), config });

    expect(body.relaxation.auto).toEqual({ filter: incoming.filters[0] });
    expect(body.state.filters).toEqual([incoming.filters[1]]);
    expect(uuids(body.results)).toEqual(['women-m']);
  });

  it('returns NO_RESULTS when even relaxation finds nothing', async () => {
    const incoming = state([filter('size', 'xl', { source: 'user' })]);
    const body = await runSearch({ q: null, state: incoming }, { sdk: fakeSdk([]), config });
    expect(body.results).toEqual([]);
    expect(body.notices).toEqual([{ code: 'NO_RESULTS', params: {} }]);
    expect(body.relaxation).toEqual({ auto: null, suggestions: [] });
  });

  it('throws UPSTREAM_ERROR when the Marketplace API fails', async () => {
    const sdk = fakeSdk([], { fail: new Error('network down') });
    await expect(runSearch({ q: 'x' }, { sdk, config })).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('throws a validation error before querying', async () => {
    const sdk = fakeSdk(catalog);
    await expect(runSearch({ q: null, state: null }, { sdk, config })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
    expect(sdk.listings.query).not.toHaveBeenCalled();
  });
});

describe('runSearch ranking (step ④)', () => {
  // A bomber jacket the query means, a jacket potato that only shares the word, a black
  // Nike boot with no vector yet, and an unrelated item.
  const ranked = [
    listing({
      id: 'potato',
      title: 'Jacket potato tray',
      price: 4000,
      metadata: { ai: { style: ['casual'] } },
    }),
    listing({
      id: 'bomber',
      title: 'Bronze bomber',
      price: 3000,
      metadata: {
        ai: { garmentType: 'bomber jacket', style: ['vintage'], season: ['autumn'] },
      },
    }),
    listing({
      id: 'boot',
      title: 'Leather boots',
      price: 2000,
      publicData: { color: 'black', brand: 'Nike' },
    }),
    listing({ id: 'scarf', title: 'Wool scarf', price: 1000 }),
  ];
  const vectors = {
    model: 'Xenova/bge-small-en-v1.5',
    listings: {
      potato: { vector: [0, 1] },
      bomber: { vector: [1, 0] },
      scarf: { vector: [0.2, 0.98] },
    },
  };
  const textState = (overrides = {}) =>
    state([], { q: 'vintage jacket', terms: ['jacket'], preferences: ['vintage'], ...overrides });

  it('orders by the initial score and fills tiers with the D16 rule', async () => {
    const embed = jest.fn(embedQuery);
    const body = await runSearch(
      { q: null, state: textState() },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery: embed }
    );
    expect(embed).toHaveBeenCalledWith('vintage jacket jacket');
    expect(uuids(body.results)).toEqual(['bomber', 'potato', 'scarf', 'boot']);
    // bomber ~0.91, potato 0.3 (keyword only), scarf ~0.1 (meaning only), boot 0
    expect(body.results.map(r => r.tier)).toEqual(['best', 'related', 'related', 'related']);
    expect(body.total).toEqual({ best: 1, related: 3 });
    expect(body.results.every(r => r.reason === null)).toBe(true);
    expect(body.meta.warnings).toEqual([]);
  });

  it('never sends the per-signal numbers, only to onRanking', async () => {
    const onRanking = jest.fn();
    const body = await runSearch(
      { q: null, state: textState() },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery, onRanking }
    );
    const { scores, signals } = onRanking.mock.calls[0][0];
    expect(scores.get('bomber')).toBeGreaterThan(0.9);
    expect(signals.get('bomber')).toMatchObject({ semantic: 1, preferences: 1 });
    expect(signals.get('potato')).toEqual({ semantic: 0, keyword: 1, preferences: 0 });
    expect(signals.get('boot')).toEqual({ semantic: 0, keyword: 0, preferences: 0 });
    expect(Object.keys(body.results[0])).toEqual(['id', 'tier', 'reason']);
    expect(JSON.stringify(body)).not.toMatch(/semantic|keyword/);
  });

  it('ranks by keyword and preferences with EMBEDDING_SKIPPED when embedQuery fails', async () => {
    const onEmbedError = jest.fn();
    const failure = new Error('onnx crashed');
    const body = await runSearch(
      { q: null, state: textState() },
      {
        sdk: fakeSdk(ranked),
        config,
        vectors,
        embedQuery: () => Promise.reject(failure),
        onEmbedError,
      }
    );
    expect(body.meta.warnings).toEqual(['EMBEDDING_SKIPPED']);
    expect(onEmbedError).toHaveBeenCalledWith(failure);
    expect(uuids(body.results)).toEqual(['bomber', 'potato', 'boot', 'scarf']);
  });

  it('adds EMBEDDING_SKIPPED when the model did not load', async () => {
    const body = await runSearch(
      { q: null, state: textState() },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery: null }
    );
    expect(body.meta.warnings).toEqual(['EMBEDDING_SKIPPED']);
    expect(uuids(body.results)[0]).toBe('bomber');
  });

  it('makes no embedding call and keeps every listing for a pure filter search', async () => {
    const embed = jest.fn();
    const pure = state([filter('size', 'xl')], { q: '' });
    const body = await runSearch(
      { q: null, state: pure },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery: embed }
    );
    expect(embed).not.toHaveBeenCalled();
    expect(body.meta.warnings).toEqual([]);
    // Nothing has size XL, so the inferred size is dropped: every listing counts as relevant.
    expect(body.relaxation.auto).toEqual({ filter: pure.filters[0] });
    expect(uuids(body.results)).toEqual(['potato', 'bomber', 'boot', 'scarf']);
    expect(body.results.every(r => r.tier === 'best')).toBe(true);
  });

  it('never removes a listing for a soft colour or brand preference', async () => {
    const soft = [
      filter('color', 'black', { mode: 'soft' }),
      filter('brand', 'Nike', { mode: 'soft' }),
    ];
    const body = await runSearch(
      { q: null, state: state(soft, { q: '' }) },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery }
    );
    expect(uuids(body.results)).toHaveLength(4);
    expect(uuids(body.results)[0]).toBe('boot');
  });

  it('keeps the tiers when sorting by price', async () => {
    const relevance = await runSearch(
      { q: null, state: textState() },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery }
    );
    const byPrice = await runSearch(
      { q: null, state: textState(), sort: 'price-asc' },
      { sdk: fakeSdk(ranked), config, vectors, embedQuery }
    );
    const tiers = body => Object.fromEntries(body.results.map(r => [r.id.uuid, r.tier]));
    expect(uuids(byPrice.results)).toEqual(['scarf', 'boot', 'bomber', 'potato']);
    expect(tiers(byPrice)).toEqual(tiers(relevance));
  });
});

// A minimal Express response double.
const fakeRes = () => {
  const res = { statusCode: null, headers: {}, body: null, json: null };
  res.status = jest.fn(code => {
    res.statusCode = code;
    return res;
  });
  res.set = jest.fn((name, value) => {
    res.headers[name] = value;
    return res;
  });
  res.send = jest.fn(body => {
    res.body = body;
    return res;
  });
  res.json = jest.fn(body => {
    res.jsonBody = body;
    return res;
  });
  res.end = jest.fn(() => res);
  return res;
};

describe('createSmartSearchHandler', () => {
  const log = { error: jest.fn() };
  const handlerWith = (
    sdk,
    getStaticData = () => Promise.resolve({ config, vectors: VECTORS, embedQuery })
  ) =>
    createSmartSearchHandler({
      getStaticData,
      getSdk: () => sdk,
      getAnthropic: () => fakeAnthropic(rawIntent()),
      logUsage,
      log,
    });

  beforeEach(() => {
    log.error.mockClear();
    logUsage.mockClear();
  });

  it('responds 200 with application/transit+json carrying SDK types', async () => {
    const res = fakeRes();
    await handlerWith(fakeSdk(catalog))({ body: { q: 'jacket', perPage: 2 } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/transit+json');
    const body = deserialize(res.body);
    expect(body.results[0].id).toBeInstanceOf(types.UUID);
    expect(body.listings.data[0].attributes.price).toBeInstanceOf(types.Money);
    expect(uuids(body.listings.data)).toEqual(['men-l', 'men-m']);
    expect(body.totalPages).toBe(2);
  });

  it('responds 200 with EMBEDDING_SKIPPED when the query embedding fails', async () => {
    const res = fakeRes();
    const failure = new Error('onnx crashed');
    const handler = createSmartSearchHandler({
      getStaticData: () =>
        Promise.resolve({ config, vectors: VECTORS, embedQuery: () => Promise.reject(failure) }),
      getSdk: () => fakeSdk(catalog),
      getAnthropic: () => fakeAnthropic(rawIntent({ terms: ['jacket'] })),
      logUsage,
      log,
    });
    await handler({ body: { q: 'jacket' } }, res);

    expect(res.statusCode).toBe(200);
    const body = deserialize(res.body);
    expect(body.meta.warnings).toEqual(['EMBEDDING_SKIPPED']);
    expect(uuids(body.results)).toEqual(['men-l', 'men-m', 'women-m']);
    expect(log.error).toHaveBeenCalledWith(failure, 'smart-search-embed-failed');
  });

  it('responds 200 when vectors.json is missing, ranking by word match only', async () => {
    const res = fakeRes();
    const warn = jest.fn();
    const missing = path.join(os.tmpdir(), 'smart-search-no-such-dir', 'vectors.json');
    const vectors = loadVectors(missing, warn);
    const handler = createSmartSearchHandler({
      getStaticData: () => Promise.resolve({ config, vectors, embedQuery }),
      getSdk: () => fakeSdk([...catalog, listing({ id: 'coat', title: 'Wool coat' })]),
      getAnthropic: () => fakeAnthropic(rawIntent({ terms: ['coat'] })),
      logUsage,
      log,
    });
    await handler({ body: { q: 'coat' } }, res);

    // The warning is printed when the server starts; D6 has no meta.warnings code for it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(res.statusCode).toBe(200);
    const body = deserialize(res.body);
    expect(uuids(body.results)[0]).toBe('coat');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('searches without inferred filters when the Anthropic client can not be created', async () => {
    const res = fakeRes();
    const missingKey = new Error('Missing environment variable ANTHROPIC_API_KEY. Set it in .env.');
    const handler = createSmartSearchHandler({
      getStaticData: () => Promise.resolve({ config, vectors: VECTORS, embedQuery }),
      getSdk: () => fakeSdk(catalog),
      getAnthropic: () => {
        throw missingKey;
      },
      logUsage,
      log,
    });
    await handler({ body: { q: 'jacket' } }, res);

    expect(res.statusCode).toBe(200);
    expect(deserialize(res.body).meta.warnings).toEqual(['INTENT_FALLBACK']);
    expect(log.error).toHaveBeenCalledWith(missingKey, 'smart-search-anthropic-unavailable');
  });

  it('responds 400 with { code, message } for an invalid request', async () => {
    const res = fakeRes();
    await handlerWith(fakeSdk(catalog))({ body: { q: 'a'.repeat(301) } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ code: 'QUERY_TOO_LONG', message: expect.any(String) });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('responds 502 UPSTREAM_ERROR when the Marketplace API fails', async () => {
    const res = fakeRes();
    const failure = new Error('network down');
    await handlerWith(fakeSdk([], { fail: failure }))({ body: { q: 'x' } }, res);
    expect(res.statusCode).toBe(502);
    expect(res.jsonBody).toEqual({ code: 'UPSTREAM_ERROR', message: expect.any(String) });
    expect(log.error).toHaveBeenCalledWith(failure, 'smart-search-failed', undefined);
  });

  it('responds 502 UPSTREAM_ERROR when the marketplace config could not be loaded', async () => {
    const res = fakeRes();
    const handler = handlerWith(fakeSdk(catalog), () => Promise.reject(new Error('no config')));
    await handler({ body: { q: 'x' } }, res);
    expect(res.statusCode).toBe(502);
    expect(res.jsonBody.code).toBe('UPSTREAM_ERROR');
  });

  it('responds 500 INTERNAL_ERROR for an unexpected error', async () => {
    const res = fakeRes();
    const brokenSdk = { listings: { query: () => Promise.resolve({ data: { data: [{}] } }) } };
    await handlerWith(brokenSdk)({ body: { q: 'x' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({ code: 'INTERNAL_ERROR', message: 'Smart search failed' });
    expect(log.error).toHaveBeenCalled();
  });
});
