exports.handler = async function(event) {
  if(event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const { query } = event.queryStringParameters || {};
  if(!query) return { statusCode: 400, body: JSON.stringify({ error: 'Missing query' }) };

  const API_KEY = process.env.RAINFOREST_API_KEY;
  const TAGS = {
    ie: process.env.AMAZON_TAG_IE || '',
    gb: process.env.AMAZON_TAG_GB || '',
    de: process.env.AMAZON_TAG_DE || '',
    fr: process.env.AMAZON_TAG_FR || '',
    it: process.env.AMAZON_TAG_IT || '',
    es: process.env.AMAZON_TAG_ES || '',
  };

  if(!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  const STORES = [
    { code: 'ie', domain: 'amazon.ie' },
    { code: 'gb', domain: 'amazon.co.uk' },
    { code: 'de', domain: 'amazon.de' },
    { code: 'fr', domain: 'amazon.fr' },
    { code: 'it', domain: 'amazon.it' },
    { code: 'es', domain: 'amazon.es' },
  ];

  const rf = async (params) => {
    const url = 'https://api.rainforestapi.com/request?' + 
      Object.entries({ api_key: API_KEY, ...params })
        .map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');
    const res = await fetch(url);
    if(!res.ok) throw new Error('Rainforest error ' + res.status);
    return res.json();
  };

  try {
    // Step 1 — Search Amazon.ie to get top ASINs (1 credit)
    const searchData = await rf({
      type: 'search',
      amazon_domain: 'amazon.ie',
      search_term: query
    });

    const searchResults = (searchData.search_results || [])
      .filter(r => r.asin && !r.is_sponsored)
      .slice(0, 3); // Top 3 to save credits

    if(!searchResults.length) return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ products: [], query })
    };

    // Step 2 — For each ASIN query all 6 stores simultaneously
    const productPromises = searchResults.map(async (result) => {
      const asin = result.asin;
      const thumb = result.image || '';
      const title = result.title || '';

      // Query all 6 stores in parallel (6 credits per product)
      const storeResults = await Promise.allSettled(
        STORES.map(store => rf({
          type: 'product',
          amazon_domain: store.domain,
          asin: asin
        }))
      );

      const prices = {};
      const buyLinks = {};
      let hasAnyPrice = false;

      storeResults.forEach((res, idx) => {
        const store = STORES[idx];
        const tag = TAGS[store.code];
        buyLinks[store.code] = `https://www.${store.domain}/dp/${asin}${tag ? '?tag=' + tag : ''}`;

        if(res.status !== 'fulfilled') return;
        const product = res.value.product;
        if(!product) return;

        // Check availability
        const buybox = product.buybox_winner;
        if(!buybox) return;
        if(buybox.availability && buybox.availability.type !== 'in_stock') return;
        if(!buybox.price || !buybox.price.value) return;

        // Convert to EUR if GBP
        let price = buybox.price.value;
        if(store.code === 'gb' && buybox.price.currency === 'GBP') {
          price = +(price * 1.17).toFixed(2); // Convert GBP to EUR approx
        }

        prices[store.code] = price;
        hasAnyPrice = true;
      });

      if(!hasAnyPrice) return null;

      return {
        asin,
        title,
        thumb,
        inStock: true,
        prices,
        buyLinks
      };
    });

    const settled = await Promise.allSettled(productPromises);
    const products = settled
      .filter(r => r.status === 'fulfilled' && r.value && Object.keys(r.value.prices).length > 0)
      .map(r => r.value);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({ products, query })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
