/**
 * Read-only snapshots for tests: the live listing config and every published listing.
 * Run by hand: NODE_ENV=development node seed/snapshot-fixtures.js
 *
 * Writes seed/fixtures/marketplace-config.json and seed/fixtures/existing-listings.json.
 */
const fs = require('fs');
const path = require('path');
const { loadEnv, createMarketplaceSdk } = require('../server/smart-search-lib/clients');
const { loadMarketplaceConfig } = require('../server/smart-search-lib/config');

const FIXTURES = path.join(__dirname, 'fixtures');

const writeJson = (file, data) => {
  fs.writeFileSync(path.join(FIXTURES, file), JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote seed/fixtures/${file}`);
};

// The Marketplace API returns published listings only.
const fetchAllListings = async sdk => {
  const listings = [];
  for (let page = 1; ; page++) {
    const res = await sdk.listings.query({ page, perPage: 100 });
    listings.push(...res.data.data);
    if (page >= res.data.meta.totalPages) {
      return listings;
    }
  }
};

const run = async () => {
  loadEnv();
  const sdk = createMarketplaceSdk();
  fs.mkdirSync(FIXTURES, { recursive: true });

  writeJson('marketplace-config.json', await loadMarketplaceConfig(sdk));

  const listings = (await fetchAllListings(sdk)).map(l => ({
    id: l.id.uuid,
    title: l.attributes.title,
    description: l.attributes.description,
    price: l.attributes.price
      ? { amount: l.attributes.price.amount, currency: l.attributes.price.currency }
      : null,
    publicData: l.attributes.publicData,
  }));
  writeJson('existing-listings.json', listings);
  console.log(`${listings.length} published listings`);
};

run().catch(e => {
  console.error(e.status ? `${e.status} ${e.statusText}` : e.message);
  process.exit(1);
});
