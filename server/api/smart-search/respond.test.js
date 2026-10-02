const { buildResponse } = require('./respond');
const { refKey } = require('./query');
const { listing, imageOf, userOf, state } = require('./test-data');

const REQUEST = { page: 1, perPage: 24, sort: 'relevance' };
const NO_RELAXATION = { auto: null, suggestions: [] };
const META = { tookMs: 5, reranked: false, intent: null, warnings: [] };

const includedFor = listings => {
  const map = new Map();
  listings.forEach(l => [userOf(l), imageOf(l)].forEach(e => map.set(refKey(e), e)));
  return map;
};

const respond = (listings, overrides = {}) => {
  const ranked = listings.map((l, i) => ({ listing: l, score: overrides.scores?.[i] ?? 1 }));
  return buildResponse({
    state: state([]),
    ranked,
    included: includedFor(listings),
    request: { ...REQUEST, ...overrides.request },
    relaxation: overrides.relaxation || NO_RELAXATION,
    meta: META,
  });
};

const uuids = entities => entities.map(e => e.id.uuid);

describe('buildResponse', () => {
  const a = listing({ id: 'a', price: 3000, createdAt: '2026-09-02T00:00:00Z' });
  const b = listing({ id: 'b', price: 1000, createdAt: '2026-09-03T00:00:00Z' });
  const c = listing({ id: 'c', price: 2000, createdAt: '2026-09-01T00:00:00Z' });

  it('returns results and listings.data in the same, ranked order', () => {
    const body = respond([a, b, c]);
    expect(uuids(body.results)).toEqual(['a', 'b', 'c']);
    expect(uuids(body.listings.data)).toEqual(['a', 'b', 'c']);
    expect(body.listings.data[0]).toBe(a);
    expect(body.results[0]).toEqual({ id: a.id, tier: 'best', reason: null });
  });

  it.each([
    ['relevance', ['a', 'b', 'c']],
    ['price-asc', ['b', 'c', 'a']],
    ['price-desc', ['a', 'c', 'b']],
    ['newest', ['b', 'a', 'c']],
  ])('sorts by %s', (sort, expected) => {
    const body = respond([a, b, c], { request: { sort } });
    expect(uuids(body.results)).toEqual(expected);
    expect(uuids(body.listings.data)).toEqual(expected);
  });

  it('keeps the ranked order for equal prices', () => {
    const d = listing({ id: 'd', price: 2000 });
    expect(uuids(respond([c, d, a], { request: { sort: 'price-asc' } }).results)).toEqual([
      'c',
      'd',
      'a',
    ]);
  });

  it('pages the results', () => {
    const listings = ['1', '2', '3', '4', '5'].map(id => listing({ id }));
    const page2 = respond(listings, { request: { page: 2, perPage: 2 } });
    expect(uuids(page2.results)).toEqual(['3', '4']);
    expect(page2).toMatchObject({ page: 2, perPage: 2, totalPages: 3 });
    expect(page2.total).toEqual({ best: 5, related: 0 });

    const page3 = respond(listings, { request: { page: 3, perPage: 2 } });
    expect(uuids(page3.results)).toEqual(['5']);

    const beyond = respond(listings, { request: { page: 4, perPage: 2 } });
    expect(beyond.results).toEqual([]);
    expect(beyond.notices).toEqual([]);
  });

  it("includes only this page's images and authors, once each", () => {
    const x = listing({ id: 'x', authorId: 'shared' });
    const y = listing({ id: 'y', authorId: 'shared' });
    const z = listing({ id: 'z' });
    const body = respond([x, y, z], { request: { perPage: 2 } });
    expect(body.listings.included.map(refKey)).toEqual([
      'user/shared',
      'image/image-x',
      'image/image-y',
    ]);
  });

  it('uses the D16 tier rule: best at 60% of the top score or more', () => {
    const body = respond([a, b, c], { scores: [1, 0.6, 0.59] });
    expect(body.results.map(r => r.tier)).toEqual(['best', 'best', 'related']);
    expect(body.total).toEqual({ best: 2, related: 1 });
  });

  it.each([
    ['exactly 60% of the top score', [0.5, 0.3], ['best', 'best']],
    ['just below 60%', [1, 0.5999], ['best', 'related']],
    ['a single result', [0.01], ['best']],
    ['all zeros (pure filter search)', [0, 0], ['best', 'best']],
  ])('D16 tier rule boundary: %s', (_, scores, tiers) => {
    const body = respond([a, b, c].slice(0, scores.length), { scores });
    expect(body.results.map(r => r.tier)).toEqual(tiers);
  });

  it('keeps tiers from the score when sorting by price', () => {
    const body = respond([a, b, c], { scores: [1, 0.2, 0.7], request: { sort: 'price-asc' } });
    expect(body.results.map(r => [r.id.uuid, r.tier])).toEqual([
      ['b', 'related'],
      ['c', 'best'],
      ['a', 'best'],
    ]);
  });

  it('passes relaxation through and wraps the dropped filter', () => {
    const dropped = { key: 'size', label: 'Size L' };
    const suggestions = [{ key: 'price', label: 'Under €40', extra: 2 }];
    const body = respond([a], { relaxation: { auto: dropped, suggestions } });
    expect(body.relaxation).toEqual({ auto: { filter: dropped }, suggestions });
  });

  it('adds NO_RESULTS when nothing matched', () => {
    const body = respond([]);
    expect(body.notices).toEqual([{ code: 'NO_RESULTS', params: {} }]);
    expect(body).toMatchObject({ results: [], totalPages: 0, total: { best: 0, related: 0 } });
    expect(body.listings).toEqual({ data: [], included: [] });
  });

  it('sends backend-only meta with reranked false', () => {
    expect(respond([a]).meta).toEqual(META);
  });
});
