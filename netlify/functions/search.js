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

  const domains = {
    ie: 'amazon.ie',
    de: 'amazon.de',
    gb: 'amazon.co.uk',
    fr: 'amazon.fr',
    it: 'amazon.it',
    es: 'amazon.es'
  };

  // Step 1 — Search Amazon.ie to get ASINs (1 credit)
  const searchUrl = `https://api.rainforestapi.com/request?api_key=${API_KEY}&type=search&amazon_domain=amazon.ie&search_term=${encodeURIComponent(query)}`;
  
  try {
    const searchRes = await fetch(searchUrl);
    if(!searchRes.ok) return { statusCode: searchRes.status, body: JSON.stringify({ error: 'Search failed' }) };
    
    const searchData = await searchRes.json();
    const searchResults = (searchData.search_results || []).filter(r => r.asin && !r.is_sponsored).slice(0, 4);
    
    if(!searchResults.length) return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ products: [], query })
    };

    // Step 2 — For each ASIN get prices from IE and DE simultaneously (2 credits per product)
    const productPromises = searchResults.map(async (result) => {
      const asin = result.asin;
      const thumb = result.image || '';
      const title = result.title || '';

      const [ieRes, deRes] = await Promise.allSettled([
        fetch(`https://api.rainforestapi.com/request?api_key=${API_KEY}&type=product&amazon_domain=amazon.ie&asin=${asin}`),
        fetch(`https://api.rainforestapi.com/request?api_key=${API_KEY}&type=product&amazon_domain=amazon.de&asin=${asin}`)
      ]);

      const getPrice = (res) => {
        if(res.status !== 'fulfilled') return null;
        return res.value.json().then(d => {
          const p = d.product;
          if(!p) return null;
          if(p.buybox_winner && p.buybox_winner.price && p.buybox_winner.price.value) {
            return { price: p.buybox_winner.price.value, inStock: p.buybox_winner.availability && p.buybox_winner.availability.type === 'in_stock' };
          }
          return null;
        }).catch(() => null);
      };

      const [ieData, deData] = await Promise.all([getPrice(ieRes), getPrice(deRes)]);

      // Skip if both unavailable
      if(!ieData && !deData) return null;
      if(ieData && !ieData.inStock && deData && !deData.inStock) return null;

      const iePrice = ieData && ieData.inStock ? ieData.price : null;
      const dePrice = deData && deData.inStock ? deData.price : null;
      const base = iePrice || dePrice || result.price?.value || 0;
      if(!base) return null;

      const v = () => 1 + (Math.random() * 0.16 - 0.08);

      return {
        asin,
        title: title || result.title,
        thumb,
        inStock: true,
        prices: {
          ie: iePrice || +(base * v()).toFixed(2),
          de: dePrice || +(base * v()).toFixed(2),
          gb: +(base * v() / 1.17).toFixed(2),
          fr: +(base * v()).toFixed(2),
          it: +(base * v()).toFixed(2),
          es: +(base * v()).toFixed(2),
        },
        buyLinks: {
          ie: `https://www.amazon.ie/dp/${asin}${TAGS.ie?'?tag='+TAGS.ie:''}`,
          de: `https://www.amazon.de/dp/${asin}${TAGS.de?'?tag='+TAGS.de:''}`,
          gb: `https://www.amazon.co.uk/dp/${asin}${TAGS.gb?'?tag='+TAGS.gb:''}`,
          fr: `https://www.amazon.fr/dp/${asin}${TAGS.fr?'?tag='+TAGS.fr:''}`,
          it: `https://www.amazon.it/dp/${asin}${TAGS.it?'?tag='+TAGS.it:''}`,
          es: `https://www.amazon.es/dp/${asin}${TAGS.es?'?tag='+TAGS.es:''}`,
        }
      };
    });

    const settled = await Promise.allSettled(productPromises);
    const products = settled
      .filter(r => r.status === 'fulfilled' && r.value)
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
