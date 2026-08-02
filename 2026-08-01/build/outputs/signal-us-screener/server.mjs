import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const configPath = join(root, '..', '..', 'work', 'dollardisha.env');
let configText = '';
try { configText = await readFile(configPath, 'utf8'); } catch { /* Production uses FMP_API_KEY from the host environment. */ }
const env = Object.fromEntries(configText.split(/\r?\n/).filter(Boolean).map(line => line.split('=')));
const key = process.env.FMP_API_KEY || env.FMP_API_KEY;
const twelveDataKey = process.env.TWELVE_DATA_API_KEY;
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
let secTickers = { rows: null, expiresAt: 0 };
async function secFactsForTicker(ticker) {
  if (!secTickers.rows || Date.now() > secTickers.expiresAt) {
    const response = await externalFetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': 'DollarDisha/1.0 contact@dollardisha.in', Accept: 'application/json' } });
    if (!response.ok) throw new Error(`SEC ticker directory returned ${response.status}`);
    secTickers = { rows: Object.values(await response.json()), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  }
  const company = secTickers.rows.find(item => String(item.ticker).toUpperCase() === ticker);
  if (!company) return null;
  const cik = String(company.cik_str).padStart(10, '0');
  const response = await externalFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { 'User-Agent': 'DollarDisha/1.0 contact@dollardisha.in', Accept: 'application/json' } });
  if (!response.ok) throw new Error(`SEC company facts returned ${response.status}`);
  return { company, facts: await response.json() };
}
function secMetric(facts, names, unit = 'USD') {
  const gaap = facts?.facts?.['us-gaap'] || {};
  for (const name of names) {
    const rows = gaap[name]?.units?.[unit] || [];
    const annual = rows.filter(row => row.form === '10-K' && row.fp === 'FY' && Number.isFinite(Number(row.val)) && row.fy).sort((a, b) => Number(b.fy) - Number(a.fy) || String(b.filed).localeCompare(String(a.filed)));
    if (annual.length) return annual;
  }
  return [];
}
function annualStatement(facts, definition) {
  const fields = Object.fromEntries(Object.entries(definition).map(([key, names]) => [key, secMetric(facts, names)]));
  const years = [...new Set(Object.values(fields).flat().map(row => row.fy))].sort((a, b) => b - a).slice(0, 8);
  return years.map(year => Object.fromEntries([['calendarYear', String(year)], ...Object.entries(fields).map(([key, rows]) => [key, rows.find(row => row.fy === year)?.val ?? null]) ]));
}
function secFinancials(facts) {
  const income = annualStatement(facts, { revenue:['RevenueFromContractWithCustomerExcludingAssessedTax','SalesRevenueNet','Revenues'], grossProfit:['GrossProfit'], operatingIncome:['OperatingIncomeLoss'], netIncome:['NetIncomeLoss'], eps:['EarningsPerShareDiluted'] });
  const balance = annualStatement(facts, { cashAndCashEquivalents:['CashAndCashEquivalentsAtCarryingValue','CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], totalAssets:['Assets'], totalLiabilities:['Liabilities'], totalStockholdersEquity:['StockholdersEquity','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], totalDebt:['LongTermDebtCurrent','LongTermDebtNoncurrent'] });
  const cashflow = annualStatement(facts, { operatingCashFlow:['NetCashProvidedByUsedInOperatingActivities'], capitalExpenditure:['PaymentsToAcquirePropertyPlantAndEquipment'], freeCashFlow:['NetCashProvidedByUsedInOperatingActivities'], netIncome:['NetIncomeLoss'] }).map(row => ({ ...row, freeCashFlow: Number.isFinite(Number(row.operatingCashFlow)) && Number.isFinite(Number(row.capitalExpenditure)) ? Number(row.operatingCashFlow) - Math.abs(Number(row.capitalExpenditure)) : null }));
  return { income, balance, cashflow };
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
async function twelveDataQuote(ticker) {
  if (!twelveDataKey) throw new Error('TWELVE_DATA_API_KEY is not configured');
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('apikey', twelveDataKey);
  const response = await externalFetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
  const data = await response.json();
  if (!response.ok || data.status === 'error' || data.code || !data.close) throw new Error(data.message || `Twelve Data returned ${response.status}`);
  return {
    symbol: ticker, price: Number(data.close), previousClose: Number(data.previous_close),
    changesPercentage: Number(data.percent_change || 0), dayHigh: Number(data.high), dayLow: Number(data.low),
    volume: Number(data.volume), provider: 'twelve-data'
  };
}
async function priceHistory(ticker, points = 260) {
  try {
    const data = await fmp('historical-price-eod/full', { symbol:ticker });
    const rows = Array.isArray(data) ? data : (data.historical || []);
    const values = rows.slice(0, points).reverse().map(item => ({ date:item.date, close:Number(item.close), volume:Number(item.volume || 0) })).filter(item => Number.isFinite(item.close));
    if (values.length) return values;
  } catch { /* Try Twelve Data and then the last-resort provider below. */ }
  if (twelveDataKey) {
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('interval', '1day');
    url.searchParams.set('outputsize', String(points));
    url.searchParams.set('apikey', twelveDataKey);
    const response = await externalFetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
    const data = await response.json();
    if (response.ok && data.status !== 'error' && Array.isArray(data.values)) return data.values.slice().reverse().map(item => ({ date:item.datetime, close:Number(item.close), volume:Number(item.volume || 0) }));
  }
  const range = points <= 25 ? '1mo' : points <= 130 ? '6mo' : points <= 260 ? '1y' : points <= 780 ? '3y' : points <= 1300 ? '5y' : '10y';
  const response = await externalFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
  if (!response.ok) throw new Error('Historical price data is unavailable');
  const data = (await response.json()).chart?.result?.[0];
  const quote = data?.indicators?.quote?.[0];
  if (!data?.timestamp || !quote?.close) throw new Error('Historical price data is unavailable');
  return data.timestamp.map((timestamp, index) => ({ date:new Date(timestamp * 1000).toISOString().slice(0, 10), close:Number(quote.close[index]), volume:Number(quote.volume[index] || 0) })).filter(item => Number.isFinite(item.close));
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
let twelveDirectory = { rows: [], expiresAt: 0 };
async function twelveStockSearch(query) {
  if (!twelveDataKey) return [];
  if (Date.now() > twelveDirectory.expiresAt) {
    const url = new URL('https://api.twelvedata.com/stocks');
    url.searchParams.set('country', 'United States');
    url.searchParams.set('type', 'Common Stock');
    url.searchParams.set('apikey', twelveDataKey);
    const response = await externalFetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
    const data = await response.json();
    const rows = data.data || [];
    if (!response.ok || data.status === 'error' || !Array.isArray(rows)) throw new Error(data.message || 'Twelve Data stock directory is unavailable');
    twelveDirectory = { rows, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  }
  const needle = query.toUpperCase();
  return twelveDirectory.rows.filter(row => String(row.symbol || '').toUpperCase().includes(needle) || String(row.instrument_name || row.name || '').toUpperCase().includes(needle)).slice(0, 12).map(row => ({
    symbol: row.symbol, name: row.instrument_name || row.name || row.symbol, exchangeShortName: row.exchange || row.mic_code || 'US', type: row.type
  }));
}
async function liveQuote(ticker) {
  if (twelveDataKey) {
    try { return await twelveDataQuote(ticker); }
    catch (error) { console.warn(`Twelve Data quote unavailable for ${ticker}: ${error.message}`); }
  }
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
        throw nasdaqError;
      }
    }
  }
}
async function liveIndex(symbol) {
  try {
    const rows = await fmp('quote', { symbol });
    if (rows[0]?.price) return rows[0];
    throw new Error('FMP returned no index quote');
  } catch (error) {
    console.warn(`FMP index unavailable for ${symbol}: ${error.message}`);
    return yahooQuote(symbol);
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
      try {
        const matches = await twelveStockSearch(query);
        if (matches.length) return send(res, 200, matches);
      } catch (error) { console.warn(`Twelve Data directory unavailable: ${error.message}`); }
      return send(res, 200, await fmp('search-name', { query, limit: 8 }));
    }
    if (url.pathname === '/data/company' || url.pathname === '/api/company') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const optional = path => fmp(path, { symbol:ticker, limit: 8 }).catch(() => []);
      const [profile, quote, metrics, income, balance, cashflow, ratios, secData] = await Promise.all([
        optional('profile'), liveQuote(ticker),
        optional('key-metrics-ttm'), optional('income-statement')
        , optional('balance-sheet-statement'), optional('cash-flow-statement'), optional('ratios-ttm'), secFactsForTicker(ticker).catch(() => null)
      ]);
      const secValues = secData ? secFinancials(secData.facts) : { income:[], balance:[], cashflow:[] };
      const fallbackProfile = { companyName: secData?.facts?.entityName || secData?.company?.title || ticker, cik: secData?.company?.cik_str, sector: 'US Equity', description: secData ? 'Financial statement figures are sourced from this company’s SEC filings.' : 'Latest available price is shown below. Detailed fundamentals are unavailable for this company right now.' };
      const finalIncome = income.length ? income : secValues.income;
      const finalBalance = balance.length ? balance : secValues.balance;
      const finalCashflow = cashflow.length ? cashflow : secValues.cashflow;
      await cacheCompany(ticker, profile[0] || fallbackProfile, quote, { income:finalIncome, balance:finalBalance, cashflow:finalCashflow, ratios });
      return send(res, 200, { profile: profile[0] || fallbackProfile, quote: quote || {}, metrics: metrics[0] || {}, income:finalIncome, balance:finalBalance, cashflow:finalCashflow, ratios: ratios[0] || {} });
    }
    if (url.pathname === '/data/chart') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const requested = Number(url.searchParams.get('points'));
      const points = [22, 130, 260, 780, 1300, 2600].includes(requested) ? requested : 260;
      return send(res, 200, { symbol:ticker, values:await priceHistory(ticker, points) });
    }
    if (url.pathname === '/data/peers') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const peerData = await fmp('stock-peers', { symbol:ticker });
      const peerList = Array.isArray(peerData) ? (peerData[0]?.peersList || []) : (peerData?.peersList || []);
      const rows = await Promise.all(peerList.filter(symbol).filter(item => item !== ticker).slice(0, 6).map(async peer => {
        const [profile, quote, ratios] = await Promise.all([fmp('profile', { symbol:peer }).catch(() => []), liveQuote(peer).catch(() => ({})), fmp('ratios-ttm', { symbol:peer }).catch(() => [])]);
        return { symbol:peer, companyName:profile[0]?.companyName || peer, sector:profile[0]?.sector, marketCap:profile[0]?.mktCap, price:quote.price, change:quote.changesPercentage, pe:ratios[0]?.peRatioTTM };
      }));
      return send(res, 200, rows);
    }
    if (url.pathname === '/data/company-intel') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      // These are intentionally independent: one unavailable premium dataset must
      // never stop the rest of a company research page from loading.
      const optional = (path, parameters = {}) => fmp(path, { symbol:ticker, limit:10, ...parameters }).catch(() => []);
      const [scores, ownerEarnings, earnings, dividends, executives, insiders, estimates, priceTarget, ratings, news] = await Promise.all([
        optional('financial-scores'), optional('owner-earnings'), optional('earnings'), optional('dividends'),
        optional('company-executives'), optional('insider-trading/search', { page:0 }),
        optional('analyst-estimates', { period:'annual', page:0 }), optional('price-target-consensus'),
        optional('ratings-snapshot'), optional('news/stock', { symbols:ticker })
      ]);
      return send(res, 200, {
        scores: Array.isArray(scores) ? scores[0] || {} : scores || {},
        ownerEarnings: Array.isArray(ownerEarnings) ? ownerEarnings.slice(0, 6) : [],
        earnings: Array.isArray(earnings) ? earnings.slice(0, 8) : [],
        dividends: Array.isArray(dividends) ? dividends.slice(0, 8) : [],
        executives: Array.isArray(executives) ? executives.slice(0, 12) : [],
        insiders: Array.isArray(insiders) ? insiders.slice(0, 12) : [],
        estimates: Array.isArray(estimates) ? estimates.slice(0, 8) : [],
        priceTarget: Array.isArray(priceTarget) ? priceTarget[0] || {} : priceTarget || {},
        ratings: Array.isArray(ratings) ? ratings[0] || {} : ratings || {},
        news: Array.isArray(news) ? news.slice(0, 10) : []
      });
    }
    if (url.pathname === '/data/movers') {
      const optional = path => fmp(path, { limit:25 }).catch(() => []);
      const [gainers, losers, active] = await Promise.all([optional('biggest-gainers'), optional('biggest-losers'), optional('most-actives')]);
      return send(res, 200, { gainers, losers, active });
    }
    if (url.pathname === '/data/calendar') {
      const optional = path => fmp(path, { limit:30 }).catch(() => []);
      const [earnings, dividends, ipos] = await Promise.all([optional('earnings-calendar'), optional('dividends-calendar'), optional('ipos-calendar')]);
      return send(res, 200, { earnings, dividends, ipos });
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
        ['S&P 500', '^GSPC'], ['Nasdaq Composite', '^IXIC'], ['Dow Jones Industrial Average', '^DJI'], ['Russell 2000', '^RUT']
      ];
      const quotes = await Promise.all(indices.map(([, ticker]) => liveIndex(ticker)));
      return send(res, 200, indices.map(([name], index) => ({ name, symbol: indices[index][1], ...quotes[index] })));
    }
    if (url.pathname === '/data/filings') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const profile = await fmp('profile', { symbol:ticker }).catch(() => []);
      const secData = await secFactsForTicker(ticker).catch(() => null);
      const cik = profile[0]?.cik || secData?.company?.cik_str;
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
