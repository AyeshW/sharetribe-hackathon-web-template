const {
  WEIGHT_SETS,
  compareWeights,
  highestLine,
  formatTable,
  buildComparisonHtml,
  queryOnce,
} = require('./compare-weights');
const { createNewSearcher } = require('./searchers/new');
const { WEIGHTS } = require('../server/api/smart-search/ranking');

const queries = [
  { id: 'q1', text: 'trainers', relevant: [{ id: 'a', grade: 2 }] },
  { id: 'q2', text: 'jumper', relevant: [{ id: 'b', grade: 2 }] },
  { id: 'q3', text: 'y2k', relevant: [{ id: 'c', grade: 2 }] },
];

const hit = (id, title) => ({ id, title });

// Fake searcher: with more keyword weight, 'jumper' starts passing and 'trainers' stops.
const searcherFor = weights => async text => {
  const keywordHeavy = weights.keyword >= 0.4;
  if (text === 'trainers') {
    return keywordHeavy ? [hit('x', 'Wrong')] : [hit('a', 'White sneakers')];
  }
  if (text === 'jumper') {
    return keywordHeavy ? [hit('b', 'Wool sweater')] : [hit('x', 'Wrong')];
  }
  return [];
};

const weightSets = [
  { semantic: 0.5, keyword: 0.3, preferences: 0.2 },
  { semantic: 0.3, keyword: 0.5, preferences: 0.2 },
  { semantic: 0.7, keyword: 0.2, preferences: 0.1 },
];

describe('WEIGHT_SETS', () => {
  it('starts with the weights in ranking.js and has the five sets to compare', () => {
    expect(WEIGHT_SETS[0]).toBe(WEIGHTS);
    expect(WEIGHT_SETS.map(w => [w.semantic, w.keyword, w.preferences])).toEqual([
      [0.5, 0.3, 0.2],
      [0.7, 0.2, 0.1],
      [0.4, 0.4, 0.2],
      [0.3, 0.5, 0.2],
      [0.6, 0.4, 0.0],
    ]);
  });
});

describe('compareWeights', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.reject(new Error('no network in tests')));
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('counts passes, Found, empty and changes against the first set', async () => {
    const rows = await compareWeights({ queries, weightSets, searcherFor });

    expect(rows.map(row => row.summary.passes)).toEqual([1, 1, 1]);
    expect(rows.map(row => row.summary.empty)).toEqual([1, 1, 1]);
    expect(rows.map(row => row.summary.avgFoundPercent)).toEqual([33, 33, 33]);
    expect(rows[0]).toMatchObject({ isBaseline: true, better: 0, worse: 0 });
    expect(rows[1]).toMatchObject({ better: 1, worse: 1 });
    expect(rows[1].changes).toEqual(['worse', 'better', 'same']);
    expect(rows[2]).toMatchObject({ better: 0, worse: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('prints the table with one row per weight set', async () => {
    const rows = await compareWeights({ queries, weightSets, searcherFor });
    const lines = formatTable(rows).split('\n');

    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(
      /^weights \(sem \/ kw \/ pref\) \| queries passed \| average Found \| empty \| changed vs 0\.5 \/ 0\.3 \/ 0\.2$/
    );
    expect(lines[2].split(' | ').map(cell => cell.trim())).toEqual([
      '0.5 / 0.3 / 0.2 (now)',
      '1 of 3',
      '33%',
      '1',
      '–',
    ]);
    expect(lines[3].split(' | ').map(cell => cell.trim())).toEqual([
      '0.3 / 0.5 / 0.2',
      '1 of 3',
      '33%',
      '1',
      '2 (1 better, 1 worse)',
    ]);
  });

  it('names the highest pass count without choosing, also on a tie', async () => {
    const rows = await compareWeights({ queries, weightSets, searcherFor });
    expect(highestLine(rows)).toBe(
      'Highest pass count, tied: 0.5 / 0.3 / 0.2, 0.3 / 0.5 / 0.2, 0.7 / 0.2 / 0.1 (1 of 3 each).'
    );

    const single = await compareWeights({
      queries,
      weightSets,
      searcherFor: weights => async text =>
        weights.semantic === 0.7 && text === 'y2k'
          ? [hit('c', 'Y2K top')]
          : searcherFor(weights)(text),
    });
    expect(highestLine(single)).toBe('Highest pass count: 0.7 / 0.2 / 0.1 (2 of 3).');
  });

  it('writes an HTML page with the summary and every query', async () => {
    const rows = await compareWeights({ queries, weightSets, searcherFor });
    const html = buildComparisonHtml({ rows, queries, startedAt: '2026-10-02T09:00:00.000Z' });

    expect(html).toContain('Highest pass count, tied');
    expect(html).toContain('0.3 / 0.5 / 0.2');
    expect(html).toContain('White sneakers');
    expect(html).toContain('<td class="worse">');
    expect(html).toContain('<td class="better">');
    ['trainers', 'jumper', 'y2k'].forEach(text => expect(html).toContain(text));
  });

  it('reports a missing cached intent as a failed query in every row, without fetching', async () => {
    const sdk = { listings: { query: jest.fn() } };
    const rows = await compareWeights({
      queries,
      weightSets,
      searcherFor: weights =>
        createNewSearcher({
          sdk,
          config: {},
          vectors: {},
          embedQuery: null,
          intentCache: { entries: {} },
          weights,
        }),
    });

    rows.forEach(row => {
      expect(row.summary.errors).toBe(3);
      expect(row.runs[0].error).toContain('no cached intent for "trainers"');
    });
    expect(sdk.listings.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('queryOnce', () => {
  it('asks the SDK once per distinct query', async () => {
    const sdk = { listings: { query: jest.fn(params => Promise.resolve({ params })) } };
    const cached = queryOnce(sdk);

    await cached.listings.query({ page: 1 });
    await cached.listings.query({ page: 1 });
    await cached.listings.query({ page: 2 });
    expect(sdk.listings.query).toHaveBeenCalledTimes(2);
  });
});
