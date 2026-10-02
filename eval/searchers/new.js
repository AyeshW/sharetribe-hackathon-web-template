/**
 * The new smart search: runSearch in-process (server/api/smart-search/search.js), exactly as the
 * endpoint runs it, without rerank (D18).
 *
 * The intent step replays the cached Claude reply from eval/results/intent-cache.json, so a search
 * here makes no Claude calls. A query without a cache entry fails with a clear message instead of
 * calling Claude (eval/run.js fills the cache first, after asking).
 */
const { runSearch } = require('../../server/api/smart-search/search');
const { replayClient } = require('../intent-cache');

const PER_PAGE = 10;

// The cached reply was logged when it was recorded; replaying it costs nothing.
const noUsageLog = () => {};

/**
 * Make a search function for the eval runner.
 *
 * Everything is passed in so tests can hand in fakes and never touch the network.
 *
 * @param {Object} deps
 * @param {Object} deps.sdk Marketplace API SDK
 * @param {Object} deps.config marketplace config (startup.js)
 * @param {Object} deps.vectors vectors.json content (startup.js)
 * @param {?Function} deps.embedQuery query embedding function, or null (ranks without meaning)
 * @param {{ entries: Object }} deps.intentCache from intent-cache.js
 * @param {Object} [deps.weights] ranking weights; runSearch defaults to ranking.js WEIGHTS
 * @returns {(text: string) => Promise<Array<{id: string, title: string}>>} results, best first
 */
const createNewSearcher = ({
  sdk,
  config,
  vectors,
  embedQuery,
  intentCache,
  weights,
}) => async text => {
  const entry = intentCache.entries[text];
  if (!entry) {
    throw new Error(`no cached intent for "${text}"; run node eval/run.js to fill the cache`);
  }

  const body = await runSearch(
    { q: text, perPage: PER_PAGE },
    {
      sdk,
      config,
      vectors,
      embedQuery,
      weights,
      anthropic: replayClient(entry),
      logUsage: noUsageLog,
    }
  );

  const titles = new Map(body.listings.data.map(l => [l.id.uuid, l.attributes.title]));
  return body.results.map(result => ({
    id: result.id.uuid,
    title: titles.get(result.id.uuid) || '(no title)',
  }));
};

module.exports = { PER_PAGE, createNewSearcher };
