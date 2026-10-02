const { runEval, compare, buildReportHtml, confirmClaudeSpend } = require('./run');

const listing = (id, title) => ({ id, title });

const queries = [
  {
    id: 'q01',
    text: 'trainers',
    tests: 'synonyms',
    relevant: [
      { id: 'a', title: 'White sneakers', grade: 2 },
      { id: 'b', title: 'Grey trainers', grade: 1 },
    ],
  },
  {
    id: 'q02',
    text: 'snekers',
    tests: 'typos',
    relevant: [{ id: 'c', title: 'Red canvas sneakers', grade: 2 }],
  },
];

// Old search: finds everything for q01, nothing for q02.
const fakeOldSearch = async text =>
  text === 'trainers' ? [listing('a', 'White sneakers'), listing('b', 'Grey trainers')] : [];

// New search: finds both.
const fakeNewSearch = async text =>
  text === 'trainers'
    ? [listing('a', 'White sneakers'), listing('b', 'Grey trainers')]
    : [listing('c', 'Red canvas sneakers')];

const run = (overrides = {}) =>
  runEval({
    queries,
    oldSearch: fakeOldSearch,
    startedAt: '2026-10-02T09:00:00.000Z',
    ...overrides,
  });

describe('runEval', () => {
  it('applies the checks to every query', async () => {
    const result = await run();

    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]).toMatchObject({
      id: 'q01',
      text: 'trainers',
      tests: 'synonyms',
      change: null,
    });
    expect(result.queries[0].old).toMatchObject({
      passes: true,
      empty: false,
      found: { found: 2, total: 2 },
      bestInTop3: true,
    });
    expect(result.queries[1].old).toMatchObject({ passes: false, empty: true });
  });

  it('writes the summary line with the new search not built', async () => {
    const result = await run();
    expect(result.summaryLine).toBe('Old search: 1 of 2 queries pass. New search: not built yet.');
    expect(result.summary.new).toBeNull();
    expect(result.summary.old).toMatchObject({ passes: 1, total: 2, empty: 1 });
    expect(result.summary.old.avgFoundPercent).toBe(50);
  });

  it('compares the two searches when the new one is given', async () => {
    const result = await run({ newSearch: fakeNewSearch });

    expect(result.summaryLine).toBe('Old search: 1 of 2 queries pass. New search: 2 of 2 pass.');
    expect(result.queries.map(query => query.change)).toEqual(['same', 'better']);
  });

  it('counts passes per kind of query', async () => {
    const result = await run({ newSearch: fakeNewSearch });

    expect(result.summary.byType).toEqual([
      { type: 'synonyms', count: 1, oldPasses: 1, newPasses: 1 },
      { type: 'typos', count: 1, oldPasses: 0, newPasses: 1 },
    ]);
  });

  it('records a failing search instead of throwing', async () => {
    const broken = async () => {
      throw new Error('API is down');
    };
    const result = await run({ oldSearch: broken });

    expect(result.queries[0].old).toMatchObject({ error: 'API is down', passes: false });
    expect(result.summary.old.errors).toBe(2);
  });
});

describe('compare', () => {
  const asRun = (passes, foundCount) => ({ passes, found: { found: foundCount, total: 2 } });

  it('is null when there is no new search', () => {
    expect(compare(asRun(true, 2), null)).toBeNull();
  });

  it('is better when the new search starts passing', () => {
    expect(compare(asRun(false, 0), asRun(true, 2))).toBe('better');
  });

  it('is worse when the new search stops passing', () => {
    expect(compare(asRun(true, 2), asRun(false, 1))).toBe('worse');
  });

  it('compares how much was found when both pass', () => {
    expect(compare(asRun(true, 1), asRun(true, 2))).toBe('better');
    expect(compare(asRun(true, 2), asRun(true, 1))).toBe('worse');
    expect(compare(asRun(true, 2), asRun(true, 2))).toBe('same');
  });
});

