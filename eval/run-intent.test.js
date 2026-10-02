const cases = require('./intent-cases.json').cases;
const { valueMatches, checkCase, expandState } = require('./run-intent');
const { config } = require('../server/api/smart-search/test-data');

describe('intent eval cases', () => {
  it('has 20 cases with unique ids, text and an expectation', () => {
    expect(cases).toHaveLength(20);
    expect(new Set(cases.map(c => c.id)).size).toBe(20);
    cases.forEach(c => {
      expect(typeof c.text).toBe('string');
      expect(c.expect).toBeDefined();
    });
  });

  it('covers the required situations', () => {
    const texts = cases.map(c => c.text);
    [
      'size 38 shoes',
      'for my 5 year old',
      'baby blue dress',
      'under 30€',
      "men's",
      'no bundles',
    ].forEach(t => expect(texts).toContain(t));
    expect(cases.find(c => c.text === 'cheaper').previousState).toBeDefined();
    expect(cases.find(c => c.text === 'now I need sneakers').previousState).toBeDefined();
    expect(cases.some(c => (c.previousState?.filters || []).some(f => f.source === 'user'))).toBe(
      true
    );
  });

  it('builds previous states that pass the config', () => {
    cases
      .filter(c => c.previousState)
      .forEach(c => {
        const state = expandState(c.previousState, config);
        state.filters.forEach(f => expect(f.label).toBeTruthy());
      });
  });
});

describe('checkCase', () => {
  const got = (overrides = {}) => ({
    intent: { mode: 'new', priceIntent: 'none' },
    state: { filters: [{ key: 'size', value: 'm' }], removed: [] },
    notices: [],
    ...overrides,
  });

  it('passes when everything expected is there', () => {
    expect(checkCase({ mode: 'new', filters: [{ key: 'size', value: 'm' }] }, got())).toEqual([]);
  });

  it('reports a wrong mode, a missing filter, an unexpected key and a missing notice', () => {
    const problems = checkCase(
      {
        mode: 'refine',
        filters: [{ key: 'color', value: 'red' }],
        absent: ['size'],
        notices: ['USER_FILTER_KEPT'],
      },
      got()
    );
    expect(problems).toHaveLength(4);
  });

  it('matches a scalar against a list and a list against the same set', () => {
    expect(valueMatches('a', ['a', 'b'])).toBe(true);
    expect(valueMatches(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(valueMatches(['a'], ['a', 'b'])).toBe(false);
    expect(valueMatches({ max: 3000 }, { max: 3000 })).toBe(true);
  });
});
