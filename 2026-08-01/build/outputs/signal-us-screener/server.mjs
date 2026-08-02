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
if (!key) throw new Error('FMP_API_KEY is missing. Add it as an environment variable before starting DollarDisha.');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
const symbol = value => /^[A-Z.]{1,10}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : null;

async function fmp(path, parameters = {}) {
  const url = new URL(`https://financialmodelingprep.com/stable/${path}`);
  Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, value));
  url.searchParams.set('apikey', key);
  const response = await fetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.local' } });
  if (!response.ok) throw new Error(`FMP returned ${response.status}`);
  return response.json();
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
        fmp('profile', { symbol:ticker }), fmp('quote', { symbol:ticker }),
        fmp('key-metrics-ttm', { symbol:ticker }), fmp('income-statement', { symbol:ticker, limit:4 })
        , optional('balance-sheet-statement'), optional('cash-flow-statement'), optional('ratios-ttm')
      ]);
      await cacheCompany(ticker, profile[0], quote[0], { income, balance, cashflow, ratios });
      return send(res, 200, { profile: profile[0] || {}, quote: quote[0] || {}, metrics: metrics[0] || {}, income, balance, cashflow, ratios: ratios[0] || {} });
    }
    if (url.pathname === '/data/market' || url.pathname === '/api/market') {
      // Broad-market ETFs are not available under every FMP plan. These liquid US equities
      // give the dashboard reliable live quotes while keeping its free-tier usage low.
      const tickers = ['NVDA', 'MSFT', 'AAPL', 'GOOGL'];
      const quotes = await Promise.all(tickers.map(ticker => fmp('quote', { symbol:ticker })));
      return send(res, 200, quotes.map(item => item[0] || {}));
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
