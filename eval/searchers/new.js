/**
 * The new smart search. Not built yet: it arrives in a later phase (D18).
 *
 * Until then the eval reports "New search: not built yet" and only measures the old search.
 * When the smart search exists, this file calls it in-process and returns its results in the
 * same shape as eval/searchers/old.js, and `isBuilt` becomes true.
 */

const isBuilt = false;
const notBuiltMessage = 'not built yet';

/**
 * @returns {?Function} a search function once the smart search exists, null until then
 */
const createNewSearcher = () => null;

module.exports = { isBuilt, notBuiltMessage, createNewSearcher };
