/**
 * runSearch: the whole smart search for one request. The Express handler (index.js), tests and
 * the eval all call this.
 *
 * Built so far: ② fetch, ③ filter + relax, ⑥ respond. Not yet: ① intent (Phase 5),
 * ④ initial ranking (Phase 6), ⑤ rerank (deferred, D18).
 */
const { validateRequest, searchError } = require('./request');
const { buildQueryParams, fetchAllListings } = require('./query');
const { applyFilters } = require('./filters');
const { buildResponse } = require('./respond');

/**
 * The state this request searches with. New text starts a new search that keeps only the
 * buyer's own filters (D3 rule 3); intent parsing (Phase 5) will add inferred filters here.
 * Without text the state is used as it is.
 */
const nextState = ({ q, state }) =>
  q
    ? {
        q,
        filters: state ? state.filters.filter(f => f.source === 'user') : [],
        preferences: [],
        removed: [],
        similarTo: null,
        terms: [],
      }
    : state;

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
 * @param {() => number} [deps.now] clock, for tookMs
 * @returns {Promise<Object>} response body (CONTRACT.md §4, plus backend-only meta)
 * @throws a search error with status and code (CONTRACT.md §9)
 */
const runSearch = async (body, deps) => {
  const { sdk, config, now = Date.now } = deps;
  const startedAt = now();

  const request = validateRequest(body);
  const state = nextState(request);

  const params = buildQueryParams(state, request.image, config);
  const { listings, included } = await fetchCandidates(sdk, params);

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

  return buildResponse({
    state: responseState,
    ranked,
    included,
    request,
    relaxation: { auto, suggestions },
    meta: { tookMs: now() - startedAt, reranked: false, intent: null, warnings: [] },
  });
};

module.exports = { runSearch, nextState };
