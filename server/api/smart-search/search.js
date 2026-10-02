/**
 * runSearch: the whole smart search for one request. The Express handler (index.js), tests and
 * the eval all call this.
 *
 * Built so far: ① intent, ② fetch, ③ filter + relax, ⑥ respond. Not yet: ④ initial ranking (Phase 6), ⑤ rerank (deferred, D18).
 */
const { validateRequest, searchError } = require('./request');
const { buildQueryParams, fetchAllListings } = require('./query');
const { applyFilters } = require('./filters');
const { buildResponse } = require('./respond');
const { parseIntent } = require('./intent');
const { mergeIntent, applyCheaper } = require('./state');

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

// Placeholder until the initial ranking (Phase 6): every listing scores 1 and is relevant.
const initialScores = listings => new Map(listings.map(listing => [listing.id.uuid, 1]));
const isRelevantFor = scores => listing => scores.get(listing.id.uuid) > 0;

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
 * @param {Object} deps.vectors vectors.json content from startup.js (used from Phase 6)
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
  const { listings, included } = await fetchCandidates(sdk, params);

  // "Cheaper" needs the fetched candidates (median price), so it runs after step ②.
  const { state, notices } =
    resolved.intent && resolved.intent.priceIntent === 'cheaper'
      ? applyCheaper({ ...resolved, listings, config })
      : resolved;

  const scores = initialScores(listings);
  const { results, auto, suggestions } = applyFilters(
    listings,
    state.filters,
    isRelevantFor(scores)
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
      warnings: resolved.warnings,
    },
  });
  // The buyer-facing notices (USER_FILTER_KEPT) come before NO_RESULTS.
  return { ...response, notices: [...notices, ...response.notices] };
};

module.exports = { runSearch };
