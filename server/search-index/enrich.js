/**
 * Listing enrichment with Claude Haiku (D11): one call per listing with the photo URL and the
 * seller's text, returning the D11 tags as structured JSON. The reply is validated in code:
 * values outside the allowed lists are dropped, and the seller's own fields always win.
 */
const { logClaudeUsage } = require('../smart-search-lib/usage');

const ENRICH_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2000;

// Single-value tags; 'unknown' when not allowed or not known.
const SINGLE_ENUMS = {
  audience: ['adult', 'kid', 'baby', 'unknown'],
  pattern: ['solid', 'striped', 'checked', 'floral', 'print', 'graphic', 'unknown'],
  materialLook: ['denim', 'leather', 'suede', 'knit', 'wool', 'cotton', 'synthetic', 'unknown'],
  warmth: ['light', 'medium', 'warm', 'unknown'],
  fit: ['slim', 'regular', 'oversized', 'cropped', 'unknown'],
  visibleWear: ['none', 'light', 'noticeable', 'unknown'],
};

// Multi-value tags; an empty list means unknown.
const MULTI_ENUMS = {
  style: [
    'vintage',
    'retro',
    'y2k',
    'minimalist',
    'sporty',
    'formal',
    'casual',
    'boho',
    'streetwear',
    'classic',
  ],
  season: ['spring', 'summer', 'autumn', 'winter', 'all-season'],
  occasion: ['everyday', 'work', 'party', 'formal', 'outdoor', 'sport'],
};

const MAX_COLORS = 2;
const MAX_SYNONYMS = 10;

// Seller fields sent to Claude besides title, description and price.
const SELLER_KEYS_EXTRA = ['categoryLevel1', 'categoryLevel2'];

/**
 * Colour option keys from the marketplace's 'color' listing field.
 */
const colorOptions = config =>
  (config.listingFields.find(f => f.key === 'color')?.enumOptions || []).map(o => o.option);

const stringList = { type: 'array', items: { type: 'string' } };
const enumList = values => ({ type: 'array', items: { type: 'string', enum: values } });

/**
 * JSON schema for output_config.format, with exactly the D11 fields.
 */
const tagSchema = colors => ({
  type: 'object',
  properties: {
    garmentType: { type: 'string' },
    synonyms: stringList,
    audience: { type: 'string', enum: SINGLE_ENUMS.audience },
    colorDetected: enumList(colors),
    pattern: { type: 'string', enum: SINGLE_ENUMS.pattern },
    materialLook: { type: 'string', enum: SINGLE_ENUMS.materialLook },
    style: enumList(MULTI_ENUMS.style),
    season: enumList(MULTI_ENUMS.season),
    warmth: { type: 'string', enum: SINGLE_ENUMS.warmth },
    occasion: enumList(MULTI_ENUMS.occasion),
    fit: { type: 'string', enum: SINGLE_ENUMS.fit },
    brand: { type: 'string' },
    visibleWear: { type: 'string', enum: SINGLE_ENUMS.visibleWear },
    photoMatchesText: {
      type: 'object',
      properties: {
        match: { type: 'string', enum: ['yes', 'no'] },
        note: { type: 'string' },
      },
      required: ['match', 'note'],
      additionalProperties: false,
    },
    searchText: { type: 'string' },
  },
  required: [
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
  ],
  additionalProperties: false,
});

