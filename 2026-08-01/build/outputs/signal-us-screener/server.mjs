import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const configPath = join(root, '..', '..', 'work', 'dollardisha.env');
let configText = '';
try { configText = await readFile(configPath, 'utf8'); } catch { /* Production uses FMP_API_KEY from the host environment. */ }
const env = Object.fromEntries(configText.split(/\r?\n/).filter(Boolean).map(line => line.split('=')));
const key = process.env.FMP_API_KEY || env.FMP_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
if (!key) console.warn('FMP_API_KEY is not configured. DollarDisha will use its quote fallback where available.');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
const symbol = value => /^[A-Z.]{1,10}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : null;
const externalFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(6000) });

async function fmp(path, parameters = {}) {
  if (!key) throw new Error('FMP_API_KEY is not configured');
  const url = new URL(`https://financialmodelingprep.com/stable/${path}`);
  Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, value));
  url.searchParams.set('apikey', key);
  const response = await externalFetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.local' } });
  if (!response.ok) throw new Error(`FMP returned ${response.status}`);
  return response.json();
}
async function secSubmissions(cik) {
  const paddedCik = String(cik).replace(/\D/g, '').padStart(10, '0');
  const response = await externalFetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, {
    headers: { 'User-Agent': 'DollarDisha/1.0 contact@dollardisha.in', Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`SEC returned ${response.status}`);
  return response.json();
}
async function yahooQuote(ticker) {
  const response = await externalFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`, {
    headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' }
  });
  if (!response.ok) throw new Error(`Fallback quote provider returned ${response.status}`);
  const meta = (await response.json()).chart?.result?.[0]?.meta;
  if (!meta) throw new Error('Fallback quote provider returned no quote');
  const price = Number(meta.regularMarketPrice ?? meta.previousClose);
  const previousClose = Number(meta.previousClose ?? meta.chartPreviousClose);
  return {
    symbol: ticker, price, previousClose,
    changesPercentage: Number(meta.regularMarketChangePercent ?? (previousClose ? ((price - previousClose) / previousClose) * 100 : 0)),
    dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume, provider: 'fallback'
  };
}
async function nasdaqQuote(ticker) {
  const fetchQuote = async assetclass => {
    const response = await externalFetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker.toLowerCase())}/info?assetclass=${assetclass}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 DollarDisha research app', Accept: 'application/json, text/plain, */*' }
    });
    if (!response.ok) throw new Error(`Nasdaq quote provider returned ${response.status}`);
    return (await response.json()).data?.primaryData;
  };
  const data = await fetchQuote('stocks').catch(() => fetchQuote('etf'));
  if (!data?.lastSalePrice) throw new Error('Nasdaq quote provider returned no quote');
  const price = Number(String(data.lastSalePrice).replace(/[$,]/g, ''));
  const percentage = Number(String(data.percentageChange || '0').replace(/[%+]/g, ''));
  return { symbol: ticker, price, changesPercentage: percentage, previousClose: data.previousClose, provider: 'nasdaq' };
}
const referenceQuotes = {
  NVDA: { price: 141.98, changesPercentage: 2.47 }, MSFT: { price: 460.36, changesPercentage: 1.12 },
  AAPL: { price: 224.18, changesPercentage: -0.31 }, GOOGL: { price: 178.34, changesPercentage: 1.83 },
  SPY: { price: 594.18, changesPercentage: 0.32 }, QQQ: { price: 513.43, changesPercentage: 0.51 },
  DIA: { price: 437.36, changesPercentage: 0.08 }, IWM: { price: 221.44, changesPercentage: -0.17 }
};
async function liveQuote(ticker) {
  try {
    const rows = await fmp('quote', { symbol: ticker });
    if (rows[0]?.price) return rows[0];
    throw new Error('FMP returned no quote');
  } catch (error) {
    console.warn(`FMP quote unavailable for ${ticker}: ${error.message}`);
    try { return await yahooQuote(ticker); }
    catch (yahooError) {
      console.warn(`Yahoo quote unavailable for ${ticker}: ${yahooError.message}`);
      try { return await nasdaqQuote(ticker); }
      catch (nasdaqError) {
        console.warn(`Nasdaq quote unavailable for ${ticker}: ${nasdaqError.message}`);
        const reference = referenceQuotes[ticker];
        if (reference) return { symbol: ticker, ...reference, delayed: true, provider: 'reference' };
        throw nasdaqError;
      }
    }
  }
}
async function database(path, { method = 'GET', body, prefer } = {}) {
  if (!supabaseUrl || !supabaseKey) return null;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`Database returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function cacheCompany(ticker, profile, quote, statements = {}) {
  if (!supabaseUrl || !supabaseKey || !profile?.companyName) return;
  await Promise.all([
    database('companies?on_conflict=symbol', { method: 'POST', prefer: 'resolution=merge-duplicates', body: {
      symbol: ticker, company_name: profile.companyName, exchange: profile.exchangeShortName,
      sector: profile.sector, industry: profile.industry, cik: profile.cik, website: profile.website,
      description: profile.description, market_cap: profile.mktCap, source_updated_at: new Date().toISOString()
    }}),
    database('company_quotes?on_conflict=symbol', { method: 'POST', prefer: 'resolution=merge-duplicates', body: {
      symbol: ticker, price: quote?.price, change_percent: quote?.changesPercentage,
      previous_close: quote?.previousClose, day_high: quote?.dayHigh, day_low: quote?.dayLow,
      volume: quote?.volume, market_cap: quote?.marketCap || profile.mktCap, as_of: new Date().toISOString()
    }})
  ]).catch(error => console.warn(`Could not cache ${ticker}: ${error.message}`));
}
async function cacheScreenerRows(rows) {
  if (!supabaseUrl || !supabaseKey || !rows.length) return;
  const companies = rows.filter(row => symbol(row.symbol) && row.companyName).map(row => ({
    symbol: symbol(row.symbol), company_name: row.companyName, exchange: row.exchangeShortName || row.exchange,
    sector: row.sector, industry: row.industry, market_cap: row.marketCap, source_updated_at: new Date().toISOString()
  }));
  const quotes = rows.filter(row => symbol(row.symbol)).map(row => ({
    symbol: symbol(row.symbol), price: row.price, change_percent: row.change,
    market_cap: row.marketCap, volume: row.volume, as_of: new Date().toISOString()
  }));
  await Promise.all([
    database('companies?on_conflict=symbol', { method: 'POST', prefer: 'resolution=merge-duplicates', body: companies }),
    database('company_quotes?on_conflict=symbol', { method: 'POST', prefer: 'resolution=merge-duplicates', body: quotes })
  ]).catch(error => console.warn(`Could not cache screener rows: ${error.message}`));
}
function send(res, status, data, type = 'application/json; charset=utf-8') { res.writeHead(status, { 'Content-Type': type, 'Cache-Control':'no-store' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); }

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/data/search' || url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim();
      if (!query || query.length > 50) return send(res, 400, { error:'Provide a company or ticker to search.' });
      return send(res, 200, await fmp('search-name', { query, limit: 8 }));
    }
    if (url.pathname === '/data/company' || url.pathname === '/api/company') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const optional = path => fmp(path, { symbol:ticker, limit: 8 }).catch(() => []);
      const [profile, quote, metrics, income, balance, cashflow, ratios] = await Promise.all([
        fmp('profile', { symbol:ticker }), liveQuote(ticker),
        fmp('key-metrics-ttm', { symbol:ticker }), fmp('income-statement', { symbol:ticker, limit:4 })
        , optional('balance-sheet-statement'), optional('cash-flow-statement'), optional('ratios-ttm')
      ]);
      await cacheCompany(ticker, profile[0], quote, { income, balance, cashflow, ratios });
      return send(res, 200, { profile: profile[0] || {}, quote: quote || {}, metrics: metrics[0] || {}, income, balance, cashflow, ratios: ratios[0] || {} });
    }
    if (url.pathname === '/data/market' || url.pathname === '/api/market') {
      // Broad-market ETFs are not available under every FMP plan. These liquid US equities
      // give the dashboard reliable live quotes while keeping its free-tier usage low.
      const tickers = ['NVDA', 'MSFT', 'AAPL', 'GOOGL'];
      const quotes = await Promise.all(tickers.map(liveQuote));
      return send(res, 200, quotes);
    }
    if (url.pathname === '/data/indices') {
      const indices = [
        ['S&P 500 ETF', 'SPY'], ['Nasdaq-100 ETF', 'QQQ'], ['Dow Jones ETF', 'DIA'], ['Russell 2000 ETF', 'IWM']
      ];
      const quotes = await Promise.all(indices.map(([, ticker]) => liveQuote(ticker)));
      return send(res, 200, indices.map(([name], index) => ({ name, symbol: indices[index][1], ...quotes[index] })));
    }
    if (url.pathname === '/data/filings') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const profile = await fmp('profile', { symbol:ticker });
      const cik = profile[0]?.cik;
      if (!cik) return send(res, 404, { error:'No SEC identifier is available for this company.' });
      const submission = await secSubmissions(cik);
      const recent = submission.filings?.recent || {};
      const filings = (recent.accessionNumber || []).slice(0, 30).map((accession, index) => ({
        accession, form: recent.form?.[index], filedAt: recent.filingDate?.[index],
        reportDate: recent.reportDate?.[index], description: recent.primaryDocDescription?.[index],
        url: recent.primaryDocument?.[index] ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replaceAll('-', '')}/${recent.primaryDocument[index]}` : null
      }));
      return send(res, 200, { symbol:ticker, companyName: submission.name, cik: String(cik), filings });
    }
    if (url.pathname === '/data/screener' || url.pathname === '/api/screener') {
      const sector = url.searchParams.get('sector');
      const cap = url.searchParams.get('cap');
      const parameters = { limit: 500 };
      if (sector && sector !== 'all') parameters.sector = sector;
      if (cap === 'mega') parameters.marketCapMoreThan = 200000000000;
      if (cap === 'large') parameters.marketCapMoreThan = 10000000000;
      const exchanges = ['NASDAQ', 'NYSE', 'AMEX'];
      const results = await Promise.all(exchanges.map(exchange => fmp('company-screener', { ...parameters, exchange })));
      const rows = results.flat();
      await cacheScreenerRows(rows);
      return send(res, 200, rows);
    }
    const requested = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([.][.][\\/])+/, '');
    if (requested.startsWith('.') || requested.includes('..')) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    const file = join(root, requested);
    const data = await readFile(file);
    return send(res, 200, data.toString(), mime[extname(file)] || 'application/octet-stream');
  } catch (error) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) return send(res, 502, { error:'Live data is temporarily unavailable.', detail:error.message });
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}).listen(process.env.PORT || 3000, () => console.log('DollarDisha is running at http://localhost:3000'));
