const { loadMarketplaceConfig, validCategoryPairs, fieldsForCategory } = require('./config');

// A trimmed copy of the live hosted config (listing fields, categories and listing types).
const enumOptions = options => options.map(option => ({ option, label: option.toUpperCase() }));
const field = (key, schemaType, isRequired, categoryIds, extra = {}) => ({
  key,
  scope: 'public',
  schemaType,
  label: key,
  showConfig: { label: `${key} label` },
  saveConfig: { label: key, isRequired },
  categoryConfig: categoryIds
    ? { limitToCategoryIds: true, categoryIds }
    : { limitToCategoryIds: false },
  ...extra,
});

const ADULT_TOPS_BOTTOMS = ['women-tops', 'women-bottoms', 'men-tops', 'men-bottoms'];
const NOT_BUNDLES = [
  'women-tops',
  'women-bottoms',
  'women-shoes',
  'men-tops',
  'men-bottoms',
  'men-shoes',
  'kids-tops',
  'kids-bottoms',
  'kids-shoes',
];
const BUNDLES = ['women-bundles', 'men-bundles', 'kids-bundles'];

const listingFields = [
  field('size', 'enum', true, ADULT_TOPS_BOTTOMS, { enumOptions: enumOptions(['s', 'm', 'l']) }),
  field('shoeSize', 'enum', true, ['women-shoes', 'men-shoes', 'kids-shoes'], {
    enumOptions: enumOptions(['38', '42']),
  }),
  field('kidsSize', 'enum', true, ['kids-tops', 'kids-bottoms'], {
    enumOptions: enumOptions(['5y', '6y']),
  }),
  field('condition', 'enum', true, NOT_BUNDLES, {
    enumOptions: enumOptions(['like-new', 'good']),
  }),
  field('conditionDetails', 'text', true, BUNDLES),
  field('color', 'enum', false, null, { enumOptions: enumOptions(['black', 'blue']) }),
  field('brand', 'text', false, null),
  field('careInstructions', 'text', false, ['women-tops', 'men-tops', 'kids-tops', ...BUNDLES]),
];

const sub = id => ({ id, name: id, subcategories: [] });
const categories = [
  {
    id: 'women',
    name: 'Women',
    subcategories: [
      sub('women-tops'),
      sub('women-bottoms'),
      sub('women-shoes'),
      sub('women-bundles'),
    ],
  },
  {
    id: 'men',
    name: 'Men',
    subcategories: [sub('men-tops'), sub('men-bottoms'), sub('men-shoes'), sub('men-bundles')],
  },
  {
    id: 'kids',
    name: 'Kids',
    subcategories: [sub('kids-tops'), sub('kids-bottoms'), sub('kids-shoes'), sub('kids-bundles')],
  },
  { id: 'accessories', name: 'Accessories' },
];

const listingTypes = [{ id: 'sell-used-products' }, { id: 'in-search-of-clothing' }];

const ASSETS = {
  'listings/listing-fields.json': { listingFields },
  'listings/listing-categories.json': { categories },
  'listings/listing-types.json': { listingTypes },
};

const fakeSdk = () => {
  const calls = [];
  return {
    calls,
    assetByAlias: params => {
      calls.push(params);
      return Promise.resolve({ data: { data: ASSETS[params.path], meta: { version: 'v1' } } });
    },
  };
};

const config = { listingFields, categories, listingTypes };

// { key: required } for the fields that apply to a category.
const fieldMap = categoryId =>
  Object.fromEntries(fieldsForCategory(config, categoryId).map(f => [f.key, f.required]));

describe('loadMarketplaceConfig', () => {
  it('fetches the three assets with the latest alias', async () => {
    const sdk = fakeSdk();
    const result = await loadMarketplaceConfig(sdk);

    expect(sdk.calls).toEqual([
      { path: 'listings/listing-fields.json', alias: 'latest' },
      { path: 'listings/listing-categories.json', alias: 'latest' },
      { path: 'listings/listing-types.json', alias: 'latest' },
    ]);
    expect(result).toEqual(config);
  });

  it('rejects when an asset is missing its array', async () => {
    const sdk = { assetByAlias: () => Promise.resolve({ data: { data: {} } }) };
    await expect(loadMarketplaceConfig(sdk)).rejects.toThrow('listing-fields.json');
  });
});

describe('validCategoryPairs', () => {
  it('lists level1 + level2 pairs and top-level categories without subcategories', () => {
    const pairs = validCategoryPairs(config);

    expect(pairs).toHaveLength(13);
    expect(pairs).toContainEqual({ level1: 'men', level2: 'men-shoes' });
    expect(pairs).toContainEqual({ level1: 'kids', level2: 'kids-bundles' });
    expect(pairs).toContainEqual({ level1: 'accessories' });
    expect(pairs).not.toContainEqual({ level1: 'men' });
  });
});

describe('fieldsForCategory', () => {
  it('adult top: size and condition required; no shoe or kids size', () => {
    expect(fieldMap('men-tops')).toEqual({
      size: true,
      condition: true,
      color: false,
      brand: false,
      careInstructions: false,
    });
  });

  it('adult shoe: shoeSize and condition required; no clothing size or care instructions', () => {
    expect(fieldMap('women-shoes')).toEqual({
      shoeSize: true,
      condition: true,
      color: false,
      brand: false,
    });
  });

  it("kids' top: kidsSize required; no adult size", () => {
    expect(fieldMap('kids-tops')).toEqual({
      kidsSize: true,
      condition: true,
      color: false,
      brand: false,
      careInstructions: false,
    });
  });

  it('bundle: conditionDetails required; no condition or sizes', () => {
    expect(fieldMap('men-bundles')).toEqual({
      conditionDetails: true,
      color: false,
      brand: false,
      careInstructions: false,
    });
  });

  it('top-level accessories: only the fields for all categories, all optional', () => {
    expect(fieldMap('accessories')).toEqual({ color: false, brand: false });
  });

  it('returns key, schemaType, required, enumOptions and label', () => {
    const size = fieldsForCategory(config, 'men-tops').find(f => f.key === 'size');
    expect(size).toEqual({
      key: 'size',
      schemaType: 'enum',
      required: true,
      enumOptions: enumOptions(['s', 'm', 'l']),
      label: 'size label',
    });
    const brand = fieldsForCategory(config, 'men-tops').find(f => f.key === 'brand');
    expect(brand.enumOptions).toBeNull();
  });

  it('applies a field limited to a parent category to its subcategories', () => {
    const withParentField = {
      ...config,
      listingFields: [field('kidsOnly', 'text', false, ['kids'])],
    };
    expect(fieldsForCategory(withParentField, 'kids-shoes').map(f => f.key)).toEqual(['kidsOnly']);
    expect(fieldsForCategory(withParentField, 'men-shoes')).toEqual([]);
  });

  it('throws for an unknown category', () => {
    expect(() => fieldsForCategory(config, 'pets')).toThrow('Unknown category pets');
  });
});
