/**
 * Compare ranking weight sets with the eval: run every eval query through the new search once per
 * weight set and print how many queries pass with each. It doesn't pick a winner and doesn't
 * change server/api/smart-search/ranking.js; the team chooses.
 *
 *   node eval/compare-weights.js                 run it
 *   node eval/compare-weights.js --yes           don't ask before Claude API calls
 *   node eval/compare-weights.js --fresh-intent  forget the cached intents and ask Claude again
 *
 * Intents come from eval/results/intent-cache.json (shared with eval/run.js). Only queries without
 * a cached intent cost anything: one Claude Haiku call each, about $0.004, after asking. The
 * comparison itself makes no Claude calls and never downloads the embedding model.
 *
 * Writes eval/results/weights-comparison.html.
 */
const fs = require('fs');
const path = require('path');

const {
  runOne,
  compare,
  summarizeSearcher,
  prepareNewSearch,
  escapeHtml,
  RESULTS_DIR,
} = require('./run');
const { TOP_WINDOW } = require('./checks');
const { loadGroundTruth } = require('./ground-truth');
const { createNewSearcher } = require('./searchers/new');
const { WEIGHTS } = require('../server/api/smart-search/ranking');

const REPORT_FILE = path.join(RESULTS_DIR, 'weights-comparison.html');

// (semantic, keyword, preferences). The first set is the one in ranking.js today; every other row
// is compared against it.
const WEIGHT_SETS = [
  WEIGHTS,
  { semantic: 0.7, keyword: 0.2, preferences: 0.1 },
  { semantic: 0.4, keyword: 0.4, preferences: 0.2 },
  { semantic: 0.3, keyword: 0.5, preferences: 0.2 },
  { semantic: 0.6, keyword: 0.4, preferences: 0.0 },
];

const label = weights => `${weights.semantic} / ${weights.keyword} / ${weights.preferences}`;

/**
 * Run every query once per weight set.
 *
 * @param {Object} input
 * @param {Array} input.queries from the ground truth
 * @param {Array<Object>} input.weightSets the first one is the baseline
 * @param {(weights: Object) => Function} input.searcherFor a search function for one weight set
 * @returns {Promise<Array<Object>>} one row per weight set: { weights, runs, summary, changes,
 *   better, worse, isBaseline }; changes[i] is better / worse / same against the baseline
 */
const compareWeights = async ({ queries, weightSets, searcherFor }) => {
  const sets = [];
  for (const weights of weightSets) {
    const search = searcherFor(weights);
    const runs = [];
    for (const query of queries) {
      runs.push(await runOne(search, query));
    }
    sets.push({ weights, runs, summary: summarizeSearcher(runs.map(run => ({ run }))) });
  }

  const baseline = sets[0];
  return sets.map((set, index) => {
    const changes = set.runs.map((run, i) => compare(baseline.runs[i], run));
    return {
      ...set,
      isBaseline: index === 0,
      changes,
      better: changes.filter(c => c === 'better').length,
      worse: changes.filter(c => c === 'worse').length,
    };
  });
};

/**
 * The rows with the highest pass count (more than one on a tie).
 */
const highestPassRows = rows => {
  const best = Math.max(...rows.map(row => row.summary.passes));
  return rows.filter(row => row.summary.passes === best);
};

const changedText = row =>
  row.isBaseline ? '–' : `${row.better + row.worse} (${row.better} better, ${row.worse} worse)`;

/**
 * The table as plain text for the terminal.
 *
 * @param {Array<Object>} rows from compareWeights
 * @returns {string}
 */
const formatTable = rows => {
  const baseline = rows[0];
  const header = [
    'weights (sem / kw / pref)',
    'queries passed',
    'average Found',
    'empty',
    `changed vs ${label(baseline.weights)}`,
  ];
  const lines = rows.map(row => [
    `${label(row.weights)}${row.isBaseline ? ' (now)' : ''}`,
    `${row.summary.passes} of ${row.summary.total}`,
    `${row.summary.avgFoundPercent}%`,
    String(row.summary.empty),
    changedText(row),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map(line => line[i].length)));
  const format = cells =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join(' | ')
      .trimEnd();
  return [format(header), widths.map(w => '-'.repeat(w)).join('-|-'), ...lines.map(format)].join(
    '\n'
  );
};

/**
 * The sentence printed under the table. Names the highest pass count, doesn't choose.
 */
const highestLine = rows => {
  const top = highestPassRows(rows);
  const names = top.map(row => label(row.weights)).join(', ');
  const count = `${top[0].summary.passes} of ${top[0].summary.total}`;
  return top.length === 1
    ? `Highest pass count: ${names} (${count}).`
    : `Highest pass count, tied: ${names} (${count} each).`;
};

// ---------------------------------------------------------------------------
// The HTML page, in the style of eval/report.html
// ---------------------------------------------------------------------------

const verdictCell = (run, change) => {
  if (run.error) {
    return `<td class="${change || ''}"><strong>⚠️ failed</strong><div class="note">${escapeHtml(
      run.error
    )}</div></td>`;
  }
  const titles = run.results
    .slice(0, TOP_WINDOW)
    .map(r => `<li>${escapeHtml(r.title)}</li>`)
    .join('');
  const marker = { better: ' ▲', worse: ' ▼' }[change] || '';
  return `<td class="${change || ''}"><strong>${run.passes ? '✅' : '❌'} ${run.found.found} of ${
    run.found.total
  }${marker}</strong>${titles ? `<ol class="titles">${titles}</ol>` : ''}</td>`;
};

