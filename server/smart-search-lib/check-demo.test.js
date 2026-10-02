const {
  REQUIRED_ENV,
  checkEnv,
  checkModelCached,
  checkVectorsFile,
  checkVectorCount,
  runChecks,
  formatResult,
} = require('./check-demo');

const MODEL = 'Xenova/bge-small-en-v1.5';
const VECTORS_FILE = '/fake/vectors.json';
const MODEL_FILE = '/fake/model_quantized.onnx';

// A fake file system: `files` maps path to content.
const fakeFs = files => ({
  existsSync: file => Object.prototype.hasOwnProperty.call(files, file),
  readFileSync: file => files[file],
});

const vectorsJson = (count, model = MODEL) =>
  JSON.stringify({
    model,
    dim: 384,
    listings: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`id-${i}`, { vector: [1] }])
    ),
  });

const fullEnv = Object.fromEntries(REQUIRED_ENV.map(name => [name, 'secret-value']));
const config = { listingFields: [{}, {}], categories: [{}] };

const checks = overrides =>
  runChecks({
    env: fullEnv,
    fs: fakeFs({ [VECTORS_FILE]: vectorsJson(3), [MODEL_FILE]: 'onnx' }),
    loadConfig: () => Promise.resolve(config),
    countLiveListings: () => Promise.resolve(3),
    vectorsFile: VECTORS_FILE,
    modelFile: MODEL_FILE,
    ...overrides,
  });

const statusOf = (results, name) => results.find(r => r.name === name).status;

describe('checkEnv', () => {
  it('passes a set variable and fails a missing or blank one, by name only', () => {
    const env = { ...fullEnv, ANTHROPIC_API_KEY: '  ' };
    delete env.SHARETRIBE_SDK_CLIENT_SECRET;
    const results = checkEnv(env);

    expect(statusOf(results, 'env REACT_APP_SHARETRIBE_SDK_CLIENT_ID')).toBe('PASS');
    expect(statusOf(results, 'env SHARETRIBE_SDK_CLIENT_SECRET')).toBe('FAIL');
    expect(statusOf(results, 'env ANTHROPIC_API_KEY')).toBe('FAIL');
    expect(JSON.stringify(checkEnv(fullEnv))).not.toContain('secret-value');
  });
});

describe('checkModelCached', () => {
  it('passes when the model file exists and fails otherwise', () => {
    expect(checkModelCached(fakeFs({ [MODEL_FILE]: 'x' }), MODEL_FILE).status).toBe('PASS');
    expect(checkModelCached(fakeFs({}), MODEL_FILE).status).toBe('FAIL');
  });
});

describe('checkVectorsFile', () => {
  it('passes with the listing count for a vectors.json of the current model', () => {
    const { check, count } = checkVectorsFile(
      fakeFs({ [VECTORS_FILE]: vectorsJson(2) }),
      VECTORS_FILE
    );
    expect(check.status).toBe('PASS');
    expect(count).toBe(2);
  });

  it('fails when the file is missing, broken or made by another model', () => {
    const fail = files => checkVectorsFile(fakeFs(files), VECTORS_FILE);
    expect(fail({}).check.status).toBe('FAIL');
    expect(fail({ [VECTORS_FILE]: '{not json' }).check.status).toBe('FAIL');
    expect(fail({ [VECTORS_FILE]: vectorsJson(2, 'other') }).check.status).toBe('FAIL');
    expect(fail({}).count).toBeNull();
  });
});

describe('checkVectorCount', () => {
  it('passes on equal counts and warns on a mismatch', () => {
    expect(checkVectorCount(3, 3).status).toBe('PASS');
    const mismatch = checkVectorCount(2, 3);
    expect(mismatch.status).toBe('WARN');
    expect(mismatch.detail).toContain('restart the server');
  });
});

describe('runChecks', () => {
  it('passes everything when all is in place', async () => {
    const results = await checks();
    expect(results.map(r => r.status)).toEqual(results.map(() => 'PASS'));
    expect(results.map(r => r.name)).toEqual([
      ...REQUIRED_ENV.map(name => `env ${name}`),
      'Marketplace config',
      'vectors.json',
      'Vectors match live listings',
      'Embedding model cached',
    ]);
  });

  it('fails the config line when the config does not load', async () => {
    const results = await checks({ loadConfig: () => Promise.reject(new Error('401')) });
    expect(statusOf(results, 'Marketplace config')).toBe('FAIL');
  });

  it('fails vectors.json and skips the count when the file is missing', async () => {
    const countLiveListings = jest.fn();
    const results = await checks({ fs: fakeFs({ [MODEL_FILE]: 'x' }), countLiveListings });
    expect(statusOf(results, 'vectors.json')).toBe('FAIL');
    expect(results.some(r => r.name === 'Vectors match live listings')).toBe(false);
    expect(countLiveListings).not.toHaveBeenCalled();
  });

  it('warns when the vector count differs from the live count', async () => {
    const results = await checks({ countLiveListings: () => Promise.resolve(5) });
    expect(statusOf(results, 'Vectors match live listings')).toBe('WARN');
  });

  it('fails the model line when the model is not cached', async () => {
    const results = await checks({ fs: fakeFs({ [VECTORS_FILE]: vectorsJson(3) }) });
    expect(statusOf(results, 'Embedding model cached')).toBe('FAIL');
  });
});

describe('formatResult', () => {
  it('prints status, name and detail on one line', () => {
    expect(formatResult({ status: 'PASS', name: 'vectors.json', detail: '3 listings' })).toBe(
      'PASS vectors.json: 3 listings'
    );
  });
});
