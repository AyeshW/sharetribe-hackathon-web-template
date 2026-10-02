const { mergeIntent, applyCheaper } = require('./state');
const { validateIntent } = require('./intent');
const { config, listing, filter, state, rawIntent } = require('./test-data');

// An intent as intent.js returns it, from raw filters { key, op, value }.
const intentOf = overrides => validateIntent(rawIntent(overrides), config);
const f = (key, op, value) => ({ key, op, value });
const keys = s => s.filters.map(x => x.key);
const merge = (intentOverrides, previous = null, q = 'new text') =>
  mergeIntent({ q, state: previous, intent: intentOf(intentOverrides) });

describe('mergeIntent', () => {
  it('starts a new search from the intent when there is no previous state', () => {
    const { state: next, notices } = merge({
      filters: [f('size', 'eq', 'm'), f('color', 'eq', 'black')],
      preferences: ['vintage'],
      terms: ['jeans'],
    });
    expect(next).toMatchObject({
      q: 'new text',
      preferences: ['vintage'],
      removed: [],
      similarTo: null,
      terms: ['jeans'],
    });
    expect(keys(next)).toEqual(['size', 'color']);
    expect(notices).toEqual([]);
  });

  describe('a new search (rule 3)', () => {
    const previous = state(
      [
        filter('categoryLevel1', 'men', { source: 'user', label: 'Men' }),
        filter('size', 'l'),
        filter('price', { max: 4000 }, { locked: true }),
      ],
      { preferences: ['vintage'], removed: ['color'], similarTo: 'abc', terms: ['coat'] }
    );

    it('keeps only the buyer filters and resets everything else', () => {
      const { state: next } = merge({ mode: 'new', terms: ['sneakers'] }, previous);
      expect(next).toEqual({
        q: 'new text',
        filters: [previous.filters[0]],
        preferences: [],
        removed: [],
        similarTo: null,
        terms: ['sneakers'],
      });
    });

    it('lets removed keys come back, since removed is reset', () => {
      const { state: next } = merge({ filters: [f('color', 'eq', 'red')] }, previous);
      expect(keys(next)).toEqual(['categoryLevel1', 'color']);
    });
  });

  describe('buyer filters win (rule 1)', () => {
    const userBlue = filter('color', 'blue', { source: 'user', label: 'Blue' });

    it('keeps the buyer filter and notices the conflict with its label', () => {
      const { state: next, notices } = merge(
        { filters: [f('color', 'eq', 'black')] },
        state([userBlue])
      );
      expect(next.filters).toEqual([userBlue]);
      expect(notices).toEqual([{ code: 'USER_FILTER_KEPT', params: { label: 'Blue' } }]);
    });

    it('gives no notice when the text agrees with the buyer filter', () => {
      const { notices } = merge({ filters: [f('color', 'eq', 'blue')] }, state([userBlue]));
      expect(notices).toEqual([]);
    });

    it('also protects locked chips in a refinement', () => {
      const locked = filter('size', 'm', { locked: true, label: 'Size M' });
      const { state: next, notices } = merge(
        { mode: 'refine', filters: [f('size', 'eq', 'l')] },
        state([locked])
      );
      expect(next.filters).toEqual([locked]);
      expect(notices).toEqual([{ code: 'USER_FILTER_KEPT', params: { label: 'Size M' } }]);
    });

    it('does not remove a buyer filter when the text asks for it', () => {
      const { state: next, notices } = merge(
        { mode: 'refine', removeKeys: ['color'] },
        state([userBlue])
      );
      expect(next.filters).toEqual([userBlue]);
      expect(next.removed).toEqual([]);
      expect(notices).toHaveLength(1);
    });

    it('replaces an inferred filter of the same key', () => {
      const { state: next } = merge(
        { mode: 'refine', filters: [f('color', 'eq', 'green')] },
        state([filter('color', 'black', { mode: 'soft' })])
      );
      expect(next.filters).toHaveLength(1);
      expect(next.filters[0]).toMatchObject({ key: 'color', value: 'green', mode: 'soft' });
    });

    it('gives one notice per label', () => {
      const { notices } = merge(
        { mode: 'refine', filters: [f('color', 'in', ['black', 'red'])], removeKeys: ['color'] },
        state([userBlue])
      );
      expect(notices).toHaveLength(1);
    });
  });

  describe('removed keys (rule 2)', () => {
    it('does not infer a removed key again in a refinement', () => {
      const { state: next } = merge(
        { mode: 'refine', filters: [f('size', 'eq', 'm'), f('color', 'eq', 'red')] },
        state([], { removed: ['size'] })
      );
      expect(keys(next)).toEqual(['color']);
      expect(next.removed).toEqual(['size']);
    });

    it('removes inferred filters named in removeKeys and remembers them', () => {
      const { state: next } = merge(
        { mode: 'refine', removeKeys: ['size'] },
        state([filter('size', 'm'), filter('color', 'black')], { removed: ['brand'] })
      );
      expect(keys(next)).toEqual(['color']);
      expect(next.removed).toEqual(['brand', 'size']);
    });

    it('lets a reply remove and set a key at once: the new value wins', () => {
      const { state: next } = merge(
        { mode: 'refine', removeKeys: ['color'], filters: [f('color', 'eq', 'red')] },
        state([filter('color', 'black')])
      );
      expect(next.filters[0]).toMatchObject({ key: 'color', value: 'red' });
      expect(next.removed).toEqual([]);
    });
  });

  describe('a refinement', () => {
    const previous = state([filter('categoryLevel2', 'men-bottoms'), filter('size', 'm')], {
      q: 'jeans size M',
      preferences: ['vintage', 'autumn'],
      terms: ['jeans'],
      similarTo: 'abc',
    });

    it('merges into the previous state', () => {
      const { state: next } = merge(
        {
          mode: 'refine',
          filters: [f('color', 'eq', 'black')],
          preferences: ['oversized'],
          removePreferences: ['Autumn'],
          terms: ['black', 'jeans'],
        },
        previous,
        'in black, not autumn'
      );
      expect(next).toMatchObject({
        q: 'in black, not autumn',
        preferences: ['vintage', 'oversized'],
        terms: ['jeans', 'black'],
        similarTo: 'abc',
      });
      expect(keys(next)).toEqual(['categoryLevel2', 'size', 'color']);
    });

    it('leaves the previous state alone when the text adds nothing', () => {
      const { state: next } = merge({ mode: 'refine' }, previous, 'cheaper');
      expect(next).toEqual({ ...previous, q: 'cheaper' });
    });

    it('does not change the previous state object', () => {
      const copy = JSON.parse(JSON.stringify(previous));
      merge(
        { mode: 'refine', filters: [f('size', 'eq', 'l')], removeKeys: ['categoryLevel2'] },
        previous
      );
      expect(previous).toEqual(copy);
    });
  });

  it('treats a refinement without a previous state as a new search', () => {
    const { state: next } = merge({ mode: 'refine', filters: [f('size', 'eq', 'm')] });
    expect(keys(next)).toEqual(['size']);
  });
});

