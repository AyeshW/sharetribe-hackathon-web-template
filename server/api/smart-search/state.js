/**
 * Step ① part two: merge the intent into the search state (D3 server rules), and the "cheaper"
 * price rule. Pure functions, no Claude calls.
 */
const { buildFilter } = require('./intent');
const { matchesFilter } = require('./filters');

const CHEAPER_FACTOR = 0.8;

// The buyer's own filters and locked chips: text can't change or remove them (D3 rule 1).
const isProtected = filter => filter.source === 'user' || filter.locked === true;

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const union = (a, b) => [...new Set([...a, ...b])];

const emptyState = q => ({
  q,
  filters: [],
  preferences: [],
  removed: [],
  similarTo: null,
  terms: [],
});

/**
 * The state to start from. A new search keeps only the buyer's own filters (rule 3); a refinement
 * continues the previous state. Without a previous state both start empty.
 */
const baseState = (q, state, mode) => {
  if (!state) {
    return emptyState(q);
  }
  if (mode === 'refine') {
    return { ...state, q };
  }
  return { ...emptyState(q), filters: state.filters.filter(f => f.source === 'user') };
};

const withNotice = (notices, label) =>
  notices.some(n => n.params.label === label)
    ? notices
    : [...notices, { code: 'USER_FILTER_KEPT', params: { label } }];

/**
 * Merge a parsed intent into the previous state.
 *
 * - The buyer's filters (source 'user') and locked chips win over inferred ones for the same
 *   key. If the text conflicts with one, it stays and the response gets USER_FILTER_KEPT with
 *   its label (rule 1).
 * - Keys in `removed` are not inferred again (rule 2). Text that removes a key adds it there.
 * - A new search resets everything but the buyer's filters; a refinement merges into the
 *   previous state (rule 3).
 *
 * @param {Object} params
 * @param {string} params.q the buyer's text
 * @param {?Object} params.state previous state, or null
 * @param {Object} params.intent from intent.js
 * @returns {{ state: Object, notices: Array }}
 */
const mergeIntent = ({ q, state, intent }) => {
  const base = baseState(q, state, intent.mode);
  const previouslyRemoved = base.removed;
  let notices = [];
  let filters = base.filters;

  const removedNow = [];
  intent.removeKeys.forEach(key => {
    const existing = filters.find(f => f.key === key);
    if (existing && isProtected(existing)) {
      notices = withNotice(notices, existing.label);
    } else {
      filters = filters.filter(f => f.key !== key);
      removedNow.push(key);
    }
  });

  intent.filters.forEach(inferred => {
    if (previouslyRemoved.includes(inferred.key)) {
      return;
    }
    const existing = filters.find(f => f.key === inferred.key);
    if (existing && isProtected(existing)) {
      if (!sameValue(existing.value, inferred.value) || existing.op !== inferred.op) {
        notices = withNotice(notices, existing.label);
      }
      return;
    }
    filters = existing ? filters.map(f => (f === existing ? inferred : f)) : [...filters, inferred];
  });

  // A key the text removed stays removed, unless the same reply sets it again.
  const removed = union(previouslyRemoved, removedNow).filter(
    key => !intent.filters.some(f => f.key === key) || previouslyRemoved.includes(key)
  );
  const dropped = intent.removePreferences.map(p => p.toLowerCase());

  return {
    state: {
      ...base,
      filters,
      removed,
      preferences: union(base.preferences, intent.preferences).filter(
        p => !dropped.includes(p.toLowerCase())
      ),
      terms: union(base.terms, intent.terms),
    },
    notices,
  };
};

const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Whole euros, in cents, never below 1 €.
const roundToEuro = cents => Math.max(100, Math.round(cents / 100) * 100);

const priceFilter = (value, config) => buildFilter({ key: 'price', op: 'range', value }, config);

// The prices (cents) a "cheaper" search is measured against: the fetched candidates that pass the
// state's hard filters, or all fetched candidates when none do.
const referencePrices = (listings, filters) => {
  const hard = filters.filter(f => f.mode === 'hard' && f.key !== 'price');
  const matching = listings.filter(l => hard.every(f => matchesFilter(f, l)));
  return (matching.length ? matching : listings)
    .map(l => l.attributes.price && l.attributes.price.amount)
    .filter(amount => typeof amount === 'number');
};

/**
 * "Cheaper" (priceIntent): lower the price max by 20%. Without a price filter, use 80% of the
 * median price of the fetched candidates. A price chip the buyer set or locked stays as it is,
 * with a USER_FILTER_KEPT notice. Needs the candidates, so it runs after the fetch (step ②).
 *
 * @param {Object} params
 * @param {Object} params.state state after mergeIntent
 * @param {Array} params.notices notices so far
 * @param {Array} params.listings candidates from the Marketplace API query
 * @param {Object} params.config marketplace config
 * @returns {{ state: Object, notices: Array }}
 */
const applyCheaper = ({ state, notices, listings, config }) => {
  const existing = state.filters.find(f => f.key === 'price');
  if (existing && isProtected(existing)) {
    return { state, notices: withNotice(notices, existing.label) };
  }

  let value;
  if (existing && existing.value.max != null) {
    const max = roundToEuro(existing.value.max * CHEAPER_FACTOR);
    value = { ...existing.value, max: Math.max(max, existing.value.min || 0) };
  } else {
    const prices = referencePrices(listings, state.filters);
    if (prices.length === 0) {
      return { state, notices };
    }
    value = {
      ...(existing ? existing.value : {}),
      max: roundToEuro(median(prices) * CHEAPER_FACTOR),
    };
  }

  const cheaper = priceFilter(value, config);
  return {
    state: {
      ...state,
      filters: existing
        ? state.filters.map(f => (f === existing ? cheaper : f))
        : [...state.filters, cheaper],
    },
    notices,
  };
};

module.exports = { mergeIntent, applyCheaper, isProtected };
