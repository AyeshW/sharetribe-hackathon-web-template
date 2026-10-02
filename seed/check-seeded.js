/**
 * Read-only check of the seeded listings through the public Marketplace API.
 * Run by hand: NODE_ENV=development node seed/check-seeded.js
 *
 * For every key in seed/uploaded.json: the listing is published (the Marketplace API returns only
 * published listings), has the expected title, and has one image when the plan has a photo (none
 * otherwise). Prints a summary; exits with 1 on any problem.
 */
const fs = require('fs');
const path = require('path');

const PLAN_FILE = path.join(__dirname, 'plan.json');
const UPLOADED_FILE = path.join(__dirname, 'uploaded.json');
const PAGE_SIZE = 100;

/**
 * @param {Object} sdk Marketplace SDK (listings.query)
 * @param {Object} options { plan, uploaded: { key: listingId } }
 * @returns {Promise<{ checked: number, problems: string[] }>}
 */
const checkSeeded = async (sdk, { plan, uploaded }) => {
  const entries = Object.entries(uploaded);
  const found = {};
  for (let i = 0; i < entries.length; i += PAGE_SIZE) {
    const ids = entries.slice(i, i + PAGE_SIZE).map(([, id]) => id);
    const res = await sdk.listings.query({ ids, include: ['images'], perPage: PAGE_SIZE });
    res.data.data.forEach(l => (found[l.id.uuid] = l));
  }

  const problems = [];
  entries.forEach(([key, id]) => {
    const planned = plan.listings.find(l => l.key === key);
    const listing = found[id];
    if (!planned) {
      return problems.push(`${key}: not in plan.json`);
    }
    if (!listing) {
      return problems.push(`${key}: ${id} is not published (not returned by the Marketplace API)`);
    }
    if (listing.attributes.title !== planned.title) {
      problems.push(`${key}: title is "${listing.attributes.title}", expected "${planned.title}"`);
    }
    const images = listing.relationships?.images?.data?.length || 0;
    const expected = planned.image ? 1 : 0;
    if (images !== expected) {
      problems.push(`${key}: ${images} images, expected ${expected}`);
    }
  });
  plan.listings
    .filter(l => !uploaded[l.key])
    .forEach(l => problems.push(`${l.key}: not uploaded yet`));

  return { checked: entries.length, problems };
};

if (require.main === module) {
  const { loadEnv, createMarketplaceSdk } = require('../server/smart-search-lib/clients');
  loadEnv();

  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const uploaded = fs.existsSync(UPLOADED_FILE)
    ? JSON.parse(fs.readFileSync(UPLOADED_FILE, 'utf8'))
    : {};
  checkSeeded(createMarketplaceSdk(), { plan, uploaded })
    .then(({ checked, problems }) => {
      problems.forEach(p => console.log(`FAIL ${p}`));
      const withPhoto = plan.listings.filter(l => l.image && uploaded[l.key]).length;
      console.log(
        `\nChecked ${checked} of ${plan.listings.length} planned listings ` +
          `(${withPhoto} with photo): ${problems.length ? `${problems.length} problems` : 'all OK'}`
      );
      process.exit(problems.length ? 1 : 0);
    })
    .catch(e => {
      console.error(e.status ? `${e.status} ${e.statusText}` : e.message);
      process.exit(1);
    });
}

module.exports = { checkSeeded };