/**
 * @param {{ rows: Array, queries: Array, startedAt: string }} input
 * @returns {string} HTML
 */
const buildComparisonHtml = ({ rows, queries, startedAt }) => {
  const baseline = rows[0];
  const summaryRows = rows
    .map(
      row => `<tr${row.isBaseline ? ' class="now"' : ''}>
        <td>${escapeHtml(label(row.weights))}${row.isBaseline ? ' (now)' : ''}</td>
        <td>${row.summary.passes} of ${row.summary.total}</td>
        <td>${row.summary.avgFoundPercent}%</td>
        <td>${row.summary.empty}</td>
        <td>${escapeHtml(changedText(row))}</td>
      </tr>`
    )
    .join('');
  const head = rows.map(row => `<th>${escapeHtml(label(row.weights))}</th>`).join('');
  const queryRows = queries
    .map(
      (query, i) =>
        `<tr><td class="query">${escapeHtml(query.text)}</td>${rows
          .map(row => verdictCell(row.runs[i], row.isBaseline ? null : row.changes[i]))
          .join('')}</tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ranking weights comparison</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         margin: 0; padding: 24px; color: #1a1a1a; background: #fff; line-height: 1.5; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  .when { color: #666; font-size: 13px; margin: 0 0 24px; }
  .summary { font-size: 18px; font-weight: 600; background: #f3f6ff; border: 1px solid #c9d8ff;
             border-radius: 8px; padding: 16px; }
  .legend { font-size: 13px; color: #444; }
  table { border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #ddd; padding: 6px 12px; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; }
  tr.now { font-weight: 600; }
  td.query { font-weight: 600; }
  td.better { background: #e8f6ec; }
  td.worse { background: #fdecec; }
  .titles { margin: 4px 0 0; padding-left: 20px; font-size: 12px; color: #333; }
  .note { font-size: 12px; color: #a33; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<h1>Ranking weights comparison</h1>
<p class="when">Run on ${escapeHtml(new Date(startedAt).toLocaleString('en-GB'))} · ${
    queries.length
  } test queries · new search only, no rerank</p>

<p class="summary">${escapeHtml(highestLine(rows))} The team chooses the weights.</p>
<p class="legend">Weights are meaning (semantic) / word match (keyword) / preferences. A query
  passes when a clearly right listing is in the first 3 results <em>and</em> at least half of its
  correct listings are in the first 10. "Changed" counts queries that pass or fail differently, or
  find a different number of correct listings, than with ${escapeHtml(label(baseline.weights))}.</p>

<h2>Summary</h2>
<table>
  <thead><tr><th>Weights</th><th>Queries passed</th><th>Average Found</th><th>Empty</th>
    <th>Changed vs ${escapeHtml(label(baseline.weights))}</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table>

<h2>Every query</h2>
<p class="legend">Green: better than with ${escapeHtml(
    label(baseline.weights)
  )}. Red: worse. Each cell shows the top ${TOP_WINDOW} titles.</p>
<div class="scroll">
<table>
  <thead><tr><th>Query</th>${head}</tr></thead>
  <tbody>${queryRows}</tbody>
</table>
</div>
</body>
</html>
`;
};

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * The SDK with each listings.query answered once per run, so every weight set ranks exactly the
 * same listings and the Marketplace API sees one query per eval query, not one per weight set.
 * Eval only; the endpoint never caches (D4).
 */
const queryOnce = sdk => {
  const answers = new Map();
  return {
    listings: {
      query: params => {
        const key = JSON.stringify(params);
        if (!answers.has(key)) {
          answers.set(key, sdk.listings.query(params));
        }
        return answers.get(key);
      },
    },
  };
};

const main = async () => {
  const assumeYes = process.argv.includes('--yes') || process.argv.includes('-y');
  const freshIntent = process.argv.includes('--fresh-intent');

  const { loadEnv, createMarketplaceSdk } = require('../server/smart-search-lib/clients');
  loadEnv();

  const queries = loadGroundTruth();
  const sdk = createMarketplaceSdk();
  const deps = await prepareNewSearch({ queries, sdk, assumeYes, freshIntent });
  if (!deps) {
    console.log('Stopped. Nothing was run.');
    return;
  }

  console.log(
    `Comparing ${WEIGHT_SETS.length} weight sets over ${queries.length} queries ` +
      '(no Claude calls)...'
  );
  const startedAt = new Date().toISOString();
  const cachedSdk = queryOnce(sdk);
  const rows = await compareWeights({
    queries,
    weightSets: WEIGHT_SETS,
    searcherFor: weights => createNewSearcher({ ...deps, sdk: cachedSdk, weights }),
  });

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, buildComparisonHtml({ rows, queries, startedAt }));

  console.log(`\n${formatTable(rows)}\n`);
  const failed = rows[0].runs.filter(run => run.error).length;
  if (failed > 0) {
    console.log(`${failed} queries failed in every row (see the report), e.g. no cached intent.`);
  }
  console.log(highestLine(rows));
  console.log('Choose the weights to use. ranking.js has not been changed.');
  console.log(`Report: ${REPORT_FILE}`);
};

if (require.main === module) {
  main().catch(error => {
    console.error(`\nThe comparison could not run: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  WEIGHT_SETS,
  REPORT_FILE,
  compareWeights,
  highestPassRows,
  highestLine,
  formatTable,
  buildComparisonHtml,
  queryOnce,
};
