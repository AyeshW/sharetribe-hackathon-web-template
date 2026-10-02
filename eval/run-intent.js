/**
 * Run the 20 intent cases (eval/intent-cases.json) live against Claude Haiku and print a plain
 * table: case, expected, got, ✅/❌, and "X of 20 correct".
 *
 *   node eval/run-intent.js          asks before making the 20 Claude calls
 *   node eval/run-intent.js --yes    no question
 *
 * Costs real money: 20 calls to claude-haiku-4-5, about $0.10. Every call is logged to
 * logs/claude-usage.jsonl (purpose "intent"). Reads the marketplace config from Sharetribe
 * (read-only). Not part of yarn test-server.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const cases = require('./intent-cases.json').cases;
const { parseIntent, buildFilter } = require('../server/api/smart-search/intent');
const { mergeIntent } = require('../server/api/smart-search/state');

const EST_COST_USD = 0.1;
const RESULTS_DIR = path.join(__dirname, 'results');

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const asSet = value => JSON.stringify([...value].sort());

/**
 * A scalar expectation matches an equal value or a list containing it; a list expectation must
 * match the same set of values.
 */
const valueMatches = (expected, got) => {
  if (Array.isArray(expected)) {
    return Array.isArray(got) && asSet(expected) === asSet(got);
  }
  return Array.isArray(got) ? got.includes(expected) : sameValue(expected, got);
};

/**
 * The previous state of a case as a full SearchState (labels, modes and ops filled in).
 */
const expandState = (previous, config) =>
  previous && {
    q: previous.q,
    filters: previous.filters.map(f =>
      buildFilter(
        { key: f.key, op: f.op || (f.key === 'price' ? 'range' : 'eq'), value: f.value },
        config,
        {
          source: f.source || 'inferred',
        }
      )
    ),
    preferences: previous.preferences || [],
    removed: previous.removed || [],
    similarTo: null,
    terms: [],
  };

/**
 * Compare what came back with what the case expects.
 *
 * @param {Object} expect the case's expectations
 * @param {{ intent: Object, state: Object, notices: Array }} got intent and merged state
 * @returns {string[]} what went wrong; empty when the case passes
 */
const checkCase = (expect, got) => {
  const problems = [];
  if (expect.mode && got.intent.mode !== expect.mode) {
    problems.push(`mode ${got.intent.mode}, wanted ${expect.mode}`);
  }
  if (expect.priceIntent && got.intent.priceIntent !== expect.priceIntent) {
    problems.push(`priceIntent ${got.intent.priceIntent}, wanted ${expect.priceIntent}`);
  }
  (expect.filters || []).forEach(({ key, value }) => {
    const found = got.state.filters.find(f => f.key === key);
    if (!found || !valueMatches(value, found.value)) {
      problems.push(`missing ${key}=${JSON.stringify(value)}`);
    }
  });
  (expect.absent || []).forEach(key => {
    if (got.state.filters.some(f => f.key === key)) {
      problems.push(`unexpected ${key}`);
    }
  });
  (expect.removed || []).forEach(key => {
    if (!got.state.removed.includes(key)) {
      problems.push(`${key} not in removed`);
    }
  });
  (expect.notices || []).forEach(code => {
    if (!got.notices.some(n => n.code === code)) {
      problems.push(`no ${code} notice`);
    }
  });
  return problems;
};

const describeExpected = ({
  mode,
  priceIntent,
  filters = [],
  absent = [],
  removed = [],
  notices = [],
}) =>
  [
    mode,
    priceIntent && `priceIntent=${priceIntent}`,
    ...filters.map(f => `${f.key}=${JSON.stringify(f.value)}`),
    ...absent.map(k => `no ${k}`),
    ...removed.map(k => `removed ${k}`),
    ...notices,
  ]
    .filter(Boolean)
    .join(', ');

const describeGot = ({ intent, state, notices }, warnings) =>
  [
    intent.mode,
    intent.priceIntent === 'cheaper' && 'priceIntent=cheaper',
    ...state.filters.map(
      f => `${f.key}=${JSON.stringify(f.value)}${f.mode === 'soft' ? ' (soft)' : ''}`
    ),
    state.removed.length > 0 && `removed ${state.removed.join('/')}`,
    ...notices.map(n => n.code),
    ...warnings,
  ]
    .filter(Boolean)
    .join(', ');

/**
 * Run one case: intent call, then the merge rules. Returns what the table needs.
 */
const runCase = async (testCase, { config, anthropic }) => {
  const previous = expandState(testCase.previousState, config);
  let error = null;
  const startedAt = Date.now();
  const { intent, warnings } = await parseIntent({
    q: testCase.text,
    state: previous,
    config,
    anthropic,
    onError: e => {
      error = e.message;
      console.error(`  case ${testCase.id}: ${e.message}`);
    },
  });
  const tookMs = Date.now() - startedAt;
  const { state, notices } = mergeIntent({ q: testCase.text, state: previous, intent });
  const got = { intent, state, notices };
  const problems = checkCase(testCase.expect, got);
  return {
    id: testCase.id,
    text: testCase.text,
    expected: describeExpected(testCase.expect),
    got: describeGot(got, warnings),
    problems,
    ok: problems.length === 0,
    error,
    tookMs,
    intent,
    state,
    notices,
  };
};

const formatTable = rows =>
  rows
    .map(
      r =>
        `${r.ok ? '✅' : '❌'} ${String(r.id).padStart(2)}. ${r.text}${
          r.previousNote ? ` (after "${r.previousNote}")` : ''
        }\n      expected: ${r.expected}\n      got:      ${r.got}${
          r.ok ? '' : `\n      problems: ${r.problems.join('; ')}`
        }${r.error ? `\n      error:    ${r.error}` : ''}`
    )
    .join('\n');

const askYes = question =>
  new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });

const main = async () => {
  const {
    loadEnv,
    createMarketplaceSdk,
    createAnthropicClient,
  } = require('../server/smart-search-lib/clients');
  const { loadMarketplaceConfig } = require('../server/smart-search-lib/config');
  const { readUsageLog, summarizeUsage } = require('../server/smart-search-lib/usage');
  loadEnv();

  console.log(
    `${cases.length} Claude calls (claude-haiku-4-5), about $${EST_COST_USD.toFixed(2)}.`
  );
  if (!process.argv.includes('--yes') && !(await askYes('Type "yes" to run them: '))) {
    console.log('Not run.');
    return;
  }

  const anthropic = createAnthropicClient();
  const config = await loadMarketplaceConfig(createMarketplaceSdk());
  const logBefore = readUsageLog().length;

  const rows = [];
  for (const testCase of cases) {
    const row = await runCase(testCase, { config, anthropic });
    row.previousNote = testCase.previousState && testCase.previousState.q;
    rows.push(row);
  }

  console.log(`\n${formatTable(rows)}\n`);
  console.log(`${rows.filter(r => r.ok).length} of ${rows.length} correct`);

  const { total } = summarizeUsage(readUsageLog().slice(logBefore));
  console.log(
    `Spend this run: ${total.calls} calls, ${total.inputTokens} in / ${
      total.outputTokens
    } out tokens, $${total.costUsd.toFixed(4)}`
  );

  const file = path.join(
    RESULTS_DIR,
    `intent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { correct: rows.filter(r => r.ok).length, total: rows.length, spend: total, rows },
      null,
      2
    )
  );
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
};

if (require.main === module) {
  main().catch(e => {
    console.error(`STOPPED: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { valueMatches, expandState, checkCase, runCase };
