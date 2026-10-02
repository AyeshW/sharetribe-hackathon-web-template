/**
 * Uploads the planned seed listings to Sharetribe with the Integration API (D9, D12).
 *
 * Run by hand:
 *   NODE_ENV=development node seed/upload.js            DRY RUN (default): validate, print, no writes
 *   NODE_ENV=development node seed/upload.js --confirm  upload for real
 *
 * Per listing (--confirm): upload the image (if any), create a published listing owned by
 * SEED_AUTHOR_IDS[author] with metadata { seeded: true, seedKey }, then set stock to 1.
 * seed/uploaded.json (key -> listing id) is written after each success; keys already there are
 * skipped, and the run stops at the first error so progress is kept.
 */
const fs = require('fs');
const path = require('path');
const { types } = require('sharetribe-flex-integration-sdk');
const { validatePlan } = require('./validate');

const { UUID, LatLng, Money } = types;

const PLAN_FILE = path.join(__dirname, 'plan.json');
const UPLOADED_FILE = path.join(__dirname, 'uploaded.json');
const ROOT = path.join(__dirname, '..');
const SHIPPING_PRICE_CENTS = 500;

// One area per seed author, like real sellers. Shape copied from existing listings.
const LOCATIONS = [
  [
    { address: 'Fredrikinkatu 22, 00120 Helsinki, Finland', lat: 60.1636, lng: 24.9367 },
    { address: 'Hämeentie 31, 00500 Helsinki, Finland', lat: 60.1858, lng: 24.9608 },
    { address: 'Mannerheimintie 80, 00250 Helsinki, Finland', lat: 60.1903, lng: 24.9137 },
  ],
  [
    { address: 'Tapiontori 3, 02100 Espoo, Finland', lat: 60.1754, lng: 24.8059 },
    { address: 'Leppävaarankatu 3, 02600 Espoo, Finland', lat: 60.2189, lng: 24.8126 },
    { address: 'Piispansilta 11, 02230 Espoo, Finland', lat: 60.1614, lng: 24.7383 },
  ],
  [
    { address: 'Tikkuraitti 11, 01300 Vantaa, Finland', lat: 60.2925, lng: 25.0383 },
    { address: 'Myyrmäenraitti 2, 01600 Vantaa, Finland', lat: 60.2615, lng: 24.8544 },
    { address: 'Vantaanportinkatu 3, 01510 Vantaa, Finland', lat: 60.2915, lng: 24.9625 },
  ],
];

const locationFor = (listing, index) => {
  const area = LOCATIONS[listing.author % LOCATIONS.length];
  return area[index % area.length];
};

/**
 * Body params for integrationSdk.listings.create.
 */
const buildCreateParams = (listing, { authorId, location, imageId }) => ({
  authorId: new UUID(authorId),
  state: 'published',
  title: listing.title,
  description: listing.description,
  geolocation: new LatLng(location.lat, location.lng),
  price: new Money(Math.round(listing.priceEur * 100), 'EUR'),
  publicData: {
    ...listing.publicData,
    listingType: 'sell-used-products',
    transactionProcessAlias: 'default-purchase/release-1',
    unitType: 'item',
    location: { address: location.address, building: '' },
    pickupEnabled: true,
    shippingEnabled: true,
    shippingPriceInSubunitsOneItem: SHIPPING_PRICE_CENTS,
  },
  metadata: { seeded: true, seedKey: listing.key },
  ...(imageId ? { images: [imageId] } : {}),
});

const categoryOf = l => l.publicData.categoryLevel2 || l.publicData.categoryLevel1;

// All checks that must pass before anything is uploaded.
const planErrors = (plan, config, authorIds, root) => {
  const errors = Object.entries(validatePlan(plan, config)).flatMap(([key, errs]) =>
    errs.map(e => `${key}: ${e}`)
  );
  plan.listings.forEach(l => {
    if (!Number.isInteger(l.author) || l.author < 0 || l.author >= authorIds.length) {
      errors.push(
        `${l.key}: author ${l.author} has no entry in SEED_AUTHOR_IDS (${authorIds.length})`
      );
    }
    if (l.image && !fs.existsSync(path.join(root, l.image.file))) {
      errors.push(`${l.key}: image file ${l.image.file} not found`);
    }
  });
  return errors;
};

