/**
 * Closes every listing in seed/uploaded.json (clean-up for seeded test data).
 *
 * Run by hand:
 *   NODE_ENV=development node seed/close-seeded.js            DRY RUN (default): list, no writes
 *   NODE_ENV=development node seed/close-seeded.js --confirm  close them
 *
 * With --confirm each listing is read first and closed only if its metadata says seeded: true.
 * Already closed listings are skipped. Stops at the first error.
 */
const fs = require('fs');
const path = require('path');
const { types } = require('sharetribe-flex-integration-sdk');

const UPLOADED_FILE = path.join(__dirname, 'uploaded.json');

/**
 * @param {Object} sdk Integration SDK (listings.show, listings.close)
 * @param {Object} options { uploaded: { key: listingId }, confirm, log }
 */
const runClose = async (sdk, { uploaded, confirm, log }) => {
  const entries = Object.entries(uploaded);
  let closed = 0;

  for (const [key, id] of entries) {
    if (!confirm) {
      log(`would close ${key} (${id})`);
      continue;
    }
    const listing = (await sdk.listings.show({ id: new types.UUID(id) })).data.data;
    const { metadata, state } = listing.attributes;
    if (!metadata?.seeded) {
      throw new Error(`${key} (${id}) is not a seeded listing; refusing to close it`);
    }
    if (state === 'closed') {
      log(`skip  ${key} (already closed)`);
      continue;
    }
    await sdk.listings.close({ id: new types.UUID(id) });
    closed += 1;
    log(`closed ${key} (${id})`);
  }

  log(
    confirm
      ? `\n${closed} of ${entries.length} listings closed.`
      : `\n${entries.length} listings would be closed. DRY RUN: nothing was written. Run with --confirm.`
  );
  return { closed };
};

if (require.main === module) {
  const { loadEnv, createIntegrationSdk } = require('../server/smart-search-lib/clients');
  loadEnv();

  const uploaded = fs.existsSync(UPLOADED_FILE)
    ? JSON.parse(fs.readFileSync(UPLOADED_FILE, 'utf8'))
    : {};
  runClose(createIntegrationSdk(), {
    uploaded,
    confirm: process.argv.includes('--confirm'),
    log: console.log,
  }).catch(e => {
    console.error(`STOPPED: ${e.status ? `${e.status} ${e.statusText}` : e.message}`);
    process.exit(1);
  });
}

module.exports = { runClose };
