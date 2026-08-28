import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const configPath = join(root, '..', '..', 'work', 'dollardisha.env');
let configText = '';
try { configText = await readFile(configPath, 'utf8'); } catch { /* Production uses FMP_API_KEY from the host environment. */ }
// Parse the optional local deployment file without truncating values that
// contain an equals sign (tokens and URLs may legally contain one).
const env = Object.fromEntries(configText.split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    const separator = line.indexOf('=');
    return separator < 0 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
// Accept the concise names too. This keeps a deployment working if a host
// dashboard saved the provider key as FMP_API or TWELVE_DATA_KEY.
const key = process.env.FMP_API_KEY || process.env.FMP_API || env.FMP_API_KEY || env.FMP_API;
const twelveDataKey = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || process.env.TWELVE_API_KEY || env.TWELVE_DATA_API_KEY || env.TWELVE_DATA_KEY || env.TWELVE_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || env.SUPABASE_URL || env.SUPABASE_PROJECT_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLIC_KEY;
const supabasePublishableKeyIsSecret = /^sb_secret_/i.test(supabasePublishableKey || '');
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY;
const stripePriceId = process.env.STRIPE_PRICE_ID || env.STRIPE_PRICE_ID;
const stripePlanPrices = {
  monthly: process.env.STRIPE_PRICE_MONTHLY_ID || env.STRIPE_PRICE_MONTHLY_ID || stripePriceId,
  'six-month': process.env.STRIPE_PRICE_SIX_MONTH_ID || env.STRIPE_PRICE_SIX_MONTH_ID,
  annual: process.env.STRIPE_PRICE_ANNUAL_ID || env.STRIPE_PRICE_ANNUAL_ID
};
const publicAppUrl = process.env.PUBLIC_APP_URL || env.PUBLIC_APP_URL || 'https://dollardisha.in';
if (supabasePublishableKeyIsSecret) console.warn('SUPABASE_PUBLISHABLE_KEY contains a secret key. Use the sb_publishable_ key in the browser instead.');
if (!key) console.warn('FMP_API_KEY is not configured. DollarDisha will use its quote fallback where available.');
const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.png':'image/png',
  '.ico':'image/x-icon',
  '.svg':'image/svg+xml',
  '.webp':'image/webp',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg'
  ,'.webmanifest':'application/manifest+json; charset=utf-8'
  ,'.txt':'text/plain; charset=utf-8'
  ,'.xml':'application/xml; charset=utf-8'
};
const startedAt = Date.now();
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; upgrade-insecure-requests",
  'Cross-Origin-Opener-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy':'strict-origin-when-cross-origin',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY'
};
const rateLimits = new Map();
function clientAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function isRateLimited(req, pathname) {
  if (!pathname.startsWith('/data/') && !pathname.startsWith('/api/')) return false;
  const windowMs = 60_000;
  const maximum = pathname === '/data/search' || pathname === '/api/search' ? 90 : 300;
  const now = Date.now();
  const id = `${clientAddress(req)}:${pathname}`;
  const current = rateLimits.get(id);
  const next = !current || current.resetAt <= now ? { count:1, resetAt:now + windowMs } : { ...current, count:current.count + 1 };
  rateLimits.set(id, next);
  if (rateLimits.size > 5000) {
    for (const [entry, value] of rateLimits) if (value.resetAt <= now) rateLimits.delete(entry);
  }
  return next.count > maximum;
}
// Tickers are not US-only: global listings can contain digits, dots, slashes
// and hyphens (for example 000001 or RY.TO). Keep the allow-list tight while
// allowing the symbols returned by the connected exchange directories.
const symbol = value => /^[A-Z0-9][A-Z0-9._/-]{0,14}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : null;
const externalFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
const finiteValue = (...values) => values.find(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) ?? null;
const safeDivide = (numerator, denominator) => {
  if (numerator === null || numerator === undefined || numerator === '' || denominator === null || denominator === undefined || denominator === '') return null;
  const top = Number(numerator);
  const bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom !== 0 ? top / bottom : null;
};
const normalizeQuote = (ticker, value = {}) => {
  const price = finiteValue(value.price, value.close, value.lastSalePrice);
  const previousClose = finiteValue(value.previousClose, value.previous_close);
  const changesPercentage = finiteValue(
    value.changesPercentage,
    value.changePercentage,
    value.percentChange,
    value.percent_change,
    safeDivide(price !== null && previousClose !== null ? price - previousClose : null, previousClose) !== null
      ? safeDivide(price - previousClose, previousClose) * 100
      : null
  );
  return {
    ...value,
    symbol:ticker,
    price,
    previousClose,
    changesPercentage,
    changePercentage:changesPercentage,
    dayHigh:finiteValue(value.dayHigh, value.high),
    dayLow:finiteValue(value.dayLow, value.low),
    volume:finiteValue(value.volume),
    marketCap:finiteValue(value.marketCap, value.mktCap)
  };
};
const liveData = (quote, extra = {}) => ({
  ...extra,
  quote: quote || {},
  live: quote?.price !== null && quote?.price !== undefined && Number.isFinite(Number(quote.price)),
  provider: quote?.provider || null,
  providers: quote?.providers || []
});

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

const screenerRatioCache = new Map();
const companyLogoCache = new Map();
const saveCompanyLogo = (ticker, value) => {
  companyLogoCache.delete(ticker);
  companyLogoCache.set(ticker, value);
  if (companyLogoCache.size > 500) companyLogoCache.delete(companyLogoCache.keys().next().value);
};

