/**
 * Step ④: initial ranking (D1). Plain arithmetic over precomputed data, no Claude calls.
 *
 *   semantic    = cosine(query vector, listing vector from vectors.json); 0 without a vector (D8)
 *   keyword     = BM25(state.terms + words of q, title + description + enriched tags)
 *   preferences = share of state.preferences and soft filters matched by the enriched tags
 *
 * Each signal is normalised to 0–1 within the candidate set (min–max), then combined with WEIGHTS.
 * Soft filters (inferred colour and brand) only feed the preference signal; they never decide which
 * listings are returned (D5).
 */
const { matchesFilter } = require('./filters');

// Starting weights from D1. The eval may pass other weights to rankListings.
const WEIGHTS = { semantic: 0.5, keyword: 0.3, preferences: 0.2 };

// Standard BM25 parameters.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Words that say nothing about the item and appear in most listing texts.
const STOPWORDS = new Set(
  'a an and or the for of in on at to with but not no is are be it this that my me i some something very'.split(
    ' '
  )
);

// Light plural folding, the same for query and listing text, so "boots" finds "boot".
const singular = word => {
  if (word.length <= 3) {
    return word;
  }
  if (word.endsWith('ies')) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith('sses')) {
    return word.slice(0, -2);
  }
  return word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
};

/**
 * Lowercase word tokens without stopwords, plurals folded.
 *
 * @param {string} text
 * @returns {string[]}
 */
const tokenize = text =>
  (
    String(text || '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || []
  )
    .filter(word => !STOPWORDS.has(word))
    .map(singular);

const aiOf = listing => ((listing.attributes || {}).metadata || {}).ai || {};

// The text word match runs over: the seller's text plus the indexer's garment type, synonyms and
// search text (D8, "coat" finds a bomber jacket).
const listingText = listing => {
  const { title, description } = listing.attributes || {};
  const ai = aiOf(listing);
  return [title, description, ai.garmentType, ...(ai.synonyms || []), ai.searchText]
    .filter(Boolean)
    .join(' ');
};

/**
 * The words the query is matched with: state.terms plus the words of q, each once.
 */
const queryTokens = state => [
  ...new Set(tokenize([state.q, ...(state.terms || [])].filter(Boolean).join(' '))),
];

/**
 * The text the query vector is made from, or '' when there is nothing to embed.
 */
const queryText = state =>
  [state.q, ...(state.terms || [])]
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join(' ');

/**
 * Okapi BM25 of each document for the query tokens.
 *
 * @param {string[]} query tokens
 * @param {string[][]} docs one token list per document
 * @returns {number[]} one raw score per document; all 0 for an empty query
 */
const bm25 = (query, docs) => {
  if (query.length === 0 || docs.length === 0) {
    return docs.map(() => 0);
  }
  const counts = docs.map(tokens =>
    tokens.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map())
  );
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const idf = Object.fromEntries(
    query.map(term => {
      const n = counts.filter(c => c.has(term)).length;
      return [term, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))];
    })
  );

  return counts.map((c, i) =>
    query.reduce((sum, term) => {
      const tf = c.get(term) || 0;
      const lengthNorm = 1 - BM25_B + (BM25_B * docs[i].length) / avgLength;
      return sum + (idf[term] * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm);
    }, 0)
  );
};

/**
 * Cosine similarity; 0 when either vector is missing, empty or all zeros.
 */
const cosine = (a, b) => {
  if (!a || !b || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    lengthA += a[i] * a[i];
    lengthB += b[i] * b[i];
  }
  return lengthA && lengthB ? dot / Math.sqrt(lengthA * lengthB) : 0;
};

/**
 * Min–max normalise to 0–1. `null` entries (no value, e.g. no vector) become 0 and don't count
 * towards the range. When all values are equal there is no range: positive values become 1,
 * zero or negative become 0.
 *
 * @param {Array<?number>} values
 * @returns {number[]}
 */
const normalise = values => {
  const present = values.filter(v => v != null);
  if (present.length === 0) {
    return values.map(() => 0);
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values.map(v => {
    if (v == null) {
      return 0;
    }
    if (max === min) {
      return v > 0 ? 1 : 0;
    }
    return (v - min) / (max - min);
  });
};

const lower = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// The enriched tags a preference can match (D1): style, season, warmth, colour, brand.
const listingTags = listing => {
  const ai = aiOf(listing);
  const publicData = (listing.attributes || {}).publicData || {};
  const colors = publicData.color ? [publicData.color] : ai.colorDetected || [];
  return new Set(
    [
      ...(ai.style || []),
      ...(ai.season || []),
      ai.warmth === 'unknown' ? null : ai.warmth,
      ...colors,
      publicData.brand,
      ai.brand,
    ]
      .map(lower)
      .filter(Boolean)
  );
};

/**
 * Soft filters: inferred colour and brand that the buyer hasn't locked (D3 rule 4).
 */
const softFilters = state => (state.filters || []).filter(f => f.mode === 'soft');

/**
 * Share of the preferences and soft filters a listing matches; 0 when there are none.
 */
const preferenceShare = (state, listing) => {
  const preferences = (state.preferences || []).map(lower).filter(Boolean);
  const soft = softFilters(state);
  const total = preferences.length + soft.length;
  if (total === 0) {
    return 0;
  }
  const tags = listingTags(listing);
  const matched =
    preferences.filter(p => tags.has(p)).length +
    soft.filter(f => matchesFilter(f, listing)).length;
  return matched / total;
};

/**
 * Does the state ask for anything to rank by? Without text, terms, preferences or soft filters it
 * is a pure filter search: every listing that passes the filters is relevant.
 */
const hasRankingSignals = state =>
  !!queryText(state) || (state.preferences || []).length > 0 || softFilters(state).length > 0;

/**
 * Score every candidate.
 *
 * @param {Object} params
 * @param {Array} params.listings candidates from the Marketplace API
 * @param {Object} params.state the search state
 * @param {?number[]} params.queryVector the embedded query, or null (semantic is then 0)
 * @param {Object} [params.vectors] vectors.json content ({ listings: { id: { vector } } })
 * @param {Object} [params.weights] { semantic, keyword, preferences }, default WEIGHTS
 * @returns {{ scores: Map<string, number>,
 *   signals: Map<string, { semantic, keyword, preferences }> }} signals are the normalised
 *   per-signal values, for debugging only; they are never sent in the response
 */
const rankListings = ({ listings, state, queryVector, vectors, weights = WEIGHTS }) => {
  const vectorOf = listing => {
    const entry = ((vectors && vectors.listings) || {})[listing.id.uuid];
    return entry ? entry.vector : null;
  };

  const semantic = normalise(
    listings.map(listing => {
      const vector = vectorOf(listing);
      return queryVector && vector ? cosine(queryVector, vector) : null;
    })
  );
  const keyword = normalise(bm25(queryTokens(state), listings.map(l => tokenize(listingText(l)))));
  const preferences = normalise(listings.map(listing => preferenceShare(state, listing)));

  const scores = new Map();
  const signals = new Map();
  listings.forEach((listing, i) => {
    const id = listing.id.uuid;
    const s = { semantic: semantic[i], keyword: keyword[i], preferences: preferences[i] };
    signals.set(id, s);
    scores.set(
      id,
      weights.semantic * s.semantic +
        weights.keyword * s.keyword +
        weights.preferences * s.preferences
    );
  });
  return { scores, signals };
};

module.exports = {
  WEIGHTS,
  tokenize,
  listingText,
  queryTokens,
  queryText,
  bm25,
  cosine,
  normalise,
  preferenceShare,
  hasRankingSignals,
  rankListings,
};
