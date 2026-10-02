const { validateRequest } = require('./request');
const { filter, state } = require('./test-data');

const errorOf = body => {
  try {
    validateRequest(body);
  } catch (e) {
    return { status: e.status, code: e.code };
  }
  return null;
};
const INVALID = { status: 400, code: 'INVALID_REQUEST' };

describe('validateRequest', () => {
  it('fills in the defaults from CONTRACT.md §3', () => {
    expect(validateRequest({ q: 'black jeans' })).toEqual({
      q: 'black jeans',
      state: null,
      page: 1,
      perPage: 24,
      sort: 'relevance',
      image: { variantPrefix: 'listing-card', aspectWidth: 1, aspectHeight: 1 },
      rerank: true,
      debug: false,
    });
  });

  it('keeps given values, trims q and accepts rerank', () => {
    const request = validateRequest({
      q: '  boots ',
      state: null,
      page: 3,
      perPage: 10,
      sort: 'price-desc',
      image: { variantPrefix: 'card', aspectWidth: 2, aspectHeight: 3 },
      rerank: false,
    });
    expect(request).toMatchObject({
      q: 'boots',
      page: 3,
      perPage: 10,
      sort: 'price-desc',
      image: { variantPrefix: 'card', aspectWidth: 2, aspectHeight: 3 },
      rerank: false,
    });
  });

  it('accepts a state without text (chip edit) and defaults missing state fields', () => {
    const request = validateRequest({ q: null, state: { filters: [filter('size', 'm')] } });
    expect(request.q).toBeNull();
    expect(request.state).toEqual({
      q: '',
      filters: [filter('size', 'm')],
      preferences: [],
      removed: [],
      similarTo: null,
      terms: [],
    });
  });

  it('rejects a request with neither q nor state', () => {
    expect(errorOf({ q: null, state: null })).toEqual(INVALID);
    expect(errorOf({})).toEqual(INVALID);
    expect(errorOf({ q: '   ', state: null })).toEqual(INVALID);
  });

  it('returns QUERY_TOO_LONG above 300 characters', () => {
    expect(errorOf({ q: 'a'.repeat(300) })).toBeNull();
    expect(errorOf({ q: 'a'.repeat(301) })).toEqual({ status: 400, code: 'QUERY_TOO_LONG' });
  });

  it.each([
    ['a non-object body', 'text'],
    ['q of the wrong type', { q: 5 }],
    ['page 0', { q: 'x', page: 0 }],
    ['a fractional page', { q: 'x', page: 1.5 }],
    ['perPage over 100', { q: 'x', perPage: 101 }],
    ['an unknown sort', { q: 'x', sort: 'cheapest' }],
    ['a bad image', { q: 'x', image: { variantPrefix: 'a b', aspectWidth: 1, aspectHeight: 1 } }],
    ['a non-boolean rerank', { q: 'x', rerank: 'yes' }],
    ['state as an array', { q: 'x', state: [] }],
    ['state.removed with numbers', { q: null, state: state([], { removed: [1] }) }],
  ])('rejects %s', (name, body) => {
    expect(errorOf(body)).toEqual(INVALID);
  });

  it.each([
    ['an unknown key', filter('weight', 'x')],
    ['a bad mode', filter('size', 'm', { mode: 'maybe' })],
    ['a missing locked', filter('size', 'm', { locked: undefined })],
    ['a bad source', filter('size', 'm', { source: 'claude' })],
    ['a price without range', filter('price', 6000, { op: 'eq' })],
    ['an empty price range', filter('price', {})],
    ['a negative price', filter('price', { max: -1 })],
    ['min above max', filter('price', { min: 5000, max: 4000 })],
    ['notIn outside categoryLevel2', filter('size', ['m'], { op: 'notIn' })],
    ['an empty in list', filter('size', [], { op: 'in' })],
    ['a non-boolean shippingEnabled', filter('shippingEnabled', 'yes')],
  ])('rejects a filter with %s', (name, badFilter) => {
    expect(errorOf({ q: null, state: state([badFilter]) })).toEqual(INVALID);
  });

  it('accepts every filter shape the backend and frontend create', () => {
    const filters = [
      filter('categoryLevel1', 'men', { source: 'user' }),
      filter('categoryLevel2', ['men-bundles'], { op: 'notIn' }),
      filter('size', ['m', 'l'], { op: 'in' }),
      filter('price', { max: 6000 }),
      filter('price', { min: 1000, max: 6000 }),
      filter('brand', 'Nike', { mode: 'soft' }),
      filter('shippingEnabled', true),
    ];
    expect(errorOf({ q: null, state: state(filters) })).toBeNull();
  });
});