const systemPrompt = colors => `You tag secondhand clothing listings for a marketplace search engine. \
You get one listing: the seller's photo (if any) and the seller's own fields. Return the tags as JSON.

Rules:
- The seller's fields are the truth. Never contradict them. If the seller gives a colour, it is the \
first colour in colorDetected. If the seller names a brand, use that brand.
- Use only the allowed values. Free text only in garmentType, synonyms, photoMatchesText.note and \
searchText.
- Say "unknown" (or leave a list empty) rather than guess.

Fields:
- garmentType: the specific item in 1-3 words, e.g. "bomber jacket", "ankle boots", "maxi skirt". \
For a bundle, name the main items, e.g. "jeans and jacket bundle".
- synonyms: 3-8 other words or short phrases a buyer might type for this same item: other names, \
the general type, and English words for non-English text. E.g. bomber jacket: "jacket", "coat", \
"flight jacket", "outerwear". Never name a different garment, not even inside a phrase: for a coat, \
no "blazer", "blazer coat" or "cardigan"; for a sweater, no "hoodie". Lowercase.
- audience: "kid" for children's items, "baby" for 0-2 years, "adult" otherwise.
- colorDetected: 1-2 main colours from: ${colors.join(', ')}. Main colour first. Use "multicolor" \
for 3 or more colours. Empty list if you can't tell.
- pattern: the visible pattern.
- materialLook: only if the material is visible in the photo or stated by the seller.
- style: the styles that clearly fit (usually 1-3).
- season: the seasons the item suits, consistent with warmth. Warm knitwear and coats suit autumn \
and winter; light dresses and shorts suit spring and summer. Use ["all-season"] alone, only for items \
worn the whole year (e.g. jeans, t-shirts, sneakers); never combine it with other seasons.
- warmth: how warm the item keeps the wearer.
- occasion: what the item is worn for (usually 1-3).
- fit: the cut, if you can tell from the photo or text.
- brand: a brand the seller states, or a logo or label clearly readable in the photo, in its usual \
spelling (e.g. "Levi's", "Nike"). Otherwise "".
- visibleWear: wear you can see in the photo. A hint only; the seller's condition stays the truth.
- photoMatchesText: "no" only if the photo clearly shows a different kind of item or a different \
colour from the text, with a short note saying what differs. A close-up of the fabric or a detail, \
the item worn by a person, or several similar items in one photo is still "yes"; say so in the note \
(e.g. "close-up of the fabric only").
- searchText: 1-2 sentences in the words a buyer would use: what the item is, how it looks, and what \
it's good for. Don't mention price, condition, the seller or the photo credit.`;

// Seller fields as Claude sees them: listing-config fields, category and price.
const sellerFields = (listing, config) => {
  const { title, description, price, publicData = {} } = listing.attributes;
  const keys = [...SELLER_KEYS_EXTRA, ...config.listingFields.map(f => f.key)];
  const fields = keys
    .filter(key => publicData[key] !== undefined && publicData[key] !== '')
    .reduce((acc, key) => ({ ...acc, [key]: publicData[key] }), {});
  return {
    title,
    description,
    ...(price ? { price: `${(price.amount / 100).toFixed(2)} ${price.currency}` } : {}),
    ...fields,
  };
};

const userContent = (fields, imageUrl) => [
  ...(imageUrl ? [{ type: 'image', source: { type: 'url', url: imageUrl } }] : []),
  {
    type: 'text',
    text:
      (imageUrl ? '' : 'This listing has no photo. Tag it from the text only.\n\n') +
      `Seller's fields:\n${JSON.stringify(fields, null, 2)}`,
  },
];

// 'all-season' together with specific seasons contradicts itself; keep the specific ones.
const seasons = values => (values.length > 1 ? values.filter(v => v !== 'all-season') : values);

const cleanString = value => (typeof value === 'string' ? value.trim() : '');
const unique = values => [...new Set(values)];
const comparable = value =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Validate Claude's tags against the allowed values and the seller's fields.
 *
 * @param {Object} raw parsed JSON from Claude
 * @param {Object} seller the listing's publicData (color, brand, categoryLevel1, ...)
 * @param {string[]} colors allowed colour option keys
 * @param {{ hasPhoto: boolean }} options
 * @returns {Object} tags with only allowed values
 */
