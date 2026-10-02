/**
 * POST /api/smart-search. A thin Express handler around runSearch (search.js).
 *
 * Success: 200, application/transit+json (the response carries UUID and Money types).
 * Errors: JSON { code, message } with the status from CONTRACT.md §9.
 */
const sdkUtils = require('../../api-util/sdk');
const defaultLog = require('../../log');
const { createAnthropicClient } = require('../../smart-search-lib/clients');
const { searchError } = require('./request');
const { runSearch } = require('./search');

const sendError = (res, error, log) => {
  const known = error && error.isSearchError ? error : null;
  const { status, code, message } =
    known || searchError(500, 'INTERNAL_ERROR', 'Smart search failed');

  if (status >= 500) {
    const cause = (known && known.cause) || error;
    log.error(cause, 'smart-search-failed', cause && cause.data);
  }
  res
    .status(status)
    .json({ code, message })
    .end();
};

/**
 * @param {Object} deps
 * @param {() => Promise<{ config, vectors }>} deps.getStaticData from startup.js
 * @param {(req, res) => Object} [deps.getSdk] Marketplace SDK for this request
 * @param {() => Object} [deps.getAnthropic] Anthropic client for the intent call
 * @param {Function} [deps.logUsage] Claude usage logger (defaults to the usage log)
 * @param {Object} [deps.log] logger with error(error, code, data)
 */
const createSmartSearchHandler = ({
  getStaticData,
  getSdk = sdkUtils.getSdk,
  getAnthropic = createAnthropicClient,
  logUsage,
  log = defaultLog,
}) => (req, res) => {
  // A missing API key must not break search: the intent step falls back (D6, INTENT_FALLBACK).
  const anthropicOrNull = () => {
    try {
      return getAnthropic();
    } catch (e) {
      log.error(e, 'smart-search-anthropic-unavailable');
      return null;
    }
  };

  const staticData = Promise.resolve()
    .then(getStaticData)
    .catch(e => {
      throw Object.assign(searchError(502, 'UPSTREAM_ERROR', 'Marketplace config unavailable'), {
        cause: e,
      });
    });

  return staticData
    .then(({ config, vectors }) =>
      runSearch(req.body, {
        sdk: getSdk(req, res),
        config,
        vectors,
        anthropic: anthropicOrNull(),
        logUsage,
        onIntentError: e => log.error(e, 'smart-search-intent-failed'),
      })
    )
    .then(body => {
      res
        .status(200)
        .set('Content-Type', 'application/transit+json')
        .send(sdkUtils.serialize(body))
        .end();
    })
    .catch(e => sendError(res, e, log));
};

module.exports = { createSmartSearchHandler, runSearch };
