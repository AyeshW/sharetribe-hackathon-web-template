const { validateListing } = require('./validate');

// A trimmed copy of the live hosted config.
const enumOptions = options => options.map(option => ({ option, label: option }));
const field = (key, schemaType, isRequired, categoryIds, extra = {}) => ({
  key,
  scope: 'public',
  schemaType,
  saveConfig: { isRequired },
  categoryConfig: categoryIds
    ? { limitToCategoryIds: true, categoryIds }
    : { limitToCategoryIds: false },
  listingTypeConfig: { limitToListingTypeIds: false },
  ...extra,
});

const config = {
  listingFields: [
    field('size', 'enum', true, ['women-tops', 'men-tops'], {
      enumOptions: enumOptions(['s', 'm']),
    }),
    field('shoeSize', 'enum', true, ['men-shoes'], { enumOptions: enumOptions(['38', '42']) }),
    field('kidsSize', 'enum', true, ['kids-tops'], { enumOptions: enumOptions(['5y', '6y']) }),
    field(
      'condition',
      'enum',
      true,
      ['women-tops', 'men-tops', 'men-shoes', 'kids-tops', 'men-accessories'],
      {
        enumOptions: enumOptions(['like-new', 'gently-used']),
      }
    ),
    field('conditionDetails', 'text', true, ['women-bundles']),
    field('color', 'enum', false, null, { enumOptions: enumOptions(['black', 'blue']) }),
    field('brand', 'text', false, null),
    field('sizeDetails', 'text', false, null, {
      listingTypeConfig: { limitToListingTypeIds: true, listingTypeIds: ['sell-used-products'] },
    }),
    field('requestNotes', 'text', false, null, {
      listingTypeConfig: { limitToListingTypeIds: true, listingTypeIds: ['in-search-of-clothing'] },
    }),
  ],
  categories: [
    { id: 'women', subcategories: [{ id: 'women-tops' }, { id: 'women-bundles' }] },
    {
      id: 'men',
      subcategories: [{ id: 'men-tops' }, { id: 'men-shoes' }, { id: 'men-accessories' }],
    },
    { id: 'kids', subcategories: [{ id: 'kids-tops' }] },
    { id: 'accessories' },
  ],
  listingTypes: [{ id: 'sell-used-products' }],
};

const listing = (publicData, extra = {}) => ({
  key: 'test',
  title: 'A title',
  description: 'A description',
  priceEur: 20,
  publicData,
  ...extra,
});

const VALID = {
  adultTop: listing({
    categoryLevel1: 'men',
    categoryLevel2: 'men-tops',
    size: 'm',
    condition: 'like-new',
    color: 'blue',
  }),
  adultShoe: listing({
    categoryLevel1: 'men',
    categoryLevel2: 'men-shoes',
    shoeSize: '42',
    condition: 'gently-used',
  }),
  kidsTop: listing({
    categoryLevel1: 'kids',
    categoryLevel2: 'kids-tops',
    kidsSize: '5y',
    condition: 'like-new',
  }),
  bundle: listing({
    categoryLevel1: 'women',
    categoryLevel2: 'women-bundles',
    conditionDetails: 'All fine.',
  }),
  topLevelAccessory: listing({ categoryLevel1: 'accessories', brand: 'Marimekko' }),
};

describe('validateListing', () => {
  it.each(Object.entries(VALID))('accepts a valid %s', (name, l) => {
    expect(validateListing(l, config)).toEqual([]);
  });

  it('accepts an image with file and credit, and no image at all', () => {
    const image = {
      file: 'seed/images/test.jpg',
      pixabayUser: 'someone',
      pixabayUrl: 'https://pixabay.com/x',
    };
    expect(validateListing({ ...VALID.adultTop, image }, config)).toEqual([]);
    expect(validateListing(VALID.adultTop, config)).toEqual([]);
  });

  it('rejects an unknown category pair', () => {
    const l = listing({
      categoryLevel1: 'women',
      categoryLevel2: 'men-tops',
      size: 'm',
      condition: 'like-new',
    });
    expect(validateListing(l, config)).toEqual([
      'category women / men-tops is not a valid category',
    ]);
  });

  it('rejects a top-level category with subcategories used on its own', () => {
    expect(validateListing(listing({ categoryLevel1: 'men' }), config)).toEqual([
      'category men is not a valid category',
    ]);
  });

  it('reports each missing required field', () => {
    const l = listing({ categoryLevel1: 'men', categoryLevel2: 'men-tops' });
    expect(validateListing(l, config)).toEqual([
      'required field size is missing',
      'required field condition is missing',
    ]);
  });

  it('rejects a field from another category', () => {
    const l = { ...VALID.adultShoe, publicData: { ...VALID.adultShoe.publicData, size: 'm' } };
    expect(validateListing(l, config)).toEqual([
      'field size does not belong to category men-shoes',
    ]);
  });

  it('rejects condition on a bundle', () => {
    const l = {
      ...VALID.bundle,
      publicData: { ...VALID.bundle.publicData, condition: 'like-new' },
    };
    expect(validateListing(l, config)).toEqual([
      'field condition does not belong to category women-bundles',
    ]);
  });

  it('rejects a field limited to another listing type', () => {
    const l = {
      ...VALID.adultTop,
      publicData: { ...VALID.adultTop.publicData, requestNotes: 'x' },
    };
    expect(validateListing(l, config)).toEqual([
      'field requestNotes does not belong to category men-tops',
    ]);
  });

  it('rejects a key that is not a listing field', () => {
    const l = {
      ...VALID.adultTop,
      publicData: { ...VALID.adultTop.publicData, listingType: 'sell-used-products' },
    };
    expect(validateListing(l, config)).toEqual(['field listingType is not a listing field']);
  });

  it('rejects an enum value that is not an option', () => {
    const l = { ...VALID.adultTop, publicData: { ...VALID.adultTop.publicData, color: 'beige' } };
    expect(validateListing(l, config)).toEqual([
      'field color has value "beige", allowed: black, blue',
    ]);
  });

  it('rejects a text field that is not a string', () => {
    const l = {
      ...VALID.topLevelAccessory,
      publicData: { ...VALID.topLevelAccessory.publicData, brand: 7 },
    };
    expect(validateListing(l, config)).toEqual(['field brand must be text']);
  });

  it.each([0, 0.5, 501, '20', undefined])('rejects price %p', priceEur => {
    expect(validateListing({ ...VALID.adultTop, priceEur }, config)).toEqual([
      `priceEur must be a number from 1 to 500, got ${priceEur}`,
    ]);
  });

  it('accepts the price limits 1 and 500', () => {
    expect(validateListing({ ...VALID.adultTop, priceEur: 1 }, config)).toEqual([]);
    expect(validateListing({ ...VALID.adultTop, priceEur: 500 }, config)).toEqual([]);
  });

  it('rejects a missing title and description', () => {
    expect(
      validateListing({ ...VALID.adultTop, title: ' ', description: undefined }, config)
    ).toEqual(['title is missing', 'description is missing']);
  });

  it('rejects an image without its credit', () => {
    const image = { file: 'seed/images/test.jpg' };
    expect(validateListing({ ...VALID.adultTop, image }, config)).toEqual([
      'image.pixabayUser is missing',
      'image.pixabayUrl is missing',
    ]);
  });
});