async function currentCompanyLogo(ticker) {
  const cached = companyLogoCache.get(ticker);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const profiles = await fmp('profile', { symbol:ticker }).catch(() => []);
  const profile = Array.isArray(profiles) ? (profiles[0] || {}) : (profiles || {});
  const candidates = [...new Set([
    profile.image,
    profile.logo,
    `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(ticker)}.png`
  ].filter(value => /^https:\/\//i.test(String(value || ''))))];

  for (const logoUrl of candidates) {
    try {
      const logoHost = new URL(logoUrl).hostname.toLowerCase();
      if (!['images.financialmodelingprep.com', 'financialmodelingprep.com'].includes(logoHost)) continue;
      const response = await externalFetch(logoUrl, { headers:{ Accept:'image/avif,image/webp,image/png,image/*,*/*' } });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.toLowerCase().startsWith('image/')) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) continue;
      const value = { buffer, contentType, expiresAt:Date.now() + 6 * 60 * 60 * 1000 };
      saveCompanyLogo(ticker, value);
      return value;
    } catch { /* Try the next current provider image. */ }
  }
  const unavailable = { unavailable:true, expiresAt:Date.now() + 60 * 60 * 1000 };
  saveCompanyLogo(ticker, unavailable);
  return unavailable;
}

async function screenerRatio(ticker) {
  const cached = screenerRatioCache.get(ticker);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const [ratioRows, metricRows] = await Promise.all([
    fmp('ratios-ttm', { symbol:ticker }).catch(() => []),
    fmp('key-metrics-ttm', { symbol:ticker }).catch(() => [])
  ]);
  const item = Array.isArray(ratioRows) ? (ratioRows[0] || {}) : {};
  const metrics = Array.isArray(metricRows) ? (metricRows[0] || {}) : {};
  const value = {
    symbol:ticker,
    pe:finiteValue(item.peRatioTTM, item.priceToEarningsRatioTTM, item.priceEarningsRatioTTM, metrics.peRatioTTM, metrics.peRatio),
    returnOnEquityTTM:finiteValue(item.returnOnEquityTTM, item.roeTTM, metrics.returnOnEquityTTM, metrics.roeTTM),
    dividendYieldTTM:finiteValue(item.dividendYieldTTM, metrics.dividendYieldTTM),
    currentRatioTTM:finiteValue(item.currentRatioTTM, metrics.currentRatioTTM),
    debtToEquityRatioTTM:finiteValue(item.debtToEquityRatioTTM, item.debtToEquityTTM, metrics.debtToEquityTTM),
    epsTTM:finiteValue(item.netIncomePerShareTTM, item.epsTTM, metrics.netIncomePerShareTTM, metrics.epsTTM),
    revenueGrowthTTM:finiteValue(item.revenueGrowthTTM, metrics.revenueGrowthTTM),
    netIncomeGrowthTTM:finiteValue(item.netIncomeGrowthTTM, metrics.netIncomeGrowthTTM),
    metricsLoaded:true
  };
  screenerRatioCache.set(ticker, { value, expiresAt:Date.now() + 6 * 60 * 60 * 1000 });
  return value;
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
async function twelveDataQuote(ticker, exchange = '') {
  if (!twelveDataKey) throw new Error('TWELVE_DATA_API_KEY is not configured');
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', ticker);
  if (exchange) url.searchParams.set('exchange', exchange);
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
async function fmpQuote(ticker) {
  if (!key) throw new Error('FMP_API_KEY is not configured');
  const rows = await fmp('quote', { symbol:ticker });
  if (!Array.isArray(rows) || !rows[0]?.price) throw new Error('FMP returned no quote');
  return normalizeQuote(ticker, { ...rows[0], provider:'fmp' });
}
function mergeProviderQuotes(symbol, twelveQuote, fmpQuoteValue) {
  const providers = [twelveQuote ? 'twelve-data' : '', fmpQuoteValue ? 'fmp' : ''].filter(Boolean);
  return normalizeQuote(symbol, {
    ...(fmpQuoteValue || {}),
    ...(twelveQuote || {}),
    price:finiteValue(twelveQuote?.price, fmpQuoteValue?.price),
    previousClose:finiteValue(twelveQuote?.previousClose, fmpQuoteValue?.previousClose),
    changesPercentage:finiteValue(twelveQuote?.changesPercentage, fmpQuoteValue?.changesPercentage),
    dayHigh:finiteValue(twelveQuote?.dayHigh, fmpQuoteValue?.dayHigh),
    dayLow:finiteValue(twelveQuote?.dayLow, fmpQuoteValue?.dayLow),
    volume:finiteValue(twelveQuote?.volume, fmpQuoteValue?.volume),
    marketCap:finiteValue(fmpQuoteValue?.marketCap, twelveQuote?.marketCap),
    pe:finiteValue(fmpQuoteValue?.pe, twelveQuote?.pe),
    name:twelveQuote?.name || fmpQuoteValue?.name || fmpQuoteValue?.companyName,
    provider:providers.join('+') || null,
    providers
  });
}
async function combinedQuote({ symbol: outputSymbol, fmpSymbol = outputSymbol, twelveSymbol = outputSymbol, exchange = '', quiet = false }) {
  const [twelveResult, fmpResult] = await Promise.allSettled([
    twelveDataKey ? twelveDataQuote(twelveSymbol, exchange) : Promise.reject(new Error('TWELVE_DATA_API_KEY is not configured')),
    key ? fmpQuote(fmpSymbol) : Promise.reject(new Error('FMP_API_KEY is not configured'))
  ]);
  const twelveQuote = twelveResult.status === 'fulfilled' ? twelveResult.value : null;
  const fmpQuoteValue = fmpResult.status === 'fulfilled' ? fmpResult.value : null;
  if (!quiet && twelveResult.status === 'rejected') console.warn(`Twelve Data quote unavailable for ${outputSymbol}: ${twelveResult.reason?.message || twelveResult.reason}`);
  if (!quiet && fmpResult.status === 'rejected') console.warn(`FMP quote unavailable for ${outputSymbol}: ${fmpResult.reason?.message || fmpResult.reason}`);
  if (twelveQuote || fmpQuoteValue) return mergeProviderQuotes(outputSymbol, twelveQuote, fmpQuoteValue);
  throw new Error(`No configured live quote provider returned data for ${outputSymbol}`);
}
async function priceHistory(ticker, points = 260) {
  // Fetch enough prior sessions to seed the 200-day moving average even when
  // the user is viewing a short range such as 1M or 6M. We still return only
  // the requested visible range after calculating the indicators.
  const historySize = Math.max(points + 200, 260);
  const [fmpResult, twelveResult] = await Promise.allSettled([
    key ? fmp('historical-price-eod/full', { symbol:ticker }) : Promise.reject(new Error('FMP_API_KEY is not configured')),
    twelveDataKey ? (async () => {
      const url = new URL('https://api.twelvedata.com/time_series');
      url.searchParams.set('symbol', ticker);
      url.searchParams.set('interval', '1day');
      url.searchParams.set('outputsize', String(historySize));
      url.searchParams.set('apikey', twelveDataKey);
      const response = await externalFetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
      const data = await response.json();
      if (!response.ok || data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || `Twelve Data returned ${response.status}`);
      return data.values;
    })() : Promise.reject(new Error('TWELVE_DATA_API_KEY is not configured'))
  ]);
  const fmpRows = fmpResult.status === 'fulfilled' ? (Array.isArray(fmpResult.value) ? fmpResult.value : (fmpResult.value.historical || [])) : [];
  const twelveRows = twelveResult.status === 'fulfilled' ? twelveResult.value : [];
  const byDate = new Map();
  fmpRows.forEach(item => byDate.set(String(item.date || item.datetime).slice(0, 10), { date:item.date, close:Number(item.close), volume:Number(item.volume || 0), provider:'fmp' }));
  twelveRows.forEach(item => { const date = String(item.datetime || item.date).slice(0, 10); const current = byDate.get(date); byDate.set(date, { ...(current || {}), date, close:Number(item.close ?? current?.close), volume:Number(item.volume ?? current?.volume ?? 0), provider:current ? 'fmp+twelve-data' : 'twelve-data' }); });
  const decorate = rows => {
    const sorted = rows.filter(item => Number.isFinite(item.close)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const visible = sorted.slice(-points);
    const start = sorted.length - visible.length;
    const averageAt = (index, window) => index < window - 1 ? null : sorted.slice(index - window + 1, index + 1).reduce((sum, item) => sum + item.close, 0) / window;
    return visible.map((item, offset) => ({ ...item, ma50:averageAt(start + offset, 50), ma200:averageAt(start + offset, 200) }));
  };
  const combined = [...byDate.values()].filter(item => Number.isFinite(item.close)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (combined.length) return decorate(combined);
  const range = historySize <= 260 ? '1y' : historySize <= 780 ? '3y' : historySize <= 1300 ? '5y' : '10y';
  const response = await externalFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
  if (!response.ok) throw new Error('Historical price data is unavailable');
  const data = (await response.json()).chart?.result?.[0];
  const quote = data?.indicators?.quote?.[0];
  if (!data?.timestamp || !quote?.close) throw new Error('Historical price data is unavailable');
  return decorate(data.timestamp.map((timestamp, index) => ({ date:new Date(timestamp * 1000).toISOString().slice(0, 10), close:Number(quote.close[index]), volume:Number(quote.volume[index] || 0) })).filter(item => Number.isFinite(item.close)));
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

// Nasdaq's official screener is our provider-independent US equity directory.
// Keep one short-lived server cache so every search box and quote fallback uses
// the same current NASDAQ listing without exposing either paid-provider key.
let nasdaqDirectoryCache = { rows: null, expiresAt: 0 };
async function nasdaqDirectory() {
  if (nasdaqDirectoryCache.rows && Date.now() < nasdaqDirectoryCache.expiresAt) return nasdaqDirectoryCache.rows;
  const url = new URL('https://api.nasdaq.com/api/screener/stocks');
  url.searchParams.set('tableonly', 'true');
  url.searchParams.set('download', 'true');
  url.searchParams.set('exchange', 'nasdaq');
  url.searchParams.set('limit', '10000');
  url.searchParams.set('offset', '0');
  const response = await externalFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 DollarDisha research app',
      Accept: 'application/json, text/plain, */*'
    }
  });
  if (!response.ok) throw new Error(`Nasdaq directory returned ${response.status}`);
  const rows = (await response.json()).data?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Nasdaq directory returned no listings');
  nasdaqDirectoryCache = { rows, expiresAt: Date.now() + 60 * 1000 };
  return rows;
}
function nasdaqDirectoryItem(row) {
  const ticker = symbol(row?.symbol);
  const cleanName = String(row?.name || ticker)
    .replace(/\s+(Common Stock|Common Shares?|Class [A-Z] Common Stock)\s*$/i, '')
    .trim();
  return normalizeQuote(ticker, {
    symbol: ticker,
    name: cleanName || ticker,
    companyName: cleanName || ticker,
    price: Number(String(row?.lastsale || '').replace(/[$,]/g, '')),
    changesPercentage: Number(String(row?.pctchange || '').replace(/[%+,]/g, '')),
    volume: Number(String(row?.volume || '').replace(/,/g, '')),
    marketCap: Number(String(row?.marketCap || '').replace(/,/g, '')),
    sector: row?.sector || null,
    industry: row?.industry || null,
    provider: 'nasdaq-directory',
    providers: ['nasdaq-directory']
  });
}
async function nasdaqDirectoryQuote(ticker) {
  const row = (await nasdaqDirectory()).find(item => symbol(item.symbol) === ticker);
  if (!row) throw new Error('Nasdaq directory returned no quote');
  const quote = nasdaqDirectoryItem(row);
  if (!Number.isFinite(Number(quote.price))) throw new Error('Nasdaq directory returned no price');
  return quote;
}
async function nasdaqDirectorySearch(query, limit = 8) {
  const needle = String(query || '').trim().toUpperCase();
  if (!needle) return [];
  const rows = (await nasdaqDirectory()).filter(row => {
    const ticker = symbol(row.symbol);
    const name = String(row.name || '').toUpperCase();
    const securityDescription = `${ticker} ${name}`;
    return securityDescription.includes(needle)
      && !/(WARRANT|RIGHTS?|PREFERRED|DEPOSITARY SHARES|UNITS?)\b/i.test(name);
  }).sort((left, right) => {
    const leftTicker = symbol(left.symbol);
    const rightTicker = symbol(right.symbol);
    return Number(rightTicker === needle) - Number(leftTicker === needle)
      || Number(String(right.name || '').toUpperCase().startsWith(needle)) - Number(String(left.name || '').toUpperCase().startsWith(needle))
      || leftTicker.localeCompare(rightTicker);
  });
  const seen = new Set();
  return rows.reduce((items, row) => {
    const item = nasdaqDirectoryItem(row);
    const companyKey = nasdaqCompanyKey(item.name) || item.symbol;
    if (items.length >= limit || seen.has(companyKey)) return items;
    seen.add(companyKey);
    items.push({
      symbol: item.symbol,
      name: item.name,
      companyName: item.name,
      exchange: 'NASDAQ',
      exchangeShortName: 'NASDAQ',
      price: item.price,
      changesPercentage: item.changesPercentage,
      marketCap: item.marketCap,
      sector: row.sector || null,
      industry: row.industry || null,
      provider: 'nasdaq-directory'
    });
    return items;
  }, []);
}
function nasdaqCompanyKey(name = '') {
  return String(name).toUpperCase()
    .replace(/\b(CLASS|COMMON STOCK|ORDINARY SHARES?)\s*[A-Z]?\b/g, ' ')
    .replace(/\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|PLC|LTD|LIMITED)\b/g, ' ')
    .replace(/[^A-Z0-9]/g, '');
}
function isNasdaqExchange(value = '') {
  const exchange = String(value).trim().toUpperCase();
  return exchange === 'XNAS' || exchange.includes('NASDAQ');
}
function uniqueNasdaqSearchResults(rows, query, limit = 8) {
  const exactSymbol = symbol(query);
  const candidates = (Array.isArray(rows) ? rows : []).map((row, index) => {
    const ticker = symbol(row.symbol || row.ticker);
    const name = row.name || row.companyName || row.instrument_name || ticker;
    const exchange = row.exchangeShortName || row.exchange || row.mic_code || '';
    return { ...row, symbol:ticker, name, exchangeShortName:'NASDAQ', _exchange:exchange, _index:index };
  }).filter(row => {
    const type = String(row.type || row.instrument_type || '').toUpperCase();
    return row.symbol && isNasdaqExchange(row._exchange) && !/(ETF|FUND|INDEX|WARRANT|RIGHT|PREFERRED)/.test(type);
  }).sort((left, right) => {
    const leftExact = left.symbol === exactSymbol ? 1 : 0;
    const rightExact = right.symbol === exactSymbol ? 1 : 0;
    return rightExact - leftExact || left._index - right._index;
  });
  const seenSymbols = new Set();
  const seenCompanies = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const companyKey = nasdaqCompanyKey(candidate.name) || candidate.symbol;
    if (seenSymbols.has(candidate.symbol) || seenCompanies.has(companyKey)) continue;
    seenSymbols.add(candidate.symbol);
    seenCompanies.add(companyKey);
    const { _exchange, _index, ...result } = candidate;
    unique.push(result);
    if (unique.length >= limit) break;
  }
  return unique;
}
async function twelveStockSearch(query) {
  if (!twelveDataKey) return [];
  const url = new URL('https://api.twelvedata.com/symbol_search');
  url.searchParams.set('symbol', query);
  url.searchParams.set('outputsize', '20');
  url.searchParams.set('apikey', twelveDataKey);
  const response = await externalFetch(url, { headers: { 'User-Agent': 'DollarDisha research app contact@dollardisha.in' } });
  const data = await response.json();
  const rows = data.data || data;
  if (!response.ok || data.status === 'error' || !Array.isArray(rows)) throw new Error(data.message || 'Twelve Data global symbol search is unavailable');
  return uniqueNasdaqSearchResults(rows.map(row => ({
    symbol: row.symbol, name: row.instrument_name || row.name || row.symbol, exchangeShortName: row.exchange || row.mic_code || 'US', type: row.type
  })), query, 8);
}
const liveQuoteCache = new Map();
async function liveQuote(ticker, exchange = '', twelveSymbol = ticker, fmpSymbol = ticker) {
  const cacheKey = `${ticker}|${exchange}|${twelveSymbol}|${fmpSymbol}`;
  const cached = liveQuoteCache.get(cacheKey);
  if (cached?.value && Date.now() < cached.expiresAt) return cached.value;
  if (cached?.refreshing) return cached.value || cached.refreshing;
  const refreshing = (async () => {
    try { return await combinedQuote({ symbol:ticker, twelveSymbol, exchange, fmpSymbol }); }
    catch (error) {
      console.warn(`Combined quote unavailable for ${ticker}: ${error.message}`);
      try { return normalizeQuote(ticker, { ...await nasdaqQuote(ticker), provider:'nasdaq', providers:['nasdaq'] }); }
      catch (nasdaqError) {
        console.warn(`Nasdaq quote unavailable for ${ticker}: ${nasdaqError.message}`);
        try { return await nasdaqDirectoryQuote(ticker); }
        catch (directoryError) {
          console.warn(`Nasdaq directory quote unavailable for ${ticker}: ${directoryError.message}`);
          return normalizeQuote(ticker, { ...await yahooQuote(ticker), provider:'yahoo', providers:['yahoo'] });
        }
      }
    }
  })();
  liveQuoteCache.set(cacheKey, { value:cached?.value || null, refreshing });
  try {
    const value = await refreshing;
    liveQuoteCache.set(cacheKey, { value, expiresAt:Date.now() + 15 * 1000 });
    return value;
  } catch (error) {
    liveQuoteCache.delete(cacheKey);
    throw error;
  }
}
async function liveIndex(symbol) {
  const index = globalMarketDefinitions.indices.find(item => item.symbol === symbol);
  return liveQuote(symbol, index?.exchange || '', index?.twelve || symbol, index?.fmp || symbol);
}

// Cross-asset market pulse. Yahoo symbols are used as a resilient fallback
// for exchanges, futures and crypto pairs that are not covered consistently by
// every FMP/Twelve Data plan.
const globalMarketDefinitions = {
  indices: [
    { name:'S&P 500', symbol:'^GSPC', region:'US', exchange:'INDEX', twelve:'SPX' },
    { name:'Nasdaq Composite', symbol:'^IXIC', region:'US', exchange:'NASDAQ', twelve:'IXIC' },
    { name:'Dow Jones', symbol:'^DJI', region:'US', exchange:'INDEX', twelve:'DJI' },
    { name:'Russell 2000', symbol:'^RUT', region:'US', exchange:'INDEX', twelve:'RUT' },
    { name:'FTSE 100', symbol:'^FTSE', region:'Europe', exchange:'LSE', twelve:'UKX' },
    { name:'DAX', symbol:'^GDAXI', region:'Europe', exchange:'XETR', twelve:'DAX' },
    { name:'CAC 40', symbol:'^FCHI', region:'Europe', exchange:'EURONEXT', twelve:'CAC' },
    { name:'Nikkei 225', symbol:'^N225', region:'Asia', exchange:'TSE', twelve:'NI225' },
    { name:'Hang Seng', symbol:'^HSI', region:'Asia', exchange:'HKEX', twelve:'HSI' },
    { name:'Shanghai Composite', symbol:'000001.SS', region:'Asia', exchange:'SSE', twelve:'000001' },
    { name:'Nifty 50', symbol:'^NSEI', region:'India', exchange:'NSE', twelve:'NIFTY' },
    { name:'BSE Sensex', symbol:'^BSESN', region:'India', exchange:'BSE', twelve:'SENSEX' },
    { name:'S&P/TSX Composite', symbol:'^GSPTSE', region:'Americas', exchange:'TSX' },
    { name:'ASX 200', symbol:'^AXJO', region:'Asia-Pacific', exchange:'ASX' },
    { name:'Bovespa', symbol:'^BVSP', region:'Americas', exchange:'B3' },
    { name:'KOSPI', symbol:'^KS11', region:'Asia-Pacific', exchange:'KRX' },
    { name:'Straits Times', symbol:'^STI', region:'Asia-Pacific', exchange:'SGX' },
    { name:'TAIEX', symbol:'^TWII', region:'Asia-Pacific', exchange:'TWSE' },
    { name:'SIX Swiss Market', symbol:'^SSMI', region:'Europe', exchange:'SIX' },
    { name:'IBEX 35', symbol:'^IBEX', region:'Europe', exchange:'BME' },
    { name:'OMX Stockholm 30', symbol:'^OMX', region:'Europe', exchange:'XSTO' },
    { name:'JSE All Share', symbol:'^J203.JO', region:'Africa', exchange:'JSE' }
  ],
  commodities: [
    { name:'Gold', symbol:'GC=F', fmp:'GCUSD', twelve:'XAU/USD' },
    { name:'Silver', symbol:'SI=F', fmp:'SIUSD', twelve:'XAG/USD' },
    { name:'Crude oil', symbol:'CL=F', fmp:'CLUSD', twelve:'WTI/USD' },
    { name:'Brent crude', symbol:'BZ=F', fmp:'BZUSD', twelve:'BRENT/USD' },
    { name:'Natural gas', symbol:'NG=F', fmp:'NGUSD', twelve:'NATURALGAS/USD' },
    { name:'Copper', symbol:'HG=F', fmp:'HGUSD', twelve:'COPPER/USD' }
  ],
  crypto: [
    { name:'Bitcoin', symbol:'BTC-USD', fmp:'BTCUSD', twelve:'BTC/USD' },
    { name:'Ethereum', symbol:'ETH-USD', fmp:'ETHUSD', twelve:'ETH/USD' },
    { name:'Solana', symbol:'SOL-USD', fmp:'SOLUSD', twelve:'SOL/USD' },
    { name:'XRP', symbol:'XRP-USD', fmp:'XRPUSD', twelve:'XRP/USD' },
    { name:'BNB', symbol:'BNB-USD', fmp:'BNBUSD', twelve:'BNB/USD' },
    { name:'Dogecoin', symbol:'DOGE-USD', fmp:'DOGEUSD', twelve:'DOGE/USD' }
  ]
};
const globalMarketCache = { value:null, expiresAt:0, refreshing:null };
async function globalAssetQuote(asset) {
  try {
    return await combinedQuote({
      symbol:asset.symbol,
      twelveSymbol:asset.twelve || asset.symbol,
      fmpSymbol:asset.fmp || asset.symbol,
      exchange:asset.exchange || '',
      // Index providers do not share a symbol format (for example, Yahoo's
      // ^FTSE is not a valid Twelve Data symbol). Yahoo is the intentional
      // fallback for these cross-asset rows, so keep expected provider misses
      // out of the production error log.
      quiet:true
    });
  } catch { /* Use the public fallback only when both configured providers fail. */ }
  try { return normalizeQuote(asset.symbol, { ...await yahooQuote(asset.symbol), provider:'yahoo' }); }
  catch { return normalizeQuote(asset.symbol); }
}
async function globalMarketPulse() {
  const now = Date.now();
  if (globalMarketCache.value && now < globalMarketCache.expiresAt) return globalMarketCache.value;
  if (!globalMarketCache.refreshing) {
    globalMarketCache.refreshing = (async () => {
      const load = group => Promise.all(group.map(async asset => {
        const quote = await globalAssetQuote(asset);
        return {
          ...quote,
          // Provider payloads sometimes omit or replace a display name. Our
          // curated labels identify the benchmark/commodity consistently.
          name: asset.name, symbol: asset.symbol, region: asset.region || null,
          exchange: asset.exchange || quote.exchange || null,
          dataStatus: quote.price !== null && quote.price !== undefined && quote.price !== '' && Number.isFinite(Number(quote.price)) ? 'live-or-latest' : 'unavailable'
        };
      }));
      const [indices, commodities, crypto] = await Promise.all([
        load(globalMarketDefinitions.indices),
        load(globalMarketDefinitions.commodities),
        load(globalMarketDefinitions.crypto)
      ]);
      const regions = [...new Set(globalMarketDefinitions.indices.map(item => item.region))].map(region => {
        const rows = indices.filter(item => item.region === region);
        const liveRows = rows.filter(item => item.dataStatus !== 'unavailable');
        const changes = liveRows.map(item => Number(item.changesPercentage)).filter(Number.isFinite);
        return { region, change:changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null, breadth:liveRows.filter(item => Number.isFinite(Number(item.changesPercentage)) && Number(item.changesPercentage) >= 0).length, total:liveRows.length };
      });
      const result = { updatedAt:new Date().toISOString(), indices, commodities, crypto, regions };
      globalMarketCache.value = result;
      // Expire slightly before the browser's 60-second refresh so a refresh
      // cannot land just before expiry and receive the previous snapshot.
      globalMarketCache.expiresAt = Date.now() + 55 * 1000;
      return result;
    })().finally(() => { globalMarketCache.refreshing = null; });
  }
  if (globalMarketCache.value) return { ...globalMarketCache.value, stale:true };
  return globalMarketCache.refreshing;
}

// Regional benchmark performance for the dashboard.  The short period uses
// the same live snapshot as the market pulse; longer periods use one liquid
// benchmark per region and calculate the return from daily closes.  Keeping
// this server-side means every visitor sees the same provider-backed snapshot
// and we do not make a burst of requests from every browser tab.
const marketPerformanceCache = new Map();
const marketPerformanceWindows = { week:5, month:22, ytd:200, '3m':66, '6m':132, year:252, '3y':756, '5y':1260, '10y':2520 };
const marketPerformanceAssets = globalMarketDefinitions.indices.filter((asset, index, all) => (
  all.findIndex(candidate => candidate.region === asset.region) === index
));
function countryForMarket(asset) {
  const symbol = String(asset?.symbol || '');
  const name = String(asset?.name || '');
  if (asset?.region === 'US') return 'United States';
  if (symbol === '^FTSE' || name === 'FTSE 100') return 'United Kingdom';
  if (symbol === '^GDAXI') return 'Germany';
  if (symbol === '^FCHI') return 'France';
  if (symbol === '^SSMI') return 'Switzerland';
  if (symbol === '^IBEX') return 'Spain';
  if (symbol === '^OMX') return 'Sweden';
  if (symbol === '^N225') return 'Japan';
  if (symbol === '^HSI') return 'Hong Kong';
  if (symbol === '000001.SS') return 'China';
  if (asset?.region === 'India') return 'India';
  if (symbol === '^GSPTSE') return 'Canada';
  if (symbol === '^BVSP') return 'Brazil';
  if (symbol === '^AXJO') return 'Australia';
  if (symbol === '^KS11') return 'South Korea';
  if (symbol === '^STI') return 'Singapore';
  if (symbol === '^TWII') return 'Taiwan';
  if (symbol === '^J203.JO') return 'South Africa';
  return asset?.region || 'Global';
}
const benchmarkDetails = (asset, row = {}) => ({ name:asset.name, symbol:asset.symbol, exchange:asset.exchange || null, country:countryForMarket(asset), change:Number.isFinite(Number(row.change)) ? Number(row.change) : null, cagr:Number.isFinite(Number(row.cagr)) ? Number(row.cagr) : null });
async function marketPerformance(period = 'day') {
  const selected = ['day', 'week', 'month', 'ytd', '3m', '6m', 'year', '3y', '5y', '10y'].includes(period) ? period : 'day';
  const cached = marketPerformanceCache.get(selected);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  if (selected === 'day') {
    const pulse = await globalMarketPulse();
    const regions = (pulse.regions || []).map(region => ({
      ...region,
      benchmarks: (pulse.indices || []).filter(item => item.region === region.region).map(item => benchmarkDetails(item, item))
    }));
    const value = { updatedAt:pulse.updatedAt, period:selected, regions };
    marketPerformanceCache.set(selected, { value, expiresAt:Date.now() + 55 * 1000 });
    return value;
  }
  const window = marketPerformanceWindows[selected];
  const rows = await Promise.all(marketPerformanceAssets.map(async asset => {
    try {
      const history = await priceHistory(asset.symbol, window + 1);
      const ytdStart = selected === 'ytd' ? `${new Date().getFullYear()}-01-01` : null;
      const points = history.filter(item => Number.isFinite(Number(item.close)) && (!ytdStart || String(item.date) >= ytdStart));
      if (points.length < 2) return { region:asset.region, change:null, breadth:null, total:1, benchmark:benchmarkDetails(asset) };
      const startPoint = points[Math.max(0, points.length - (window + 1))];
      const endPoint = points.at(-1);
      const start = Number(startPoint.close);
      const end = Number(endPoint.close);
      const change = start > 0 ? ((end - start) / start) * 100 : null;
      const elapsedDays = Math.max(1, (new Date(endPoint.date) - new Date(startPoint.date)) / 86400000);
      const elapsedYears = elapsedDays / 365.2425;
      const cagr = start > 0 && end > 0 && elapsedYears > 0.01 ? (Math.pow(end / start, 1 / elapsedYears) - 1) * 100 : null;
      return { region:asset.region, change:Number.isFinite(change) ? change : null, cagr:Number.isFinite(cagr) ? cagr : null, breadth:Number.isFinite(change) && change >= 0 ? 1 : 0, total:1, benchmark:benchmarkDetails(asset, { change, cagr }) };
    } catch {
      return { region:asset.region, change:null, breadth:null, total:1, benchmark:benchmarkDetails(asset) };
    }
  }));
  const regions = [...new Set(marketPerformanceAssets.map(asset => asset.region))].map(region => {
    const regionRows = rows.filter(row => row.region === region);
    const changes = regionRows.map(row => row.change).filter(Number.isFinite);
    return {
      region,
      change:changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null,
      cagr:(regionRows.map(row => row.cagr).filter(Number.isFinite).length ? regionRows.map(row => row.cagr).filter(Number.isFinite).reduce((sum, value) => sum + value, 0) / regionRows.map(row => row.cagr).filter(Number.isFinite).length : null),
      breadth:regionRows.reduce((sum, row) => sum + (row.breadth || 0), 0),
      total:regionRows.length,
      benchmarks:regionRows.map(row => row.benchmark).filter(Boolean)
    };
  }).sort((a, b) => (Number(b.change) || -Infinity) - (Number(a.change) || -Infinity));
  const value = { updatedAt:new Date().toISOString(), period:selected, regions };
  marketPerformanceCache.set(selected, { value, expiresAt:Date.now() + 55 * 1000 });
  return value;
}

// Keep the shared server snapshot warm even when no browser tab is open.
// Visitors then receive a recently refreshed snapshot immediately instead of
// making the first visitor wait for every provider request to complete.
const backgroundFeaturedTickers = ['NVDA', 'MSFT', 'AAPL', 'GOOGL'];
let backgroundRefreshInFlight = false;
async function refreshLiveSnapshots() {
  if (backgroundRefreshInFlight) return;
  backgroundRefreshInFlight = true;
  try {
    await Promise.allSettled([
      Promise.all(backgroundFeaturedTickers.map(ticker => liveQuote(ticker))),
      globalMarketPulse()
    ]);
  } finally {
    backgroundRefreshInFlight = false;
  }
}

// This is deliberately server-side: it runs independently of browser
// visibility, focus, and reloads while the hosting process is running.
refreshLiveSnapshots().catch(error => console.warn(`Initial live snapshot refresh failed: ${error.message}`));
setInterval(() => {
  refreshLiveSnapshots().catch(error => console.warn(`Background live snapshot refresh failed: ${error.message}`));
}, 60 * 1000);

const marketScanCache = new Map();
async function marketScan(mode) {
  const cached = marketScanCache.get(mode);
  if (cached && Date.now() < cached.expiresAt) return cached.rows;
  let source = [];
  if (mode === 'largest') {
    const parameters = { limit:100, isEtf:false, isFund:false, isActivelyTrading:true };
    const exchanges = ['NASDAQ', 'NYSE', 'AMEX'];
    source = (await Promise.all(exchanges.map(exchange => fmp('company-screener', { ...parameters, exchange }).catch(() => []))))
      .flat()
      .sort((a, b) => Number(b.marketCap || 0) - Number(a.marketCap || 0));
  } else {
    const endpoint = mode === 'losers' ? 'biggest-losers' : mode === 'active' ? 'most-actives' : 'biggest-gainers';
    source = await fmp(endpoint, { limit:30 }).catch(() => []);
  }
  const seen = new Set();
  const seeds = source.filter(item => {
    const ticker = symbol(item.symbol);
    if (!ticker || seen.has(ticker)) return false;
    seen.add(ticker);
    return true;
  }).slice(0, 20);
  const rows = await Promise.all(seeds.map(async seed => {
    const ticker = symbol(seed.symbol);
    const seedQuote = normalizeQuote(ticker, seed);
    const needsQuote = finiteValue(seedQuote.price) === null || finiteValue(seedQuote.changesPercentage) === null;
    const needsProfile = !seed.companyName && !seed.name || finiteValue(seed.marketCap, seed.mktCap) === null || !seed.sector;
    const [quote, ratioRows, profileRows] = await Promise.all([
      liveQuote(ticker).catch(() => seedQuote),
      fmp('ratios-ttm', { symbol:ticker }).catch(() => []),
      needsProfile ? fmp('profile', { symbol:ticker }).catch(() => []) : Promise.resolve([])
    ]);
    const ratios = ratioRows[0] || {};
    const profile = profileRows[0] || seed;
    const eps = finiteValue(ratios.netIncomePerShareTTM, quote.eps, seed.eps);
    const pe = finiteValue(
      seed.pe,
      ratios.peRatioTTM,
      ratios.priceToEarningsRatioTTM,
      ratios.priceEarningsRatioTTM,
      quote.pe,
      quote.priceEarningsRatio,
      safeDivide(quote.price, eps)
    );
    return {
      symbol:ticker,
      companyName:profile.companyName || profile.name || seed.companyName || seed.name || ticker,
      price:finiteValue(quote.price, seed.price),
      marketCap:finiteValue(quote.marketCap, profile.mktCap, profile.marketCap, seed.marketCap),
      pe,
      change:finiteValue(quote.changesPercentage, seed.changesPercentage, seed.changePercentage, seed.change),
      changesPercentage:finiteValue(quote.changesPercentage, seed.changesPercentage, seed.changePercentage, seed.change),
      volume:finiteValue(quote.volume, seed.volume),
      provider:quote.provider || null,
      providers:quote.providers || [],
      sector:profile.sector || seed.sector || null,
      industry:profile.industry || seed.industry || null
    };
  }));
  // Match the browser's one-minute live refresh cadence so scans do not
  // continue serving an older snapshot after the next refresh.
  marketScanCache.set(mode, { rows, expiresAt:Date.now() + 55 * 1000 });
  return rows;
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
function send(res, status, data, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type':type, 'Cache-Control':'no-store', ...extraHeaders });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // Keep one canonical public URL. Render forwards the original scheme in
    // this header, so old HTTP links are permanently upgraded to HTTPS for
    // visitors and search crawlers.
    if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'http') {
      res.writeHead(301, { ...securityHeaders, Location:`https://${req.headers.host}${req.url}`, 'Cache-Control':'public, max-age=3600' });
      return res.end();
    }
    if (url.pathname === '/healthz') {
      return send(res, 200, {
        status:'ok',
        uptimeSeconds:Math.floor((Date.now() - startedAt) / 1000),
        providers:{ fmp:Boolean(key), twelveData:Boolean(twelveDataKey) },
        databaseConfigured:Boolean(supabaseUrl && supabaseKey),
        checkedAt:new Date().toISOString()
      });
    }
    if (isRateLimited(req, url.pathname)) {
      return send(res, 429, { error:'Too many requests. Please retry shortly.' }, 'application/json; charset=utf-8', { 'Retry-After':'60' });
    }
    if (url.pathname === '/data/auth-config') {
      return send(res, 200, {
        enabled:Boolean(supabaseUrl && supabasePublishableKey && !supabasePublishableKeyIsSecret),
        url:supabaseUrl || null,
        publishableKey:supabasePublishableKeyIsSecret ? null : (supabasePublishableKey || null),
        reason:supabasePublishableKeyIsSecret
          ? 'The deployment has a Supabase secret key in the browser-key setting. Replace it with the project publishable key (sb_publishable_…).'
          : null
      });
    }
    if (url.pathname === '/data/provider-status') {
      const fmpConfigured = Boolean(key);
      const twelveDataConfigured = Boolean(twelveDataKey);
      return send(res, 200, {
        fmpConfigured,
        twelveDataConfigured,
        dualFeedConfigured: fmpConfigured && twelveDataConfigured,
        mode: fmpConfigured && twelveDataConfigured
          ? 'dual-provider'
          : fmpConfigured
            ? 'fmp-only'
            : twelveDataConfigured
              ? 'twelve-data-only'
              : 'fallback-only',
        checkedAt: new Date().toISOString()
      });
    }
    if (url.pathname === '/data/fx-rate') {
      let fxQuote = null;
      try {
        fxQuote = await combinedQuote({ symbol:'USDINR', twelveSymbol:'USD/INR', fmpSymbol:'USDINR', exchange:'FOREX', quiet:true });
      } catch {}
      if (!finiteValue(fxQuote?.price)) {
        try { fxQuote = normalizeQuote('USDINR', { ...(await yahooQuote('INR=X')), provider:'yahoo', providers:['yahoo'] }); } catch {}
      }
      const rate = finiteValue(fxQuote?.price);
      if (!rate) return send(res, 503, { error:'USD/INR is temporarily unavailable.', updatedAt:new Date().toISOString() });
      return send(res, 200, {
        pair:'USD/INR',
        rate,
        change:finiteValue(fxQuote?.changesPercentage, fxQuote?.changePercentage),
        provider:fxQuote?.provider || 'live market feed',
        updatedAt:new Date().toISOString()
      });
    }
    if (url.pathname === '/data/system-status') {
      const pulse = await globalMarketPulse().catch(() => null);
      const globalAvailable = Boolean(pulse?.indices?.some(row => finiteValue(row?.price)));
      const coreProviders = Boolean(key) && Boolean(twelveDataKey);
      return send(res, 200, {
        status:coreProviders && globalAvailable ? 'ok' : 'degraded',
        website:true,
        uptimeHours:(Date.now() - startedAt) / 3600000,
        providers:{ fmp:Boolean(key), twelveData:Boolean(twelveDataKey) },
        databaseConfigured:Boolean(supabaseUrl && supabaseKey),
        globalMarkets:{ available:globalAvailable, updatedAt:pulse?.updatedAt || null },
        checkedAt:new Date().toISOString()
      });
    }
    if (url.pathname === '/api/billing/create-checkout-session') {
      if (req.method !== 'POST') return send(res, 405, { error:'Use POST to start checkout.' }, 'application/json; charset=utf-8', { Allow:'POST' });
      const plan = ['monthly', 'six-month', 'annual'].includes(url.searchParams.get('plan')) ? url.searchParams.get('plan') : 'monthly';
      const selectedPriceId = stripePlanPrices[plan];
      if (!stripeSecretKey || !selectedPriceId) return send(res, 503, { error:`${plan === 'six-month' ? '6-month' : plan === 'annual' ? 'Annual' : 'Monthly'} Pro checkout is not configured yet. Add the matching Stripe price ID in the hosting environment, then redeploy.` });
      const form = new URLSearchParams({
        mode:'subscription',
        'line_items[0][price]':selectedPriceId,
        'line_items[0][quantity]':'1',
        success_url:`${publicAppUrl}/#pricing?checkout=success`,
        cancel_url:`${publicAppUrl}/#pricing?checkout=cancelled`,
        'subscription_data[description]':'DollarDisha Pro monthly subscription'
      });
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method:'POST', headers:{ Authorization:`Bearer ${stripeSecretKey}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:form, signal:AbortSignal.timeout(10000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) return send(res, 502, { error:'Secure checkout could not be created. Check the Stripe price and account settings.' });
      return send(res, 200, { url:data.url });
    }
    if (url.pathname === '/data/company-logo') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const logo = await currentCompanyLogo(ticker);
      if (!logo?.buffer) {
        res.writeHead(404, { ...securityHeaders, 'Cache-Control':'public, max-age=3600' });
        return res.end();
      }
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type':logo.contentType,
        'Content-Length':logo.buffer.length,
        'Cache-Control':'public, max-age=21600, stale-while-revalidate=86400',
        'X-Content-Type-Options':'nosniff'
      });
      return res.end(logo.buffer);
    }
    if (url.pathname === '/data/search' || url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim();
      if (!query || query.length > 50) return send(res, 400, { error:'Provide a company or ticker to search.' });
      try {
        const matches = await nasdaqDirectorySearch(query);
        if (matches.length) return send(res, 200, matches);
      } catch (error) { console.warn(`Nasdaq directory unavailable: ${error.message}`); }
      try {
        const matches = await twelveStockSearch(query);
        if (matches.length) return send(res, 200, matches);
      } catch (error) { console.warn(`Twelve Data directory unavailable: ${error.message}`); }
      try {
        const fmpMatches = await fmp('search-name', { query, limit: 30 });
        return send(res, 200, uniqueNasdaqSearchResults(fmpMatches, query, 8));
      } catch (error) {
        console.warn(`FMP directory unavailable: ${error.message}`);
        return send(res, 200, []);
      }
    }
    if (url.pathname === '/data/company' || url.pathname === '/api/company') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const optional = path => fmp(path, { symbol:ticker, limit: 20 }).catch(() => []);
      const optionalQuarterly = path => fmp(path, { symbol:ticker, period:'quarter', limit: 12 }).catch(() => []);
      const [profile, quote, metrics, income, balance, cashflow, ratios, quarterlyIncome, secData] = await Promise.all([
        optional('profile'), liveQuote(ticker).catch(error => {
          console.warn(`Live quote unavailable for ${ticker}; loading fundamentals without it: ${error.message}`);
          return normalizeQuote(ticker);
        }),
        optional('key-metrics-ttm'), optional('income-statement')
        , optional('balance-sheet-statement'), optional('cash-flow-statement'), optional('ratios-ttm'), optionalQuarterly('income-statement'), secFactsForTicker(ticker).catch(() => null)
      ]);
      const secValues = secData ? secFinancials(secData.facts) : { income:[], balance:[], cashflow:[] };
      const fallbackProfile = { companyName: secData?.facts?.entityName || secData?.company?.title || ticker, cik: secData?.company?.cik_str, sector: 'US Equity', description: secData ? 'Financial statement figures are sourced from this company’s SEC filings.' : 'Latest available price is shown below. Detailed fundamentals are unavailable for this company right now.' };
      const rawProfile = profile[0] || fallbackProfile;
      const rawRatios = ratios[0] || {};
      const rawMetrics = metrics[0] || {};
      const latestIncome = income[0] || secValues.income[0] || {};
      const latestBalance = balance[0] || secValues.balance[0] || {};
      const dilutedShares = finiteValue(latestIncome.weightedAverageShsOutDil, latestIncome.weightedAverageShsOut);
      const reportedBookValuePerShare = finiteValue(rawRatios.bookValuePerShareTTM, rawMetrics.bookValuePerShareTTM, rawMetrics.bookValuePerShare, rawRatios.shareholdersEquityPerShareTTM);
      const derivedBookValuePerShare = safeDivide(latestBalance.totalStockholdersEquity, dilutedShares);
      const bookValuePerShare = finiteValue(reportedBookValuePerShare, derivedBookValuePerShare);
      const earningsPerShare = finiteValue(rawRatios.netIncomePerShareTTM, rawMetrics.netIncomePerShareTTM, rawMetrics.netIncomePerShare);
      const derivedPe = safeDivide(quote.price, earningsPerShare);
      const derivedPriceToBook = safeDivide(quote.price, bookValuePerShare);
      const derivedRoe = safeDivide(rawRatios.netIncomePerShareTTM, rawRatios.shareholdersEquityPerShareTTM);
      const derivedRoa = Number.isFinite(Number(rawRatios.netProfitMarginTTM)) && Number.isFinite(Number(rawRatios.assetTurnoverTTM))
        ? Number(rawRatios.netProfitMarginTTM) * Number(rawRatios.assetTurnoverTTM)
        : null;
      const derivedCurrentRatio = safeDivide(latestBalance.totalCurrentAssets, latestBalance.totalCurrentLiabilities);
      const derivedDebtToEquity = safeDivide(latestBalance.totalDebt, latestBalance.totalStockholdersEquity);
      const derivedDebtRatio = safeDivide(latestBalance.totalDebt, latestBalance.totalAssets);
      // FMP uses different field names across a few datasets. Normalise them
      // once on the server so the website never loses a number that was sent.
      const finalProfile = { ...rawProfile, mktCap: finiteValue(rawProfile.mktCap, rawProfile.marketCap, quote.marketCap, rawMetrics.marketCapTTM) };
      const finalRatios = {
        ...rawRatios,
        peRatioTTM: finiteValue(rawRatios.peRatioTTM, rawRatios.priceToEarningsRatioTTM, rawRatios.priceEarningsRatioTTM, rawMetrics.peRatioTTM, rawMetrics.priceToEarningsRatioTTM, rawMetrics.peRatio, quote.pe, quote.priceEarningsRatio, derivedPe),
        priceToBookRatioTTM: finiteValue(rawRatios.priceToBookRatioTTM, rawRatios.priceBookValueRatioTTM, rawMetrics.priceToBookRatioTTM, rawMetrics.pbRatioTTM, derivedPriceToBook),
        priceToSalesRatioTTM: finiteValue(rawRatios.priceToSalesRatioTTM, rawMetrics.priceToSalesRatioTTM, rawMetrics.priceSalesRatioTTM),
        priceToFreeCashFlowsRatioTTM: finiteValue(rawRatios.priceToFreeCashFlowsRatioTTM, rawRatios.priceToFreeCashFlowRatioTTM, rawMetrics.priceToFreeCashFlowRatioTTM, rawMetrics.pfcfRatioTTM),
        enterpriseValueMultipleTTM: finiteValue(rawRatios.enterpriseValueMultipleTTM, rawMetrics.enterpriseValueMultipleTTM, rawMetrics.enterpriseValueOverEBITDATTM, rawMetrics.evToEBITDATTM),
        dividendYieldTTM: finiteValue(rawRatios.dividendYieldTTM, rawMetrics.dividendYieldTTM),
        grossProfitMarginTTM: finiteValue(rawRatios.grossProfitMarginTTM, rawRatios.grossMarginTTM),
        operatingProfitMarginTTM: finiteValue(rawRatios.operatingProfitMarginTTM, rawRatios.operatingMarginTTM),
        netProfitMarginTTM: finiteValue(rawRatios.netProfitMarginTTM, rawRatios.netMarginTTM),
        returnOnEquityTTM: finiteValue(rawRatios.returnOnEquityTTM, rawRatios.roeTTM, rawMetrics.returnOnEquityTTM, rawMetrics.roeTTM, derivedRoe),
        returnOnAssetsTTM: finiteValue(rawRatios.returnOnAssetsTTM, rawMetrics.returnOnAssetsTTM, rawMetrics.roaTTM, derivedRoa),
        returnOnInvestedCapitalTTM: finiteValue(rawRatios.returnOnInvestedCapitalTTM, rawMetrics.returnOnInvestedCapitalTTM, rawMetrics.roicTTM),
        currentRatioTTM: finiteValue(rawRatios.currentRatioTTM, rawMetrics.currentRatioTTM, derivedCurrentRatio),
        quickRatioTTM: finiteValue(rawRatios.quickRatioTTM, rawMetrics.quickRatioTTM),
        debtToEquityRatioTTM: finiteValue(rawRatios.debtToEquityRatioTTM, rawRatios.debtEquityRatioTTM, rawMetrics.debtToEquityTTM, derivedDebtToEquity),
        debtRatioTTM: finiteValue(rawRatios.debtRatioTTM, rawRatios.debtToAssetsRatioTTM, rawMetrics.debtToAssetsTTM, derivedDebtRatio),
        interestCoverageTTM: finiteValue(rawRatios.interestCoverageTTM, rawRatios.interestCoverageRatioTTM, rawMetrics.interestCoverageTTM),
        companyEquityMultiplierTTM: finiteValue(rawRatios.companyEquityMultiplierTTM, rawRatios.financialLeverageRatioTTM, rawMetrics.financialLeverageRatioTTM),
        operatingCashFlowSalesRatioTTM: finiteValue(rawRatios.operatingCashFlowSalesRatioTTM, rawMetrics.operatingCashFlowSalesRatioTTM),
        freeCashFlowOperatingCashFlowRatioTTM: finiteValue(rawRatios.freeCashFlowOperatingCashFlowRatioTTM, rawMetrics.freeCashFlowOperatingCashFlowRatioTTM),
        assetTurnoverTTM: finiteValue(rawRatios.assetTurnoverTTM, rawMetrics.assetTurnoverTTM),
        inventoryTurnoverTTM: finiteValue(rawRatios.inventoryTurnoverTTM, rawMetrics.inventoryTurnoverTTM),
        receivablesTurnoverTTM: finiteValue(rawRatios.receivablesTurnoverTTM, rawMetrics.receivablesTurnoverTTM),
        payoutRatioTTM: finiteValue(rawRatios.payoutRatioTTM, rawRatios.dividendPayoutRatioTTM, rawMetrics.payoutRatioTTM),
        bookValuePerShareTTM: bookValuePerShare
      };
      const finalMetrics = { ...rawMetrics, bookValuePerShareTTM: bookValuePerShare };
      const finalIncome = income.length ? income : secValues.income;
      const finalBalance = balance.length ? balance : secValues.balance;
      const finalCashflow = cashflow.length ? cashflow : secValues.cashflow;
      await cacheCompany(ticker, finalProfile, quote, { income:finalIncome, balance:finalBalance, cashflow:finalCashflow, ratios:finalRatios });
      return send(res, 200, { profile: finalProfile, quote: quote || {}, live: quote?.price !== null && quote?.price !== undefined && Number.isFinite(Number(quote.price)), providers: quote?.providers || [], metrics: finalMetrics, income:finalIncome, quarterlyIncome, balance:finalBalance, cashflow:finalCashflow, ratios: finalRatios });
    }
    if (url.pathname === '/data/chart') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const requested = Number(url.searchParams.get('points'));
      const points = [22, 130, 260, 780, 1300, 2600, 3900].includes(requested) ? requested : 260;
      const [history, quarterly, quote] = await Promise.all([
        priceHistory(ticker, points),
        fmp('income-statement', { symbol:ticker, period:'quarter', limit:80 }).catch(() => []),
        liveQuote(ticker).catch(() => normalizeQuote(ticker))
      ]);
      const reports = (Array.isArray(quarterly) ? quarterly : []).map(row => ({
        date:row.date || row.filingDate || row.calendarYear,
        eps:finiteValue(row.epsdiluted, row.epsDiluted, row.eps)
      })).filter(row => row.date && Number.isFinite(row.eps)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const values = history.map(point => {
        const report = reports.filter(row => String(row.date) <= String(point.date)).pop();
        const eps = report?.eps ?? null;
        return { ...point, eps, pe:eps !== null && eps > 0 ? point.close / eps : null };
      });
      // Keep the carried-forward EPS for tooltip/P-E calculations, but mark
      // only the first daily candle after each reported filing for the EPS
      // bars. This prevents a quarterly figure from becoming a giant daily
      // staircase across the whole chart.
      for (const report of reports) {
        const index = values.findIndex(point => String(point.date) >= String(report.date));
        if (index >= 0) {
          values[index].epsBar = report.eps;
          values[index].epsReportDate = report.date;
        }
      }
      return send(res, 200, { symbol:ticker, values, quote, live:quote?.price !== null && quote?.price !== undefined && Number.isFinite(Number(quote.price)), providers:quote?.providers || history.providers || [], provider:history.provider || quote?.provider || null });
    }
    if (url.pathname === '/data/peers') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const [peerData, targetProfiles] = await Promise.all([
        fmp('stock-peers', { symbol:ticker }).catch(error => { console.warn(`FMP peers unavailable for ${ticker}: ${error.message}`); return []; }),
        fmp('profile', { symbol:ticker }).catch(() => [])
      ]);
      const targetProfile = targetProfiles[0] || {};
      const peerPayload = Array.isArray(peerData) ? peerData[0] : peerData;
      let peerList = Array.isArray(peerPayload?.peersList) ? peerPayload.peersList : [];
      let screenerRows = [];

      // The direct peer endpoint can legitimately return no rows for smaller
      // companies. Build a second provider-backed peer set from the same
      // industry (or sector) so the comparison section is still useful.
      if (!peerList.length && (targetProfile.industry || targetProfile.sector)) {
        const filters = { limit:20, isActivelyTrading:true };
        if (targetProfile.industry) filters.industry = targetProfile.industry;
        else filters.sector = targetProfile.sector;
        if (targetProfile.exchangeShortName) filters.exchange = targetProfile.exchangeShortName;
        screenerRows = await fmp('company-screener', filters).catch(error => { console.warn(`FMP peer screener unavailable for ${ticker}: ${error.message}`); return []; });
        peerList = screenerRows.map(row => row.symbol);
      }

      const screenedBySymbol = new Map(screenerRows.map(row => [symbol(row.symbol), row]));
      const peerSymbols = [...new Set(peerList.map(symbol).filter(Boolean))].filter(item => item !== ticker).slice(0, 8);
      const rows = await Promise.all(peerSymbols.map(async peer => {
        const screened = screenedBySymbol.get(peer) || {};
        const [profile, quote, ratios] = await Promise.all([fmp('profile', { symbol:peer }).catch(() => []), liveQuote(peer).catch(() => ({})), fmp('ratios-ttm', { symbol:peer }).catch(() => [])]);
        const peerProfile = profile[0] || screened;
        const peerRatios = ratios[0] || {};
        const peerEps = finiteValue(peerRatios.netIncomePerShareTTM);
        const pe = finiteValue(peerRatios.peRatioTTM, peerRatios.priceToEarningsRatioTTM, peerRatios.priceEarningsRatioTTM, quote.pe, quote.priceEarningsRatio, safeDivide(quote.price, peerEps));
        return {
          symbol:peer,
          companyName:peerProfile.companyName || peerProfile.name || peer,
          sector:peerProfile.sector || targetProfile.sector || null,
          industry:peerProfile.industry || targetProfile.industry || null,
          marketCap:finiteValue(peerProfile.mktCap, peerProfile.marketCap, quote.marketCap),
          price:finiteValue(quote.price, screened.price),
          change:finiteValue(quote.changesPercentage, quote.changePercentage, screened.change),
          pe
        };
      }));
      return send(res, 200, rows);
    }
    if (url.pathname === '/data/company-intel') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      // These are intentionally independent: one unavailable premium dataset must
      // never stop the rest of a company research page from loading.
      const optional = (path, parameters = {}) => fmp(path, { symbol:ticker, limit:10, ...parameters }).catch(() => []);
      const [scores, ownerEarnings, earnings, dividends, executives, insiders, estimates, priceTarget, ratings, news, transcriptDates] = await Promise.all([
        optional('financial-scores'), optional('owner-earnings'), optional('earnings'), optional('dividends'),
        optional('company-executives'), optional('insider-trading/search', { page:0 }),
        optional('analyst-estimates', { period:'annual', page:0 }), optional('price-target-consensus'),
        optional('ratings-snapshot'), optional('news/stock', { symbols:ticker }),
        optional('earning-call-transcript-dates')
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
        news: Array.isArray(news) ? news.slice(0, 10) : [],
        transcriptDates: Array.isArray(transcriptDates) ? transcriptDates.slice(0, 12) : []
      });
    }
    if (url.pathname === '/data/earnings-transcript') {
      const ticker = symbol(url.searchParams.get('symbol'));
      const year = Number(url.searchParams.get('year'));
      const quarter = Number(url.searchParams.get('quarter'));
      if (!ticker || !Number.isInteger(year) || year < 1990 || year > 2100 || ![1, 2, 3, 4].includes(quarter)) return send(res, 400, { error:'A valid symbol, year and quarter are required.' });
      const response = await fmp('earning-call-transcript', { symbol:ticker, year, quarter }).catch(() => []);
      const record = Array.isArray(response) ? response[0] : response;
      const rawContent = String(record?.content || record?.transcript || record?.text || '').trim();
      if (!rawContent) return send(res, 404, { error:'No earnings-call transcript is available for this period.' });
      const plainContent = rawContent
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const sentences = plainContent.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z])/).map(value => value.trim()).filter(value => value.length >= 45 && value.length <= 420);
      const priority = /revenue|sales|margin|earnings|eps|guidance|outlook|demand|growth|cash flow|capital expenditure|inventory|headwind|risk|customer|orders|pricing/i;
      const selected = [];
      for (const sentence of [...sentences.filter(value => priority.test(value)), ...sentences]) {
        const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 90);
        if (!key || selected.some(value => value.key === key)) continue;
        selected.push({ key, text:sentence });
        if (selected.length === 8) break;
      }
      return send(res, 200, {
        symbol:ticker,
        year,
        quarter,
        date:record?.date || record?.publishedDate || null,
        title:`${ticker} Q${quarter} ${year} earnings call`,
        content:plainContent,
        highlights:selected.map(value => value.text),
        source:'Company earnings-call transcript supplied by Financial Modeling Prep'
      });
    }
    if (url.pathname === '/data/ownership') {
      const ticker = symbol(url.searchParams.get('symbol'));
      if (!ticker) return send(res, 400, { error:'Invalid ticker.' });
      const optional = (path, parameters = {}) => fmp(path, { symbol:ticker, limit:100, ...parameters }).catch(() => []);
      const [holderResponse, profileResponse, insiderResponse] = await Promise.all([
        optional('institutional-holder'), optional('profile'), optional('insider-trading/search', { page:0 })
      ]);
      const holders = Array.isArray(holderResponse) ? holderResponse : [];
      const profile = Array.isArray(profileResponse) ? profileResponse[0] || {} : {};
      const number = (...values) => finiteValue(...values);
      const periodDate = row => String(row.date || row.reportDate || row.filingDate || row.period || '').slice(0, 10);
      const quarterLabel = date => { const year = Number(String(date).slice(0, 4)); const month = Number(String(date).slice(5, 7)); return year && month ? `${year} Q${Math.ceil(month / 3)}` : null; };
      const buckets = new Map();
      holders.forEach(row => {
        const date = periodDate(row);
        const period = quarterLabel(date);
        if (!period) return;
        const bucket = buckets.get(period) || { period, date, institutionalShares:0, reportedValue:0, holderCount:0, ownershipPercent:null };
        const shares = number(row.shares, row.sharesHeld, row.position);
        const value = number(row.value, row.marketValue, row.currentValue);
        if (shares !== null) bucket.institutionalShares += shares;
        if (value !== null) bucket.reportedValue += value;
        bucket.holderCount += 1;
        const ownership = number(row.ownershipPercent, row.sharesPercent, row.percentOfShares);
        if (ownership !== null) bucket.ownershipPercent = bucket.ownershipPercent === null ? ownership : bucket.ownershipPercent + ownership;
        buckets.set(period, bucket);
      });
      const quarterly = [...buckets.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).map(item => ({
        ...item,
        institutionalShares: item.institutionalShares || null,
        reportedValue: item.reportedValue || null,
        ownershipPercent: item.ownershipPercent
      }));
      const yearlyMap = new Map();
      quarterly.forEach(item => { const year = String(item.period).slice(0, 4); if (!yearlyMap.has(year)) yearlyMap.set(year, { ...item, period: year }); });
      const yearly = [...yearlyMap.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const insiders = Array.isArray(insiderResponse) ? insiderResponse : [];
      const trades = insiders.slice(0, 20).map(row => ({
        date: row.transactionDate || row.filingDate || row.date || null,
        name: row.reportingName || row.reportingOwner || row.name || 'Insider',
        type: row.transactionType || row.transactionTypeName || row.transactionCode || 'Reported transaction',
        shares: number(row.securitiesTransacted, row.shares, row.securitiesOwned),
        value: number(row.transactionValue, row.value)
      }));
      return send(res, 200, {
        symbol:ticker,
        quarterly,
        yearly,
        trades,
        sharesOutstanding:number(profile.sharesOutstanding),
        sharesFloat:number(profile.floatShares, profile.sharesFloat),
        note:'Institutional snapshots and insider transactions are reported by providers and SEC filings; unavailable ownership percentages are left blank.'
      });
    }
    if (url.pathname === '/data/movers') {
      const optional = path => fmp(path, { limit:25 }).catch(() => []);
      const [gainers, losers, active] = await Promise.all([optional('biggest-gainers'), optional('biggest-losers'), optional('most-actives')]);
      return send(res, 200, { gainers, losers, active });
    }
    if (url.pathname === '/data/market-scan') {
      const mode = ['gainers', 'losers', 'largest', 'active'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'gainers';
      return send(res, 200, await marketScan(mode));
    }
    if (url.pathname === '/data/calendar') {
      const fromDate = new Date();
      fromDate.setUTCDate(fromDate.getUTCDate() - 1);
      const toDate = new Date();
      toDate.setUTCDate(toDate.getUTCDate() + 120);
      const range = { from:fromDate.toISOString().slice(0, 10), to:toDate.toISOString().slice(0, 10) };
      const optional = (path, parameters = {}) => fmp(path, { ...parameters, limit:250 }).catch(() => []);
      // FMP's stable calendar requires an explicit date range for future
      // events. Without it the endpoint can return only old rows or none.
      const [earnings, dividends, ipos] = await Promise.all([
        optional('earnings-calendar', range),
        optional('dividends-calendar', range),
        optional('ipos-calendar', range)
      ]);
      return send(res, 200, { earnings, dividends, ipos, from:range.from, to:range.to, updatedAt:new Date().toISOString() });
    }
    if (url.pathname === '/data/watchlist') {
      const tickers = [...new Set(String(url.searchParams.get('symbols') || '').split(',').map(symbol).filter(Boolean))].slice(0, 30);
      if (!tickers.length) return send(res, 200, []);
      const rows = await Promise.all(tickers.map(async ticker => {
        const [quote, ratioRows] = await Promise.all([
          liveQuote(ticker).catch(() => normalizeQuote(ticker)),
          fmp('ratios-ttm', { symbol:ticker }).catch(() => [])
        ]);
        let profile = {};
        if (!quote.name || !finiteValue(quote.marketCap)) profile = (await fmp('profile', { symbol:ticker }).catch(() => []))[0] || {};
        const ratios = ratioRows[0] || {};
        const eps = finiteValue(ratios.netIncomePerShareTTM, quote.eps);
        return {
          symbol:ticker,
          companyName:quote.name || quote.companyName || profile.companyName || ticker,
          price:finiteValue(quote.price),
          marketCap:finiteValue(quote.marketCap, profile.mktCap, profile.marketCap),
          pe:finiteValue(ratios.peRatioTTM, ratios.priceToEarningsRatioTTM, quote.pe, quote.priceEarningsRatio, safeDivide(quote.price, eps)),
          change:finiteValue(quote.changesPercentage, quote.changePercentage),
           changesPercentage:finiteValue(quote.changesPercentage, quote.changePercentage),
           provider:quote.provider || null,
           providers:quote.providers || [],
           sector:profile.sector || null
        };
      }));
      return send(res, 200, rows);
    }
    if (url.pathname === '/data/market' || url.pathname === '/api/market') {
      // Broad-market ETFs are not available under every FMP plan. These liquid US equities
      // give the dashboard reliable live quotes while keeping its free-tier usage low.
      const tickers = ['NVDA', 'MSFT', 'AAPL', 'GOOGL'];
      const quotes = await Promise.all(tickers.map(ticker => liveQuote(ticker).catch(() => normalizeQuote(ticker))));
      return send(res, 200, quotes);
    }
    if (url.pathname === '/data/indices') {
      const indices = [
        ['S&P 500', '^GSPC'], ['Nasdaq Composite', '^IXIC'], ['Dow Jones Industrial Average', '^DJI'], ['Russell 2000', '^RUT']
      ];
      const quotes = await Promise.all(indices.map(([, ticker]) => liveIndex(ticker).catch(() => normalizeQuote(ticker))));
      return send(res, 200, indices.map(([name], index) => ({ name, symbol: indices[index][1], ...quotes[index] })));
    }
    if (url.pathname === '/data/global-markets') {
      return send(res, 200, await globalMarketPulse());
    }
    if (url.pathname === '/data/market-performance') {
      return send(res, 200, await marketPerformance(String(url.searchParams.get('period') || 'day')));
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
      // Keep this section issuer-only: exclude insider ownership, fund/holder
      // reports and other third-party research documents from the company view.
      const issuerForms = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', '20-F', '20-F/A', '40-F', '40-F/A', '6-K', '6-K/A', 'DEF 14A', 'DEFA14A', 'DEFR14A', 'PRE 14A', 'ARS', 'ARS/A', 'S-1', 'S-1/A', 'S-3', 'S-3/A', 'S-4', 'S-4/A', 'S-8', 'S-8/A', 'F-1', 'F-1/A', 'F-3', 'F-3/A', 'F-4', 'F-4/A', 'F-10', 'F-10/A', '15-12B', '15-12G', '15D', 'NT 10-K', 'NT 10-Q']);
      const filings = (recent.accessionNumber || []).reduce((items, accession, index) => {
        const form = String(recent.form?.[index] || '').toUpperCase();
        if (!issuerForms.has(form)) return items;
        const category = form.includes('10-K') || form === '20-F' || form === '40-F' || form === 'ARS' || form === 'ARS/A'
          ? 'Annual report'
          : form.includes('10-Q') ? 'Quarterly report'
            : form.includes('8-K') || form === '6-K' ? 'Current report'
              : form.includes('14A') ? 'Proxy statement'
                : form.includes('S-') || form.startsWith('F-') ? 'Registration statement'
                  : 'Company filing';
        items.push({
          accession, form, category, filedAt: recent.filingDate?.[index],
          reportDate: recent.reportDate?.[index],
          items: recent.items?.[index] || null,
          description: recent.primaryDocDescription?.[index] && recent.primaryDocDescription[index] !== form
            ? recent.primaryDocDescription[index]
            : `${category}${recent.items?.[index] ? ` · Items ${recent.items[index]}` : ''}`,
          url: recent.primaryDocument?.[index] ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replaceAll('-', '')}/${recent.primaryDocument[index]}` : null
        });
        return items;
      }, []).slice(0, 60);
      return send(res, 200, { symbol:ticker, companyName: submission.name, cik: String(cik), filings });
    }
    if (url.pathname === '/data/screener-metrics') {
      const tickers = [...new Set(String(url.searchParams.get('symbols') || '').split(',').map(symbol).filter(Boolean))].slice(0, 60);
      if (!tickers.length) return send(res, 200, []);
      return send(res, 200, await Promise.all(tickers.map(screenerRatio)));
    }
    if (url.pathname === '/data/screener' || url.pathname === '/api/screener') {
      const parameters = { limit: 3000, isEtf: false, isFund: false, isActivelyTrading: true };
      const exchanges = ['NASDAQ', 'NYSE', 'AMEX'];
      const results = await Promise.all(exchanges.map(exchange => fmp('company-screener', { ...parameters, exchange })));
      const seen = new Set();
      const rows = results.flat().filter(item => {
        const ticker = symbol(item.symbol);
        const isFund = item.isEtf === true || item.isFund === true || String(item.isEtf).toLowerCase() === 'true' || String(item.isFund).toLowerCase() === 'true';
        const inactive = item.isActivelyTrading === false || String(item.isActivelyTrading).toLowerCase() === 'false';
        if (!ticker || isFund || inactive || seen.has(ticker)) return false;
        seen.add(ticker);
        return true;
      });
      await cacheScreenerRows(rows.slice(0, 1500));
      return send(res, 200, rows);
    }
    const stockRoute = url.pathname.match(/^\/stocks\/([A-Z0-9][A-Z0-9._-]{0,14})\/?$/i);
    const requested = url.pathname === '/' || stockRoute ? 'index.html' : normalize(url.pathname).replace(/^([.][.][\\/])+/, '');
    if (requested.startsWith('.') || requested.includes('..')) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    const file = join(root, requested);
    let data = await readFile(file);
    const assetName = requested.replace(/^[\\/]+/, '');
    if (stockRoute && assetName === 'index.html') {
      const ticker = stockRoute[1].toUpperCase();
      const canonical = `https://dollardisha.in/stocks/${encodeURIComponent(ticker)}`;
      const title = `${ticker} Stock Research, Financials & SEC Filings | DollarDisha`;
      const description = `Research ${ticker} stock price, financial statements, valuation ratios, peers, charts and official SEC filings on DollarDisha.`;
      data = Buffer.from(data.toString('utf8')
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${canonical}">`)
        .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${canonical}">`)
        .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${title}">`)
        .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${description}">`)
        .replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${title}">`)
        .replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${description}">`)
        .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${description}">`));
    }
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': ['index.html', 'app.js', 'styles.css', 'ui-refresh.css'].includes(assetName) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
    });
    return res.end(data);
  } catch (error) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) return send(res, 502, { error:'Live data is temporarily unavailable.', detail:error.message });
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}).listen(process.env.PORT || 3000, () => console.log('DollarDisha is running at http://localhost:3000'));
