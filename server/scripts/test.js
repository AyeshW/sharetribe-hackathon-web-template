const sdk = require('sharetribe-flex-sdk').createInstance({ clientId: '1e0cef49-ea70-4969-b8cf-011fac1eeeb3' });
sdk.listings.query({ perPage: 50 })
  .then(res => res.data.data.forEach(l => console.log(l)))
  .catch(e => console.log(e.status, e.statusText));
