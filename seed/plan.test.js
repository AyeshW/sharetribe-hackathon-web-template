const fs = require('fs');
const path = require('path');
const plan = require('./plan.json');
const config = require('./fixtures/marketplace-config.json');
const existing = require('./fixtures/existing-listings.json');
const { validateListing } = require('./validate');

const ROOT = path.join(__dirname, '..');
const TEST_TYPES = [
  'synonyms',
  'typos',
  'occasion',
  'season',
  'kids',
  'constraints',
  'colour-in-photo',
  'negation',
  'brand',
  'style',
  'multi-constraint',
  'edge-case',
];

const keys = plan.listings.map(l => l.key);
const listingByKey = Object.fromEntries(plan.listings.map(l => [l.key, l]));
const existingSellIds = existing
  .filter(l => l.publicData.listingType === 'sell-used-products')
  .map(l => l.id);

describe('seed/plan.json', () => {
  it('has unique listing keys and query ids', () => {
    expect(new Set(keys).size).toBe(keys.length);
    const ids = plan.queries.map(q => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every test type at least twice', () => {
    TEST_TYPES.forEach(type => {
      expect([type, plan.queries.filter(q => q.tests === type).length >= 2]).toEqual([type, true]);
    });
    plan.queries.forEach(q => expect(TEST_TYPES).toContain(q.tests));
  });

  it('every relevant ref points to a seed listing or a published existing sell listing', () => {
    plan.queries.forEach(q =>
      q.relevant.forEach(({ ref, grade }) => {
        const [kind, id] = ref.split(':');
        expect([1, 2]).toContain(grade);
        if (kind === 'seed') {
          expect([ref, keys.includes(id)]).toEqual([ref, true]);
        } else {
          expect([ref, kind === 'existing' && existingSellIds.includes(id)]).toEqual([ref, true]);
        }
      })
    );
  });

  it('every query has a grade-2 listing and at least 2 relevant', () => {
    plan.queries.forEach(q => {
      expect([q.id, q.relevant.some(r => r.grade === 2), q.relevant.length >= 2]).toEqual([
        q.id,
        true,
        true,
      ]);
    });
  });

  it('every seed listing is used by a query, and lists every query that marks it relevant', () => {
    const queryIds = plan.queries.map(q => q.id);
    plan.listings.forEach(l => {
      expect([l.key, l.forQueries.length > 0]).toEqual([l.key, true]);
      l.forQueries.forEach(id => expect(queryIds).toContain(id));
    });
    plan.queries.forEach(q =>
      q.relevant
        .filter(r => r.ref.startsWith('seed:'))
        .forEach(r => {
          const key = r.ref.slice('seed:'.length);
          expect([key, listingByKey[key].forQueries.includes(q.id)]).toEqual([key, true]);
        })
    );
  });

  it('every listing passes validateListing with the config snapshot', () => {
    plan.listings.forEach(l => expect([l.key, validateListing(l, config)]).toEqual([l.key, []]));
  });

  it('every image file exists and is credited in the description', () => {
    plan.listings
      .filter(l => l.image)
      .forEach(l => {
        expect([l.key, fs.existsSync(path.join(ROOT, l.image.file))]).toEqual([l.key, true]);
        expect(l.description.endsWith(`Image by ${l.image.pixabayUser} from Pixabay`)).toBe(true);
      });
  });

  it('hidden grade-2 matches for colour-in-photo queries have a photo and no colour field', () => {
    const photoOnly = plan.queries
      .filter(q => q.tests === 'colour-in-photo')
      .flatMap(q => q.relevant.filter(r => r.grade === 2 && r.ref.startsWith('seed:')))
      .map(r => listingByKey[r.ref.slice('seed:'.length)])
      .filter(l => l.role === 'hidden');
    expect(photoOnly.length).toBeGreaterThan(0);
    photoOnly.forEach(l => {
      expect([l.key, !!l.image, l.publicData.color]).toEqual([l.key, true, undefined]);
    });
  });
});
