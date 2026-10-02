/**
 * Downloads up to 3 Pixabay photo candidates per planned listing (D10).
 *
 * Run by hand:
 *   NODE_ENV=development node seed/fetch-photos.js                all keys without candidates
 *   NODE_ENV=development node seed/fetch-photos.js --key <k>[,<k>] re-fetch these keys (replaces them)
 *   NODE_ENV=development node seed/fetch-photos.js --all          re-fetch every key
 *   add --any-category to search outside Pixabay's fashion category
 *
 * Writes seed/images/candidates/<key>/<n>.jpg and <n>.json ({ pixabayUser, pixabayUrl, ... }).
 * Keys that already have candidates are skipped. One search per key (fashion category) returns up
 * to 50 hits; the 3 whose tags best match the search words are downloaded, preferring photos without
 * people. Searches are spaced to stay under Pixabay's 100 requests per minute. The API key is never
 * printed.
 */
const fs = require('fs');
const path = require('path');
const { loadEnv, getPixabayApiKey } = require('../server/smart-search-lib/clients');

const PLAN_FILE = path.join(__dirname, 'plan.json');
const CANDIDATES_DIR = path.join(__dirname, 'images', 'candidates');
const MAX_CANDIDATES = 3;
const HITS_PER_SEARCH = 50;
const MS_BETWEEN_SEARCHES = 700; // ~85 searches per minute
const PEOPLE_TAGS = [
  'portrait',
  'face',
  'woman',
  'man',
  'girl',
  'boy',
  'child',
  'kid',
  'baby',
  'toddler',
  'model',
  'people',
  'person',
  'guy',
  'teen',
  'female',
  'male',
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const words = text =>
  text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);

// Search words found in the tags count for the photo; people tags not asked for count against it.
const scoreHit = (hit, query) => {
  const queryWords = words(query);
  const tagWords = new Set(words(hit.tags || ''));
  const matches = queryWords.filter(w => tagWords.has(w)).length;
  const hasPeople = PEOPLE_TAGS.some(t => tagWords.has(t) && !queryWords.includes(t));
  return matches * 2 - (hasPeople ? 3 : 0);
};

// Best-scoring hits first; Pixabay's order breaks ties.
const pickHits = (hits, query) =>
  hits
    .map((hit, i) => ({ hit, i, score: scoreHit(hit, query) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_CANDIDATES)
    .map(h => h.hit);

const searchPixabay = async (fetchFn, apiKey, query, anyCategory) => {
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    image_type: 'photo',
    safesearch: 'true',
    ...(anyCategory ? {} : { category: 'fashion' }),
    per_page: String(HITS_PER_SEARCH),
  });
  const res = await fetchFn(`https://pixabay.com/api/?${params}`);
  if (!res.ok) {
    // The error body is a short message such as "[ERROR 400] Invalid or missing API key".
    throw new Error(`Pixabay search failed: ${res.status} ${(await res.text()).slice(0, 100)}`);
  }
  return (await res.json()).hits || [];
};

const download = async (fetchFn, url, file) => {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
};

const hasCandidates = dir =>
  fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.jpg'));

/**
 * @param {Object} options { listings, apiKey, fetchFn, outDir, onlyKeys, all, anyCategory, log }
 *   onlyKeys: re-fetch just these keys; all: re-fetch every key. Otherwise keys with candidates
 *   are skipped.
 */
const fetchPhotos = async ({
  listings,
  apiKey,
  fetchFn,
  outDir,
  onlyKeys,
  all,
  anyCategory,
  log,
}) => {
  const unknown = (onlyKeys || []).filter(k => !listings.some(l => l.key === k));
  if (unknown.length) {
    throw new Error(`No listing with key ${unknown.join(', ')} in plan.json`);
  }
  const todo = onlyKeys ? listings.filter(l => onlyKeys.includes(l.key)) : listings;
  const replace = all || !!onlyKeys;

  let searches = 0;
  for (const listing of todo) {
    const dir = path.join(outDir, listing.key);
    if (!replace && hasCandidates(dir)) {
      log(`skip  ${listing.key} (has candidates)`);
      continue;
    }

    if (searches > 0) {
      await sleep(MS_BETWEEN_SEARCHES);
    }
    searches += 1;
    const hits = pickHits(
      await searchPixabay(fetchFn, apiKey, listing.photoSearch, anyCategory),
      listing.photoSearch
    );

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, hit] of hits.entries()) {
      const n = i + 1;
      await download(fetchFn, hit.webformatURL, path.join(dir, `${n}.jpg`));
      const meta = {
        pixabayUser: hit.user,
        pixabayUrl: hit.pageURL,
        pixabayId: hit.id,
        tags: hit.tags,
        search: listing.photoSearch,
      };
      fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(meta, null, 2) + '\n');
    }
    log(
      `${hits.length ? 'ok   ' : 'NONE '} ${listing.key}: ${hits.length} for "${
        listing.photoSearch
      }"`
    );
  }
  log(`Done. ${searches} Pixabay searches.`);
};

if (require.main === module) {
  loadEnv();
  const keyArg = process.argv.indexOf('--key');
  const onlyKeys = keyArg > -1 ? process.argv[keyArg + 1].split(',').filter(Boolean) : null;
  const { listings } = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));

  fetchPhotos({
    listings,
    apiKey: getPixabayApiKey(),
    fetchFn: fetch,
    outDir: CANDIDATES_DIR,
    onlyKeys,
    all: process.argv.includes('--all'),
    anyCategory: process.argv.includes('--any-category'),
    log: console.log,
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { fetchPhotos, pickHits };
