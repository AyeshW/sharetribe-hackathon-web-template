/**
 * Run every eval query through the old search and the new smart search, save the results and
 * write a report a teammate can read without knowing anything about search.
 *
 *   node eval/run.js                 run it
 *   node eval/run.js --yes           don't ask before Claude API calls
 *   node eval/run.js --fresh-intent  forget the cached intents and ask Claude again
 *
 * The new search needs one Claude Haiku intent call per query. Replies are cached in
 * eval/results/intent-cache.json and reused, so only queries without a cached intent cost
 * anything (about $0.004 each). Before any call it prints the count and cost and asks.
 *
 * See eval/HOW-TO-EVALUATE.md.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { found, bestInTop3, passes, FOUND_WINDOW, TOP_WINDOW } = require('./checks');
const { loadGroundTruth } = require('./ground-truth');
const { createOldSearcher } = require('./searchers/old');
const { createNewSearcher } = require('./searchers/new');
const {
  INTENT_CACHE_FILE,
  emptyCache,
  readIntentCache,
  writeIntentCache,
  missingTexts,
  recordIntent,
} = require('./intent-cache');
const { WEIGHTS } = require('../server/api/smart-search/ranking');

const RESULTS_DIR = path.join(__dirname, 'results');
const REPORT_FILE = path.join(__dirname, 'report.html');

// A full run with the new search makes one intent call per query with Claude Haiku.
// About $0.10 for the whole run of ~25 queries (D18).
const EST_COST_PER_CLAUDE_CALL_USD = 0.004;

/** How many results of a query to show in the report. */
const TITLES_SHOWN = TOP_WINDOW;

// ---------------------------------------------------------------------------
// Running the queries
// ---------------------------------------------------------------------------

/**
 * Run one query through one search and apply the three checks.
 *
 * @param {Function} search text => Promise<Array<{id, title}>>
 * @param {{text: string, relevant: Array}} query one query from the ground truth
 * @returns {Promise<Object>} results, the checks, and an error message if the search failed
 */
const runOne = async (search, query) => {
  let results = [];
  let error = null;
  try {
    results = (await search(query.text)) || [];
  } catch (e) {
    error = e.message || String(e);
  }
  const ids = results.map(result => result.id);
  return {
    results,
    error,
    empty: !error && results.length === 0,
    found: found(ids, query.relevant),
    bestInTop3: bestInTop3(ids, query.relevant),
    passes: error ? false : passes(ids, query.relevant),
  };
};

const percent = (part, whole) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/**
 * better / worse / same, comparing the new search against the old one for one query.
 */
const compare = (oldRun, newRun) => {
  if (!newRun) {
    return null;
  }
  if (oldRun.passes !== newRun.passes) {
    return newRun.passes ? 'better' : 'worse';
  }
  if (newRun.found.found > oldRun.found.found) {
    return 'better';
  }
  if (newRun.found.found < oldRun.found.found) {
    return 'worse';
  }
  return 'same';
};

const summarizeSearcher = rows => {
  const runs = rows.map(row => row.run);
  const foundShares = runs.map(run =>
    run.found.total === 0 ? 0 : run.found.found / run.found.total
  );
  return {
    passes: runs.filter(run => run.passes).length,
    total: runs.length,
    avgFoundPercent: percent(foundShares.reduce((sum, share) => sum + share, 0), runs.length),
    empty: runs.filter(run => run.empty).length,
    errors: runs.filter(run => run.error).length,
  };
};

const byType = queries => {
  const types = [];
  queries.forEach(query => {
    let row = types.find(type => type.type === query.tests);
    if (!row) {
      row = { type: query.tests, count: 0, oldPasses: 0, newPasses: null };
      types.push(row);
    }
    row.count += 1;
    if (query.old.passes) {
      row.oldPasses += 1;
    }
    if (query.new) {
      row.newPasses = (row.newPasses || 0) + (query.new.passes ? 1 : 0);
    }
  });
  return types;
};

/**
 * The one line that answers "did it get better?".
 */
const summaryLine = run => {
  const { old: oldSummary, new: newSummary } = run.summary;
  const newPart = newSummary
    ? `New search: ${newSummary.passes} of ${newSummary.total} pass.`
    : 'New search: not built yet.';
  return `Old search: ${oldSummary.passes} of ${oldSummary.total} queries pass. ${newPart}`;
};

