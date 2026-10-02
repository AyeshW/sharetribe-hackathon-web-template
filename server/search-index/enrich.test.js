const {
  ENRICH_MODEL,
  colorOptions,
  tagSchema,
  sellerFields,
  validateTags,
  enrichListing,
} = require('./enrich');

const COLORS = ['black', 'white', 'blue', 'brown', 'multicolor'];
const config = {
  listingFields: [
    { key: 'color', schemaType: 'enum', enumOptions: COLORS.map(option => ({ option })) },
    { key: 'brand', schemaType: 'text' },
    { key: 'condition', schemaType: 'enum', enumOptions: [{ option: 'well-used' }] },
  ],
  categories: [],
  listingTypes: [],
};

const goodTags = {
  garmentType: 'bomber jacket',
  synonyms: ['Jacket', 'coat', 'jacket', ' flight jacket '],
  audience: 'adult',
  colorDetected: ['brown', 'black'],
  pattern: 'solid',
  materialLook: 'suede',
  style: ['vintage', 'casual'],
  season: ['autumn', 'spring'],
  warmth: 'medium',
  occasion: ['everyday'],
  fit: 'regular',
  brand: '',
  visibleWear: 'light',
  photoMatchesText: { match: 'yes', note: '' },
  searchText: 'A brown suede bomber jacket for autumn.',
};

const listing = (publicData = {}) => ({
  id: { uuid: 'l1' },
  attributes: {
    title: 'Vintage suede jacket',
    description: 'Soft and broken in.',
    price: { amount: 3500, currency: 'EUR' },
    publicData: {
      categoryLevel1: 'women',
      categoryLevel2: 'women-tops',
      condition: 'well-used',
      listingType: 'sell-used-products',
      pickupEnabled: true,
      ...publicData,
    },
  },
});

const fakeAnthropic = (reply, { stopReason = 'end_turn' } = {}) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async params => {
        calls.push(params);
        return {
          model: 'claude-haiku-4-5-20251001',
          stop_reason: stopReason,
          content: [{ type: 'text', text: JSON.stringify(reply) }],
          usage: { input_tokens: 1800, output_tokens: 300 },
        };
      },
    },
  };
};

describe('validateTags', () => {
  it('keeps allowed values and tidies lists', () => {
    const tags = validateTags(goodTags, listing().attributes.publicData, COLORS);
    expect(tags).toEqual({
      ...goodTags,
      synonyms: ['jacket', 'coat', 'flight jacket'],
    });
  });

  it('sets disallowed single values to unknown and drops disallowed list values', () => {
    const tags = validateTags(
      {
        ...goodTags,
        pattern: 'paisley',
        materialLook: 'velvet',
        warmth: 'hot',
        fit: 'baggy',
        visibleWear: 'lots',
        style: ['vintage', 'grunge'],
        season: ['monsoon'],
        occasion: ['wedding', 'party'],
        colorDetected: ['teal', 'blue'],
      },
      { categoryLevel1: 'accessories' },
      COLORS
    );
    expect(tags.pattern).toBe('unknown');
    expect(tags.materialLook).toBe('unknown');
    expect(tags.warmth).toBe('unknown');
    expect(tags.fit).toBe('unknown');
    expect(tags.visibleWear).toBe('unknown');
    expect(tags.style).toEqual(['vintage']);
    expect(tags.season).toEqual([]);
    expect(tags.occasion).toEqual(['party']);
    expect(tags.colorDetected).toEqual(['blue']);
  });

  it("drops 'all-season' when specific seasons are given too", () => {
    const mixed = validateTags({ ...goodTags, season: ['autumn', 'all-season'] }, {}, COLORS);
    expect(mixed.season).toEqual(['autumn']);
    const alone = validateTags({ ...goodTags, season: ['all-season'] }, {}, COLORS);
    expect(alone.season).toEqual(['all-season']);
  });

  it('handles missing or wrongly typed fields', () => {
    const tags = validateTags({ synonyms: 'coat', style: 'vintage', brand: 3 }, {}, COLORS);
    expect(tags).toMatchObject({
      garmentType: '',
      synonyms: [],
      style: [],
      colorDetected: [],
      brand: '',
      photoMatchesText: null,
      searchText: '',
    });
    expect(validateTags(null, {}, COLORS).audience).toBe('unknown');
  });

  it("puts the seller's colour first and keeps at most two colours", () => {
    const tags = validateTags(
      { ...goodTags, colorDetected: ['black', 'white', 'brown'] },
      { color: 'blue' },
      COLORS
    );
    expect(tags.colorDetected).toEqual(['blue', 'black']);
    const same = validateTags(
      { ...goodTags, colorDetected: ['white', 'blue'] },
      { color: 'blue' },
      COLORS
    );
    expect(same.colorDetected).toEqual(['blue', 'white']);
  });

  it("keeps the seller's brand, allowing only a tidier spelling", () => {
    expect(validateTags({ ...goodTags, brand: "Levi's" }, { brand: 'levis' }, COLORS).brand).toBe(
      "Levi's"
    );
    expect(
      validateTags({ ...goodTags, brand: 'Wrangler' }, { brand: 'levis ' }, COLORS).brand
    ).toBe('levis');
    expect(validateTags({ ...goodTags, brand: '' }, { brand: 'Zara' }, COLORS).brand).toBe('Zara');
    expect(validateTags({ ...goodTags, brand: 'Nike' }, {}, COLORS).brand).toBe('Nike');
  });

  it('sets audience from the category', () => {
    const kid = validateTags(
      { ...goodTags, audience: 'adult' },
      { categoryLevel1: 'kids' },
      COLORS
    );
    expect(kid.audience).toBe('kid');
    const baby = validateTags(
      { ...goodTags, audience: 'baby' },
      { categoryLevel1: 'kids' },
      COLORS
    );
    expect(baby.audience).toBe('baby');
    const adult = validateTags({ ...goodTags, audience: 'kid' }, { categoryLevel1: 'men' }, COLORS);
    expect(adult.audience).toBe('adult');
  });

  it('marks listings without a photo', () => {
    const tags = validateTags(goodTags, {}, COLORS, { hasPhoto: false });
    expect(tags.photoMatchesText).toEqual({ match: 'no', note: 'No photo.' });
    expect(tags.visibleWear).toBe('unknown');
  });
});

