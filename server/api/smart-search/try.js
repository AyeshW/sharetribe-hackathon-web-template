/**
 * Try the smart search endpoint by hand against the running dev API server.
 *
 *   node server/api/smart-search/try.js "<text>" [--state file.json] [--page n] [--per-page n]
 *                                                [--sort relevance|price-asc|price-desc|newest]
 *
 * Leave out the text to send only the state (a chip edit, q: null). The state file holds a
 * SearchState as JSON, e.g. the "State" printed by an earlier run.
 *
 * Needs the dev server running (yarn run dev, API on port 3500). Makes no Claude calls itself.
 *
 * Ranked mode (step ④) runs the search in-process instead, so it can print the per-signal numbers
 * that the response never carries:
 *
 *   NODE_ENV=development node server/api/smart-search/try.js --ranked ["<text>"]
 *
 * Without text it runs the five RANKED_QUERIES. Prints the top 10 with tier, score and the
 * semantic / keyword / preference signals. One Claude Haiku intent call per query (about $0.003
 * each), logged to logs/claude-usage.jsonl. Loads the local embedding model; doesn't need the dev
 * server.
 */
const fs = require('fs');
const { transit } = require('sharetribe-flex-sdk');

const URL = 'http://localhost:3500/api/smart-search';
const IMAGE = { variantPrefix: 'listing-card', aspectWidth: 1, aspectHeight: 1 };
const RANKED_QUERIES = [
  'vintage jacket for autumn',
  'black boots size 38',
  'something for a wedding',
  'warm but not wool',
  'baby winter clothes',
];
const RANKED_TOP = 10;

const parseArgs = argv => {
  const args = { q: null, state: null, page: 1, perPage: 24, sort: 'relevance', ranked: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') {
      args.state = JSON.parse(fs.readFileSync(argv[++i], 'utf8'));
    } else if (arg === '--page') {
      args.page = parseInt(argv[++i], 10);
    } else if (arg === '--per-page') {
      args.perPage = parseInt(argv[++i], 10);
    } else if (arg === '--sort') {
      args.sort = argv[++i];
    } else if (arg === '--ranked') {
      args.ranked = true;
    } else {
      args.q = arg;
    }
  }
  return args;
};

const euros = price => (price ? `€${(price.amount / 100).toFixed(2)}` : '');

const chip = f =>
  `${f.label} [${[f.mode, f.source, f.locked ? 'locked' : null].filter(Boolean).join(', ')}]`;

const print = (body, ms) => {
  const { state, results, listings, total, page, totalPages, relaxation, notices, meta } = body;
  const byId = new Map(listings.data.map(l => [l.id.uuid, l]));

  console.log(`${ms} ms (server ${meta ? meta.tookMs : '?'} ms)`);
  console.log(`Chips: ${state.filters.map(chip).join(' · ') || 'none'}`);
  console.log(`Preferences: ${state.preferences.join(', ') || 'none'}`);
  console.log(
    `Relaxation: auto ${relaxation.auto ? `dropped "${relaxation.auto.filter.label}"` : 'none'}; ` +
      `suggestions ${relaxation.suggestions
        .map(s => `${s.extra} more without "${s.label}"`)
        .join(', ') || 'none'}`
  );
  console.log(`Notices: ${notices.map(n => n.code).join(', ') || 'none'}`);
  console.log(
    `Results: page ${page} of ${totalPages}, ${results.length} shown, ` +
      `${total.best} best + ${total.related} related in total`
  );
  results.forEach((r, i) => {
    const attributes = byId.get(r.id.uuid).attributes;
    const reason = r.reason ? `  "${r.reason}"` : '';
    console.log(
      `  ${String(i + 1).padStart(2)}. [${r.tier}] ${attributes.title}  ` +
        `${euros(attributes.price)}${reason}`
    );
  });
  console.log(`Images and users included: ${listings.included.length}`);
  console.log(`State (save it to a file to send back with --state):\n${JSON.stringify(state)}`);
};

const fixed = n => n.toFixed(2).padStart(5);

const printRanked = (q, body, signals) => {
  const { state, results, listings, meta } = body;
  const byId = new Map(listings.data.map(l => [l.id.uuid, l]));
  console.log(`\n"${q}"  (${meta.tookMs} ms, warnings: ${meta.warnings.join(', ') || 'none'})`);
  console.log(`  Chips: ${state.filters.map(chip).join(' · ') || 'none'}`);
  console.log(`  Preferences: ${state.preferences.join(', ') || 'none'}`);
  console.log(`  Terms: ${state.terms.join(', ') || 'none'}`);
  console.log('   #  tier     score   sem    kw  pref  title');
  results.forEach((r, i) => {
    const id = r.id.uuid;
    const s = signals.get(id);
    console.log(
      `  ${String(i + 1).padStart(2)}  ${r.tier.padEnd(7)}  ${fixed(s.score)} ${fixed(
        s.semantic
      )} ${fixed(s.keyword)} ${fixed(s.preferences)}  ${byId.get(id).attributes.title}`
    );
  });
};

const runRanked = async q => {
  const {
    loadEnv,
    createMarketplaceSdk,
    createAnthropicClient,
  } = require('../../smart-search-lib/clients');
  const { readUsageLog, summarizeUsage } = require('../../smart-search-lib/usage');
  const { loadStaticData } = require('./startup');
  const { runSearch } = require('./search');
  loadEnv();

  const queries = q ? [q] : RANKED_QUERIES;
  console.log(
    `${queries.length} queries in-process: ${queries.length} Claude Haiku intent calls, ` +
      `about $${(queries.length * 0.003).toFixed(3)}.`
  );
  const sdk = createMarketplaceSdk();
  const { config, vectors, embedQuery } = await loadStaticData({ sdk });
  const anthropic = createAnthropicClient();
  const logBefore = readUsageLog().length;

  for (const text of queries) {
    let ranking = null;
    const body = await runSearch(
      { q: text, perPage: RANKED_TOP, image: IMAGE },
      {
        sdk,
        config,
        vectors,
        embedQuery,
        anthropic,
        onIntentError: e => console.error(`  intent failed: ${e.message}`),
        onEmbedError: e => console.error(`  embedding failed: ${e.message}`),
        onRanking: r => (ranking = r),
      }
    );
    const signals = new Map(
      [...ranking.signals].map(([id, s]) => [id, { ...s, score: ranking.scores.get(id) }])
    );
    printRanked(text, body, signals);
  }

  const { total } = summarizeUsage(readUsageLog().slice(logBefore));
  console.log(
    `\nSpend this run: ${total.calls} calls, ${total.inputTokens} in / ${total.outputTokens} out ` +
      `tokens, $${total.costUsd.toFixed(4)}`
  );
};

const main = async () => {
  const { q, state, page, perPage, sort, ranked } = parseArgs(process.argv.slice(2));
  if (ranked) {
    return runRanked(q);
  }
  const body = { q, state, page, perPage, sort, image: IMAGE };
  console.log(`POST ${URL}  q=${JSON.stringify(q)}  state=${state ? 'from file' : 'null'}`);

  const started = Date.now();
  const response = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/transit+json', Accept: 'application/transit+json' },
    body: transit.write(body),
  });
  const text = await response.text();
  const ms = Date.now() - started;

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${text}`);
    process.exit(1);
  }
  print(transit.read(text), ms);
};

main().catch(e => {
  const refused = e.cause && e.cause.code === 'ECONNREFUSED';
  console.error(refused ? `Can't reach ${URL}. Is "yarn run dev" running?` : e);
  process.exit(1);
});
