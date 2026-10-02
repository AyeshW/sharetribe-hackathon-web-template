const {
  parseIntent,
  validateIntent,
  labelFor,
  systemPrompt,
  intentSchema,
  INTENT_MODEL,
} = require('./intent');
const { config, filter, state, fakeAnthropic, claudeReply, rawIntent } = require('./test-data');

const f = (key, op, value) => ({ key, op, value });
const validate = filters => validateIntent(rawIntent({ filters }), config).filters;

describe('validateIntent: only allowed filters get through (D15)', () => {
  it('drops unknown keys, unknown values and wrong ops', () => {
    const filters = validate([
      f('size', 'eq', 'l'),
      f('size', 'eq', 'huge'),
      f('sleeves', 'eq', 'long'),
      f('color', 'eq', 'teal'),
      f('condition', 'range', 'like-new'),
      f('categoryLevel1', 'notIn', ['men']),
      f('price', 'eq', 30),
      f('price', 'range', { min: 50, max: 20 }),
      f('price', 'range', { min: null, max: null }),
      f('brand', 'eq', '   '),
      f('shippingEnabled', 'eq', false),
    ]);
    expect(filters.map(x => x.key)).toEqual(['size']);
  });

  it('keeps allowed values of an `in` filter and drops the rest', () => {
    const [kept] = validate([f('color', 'in', ['black', 'teal', 'blue'])]);
    expect(kept).toMatchObject({ key: 'color', op: 'in', value: ['black', 'blue'] });
  });

  it('turns an `in` with one allowed value into `eq`, and drops it with none', () => {
    expect(validate([f('color', 'in', ['black', 'teal'])])[0]).toMatchObject({
      op: 'eq',
      value: 'black',
    });
    expect(validate([f('color', 'in', ['teal'])])).toEqual([]);
  });

  it('allows notIn only for categoryLevel2', () => {
    const [kept] = validate([f('categoryLevel2', 'notIn', ['women-bundles', 'men-bundles', 'x'])]);
    expect(kept).toMatchObject({ op: 'notIn', value: ['women-bundles', 'men-bundles'] });
    expect(validate([f('color', 'notIn', ['black'])])).toEqual([]);
  });

  it('converts price from euros to cents', () => {
    expect(validate([f('price', 'range', { min: null, max: 30 })])[0].value).toEqual({ max: 3000 });
    expect(validate([f('price', 'range', { min: 10.5, max: 20 })])[0].value).toEqual({
      min: 1050,
      max: 2000,
    });
  });

  it('keeps only "yes" for pet-free and smoke-free home', () => {
    expect(validate([f('smokeFreeHome', 'eq', 'yes')])).toHaveLength(1);
    expect(validate([f('smokeFreeHome', 'eq', 'no')])).toEqual([]);
  });

  it('drops a subcategory that does not belong to the category in the same reply', () => {
    const filters = validate([
      f('categoryLevel1', 'eq', 'men'),
      f('categoryLevel2', 'eq', 'women-shoes'),
    ]);
    expect(filters.map(x => x.key)).toEqual(['categoryLevel1']);
  });

  it('drops a size key that does not fit the subcategory in the same reply', () => {
    const filters = validate([
      f('categoryLevel2', 'eq', 'men-shoes'),
      f('size', 'eq', 'm'),
      f('shoeSize', 'eq', '42'),
    ]);
    expect(filters.map(x => x.key)).toEqual(['categoryLevel2', 'shoeSize']);
  });

  it('cleans removeKeys, terms and preferences, and defaults priceIntent to none', () => {
    const intent = validateIntent(
      rawIntent({
        removeKeys: ['size', 'bogus'],
        terms: [' Jeans ', 'jeans', '', 'DENIM'],
        preferences: ['Vintage'],
        priceIntent: 'whatever',
      }),
      config
    );
    expect(intent).toMatchObject({
      removeKeys: ['size'],
      terms: ['jeans', 'denim'],
      preferences: ['vintage'],
      priceIntent: 'none',
    });
  });

  it('rejects a reply without a valid mode', () => {
    expect(() => validateIntent({ mode: 'maybe' }, config)).toThrow();
    expect(() => validateIntent(null, config)).toThrow();
  });
});

