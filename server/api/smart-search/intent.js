/**
 * Step ①: intent parsing with Claude Haiku (D1–D3, D6, D15).
 *
 * Claude reads the buyer's text (and the previous search state) and returns keys and values only.
 * Code then checks every filter against the marketplace config and drops anything not allowed,
 * builds the chip labels, and sets the mode: soft for colour and brand, hard for the rest.
 *
 * On error, timeout, refusal or invalid JSON the search goes on with the raw text: a new state,
 * no inferred filters, and the words of the text as terms (D6, INTENT_FALLBACK).
 */
const { logClaudeUsage } = require('../../smart-search-lib/usage');
const { fieldsForCategory } = require('../../smart-search-lib/config');
const { FILTER_KEYS, ENUM_KEYS } = require('./request');

const INTENT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1500;
const TIMEOUT_MS = 5000;

const SOFT_KEYS = ['color', 'brand'];
const SIZE_KEYS = ['size', 'shoeSize', 'kidsSize'];
const OPS = ['eq', 'in', 'notIn', 'range'];
const MAX_TERMS = 15;
const MAX_PREFERENCES = 8;

// ---------------------------------------------------------------------------
// What the config allows
// ---------------------------------------------------------------------------

const topCategories = config => config.categories;
const subcategories = config =>
  config.categories.flatMap(top =>
    (top.subcategories || []).map(sub => ({ ...sub, parent: top.id }))
  );

const enumField = (config, key) => config.listingFields.find(f => f.key === key);

/**
 * Allowed values for each enum key, as { value: label }. Category values come from the
 * categories asset, the rest from the listing fields.
 */
const allowedValues = config => {
  const values = {
    categoryLevel1: Object.fromEntries(topCategories(config).map(c => [c.id, c.name])),
    categoryLevel2: Object.fromEntries(subcategories(config).map(c => [c.id, c.name])),
  };
  ENUM_KEYS.filter(key => !values[key]).forEach(key => {
    const field = enumField(config, key);
    values[key] = Object.fromEntries(
      ((field && field.enumOptions) || []).map(o => [o.option, o.label])
    );
  });
  return values;
};

// ---------------------------------------------------------------------------
// Labels and mode (D15)
// ---------------------------------------------------------------------------

const formatEuros = cents => {
  const euros = cents / 100;
  return `€${Number.isInteger(euros) ? euros : euros.toFixed(2)}`;
};

const priceLabel = ({ min, max }) => {
  if (min == null) {
    return `Under ${formatEuros(max)}`;
  }
  return max == null ? `Over ${formatEuros(min)}` : `${formatEuros(min)}–${formatEuros(max)}`;
};

const asList = value => (Array.isArray(value) ? value : [value]);

/**
 * The chip label, built from the config. Follows the examples in CONTRACT.md §4:
 * "Size L", "EU 38", "5 years", "Men", "Shoes", "Under €60", "No bundles", "Pet-free home".
 */
const labelFor = ({ key, op, value }, config) => {
  if (key === 'price') {
    return priceLabel(value);
  }
  if (key === 'brand') {
    return value;
  }
  if (key === 'shippingEnabled') {
    return 'Can be shipped';
  }
  const options = allowedValues(config)[key];
  const names = asList(value).map(v => options[v] || v);
  if (op === 'notIn') {
    // "No bundles", not "No Bundles, Bundles, Bundles": same names are shown once.
    return `No ${[...new Set(names)].join(', ').toLowerCase()}`;
  }
  if (key === 'petFreeHome' || key === 'smokeFreeHome') {
    return enumField(config, key).label;
  }
  if (key === 'size') {
    return `${enumField(config, key).label} ${names.join(', ')}`;
  }
  return [...new Set(names)].join(', ');
};

/**
 * A complete filter for state.filters (CONTRACT.md §4). Inferred colour and brand are soft,
 * everything else hard (D3 rule 4).
 */
const buildFilter = ({ key, op, value }, config, { source = 'inferred', locked = false } = {}) => ({
  key,
  value,
  label: labelFor({ key, op, value }, config),
  mode: source === 'inferred' && SOFT_KEYS.includes(key) ? 'soft' : 'hard',
  locked,
  source,
  op,
});

