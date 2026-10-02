/**
 * Validates planned seed listings against the marketplace's listing config (D12).
 *
 * Run by hand: NODE_ENV=development node seed/validate.js
 * Checks every listing in seed/plan.json against the LIVE config; exits with 1 on any error.
 *
 * The image is optional (a listing only needs a photo when a query depends on it), but when one
 * is given it must have a file and the Pixabay credit.
 */
const fs = require('fs');
const path = require('path');
const { validCategoryPairs, fieldsForCategory } = require('../server/smart-search-lib/config');

const LISTING_TYPE = 'sell-used-products';
const CATEGORY_KEYS = ['categoryLevel1', 'categoryLevel2'];
const MIN_PRICE_EUR = 1;
const MAX_PRICE_EUR = 500;

const isNonEmptyString = v => typeof v === 'string' && v.trim().length > 0;

const isForListingType = field => {
  const { limitToListingTypeIds, listingTypeIds } = field.listingTypeConfig || {};
  return !limitToListingTypeIds || (listingTypeIds || []).includes(LISTING_TYPE);
};

/**
 * @param {Object} listing a planned listing from seed/plan.json
 * @param {Object} config result of loadMarketplaceConfig
 * @returns {string[]} errors, empty when the listing is valid
 */
const validateListing = (listing, config) => {
  const errors = [];
  const publicData = listing.publicData || {};
  const { categoryLevel1, categoryLevel2 } = publicData;

  if (!isNonEmptyString(listing.title)) {
    errors.push('title is missing');
  }
  if (!isNonEmptyString(listing.description)) {
    errors.push('description is missing');
  }
  const price = listing.priceEur;
  if (typeof price !== 'number' || price < MIN_PRICE_EUR || price > MAX_PRICE_EUR) {
    errors.push(
      `priceEur must be a number from ${MIN_PRICE_EUR} to ${MAX_PRICE_EUR}, got ${price}`
    );
  }
  if (listing.image) {
    ['file', 'pixabayUser', 'pixabayUrl'].forEach(k => {
      if (!isNonEmptyString(listing.image[k])) {
        errors.push(`image.${k} is missing`);
      }
    });
  }

  const validPair = validCategoryPairs(config).some(
    p => p.level1 === categoryLevel1 && p.level2 === categoryLevel2
  );
  if (!validPair) {
    errors.push(
      `category ${categoryLevel1}${
        categoryLevel2 ? ' / ' + categoryLevel2 : ''
      } is not a valid category`
    );
    return errors; // field checks need a valid category
  }

  const allowed = fieldsForCategory(config, categoryLevel2 || categoryLevel1).filter(f => {
    const field = config.listingFields.find(lf => lf.key === f.key);
    return isForListingType(field);
  });
  const allowedByKey = Object.fromEntries(allowed.map(f => [f.key, f]));

  allowed
    .filter(f => f.required && !isNonEmptyString(publicData[f.key]))
    .forEach(f => errors.push(`required field ${f.key} is missing`));

  Object.entries(publicData).forEach(([key, value]) => {
    if (CATEGORY_KEYS.includes(key)) {
      return;
    }
    const field = allowedByKey[key];
    if (!field) {
      const known = config.listingFields.some(f => f.key === key);
      errors.push(
        known
          ? `field ${key} does not belong to category ${categoryLevel2 || categoryLevel1}`
          : `field ${key} is not a listing field`
      );
      return;
    }
    if (field.schemaType === 'enum') {
      const options = (field.enumOptions || []).map(o => o.option);
      if (!options.includes(value)) {
        errors.push(
          `field ${key} has value ${JSON.stringify(value)}, allowed: ${options.join(', ')}`
        );
      }
    } else if (typeof value !== 'string') {
      errors.push(`field ${key} must be text`);
    }
  });

  return errors;
};

/**
 * Errors for every listing, keyed by listing key (only listings with errors).
 */
const validatePlan = (plan, config) =>
  Object.fromEntries(
    plan.listings
      .map(l => [l.key, validateListing(l, config)])
      .filter(([, errors]) => errors.length > 0)
  );

if (require.main === module) {
  const { loadEnv, createMarketplaceSdk } = require('../server/smart-search-lib/clients');
  const { loadMarketplaceConfig } = require('../server/smart-search-lib/config');
  loadEnv();

  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
  loadMarketplaceConfig(createMarketplaceSdk())
    .then(config => {
      const invalid = validatePlan(plan, config);
      const root = path.join(__dirname, '..');
      plan.listings
        .filter(l => l.image && !fs.existsSync(path.join(root, l.image.file)))
        .forEach(
          l =>
            (invalid[l.key] = [...(invalid[l.key] || []), `image file ${l.image.file} not found`])
        );

      Object.entries(invalid).forEach(([key, errors]) => {
        errors.forEach(e => console.log(`FAIL ${key}: ${e}`));
      });
      const count = Object.keys(invalid).length;
      console.log(
        count
          ? `\n${count} of ${plan.listings.length} listings have errors`
          : `All ${plan.listings.length} listings are valid against the live config`
      );
      process.exit(count ? 1 : 0);
    })
    .catch(e => {
      console.error(e.status ? `${e.status} ${e.statusText}` : e.message);
      process.exit(1);
    });
}

module.exports = { validateListing, validatePlan };
