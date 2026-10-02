const { types } = require('sharetribe-flex-integration-sdk');
const {
  contentHash,
  buildEmbeddingText,
  fetchListings,
  usableVectors,
  estimateCallCost,
  runIndex,
  parseLimit,
} = require('./build');

const { UUID, Money } = types;

const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
const config = {
  listingFields: [{ key: 'color', schemaType: 'enum', enumOptions: [{ option: 'brown' }] }],
  categories: [],
  listingTypes: [],
};

const tags = {
  garmentType: 'bomber jacket',
  synonyms: ['jacket', 'coat'],
  audience: 'adult',
  colorDetected: ['brown'],
  pattern: 'solid',
  materialLook: 'suede',
  style: ['vintage'],
  season: ['autumn'],
  warmth: 'medium',
  occasion: ['everyday'],
  fit: 'regular',
  brand: '',
  visibleWear: 'light',
  photoMatchesText: { match: 'yes', note: '' },
  searchText: 'A brown jacket for autumn.',
};

const makeListing = (id, { listingType = 'sell-used-products', metadata, imageId } = {}) => ({
  id: new UUID(id),
  type: 'listing',
  attributes: {
    title: `Title ${id}`,
    description: `Description ${id}`,
    price: new Money(3500, 'EUR'),
    state: 'published',
    publicData: { listingType, categoryLevel1: 'women', color: 'brown' },
    metadata: metadata || { seeded: true, seedKey: `key-${id}` },
  },
  relationships: { images: { data: imageId ? [{ id: new UUID(imageId), type: 'image' }] : [] } },
});

const imageEntity = id => ({
  id: new UUID(id),
  type: 'image',
  attributes: { variants: { 'scaled-medium': { url: `https://img.example/${id}` } } },
});

// Fake Integration SDK. listings.update merges metadata on the top level like the real API.
const fakeSdk = (listings, { perPage = 100 } = {}) => {
  const queries = [];
  const updates = [];
  return {
    queries,
    updates,
    listings: {
      query: async params => {
        queries.push(params);
        const start = (params.page - 1) * perPage;
        const page = listings.slice(start, start + perPage);
        const imageIds = page.flatMap(l => l.relationships.images.data.map(i => i.id.uuid));
        return {
          data: {
            data: page,
            included: imageIds.map(imageEntity),
            meta: {
              totalPages: Math.max(1, Math.ceil(listings.length / perPage)),
              page: params.page,
            },
          },
        };
      },
      update: async params => {
        updates.push(params);
        const listing = listings.find(l => l.id.uuid === params.id.uuid);
        listing.attributes.metadata = { ...listing.attributes.metadata, ...params.metadata };
        return { data: { data: { id: params.id } } };
      },
    },
  };
};

const fakeAnthropic = ({ failFor = [] } = {}) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async params => {
        calls.push(params);
        const text = params.messages[0].content.find(b => b.type === 'text').text;
        if (failFor.some(id => text.includes(`Title ${id}`))) {
          throw new Error('overloaded');
        }
        return {
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(tags) }],
          usage: { input_tokens: 2000, output_tokens: 300 },
        };
      },
    },
  };
};

const fakeEmbedder = () => {
  const texts = [];
  const createEmbedder = jest.fn(async () => ({
    model: EMBED_MODEL,
    dim: 384,
    embedListing: async text => {
      texts.push(text);
      return [0.6, 0.8];
    },
  }));
  return { texts, createEmbedder };
};

const setup = (listings, overrides = {}) => {
  const integrationSdk = fakeSdk(listings);
  const anthropic = fakeAnthropic(overrides.anthropic);
  const embedder = fakeEmbedder();
  const saved = { vectors: [], preview: [] };
  const options = {
    config,
    vectors: null,
    confirm: false,
    limit: null,
    log: () => {},
    askYes: jest.fn(async () => true),
    saveVectors: v => saved.vectors.push(JSON.parse(JSON.stringify(v))),
    savePreview: p => saved.preview.push(p),
    logUsage: jest.fn(),
    ...overrides.options,
  };
  const run = () =>
    runIndex({ integrationSdk, anthropic, createEmbedder: embedder.createEmbedder }, options);
  return { integrationSdk, anthropic, embedder, saved, options, run };
};