/**
 * Run all queries through the given searches and work out every number the report shows.
 *
 * @param {{queries: Array, oldSearch: Function, newSearch: ?Function, weights: ?Object,
 *   startedAt: string}} input weights is only recorded (the searcher already uses them)
 * @returns {Promise<Object>} the whole run, which is also what is saved as JSON
 */
const runEval = async ({
  queries,
  oldSearch,
  newSearch: newSearcher = null,
  weights = null,
  startedAt,
}) => {
  const rows = [];
  for (const query of queries) {
    const oldRun = await runOne(oldSearch, query);
    const newRun = newSearcher ? await runOne(newSearcher, query) : null;
    rows.push({
      id: query.id,
      text: query.text,
      tests: query.tests,
      relevant: query.relevant,
      old: oldRun,
      new: newRun,
      change: compare(oldRun, newRun),
    });
  }

  const run = {
    startedAt: startedAt || new Date().toISOString(),
    newSearchBuilt: Boolean(newSearcher),
    weights: newSearcher ? weights : null,
    queries: rows,
    summary: {
      old: summarizeSearcher(rows.map(row => ({ run: row.old }))),
      new: newSearcher ? summarizeSearcher(rows.map(row => ({ run: row.new }))) : null,
      byType: byType(rows),
    },
  };
  run.summaryLine = summaryLine(run);
  return run;
};

// ---------------------------------------------------------------------------
// The HTML report
// ---------------------------------------------------------------------------

const escapeHtml = value =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * "meaning 0.5 · word match 0.3 · preferences 0.2", the names used in D1.
 */
const formatWeights = weights =>
  `meaning ${weights.semantic} · word match ${weights.keyword} · preferences ${weights.preferences}`;

const resultCell = run => {
  if (!run) {
    return '<div class="cell muted">not built yet</div>';
  }
  if (run.error) {
    return `<div class="cell"><div class="verdict">⚠️ search failed</div><div class="note">${escapeHtml(
      run.error
    )}</div></div>`;
  }
  const verdict = `${run.passes ? '✅' : '❌'} Found ${run.found.found} of ${run.found.total}`;
  const titles = run.results.slice(0, TITLES_SHOWN).map(result => result.title);
  const titleList = run.empty
    ? '<div class="note">no results</div>'
    : `<ol class="titles">${titles.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ol>`;
  return `<div class="cell"><div class="verdict">${verdict}</div>${titleList}</div>`;
};

const changeCell = change => {
  if (!change) {
    return '<div class="cell muted">–</div>';
  }
  const label = { better: '▲ better', worse: '▼ worse', same: '= same' }[change];
  return `<div class="cell change ${change}">${label}</div>`;
};

const correctListings = query => {
  const items = query.relevant
    .map(
      item =>
        `<li>${escapeHtml(item.title)} <span class="grade">${
          item.grade === 2 ? 'clearly right' : 'also relevant'
        }</span></li>`
    )
    .join('');
  return `<div class="detail"><p>The listings this query should find:</p><ul>${items}</ul></div>`;
};

