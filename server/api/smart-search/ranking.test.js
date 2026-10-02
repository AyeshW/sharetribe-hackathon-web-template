const {
  WEIGHTS,
  tokenize,
  listingText,
  queryTokens,
  queryText,
  bm25,
  cosine,
  normalise,
  preferenceShare,
  hasRankingSignals,
  rankListings,
} = require('./ranking');
const { listing, filter, state } = require('./test-data');

describe('tokenize', () => {
  it('lowercases, drops stopwords and folds plurals', () => {
    expect(tokenize('Black BOOTS for a wedding, dresses & accessories')).toEqual([
      'black',
      'boot',
      'wedding',
      'dress',
      'accessory',
    ]);
  });
});

describe('bm25', () => {
  it('scores a document with the exact word above one without it', () => {
    const [hit, miss] = bm25(['jacket'], [tokenize('brown jacket'), tokenize('black shoes')]);
    expect(hit).toBeGreaterThan(0);
    expect(miss).toBe(0);
  });

  it('weighs rarer words more', () => {
    const docs = [['common', 'x'], ['rare', 'x'], ['common', 'y'], ['common', 'z']];
    const [withCommon, withRare] = bm25(['common', 'rare'], docs);
    expect(withRare).toBeGreaterThan(withCommon);
  });

  it('gives all zeros for an empty query', () => {
    expect(bm25([], [['jacket'], ['shoe']])).toEqual([0, 0]);
  });
});

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosine([3, 4], [3, 4])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it('is 0 for a missing or all-zero vector', () => {
    expect(cosine([1, 0], null)).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe('normalise', () => {
  it('maps the candidate range to 0–1', () => {
    expect(normalise([2, 4, 6])).toEqual([0, 0.5, 1]);
  });

  it('does not divide by zero when all values are equal', () => {
    expect(normalise([3, 3])).toEqual([1, 1]);
    expect(normalise([0, 0])).toEqual([0, 0]);
  });

  it('gives null (no value) 0 and leaves it out of the range', () => {
    expect(normalise([null, 0.2, 0.6])).toEqual([0, 0, 1]);
    expect(normalise([null, null])).toEqual([0, 0]);
  });
});

describe('query text', () => {
  it('uses the words of q plus the terms, each once', () => {
    const s = state([], { q: 'vintage jacket for autumn', terms: ['jacket', 'coat'] });
    expect(queryTokens(s)).toEqual(['vintage', 'jacket', 'autumn', 'coat']);
    expect(queryText(s)).toBe('vintage jacket for autumn jacket coat');
  });

  it('is empty without q and terms', () => {
    expect(queryText(state([], { q: '' }))).toBe('');
  });
});

describe('listingText', () => {
  it('adds the enriched garment type, synonyms and search text (D8)', () => {
    const l = listing({
      id: 'a',
      title: 'Bronze bomber',
      metadata: { ai: { garmentType: 'bomber jacket', synonyms: ['coat'], searchText: 'Warm.' } },
    });
    expect(listingText(l)).toBe('Bronze bomber Bronze bomber description bomber jacket coat Warm.');
  });
});

describe('preferenceShare', () => {
  const tagged = listing({
    id: 'a',
    publicData: { color: 'black' },
    metadata: { ai: { style: ['vintage'], season: ['winter'], warmth: 'warm', brand: 'Nike' } },
  });

  it('is the share of preferences matched by the enriched tags', () => {
    expect(preferenceShare(state([], { preferences: ['vintage', 'autumn'] }), tagged)).toBe(0.5);
    expect(preferenceShare(state([], { preferences: ['Warm', 'winter'] }), tagged)).toBe(1);
  });

  it('counts soft colour and brand filters as preferences', () => {
    const soft = [
      filter('color', 'black', { mode: 'soft' }),
      filter('brand', 'adidas', { mode: 'soft' }),
    ];
    expect(preferenceShare(state(soft), tagged)).toBe(0.5);
  });

  it('is 0 for everyone without preferences', () => {
    expect(preferenceShare(state([]), tagged)).toBe(0);
  });
});

describe('hasRankingSignals', () => {
  it('is false only for a pure filter search', () => {
    expect(hasRankingSignals(state([filter('size', 'm')], { q: '' }))).toBe(false);
    expect(hasRankingSignals(state([], { q: '', terms: ['coat'] }))).toBe(true);
    expect(hasRankingSignals(state([], { q: '', preferences: ['vintage'] }))).toBe(true);
    expect(hasRankingSignals(state([filter('color', 'black', { mode: 'soft' })], { q: '' }))).toBe(
      true
    );
  });
});

describe('rankListings', () => {
  // "a" means the same as the query; "b" has the query word but a different meaning.
  const a = listing({ id: 'a', title: 'Warm coat' });
  const b = listing({ id: 'b', title: 'Jacket potato' });
  const vectors = { listings: { a: { vector: [1, 0] }, b: { vector: [0, 1] } } };
  const s = state([], { q: 'jacket' });

  it('uses D1 weights 0.5 / 0.3 / 0.2 by default', () => {
    expect(WEIGHTS).toEqual({ semantic: 0.5, keyword: 0.3, preferences: 0.2 });
  });

  it('changes the order when the weights change', () => {
    const order = weights => {
      const { scores } = rankListings({
        listings: [a, b],
        state: s,
        queryVector: [1, 0],
        vectors,
        weights,
      });
      return [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    };
    expect(order(undefined)).toEqual(['a', 'b']);
    expect(order({ semantic: 0.1, keyword: 0.8, preferences: 0.1 })).toEqual(['b', 'a']);
  });

  it('computes score as the weighted sum of the normalised signals', () => {
    const { scores, signals } = rankListings({
      listings: [a, b],
      state: s,
      queryVector: [1, 0],
      vectors,
    });
    expect(signals.get('a')).toEqual({ semantic: 1, keyword: 0, preferences: 0 });
    expect(signals.get('b')).toEqual({ semantic: 0, keyword: 1, preferences: 0 });
    expect(scores.get('a')).toBeCloseTo(0.5);
    expect(scores.get('b')).toBeCloseTo(0.3);
  });

  it('ranks a listing without a vector through keyword and preferences', () => {
    const noVector = listing({
      id: 'new',
      title: 'Vintage jacket',
      metadata: { ai: { style: ['vintage'] } },
    });
    const { scores, signals } = rankListings({
      listings: [a, b, noVector],
      state: state([], { q: 'jacket', preferences: ['vintage'] }),
      queryVector: [1, 0],
      vectors,
    });
    expect(signals.get('new')).toEqual({ semantic: 0, keyword: 1, preferences: 1 });
    expect(scores.get('new')).toBeCloseTo(0.5);
    expect(scores.get('new')).toBeGreaterThan(scores.get('b'));
  });

  it('gives semantic 0 to everyone without a query vector', () => {
    const { signals } = rankListings({ listings: [a, b], state: s, queryVector: null, vectors });
    expect([...signals.values()].map(x => x.semantic)).toEqual([0, 0]);
  });
});
