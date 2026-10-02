const { MODEL, DIM, QUERY_PREFIX, createEmbedder } = require('./embed');

// Fake feature-extraction function: a 384-dim vector derived from the text length, not normalised.
const fakeLoadModel = calls => async () => async (text, options) => {
  calls.push({ text, options });
  return { data: Float32Array.from({ length: DIM }, (_, i) => (i % 7) + text.length) };
};

const length = v => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

describe('createEmbedder', () => {
  it('loads the model once', async () => {
    const loadModel = jest.fn(fakeLoadModel([]));
    const embedder = await createEmbedder({ loadModel });
    await embedder.embedListing('a');
    await embedder.embedQuery('b');
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(embedder.model).toBe(MODEL);
    expect(embedder.model).toBe('Xenova/bge-small-en-v1.5');
    expect(embedder.dim).toBe(384);
  });

  it('embeds listing text as is and query text with the D13 prefix, using CLS pooling', async () => {
    const calls = [];
    const embedder = await createEmbedder({ loadModel: fakeLoadModel(calls) });
    await embedder.embedListing('Brown suede jacket');
    await embedder.embedQuery('vintage jacket');
    expect(calls[0]).toEqual({
      text: 'Brown suede jacket',
      options: { pooling: 'cls', normalize: true },
    });
    expect(calls[1].text).toBe(
      'Represent this sentence for searching relevant passages: vintage jacket'
    );
    expect(QUERY_PREFIX).toBe('Represent this sentence for searching relevant passages: ');
  });

  it('returns normalised 384-dim plain arrays', async () => {
    const embedder = await createEmbedder({ loadModel: fakeLoadModel([]) });
    const vector = await embedder.embedListing('some text');
    expect(Array.isArray(vector)).toBe(true);
    expect(vector).toHaveLength(384);
    expect(length(vector)).toBeCloseTo(1, 5);
  });

  it('rejects a vector with the wrong dimension', async () => {
    const embedder = await createEmbedder({
      loadModel: async () => async () => ({ data: Float32Array.from([1, 2, 3]) }),
    });
    await expect(embedder.embedListing('x')).rejects.toThrow('Expected a 384-dim embedding, got 3');
  });
});
