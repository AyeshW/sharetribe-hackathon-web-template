const { types } = require('sharetribe-flex-integration-sdk');
const { checkSeeded } = require('./check-seeded');

const plan = {
  listings: [
    { key: 'a', title: 'Shirt A', image: { file: 'seed/images/a.jpg' } },
    { key: 'b', title: 'Shirt B' },
    { key: 'c', title: 'Shirt C' },
  ],
};

const listing = (id, title, imageCount) => ({
  id: new types.UUID(id),
  attributes: { title },
  relationships: { images: { data: Array.from({ length: imageCount }, () => ({})) } },
});

const fakeSdk = listings => {
  const calls = [];
  return {
    calls,
    listings: {
      query: params => {
        calls.push(params);
        return Promise.resolve({
          data: { data: listings.filter(l => params.ids.includes(l.id.uuid)) },
        });
      },
    },
  };
};

describe('checkSeeded', () => {
  it('passes when every uploaded listing is published with the right title and images', async () => {
    const sdk = fakeSdk([listing('id-a', 'Shirt A', 1), listing('id-b', 'Shirt B', 0)]);
    const plan2 = { listings: plan.listings.slice(0, 2) };
    const result = await checkSeeded(sdk, { plan: plan2, uploaded: { a: 'id-a', b: 'id-b' } });
    expect(result).toEqual({ checked: 2, problems: [] });
    expect(sdk.calls).toEqual([{ ids: ['id-a', 'id-b'], include: ['images'], perPage: 100 }]);
  });

  it('reports unpublished, wrong title, wrong image count and not uploaded', async () => {
    const sdk = fakeSdk([listing('id-a', 'Shirt X', 0)]);
    const result = await checkSeeded(sdk, { plan, uploaded: { a: 'id-a', b: 'id-b' } });
    expect(result.problems).toEqual([
      'a: title is "Shirt X", expected "Shirt A"',
      'a: 0 images, expected 1',
      'b: id-b is not published (not returned by the Marketplace API)',
      'c: not uploaded yet',
    ]);
  });
});
