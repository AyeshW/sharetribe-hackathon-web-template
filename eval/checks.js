/**
 * The three eval checks from D17. Pure functions: no IO, no network.
 *
 * `resultIds` is the list of listing ids a search returned, best first.
 * `relevant` is the list of correct listings for the query, each `{ id, grade }`,
 * where grade 2 means "clearly right" and grade 1 means "also relevant".
 */

// Only the first page of results counts as "found".
const FOUND_WINDOW = 10;
// "Best in top 3" looks at this many results.
const TOP_WINDOW = 3;

/**
 * How many of the correct listings are in the first 10 results.
 *
 * @param {string[]} resultIds listing ids the search returned, best first
 * @param {Array<{id: string, grade: number}>} relevant correct listings for the query
 * @returns {{found: number, total: number}} e.g. { found: 3, total: 4 }
 */
const found = (resultIds = [], relevant = []) => {
  const window = new Set(resultIds.slice(0, FOUND_WINDOW));
  const relevantIds = new Set(relevant.map(item => item.id));
  const foundCount = [...relevantIds].filter(id => window.has(id)).length;
  return { found: foundCount, total: relevantIds.size };
};

/**
 * True when at least one grade-2 ("clearly right") listing is in the first 3 results.
 *
 * @param {string[]} resultIds listing ids the search returned, best first
 * @param {Array<{id: string, grade: number}>} relevant correct listings for the query
 * @returns {boolean}
 */
const bestInTop3 = (resultIds = [], relevant = []) => {
  const top = new Set(resultIds.slice(0, TOP_WINDOW));
  return relevant.some(item => item.grade === 2 && top.has(item.id));
};

/**
 * A query passes when a clearly right listing is in the top 3 and at least half of the
 * correct listings are in the first 10 results.
 *
 * @param {string[]} resultIds listing ids the search returned, best first
 * @param {Array<{id: string, grade: number}>} relevant correct listings for the query
 * @returns {boolean}
 */
const passes = (resultIds = [], relevant = []) => {
  const { found: foundCount, total } = found(resultIds, relevant);
  const foundAtLeastHalf = foundCount * 2 >= total;
  return bestInTop3(resultIds, relevant) && foundAtLeastHalf;
};

module.exports = { found, bestInTop3, passes, FOUND_WINDOW, TOP_WINDOW };
