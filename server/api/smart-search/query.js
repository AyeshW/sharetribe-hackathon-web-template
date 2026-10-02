/**
 * Step ②: the one Marketplace API query per search (D2, D5).
 *
 * The query holds the listing type and the filters that are never relaxed: those the buyer set
 * (source 'user') or locked. Inferred filters are applied in memory (filters.js).
 */
const { util: sdkUtil } = require('sharetribe-flex-sdk');
const { ENUM_KEYS } = require('./request');

const LISTING_TYPE = 'sell-used-products';
const API_PER_PAGE = 100;
const MAX_VARIANT_SIDE = 3072;

/**
 * Filters that go into the query and are never relaxed.
 */
const isFixed = filter => filter.source === 'user' || filter.locked === true;

/**
 * Keys the query can filter on. brand and shippingEnabled have no search schema, so they are
 * always applied in memory (D5).
 */
const QUERY_KEYS = [...ENUM_KEYS, 'price'];

const valuesOf = value => (Array.isArray(value) ? value : [value]);

// The API has no "not" for enums, so "No bundles" becomes `in` over every other subcategory.
const otherSubcategories = (config, excluded) =>
  config.categories
    .flatMap(category => (category.subcategories || []).map(sub => sub.id))
    .filter(id => !excluded.includes(id));

// The API's upper bound is exclusive, so max + 1 keeps the buyer's max included.
const priceRange = ({ min, max }) => `${min == null ? '' : min},${max == null ? '' : max + 1}`;

const filterParams = (filter, config) => {
  if (filter.key === 'price') {
    return { price: priceRange(filter.value) };
  }
  const values =
    filter.op === 'notIn'
      ? otherSubcategories(config, valuesOf(filter.value))
      : valuesOf(filter.value);
  return { [`pub_${filter.key}`]: values.join(',') };
};

// Same as createImageVariantConfig in src/util/sdkLoader.js (which can't be required here).
const imageVariant = (name, width, aspectRatio) => {
  let variantWidth = width;
  let variantHeight = Math.round(aspectRatio * width);
  if (variantHeight > MAX_VARIANT_SIDE) {
    variantHeight = MAX_VARIANT_SIDE;
    variantWidth = Math.round(variantHeight / aspectRatio);
  }
  return {
    [`imageVariant.${name}`]: sdkUtil.objectQueryString({
      w: variantWidth,
      h: variantHeight,
      fit: 'crop',
    }),
  };
};

// Images and authors as SearchPage.duck.js fetches them for listing cards.
const includeParams = ({ variantPrefix, aspectWidth, aspectHeight }) => {
  const aspectRatio = aspectHeight / aspectWidth;
  return {
    include: ['author', 'images'],
    'fields.user': ['profile.displayName', 'profile.abbreviatedName'],
    'fields.image': [
      'variants.scaled-small',
      'variants.scaled-medium',
      `variants.${variantPrefix}`,
      `variants.${variantPrefix}-2x`,
    ],
    ...imageVariant(variantPrefix, 400, aspectRatio),
    ...imageVariant(`${variantPrefix}-2x`, 800, aspectRatio),
    'limit.images': 1,
  };
};

/**
 * Marketplace API query params for a search state (D5 mapping table).
 *
 * @param {Object} state the search state (filters with source, locked, op, value)
 * @param {Object} image { variantPrefix, aspectWidth, aspectHeight } from the request
 * @param {Object} config marketplace config (categories are used for notIn)
 * @returns {Object} params for sdk.listings.query, without page
 */
const buildQueryParams = (state, image, config) => {
  const filterParamsMaybe = state.filters
    .filter(filter => isFixed(filter) && QUERY_KEYS.includes(filter.key))
    .reduce((params, filter) => ({ ...params, ...filterParams(filter, config) }), {});

  return {
    pub_listingType: LISTING_TYPE,
    ...filterParamsMaybe,
    ...includeParams(image),
    perPage: API_PER_PAGE,
  };
};

const refKey = ref => `${ref.type}/${ref.id.uuid}`;

/**
 * Run the query over all result pages.
 *
 * @param {Object} sdk Marketplace API SDK (anything with listings.query)
 * @param {Object} params from buildQueryParams
 * @returns {Promise<{ listings: Array, included: Map<string, Object> }>} listings in API order;
 *   included images and users keyed by `${type}/${uuid}`
 */
const fetchAllListings = async (sdk, params) => {
  const listings = [];
  const included = new Map();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await sdk.listings.query({ ...params, page });
    const { data = [], included: pageIncluded = [], meta = {} } = response.data || {};
    listings.push(...data);
    pageIncluded.forEach(entity => included.set(refKey(entity), entity));
    totalPages = meta.totalPages || 1;
    page += 1;
  }

  return { listings, included };
};

module.exports = {
  LISTING_TYPE,
  QUERY_KEYS,
  isFixed,
  refKey,
  buildQueryParams,
  fetchAllListings,
};
