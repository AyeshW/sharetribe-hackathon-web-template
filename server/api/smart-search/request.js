/**
 * Validate and default a smart search request (CONTRACT.md §3). Errors follow §9.
 */

const MAX_QUERY_LENGTH = 300;
const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 24;
const SORTS = ['relevance', 'price-asc', 'price-desc', 'newest'];
// Same defaults as SearchPage.duck.js uses for config.layout.listingImage.
const DEFAULT_IMAGE = { variantPrefix: 'listing-card', aspectWidth: 1, aspectHeight: 1 };

// Filter keys from CONTRACT.md §4.
const ENUM_KEYS = [
  'categoryLevel1',
  'categoryLevel2',
  'size',
  'shoeSize',
  'kidsSize',
  'color',
  'condition',
  'petFreeHome',
  'smokeFreeHome',
];
const FILTER_KEYS = [...ENUM_KEYS, 'price', 'brand', 'shippingEnabled'];

/**
 * An error the handler turns into `{ code, message }` with the given HTTP status.
 */
const searchError = (status, code, message) =>
  Object.assign(new Error(message), { status, code, isSearchError: true });

const invalid = message => searchError(400, 'INVALID_REQUEST', message);

const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';
const isStringArray = value => Array.isArray(value) && value.every(v => typeof v === 'string');
const isNonNegativeInt = value => Number.isInteger(value) && value >= 0;

const validPrice = value =>
  isObject(value) &&
  (value.min != null || value.max != null) &&
  (value.min == null || isNonNegativeInt(value.min)) &&
  (value.max == null || isNonNegativeInt(value.max)) &&
  (value.min == null || value.max == null || value.min <= value.max);

// Each key allows its own ops and value types. 'notIn' exists only for category exclusions
// such as "No bundles" (D5).
const validValue = ({ key, op, value }) => {
  if (key === 'price') {
    return op === 'range' && validPrice(value);
  }
  if (key === 'shippingEnabled') {
    return op === 'eq' && typeof value === 'boolean';
  }
  if (key === 'brand') {
    return op === 'eq' && isNonEmptyString(value);
  }
  if (op === 'eq') {
    return isNonEmptyString(value);
  }
  const listOk = isStringArray(value) && value.length > 0;
  return (op === 'in' && listOk) || (op === 'notIn' && key === 'categoryLevel2' && listOk);
};

const validateFilter = (filter, index) => {
  const where = `state.filters[${index}]`;
  if (!isObject(filter)) {
    throw invalid(`${where} must be an object`);
  }
  if (!FILTER_KEYS.includes(filter.key)) {
    throw invalid(`${where}.key is not a known filter key`);
  }
  if (typeof filter.label !== 'string') {
    throw invalid(`${where}.label must be a string`);
  }
  if (!['hard', 'soft'].includes(filter.mode)) {
    throw invalid(`${where}.mode must be 'hard' or 'soft'`);
  }
  if (typeof filter.locked !== 'boolean') {
    throw invalid(`${where}.locked must be a boolean`);
  }
  if (!['user', 'inferred'].includes(filter.source)) {
    throw invalid(`${where}.source must be 'user' or 'inferred'`);
  }
  if (!validValue(filter)) {
    throw invalid(`${where} has an invalid op or value for key '${filter.key}'`);
  }
  return filter;
};

const validateState = state => {
  if (state == null) {
    return null;
  }
  if (!isObject(state)) {
    throw invalid('state must be an object or null');
  }
  const {
    q = '',
    filters = [],
    preferences = [],
    removed = [],
    similarTo = null,
    terms = [],
  } = state;

  if (typeof q !== 'string') {
    throw invalid('state.q must be a string');
  }
  if (!Array.isArray(filters)) {
    throw invalid('state.filters must be an array');
  }
  ['preferences', 'removed', 'terms'].forEach(name => {
    const value = { preferences, removed, terms }[name];
    if (!isStringArray(value)) {
      throw invalid(`state.${name} must be an array of strings`);
    }
  });
  if (similarTo !== null && typeof similarTo !== 'string') {
    throw invalid('state.similarTo must be a string or null');
  }

  return { q, filters: filters.map(validateFilter), preferences, removed, similarTo, terms };
};

const validateQ = q => {
  if (q == null) {
    return null;
  }
  if (typeof q !== 'string') {
    throw invalid('q must be a string or null');
  }
  const trimmed = q.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw searchError(400, 'QUERY_TOO_LONG', `q is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  return trimmed === '' ? null : trimmed;
};

const validateInt = (value, name, defaultValue, max) => {
  if (value == null) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value < 1 || (max && value > max)) {
    throw invalid(`${name} must be an integer from 1${max ? ` to ${max}` : ''}`);
  }
  return value;
};

const validateImage = image => {
  if (image == null) {
    return DEFAULT_IMAGE;
  }
  if (!isObject(image)) {
    throw invalid('image must be an object');
  }
  const {
    variantPrefix = DEFAULT_IMAGE.variantPrefix,
    aspectWidth = DEFAULT_IMAGE.aspectWidth,
    aspectHeight = DEFAULT_IMAGE.aspectHeight,
  } = image;
  const positive = n => typeof n === 'number' && n > 0 && Number.isFinite(n);
  if (!/^[a-zA-Z0-9-]+$/.test(variantPrefix) || !positive(aspectWidth) || !positive(aspectHeight)) {
    throw invalid('image must have a variantPrefix and positive aspectWidth and aspectHeight');
  }
  return { variantPrefix, aspectWidth, aspectHeight };
};

const validateBoolean = (value, name, defaultValue) => {
  if (value == null) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw invalid(`${name} must be a boolean`);
  }
  return value;
};

/**
 * Validate a request body and fill in defaults.
 *
 * @param {Object} body the deserialized request body
 * @returns {{ q: ?string, state: ?Object, page, perPage, sort, image, rerank, debug }}
 * @throws a search error (status 400, code INVALID_REQUEST or QUERY_TOO_LONG)
 */
const validateRequest = body => {
  if (!isObject(body)) {
    throw invalid('Request body must be an object');
  }

  const q = validateQ(body.q);
  const state = validateState(body.state);
  if (q === null && state === null) {
    throw invalid('Send q, state or both');
  }

  const sort = body.sort == null ? 'relevance' : body.sort;
  if (!SORTS.includes(sort)) {
    throw invalid(`sort must be one of ${SORTS.join(', ')}`);
  }

  return {
    q,
    state,
    page: validateInt(body.page, 'page', 1),
    perPage: validateInt(body.perPage, 'perPage', DEFAULT_PER_PAGE, MAX_PER_PAGE),
    sort,
    image: validateImage(body.image),
    // Accepted but has no effect until rerank is built (D18).
    rerank: validateBoolean(body.rerank, 'rerank', true),
    debug: validateBoolean(body.debug, 'debug', false),
  };
};

module.exports = {
  ENUM_KEYS,
  FILTER_KEYS,
  MAX_QUERY_LENGTH,
  searchError,
  validateRequest,
};
