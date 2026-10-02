/**
 * Static data loaded once when the server starts (D14): the marketplace config, vectors.json and
 * the embedding model. After changing Console settings or re-running the indexer, restart the
 * server.
 */
const fs = require('fs');
const path = require('path');
const { loadMarketplaceConfig } = require('../../smart-search-lib/config');
const { createMarketplaceSdk } = require('../../smart-search-lib/clients');
const { MODEL, createEmbedder } = require('../../search-index/embed');

const VECTORS_FILE = path.join(__dirname, '..', '..', 'search-index', 'vectors.json');

const emptyVectors = () => ({ model: MODEL, listings: {} });

/**
 * vectors.json content. Without the file, or when it was made by another model (D13), there are
 * no vectors and listings get a meaning score of 0.
 */
const loadVectors = (file, warn) => {
  if (!fs.existsSync(file)) {
    warn(`Smart search: ${file} not found. Run the indexer. Searching without vectors.`);
    return emptyVectors();
  }
  const vectors = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (vectors.model !== MODEL || !vectors.listings) {
    warn(`Smart search: vectors.json was made by ${vectors.model}, not ${MODEL}. Ignoring it.`);
    return emptyVectors();
  }
  return vectors;
};

/**
 * The query embedding function (with the D13 query prefix), or null when the model can't load.
 * Search then ranks without the meaning signal (EMBEDDING_SKIPPED).
 */
const loadEmbedQuery = async (loadEmbedder, warn) => {
  try {
    const embedder = await loadEmbedder();
    return embedder.embedQuery;
  } catch (e) {
    warn(`Smart search: embedding model failed to load (${e.message}). Ranking without it.`);
    return null;
  }
};

/**
 * @param {Object} options { sdk, vectorsFile, warn, loadEmbedder }; tests pass a fake
 *   loadEmbedder so the real model is never loaded
 * @returns {Promise<{ config: Object, vectors: Object, embedQuery: ?Function }>}
 */
const loadStaticData = async ({
  sdk,
  vectorsFile = VECTORS_FILE,
  warn = console.warn,
  loadEmbedder = createEmbedder,
}) => {
  const [config, embedQuery] = await Promise.all([
    loadMarketplaceConfig(sdk),
    loadEmbedQuery(loadEmbedder, warn),
  ]);
  return { config, vectors: loadVectors(vectorsFile, warn), embedQuery };
};

let loading = null;

/**
 * The static data, loaded on the first call and shared after that. If loading fails, the next
 * call tries again, so a Sharetribe hiccup at start-up doesn't break search until a restart.
 */
const getStaticData = () => {
  if (!loading) {
    loading = Promise.resolve()
      .then(() => loadStaticData({ sdk: createMarketplaceSdk() }))
      .catch(e => {
        loading = null;
        throw e;
      });
  }
  return loading;
};

module.exports = { VECTORS_FILE, loadVectors, loadStaticData, getStaticData };