// ---------------------------------------------------------------------------
// Validating Claude's filters against the config (D15)
// ---------------------------------------------------------------------------

const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v);

// Price from Claude is in whole euros; filters hold cents (CONTRACT.md §6).
const toCents = euros =>
  typeof euros === 'number' && Number.isFinite(euros) && euros >= 0
    ? Math.round(euros * 100)
    : null;

const validPrice = value => {
  if (!isPlainObject(value)) {
    return null;
  }
  const min = toCents(value.min);
  const max = toCents(value.max);
  if ((min === null && max === null) || (min !== null && max !== null && min > max)) {
    return null;
  }
  return { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
};

const validEnum = ({ key, op, value }, allowed) => {
  const options = allowed[key];
  const values = [...new Set(asList(value))].filter(v => typeof v === 'string' && options[v]);
  // pet/smoke-free: only 'yes' has a label ("Pet-free home"); 'no' is not a useful chip.
  const kept = ['petFreeHome', 'smokeFreeHome'].includes(key)
    ? values.filter(v => v === 'yes')
    : values;
  const opOk = op === 'eq' || op === 'in' || (op === 'notIn' && key === 'categoryLevel2');
  if (kept.length === 0 || !opOk) {
    return null;
  }
  if (op === 'notIn') {
    return { key, op, value: kept };
  }
  return kept.length === 1 ? { key, op: 'eq', value: kept[0] } : { key, op: 'in', value: kept };
};

/**
 * The checked filter { key, op, value } with value normalised (price in cents), or null when
 * the key, op or value is not allowed.
 */
const validateFilter = (raw, config) => {
  if (!isPlainObject(raw) || !FILTER_KEYS.includes(raw.key) || !OPS.includes(raw.op)) {
    return null;
  }
  const { key, op, value } = raw;
  if (key === 'price') {
    const price = op === 'range' ? validPrice(value) : null;
    return price && { key, op: 'range', value: price };
  }
  if (key === 'brand') {
    const brand = typeof value === 'string' ? value.trim() : '';
    return brand && op === 'eq' ? { key, op, value: brand } : null;
  }
  if (key === 'shippingEnabled') {
    // Only "can be shipped"; there is no label for "can not".
    return op === 'eq' && value === true ? { key, op, value } : null;
  }
  return validEnum(raw, allowedValues(config));
};

// A categoryLevel2 must belong to the categoryLevel1 asked for in the same reply.
const consistentCategories = (filters, config) => {
  const parents = Object.fromEntries(subcategories(config).map(s => [s.id, s.parent]));
  const level1 = filters.find(f => f.key === 'categoryLevel1');
  return filters.filter(f => {
    if (f.key !== 'categoryLevel2' || f.op === 'notIn' || !level1) {
      return true;
    }
    return asList(f.value).every(v => asList(level1.value).includes(parents[v]));
  });
};

// A size field only fits some categories (e.g. shoeSize only shoes). Checked against the
// subcategories asked for in the same reply, when there are any.
const sizeFitsCategories = (filters, config) => {
  const level2 = filters.find(f => f.key === 'categoryLevel2' && f.op !== 'notIn');
  if (!level2) {
    return filters;
  }
  return filters.filter(f => {
    if (!SIZE_KEYS.includes(f.key)) {
      return true;
    }
    return asList(level2.value).some(id =>
      fieldsForCategory(config, id).some(field => field.key === f.key)
    );
  });
};

const cleanWords = (words, max) =>
  [
    ...new Set(
      (Array.isArray(words) ? words : [])
        .filter(w => typeof w === 'string')
        .map(w => w.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, max);

const cleanKeys = keys => (Array.isArray(keys) ? keys : []).filter(k => FILTER_KEYS.includes(k));

/**
 * Turn Claude's raw reply into the intent the rest of the search uses. Invalid filters are
 * dropped, valid ones become complete filters. Throws when the reply isn't the expected shape.
 *
 * @param {Object} raw parsed JSON from Claude
 * @param {Object} config marketplace config
 * @returns {{ mode, filters, removeKeys, preferences, removePreferences, terms, priceIntent }}
 */
const validateIntent = (raw, config) => {
  if (!isPlainObject(raw) || !['new', 'refine'].includes(raw.mode)) {
    throw new Error('Intent reply has no valid mode');
  }
  const checked = (Array.isArray(raw.filters) ? raw.filters : [])
    .map(f => validateFilter(f, config))
    .filter(Boolean);
  const filters = sizeFitsCategories(consistentCategories(checked, config), config);

  return {
    mode: raw.mode,
    filters: filters.map(f => buildFilter(f, config)),
    removeKeys: cleanKeys(raw.removeKeys),
    preferences: cleanWords(raw.preferences, MAX_PREFERENCES),
    removePreferences: cleanWords(raw.removePreferences, MAX_PREFERENCES),
    terms: cleanWords(raw.terms, MAX_TERMS),
    priceIntent: raw.priceIntent === 'cheaper' ? 'cheaper' : 'none',
  };
};

// ---------------------------------------------------------------------------
// The Claude call
// ---------------------------------------------------------------------------

const valueSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'boolean' },
    { type: 'array', items: { type: 'string' } },
    {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max'],
      properties: {
        min: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        max: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    },
  ],
};

const stringArray = { type: 'array', items: { type: 'string' } };

/**
 * JSON schema for output_config.format: exactly the fields of the intent.
 */
const intentSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'mode',
    'filters',
    'removeKeys',
    'preferences',
    'removePreferences',
    'terms',
    'priceIntent',
  ],
  properties: {
    mode: { type: 'string', enum: ['new', 'refine'] },
    filters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'op', 'value'],
        properties: {
          key: { type: 'string', enum: FILTER_KEYS },
          op: { type: 'string', enum: OPS },
          value: valueSchema,
        },
      },
    },
    removeKeys: { type: 'array', items: { type: 'string', enum: FILTER_KEYS } },
    preferences: stringArray,
    removePreferences: stringArray,
    terms: stringArray,
    priceIntent: { type: 'string', enum: ['cheaper', 'none'] },
  },
});

