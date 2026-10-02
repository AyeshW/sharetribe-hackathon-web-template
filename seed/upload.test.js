const fs = require('fs');
const os = require('os');
const path = require('path');
const { types } = require('sharetribe-flex-integration-sdk');
const { runUpload, buildCreateParams } = require('./upload');
const { runClose } = require('./close-seeded');

const config = {
  listingFields: [
    {
      key: 'size',
      schemaType: 'enum',
      saveConfig: { isRequired: true },
      categoryConfig: { limitToCategoryIds: true, categoryIds: ['men-tops'] },
      enumOptions: [{ option: 'm' }],
    },
    {
      key: 'condition',
      schemaType: 'enum',
      saveConfig: { isRequired: true },
      categoryConfig: { limitToCategoryIds: true, categoryIds: ['men-tops'] },
      enumOptions: [{ option: 'like-new' }],
    },
  ],
  categories: [{ id: 'men', subcategories: [{ id: 'men-tops' }] }],
  listingTypes: [{ id: 'sell-used-products' }],
};

const AUTHORS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const publicData = {
  categoryLevel1: 'men',
  categoryLevel2: 'men-tops',
  size: 'm',
  condition: 'like-new',
};

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-upload-'));
  fs.mkdirSync(path.join(root, 'seed', 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'seed', 'images', 'a.jpg'), 'jpg');
  return root;
};

const plan = {
  listings: [
    {
      key: 'a',
      title: 'Shirt A',
      description: 'Desc A',
      priceEur: 12.5,
      publicData,
      author: 1,
      image: { file: 'seed/images/a.jpg', pixabayUser: 'u', pixabayUrl: 'https://pixabay.com/a' },
    },
    { key: 'b', title: 'Shirt B', description: 'Desc B', priceEur: 8, publicData, author: 0 },
  ],
};

// Fake Integration SDK that records every call. The failAt-th call of failOn rejects.
const fakeSdk = ({ failOn, failAt = 1 } = {}) => {
  const calls = [];
  let n = 0;
  const call = (name, result) => params => {
    calls.push({ name, params });
    if (name === failOn && calls.filter(c => c.name === name).length === failAt) {
      return Promise.reject(new Error(`${name} failed`));
    }
    return Promise.resolve({ data: { data: result() } });
  };
  return {
    calls,
    images: { upload: call('images.upload', () => ({ id: new types.UUID(`img-${++n}`) })) },
    listings: {
      create: call('listings.create', () => ({ id: new types.UUID(`listing-${++n}`) })),
      show: call('listings.show', () => ({
        attributes: { metadata: { seeded: true }, state: 'published' },
      })),
      close: call('listings.close', () => ({})),
    },
    stock: { compareAndSet: call('stock.compareAndSet', () => ({})) },
  };
};

const options = (root, extra = {}) => {
  const saved = [];
  return {
    saved,
    opts: {
      plan,
      config,
      authorIds: AUTHORS,
      uploaded: {},
      saveUploaded: u => saved.push({ ...u }),
      root,
      log: () => {},
      ...extra,
    },
  };
};