describe('applyCheaper', () => {
  const listings = [1000, 2000, 3000, 4000, 9000].map((price, i) =>
    listing({ id: `l${i}`, price, publicData: { categoryLevel1: 'men' } })
  );
  const priceOf = s => s.filters.find(x => x.key === 'price');
  const run = (s, extra = {}) =>
    applyCheaper({ state: s, notices: [], listings, config, ...extra });

  it('lowers an existing price max by 20%', () => {
    const { state: next } = run(state([filter('price', { max: 6000 }, { label: 'Under €60' })]));
    expect(priceOf(next)).toMatchObject({
      value: { max: 4800 },
      label: 'Under €48',
      op: 'range',
      mode: 'hard',
      source: 'inferred',
      locked: false,
    });
  });

  it('keeps the min and never goes below it', () => {
    const { state: next } = run(state([filter('price', { min: 5000, max: 5500 })]));
    expect(priceOf(next).value).toEqual({ min: 5000, max: 5000 });
  });

  it('without a price filter uses 80% of the median price of the candidates', () => {
    const { state: next } = run(state([]));
    // median of 10, 20, 30, 40, 90 € is 30 €
    expect(priceOf(next).value).toEqual({ max: 2400 });
    expect(priceOf(next).label).toBe('Under €24');
  });

  it('uses the median of the candidates that pass the other hard filters', () => {
    const mixed = [
      listing({ id: 'a', price: 1000, publicData: { categoryLevel1: 'men' } }),
      listing({ id: 'b', price: 2000, publicData: { categoryLevel1: 'men' } }),
      listing({ id: 'c', price: 9000, publicData: { categoryLevel1: 'women' } }),
    ];
    const { state: next } = run(state([filter('categoryLevel1', 'men')]), { listings: mixed });
    expect(priceOf(next).value).toEqual({ max: 1200 });
  });

  it('adds a max to a min-only price filter', () => {
    const { state: next } = run(state([filter('price', { min: 500 })]));
    expect(priceOf(next).value).toEqual({ min: 500, max: 2400 });
  });

  it('keeps a price the buyer set, with a notice', () => {
    const userPrice = filter('price', { max: 6000 }, { source: 'user', label: 'Under €60' });
    const { state: next, notices } = run(state([userPrice]));
    expect(priceOf(next)).toBe(userPrice);
    expect(notices).toEqual([{ code: 'USER_FILTER_KEPT', params: { label: 'Under €60' } }]);
  });

  it('changes nothing when there are no candidates and no price filter', () => {
    const input = state([]);
    expect(run(input, { listings: [] }).state).toBe(input);
  });
});
