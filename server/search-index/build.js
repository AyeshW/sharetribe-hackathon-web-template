/**
 * Search indexer (D8, D11, D13): AI tags into listing metadata, vectors into vectors.json.
 *
 * Run by hand:
 *   NODE_ENV=development node server/search-index/build.js [--limit N]
 *     PREVIEW (default): enrich + embed, write server/search-index/preview.json.
 *     No Sharetribe writes; vectors.json is not touched.
 *   NODE_ENV=development node server/search-index/build.js [--limit N] --confirm
 *     Also write metadata { ai, aiContentHash, aiModel } to each listing (Integration API) and
 *     the vectors to server/search-index/vectors.json.
 *
 * Reads all published sell-used-products listings. A listing is skipped when its
 * metadata.aiContentHash equals its content hash and vectors.json has a vector with the same
 * hash for the current embedding model. Before more than 10 Claude calls, the run prints the
 * count and an estimated cost and waits for "yes".
 */
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { types } = require('sharetribe-flex-integration-sdk');
const { readUsageLog, costUsd } = require('../smart-search-lib/usage');
const { ENRICH_MODEL, enrichListing } = require('./enrich');
const { MODEL: EMBED_MODEL, DIM } = require('./embed');

const { UUID } = types;

const VECTORS_FILE = path.join(__dirname, 'vectors.json');
const PREVIEW_FILE = path.join(__dirname, 'preview.json');
const LISTING_TYPE = 'sell-used-products';
const IMAGE_VARIANT = 'scaled-medium';
const PAGE_SIZE = 100;
const CONFIRM_ABOVE_CALLS = 10;
// Used for the estimate until enrich calls have been logged: ~550 image + ~1500 text tokens in.
const DEFAULT_CALL_USAGE = { input_tokens: 2100, output_tokens: 400 };

const sortKeys = value =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
    ? Object.keys(value)
        .sort()
        .reduce((acc, key) => ({ ...acc, [key]: sortKeys(value[key]) }), {})
    : value;

/**
 * sha256 of title, description, price, publicData (keys sorted) and the first image id.
 */
const contentHash = (listing, imageId) => {
  const { title, description, price, publicData } = listing.attributes;
  const content = [
    title || '',
    description || '',
    price ? { amount: price.amount, currency: price.currency } : null,
    sortKeys(publicData || {}),
    imageId || null,
  ];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
};

/**
 * Text that gets embedded: title, description and the main tags.
 */
const buildEmbeddingText = (listing, tags) => {
  const { title, description } = listing.attributes;
  const list = values => (values || []).join(', ');
  return [
    title,
    description,
    tags.garmentType,
    list(tags.synonyms),
    list(tags.style),
    list(tags.season),
    tags.searchText,
  ]
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join('\n');
};

/**
 * All published sell-used-products listings with their first image's scaled-medium URL.
 *
 * @param {Object} sdk Integration SDK (listings.query)
 * @returns {Promise<Array<{ listing, imageId, imageUrl }>>}
 */
const fetchListings = async sdk => {
  const results = [];
  for (let page = 1; ; page += 1) {
    const res = await sdk.listings.query({
      states: ['published'],
      include: ['images'],
      'fields.image': [`variants.${IMAGE_VARIANT}`],
      perPage: PAGE_SIZE,
      page,
    });
    const images = (res.data.included || []).filter(i => i.type === 'image');
    res.data.data
      .filter(l => l.attributes.publicData?.listingType === LISTING_TYPE)
      .forEach(listing => {
        const imageId = listing.relationships?.images?.data?.[0]?.id?.uuid || null;
        const image = images.find(i => i.id.uuid === imageId);
        const imageUrl = image?.attributes?.variants?.[IMAGE_VARIANT]?.url || null;
        results.push({ listing, imageId, imageUrl });
      });
    if (page >= (res.data.meta?.totalPages || 1)) {
      return results;
    }
  }
};

/**
 * Empty vectors.json content, or the existing one when it was made by the current model.
 */
const usableVectors = existing =>
  existing && existing.model === EMBED_MODEL && existing.listings
    ? existing
    : { model: EMBED_MODEL, dim: DIM, listings: {} };

const isUpToDate = ({ listing, hash }, vectors) =>
  listing.attributes.metadata?.aiContentHash === hash &&
  vectors.model === EMBED_MODEL &&
  vectors.listings[listing.id.uuid]?.hash === hash;

/**
 * Average cost of logged enrich calls, or the default estimate when none are logged.
 */
const estimateCallCost = records => {
  const costs = records
    .filter(r => r.purpose === 'enrich')
    .map(r => costUsd(r.model, r.usage))
    .filter(c => c !== null);
  return costs.length
    ? costs.reduce((a, b) => a + b, 0) / costs.length
    : costUsd(ENRICH_MODEL, DEFAULT_CALL_USAGE);
};

/**
 * @param {Object} clients { integrationSdk, anthropic, createEmbedder }
 * @param {Object} options { config, vectors, confirm, limit, log, askYes, saveVectors,
 *   savePreview, usageRecords, logUsage }
 *   vectors: current vectors.json content (or null); saveVectors(vectors) is called after each
 *   listing in --confirm mode; savePreview(entries) once in preview mode
 * @returns {Promise<{ total, skipped, enriched, failed, written, stopped? }>}
 */
