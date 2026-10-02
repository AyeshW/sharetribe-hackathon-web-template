/**
 * The old search: the marketplace's current keyword search.
 *
 * One Marketplace API query per eval query, exactly what the site's search page does for a
 * keyword search, limited to listings that are for sale.
 */

const LISTING_TYPE = 'sell-used-products';
const PER_PAGE = 10;

/**
 * Make a search function for the eval runner.
 *
 * The SDK is passed in so tests can hand in a fake one and never touch the network.
 *
 * @param {Object} sdk a Marketplace API SDK instance (see server/smart-search-lib/clients.js)
 * @returns {(text: string) => Promise<Array<{id: string, title: string}>>} results in API order
 */
const createOldSearcher = sdk => async text => {
  const response = await sdk.listings.query({
    keywords: text,
    pub_listingType: LISTING_TYPE,
    perPage: PER_PAGE,
  });

  const listings = response?.data?.data || [];
  return listings.map(listing => ({
    id: listing.id?.uuid || listing.id,
    title: listing.attributes?.title || '(no title)',
  }));
};

module.exports = { createOldSearcher, LISTING_TYPE, PER_PAGE };