/**
 * @param {Object} sdk Integration SDK (images.upload, listings.create, stock.compareAndSet)
 * @param {Object} options { plan, config, authorIds, uploaded, saveUploaded, confirm, root, log }
 *   uploaded: { key: listingId } of earlier runs; saveUploaded(uploaded) is called after each success
 * @returns {Promise<{ created: number, skipped: number }>}
 */
const runUpload = async (sdk, options) => {
  const { plan, config, authorIds, uploaded, saveUploaded, confirm, root = ROOT, log } = options;

  const errors = planErrors(plan, config, authorIds, root);
  if (errors.length) {
    errors.forEach(e => log(`INVALID ${e}`));
    throw new Error(`${errors.length} validation errors; nothing uploaded`);
  }

  let created = 0;
  let skipped = 0;
  for (const [index, listing] of plan.listings.entries()) {
    const line = `${listing.key} | ${listing.title} | €${listing.priceEur} | ${categoryOf(
      listing
    )} | author ${listing.author}${listing.image ? '' : ' | no photo'}`;

    if (uploaded[listing.key]) {
      skipped += 1;
      log(`skip   ${line} (uploaded as ${uploaded[listing.key]})`);
      continue;
    }
    if (!confirm) {
      log(`would  ${line}`);
      continue;
    }

    let imageId = null;
    if (listing.image) {
      const res = await sdk.images.upload({ image: path.join(root, listing.image.file) });
      imageId = res.data.data.id;
    }
    const params = buildCreateParams(listing, {
      authorId: authorIds[listing.author],
      location: locationFor(listing, index),
      imageId,
    });
    const res = await sdk.listings.create(params);
    const listingId = res.data.data.id;
    await sdk.stock.compareAndSet({ listingId, oldTotal: null, newTotal: 1 });

    uploaded[listing.key] = listingId.uuid;
    saveUploaded(uploaded);
    created += 1;
    log(`done   ${line} -> ${listingId.uuid}`);
  }

  const todo = plan.listings.length - skipped;
  const byAuthor = plan.listings.reduce(
    (acc, l) => ((acc[l.author] = (acc[l.author] || 0) + 1), acc),
    {}
  );
  log(
    `\n${plan.listings.length} listings (${
      plan.listings.filter(l => l.image).length
    } with photo), ` +
      `${skipped} already uploaded, ${
        confirm ? `${created} created` : `${todo} would be created`
      }. ` +
      `By author: ${Object.entries(byAuthor)
        .map(([a, n]) => `${a}: ${n}`)
        .join(', ')}.`
  );
  if (!confirm) {
    log('DRY RUN: nothing was written. Run with --confirm to upload.');
  }
  return { created, skipped };
};

const readUploaded = () =>
  fs.existsSync(UPLOADED_FILE) ? JSON.parse(fs.readFileSync(UPLOADED_FILE, 'utf8')) : {};

const writeUploaded = uploaded =>
  fs.writeFileSync(UPLOADED_FILE, JSON.stringify(uploaded, null, 2) + '\n');

if (require.main === module) {
  const {
    loadEnv,
    createMarketplaceSdk,
    createIntegrationSdk,
    getSeedAuthorIds,
  } = require('../server/smart-search-lib/clients');
  const { loadMarketplaceConfig } = require('../server/smart-search-lib/config');
  loadEnv();

  const confirm = process.argv.includes('--confirm');
  const run = async () => {
    const config = await loadMarketplaceConfig(createMarketplaceSdk());
    await runUpload(createIntegrationSdk(), {
      plan: JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')),
      config,
      authorIds: getSeedAuthorIds(),
      uploaded: readUploaded(),
      saveUploaded: writeUploaded,
      confirm,
      log: console.log,
    });
  };
  run().catch(e => {
    const detail = e.data?.errors?.map(err => err.title || err.code).join('; ');
    console.error(
      `STOPPED: ${e.status ? `${e.status} ${e.statusText}` : e.message}${
        detail ? ` (${detail})` : ''
      }`
    );
    console.error('Progress so far is in seed/uploaded.json. Fix the problem and run again.');
    process.exit(1);
  });
}

module.exports = { runUpload, buildCreateParams, locationFor, LOCATIONS };
