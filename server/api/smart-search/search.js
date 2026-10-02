/**
 * runSearch: the whole smart search for one request. The Express handler (index.js), tests and
 * the eval all call this.
 *
 * Built: ① intent, ② fetch, ③ filter + relax, ④ initial ranking, ⑥ respond. Not yet: ⑤ rerank
 * (deferred, D18).
 */
const { validateRequest, searchError } = require('./request');
const { buildQueryParams, fetchAllListings } = require('./query');
const { applyFilters } = require('./filters');
const { buildResponse } = require('./respond');
const { parseIntent } = require('./intent');
const { mergeIntent, applyCheaper } = require('./state');
const { queryText, hasRankingSignals, rankListings } = require('./ranking');

/**
 * Step ①: the state this request searches with. New text goes through intent parsing and the
 * merge rules (D3); without text (a chip edit, sort or page change) the state is used as it is
 * and Claude is not called.
 */
const resolveState = async ({ q, state }, deps) => {
  if (!q) {
    return { state, notices: [], warnings: [], intent: null };
  }
  const { intent, warnings } = await parseIntent({
    q,
    state,
    config: deps.config,
    anthropic: deps.anthropic,
    logUsage: deps.logUsage,
    timeoutMs: deps.intentTimeoutMs,
    onError: deps.onIntentError,
  });
  const merged = mergeIntent({ q, state, intent });
  return { ...merged, warnings, intent };
};

/**
 * The query vector for step ④, or null when there is no text or terms to embed. A missing model
 * or a failed call is not an error: ranking goes on without the meaning signal (D6).
 */
const embedQueryVector = async (state, deps) => {
  const text = queryText(state);
  if (!text) {
    return { queryVector: null, warnings: [] };
  }
  if (!deps.embedQuery) {
    return { queryVector: null, warnings: ['EMBEDDING_SKIPPED'] };
  }
  try {
    return { queryVector: await deps.embedQuery(text), warnings: [] };
  } catch (e) {
    if (deps.onEmbedError) {
      deps.onEmbedError(e);
    }
    return { queryVector: null, warnings: ['EMBEDDING_SKIPPED'] };
  }
};

// A listing is relevant when it scores above 0, or always in a pure filter search.
const isRelevantFor = (state, scores) =>
  hasRankingSignals(state) ? listing => scores.get(listing.id.uuid) > 0 : () => true;

const fetchCandidates = (sdk, params) =>
  fetchAllListings(sdk, params).catch(e => {
    throw Object.assign(searchError(502, 'UPSTREAM_ERROR', 'Marketplace API query failed'), {
      cause: e,
    });
  });

/**
 * Run one search.
 *
 * @param {Object} body request body (CONTRACT.md §3)
 * @param {Object} deps
 * @param {Object} deps.sdk Marketplace API SDK (anything with listings.query)
 * @param {Object} deps.config marketplace config from startup.js
 * @param {Object} deps.vectors vectors.json content from startup.js
 * @param {?Function} [deps.embedQuery] (text) => Promise<number[]>, from startup.js (null: the
 *   model didn't load, ranking skips the meaning signal)
 * @param {Function} [deps.onEmbedError] called with the error when embedQuery fails
 * @param {Object} [deps.weights] ranking weights (ranking.js WEIGHTS), for the eval
 * @param {Function} [deps.onRanking] called with { scores, signals } for debugging; never sent
 * @param {?Object} [deps.anthropic] Anthropic client for the intent call (null: intent falls back)
 * @param {Function} [deps.logUsage] Claude usage logger (defaults to the usage log)
 * @param {number} [deps.intentTimeoutMs] intent call timeout
 * @param {Function} [deps.onIntentError] called with the error when the intent call falls back
 * @param {() => number} [deps.now] clock, for tookMs
 * @returns {Promise<Object>} response body (CONTRACT.md §4, plus backend-only meta)
 * @throws a search error with status and code (CONTRACT.md §9)
 */
const runSearch = async (body, deps) => {
  const { sdk, config, now = Date.now } = deps;
  const startedAt = now();

  const request = validateRequest(body);
  const resolved = await resolveState(request, deps);

  const params = buildQueryParams(resolved.state, request.image, config);
  const [{ listings, included }, embedded] = await Promise.all([
    fetchCandidates(sdk, params),
    embedQueryVector(resolved.state, deps),
  ]);

  // "Cheaper" needs the fetched candidates (median price), so it runs after step ②.
  const { state, notices } =
    resolved.intent && resolved.intent.priceIntent === 'cheaper'
      ? applyCheaper({ ...resolved, listings, config })
      : resolved;

  const { scores, signals } = rankListings({
    listings,
    state,
    queryVector: embedded.queryVector,
    vectors: deps.vectors,
    weights: deps.weights,
  });
  if (deps.onRanking) {
    deps.onRanking({ scores, signals });
  }
  const { results, auto, suggestions } = applyFilters(
    listings,
    state.filters,
    isRelevantFor(state, scores)
  );

  // The dropped filter leaves the state, so later pages and sorts search the same way.
  // The buyer can put it back from relaxation.auto (CONTRACT.md §6, "Undo").
  const responseState = auto ? { ...state, filters: state.filters.filter(f => f !== auto) } : state;

  // Stable sort: equal scores keep the API order.
  const ranked = results
    .map(listing => ({ listing, score: scores.get(listing.id.uuid) }))
    .sort((a, b) => b.score - a.score);

  const response = buildResponse({
    state: responseState,
    ranked,
    included,
    request,
    relaxation: { auto, suggestions },
    meta: {
      tookMs: now() - startedAt,
      reranked: false,
      intent: resolved.intent,
      warnings: [...resolved.warnings, ...embedded.warnings],
    },
  });
  // The buyer-facing notices (USER_FILTER_KEPT) come before NO_RESULTS.
  return { ...response, notices: [...notices, ...response.notices] };
};

module.exports = { runSearch };
