/**
 * Step ③: in-memory filters and relaxation (D5).
 *
 * - Inferred hard filters are applied here, to the main query's results. They can be relaxed.
 * - brand and shippingEnabled have no search schema, so when the buyer set or locked them they
 *   are applied here too. Like every buyer-set or locked filter, they are never relaxed.
 * - Soft filters only affect ranking, never which listings appear.
 */
const { isFixed, QUERY_KEYS } = require('./query');

const valuesOf = value => (Array.isArray(value) ? value : [value]);
const normalize = text => (typeof text === 'string' ? text.trim().toLowerCase() : '');

// The seller's colour, or the colours the indexer saw in the photo when the seller left it
// empty (D8).
const listingColors = (publicData, ai) =>
  publicData.color ? [publicData.color] : (ai && ai.colorDetected) || [];

/**
 * Does a listing pass one filter?
 *
 * @param {Object} filter { key, op, value }
 * @param {Object} listing listing from the Marketplace API
 * @returns {boolean}
 */
const matchesFilter = (filter, listing) => {
  const { key, op, value } = filter;
  const attributes = listing.attributes || {};
  const publicData = attributes.publicData || {};
  const ai = (attributes.metadata || {}).ai;

  if (key === 'price') {
    const amount = attributes.price ? attributes.price.amount : null;
    return (
      amount != null &&
      (value.min == null || amount >= value.min) &&
      (value.max == null || amount <= value.max)
    );
  }
  if (key === 'brand') {
    const wanted = normalize(value);
    return normalize(publicData.brand) === wanted || normalize(ai && ai.brand) === wanted;
  }
  if (key === 'shippingEnabled') {
    return (publicData.shippingEnabled === true) === value;
  }

  const listingValues = key === 'color' ? listingColors(publicData, ai) : [publicData[key]];
  const hit = listingValues.some(v => valuesOf(value).includes(v));
  return op === 'notIn' ? !hit : hit;
};

const passesAll = (filters, listing) => filters.every(filter => matchesFilter(filter, listing));
const without = (filters, filter) => filters.filter(f => f !== filter);

/**
 * Inferred hard filters: the only ones that can be relaxed.
 */
const isRelaxable = filter => !isFixed(filter) && filter.mode === 'hard';

// Relevant listings that pass every active filter except `filter`, and fail `filter`.
const hiddenBy = (pool, active, filter, isRelevant) =>
  pool.filter(
    listing =>
      isRelevant(listing) &&
      !matchesFilter(filter, listing) &&
      passesAll(without(active, filter), listing)
  ).length;

// The filter that recovers the most relevant listings. Price only if nothing else recovers any.
// On a tie the filter that comes first in the state wins.
const chooseAutoDrop = counts => {
  const best = list => list.reduce((top, c) => (c.extra > (top ? top.extra : 0) ? c : top), null);
  return (
    best(counts.filter(c => c.filter.key !== 'price')) ||
    best(counts.filter(c => c.filter.key === 'price'))
  );
};

/**
 * Apply in-memory filters and relax them when nothing is left (D5).
 *
 * @param {Array} listings candidates from the main query, in API order
 * @param {Array} filters state.filters
 * @param {(listing) => boolean} isRelevant whether a listing counts as relevant for
 *   suggestions and auto-relaxation (initial score above the relevance threshold)
 * @returns {{ results: Array, auto: ?Object, suggestions: Array<{ key, label, extra }> }}
 *   results in the order of `listings`; auto is the dropped filter, or null
 */
const applyFilters = (listings, filters, isRelevant) => {
  const fixedInMemory = filters.filter(f => isFixed(f) && !QUERY_KEYS.includes(f.key));
  const relaxable = filters.filter(isRelaxable);
  const pool = listings.filter(listing => passesAll(fixedInMemory, listing));

  const countHidden = active =>
    active.map(filter => ({ filter, extra: hiddenBy(pool, active, filter, isRelevant) }));

  let active = relaxable;
  let auto = null;
  let results = pool.filter(listing => passesAll(active, listing));

  if (results.length === 0) {
    const dropped = chooseAutoDrop(countHidden(active));
    if (dropped) {
      auto = dropped.filter;
      active = without(active, auto);
      results = pool.filter(listing => passesAll(active, listing));
    }
  }

  const suggestions = countHidden(active)
    .filter(c => c.extra > 0)
    .map(({ filter, extra }) => ({ key: filter.key, label: filter.label, extra }));

  return { results, auto, suggestions };
};

module.exports = { matchesFilter, isRelaxable, applyFilters };