// Where a field applies, in words Claude can use: "all categories" or the category ids.
const appliesTo = (config, key) => {
  const field = enumField(config, key);
  const { limitToCategoryIds, categoryIds } = (field && field.categoryConfig) || {};
  return limitToCategoryIds ? `only for ${categoryIds.join(', ')}` : 'for all categories';
};

const describeKey = (config, key, values) => {
  const options = Object.entries(values)
    .map(([value, label]) => (value === label ? value : `${value} (${label})`))
    .join(', ');
  const where = SIZE_KEYS.includes(key) ? ` [${appliesTo(config, key)}]` : '';
  return `- ${key}${where}: ${options}`;
};

/**
 * The system prompt: the rules and the allowed keys and values from the marketplace config.
 */
const systemPrompt = config => {
  const allowed = allowedValues(config);
  const enumLines = ENUM_KEYS.map(key => describeKey(config, key, allowed[key])).join('\n');

  return `You turn the text a buyer types into the structured search state of a secondhand clothing marketplace. Reply with JSON only, in the given schema.

Allowed filter keys and values (use these exact values, nothing else):
${enumLines}
- price: op "range", value { "min": euros or null, "max": euros or null }, whole euros ("under 30€" is max 30)
- brand: op "eq", value the brand name as the buyer wrote it
- shippingEnabled: op "eq", value true (buyer wants items that can be shipped)

Ops: "eq" one value; "in" any of several values; "notIn" only for categoryLevel2, to exclude subcategories (value is a list); "range" only for price.

Rules:
- Only add a filter the text asks for. Never guess an audience (men, women, kids) or size that the text does not give.
- Colour and brand are soft preferences for ranking; still return them as filters.
- "baby" alone means categoryLevel1 kids, not a size. "baby blue", "navy" and other shades are colours (baby blue is blue). Pick the nearest allowed colour.
- Pick the size key by category: size for adult tops and bottoms, shoeSize for shoes (EU number), kidsSize for kids' tops and bottoms (by age: "5 year old" is 5y, "18 months" is 1y if no closer value exists). For a child's age use categoryLevel1 kids too.
- When the text names an item type but no audience (e.g. "shoes"), use categoryLevel2 with op "in" over that type in every audience that has it.
- "no bundles" or "not bundles" is categoryLevel2 with op "notIn" over every bundles subcategory.
- "cheaper" or "less expensive" with no amount: priceIntent "cheaper" and no price filter. If the buyer gives an amount, use a price filter and priceIntent "none".
- preferences: soft wishes that are not filters (style, season, warmth, fit, occasion), one or two lowercase words each.
- terms: words to search listing titles and descriptions with: the item words from the text, plus synonyms and fixed typos. Lowercase, singular, at most ${MAX_TERMS}.

Mode:
- Without a previous state, mode is "new".
- With a previous state, mode is "refine" when the text changes or adds to it ("cheaper", "in black", "size M", "not bundles", "remove the size filter"), and "new" when the text asks for a different kind of item ("now I need sneakers").
- In "refine" mode return only filters, preferences and terms that are new or changed, not the ones already in the state.
- removeKeys: filter keys the buyer wants dropped ("any size", "forget the colour"). removePreferences: preferences to drop.
- In "new" mode removeKeys and removePreferences are empty.`;
};

