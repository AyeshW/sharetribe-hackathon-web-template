const { buildQueryParams, fetchAllListings } = require('./query');
const { config, listing, fakeSdk, filter, state } = require('./test-data');

const IMAGE = { variantPrefix: 'listing-card', aspectWidth: 1, aspectHeight: 1 };
const user = (key, value, overrides) => filter(key, value, { source: 'user', ...overrides });

// Only the filter params, without listing type, include and image params.
const filterParamsOf = filters => {
  const params = buildQueryParams(state(filters), IMAGE, config);
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => key === 'price' || /^pub_(?!listingType)/.test(key))
  );
};

describe('buildQueryParams', () => {
  it('always queries sell listings with authors and one image in the card variants', () => {
    const params = buildQueryParams(state([]), IMAGE, config);
    expect(params).toEqual({
      pub_listingType: 'sell-used-products',
      include: ['author', 'images'],
      'fields.user': ['profile.displayName', 'profile.abbreviatedName'],
      'fields.image': [
        'variants.scaled-small',
        'variants.scaled-medium',
        'variants.listing-card',
        'variants.listing-card-2x',
      ],
      'imageVariant.listing-card': 'w:400;h:400;fit:crop',
      'imageVariant.listing-card-2x': 'w:800;h:800;fit:crop',
      'limit.images': 1,
      perPage: 100,
    });
  });

  it('builds the image variants from the request aspect ratio and prefix', () => {
    const params = buildQueryParams(
      state([]),
      { variantPrefix: 'tall', aspectWidth: 2, aspectHeight: 3 },
      config
    );
    expect(params['imageVariant.tall']).toBe('w:400;h:600;fit:crop');
    expect(params['imageVariant.tall-2x']).toBe('w:800;h:1200;fit:crop');
    expect(params['fields.image']).toContain('variants.tall-2x');
  });

  it.each([
    ['categoryLevel1', 'men'],
    ['categoryLevel2', 'men-shoes'],
    ['size', 'l'],
    ['shoeSize', '38'],
    ['kidsSize', '5y'],
    ['color', 'black'],
    ['condition', 'like-new'],
    ['petFreeHome', 'yes'],
    ['smokeFreeHome', 'yes'],
  ])('sends a user %s filter as pub_%s', (key, value) => {
    expect(filterParamsOf([user(key, value)])).toEqual({ [`pub_${key}`]: value });
  });

  it('sends an in filter comma-separated', () => {
    expect(filterParamsOf([user('size', ['m', 'l'], { op: 'in' })])).toEqual({ pub_size: 'm,l' });
  });

  it('rewrites categoryLevel2 notIn as in over every other subcategory', () => {
    const noBundles = user('categoryLevel2', ['women-bundles', 'men-bundles', 'kids-bundles'], {
      op: 'notIn',
    });
    const sent = filterParamsOf([noBundles]).pub_categoryLevel2.split(',');
    expect(sent).toEqual([
      'women-tops',
      'women-bottoms',
      'women-shoes',
      'women-accessories',
      'men-tops',
      'men-bottoms',
      'men-shoes',
      'men-accessories',
      'kids-tops',
      'kids-bottoms',
      'kids-shoes',
      'kids-accessories',
    ]);
  });

  it.each([
    [{ min: 1000, max: 6000 }, '1000,6001'],
    [{ max: 6000 }, ',6001'],
    [{ min: 1000 }, '1000,'],
  ])('sends price %j as price=%s (exclusive upper bound)', (value, expected) => {
    expect(filterParamsOf([user('price', value)])).toEqual({ price: expected });
  });

  it('never sends brand or shippingEnabled', () => {
    expect(
      filterParamsOf([user('brand', 'Nike'), filter('shippingEnabled', true, { locked: true })])
    ).toEqual({});
  });

  it('sends locked inferred filters but not unlocked inferred or soft ones', () => {
    const filters = [
      filter('size', 'l'),
      filter('color', 'black', { mode: 'soft' }),
      filter('price', { max: 4000 }, { locked: true }),
      filter('condition', 'like-new', { locked: true }),
    ];
    expect(filterParamsOf(filters)).toEqual({ price: ',4001', pub_condition: 'like-new' });
  });
});

describe('fetchAllListings', () => {
  it('reads every result page and merges included entities once each', async () => {
    const shared = 'same-author';
    const listings = ['a', 'b', 'c', 'd', 'e'].map(id => listing({ id, authorId: shared }));
    const sdk = fakeSdk(listings, { pageSize: 2 });

    const result = await fetchAllListings(sdk, { pub_listingType: 'sell-used-products' });

    expect(sdk.listings.query).toHaveBeenCalledTimes(3);
    expect(sdk.listings.query.mock.calls.map(([params]) => params.page)).toEqual([1, 2, 3]);
    expect(sdk.listings.query.mock.calls[0][0].pub_listingType).toBe('sell-used-products');
    expect(result.listings.map(l => l.id.uuid)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // 5 images + 1 shared author
    expect(result.included.size).toBe(6);
    expect(result.included.has(`user/${shared}`)).toBe(true);
  });

  it('passes an SDK failure on', async () => {
    const sdk = fakeSdk([], { fail: new Error('boom') });
    await expect(fetchAllListings(sdk, {})).rejects.toThrow('boom');
  });
});
