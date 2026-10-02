/**
 * Fake listings, config and SDK for the smart search tests. Never touches the network.
 */
const { types } = require('sharetribe-flex-sdk');

const { UUID, Money } = types;

const config = require('../../../seed/fixtures/marketplace-config.json');

/**
 * A listing in the Marketplace API shape, with one image and an author.
 */
const listing = ({
  id,
  title = `Listing ${id}`,
  price = 2000,
  createdAt = '2026-09-01T10:00:00.000Z',
  publicData = {},
  metadata = {},
  authorId = `author-${id}`,
}) => ({
  id: new UUID(id),
  type: 'listing',
  attributes: {
    title,
    description: `${title} description`,
    createdAt: new Date(createdAt),
    state: 'published',
    price: new Money(price, 'EUR'),
    publicData: { listingType: 'sell-used-products', ...publicData },
    metadata,
  },
  relationships: {
    author: { data: { id: new UUID(authorId), type: 'user' } },
    images: { data: [{ id: new UUID(`image-${id}`), type: 'image' }] },
  },
});

const imageOf = l => ({
  id: l.relationships.images.data[0].id,
  type: 'image',
  attributes: { variants: { 'listing-card': { url: `https://img/${l.id.uuid}` } } },
});

const userOf = l => ({
  id: l.relationships.author.data.id,
  type: 'user',
  attributes: { profile: { displayName: `Name ${l.relationships.author.data.id.uuid}` } },
});

/**
 * Fake SDK whose listings.query returns `listings` in pages of `pageSize`.
 */
const fakeSdk = (listings, { pageSize = 100, fail = null } = {}) => {
  const query = jest.fn(params => {
    if (fail) {
      return Promise.reject(fail);
    }
    const page = params.page || 1;
    const data = listings.slice((page - 1) * pageSize, page * pageSize);
    const included = [...data.map(userOf), ...data.map(imageOf)];
    const totalPages = Math.max(1, Math.ceil(listings.length / pageSize));
    return Promise.resolve({ data: { data, included, meta: { page, totalPages } } });
  });
  return { listings: { query } };
};

/**
 * A filter as it appears in state.filters.
 */
const filter = (key, value, overrides = {}) => ({
  key,
  value,
  label: `${key} label`,
  mode: 'hard',
  locked: false,
  source: 'inferred',
  op: key === 'price' ? 'range' : 'eq',
  ...overrides,
});

const state = (filters = [], overrides = {}) => ({
  q: 'some text',
  filters,
  preferences: [],
  removed: [],
  similarTo: null,
  terms: [],
  ...overrides,
});

module.exports = { config, listing, fakeSdk, filter, state, imageOf, userOf };