describe('labels are built in code (D15)', () => {
  const label = (key, op, value) => labelFor({ key, op, value }, config);

  it.each([
    ['size', 'eq', 'l', 'Size L'],
    ['shoeSize', 'eq', '38', 'EU 38'],
    ['kidsSize', 'eq', '5y', '5 years'],
    ['categoryLevel1', 'eq', 'men', 'Men'],
    ['categoryLevel2', 'eq', 'men-shoes', 'Shoes'],
    ['color', 'eq', 'black', 'Black'],
    ['color', 'in', ['black', 'blue'], 'Black, Blue'],
    ['condition', 'eq', 'like-new', 'Like new'],
    ['brand', 'eq', 'Nike', 'Nike'],
    ['petFreeHome', 'eq', 'yes', 'Pet-free home'],
    ['smokeFreeHome', 'eq', 'yes', 'Smoke-free home'],
    ['shippingEnabled', 'eq', true, 'Can be shipped'],
    ['price', 'range', { max: 6000 }, 'Under €60'],
    ['price', 'range', { min: 1000 }, 'Over €10'],
    ['price', 'range', { min: 1000, max: 2550 }, '€10–€25.50'],
    ['categoryLevel2', 'notIn', ['women-bundles', 'men-bundles', 'kids-bundles'], 'No bundles'],
  ])('%s %s %j → %s', (key, op, value, expected) => {
    expect(label(key, op, value)).toBe(expected);
  });

  it('builds a complete filter, ignoring any label Claude sent', () => {
    const [chip] = validate([{ ...f('size', 'eq', 'm'), label: 'Anything I like' }]);
    expect(chip).toEqual({
      key: 'size',
      value: 'm',
      label: 'Size M',
      mode: 'hard',
      locked: false,
      source: 'inferred',
      op: 'eq',
    });
  });
});

describe('mode: colour and brand are soft, everything else hard (D3 rule 4)', () => {
  it.each([
    ['color', 'eq', 'black', 'soft'],
    ['brand', 'eq', 'Nike', 'soft'],
    ['size', 'eq', 'l', 'hard'],
    ['price', 'range', { max: 3000 }, 'hard'],
    ['categoryLevel1', 'eq', 'men', 'hard'],
    ['condition', 'eq', 'like-new', 'hard'],
  ])('%s is %s', (key, op, value, mode) => {
    const input = key === 'price' ? { min: null, max: 30 } : value;
    expect(validate([f(key, op, input)])[0].mode).toBe(mode);
  });
});

