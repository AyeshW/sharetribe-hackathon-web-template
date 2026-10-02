const {
  createMarketplaceSdk,
  createIntegrationSdk,
  createAnthropicClient,
  getPixabayApiKey,
  getSeedAuthorIds,
} = require('./clients');

describe('clients', () => {
  describe('missing variables', () => {
    it('createMarketplaceSdk names REACT_APP_SHARETRIBE_SDK_CLIENT_ID', () => {
      expect(() => createMarketplaceSdk({})).toThrow('REACT_APP_SHARETRIBE_SDK_CLIENT_ID');
    });

    it('createIntegrationSdk names the client id, then the secret', () => {
      expect(() => createIntegrationSdk({})).toThrow('SHARETRIBE_INTEGRATION_CLIENT_ID');
      expect(() => createIntegrationSdk({ SHARETRIBE_INTEGRATION_CLIENT_ID: 'id-123' })).toThrow(
        'SHARETRIBE_INTEGRATION_CLIENT_SECRET'
      );
    });

    it('createAnthropicClient names ANTHROPIC_API_KEY', () => {
      expect(() => createAnthropicClient({})).toThrow('ANTHROPIC_API_KEY');
    });

    it('getPixabayApiKey names PIXABAY_API_KEY', () => {
      expect(() => getPixabayApiKey({})).toThrow('PIXABAY_API_KEY');
    });

    it('getSeedAuthorIds names SEED_AUTHOR_IDS', () => {
      expect(() => getSeedAuthorIds({})).toThrow('SEED_AUTHOR_IDS');
    });

    it('treats a whitespace-only value as missing', () => {
      expect(() => createAnthropicClient({ ANTHROPIC_API_KEY: '   ' })).toThrow(
        'ANTHROPIC_API_KEY'
      );
    });

    it('never puts a set value in the error message', () => {
      let message = '';
      try {
        createIntegrationSdk({ SHARETRIBE_INTEGRATION_CLIENT_ID: 'id-123' });
      } catch (e) {
        message = e.message;
      }
      expect(message).not.toContain('id-123');
    });
  });

  describe('with variables set', () => {
    it('creates the marketplace SDK and Anthropic client without network calls', () => {
      expect(
        createMarketplaceSdk({ REACT_APP_SHARETRIBE_SDK_CLIENT_ID: 'abc' }).listings
      ).toBeDefined();
      expect(createAnthropicClient({ ANTHROPIC_API_KEY: 'test-key' }).messages).toBeDefined();
    });

    it('returns the Pixabay key trimmed', () => {
      expect(getPixabayApiKey({ PIXABAY_API_KEY: ' key ' })).toBe('key');
    });
  });

  describe('getSeedAuthorIds', () => {
    it('splits on commas, trims and ignores empty items', () => {
      expect(getSeedAuthorIds({ SEED_AUTHOR_IDS: ' a-1, b-2 ,,c-3, ' })).toEqual([
        'a-1',
        'b-2',
        'c-3',
      ]);
    });

    it('returns a single id', () => {
      expect(getSeedAuthorIds({ SEED_AUTHOR_IDS: 'a-1' })).toEqual(['a-1']);
    });

    it('throws when only separators are given', () => {
      expect(() => getSeedAuthorIds({ SEED_AUTHOR_IDS: ' , ,' })).toThrow('SEED_AUTHOR_IDS');
    });
  });
});
