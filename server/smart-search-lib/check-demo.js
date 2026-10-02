/**
 * Demo start-up self-check. Run by hand before a demo:
 *   NODE_ENV=development node server/smart-search-lib/check-demo.js
 *
 * Prints one PASS / WARN / FAIL line per check and exits with 1 on any FAIL. Never calls Claude,
 * never downloads the embedding model and never prints secret values (env vars by name only).
 * Reads from Sharetribe (marketplace config and the live listing count), never writes.
 *
 * Checks:
 *   - the env vars the smart search server needs are set
 *   - the marketplace config loads (listing fields, categories, listing types)
 *   - vectors.json exists and was made by the current embedding model
 *   - vectors.json has as many listings as are live (WARN on a mismatch: re-run the indexer,
 *     then restart the server)
 *   - the embedding model is in the local transformers.js cache
 */
const path = require('path');
const { MODEL } = require('../search-index/embed');

const ROOT = path.join(__dirname, '..', '..');
const VECTORS_FILE = path.join(ROOT, 'server', 'search-index', 'vectors.json');
// transformers.js caches models under its own package folder; the server loads the q8 weights.
const MODEL_FILE = path.join(
  ROOT,
  'node_modules',
  '@huggingface',
  'transformers',
  '.cache',
  ...MODEL.split('/'),
  'onnx',
  'model_quantized.onnx'
);
const LISTING_TYPE = 'sell-used-products';

// What `yarn run dev` needs for smart search (CLAUDE.md, Environment variables).
const REQUIRED_ENV = [
  'REACT_APP_SHARETRIBE_SDK_CLIENT_ID',
  'SHARETRIBE_SDK_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
];

const result = (status, name, detail) => ({ status, name, detail });

/**
 * One line per required env var. Only names are reported, never values.
 *
 * @param {Object} env e.g. process.env
 */
const checkEnv = env =>
  REQUIRED_ENV.map(name =>
    (env[name] || '').trim()
      ? result('PASS', `env ${name}`, 'set')
      : result('FAIL', `env ${name}`, 'missing; set it in .env')
  );

/**
 * Is the embedding model in the local cache? (If not, the first server start would download it.)
 *
 * @param {{ existsSync: Function }} fs
 * @param {string} [file]
 */
const checkModelCached = (fs, file = MODEL_FILE) =>
  fs.existsSync(file)
    ? result('PASS', 'Embedding model cached', MODEL)
    : result('FAIL', 'Embedding model cached', `${MODEL} not found at ${file}`);

/**
 * vectors.json: exists, is readable and was made by the current model.
 *
 * @param {{ existsSync: Function, readFileSync: Function }} fs
 * @param {string} [file]
 * @returns {{ check: Object, count: ?number }} count is the number of listings with a vector
 */
const checkVectorsFile = (fs, file = VECTORS_FILE) => {
  const name = 'vectors.json';
  if (!fs.existsSync(file)) {
    return { check: result('FAIL', name, `not found at ${file}; run the indexer`), count: null };
  }
  let vectors;
  try {
    vectors = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { check: result('FAIL', name, `not valid JSON: ${e.message}`), count: null };
  }
  if (vectors.model !== MODEL || !vectors.listings) {
    const detail = `made by ${vectors.model}, not ${MODEL}; re-run the indexer`;
    return { check: result('FAIL', name, detail), count: null };
  }
  const count = Object.keys(vectors.listings).length;
  return { check: result('PASS', name, `${count} listings, ${MODEL}`), count };
};

/**
 * Compare the number of vectors with the number of live sell listings.
 */
const checkVectorCount = (vectorCount, liveCount) => {
  const name = 'Vectors match live listings';
  const detail = `${vectorCount} in vectors.json, ${liveCount} live`;
  return vectorCount === liveCount
    ? result('PASS', name, detail)
    : result('WARN', name, `${detail}; re-run the indexer, then restart the server`);
};

const errorText = e =>
  e.status ? `${e.status} ${e.statusText || ''}`.trim() : e.message || String(e);

/**
 * Run every check.
 *
 * @param {Object} deps
 * @param {Object} deps.env environment variables
 * @param {{ existsSync, readFileSync }} deps.fs file system
 * @param {() => Promise<Object>} deps.loadConfig loads the marketplace config
 * @param {() => Promise<number>} deps.countLiveListings live sell-used-products listings
 * @param {string} [deps.vectorsFile]
 * @param {string} [deps.modelFile]
 * @returns {Promise<Array<{ status: 'PASS'|'WARN'|'FAIL', name: string, detail: string }>>}
 */
const runChecks = async ({ env, fs, loadConfig, countLiveListings, vectorsFile, modelFile }) => {
  const results = checkEnv(env);

  try {
    const config = await loadConfig();
    results.push(
      result(
        'PASS',
        'Marketplace config',
        `${config.listingFields.length} listing fields, ${config.categories.length} top-level categories`
      )
    );
  } catch (e) {
    results.push(result('FAIL', 'Marketplace config', errorText(e)));
  }

  const vectors = checkVectorsFile(fs, vectorsFile);
  results.push(vectors.check);
  if (vectors.count !== null) {
    try {
      results.push(checkVectorCount(vectors.count, await countLiveListings()));
    } catch (e) {
      results.push(result('FAIL', 'Vectors match live listings', errorText(e)));
    }
  }

  results.push(checkModelCached(fs, modelFile));
  return results;
};

const formatResult = ({ status, name, detail }) => `${status.padEnd(4)} ${name}: ${detail}`;

const main = async () => {
  const fs = require('fs');
  const { loadEnv, createMarketplaceSdk } = require('./clients');
  const { loadMarketplaceConfig } = require('./config');
  loadEnv();

  // Without the client id there is no SDK; the env line above then already says FAIL.
  const sdk = () => createMarketplaceSdk();
  const results = await runChecks({
    env: process.env,
    fs,
    loadConfig: () => loadMarketplaceConfig(sdk()),
    countLiveListings: async () => {
      const res = await sdk().listings.query({ pub_listingType: LISTING_TYPE, perPage: 1 });
      return res.data.meta.totalItems;
    },
  });

  results.forEach(r => console.log(formatResult(r)));
  const failures = results.filter(r => r.status === 'FAIL').length;
  const warnings = results.filter(r => r.status === 'WARN').length;
  console.log(
    failures
      ? `\n${failures} check(s) failed. Fix them before the demo.`
      : `\nReady for the demo${warnings ? ` (${warnings} warning(s))` : ''}.`
  );
  process.exit(failures ? 1 : 0);
};

if (require.main === module) {
  main().catch(e => {
    console.error(`FAIL check-demo: ${errorText(e)}`);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_ENV,
  VECTORS_FILE,
  MODEL_FILE,
  checkEnv,
  checkModelCached,
  checkVectorsFile,
  checkVectorCount,
  runChecks,
  formatResult,
};