const runIndex = async (clients, options) => {
  const { integrationSdk, anthropic, createEmbedder } = clients;
  const { config, confirm, limit, log, askYes, saveVectors, savePreview } = options;
  const { usageRecords = [], logUsage } = options;

  const vectors = usableVectors(options.vectors);
  const all = await fetchListings(integrationSdk);
  const withHash = all.map(item => ({ ...item, hash: contentHash(item.listing, item.imageId) }));
  const outdated = withHash.filter(item => !isUpToDate(item, vectors));
  const todo = limit ? outdated.slice(0, limit) : outdated;
  const summary = {
    total: all.length,
    skipped: all.length - outdated.length,
    enriched: 0,
    failed: 0,
    written: 0,
  };

  log(
    `${all.length} published ${LISTING_TYPE} listings, ${summary.skipped} up to date, ` +
      `${outdated.length} to index${limit ? ` (limited to ${todo.length})` : ''}.`
  );
  if (todo.length === 0) {
    return summary;
  }

  if (todo.length > CONFIRM_ABOVE_CALLS) {
    const perCall = estimateCallCost(usageRecords);
    const question =
      `This run makes ${todo.length} Claude calls (${ENRICH_MODEL}), ` +
      `estimated $${(perCall * todo.length).toFixed(2)} ($${perCall.toFixed(4)} per call). ` +
      'Type yes to continue: ';
    if (!(await askYes(question))) {
      log('Stopped: no Claude calls made.');
      return { ...summary, stopped: true };
    }
  }

  const embedder = await createEmbedder();
  const preview = [];
  for (const item of todo) {
    const { listing, imageUrl, hash } = item;
    const id = listing.id.uuid;
    const label = `${id} | ${listing.attributes.title}`;

    let tags;
    let vector;
    let embeddingText;
    try {
      tags = await enrichListing(listing, imageUrl, config, anthropic, { logUsage });
      embeddingText = buildEmbeddingText(listing, tags);
      vector = await embedder.embedListing(embeddingText);
    } catch (e) {
      summary.failed += 1;
      log(`FAIL   ${label}: ${e.message}`);
      continue;
    }
    summary.enriched += 1;

    if (!confirm) {
      preview.push({
        id,
        seedKey: listing.attributes.metadata?.seedKey || null,
        title: listing.attributes.title,
        imageUrl,
        publicData: listing.attributes.publicData,
        tags,
        embeddingText,
        hash,
      });
      log(`tagged ${label}: ${tags.garmentType} [${tags.colorDetected.join(', ')}]`);
      continue;
    }

    // Metadata is merged on the top level, so seeded/seedKey and other keys are kept.
    await integrationSdk.listings.update({
      id: new UUID(id),
      metadata: { ai: tags, aiContentHash: hash, aiModel: ENRICH_MODEL },
    });
    vectors.listings[id] = { hash, vector };
    saveVectors(vectors);
    summary.written += 1;
    log(`wrote  ${label}: ${tags.garmentType}`);
  }

  if (!confirm) {
    savePreview(preview);
    log(
      `\nPREVIEW: ${preview.length} listings in ${PREVIEW_FILE}. Nothing was written to ` +
        'Sharetribe and vectors.json is unchanged. Run with --confirm to write.'
    );
  }
  log(
    `\nDone: ${summary.enriched} enriched, ${summary.failed} failed, ${summary.written} written, ` +
      `${summary.skipped} skipped.`
  );
  return summary;
};

const readJson = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

const parseLimit = argv => {
  const index = argv.indexOf('--limit');
  if (index === -1) {
    return null;
  }
  const limit = Number(argv[index + 1]);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit needs a positive whole number');
  }
  return limit;
};

const askYesOnStdin = question =>
  new Promise(resolve => {
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });

if (require.main === module) {
  const {
    loadEnv,
    createMarketplaceSdk,
    createIntegrationSdk,
    createAnthropicClient,
  } = require('../smart-search-lib/clients');
  const { loadMarketplaceConfig } = require('../smart-search-lib/config');
  const { createEmbedder } = require('./embed');
  loadEnv();

  const run = async () => {
    const config = await loadMarketplaceConfig(createMarketplaceSdk());
    await runIndex(
      {
        integrationSdk: createIntegrationSdk(),
        anthropic: createAnthropicClient(),
        createEmbedder,
      },
      {
        config,
        vectors: readJson(VECTORS_FILE),
        confirm: process.argv.includes('--confirm'),
        limit: parseLimit(process.argv),
        log: console.log,
        askYes: askYesOnStdin,
        saveVectors: vectors => writeJson(VECTORS_FILE, vectors),
        savePreview: entries => writeJson(PREVIEW_FILE, entries),
        usageRecords: readUsageLog(),
      }
    );
  };
  run().catch(e => {
    const detail = e.data?.errors?.map(err => err.title || err.code).join('; ');
    console.error(
      `STOPPED: ${e.status ? `${e.status} ${e.statusText}` : e.message}${
        detail ? ` (${detail})` : ''
      }`
    );
    process.exit(1);
  });
}

module.exports = {
  contentHash,
  buildEmbeddingText,
  fetchListings,
  usableVectors,
  isUpToDate,
  estimateCallCost,
  runIndex,
  parseLimit,
};
