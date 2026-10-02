/**
 * Local text embeddings with bge-small-en-v1.5 (D13), used by the indexer and the server.
 *
 * Listing text is embedded as is; query text gets the model's retrieval prefix. Vectors are
 * normalised, so cosine similarity is a dot product.
 *
 * The first real run downloads the quantized model (about 34 MB) into the transformers.js cache.
 */
const MODEL = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Required lazily so tests (which pass a fake) never load transformers.js or the model.
const loadExtractor = () => {
  const { pipeline } = require('@huggingface/transformers');
  return pipeline('feature-extraction', MODEL, { dtype: 'q8' });
};

const normalise = values => {
  const length = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (!length) {
    throw new Error('Embedding is all zeros');
  }
  return values.map(v => Number((v / length).toFixed(6)));
};

/**
 * Load the model once and return embedding functions.
 *
 * @param {{ loadModel?: () => Promise<Function> }} options loadModel returns a feature-extraction
 *   function (text, options) => { data }; tests pass a fake
 * @returns {Promise<{ model, dim, embedListing: (text) => Promise<number[]>,
 *   embedQuery: (text) => Promise<number[]> }>}
 */
const createEmbedder = async ({ loadModel = loadExtractor } = {}) => {
  const extractor = await loadModel();

  // bge models use the CLS token embedding.
  const embed = async text => {
    const output = await extractor(text, { pooling: 'cls', normalize: true });
    const values = Array.from(output.data);
    if (values.length !== DIM) {
      throw new Error(`Expected a ${DIM}-dim embedding, got ${values.length}`);
    }
    return normalise(values);
  };

  return {
    model: MODEL,
    dim: DIM,
    embedListing: text => embed(text),
    embedQuery: text => embed(QUERY_PREFIX + text),
  };
};

module.exports = { MODEL, DIM, QUERY_PREFIX, createEmbedder };
