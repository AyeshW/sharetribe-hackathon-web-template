const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadStaticData } = require('./startup');
const { config } = require('./test-data');

const ASSET_KEYS = {
  'listings/listing-fields.json': 'listingFields',
  'listings/listing-categories.json': 'categories',
  'listings/listing-types.json': 'listingTypes',
};
const fakeAssetSdk = () => ({
  assetByAlias: jest.fn(({ path: assetPath }) => {
    const key = ASSET_KEYS[assetPath];
    return Promise.resolve({ data: { data: { [key]: config[key] } } });
  }),
});

const tempFile = content => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-search-'));
  const file = path.join(dir, 'vectors.json');
  if (content) {
    fs.writeFileSync(file, JSON.stringify(content));
  }
  return file;
};

describe('loadStaticData', () => {
  const vectors = {
    model: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    listings: { a: { hash: 'h', vector: [1, 0] } },
  };

  it('loads the marketplace config and vectors.json', async () => {
    const sdk = fakeAssetSdk();
    const warn = jest.fn();
    const result = await loadStaticData({ sdk, vectorsFile: tempFile(vectors), warn });
    expect(result.config.categories).toEqual(config.categories);
    expect(result.config.listingFields).toEqual(config.listingFields);
    expect(result.vectors).toEqual(vectors);
    expect(sdk.assetByAlias).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores vectors made by another model (D13)', async () => {
    const warn = jest.fn();
    const other = { ...vectors, model: 'other-model' };
    const result = await loadStaticData({
      sdk: fakeAssetSdk(),
      vectorsFile: tempFile(other),
      warn,
    });
    expect(result.vectors.listings).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it('works without vectors.json', async () => {
    const warn = jest.fn();
    const result = await loadStaticData({ sdk: fakeAssetSdk(), vectorsFile: tempFile(), warn });
    expect(result.vectors.listings).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it('fails when the config cannot be fetched', async () => {
    const sdk = { assetByAlias: () => Promise.reject(new Error('down')) };
    await expect(loadStaticData({ sdk, vectorsFile: tempFile(vectors) })).rejects.toThrow('down');
  });
});
