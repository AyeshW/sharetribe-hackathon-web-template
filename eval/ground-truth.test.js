const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildGroundTruth, seededListingsByKey, loadGroundTruth } = require('./ground-truth');

const plan = {
  queries: [
    {
      id: 'q01',
      text: 'trainers',
      tests: 'synonyms',
      relevant: [
        { ref: 'seed:white-sneakers', grade: 2 },
        { ref: 'existing:6ab28b71-4240-4ba1-b168-7f238eb9e97d', grade: 1 },
      ],
    },
  ],
  listings: [{ key: 'white-sneakers', title: 'White sneakers, size 39' }],
};

const uploaded = { listings: { 'white-sneakers': { id: 'uuid-1', title: 'uploaded title' } } };
const existingListings = [
  { id: '6ab28b71-4240-4ba1-b168-7f238eb9e97d', title: 'Black and white hi-top sneakers' },
];

describe('seededListingsByKey', () => {
  it('reads a map of key to id', () => {
    const byKey = seededListingsByKey({ listings: { a: 'uuid-a' } });
    expect(byKey.get('a')).toEqual({ id: 'uuid-a', title: null });
  });

  it('reads a map of key to object', () => {
    const byKey = seededListingsByKey({ a: { id: 'uuid-a', title: 'A' } });
    expect(byKey.get('a')).toEqual({ id: 'uuid-a', title: 'A' });
  });

  it('reads a list of objects', () => {
    const byKey = seededListingsByKey([{ key: 'a', id: 'uuid-a', title: 'A' }]);
    expect(byKey.get('a')).toEqual({ id: 'uuid-a', title: 'A' });
  });

  it('explains what it expected when there are no ids at all', () => {
    expect(() => seededListingsByKey({ listings: {} })).toThrow(/no listing ids/);
  });
});

describe('buildGroundTruth', () => {
  it('resolves seed and existing refs to ids and titles', () => {
    const queries = buildGroundTruth({ plan, uploaded, existingListings });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ id: 'q01', text: 'trainers', tests: 'synonyms' });
    expect(queries[0].relevant).toEqual([
      {
        ref: 'seed:white-sneakers',
        id: 'uuid-1',
        title: 'White sneakers, size 39',
        grade: 2,
      },
      {
        ref: 'existing:6ab28b71-4240-4ba1-b168-7f238eb9e97d',
        id: '6ab28b71-4240-4ba1-b168-7f238eb9e97d',
        title: 'Black and white hi-top sneakers',
        grade: 1,
      },
    ]);
  });

  it('falls back to the id as the title for an unknown existing listing', () => {
    const queries = buildGroundTruth({ plan, uploaded, existingListings: [] });
    expect(queries[0].relevant[1].title).toBe('6ab28b71-4240-4ba1-b168-7f238eb9e97d');
  });

  it('names the query and the key when a seeded listing has no id', () => {
    const missing = { listings: { 'something-else': 'uuid-2' } };
    expect(() => buildGroundTruth({ plan, uploaded: missing, existingListings })).toThrow(
      /Query q01 .*"white-sneakers".*seed\/uploaded\.json has no id/s
    );
  });

  it('rejects a ref that is neither seed nor existing', () => {
    const badPlan = {
      ...plan,
      queries: [{ ...plan.queries[0], relevant: [{ ref: 'listing:abc', grade: 2 }] }],
    };
    expect(() => buildGroundTruth({ plan: badPlan, uploaded, existingListings })).toThrow(
      /must start with "seed:" or "existing:"/
    );
  });

  it('refuses a plan with no queries', () => {
    expect(() => buildGroundTruth({ plan: { queries: [] }, uploaded })).toThrow(/no queries/);
  });
});

describe('loadGroundTruth', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ground-truth-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  };

  it('reads the files from disk', () => {
    const queries = loadGroundTruth({
      planFile: write('plan.json', plan),
      uploadedFile: write('uploaded.json', uploaded),
      existingListingsFile: write('existing.json', existingListings),
    });
    expect(queries[0].relevant[0].id).toBe('uuid-1');
  });

  it('says to run the seeder when uploaded.json is missing', () => {
    expect(() =>
      loadGroundTruth({
        planFile: write('plan.json', plan),
        uploadedFile: path.join(dir, 'uploaded.json'),
        existingListingsFile: write('existing.json', existingListings),
      })
    ).toThrow(/uploaded\.json not found.*Run the seeder first/s);
  });
});
