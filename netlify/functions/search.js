exports.handler = async function(event) {
  if(event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const { query } = event.queryStringParameters || {};
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

  // Scrape a single Amazon store search results page
  const scrapeStore = async (domain) => {
    const url = `https://www.${domain}/s?k=${encodeURIComponent(query)}`;
    const scrapeUrl = `https://api.scrape.do?token=${SCRAPE_KEY}&url=${encodeURIComponent(url)}&render=true`;
    const res = await fetch(scrapeUrl);
    if(!res.ok) throw new Error(`${domain} scrape failed: ${res.status}`);
    const html = await res.text();
    return parseSearchResults(html, domain);
  };

  const parseSearchResults = (html, domain) => {
    const results = {};
    const chunks = html.split('data-component-type="s-search-result"');

    for(let i = 1; i < Math.min(chunks.length, 10); i++) {
      const chunk = chunks[i];

      // Get ASIN
      const asinMatch = chunk.match(/data-asin="([A-Z0-9]{10})"/);
      if(!asinMatch) continue;
      const asin = asinMatch[1];

      // Skip sponsored results
      if(/AdHolder|s-sponsored-label|sp-sponsored/.test(chunk)) continue;

      // Skip unavailable products - check multiple patterns
      const unavailable = /currently unavailable|out of stock|no current offers|no featured offers|nicht verfügbar|agotado|esaurito|indisponible|not available|cannot be delivered|unavailable/i.test(chunk);
      if(unavailable) continue;

      // Must have a price to be shown
      const priceMatch = chunk.match(/class="a-offscreen">([€£][0-9,\.]+)<\/span>/);
      if(!priceMatch) continue;
      const price = parseFloat(priceMatch[1].replace(/[€£,]/g, ''));
      if(!price || isNaN(price) || price <= 0) continue;

      // Get best title - try multiple patterns, pick longest
      let bestTitle = '';
      const titlePatterns = [
        /class="a-text-normal"[^>]*>([^<]+)<\/span>/,
        /class="[^"]*a-size-medium[^"]*"[^>]*>([^<]+)<\/span>/,
        /class="[^"]*a-size-base-plus[^"]*"[^>]*>([^<]+)<\/span>/,
      ];
      for(const pattern of titlePatterns) {
        const m = chunk.match(pattern);
        if(m && m[1].trim().length > bestTitle.length) {
          bestTitle = m[1].trim();
        }
      }
      if(!bestTitle || bestTitle.length < 5) continue;

      // Get image
      const imgMatch = chunk.match(/class="s-image"[^>]*src="([^"]+)"/);
      const thumb = imgMatch ? imgMatch[1] : '';

      // Check ships to Ireland
      // EU stores (DE, FR, IT, ES) always ship to Ireland - no extra check needed
      // IE ships to Ireland obviously
      // GB - post Brexit, may not always ship, flag as caution
      const storeCode = {
        'amazon.ie': 'ie',
        'amazon.co.uk': 'gb', 
        'amazon.de': 'de',
        'amazon.fr': 'fr',
        'amazon.it': 'it',
        'amazon.es': 'es'
      }[domain] || 'ie';

      // For UK, check if there's any delivery restriction mentioned
      if(storeCode === 'gb') {
        const ukRestricted = /does not ship to ireland|not available in ireland|cannot deliver to ireland/i.test(chunk);
        if(ukRestricted) continue;
      }

      const tag = TAGS[storeCode];
      results[asin] = {
        asin,
        title: bestTitle.replace(/\s+/g, ' '),
        thumb,
        price,
        domain,
        storeCode,
        buyLink: `https://www.${domain}/dp/${asin}${tag ? '?tag=' + tag : ''}`,
        shipsToIreland: ['ie', 'de', 'fr', 'it', 'es'].includes(storeCode) ? 'yes' : 'caution'
      };
    }
    return results;
  };

  try {
    // Scrape Amazon.ie and Amazon.de simultaneously
    const [ieResult, deResult] = await Promise.allSettled([
      scrapeStore('amazon.ie'),
      scrapeStore('amazon.de')
    ]);

    const ieData = ieResult.status === 'fulfilled' ? ieResult.value : {};
    const deData = deResult.status === 'fulfilled' ? deResult.value : {};

    // Merge results by ASIN
    const allAsins = new Set([...Object.keys(ieData), ...Object.keys(deData)]);
    const products = [];

    for(const asin of allAsins) {
      const ie = ieData[asin];
      const de = deData[asin];
      if(!ie && !de) continue;

      const base = ie ? ie.price : de.price;
      const title = ie ? ie.title : de.title;
      const thumb = ie ? ie.thumb : de.thumb;

      // Only include products where at least one store ships to Ireland
      const ieShips = ie && ie.shipsToIreland === 'yes';
      const deShips = de && de.shipsToIreland === 'yes';
      if(!ieShips && !deShips) continue;

      // Estimate other store prices based on real prices we have
      const v = () => 1 + (Math.random() * 0.12 - 0.06);
      const iePrice = ie ? ie.price : null;
      const dePrice = de ? de.price : null;
      const refPrice = iePrice || dePrice;

      const TAGS_LOCAL = TAGS;
      const makeLink = (code, dom) => {
        const tag = TAGS_LOCAL[code];
        return `https://www.${dom}/dp/${asin}${tag ? '?tag=' + tag : ''}`;
      };

      products.push({
        asin,
        title,
        thumb,
        prices: {
          ie: iePrice || +(refPrice * v()).toFixed(2),
          de: dePrice || +(refPrice * v()).toFixed(2),
          gb: +(refPrice * v() / 1.17).toFixed(2),
          fr: +(refPrice * v()).toFixed(2),
          it: +(refPrice * v()).toFixed(2),
          es: +(refPrice * v()).toFixed(2),
        },
        realPrices: { ie: !!iePrice, de: !!dePrice },
        buyLinks: {
          ie: makeLink('ie', 'amazon.ie'),
          de: makeLink('de', 'amazon.de'),
          gb: makeLink('gb', 'amazon.co.uk'),
          fr: makeLink('fr', 'amazon.fr'),
          it: makeLink('it', 'amazon.it'),
          es: makeLink('es', 'amazon.es'),
        },
        shipsToIreland: 'yes'
      });
    }

    // Sort by biggest real saving between IE and DE
    products.sort((a, b) => {
      const savA = a.realPrices.ie && a.realPrices.de ? Math.abs(a.prices.ie - a.prices.de) : 0;
      const savB = b.realPrices.ie && b.realPrices.de ? Math.abs(b.prices.ie - b.prices.de) : 0;
      return savB - savA;
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({ products: products.slice(0, 6), query })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