const validateTags = (raw, seller, colors, { hasPhoto = true } = {}) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const single = key => (SINGLE_ENUMS[key].includes(input[key]) ? input[key] : 'unknown');
  const multi = key =>
    unique((Array.isArray(input[key]) ? input[key] : []).filter(v => MULTI_ENUMS[key].includes(v)));

  // Colour: the seller's colour is always first.
  const detected = (Array.isArray(input.colorDetected) ? input.colorDetected : []).filter(c =>
    colors.includes(c)
  );
  const sellerColor = colors.includes(seller.color) ? seller.color : null;
  const colorDetected = unique([...(sellerColor ? [sellerColor] : []), ...detected]).slice(
    0,
    MAX_COLORS
  );

  // Brand: the seller's brand wins; Claude may only tidy its spelling.
  const claudeBrand = cleanString(input.brand);
  const sellerBrand = cleanString(seller.brand);
  const brand =
    sellerBrand && comparable(claudeBrand) !== comparable(sellerBrand) ? sellerBrand : claudeBrand;

  // Audience follows the category: kids items are kid or baby, women/men items are adult.
  let audience = single('audience');
  if (seller.categoryLevel1 === 'kids' && !['kid', 'baby'].includes(audience)) {
    audience = 'kid';
  } else if (['women', 'men'].includes(seller.categoryLevel1)) {
    audience = 'adult';
  }

  const photo = input.photoMatchesText;
  const photoMatchesText = !hasPhoto
    ? { match: 'no', note: 'No photo.' }
    : photo && ['yes', 'no'].includes(photo.match)
    ? { match: photo.match, note: cleanString(photo.note) }
    : null;

  return {
    garmentType: cleanString(input.garmentType),
    synonyms: unique(
      (Array.isArray(input.synonyms) ? input.synonyms : [])
        .map(s => cleanString(s).toLowerCase())
        .filter(Boolean)
    ).slice(0, MAX_SYNONYMS),
    audience,
    colorDetected,
    pattern: single('pattern'),
    materialLook: single('materialLook'),
    style: multi('style'),
    season: seasons(multi('season')),
    warmth: single('warmth'),
    occasion: multi('occasion'),
    fit: single('fit'),
    brand,
    visibleWear: hasPhoto ? single('visibleWear') : 'unknown',
    photoMatchesText,
    searchText: cleanString(input.searchText),
  };
};

/**
 * Enrich one listing with a claude-haiku-4-5 call. Logs response.usage for every call.
 *
 * @param {Object} listing Integration API listing entity (attributes.title, description, ...)
 * @param {string|null} imageUrl scaled-medium image variant URL, or null for no photo
 * @param {Object} config marketplace config (loadMarketplaceConfig)
 * @param {Object} anthropic Anthropic client (anything with messages.create)
 * @param {{ logUsage?: Function }} options tests pass a fake logUsage
 * @returns {Promise<Object>} validated tags
 */
const enrichListing = async (listing, imageUrl, config, anthropic, options = {}) => {
  const { logUsage = logClaudeUsage } = options;
  const colors = colorOptions(config);

  const response = await anthropic.messages.create({
    model: ENRICH_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: systemPrompt(colors),
    messages: [{ role: 'user', content: userContent(sellerFields(listing, config), imageUrl) }],
    output_config: { format: { type: 'json_schema', schema: tagSchema(colors) } },
  });
  logUsage({ purpose: 'enrich', model: response.model, usage: response.usage });

  if (response.stop_reason !== 'end_turn') {
    throw new Error(`Claude stopped with ${response.stop_reason}`);
  }
  const text = response.content.find(block => block.type === 'text')?.text;
  if (!text) {
    throw new Error('Claude returned no text');
  }
  return validateTags(JSON.parse(text), listing.attributes.publicData || {}, colors, {
    hasPhoto: !!imageUrl,
  });
};

module.exports = {
  ENRICH_MODEL,
  SINGLE_ENUMS,
  MULTI_ENUMS,
  colorOptions,
  tagSchema,
  systemPrompt,
  sellerFields,
  validateTags,
  enrichListing,
};