describe('parseIntent', () => {
  const logUsage = jest.fn();
  const run = (overrides = {}) =>
    parseIntent({ q: 'black jeans, size M', config, logUsage, ...overrides });

  beforeEach(() => logUsage.mockClear());

  it('calls claude-haiku-4-5 with the text, the previous state and the config values', async () => {
    const anthropic = fakeAnthropic(rawIntent({ mode: 'refine' }));
    const previous = state([filter('size', 'm')], { q: 'jeans' });
    await run({ anthropic, state: previous, q: 'cheaper' });

    const [params, options] = anthropic.messages.create.mock.calls[0];
    expect(params.model).toBe(INTENT_MODEL);
    expect(INTENT_MODEL).toBe('claude-haiku-4-5');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(options).toMatchObject({ timeout: 5000 });
    const message = JSON.parse(params.messages[0].content);
    expect(message.text).toBe('cheaper');
    expect(message.previousState.text).toBe('jeans');
    expect(message.previousState.filters[0]).toMatchObject({ key: 'size', value: 'm' });
    expect(params.system).toContain('shoeSize');
    expect(params.system).toContain('men-shoes');
    expect(params.system).toContain('5y (5 years)');
    expect(params.system).toContain('baby');
  });

  it('sends previousState null without a previous state', async () => {
    const anthropic = fakeAnthropic(rawIntent());
    await run({ anthropic });
    expect(JSON.parse(anthropic.messages.create.mock.calls[0][0].messages[0].content)).toEqual({
      text: 'black jeans, size M',
      previousState: null,
    });
  });

  it('returns the validated intent and logs usage with purpose intent', async () => {
    const anthropic = fakeAnthropic(
      rawIntent({ filters: [f('size', 'eq', 'm'), f('size', 'eq', 'nope')], terms: ['jeans'] })
    );
    const { intent, warnings } = await run({ anthropic });
    expect(warnings).toEqual([]);
    expect(intent.filters).toHaveLength(1);
    expect(intent.terms).toEqual(['jeans']);
    expect(logUsage).toHaveBeenCalledWith({
      purpose: 'intent',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  describe('falls back to the raw text with INTENT_FALLBACK (D6)', () => {
    const expectFallback = result => {
      expect(result.warnings).toEqual(['INTENT_FALLBACK']);
      expect(result.intent).toEqual({
        mode: 'new',
        filters: [],
        removeKeys: [],
        preferences: [],
        removePreferences: [],
        terms: ['black', 'jeans', 'size', 'm'],
        priceIntent: 'none',
      });
    };

    it('on an API error', async () => {
      const anthropic = { messages: { create: jest.fn(() => Promise.reject(new Error('529'))) } };
      const onError = jest.fn();
      expectFallback(await run({ anthropic, onError }));
      expect(onError).toHaveBeenCalled();
    });

    it('on a timeout', async () => {
      const anthropic = { messages: { create: jest.fn(() => new Promise(() => {})) } };
      expectFallback(await run({ anthropic, timeoutMs: 20 }));
    });

    it('on invalid JSON', async () => {
      expectFallback(await run({ anthropic: fakeAnthropic('{not json') }));
    });

    it('on a reply of the wrong shape', async () => {
      expectFallback(await run({ anthropic: fakeAnthropic({ mode: 'sideways' }) }));
    });

    it('on a refusal', async () => {
      expectFallback(
        await run({ anthropic: fakeAnthropic(rawIntent(), { stop_reason: 'refusal' }) })
      );
    });

    it('when the reply was cut off', async () => {
      expectFallback(
        await run({ anthropic: fakeAnthropic(rawIntent(), { stop_reason: 'max_tokens' }) })
      );
    });

    it('without a client', async () => {
      expectFallback(await run({ anthropic: null }));
    });

    it('still logs usage when the reply was unusable', async () => {
      await run({ anthropic: fakeAnthropic('{not json') });
      expect(logUsage).toHaveBeenCalledTimes(1);
    });
  });

  it('never gets the raw reply object into the intent', async () => {
    const reply = claudeReply(rawIntent({ terms: ['x'] }));
    const anthropic = { messages: { create: jest.fn(() => Promise.resolve(reply)) } };
    const { intent } = await run({ anthropic });
    expect(Object.keys(intent).sort()).toEqual(
      [
        'filters',
        'mode',
        'preferences',
        'priceIntent',
        'removeKeys',
        'removePreferences',
        'terms',
      ].sort()
    );
  });
});

describe('prompt and schema', () => {
  it('lists the rules Claude must follow', () => {
    const prompt = systemPrompt(config);
    expect(prompt).toMatch(/Colour and brand are soft/);
    expect(prompt).toMatch(/"baby" alone means categoryLevel1 kids, not a size/);
    expect(prompt).toMatch(/baby blue/);
  });

  it('asks for exactly the intent fields', () => {
    expect(intentSchema().required).toEqual([
      'mode',
      'filters',
      'removeKeys',
      'preferences',
      'removePreferences',
      'terms',
      'priceIntent',
    ]);
  });
});