const typeTable = run => {
  const rows = run.summary.byType
    .map(
      type => `<tr>
        <td>${escapeHtml(type.type)}</td>
        <td>${type.count}</td>
        <td>${type.oldPasses} of ${type.count}</td>
        <td>${type.newPasses === null ? 'not built yet' : `${type.newPasses} of ${type.count}`}</td>
      </tr>`
    )
    .join('');
  return `<table class="types">
      <thead><tr><th>Kind of query</th><th>Queries</th><th>Old search passes</th><th>New search passes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};

const queryRows = run =>
  run.queries
    .map(
      query => `<details class="row${query.change === 'worse' ? ' worse-row' : ''}">
      <summary>
        <div class="cell query"><span class="qtext">${escapeHtml(
          query.text
        )}</span><span class="type">${escapeHtml(query.tests)}</span></div>
        ${resultCell(query.old)}
        ${resultCell(query.new)}
        ${changeCell(query.change)}
      </summary>
      ${correctListings(query)}
    </details>`
    )
    .join('');

/**
 * The whole report as one HTML string: plain HTML and inline CSS, no libraries.
 *
 * @param {Object} run what runEval returned
 * @returns {string} HTML
 */
const buildReportHtml = run => {
  const { old: oldSummary, new: newSummary } = run.summary;
  const newStats = newSummary
    ? `<li>New search: found on average <strong>${newSummary.avgFoundPercent}%</strong> of the correct listings, <strong>${newSummary.empty}</strong> queries with no results at all.</li>`
    : '<li>New search: not built yet.</li>';
  const weightsNote = run.weights
    ? `<p class="legend">New search ranking weights: ${escapeHtml(
        formatWeights(run.weights)
      )}. No rerank.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Search eval report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         margin: 0; padding: 24px; color: #1a1a1a; background: #fff; line-height: 1.5; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  .when { color: #666; font-size: 13px; margin: 0 0 24px; }
  .summary { font-size: 18px; font-weight: 600; background: #f3f6ff; border: 1px solid #c9d8ff;
             border-radius: 8px; padding: 16px; }
  .stats { margin: 12px 0 0; padding-left: 20px; color: #333; font-size: 14px; }
  table.types { border-collapse: collapse; font-size: 14px; }
  table.types th, table.types td { border: 1px solid #ddd; padding: 6px 12px; text-align: left; }
  table.types th { background: #f5f5f5; }
  .rows { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
  .head, details.row > summary { display: grid; grid-template-columns: 2fr 3fr 3fr 1fr;
    gap: 12px; padding: 12px; align-items: start; }
  .head { background: #f5f5f5; font-weight: 600; font-size: 13px; }
  details.row { border-top: 1px solid #eee; }
  details.row > summary { cursor: pointer; list-style: none; }
  details.row > summary::-webkit-details-marker { display: none; }
  details.row:nth-of-type(even) { background: #fafafa; }
  details.row.worse-row { background: #fdecec; }
  details.row.worse-row:hover { background: #fbdede; }
  .qtext { display: block; font-weight: 600; }
  .qtext::before { content: '▸ '; color: #888; }
  details.row[open] .qtext::before { content: '▾ '; }
  .type { display: inline-block; margin-top: 4px; font-size: 12px; color: #555;
          background: #ececec; border-radius: 10px; padding: 1px 8px; }
  .verdict { font-weight: 600; font-size: 14px; }
  .titles { margin: 4px 0 0; padding-left: 20px; font-size: 13px; color: #333; }
  .note { font-size: 13px; color: #a33; }
  .muted { color: #888; font-size: 13px; }
  .change { font-size: 13px; font-weight: 600; }
  .change.better { color: #1a7f37; }
  .change.worse { color: #b32020; }
  .change.same { color: #666; }
  .detail { padding: 0 12px 16px 24px; font-size: 13px; background: #fff; border-top: 1px dashed #ddd; }
  .detail ul { margin: 4px 0; padding-left: 20px; }
  .grade { color: #666; font-size: 12px; }
  .legend { font-size: 13px; color: #444; }
</style>
</head>
<body>
<h1>Search eval report</h1>
<p class="when">Run on ${escapeHtml(new Date(run.startedAt).toLocaleString('en-GB'))} · ${
    run.queries.length
  } test queries</p>

<p class="summary">${escapeHtml(run.summaryLine)}</p>
<ul class="stats">
  <li>Old search: found on average <strong>${
    oldSummary.avgFoundPercent
  }%</strong> of the correct listings, <strong>${
    oldSummary.empty
  }</strong> queries with no results at all.</li>
  ${newStats}
</ul>
${weightsNote}
<p class="legend">A query passes when a clearly right listing is in the first 3 results
  <em>and</em> at least half of its correct listings are in the first ${FOUND_WINDOW}.
  Click any query to see which listings it should have found.</p>

<h2>By kind of query</h2>
${typeTable(run)}

<h2>Every query</h2>
<div class="rows">
  <div class="head">
    <div>Query</div><div>Old search (top ${TITLES_SHOWN} results)</div>
    <div>New search (top ${TITLES_SHOWN} results)</div><div>Change</div>
  </div>
  ${queryRows(run)}
</div>
</body>
</html>
`;
};

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const ask = question =>
  new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });

/**
 * Print what this run will cost and, if it calls Claude, ask for a yes first.
 *
 * @param {{calls: number, assumeYes: boolean, ask: Function}} input
 * @returns {Promise<boolean>} true when the run may go ahead
 */
const confirmClaudeSpend = async ({ calls, assumeYes = false, ask: askFn = ask }) => {
  const cost = calls * EST_COST_PER_CLAUDE_CALL_USD;
  console.log(`This run makes ${calls} Claude API calls, costing about $${cost.toFixed(2)}.`);
  if (calls === 0) {
    console.log('Nothing to pay for, so no confirmation needed.');
    return true;
  }
  if (assumeYes) {
    console.log('Continuing because --yes was given.');
    return true;
  }
  const answer = await askFn('Continue? [y/N] ');
  return answer === 'y' || answer === 'yes';
};

const timestamp = date =>
  date
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('Z', '');

const formatSpend = records => {
  const { summarizeUsage } = require('../server/smart-search-lib/usage');
  const { total } = summarizeUsage(records);
  return `${total.calls} Claude calls, ${total.inputTokens} in / ${
    total.outputTokens
  } out tokens, $${total.costUsd.toFixed(4)}`;
};

/**
 * Everything the new search needs, with the intent cache filled for queries that have no entry.
 * Asks before any Claude call. Shared with eval/compare-weights.js.
 *
 * @param {{queries: Array, sdk: Object, assumeYes: boolean, freshIntent: boolean}} input
 * @returns {Promise<?Object>} deps for createNewSearcher (without weights), or null when the
 *   user said no
 */
const prepareNewSearch = async ({ queries, sdk, assumeYes = false, freshIntent = false }) => {
  const { createAnthropicClient } = require('../server/smart-search-lib/clients');
  const { readUsageLog } = require('../server/smart-search-lib/usage');
  const { MODEL_FILE } = require('../server/smart-search-lib/check-demo');
  const { loadStaticData } = require('../server/api/smart-search/startup');

  // Loading the embedder without a local copy would download it, which the eval never does.
  if (!fs.existsSync(MODEL_FILE)) {
    throw new Error(
      `The embedding model is not in the local cache (${MODEL_FILE}). The eval does not ` +
        'download it. Ask the team before downloading it.'
    );
  }

  const intentCache = freshIntent ? emptyCache() : readIntentCache();
  const missing = missingTexts(queries, intentCache);
  console.log(
    `Intent cache: ${queries.length - missing.length} of ${queries.length} queries cached ` +
      `(${path.relative(process.cwd(), INTENT_CACHE_FILE)}).`
  );
  if (!(await confirmClaudeSpend({ calls: missing.length, assumeYes }))) {
    return null;
  }

  const { config, vectors, embedQuery } = await loadStaticData({ sdk });
  if (missing.length > 0) {
    const anthropic = createAnthropicClient();
    const logBefore = readUsageLog().length;
    for (const text of missing) {
      const entry = await recordIntent({
        text,
        config,
        anthropic,
        onError: e => console.error(`  intent failed for "${text}" (not cached): ${e.message}`),
      });
      if (entry) {
        intentCache.entries[text] = entry;
      }
    }
    writeIntentCache(intentCache);
    console.log(`Spend on intents: ${formatSpend(readUsageLog().slice(logBefore))}`);
  }
  return { sdk, config, vectors, embedQuery, intentCache };
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

  console.log(`Running ${queries.length} queries through the old and the new search...`);
  const startedAt = new Date();
  const run = await runEval({
    queries,
    oldSearch: createOldSearcher(sdk),
    newSearch: createNewSearcher({ ...deps, weights: WEIGHTS }),
    weights: WEIGHTS,
    startedAt: startedAt.toISOString(),
  });

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultsFile = path.join(RESULTS_DIR, `${timestamp(startedAt)}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(run, null, 2));
  fs.writeFileSync(REPORT_FILE, buildReportHtml(run));

  console.log('');
  console.log(run.summaryLine);
  console.log(`New search weights: ${formatWeights(WEIGHTS)}`);
  if (run.summary.new.errors > 0) {
    console.log(`${run.summary.new.errors} new-search queries failed; see the report.`);
  }
  console.log(`Report: ${REPORT_FILE}`);
  console.log(`Saved results: ${resultsFile}`);
};

if (require.main === module) {
  main().catch(error => {
    console.error(`\nThe eval could not run: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  runEval,
  runOne,
  compare,
  summaryLine,
  summarizeSearcher,
  formatWeights,
  buildReportHtml,
  confirmClaudeSpend,
  prepareNewSearch,
  escapeHtml,
  percent,
  EST_COST_PER_CLAUDE_CALL_USD,
  RESULTS_DIR,
  REPORT_FILE,
};