const ids = n =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('contentHash', () => {
  const base = makeListing('l1');

  it('is stable, including for publicData key order', () => {
    const reordered = makeListing('l1');
    reordered.attributes.publicData = {
      color: 'brown',
      categoryLevel1: 'women',
      listingType: 'sell-used-products',
    };
    expect(contentHash(base, 'img1')).toBe(contentHash(makeListing('l1'), 'img1'));
    expect(contentHash(reordered, 'img1')).toBe(contentHash(base, 'img1'));
    expect(contentHash(base, 'img1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts nested publicData keys too', () => {
    const a = makeListing('l1');
    const b = makeListing('l1');
    a.attributes.publicData.location = { address: 'X', building: '' };
    b.attributes.publicData.location = { building: '', address: 'X' };
    expect(contentHash(a, 'img1')).toBe(contentHash(b, 'img1'));
  });

  it('changes with each input', () => {
    const original = contentHash(base, 'img1');
    const changed = change => {
      const l = makeListing('l1');
      change(l.attributes);
      return contentHash(l, 'img1');
    };
    expect(changed(a => (a.title = 'Other'))).not.toBe(original);
    expect(changed(a => (a.description = 'Other'))).not.toBe(original);
    expect(changed(a => (a.price = new Money(3600, 'EUR')))).not.toBe(original);
    expect(changed(a => (a.price = new Money(3500, 'USD')))).not.toBe(original);
    expect(changed(a => (a.price = null))).not.toBe(original);
    expect(changed(a => (a.publicData.color = 'black'))).not.toBe(original);
    expect(changed(a => (a.publicData.brand = 'Zara'))).not.toBe(original);
    expect(contentHash(base, 'img2')).not.toBe(original);
    expect(contentHash(base, null)).not.toBe(original);
  });

  it('ignores metadata, so writing tags does not change the hash', () => {
    const l = makeListing('l1');
    l.attributes.metadata = { ai: tags, aiContentHash: 'x' };
    expect(contentHash(l, 'img1')).toBe(contentHash(base, 'img1'));
  });
});

describe('buildEmbeddingText', () => {
  it('joins title, description, garment type, synonyms, style, season and searchText', () => {
    const text = buildEmbeddingText(makeListing('l1'), {
      ...tags,
      style: ['vintage', 'casual'],
      season: ['autumn', 'winter'],
    });
    expect(text).toBe(
      [
        'Title l1',
        'Description l1',
        'bomber jacket',
        'jacket, coat',
        'vintage, casual',
        'autumn, winter',
        'A brown jacket for autumn.',
      ].join('\n')
    );
  });

  it('leaves out empty parts', () => {
    const text = buildEmbeddingText(makeListing('l1'), {
      ...tags,
      garmentType: '',
      synonyms: [],
      style: [],
      season: [],
      searchText: '',
    });
    expect(text).toBe('Title l1\nDescription l1');
  });
});

describe('fetchListings', () => {
  it('queries published listings with images, keeps sell-used-products only, all pages', async () => {
    const [a, b, c] = ids(3);
    const sdk = fakeSdk(
      [
        makeListing(a, { imageId: 'aaaaaaaa-0000-4000-8000-000000000001' }),
        makeListing(b, { listingType: 'in-search-of-clothing' }),
        makeListing(c),
      ],
      { perPage: 2 }
    );
    const result = await fetchListings(sdk);

    expect(sdk.queries).toHaveLength(2);
    expect(sdk.queries[0]).toEqual({
      states: ['published'],
      include: ['images'],
      'fields.image': ['variants.scaled-medium'],
      perPage: 100,
      page: 1,
    });
    expect(result.map(r => r.listing.id.uuid)).toEqual([a, c]);
    expect(result[0].imageId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(result[0].imageUrl).toBe('https://img.example/aaaaaaaa-0000-4000-8000-000000000001');
    expect(result[1]).toMatchObject({ imageId: null, imageUrl: null });
  });
});

describe('runIndex skip logic', () => {
  const [id] = ids(1);
  const hashOf = listing => contentHash(listing, null);

  it('skips a listing whose metadata hash and vector hash match for the same model', async () => {
    const listing = makeListing(id);
    const hash = hashOf(listing);
    listing.attributes.metadata.aiContentHash = hash;
    const vectors = { model: EMBED_MODEL, dim: 384, listings: { [id]: { hash, vector: [1] } } };
    const { run, anthropic, embedder } = setup([listing], { options: { vectors } });

    const summary = await run();
    expect(summary).toMatchObject({ total: 1, skipped: 1, enriched: 0 });
    expect(anthropic.calls).toHaveLength(0);
    expect(embedder.createEmbedder).not.toHaveBeenCalled();
  });

  it('re-indexes when the vector is missing', async () => {
    const listing = makeListing(id);
    listing.attributes.metadata.aiContentHash = hashOf(listing);
    const vectors = { model: EMBED_MODEL, dim: 384, listings: {} };
    const { run, anthropic } = setup([listing], { options: { vectors } });
    await run();
    expect(anthropic.calls).toHaveLength(1);
  });

  it('re-indexes when the vector was made by another model', async () => {
    const listing = makeListing(id);
    const hash = hashOf(listing);
    listing.attributes.metadata.aiContentHash = hash;
    const vectors = { model: 'other-model', dim: 384, listings: { [id]: { hash, vector: [1] } } };
    const { run, anthropic } = setup([listing], { options: { vectors } });
    await run();
    expect(anthropic.calls).toHaveLength(1);
  });

  it('re-indexes when the content changed since the last run', async () => {
    const listing = makeListing(id);
    listing.attributes.metadata.aiContentHash = 'old';
    const vectors = {
      model: EMBED_MODEL,
      dim: 384,
      listings: { [id]: { hash: 'old', vector: [1] } },
    };
    const { run, anthropic } = setup([listing], { options: { vectors } });
    await run();
    expect(anthropic.calls).toHaveLength(1);
  });
});

describe('runIndex preview (no --confirm)', () => {
  it('makes zero Sharetribe writes, leaves vectors.json alone and writes the preview', async () => {
    const [a, b] = ids(2);
    const { run, integrationSdk, saved, embedder } = setup([makeListing(a), makeListing(b)]);
    const summary = await run();

    expect(integrationSdk.updates).toHaveLength(0);
    expect(saved.vectors).toHaveLength(0);
    expect(saved.preview).toHaveLength(1);
    expect(saved.preview[0].map(p => p.id)).toEqual([a, b]);
    expect(saved.preview[0][0]).toMatchObject({
      seedKey: `key-${a}`,
      title: `Title ${a}`,
      imageUrl: null,
      tags: {
        ...tags,
        photoMatchesText: { match: 'no', note: 'No photo.' },
        visibleWear: 'unknown',
      },
      embeddingText: buildEmbeddingText(makeListing(a), tags),
    });
    expect(embedder.texts).toEqual([
      buildEmbeddingText(makeListing(a), tags),
      buildEmbeddingText(makeListing(b), tags),
    ]);
    expect(summary).toMatchObject({ enriched: 2, written: 0, failed: 0 });
  });

  it('applies --limit to the listings that need indexing', async () => {
    const { run, anthropic, saved } = setup(ids(4).map(i => makeListing(i)), {
      options: { limit: 3 },
    });
    await run();
    expect(anthropic.calls).toHaveLength(3);
    expect(saved.preview[0]).toHaveLength(3);
  });
});

describe('runIndex --confirm', () => {
  it('writes only the AI keys, so existing metadata keys are kept', async () => {
    const [a] = ids(1);
    const imageId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const listing = makeListing(a, {
      metadata: { seeded: true, seedKey: 'suede-jacket' },
      imageId,
    });
    const hash = contentHash(listing, imageId);
    const { run, integrationSdk } = setup([listing], { options: { confirm: true } });
    await run();

    expect(integrationSdk.updates).toHaveLength(1);
    const update = integrationSdk.updates[0];
    expect(update.id).toEqual(new UUID(a));
    expect(Object.keys(update)).toEqual(['id', 'metadata']);
    expect(update.metadata).toEqual({ ai: tags, aiContentHash: hash, aiModel: 'claude-haiku-4-5' });
    expect(listing.attributes.metadata).toEqual({
      seeded: true,
      seedKey: 'suede-jacket',
      ai: tags,
      aiContentHash: hash,
      aiModel: 'claude-haiku-4-5',
    });
  });

  it('writes vectors.json as { model, dim, listings: { id: { hash, vector } } }', async () => {
    const [a, b] = ids(2);
    const listings = [makeListing(a), makeListing(b)];
    const { run, saved } = setup(listings, { options: { confirm: true } });
    await run();

    expect(saved.vectors).toHaveLength(2);
    expect(saved.vectors[1]).toEqual({
      model: EMBED_MODEL,
      dim: 384,
      listings: {
        [a]: { hash: contentHash(listings[0], null), vector: [0.6, 0.8] },
        [b]: { hash: contentHash(listings[1], null), vector: [0.6, 0.8] },
      },
    });
  });

  it('keeps vectors of other listings from earlier runs', async () => {
    const [a] = ids(1);
    const vectors = {
      model: EMBED_MODEL,
      dim: 384,
      listings: { other: { hash: 'h', vector: [1] } },
    };
    const { run, saved } = setup([makeListing(a)], { options: { confirm: true, vectors } });
    await run();
    expect(Object.keys(saved.vectors[0].listings)).toEqual(['other', a]);
  });

  it('continues after a Claude failure and writes nothing for the failed listing', async () => {
    const [a, b] = ids(2);
    const { run, integrationSdk, saved } = setup([makeListing(a), makeListing(b)], {
      anthropic: { failFor: [a] },
      options: { confirm: true },
    });
    const summary = await run();
    expect(summary).toMatchObject({ enriched: 1, failed: 1, written: 1 });
    expect(integrationSdk.updates.map(u => u.id.uuid)).toEqual([b]);
    expect(Object.keys(saved.vectors[0].listings)).toEqual([b]);
  });
});

describe('runIndex cost confirmation', () => {
  it('asks before more than 10 Claude calls and stops on no', async () => {
    const askYes = jest.fn(async () => false);
    const { run, anthropic, embedder } = setup(ids(11).map(i => makeListing(i)), {
      options: { askYes },
    });
    const summary = await run();
    expect(askYes).toHaveBeenCalledTimes(1);
    expect(askYes.mock.calls[0][0]).toMatch(/11 Claude calls .*estimated \$\d+\.\d\d/);
    expect(anthropic.calls).toHaveLength(0);
    expect(embedder.createEmbedder).not.toHaveBeenCalled();
    expect(summary.stopped).toBe(true);
  });

  it('continues on yes', async () => {
    const { run, anthropic } = setup(ids(11).map(i => makeListing(i)));
    await run();
    expect(anthropic.calls).toHaveLength(11);
  });

  it('does not ask for 10 calls or fewer', async () => {
    const askYes = jest.fn(async () => false);
    const { run, anthropic } = setup(ids(10).map(i => makeListing(i)), { options: { askYes } });
    await run();
    expect(askYes).not.toHaveBeenCalled();
    expect(anthropic.calls).toHaveLength(10);
  });
});

describe('helpers', () => {
  it('usableVectors starts fresh for a missing file or another model', () => {
    const empty = { model: EMBED_MODEL, dim: 384, listings: {} };
    expect(usableVectors(null)).toEqual(empty);
    expect(usableVectors({ model: 'old', dim: 384, listings: { a: {} } })).toEqual(empty);
    const current = { model: EMBED_MODEL, dim: 384, listings: { a: {} } };
    expect(usableVectors(current)).toBe(current);
  });

  it('estimateCallCost averages logged enrich calls, with a default when none', () => {
    expect(estimateCallCost([])).toBeCloseTo((2100 * 1 + 400 * 5) / 1e6, 10);
    const records = [
      {
        purpose: 'enrich',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
      {
        purpose: 'enrich',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 3000, output_tokens: 0 },
      },
      {
        purpose: 'intent',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 99999, output_tokens: 0 },
      },
    ];
    expect(estimateCallCost(records)).toBeCloseTo(0.002, 10);
  });

  it('parseLimit reads --limit N', () => {
    expect(parseLimit(['node', 'build.js'])).toBe(null);
    expect(parseLimit(['node', 'build.js', '--limit', '5', '--confirm'])).toBe(5);
    expect(() => parseLimit(['--limit', 'x'])).toThrow('--limit needs a positive whole number');
    expect(() => parseLimit(['--limit', '0'])).toThrow();
  });
});