const userMessage = (q, state) =>
  JSON.stringify({
    text: q,
    previousState: state
      ? {
          text: state.q,
          filters: state.filters.map(({ key, value, label, source, locked }) => ({
            key,
            value,
            label,
            source,
            locked,
          })),
          preferences: state.preferences,
          removedKeys: state.removed,
        }
      : null,
  });

const fallbackIntent = q => ({
  mode: 'new',
  filters: [],
  removeKeys: [],
  preferences: [],
  removePreferences: [],
  terms: (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, MAX_TERMS),
  priceIntent: 'none',
});

// Rejects after `ms`. The SDK has its own timeout, but this also covers clients that ignore it.
const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Intent call timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const callClaude = async ({ q, state, config, anthropic, logUsage, timeoutMs }) => {
  const response = await withTimeout(
    anthropic.messages.create(
      {
        model: INTENT_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system: systemPrompt(config),
        messages: [{ role: 'user', content: userMessage(q, state) }],
        output_config: { format: { type: 'json_schema', schema: intentSchema() } },
      },
      { timeout: timeoutMs, maxRetries: 0 }
    ),
    timeoutMs
  );
  logUsage({ purpose: 'intent', model: response.model, usage: response.usage });

  if (response.stop_reason !== 'end_turn') {
    throw new Error(`Claude stopped with ${response.stop_reason}`);
  }
  const text = (response.content.find(block => block.type === 'text') || {}).text;
  if (!text) {
    throw new Error('Claude returned no text');
  }
  return validateIntent(JSON.parse(text), config);
};

/**
 * Read the intent of the buyer's text with claude-haiku-4-5. Never throws: on error, timeout,
 * refusal or invalid JSON it returns the fallback intent (D6). Logs response.usage.
 *
 * @param {Object} params
 * @param {string} params.q the buyer's text
 * @param {?Object} params.state the previous search state, or null
 * @param {Object} params.config marketplace config
 * @param {?Object} params.anthropic Anthropic client (anything with messages.create); null falls back
 * @param {Function} [params.logUsage] defaults to the usage log; tests pass a fake
 * @param {number} [params.timeoutMs] defaults to 5 s
 * @param {Function} [params.onError] called with the error when falling back
 * @returns {Promise<{ intent: Object, warnings: string[] }>} warnings has INTENT_FALLBACK on fallback
 */
const parseIntent = async ({
  q,
  state = null,
  config,
  anthropic,
  logUsage = logClaudeUsage,
  timeoutMs = TIMEOUT_MS,
  onError = () => {},
}) => {
  try {
    if (!anthropic) {
      throw new Error('No Anthropic client');
    }
    const intent = await callClaude({ q, state, config, anthropic, logUsage, timeoutMs });
    return { intent, warnings: [] };
  } catch (e) {
    onError(e);
    return { intent: fallbackIntent(q), warnings: ['INTENT_FALLBACK'] };
  }
};

module.exports = {
  INTENT_MODEL,
  TIMEOUT_MS,
  allowedValues,
  labelFor,
  buildFilter,
  validateIntent,
  intentSchema,
  systemPrompt,
  fallbackIntent,
  parseIntent,
  formatEuros,
};
