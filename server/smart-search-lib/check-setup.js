/**
 * Checks that every service smart search needs is reachable with the keys in .env.
 * Run by hand: NODE_ENV=development node server/smart-search-lib/check-setup.js
 *
 * Prints one OK/FAIL line per check and never prints secrets. Exits with 1 on any failure.
 * No Claude messages are sent (the models list is free).
 */
const { types } = require('sharetribe-flex-integration-sdk');
const {
  loadEnv,
  createMarketplaceSdk,
  createIntegrationSdk,
  createAnthropicClient,
  getPixabayApiKey,
  getSeedAuthorIds,
} = require('./clients');
const { loadMarketplaceConfig } = require('./config');

const REQUIRED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5-5'];

let failures = 0;

// SDK errors carry status/statusText; other errors only a message. Neither contains secrets.
const errorText = e =>
  e.status ? `${e.status} ${e.statusText || ''}`.trim() : e.message || String(e);

const check = async (name, fn) => {
  try {
    console.log(`OK   ${name}: ${await fn()}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${name}: ${errorText(e)}`);
  }
};

const run = async () => {
  loadEnv();

  await check('Marketplace API', async () => {
    const res = await createMarketplaceSdk().listings.query({ perPage: 1 });
    return `${res.data.meta.totalItems} published listings`;
  });

  await check('Asset Delivery API', async () => {
    const config = await loadMarketplaceConfig(createMarketplaceSdk());
    return `${config.listingFields.length} listing fields, ${config.categories.length} top-level categories`;
  });

  let integrationSdk = null;
  await check('Integration API', async () => {
    integrationSdk = createIntegrationSdk();
    const res = await integrationSdk.listings.query({ perPage: 1 });
    return `${res.data.meta.totalItems} listings (all states)`;
  });

  let authorIds = [];
  await check('SEED_AUTHOR_IDS', async () => {
    authorIds = getSeedAuthorIds();
    return `${authorIds.length} ids`;
  });
  for (const id of integrationSdk ? authorIds : []) {
    await check(`Seed author ${id}`, async () => {
      const res = await integrationSdk.users.show({ id: new types.UUID(id) });
      return res.data.data.attributes.profile.displayName;
    });
  }

  await check('Claude API', async () => {
    const ids = [];
    for await (const model of createAnthropicClient().models.list()) {
      ids.push(model.id);
    }
    const found = REQUIRED_MODELS.map(alias => ({
      alias,
      id: ids.find(id => id === alias || id.startsWith(`${alias}-`)),
    }));
    const missing = found.filter(m => !m.id).map(m => m.alias);
    if (missing.length) {
      throw new Error(`model not available: ${missing.join(', ')}`);
    }
    return `${ids.length} models; ${found.map(m => m.id).join(', ')}`;
  });

  await check('Pixabay API', async () => {
    const params = new URLSearchParams({ key: getPixabayApiKey(), q: 'jacket', per_page: '3' });
    const res = await fetch(`https://pixabay.com/api/?${params}`);
    if (!res.ok) {
      // Pixabay's error body is a short message like "[ERROR 400] Invalid or missing API key".
      throw new Error(`${res.status} ${(await res.text()).slice(0, 100)}`);
    }
    const body = await res.json();
    return `${body.totalHits} hits for "jacket"`;
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
};

run();