describe('buildReportHtml', () => {
  it('shows the summary line, a type table and one row per query', async () => {
    const html = buildReportHtml(await run());

    expect(html).toContain('Old search: 1 of 2 queries pass. New search: not built yet.');
    expect(html).toContain('Kind of query');
    expect(html).toContain('synonyms');
    expect(html).toContain('typos');
    expect((html.match(/<details class="row/g) || []).length).toBe(2);
    expect(html).toContain('trainers');
    expect(html).toContain('snekers');
  });

  it('shows result titles, not ids', async () => {
    const html = buildReportHtml(await run());

    expect(html).toContain('White sneakers');
    expect(html).toContain('Grey trainers');
    expect(html).not.toContain('>a<');
  });

  it('shows the correct listings of each query in the expandable part', async () => {
    const html = buildReportHtml(await run());

    expect(html).toContain('The listings this query should find');
    expect(html).toContain('Red canvas sneakers');
    expect(html).toContain('clearly right');
  });

  it('marks a row red when the new search is worse', async () => {
    const worseSearch = async () => [];
    const html = buildReportHtml(await run({ newSearch: worseSearch }));

    expect(html).toContain('worse-row');
    expect(html).toContain('▼ worse');
  });

  it('escapes HTML in listing titles and queries', async () => {
    const nasty = [{ ...queries[0], text: '<script>bad</script>', relevant: queries[0].relevant }];
    const html = buildReportHtml(
      await runEval({ queries: nasty, oldSearch: async () => [listing('a', '<b>Hi</b>')] })
    );

    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Hi&lt;/b&gt;');
  });
});

describe('confirmClaudeSpend', () => {
  const quiet = () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not ask when there are no Claude calls', async () => {
    quiet();
    const ask = jest.fn();
    await expect(confirmClaudeSpend({ calls: 0, ask })).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks before spending and stops on anything but yes', async () => {
    quiet();
    await expect(confirmClaudeSpend({ calls: 25, ask: async () => 'y' })).resolves.toBe(true);
    await expect(confirmClaudeSpend({ calls: 25, ask: async () => '' })).resolves.toBe(false);
    await expect(confirmClaudeSpend({ calls: 25, ask: async () => 'n' })).resolves.toBe(false);
  });

  it('prints the number of calls and the cost', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await confirmClaudeSpend({ calls: 25, assumeYes: true });
    expect(log.mock.calls[0][0]).toMatch(/25 Claude API calls, costing about \$0\.10/);
  });
});

describe('summary line for a hand-made result set', () => {
  const ids = (...list) => list.map(id => listing(id, `Title ${id}`));
  const handMade = [
    { id: 'h1', text: 'one', tests: 't', relevant: [{ id: 'a', grade: 2 }] },
    { id: 'h2', text: 'two', tests: 't', relevant: [{ id: 'b', grade: 2 }] },
    { id: 'h3', text: 'three', tests: 't', relevant: [{ id: 'c', grade: 2 }] },
    {
      id: 'h4',
      text: 'four',
      tests: 't',
      relevant: [{ id: 'd', grade: 2 }, { id: 'e', grade: 1 }, { id: 'f', grade: 1 }],
    },
  ];
  // Old: passes one (best in top 3); fails two (not found) and four (found 1 of 3, not half).
  // New: passes one, two and four; three errors.
  const oldSearch = async text =>
    ({ one: ids('a'), two: [], three: ids('x'), four: ids('d', 'x') }[text]);
  const newSearch = async text => {
    if (text === 'three') {
      throw new Error('no cached intent for "three"');
    }
    return { one: ids('a'), two: ids('x', 'b'), four: ids('d', 'e', 'x') }[text];
  };
  const weights = { semantic: 0.5, keyword: 0.3, preferences: 0.2 };

  it('counts passes for each search', async () => {
    const result = await runEval({ queries: handMade, oldSearch, newSearch, weights });

    expect(result.summaryLine).toBe('Old search: 1 of 4 queries pass. New search: 3 of 4 pass.');
    expect(result.summary.old).toMatchObject({ passes: 1, total: 4, empty: 1, errors: 0 });
    expect(result.summary.new).toMatchObject({ passes: 3, total: 4, empty: 0, errors: 1 });
    expect(result.queries.map(query => query.change)).toEqual(['same', 'better', 'same', 'better']);
  });

  it('puts the summary line at the top of the report and shows the weights', async () => {
    const html = buildReportHtml(
      await runEval({ queries: handMade, oldSearch, newSearch, weights })
    );

    const summaryAt = html.indexOf('Old search: 1 of 4 queries pass. New search: 3 of 4 pass.');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(html.indexOf('Every query'));
    expect(html).toContain('meaning 0.5 · word match 0.3 · preferences 0.2');
  });
});
