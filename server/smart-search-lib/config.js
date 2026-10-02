/**
 * Marketplace listing config (hosted assets from Console) and pure helpers over it.
 */

const ASSET_PATHS = {
  listingFields: 'listings/listing-fields.json',
  categories: 'listings/listing-categories.json',
  listingTypes: 'listings/listing-types.json',
};

const assetData = (response, path, key) => {
  const value = response?.data?.data?.[key];
  if (!Array.isArray(value)) {
    throw new Error(`Asset ${path} has no ${key} array`);
  }
  return value;
};

/**
 * Fetch listing fields, categories and listing types with the 'latest' alias.
 *
 * @param {Object} sdk Marketplace SDK instance (anything with assetByAlias)
 * @returns {Promise<{ listingFields: Array, categories: Array, listingTypes: Array }>}
 */
const loadMarketplaceConfig = sdk => {
  const fetchAsset = path => sdk.assetByAlias({ path, alias: 'latest' });
  return Promise.all([
    fetchAsset(ASSET_PATHS.listingFields),
    fetchAsset(ASSET_PATHS.categories),
    fetchAsset(ASSET_PATHS.listingTypes),
  ]).then(([fieldsRes, categoriesRes, typesRes]) => ({
    listingFields: assetData(fieldsRes, ASSET_PATHS.listingFields, 'listingFields'),
    categories: assetData(categoriesRes, ASSET_PATHS.categories, 'categories'),
    listingTypes: assetData(typesRes, ASSET_PATHS.listingTypes, 'listingTypes'),
  }));
};

/**
 * Every category a listing can have: { level1, level2 } pairs, plus { level1 } for top-level
 * categories without subcategories (e.g. 'accessories').
 */
const validCategoryPairs = config =>
  config.categories.flatMap(top => {
    const subcategories = top.subcategories || [];
    return subcategories.length === 0
      ? [{ level1: top.id }]
      : subcategories.map(sub => ({ level1: top.id, level2: sub.id }));
  });

// Ids from the top-level category down to categoryId, e.g. ['men', 'men-shoes'].
const categoryPath = (categories, categoryId) => {
  for (const category of categories || []) {
    if (category.id === categoryId) {
      return [category.id];
    }
    const subPath = categoryPath(category.subcategories, categoryId);
    if (subPath) {
      return [category.id, ...subPath];
    }
  }
  return null;
};

/**
 * Listing fields that apply to a category. Like the template (isFieldForCategory), a field applies
 * when it isn't limited to categories, or when any level of the category's path is in its list.
 *
 * @param {Object} config result of loadMarketplaceConfig
 * @param {string} categoryId deepest category id, e.g. 'men-shoes' or 'accessories'
 * @returns {Array<{ key, schemaType, required, enumOptions, label }>}
 */
const fieldsForCategory = (config, categoryId) => {
  const path = categoryPath(config.categories, categoryId);
  if (!path) {
    throw new Error(`Unknown category ${categoryId}`);
  }

  return config.listingFields
    .filter(field => {
      const { limitToCategoryIds, categoryIds } = field.categoryConfig || {};
      return !limitToCategoryIds || (categoryIds || []).some(id => path.includes(id));
    })
    .map(field => ({
      key: field.key,
      schemaType: field.schemaType,
      required: !!field.saveConfig?.isRequired,
      enumOptions: field.enumOptions || null,
      label: field.showConfig?.label || field.label,
    }));
};

module.exports = {
  loadMarketplaceConfig,
  validCategoryPairs,
  fieldsForCategory,
};
