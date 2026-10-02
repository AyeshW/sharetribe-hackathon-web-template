/**
 * Client factories for smart search scripts and server code.
 *
 * Every factory reads its settings from an env object (process.env by default) and throws an error
 * that names the missing variable. Secret values are never logged or included in error messages.
 *
 * Scripts run by hand call loadEnv() first, so .env files are loaded the same way the server
 * loads them (server/env.js, which requires NODE_ENV).
 */
const sharetribeSdk = require('sharetribe-flex-sdk');
const sharetribeIntegrationSdk = require('sharetribe-flex-integration-sdk');
const Anthropic = require('@anthropic-ai/sdk');

const loadEnv = () => require('../env').configureEnv();

const requireEnv = (env, name) => {
  const value = (env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Set it in .env.`);
  }
  return value;
};

/**
 * Marketplace API SDK with the public client ID (anonymous, read-only).
 */
const createMarketplaceSdk = (env = process.env) => {
  const clientId = requireEnv(env, 'REACT_APP_SHARETRIBE_SDK_CLIENT_ID');
  const baseUrl = env.REACT_APP_SHARETRIBE_SDK_BASE_URL;
  const assetCdnBaseUrl = env.REACT_APP_SHARETRIBE_SDK_ASSET_CDN_BASE_URL;

  return sharetribeSdk.createInstance({
    clientId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(assetCdnBaseUrl ? { assetCdnBaseUrl } : {}),
  });
};

/**
 * Integration API SDK with the SDK's built-in client-side rate limiting (dev/demo limits).
 */
const createIntegrationSdk = (env = process.env) => {
  const clientId = requireEnv(env, 'SHARETRIBE_INTEGRATION_CLIENT_ID');
  const clientSecret = requireEnv(env, 'SHARETRIBE_INTEGRATION_CLIENT_SECRET');
  const { util } = sharetribeIntegrationSdk;

  return sharetribeIntegrationSdk.createInstance({
    clientId,
    clientSecret,
    queryLimiter: util.createRateLimiter(util.devQueryLimiterConfig),
    commandLimiter: util.createRateLimiter(util.devCommandLimiterConfig),
  });
};

/**
 * Claude API client. Every call made with it must be logged with logClaudeUsage (usage.js).
 */
const createAnthropicClient = (env = process.env) => {
  const apiKey = requireEnv(env, 'ANTHROPIC_API_KEY');
  return new Anthropic({ apiKey });
};

const getPixabayApiKey = (env = process.env) => requireEnv(env, 'PIXABAY_API_KEY');

/**
 * User UUIDs that own seeded listings, from the comma-separated SEED_AUTHOR_IDS.
 */
const getSeedAuthorIds = (env = process.env) => {
  const ids = requireEnv(env, 'SEED_AUTHOR_IDS')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error('Missing environment variable SEED_AUTHOR_IDS. Set it in .env.');
  }
  return ids;
};

module.exports = {
  loadEnv,
  createMarketplaceSdk,
  createIntegrationSdk,
  createAnthropicClient,
  getPixabayApiKey,
  getSeedAuthorIds,
};
