exports.handler = async function(event) {
  if(event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const { query, store } = event.queryStringParameters || {};
  if(!query) return { statusCode: 400, body: JSON.stringify({ error: 'Missing query' }) };

  const SCRAPE_KEY = process.env.SCRAPE_DO_KEY;
  const TAGS = {
    ie: process.env.AMAZON_TAG_IE || '',
    gb: process.env.AMAZON_TAG_GB || '',
    de: process.env.AMAZON_TAG_DE || '',
    fr: process.env.AMAZON_TAG_FR || '',
    it: process.env.AMAZON_TAG_IT || '',
    es: process.env.AMAZON_TAG_ES || '',
  };

  if(!SCRAPE_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  const targetStore = store || 'amazon.ie';
  const scrapeUrl = `https://api.scrape.do?token=${SCRAPE_KEY}&url=${encodeURIComponent('https://www.' + targetStore + '/s?k=' + encodeURIComponent(query))}&render=true`;

  try {
    const response = await fetch(scrapeUrl);
    if(!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: 'Scrape failed: ' + response.status }) };

    const html = await response.text();
    const products = [];
    const chunks = html.split('data-component-type="s-search-result"');

    for(let i = 1; i < Math.min(chunks.length, 10); i++) {
      const chunk = chunks[i];

      const asinMatch = chunk.match(/data-asin="([A-Z0-9]{10})"/);
      if(!asinMatch) continue;

      // Full title - grab the longest matching span to get complete product name
      const titleMatch = chunk.match(/class="a-text-normal"[^>]*>([^<]+)<\/span>/) ||
  chunk.match(/class="[^"]*a-size-medium[^"]*"[^>]*>([^<]+)<\/span>/) ||
  chunk.match(/class="[^"]*a-size-base-plus[^"]*"[^>]*>([^<]+)<\/span>/);

      const priceMatch = chunk.match(/class="a-offscreen">([€£$][0-9,\.]+)<\/span>/);
      const imgMatch = chunk.match(/class="s-image"[^>]*src="([^"]+)"/);
      
      // Check availability - skip if explicitly unavailable
      const unavailable = /currently unavailable|out of stock|nicht auf lager|no disponible|non disponibile|indisponible|unavailable|no longer available|not available/i.test(chunk);
if(unavailable) continue;

      if(!titleMatch || !priceMatch) continue;

      const price = parseFloat(priceMatch[1].replace(/[€£$,]/g,''));
      if(!price || isNaN(price)) continue;

      const asin = asinMatch[1];
      const storeCode = {
        'amazon.ie':'ie','amazon.co.uk':'gb','amazon.de':'de',
        'amazon.fr':'fr','amazon.it':'it','amazon.es':'es'
      }[targetStore] || 'ie';

      const tag = TAGS[storeCode];
      products.push({
        asin,
        price,
        title: titleMatch[1].trim().replace(/\s+/g,' '),
        thumb: imgMatch ? imgMatch[1] : '',
        buyLink: `https://www.${targetStore}/dp/${asin}${tag?'?tag='+tag:''}`,
        inStock: true,
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({ products, store: targetStore, query })
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