describe('runUpload', () => {
  it('dry run makes zero SDK calls and saves nothing', async () => {
    const sdk = fakeSdk();
    const { saved, opts } = options(makeRoot(), { confirm: false });
    const result = await runUpload(sdk, opts);
    expect(sdk.calls).toEqual([]);
    expect(saved).toEqual([]);
    expect(result).toEqual({ created: 0, skipped: 0 });
  });

  it('--confirm uploads the image, creates the listing, then sets stock to 1', async () => {
    const root = makeRoot();
    const sdk = fakeSdk();
    const { saved, opts } = options(root, { confirm: true });
    await runUpload(sdk, opts);

    expect(sdk.calls.map(c => c.name)).toEqual([
      'images.upload',
      'listings.create',
      'stock.compareAndSet',
      'listings.create',
      'stock.compareAndSet',
    ]);
    expect(sdk.calls[0].params).toEqual({ image: path.join(root, 'seed/images/a.jpg') });

    const created = sdk.calls[1].params;
    expect(created.authorId).toEqual(new types.UUID(AUTHORS[1]));
    expect(created.state).toBe('published');
    expect(created.price).toEqual(new types.Money(1250, 'EUR'));
    expect(created.images).toEqual([new types.UUID('img-1')]);
    expect(created.metadata).toEqual({ seeded: true, seedKey: 'a' });
    expect(created.publicData).toMatchObject({
      ...publicData,
      listingType: 'sell-used-products',
      transactionProcessAlias: 'default-purchase/release-1',
      unitType: 'item',
      pickupEnabled: true,
      shippingEnabled: true,
      shippingPriceInSubunitsOneItem: 500,
    });
    expect(created.publicData.location.address).toMatch(/Espoo|Helsinki|Vantaa/);
    expect(created.geolocation).toBeInstanceOf(types.LatLng);

    expect(sdk.calls[2].params).toEqual({
      listingId: new types.UUID('listing-2'),
      oldTotal: null,
      newTotal: 1,
    });
    expect(sdk.calls[3].params.images).toBeUndefined(); // listing b has no photo
    expect(saved).toEqual([{ a: 'listing-2' }, { a: 'listing-2', b: 'listing-3' }]);
  });

  it('skips keys that are already uploaded', async () => {
    const sdk = fakeSdk();
    const { opts } = options(makeRoot(), { confirm: true, uploaded: { a: 'old-id' } });
    const result = await runUpload(sdk, opts);
    expect(result).toEqual({ created: 1, skipped: 1 });
    expect(sdk.calls.map(c => c.name)).toEqual(['listings.create', 'stock.compareAndSet']);
    expect(sdk.calls[0].params.metadata.seedKey).toBe('b');
  });

  it('stops at the first error and keeps the progress made before it', async () => {
    const sdk = fakeSdk({ failOn: 'listings.create', failAt: 2 });
    const { saved, opts } = options(makeRoot(), { confirm: true });
    await expect(runUpload(sdk, opts)).rejects.toThrow('listings.create failed');
    // a was created and recorded; b failed, so it has no stock call and is not recorded
    expect(sdk.calls.map(c => c.name)).toEqual([
      'images.upload',
      'listings.create',
      'stock.compareAndSet',
      'listings.create',
    ]);
    expect(saved).toEqual([{ a: 'listing-2' }]);
    expect(opts.uploaded).toEqual({ a: 'listing-2' });
  });

  it('refuses to upload anything when a listing is invalid', async () => {
    const sdk = fakeSdk();
    const bad = {
      listings: [
        { ...plan.listings[1], publicData: { categoryLevel1: 'men', categoryLevel2: 'men-tops' } },
      ],
    };
    const { opts } = options(makeRoot(), { confirm: true, plan: bad });
    await expect(runUpload(sdk, opts)).rejects.toThrow('validation errors');
    expect(sdk.calls).toEqual([]);
  });

  it('refuses an author index without an id in SEED_AUTHOR_IDS', async () => {
    const sdk = fakeSdk();
    const bad = { listings: [{ ...plan.listings[1], author: 5 }] };
    const { opts } = options(makeRoot(), { confirm: false, plan: bad });
    await expect(runUpload(sdk, opts)).rejects.toThrow('validation errors');
    expect(sdk.calls).toEqual([]);
  });
});

describe('buildCreateParams', () => {
  it('rounds the price to cents and leaves out images when there is none', () => {
    const params = buildCreateParams(
      { ...plan.listings[1], priceEur: 9.99 },
      { authorId: AUTHORS[0], location: { address: 'X 1, Espoo', lat: 60, lng: 24 }, imageId: null }
    );
    expect(params.price).toEqual(new types.Money(999, 'EUR'));
    expect(params).not.toHaveProperty('images');
    expect(params.publicData.location).toEqual({ address: 'X 1, Espoo', building: '' });
  });
});

describe('runClose', () => {
  it('dry run makes zero SDK calls', async () => {
    const sdk = fakeSdk();
    await runClose(sdk, { uploaded: { a: AUTHORS[0] }, confirm: false, log: () => {} });
    expect(sdk.calls).toEqual([]);
  });

  it('--confirm closes seeded listings only', async () => {
    const sdk = fakeSdk();
    const result = await runClose(sdk, {
      uploaded: { a: AUTHORS[0] },
      confirm: true,
      log: () => {},
    });
    expect(sdk.calls.map(c => c.name)).toEqual(['listings.show', 'listings.close']);
    expect(result).toEqual({ closed: 1 });

    const notSeeded = fakeSdk();
    notSeeded.listings.show = () =>
      Promise.resolve({ data: { data: { attributes: { metadata: {}, state: 'published' } } } });
    await expect(
      runClose(notSeeded, { uploaded: { a: AUTHORS[0] }, confirm: true, log: () => {} })
    ).rejects.toThrow('not a seeded listing');
    expect(notSeeded.calls).toEqual([]);
  });
});
