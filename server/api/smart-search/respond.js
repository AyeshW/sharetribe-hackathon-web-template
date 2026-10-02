/**
 * Step ⑥: the response in the contract shape (CONTRACT.md §4).
 */
const { refKey } = require('./query');

// D16, rule without rerank: 'best' if the initial score is at least 60% of the top score.
const BEST_SHARE = 0.6;

const priceOf = listing => {
  const price = listing.attributes.price;
  return price ? price.amount : 0;
};
const createdAtOf = listing => new Date(listing.attributes.createdAt).getTime();

const SORTERS = {
  'price-asc': (a, b) => priceOf(a.listing) - priceOf(b.listing),
  'price-desc': (a, b) => priceOf(b.listing) - priceOf(a.listing),
  newest: (a, b) => createdAtOf(b.listing) - createdAtOf(a.listing),
};

/**
 * Order results for the requested sort. 'relevance' keeps the ranked order; the others sort a
 * copy (stable, so ties keep the ranked order).
 */
const sortResults = (ranked, sort) => (SORTERS[sort] ? [...ranked].sort(SORTERS[sort]) : ranked);

const tierFor = (score, topScore) => (score >= BEST_SHARE * topScore ? 'best' : 'related');

// The images and authors of this page's listings, in card order, each once.
const pageIncluded = (listings, included) => {
  const keys = new Set();
  listings.forEach(listing => {
    const { author, images } = listing.relationships || {};
    const refs = [
      ...(author && author.data ? [author.data] : []),
      ...((images && images.data) || []),
    ];
    refs.forEach(ref => keys.add(refKey(ref)));
  });
  return [...keys].filter(key => included.has(key)).map(key => included.get(key));
};

/**
 * Build the response body.
 *
 * @param {Object} params
 * @param {Object} params.state the state to send back
 * @param {Array<{ listing, score }>} params.ranked every result, in ranked (relevance) order
 * @param {Map<string, Object>} params.included images and users from the query (query.js)
 * @param {Object} params.request validated request (page, perPage, sort)
 * @param {{ auto: ?Object, suggestions: Array }} params.relaxation from filters.js
 * @param {Object} params.meta backend-only fields (D6)
 */
const buildResponse = ({ state, ranked, included, request, relaxation, meta }) => {
  const { page, perPage, sort } = request;
  const topScore = ranked.reduce((top, r) => Math.max(top, r.score), 0);
  const withTier = ranked.map(r => ({ ...r, tier: tierFor(r.score, topScore) }));
  const ordered = sortResults(withTier, sort);
  const pageResults = ordered.slice((page - 1) * perPage, page * perPage);
  const pageListings = pageResults.map(r => r.listing);
  const best = withTier.filter(r => r.tier === 'best').length;

  return {
    state,
    results: pageResults.map(r => ({ id: r.listing.id, tier: r.tier, reason: null })),
    listings: { data: pageListings, included: pageIncluded(pageListings, included) },
    total: { best, related: withTier.length - best },
    page,
    perPage,
    totalPages: Math.ceil(ordered.length / perPage),
    relaxation: {
      auto: relaxation.auto ? { filter: relaxation.auto } : null,
      suggestions: relaxation.suggestions,
    },
    notices: ordered.length === 0 ? [{ code: 'NO_RESULTS', params: {} }] : [],
    meta,
  };
};

module.exports = { sortResults, buildResponse };
