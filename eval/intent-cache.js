/**
 * The eval's intent cache: one Claude Haiku intent reply per eval query, saved in
 * eval/results/intent-cache.json and reused by every later eval run and weights comparison.
 *
 * Each entry keeps the raw reply (so the search can replay it exactly as the endpoint would
 * parse it) and the state it merges into (so a person can read what the intent step understood).
 *
 * Only recordIntent calls Claude. A query without an entry is never fetched silently: the
 * replaying searcher throws, and the eval shows that query as "search failed".
 */
const fs = require('fs');
const path = require('path');
const { parseIntent } = require('../server/api/smart-search/intent');
const { mergeIntent } = require('../server/api/smart-search/state');

const INTENT_CACHE_FILE = path.join(__dirname, 'results', 'intent-cache.json');

const emptyCache = () => ({ entries: {} });

/**
 * @param {string} [file]
 * @returns {{ entries: Object<string, Object> }} entries keyed by query text; empty without a file
 */
const readIntentCache = (file = INTENT_CACHE_FILE) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyCache();

const writeIntentCache = (cache, file = INTENT_CACHE_FILE) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
};

/**
 * Query texts that have no cache entry yet.
 *
 * @param {Array<{text: string}>} queries
 * @param {{ entries: Object }} cache
 * @returns {string[]}
 */
const missingTexts = (queries, cache) =>
  [...new Set(queries.map(query => query.text))].filter(text => !cache.entries[text]);

/**
 * Make one real intent call for a query and return its cache entry, or null when the call failed
 * (a failure is not cached, so the next run tries it again).
 *
 * @param {Object} params
 * @param {string} params.text the query
 * @param {Object} params.config marketplace config
 * @param {Object} params.anthropic Anthropic client
 * @param {Function} [params.logUsage] usage logger; parseIntent defaults to the usage log
 * @param {Function} [params.onError] called with the error when the call failed
 * @returns {Promise<?Object>} { reply, intent, state, recordedAt }
 */
const recordIntent = async ({ text, config, anthropic, logUsage, onError = () => {} }) => {
  let reply = null;
  const recording = {
    messages: {
      create: (...args) =>
        anthropic.messages.create(...args).then(response => {
          const { model, stop_reason, content, usage } = response;
          reply = { model, stop_reason, content, usage };
          return response;
        }),
    },
  };

  const { intent, warnings } = await parseIntent({
    q: text,
    state: null,
    config,
    anthropic: recording,
    ...(logUsage ? { logUsage } : {}),
    onError,
  });
  if (warnings.includes('INTENT_FALLBACK') || !reply) {
    return null;
  }
  const { state } = mergeIntent({ q: text, state: null, intent });
  return { reply, intent, state, recordedAt: new Date().toISOString() };
};

/**
 * An Anthropic client stand-in that returns the cached reply and never touches the network.
 *
 * @param {Object} entry a cache entry
 * @returns {{ messages: { create: Function } }}
 */
const replayClient = entry => ({
  messages: { create: () => Promise.resolve(entry.reply) },
});

module.exports = {
  INTENT_CACHE_FILE,
  emptyCache,
  readIntentCache,
  writeIntentCache,
  missingTexts,
  recordIntent,
  replayClient,
};
