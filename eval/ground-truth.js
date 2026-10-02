/**
 * The eval's correct answers: every query from seed/plan.json with its correct listings
 * resolved to real Sharetribe listing ids.
 *
 * A query's `relevant` entries use refs:
 *   "seed:<key>"       a listing the seeder created; the id comes from seed/uploaded.json
 *   "existing:<uuid>"  a listing that was already on the marketplace; the uuid is the id
 *
 * No network and no Sharetribe calls: everything is read from files on disk.
 */
const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, '..', 'seed');
const PLAN_FILE = path.join(SEED_DIR, 'plan.json');
const UPLOADED_FILE = path.join(SEED_DIR, 'uploaded.json');
const EXISTING_LISTINGS_FILE = path.join(SEED_DIR, 'fixtures', 'existing-listings.json');

const readJson = (file, what) => {
  if (!fs.existsSync(file)) {
    throw new Error(`${what} not found at ${file}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${what} at ${file} is not valid JSON: ${e.message}`);
  }
};

const idOf = value => {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    return value.id || value.listingId || value.uuid || null;
  }
  return null;
};

/**
 * Seed key -> { id, title } from seed/uploaded.json, whatever shape the seeder wrote.
 *
 * Accepted shapes (the seeder is written in a separate phase):
 *   { "listings": [ { "key": "...", "id": "...", "title": "..." } ] }  (or the array on its own)
 *   { "listings": { "<key>": "<id>" } }                                (or the map on its own)
 *   { "listings": { "<key>": { "id": "...", "title": "..." } } }
 *
 * @param {Object|Array} uploaded parsed seed/uploaded.json
 * @returns {Map<string, {id: string, title: ?string}>}
 */
const seededListingsByKey = uploaded => {
  const source = Array.isArray(uploaded) ? uploaded : uploaded?.listings || uploaded;
  const entries = Array.isArray(source) ? source : Object.entries(source || {});
  const byKey = new Map();

  entries.forEach(entry => {
    const [key, value] = Array.isArray(entry) ? entry : [entry?.key, entry];
    const id = idOf(value);
    if (key && id) {
      byKey.set(key, { id, title: value?.title || null });
    }
  });

  if (byKey.size === 0) {
    throw new Error(
      `seed/uploaded.json has no listing ids in it. The eval expects the seeder to record ` +
        `which listing each seed key became, for example ` +
        `{ "listings": { "white-tshirt": { "id": "<uuid>", "title": "White t-shirt" } } }.`
    );
  }
  return byKey;
};

/**
 * Resolve one "seed:<key>" or "existing:<uuid>" ref to a listing id and a title.
 *
 * @param {string} ref the ref from plan.json
 * @param {{seeded: Map, planTitles: Map, existingTitles: Map, queryId: string}} context
 * @returns {{ref: string, id: string, title: string}}
 */
const resolveRef = (ref, { seeded, planTitles, existingTitles, queryId }) => {
  const where = queryId ? `Query ${queryId} in seed/plan.json` : 'seed/plan.json';

  if (typeof ref !== 'string' || !ref.includes(':')) {
    throw new Error(
      `${where} has the ref ${JSON.stringify(ref)}, which is not "seed:<key>" or "existing:<uuid>".`
    );
  }

  const separator = ref.indexOf(':');
  const kind = ref.slice(0, separator);
  const value = ref.slice(separator + 1).trim();

  if (kind === 'existing') {
    if (!value) {
      throw new Error(`${where} has the ref "${ref}" with no listing id after "existing:".`);
    }
    return { ref, id: value, title: existingTitles.get(value) || value };
  }

  if (kind === 'seed') {
    const uploadedListing = seeded.get(value);
    if (!uploadedListing) {
      throw new Error(
        `${where} expects the seeded listing "${value}", but seed/uploaded.json has no id for ` +
          `that key. Run the seeder so every planned listing is uploaded, then run the eval again.`
      );
    }
    return {
      ref,
      id: uploadedListing.id,
      title: planTitles.get(value) || uploadedListing.title || value,
    };
  }

  throw new Error(`${where} has the ref "${ref}". Refs must start with "seed:" or "existing:".`);
};

/**
 * Build the list of eval queries with their correct listings resolved to ids.
 *
 * @param {{plan: Object, uploaded: Object, existingListings: Array}} input parsed files
 * @returns {Array<{id, text, tests, relevant: Array<{ref, id, title, grade}>}>}
 */
const buildGroundTruth = ({ plan, uploaded, existingListings = [] }) => {
  const seeded = seededListingsByKey(uploaded);
  const planTitles = new Map((plan?.listings || []).map(l => [l.key, l.title]));
  const existingTitles = new Map((existingListings || []).map(l => [l.id, l.title]));
  const queries = plan?.queries || [];

  if (queries.length === 0) {
    throw new Error('seed/plan.json has no queries, so there is nothing to evaluate.');
  }

  return queries.map(query => ({
    id: query.id,
    text: query.text,
    tests: query.tests || 'other',
    relevant: (query.relevant || []).map(item => ({
      ...resolveRef(item.ref, { seeded, planTitles, existingTitles, queryId: query.id }),
      grade: item.grade,
    })),
  }));
};

/**
 * Read the plan, the seeder's output and the existing-listing titles from disk.
 *
 * @param {{planFile, uploadedFile, existingListingsFile}} [files] overrides, used by tests
 * @returns {Array} the same list buildGroundTruth returns
 */
const loadGroundTruth = ({
  planFile = PLAN_FILE,
  uploadedFile = UPLOADED_FILE,
  existingListingsFile = EXISTING_LISTINGS_FILE,
} = {}) => {
  const plan = readJson(planFile, 'seed/plan.json');
  if (!fs.existsSync(uploadedFile)) {
    throw new Error(
      `seed/uploaded.json not found at ${uploadedFile}. The eval needs it to know which ` +
        `listing each planned seed listing became. Run the seeder first.`
    );
  }
  const uploaded = readJson(uploadedFile, 'seed/uploaded.json');
  // Only used for nicer titles in the report; missing is fine.
  const existingListings = fs.existsSync(existingListingsFile)
    ? readJson(existingListingsFile, 'seed/fixtures/existing-listings.json')
    : [];

  return buildGroundTruth({ plan, uploaded, existingListings });
};

module.exports = {
  loadGroundTruth,
  buildGroundTruth,
  seededListingsByKey,
  resolveRef,
  PLAN_FILE,
  UPLOADED_FILE,
  EXISTING_LISTINGS_FILE,
};
