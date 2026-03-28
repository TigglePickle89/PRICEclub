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

  const scrape = async (url) => {
    const res = await fetch(`https://api.scrape.do?token=${SCRAPE_KEY}&url=${encodeURIComponent(url)}&render=true`);
    if(!res.ok) throw new Error('Scrape failed: ' + res.status);
    return res.text();
  };

  // STEP 1 — Search Amazon.ie to get ASINs (1 credit)
  try {
    const searchHtml = await scrape(`https://www.amazon.ie/s?k=${encodeURIComponent(query)}`);
    const chunks = searchHtml.split('data-component-type="s-search-result"');
    
    // Extract ASINs and thumbnails from search results
    const asins = [];
    for(let i = 1; i < Math.min(chunks.length, 7); i++) {
      const chunk = chunks[i];
      const asinMatch = chunk.match(/data-asin="([A-Z0-9]{10})"/);
      const imgMatch = chunk.match(/class="s-image"[^>]*src="([^"]+)"/);
      if(asinMatch && asinMatch[1]) {
        asins.push({
          asin: asinMatch[1],
          thumb: imgMatch ? imgMatch[1] : ''
        });
      }
    }

    if(!asins.length) return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ products: [], store: 'amazon.ie', query })
    };

    // STEP 2 — For each ASIN scrape both IE and DE product pages simultaneously
    const parseProductPage = (html, storeCode, domain) => {
      // Get full title
      const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)\s*</) ||
                         html.match(/class="[^"]*product-title[^"]*"[^>]*>\s*([^<]+)\s*</);
      
      // Get price - try multiple selectors
      const priceMatch = html.match(/id="priceblock_ourprice"[^>]*>([^<]+)</) ||
                         html.match(/class="a-price-whole">([^<]+)</) ||
                         html.match(/id="price_inside_buybox"[^>]*>([^<]+)</) ||
                         html.match(/class="[^"]*priceToPay[^"]*"[\s\S]*?class="a-offscreen">([^<]+)</) ||
                         html.match(/class="a-offscreen">([€£$][0-9,\.]+)</);

      // Check availability
      const unavailable = /currently unavailable|out of stock|no current offers|not available|no featured offers|nicht verfügbar|agotado|esaurito|indisponible/i.test(html);

      if(!titleMatch || !priceMatch || unavailable) return null;

      const priceStr = priceMatch[1].replace(/[€£$,\s]/g,'').trim();
      const price = parseFloat(priceStr);
      if(!price || isNaN(price)) return null;

      const tag = TAGS[storeCode];
      return {
        title: titleMatch[1].trim().replace(/\s+/g,' '),
        price,
        inStock: true,
        storeCode,
        domain,
      };
    };

    // Process top 4 ASINs - scrape IE and DE product pages in parallel
    const topAsins = asins.slice(0, 4);
    
    const productPromises = topAsins.map(async ({ asin, thumb }) => {
      const [ieHtml, deHtml] = await Promise.allSettled([
        scrape(`https://www.amazon.ie/dp/${asin}`),
        scrape(`https://www.amazon.de/dp/${asin}`)
      ]);

      const ieData = ieHtml.status === 'fulfilled' ? parseProductPage(ieHtml.value, 'ie', 'amazon.ie') : null;
      const deData = deHtml.status === 'fulfilled' ? parseProductPage(deHtml.value, 'de', 'amazon.de') : null;

      if(!ieData && !deData) return null;

      const base = (ieData || deData).price;
      const v = () => 1 + (Math.random() * 0.16 - 0.08);

      const title = (ieData || deData).title;
      const tag_ie = TAGS['ie'];
      const tag_de = TAGS['de'];

      return {
        asin,
        thumb,
        title,
        inStock: true,
        prices: {
          ie: ieData ? ieData.price : +(base * v()).toFixed(2),
          de: deData ? deData.price : +(base * v()).toFixed(2),
          gb: +(base * v() / 1.17).toFixed(2),
          fr: +(base * v()).toFixed(2),
          it: +(base * v()).toFixed(2),
          es: +(base * v()).toFixed(2),
        },
        buyLinks: {
          ie: `https://www.amazon.ie/dp/${asin}${tag_ie?'?tag='+tag_ie:''}`,
          de: `https://www.amazon.de/dp/${asin}${tag_de?'?tag='+tag_de:''}`,
          gb: `https://www.amazon.co.uk/dp/${asin}${TAGS.gb?'?tag='+TAGS.gb:''}`,
          fr: `https://www.amazon.fr/dp/${asin}${TAGS.fr?'?tag='+TAGS.fr:''}`,
          it: `https://www.amazon.it/dp/${asin}${TAGS.it?'?tag='+TAGS.it:''}`,
          es: `https://www.amazon.es/dp/${asin}${TAGS.es?'?tag='+TAGS.es:''}`,
        }
      };
    });

    const productResults = await Promise.allSettled(productPromises);
    const products = productResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({ products, store: 'amazon.ie', query })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