describe('tagSchema', () => {
  it('has exactly the D11 fields, all required, with the marketplace colours', () => {
    const schema = tagSchema(COLORS);
    const fields = [
      'garmentType',
      'synonyms',
      'audience',
      'colorDetected',
      'pattern',
      'materialLook',
      'style',
      'season',
      'warmth',
      'occasion',
      'fit',
      'brand',
      'visibleWear',
      'photoMatchesText',
      'searchText',
    ];
    expect(Object.keys(schema.properties)).toEqual(fields);
    expect(schema.required).toEqual(fields);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.colorDetected.items.enum).toEqual(COLORS);
  });

  it('reads colours from the marketplace config', () => {
    expect(colorOptions(config)).toEqual(COLORS);
  });
});

describe('sellerFields', () => {
  it('sends listing-config fields, category and price, not logistics fields', () => {
    expect(sellerFields(listing({ brand: 'Zara', color: '' }), config)).toEqual({
      title: 'Vintage suede jacket',
      description: 'Soft and broken in.',
      price: '35.00 EUR',
      categoryLevel1: 'women',
      categoryLevel2: 'women-tops',
      brand: 'Zara',
      condition: 'well-used',
    });
  });
});

describe('enrichListing', () => {
  it('calls claude-haiku-4-5 with the image URL, the text and a JSON schema', async () => {
    const anthropic = fakeAnthropic(goodTags);
    const logUsage = jest.fn();
    await enrichListing(listing(), 'https://img.example/medium.jpg', config, anthropic, {
      logUsage,
    });

    const params = anthropic.calls[0];
    expect(params.model).toBe(ENRICH_MODEL);
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://img.example/medium.jpg' },
    });
    expect(params.messages[0].content[1].text).toContain('Vintage suede jacket');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.output_config.format.schema.properties.colorDetected.items.enum).toEqual(COLORS);
    expect(params.system).toContain('Never contradict them');
  });

  it('logs usage for the call with purpose enrich', async () => {
    const logUsage = jest.fn();
    await enrichListing(listing(), 'https://img.example/a.jpg', config, fakeAnthropic(goodTags), {
      logUsage,
    });
    expect(logUsage).toHaveBeenCalledWith({
      purpose: 'enrich',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1800, output_tokens: 300 },
    });
  });

  it('sends no image block for a listing without a photo', async () => {
    const anthropic = fakeAnthropic(goodTags);
    const tags = await enrichListing(listing(), null, config, anthropic, { logUsage: jest.fn() });
    expect(anthropic.calls[0].messages[0].content).toHaveLength(1);
    expect(anthropic.calls[0].messages[0].content[0].text).toContain('no photo');
    expect(tags.photoMatchesText.match).toBe('no');
  });

  it("validates the reply against the seller's fields", async () => {
    const anthropic = fakeAnthropic({ ...goodTags, colorDetected: ['black'], pattern: 'tartan' });
    const tags = await enrichListing(listing({ color: 'brown' }), 'u', config, anthropic, {
      logUsage: jest.fn(),
    });
    expect(tags.colorDetected).toEqual(['brown', 'black']);
    expect(tags.pattern).toBe('unknown');
  });

  it('throws when Claude does not finish, after logging usage', async () => {
    const logUsage = jest.fn();
    const anthropic = fakeAnthropic(goodTags, { stopReason: 'max_tokens' });
    await expect(enrichListing(listing(), 'u', config, anthropic, { logUsage })).rejects.toThrow(
      'Claude stopped with max_tokens'
    );
    expect(logUsage).toHaveBeenCalledTimes(1);
  });
});
