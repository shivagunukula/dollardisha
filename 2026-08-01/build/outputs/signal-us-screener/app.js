const stocks = [
  { ticker: 'NVDA', name: 'NVIDIA', sector: 'Technology' },
  { ticker: 'MSFT', name: 'Microsoft', sector: 'Technology' },
  { ticker: 'AAPL', name: 'Apple', sector: 'Technology' },
  { ticker: 'AMZN', name: 'Amazon', sector: 'Consumer Cyclical' },
  { ticker: 'GOOGL', name: 'Alphabet', sector: 'Technology' },
  { ticker: 'META', name: 'Meta Platforms', sector: 'Technology' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financial Services' },
  { ticker: 'LLY', name: 'Eli Lilly', sector: 'Healthcare' }
];

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '—').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  if (number >= 1e12) return `$${(number / 1e12).toFixed(2)}T`;
  if (number >= 1e9) return `$${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `$${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  return `$${number.toFixed(2)}`;
};
const percent = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : '—';
function providerLabel(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split('+');
  const providers = new Set(raw.map(item => String(item).trim().toLowerCase()).filter(Boolean));
  if (providers.has('fmp') && providers.has('twelve-data')) return 'FMP + Twelve Data';
  if (providers.has('twelve-data')) return 'Twelve Data';
  if (providers.has('fmp')) return 'FMP';
  if (providers.has('yahoo')) return 'Yahoo fallback';
  if (providers.has('nasdaq')) return 'Nasdaq fallback';
  return 'Provider unavailable';
}
async function hydrateProviderStatus() {
  let holder = document.querySelector('[data-provider-status]');
  if (!holder) {
    const proof = document.querySelector('.dashboard-hero .hero-proof');
    if (proof) {
      const item = document.createElement('div');
      item.className = 'feed-status';
      item.innerHTML = '<b>Feeds</b><small data-provider-status>Checking providersâ€¦</small>';
      proof.appendChild(item);
      holder = item.querySelector('[data-provider-status]');
    }
  }
  if (!holder) return;
  try {
    const status = await getJson('/data/provider-status', 15000);
    holder.textContent = status.dualFeedConfigured
      ? 'Dual live feed · FMP + Twelve Data'
      : status.mode === 'fmp-only'
        ? 'Live feed · FMP only (add TWELVE_DATA_API_KEY in Render)'
        : status.mode === 'twelve-data-only'
          ? 'Live feed · Twelve Data only (add FMP_API_KEY in Render)'
          : 'Live feed unavailable · add both provider keys';
    holder.dataset.mode = status.mode;
  } catch {
    holder.textContent = 'Live feed status unavailable';
  }
}
let page = 'dashboard';
let watchlist = JSON.parse(localStorage.getItem('dd-watchlist') || '[]');
let watchlistRefreshTimer;
let basket = JSON.parse(localStorage.getItem('dd-custom-index') || '{"name":"DollarDisha Research 10","symbols":[]}');
const legacyIndexNames = new Set(['DollarDisha Research 10', 'DollarDisha', 'Shiva']);
let indexNameConfirmed = (() => {
  try { return localStorage.getItem('dd-custom-index-name-set') === '1'; } catch { return false; }
})();
let notes = JSON.parse(localStorage.getItem('dd-research-notes') || '[]');
let alerts = JSON.parse(localStorage.getItem('dd-price-alerts') || '[]');
let savedScreens = JSON.parse(localStorage.getItem('dd-saved-screens') || '[]');
let valuationCases = JSON.parse(localStorage.getItem('dd-valuation-cases') || '[]');
let portfolio = JSON.parse(localStorage.getItem('dd-portfolio') || '{"name":"My US portfolio","holdings":[],"updatedAt":null}');
let researchActivity = JSON.parse(localStorage.getItem('dd-research-activity') || '[]');
let authClient = null;
let authSession = null;
let authMode = 'login';
let syncedResearchUser = null;
let researchSyncTimer = null;

function localResearchState() {
  return {
    watchlist:[...new Set(watchlist.map(value => String(value || '').toUpperCase()).filter(Boolean))],
    custom_index:{ name:String(basket?.name || 'My Index').slice(0, 60), symbols:[...new Set((basket?.symbols || []).map(value => String(value || '').toUpperCase()).filter(Boolean))] },
    notes:[
      ...(Array.isArray(notes) ? notes : []),
      ...(Array.isArray(savedScreens) ? savedScreens : []).map(item => ({ kind:'saved-screen', payload:item })),
      ...(Array.isArray(valuationCases) ? valuationCases : []).map(item => ({ kind:'valuation-case', payload:item })),
      { kind:'portfolio', payload:portfolio },
      { kind:'activity-log', payload:{ items:researchActivity, updatedAt:new Date().toISOString() } }
    ],
    alerts:Array.isArray(alerts) ? alerts : []
  };
}
function uniqueResearchItems(...groups) {
  const seen = new Set();
  return groups.flat().filter(item => {
    const id = JSON.stringify(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
function saveResearchStateLocally(state) {
  watchlist = state.watchlist;
  basket = state.custom_index;
  const syncedItems = Array.isArray(state.notes) ? state.notes : [];
  notes = syncedItems.filter(item => !item?.kind);
  savedScreens = syncedItems.filter(item => item?.kind === 'saved-screen' && item.payload).map(item => item.payload);
  valuationCases = syncedItems.filter(item => item?.kind === 'valuation-case' && item.payload).map(item => item.payload);
  const portfolioItems = syncedItems.filter(item => item?.kind === 'portfolio' && item.payload).map(item => item.payload);
  const activityItems = syncedItems.filter(item => item?.kind === 'activity-log' && item.payload).map(item => item.payload);
  portfolio = portfolioItems.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''))).at(-1) || portfolio;
  researchActivity = activityItems.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''))).at(-1)?.items || researchActivity;
  alerts = state.alerts;
  try {
    localStorage.setItem('dd-watchlist', JSON.stringify(watchlist));
    localStorage.setItem('dd-custom-index', JSON.stringify(basket));
    localStorage.setItem('dd-research-notes', JSON.stringify(notes));
    localStorage.setItem('dd-price-alerts', JSON.stringify(alerts));
    localStorage.setItem('dd-saved-screens', JSON.stringify(savedScreens));
    localStorage.setItem('dd-valuation-cases', JSON.stringify(valuationCases));
    localStorage.setItem('dd-portfolio', JSON.stringify(portfolio));
    localStorage.setItem('dd-research-activity', JSON.stringify(researchActivity));
    if (basket.name && !legacyIndexNames.has(basket.name)) localStorage.setItem('dd-custom-index-name-set', '1');
  } catch {}
}
function recordResearchActivity(type, title, detail = '', ticker = '') {
  researchActivity.unshift({ id:`activity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, title, detail, ticker:String(ticker || '').toUpperCase(), at:new Date().toISOString() });
  researchActivity = researchActivity.slice(0, 60);
  try { localStorage.setItem('dd-research-activity', JSON.stringify(researchActivity)); } catch {}
  queueResearchStateSync();
}
async function persistResearchState() {
  const user = authSession?.user;
  if (!authClient || !user) return;
  const state = localResearchState();
  const { error } = await authClient.from('research_state').upsert({ owner_id:user.id, ...state, updated_at:new Date().toISOString() }, { onConflict:'owner_id' });
  if (error) console.warn(`Could not sync DollarDisha research state: ${error.message}`);
}
function queueResearchStateSync() {
  if (!authClient || !authSession?.user) return;
  clearTimeout(researchSyncTimer);
  researchSyncTimer = setTimeout(persistResearchState, 500);
}
async function syncResearchState(user) {
  if (!authClient || !user || syncedResearchUser === user.id) return;
  syncedResearchUser = user.id;
  const local = localResearchState();
  try {
    const { data:remote, error } = await authClient.from('research_state').select('watchlist,custom_index,notes,alerts,updated_at').eq('owner_id', user.id).maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    const remoteIndex = remote?.custom_index && typeof remote.custom_index === 'object' ? remote.custom_index : {};
    const remoteName = String(remoteIndex.name || '').trim();
    const merged = {
      watchlist:[...new Set([...(remote?.watchlist || []), ...local.watchlist].map(value => String(value || '').toUpperCase()).filter(Boolean))],
      custom_index:{
        name:remoteName && !legacyIndexNames.has(remoteName) ? remoteName : local.custom_index.name,
        symbols:[...new Set([...(remoteIndex.symbols || []), ...local.custom_index.symbols].map(value => String(value || '').toUpperCase()).filter(Boolean))]
      },
      notes:uniqueResearchItems(remote?.notes || [], local.notes),
      alerts:uniqueResearchItems(remote?.alerts || [], local.alerts)
    };
    saveResearchStateLocally(merged);
    await persistResearchState();
    if (['watchlist', 'indexlab', 'research', 'screener', 'toolkit', 'portfolio'].includes(page)) render();
  } catch (error) {
    syncedResearchUser = null;
    console.warn(`DollarDisha account sync is unavailable: ${error.message}`);
  }
}

const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(mode, persist = true) {
  const preference = ['light', 'dark', 'auto'].includes(mode) ? mode : 'auto';
  const resolved = preference === 'auto' ? (themeMedia.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.themeMode = preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  if (persist) {
    try { localStorage.setItem('dd-theme', preference); } catch {}
  }
  const label = $('#theme-button-label');
  const icon = $('#theme-button-icon');
  if (label) label.textContent = preference[0].toUpperCase() + preference.slice(1);
  if (icon) icon.textContent = preference === 'light' ? '☀' : preference === 'dark' ? '☾' : '▣';
  document.querySelectorAll('[data-theme-option]').forEach(option => {
    const selected = option.dataset.themeOption === preference;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-checked', String(selected));
  });
}

function setupTheme() {
  const picker = $('.theme-picker');
  const button = $('#theme-button');
  const menu = $('#theme-menu');
  if (!picker || !button || !menu) return;
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  applyTheme(document.documentElement.dataset.themeMode || 'auto', false);
  button.onclick = event => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) menu.querySelector('[aria-checked="true"]')?.focus();
  };
  menu.onclick = event => event.stopPropagation();
  menu.querySelectorAll('[data-theme-option]').forEach(option => option.onclick = () => {
    applyTheme(option.dataset.themeOption);
    close();
    button.focus();
  });
  document.addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  const handleSystemThemeChange = () => {
    if (document.documentElement.dataset.themeMode === 'auto') applyTheme('auto', false);
  };
  if (themeMedia.addEventListener) themeMedia.addEventListener('change', handleSystemThemeChange);
  else themeMedia.addListener(handleSystemThemeChange);
}

function watchButton(ticker) { return `<button class="watch-toggle ${watchlist.includes(ticker) ? 'saved' : ''}" data-watch="${ticker}" title="Add to watchlist">${watchlist.includes(ticker) ? '★' : '☆'}</button>`; }
function companyLogo(ticker, name = ticker, size = 'regular') {
  const safeTicker = String(ticker || '').toUpperCase().replace(/[^A-Z0-9._\/-]/g, '');
  const initials = safeTicker.slice(0, 2) || String(name || '?').slice(0, 1).toUpperCase();
  const src = `/data/company-logo?symbol=${encodeURIComponent(safeTicker)}`;
  return `<span class="company-logo company-logo-${size}" aria-hidden="true"><span>${escapeHtml(initials)}</span><img src="${src}" alt="" loading="lazy" decoding="async" onload="this.parentElement.classList.add('has-image')" onerror="this.remove()"></span>`;
}
function companyIdentity(ticker, name, meta = '') {
  return `<span class="company-identity">${companyLogo(ticker, name)}<span class="company-copy"><b>${escapeHtml(name || ticker)}</b><small>${escapeHtml(ticker)}${meta ? ` · ${escapeHtml(meta)}` : ''}</small></span></span>`;
}
function row(stock) {
  const rawChange = stock.change ?? stock.changesPercentage ?? stock.changePercentage;
  const hasChange = Number.isFinite(Number(rawChange));
  const change = Number(rawChange || 0);
  const ticker = stock.symbol || stock.ticker;
  const name = stock.companyName || stock.name || ticker;
  const price = scanNumber(stock.price, stock.close);
  const cap = scanNumber(stock.marketCap, stock.mktCap, stock.cap ? stock.cap * 1e9 : null);
  const pe = scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM);
  return `<tr class="company-row" data-stock="${ticker}"><td class="company">${companyIdentity(ticker, name)}</td><td>${price !== null ? `$${Number(price).toFixed(2)}` : 'Quote unavailable'}</td><td>${cap !== null ? money(cap) : 'Not reported'}</td><td>${pe !== null && Number(pe) > 0 ? `${Number(pe).toFixed(1)}x` : 'N/M'}</td><td class="${hasChange ? (change >= 0 ? 'positive' : 'down') : ''}">${hasChange ? percent(change) : 'Not reported'}</td><td>${watchButton(ticker)}</td></tr>`;
}
const scanNumber = (...values) => values.find(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) ?? null;
const scanPercent = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.abs(number) <= 2 ? number * 100 : number;
};
const savedCustomRatios = () => {
  try { const value = JSON.parse(localStorage.getItem('dd-custom-ratios') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
};
const customRatioValue = (stock, key) => {
  const definition = savedCustomRatios().find(item => `custom:${item.name}` === key);
  if (!definition) return null;
  const base = metric => ({
    price: stock.price, eps: scanNumber(stock.epsTTM, stock.netIncomePerShareTTM), revenue: scanNumber(stock.revenueTTM, stock.revenue, stock.salesTTM, stock.sales),
    netIncome: scanNumber(stock.netIncomeTTM, stock.netIncome), marketCap: scanNumber(stock.marketCap, stock.cap ? stock.cap * 1e9 : null), pe: scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM),
    shares: scanNumber(stock.sharesOutstanding, stock.shareCount, stock.shares)
  }[metric]);
  const left = Number(base(definition.left)), right = Number(base(definition.right));
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  if (definition.op === '/') return right === 0 ? null : left / right;
  if (definition.op === '*') return left * right;
  if (definition.op === '+') return left + right;
  if (definition.op === '-') return left - right;
  return null;
};
function screenerRow(stock, extraColumns = []) {
  const ticker = stock.symbol || stock.ticker;
  const name = stock.companyName || stock.name || ticker;
  const cap = scanNumber(stock.marketCap, stock.cap ? stock.cap * 1e9 : null);
  const pe = scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM);
  const roe = scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe));
  const volume = scanNumber(stock.volume, stock.avgVolume);
  const sector = stock.sector || 'Not classified';
  const metricValue = key => {
    const value = key === 'eps' ? scanNumber(stock.epsTTM, stock.netIncomePerShareTTM)
      : key === 'growth' ? scanPercent(scanNumber(stock.revenueGrowthTTM))
        : key === 'dividend' ? scanPercent(scanNumber(stock.dividendYieldTTM))
          : key === 'debt' ? scanNumber(stock.debtToEquityRatioTTM, stock.debtToEquity)
            : key === 'pb' ? scanNumber(stock.priceToBookRatioTTM)
              : key === 'ps' ? scanNumber(stock.priceToSalesRatioTTM)
                : key === 'evEbitda' ? scanNumber(stock.enterpriseValueMultipleTTM)
                    : key === 'margin' ? scanPercent(scanNumber(stock.netProfitMarginTTM))
                      : key.startsWith('custom:') ? customRatioValue(stock, key)
                    : null;
    if (value === null) return '—';
    if (['growth', 'dividend', 'margin'].includes(key)) return `${Number(value).toFixed(1)}%`;
    if (['pb', 'ps', 'evEbitda', 'debt'].includes(key)) return `${Number(value).toFixed(1)}x`;
    return `$${Number(value).toFixed(2)}`;
  };
  return `<tr class="company-row" data-stock="${ticker}"><td class="company">${companyIdentity(ticker, name)}</td><td>${scanNumber(stock.price) !== null ? `$${Number(stock.price).toFixed(2)}` : 'Not available'}</td><td>${cap !== null ? money(cap) : 'Not available'}</td><td title="N/M means not meaningful or not reported">${pe !== null && pe > 0 ? `${Number(pe).toFixed(1)}x` : 'N/M'}</td><td>${roe !== null ? `${roe.toFixed(1)}%` : 'Not reported'}</td><td>${volume !== null ? whole(volume) : 'Not available'}</td>${extraColumns.map(column => `<td>${metricValue(column)}</td>`).join('')}<td>${escapeHtml(sector)}</td><td>${watchButton(ticker)}</td></tr>`;
}
function pageHeader(kicker, title, text) { return `<div class="section-header"><div><p class="crumb">${kicker}</p><h1 class="page-title">${title}</h1><p class="sub">${text}</p></div></div>`; }

function dashboardView() {
  return `<div class="page public-home">
  <section class="home-intro" aria-labelledby="home-title"><p class="crumb">DOLLARDISHA · US EQUITY RESEARCH</p><h1 id="home-title">Research a US company.</h1><p>Prices, financial statements, valuation ratios and SEC filings—built for deliberate research, not noise.</p><form id="home-company-form" class="home-company-search"><label class="sr-only" for="home-company-search">Company ticker</label><span aria-hidden="true">⌕</span><input id="home-company-search" autocomplete="off" placeholder="Enter a ticker, e.g. NVDA"><button class="solid-btn" type="submit">Research company</button></form><div class="home-ideas"><span>Try:</span><button type="button" data-page="NVDA">NVDA</button><button type="button" data-page="MSFT">MSFT</button><button type="button" data-page="AAPL">AAPL</button><button type="button" data-page="GOOGL">GOOGL</button></div></section>
  <section class="home-market-section" aria-labelledby="home-market-title"><div class="home-section-head"><div><p class="crumb">MARKET SNAPSHOT</p><h2 id="home-market-title">Large US companies</h2></div><button class="link-button" type="button" data-page="markets">View market scans</button></div><section class="home-market-grid" id="market-cards">${['NVDA', 'MSFT', 'AAPL', 'GOOGL'].map((ticker) => `<button type="button" class="home-market-row market-card" data-market-ticker="${ticker}"><span>${ticker}</span><strong>Loading…</strong><b>Latest available quote</b></button>`).join('')}</section></section>
  <section class="home-research-links" aria-label="Research tools"><article><p class="crumb">01</p><h2>Screen stocks</h2><p>Build a precise list from valuation, quality and price criteria.</p><button class="link-button" type="button" data-page="screener">Open stock screener →</button></article><article><p class="crumb">02</p><h2>Compare companies</h2><p>Put fundamentals and valuation side by side before forming a view.</p><button class="link-button" type="button" data-page="compare">Compare companies →</button></article><article><p class="crumb">03</p><h2>Read filings</h2><p>Follow official SEC disclosures and keep your research in one place.</p><button class="link-button" type="button" data-page="research">Open research hub →</button></article></section>
  <section class="home-watchlist"><div class="home-section-head"><div><p class="crumb">YOUR LIST</p><h2>Watchlist</h2></div><button class="link-button" type="button" data-page="watchlist">Open watchlist</button></div>${watchlist.slice(0, 3).map((ticker) => { const stock = stocks.find((item) => item.ticker === ticker) || { ticker, name: ticker, change: 0 }; return `<button type="button" class="home-watch-row" data-page="${ticker}"><span>${ticker}</span><b>${escapeHtml(stock.name)}</b><em class="${stock.change >= 0 ? 'positive' : 'down'}">${percent(stock.change)}</em></button>`; }).join('') || '<p class="home-empty">No companies saved yet. Add them while browsing the screener or market scans.</p>'}</section></div>`;
}
function setupDashboard() {
  const form = $('#home-company-form');
  const input = $('#home-company-search');
  if (!form || !input) return;
  form.onsubmit = event => {
    event.preventDefault();
    const query = input.value.trim();
    const match = stocks.find(stock => stock.ticker === query.toUpperCase() || stock.name.toLowerCase() === query.toLowerCase());
    if (!match) {
      input.setCustomValidity('Enter a ticker, such as NVDA, MSFT or AAPL.');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    navigateTo(match.ticker);
  };
  input.oninput = () => input.setCustomValidity('');
}

function marketsView() {
  const us = [['S&P 500', '^GSPC'], ['Nasdaq Composite', '^IXIC'], ['Dow Jones Industrial Average', '^DJI'], ['Russell 2000', '^RUT']];
  return `<div class="page">${pageHeader('GLOBAL MARKET INTELLIGENCE', 'Market scans', 'See the world’s major exchanges, commodities and crypto in one live research view. Moves are reference data, not buy or sell signals.')}
  <section class="market-section"><div class="market-section-heading"><div><p class="crumb">UNITED STATES</p><h2>US indices</h2></div><span class="market-freshness" id="us-market-freshness">Loading live data…</span></div><section class="index-grid" id="index-cards">${us.map(([name, ticker]) => `<article class="index-card" data-index="${ticker}"><span>${name}</span><strong>Loading…</strong><b>Latest available index level</b></article>`).join('')}</section></section>
  <section class="market-section"><div class="market-section-heading"><div><p class="crumb">AROUND THE WORLD</p><h2>Global exchanges</h2></div><span class="market-freshness">Exchange level · live/latest where covered</span></div><section class="cross-market-grid" id="global-indices"><article class="cross-market-empty">Loading global exchanges…</article></section></section>
  <section class="market-section"><div class="market-section-heading"><div><p class="crumb">REGIONAL PULSE</p><h2>Which regions are leading?</h2></div><span class="market-freshness">Average move across representative indexes</span></div><section class="region-grid" id="region-pulse"><article class="cross-market-empty">Calculating regional breadth…</article></section></section>
  <section class="market-section"><div class="market-section-heading"><div><p class="crumb">REAL ASSETS</p><h2>Commodities</h2></div><span class="market-freshness">Gold, energy and industrial metals</span></div><section class="cross-market-grid" id="global-commodities"><article class="cross-market-empty">Loading commodities…</article></section></section>
  <section class="market-section"><div class="market-section-heading"><div><p class="crumb">DIGITAL ASSETS</p><h2>Crypto</h2></div><span class="market-freshness">Reference USD pairs</span></div><section class="cross-market-grid" id="global-crypto"><article class="cross-market-empty">Loading crypto…</article></section></section>
  <section class="panel"><div class="panel-head"><div><h2>Discover US companies</h2><p id="market-scan-status" role="status" aria-live="polite">Loading live gainers…</p></div><div><button class="link-button market-mode selected" data-mode="gainers">Top gainers</button><button class="link-button market-mode" data-mode="losers">Top losers</button><button class="link-button market-mode" data-mode="largest">Largest</button></div></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>Today</th><th></th></tr></thead><tbody id="market-table"><tr><td colspan="6">Loading live market scan…</td></tr></tbody></table></div></section></div>`;
}

function screenerView() {
  return `<div class="page">${pageHeader('DISCOVER', 'US stock screener', 'Filter a broad US-equity universe, customise your query and export a research list.')}
  <section class="screen-query-builder" aria-label="Create a search query"><label class="screen-query-label" for="screen-query">Query</label><div class="screen-query-composer"><div class="screen-query-input-wrap"><textarea id="screen-query" rows="5" placeholder="P/E < 25 AND ROE >= 15" autocomplete="off" aria-describedby="screen-query-status" aria-controls="screen-query-suggestions" aria-expanded="false"></textarea><div id="screen-query-suggestions" class="screen-query-suggestions" role="listbox" aria-label="Query suggestions" hidden></div></div><aside class="screen-query-help" aria-live="polite"><b id="screen-query-help-name">Custom query example</b><span id="screen-query-help-description">Market cap &gt; 10B AND<br>P/E &lt; 25 AND<br>ROE &gt;= 15</span><button type="button" id="screen-query-help-action" data-screen-query="Market cap > 10B AND P/E < 25 AND ROE >= 15">Use this example</button></aside></div><p id="screen-query-status" class="screen-query-status">Start typing a metric, for example “price”, “return” or “sales”.</p><div class="screen-query-actions"><button class="solid-btn" id="screen-run-query" type="button">▶&nbsp; Run this query</button><div><button class="link-button" id="screen-gallery-open" type="button">Show all Ratios</button><button class="link-button" id="screen-query-clear" type="button">Clear</button></div></div></section>
  <section id="screen-ratio-gallery" class="screen-ratio-gallery" aria-label="Ratio Gallery" hidden><div class="ratio-gallery-head"><b>Ratio Gallery</b><button type="button" id="screen-gallery-close" class="link-button">Close gallery</button></div><div class="ratio-gallery-operators" aria-label="Query operators"><button type="button" disabled title="Formula expressions are coming soon">+</button><button type="button" disabled title="Formula expressions are coming soon">−</button><button type="button" disabled title="Formula expressions are coming soon">÷</button><button type="button" disabled title="Formula expressions are coming soon">×</button><button type="button" data-query-operator=">">&gt;</button><button type="button" data-query-operator="<">&lt;</button><button type="button" data-query-operator="AND">AND</button><button type="button" disabled title="OR logic is coming soon">OR</button></div><div class="ratio-gallery-tabs" role="tablist"><button type="button" class="selected" data-ratio-gallery-tab="most-used">Most Used</button><button type="button" data-ratio-gallery-tab="annual">Annual P&amp;L</button><button type="button" data-ratio-gallery-tab="quarterly">Quarterly P&amp;L</button><button type="button" data-ratio-gallery-tab="balance">Balance Sheet</button><button type="button" data-ratio-gallery-tab="cash-flow">Cash Flow</button><button type="button" data-ratio-gallery-tab="ratios">Ratios</button><button type="button" data-ratio-gallery-tab="price">Price</button></div><label class="ratio-gallery-search">Search ratio<input id="screen-ratio-search" type="search" placeholder="e.g. sales"></label><div id="screen-ratio-list" class="ratio-gallery-list"></div><p class="ratio-gallery-note">Available fields run against current live US-market and TTM fundamental data. Historical fields appear as company financial history is synced.</p></section>
  <div class="screen-utility-row"><input id="screen-search" placeholder="Search a company or ticker"><button class="solid-btn" id="screen-run">Refresh live data</button><button class="link-button" id="export-screen">Export CSV</button></div>
  <section class="advanced-screen-builder" aria-label="Advanced formula filter"><div><b>Advanced filter</b><small>Add one extra rule to any screen without writing code.</small></div><select id="screen-formula-metric" aria-label="Formula metric"><option value="none">No extra rule</option><option value="pe">P/E</option><option value="roe">ROE %</option><option value="eps">EPS</option><option value="growth">Revenue growth %</option><option value="debt">Debt to equity</option><option value="dividend">Dividend yield %</option><option value="cap">Market cap ($B)</option><option value="volume">Daily volume</option></select><select id="screen-formula-op" aria-label="Formula operator"><option value="gte">at least</option><option value="lte">at most</option><option value="gt">greater than</option><option value="lt">less than</option></select><input id="screen-formula-value" type="number" step="any" placeholder="Value" aria-label="Formula value"><button class="link-button" id="screen-formula-clear" type="button">Clear rule</button></section>
  <div class="screen-presets" aria-label="Quick screening presets"><span>Popular screens</span><button data-screen-preset="mega">Mega-cap leaders</button><button data-screen-preset="value">Profitable value</button><button data-screen-preset="quality">High ROE</button><button data-screen-preset="liquid">Highly liquid</button><button data-screen-preset="dividend">Dividend payers</button><button data-screen-preset="reset">Clear all</button></div>
  <section class="screen-columns" aria-label="Screener result columns"><div><b>Result columns</b><small>Choose the fundamentals shown in every row. Your choices are saved on this device.</small></div><div id="screen-column-controls" class="screen-column-controls" role="group" aria-label="Choose result columns"></div></section>
  <section class="saved-screen-workspace" aria-label="Saved screens"><div class="saved-screen-create"><div><b>Saved screens</b><small>Keep a reusable filter set and detect result changes whenever you run it.</small></div><label><span>Screen name</span><input id="saved-screen-name" maxlength="50" placeholder="e.g. Profitable technology"></label><label class="saved-alert-toggle"><input id="saved-screen-alert" type="checkbox" checked><span>Track result changes</span></label><button class="solid-btn" id="save-current-screen" type="button">Save current screen</button></div><div id="saved-screen-list" class="saved-screen-list"></div></section>
  <div class="filter-layout"><aside class="filters"><div class="filter-title"><span>Filter stocks</span><b>Active US listings</b></div>
    <div class="filter-fields">
      <label>Sector<select id="screen-sector"><option value="all">All sectors</option><option>Technology</option><option>Healthcare</option><option>Financial Services</option><option>Consumer Cyclical</option><option>Communication Services</option><option>Industrials</option><option>Consumer Defensive</option><option>Energy</option><option>Basic Materials</option><option>Real Estate</option><option>Utilities</option></select></label>
      <label>Exchange<select id="screen-exchange"><option value="all">NASDAQ, NYSE & AMEX</option><option value="NASDAQ">NASDAQ</option><option value="NYSE">NYSE</option><option value="AMEX">AMEX</option></select></label>
      <label>Market capitalisation<select id="screen-cap"><option value="all">All sizes</option><option value="mega">Mega cap · $200B+</option><option value="large">Large cap · $10B–$200B</option><option value="mid">Mid cap · $2B–$10B</option><option value="small">Small cap · $300M–$2B</option><option value="micro">Micro cap · under $300M</option></select></label>
      <label>Share price<select id="screen-price"><option value="all">Any price</option><option value="under10">Under $10</option><option value="10to50">$10–$50</option><option value="50to200">$50–$200</option><option value="over200">Above $200</option></select></label>
      <label>Maximum P/E<select id="screen-pe"><option value="999">Any P/E / not reported</option><option value="15">Under 15x</option><option value="20">Under 20x</option><option value="30">Under 30x</option><option value="50">Under 50x</option></select></label>
      <label>Minimum ROE<select id="screen-roe"><option value="0">No minimum</option><option value="10">10%+</option><option value="15">15%+</option><option value="20">20%+</option><option value="30">30%+</option></select></label>
      <label>Minimum EPS<select id="screen-eps"><option value="-999999">Any EPS</option><option value="0">Positive EPS</option><option value="1">$1+</option><option value="5">$5+</option></select></label>
      <label>Minimum revenue growth<select id="screen-growth"><option value="-999999">Any growth</option><option value="0">Positive growth</option><option value="0.1">10%+</option><option value="0.2">20%+</option></select></label>
      <label>Minimum daily volume<select id="screen-volume"><option value="0">Any volume</option><option value="100000">100K+</option><option value="1000000">1M+</option><option value="10000000">10M+</option></select></label>
      <label>Dividend<select id="screen-dividend"><option value="all">Any dividend policy</option><option value="payer">Dividend payers only</option></select></label>
      <label>Sort results<select id="screen-sort"><option value="cap">Market cap · high to low</option><option value="volume">Volume · high to low</option><option value="roe">ROE · high to low</option><option value="pe">P/E · low to high</option><option value="price">Price · high to low</option><option value="name">Company name · A–Z</option></select></label>
    </div>
    <p class="filter-help"><b>N/M</b> means a valuation is not meaningful or has not been reported. P/E and ROE use the latest available TTM filing data.</p>
  </aside><section class="table-panel"><div class="result-meta"><span id="screen-count">Loading active US stocks…</span><span>Click a company to research it</span></div><div class="screen-data-note" id="screen-data-note">Funds and ETFs are excluded. Financial ratios appear when reported by the company.</div><div class="table-wrap"><table class="screener-table"><thead id="screen-table-head"><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>ROE</th><th>Volume</th><th>Sector</th><th></th></tr></thead><tbody id="screen-table"><tr><td colspan="8">Loading the US stock directory…</td></tr></tbody></table></div></section></div></div>`;
}

function indexView() {
  const equal = basket.symbols.length ? (100 / basket.symbols.length).toFixed(1) : '0.0';
  return `<div class="page">${pageHeader('BUILD YOUR OWN BENCHMARK', 'Custom Index', 'Create a personal US-stock basket to organise your research ideas.')}
  <section class="index-hero"><div><span>YOUR INDEX</span><h2>${escapeHtml(basket.name)}</h2><p>${basket.symbols.length} companies · Equal weight <b>${equal}%</b> each</p></div><div class="index-actions"><input id="basket-ticker" maxlength="10" placeholder="Add ticker, e.g. TSLA"><button id="basket-add" class="solid-btn">Add company</button></div></section>
  <section class="index-lab-grid"><div class="panel"><div class="panel-head"><div><h2>Index holdings</h2><p>Add tickers you want to study together.</p></div><button id="basket-rename" class="link-button">Rename</button></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Reference price</th><th>Weight</th><th></th></tr></thead><tbody>${basket.symbols.map((ticker) => { const stock = stocks.find((item) => item.ticker === ticker); return `<tr><td class="company">${escapeHtml(stock ? stock.name : ticker)}<span class="ticker">${ticker}</span></td><td>${stock ? `$${stock.price.toFixed(2)}` : 'Open research'}</td><td>${equal}%</td><td><button data-remove-basket="${ticker}">Remove</button></td></tr>`; }).join('') || '<tr><td colspan="4">Add a ticker above to create your index.</td></tr>'}</tbody></table></div></div><aside class="panel"><div class="panel-head"><div><h2>How to use it</h2><p>A research tool, not a portfolio tracker</p></div></div><div class="callout"><b>Compare ideas consistently</b>Build a theme, a watchlist or a personal benchmark, then review its holdings against broad US indices.</div></aside></section></div>`;
}

function researchView() {
  return `<div class="page research-workspace">${pageHeader('YOUR RESEARCH SYSTEM', 'Research Workspace', 'Track a thesis, monitor catalysts and review official company disclosures in one place.')}
  <section class="workspace-summary"><div><span>WATCHLIST</span><b>${watchlist.length}</b><small>companies followed</small></div><div><span>ACTIVE ALERTS</span><b>${alerts.length}</b><small>price and earnings</small></div><div><span>THESIS CARDS</span><b>${notes.length}</b><small>ideas under review</small></div><div><span>LAST ACTIVITY</span><b>${researchActivity[0] ? new Date(researchActivity[0].at).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : '—'}</b><small>research action</small></div></section>
  <div class="research-grid"><section class="panel"><div class="panel-head"><div><h2>Official filing finder</h2><p>Issuer disclosures direct from SEC EDGAR</p></div></div><div class="filing-search"><input id="filing-ticker" value="AAPL" maxlength="10" placeholder="Ticker e.g. AAPL"><button id="filing-find" class="solid-btn">Find filings</button></div><div id="filing-results" class="filing-results"><p class="sub">Search a US ticker to see its latest official filings.</p></div></section>
  <section class="panel"><div class="panel-head"><div><h2>Research alerts</h2><p>Price levels and earnings dates you want to revisit</p></div></div><div class="alert-form"><input id="alert-ticker" placeholder="Ticker"><select id="alert-direction"><option value="above">Price goes above</option><option value="below">Price goes below</option></select><input id="alert-price" type="number" min="0" step="0.01" placeholder="Price"><button id="alert-add" class="solid-btn">Add alert</button></div><div id="alerts-list" class="alert-list"></div></section></div>
  <section class="panel journal-panel"><div class="panel-head"><div><h2>Thesis tracker</h2><p>Record the thesis, risk, catalyst and next review date before acting.</p></div></div><div class="thesis-form"><input id="note-ticker" placeholder="Ticker, e.g. NVDA"><select id="note-status"><option>Researching</option><option>Watching</option><option>Owned</option><option>Closed</option></select><select id="note-conviction"><option value="1">Conviction 1/5</option><option value="2">Conviction 2/5</option><option value="3" selected>Conviction 3/5</option><option value="4">Conviction 4/5</option><option value="5">Conviction 5/5</option></select><input id="note-review" type="date" title="Next review date"><textarea id="note-text" placeholder="Core thesis — what has to be true?"></textarea><textarea id="note-risk" placeholder="Key risk — what would prove you wrong?"></textarea><textarea id="note-catalyst" placeholder="Catalyst — what could change market expectations?"></textarea><button id="note-save" class="solid-btn">Save thesis card</button></div><div id="notes-list" class="notes-list thesis-list"></div></section>
  <div class="research-grid workspace-feed-grid"><section class="panel"><div class="panel-head"><div><h2>Watchlist filing activity</h2><p>Latest official updates across followed companies</p></div></div><div id="workspace-filings" class="activity-feed"><p class="sub">Loading watchlist disclosures…</p></div></section><section class="panel"><div class="panel-head"><div><h2>Recent research activity</h2><p>Your latest saved decisions and changes</p></div></div><div id="research-activity" class="activity-feed"></div></section></div></div>`;
}

function toolsView() {
  const tool = (icon, title, text, page, label = 'Open tool') => `<article class="tool-library-card"><div class="tool-library-icon" aria-hidden="true">${icon}</div><div><h3>${title}</h3><p>${text}</p><button type="button" class="link-button" data-page="${page}">${label} →</button></div></article>`;
  return `<div class="page tools-library-page">${pageHeader('DOLLARDISHA TOOLKIT', 'Research tools', 'Everything you need to move from discovery to a documented investment decision.')}
    <section class="tool-library-hero"><div><p class="crumb">A COMPLETE RESEARCH WORKFLOW</p><h2>Find. Filter. Understand.</h2><p>Use live quotes, fundamentals, filings and your own assumptions together. Every tool links back to the company pages and saved research.</p></div><div class="tool-library-stats"><div><b>Live</b><span>quotes & scans</span></div><div><b>SEC</b><span>official filings</span></div><div><b>Saved</b><span>ideas & alerts</span></div></div></section>
    <section class="tool-library-section"><div class="section-header"><div><p class="crumb">DISCOVER</p><h2>Find opportunities</h2></div></div><div class="tool-library-grid">${tool('⌕','US stock screener','Combine valuation, growth, quality, size, sector, exchange and liquidity filters.','screener')}${tool('↗','Market scans','Review gainers, laggards, volume leaders, US indices, global benchmarks, commodities and crypto.','markets')}${tool('◎','Global market pulse','Compare regional benchmark performance across day, month, YTD, 3M, 6M, 1Y, 3Y, 5Y and 10Y.','markets','View markets')}${tool('↔','Compare companies','Search the complete directory and compare prices, valuation, growth and quality side by side.','compare')}</div></section>
    <section class="tool-library-section"><div class="section-header"><div><p class="crumb">ANALYSE</p><h2>Go deeper on a company</h2></div></div><div class="tool-library-grid">${tool('▦','Company research','Open overview, charts, PE/EPS history, moving averages, financials, ratios, peers, filings and pros & cons.','AAPL','Open example')}${tool('◫','Research workspace','Save thesis cards, catalysts, risks, filing activity and price or earnings alerts.','research')}${tool('▤','Official filings','Find 10-K, 10-Q, 8-K and other issuer documents from SEC EDGAR.','research','Find filings')}${tool('★','Watchlist','Track saved companies with live price, market cap, P/E and daily change updates.','watchlist')}</div></section>
    <section class="tool-library-section"><div class="section-header"><div><p class="crumb">MODEL</p><h2>Test your assumptions</h2></div></div><div class="tool-library-grid">${tool('⌁','Valuation lab','Build an earnings-growth and exit-multiple scenario from live price and reported TTM EPS.','toolkit')}${tool('₹','INR return calculator','Translate a US stock return and USD/INR move into an estimated rupee outcome.','toolkit')}${tool('◈','Custom index','Create a named, equal-weight basket and monitor its holdings together.','indexlab')}${tool('▣','Portfolio tracker','Record shares and average cost, then follow live value, allocation and return.','portfolio')}</div></section>
    <section class="tool-calculator-grid"><article class="panel mini-calculator"><div class="panel-head"><div><p class="crumb">QUICK CALCULATOR</p><h2>CAGR return</h2><p>Annualised return from an investment’s start and end value.</p></div></div><div class="mini-calculator-fields"><label>Starting value<input id="tool-cagr-start" type="number" min="0" step="0.01" value="1000"></label><label>Ending value<input id="tool-cagr-end" type="number" min="0" step="0.01" value="1500"></label><label>Years<input id="tool-cagr-years" type="number" min="0.1" step="0.1" value="3"></label></div><output id="tool-cagr-result">CAGR: 14.47%</output></article><article class="panel mini-calculator"><div class="panel-head"><div><p class="crumb">QUICK CALCULATOR</p><h2>PEG ratio</h2><p>Compare P/E with expected annual EPS growth.</p></div></div><div class="mini-calculator-fields"><label>P/E<input id="tool-peg-pe" type="number" min="0" step="0.1" value="25"></label><label>EPS growth %<input id="tool-peg-growth" type="number" min="0.1" step="0.1" value="15"></label></div><output id="tool-peg-result">PEG: 1.67x</output></article><article class="panel mini-calculator"><div class="panel-head"><div><p class="crumb">QUICK CALCULATOR</p><h2>Position sizing</h2><p>Estimate shares from a risk budget and stop-loss distance.</p></div></div><div class="mini-calculator-fields"><label>Portfolio value<input id="tool-size-portfolio" type="number" min="0" step="100" value="10000"></label><label>Risk %<input id="tool-size-risk" type="number" min="0.1" step="0.1" value="1"></label><label>Entry price<input id="tool-size-entry" type="number" min="0.01" step="0.01" value="100"></label><label>Stop price<input id="tool-size-stop" type="number" min="0" step="0.01" value="90"></label></div><output id="tool-size-result">Suggested size: 10 shares</output></article></section>
    <section class="tool-library-footer panel"><b>Need the full data view?</b><span>Search any ticker to open its complete DollarDisha research page.</span><button type="button" class="solid-btn" data-page="screener">Open stock screener</button></section></div>`;
}

function setupTools() {
  const calc = () => {
    const start = Number($('#tool-cagr-start')?.value), end = Number($('#tool-cagr-end')?.value), years = Number($('#tool-cagr-years')?.value);
    if (start > 0 && end >= 0 && years > 0) $('#tool-cagr-result').textContent = `CAGR: ${(((end / start) ** (1 / years) - 1) * 100).toFixed(2)}%`;
    const pe = Number($('#tool-peg-pe')?.value), growth = Number($('#tool-peg-growth')?.value);
    if (pe >= 0 && growth > 0) $('#tool-peg-result').textContent = `PEG: ${(pe / growth).toFixed(2)}x`;
    const portfolio = Number($('#tool-size-portfolio')?.value), risk = Number($('#tool-size-risk')?.value) / 100, entry = Number($('#tool-size-entry')?.value), stop = Number($('#tool-size-stop')?.value);
    if (portfolio > 0 && risk > 0 && entry > stop) $('#tool-size-result').textContent = `Suggested size: ${Math.floor((portfolio * risk) / (entry - stop)).toLocaleString('en-US')} shares`;
  };
  ['tool-cagr-start','tool-cagr-end','tool-cagr-years','tool-peg-pe','tool-peg-growth','tool-size-portfolio','tool-size-risk','tool-size-entry','tool-size-stop'].forEach(id => { const input = $(`#${id}`); if (input) input.oninput = calc; });
  calc();
  const toolsPage = document.querySelector('.tools-library-page');
  if (toolsPage && !toolsPage.querySelector('.custom-ratio-tool')) {
    const customRatioTool = document.createElement('section');
    customRatioTool.className = 'panel custom-ratio-tool';
    customRatioTool.innerHTML = '<div class="panel-head"><div><p class="crumb">CUSTOM RATIOS</p><h2>Build a reusable ratio</h2><p>Combine two reported metrics into a formula you can keep with your research.</p></div></div><div class="custom-ratio-form"><label>Name<input id="custom-ratio-name" maxlength="40" placeholder="e.g. Cash per share"></label><label>First metric<select id="custom-ratio-left"><option value="price">Current price</option><option value="eps">EPS</option><option value="revenue">Revenue</option><option value="netIncome">Net income</option><option value="marketCap">Market cap</option><option value="pe">P/E</option></select></label><label>Operator<select id="custom-ratio-op"><option value="/">÷ divide</option><option value="*">× multiply</option><option value="+">+ add</option><option value="-">− subtract</option></select></label><label>Second metric<select id="custom-ratio-right"><option value="shares">Shares outstanding</option><option value="eps">EPS</option><option value="revenue">Revenue</option><option value="netIncome">Net income</option><option value="marketCap">Market cap</option><option value="price">Current price</option></select></label><button class="solid-btn" id="custom-ratio-save" type="button">Save ratio</button></div><p id="custom-ratio-preview" class="custom-ratio-preview">Preview: Current price ÷ Shares outstanding</p><div id="custom-ratio-list" class="custom-ratio-list" aria-live="polite"></div>';
    toolsPage.append(customRatioTool);
    const labels = { price:'Current price', eps:'EPS', revenue:'Revenue', netIncome:'Net income', marketCap:'Market cap', pe:'P/E', shares:'Shares outstanding' };
    const readRatios = () => { try { const value = JSON.parse(localStorage.getItem('dd-custom-ratios') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };
    const writeRatios = ratios => { localStorage.setItem('dd-custom-ratios', JSON.stringify(ratios.slice(0, 20))); };
    const preview = () => { const left = $('#custom-ratio-left')?.value || 'price'; const right = $('#custom-ratio-right')?.value || 'shares'; const op = $('#custom-ratio-op')?.value || '/'; const target = $('#custom-ratio-preview'); if (target) target.textContent = `Preview: ${labels[left]} ${op === '/' ? '÷' : op === '*' ? '×' : op} ${labels[right]}`; };
    const drawRatios = () => { const holder = $('#custom-ratio-list'); if (!holder) return; const ratios = readRatios(); holder.innerHTML = ratios.length ? ratios.map((item, index) => `<div class="custom-ratio-item"><span><b>${escapeHtml(item.name)}</b><small>${labels[item.left] || item.left} ${item.op} ${labels[item.right] || item.right}</small></span><button type="button" data-custom-ratio-remove="${index}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button></div>`).join('') : '<p class="data-empty">No custom ratios saved yet.</p>'; holder.querySelectorAll('[data-custom-ratio-remove]').forEach(button => button.onclick = () => { const ratios = readRatios(); ratios.splice(Number(button.dataset.customRatioRemove), 1); writeRatios(ratios); drawRatios(); }); };
    ['custom-ratio-left','custom-ratio-op','custom-ratio-right'].forEach(id => $(`#${id}`)?.addEventListener('change', preview));
    $('#custom-ratio-save').onclick = () => { const name = $('#custom-ratio-name')?.value.trim() || 'Untitled ratio'; const ratio = { name, left:$('#custom-ratio-left')?.value || 'price', op:$('#custom-ratio-op')?.value || '/', right:$('#custom-ratio-right')?.value || 'shares' }; writeRatios([ratio, ...readRatios().filter(item => item.name.toLowerCase() !== name.toLowerCase())]); $('#custom-ratio-name').value = ''; drawRatios(); preview(); };
    preview();
    drawRatios();
  }
}

function compareView() { return `<div class="page">${pageHeader('RESEARCH SIDE BY SIDE', 'Compare companies', 'Search the complete US stock directory and compare two companies side by side.')}<section class="panel compare-panel"><div class="compare-controls"><div class="compare-picker"><label for="compare-a">First company</label><div class="compare-search"><span>⌕</span><input id="compare-a" value="AAPL" maxlength="50" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="compare-a-results"><div id="compare-a-results" class="compare-results" hidden></div></div></div><span class="compare-vs">VS</span><div class="compare-picker"><label for="compare-b">Second company</label><div class="compare-search"><span>⌕</span><input id="compare-b" value="MSFT" maxlength="50" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="compare-b-results"><div id="compare-b-results" class="compare-results" hidden></div></div></div><button id="compare-run" class="solid-btn">Compare stocks</button></div><div id="comparison"></div></section></div>`; }
function watchlistView() { const placeholders = watchlist.map(ticker => `<tr class="company-row" data-stock="${ticker}"><td class="company">${companyIdentity(ticker, ticker, 'Updating live data…')}</td><td colspan="4">Loading latest values…</td><td>${watchButton(ticker)}</td></tr>`).join(''); return `<div class="page">${pageHeader('YOUR RESEARCH', 'Watchlist', 'Latest available prices and fundamentals. Values refresh every minute while this page is open.')}<section class="panel"><div class="watchlist-toolbar"><span id="watchlist-status" role="status" aria-live="polite">${watchlist.length ? 'Loading live prices…' : 'Add a company to begin.'}</span>${watchlist.length ? '<button type="button" class="link-button" data-refresh-watchlist>Refresh now</button>' : ''}</div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>Today</th><th></th></tr></thead><tbody id="watchlist-body">${placeholders || '<tr><td colspan="6">Your watchlist is empty. Add a company from any scan.</td></tr>'}</tbody></table></div></section></div>`; }

const usd = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', notation:'compact', maximumFractionDigits:2 }).format(Number(value)) : '—';
const whole = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits:0 }).format(Number(value)) : '—';
const compactFinancial = (value, perShare = false) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if (perShare) return `${number < 0 ? '-$' : '$'}${Math.abs(number).toFixed(2)}`;
  const absolute = Math.abs(number);
  const units = absolute >= 1e12 ? [1e12, 'T', 2] : absolute >= 1e9 ? [1e9, 'B', 2] : absolute >= 1e6 ? [1e6, 'M', 2] : absolute >= 1e3 ? [1e3, 'K', 1] : [1, '', 0];
  const decimals = units[2];
  return `${(number / units[0]).toFixed(decimals)}${units[1]}`;
};
const financialTable = (title, rows, fields) => `<section class="panel financial-panel"><div class="panel-head"><div><h2>${title}</h2><p>USD · compact units · annual reports</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Metric</th>${rows.map(item => `<th>${escapeHtml(item.calendarYear || String(item.date || '').slice(0, 4) || 'TTM')}</th>`).join('')}</tr></thead><tbody>${fields.map(([label, key]) => `<tr><td>${label}</td>${rows.map(item => `<td>${compactFinancial(item[key], key === 'eps')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="data-empty">Financial data is not available from the current provider for this company.</p>'}</section>`;

const quarterlyPeriodLabel = (row) => {
  const rawDate = row.date || row.fiscalDateEnding;
  if (rawDate) {
    const date = new Date(`${String(rawDate).slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString('en-US', { month:'short', year:'numeric', timeZone:'UTC' });
  }
  const year = row.calendarYear || row.fiscalYear || '';
  return [row.period, year].filter(Boolean).join(' ') || 'Quarter';
};

const quarterlyNumber = (value, perShare = false) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '&mdash;';
  const number = perShare ? Number(value) : Number(value) / 1e6;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits:perShare ? 2 : 0, maximumFractionDigits:perShare ? 2 : 1 }).format(number);
};

function quarterlyResultsTable(rows) {
  const quarters = (Array.isArray(rows) ? rows : []).slice(0, 8).reverse();
  if (!quarters.length) return '<p class="data-empty">Quarterly results are not available from the current provider for this company.</p>';
  const value = (row, ...keys) => keys.map(key => row[key]).find(item => item !== null && item !== undefined && item !== '' && Number.isFinite(Number(item)));
  const expenses = row => value(row, 'costAndExpenses') ?? (() => {
    const cost = value(row, 'costOfRevenue');
    const operating = value(row, 'operatingExpenses');
    return Number.isFinite(Number(cost)) && Number.isFinite(Number(operating)) ? Number(cost) + Number(operating) : null;
  })();
  const calculatedPercent = (numerator, denominator) => {
    const top = Number(numerator);
    const bottom = Number(denominator);
    return Number.isFinite(top) && Number.isFinite(bottom) && bottom !== 0 ? `${((top / bottom) * 100).toFixed(1)}%` : '&mdash;';
  };
  const metrics = [
    ['Revenue', row => quarterlyNumber(value(row, 'revenue'))],
    ['Expenses', row => quarterlyNumber(expenses(row))],
    ['Operating profit', row => quarterlyNumber(value(row, 'operatingIncome')), 'quarter-key-row'],
    ['Operating margin', row => calculatedPercent(value(row, 'operatingIncome'), value(row, 'revenue'))],
    ['Other income / expense', row => quarterlyNumber(value(row, 'totalOtherIncomeExpensesNet', 'totalOtherIncomeExpenses'))],
    ['Interest expense', row => quarterlyNumber(value(row, 'interestExpense', 'interestExpenseNonOperating'))],
    ['Depreciation & amortisation', row => quarterlyNumber(value(row, 'depreciationAndAmortization', 'depreciationAndAmortizationInIncomeStatement'))],
    ['Profit before tax', row => quarterlyNumber(value(row, 'incomeBeforeTax')), 'quarter-key-row'],
    ['Effective tax rate', row => calculatedPercent(value(row, 'incomeTaxExpense'), value(row, 'incomeBeforeTax'))],
    ['Net income', row => quarterlyNumber(value(row, 'netIncome')), 'quarter-key-row'],
    ['Diluted EPS', row => quarterlyNumber(value(row, 'epsdiluted', 'epsDiluted', 'eps'), true)]
  ];
  const detailFields = {
    Revenue: [['Reported revenue', row => quarterlyNumber(value(row, 'revenue'))], ['Gross profit', row => quarterlyNumber(value(row, 'grossProfit'))]],
    Expenses: [['Cost of revenue', row => quarterlyNumber(value(row, 'costOfRevenue'))], ['Operating expenses', row => quarterlyNumber(value(row, 'operatingExpenses'))], ['Total expenses', row => quarterlyNumber(expenses(row))]],
    'Operating profit': [['Revenue', row => quarterlyNumber(value(row, 'revenue'))], ['Operating income', row => quarterlyNumber(value(row, 'operatingIncome'))], ['Operating margin', row => calculatedPercent(value(row, 'operatingIncome'), value(row, 'revenue'))]],
    'Operating margin': [['Operating income', row => quarterlyNumber(value(row, 'operatingIncome'))], ['Revenue', row => quarterlyNumber(value(row, 'revenue'))], ['Operating margin', row => calculatedPercent(value(row, 'operatingIncome'), value(row, 'revenue'))]],
    'Other income / expense': [['Other income / expense', row => quarterlyNumber(value(row, 'totalOtherIncomeExpensesNet', 'totalOtherIncomeExpenses'))], ['Income before tax', row => quarterlyNumber(value(row, 'incomeBeforeTax'))]],
    'Interest expense': [['Interest expense', row => quarterlyNumber(value(row, 'interestExpense', 'interestExpenseNonOperating'))], ['Operating income', row => quarterlyNumber(value(row, 'operatingIncome'))]],
    'Depreciation & amortisation': [['Depreciation & amortisation', row => quarterlyNumber(value(row, 'depreciationAndAmortization', 'depreciationAndAmortizationInIncomeStatement'))], ['Capital expenditure', row => quarterlyNumber(value(row, 'capitalExpenditure'))]],
    'Profit before tax': [['Profit before tax', row => quarterlyNumber(value(row, 'incomeBeforeTax'))], ['Income tax expense', row => quarterlyNumber(value(row, 'incomeTaxExpense'))], ['Effective tax rate', row => calculatedPercent(value(row, 'incomeTaxExpense'), value(row, 'incomeBeforeTax'))]],
    'Effective tax rate': [['Income tax expense', row => quarterlyNumber(value(row, 'incomeTaxExpense'))], ['Profit before tax', row => quarterlyNumber(value(row, 'incomeBeforeTax'))], ['Effective tax rate', row => calculatedPercent(value(row, 'incomeTaxExpense'), value(row, 'incomeBeforeTax'))]],
    'Net income': [['Net income', row => quarterlyNumber(value(row, 'netIncome'))], ['Revenue', row => quarterlyNumber(value(row, 'revenue'))], ['Net margin', row => calculatedPercent(value(row, 'netIncome'), value(row, 'revenue'))]],
    'Diluted EPS': [['Diluted EPS', row => quarterlyNumber(value(row, 'epsdiluted', 'epsDiluted', 'eps'), true)], ['Diluted shares', row => quarterlyNumber(value(row, 'weightedAverageShsOutDil', 'weightedAverageSharesOutstandingDiluted'), true)] ]
  };
  const key = index => `quarter-detail-${index}`;
  const detailRow = (label, index) => {
    const fields = detailFields[label] || [];
    if (!fields.length) return '';
    return `<tr class="quarter-detail-row" data-quarter-detail="${key(index)}" hidden><td colspan="${quarters.length + 1}"><div class="quarter-detail-grid">${quarters.map((row, quarterIndex) => `<section><b>${escapeHtml(quarterlyPeriodLabel(row))}</b>${fields.map(([field, formatter]) => `<div><span>${escapeHtml(field)}</span><strong>${formatter(row, quarterIndex)}</strong></div>`).join('')}</section>`).join('')}</div></td></tr>`;
  };
  return `<div class="table-wrap quarterly-table-wrap"><table class="quarterly-table"><thead><tr><th>Metric</th>${quarters.map((row, index) => `<th class="${index === quarters.length - 1 ? 'latest-quarter' : ''}">${escapeHtml(quarterlyPeriodLabel(row))}${index === quarters.length - 1 ? '<small>Latest</small>' : ''}</th>`).join('')}</tr></thead><tbody>${metrics.map(([label, format, className = ''], metricIndex) => `<tr class="${className}"><td>${detailFields[label] ? `<button class="quarter-toggle" type="button" data-quarter-toggle="${key(metricIndex)}" aria-expanded="false">${label}<span>+</span></button>` : label}</td>${quarters.map((row, index) => `<td class="${index === quarters.length - 1 ? 'latest-quarter' : ''}">${format(row)}</td>`).join('')}</tr>${detailRow(label, metricIndex)}`).join('')}</tbody></table></div>`;
}

function portfolioView() {
  const holdings = Array.isArray(portfolio?.holdings) ? portfolio.holdings : [];
  return `<div class="page portfolio-page">${pageHeader('PORTFOLIO RESEARCH', 'Portfolio Lab', 'Monitor a personal US-stock portfolio in dollars and rupees with live market data. Research only — not brokerage execution.')}
  <section class="portfolio-command panel"><div><label>Portfolio name<input id="portfolio-name" maxlength="60" value="${escapeHtml(portfolio?.name || 'My US portfolio')}"></label></div><div class="portfolio-add"><label class="portfolio-symbol-search">Company<input id="portfolio-symbol" autocomplete="off" placeholder="Search ticker or company" role="combobox" aria-controls="portfolio-symbol-results"><div id="portfolio-symbol-results" class="compare-results" hidden></div></label><label>Shares<input id="portfolio-shares" type="number" min="0.000001" step="any" placeholder="10"></label><label>Average cost (USD)<input id="portfolio-cost" type="number" min="0" step="0.01" placeholder="150.00"></label><button id="portfolio-add" class="solid-btn" type="button">Add holding</button></div></section>
  <section class="portfolio-kpis"><article><span>MARKET VALUE</span><b id="portfolio-market-value">Loading…</b><small id="portfolio-market-inr">Converting to INR…</small></article><article><span>TODAY</span><b id="portfolio-day-change">—</b><small>live daily change</small></article><article><span>TOTAL RETURN</span><b id="portfolio-total-return">—</b><small>vs average cost</small></article><article><span>USD / INR</span><b id="portfolio-fx">Loading…</b><small id="portfolio-updated">checking live feeds</small></article></section>
  <div class="portfolio-layout"><section class="panel"><div class="panel-head"><div><h2>Holdings</h2><p>${holdings.length} ${holdings.length === 1 ? 'company' : 'companies'} · values refresh every minute</p></div><button id="portfolio-refresh" type="button" class="link-button">Refresh live data</button></div><div class="table-wrap"><table class="portfolio-table"><thead><tr><th>Company</th><th>Shares</th><th>Avg cost</th><th>Live price</th><th>Market value</th><th>Today</th><th>Total return</th><th></th></tr></thead><tbody id="portfolio-body"><tr><td colspan="8">${holdings.length ? 'Loading live portfolio data…' : 'Add your first holding above.'}</td></tr></tbody></table></div></section><aside class="panel allocation-panel"><div class="panel-head"><div><h2>Allocation</h2><p>Current market-value weights</p></div></div><div id="portfolio-allocation" class="allocation-list"><p class="sub">Add holdings to see allocation.</p></div></aside></div>
  <p class="portfolio-disclaimer">DollarDisha does not connect to your broker and does not place trades. Prices and currency conversion can be delayed. For research and education only.</p></div>`;
}

function statusView() {
  return `<div class="page status-page">${pageHeader('LIVE OPERATIONS', 'Data & System Status', 'See which market-data services are connected, when data was last checked and whether the research tools are operating normally.')}
  <section class="status-hero panel"><div><span class="status-dot"></span><div><b id="system-overall">Checking DollarDisha services…</b><small id="system-checked">Connecting to the live server</small></div></div><button id="status-refresh" class="solid-btn" type="button">Run live check</button></section>
  <section class="status-grid"><article class="panel"><span>WEBSITE</span><b id="status-website">Checking</b><small>Application server and secure connection</small></article><article class="panel"><span>FMP</span><b id="status-fmp">Checking</b><small>Quotes, fundamentals and calendars</small></article><article class="panel"><span>TWELVE DATA</span><b id="status-twelve">Checking</b><small>Independent live-quote confirmation</small></article><article class="panel"><span>GLOBAL MARKETS</span><b id="status-global">Checking</b><small>Indices, commodities and crypto pulse</small></article><article class="panel"><span>DATABASE</span><b id="status-database">Checking</b><small>Signed-in research workspace</small></article><article class="panel"><span>AUTOMATIC UPDATE</span><b>Every 60 seconds</b><small>Server snapshots refresh even without an open browser tab</small></article></section>
  <section class="panel status-details"><div class="panel-head"><div><h2>Data policy</h2><p>How DollarDisha handles provider gaps</p></div></div><div class="status-policy"><div><b>Dual-provider validation</b><p>FMP and Twelve Data are combined where coverage overlaps. Official Nasdaq and public market sources are used only as resilient fallbacks.</p></div><div><b>No invented values</b><p>A dash or “not reported” means a provider did not return a reliable figure. DollarDisha never fills financial data with estimates.</p></div><div><b>Official documents</b><p>Company filings link directly to SEC EDGAR. Third-party documents are not mixed into issuer disclosures.</p></div></div></section></div>`;
}

function pricingView() {
  return `<div class="page pricing-page">${pageHeader('DOLLARDISHA PRO', 'Research without limits', 'Unlock the complete research workspace for serious US-equity analysis. One simple plan, billed monthly, with no confusing tiers.')}
  <section class="pricing-hero panel"><div><p class="crumb">BUILT FOR INDIAN INVESTORS</p><h2>Make every research session count.</h2><p class="sub">Pro brings live market context, deeper company pages and a faster workflow together in one focused plan.</p><div class="pricing-proof"><span>✓ Live quote refresh</span><span>✓ Full research pages</span><span>✓ Cancel anytime</span></div></div><div class="price-card"><span class="price-card-label">DOLLARDISHA PRO</span><p class="price-card-intro">Choose the access period that suits you.</p><div class="plan-options" role="radiogroup" aria-label="Choose a Pro plan"><button type="button" class="plan-option selected" data-plan="monthly" aria-pressed="true"><span>Monthly</span><strong>₹99</strong><small>per month</small></button><button type="button" class="plan-option" data-plan="six-month" aria-pressed="false"><span>6 months</span><strong>₹499</strong><small>save 16%</small></button><button type="button" class="plan-option" data-plan="annual" aria-pressed="false"><span>Annual</span><strong>₹999</strong><small>best value</small></button></div><button type="button" class="solid-btn pricing-cta" data-start-checkout>Start Pro</button><small id="billing-status" aria-live="polite">Secure checkout will open in a new window.</small></div></section>
  <section class="pricing-grid"><article class="panel"><h2>Everything in Pro</h2><ul class="feature-list"><li><b>Live market data</b><span>Quotes, indices and market scans refreshed every minute.</span></li><li><b>Complete company research</b><span>Profiles, valuation ratios, EPS, PE, financials and trend charts.</span></li><li><b>Powerful screening</b><span>Saved screens, advanced formulas and quick filters across US equities.</span></li><li><b>Research workspace</b><span>Watchlists, comparisons, portfolio tracking, notes and alerts.</span></li><li><b>Official filings</b><span>Issuer documents linked directly to SEC EDGAR.</span></li></ul></article><article class="panel pricing-free"><h2>Free access</h2><p class="sub">Explore DollarDisha before upgrading.</p><div class="free-row"><span>Company discovery</span><b>Included</b></div><div class="free-row"><span>Basic market pulse</span><b>Included</b></div><div class="free-row"><span>Full research workspace</span><b>Pro</b></div><div class="free-row"><span>Saved screens & alerts</span><b>Pro</b></div><button type="button" class="link-button" data-page="dashboard">Continue exploring →</button></article></section>
  <p class="pricing-note">Market data may be delayed or unavailable. DollarDisha is for research and education only, not investment advice. Subscription access is activated after successful payment.</p></div>`;
}

async function setupPricing() {
  const buttons = [...document.querySelectorAll('[data-start-checkout]')];
  const planButtons = [...document.querySelectorAll('[data-plan]')];
  const status = $('#billing-status');
  if (!buttons.length) return;
  let selectedPlan = 'monthly';
  planButtons.forEach(planButton => planButton.onclick = () => {
    selectedPlan = planButton.dataset.plan || 'monthly';
    planButtons.forEach(item => { const selected = item === planButton; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', String(selected)); });
  });
  buttons.forEach(button => button.onclick = async () => {
    buttons.forEach(item => { item.disabled = true; });
    if (status) status.textContent = 'Preparing secure checkout…';
    try {
      const response = await fetch(`/api/billing/create-checkout-session?plan=${encodeURIComponent(selectedPlan)}`, { method:'POST', headers:{ Accept:'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Checkout is not configured yet.');
      if (data.url) window.location.assign(data.url);
      else throw new Error('Checkout link was not returned.');
    } catch (error) {
      if (status) status.textContent = error.message;
      buttons.forEach(item => { item.disabled = false; });
    }
  });
}

function setupQuarterlyDetails(holder) {
  if (!holder) return;
  holder.querySelectorAll('[data-quarter-toggle]').forEach(button => button.onclick = () => {
    const detail = holder.querySelector(`[data-quarter-detail="${button.dataset.quarterToggle}"]`);
    if (!detail) return;
    const opening = detail.hidden;
    detail.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    button.classList.toggle('expanded', opening);
    const icon = button.querySelector('span');
    if (icon) icon.textContent = opening ? '−' : '+';
  });
}
function render() {
  const view = page === 'dashboard' ? dashboardView() : page === 'markets' ? marketsView() : page === 'screener' ? screenerView() : page === 'indexlab' ? indexView() : page === 'research' ? researchView() : page === 'compare' ? compareView() : page === 'watchlist' ? watchlistView() : page === 'toolkit' ? toolkitView() : page === 'latest-results' ? latestResultsView() : page === 'tools' ? toolsView() : page === 'portfolio' ? portfolioView() : page === 'status' ? statusView() : page === 'pricing' ? pricingView() : companyView(page);
  const content = $('#content');
  content.classList.remove('route-ready');
  content.innerHTML = view;
  document.querySelectorAll('.nav').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('#watch-count').textContent = watchlist.length;
  wireCommon();
  if (page === 'dashboard') { setupDashboard(); hydrateDashboard(); }
  if (page === 'markets') setupMarkets();
  if (page === 'screener') setupScreener();
  if (page === 'indexlab') setupIndex();
  if (page === 'research') setupResearch();
  if (page === 'compare') setupCompare();
  if (page === 'watchlist') hydrateWatchlist();
  else { clearTimeout(watchlistRefreshTimer); watchlistRefreshTimer = null; }
  if (page === 'toolkit') setupToolkit();
  if (page === 'latest-results') setupLatestResults();
  if (page === 'tools') setupTools();
  if (page === 'portfolio') setupPortfolio();
  if (page === 'status') setupSystemStatus();
  if (page === 'pricing') setupPricing();
  if (!['dashboard', 'markets', 'screener', 'indexlab', 'research', 'compare', 'watchlist', 'toolkit', 'latest-results', 'tools', 'portfolio', 'status', 'pricing'].includes(page)) {
    const companyPage = content.querySelector('.company-page');
    if (companyPage) { companyPage.classList.add('company-loading'); companyPage.setAttribute('aria-busy', 'true'); }
    hydrateCompany(page);
    hydrateCompanyResearchSummary(page);
    hydrateCompanyExtras(page);
  }
  requestAnimationFrame(() => activatePageMotion(content));
}

// Refresh only the live regions on the current screen once per minute. This
// keeps prices, scans, charts, ratios, peers and filings current without
// reloading the whole document or interrupting the user's scroll position.
const LIVE_REFRESH_MS = 60 * 1000;
let liveRefreshTimer = null;
let liveRefreshBusy = false;
const isCompanyRoute = route => !['dashboard', 'markets', 'screener', 'indexlab', 'research', 'compare', 'watchlist', 'toolkit', 'latest-results', 'tools', 'portfolio', 'status', 'pricing'].includes(route);
async function refreshLiveData() {
  if (document.hidden || liveRefreshBusy) return;
  liveRefreshBusy = true;
  try {
    jsonRequestCache.clear();
    if (page === 'dashboard') await hydrateDashboard();
    else if (page === 'watchlist') await hydrateWatchlist();
    else if (page === 'portfolio') await hydratePortfolio();
    else if (page === 'status') await hydrateSystemStatus();
    else if (isCompanyRoute(page)) await Promise.allSettled([hydrateCompany(page), hydrateCompanyExtras(page), hydrateCompanyResearchSummary(page)]);
    else if (page === 'markets') await setupMarkets();
    else if (page === 'screener') $('#screen-run')?.click();
    else if (page === 'latest-results') await setupLatestResults();
    else if (page === 'compare') $('#compare-run')?.click();
    else if (page === 'research') await Promise.allSettled([hydrateWorkspaceFilings(), evaluateResearchAlerts()]);
  } finally {
    liveRefreshBusy = false;
  }
}
function startLiveRefresh() {
  clearInterval(liveRefreshTimer);
  liveRefreshTimer = setInterval(refreshLiveData, LIVE_REFRESH_MS);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshLiveData();
});

const routeSections = new Set(['overview', 'chart', 'earnings', 'strengths', 'quarterly', 'financials', 'peers', 'intelligence', 'events', 'documents']);
const toolkitSections = new Set(['valuation-lab', 'india-return-tool', 'earnings-calendar', 'ipo-calendar', 'saved-cases']);
const routeFromHash = () => {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw.includes('=') || raw.startsWith('access_token') || raw.startsWith('error')) return null;
  const decoded = decodeURIComponent(raw);
  return routeSections.has(decoded) || toolkitSections.has(decoded) ? null : decoded;
};
const routeFromPath = () => {
  const match = window.location.pathname.match(/^\/stocks\/([A-Z0-9][A-Z0-9._-]{0,14})\/?$/i);
  return match ? match[1].toUpperCase() : null;
};
// A hash route is an app-level destination even when the current URL is a
// company path.  Without this precedence, clicking Home/Market/Screens from
// `/stocks/AAPL` leaves the path route in control and appears to do nothing.
// Section hashes such as `#chart` intentionally return null above, so they
// continue to behave as normal in-page anchors on a company page.
const routeFromLocation = () => routeFromHash() || routeFromPath();
const routeHref = target => {
  const next = String(target || 'dashboard');
  return isCompanyRoute(next) ? `/stocks/${encodeURIComponent(next.toUpperCase())}` : `/#${encodeURIComponent(next)}`;
};
function navigateTo(target, { replace = false } = {}) {
  const next = String(target || 'dashboard');
  const href = routeHref(next);
  if (`${window.location.pathname}${window.location.hash}` !== href) {
    window.history[replace ? 'replaceState' : 'pushState']({ page: next }, '', href);
  }
  page = next;
  render();
}
function revealRouteSection(sectionId) {
  if (!sectionId) { window.scrollTo(0, 0); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const section = document.getElementById(sectionId);
    if (section) section.scrollIntoView({ behavior:'smooth', block:'start' });
  }));
}
function openRouteInNewTab(target) {
  const opened = window.open(routeHref(target), '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}
function wireCommon() {
  document.querySelectorAll('[data-page]').forEach((button) => {
    const target = button.dataset.page;
    if (button.tagName === 'A') return;
    if (button.tagName !== 'BUTTON') {
      button.setAttribute('role', 'link');
      button.setAttribute('tabindex', '0');
      button.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        navigateTo(target);
        revealRouteSection(button.dataset.section);
      };
    }
    button.setAttribute('title', 'Open with Ctrl/Cmd-click or middle-click in a new tab');
    button.onclick = event => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); openRouteInNewTab(target); return; }
      navigateTo(target);
      revealRouteSection(button.dataset.section);
    };
    button.onauxclick = event => {
      if (event.button === 1) { event.preventDefault(); openRouteInNewTab(target); }
    };
  });
  document.querySelectorAll('[data-stock], [data-market-ticker]').forEach((element) => {
    const target = element.dataset.stock || element.dataset.marketTicker;
    if (!target) return;
    if (!element.dataset.companyPrefetch) {
      const prefetchCompany = () => getJson(`/data/company?symbol=${encodeURIComponent(target)}`).catch(() => null);
      element.addEventListener('pointerenter', prefetchCompany, { once:true, passive:true });
      element.addEventListener('focus', prefetchCompany, { once:true });
      element.dataset.companyPrefetch = 'true';
    }
    if (element.dataset.marketTicker) {
      element.setAttribute('role', 'link');
      element.setAttribute('tabindex', '0');
      element.setAttribute('aria-label', `Open ${target} company research`);
      element.setAttribute('title', `Open ${target} company research`);
      element.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        navigateTo(target); window.scrollTo(0, 0);
      };
    }
    element.onclick = event => {
      if (event.target.closest('[data-watch]')) return;
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); openRouteInNewTab(target); return; }
      navigateTo(target); window.scrollTo(0, 0);
    };
    element.onauxclick = event => {
      if (event.button === 1 && !event.target.closest('[data-watch]')) { event.preventDefault(); openRouteInNewTab(target); }
    };
  });
  document.querySelectorAll('[data-watch]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); const ticker = button.dataset.watch; const removing = watchlist.includes(ticker); watchlist = removing ? watchlist.filter((item) => item !== ticker) : [...watchlist, ticker]; localStorage.setItem('dd-watchlist', JSON.stringify(watchlist)); recordResearchActivity('watchlist', `${removing ? 'Removed' : 'Added'} ${ticker} ${removing ? 'from' : 'to'} watchlist`, '', ticker); queueResearchStateSync(); render(); });
  document.querySelectorAll('[data-refresh-watchlist]').forEach((button) => button.onclick = () => hydrateWatchlist());
}
const jsonRequestCache = new Map();
function markDataFreshness(value = new Date()) {
  const label = $('#data-freshness-label');
  if (!label) return;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return;
  label.textContent = date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  label.closest('.data-freshness')?.classList.add('is-live');
}
async function getJson(url, timeout = 9000) {
  const cacheable = url.startsWith('/data/company?') || url.startsWith('/data/company-intel?') || url.startsWith('/data/filings?') || url.startsWith('/data/market') || url.startsWith('/data/indices') || url.startsWith('/data/global-markets') || url.startsWith('/data/watchlist?');
  const maxAge = url.startsWith('/data/company?') ? 30000 : url.startsWith('/data/watchlist?') ? 15000 : 10000;
  if (cacheable && jsonRequestCache.has(url)) return jsonRequestCache.get(url);
  const request = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { signal:controller.signal, cache:'no-store', headers:{ Accept:'application/json' } });
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const data = await response.json();
        markDataFreshness(data?.updatedAt || data?.checkedAt || new Date());
        return data;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 180));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('Request failed');
  })();
  if (cacheable) {
    jsonRequestCache.set(url, request);
    setTimeout(() => jsonRequestCache.delete(url), maxAge);
    request.catch(() => jsonRequestCache.delete(url));
  }
  return request;
}
async function hydrateWatchlist() {
  clearTimeout(watchlistRefreshTimer);
  watchlistRefreshTimer = null;
  const holder = $('#watchlist-body');
  const status = $('#watchlist-status');
  const requested = [...watchlist];
  if (!holder || !requested.length) return;
  if (status) status.textContent = 'Loading live prices…';
  try {
    const rows = await getJson(`/data/watchlist?symbols=${encodeURIComponent(requested.join(','))}`, 45000);
    if (!Array.isArray(rows)) throw new Error('Invalid watchlist response');
    const currentHolder = $('#watchlist-body');
    if (page !== 'watchlist' || !currentHolder) return;
    const byTicker = new Map(rows.map(item => [String(item.symbol || item.ticker || '').toUpperCase(), item]));
    currentHolder.innerHTML = requested.map(ticker => row(byTicker.get(ticker) || { ticker, name:ticker })).join('');
    const currentStatus = $('#watchlist-status');
    if (currentStatus) currentStatus.textContent = `Live values updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    wireCommon();
  } catch (error) {
    const currentHolder = $('#watchlist-body');
    if (page === 'watchlist' && currentHolder) {
      currentHolder.innerHTML = requested.map(ticker => row({ ticker, name:ticker })).join('');
      const currentStatus = $('#watchlist-status');
      if (currentStatus) currentStatus.textContent = 'Live values could not load. Select Refresh now to retry.';
      wireCommon();
    }
  }
}
async function setupMarkets() {
  const scanCache = new Map();
  const globalSection = $('#global-indices')?.closest('.market-section');
  if (globalSection) globalSection.hidden = true;
  const status = () => $('#market-scan-status');
  const renderIndices = rows => {
    (rows || []).forEach(quote => {
      const card = document.querySelector(`[data-index="${quote.symbol}"]`);
      if (!card) return;
      const price = scanNumber(quote.price);
      const rawChange = scanNumber(quote.changesPercentage, quote.changePercentage);
      card.querySelector('strong').textContent = price !== null ? Number(price).toLocaleString('en-US', { maximumFractionDigits:2 }) : 'Quote unavailable';
      const note = card.querySelector('b');
      note.textContent = rawChange !== null ? `${percent(rawChange)} today` : 'Daily change not reported';
      note.className = rawChange === null ? '' : Number(rawChange) >= 0 ? 'positive' : 'down';
    });
  };
  const renderGlobalMarkets = data => {
    const allIndices = Array.isArray(data?.indices) ? data.indices : [];
    // Do not show a global-market panel full of placeholders. A market is
    // considered usable only when the provider returned a real quote.
    const globalIndices = allIndices.filter(item => item.region !== 'US' && item.provider && scanNumber(item.price) !== null);
    if (globalSection) globalSection.hidden = globalIndices.length === 0;
    const renderList = (holder, rows, empty) => {
      if (!holder) return;
      holder.innerHTML = rows.length ? rows.map(item => {
        const price = scanNumber(item.price);
        const change = scanNumber(item.changesPercentage, item.changePercentage);
        const source = item.provider ? String(item.provider).replace('twelve-data', 'Twelve Data') : 'No provider';
        const venue = item.exchange || item.region || 'Exchange';
        return `<article class="cross-market-card ${change === null ? '' : Number(change) >= 0 ? 'gain' : 'loss'}" data-global-kind="asset" data-global-symbol="${escapeHtml(item.symbol)}"><span>${escapeHtml(item.name)} <em>${escapeHtml(venue)}</em></span><strong>${price !== null ? Number(price).toLocaleString('en-US', { maximumFractionDigits:4 }) : 'Quote unavailable'}</strong><b class="${change === null ? '' : Number(change) >= 0 ? 'positive' : 'down'}">${change !== null ? `${percent(change)} today` : 'Coverage unavailable'}</b><small>${escapeHtml(source)} · ${item.dataStatus === 'unavailable' ? 'not reported' : 'latest quote'}</small></article>`;
      }).join('') : `<article class="cross-market-empty">${empty}</article>`;
    };
    renderList($('#global-indices'), globalIndices, 'Global exchange quotes are temporarily unavailable.');
    const liveAssets = rows => (Array.isArray(rows) ? rows : []).filter(item => item.dataStatus !== 'unavailable' && item.provider && scanNumber(item.price) !== null);
    renderList($('#global-commodities'), liveAssets(data?.commodities), 'Commodity quotes are temporarily unavailable.');
    renderList($('#global-crypto'), liveAssets(data?.crypto), 'Crypto quotes are temporarily unavailable.');
    const regions = Array.isArray(data?.regions) ? data.regions.slice().sort((a, b) => Number(b.change ?? -Infinity) - Number(a.change ?? -Infinity)) : [];
    const regionHolder = $('#region-pulse');
    if (regionHolder) regionHolder.innerHTML = regions.length ? regions.map((item, index) => {
      const change = scanNumber(item.change);
      const breadth = Number(item.total) > 0 && Number.isFinite(Number(item.breadth)) ? `${item.breadth}/${item.total} indexes higher` : 'Breadth unavailable';
      return `<article class="region-card ${change === null ? '' : Number(change) >= 0 ? 'gain' : 'loss'}"><span>${escapeHtml(item.region)}</span><strong>${change !== null ? percent(change) : 'Unavailable'}</strong><b>${breadth}</b><small>${index === 0 && change !== null ? 'Leading region' : index === regions.length - 1 && change !== null ? 'Lagging region' : 'Regional average'}</small></article>`;
    }).join('') : '<article class="cross-market-empty">Regional performance is temporarily unavailable.</article>';
    const freshness = $('#us-market-freshness');
    if (freshness) freshness.textContent = data?.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })} · provider coverage varies` : 'Latest available data';
  };
  const loadMode = async mode => {
    document.querySelectorAll('.market-mode').forEach(button => button.classList.toggle('selected', button.dataset.mode === mode));
    const holder = $('#market-table');
    if (!holder) return;
    holder.innerHTML = `<tr><td colspan="6">Loading live ${mode === 'largest' ? 'large-cap companies' : mode}…</td></tr>`;
    if (status()) status().textContent = `Updating ${mode === 'largest' ? 'largest US companies' : `top ${mode}`}…`;
    try {
      const rows = scanCache.has(mode) ? scanCache.get(mode) : await getJson(`/data/market-scan?mode=${mode}`, 60000);
      if (!Array.isArray(rows)) throw new Error('Invalid market scan response');
      scanCache.set(mode, rows);
      holder.innerHTML = rows.length ? rows.map(row).join('') : '<tr><td colspan="6">No companies were returned for this scan.</td></tr>';
      if (status()) status().textContent = `${rows.length} companies · live quotes and latest reported fundamentals`;
      wireCommon();
    } catch {
      holder.innerHTML = '<tr><td colspan="6">The live scan could not load. Select the scan again to retry.</td></tr>';
      if (status()) status().textContent = 'Live market data is temporarily unavailable.';
    }
  };
  document.querySelectorAll('.market-mode').forEach(button => button.onclick = () => loadMode(button.dataset.mode));
  getJson('/data/indices', 45000).then(renderIndices).catch(() => {
    document.querySelectorAll('#index-cards .index-card').forEach(card => {
      card.querySelector('strong').textContent = 'Quote unavailable';
      card.querySelector('b').textContent = 'Select refresh to try again';
    });
  });
  getJson('/data/global-markets', 60000).then(renderGlobalMarkets).catch(() => {
    ['#global-indices', '#global-commodities', '#global-crypto', '#region-pulse'].forEach(selector => { const holder = $(selector); if (holder) holder.innerHTML = '<article class="cross-market-empty">Live market data is temporarily unavailable. Try again shortly.</article>'; });
  });
  await loadMode('gainers');
}
function setupScreener() {
  // Keep screening results first. The query builder and every extra control remain
  // available below the table instead of competing with the results themselves.
  const screenerPage = $('#screen-table')?.closest('.page');
  const filterLayout = $('.filter-layout');
  const tablePanel = filterLayout?.querySelector('.table-panel');
  const filterPanel = filterLayout?.querySelector('.filters');
  const queryBuilder = $('.screen-query-builder');
  const ratioGallery = $('#screen-ratio-gallery');
  const utilityRow = $('.screen-utility-row');
  const advancedBuilder = $('.advanced-screen-builder');
  const presetsPanel = $('.screen-presets');
  const columnsPanel = $('.screen-columns');
  const savedPanel = $('.saved-screen-workspace');
  if (screenerPage && tablePanel && filterPanel && queryBuilder && ratioGallery) {
    const exportButton = $('#export-screen');
    const searchInput = $('#screen-search');
    const refreshButton = $('#screen-run');
    const resultsPanel = document.createElement('section');
    resultsPanel.className = 'screen-results-panel';
    resultsPanel.innerHTML = `<div class="screen-results-heading"><div><h2>Query results</h2><p id="screen-result-count">Loading active US stocks…</p></div><div class="screen-results-actions"><button type="button" class="link-button" id="screen-save-focus">Save this query</button><button type="button" class="link-button" id="screen-columns-focus">Edit columns</button></div></div>`;
    const actionGroup = resultsPanel.querySelector('.screen-results-actions');
    if (exportButton) actionGroup.append(exportButton);
    resultsPanel.append(tablePanel);
    resultsPanel.insertAdjacentHTML('beforeend', '<div class="screen-pagination" id="screen-pagination"></div>');
    const extraTools = document.createElement('details');
    extraTools.className = 'screen-more-filters';
    extraTools.innerHTML = '<summary>More filters, columns and saved screens</summary><div class="screen-more-filters-content"></div>';
    const extraContent = extraTools.querySelector('.screen-more-filters-content');
    const dataTools = document.createElement('div');
    dataTools.className = 'screen-data-tools';
    if (searchInput) dataTools.append(searchInput);
    if (refreshButton) dataTools.append(refreshButton);
    extraContent.append(dataTools, advancedBuilder, presetsPanel, columnsPanel, savedPanel, filterPanel);
    filterLayout.remove();
    utilityRow?.remove();
    screenerPage.append(queryBuilder, ratioGallery, resultsPanel, extraTools);
  }
  let universe = [];
  let results = [];
  let resultPage = 1;
  const readCustomRatioDefinitions = () => {
    try {
      const value = JSON.parse(localStorage.getItem('dd-custom-ratios') || '[]');
      return Array.isArray(value) ? value.filter(item => item && item.name && item.left && item.right && item.op) : [];
    } catch { return []; }
  };
  const customRatioDefinitions = readCustomRatioDefinitions();
  const columnOptions = [
    ['eps', 'EPS'], ['growth', 'Sales growth'], ['dividend', 'Dividend yield'], ['debt', 'Debt / equity'],
    ['pb', 'P / B'], ['ps', 'P / S'], ['evEbitda', 'EV / EBITDA'], ['margin', 'Net margin']
  ];
  customRatioDefinitions.slice(0, 20).forEach(item => columnOptions.push([`custom:${item.name}`, item.name]));
  let selectedColumns = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dd-screener-columns') || '[]');
      return Array.isArray(saved) ? saved.filter(key => columnOptions.some(([id]) => id === key)).slice(0, 5) : [];
    } catch { return []; }
  })();
  const saveColumns = () => {
    try { localStorage.setItem('dd-screener-columns', JSON.stringify(selectedColumns)); } catch {}
  };
  const renderColumns = () => {
    const controls = $('#screen-column-controls');
    if (!controls) return;
    controls.innerHTML = columnOptions.map(([key, label]) => `<button type="button" class="${selectedColumns.includes(key) ? 'selected' : ''}" data-screen-column="${key}" aria-pressed="${selectedColumns.includes(key)}">${escapeHtml(label)}</button>`).join('');
    controls.querySelectorAll('[data-screen-column]').forEach(button => button.onclick = () => {
      const key = button.dataset.screenColumn;
      if (selectedColumns.includes(key)) selectedColumns = selectedColumns.filter(value => value !== key);
      else if (selectedColumns.length < 5) selectedColumns = [...selectedColumns, key];
      else return;
      saveColumns(); renderColumns(); draw();
    });
  };
  const renderTableHead = () => {
    const head = $('#screen-table-head');
    if (!head) return;
    const labels = new Map(columnOptions);
    const sortableHead = (label, sort) => `<th><button type="button" data-screen-table-sort="${sort}">${label}</button></th>`;
    head.innerHTML = `<tr>${sortableHead('Company', 'name')}${sortableHead('Price', 'price')}${sortableHead('Market cap', 'cap')}${sortableHead('P/E', 'pe')}${sortableHead('ROE', 'roe')}${sortableHead('Volume', 'volume')}${selectedColumns.map(key => `<th>${escapeHtml(labels.get(key) || key)}</th>`).join('')}<th>Sector</th><th></th></tr>`;
    head.querySelectorAll('[data-screen-table-sort]').forEach(button => button.onclick = () => {
      $('#screen-sort').value = button.dataset.screenTableSort || 'cap';
      resultPage = 1;
      draw();
    });
  };
  const exportColumnValue = (stock, key) => {
    if (key === 'eps') return scanNumber(stock.epsTTM, stock.netIncomePerShareTTM) ?? '';
    if (key === 'growth') return scanPercent(scanNumber(stock.revenueGrowthTTM)) ?? '';
    if (key === 'dividend') return scanPercent(scanNumber(stock.dividendYieldTTM)) ?? '';
    if (key === 'debt') return scanNumber(stock.debtToEquityRatioTTM, stock.debtToEquity) ?? '';
    if (key === 'pb') return scanNumber(stock.priceToBookRatioTTM) ?? '';
    if (key === 'ps') return scanNumber(stock.priceToSalesRatioTTM) ?? '';
    if (key === 'evEbitda') return scanNumber(stock.enterpriseValueMultipleTTM) ?? '';
    if (key === 'margin') return scanPercent(scanNumber(stock.netProfitMarginTTM)) ?? '';
    if (key.startsWith('custom:')) return queryMetricValue(stock, key) ?? '';
    return '';
  };
  renderColumns();
  const resultMeta = document.querySelector('.result-meta');
  if (resultMeta && !document.querySelector('#screen-freshness')) resultMeta.insertAdjacentHTML('beforeend', '<span id="screen-freshness">Waiting for live directory data</span>');
  const metricSymbols = new Set();
  const priceMetricSymbols = new Set();
  const financialMetricSymbols = new Set();
  let metricRequest = 0;
  let priceMetricRequest = 0;
  let financialMetricRequest = 0;
  const value = id => $(`#${id}`).value;
  const inCapBand = (cap, band) => band === 'all' || (band === 'mega' && cap >= 2e11) || (band === 'large' && cap >= 1e10 && cap < 2e11) || (band === 'mid' && cap >= 2e9 && cap < 1e10) || (band === 'small' && cap >= 3e8 && cap < 2e9) || (band === 'micro' && cap < 3e8);
  const inPriceBand = (price, band) => band === 'all' || (band === 'under10' && price < 10) || (band === '10to50' && price >= 10 && price < 50) || (band === '50to200' && price >= 50 && price <= 200) || (band === 'over200' && price > 200);
  const queryMetrics = new Map([
    ['p/e', 'pe'], ['pe', 'pe'], ['price to earnings', 'pe'],
    ['p/b', 'pb'], ['pb', 'pb'], ['price to book', 'pb'],
    ['p/s', 'ps'], ['ps', 'ps'], ['price to sales', 'ps'],
    ['ev/ebitda', 'evEbitda'], ['ev / ebitda', 'evEbitda'], ['ev ebitda', 'evEbitda'],
    ['price to free cash flow', 'pfcf'], ['p/fcf', 'pfcf'],
    ['roe', 'roe'], ['return on equity', 'roe'], ['roa', 'roa'], ['return on assets', 'roa'], ['roic', 'roic'], ['return on invested capital', 'roic'], ['eps', 'eps'],
    ['revenue growth', 'growth'], ['sales growth', 'growth'], ['growth', 'growth'], ['revenue', 'revenue'], ['net income', 'netIncome'], ['shares outstanding', 'shares'],
    ['gross margin', 'grossMargin'], ['operating margin', 'operatingMargin'], ['net margin', 'margin'], ['net profit margin', 'margin'],
    ['market cap', 'cap'], ['market capitalization', 'cap'], ['mcap', 'cap'],
    ['price', 'price'], ['share price', 'price'], ['current price', 'price'],
    ['volume', 'volume'], ['daily volume', 'volume'],
    ['current ratio', 'currentRatio'],
    ['quick ratio', 'quickRatio'], ['interest coverage', 'interestCoverage'], ['asset turnover', 'assetTurnover'], ['inventory turnover', 'inventoryTurnover'],
    ['debt to equity', 'debt'], ['debt/equity', 'debt'], ['d/e', 'debt'],
    ['dividend yield', 'dividend'], ['dividend', 'dividend'], ['payout ratio', 'payoutRatio'],
    ['operating cash flow per share', 'operatingCashFlowPerShare'], ['operating cash flow / share', 'operatingCashFlowPerShare'],
    ['free cash flow per share', 'freeCashFlowPerShare'], ['free cash flow / share', 'freeCashFlowPerShare'],
    ['free cash flow yield', 'freeCashFlowYield'], ['fcf yield', 'freeCashFlowYield']
    ,['earnings yield', 'earningsYield'], ['enterprise value', 'enterpriseValue']
    ,['sales', 'sales'], ['sales preceding year', 'salesPrev'], ['sales growth 3 years', 'salesGrowth3y'], ['sales growth 5 years', 'salesGrowth5y'],
    ['profit after tax', 'profitAfterTax'], ['net profit last year', 'profitAfterTax'], ['net profit preceding year', 'profitPrev'], ['profit growth 3 years', 'profitGrowth3y'], ['profit growth 5 years', 'profitGrowth5y'], ['eps preceding year', 'epsPrev'],
    ['sales latest quarter', 'salesLatestQuarter'], ['profit after tax latest quarter', 'profitLatestQuarter'], ['net profit latest quarter', 'profitLatestQuarter'], ['eps latest quarter', 'epsLatestQuarter'],
    ['sales preceding quarter', 'salesPrecedingQuarter'], ['profit after tax preceding quarter', 'profitPrecedingQuarter'], ['net profit preceding quarter', 'profitPrecedingQuarter'], ['eps preceding quarter', 'epsPrecedingQuarter'],
    ['sales preceding year quarter', 'salesPriorYearQuarter'], ['profit after tax preceding year quarter', 'profitPriorYearQuarter'], ['net profit preceding year quarter', 'profitPriorYearQuarter'], ['eps preceding year quarter', 'epsPriorYearQuarter'],
    ['yoy quarterly sales growth', 'salesGrowthQuarter'], ['yoy quarterly profit growth', 'profitGrowthQuarter'],
    ['debt', 'debtBalance'], ['debt preceding year', 'debtPrev'], ['equity capital', 'equity'], ['reserves', 'retainedEarnings'], ['total assets', 'totalAssets'], ['current assets', 'currentAssets'], ['current liabilities', 'currentLiabilities'], ['cash equivalents', 'cashAndEquivalents'], ['inventory', 'inventory'], ['trade receivables', 'receivables'], ['trade payables', 'payables'],
    ['cash from operations last year', 'operatingCashFlow'], ['cash from operations preceding year', 'operatingCashFlowPrev'], ['free cash flow preceding year', 'freeCashFlowPrev'], ['cash from investing last year', 'investingCashFlow'], ['cash from financing last year', 'financingCashFlow'], ['net cash flow last year', 'netCashFlow']
    ,['return over 1 day', 'return1d'], ['return over 1 week', 'return1w'], ['return over 1 month', 'return1m'],
    ['return over 3 months', 'return3m'], ['return over 6 months', 'return6m'], ['return over 1 year', 'return1y'], ['return over 3 years', 'return3y'], ['return over 5 years', 'return5y'],
    ['52-week high', 'high52w'], ['52 week high', 'high52w'], ['52-week low', 'low52w'], ['52 week low', 'low52w'],
    ['all-time high', 'allTimeHigh'], ['all time high', 'allTimeHigh'], ['all-time low', 'allTimeLow'], ['all time low', 'allTimeLow'],
    ['50-day moving average', 'ma50'], ['50 day moving average', 'ma50'], ['dma 50', 'ma50'],
    ['200-day moving average', 'ma200'], ['200 day moving average', 'ma200'], ['dma 200', 'ma200'],
    ['rsi', 'rsi14'], ['macd', 'macd'], ['macd signal', 'macdSignal'],
    ['volume 1 week average', 'volume1w'], ['volume 1 month average', 'volume1m'], ['volume 1 year average', 'volume1y']
  ]);
  let galleryMetricAliases = new Map();
  customRatioDefinitions.forEach(item => galleryMetricAliases.set(String(item.name).trim().toLowerCase().replace(/\s+/g, ' '), `custom:${item.name}`));
  const normaliseQueryMetric = input => {
    const key = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return galleryMetricAliases.get(key) || queryMetrics.get(key);
  };
  const priceHistoryQueryMetrics = new Set(['return1d', 'return1w', 'return1m', 'return3m', 'return6m', 'return1y', 'return3y', 'return5y', 'high52w', 'low52w', 'allTimeHigh', 'allTimeLow', 'ma50', 'ma200', 'rsi14', 'macd', 'macdSignal', 'volume1w', 'volume1m', 'volume1y']);
  const dateQueryMetrics = new Set(['latestResultDate']);
  const queryMetricValue = (stock, metric) => {
    if (metric === 'pe') return scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM);
    if (metric === 'pb') return scanNumber(stock.priceToBookRatioTTM);
    if (metric === 'ps') return scanNumber(stock.priceToSalesRatioTTM);
    if (metric === 'evEbitda') return scanNumber(stock.enterpriseValueMultipleTTM);
    if (metric === 'pfcf') return scanNumber(stock.priceToFreeCashFlowTTM);
    if (metric === 'roe') return scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe));
    if (metric === 'roa') return scanPercent(scanNumber(stock.returnOnAssetsTTM));
    if (metric === 'roic') return scanPercent(scanNumber(stock.returnOnInvestedCapitalTTM));
    if (metric === 'eps') return scanNumber(stock.epsTTM, stock.netIncomePerShareTTM);
    if (metric === 'growth') {
      const growth = scanNumber(stock.revenueGrowthTTM);
      return growth === null ? null : Math.abs(Number(growth)) <= 1 ? Number(growth) * 100 : Number(growth);
    }
    if (metric === 'grossMargin') return scanPercent(scanNumber(stock.grossProfitMarginTTM));
    if (metric === 'operatingMargin') return scanPercent(scanNumber(stock.operatingProfitMarginTTM));
    if (metric === 'margin') return scanPercent(scanNumber(stock.netProfitMarginTTM));
    if (metric === 'cap') return scanNumber(stock.marketCap, stock.cap ? stock.cap * 1e9 : null);
    if (metric === 'price') return scanNumber(stock.price);
    if (metric === 'volume') return scanNumber(stock.volume, stock.avgVolume);
    if (metric === 'revenue') return scanNumber(stock.revenueTTM, stock.revenue, stock.salesTTM, stock.sales);
    if (metric === 'netIncome') return scanNumber(stock.netIncomeTTM, stock.netIncome, stock.netIncomeAvailable);
    if (metric === 'shares') return scanNumber(stock.sharesOutstanding, stock.shareCount, stock.shares);
    if (metric === 'currentRatio') return scanNumber(stock.currentRatioTTM);
    if (metric === 'quickRatio') return scanNumber(stock.quickRatioTTM);
    if (metric === 'interestCoverage') return scanNumber(stock.interestCoverageTTM);
    if (metric === 'assetTurnover') return scanNumber(stock.assetTurnoverTTM);
    if (metric === 'inventoryTurnover') return scanNumber(stock.inventoryTurnoverTTM);
    if (metric === 'debt') return scanNumber(stock.debtToEquityRatioTTM, stock.debtToEquity);
    if (metric === 'operatingCashFlowPerShare') return scanNumber(stock.operatingCashFlowPerShareTTM);
    if (metric === 'freeCashFlowPerShare') return scanNumber(stock.freeCashFlowPerShareTTM);
    if (metric === 'freeCashFlowYield') {
      const yieldValue = scanNumber(stock.freeCashFlowYieldTTM);
      return yieldValue === null ? null : Math.abs(Number(yieldValue)) <= 1 ? Number(yieldValue) * 100 : Number(yieldValue);
    }
    if (metric === 'dividend') {
      const yieldValue = scanNumber(stock.dividendYieldTTM);
      return yieldValue === null ? null : Math.abs(Number(yieldValue)) <= 1 ? Number(yieldValue) * 100 : Number(yieldValue);
    }
    if (metric === 'payoutRatio') return scanPercent(scanNumber(stock.payoutRatioTTM));
    if (String(metric).startsWith('custom:')) {
      const definition = customRatioDefinitions.find(item => `custom:${item.name}` === metric);
      if (!definition) return null;
      const left = queryMetricValue(stock, definition.left);
      const right = queryMetricValue(stock, definition.right);
      if (left === null || right === null || !Number.isFinite(Number(left)) || !Number.isFinite(Number(right))) return null;
      if (definition.op === '/') return Number(right) === 0 ? null : Number(left) / Number(right);
      if (definition.op === '*') return Number(left) * Number(right);
      if (definition.op === '+') return Number(left) + Number(right);
      if (definition.op === '-') return Number(left) - Number(right);
    }
    if (dateQueryMetrics.has(metric)) {
      const timestamp = Date.parse(String(stock[metric] || ''));
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (Object.hasOwn(stock, metric)) return scanNumber(stock[metric]);
    return null;
  };
  const parseQueryNumber = (raw, suffix, metric) => {
    const number = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(number)) return null;
    const unit = String(suffix || '').toLowerCase();
    if (metric === 'cap') return number * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1e9);
    if (metric === 'volume') return number * (unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1);
    return number;
  };
  const parseScreenQuery = input => String(input || '').trim().split(/\s+and\s+|,/i).map(part => part.trim()).filter(Boolean).reduce((parsed, part) => {
    const match = part.match(/^(.+?)\s*(<=|>=|!=|=|<|>)\s*\$?\s*(-?\d[\d,]*(?:\.\d+)?)\s*([%BbMmKk]?)$/);
    const dateMatch = part.match(/^(.+?)\s*(<=|>=|!=|=|<|>)\s*(\d{4}-\d{2}-\d{2})$/);
    const candidate = match || dateMatch;
    if (!candidate) { parsed.invalid.push(part); return parsed; }
    const metric = normaliseQueryMetric(candidate[1]);
    const target = metric && dateQueryMetrics.has(metric)
      ? Date.parse(candidate[3])
      : match ? parseQueryNumber(match[3], match[4], metric) : null;
    if (!metric || target === null) { parsed.invalid.push(part); return parsed; }
    parsed.rules.push({ metric, operator: match[2], target });
    return parsed;
  }, { rules: [], invalid: [] });
  const queryPass = (stock, rules) => rules.every(rule => {
    const current = queryMetricValue(stock, rule.metric);
    if (current === null || !Number.isFinite(Number(current))) return false;
    if (rule.operator === '<') return current < rule.target;
    if (rule.operator === '<=') return current <= rule.target;
    if (rule.operator === '>') return current > rule.target;
    if (rule.operator === '>=') return current >= rule.target;
    if (rule.operator === '!=') return current !== rule.target;
    return current === rule.target;
  });
  const updateQueryStatus = parsed => {
    const status = $('#screen-query-status');
    if (!status) return;
    status.classList.toggle('has-error', Boolean(parsed.invalid.length));
    status.classList.toggle('is-active', Boolean(parsed.rules.length) && !parsed.invalid.length);
    const incompleteField = parsed.invalid.length === 1 && Boolean(normaliseQueryMetric(parsed.invalid[0]));
    if (incompleteField) { status.classList.remove('has-error'); status.textContent = `“${parsed.invalid[0]}” added. Choose an operator and number to complete this rule.`; }
    else if (parsed.invalid.length) status.textContent = `Could not use: ${parsed.invalid.join(' · ')}. Choose a field from the Ratio Gallery, then use <, >, <= or >= with a number (or YYYY-MM-DD for a result date).`;
    else if (parsed.rules.length) status.textContent = `${parsed.rules.length} custom ${parsed.rules.length === 1 ? 'rule' : 'rules'} active. Every rule must match.`;
    else status.textContent = 'Choose a metric from the Ratio Gallery, then add an operator and a number.';
  };
  let financialHistoryLoaded = false;
  let financialHistoryState = 'idle';
  // `available` is deliberately explicit. The gallery may show a metric that
  // belongs in a US-equity screen, but it is only selectable once it is
  // calculated for the whole live universe—not merely for one company page.
  const galleryField = (token, label, available = true) => ({ token, label, available:available === false ? 'financial' : available });
  const galleryFields = {
    'most-used': {
      recent: [
        galleryField('P/E', 'Price to earnings'), galleryField('Return on equity', 'Return on equity'),
        galleryField('Market cap', 'Market capitalisation'), galleryField('Current price', 'Current price'),
        galleryField('Sales growth', 'Sales growth'), galleryField('EPS', 'EPS'),
        galleryField('Dividend yield', 'Dividend yield'), galleryField('Volume', 'Volume')
      ],
      preceding: [galleryField('Sales preceding year', 'Sales preceding year', false), galleryField('EPS preceding year', 'EPS preceding year', false)],
      historical: [galleryField('Sales growth 3 years', 'Sales growth 3 years', false), galleryField('Profit growth 3 years', 'Profit growth 3 years', false), galleryField('Return over 1 year', 'Return over 1 year')]
    },
    annual: {
      recent: [
        galleryField('Sales', 'Sales (TTM)', false), galleryField('Operating margin', 'Operating margin'),
        galleryField('Profit after tax', 'Net income (TTM)', false), galleryField('Return on invested capital', 'Return on invested capital'),
        galleryField('EPS', 'EPS'), galleryField('Sales last year', 'Sales last fiscal year', false),
        galleryField('Operating profit last year', 'Operating income last fiscal year', false), galleryField('Other income last year', 'Other income last fiscal year', false),
        galleryField('EBITDA last year', 'EBITDA last fiscal year', false), galleryField('Depreciation last year', 'Depreciation last fiscal year', false),
        galleryField('EBIT last year', 'EBIT last fiscal year', false), galleryField('Interest last year', 'Interest expense last fiscal year', false),
        galleryField('Profit before tax last year', 'Pre-tax income last fiscal year', false), galleryField('Tax last year', 'Income tax last fiscal year', false),
        galleryField('Net profit last year', 'Net income last fiscal year', false), galleryField('Dividend last year', 'Dividends last fiscal year', false),
        galleryField('Gross margin', 'Gross margin'), galleryField('Operating margin', 'Operating margin'), galleryField('Net profit margin', 'Net profit margin')
      ],
      preceding: [
        galleryField('Sales preceding year', 'Sales preceding year', false), galleryField('Operating profit preceding year', 'Operating income preceding year', false),
        galleryField('Other income preceding year', 'Other income preceding year', false), galleryField('EBITDA preceding year', 'EBITDA preceding year', false),
        galleryField('Depreciation preceding year', 'Depreciation preceding year', false), galleryField('EBIT preceding year', 'EBIT preceding year', false),
        galleryField('Interest preceding year', 'Interest expense preceding year', false), galleryField('Profit before tax preceding year', 'Pre-tax income preceding year', false),
        galleryField('Tax preceding year', 'Income tax preceding year', false), galleryField('Profit after tax preceding year', 'Net income preceding year', false),
        galleryField('Net profit preceding year', 'Net income preceding year', false), galleryField('EPS preceding year', 'EPS preceding year', false),
        galleryField('Sales preceding 12 months', 'Sales preceding 12 months', false), galleryField('Net profit preceding 12 months', 'Net income preceding 12 months', false)
      ],
      historical: [
        galleryField('Sales growth 3 years', 'Sales growth 3 years', false), galleryField('Sales growth 5 years', 'Sales growth 5 years', false), galleryField('Sales growth 7 years', 'Sales growth 7 years', false), galleryField('Sales growth 10 years', 'Sales growth 10 years', false),
        galleryField('Profit growth 3 years', 'Profit growth 3 years', false), galleryField('Profit growth 5 years', 'Profit growth 5 years', false), galleryField('Profit growth 7 years', 'Profit growth 7 years', false), galleryField('Profit growth 10 years', 'Profit growth 10 years', false),
        galleryField('EPS growth 3 years', 'EPS growth 3 years', false), galleryField('EPS growth 5 years', 'EPS growth 5 years', false), galleryField('EPS growth 7 years', 'EPS growth 7 years', false), galleryField('EPS growth 10 years', 'EPS growth 10 years', false),
        galleryField('Average earnings 5 years', 'Average earnings 5 years', false), galleryField('Average EBIT 5 years', 'Average EBIT 5 years', false)
      ]
    },
    quarterly: {
      recent: [
        galleryField('Sales latest quarter', 'Sales latest quarter', false), galleryField('Profit after tax latest quarter', 'Net income latest quarter', false),
        galleryField('YOY quarterly sales growth', 'YoY quarterly sales growth', false), galleryField('YOY quarterly profit growth', 'YoY quarterly profit growth', false),
        galleryField('Sales growth', 'Sales growth'), galleryField('Profit growth', 'Net income growth', false), galleryField('Operating profit latest quarter', 'Operating income latest quarter', false),
        galleryField('Other income latest quarter', 'Other income latest quarter', false), galleryField('EBITDA latest quarter', 'EBITDA latest quarter', false), galleryField('Depreciation latest quarter', 'Depreciation latest quarter', false),
        galleryField('EBIT latest quarter', 'EBIT latest quarter', false), galleryField('Interest latest quarter', 'Interest expense latest quarter', false), galleryField('Profit before tax latest quarter', 'Pre-tax income latest quarter', false),
        galleryField('Tax latest quarter', 'Income tax latest quarter', false), galleryField('Net profit latest quarter', 'Net income latest quarter', false), galleryField('Gross margin latest quarter', 'Gross margin latest quarter', false), galleryField('Operating margin latest quarter', 'Operating margin latest quarter', false),
        galleryField('Net margin latest quarter', 'Net margin latest quarter', false), galleryField('EPS latest quarter', 'EPS latest quarter', false), galleryField('Last result date', 'Last earnings result date', false)
      ],
      preceding: [
        galleryField('Sales preceding quarter', 'Sales preceding quarter', false), galleryField('Operating profit preceding quarter', 'Operating income preceding quarter', false), galleryField('Other income preceding quarter', 'Other income preceding quarter', false),
        galleryField('EBITDA preceding quarter', 'EBITDA preceding quarter', false), galleryField('Depreciation preceding quarter', 'Depreciation preceding quarter', false), galleryField('EBIT preceding quarter', 'EBIT preceding quarter', false),
        galleryField('Interest preceding quarter', 'Interest expense preceding quarter', false), galleryField('Profit before tax preceding quarter', 'Pre-tax income preceding quarter', false), galleryField('Tax preceding quarter', 'Income tax preceding quarter', false),
        galleryField('Profit after tax preceding quarter', 'Net income preceding quarter', false), galleryField('Net profit preceding quarter', 'Net income preceding quarter', false), galleryField('EPS preceding quarter', 'EPS preceding quarter', false)
      ],
      historical: [
        galleryField('Sales preceding year quarter', 'Sales in prior-year quarter', false), galleryField('Operating profit preceding year quarter', 'Operating income in prior-year quarter', false), galleryField('EBITDA preceding year quarter', 'EBITDA in prior-year quarter', false),
        galleryField('Profit after tax preceding year quarter', 'Net income in prior-year quarter', false), galleryField('Net profit preceding year quarter', 'Net income in prior-year quarter', false), galleryField('EPS preceding year quarter', 'EPS in prior-year quarter', false)
      ]
    },
    balance: {
      recent: [
        galleryField('Debt', 'Total debt', false), galleryField('Equity capital', 'Shareholders’ equity', false), galleryField('Reserves', 'Retained earnings', false), galleryField('Short-term debt', 'Short-term debt', false), galleryField('Long-term debt', 'Long-term debt', false),
        galleryField('Balance sheet total', 'Balance-sheet total', false), galleryField('Gross block', 'Gross property, plant & equipment', false), galleryField('Accumulated depreciation', 'Accumulated depreciation', false), galleryField('Net block', 'Net property, plant & equipment', false),
        galleryField('Other property, plant & equipment', 'Other property, plant & equipment', false), galleryField('Investments', 'Investments', false), galleryField('Current assets', 'Current assets', false), galleryField('Current liabilities', 'Current liabilities', false),
        galleryField('Total assets', 'Total assets', false), galleryField('Working capital', 'Working capital', false), galleryField('Lease liabilities', 'Lease liabilities', false), galleryField('Inventory', 'Inventory', false), galleryField('Trade receivables', 'Accounts receivable', false),
        galleryField('Cash equivalents', 'Cash & equivalents', false), galleryField('Trade payables', 'Accounts payable', false), galleryField('Debt to equity', 'Debt to equity'), galleryField('Current ratio', 'Current ratio'), galleryField('Quick ratio', 'Quick ratio')
      ],
      preceding: [galleryField('Debt preceding year', 'Debt preceding year', false), galleryField('Working capital preceding year', 'Working capital preceding year', false), galleryField('Net block preceding year', 'Net property, plant & equipment preceding year', false), galleryField('Gross block preceding year', 'Gross property, plant & equipment preceding year', false)],
      historical: [galleryField('Working capital 3 years back', 'Working capital 3 years back', false), galleryField('Working capital 5 years back', 'Working capital 5 years back', false), galleryField('Debt 3 years back', 'Debt 3 years back', false), galleryField('Debt 5 years back', 'Debt 5 years back', false), galleryField('Net block 3 years back', 'Net PPE 3 years back', false), galleryField('Net block 5 years back', 'Net PPE 5 years back', false)]
    },
    'cash-flow': {
      recent: [galleryField('Operating cash flow / share', 'Operating cash flow per share'), galleryField('Free cash flow / share', 'Free cash flow per share'), galleryField('Free cash flow yield', 'Free cash flow yield'), galleryField('Cash from operations last year', 'Cash from operations last fiscal year', false), galleryField('Cash from investing last year', 'Cash from investing last fiscal year', false), galleryField('Cash from financing last year', 'Cash from financing last fiscal year', false), galleryField('Net cash flow last year', 'Net cash flow last fiscal year', false), galleryField('Cash beginning last year', 'Cash at start of fiscal year', false), galleryField('Cash end last year', 'Cash at end of fiscal year', false)],
      preceding: [galleryField('Free cash flow preceding year', 'Free cash flow preceding year', false), galleryField('Cash from operations preceding year', 'Cash from operations preceding year', false), galleryField('Cash from investing preceding year', 'Cash from investing preceding year', false), galleryField('Cash from financing preceding year', 'Cash from financing preceding year', false), galleryField('Net cash flow preceding year', 'Net cash flow preceding year', false)],
      historical: [galleryField('Free cash flow 3 years', 'Free cash flow 3 years', false), galleryField('Free cash flow 5 years', 'Free cash flow 5 years', false), galleryField('Operating cash flow 3 years', 'Operating cash flow 3 years', false), galleryField('Operating cash flow 5 years', 'Operating cash flow 5 years', false), galleryField('Investing cash flow 3 years', 'Investing cash flow 3 years', false), galleryField('Cash 3 years back', 'Cash 3 years back', false)]
    },
    ratios: {
      recent: [
        galleryField('Market cap', 'Market capitalisation'), galleryField('P/E', 'Price to earnings'), galleryField('Dividend yield', 'Dividend yield'), galleryField('Price to book', 'Price to book'), galleryField('Return on assets', 'Return on assets'), galleryField('Debt to equity', 'Debt to equity'), galleryField('Return on equity', 'Return on equity'),
        galleryField('Earnings yield', 'Earnings yield'), galleryField('Enterprise value', 'Enterprise value'), galleryField('Price to sales', 'Price to sales'), galleryField('Price to free cash flow', 'Price to free cash flow'), galleryField('EV / EBITDA', 'EV / EBITDA'), galleryField('Return on invested capital', 'Return on invested capital'),
        galleryField('Gross margin', 'Gross margin'), galleryField('Operating margin', 'Operating margin'), galleryField('Net profit margin', 'Net profit margin'), galleryField('Current ratio', 'Current ratio'), galleryField('Quick ratio', 'Quick ratio'), galleryField('Interest coverage', 'Interest coverage'), galleryField('Asset turnover', 'Asset turnover'), galleryField('Inventory turnover', 'Inventory turnover'), galleryField('Payout ratio', 'Payout ratio')
      ],
      preceding: [galleryField('Book value preceding year', 'Book value preceding year', false), galleryField('Return on capital employed preceding year', 'Return on capital employed preceding year', false), galleryField('Return on assets preceding year', 'Return on assets preceding year', false), galleryField('Return on equity preceding year', 'Return on equity preceding year', false)],
      historical: [galleryField('Average return on equity 3 years', 'Average return on equity 3 years', false), galleryField('Average return on equity 5 years', 'Average return on equity 5 years', false), galleryField('Average return on capital employed 3 years', 'Average return on capital employed 3 years', false), galleryField('Average return on capital employed 5 years', 'Average return on capital employed 5 years', false), galleryField('Historical P/E 3 years', 'Historical P/E 3 years', false), galleryField('Historical P/E 5 years', 'Historical P/E 5 years', false), galleryField('Historical P/B 3 years', 'Historical P/B 3 years', false), galleryField('Market capitalisation 3 years back', 'Market capitalisation 3 years back', false)]
    },
    price: {
      recent: [galleryField('Current price', 'Current price'), galleryField('Volume', 'Volume'), galleryField('Return over 3 months', 'Return over 3 months'), galleryField('Return over 6 months', 'Return over 6 months'), galleryField('52-week high', '52-week high'), galleryField('52-week low', '52-week low'), galleryField('All-time high', 'All-time high'), galleryField('All-time low', 'All-time low'), galleryField('Return over 1 day', 'Return over 1 day'), galleryField('Return over 1 week', 'Return over 1 week'), galleryField('Return over 1 month', 'Return over 1 month'), galleryField('50-day moving average', '50-day moving average'), galleryField('200-day moving average', '200-day moving average'), galleryField('RSI', 'RSI'), galleryField('MACD', 'MACD')],
      preceding: [],
      historical: [galleryField('Return over 1 year', 'Return over 1 year'), galleryField('Return over 3 years', 'Return over 3 years'), galleryField('Return over 5 years', 'Return over 5 years'), galleryField('Volume 1 year average', 'Volume 1-year average')]
    }
  };
  // Every financial-gallery chip is connected to a normalized field returned
  // by /data/screener-financial-metrics. This makes the displayed vocabulary
  // and the query parser use one consistent source of truth.
  const financialMetricRows = [
    ['sales', ['Sales', 'Sales last year']], ['salesPrev', ['Sales preceding year', 'Sales preceding 12 months']], ['salesGrowth3y', ['Sales growth 3 years']], ['salesGrowth5y', ['Sales growth 5 years']], ['salesGrowth7y', ['Sales growth 7 years']], ['salesGrowth10y', ['Sales growth 10 years']],
    ['operatingProfit', ['Operating profit last year']], ['operatingProfitPrev', ['Operating profit preceding year']], ['otherIncome', ['Other income last year']], ['otherIncomePrev', ['Other income preceding year']], ['ebitda', ['EBITDA last year']], ['ebitdaPrev', ['EBITDA preceding year']], ['depreciation', ['Depreciation last year']], ['depreciationPrev', ['Depreciation preceding year']], ['ebit', ['EBIT last year']], ['ebitPrev', ['EBIT preceding year']], ['interestExpense', ['Interest last year']], ['interestExpensePrev', ['Interest preceding year']], ['incomeBeforeTax', ['Profit before tax last year']], ['incomeBeforeTaxPrev', ['Profit before tax preceding year']], ['incomeTax', ['Tax last year']], ['incomeTaxPrev', ['Tax preceding year']],
    ['profitAfterTax', ['Profit after tax', 'Net profit last year']], ['profitPrev', ['Profit after tax preceding year', 'Net profit preceding year', 'Net profit preceding 12 months']], ['profitGrowth3y', ['Profit growth 3 years']], ['profitGrowth5y', ['Profit growth 5 years']], ['profitGrowth7y', ['Profit growth 7 years']], ['profitGrowth10y', ['Profit growth 10 years']], ['epsAnnual', ['EPS last year']], ['epsPrev', ['EPS preceding year']], ['epsGrowth3y', ['EPS growth 3 years']], ['epsGrowth5y', ['EPS growth 5 years']], ['epsGrowth7y', ['EPS growth 7 years']], ['epsGrowth10y', ['EPS growth 10 years']], ['dividendAnnual', ['Dividend last year']], ['averageEarnings5y', ['Average earnings 5 years']], ['averageEbit5y', ['Average EBIT 5 years']],
    ['salesLatestQuarter', ['Sales latest quarter']], ['salesPrecedingQuarter', ['Sales preceding quarter']], ['salesPriorYearQuarter', ['Sales preceding year quarter']], ['sales2QuartersBack', ['Sales 2 quarters back']], ['sales3QuartersBack', ['Sales 3 quarters back']], ['salesGrowthQuarter', ['YOY quarterly sales growth']], ['profitLatestQuarter', ['Profit after tax latest quarter', 'Net profit latest quarter']], ['profitPrecedingQuarter', ['Profit after tax preceding quarter', 'Net profit preceding quarter']], ['profitPriorYearQuarter', ['Profit after tax preceding year quarter', 'Net profit preceding year quarter']], ['profit2QuartersBack', ['Net profit 2 quarters back']], ['profit3QuartersBack', ['Net profit 3 quarters back']], ['profitGrowthQuarter', ['YOY quarterly profit growth', 'Profit growth']], ['epsLatestQuarter', ['EPS latest quarter']], ['epsPrecedingQuarter', ['EPS preceding quarter']], ['epsPriorYearQuarter', ['EPS preceding year quarter']],
    ['operatingProfitLatestQuarter', ['Operating profit latest quarter']], ['operatingProfitPrecedingQuarter', ['Operating profit preceding quarter']], ['operatingProfitPriorYearQuarter', ['Operating profit preceding year quarter']], ['otherIncomeLatestQuarter', ['Other income latest quarter']], ['otherIncomePrecedingQuarter', ['Other income preceding quarter']], ['otherIncomePriorYearQuarter', ['Other income preceding year quarter']], ['ebitdaLatestQuarter', ['EBITDA latest quarter']], ['ebitdaPrecedingQuarter', ['EBITDA preceding quarter']], ['ebitdaPriorYearQuarter', ['EBITDA preceding year quarter']], ['depreciationLatestQuarter', ['Depreciation latest quarter']], ['depreciationPrecedingQuarter', ['Depreciation preceding quarter']], ['depreciationPriorYearQuarter', ['Depreciation preceding year quarter']], ['ebitLatestQuarter', ['EBIT latest quarter']], ['ebitPrecedingQuarter', ['EBIT preceding quarter']], ['ebitPriorYearQuarter', ['EBIT preceding year quarter']], ['interestLatestQuarter', ['Interest latest quarter']], ['interestPrecedingQuarter', ['Interest preceding quarter']], ['interestPriorYearQuarter', ['Interest preceding year quarter']], ['preTaxLatestQuarter', ['Profit before tax latest quarter']], ['preTaxPrecedingQuarter', ['Profit before tax preceding quarter']], ['preTaxPriorYearQuarter', ['Profit before tax preceding year quarter']], ['taxLatestQuarter', ['Tax latest quarter']], ['taxPrecedingQuarter', ['Tax preceding quarter']], ['taxPriorYearQuarter', ['Tax preceding year quarter']], ['grossMarginLatestQuarter', ['Gross margin latest quarter']], ['grossMarginPrecedingQuarter', ['Gross margin preceding quarter']], ['grossMarginPriorYearQuarter', ['Gross margin preceding year quarter']], ['operatingMarginLatestQuarter', ['Operating margin latest quarter']], ['operatingMarginPrecedingQuarter', ['Operating margin preceding quarter']], ['operatingMarginPriorYearQuarter', ['Operating margin preceding year quarter']], ['netMarginLatestQuarter', ['Net margin latest quarter']], ['netMarginPrecedingQuarter', ['Net margin preceding quarter']], ['netMarginPriorYearQuarter', ['Net margin preceding year quarter']], ['latestResultDate', ['Last result date']],
    ['debt', ['Debt']], ['debtPrev', ['Debt preceding year']], ['debt3y', ['Debt 3 years back']], ['debt5y', ['Debt 5 years back']], ['debt7y', ['Debt 7 years back']], ['debt10y', ['Debt 10 years back']], ['shortTermDebt', ['Short-term debt']], ['longTermDebt', ['Long-term debt']], ['equity', ['Equity capital']], ['preferredEquity', ['Preference capital']], ['retainedEarnings', ['Reserves']], ['totalAssets', ['Total assets', 'Balance sheet total']], ['totalLiabilities', ['Total liabilities']], ['grossPpe', ['Gross block']], ['grossPpePrev', ['Gross block preceding year']], ['accumulatedDepreciation', ['Accumulated depreciation']], ['netPpe', ['Net block']], ['netPpePrev', ['Net block preceding year']], ['netPpe3y', ['Net block 3 years back']], ['netPpe5y', ['Net block 5 years back']], ['otherPpe', ['Other property, plant & equipment']], ['investments', ['Investments']], ['currentAssets', ['Current assets']], ['currentLiabilities', ['Current liabilities']], ['workingCapital', ['Working capital']], ['workingCapitalPrev', ['Working capital preceding year']], ['workingCapital3y', ['Working capital 3 years back']], ['workingCapital5y', ['Working capital 5 years back']], ['workingCapital7y', ['Working capital 7 years back']], ['workingCapital10y', ['Working capital 10 years back']], ['leaseLiabilities', ['Lease liabilities']], ['inventory', ['Inventory']], ['receivables', ['Trade receivables']], ['cashAndEquivalents', ['Cash equivalents']], ['payables', ['Trade payables']],
    ['operatingCashFlow', ['Cash from operations last year']], ['operatingCashFlowPrev', ['Cash from operations preceding year']], ['operatingCashFlow3y', ['Operating cash flow 3 years']], ['operatingCashFlow5y', ['Operating cash flow 5 years']], ['operatingCashFlow7y', ['Operating cash flow 7 years']], ['operatingCashFlow10y', ['Operating cash flow 10 years']], ['freeCashFlow', ['Free cash flow last year']], ['freeCashFlowPrev', ['Free cash flow preceding year']], ['freeCashFlow3y', ['Free cash flow 3 years']], ['freeCashFlow5y', ['Free cash flow 5 years']], ['freeCashFlow7y', ['Free cash flow 7 years']], ['freeCashFlow10y', ['Free cash flow 10 years']], ['investingCashFlow', ['Cash from investing last year']], ['investingCashFlowPrev', ['Cash from investing preceding year']], ['investingCashFlow3y', ['Investing cash flow 3 years']], ['investingCashFlow5y', ['Investing cash flow 5 years']], ['investingCashFlow7y', ['Investing cash flow 7 years']], ['investingCashFlow10y', ['Investing cash flow 10 years']], ['financingCashFlow', ['Cash from financing last year']], ['financingCashFlowPrev', ['Cash from financing preceding year']], ['netCashFlow', ['Net cash flow last year']], ['netCashFlowPrev', ['Net cash flow preceding year']], ['cashBeginning', ['Cash beginning last year']], ['cashEnd', ['Cash end last year']], ['cash3y', ['Cash 3 years back']],
    ['bookValuePrev', ['Book value preceding year']], ['annualRocePrev', ['Return on capital employed preceding year']], ['annualRoaPrev', ['Return on assets preceding year']], ['annualRoePrev', ['Return on equity preceding year']], ['averageRoe3y', ['Average return on equity 3 years']], ['averageRoe5y', ['Average return on equity 5 years']], ['averageRoe7y', ['Average return on equity 7 years']], ['averageRoe10y', ['Average return on equity 10 years']], ['averageRoa3y', ['Return on assets 3 years', 'Return on assets 5 years']], ['averageRoce3y', ['Average return on capital employed 3 years']], ['averageRoce5y', ['Average return on capital employed 5 years']], ['averageRoce7y', ['Average return on capital employed 7 years']], ['averageRoce10y', ['Average return on capital employed 10 years']], ['historicalPe3y', ['Historical P/E 3 years']], ['historicalPe5y', ['Historical P/E 5 years']], ['historicalPb3y', ['Historical P/B 3 years']], ['historicalPb5y', ['Historical P/B 5 years']], ['marketCap3y', ['Market capitalisation 3 years back']]
  ];
  galleryMetricAliases = new Map(financialMetricRows.flatMap(([metric, aliases]) => aliases.map(alias => [alias.toLowerCase(), metric])));
  const financialHistoryMetricKeys = new Set(financialMetricRows.map(([metric]) => metric));
  const fieldHelp = {
    'P/E':['Price to earnings', 'Latest price divided by trailing-twelve-month earnings per share. Enter a multiple, for example P/E < 25.'],
    'Market cap':['Market capitalisation', 'Total market value of the company. Use B for billions, for example Market cap > 10B.'],
    'Current price':['Current price', 'Latest available US market price in dollars.'],
    'Sales growth':['Sales growth', 'Trailing revenue growth, expressed as a percentage.'],
    'EPS':['Earnings per share', 'Trailing earnings per share reported by the company.'],
    'Dividend yield':['Dividend yield', 'Trailing dividend yield, expressed as a percentage.'],
    'Daily volume':['Daily volume', 'Latest reported trading volume. Use M for millions, for example Daily volume > 5M.'],
    'ROE':['Return on equity', 'Trailing return on shareholders’ equity, expressed as a percentage.'],
    'ROA':['Return on assets', 'Trailing return on assets, expressed as a percentage.'],
    'ROIC':['Return on invested capital', 'Trailing return on invested capital, expressed as a percentage.'],
    'P / B':['Price to book', 'Latest price divided by book value per share.'],
    'P / S':['Price to sales', 'Market value relative to trailing sales.'],
    'P / FCF':['Price to free cash flow', 'Market value relative to trailing free cash flow.'],
    'EV / EBITDA':['EV / EBITDA', 'Enterprise value relative to trailing EBITDA.'],
    'Gross margin':['Gross margin', 'Trailing gross profit as a percentage of revenue.'],
    'Operating margin':['Operating margin', 'Trailing operating income as a percentage of revenue.'],
    'Net profit margin':['Net profit margin', 'Trailing net income as a percentage of revenue.'],
    'Current ratio':['Current ratio', 'Current assets divided by current liabilities.'],
    'Quick ratio':['Quick ratio', 'Liquid current assets relative to current liabilities.'],
    'Interest coverage':['Interest coverage', 'Operating earnings available to cover interest expense.'],
    'Asset turnover':['Asset turnover', 'Trailing revenue relative to total assets.'],
    'Inventory turnover':['Inventory turnover', 'Cost of sales relative to average inventory.'],
    'Debt / equity':['Debt to equity', 'Total debt relative to shareholders’ equity.'],
    'Payout ratio':['Payout ratio', 'Portion of earnings paid as dividends, expressed as a percentage.'],
    'Operating cash flow / share':['Operating cash flow per share', 'Trailing operating cash flow divided by shares outstanding.'],
    'Free cash flow / share':['Free cash flow per share', 'Trailing free cash flow divided by shares outstanding.'],
    'Free cash flow yield':['Free cash flow yield', 'Trailing free cash flow relative to market value, expressed as a percentage.']
  };
  const coreQuerySuggestions = [
    ['P/E', 'Price to earnings'], ['Price to book', 'Price to book'], ['Price to sales', 'Price to sales'], ['EV / EBITDA', 'Enterprise value / EBITDA'], ['Price to free cash flow', 'Price to free cash flow'],
    ['Market cap', 'Use B for billions'], ['Current price', 'Latest market price'], ['Volume', 'Latest trading volume'], ['Dividend yield', 'Trailing dividend yield'],
    ['Return on equity', 'ROE %'], ['Return on assets', 'ROA %'], ['Return on invested capital', 'ROIC %'], ['Current ratio', 'Liquidity ratio'], ['Quick ratio', 'Liquidity ratio'], ['Debt to equity', 'Leverage ratio'],
    ['Sales growth', 'Trailing sales growth %'], ['Gross margin', 'Gross margin %'], ['Operating margin', 'Operating margin %'], ['Net profit margin', 'Net margin %'], ['EPS', 'Trailing EPS'],
  ];
  if (customRatioDefinitions.length) {
    galleryFields['most-used'].recent.push(...customRatioDefinitions.slice(0, 20).map(item => galleryField(item.name, 'Custom ratio')));
    coreQuerySuggestions.push(...customRatioDefinitions.slice(0, 20).map(item => [item.name, 'Saved custom ratio']));
  }
  const galleryQuerySuggestions = Object.values(galleryFields).flatMap(category => ['recent', 'preceding', 'historical'].flatMap(column => (category[column] || []).map(field => [field.token, field.label])));
  const querySuggestionCatalog = [...new Map([...coreQuerySuggestions, ...galleryQuerySuggestions]
    .filter(([token]) => Boolean(normaliseQueryMetric(token)))
    .map(([token, detail]) => [token.toLowerCase(), [token, detail]])).values()];
  const queryInput = $('#screen-query');
  const querySuggestionHolder = $('#screen-query-suggestions');
  let activeQuerySuggestion = -1;
  let activeQuerySuggestionItems = [];
  const hideQuerySuggestions = () => {
    if (!querySuggestionHolder || !queryInput) return;
    querySuggestionHolder.hidden = true;
    querySuggestionHolder.innerHTML = '';
    queryInput.setAttribute('aria-expanded', 'false');
    activeQuerySuggestion = -1;
    activeQuerySuggestionItems = [];
  };
  const queryClauseAtCursor = () => {
    if (!queryInput) return { start:0, end:0, text:'' };
    const cursor = Number.isFinite(queryInput.selectionStart) ? queryInput.selectionStart : queryInput.value.length;
    const before = queryInput.value.slice(0, cursor);
    const boundaries = [before.lastIndexOf('\n'), before.lastIndexOf(',')];
    const andMatch = [...before.matchAll(/\bAND\b/gi)].at(-1);
    if (andMatch) boundaries.push(andMatch.index + andMatch[0].length - 1);
    const boundary = Math.max(...boundaries);
    const rawStart = boundary + 1;
    const leading = before.slice(rawStart).match(/^\s*/)?.[0].length || 0;
    const start = rawStart + leading;
    return { start, end:cursor, text:before.slice(start) };
  };
  const applyQuerySuggestion = item => {
    if (!queryInput || !item) return;
    const clause = queryClauseAtCursor();
    const insert = item.type === 'operator' ? `${clause.text.trim() ? ' ' : ''}${item.token} ` : `${item.token} `;
    const start = item.type === 'operator' ? clause.end : clause.start;
    queryInput.value = `${queryInput.value.slice(0, start)}${insert}${queryInput.value.slice(clause.end)}`;
    const nextCursor = start + insert.length;
    queryInput.focus();
    queryInput.setSelectionRange(nextCursor, nextCursor);
    if (item.type === 'metric') showFieldHelp(item.token);
    hideQuerySuggestions();
    queryInput.dispatchEvent(new Event('input', { bubbles:true }));
  };
  const renderQuerySuggestions = () => {
    if (!queryInput || !querySuggestionHolder) return;
    const clause = queryClauseAtCursor();
    const trimmed = clause.text.trim();
    if (/(?:<=|>=|!=|=|<|>)/.test(trimmed)) { hideQuerySuggestions(); return; }
    const exactMetric = normaliseQueryMetric(trimmed);
    const items = exactMetric
      ? [['>', 'Greater than'], ['>=', 'At least'], ['<', 'Less than'], ['<=', 'At most'], ['=', 'Exactly']].map(([token, detail]) => ({ token, detail, type:'operator' }))
      : querySuggestionCatalog.filter(([token, detail]) => !trimmed || `${token} ${detail}`.toLowerCase().includes(trimmed.toLowerCase())).slice(0, 8).map(([token, detail]) => ({ token, detail, type:'metric' }));
    if (!items.length) { hideQuerySuggestions(); return; }
    activeQuerySuggestionItems = items;
    activeQuerySuggestion = Math.min(Math.max(activeQuerySuggestion, 0), items.length - 1);
    querySuggestionHolder.innerHTML = items.map((item, index) => `<button type="button" class="screen-query-suggestion${index === activeQuerySuggestion ? ' selected' : ''}" role="option" aria-selected="${index === activeQuerySuggestion}" data-query-suggestion="${escapeHtml(item.token)}"><b>${escapeHtml(item.token)}</b><small>${escapeHtml(item.detail)}</small></button>`).join('');
    querySuggestionHolder.hidden = false;
    queryInput.setAttribute('aria-expanded', 'true');
    querySuggestionHolder.querySelectorAll('[data-query-suggestion]').forEach((button, index) => button.onclick = () => applyQuerySuggestion(items[index]));
  };
  queryInput?.addEventListener('focus', renderQuerySuggestions);
  queryInput?.addEventListener('input', () => { activeQuerySuggestion = -1; renderQuerySuggestions(); });
  queryInput?.addEventListener('keydown', event => {
    if (!querySuggestionHolder || querySuggestionHolder.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); hideQuerySuggestions(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeQuerySuggestion = (activeQuerySuggestion + step + activeQuerySuggestionItems.length) % activeQuerySuggestionItems.length;
      renderQuerySuggestions();
      return;
    }
    if (event.key === 'Enter' && activeQuerySuggestionItems[activeQuerySuggestion]) {
      event.preventDefault();
      applyQuerySuggestion(activeQuerySuggestionItems[activeQuerySuggestion]);
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!querySuggestionHolder?.hidden && !event.target.closest('.screen-query-input-wrap')) hideQuerySuggestions();
  });
  const showFieldHelp = label => {
    const [title, description] = fieldHelp[label] || [label, 'Choose a comparison and a value to add this field to your screen.'];
    $('#screen-query-help-name').textContent = title;
    $('#screen-query-help-description').textContent = description;
    const action = $('#screen-query-help-action');
    action.textContent = 'Add to query';
    action.dataset.screenQuery = label;
  };
  let activeGalleryTab = 'most-used';
  const insertQueryText = text => {
    const input = $('#screen-query');
    if (!input) return;
    const existing = input.value.trimEnd();
    input.value = `${existing}${existing ? ' ' : ''}${text} `;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles:true }));
  };
  const renderRatioGallery = () => {
    const holder = $('#screen-ratio-list');
    if (!holder) return;
    const needle = ($('#screen-ratio-search')?.value || '').trim().toLowerCase();
    const category = galleryFields[activeGalleryTab] || { recent:[], preceding:[], historical:[] };
    const renderColumn = (title, fields) => {
      const visible = fields.filter(field => !needle || `${field.token} ${field.label}`.toLowerCase().includes(needle));
      if (!visible.length) return `<section class="ratio-gallery-column"><h3>${title}</h3><span class="ratio-gallery-empty">No matching metrics.</span></section>`;
      return `<section class="ratio-gallery-column"><h3>${title}</h3>${visible.map(field => (field.available === true || (field.available === 'financial' && financialHistoryLoaded))
        ? `<button type="button" data-query-token="${escapeHtml(field.token)}" data-query-label="${escapeHtml(field.label)}" title="Add ${escapeHtml(field.label)} to query">${escapeHtml(field.label)}</button>`
        : `<button type="button" class="ratio-gallery-pending" disabled title="${financialHistoryState === 'error' ? 'The financial-data provider is temporarily unavailable. Select the tab again to retry.' : 'Select this tab to load reported financial history for the visible companies.'}">${escapeHtml(field.label)}<small>${financialHistoryState === 'loading' ? 'Loading' : financialHistoryState === 'error' ? 'Retry' : 'Load data'}</small></button>`).join('')}</section>`;
    };
    holder.innerHTML = `${renderColumn('Recent', category.recent)}${renderColumn('Preceding', category.preceding)}${renderColumn('Historical', category.historical)}`;
    holder.querySelectorAll('[data-query-token]').forEach(button => button.onclick = () => { showFieldHelp(button.dataset.queryLabel || button.dataset.queryToken); insertQueryText(button.dataset.queryToken); });
  };
  document.querySelectorAll('[data-ratio-gallery-tab]').forEach(button => button.onclick = () => {
    activeGalleryTab = button.dataset.ratioGalleryTab || 'most-used';
    document.querySelectorAll('[data-ratio-gallery-tab]').forEach(item => item.classList.toggle('selected', item === button));
    renderRatioGallery();
    if (activeGalleryTab === 'price' && universe.length) enrichPriceHistory(universe.slice(0, 60));
    if (activeGalleryTab !== 'price' && universe.length) enrichFinancialHistory(universe.slice(0, 60));
  });
  document.querySelectorAll('[data-query-operator]').forEach(button => button.onclick = () => insertQueryText(button.dataset.queryOperator));
  $('#screen-ratio-search').oninput = renderRatioGallery;
  $('#screen-gallery-close').onclick = () => { $('#screen-ratio-gallery').hidden = true; $('#screen-gallery-open').focus(); };
  $('#screen-gallery-open').onclick = () => { $('#screen-ratio-gallery').hidden = false; renderRatioGallery(); enrichFinancialHistory(universe.slice(0, 60)); $('#screen-ratio-search').focus(); };
  renderRatioGallery();
  const enrichVisible = async list => {
    const tickers = list.slice(0, 60).map(stock => stock.symbol || stock.ticker).filter(ticker => ticker && !metricSymbols.has(ticker));
    if (!tickers.length) return;
    tickers.forEach(ticker => metricSymbols.add(ticker));
    const request = ++metricRequest;
    try {
      const metricRows = await getJson(`/data/screener-metrics?symbols=${encodeURIComponent(tickers.join(','))}`, 45000);
      if (request !== metricRequest || page !== 'screener' || !$('#screen-table') || !Array.isArray(metricRows)) return;
      const metricsBySymbol = new Map(metricRows.map(item => [String(item.symbol || '').toUpperCase(), item]));
      universe = universe.map(stock => ({ ...stock, ...(metricsBySymbol.get(String(stock.symbol || stock.ticker || '').toUpperCase()) || {}) }));
      draw(true);
    } catch {
      tickers.forEach(ticker => metricSymbols.delete(ticker));
    }
  };
  const enrichPriceHistory = async list => {
    const tickers = list.slice(0, 60).map(stock => stock.symbol || stock.ticker).filter(ticker => ticker && !priceMetricSymbols.has(ticker));
    if (!tickers.length) return;
    tickers.forEach(ticker => priceMetricSymbols.add(ticker));
    const request = ++priceMetricRequest;
    const note = $('#screen-data-note');
    if (note) note.textContent = 'Loading price history and technical indicators for the visible companies…';
    try {
      const metricRows = await getJson(`/data/screener-price-metrics?symbols=${encodeURIComponent(tickers.join(','))}`, 60000);
      if (request !== priceMetricRequest || page !== 'screener' || !$('#screen-table') || !Array.isArray(metricRows)) return;
      const metricsBySymbol = new Map(metricRows.map(item => [String(item.symbol || '').toUpperCase(), item]));
      universe = universe.map(stock => ({ ...stock, ...(metricsBySymbol.get(String(stock.symbol || stock.ticker || '').toUpperCase()) || {}) }));
      if (note) note.textContent = 'Price history and technical indicators are loaded from the connected market-data providers.';
      draw(true);
    } catch {
      tickers.forEach(ticker => priceMetricSymbols.delete(ticker));
      if (note) note.textContent = 'Price-history data is temporarily unavailable. Select Refresh to retry.';
    }
  };
  const enrichFinancialHistory = async list => {
    const tickers = list.slice(0, 60).map(stock => stock.symbol || stock.ticker).filter(ticker => ticker && !financialMetricSymbols.has(ticker));
    if (!tickers.length) return;
    tickers.forEach(ticker => financialMetricSymbols.add(ticker));
    const request = ++financialMetricRequest;
    financialHistoryState = 'loading';
    renderRatioGallery();
    const note = $('#screen-data-note');
    if (note) note.textContent = 'Loading reported annual and quarterly financial statements for the visible companies…';
    try {
      const metricRows = await getJson(`/data/screener-financial-metrics?symbols=${encodeURIComponent(tickers.join(','))}`, 60000);
      if (request !== financialMetricRequest || page !== 'screener' || !$('#screen-table') || !Array.isArray(metricRows)) return;
      const metricsBySymbol = new Map(metricRows.map(item => [String(item.symbol || '').toUpperCase(), item]));
      universe = universe.map(stock => ({ ...stock, ...(metricsBySymbol.get(String(stock.symbol || stock.ticker || '').toUpperCase()) || {}) }));
      financialHistoryLoaded = metricRows.some(item => item.financialsLoaded);
      financialHistoryState = financialHistoryLoaded ? 'ready' : 'error';
      renderRatioGallery();
      if (note) note.textContent = 'Reported annual and quarterly financial metrics are loaded from the connected financial-statement provider.';
      draw(true);
    } catch {
      tickers.forEach(ticker => financialMetricSymbols.delete(ticker));
      financialHistoryState = 'error';
      renderRatioGallery();
      if (note) note.textContent = 'Financial-statement data is temporarily unavailable. Select Refresh to retry.';
    }
  };
  const draw = (skipEnrichment = false) => {
    if (page !== 'screener' || !$('#screen-table')) return;
    const search = value('screen-search').trim().toUpperCase();
    const parsedQuery = parseScreenQuery(value('screen-query'));
    updateQueryStatus(parsedQuery);
    const sector = value('screen-sector');
    const exchange = value('screen-exchange');
    const capBand = value('screen-cap');
    const priceBand = value('screen-price');
    const maxPe = Number(value('screen-pe'));
    const minRoe = Number(value('screen-roe'));
    const minEps = Number(value('screen-eps'));
    const minGrowth = Number(value('screen-growth'));
    const minVolume = Number(value('screen-volume'));
    const formulaMetric = value('screen-formula-metric');
    const formulaOp = value('screen-formula-op');
    const formulaValue = Number(value('screen-formula-value'));
    const formulaPass = stock => {
      if (formulaMetric === 'none' || !Number.isFinite(formulaValue)) return true;
      const cap = Number(scanNumber(stock.marketCap, stock.cap ? stock.cap * 1e9 : null) || 0);
      const raw = formulaMetric === 'pe' ? scanNumber(stock.pe, stock.peRatioTTM) : formulaMetric === 'roe' ? scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe)) : formulaMetric === 'eps' ? scanNumber(stock.epsTTM, stock.netIncomePerShareTTM) : formulaMetric === 'growth' ? Number(scanNumber(stock.revenueGrowthTTM) || 0) * 100 : formulaMetric === 'debt' ? scanNumber(stock.debtToEquityRatioTTM, stock.debtToEquity) : formulaMetric === 'dividend' ? Number(scanNumber(stock.dividendYieldTTM) || 0) * 100 : formulaMetric === 'cap' ? cap / 1e9 : Number(scanNumber(stock.volume, stock.avgVolume) || 0);
      if (!Number.isFinite(Number(raw))) return false;
      const n = Number(raw);
      return formulaOp === 'lte' ? n <= formulaValue : formulaOp === 'gt' ? n > formulaValue : formulaOp === 'lt' ? n < formulaValue : n >= formulaValue;
    };
    const dividend = value('screen-dividend');
    const sort = value('screen-sort');
    results = universe.filter(stock => {
      const ticker = String(stock.symbol || stock.ticker || '').toUpperCase();
      const name = String(stock.companyName || stock.name || '').toUpperCase();
      const stockSector = stock.sector || 'Not classified';
      const stockExchange = String(stock.exchangeShortName || stock.exchange || '').toUpperCase();
      const cap = Number(scanNumber(stock.marketCap, stock.cap ? stock.cap * 1e9 : null) || 0);
      const price = Number(scanNumber(stock.price) || 0);
      const pe = scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM);
      const roe = scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe));
      const volume = Number(scanNumber(stock.volume, stock.avgVolume) || 0);
      const eps = scanNumber(stock.epsTTM, stock.netIncomePerShareTTM);
      const growth = scanNumber(stock.revenueGrowthTTM);
      const yieldValue = scanNumber(stock.dividendYieldTTM);
      const paysDividend = (yieldValue !== null && Number(yieldValue) > 0) || Number(stock.lastAnnualDividend || 0) > 0;
      return (!search || ticker.includes(search) || name.includes(search)) &&
        (sector === 'all' || stockSector === sector) &&
        (exchange === 'all' || stockExchange.includes(exchange)) &&
        inCapBand(cap, capBand) && inPriceBand(price, priceBand) &&
        (maxPe === 999 || (pe !== null && Number(pe) > 0 && Number(pe) <= maxPe)) &&
        (minRoe === 0 || (roe !== null && roe >= minRoe)) &&
        (minEps <= -999998 || (eps !== null && eps >= minEps)) &&
        (minGrowth <= -999998 || (growth !== null && growth >= minGrowth)) && volume >= minVolume &&
        (dividend === 'all' || paysDividend) && formulaPass(stock) && queryPass(stock, parsedQuery.rules);
    });
    const sorter = {
      cap: (a, b) => Number(b.marketCap || 0) - Number(a.marketCap || 0),
      volume: (a, b) => Number(b.volume || 0) - Number(a.volume || 0),
      roe: (a, b) => Number(scanPercent(scanNumber(b.returnOnEquityTTM, b.roeTTM, b.roe)) ?? -Infinity) - Number(scanPercent(scanNumber(a.returnOnEquityTTM, a.roeTTM, a.roe)) ?? -Infinity),
      pe: (a, b) => Number(scanNumber(a.pe, a.peRatioTTM) ?? Infinity) - Number(scanNumber(b.pe, b.peRatioTTM) ?? Infinity),
      price: (a, b) => Number(b.price || 0) - Number(a.price || 0),
      name: (a, b) => String(a.companyName || a.name || '').localeCompare(String(b.companyName || b.name || ''))
    };
    results.sort(sorter[sort] || sorter.cap);
    const pageSize = 50;
    const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
    resultPage = Math.min(Math.max(1, resultPage), pageCount);
    const pageRows = results.slice((resultPage - 1) * pageSize, resultPage * pageSize);
    renderTableHead();
    const resultSummary = `${results.length.toLocaleString()} result${results.length === 1 ? '' : 's'} found · page ${resultPage} of ${pageCount}`;
    $('#screen-count').textContent = resultSummary;
    const topResultCount = $('#screen-result-count');
    if (topResultCount) topResultCount.textContent = resultSummary;
    $('#screen-table').innerHTML = pageRows.map(stock => screenerRow(stock, selectedColumns)).join('') || `<tr><td colspan="${8 + selectedColumns.length}">No active US stocks match these filters. Try clearing one or two filters.</td></tr>`;
    const pagination = $('#screen-pagination');
    if (pagination) {
      const pages = Array.from(new Set([1, resultPage - 1, resultPage, resultPage + 1, pageCount].filter(item => item >= 1 && item <= pageCount)));
      pagination.innerHTML = results.length > pageSize ? `<button type="button" data-screen-page="${resultPage - 1}" ${resultPage === 1 ? 'disabled' : ''}>Previous</button>${pages.map(item => `<button type="button" class="${item === resultPage ? 'selected' : ''}" data-screen-page="${item}">${item}</button>`).join('')}<button type="button" data-screen-page="${resultPage + 1}" ${resultPage === pageCount ? 'disabled' : ''}>Next</button><span>50 results per page</span>` : `<span>${results.length.toLocaleString()} result${results.length === 1 ? '' : 's'} shown</span>`;
      pagination.querySelectorAll('[data-screen-page]').forEach(button => button.onclick = () => { resultPage = Number(button.dataset.screenPage) || 1; draw(); });
    }
    wireCommon();
    if (!skipEnrichment && parsedQuery.rules.some(rule => priceHistoryQueryMetrics.has(rule.metric))) enrichPriceHistory(universe.slice(0, 60));
    if (!skipEnrichment && parsedQuery.rules.some(rule => financialHistoryMetricKeys.has(rule.metric))) enrichFinancialHistory(universe.slice(0, 60));
    if (!skipEnrichment) enrichVisible(pageRows);
  };
  const load = async force => {
    const freshness = $('#screen-freshness');
    if (freshness) freshness.textContent = force ? 'Refreshing live data…' : 'Loading live data…';
    $('#screen-count').textContent = force ? 'Refreshing the US stock directory…' : 'Loading active US stocks…';
    try {
      const data = await getJson(`/data/screener${force ? `?refresh=${Date.now()}` : ''}`, 25000);
      if (page !== 'screener' || !$('#screen-table')) return;
      universe = Array.isArray(data) ? data : stocks;
      // Draw the directory immediately. Ratios arrive progressively below,
      // so visitors can browse companies instead of waiting on a second API.
      draw(true);
      const loadingNote = $('#screen-data-note');
      if (loadingNote) loadingNote.textContent = 'Active US listings loaded. Adding live valuation and quality ratios…';
      const symbols = [...universe].sort((a, b) => Number(b.marketCap || 0) - Number(a.marketCap || 0)).slice(0, 60).map(stock => stock.symbol || stock.ticker).filter(Boolean);
      symbols.forEach(ticker => metricSymbols.add(ticker));
      const metricRows = await getJson(`/data/screener-metrics?symbols=${encodeURIComponent(symbols.join(','))}`, 45000).catch(() => []);
      if (page !== 'screener' || !$('#screen-table')) return;
      const metricsBySymbol = new Map(metricRows.map(item => [String(item.symbol || '').toUpperCase(), item]));
      universe = universe.map(stock => ({ ...stock, ...(metricsBySymbol.get(String(stock.symbol || stock.ticker || '').toUpperCase()) || {}) }));
      const ratioCount = universe.filter(stock => scanNumber(stock.pe, stock.peRatioTTM, stock.returnOnEquityTTM) !== null).length;
      const dataNote = $('#screen-data-note');
      if (dataNote) dataNote.textContent = `Funds and ETFs are excluded. TTM valuation or quality data is loaded for ${ratioCount.toLocaleString()} companies in this scan; open any company for its complete ratios.`;
      if (activeGalleryTab === 'price') enrichPriceHistory(universe.slice(0, 60));
      const currentFreshness = $('#screen-freshness');
      if (currentFreshness) currentFreshness.textContent = `Live directory updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    } catch {
      if (page !== 'screener' || !$('#screen-table')) return;
      universe = stocks;
      const dataNote = $('#screen-data-note');
      if (dataNote) dataNote.textContent = 'The live directory is temporarily unavailable. Showing a small local company list.';
      const currentFreshness = $('#screen-freshness');
      if (currentFreshness) currentFreshness.textContent = 'Live directory unavailable';
    }
    draw();
  };
  const presets = {
    mega: { cap:'mega', sort:'cap' },
    value: { cap:'large', pe:'20', sort:'pe' },
    quality: { cap:'large', roe:'20', sort:'roe' },
    liquid: { cap:'large', volume:'10000000', sort:'volume' },
    dividend: { dividend:'payer', sort:'cap' },
    reset: { sector:'all', exchange:'all', cap:'all', price:'all', pe:'999', roe:'0', eps:'-999999', growth:'-999999', volume:'0', dividend:'all', sort:'cap', query:'', 'formula-metric':'none', 'formula-op':'gte', 'formula-value':'' }
  };
  const screenFilterNames = ['sector', 'exchange', 'cap', 'price', 'pe', 'roe', 'eps', 'growth', 'volume', 'dividend', 'sort', 'query', 'formula-metric', 'formula-op', 'formula-value'];
  const currentScreenFilters = () => Object.fromEntries(screenFilterNames.map(name => [name, $(`#screen-${name}`)?.value || presets.reset[name]]));
  const saveScreens = () => {
    try { localStorage.setItem('dd-saved-screens', JSON.stringify(savedScreens)); } catch {}
    queueResearchStateSync();
  };
  const drawSavedScreens = () => {
    const holder = $('#saved-screen-list');
    if (!holder) return;
    holder.innerHTML = savedScreens.length
      ? savedScreens.map(item => `<div class="saved-screen-chip"><button type="button" data-load-screen="${escapeHtml(item.id)}"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.summary || 'Custom screen')}</small><em>${item.alertEnabled ? `${Number(item.changedCount || 0)} changes · alerts on` : 'change alerts off'}</em></button><button type="button" data-toggle-screen-alert="${escapeHtml(item.id)}" aria-label="Toggle result alerts">${item.alertEnabled ? '◉' : '○'}</button><button type="button" data-delete-screen="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.name)}">×</button></div>`).join('')
      : '<p>No saved screens yet. Set filters, give the screen a name, and save it here.</p>';
    holder.querySelectorAll('[data-load-screen]').forEach(button => button.onclick = () => {
      const item = savedScreens.find(screen => screen.id === button.dataset.loadScreen);
      if (!item) return;
      Object.entries(item.filters || {}).forEach(([name, selected]) => { const input = $(`#screen-${name}`); if (input) input.value = selected; });
      $('#screen-search').value = item.search || '';
      if (Array.isArray(item.columns)) {
        selectedColumns = item.columns.filter(key => columnOptions.some(([id]) => id === key)).slice(0, 5);
        saveColumns();
        renderColumns();
      }
      draw();
      if (item.alertEnabled) {
        const symbols = results.slice(0, 60).map(stock => String(stock.symbol || stock.ticker || '').toUpperCase()).filter(Boolean);
        const previous = Array.isArray(item.lastResultSymbols) ? item.lastResultSymbols : [];
        item.changedCount = previous.length ? symbols.filter(symbol => !previous.includes(symbol)).length + previous.filter(symbol => !symbols.includes(symbol)).length : 0;
        item.lastResultSymbols = symbols; item.lastCheckedAt = new Date().toISOString();
        if (item.changedCount) recordResearchActivity('screen', `${item.name} changed`, `${item.changedCount} companies entered or left`, '');
        saveScreens(); drawSavedScreens();
      }
    });
    holder.querySelectorAll('[data-toggle-screen-alert]').forEach(button => button.onclick = () => { const item = savedScreens.find(screen => screen.id === button.dataset.toggleScreenAlert); if (!item) return; item.alertEnabled = !item.alertEnabled; saveScreens(); drawSavedScreens(); });
    holder.querySelectorAll('[data-delete-screen]').forEach(button => button.onclick = () => {
      savedScreens = savedScreens.filter(screen => screen.id !== button.dataset.deleteScreen);
      saveScreens();
      drawSavedScreens();
    });
  };
  $('#save-current-screen').onclick = () => {
    const input = $('#saved-screen-name');
    const name = input.value.trim();
    if (!name) { input.focus(); input.setCustomValidity('Give this screen a name.'); input.reportValidity(); return; }
    input.setCustomValidity('');
    const filters = currentScreenFilters();
    const active = Object.entries(filters).filter(([key, selected]) => selected !== presets.reset[key]).map(([key, selected]) => `${key}: ${selected}`);
    savedScreens.unshift({ id:`screen-${Date.now()}`, name, filters, search:$('#screen-search').value.trim(), columns:[...selectedColumns], customRatios:customRatioDefinitions.map(item => ({ name:item.name, left:item.left, op:item.op, right:item.right })), summary:active.slice(0, 3).join(' · ') || 'All active US listings', alertEnabled:$('#saved-screen-alert').checked, lastResultSymbols:results.slice(0, 60).map(stock => String(stock.symbol || stock.ticker || '').toUpperCase()).filter(Boolean), lastCheckedAt:new Date().toISOString(), savedAt:new Date().toISOString() });
    savedScreens = savedScreens.slice(0, 20);
    input.value = '';
    saveScreens();
    recordResearchActivity('screen', `Saved screen: ${name}`, active.slice(0, 3).join(' · ') || 'All active US listings');
    drawSavedScreens();
  };
  drawSavedScreens();
  $('#screen-save-focus').onclick = () => {
    const controls = $('.screen-more-filters');
    if (controls) controls.open = true;
    $('#saved-screen-name')?.focus();
  };
  $('#screen-columns-focus').onclick = () => {
    const controls = $('.screen-more-filters');
    if (controls) controls.open = true;
    $('#screen-column-controls')?.scrollIntoView({ behavior:'smooth', block:'center' });
  };
  document.querySelectorAll('[data-screen-preset]').forEach(button => button.onclick = () => {
    const preset = presets[button.dataset.screenPreset];
    Object.entries(presets.reset).forEach(([name, selected]) => { const input = $(`#screen-${name}`); if (input) input.value = selected; });
    Object.entries(preset).forEach(([name, selected]) => { const input = $(`#screen-${name}`); if (input) input.value = selected; });
    $('#screen-search').value = '';
    document.querySelectorAll('[data-screen-preset]').forEach(item => item.classList.toggle('selected', item === button && button.dataset.screenPreset !== 'reset'));
    resultPage = 1;
    draw();
  });
  ['screen-search', 'screen-query', 'screen-sector', 'screen-exchange', 'screen-cap', 'screen-price', 'screen-pe', 'screen-roe', 'screen-eps', 'screen-growth', 'screen-volume', 'screen-dividend', 'screen-sort', 'screen-formula-metric', 'screen-formula-op', 'screen-formula-value'].forEach(id => $(`#${id}`).oninput = () => { resultPage = 1; draw(); });
  $('#screen-query-clear').onclick = () => { $('#screen-query').value = ''; resultPage = 1; draw(); };
  $('#screen-run-query').onclick = () => { resultPage = 1; draw(); $('.screen-results-heading')?.scrollIntoView({ behavior:'smooth', block:'start' }); };
  document.querySelectorAll('[data-screen-query]').forEach(button => button.onclick = () => { $('#screen-query').value = button.dataset.screenQuery || ''; resultPage = 1; draw(); });
  $('#screen-formula-clear').onclick = () => { $('#screen-formula-metric').value = 'none'; $('#screen-formula-value').value = ''; draw(); };
  $('#screen-run').onclick = () => load(true);
  $('#export-screen').onclick = () => {
    const selectedLabels = new Map(columnOptions);
    const csv = [['Symbol','Company','Price','Market Cap','P/E','ROE','Volume', ...selectedColumns.map(key => selectedLabels.get(key)), 'Sector'].join(','), ...results.map(stock => {
      const fields = [stock.symbol || stock.ticker, stock.companyName || stock.name || '', stock.price || '', stock.marketCap || '', scanNumber(stock.pe, stock.peRatioTTM) ?? '', scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe)) ?? '', stock.volume || '', ...selectedColumns.map(key => exportColumnValue(stock, key)), stock.sector || ''];
      return fields.map(item => `"${String(item).replace(/"/g, '""')}"`).join(',');
    })].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
    link.download = 'dollardisha-screen.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  load(false);
}
function drawResearchLists() {
  const alertsHolder = $('#alerts-list');
  if (alertsHolder) alertsHolder.innerHTML = alerts.map((alert, index) => {
    const earnings = alert.type === 'earnings';
    const triggered = alert.triggered === true;
    const detail = earnings ? `${alert.date || 'Date TBA'} · earnings event` : `price ${alert.direction || 'above'} $${Number(alert.price || 0).toFixed(2)}`;
    return `<div class="alert-item ${triggered ? 'triggered' : ''}"><span><b>${escapeHtml(alert.ticker)}</b> · ${escapeHtml(detail)}<small>${alert.currentPrice ? `Live $${Number(alert.currentPrice).toFixed(2)} · ` : ''}${triggered ? 'Condition reached' : 'Monitoring'}</small></span><button data-delete-alert="${index}">Remove</button></div>`;
  }).join('') || '<div class="empty-small">No research alerts saved yet.</div>';
  const notesHolder = $('#notes-list');
  if (notesHolder) notesHolder.innerHTML = notes.slice().reverse().map((note, index) => `<article class="note-item thesis-card"><div><span><b>${escapeHtml(note.ticker)}</b><em>${escapeHtml(note.status || 'Researching')}</em></span><small>${escapeHtml(note.date || '')}${note.reviewDate ? ` · review ${escapeHtml(note.reviewDate)}` : ''}</small></div><p><strong>THESIS</strong>${escapeHtml(note.text)}</p>${note.risk ? `<p><strong>RISK</strong>${escapeHtml(note.risk)}</p>` : ''}${note.catalyst ? `<p><strong>CATALYST</strong>${escapeHtml(note.catalyst)}</p>` : ''}<footer><span>Conviction ${escapeHtml(note.conviction || '3')}/5</span><button data-delete-note="${notes.length - 1 - index}">Delete</button></footer></article>`).join('') || '<div class="empty-small">No thesis cards yet.</div>';
  document.querySelectorAll('[data-delete-alert]').forEach(button => button.onclick = () => { const removed = alerts.splice(Number(button.dataset.deleteAlert), 1)[0]; localStorage.setItem('dd-price-alerts', JSON.stringify(alerts)); recordResearchActivity('alert', 'Removed research alert', removed?.ticker || '', removed?.ticker); queueResearchStateSync(); drawResearchLists(); });
  document.querySelectorAll('[data-delete-note]').forEach(button => button.onclick = () => { const removed = notes.splice(Number(button.dataset.deleteNote), 1)[0]; localStorage.setItem('dd-research-notes', JSON.stringify(notes)); recordResearchActivity('thesis', 'Removed thesis card', removed?.ticker || '', removed?.ticker); queueResearchStateSync(); drawResearchLists(); });
}
async function evaluateResearchAlerts() {
  const priceAlerts = alerts.filter(item => item.type !== 'earnings' && item.ticker);
  const symbols = [...new Set(priceAlerts.map(item => item.ticker))];
  if (!symbols.length) return;
  try {
    const quotes = await getJson(`/data/watchlist?symbols=${encodeURIComponent(symbols.join(','))}`, 30000);
    const bySymbol = new Map((quotes || []).map(item => [String(item.symbol || '').toUpperCase(), item]));
    let changed = false;
    priceAlerts.forEach(alert => {
      const price = Number(bySymbol.get(alert.ticker)?.price);
      if (!Number.isFinite(price)) return;
      const reached = alert.direction === 'below' ? price <= Number(alert.price) : price >= Number(alert.price);
      if (alert.currentPrice !== price || alert.triggered !== reached) changed = true;
      alert.currentPrice = price; alert.triggered = reached; alert.checkedAt = new Date().toISOString();
    });
    if (changed) { localStorage.setItem('dd-price-alerts', JSON.stringify(alerts)); queueResearchStateSync(); drawResearchLists(); }
  } catch {}
}
async function hydrateWorkspaceFilings() {
  const holder = $('#workspace-filings');
  if (!holder) return;
  const symbols = watchlist.slice(0, 6);
  if (!symbols.length) { holder.innerHTML = '<p class="sub">Follow companies to build an automatic official-filings feed.</p>'; return; }
  try {
    const results = await Promise.allSettled(symbols.map(ticker => getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`, 30000)));
    const filings = results.flatMap((result, index) => result.status === 'fulfilled' ? (result.value.filings || []).slice(0, 2).map(item => ({ ...item, ticker:symbols[index] })) : []).sort((a, b) => String(b.filedAt || '').localeCompare(String(a.filedAt || ''))).slice(0, 10);
    holder.innerHTML = filings.map(item => `<a href="${escapeHtml(item.url || '#')}" target="_blank" rel="noreferrer"><span class="activity-icon">SEC</span><span><b>${escapeHtml(item.ticker)} · ${escapeHtml(item.form)}</b><small>${escapeHtml(item.category || item.description || 'Company filing')} · ${escapeHtml(item.filedAt || '')}</small></span><em>Open ↗</em></a>`).join('') || '<p class="sub">No recent issuer filings were returned.</p>';
  } catch { holder.innerHTML = '<p class="sub">The official-filings feed is temporarily unavailable.</p>'; }
}
function drawResearchActivity() {
  const holder = $('#research-activity'); if (!holder) return;
  holder.innerHTML = researchActivity.slice(0, 12).map(item => `<div><span class="activity-icon">${escapeHtml(String(item.type || 'R').slice(0, 2).toUpperCase())}</span><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail || item.ticker || '')} · ${new Date(item.at).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}</small></span></div>`).join('') || '<p class="sub">Saved alerts, thesis changes and portfolio actions will appear here.</p>';
}
function setupResearch() {
  const findFilings = async () => { const ticker = $('#filing-ticker').value.trim().toUpperCase(); if (!/^[A-Z.]{1,10}$/.test(ticker)) return; $('#filing-results').innerHTML = '<p class="sub">Loading official SEC filings…</p>'; try { const data = await getJson(`/data/filings?symbol=${ticker}`); $('#filing-results').innerHTML = `<div class="filing-company"><b>${escapeHtml(data.companyName)}</b><small>${data.symbol} · CIK ${data.cik}</small></div>` + (data.filings || []).slice(0, 12).map(filing => `<a class="filing-row" href="${filing.url || '#'}" target="_blank" rel="noreferrer"><span class="filing-form">${escapeHtml(filing.form || 'Filing')}</span><span>${escapeHtml(filing.description || filing.reportDate || 'SEC filing')}<small>Filed ${escapeHtml(filing.filedAt || '—')}</small></span><b>Open ↗</b></a>`).join(''); recordResearchActivity('filing', `Reviewed ${ticker} filings`, `${(data.filings || []).length} official documents`, ticker); drawResearchActivity(); } catch { $('#filing-results').innerHTML = '<p class="sub">Filings are temporarily unavailable. Try again shortly.</p>'; } };
  $('#filing-find').onclick = findFilings;
  $('#alert-add').onclick = () => { const ticker = $('#alert-ticker').value.trim().toUpperCase(); const price = Number($('#alert-price').value); if (/^[A-Z.]{1,10}$/.test(ticker) && price > 0) { alerts.push({ id:`alert-${Date.now()}`, type:'price', ticker, price, direction:$('#alert-direction').value, createdAt:new Date().toISOString() }); localStorage.setItem('dd-price-alerts', JSON.stringify(alerts)); recordResearchActivity('alert', `Added ${ticker} price alert`, `${$('#alert-direction').value} $${price.toFixed(2)}`, ticker); queueResearchStateSync(); drawResearchLists(); evaluateResearchAlerts(); } };
  $('#note-save').onclick = () => { const ticker = $('#note-ticker').value.trim().toUpperCase(); const text = $('#note-text').value.trim(); if (/^[A-Z.]{1,10}$/.test(ticker) && text) { const item = { id:`thesis-${Date.now()}`, ticker, text, risk:$('#note-risk').value.trim(), catalyst:$('#note-catalyst').value.trim(), status:$('#note-status').value, conviction:$('#note-conviction').value, reviewDate:$('#note-review').value, date:new Date().toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }), createdAt:new Date().toISOString() }; notes.push(item); localStorage.setItem('dd-research-notes', JSON.stringify(notes)); recordResearchActivity('thesis', `Saved ${ticker} thesis`, item.status, ticker); queueResearchStateSync(); ['note-text','note-risk','note-catalyst'].forEach(id => $(`#${id}`).value = ''); drawResearchLists(); drawResearchActivity(); } };
  drawResearchLists(); drawResearchActivity(); evaluateResearchAlerts(); hydrateWorkspaceFilings();
}
function setupCompare() {
  const readTicker = input => String(input.dataset.symbol || input.value).trim().toUpperCase();
  const wirePicker = (inputId, resultsId) => {
    const input = $(`#${inputId}`);
    const results = $(`#${resultsId}`);
    let timer;
    let requestNumber = 0;
    const close = () => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const select = button => {
      input.value = button.dataset.compareSymbol;
      input.dataset.symbol = button.dataset.compareSymbol;
      input.title = button.dataset.compareName;
      close();
    };
    input.setAttribute('aria-expanded', 'false');
    input.oninput = () => {
      input.dataset.symbol = '';
      clearTimeout(timer);
      const currentRequest = ++requestNumber;
      const query = input.value.trim();
      if (!query) { close(); return; }
      timer = setTimeout(async () => {
        results.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        results.innerHTML = '<button type="button" disabled>Searching all US stocks…</button>';
        try {
          const found = await getJson(`/data/search?q=${encodeURIComponent(query)}`);
          if (currentRequest !== requestNumber) return;
          results.innerHTML = found.map(stock => {
            const ticker = stock.symbol || stock.ticker;
            const name = stock.name || stock.companyName || ticker;
            const exchange = stock.exchangeShortName || stock.exchange || 'US';
            return `<button type="button" data-compare-symbol="${escapeHtml(ticker)}" data-compare-name="${escapeHtml(name)}">${companyLogo(ticker, name, 'small')}<span><b>${escapeHtml(name)}</b><small>${escapeHtml(ticker)}</small></span><em>${escapeHtml(exchange)}</em></button>`;
          }).join('') || '<button type="button" disabled>No matching US stock</button>';
          results.querySelectorAll('[data-compare-symbol]').forEach(button => button.onclick = () => select(button));
        } catch { results.innerHTML = '<button type="button" disabled>Directory temporarily unavailable</button>'; }
      }, 220);
    };
    input.onfocus = () => { if (results.children.length && input.value.trim()) { results.hidden = false; input.setAttribute('aria-expanded', 'true'); } };
    input.onkeydown = event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Enter' && !results.hidden) {
        const first = results.querySelector('[data-compare-symbol]');
        if (first) { event.preventDefault(); select(first); }
      }
    };
    input.onblur = () => setTimeout(close, 160);
  };

  const run = async () => {
    const inputs = [$('#compare-a'), $('#compare-b')];
    const tickers = inputs.map(readTicker);
    if (tickers.some(ticker => !/^[A-Z.]{1,10}$/.test(ticker))) {
      $('#comparison').innerHTML = '<p class="sub">Choose two companies from the US stock directory above.</p>';
      return;
    }
    inputs.forEach((input, index) => { input.value = tickers[index]; input.dataset.symbol = tickers[index]; });
    $('#comparison').innerHTML = '<p class="sub">Loading comparison…</p>';
    try {
      const data = await Promise.all(tickers.map(ticker => getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`)));
      const fields = [['Price', d => d.quote?.price ? `$${Number(d.quote.price).toFixed(2)}` : '—'], ['Market cap', d => money(d.profile?.mktCap || d.quote?.marketCap)], ['P/E ratio', d => d.ratios?.peRatioTTM ? `${Number(d.ratios.peRatioTTM).toFixed(1)}x` : '—'], ['Price to book', d => d.ratios?.priceToBookRatioTTM ? `${Number(d.ratios.priceToBookRatioTTM).toFixed(1)}x` : '—'], ['Return on equity', d => Number.isFinite(Number(d.ratios?.returnOnEquityTTM)) ? `${(Number(d.ratios.returnOnEquityTTM) * 100).toFixed(1)}%` : '—'], ['Dividend yield', d => Number.isFinite(Number(d.ratios?.dividendYieldTTM)) ? `${(Number(d.ratios.dividendYieldTTM) * 100).toFixed(2)}%` : '—'], ['Sector', d => d.profile?.sector || '—']];
      $('#comparison').innerHTML = `<section class="compare-performance"><div class="panel-head"><div><h2>Relative performance</h2><p>Both stocks rebased to 0% across the latest year</p></div><span>Live market history</span></div><div id="comparison-chart" class="comparison-chart">Loading performance chart…</div></section><div class="comparison-grid"><div></div>${data.map(d => { const ticker = d.quote?.symbol || d.profile?.symbol || ''; const name = d.profile?.companyName || ticker; return `<div class="compare-company">${companyLogo(ticker, name)}<span><b>${escapeHtml(name)}</b><small>${escapeHtml(ticker)}</small></span></div>`; }).join('')}${fields.map(([name, fn]) => `<div class="compare-label">${name}</div>${data.map(d => `<div class="compare-value">${fn(d)}</div>`).join('')}`).join('')}</div>`;
      drawComparisonChart(tickers);
    } catch { $('#comparison').innerHTML = '<p class="sub">Live comparison is unavailable. Please try again shortly.</p>'; }
  };
  wirePicker('compare-a', 'compare-a-results');
  wirePicker('compare-b', 'compare-b-results');
  $('#compare-run').onclick = run;
  run();
}
async function drawComparisonChart(tickers) {
  const holder = $('#comparison-chart'); if (!holder) return;
  try {
    const charts = await Promise.all(tickers.map(ticker => getJson(`/data/chart?symbol=${encodeURIComponent(ticker)}&points=260`, 45000)));
    if (!$('#comparison-chart')) return;
    const series = charts.map((chart, seriesIndex) => {
      const values = (chart.values || []).map(item => Number(item.close ?? item.price ?? item.value)).filter(Number.isFinite);
      const base = values[0];
      return { ticker:tickers[seriesIndex], values:values.map(value => ((value / base) - 1) * 100) };
    }).filter(item => item.values.length > 2);
    if (!series.length) throw new Error('No chart values');
    const width = 1000, height = 280, pad = 42;
    const all = series.flatMap(item => item.values); const min = Math.min(...all, 0), max = Math.max(...all, 0); const range = Math.max(1, max - min);
    const pathFor = values => values.map((value, index) => `${index ? 'L' : 'M'}${(pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2)).toFixed(1)},${(height - pad - ((value - min) / range) * (height - pad * 2)).toFixed(1)}`).join(' ');
    const zeroY = height - pad - ((0 - min) / range) * (height - pad * 2);
    holder.innerHTML = `<div class="compare-chart-legend">${series.map((item, index) => `<span class="series-${index}"><i></i>${escapeHtml(item.ticker)} <b>${item.values.at(-1) >= 0 ? '+' : ''}${item.values.at(-1).toFixed(1)}%</b></span>`).join('')}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Relative stock performance"><line x1="${pad}" x2="${width-pad}" y1="${zeroY}" y2="${zeroY}" class="zero-line"/>${series.map((item,index) => `<path d="${pathFor(item.values)}" class="series-line series-${index}"/>`).join('')}<text x="${pad}" y="${height-12}">1 year ago</text><text x="${width-pad}" y="${height-12}" text-anchor="end">Latest</text></svg>`;
  } catch { holder.textContent = 'Relative performance is temporarily unavailable.'; }
}
function ratioCard(label, value) { return `<div><span>${label}</span><b>${value}</b></div>`; }
async function hydrateCompany(ticker) { try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const profile = data.profile || {}; const quote = data.quote || {}; const ratios = data.ratios || {}; const metrics = data.metrics || {}; const set = (id, value) => { const element = $(`#${id}`); if (element) element.textContent = value; }; const valid = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); const ratio = (value, digits = 2) => valid(value) ? Number(value).toFixed(digits) : '—'; const pct = (value, digits = 1) => valid(value) ? `${(Number(value) * 100).toFixed(digits)}%` : '—'; set('company-title', profile.companyName || ticker); set('company-subtitle', `${ticker} · ${profile.exchangeShortName || profile.exchange || 'US Equity'}`); set('company-description', profile.description || 'Company profile is unavailable from the current provider.'); set('company-cap', usd(profile.mktCap || quote.marketCap)); set('company-price', quote.price ? `$${Number(quote.price).toFixed(2)}` : '—'); const change = quote.changesPercentage; const changeElement = $('#company-change'); if (changeElement) { changeElement.textContent = Number.isFinite(Number(change)) ? `${percent(change)} today` : 'Latest available quote'; changeElement.className = Number(change) >= 0 ? 'positive' : 'down'; } set('company-range', quote.dayHigh && quote.dayLow ? `$${Number(quote.dayLow).toFixed(2)} / $${Number(quote.dayHigh).toFixed(2)}` : '—'); set('company-pe', valid(ratios.peRatioTTM) ? `${ratio(ratios.peRatioTTM, 1)}x` : '—'); set('company-book', valid(metrics.bookValuePerShareTTM) ? `$${ratio(metrics.bookValuePerShareTTM, 2)}` : '—'); set('company-dividend', pct(ratios.dividendYieldTTM, 2)); set('company-roe', pct(ratios.returnOnEquityTTM)); set('company-current', ratio(ratios.currentRatioTTM)); set('company-debt', ratio(ratios.debtToEquityRatioTTM)); set('company-pb', valid(ratios.priceToBookRatioTTM) ? `${ratio(ratios.priceToBookRatioTTM, 1)}x` : '—'); set('company-volume', whole(quote.volume)); set('company-sector', profile.sector || '—'); const site = $('#company-site'); if (site) site.innerHTML = profile.website ? `<a href="${escapeHtml(profile.website)}" target="_blank" rel="noreferrer">Website ↗</a>` : '—'; const points = $('#company-keypoints'); const income = data.income || []; if (points) { const latest = income[0] || {}; const previous = income[1] || {}; const growth = latest.revenue && previous.revenue ? ((latest.revenue - previous.revenue) / Math.abs(previous.revenue)) * 100 : null; points.innerHTML = `<p class="about-label">KEY POINTS</p><ul>${Number.isFinite(growth) ? `<li>Revenue changed ${percent(growth)} in the latest reported year.</li>` : ''}${latest.netIncome && latest.revenue ? `<li>Latest reported net margin: ${((latest.netIncome / latest.revenue) * 100).toFixed(1)}%.</li>` : ''}</ul>`; } const financials = $('#financials'); if (financials) financials.innerHTML = financialTable('Income statement', data.income || [], [['Revenue','revenue'],['Gross profit','grossProfit'],['Operating income','operatingIncome'],['Net income','netIncome'],['EPS','eps']]) + financialTable('Balance sheet', data.balance || [], [['Cash & equivalents','cashAndCashEquivalents'],['Total assets','totalAssets'],['Total debt','totalDebt'],['Total liabilities','totalLiabilities'],['Total equity','totalStockholdersEquity']]) + financialTable('Cash flow', data.cashflow || [], [['Operating cash flow','operatingCashFlow'],['Capital expenditure','capitalExpenditure'],['Free cash flow','freeCashFlow'],['Net income','netIncome']]); const ratiosElement = $('#company-ratios'); if (ratiosElement) ratiosElement.innerHTML = ratioCard('P/E', valid(ratios.peRatioTTM) ? `${ratio(ratios.peRatioTTM, 1)}x` : '—') + ratioCard('Price to book', valid(ratios.priceToBookRatioTTM) ? `${ratio(ratios.priceToBookRatioTTM, 1)}x` : '—') + ratioCard('Return on equity', pct(ratios.returnOnEquityTTM)) + ratioCard('Current ratio', ratio(ratios.currentRatioTTM)) + ratioCard('Debt to equity', ratio(ratios.debtToEquityRatioTTM)) + ratioCard('Dividend yield', pct(ratios.dividendYieldTTM, 2)); getJson(`/data/chart?symbol=${encodeURIComponent(ticker)}&points=${companyChartOptions.points}`).then(chart => { const holder = $('#company-chart'); if (holder) holder.innerHTML = drawCompanyChart(chart.values || []); }).catch(() => { const holder = $('#company-chart'); if (holder) holder.innerHTML = '<p class="data-empty">Price history is temporarily unavailable.</p>'; }); } catch { const description = $('#company-description'); if (description) description.textContent = 'Live company data is temporarily unavailable.'; } }
async function hydrateCompanyResearchSummary(ticker) {
  try {
    const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`);
    window.currentCompanyData = { ticker, data };
    const income = Array.isArray(data.income) ? data.income.slice().sort((a,b) => String(b.date || b.calendarYear || '').localeCompare(String(a.date || a.calendarYear || ''))) : [];
    const ratios = data.ratios || {};
    const num = value => Number.isFinite(Number(value)) ? Number(value) : null;
    const field = (row, names) => { for (const name of names) { const value = num(row?.[name]); if (value !== null) return value; } return null; };
    const values = names => income.map(row => field(row, names)).filter(value => value !== null);
    const cagr = (latest, oldest, years) => latest > 0 && oldest > 0 ? ((latest / oldest) ** (1 / years) - 1) * 100 : null;
    const sales = values(['revenue','sales']);
    const profits = values(['netIncome','netIncomeCommonStockholders']);
    const eps = values(['eps','epsdiluted','epsDiluted']);
    const cards = document.querySelectorAll('#company-growth-cards > div b');
    const metrics = [cagr(sales[0], sales[5], 5), cagr(profits[0], profits[5], 5), eps.length > 1 && eps[1] !== 0 ? ((eps[0] - eps[1]) / Math.abs(eps[1])) * 100 : null, num(ratios.returnOnEquityTTM) === null ? null : num(ratios.returnOnEquityTTM) * 100];
    cards.forEach((node, index) => { if (node) node.textContent = metrics[index] === null ? '—' : `${metrics[index] >= 0 ? '+' : ''}${metrics[index].toFixed(1)}%`; });
    const freshness = $('#company-freshness');
    if (freshness) freshness.textContent = `Updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })} · Connected market feeds`;
    const refresh = $('#company-refresh');
    if (refresh) refresh.onclick = async () => { refresh.disabled = true; refresh.textContent = 'Refreshing…'; await Promise.allSettled([hydrateCompany(ticker), hydrateCompanyExtras(ticker), hydrateCompanyResearchSummary(ticker)]); refresh.disabled = false; refresh.textContent = 'Refresh data'; };
    const exportButton = $('#company-export');
    if (exportButton) exportButton.onclick = () => { const profile = data.profile || {}; const quote = data.quote || {}; const rows = [['Field','Value'],['Ticker',ticker],['Company',profile.companyName || ticker],['Exchange',profile.exchangeShortName || profile.exchange || 'US Equity'],['Price',quote.price ?? ''],['Change %',quote.changesPercentage ?? ''],['Market cap',profile.mktCap || quote.marketCap || ''],['Sector',profile.sector || ''],['P/E',ratios.peRatioTTM ?? ''],['Price to book',ratios.priceToBookRatioTTM ?? ''],['ROE',ratios.returnOnEquityTTM ?? ''],['Current ratio',ratios.currentRatioTTM ?? ''],['Debt to equity',ratios.debtToEquityRatioTTM ?? '']]; const csv = rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"','""')}"`).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${ticker}-research.csv`; link.click(); URL.revokeObjectURL(url); };
    const peerSearch = $('#peer-search');
    if (peerSearch && !peerSearch.dataset.wired) { peerSearch.dataset.wired = 'true'; peerSearch.oninput = () => { const needle = peerSearch.value.trim().toLowerCase(); document.querySelectorAll('#company-peers tbody tr').forEach(row => { row.hidden = Boolean(needle && !row.textContent.toLowerCase().includes(needle)); }); }; }
  } catch { const freshness = $('#company-freshness'); if (freshness) freshness.textContent = 'Provider data is temporarily unavailable'; }
}
var companyChartOptions = { points:260, ma50:true, ma200:true, volume:true };
function movingAverage(values, window) { return values.map((item, index) => index < window - 1 ? null : values.slice(index - window + 1, index + 1).reduce((sum, value) => sum + value, 0) / window); }
function setupSearch() { const input = $('#global-search'); const results = $('#global-results'); let timer; const openCompany = () => document.querySelectorAll('[data-find]').forEach((button) => { const target = button.dataset.find; button.setAttribute('title', 'Open with Ctrl/Cmd-click or middle-click in a new tab'); button.onclick = event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); openRouteInNewTab(target); return; } input.value = ''; results.hidden = true; navigateTo(target); }; button.onauxclick = event => { if (event.button === 1) { event.preventDefault(); openRouteInNewTab(target); } }; }); input.oninput = () => { clearTimeout(timer); const query = input.value.trim(); if (!query) { results.hidden = true; return; } timer = setTimeout(async () => { results.hidden = false; results.innerHTML = '<button disabled>Searching global exchanges…</button>'; try { const found = await getJson(`/data/search?q=${encodeURIComponent(query)}`); results.innerHTML = found.map((stock) => { const ticker = stock.symbol || stock.ticker; const name = stock.name || stock.companyName || ticker; const exchange = stock.exchangeShortName || stock.exchange || stock.sector || 'Global'; return `<button data-find="${escapeHtml(ticker)}">${companyLogo(ticker, name, 'small')}<span>${escapeHtml(name)} <small>${escapeHtml(ticker)}</small></span><small>${escapeHtml(exchange)}</small></button>`; }).join('') || '<button disabled>No matching company in the connected directories</button>'; } catch { const needle = query.toUpperCase(); const found = stocks.filter((stock) => stock.ticker.includes(needle) || stock.name.toUpperCase().includes(needle)); results.innerHTML = found.map((stock) => `<button data-find="${stock.ticker}">${companyLogo(stock.ticker, stock.name, 'small')}<span>${escapeHtml(stock.name)} <small>${stock.ticker}</small></span><small>${escapeHtml(stock.sector)}</small></button>`).join('') || '<button disabled>Global directory temporarily unavailable</button>'; } openCompany(); }, 220); }; }
// Expanded company workspace. Provider results remain optional so a missing
// premium endpoint never breaks charts, filings, or financial statements.
function intelNumber(value, digits = 1) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits:digits }) : '—'; }
function intelDate(value) { return value ? String(value).slice(0, 10) : '—'; }
function peerTableRow(row) { const valid = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); const change = valid(row.change) ? Number(row.change) : null; const ticker = row.symbol || ''; const name = row.companyName || ticker || 'Company'; return `<tr class="company-row" data-page="${escapeHtml(ticker)}"><td>${companyIdentity(ticker, name, row.industry || row.sector || 'US Equity')}</td><td>${valid(row.price) ? `$${Number(row.price).toFixed(2)}` : '&mdash;'}</td><td>${valid(row.marketCap) ? usd(row.marketCap) : '&mdash;'}</td><td>${valid(row.pe) ? `${Number(row.pe).toFixed(1)}x` : '&mdash;'}</td><td class="${change === null ? '' : change >= 0 ? 'positive' : 'down'}">${change === null ? '&mdash;' : percent(change)}</td></tr>`; }
function hydrateCompanyExtras(ticker) { const documents = $('#company-documents'); const peers = $('#company-peers'); if (peers) { peers.textContent = 'Loading peer comparison…'; getJson(`/data/peers?symbol=${encodeURIComponent(ticker)}`).then(rows => { peers.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>Today</th></tr></thead><tbody>${rows.map(peerTableRow).join('')}</tbody></table></div>` : 'No comparable companies were returned for this stock.'; wireCommon(); }).catch(() => { peers.textContent = 'Peer comparison is unavailable for this company.'; }); }
  if (documents) getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`).then(data => { const filings = (data.filings || []).slice(0, 20); documents.innerHTML = filings.length ? `<div class="filings-inline">${filings.map((filing) => `<a href="${escapeHtml(filing.url || '#')}" target="_blank" rel="noreferrer"><b>${escapeHtml(filing.form || 'Filing')}</b><span><strong>${escapeHtml(filing.category || 'Company filing')}</strong> · ${escapeHtml(filing.description || filing.reportDate || 'Issuer filing')}<small>Filed ${escapeHtml(filing.filedAt || '—')}</small></span><em>Open ↗</em></a>`).join('')}</div><p class="filings-source-note">Issuer filings only · sourced from SEC EDGAR. Third-party ratings, analyst notes and conference-call summaries are excluded.</p>` : 'No issuer filings are available for this company.'; }).catch(() => { documents.textContent = 'Issuer filings are unavailable for this company.'; });
  getJson(`/data/company-intel?symbol=${encodeURIComponent(ticker)}`).then(intel => { const target = $('#company-intel'); const executives = $('#company-executives'); const updates = $('#company-updates'); const insiders = $('#company-insiders'); const score = intel.scores || {}; const priceTarget = intel.priceTarget || {}; const rating = intel.ratings || {}; const cards = [['Analyst target', priceTarget.consensusTargetPrice || priceTarget.targetConsensus, value => value ? `$${intelNumber(value, 2)}` : '—'], ['Financial score', score.altmanZScore || score.piotroskiScore, value => intelNumber(value, 2)], ['Rating', rating.rating || rating.ratingRecommendation, value => value || '—'], ['Owner earnings', intel.ownerEarnings?.[0]?.ownerEarnings, value => usd(value)]]; if (target) target.innerHTML = `<div class="intel-cards">${cards.map(([label,value,format]) => `<div><span>${label}</span><b>${format(value)}</b></div>`).join('')}</div>${intel.estimates?.length ? `<p class="intel-note">Latest annual revenue estimate: <b>${usd(intel.estimates[0].estimatedRevenueAvg || intel.estimates[0].revenueAvg)}</b> · estimated EPS: <b>${intelNumber(intel.estimates[0].estimatedEpsAvg || intel.estimates[0].epsAvg, 2)}</b></p>` : '<p class="intel-note">No analyst-estimate data was returned for this company.</p>'}`; if (executives) executives.innerHTML = intel.executives?.length ? `<div class="compact-list">${intel.executives.slice(0,6).map(person => `<div><b>${escapeHtml(person.name || person.title || 'Executive')}</b><span>${escapeHtml(person.title || person.position || 'Company executive')}</span></div>`).join('')}</div>` : 'Executive data is not available for this company.'; const events = [...(intel.earnings || []).slice(0,2).map(item => ({ type:'Earnings', title:`EPS estimate ${intelNumber(item.epsEstimated,2)} · reported ${intelNumber(item.eps,2)}`, date:item.date || item.fiscalDateEnding })), ...(intel.dividends || []).slice(0,2).map(item => ({ type:'Dividend', title:`${item.dividend ? `$${intelNumber(item.dividend, 2)} per share` : 'Dividend event'}`, date:item.paymentDate || item.recordDate || item.date }))]; const articles = (intel.news || []).slice(0,4); if (updates) updates.innerHTML = (articles.length || events.length) ? `<div class="compact-list">${articles.map(article => `<a href="${escapeHtml(article.url || '#')}" target="_blank" rel="noreferrer"><b>${escapeHtml(article.title || article.text || 'Company news')}</b><span>${escapeHtml(article.site || article.publisher || 'Market news')} · ${intelDate(article.publishedDate || article.date)}</span></a>`).join('')}${events.map(event => `<div><b>${event.type}</b><span>${event.title} · ${intelDate(event.date)}</span></div>`).join('')}</div>` : 'No news, earnings or dividend events were returned for this company.'; if (insiders) insiders.innerHTML = intel.insiders?.length ? `<div class="compact-list">${intel.insiders.slice(0,6).map(item => `<div><b>${escapeHtml(item.reportingName || item.name || 'Insider transaction')}</b><span>${escapeHtml(item.transactionType || item.transactionTypeName || 'Reported transaction')} · ${intelDate(item.transactionDate || item.filingDate)}</span></div>`).join('')}</div>` : 'No reported insider activity was returned for this company.'; }).catch(() => { ['company-intel','company-executives','company-updates','company-insiders'].forEach(id => { const element = $(`#${id}`); if (element) element.textContent = 'This dataset is not available for this company right now.'; }); }); }
document.head.insertAdjacentHTML('beforeend', '<style>.intelligence-grid{margin-top:16px}.intel-cards{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid #dedede}.intel-cards>div{padding:13px 16px;border-right:1px solid #dedede;border-bottom:1px solid #dedede}.intel-cards span,.compact-list span{display:block;color:#888;font-size:10px}.intel-cards b{display:block;margin-top:5px;font-size:14px}.intel-note{margin:0;padding:13px 16px;color:#666;font-size:11px;line-height:1.6}.compact-list{padding:0 16px 12px}.compact-list>div,.compact-list>a{display:block;padding:11px 0;border-top:1px solid #eee;color:#333;text-decoration:none;font-size:11px;line-height:1.45}.compact-list>a:hover{color:#276d3d;background:#fafdf9}.compact-list b{display:block;font-size:11px}.compact-list span{margin-top:3px}@media(max-width:700px){.intel-cards{grid-template-columns:1fr}.intel-cards>div{border-right:0}}</style>');
document.head.insertAdjacentHTML('beforeend', '<style>.company-research-card{grid-template-columns:minmax(0,2.1fr) minmax(280px,1fr);overflow:hidden}.ratio-board{display:grid;grid-template-columns:repeat(3,1fr);padding:12px;border-right:1px solid #2c3657}.ratio-cell{padding:13px 12px;min-height:74px}.ratio-cell span{display:block;color:#95a5cd;font-size:10px}.ratio-cell b{display:block;margin-top:7px;color:#fff;font-size:14px}.ratio-cell small{display:block;margin-top:3px;font-size:10px}.ratio-cell.emphasis{background:#0d1426;border-radius:7px}.price-cell b{font-size:22px}.company-about{padding:20px 22px}.company-about>p:not(.about-label){margin:8px 0 18px;color:#bac5dc;font-size:11px;line-height:1.65;max-height:196px;overflow:auto}.about-label{margin:0;color:#9faeff;font-size:10px;font-weight:700;letter-spacing:.12em}.about-meta{padding:12px 0;border-top:1px solid #2c3657}.about-meta span,.about-meta b{display:block}.about-meta span{color:#94a3c4;font-size:10px}.about-meta b{margin-top:5px;font-size:11px}.about-meta a{color:#9eafff}.key-points{margin-top:18px}.key-points ul{margin:8px 0 0;padding-left:16px;color:#bac5dc;font-size:11px;line-height:1.55}@media(max-width:850px){.company-research-card{grid-template-columns:1fr}.ratio-board{border-right:0;border-bottom:1px solid #2c3657}}@media(max-width:550px){.ratio-board{grid-template-columns:repeat(2,1fr)}}</style>');
const originalHydrateCompanyExtras = hydrateCompanyExtras;
hydrateCompanyExtras = async function(ticker) { originalHydrateCompanyExtras(ticker); const holder = $('#company-ratios'); if (!holder) return; try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const r = data.ratios || {}; const n = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; const x = (value, digits = 1) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '—'; const groups = [['Valuation', [['P/E', r.peRatioTTM ? `${n(r.peRatioTTM, 1)}x` : '—'], ['Price to book', r.priceToBookRatioTTM ? `${n(r.priceToBookRatioTTM, 1)}x` : '—'], ['Price to sales', r.priceToSalesRatioTTM ? `${n(r.priceToSalesRatioTTM, 1)}x` : '—'], ['Price to free cash flow', r.priceToFreeCashFlowsRatioTTM ? `${n(r.priceToFreeCashFlowsRatioTTM, 1)}x` : '—'], ['EV / EBITDA', r.enterpriseValueMultipleTTM ? `${n(r.enterpriseValueMultipleTTM, 1)}x` : '—'], ['Dividend yield', x(r.dividendYieldTTM, 2)]]], ['Profitability', [['Gross margin', x(r.grossProfitMarginTTM)], ['Operating margin', x(r.operatingProfitMarginTTM)], ['Net margin', x(r.netProfitMarginTTM)], ['Return on equity', x(r.returnOnEquityTTM)], ['Return on assets', x(r.returnOnAssetsTTM)], ['Return on capital employed', x(r.returnOnCapitalEmployedTTM)]]], ['Balance sheet', [['Current ratio', n(r.currentRatioTTM)], ['Quick ratio', n(r.quickRatioTTM)], ['Debt to equity', n(r.debtToEquityRatioTTM)], ['Debt ratio', n(r.debtRatioTTM)], ['Interest coverage', n(r.interestCoverageTTM)], ['Equity multiplier', n(r.companyEquityMultiplierTTM)]]], ['Cash flow & efficiency', [['Operating cash flow / sales', x(r.operatingCashFlowSalesRatioTTM)], ['Free cash flow / operating cash flow', x(r.freeCashFlowOperatingCashFlowRatioTTM)], ['Asset turnover', n(r.assetTurnoverTTM)], ['Inventory turnover', n(r.inventoryTurnoverTTM)], ['Receivables turnover', n(r.receivablesTurnoverTTM)], ['Payout ratio', x(r.payoutRatioTTM)]]]]; holder.innerHTML = `<div class="ratio-explorer-head"><div><b>Ratio explorer</b><span>Most recent trailing-twelve-month values</span></div></div><div class="ratio-explorer">${groups.map(([name, rows]) => `<section><h3>${name}</h3>${rows.map(([label,value]) => `<div><span>${label}</span><b>${value}</b></div>`).join('')}</section>`).join('')}</div>`; } catch { holder.innerHTML = '<p class="data-empty">Detailed ratios are temporarily unavailable for this company.</p>'; } };
document.head.insertAdjacentHTML('beforeend', '<style>.ratios-panel{overflow:hidden}.ratio-explorer-head{padding:2px 16px 14px}.ratio-explorer-head b,.ratio-explorer-head span{display:block}.ratio-explorer-head b{font-size:12px}.ratio-explorer-head span{margin-top:4px;color:#94a3c4;font-size:10px}.ratio-explorer{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:0 16px 16px}.ratio-explorer section{border:1px solid #2d395a;border-radius:9px;overflow:hidden;background:#10182b}.ratio-explorer h3{margin:0;padding:11px 12px;background:#17213b;color:#b7c5ff;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.ratio-explorer section>div{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-top:1px solid #273250;font-size:11px}.ratio-explorer span{color:#a6b2cb}.ratio-explorer b{color:#f0f4ff}@media(max-width:700px){.ratio-explorer{grid-template-columns:1fr}}</style>');
document.head.insertAdjacentHTML('beforeend', '<style>.ratio-cell{padding:11px 12px!important;min-height:64px!important}.ratio-cell span{font-size:9px!important}.ratio-cell b{margin-top:5px!important;font-size:12px!important;line-height:1.25!important;word-break:break-word}.ratio-cell.price-cell b{font-size:18px!important}.ratio-cell small{font-size:9px!important}.company-research-card{grid-template-columns:minmax(0,2.2fr) minmax(270px,.9fr)!important}.company-about{padding:18px 20px!important}</style>');
document.head.insertAdjacentHTML('beforeend', '<style>.company-actionbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 16px;padding:10px 12px;border:1px solid #2d395a;border-radius:10px;background:#10182b;color:#94a3c4;font-size:10px}.company-actionbar .live-pill{display:inline-flex;align-items:center;gap:6px;color:#5de0b6;font-weight:700;letter-spacing:.04em}.live-pill i{width:7px;height:7px;border-radius:50%;background:#5de0b6;box-shadow:0 0 0 4px #5de0b622;animation:ddPulse 1.8s ease-in-out infinite}.company-actionbar button{margin-left:auto}.company-actionbar .link-button + .solid-btn{margin-left:0}.growth-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0 16px 16px}.growth-cards>div{padding:14px;border:1px solid #2d395a;border-radius:9px;background:#10182b}.growth-cards span,.growth-cards small{display:block;color:#94a3c4;font-size:10px}.growth-cards b{display:block;margin:7px 0 3px;color:#f0f4ff;font-size:18px}.peer-search{max-width:180px;background:#0e1526;color:#edf2ff;border:1px solid #34405f;border-radius:7px;padding:8px 10px}@keyframes ddPulse{50%{opacity:.45;transform:scale(.8)}}html[data-theme="light"] .company-actionbar{background:#fff;color:#60706b;border-color:#cbd9d5}html[data-theme="light"] .growth-cards>div{background:#f8fbfa;border-color:#cadbd5}html[data-theme="light"] .growth-cards b{color:#16322f}html[data-theme="light"] .peer-search{background:#fff;color:#16322f;border-color:#bfd2cc}@media(max-width:700px){.growth-cards{grid-template-columns:repeat(2,1fr)}.company-actionbar button{margin-left:0}.peer-search{max-width:none;width:100%}}</style>');
// Company overview: keep the headline facts and the complete ratio explorer
// together, with controls for finding and hiding individual metrics.
function companyView(ticker) {
  return `<div class="page company-page">
    <div class="company-top">
      <div class="company-heading">
        ${companyLogo(ticker, ticker, 'large')}
        <div><p class="crumb">US EQUITY RESEARCH</p><h1 class="page-title" id="company-title">${escapeHtml(ticker)}</h1><p class="sub" id="company-subtitle">${escapeHtml(ticker)} · Loading company research…</p></div>
      </div>
      <button class="solid-btn ${watchlist.includes(ticker) ? 'saved' : ''}" data-watch="${ticker}">${watchlist.includes(ticker) ? 'Following' : 'Follow'}</button>
    </div>
    <nav class="company-tabs" aria-label="Company research sections"><a href="#overview">Summary</a><a href="#chart">Chart</a><a href="#earnings">Earnings</a><a href="#intelligence">Analysis</a><a href="#intelligence">Outlook</a><a href="#peers">Peers</a><a href="#quarterly">Quarters</a><a href="#pnl">P&amp;L</a><a href="#balance-sheet">Balance Sheet</a><a href="#cash-flow">Cash Flow</a><a href="#overview-ratios">Ratios</a><a href="#intelligence">Investors</a><a href="#events">Events</a><a href="#documents">Documents</a></nav>
    <div class="company-actionbar"><span class="live-pill"><i></i> Live research data</span><span id="company-freshness">Updating from connected providers…</span><button type="button" class="link-button" id="company-refresh">Refresh data</button><button type="button" class="solid-btn" id="company-export">Export research CSV</button></div>
    <div id="overview" class="company-overview-stack">
      <section class="panel company-summary company-research-card">
        <div class="summary-main ratio-board">
          <div class="ratio-cell"><span>Market cap</span><b id="company-cap">—</b></div>
          <div class="ratio-cell price-cell"><span>Current price</span><b id="company-price">—</b><small id="company-change">Quote loading…</small></div>
          <div class="ratio-cell"><span>Day high / low</span><b id="company-range">—</b></div>
          <div class="ratio-cell emphasis"><span>Stock P/E</span><b id="company-pe">—</b></div>
          <div class="ratio-cell emphasis"><span>Book value / share</span><b id="company-book">—</b></div>
          <div class="ratio-cell emphasis"><span>Dividend yield</span><b id="company-dividend">—</b></div>
          <div class="ratio-cell"><span>Return on equity</span><b id="company-roe">—</b></div>
          <div class="ratio-cell"><span>Current ratio</span><b id="company-current">—</b></div>
          <div class="ratio-cell"><span>Debt to equity</span><b id="company-debt">—</b></div>
          <div class="ratio-cell emphasis"><span>Price to book</span><b id="company-pb">—</b></div>
          <div class="ratio-cell"><span>Volume</span><b id="company-volume">—</b></div>
          <div class="ratio-cell"><span>Sector</span><b id="company-sector">—</b></div>
        </div>
        <aside class="company-about"><p class="about-label">ABOUT</p><p id="company-description">Loading company profile and latest available quote…</p><div class="about-meta"><span>Website</span><b id="company-site">—</b></div><div id="company-keypoints" class="key-points"></div></aside>
      </section>
      <section id="overview-ratios" class="panel ratios-panel overview-ratios">
        <div class="panel-head"><div><h2>Financial ratio explorer</h2><p>Filter the latest trailing-twelve-month valuation, quality and efficiency metrics</p></div></div>
        <div id="company-ratios"><p class="data-empty">Loading ratios…</p></div>
      </section>
      <section class="panel growth-panel"><div class="panel-head"><div><h2>Long-term performance</h2><p>Calculated from reported annual statements and current market data</p></div><span class="data-badge">Reported history</span></div><div id="company-growth-cards" class="growth-cards"><div><span>Sales CAGR</span><b>—</b><small>5 years</small></div><div><span>Profit CAGR</span><b>—</b><small>5 years</small></div><div><span>EPS trend</span><b>—</b><small>Latest vs prior year</small></div><div><span>ROE</span><b id="growth-roe">—</b><small>TTM</small></div></div></section>
    </div>
    <section id="chart" class="panel chart-panel"><div class="panel-head"><div><h2>Price & volume</h2><p>Historical market data · select the time range below</p></div></div><div id="company-chart" class="chart-area">Loading chart…</div></section>
    <section id="earnings" class="panel earnings-dashboard-panel"><div class="panel-head"><div><h2>Earnings dashboard</h2><p>Provider-reported estimates, actual results and surprise history</p></div><span class="data-badge" id="earnings-confidence">Checking coverage…</span></div><div id="company-earnings-dashboard"><p class="data-empty">Loading earnings data…</p></div></section>
    <section id="strengths" class="panel company-signals-panel" aria-labelledby="company-signals-title">
      <div class="panel-head"><div><h2 id="company-signals-title">Pros &amp; cons</h2><p>Automatically calculated from reported financial data</p></div><span class="signals-badge">Rules-based</span></div>
      <div id="company-signals" class="company-signals-loading">Analysing the latest reported figures...</div>
    </section>
    <section id="quarterly" class="panel financial-panel quarterly-panel"><div class="panel-head"><div><h2>Quarterly results</h2><p>USD millions except per-share data · latest reported quarters</p></div><span class="quarterly-source">Reported data</span></div><div id="company-quarterly"><p class="data-empty">Loading quarterly results…</p></div></section>
    <div id="financials" class="financial-stack"></div>
    <section id="peers" class="panel documents-panel"><div class="panel-head"><div><h2>Peer comparison</h2><p>Companies in the same sector and industry</p></div><input id="peer-search" class="peer-search" placeholder="Find a peer…" aria-label="Find a peer"></div><div id="company-peers" class="data-empty">Peer data is loading…</div></section>
    <section id="intelligence" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>Analyst & financial strength</h2><p>Consensus, financial scores and owner earnings</p></div></div><div id="company-intel" class="data-empty">Loading analyst and financial-strength data…</div></div><div class="panel"><div class="panel-head"><div><h2>Company leadership</h2><p>Executives reported by the provider</p></div></div><div id="company-executives" class="data-empty">Loading executive data…</div></div><div class="panel"><div class="panel-head"><div><h2>Insider activity</h2><p>Reported insider transactions</p></div></div><div id="company-insiders" class="data-empty">Loading insider activity…</div></div></section>
    <section id="events" class="panel company-events-panel"><div class="panel-head"><div><h2>Company event timeline</h2><p>Earnings, dividends, calls and official SEC filings in one place</p></div><span class="data-badge" id="events-updated">Loading events…</span></div><div id="company-event-timeline"><p class="data-empty">Building the reported event timeline…</p></div></section>
    <section id="documents" class="panel documents-panel"><div class="panel-head"><div><h2>Recent SEC filings</h2><p>Official documents, direct from the SEC</p></div></div><div id="company-documents" class="data-empty">Loading recent filings…</div></section>
  </div>`;
}

function renderFilteredRatioExplorer(holder, ratios) {
  const metric = (label, value, format = 'number', digits = 2) => ({ label, value, format, digits, available: value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) });
  const groups = [
    { id:'valuation', name:'Valuation', rows:[metric('P/E', ratios.peRatioTTM, 'multiple', 1), metric('Price to book', ratios.priceToBookRatioTTM, 'multiple', 1), metric('Price to sales', ratios.priceToSalesRatioTTM, 'multiple', 1), metric('Price to free cash flow', ratios.priceToFreeCashFlowsRatioTTM, 'multiple', 1), metric('EV / EBITDA', ratios.enterpriseValueMultipleTTM, 'multiple', 1), metric('Dividend yield', ratios.dividendYieldTTM, 'percent', 2)] },
    { id:'profitability', name:'Profitability', rows:[metric('Gross margin', ratios.grossProfitMarginTTM, 'percent', 1), metric('Operating margin', ratios.operatingProfitMarginTTM, 'percent', 1), metric('Net margin', ratios.netProfitMarginTTM, 'percent', 1), metric('Return on equity', ratios.returnOnEquityTTM, 'percent', 1), metric('Return on assets', ratios.returnOnAssetsTTM, 'percent', 1), metric('Return on invested capital', ratios.returnOnInvestedCapitalTTM, 'percent', 1)] },
    { id:'balance', name:'Balance sheet', rows:[metric('Current ratio', ratios.currentRatioTTM), metric('Quick ratio', ratios.quickRatioTTM), metric('Debt to equity', ratios.debtToEquityRatioTTM), metric('Debt ratio', ratios.debtRatioTTM), metric('Interest coverage', ratios.interestCoverageTTM), metric('Equity multiplier', ratios.companyEquityMultiplierTTM)] },
    { id:'cashflow', name:'Cash flow & efficiency', rows:[metric('Operating cash flow / sales', ratios.operatingCashFlowSalesRatioTTM, 'percent', 1), metric('Free cash flow / operating cash flow', ratios.freeCashFlowOperatingCashFlowRatioTTM, 'percent', 1), metric('Asset turnover', ratios.assetTurnoverTTM), metric('Inventory turnover', ratios.inventoryTurnoverTTM), metric('Receivables turnover', ratios.receivablesTurnoverTTM), metric('Payout ratio', ratios.payoutRatioTTM, 'percent', 1)] }
  ];
  let activeGroup = 'all';
  let hideUnavailable = false;
  const formatValue = row => {
    if (!row.available) return '&mdash;';
    const value = Number(row.value);
    if (row.format === 'percent') return `${(value * 100).toFixed(row.digits)}%`;
    if (row.format === 'multiple') return `${value.toFixed(row.digits)}x`;
    return value.toFixed(row.digits);
  };
  const draw = () => {
    const visibleGroups = groups.map(group => ({ ...group, rows:group.rows.filter(row => !hideUnavailable || row.available) })).filter(group => (activeGroup === 'all' || group.id === activeGroup) && group.rows.length);
    holder.innerHTML = `<div class="ratio-filter-bar"><div class="ratio-category-filter"><button class="${activeGroup === 'all' ? 'active' : ''}" data-ratio-group="all">All</button>${groups.map(group => `<button class="${activeGroup === group.id ? 'active' : ''}" data-ratio-group="${group.id}">${group.name}</button>`).join('')}</div><div class="ratio-filter-actions"><label class="ratio-hide"><input id="ratio-hide-unavailable" type="checkbox" ${hideUnavailable ? 'checked' : ''}> Hide unavailable</label></div></div><div class="ratio-explorer">${visibleGroups.map(group => `<section data-ratio-section="${group.id}"><h3>${group.name}</h3>${group.rows.map(row => `<div data-ratio-name="${escapeHtml(row.label.toLowerCase())}"><span>${row.label}</span><b>${formatValue(row)}</b></div>`).join('')}</section>`).join('') || '<p class="data-empty">No ratios are available for this filter.</p>'}</div>`;
    holder.querySelectorAll('[data-ratio-group]').forEach(button => button.onclick = () => { activeGroup = button.dataset.ratioGroup; draw(); });
    const hide = holder.querySelector('#ratio-hide-unavailable');
    if (hide) hide.onchange = () => { hideUnavailable = hide.checked; draw(); };
  };
  draw();
}

function buildCompanySignals(data) {
  const ratios = data.ratios || {};
  const income = Array.isArray(data.income) ? data.income : [];
  const cashflow = Array.isArray(data.cashflow) ? data.cashflow : [];
  const quarterly = Array.isArray(data.quarterlyIncome) ? data.quarterlyIncome : [];
  const pros = [];
  const cons = [];
  const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const firstNumber = (...values) => values.map(number).find(value => value !== null) ?? null;
  const push = (list, key, text, priority) => {
    if (!text || list.some(item => item.key === key)) return;
    list.push({ key, text, priority });
  };
  const percentage = value => `${Math.abs(value * 100).toFixed(1)}%`;
  const multiple = value => `${Math.abs(value).toFixed(1)}x`;
  const latestIncome = income[0] || {};
  const previousIncome = income[1] || {};
  const latestQuarter = quarterly[0] || {};
  const previousQuarter = quarterly[1] || {};
  const latestCashflow = cashflow[0] || {};

  const latestRevenue = firstNumber(latestIncome.revenue, latestQuarter.revenue);
  const previousRevenue = firstNumber(previousIncome.revenue, previousQuarter.revenue);
  if (latestRevenue !== null && previousRevenue !== null && previousRevenue !== 0) {
    const growth = (latestRevenue - previousRevenue) / Math.abs(previousRevenue);
    if (growth >= 0.08) push(pros, 'revenue-growth', `Revenue grew ${percentage(growth)} versus the previous reported period.`, 90 + Math.min(growth, 1));
    if (growth <= -0.05) push(cons, 'revenue-decline', `Revenue declined ${percentage(growth)} versus the previous reported period.`, 90 + Math.min(Math.abs(growth), 1));
  }

  const latestNetIncome = firstNumber(latestIncome.netIncome, latestQuarter.netIncome);
  const previousNetIncome = firstNumber(previousIncome.netIncome, previousQuarter.netIncome);
  if (latestNetIncome !== null && latestNetIncome < 0) push(cons, 'loss', 'The latest reported period shows a net loss.', 120);
  if (latestNetIncome !== null && previousNetIncome !== null && latestNetIncome > 0 && previousNetIncome > 0) {
    const growth = (latestNetIncome - previousNetIncome) / Math.abs(previousNetIncome);
    if (growth >= 0.12) push(pros, 'profit-growth', `Net profit grew ${percentage(growth)} versus the previous reported period.`, 105 + Math.min(growth, 1));
    if (growth <= -0.15) push(cons, 'profit-decline', `Net profit fell ${percentage(growth)} versus the previous reported period.`, 105 + Math.min(Math.abs(growth), 1));
  }

  const grossMargin = number(ratios.grossProfitMarginTTM);
  const operatingMargin = number(ratios.operatingProfitMarginTTM);
  const netMargin = number(ratios.netProfitMarginTTM);
  if (grossMargin !== null && grossMargin >= 0.45) push(pros, 'gross-margin', `Gross margin is a strong ${percentage(grossMargin)} on a trailing-twelve-month basis.`, 80 + grossMargin);
  if (operatingMargin !== null && operatingMargin >= 0.18) push(pros, 'operating-margin', `Operating margin is ${percentage(operatingMargin)} on a trailing-twelve-month basis.`, 85 + operatingMargin);
  if (netMargin !== null && netMargin >= 0.12) push(pros, 'net-margin', `Net margin is ${percentage(netMargin)} on a trailing-twelve-month basis.`, 88 + netMargin);
  if (netMargin !== null && netMargin < 0) push(cons, 'loss', `Trailing-twelve-month net margin is negative at -${percentage(netMargin)}.`, 115);
  else if (netMargin !== null && netMargin >= 0 && netMargin < 0.04) push(cons, 'thin-margin', `Trailing-twelve-month net margin is thin at ${percentage(netMargin)}.`, 72);

  const roe = number(ratios.returnOnEquityTTM);
  const roic = number(ratios.returnOnInvestedCapitalTTM);
  if (roe !== null && roe >= 0.15) push(pros, 'roe', `Return on equity is ${percentage(roe)}.`, 96 + Math.min(roe, 1));
  if (roe !== null && roe < 0) push(cons, 'negative-roe', `Return on equity is negative at -${percentage(roe)}.`, 112);
  else if (roe !== null && roe >= 0 && roe < 0.07) push(cons, 'low-roe', `Return on equity is low at ${percentage(roe)}.`, 75);
  if (roic !== null && roic >= 0.12) push(pros, 'roic', `Return on invested capital is ${percentage(roic)}.`, 94 + Math.min(roic, 1));
  if (roic !== null && roic >= 0 && roic < 0.04) push(cons, 'low-roic', `Return on invested capital is low at ${percentage(roic)}.`, 74);

  const debtToEquity = number(ratios.debtToEquityRatioTTM);
  const currentRatio = number(ratios.currentRatioTTM);
  const interestCoverage = number(ratios.interestCoverageTTM);
  if (debtToEquity !== null && debtToEquity >= 0 && debtToEquity <= 0.45) push(pros, 'low-debt', `Debt to equity is conservative at ${debtToEquity.toFixed(2)}.`, 92 - debtToEquity);
  if (debtToEquity !== null && debtToEquity > 1.5) push(cons, 'high-debt', `Debt to equity is elevated at ${debtToEquity.toFixed(2)}.`, 98 + Math.min(debtToEquity, 5));
  if (currentRatio !== null && currentRatio >= 1.5) push(pros, 'liquidity', `Current ratio of ${currentRatio.toFixed(2)} indicates a solid near-term liquidity cushion.`, 82 + Math.min(currentRatio, 3));
  if (currentRatio !== null && currentRatio < 1) push(cons, 'liquidity', `Current ratio is below 1.0 at ${currentRatio.toFixed(2)}.`, 100 - currentRatio);
  if (interestCoverage !== null && interestCoverage >= 5) push(pros, 'interest-coverage', `Operating earnings cover interest expense ${multiple(interestCoverage)}.`, 88 + Math.min(interestCoverage / 10, 2));
  if (interestCoverage !== null && interestCoverage > 0 && interestCoverage < 2) push(cons, 'interest-coverage', `Interest coverage is only ${multiple(interestCoverage)}.`, 104 - interestCoverage);

  const freeCashFlow = number(latestCashflow.freeCashFlow);
  const operatingCashFlow = number(latestCashflow.operatingCashFlow);
  if (freeCashFlow !== null && freeCashFlow > 0) push(pros, 'free-cash-flow', 'The latest annual period generated positive free cash flow.', 86);
  if (freeCashFlow !== null && freeCashFlow < 0) push(cons, 'free-cash-flow', 'The latest annual period reported negative free cash flow.', 108);
  else if (operatingCashFlow !== null && operatingCashFlow < 0) push(cons, 'operating-cash-flow', 'The latest annual period reported negative operating cash flow.', 106);

  const pe = number(ratios.peRatioTTM);
  const priceToBook = number(ratios.priceToBookRatioTTM);
  const priceToSales = number(ratios.priceToSalesRatioTTM);
  if (pe !== null && pe > 45) push(cons, 'pe', `The stock trades at a high ${multiple(pe)} trailing earnings.`, 91 + Math.min(pe / 20, 5));
  if (priceToBook !== null && priceToBook > 8) push(cons, 'price-to-book', `The stock trades at ${multiple(priceToBook)} book value.`, 88 + Math.min(priceToBook / 10, 4));
  if (priceToSales !== null && priceToSales > 10) push(cons, 'price-to-sales', `The stock trades at ${multiple(priceToSales)} trailing sales.`, 87 + Math.min(priceToSales / 10, 4));

  const dividendYield = number(ratios.dividendYieldTTM);
  if (dividendYield !== null && dividendYield >= 0.02) push(pros, 'dividend', `Trailing dividend yield is ${percentage(dividendYield)}.`, 70 + dividendYield);

  const takeBest = values => values.sort((a, b) => b.priority - a.priority).slice(0, 4).map(item => item.text);
  return { pros: takeBest(pros), cons: takeBest(cons) };
}

function renderCompanySignals(holder, data) {
  if (!holder) return;
  const signals = buildCompanySignals(data);
  const list = (items, emptyText) => items.length
    ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="signal-empty">${emptyText}</p>`;
  holder.innerHTML = `<div class="company-signals-grid">
    <article class="signal-card signal-pros"><div class="signal-heading"><span aria-hidden="true">+</span><h3>Pros</h3><small>${signals.pros.length} signals</small></div>${list(signals.pros, 'No strong positive signal crossed the current rules with the available reported data.')}</article>
    <article class="signal-card signal-cons"><div class="signal-heading"><span aria-hidden="true">!</span><h3>Cons</h3><small>${signals.cons.length} signals</small></div>${list(signals.cons, 'No material risk signal crossed the current rules with the available reported data.')}</article>
  </div><p class="signals-note">Automatically generated from reported financial statements and ratios using fixed research rules. For education only, not investment advice.</p>`;
}

function reportedNumber(...values) {
  const value = values.find(item => item !== null && item !== undefined && item !== '' && Number.isFinite(Number(item)));
  return value === undefined ? null : Number(value);
}

function reportedDate(...values) {
  const value = values.find(item => item && !Number.isNaN(new Date(item).getTime()));
  return value ? String(value).slice(0, 10) : '';
}

function renderEarningsDashboard(holder, intel) {
  if (!holder) return;
  const rows = (Array.isArray(intel?.earnings) ? intel.earnings : []).map(item => ({
    date:reportedDate(item.date, item.fiscalDateEnding, item.reportedDate),
    period:item.fiscalDateEnding || item.period || item.date || '',
    epsActual:reportedNumber(item.eps, item.epsActual, item.epsReported),
    epsEstimate:reportedNumber(item.epsEstimated, item.epsEstimate, item.estimatedEps),
    revenueActual:reportedNumber(item.revenue, item.revenueActual, item.revenueReported),
    revenueEstimate:reportedNumber(item.revenueEstimated, item.revenueEstimate, item.estimatedRevenue),
    session:item.time || item.session || ''
  })).filter(item => item.date).sort((a, b) => b.date.localeCompare(a.date));
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter(item => item.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const completed = rows.filter(item => item.date < today && (item.epsActual !== null || item.revenueActual !== null));
  const latest = completed[0] || rows.find(item => item.epsActual !== null || item.revenueActual !== null) || null;
  const surprise = row => row?.epsActual !== null && row?.epsEstimate !== null && row.epsEstimate !== 0 ? ((row.epsActual - row.epsEstimate) / Math.abs(row.epsEstimate)) * 100 : null;
  const surpriseLabel = row => {
    const value = surprise(row);
    return value === null ? 'Not reported' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
  };
  const moneyValue = value => value === null ? 'Not reported' : usd(value);
  const epsValue = value => value === null ? 'Not reported' : `$${value.toFixed(2)}`;
  const status = $('#earnings-confidence');
  if (status) status.textContent = rows.length >= 4 ? 'Provider history available' : rows.length ? 'Partial provider coverage' : 'Not reported by provider';
  if (!rows.length) {
    holder.innerHTML = '<div class="earnings-empty"><b>No earnings dataset was returned</b><span>The quarterly financial statements below may still be available. DollarDisha does not estimate missing results or dates.</span></div>';
    return;
  }
  const summary = [
    ['Next report', upcoming?.date || 'Not reported', upcoming?.session ? String(upcoming.session).toUpperCase() : 'Provider date'],
    ['EPS estimate', epsValue(upcoming?.epsEstimate ?? null), upcoming ? 'Upcoming consensus' : 'No upcoming event returned'],
    ['Revenue estimate', moneyValue(upcoming?.revenueEstimate ?? null), upcoming ? 'Upcoming consensus' : 'No upcoming event returned'],
    ['Latest EPS surprise', latest ? surpriseLabel(latest) : 'Not reported', latest?.date || 'No completed event returned']
  ];
  const history = rows.slice(0, 8);
  holder.innerHTML = `<div class="earnings-summary-grid">${summary.map(([label, value, note]) => `<article><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></article>`).join('')}</div><div class="table-wrap earnings-history-wrap"><table class="earnings-history-table"><thead><tr><th>Reported date</th><th>Period</th><th>EPS actual</th><th>EPS estimate</th><th>Surprise</th><th>Revenue actual</th><th>Revenue estimate</th></tr></thead><tbody>${history.map(row => { const surpriseValue = surprise(row); return `<tr><td><b>${escapeHtml(row.date)}</b></td><td>${escapeHtml(String(row.period).slice(0, 10) || '—')}</td><td>${epsValue(row.epsActual)}</td><td>${epsValue(row.epsEstimate)}</td><td class="${surpriseValue === null ? '' : surpriseValue >= 0 ? 'positive' : 'down'}">${surpriseLabel(row)}</td><td>${moneyValue(row.revenueActual)}</td><td>${moneyValue(row.revenueEstimate)}</td></tr>`; }).join('')}</tbody></table></div><p class="earnings-source-note">Actuals, estimates and dates are shown exactly as returned by the connected provider. Missing values remain explicitly labelled.</p>`;
}

function renderCompanyEventTimeline(holder, intel, filingData, ticker) {
  if (!holder) return;
  const today = new Date().toISOString().slice(0, 10);
  const filings = (Array.isArray(filingData?.filings) ? filingData.filings : []).slice(0, 24).map(item => ({
    type:'filing', date:reportedDate(item.filedAt, item.reportDate), title:`${item.form || 'SEC filing'} · ${item.description || item.category || 'Company disclosure'}`, detail:'Official issuer filing', url:item.url || ''
  }));
  const earnings = (Array.isArray(intel?.earnings) ? intel.earnings : []).slice(0, 10).map(item => {
    const actual = reportedNumber(item.eps, item.epsActual, item.epsReported);
    const estimate = reportedNumber(item.epsEstimated, item.epsEstimate, item.estimatedEps);
    const detail = actual !== null ? `EPS actual $${actual.toFixed(2)}${estimate !== null ? ` · estimate $${estimate.toFixed(2)}` : ''}` : estimate !== null ? `EPS estimate $${estimate.toFixed(2)}` : 'Provider-reported earnings event';
    return { type:'earnings', date:reportedDate(item.date, item.fiscalDateEnding), title:`${ticker} earnings`, detail };
  });
  const dividends = (Array.isArray(intel?.dividends) ? intel.dividends : []).slice(0, 10).map(item => {
    const dividend = reportedNumber(item.dividend, item.adjDividend);
    return { type:'dividend', date:reportedDate(item.paymentDate, item.recordDate, item.date), title:'Dividend event', detail:dividend === null ? 'Provider-reported dividend date' : `$${dividend.toFixed(4)} per share` };
  });
  const calls = (Array.isArray(intel?.transcriptDates) ? intel.transcriptDates : []).slice(0, 10).map(item => ({
    type:'call', date:reportedDate(item.date), title:`Q${item.quarter || '—'} ${item.year || ''} earnings call`, detail:'Company management discussion and analyst Q&A', year:item.year, quarter:item.quarter
  }));
  const events = [...earnings, ...dividends, ...calls, ...filings].filter(item => item.date).sort((a, b) => {
    const aFuture = a.date >= today; const bFuture = b.date >= today;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  });
  if (!events.length) {
    holder.innerHTML = '<div class="earnings-empty"><b>No dated company events were returned</b><span>DollarDisha will show the timeline when the provider or SEC reports a dated event.</span></div>';
    return;
  }
  const labels = { all:'All events', earnings:'Earnings', filing:'SEC filings', dividend:'Dividends', call:'Calls' };
  let active = 'all';
  const draw = () => {
    const visible = events.filter(item => active === 'all' || item.type === active).slice(0, 18);
    holder.innerHTML = `<div class="event-filter-bar">${Object.entries(labels).map(([key, label]) => `<button type="button" class="${active === key ? 'active' : ''}" data-event-filter="${key}">${label}<span>${key === 'all' ? events.length : events.filter(item => item.type === key).length}</span></button>`).join('')}</div><div class="company-event-list">${visible.map(item => { const upcoming = item.date >= today; const callAction = item.type === 'call' && item.year && item.quarter ? `<button type="button" data-call-mode="summary" data-call-year="${item.year}" data-call-quarter="${item.quarter}">Open summary</button>` : ''; const filingAction = item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open filing ↗</a>` : ''; return `<article class="company-event-item event-${item.type}"><time datetime="${escapeHtml(item.date)}"><b>${escapeHtml(item.date)}</b><small>${upcoming ? 'Upcoming' : 'Reported'}</small></time><span class="event-marker" aria-hidden="true"></span><div><span class="event-kind">${escapeHtml(labels[item.type] || item.type)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></div><aside>${callAction || filingAction}</aside></article>`; }).join('')}</div><p class="earnings-source-note">Exact dates only. SEC filings are confirmed issuer disclosures; earnings, dividends and calls are labelled from provider-reported data.</p>`;
    holder.querySelectorAll('[data-event-filter]').forEach(button => button.onclick = () => { active = button.dataset.eventFilter; draw(); });
    holder.querySelectorAll('[data-call-mode]').forEach(button => button.onclick = () => openEarningsDocument(ticker, button.dataset.callYear, button.dataset.callQuarter, button.dataset.callMode));
  };
  draw();
}

async function hydrateCompanyEarningsAndEvents(ticker) {
  const earningsHolder = $('#company-earnings-dashboard');
  const timelineHolder = $('#company-event-timeline');
  if (!earningsHolder && !timelineHolder) return;
  try {
    const [intel, filings] = await Promise.all([
      getJson(`/data/company-intel?symbol=${encodeURIComponent(ticker)}`, 45000),
      getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`, 45000)
    ]);
    renderEarningsDashboard(earningsHolder, intel);
    renderCompanyEventTimeline(timelineHolder, intel, filings, ticker);
    const updated = $('#events-updated');
    if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
  } catch {
    if (earningsHolder) earningsHolder.innerHTML = '<p class="data-empty">Earnings data is temporarily unavailable.</p>';
    if (timelineHolder) timelineHolder.innerHTML = '<p class="data-empty">The company event timeline is temporarily unavailable.</p>';
    const updated = $('#events-updated'); if (updated) updated.textContent = 'Provider unavailable';
  }
}

function renderOwnership(holder, data) {
  if (!holder) return;
  const state = { period: 'quarterly', view: 'snapshots' };
  const formatPercent = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : '—';
  const formatShares = value => Number.isFinite(Number(value)) ? whole(value) : '—';
  const hasSnapshots = (Array.isArray(data?.quarterly) && data.quarterly.length) || (Array.isArray(data?.yearly) && data.yearly.length);
  const hasTrades = Array.isArray(data?.trades) && data.trades.length;
  if (!hasSnapshots && !hasTrades) {
    holder.closest('.ownership-panel')?.remove();
    document.querySelector('.company-tabs a[href="#ownership"]')?.remove();
    return;
  }
  const draw = () => {
    const rows = Array.isArray(data[state.period]) ? data[state.period] : [];
    const trades = Array.isArray(data.trades) ? data.trades : [];
    const latest = rows[0] || {};
    const snapshotTable = rows.length ? `<div class="table-wrap ownership-table-wrap"><table class="ownership-table"><thead><tr><th>Period</th><th>Institutional shares</th><th>Reported value</th><th>Holders</th><th>Ownership %</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.period || row.date || '—')}</td><td>${formatShares(row.institutionalShares)}</td><td>${usd(row.reportedValue)}</td><td>${whole(row.holderCount)}</td><td>${formatPercent(row.ownershipPercent)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="data-empty">No institutional ownership snapshots were returned for this company.</p>';
    const tradeTable = trades.length ? `<div class="table-wrap ownership-table-wrap"><table class="ownership-table"><thead><tr><th>Date</th><th>Insider</th><th>Transaction</th><th>Shares</th><th>Value</th></tr></thead><tbody>${trades.map(row => `<tr><td>${escapeHtml(row.date || '—')}</td><td>${escapeHtml(row.name || 'Insider')}</td><td>${escapeHtml(row.type || 'Reported transaction')}</td><td>${formatShares(row.shares)}</td><td>${usd(row.value)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="data-empty">No recent insider transaction records were returned for this company.</p>';
    holder.innerHTML = `<div class="ownership-toolbar"><div class="ownership-switch"><button class="${state.period === 'quarterly' ? 'active' : ''}" data-ownership-period="quarterly">Quarterly</button><button class="${state.period === 'yearly' ? 'active' : ''}" data-ownership-period="yearly">Yearly</button></div><button class="ownership-trades ${state.view === 'trades' ? 'active' : ''}" data-ownership-view="trades">Trades <span>${trades.length}</span></button></div><div class="ownership-summary"><div><span>Institutional shares</span><b>${formatShares(latest.institutionalShares)}</b></div><div><span>Reported value</span><b>${usd(latest.reportedValue)}</b></div><div><span>Ownership reported</span><b>${formatPercent(latest.ownershipPercent)}</b></div><div><span>Holder count</span><b>${whole(latest.holderCount)}</b></div></div>${state.view === 'trades' ? tradeTable : snapshotTable}<p class="ownership-note">Institutional snapshots are grouped by reported period. Ownership percentages are shown only when explicitly reported by the provider; no estimates are invented.</p>`;
    holder.querySelectorAll('[data-ownership-period]').forEach(button => button.onclick = () => { state.period = button.dataset.ownershipPeriod; state.view = 'snapshots'; draw(); });
    holder.querySelector('[data-ownership-view]')?.addEventListener('click', () => { state.view = state.view === 'trades' ? 'snapshots' : 'trades'; draw(); });
  };
  draw();
}

hydrateCompanyExtras = function(ticker) {
  originalHydrateCompanyExtras(ticker);
  hydrateCompanyEarningsAndEvents(ticker);
  const holder = $('#company-ratios');
  const quarterlyHolder = $('#company-quarterly');
  const signalsHolder = $('#company-signals');
  const ownershipHolder = $('#company-ownership');
  if (!holder && !quarterlyHolder && !signalsHolder && !ownershipHolder) return;
  getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`)
    .then(data => {
      if (holder) renderFilteredRatioExplorer(holder, data.ratios || {});
      if (quarterlyHolder) { quarterlyHolder.innerHTML = quarterlyResultsTable(data.quarterlyIncome || []); setupQuarterlyDetails(quarterlyHolder); }
      renderCompanySignals(signalsHolder, data);
    })
    .catch(() => {
      if (holder) holder.innerHTML = '<p class="data-empty">Detailed ratios are temporarily unavailable for this company.</p>';
      if (quarterlyHolder) quarterlyHolder.innerHTML = '<p class="data-empty">Quarterly results are temporarily unavailable for this company.</p>';
      if (signalsHolder) signalsHolder.innerHTML = '<p class="signal-empty">Pros and cons are temporarily unavailable because reported company data could not be loaded.</p>';
    });
  if (ownershipHolder) getJson(`/data/ownership?symbol=${encodeURIComponent(ticker)}`).then(data => renderOwnership(ownershipHolder, data)).catch(() => { ownershipHolder.innerHTML = '<p class="data-empty">Shareholding data is temporarily unavailable for this company.</p>'; });
};

document.head.insertAdjacentHTML('beforeend', `<style>
  .company-overview-stack{display:grid;gap:14px;margin-bottom:16px}
  .overview-ratios{overflow:hidden}
  .ratio-filter-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 16px 14px;border-bottom:1px solid #2d395a}
  .ratio-category-filter{display:flex;gap:6px;flex-wrap:wrap}
  .ratio-category-filter button{border:1px solid #334163;border-radius:999px;background:#111a2e;color:#aebad3;padding:7px 10px;font:600 10px Inter;cursor:pointer}
  .ratio-category-filter button.active,.ratio-category-filter button:hover{background:#536cec;border-color:#7186ff;color:#fff}
  .ratio-filter-actions{display:flex;align-items:center;gap:10px}
  .ratio-hide{display:flex;align-items:center;gap:6px;color:#aebad3;font-size:10px;white-space:nowrap}
  .overview-ratios .ratio-explorer{grid-template-columns:repeat(4,minmax(0,1fr));padding-top:16px}
  @media(max-width:1100px){.overview-ratios .ratio-explorer{grid-template-columns:repeat(2,minmax(0,1fr))}.ratio-filter-bar{align-items:flex-start;flex-direction:column}.ratio-filter-actions{width:100%}}
  @media(max-width:650px){.overview-ratios .ratio-explorer{grid-template-columns:1fr}.ratio-filter-actions{align-items:flex-start;flex-direction:column}}
</style>`);

// Final live-data views. These override the early static prototypes above so
// every rendered summary uses the same server-normalised market data.
function legacyDashboardView() {
  const saved = watchlist.slice(0, 3).map(ticker => `<div class="idea company-row" data-stock="${escapeHtml(ticker)}" data-dashboard-watch="${escapeHtml(ticker)}">${companyLogo(ticker, ticker)}<div><b>${escapeHtml(ticker)}</b><small>Loading company and live price…</small></div><strong>Loading…</strong></div>`).join('');
  return `<div class="page"><section class="panel dashboard-hero"><p class="crumb">DOLLARDISHA TERMINAL · US EQUITIES</p><div><h1 class="page-title">Research US markets with <span>clarity.</span></h1><p class="sub">Live prices, deep company financials, SEC filings and market intelligence — built for Indian investors studying US equities.</p><div class="hero-actions"><button class="solid-btn" data-page="screener">Explore US stocks</button><button class="link-button" data-page="markets">View market pulse →</button></div></div><div class="hero-proof"><div><b>US</b><small>Equity coverage</small></div><div><b>Live</b><small>Quotes & charts</small></div><div><b>SEC</b><small>Official filings</small></div></div></section><div class="section-header"><div><p class="crumb">MARKET PULSE</p><h2>Major US stocks</h2></div><button class="link-button" data-page="markets">See full market →</button></div><section class="market-grid" id="market-cards">${['NVDA','MSFT','AAPL','GOOGL'].map(ticker => `<div class="market-card" data-market-ticker="${ticker}"><div class="market-card-company">${companyLogo(ticker, ticker)}<span>${ticker}</span></div><strong>Loading…</strong><b>Latest available quote</b></div>`).join('')}</section><section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>Research workflow</h2><p>Start with a question. Build your decision with evidence.</p></div></div><div class="workflow"><button data-page="screener"><b>1</b><span>Screen stocks<small>Filter the US equity universe</small></span></button><button data-page="markets"><b>2</b><span>Read market pulse<small>See leaders, laggards and indices</small></span></button><button data-page="research"><b>3</b><span>Study the filings<small>Open official SEC documents</small></span></button></div></div><div class="panel"><div class="panel-head"><div><h2>Your watchlist</h2><p>${watchlist.length ? `${watchlist.length} saved companies · live values` : 'No companies saved yet'}</p></div><button class="link-button" data-page="watchlist">Open</button></div>${saved || '<div class="watch-empty"><b>Your research list is waiting</b>Add companies from Market Scans or the Stock Screener.</div>'}</div></section></div>`;
}

// Dashboard research entry points. Each card is a complete keyboard-accessible
// destination, not a decorative container around a small link.
function dashboardInsightCards() {
  return `<section class="dashboard-insights" aria-label="Research tools">
    <article class="dashboard-insight" data-page="markets" aria-label="Open live market scans">
      <span class="insight-icon">↗</span><div><p class="crumb">FIND MOMENTUM</p><h3>Market scans</h3><p>Spot today’s leaders, laggards and unusual volume across the US universe.</p>
      <div class="insight-preview insight-preview-live"><span>Live leader</span><b id="dashboard-scan-symbol">Loading…</b><small id="dashboard-scan-change">Updating top gainers</small></div><span class="insight-cta">Open live scans →</span></div>
    </article>
    <article class="dashboard-insight" data-page="screener" aria-label="Open the US stock screener">
      <span class="insight-icon">⌕</span><div><p class="crumb">BUILD A VIEW</p><h3>Screen your way</h3><p>Combine valuation, growth and quality filters to create a focused shortlist.</p>
      <div class="insight-preview"><span>Ready to use</span><b>10 filters</b><small>Mega-cap · value · high ROE · dividend</small></div><span class="insight-cta">Build a screen →</span></div>
    </article>
    <article class="dashboard-insight" data-page="screener" aria-label="Choose a company for detailed research">
      <span class="insight-icon">▦</span><div><p class="crumb">GO DEEPER</p><h3>Company research</h3><p>Choose any active US company, then review its financials, ratios, filings and technicals.</p>
      <div class="insight-preview"><span>One research page</span><b>Price · EPS · P/E</b><small>Quarterly results · peers · SEC filings</small></div><span class="insight-cta">Choose a company →</span></div>
    </article>
    <article class="dashboard-insight" data-page="toolkit" aria-label="Open valuation and earnings toolkit">
      <span class="insight-icon">%</span><div><p class="crumb">TEST THE THESIS</p><h3>Valuation toolkit</h3><p>Model EPS growth and exit multiples, review upcoming earnings and save reusable cases.</p>
      <div class="insight-preview"><span>Scenario workspace</span><b>Growth · P/E · return</b><small>Saved cases · earnings calendar · saved screens</small></div><span class="insight-cta">Open toolkit →</span></div>
    </article>
  </section>`;
}

function dashboardQuickAccess() {
  return `<aside class="dashboard-quick-access" aria-label="Market updates">
    <div class="dashboard-quick-head"><p class="crumb">TODAY ON DOLLARDISHA</p><h2>Market updates</h2><p>Jump directly to the live research view you need.</p></div>
    <div class="dashboard-quick-list">
      <button type="button" data-page="markets"><span class="dashboard-quick-icon" aria-hidden="true">⌁</span><span><b>Market pulse</b><small>Leaders, laggards and global benchmarks</small></span><em>Live</em><i aria-hidden="true">›</i></button>
      <button type="button" data-page="latest-results"><span class="dashboard-quick-icon" aria-hidden="true">▥</span><span><b>Quarterly results</b><small>Latest reported sales, profit and EPS</small></span><em id="dashboard-results-count">Latest</em><i aria-hidden="true">›</i></button>
      <button type="button" data-page="toolkit" data-section="ipo-calendar"><span class="dashboard-quick-icon" aria-hidden="true">↗</span><span><b>Upcoming IPOs</b><small>Provider-reported US listing calendar</small></span><em id="dashboard-ipo-count">Loading</em><i aria-hidden="true">›</i></button>
    </div>
    <small class="dashboard-quick-note" id="dashboard-calendar-note">Calendar dates are provider reported and may change.</small>
  </aside>`;
}

// Preserve the original dashboard renderer for the enhanced hero below.
const baseDashboardView = dashboardView;

// Correctly replace the hero contents (rather than nesting a second copy of
// the hero) while preserving the original dashboard markup below it.
const dashboardViewBaseForLeaders = baseDashboardView;
dashboardView = function() {
  // Use the complete dashboard hero as the base. The early prototype above
  // starts with a generic page header, so the hero matcher cannot attach the
  // global-market panel and silently returns the compact dashboard instead.
  const html = legacyDashboardView();
  const polishedHtml = html
    .replace(/DOLLARDISHA TERMINAL[^<]*US EQUITIES/g, 'DOLLARDISHA TERMINAL · US EQUITY RESEARCH')
    .replace('DOLLARDISHA TERMINAL Â· US EQUITIES', 'DOLLARDISHA TERMINAL Â· US EQUITY RESEARCH')
    .replace('Research US markets with <span>clarity.</span>', 'A clearer way to research <span>US equities.</span>')
    .replace(/Live prices, deep company financials, SEC filings and market intelligence[^<]*Indian investors studying US equities\./, 'Track live prices, company financials, SEC filings and market trends in one focused workspace — built for Indian investors accessing US markets.')
    .replace('Explore US stocks', 'Explore US equities')
    .replace('View market pulse', 'View market overview')
    .replace('<b>US</b><small>Equity coverage</small>', '<b>US Markets</b><small>Equity coverage</small>')
    .replace('<b>Live</b><small>Quotes & charts</small>', '<b>Live data</b><small>Quotes & charts</small>')
    .replace('<b>SEC</b><small>Official filings</small>', '<b>SEC filings</b><small>Official disclosures</small>');
  const panel = '<aside class="market-leaders-panel" id="market-leaders-panel"><div class="market-leaders-head"><div><p class="crumb">GLOBAL MARKET PULSE</p><h2>Best-performing markets</h2><small class="market-leaders-subtitle">Compare country benchmarks across every available region.</small></div><small id="market-leaders-updated">Updating...</small></div><div class="market-periods" role="tablist" aria-label="Market performance period"><button type="button" class="selected" data-market-period="day">Day</button><button type="button" data-market-period="week">1W</button><button type="button" data-market-period="month">1M</button><button type="button" data-market-period="ytd">YTD</button><button type="button" data-market-period="3m">3M</button><button type="button" data-market-period="6m">6M</button><button type="button" data-market-period="year">1Y</button><button type="button" data-market-period="3y">3Y</button><button type="button" data-market-period="5y">5Y</button><button type="button" data-market-period="10y">10Y</button></div><div class="market-leader-toolbar"><div class="market-leader-mode"><button type="button" class="selected" data-market-direction="leaders">Leaders</button><button type="button" data-market-direction="laggards">Laggards</button></div><div class="market-filter-group"><select id="market-region-filter" aria-label="Filter by region"><option value="all">All regions</option><option>US</option><option>Europe</option><option>Asia</option><option>India</option><option>Americas</option><option>Asia-Pacific</option><option>Africa</option></select><select id="market-move-filter" aria-label="Filter by minimum move"><option value="0">Any move</option><option value="1">Move 1%+</option><option value="3">Move 3%+</option><option value="5">Move 5%+</option><option value="10">Move 10%+</option></select></div></div><div class="market-leaders-content"><div id="market-leaders-list" class="market-leaders-list"><div class="market-leader-loading">Loading regional performance...</div></div><div id="market-benchmark-details" class="market-benchmark-details"><p class="crumb">SELECT A REGION</p><strong>Benchmark details</strong><small>Click a market to see the country, exchange and benchmark behind the ranking.</small></div></div><button class="link-button market-leaders-link" data-page="markets">View market pulse →</button></aside>';
  const match = polishedHtml.match(/<section class="panel dashboard-hero">([\s\S]*?)<\/section><div class="section-header">/);
  if (!match) return polishedHtml;
  const insights = dashboardInsightCards();
  const hero = `<section class="panel dashboard-hero"><div class="dashboard-hero-layout">${dashboardQuickAccess()}${panel}</div></section><div class="section-header">`;
  return polishedHtml.replace(match[0], hero).replace('<section class="dashboard-grid">', `${insights}<section class="dashboard-grid">`);
};

let marketLeadersDirection = 'leaders';
async function hydrateMarketLeaders(period = 'day') {
  const holder = document.querySelector('#market-leaders-list');
  if (!holder) return;
  document.querySelectorAll('[data-market-period]').forEach(button => {
    button.classList.toggle('selected', button.dataset.marketPeriod === period);
    button.setAttribute('aria-selected', button.dataset.marketPeriod === period ? 'true' : 'false');
  });
  holder.innerHTML = '<div class="market-leader-loading">Loading regional performance...</div>';
  try {
    const data = await getJson(`/data/market-performance?period=${encodeURIComponent(period)}`, 60000);
    const regionFilter = document.querySelector('#market-region-filter')?.value || 'all';
    const moveFilter = Number(document.querySelector('#market-move-filter')?.value || 0);
    const rows = (data.regions || []).filter(row => {
      if (!row || !row.region || (regionFilter !== 'all' && row.region !== regionFilter)) return false;
      // Do not coerce a missing return to zero: Number(null) is 0 and used to
      // make unavailable regions look like flat, valid market observations.
      const change = scanNumber(row.change);
      if (change === null) return false;
      const inDirection = marketLeadersDirection === 'leaders' ? change >= 0 : change < 0;
      return inDirection && (!moveFilter || Math.abs(change) >= moveFilter);
    }).sort((a, b) => {
      const left = scanNumber(a.change); const right = scanNumber(b.change);
      return marketLeadersDirection === 'leaders' ? right - left : left - right;
    }).slice(0, 5);
    holder.innerHTML = rows.length ? rows.map((row, index) => {
      const change = scanNumber(row.change);
      const label = change === null ? 'Unavailable' : percent(change);
      const cagr = scanNumber(row.cagr);
      const trend = change === null ? '' : change >= 0 ? 'positive' : 'down';
      return `<button type="button" class="market-leader-row" data-market-region-row="${escapeHtml(row.region)}"><span class="market-leader-rank">${index + 1}</span><div><b>${escapeHtml(row.region)}</b><small>${row.breadth !== null && row.total ? `${row.breadth}/${row.total} rising` : 'Regional benchmark'} · CAGR ${cagr === null ? '—' : percent(cagr)}</small></div><strong class="${trend}">${label}</strong></button>`;
    }).join('') : '<div class="market-leader-loading">Market performance is temporarily unavailable.</div>';
    const details = document.querySelector('#market-benchmark-details');
    const showDetails = (region) => {
      const row = (data.regions || []).find(item => item.region === region);
      if (!details || !row) return;
      details.innerHTML = `<p class="crumb">${escapeHtml(row.region)} BENCHMARKS</p><strong>${escapeHtml(row.region)} market detail</strong><div class="market-benchmark-list">${(row.benchmarks || []).map(item => {
        const itemChange = scanNumber(item.change);
        const itemCagr = scanNumber(item.cagr);
        return `<div><span><b>${escapeHtml(item.country || item.name)}</b><small>${escapeHtml(item.name)} · ${escapeHtml(item.exchange || 'Global')}</small></span><strong class="${itemChange === null ? '' : itemChange >= 0 ? 'positive' : 'down'}"><em>${itemChange === null ? 'Unavailable' : percent(itemChange)}</em><small>CAGR ${itemCagr === null ? '—' : percent(itemCagr)}</small></strong></div>`;
      }).join('') || '<small>No benchmark detail is available for this region yet.</small>'}</div>`;
    };
    document.querySelectorAll('[data-market-region-row]').forEach(rowButton => rowButton.addEventListener('click', () => showDetails(rowButton.dataset.marketRegionRow)));
    if (rows[0]) showDetails(rows[0].region);
    if (details) {
      const allBenchmarks = (data.regions || [])
        .filter(item => item && item.region && (regionFilter === 'all' || item.region === regionFilter))
        .flatMap(item => (item.benchmarks || []).map(benchmark => ({ ...benchmark, region: item.region })));
      const rising = marketLeadersDirection === 'leaders';
      const matching = allBenchmarks
        .filter(item => {
          const change = scanNumber(item.change);
          return change !== null && (rising ? (moveFilter ? change >= moveFilter : change >= 0) : (moveFilter ? change <= -moveFilter : change < 0));
        })
        .sort((a, b) => {
          const left = scanNumber(a.change); const right = scanNumber(b.change);
          return rising ? right - left : left - right;
        })
        .slice(0, 8);
      details.innerHTML = `<p class="crumb">${rising ? 'RISING' : 'FALLING'} COUNTRIES</p><strong>${rising ? 'Country benchmarks rising' : 'Country benchmarks falling'}</strong><small>${rising ? 'Benchmarks with a positive return' : 'Benchmarks with a negative return'} for the selected period. Click a region to narrow the list.</small><div class="market-benchmark-list">${matching.map(item => {
        const itemChange = scanNumber(item.change);
        const itemCagr = scanNumber(item.cagr);
        return `<div><span><b>${escapeHtml(item.country || item.name)}</b><small>${escapeHtml(item.name)} · ${escapeHtml(item.region || 'Global')} · ${escapeHtml(item.exchange || 'Global')}</small></span><strong class="${itemChange >= 0 ? 'positive' : 'down'}"><em>${percent(itemChange)}</em><small>CAGR ${itemCagr === null ? '—' : percent(itemCagr)}</small></strong></div>`;
      }).join('') || '<small>No country benchmark matches this filter yet.</small>'}</div>`;
    }
    const updated = document.querySelector('#market-leaders-updated');
    if (updated) updated.textContent = data.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : 'Latest snapshot';
  } catch {
    holder.innerHTML = '<div class="market-leader-loading">Market performance is temporarily unavailable.</div>';
  }
}
function setupMarketLeaders() {
  document.querySelectorAll('[data-market-period]').forEach(button => {
    button.onclick = () => hydrateMarketLeaders(button.dataset.marketPeriod);
  });
  document.querySelectorAll('[data-market-direction]').forEach(button => {
    button.onclick = () => {
      marketLeadersDirection = button.dataset.marketDirection;
      document.querySelectorAll('[data-market-direction]').forEach(item => item.classList.toggle('selected', item.dataset.marketDirection === marketLeadersDirection));
      hydrateMarketLeaders(document.querySelector('[data-market-period].selected')?.dataset.marketPeriod || 'day');
    };
  });
  const refreshLeaders = () => hydrateMarketLeaders(document.querySelector('[data-market-period].selected')?.dataset.marketPeriod || 'day');
  const regionFilter = document.querySelector('#market-region-filter');
  const moveFilter = document.querySelector('#market-move-filter');
  if (regionFilter) regionFilter.onchange = refreshLeaders;
  if (moveFilter) moveFilter.onchange = refreshLeaders;
  hydrateMarketLeaders();
}

async function hydrateDashboard() {
  setupMarketLeaders();
  hydrateProviderStatus();
  const calendarTask = getJson('/data/calendar', 45000).then(data => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + 30);
    const inNextThirtyDays = row => {
      const date = new Date(`${String(row?.date || row?.reportDate || row?.filingDate || '').slice(0, 10)}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date >= today && date <= cutoff;
    };
    const earnings = (Array.isArray(data.earnings) ? data.earnings : []).filter(inNextThirtyDays);
    const ipos = (Array.isArray(data.ipos) ? data.ipos : []).filter(inNextThirtyDays);
    const ipoBadge = $('#dashboard-ipo-count');
    if (ipoBadge) ipoBadge.textContent = ipos.length ? `${ipos.length} upcoming` : 'View calendar';
    const note = $('#dashboard-calendar-note');
    if (note && data.updatedAt) note.textContent = `Provider-reported calendar · updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
  }).catch(() => {
    if ($('#dashboard-ipo-count')) $('#dashboard-ipo-count').textContent = 'Open calendar';
    if ($('#dashboard-calendar-note')) $('#dashboard-calendar-note').textContent = 'Calendar is temporarily unavailable; open the toolkit to retry.';
  });
  const insightTask = getJson('/data/market-scan?mode=gainers', 45000).then(rows => {
    const leader = Array.isArray(rows) ? rows.find(item => scanNumber(item.changesPercentage, item.changePercentage, item.change) !== null) : null;
    const symbol = $('#dashboard-scan-symbol');
    const change = $('#dashboard-scan-change');
    if (!symbol || !change) return;
    if (!leader) { symbol.textContent = 'Open the live table'; change.textContent = 'Gainers, losers and largest companies'; return; }
    const move = scanNumber(leader.changesPercentage, leader.changePercentage, leader.change);
    symbol.textContent = `${leader.symbol || leader.ticker || 'Leader'} ${move !== null ? percent(move) : ''}`.trim();
    change.textContent = leader.companyName || leader.name || 'Current top gainer';
  }).catch(() => {
    const symbol = $('#dashboard-scan-symbol');
    const change = $('#dashboard-scan-change');
    if (symbol) symbol.textContent = 'Open the live table';
    if (change) change.textContent = 'Gainers, losers and largest companies';
  });
  const quoteTask = getJson('/data/market', 45000).then(quotes => {
    const byTicker = new Map((quotes || []).map(quote => [String(quote.symbol || '').toUpperCase(), quote]));
    document.querySelectorAll('#market-cards .market-card').forEach(card => {
      const quote = byTicker.get(card.dataset.marketTicker) || {};
      const price = scanNumber(quote.price);
      const change = scanNumber(quote.changesPercentage, quote.changePercentage);
      card.querySelector('strong').textContent = price !== null ? `$${Number(price).toFixed(2)}` : 'Quote unavailable';
      card.classList.toggle('gain', change !== null && Number(change) >= 0);
      card.classList.toggle('loss', change !== null && Number(change) < 0);
      const note = card.querySelector('b');
      note.textContent = change !== null ? `${percent(change)} today` : 'Daily change not reported';
      note.className = change === null ? '' : Number(change) >= 0 ? 'positive' : 'down';
      let source = card.querySelector('.provider-source');
      if (!source) { source = document.createElement('small'); source.className = 'provider-source'; note.insertAdjacentElement('afterend', source); }
      source.textContent = providerLabel(quote.providers || quote.provider);
      source.title = 'Live quote provider(s) used for this card';
    });
  }).catch(() => document.querySelectorAll('#market-cards .market-card').forEach(card => {
    card.querySelector('strong').textContent = 'Quote unavailable';
    card.querySelector('b').textContent = 'Live feed is retrying';
  }));
  const watchTask = watchlist.length ? getJson(`/data/watchlist?symbols=${encodeURIComponent(watchlist.slice(0, 3).join(','))}`, 45000).then(rows => {
    const byTicker = new Map((rows || []).map(item => [String(item.symbol || item.ticker || '').toUpperCase(), item]));
    document.querySelectorAll('[data-dashboard-watch]').forEach(card => {
      const item = byTicker.get(card.dataset.dashboardWatch) || {};
      card.querySelector('b').textContent = item.companyName || item.name || card.dataset.dashboardWatch;
      card.querySelector('small').textContent = scanNumber(item.price) !== null ? `${card.dataset.dashboardWatch} · $${Number(item.price).toFixed(2)}` : `${card.dataset.dashboardWatch} · Quote unavailable`;
      const change = scanNumber(item.change, item.changesPercentage, item.changePercentage);
      const value = card.querySelector('strong');
      value.textContent = change !== null ? percent(change) : 'Not reported';
      value.className = change === null ? '' : Number(change) >= 0 ? 'positive' : 'down';
    });
  }).catch(() => document.querySelectorAll('[data-dashboard-watch] strong').forEach(value => { value.textContent = 'Retry'; })) : Promise.resolve();
  await Promise.allSettled([calendarTask, insightTask, quoteTask, watchTask]);
}

function legacyIndexView() {
  const equal = basket.symbols.length ? (100 / basket.symbols.length).toFixed(1) : '0.0';
  const legacyNames = legacyIndexNames;
  const visibleName = authSession?.user && legacyNames.has(String(basket.name || '').trim())
    ? accountDisplayName(authSession.user)
    : basket.name;
  const placeholders = basket.symbols.map(ticker => `<tr><td class="company">${companyIdentity(ticker, ticker, 'Loading company…')}</td><td colspan="3">Loading live values…</td><td>${equal}%</td><td><button data-remove-basket="${escapeHtml(ticker)}">Remove</button></td></tr>`).join('');
  return `<div class="page">${pageHeader('BUILD YOUR OWN BENCHMARK', 'Custom Index', 'Create a personal US-stock basket and monitor every holding with live market data.')}<section class="index-hero"><div><span>YOUR INDEX</span><h2>${escapeHtml(visibleName)}</h2><p>${basket.symbols.length} companies · Equal weight <b>${equal}%</b> each</p></div><div class="index-actions"><input id="basket-ticker" maxlength="10" placeholder="Add ticker, e.g. TSLA"><button id="basket-add" class="solid-btn">Add company</button></div></section><section class="index-lab-grid"><div class="panel"><div class="panel-head"><div><h2>Index holdings</h2><p id="basket-status">${basket.symbols.length ? 'Loading live holding values…' : 'Add tickers you want to study together.'}</p></div><button id="basket-rename" class="link-button">Rename</button></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Live price</th><th>Market cap</th><th>Today</th><th>Weight</th><th></th></tr></thead><tbody id="basket-body">${placeholders || '<tr><td colspan="6">Add a ticker above to create your index.</td></tr>'}</tbody></table></div></div><aside class="panel"><div class="panel-head"><div><h2>How to use it</h2><p>A research tool, not a portfolio tracker</p></div></div><div class="callout"><b>Compare ideas consistently</b>Build a theme, watchlist or personal benchmark, then review its holdings against broad US indices.</div></aside></section></div>`;
}

function setupIndex() {
  const save = () => { localStorage.setItem('dd-custom-index', JSON.stringify(basket)); queueResearchStateSync(); };
  const nameInput = document.createElement('input');
  const nameSave = document.createElement('button');
  const namePanel = document.createElement('section');
  if (!indexNameConfirmed) {
    namePanel.className = 'panel index-name-setup';
    namePanel.innerHTML = '<p class="crumb">ONE-TIME SETUP</p><h2>Name your index</h2><p>Give this basket a name before adding companies. You can change it later.</p>';
    const form = document.createElement('div');
    form.className = 'index-name-form';
    nameInput.id = 'basket-name-input';
    nameInput.maxLength = 60;
    nameInput.placeholder = 'e.g. Long-term compounders';
    nameSave.type = 'button';
    nameSave.className = 'solid-btn';
    nameSave.textContent = 'Save index name';
    form.append(nameInput, nameSave);
    namePanel.appendChild(form);
    document.querySelector('.index-hero')?.before(namePanel);
    const ticker = $('#basket-ticker');
    const add = $('#basket-add');
    if (ticker) ticker.disabled = true;
    if (add) add.disabled = true;
    const saveIndexName = () => {
      const name = nameInput.value.trim();
      if (name.length < 2) {
        nameInput.setCustomValidity('Enter an index name with at least 2 characters.');
        nameInput.reportValidity();
        return;
      }
      nameInput.setCustomValidity('');
      basket.name = name.slice(0, 60);
      indexNameConfirmed = true;
      try { localStorage.setItem('dd-custom-index-name-set', '1'); } catch {}
      save();
      render();
    };
    nameSave.onclick = saveIndexName;
    nameInput.onkeydown = event => { if (event.key === 'Enter') saveIndexName(); };
  }
  const tickerInput = $('#basket-ticker');
  let selectedTicker = '';
  let searchTimer;
  let searchRequest = 0;
  const results = document.createElement('div');
  results.className = 'basket-search-results';
  results.hidden = true;
  if (tickerInput) {
    tickerInput.setAttribute('autocomplete', 'off');
    tickerInput.setAttribute('placeholder', 'Search a NASDAQ company, e.g. TSLA');
    const searchWrap = document.createElement('div');
    searchWrap.className = 'basket-search';
    tickerInput.parentElement?.insertBefore(searchWrap, tickerInput);
    searchWrap.appendChild(tickerInput);
    searchWrap.appendChild(results);
    tickerInput.addEventListener('input', () => {
      selectedTicker = '';
      clearTimeout(searchTimer);
      const query = tickerInput.value.trim();
      if (query.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        const requestId = ++searchRequest;
        results.hidden = false;
        results.innerHTML = '<div class="basket-search-loading">Searching NASDAQ companies…</div>';
        try {
          const matches = await getJson(`/data/search?q=${encodeURIComponent(query)}`, 15000);
          if (requestId !== searchRequest) return;
          const list = Array.isArray(matches) ? matches.slice(0, 8) : [];
          const symbols = list.map(item => item.symbol || item.ticker).filter(Boolean);
          const liveRows = symbols.length ? await getJson(`/data/watchlist?symbols=${encodeURIComponent(symbols.join(','))}`, 15000).catch(() => []) : [];
          const liveBySymbol = new Map((Array.isArray(liveRows) ? liveRows : []).map(item => [String(item.symbol || item.ticker || '').toUpperCase(), item]));
          results.innerHTML = list.length ? list.map(item => {
            const symbol = item.symbol || item.ticker || '';
            const name = item.name || item.companyName || symbol;
            const venue = item.exchange || item.exchangeShortName || item.country || 'US listing';
            const live = liveBySymbol.get(String(symbol).toUpperCase()) || {};
            const price = scanNumber(live.price);
            const change = scanNumber(live.change, live.changesPercentage, live.changePercentage);
            const quote = price !== null ? `$${Number(price).toFixed(2)}${change !== null ? ` · ${percent(change)}` : ''}` : 'Quote unavailable';
            return `<button type="button" class="basket-search-item" data-basket-symbol="${escapeHtml(symbol)}">${companyLogo(symbol, name, 'small')}<b>${escapeHtml(symbol)}</b><span>${escapeHtml(name)} · ${escapeHtml(venue)} · <strong>${escapeHtml(quote)}</strong></span></button>`;
          }).join('') : '<div class="basket-search-loading">No matching NASDAQ company found.</div>';
          results.querySelectorAll('[data-basket-symbol]').forEach(button => button.onclick = () => {
            selectedTicker = button.dataset.basketSymbol.toUpperCase();
            tickerInput.value = selectedTicker;
            results.hidden = true;
            tickerInput.focus();
          });
        } catch { results.innerHTML = '<div class="basket-search-loading">Directory unavailable. Enter a ticker manually.</div>'; }
      }, 220);
    });
    document.addEventListener('click', event => { if (!tickerInput.contains(event.target) && !results.contains(event.target)) results.hidden = true; });
  }
  const wireRemovals = () => document.querySelectorAll('[data-remove-basket]').forEach(button => button.onclick = event => {
    event.stopPropagation();
    basket.symbols = basket.symbols.filter(ticker => ticker !== button.dataset.removeBasket);
    save();
    render();
  });
  $('#basket-add').onclick = () => {
    const ticker = (selectedTicker || $('#basket-ticker').value.trim()).toUpperCase();
    if (/^[A-Z.]{1,10}$/.test(ticker) && !basket.symbols.includes(ticker)) { basket.symbols.push(ticker); save(); render(); }
  };
  $('#basket-rename').onclick = () => { const name = prompt('Name your index', basket.name); if (name?.trim()) { basket.name = name.trim(); save(); render(); } };
  wireRemovals();
  if (!basket.symbols.length) return;
  getJson(`/data/watchlist?symbols=${encodeURIComponent(basket.symbols.slice(0, 30).join(','))}`, 45000).then(rows => {
    const holder = $('#basket-body');
    if (!holder || page !== 'indexlab') return;
    const equal = (100 / basket.symbols.length).toFixed(1);
    const byTicker = new Map((rows || []).map(item => [String(item.symbol || item.ticker || '').toUpperCase(), item]));
    holder.innerHTML = basket.symbols.map(ticker => {
      const item = byTicker.get(ticker) || { symbol:ticker, companyName:ticker };
      const change = scanNumber(item.change, item.changesPercentage, item.changePercentage);
      return `<tr class="company-row" data-stock="${escapeHtml(ticker)}"><td class="company">${companyIdentity(ticker, item.companyName || ticker)}</td><td>${scanNumber(item.price) !== null ? `$${Number(item.price).toFixed(2)}` : 'Quote unavailable'}</td><td>${scanNumber(item.marketCap) !== null ? money(item.marketCap) : 'Not reported'}</td><td class="${change === null ? '' : Number(change) >= 0 ? 'positive' : 'down'}">${change !== null ? percent(change) : 'Not reported'}</td><td>${equal}%</td><td><button data-remove-basket="${escapeHtml(ticker)}">Remove</button></td></tr>`;
    }).join('');
    $('#basket-status').textContent = `Live values updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    wireCommon();
    wireRemovals();
  }).catch(() => { const status = $('#basket-status'); if (status) status.textContent = 'Live holding values could not load. Reopen this page to retry.'; });
}

function setAuthMessage(message = '', kind = '') {
  const holder = $('#auth-message');
  if (!holder) return;
  holder.textContent = message;
  holder.className = `auth-message${kind ? ` ${kind}` : ''}`;
}

function friendlyAuthError(error) {
  const raw = String(error?.message || error?.error_description || error || 'Could not complete that request.');
  if (/invalid login credentials/i.test(raw)) return 'Email or password is incorrect. If you just created the account, confirm your email first.';
  if (/email not confirmed/i.test(raw)) return 'Please confirm your email address, then try logging in again.';
  if (/user already registered|already been registered|already exists/i.test(raw)) return 'An account with this email already exists. Switch to Log in, or use Forgot password.';
  if (/password.*(at least|characters)|weak password|password should be/i.test(raw)) return 'Choose a stronger password with at least 8 characters.';
  if (/rate limit|too many requests/i.test(raw)) return 'Too many attempts. Please wait a few minutes and try again.';
  if (/invalid email/i.test(raw)) return 'Enter a valid email address.';
  if (/email address not authorized|not authorized/i.test(raw)) return 'Supabase email delivery is still in test mode. Add this address to your Supabase team, or configure a real SMTP provider before sending confirmations.';
  if (/smtp|mail.*send|email.*send|sending.*email/i.test(raw)) return 'Supabase could not send the confirmation email. Check Authentication â†’ SMTP Settings and use a real SMTP host, username and password.';
  if (/provider is not enabled|unsupported provider/i.test(raw)) return 'Google sign-in is not enabled in Supabase yet. Enable Google under Authentication → Providers.';
  if (/redirect|redirect_uri|site url|not allowed/i.test(raw)) return `This website URL is not approved for sign-in yet. Add ${window.location.origin} to Supabase Authentication → URL Configuration.`;
  if (/unable to exchange external code|external code/i.test(raw)) return 'Google returned an invalid sign-in response. In Supabase, check the Google Client ID/secret and make sure the callback URL is configured exactly.';
  if (/pkce|code verifier|exchange/i.test(raw)) return 'The sign-in callback expired. Close this window, reopen Log in, and try again.';
  if (/network|fetch|failed to fetch|load failed/i.test(raw)) return 'The sign-in service could not be reached. Check your connection and try again.';
  return raw;
}

function setAuthBusy(busy) {
  ['#auth-submit', '#auth-google', '#auth-magic', '#auth-forgot', '#auth-signout'].forEach(selector => {
    const control = $(selector);
    if (control) control.disabled = busy;
  });
}

function setAuthMode(mode = 'login') {
  authMode = mode;
  // Email/password registration is intentionally disabled. Google OAuth is
  // the only account-creation path; keep recovery available for existing
  // email accounts.
  if (mode === 'signup') mode = 'login';
  authMode = mode;
  const recovery = mode === 'recovery';
  const signup = false;
  const authDialog = document.querySelector('.auth-dialog');
  if (authDialog) authDialog.classList.toggle('auth-recovery', recovery);
  // Google is the only visible account entry point. Keep the email form
  // available internally for password recovery, but do not show a second
  // sign-in path in the normal auth dialog.
  $('#auth-tabs').hidden = true;
  $('#auth-name-field').hidden = !signup;
  $('#auth-email-field').hidden = recovery;
  $('#auth-password-field').hidden = recovery;
  $('#auth-email').required = !recovery;
  $('#auth-password').required = !recovery;
  $('#auth-secondary-actions').hidden = true;
  const confirmationActions = $('#auth-confirmation-actions');
  if (confirmationActions) confirmationActions.hidden = true;
  const signupNote = $('#auth-signup-note');
  if (signupNote) signupNote.hidden = !signup;
  $('#auth-google').hidden = recovery;
  document.querySelector('.auth-divider').hidden = true;
  $('#auth-form').hidden = !recovery;
  document.querySelectorAll('[data-auth-view]').forEach(button => button.classList.toggle('active', button.dataset.authView === mode));
  $('#auth-title').textContent = recovery ? 'Choose a new password' : 'Sign in to DollarDisha';
  $('#auth-description').textContent = recovery ? 'Enter a secure new password for your DollarDisha account.' : signup ? 'Save your research identity and access personalised features.' : 'Use Google to create or access your DollarDisha research account.';
  $('#auth-submit').textContent = recovery ? 'Update password' : signup ? 'Create account' : 'Log in';
  $('#auth-password').autocomplete = recovery ? 'new-password' : signup ? 'new-password' : 'current-password';
  setAuthMessage();
}

function accountDisplayName(user) {
  const metadata = user?.user_metadata || {};
  return String(metadata.full_name || metadata.name || metadata.preferred_username || user?.email?.split('@')[0] || 'Account').trim() || 'Account';
}
function syncPersonalIndexName(user) {
  if (!user) return false;
  const name = accountDisplayName(user);
  const legacyNames = new Set(['Shiva', 'DollarDisha', 'DollarDisha Research 10']);
  if (!name || !legacyNames.has(String(basket.name || '').trim())) return false;
  basket.name = name;
  try { localStorage.setItem('dd-custom-index', JSON.stringify(basket)); } catch {}
  return true;
}
function updateAuthUI(session) {
  authSession = session || null;
  const user = authSession?.user;
  const indexNameChanged = syncPersonalIndexName(user);
  const button = $('#account-button');
  if (!button) return;
  const email = user?.email || '';
  const displayName = accountDisplayName(user);
  const label = button.querySelector('.account-label');
  const avatar = button.querySelector('.account-avatar');
  const firstName = displayName.trim().split(/\s+/)[0] || 'Account';
  if (label) label.textContent = user ? firstName : 'Log in';
  if (avatar) {
    if (user) {
      avatar.classList.remove('account-brand-mark');
      avatar.textContent = firstName.slice(0, 1).toUpperCase();
    } else {
      avatar.classList.add('account-brand-mark');
      avatar.innerHTML = '<img src="/assets/dollardisha-app-icon.png" alt="">';
    }
  }
  button.title = user ? `Signed in as ${email || displayName}` : 'Log in to DollarDisha';
  button.setAttribute('aria-label', user ? `Account: ${email || displayName}` : 'Log in to DollarDisha');
  button.classList.toggle('signed-in', Boolean(user));
  if (user) syncResearchState(user);
  else syncedResearchUser = null;
  const signedOut = $('#auth-signed-out');
  const signedIn = $('#auth-signed-in');
  if (signedOut) signedOut.hidden = Boolean(user);
  if (signedIn) signedIn.hidden = !user;
  if (user) {
    const profileEmail = $('#auth-profile-email');
    const profileAvatar = $('#auth-profile-avatar');
    if (profileEmail) profileEmail.textContent = email || displayName;
    if (profileAvatar) profileAvatar.textContent = firstName.slice(0, 1).toUpperCase();
  }
  if (indexNameChanged && page === 'indexlab') render();
}

function openAuth(mode = 'login') {
  const modal = $('#auth-modal');
  if (!modal) return;
  updateAuthUI(authSession);
  if (!authSession?.user) setAuthMode(mode);
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => (authSession?.user ? $('#auth-signout') : mode === 'recovery' ? $('#auth-password') : $('#auth-google'))?.focus(), 30);
}

function closeAuth() {
  const modal = $('#auth-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
  setAuthMessage();
}

async function setupAuth() {
  const accountButton = $('#account-button');
  const modal = $('#auth-modal');
  if (!accountButton || !modal) return;

  accountButton.onclick = () => openAuth('login');
  $('#auth-close').onclick = closeAuth;
  modal.onclick = event => { if (event.target === modal) closeAuth(); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) closeAuth(); });
  document.querySelectorAll('[data-auth-view]').forEach(button => button.onclick = () => setAuthMode('login'));

  let config;
  try { config = await getJson('/data/auth-config'); }
  catch { config = null; }
  if (!config?.enabled || !window.supabase?.createClient) {
    const reason = !window.supabase?.createClient
      ? 'The sign-in library did not load. Refresh the page and try again.'
      : config?.reason || `Sign-in is not connected on this deployment. Add SUPABASE_URL and the Supabase publishable key (sb_publishable_…) in Render, then redeploy. Current site: ${window.location.origin}`;
    accountButton.onclick = () => { openAuth('login'); setAuthMessage(reason, 'error'); setAuthBusy(false); };
    setAuthBusy(false);
    return;
  }

  authClient = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:false, flowType:'pkce' }
  });

  // Keep the callback on the exact origin that started OAuth. PKCE stores its
  // verifier per origin, so forcing www/apex/Render to another host loses it.
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const callbackParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const recoveryReturn = callbackParams.get('type') === 'recovery' || hashParams.get('type') === 'recovery';
  const confirmationReturn = hashParams.get('type') === 'signup' || callbackParams.get('type') === 'signup';
  const callbackUrl = new URL(window.location.href);
  const callbackCode = callbackUrl.searchParams.get('code');
  const hashAccessToken = hashParams.get('access_token');
  const hashRefreshToken = hashParams.get('refresh_token');
  let callbackError = callbackUrl.searchParams.get('error_description') || callbackUrl.searchParams.get('error') || hashParams.get('error_description') || hashParams.get('error') || '';
  let initialSession = null;
  if (callbackCode) {
    try {
      const { data, error } = await authClient.auth.exchangeCodeForSession(callbackCode);
      initialSession = data?.session || null;
      if (error) callbackError = error.message || 'The sign-in callback could not be completed.';
    } catch (error) {
      callbackError = error?.message || 'The sign-in callback could not be completed.';
    }
  }
  // Email confirmation links return access and refresh tokens in the URL hash
  // when the Supabase client is configured with detectSessionInUrl disabled.
  // Store that session explicitly, then remove the tokens from the address bar.
  if (!callbackCode && hashAccessToken && hashRefreshToken && !callbackError) {
    try {
      const { data, error } = await authClient.auth.setSession({ access_token: hashAccessToken, refresh_token: hashRefreshToken });
      initialSession = data?.session || null;
      if (error) callbackError = error.message || 'Your email was confirmed, but the session could not be started.';
    } catch (error) {
      callbackError = error?.message || 'Your email was confirmed, but the session could not be started.';
    }
  }
  for (let attempt = 0; attempt < 8 && !initialSession; attempt += 1) {
    try {
      const { data } = await authClient.auth.getSession();
      initialSession = data?.session || null;
    } catch (error) { console.warn(`Could not read account session: ${error.message}`); }
    if (!initialSession && attempt < 7) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (callbackCode || hashAccessToken || callbackError) {
    if (callbackCode && !initialSession && !callbackError) {
      callbackError = 'The sign-in callback could not be completed. Please start Google sign-in again.';
    }
    callbackUrl.searchParams.delete('code');
    callbackUrl.searchParams.delete('error');
    callbackUrl.searchParams.delete('error_code');
    callbackUrl.searchParams.delete('error_description');
    if (hashAccessToken || callbackError) callbackUrl.hash = '';
    window.history.replaceState({}, document.title, `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
  }
  updateAuthUI(initialSession);
  if (callbackError && !initialSession) {
    openAuth('login');
    setAuthMessage(friendlyAuthError(callbackError), 'error');
  }
  if (recoveryReturn && initialSession) {
    setAuthMode('recovery');
    openAuth('recovery');
  } else if (confirmationReturn && initialSession) {
    // The confirmation link has completed account creation. Keep the user on
    // the site and let the normal account button reflect the signed-in state.
    setAuthMessage('Email confirmed. Your DollarDisha account is ready.', 'success');
  }

  authClient.auth.onAuthStateChange((event, session) => {
    updateAuthUI(session);
    if (event === 'PASSWORD_RECOVERY') {
      setAuthMode('recovery');
      openAuth('recovery');
    } else if (event === 'SIGNED_IN' && !modal.hidden && authMode !== 'recovery') {
      setAuthMessage('You are logged in.', 'success');
      setTimeout(closeAuth, 450);
    }
  });

  $('#auth-form').onsubmit = async event => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    try {
      if (authMode === 'recovery') {
        const { error } = await authClient.auth.updateUser({ password });
        if (error) throw error;
        setAuthMessage('Password updated. You are now logged in.', 'success');
        setTimeout(closeAuth, 700);
      } else if (authMode === 'signup') {
        const fullName = $('#auth-name').value.trim();
        const { data, error } = await authClient.auth.signUp({ email, password, options:{ data:{ full_name:fullName }, emailRedirectTo:redirectTo } });
        if (error) throw error;
        if (data.session) {
          updateAuthUI(data.session);
          setAuthMessage('Account created. You are now logged in.', 'success');
        } else {
          const confirmationActions = $('#auth-confirmation-actions');
          if (confirmationActions) confirmationActions.hidden = false;
          setAuthMessage('Account created. Check your email (including spam) to confirm it, then use Log in.', 'success');
        }
      } else {
        const { data, error } = await authClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        updateAuthUI(data.session);
      }
    } catch (error) { setAuthMessage(friendlyAuthError(error), 'error'); }
    finally { setAuthBusy(false); }
  };

  $('#auth-google').onclick = async () => {
    setAuthBusy(true);
    setAuthMessage();
    const { error } = await authClient.auth.signInWithOAuth({ provider:'google', options:{ redirectTo } });
    if (error) { setAuthMessage(friendlyAuthError(error), 'error'); setAuthBusy(false); }
  };

  $('#auth-magic').onclick = async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { $('#auth-email').focus(); setAuthMessage('Enter your email address first.', 'error'); return; }
    setAuthBusy(true);
    const { error } = await authClient.auth.signInWithOtp({ email, options:{ emailRedirectTo:redirectTo, shouldCreateUser:false } });
    setAuthMessage(error ? friendlyAuthError(error) : 'Login link sent. Check your email.', error ? 'error' : 'success');
    setAuthBusy(false);
  };

  $('#auth-resend').onclick = async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { $('#auth-email').focus(); setAuthMessage('Enter your email address first.', 'error'); return; }
    setAuthBusy(true);
    const { error } = await authClient.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectTo } });
    setAuthMessage(error ? friendlyAuthError(error) : 'Confirmation email sent again. Check your inbox and spam folder.', error ? 'error' : 'success');
    setAuthBusy(false);
  };

  $('#auth-forgot').onclick = async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { $('#auth-email').focus(); setAuthMessage('Enter your email address first.', 'error'); return; }
    setAuthBusy(true);
    const { error } = await authClient.auth.resetPasswordForEmail(email, { redirectTo });
    setAuthMessage(error ? friendlyAuthError(error) : 'Password reset email sent.', error ? 'error' : 'success');
    setAuthBusy(false);
  };

  $('#auth-signout').onclick = async () => {
    setAuthBusy(true);
    const { error } = await authClient.auth.signOut();
    if (error) setAuthMessage(friendlyAuthError(error), 'error');
    else { updateAuthUI(null); closeAuth(); }
    setAuthBusy(false);
  };
}

// Chart enhancement: expose calculated moving averages and reported earnings
// beside the graph. The provider's daily history is the source of truth for
// both DMA lines and the values shown in this strip.
var companyChartMetrics = { ticker:null, pe:null, eps:null, loading:false };
function chartMetricValue(value, suffix) { return Number.isFinite(Number(value)) ? `${Number(value).toLocaleString('en-US', { maximumFractionDigits:2 })}${suffix || ''}` : 'Unavailable'; }
function hydrateChartMetrics(ticker) {
  if (companyChartMetrics.ticker === ticker || companyChartMetrics.loading) return;
  companyChartMetrics = { ticker, pe:null, eps:null, loading:true };
  getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`).then(data => {
    const ratios = data.ratios || {};
    const latest = (data.quarterlyIncome || [])[0] || (data.income || [])[0] || {};
    companyChartMetrics.pe = ratios.peRatioTTM;
    companyChartMetrics.eps = latest.epsdiluted ?? latest.epsDiluted ?? latest.eps;
    companyChartMetrics.loading = false;
    const holder = $('#company-chart');
    if (!holder || page !== ticker) return;
    const pe = holder.querySelector('[data-chart-stat="pe"]');
    const eps = holder.querySelector('[data-chart-stat="eps"]');
    if (pe) pe.textContent = chartMetricValue(companyChartMetrics.pe, 'x');
    if (eps) eps.textContent = chartMetricValue(companyChartMetrics.eps, ' USD');
  }).catch(() => { companyChartMetrics.loading = false; });
}
function drawCompanyChart(values) {
  if (!values.length) return '<p class="data-empty">Price history is unavailable.</p>';
  hydrateChartMetrics(page);
  const closes = values.map(item => Number(item.close));
  const supplied50 = values.map(item => Number.isFinite(Number(item.ma50)) ? Number(item.ma50) : null);
  const supplied200 = values.map(item => Number.isFinite(Number(item.ma200)) ? Number(item.ma200) : null);
  const ma50 = supplied50.some(value => value !== null) ? supplied50 : movingAverage(closes, 50);
  const ma200 = supplied200.some(value => value !== null) ? supplied200 : movingAverage(closes, 200);
  const latest50 = ma50[ma50.length - 1];
  const latest200 = ma200[ma200.length - 1];
  const plotted = closes.concat(ma50.filter(value => value != null), ma200.filter(value => value != null));
  const max = Math.max(...plotted); const min = Math.min(...plotted);
  const scaleX = index => 28 + (index / Math.max(values.length - 1, 1)) * 744;
  const scaleY = value => 174 - ((value - min) / Math.max(max - min, 0.01)) * 135;
  const pathFor = series => series.map((value, index) => value == null ? '' : `${index && series[index - 1] != null ? 'L' : 'M'} ${scaleX(index).toFixed(1)} ${scaleY(value).toFixed(1)}`).join(' ');
  const maxVolume = Math.max(...values.map(item => Number(item.volume || 0)), 1);
  const bars = companyChartOptions.volume ? values.map((item, index) => `<rect x="${scaleX(index) - 1.2}" y="${(174 - (Number(item.volume || 0) / maxVolume) * 42).toFixed(1)}" width="2.4" height="${((Number(item.volume || 0) / maxVolume) * 42).toFixed(1)}"/>`).join('') : '';
  setTimeout(() => document.querySelectorAll('[data-chart-points],[data-chart-toggle]').forEach(button => button.onclick = async () => {
    if (button.dataset.chartPoints) companyChartOptions.points = Number(button.dataset.chartPoints);
    if (button.dataset.chartToggle) companyChartOptions[button.dataset.chartToggle] = !companyChartOptions[button.dataset.chartToggle];
    const holder = $('#company-chart'); holder.innerHTML = '<p class="data-empty">Loading chart…</p>';
    try { const chart = await getJson(`/data/chart?symbol=${encodeURIComponent(page)}&points=${companyChartOptions.points}`); holder.innerHTML = drawCompanyChart(chart.values || []); }
    catch { holder.innerHTML = '<p class="data-empty">Price history is unavailable.</p>'; }
  }), 0);
  const stats = [['Latest close', chartMetricValue(closes[closes.length - 1], ' USD'), 'close'], ['50 DMA', chartMetricValue(latest50, ' USD'), 'ma50'], ['200 DMA', chartMetricValue(latest200, ' USD'), 'ma200'], ['P/E (TTM)', chartMetricValue(companyChartMetrics.pe, 'x'), 'pe'], ['EPS (latest)', chartMetricValue(companyChartMetrics.eps, ' USD'), 'eps']];
  const averageStatus = latest200 == null ? '200 DMA needs at least 200 trading sessions.' : `As of ${values[values.length - 1].date}, based on daily closes.`;
  return `<div class="chart-live-heading"><div><b>Live technicals</b><span>Daily close with moving-average trend</span></div><span class="chart-live-badge"><i></i> Feed connected</span></div><div class="chart-live-stats">${stats.map(([label,value,key]) => `<div class="chart-stat-${key}"><span>${label}</span><b${key === 'pe' || key === 'eps' ? ` data-chart-stat="${key}"` : ''}>${value}</b></div>`).join('')}</div><p class="chart-data-note">${averageStatus} DMA values update when the latest daily market candle is available. Intraday quotes do not create a partial DMA.</p><div class="chart-controls"><div>${[[22,'1M'],[130,'6M'],[260,'1Y'],[780,'3Y'],[1300,'5Y'],[2600,'10Y']].map(([points,label]) => `<button class="${companyChartOptions.points === points ? 'selected' : ''}" data-chart-points="${points}">${label}</button>`).join('')}</div><div><button class="${companyChartOptions.ma50 ? 'selected' : ''}" data-chart-toggle="ma50">50 DMA</button><button class="${companyChartOptions.ma200 ? 'selected' : ''}" data-chart-toggle="ma200">200 DMA</button><button class="${companyChartOptions.volume ? 'selected' : ''}" data-chart-toggle="volume">Volume</button></div></div><svg viewBox="0 0 800 200" role="img" aria-label="Historical price, moving averages and volume chart"><path class="chart-grid" d="M28 30H772M28 78H772M28 126H772M28 174H772"/><g class="chart-volume">${bars}</g><path class="chart-line" d="${pathFor(closes)}"/>${companyChartOptions.ma50 ? `<path class="chart-ma50" d="${pathFor(ma50)}"/>` : ''}${companyChartOptions.ma200 ? `<path class="chart-ma200" d="${pathFor(ma200)}"/>` : ''}<text x="28" y="193">${escapeHtml(values[0].date)}</text><text x="676" y="193">${escapeHtml(values[values.length - 1].date)}</text><text x="720" y="30">${max.toFixed(2)}</text><text x="720" y="174">${min.toFixed(2)}</text></svg><div class="chart-legend"><span class="legend-price">Price</span>${companyChartOptions.ma50 ? '<span class="legend-ma50">50 DMA</span>' : ''}${companyChartOptions.ma200 ? '<span class="legend-ma200">200 DMA</span>' : ''}${companyChartOptions.volume ? '<span class="legend-volume">Volume</span>' : ''}</div>`;
}

function placeChartTooltip(target, tooltip, holder) {
  if (!target || !tooltip || !holder) return;
  const point = target.getBoundingClientRect();
  const box = holder.getBoundingClientRect();
  const left = point.left - box.left + point.width / 2;
  const top = point.top - box.top - tooltip.offsetHeight - 10;
  tooltip.style.left = `${Math.max(12, Math.min(box.width - tooltip.offsetWidth - 12, left))}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

const baseDrawCompanyChart = drawCompanyChart;
drawCompanyChart = function(values) {
  const html = baseDrawCompanyChart(values);
  if (!values.length || !html.includes('</svg>')) return html;
  const step = 744 / Math.max(values.length - 1, 1);
  const targets = values.map((item, index) => `<rect class="chart-hover-target" tabindex="0" data-chart-index="${index}" x="${(28 + index * step - Math.max(step / 2, 2)).toFixed(1)}" y="20" width="${Math.max(step, 4).toFixed(1)}" height="158"/>`).join('');
  const withTargets = html.replace('</svg>', `<g class="chart-hover-points" aria-label="Historical data points">${targets}</g></svg>`);
  setTimeout(() => {
    const holder = $('#company-chart');
    const tooltip = holder?.querySelector('[data-chart-tooltip]');
    if (!holder || !tooltip) return;
    const show = target => {
      const index = Number(target.dataset.chartIndex);
      const item = values[index];
      if (!item) return;
      const fmt = (value, suffix = '') => Number.isFinite(Number(value)) ? `${Number(value).toLocaleString('en-US', { maximumFractionDigits:2 })}${suffix}` : 'Unavailable';
      const closes = values.map(row => Number(row.close));
      const dma = (window, offset) => offset < window - 1 ? null : closes.slice(offset - window + 1, offset + 1).reduce((sum, value) => sum + value, 0) / window;
      tooltip.innerHTML = `<b>${escapeHtml(item.date || 'Historical point')}</b><span>Price: <strong>${fmt(item.close, ' USD')}</strong></span><span>50 DMA: <strong>${fmt(item.ma50 ?? dma(50, index), ' USD')}</strong></span><span>200 DMA: <strong>${fmt(item.ma200 ?? dma(200, index), ' USD')}</strong></span><span>P/E: <strong>${fmt(item.pe, 'x')}</strong></span><span>EPS: <strong>${fmt(item.eps, ' USD')}</strong></span>`;
      tooltip.hidden = false;
      requestAnimationFrame(() => placeChartTooltip(target, tooltip, holder));
    };
    holder.querySelectorAll('.chart-hover-target').forEach(target => {
      target.addEventListener('mouseenter', () => show(target));
      target.addEventListener('focus', () => show(target));
      target.addEventListener('mouseleave', () => { tooltip.hidden = true; });
      target.addEventListener('blur', () => { tooltip.hidden = true; });
    });
  }, 0);
  return withTargets;
};

// Add a persistent tooltip host after the chart markup is created.
const chartWithTooltip = drawCompanyChart;
drawCompanyChart = function(values) {
  const output = chartWithTooltip(values);
  return output.includes('data-chart-tooltip') ? output : `${output}<div class="chart-hover-tooltip" data-chart-tooltip hidden>Hover over the chart to inspect a historical point.</div>`;
};

// Valuation chart modes: keep the price chart as the default, but let a
// researcher switch to the reported P/E or EPS series without leaving the
// company page. EPS growth is calculated only when two positive reported EPS
// observations are available.
let companyChartMode = 'price';
const chartModeButtons = active => `<div class="chart-mode-switch" role="group" aria-label="Chart metric"><button type="button" data-chart-mode="price" class="${active === 'price' ? 'selected' : ''}">Price</button><button type="button" data-chart-mode="pe" class="${active === 'pe' ? 'selected' : ''}">PE Ratio</button><button type="button" data-chart-mode="eps" class="${active === 'eps' ? 'selected' : ''}">EPS</button></div>`;
const chartMetricRows = (values, key) => values.map((item, index) => ({ ...item, index, metric:Number(item[key]) })).filter(item => Number.isFinite(item.metric));
const chartEpsBars = values => values.map((item, index) => ({ ...item, index, metric:Number(item.epsBar) })).filter(item => Number.isFinite(item.metric));
function epsGrowth(values) {
  const points = chartEpsBars(values).map(item => item.metric);
  if (points.length < 2 || points[points.length - 2] === 0) return null;
  return ((points[points.length - 1] - points[points.length - 2]) / Math.abs(points[points.length - 2])) * 100;
}
function drawMetricChart(values, mode) {
  const key = mode === 'pe' ? 'pe' : 'eps';
  const rows = chartMetricRows(values, key);
  const epsRows = chartEpsBars(values);
  const peRows = chartMetricRows(values, 'pe');
  if (!rows.length) return `<div class="chart-mode-header">${chartModeButtons(mode)}</div><p class="data-empty">${mode === 'pe' ? 'Historical P/E data is unavailable for this company.' : 'Reported EPS history is unavailable for this company.'}</p>`;
  const min = Math.min(...rows.map(item => item.metric));
  const max = Math.max(...rows.map(item => item.metric));
  const epsMin = epsRows.length ? Math.min(...epsRows.map(item => item.metric)) : 0;
  const epsMax = epsRows.length ? Math.max(...epsRows.map(item => item.metric)) : 1;
  const peMin = peRows.length ? Math.min(...peRows.map(item => item.metric)) : 0;
  const peMax = peRows.length ? Math.max(...peRows.map(item => item.metric)) : 1;
  const scaleX = index => 28 + (index / Math.max(values.length - 1, 1)) * 744;
  const scaleY = value => 174 - ((value - min) / Math.max(max - min, 0.01)) * 135;
  const path = rows.map((item, index) => `${index ? 'L' : 'M'} ${scaleX(item.index).toFixed(1)} ${scaleY(item.metric).toFixed(1)}`).join(' ');
  const peTrend = peRows.map(item => `${scaleX(item.index).toFixed(1)},${(174 - ((item.metric - peMin) / Math.max(peMax - peMin, 0.01)) * 135).toFixed(1)}`).join(' ');
  const zeroY = mode === 'eps' ? (min > 0 ? 174 : max < 0 ? 39 : scaleY(0)) : 174;
  const bars = mode === 'eps' ? epsRows.map((item) => {
    const startX = scaleX(item.index);
    const barWidth = Math.max(5, Math.min(18, 744 / Math.max(epsRows.length, 1) * 0.56));
    const valueY = 174 - ((item.metric - epsMin) / Math.max(epsMax - epsMin, 0.01)) * 135;
    const y = Math.min(valueY, zeroY);
    const height = Math.max(1, Math.abs(zeroY - valueY));
    return `<rect class="metric-bars ${item.metric >= 0 ? 'positive' : 'negative'}" x="${(startX - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}"><title>${escapeHtml(item.epsReportDate || item.date || 'Reported quarter')}: EPS ${item.metric.toFixed(2)}</title></rect>`;
  }).join('') : '';
  const pePath = mode === 'eps' && peRows.length ? peRows.map((item, index) => `${index ? 'L' : 'M'} ${scaleX(item.index).toFixed(1)} ${(174 - ((item.metric - peMin) / Math.max(peMax - peMin, 0.01)) * 135).toFixed(1)}`).join(' ') : '';
  const axisTicks = [0, 1, 2, 3, 4].map(step => {
    const y = 174 - step * 33.75;
    const epsTick = epsMin + (epsMax - epsMin) * (step / 4);
    const peTick = peMin + (peMax - peMin) * (step / 4);
    return `<text class="metric-tick metric-tick-left" x="3" y="${(y + 3).toFixed(1)}">${epsTick.toFixed(1)}</text><text class="metric-tick metric-tick-right" x="797" y="${(y + 3).toFixed(1)}">${peTick.toFixed(1)}</text>`;
  }).join('');
  const latest = rows[rows.length - 1] || epsRows[epsRows.length - 1] || peRows[peRows.length - 1];
  const growth = epsGrowth(values);
  const label = mode === 'pe' ? 'P/E (TTM)' : 'EPS (reported)';
  const value = Number(latest.metric).toLocaleString('en-US', { maximumFractionDigits:2 });
  const growthLabel = growth === null ? 'Unavailable' : `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`;
  const targets = values.map((item, index) => `<rect class="chart-hover-target" tabindex="0" data-chart-index="${index}" x="${(scaleX(index) - 3).toFixed(1)}" y="20" width="6" height="158"/>`).join('');
  setTimeout(() => {
    const holder = $('#company-chart');
    if (!holder) return;
    holder.querySelectorAll('[data-chart-mode]').forEach(button => { button.onclick = () => { companyChartMode = button.dataset.chartMode; holder.innerHTML = drawCompanyChart(values); }; });
    holder.querySelectorAll('[data-chart-points]').forEach(button => { button.onclick = async () => { companyChartOptions.points = Number(button.dataset.chartPoints); holder.innerHTML = '<p class="data-empty">Loading chart…</p>'; try { const chart = await getJson(`/data/chart?symbol=${encodeURIComponent(page)}&points=${companyChartOptions.points}`); holder.innerHTML = drawCompanyChart(chart.values || []); } catch { holder.innerHTML = '<p class="data-empty">Chart data is unavailable.</p>'; } }; });
    const tooltip = holder.querySelector('[data-chart-tooltip]');
    const show = target => { const item = values[Number(target.dataset.chartIndex)]; if (!item || !tooltip) return; const fmt = (v, suffix = '') => Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('en-US', { maximumFractionDigits:2 })}${suffix}` : 'Unavailable'; tooltip.innerHTML = `<b>${escapeHtml(item.date || 'Historical point')}</b><span>Price: <strong>${fmt(item.close, ' USD')}</strong></span><span>P/E: <strong>${fmt(item.pe, 'x')}</strong></span><span>EPS: <strong>${fmt(item.eps, ' USD')}</strong></span>`; tooltip.hidden = false; requestAnimationFrame(() => placeChartTooltip(target, tooltip, holder)); };
    holder.querySelectorAll('.chart-hover-target').forEach(target => { target.addEventListener('mouseenter', () => show(target)); target.addEventListener('focus', () => show(target)); target.addEventListener('mouseleave', () => { if (tooltip) tooltip.hidden = true; }); target.addEventListener('blur', () => { if (tooltip) tooltip.hidden = true; }); });
  }, 0);
  return `<div class="chart-mode-header"><div><b>${mode === 'pe' ? 'Valuation history' : 'EPS history'}</b><span>Reported values aligned to daily market dates · hover a point for Price, P/E and EPS</span></div>${chartModeButtons(mode)}</div><div class="chart-live-stats metric-stats"><div><span>${label}</span><b>${value}${mode === 'pe' ? 'x' : ' USD'}</b></div><div><span>EPS growth</span><b>${growthLabel}</b></div><div><span>Latest report</span><b>${escapeHtml(String(latest.date || '—'))}</b></div></div><div class="chart-controls"><div>${[[22,'1M'],[130,'6M'],[260,'1Y'],[780,'3Y'],[1300,'5Y'],[2600,'10Y']].map(([points,labelText]) => `<button class="${companyChartOptions.points === points ? 'selected' : ''}" data-chart-points="${points}">${labelText}</button>`).join('')}</div></div><svg class="metric-chart" viewBox="0 0 800 200" role="img" aria-label="Historical ${mode === 'pe' ? 'price to earnings ratio' : 'earnings per share'} chart"><path class="chart-grid" d="M28 30H772M28 78H772M28 126H772M28 174H772"/><g>${bars}</g>${mode === 'pe' ? `<path class="chart-line metric-line" d="${path}"/>` : ''}<g class="chart-hover-points">${targets}</g><text x="28" y="193">${escapeHtml(String(values[0].date || ''))}</text><text x="676" y="193">${escapeHtml(String(values[values.length - 1].date || ''))}</text><text x="720" y="30">${max.toFixed(2)}</text><text x="720" y="174">${min.toFixed(2)}</text></svg><div class="chart-hover-tooltip" data-chart-tooltip hidden></div>`;
}
const metricAwareChart = drawCompanyChart;
drawCompanyChart = function(values) {
  if (companyChartMode === 'price') {
    const output = metricAwareChart(values);
    const markup = output.replace('<div class="chart-controls">', `${chartModeButtons('price')}<div class="chart-controls">`);
    setTimeout(() => document.querySelectorAll('#company-chart [data-chart-mode]').forEach(button => { button.onclick = () => { companyChartMode = button.dataset.chartMode; const holder = $('#company-chart'); if (holder) holder.innerHTML = drawCompanyChart(values); }; }), 0);
    return markup;
  }
  const metricOutput = drawMetricChart(values, companyChartMode);
  if (companyChartMode === 'eps') {
    const peRows = chartMetricRows(values, 'pe');
    // A 10-year chart contains many quarterly reports. Label only a small,
    // evenly spaced set of years; the exact quarter remains in the hover card.
    const reportRows = chartEpsBars(values);
    const years = [];
    reportRows.forEach(item => {
      const year = String(item.epsReportDate || item.date || '').slice(0, 4);
      if (year && (!years.length || years[years.length - 1].year !== year)) years.push({ year, item });
    });
    const labelStep = Math.max(1, Math.ceil(years.length / 7));
    const visibleYears = years.filter((row, index) => index % labelStep === 0 || index === years.length - 1);
    const epsLabels = visibleYears.map(row => `<text class="metric-axis-label" x="${(28 + (row.item.index / Math.max(values.length - 1, 1)) * 744).toFixed(1)}" y="193">${escapeHtml(row.year)}</text>`).join('');
    const labeledOutput = metricOutput
      .replace(/<text x="28" y="193">.*?<\/text>/, '')
      .replace(/<text x="676" y="193">.*?<\/text>/, '')
      .replace('<text x="720" y="30">', `${epsLabels}<text x="720" y="30">`);
    if (peRows.length) {
      const peMin = Math.min(...peRows.map(item => item.metric));
      const peMax = Math.max(...peRows.map(item => item.metric));
      const x = index => 28 + (index / Math.max(values.length - 1, 1)) * 744;
      const y = value => 174 - ((value - peMin) / Math.max(peMax - peMin, 0.01)) * 135;
      const line = peRows.map((item, index) => `${index ? 'L' : 'M'} ${x(item.index).toFixed(1)} ${y(item.metric).toFixed(1)}`).join(' ');
      return labeledOutput.replace('<g class="chart-hover-points">', `<path class="chart-line metric-line metric-pe-overlay" d="${line}"/><g class="chart-hover-points">`);
    }
    return labeledOutput;
  }
  const epsAxis = chartEpsBars(values);
  const peAxis = chartMetricRows(values, 'pe');
  const epsMin = epsAxis.length ? Math.min(...epsAxis.map(item => item.metric)) : 0;
  const epsMax = epsAxis.length ? Math.max(...epsAxis.map(item => item.metric)) : 1;
  const peMin = peAxis.length ? Math.min(...peAxis.map(item => item.metric)) : 0;
  const peMax = peAxis.length ? Math.max(...peAxis.map(item => item.metric)) : 1;
  const axisTicks = [0, 1, 2, 3, 4].map(step => { const y = 174 - step * 33.75; return `<text class="metric-tick metric-tick-left" x="3" y="${(y + 3).toFixed(1)}">${(epsMin + (epsMax - epsMin) * step / 4).toFixed(1)}</text><text class="metric-tick metric-tick-right" x="797" y="${(y + 3).toFixed(1)}">${(peMin + (peMax - peMin) * step / 4).toFixed(1)}</text>`; }).join('');
  return metricOutput.replace('<path class="chart-grid"', `${axisTicks}<path class="chart-grid"`);
};

// Issuer document workspace: keep the visual grouping close to the reference
// while limiting content to SEC/company-reported material.
const baseCompanyView = companyView;
companyView = function(ticker) {
  const html = baseCompanyView(ticker);
  const documents = `<section id="documents" class="panel documents-panel issuer-documents-panel"><div class="panel-head"><div><h2>Documents</h2><p>Official company filings, annual and quarterly reports, and earnings-call materials</p></div><small id="doc-updated">Checking latest filings…</small></div><div class="issuer-documents-grid"><article class="issuer-doc-card issuer-announcements"><h3>Company filings</h3><div class="issuer-doc-tabs" role="tablist" aria-label="Filter company filings"><button type="button" class="active" aria-selected="true" data-doc-filter="recent">Recent</button><button type="button" aria-selected="false" data-doc-filter="important">Important</button><button type="button" aria-selected="false" data-doc-filter="search">Search</button><button type="button" aria-selected="false" data-doc-filter="all">All</button></div><div id="doc-announcements" class="issuer-doc-list"><p class="data-empty">Loading issuer filings…</p></div></article><article class="issuer-doc-card"><h3>Annual reports</h3><div id="doc-annual" class="issuer-doc-list"><p class="data-empty">Loading annual reports…</p></div></article><article class="issuer-doc-card"><h3>Quarterly reports</h3><div id="doc-quarterly" class="issuer-doc-list"><p class="data-empty">Loading quarterly reports…</p></div></article><article class="issuer-doc-card issuer-concalls"><h3>Earnings calls</h3><div id="doc-concalls" class="issuer-doc-list"><p class="data-empty">Checking transcript availability…</p></div></article></div><p class="filings-source-note">Filings link directly to SEC EDGAR. Earnings-call text is shown only when supplied by the connected provider; transcript summaries are extractive and should be checked against the full call.</p></section>`;
  return html.replace(/<section id="documents"[\s\S]*?<\/section>\s*<\/div>\s*$/, `${documents}</div>`);
};

function openEarningsDocument(ticker, year, quarter, mode) {
  document.querySelector('#earnings-document-reader')?.remove();
  const reader = document.createElement('div');
  reader.id = 'earnings-document-reader';
  reader.className = 'earnings-document-reader';
  reader.setAttribute('role', 'dialog');
  reader.setAttribute('aria-modal', 'true');
  reader.setAttribute('aria-label', `${ticker} earnings call ${mode}`);
  reader.innerHTML = `<div class="earnings-document-dialog"><button class="earnings-document-close" type="button" aria-label="Close">×</button><p class="crumb">${escapeHtml(ticker)} · Q${quarter} ${year}</p><h2>${mode === 'summary' ? 'Call summary' : 'Earnings-call transcript'}</h2><div class="earnings-document-body"><p class="data-empty">Loading company call material…</p></div></div>`;
  document.body.appendChild(reader);
  let keyHandler;
  const close = () => { reader.remove(); if (keyHandler) document.removeEventListener('keydown', keyHandler); };
  reader.querySelector('.earnings-document-close').onclick = close;
  reader.onclick = event => { if (event.target === reader) close(); };
  keyHandler = event => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', keyHandler);
  getJson(`/data/earnings-transcript?symbol=${encodeURIComponent(ticker)}&year=${year}&quarter=${quarter}`, 120000).then(data => {
    const body = reader.querySelector('.earnings-document-body');
    if (!body) return;
    if (mode === 'summary') {
      const highlights = Array.isArray(data.highlights) ? data.highlights : [];
      body.innerHTML = `<div class="transcript-source"><b>${escapeHtml(data.title || `${ticker} earnings call`)}</b><span>${escapeHtml(data.date || '')}</span></div>${highlights.length ? `<ul class="transcript-highlights">${highlights.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="data-empty">A reliable extractive summary could not be produced. Open the full transcript instead.</p>'}<p class="transcript-disclaimer">Automated extractive highlights from the company call—not investment advice. Verify wording and context in the full transcript.</p>`;
      return;
    }
    const paragraphs = String(data.content || '').split(/\n+/).map(value => value.trim()).filter(Boolean);
    body.innerHTML = `<div class="transcript-source"><b>${escapeHtml(data.title || `${ticker} earnings call`)}</b><span>${escapeHtml(data.date || '')}</span></div><div class="transcript-copy">${paragraphs.map(value => `<p>${escapeHtml(value)}</p>`).join('')}</div>`;
  }).catch(() => {
    const body = reader.querySelector('.earnings-document-body');
    if (body) body.innerHTML = '<p class="data-empty">This transcript is not available through the current provider plan or has not yet been published.</p>';
  });
}

function renderCompanyDocuments(ticker) {
  const safe = value => escapeHtml(value ?? '—');
  const list = (rows, empty, render) => rows.length ? rows.map(render).join('') : `<p class="data-empty">${empty}</p>`;
  const filingLink = filing => `<a class="issuer-doc-item" href="${escapeHtml(filing.url || '#')}" target="_blank" rel="noreferrer"><b>${safe(filing.description || filing.form || 'Company filing')}</b><span>${safe(filing.filedAt || filing.reportDate)} · ${safe(filing.form)}</span></a>`;
  Promise.all([getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`), getJson(`/data/company-intel?symbol=${encodeURIComponent(ticker)}`)])
    .then(([filingData, intel]) => {
      const filings = filingData.filings || [];
      const announcements = filings.filter(item => /^(8-K|8-K\/A|6-K|6-K\/A)$/.test(String(item.form || '').toUpperCase())).slice(0, 8);
      const annual = filings.filter(item => /10-K|20-F|40-F|ARS/.test(String(item.form || '').toUpperCase())).slice(0, 6);
      const quarterly = filings.filter(item => /10-Q/.test(String(item.form || '').toUpperCase())).slice(0, 6);
      const announcementHolder = $('#doc-announcements'); const annualHolder = $('#doc-annual'); const quarterlyHolder = $('#doc-quarterly'); const callsHolder = $('#doc-concalls');
      const importantPattern = /results|earnings|guidance|acquisition|merger|dividend|chief executive|chief financial|cyber|restatement|bankruptcy|material agreement|tender offer/i;
      const important = filings.filter(item => /^(8-K|8-K\/A|6-K|6-K\/A|10-Q|10-Q\/A|10-K|10-K\/A)$/.test(String(item.form || '').toUpperCase()) || importantPattern.test(`${item.description || ''} ${item.category || ''}`)).slice(0, 20);
      const renderFilingMode = (mode, query = '') => {
        if (!announcementHolder) return;
        let rows = announcements;
        if (mode === 'important') rows = important;
        if (mode === 'all') rows = filings.slice(0, 40);
        if (mode === 'search') {
          const term = String(query).trim().toLowerCase();
          const matches = term ? filings.filter(item => `${item.form || ''} ${item.category || ''} ${item.description || ''}`.toLowerCase().includes(term)).slice(0, 30) : filings.slice(0, 12);
          announcementHolder.innerHTML = `<label class="issuer-doc-search"><span>Search official filings</span><input type="search" id="issuer-doc-search-input" value="${escapeHtml(query)}" placeholder="Try 10-Q, earnings, merger…"></label>${list(matches, 'No company filings match this search.', filingLink)}`;
          const input = $('#issuer-doc-search-input');
          if (input) { input.oninput = () => renderFilingMode('search', input.value); input.focus(); }
          return;
        }
        announcementHolder.innerHTML = list(rows, mode === 'important' ? 'No material company filings were returned.' : 'No company filings were returned.', filingLink);
      };
      renderFilingMode('recent');
      document.querySelectorAll('[data-doc-filter]').forEach(button => { button.onclick = () => { document.querySelectorAll('[data-doc-filter]').forEach(item => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); }); renderFilingMode(button.dataset.docFilter); }; });
      if (annualHolder) annualHolder.innerHTML = list(annual, 'No annual reports were returned.', filingLink);
      if (quarterlyHolder) quarterlyHolder.innerHTML = list(quarterly, 'No quarterly reports were returned.', filingLink);
      const transcriptDates = (intel.transcriptDates || []).map(item => ({ ...item, year:Number(item.year || String(item.date || '').slice(0, 4)), quarter:Number(item.quarter || item.fiscalQuarter || item.q) })).filter(item => Number.isInteger(item.year) && [1,2,3,4].includes(item.quarter)).slice(0, 8);
      const earningsFilings = filings.filter(item => /10-Q|8-K|6-K/.test(String(item.form || '').toUpperCase()) && /earnings|results|quarter|current report|2\.02/i.test(`${item.description || ''} ${item.category || ''} ${item.items || ''}`)).slice(0, 6);
      if (callsHolder) callsHolder.innerHTML = transcriptDates.length
        ? transcriptDates.map(item => `<div class="issuer-call-row"><span>${safe(item.date || `Q${item.quarter}`)}</span><div><b>Q${item.quarter} ${item.year} earnings call</b><small>Company management discussion and analyst Q&amp;A</small></div><span class="issuer-doc-actions"><button type="button" data-call-mode="transcript" data-call-year="${item.year}" data-call-quarter="${item.quarter}">Transcript</button><button type="button" data-call-mode="summary" data-call-year="${item.year}" data-call-quarter="${item.quarter}">Summary</button></span></div>`).join('')
        : `<p class="issuer-call-notice">The provider has not returned call transcripts for this company. These official earnings filings remain available:</p>${list(earningsFilings, 'No company earnings-call transcript or earnings filing was returned.', filingLink)}`;
      document.querySelectorAll('[data-call-mode]').forEach(button => { button.onclick = () => openEarningsDocument(ticker, Number(button.dataset.callYear), Number(button.dataset.callQuarter), button.dataset.callMode); });
      const updated = $('#doc-updated');
      if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    })
    .catch(() => ['doc-announcements','doc-annual','doc-quarterly','doc-concalls'].forEach(id => { const holder = $(`#${id}`); if (holder) holder.innerHTML = '<p class="data-empty">Document data is temporarily unavailable.</p>'; }));
}
const previousCompanyExtras = hydrateCompanyExtras;
hydrateCompanyExtras = function(ticker) { previousCompanyExtras(ticker); renderCompanyDocuments(ticker); };

// Keep SPA routes shareable and make them usable as real browser tabs. Section
// anchors on a company page (for example #chart) remain normal in-page links.
window.addEventListener('hashchange', () => {
  const next = routeFromLocation();
  if (next && next !== page) { page = next; render(); window.scrollTo(0, 0); }
});
window.addEventListener('popstate', () => {
  const next = routeFromLocation() || 'dashboard';
  if (next !== page) { page = next; render(); window.scrollTo(0, 0); }
});
const initialRoute = routeFromLocation();
if (initialRoute) page = initialRoute;

// Motion system -----------------------------------------------------------
// Keep motion informative: pages reveal in reading order, company facts
// settle only after the live profile is ready, and asynchronously inserted
// research blocks receive a short, non-disruptive highlight.
let pageRevealObserver = null;
let contentMotionObserver = null;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function activatePageMotion(content = $('#content')) {
  if (!content) return;
  pageRevealObserver?.disconnect();
  contentMotionObserver?.disconnect();
  content.classList.add('motion-enabled');
  const pageRoot = content.querySelector('.page');
  if (!pageRoot) return;
  const groupedContainers = new Set(['market-grid', 'dashboard-grid', 'company-overview-stack', 'research-grid', 'financial-stack']);
  const targets = [];
  Array.from(pageRoot.children).forEach(child => {
    const grouped = Array.from(groupedContainers).some(name => child.classList.contains(name));
    if (grouped) targets.push(...Array.from(child.children));
    else targets.push(child);
  });
  if (pageRoot.classList.contains('company-page')) {
    targets.push(...Array.from(pageRoot.querySelectorAll('.ratio-board .ratio-cell')));
  }
  const uniqueTargets = [...new Set(targets)].filter(element => element && !element.closest('[hidden]'));
  uniqueTargets.forEach((element, index) => {
    element.classList.add('motion-reveal');
    element.style.setProperty('--motion-delay', `${Math.min(index % 7, 6) * 42}ms`);
    element.addEventListener('animationend', event => {
      if (event.animationName !== 'dd-reveal') return;
      element.classList.remove('motion-reveal', 'is-visible');
      element.style.removeProperty('--motion-delay');
    }, { once:true });
  });
  const show = element => { element.classList.add('is-visible'); pageRevealObserver?.unobserve(element); };
  if (reduceMotion() || !('IntersectionObserver' in window)) uniqueTargets.forEach(show);
  else {
    pageRevealObserver = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) show(entry.target); }), { threshold:0.08, rootMargin:'0px 0px -5% 0px' });
    uniqueTargets.forEach(element => pageRevealObserver.observe(element));
  }
  requestAnimationFrame(() => content.classList.add('route-ready'));

  if ('MutationObserver' in window && !reduceMotion()) {
    const pendingPanels = new Set();
    let frame = 0;
    contentMotionObserver = new MutationObserver(records => {
      records.forEach(record => {
        if (!record.addedNodes.length) return;
        const panel = record.target.nodeType === 1 ? record.target.closest?.('.panel, .market-card, .financial-panel') : null;
        if (panel) pendingPanels.add(panel);
      });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        pendingPanels.forEach(panel => {
          panel.classList.remove('content-arrived');
          void panel.offsetWidth;
          panel.classList.add('content-arrived');
          setTimeout(() => panel.classList.remove('content-arrived'), 620);
        });
        pendingPanels.clear();
      });
    });
    contentMotionObserver.observe(pageRoot, { childList:true, subtree:true });
  }
}

function pulseCompanyFacts() {
  ['company-title','company-subtitle','company-price','company-change','company-cap','company-pe','company-range','company-description']
    .map(id => document.getElementById(id)).filter(Boolean).forEach((element, index) => {
      element.classList.remove('data-settled');
      element.style.setProperty('--data-delay', `${index * 34}ms`);
      void element.offsetWidth;
      element.classList.add('data-settled');
    });
}

const hydrateCompanyBeforeMotion = hydrateCompany;
hydrateCompany = async function(ticker) {
  const companyPage = document.querySelector('.company-page');
  try {
    await hydrateCompanyBeforeMotion(ticker);
  } finally {
    if (page !== ticker || !companyPage?.isConnected) return;
    companyPage.querySelectorAll('#financials > .financial-panel').forEach((panel, index) => {
      const ids = ['pnl', 'balance-sheet', 'cash-flow'];
      if (ids[index]) panel.id = ids[index];
    });
    companyPage.classList.remove('company-loading');
    companyPage.classList.add('company-ready');
    companyPage.setAttribute('aria-busy', 'false');
    pulseCompanyFacts();
  }
};

function latestResultsView() {
  return `<div class="page latest-results-page">${pageHeader('REPORTED EARNINGS', 'Latest US quarterly results', 'Track newly reported Nasdaq company results in one research table. Filter by date, size and performance, then open any company for a complete review.')}
  <section class="latest-results-summary" aria-label="Results summary">
    <article><span>Reported companies</span><strong id="results-total">—</strong><small>Every unique result in this feed</small></article>
    <article><span>Sales growth leaders</span><strong id="results-sales-leaders">—</strong><small>Positive year-over-year growth</small></article>
    <article><span>Profit growth leaders</span><strong id="results-profit-leaders">—</strong><small>Positive year-over-year growth</small></article>
    <article><span>Turnarounds</span><strong id="results-turnarounds">—</strong><small>Loss to reported profit</small></article>
  </section>
  <section class="panel latest-results-workspace">
    <div class="latest-results-heading"><div><p class="crumb">LATEST RESULTS</p><h2>Latest quarterly results</h2><p>Browse every unique Nasdaq company result returned by the provider. Filter by date, size and performance, then open any company for a complete review.</p></div><div class="results-live-status"><span class="live-dot" aria-hidden="true"></span><b id="latest-results-updated">Loading provider data…</b><small id="latest-results-source">FMP reported statements · Nasdaq listings</small></div></div>
    <div class="latest-results-filters">
      <label class="results-search"><span>Company</span><input id="latest-results-search" type="search" placeholder="Search ticker or company" autocomplete="off"></label>
      <label><span>Report date</span><select id="latest-results-period"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="all" selected>All available</option></select></label>
      <label class="results-cap-field"><span>Market cap <small>(multi-select)</small></span><div class="results-multi" id="latest-results-cap" role="group" aria-label="Market cap filters"><button type="button" class="selected" data-cap-option="all">All</button><button type="button" data-cap-option="mega">Mega</button><button type="button" data-cap-option="large">Large</button><button type="button" data-cap-option="mid">Mid</button><button type="button" data-cap-option="small">Small</button><button type="button" data-cap-option="micro">Micro</button><button type="button" data-cap-option="unknown">Unknown</button></div></label>
      <label class="results-sort-field"><span>Sort results <small>(multi-priority)</small></span><div class="results-multi" id="latest-results-sort" role="group" aria-label="Sort priorities"><button type="button" class="selected" data-sort-option="latest">Latest</button><button type="button" data-sort-option="sales">Sales growth</button><button type="button" data-sort-option="profit">Profit growth</button><button type="button" data-sort-option="eps-surprise">EPS surprise</button><button type="button" data-sort-option="market-cap">Market cap</button><button type="button" data-sort-option="turnaround">Turnarounds</button></div></label>
    </div>
    <div class="results-quick-filters" role="tablist" aria-label="Result performance filter">
      <button class="selected" type="button" data-results-view="all">All results</button>
      <button type="button" data-results-view="sales">Sales growth 15%+</button>
      <button type="button" data-results-view="profit">Profit growth 15%+</button>
      <button type="button" data-results-view="turnaround">Turnarounds</button>
      <button type="button" data-results-view="decline">Earnings declines</button>
    </div>
    <div class="latest-results-meta"><span id="latest-results-visible">Loading results…</span><div><button type="button" class="link-button" data-page="toolkit" data-section="earnings-calendar">Upcoming earnings →</button><button type="button" class="link-button" data-page="screener">Screen companies →</button></div></div>
    <div class="table-wrap latest-results-table-wrap"><table class="latest-results-table"><thead><tr><th>Reported</th><th>Company</th><th>Price</th><th>P/E</th><th>Market cap</th><th>Quarterly revenue</th><th>Sales YoY</th><th>Net income</th><th>Profit YoY</th><th>EPS</th><th>EPS surprise</th><th></th></tr></thead><tbody id="latest-results-body"><tr><td colspan="12"><div class="results-loading"><span></span><b>Loading the latest reported results…</b><small>Combining FMP statements with Nasdaq listing data</small></div></td></tr></tbody></table></div>
    <div class="latest-results-pagination"><button id="latest-results-prev" type="button">← Previous</button><span id="latest-results-page-label">Page 1</span><button id="latest-results-next" type="button">Next →</button></div>
    <footer class="latest-results-note"><b>Research data, not a recommendation.</b><span id="latest-results-note">Figures are provider reported. DollarDisha does not fill unavailable values with estimates.</span></footer>
  </section></div>`;
}

async function setupLatestResults() {
  const body = $('#latest-results-body');
  if (!body) return;
  let rows = [];
  const resultViews = new Set();
  const selectedCaps = new Set(['all']);
  const selectedSorts = ['latest'];
  let resultPage = 1;
  const pageSize = 25;
  const numeric = value => scanNumber(value);
  const compactUsd = value => numeric(value) === null ? '—' : new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', notation:'compact', maximumFractionDigits:2 }).format(Number(value));
  const ratio = value => numeric(value) === null ? '—' : `${Number(value).toFixed(1)}x`;
  const signedPercent = value => numeric(value) === null ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
  const resultDate = value => {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? 'Not reported' : date.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  };
  const tone = value => numeric(value) === null ? '' : Number(value) >= 0 ? 'positive' : 'down';
  const capMatches = (row, selected) => {
    const cap = numeric(row.marketCap);
    if (selected === 'all') return true;
    if (selected === 'unknown') return cap === null;
    if (cap === null) return false;
    if (selected === 'mega') return cap >= 200_000_000_000;
    if (selected === 'large') return cap >= 10_000_000_000 && cap < 200_000_000_000;
    if (selected === 'mid') return cap >= 2_000_000_000 && cap < 10_000_000_000;
    if (selected === 'small') return cap >= 300_000_000 && cap < 2_000_000_000;
    return cap < 300_000_000;
  };
  const viewMatches = row => {
    if (!resultViews.size) return true;
    return [...resultViews].some(view => view === 'sales'
      ? numeric(row.revenueGrowth) !== null && Number(row.revenueGrowth) >= 15
      : view === 'profit'
        ? numeric(row.profitGrowth) !== null && Number(row.profitGrowth) >= 15
        : view === 'turnaround' ? row.turnaround === true
          : (numeric(row.profitGrowth) !== null && Number(row.profitGrowth) < 0) || (numeric(row.epsGrowth) !== null && Number(row.epsGrowth) < 0));
  };
  const draw = () => {
    const search = $('#latest-results-search').value.trim().toUpperCase();
    const days = $('#latest-results-period').value === 'all' ? Infinity : Number($('#latest-results-period').value);
    const cap = selectedCaps;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const filtered = rows.filter(row => {
      const date = new Date(`${row.reportDate}T00:00:00`);
      const age = (today - date) / 86400000;
      const identity = `${row.symbol || ''} ${row.companyName || ''}`.toUpperCase();
      return age >= -1 && age <= days && (!search || identity.includes(search)) && viewMatches(row);
    }).filter(row => cap.has('all') || [...cap].some(selected => capMatches(row, selected))).sort((left, right) => {
      const descending = field => (numeric(right[field]) ?? -Infinity) - (numeric(left[field]) ?? -Infinity);
      for (const sort of selectedSorts) {
        const result = sort === 'sales' ? descending('revenueGrowth')
          : sort === 'profit' ? descending('profitGrowth')
            : sort === 'eps-surprise' ? descending('epsSurprise')
              : sort === 'market-cap' ? descending('marketCap')
                : sort === 'turnaround' ? Number(right.turnaround) - Number(left.turnaround)
                  : String(right.reportDate).localeCompare(String(left.reportDate));
        if (result) return result;
      }
      return 0;
    });
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    resultPage = Math.min(resultPage, pages);
    const visible = filtered.slice((resultPage - 1) * pageSize, resultPage * pageSize);
    $('#latest-results-visible').textContent = `${filtered.length} ${filtered.length === 1 ? 'company' : 'companies'} match this view`;
    $('#latest-results-page-label').textContent = `Page ${resultPage} of ${pages}`;
    $('#latest-results-prev').disabled = resultPage <= 1;
    $('#latest-results-next').disabled = resultPage >= pages;
    body.innerHTML = visible.length ? visible.map(row => {
      const salesTone = tone(row.revenueGrowth);
      const profitTone = tone(row.profitGrowth);
      const surpriseTone = tone(row.epsSurprise);
      const tags = `${row.turnaround ? '<span class="result-tag turnaround">Turnaround</span>' : ''}${numeric(row.revenueGrowth) !== null && Number(row.revenueGrowth) >= 15 ? '<span class="result-tag">Sales growth</span>' : ''}`;
      return `<tr class="company-row" data-stock="${escapeHtml(row.symbol)}">
        <td data-label="Reported"><b>${resultDate(row.reportDate)}</b><small>${row.fiscalDate ? `Quarter ended ${resultDate(row.fiscalDate)}` : 'Latest reported quarter'}</small></td>
        <td data-label="Company"><div class="result-company">${companyIdentity(row.symbol, row.companyName, row.sector || 'NASDAQ')}<div class="result-tags">${tags}</div></div></td>
        <td data-label="Price"><b>${numeric(row.price) === null ? '—' : `$${Number(row.price).toFixed(2)}`}</b><small class="${tone(row.change)}">${signedPercent(row.change)} today</small></td>
        <td data-label="P/E"><b>${ratio(row.pe)}</b></td>
        <td data-label="Market cap"><b>${compactUsd(row.marketCap)}</b></td>
        <td data-label="Quarterly revenue"><b>${compactUsd(row.revenue)}</b><small>${numeric(row.revenueEstimate) === null ? 'Estimate not reported' : `${signedPercent(row.revenueSurprise)} vs estimate`}</small></td>
        <td data-label="Sales YoY"><b class="${salesTone}">${signedPercent(row.revenueGrowth)}</b></td>
        <td data-label="Net income"><b>${compactUsd(row.netIncome)}</b></td>
        <td data-label="Profit YoY"><b class="${profitTone}">${row.turnaround ? 'Turnaround' : signedPercent(row.profitGrowth)}</b></td>
        <td data-label="EPS"><b>${numeric(row.eps) === null ? '—' : `$${Number(row.eps).toFixed(2)}`}</b><small>${numeric(row.epsEstimate) === null ? 'Estimate not reported' : `$${Number(row.epsEstimate).toFixed(2)} estimate`}</small></td>
        <td data-label="EPS surprise"><b class="${surpriseTone}">${signedPercent(row.epsSurprise)}</b></td>
        <td><button type="button" class="result-open" data-page="${escapeHtml(row.symbol)}">Research →</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="12"><div class="results-empty"><b>No reported results match these filters</b><span>Try a wider date range, another market-cap group or the All results view.</span><button type="button" id="latest-results-reset">Reset filters</button></div></td></tr>';
    wireCommon();
    $('#latest-results-reset')?.addEventListener('click', () => {
      $('#latest-results-search').value = '';
      $('#latest-results-period').value = 'all';
      selectedSorts.splice(0, selectedSorts.length, 'latest');
      resultViews.clear(); selectedCaps.clear(); selectedCaps.add('all'); resultPage = 1;
      document.querySelectorAll('[data-results-view]').forEach(button => button.classList.remove('selected'));
      document.querySelector('[data-results-view="all"]')?.classList.add('selected');
      document.querySelectorAll('[data-cap-option]').forEach(button => button.classList.toggle('selected', button.dataset.capOption === 'all'));
      draw();
    });
  };
  const resetAndDraw = () => { resultPage = 1; draw(); };
  ['latest-results-search','latest-results-period'].forEach(id => {
    const element = $(`#${id}`);
    if (element) element[element.tagName === 'INPUT' ? 'oninput' : 'onchange'] = resetAndDraw;
  });
  document.querySelectorAll('[data-results-view]').forEach(button => button.onclick = () => {
    const view = button.dataset.resultsView;
    if (view === 'all') resultViews.clear();
    else {
      resultViews.delete('all');
      resultViews.has(view) ? resultViews.delete(view) : resultViews.add(view);
    }
    resultPage = 1;
    document.querySelectorAll('[data-results-view]').forEach(item => item.classList.toggle('selected', item.dataset.resultsView === 'all' ? !resultViews.size : resultViews.has(item.dataset.resultsView)));
    draw();
  });
  document.querySelectorAll('[data-cap-option]').forEach(button => button.onclick = () => {
    const option = button.dataset.capOption;
    if (option === 'all') { selectedCaps.clear(); selectedCaps.add('all'); }
    else { selectedCaps.delete('all'); selectedCaps.has(option) ? selectedCaps.delete(option) : selectedCaps.add(option); if (!selectedCaps.size) selectedCaps.add('all'); }
    document.querySelectorAll('[data-cap-option]').forEach(item => item.classList.toggle('selected', selectedCaps.has(item.dataset.capOption)));
    resultPage = 1; draw();
  });
  document.querySelectorAll('[data-sort-option]').forEach(button => button.onclick = () => {
    const option = button.dataset.sortOption;
    if (option === 'latest') selectedSorts.splice(0, selectedSorts.length, 'latest');
    else {
      const index = selectedSorts.indexOf(option);
      if (index >= 0) selectedSorts.splice(index, 1);
      else { const latestIndex = selectedSorts.indexOf('latest'); if (latestIndex >= 0) selectedSorts.splice(latestIndex, 1); selectedSorts.push(option); }
      if (!selectedSorts.length) selectedSorts.push('latest');
    }
    document.querySelectorAll('[data-sort-option]').forEach(item => item.classList.toggle('selected', selectedSorts.includes(item.dataset.sortOption)));
    resultPage = 1; draw();
  });
  $('#latest-results-prev').onclick = () => { resultPage -= 1; draw(); document.querySelector('.latest-results-workspace')?.scrollIntoView({ behavior:'smooth', block:'start' }); };
  $('#latest-results-next').onclick = () => { resultPage += 1; draw(); document.querySelector('.latest-results-workspace')?.scrollIntoView({ behavior:'smooth', block:'start' }); };
  try {
    const data = await getJson('/data/results/latest', 5 * 60 * 1000);
    if (!$('#latest-results-body')) return;
    rows = Array.isArray(data.rows) ? data.rows : [];
    $('#results-total').textContent = rows.length;
    $('#results-sales-leaders').textContent = rows.filter(row => numeric(row.revenueGrowth) !== null && Number(row.revenueGrowth) > 0).length;
    $('#results-profit-leaders').textContent = rows.filter(row => numeric(row.profitGrowth) !== null && Number(row.profitGrowth) > 0).length;
    $('#results-turnarounds').textContent = rows.filter(row => row.turnaround).length;
    $('#latest-results-updated').textContent = `${data.stale ? 'Last available snapshot' : 'Updated'} ${new Date(data.updatedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    $('#latest-results-source').textContent = data.source || 'FMP reported statements · Nasdaq listings';
    $('#latest-results-note').textContent = data.note || 'Figures are provider reported. Missing values are left blank.';
    draw();
  } catch {
    if (!$('#latest-results-body')) return;
    $('#latest-results-updated').textContent = 'Results temporarily unavailable';
    $('#latest-results-source').textContent = 'The provider connection can be retried shortly';
    body.innerHTML = '<tr><td colspan="12"><div class="results-empty"><b>The latest results could not be loaded</b><span>Your other research tools remain available. Please retry this page shortly.</span><button type="button" id="latest-results-retry">Retry</button></div></td></tr>';
    $('#latest-results-retry').onclick = () => { jsonRequestCache.clear(); setupLatestResults(); };
  }
}

function toolkitView() {
  return `<div class="page toolkit-page">${pageHeader('DECISION TOOLS', 'Research Toolkit', 'Turn live company data into a repeatable valuation view, then track the earnings events that can change the thesis.')}
  <nav class="toolkit-jump" aria-label="Research toolkit sections"><a href="#valuation-lab">Valuation Lab</a><a href="#india-return-tool">INR Return</a><a href="#earnings-calendar">Earnings Calendar</a><a href="#ipo-calendar">IPO Calendar</a><a href="#saved-cases">Saved Cases</a><button type="button" data-page="screener">Open saved screens</button></nav>
  <section id="valuation-lab" class="panel toolkit-valuation"><div class="toolkit-section-head"><div><p class="crumb">VALUATION LAB</p><h2>Build an earnings-multiple scenario</h2><p>Start from the latest reported EPS and live price, then test your own growth, exit multiple and required return.</p></div><span class="toolkit-badge">Scenario, not a price target</span></div>
    <div class="valuation-search"><label class="toolkit-symbol-search"><span>Search a US company</span><input id="valuation-symbol" maxlength="50" value="AAPL" placeholder="Ticker or company, e.g. AAPL or Apple" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="valuation-symbol-results" aria-expanded="false"><div id="valuation-symbol-results" class="compare-results valuation-symbol-results" hidden></div></label><button id="valuation-load" class="solid-btn" type="button">Load company</button><span id="valuation-status" role="status" aria-live="polite">Ready to load live data</span></div>
    <div id="valuation-company-card" class="toolkit-company-card" aria-live="polite"><div class="toolkit-company-placeholder"><span>LIVE INPUTS</span><b>Choose a company to populate the valuation model</b><small>DollarDisha will load the latest quote, reported TTM EPS and current P/E where available.</small></div></div>
    <div class="valuation-workspace"><div class="valuation-inputs"><label>Current price<input id="valuation-price" type="number" step="0.01"></label><label>TTM EPS<input id="valuation-eps" type="number" step="0.01"></label><label>EPS growth / year<input id="valuation-growth" type="number" step="0.1" value="12"><span>%</span></label><label>Exit P/E<input id="valuation-pe" type="number" step="0.1" value="24"><span>x</span></label><label>Required return<input id="valuation-discount" type="number" step="0.1" value="12"><span>%</span></label><label>Forecast period<select id="valuation-years"><option value="3">3 years</option><option value="5" selected>5 years</option><option value="10">10 years</option></select></label></div>
    <div class="valuation-output" id="valuation-output"><p>Load a company to calculate the scenario.</p></div></div>
    <div class="valuation-save"><input id="valuation-case-name" maxlength="60" placeholder="Name this case, e.g. Apple base case" aria-label="Valuation case name"><button id="valuation-save" type="button" class="solid-btn" disabled>Save valuation case</button></div>
  </section>
  <section id="india-return-tool" class="panel india-return-tool"><div class="toolkit-section-head"><div><p class="crumb">INDIAN INVESTOR TOOL</p><h2>Translate a US return into rupees</h2><p>See how the stock return and the USD/INR move combine for an Indian investor.</p></div><span id="india-fx-rate" class="toolkit-badge">Loading USD/INR</span></div><div class="india-return-grid"><label>Investment in USD<input id="india-usd-amount" type="number" min="0" step="100" value="1000"></label><label>US stock return<input id="india-stock-return" type="number" step="0.1" value="10"><span>%</span></label><label>USD/INR move<input id="india-fx-change" type="number" step="0.1" value="2"><span>%</span></label><div class="india-return-output"><span>Estimated value in INR</span><strong id="india-final-inr">—</strong><b id="india-total-return">—</b><small>Before tax, fees and currency-conversion costs</small></div></div></section>
  <section id="earnings-calendar" class="panel toolkit-calendar"><div class="toolkit-section-head"><div><p class="crumb">EARNINGS CALENDAR</p><h2>Upcoming US company results</h2><p>Provider-reported earnings dates and estimates. Open any ticker directly in DollarDisha research.</p></div><span id="earnings-updated" class="toolkit-badge">Loading calendar</span></div>
    <div class="calendar-toolbar"><div role="tablist" aria-label="Calendar period"><button class="selected" type="button" data-earnings-period="7">Next 7 days</button><button type="button" data-earnings-period="14">Next 14 days</button><button type="button" data-earnings-period="30">Next 30 days</button><button type="button" data-earnings-period="all">All available</button></div><label><span class="sr-only">Filter earnings calendar</span><input id="earnings-search" type="search" placeholder="Filter ticker or company"></label></div>
    <div class="calendar-summary"><span id="earnings-visible">Loading reported events</span><small>Dates and estimates are provider reported and may change.</small></div>
    <div class="table-wrap"><table class="earnings-calendar-table"><thead><tr><th>Date</th><th>Company</th><th>Session</th><th>EPS estimate</th><th>Revenue estimate</th><th>Alert</th><th></th></tr></thead><tbody id="earnings-calendar-body"><tr><td colspan="7">Loading the earnings calendar...</td></tr></tbody></table></div>
  </section>
  <section id="ipo-calendar" class="panel toolkit-calendar ipo-calendar"><div class="toolkit-section-head"><div><p class="crumb">IPO CALENDAR</p><h2>Upcoming US listings</h2><p>Provider-reported listing dates and offer details. Dates and terms can change before an offering is completed.</p></div><span id="ipo-updated" class="toolkit-badge">Loading calendar</span></div>
    <div class="table-wrap"><table class="earnings-calendar-table"><thead><tr><th>Date</th><th>Company</th><th>Exchange</th><th>Shares</th><th>Offer range</th></tr></thead><tbody id="ipo-calendar-body"><tr><td colspan="5">Loading the IPO calendar...</td></tr></tbody></table></div>
  </section>
  <section id="saved-cases" class="panel saved-cases-panel"><div class="toolkit-section-head"><div><p class="crumb">YOUR WORK</p><h2>Saved valuation cases</h2><p>Cases are saved locally and merge into your signed-in research account.</p></div><span id="saved-cases-count" class="toolkit-badge">0 saved cases</span></div><div id="valuation-cases" class="valuation-case-grid"></div></section></div>`;
}

function setupToolkit() {
  let companyData = null;
  let calendarRows = [];
  let ipoRows = [];
  let calendarPeriod = '7';
  let valuationSearchTimer;
  let valuationSearchRequest = 0;
  let valuationLoadRequest = 0;
  let activeValuationSymbol = '';
  const numberFrom = (...values) => scanNumber(...values);
  const formatMoney = value => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString('en-US', { maximumFractionDigits:2 })}` : 'Not reported';
  const setValuationStatus = (message, tone = '') => {
    const status = $('#valuation-status');
    status.textContent = message;
    status.dataset.tone = tone;
  };
  const saveToolState = () => {
    try { localStorage.setItem('dd-valuation-cases', JSON.stringify(valuationCases)); } catch {}
    queueResearchStateSync();
  };
  const calculate = () => {
    const price = Number($('#valuation-price').value);
    const eps = Number($('#valuation-eps').value);
    const growth = Number($('#valuation-growth').value) / 100;
    const exitPe = Number($('#valuation-pe').value);
    const discount = Number($('#valuation-discount').value) / 100;
    const years = Number($('#valuation-years').value);
    const holder = $('#valuation-output');
    if (![price, eps, growth, exitPe, discount, years].every(Number.isFinite) || price <= 0 || eps <= 0 || exitPe <= 0 || discount <= -1) {
      holder.innerHTML = '<div class="valuation-warning"><b>Complete the live inputs and assumptions above.</b><span>Positive EPS is required for this earnings-multiple model. Loss-making companies need a different valuation method.</span></div>';
      $('#valuation-save').disabled = true;
      return null;
    }
    const futureEps = eps * ((1 + growth) ** years);
    const futurePrice = futureEps * exitPe;
    const presentValue = futurePrice / ((1 + discount) ** years);
    const upside = ((presentValue / price) - 1) * 100;
    const annualReturn = (((presentValue / price) ** (1 / years)) - 1) * 100;
    holder.innerHTML = `<div class="valuation-result-main"><span>Scenario present value</span><strong>${formatMoney(presentValue)}</strong><b class="${upside >= 0 ? 'positive' : 'down'}">${upside >= 0 ? '+' : ''}${upside.toFixed(1)}% vs live price</b></div><div class="valuation-result-grid"><div><span>Future EPS</span><b>${formatMoney(futureEps)}</b></div><div><span>Future value</span><b>${formatMoney(futurePrice)}</b></div><div><span>Annualised return</span><b>${annualReturn.toFixed(1)}%</b></div><div><span>Forecast</span><b>${years} years</b></div></div><p>Formula: EPS growth compounded for ${years} years, valued at ${exitPe.toFixed(1)}x, then discounted at ${(discount * 100).toFixed(1)}%.</p>`;
    $('#valuation-save').disabled = !activeValuationSymbol;
    return { price, eps, growth:growth * 100, exitPe, discount:discount * 100, years, futureEps, futurePrice, presentValue, upside, annualReturn };
  };
  const drawValuationCompany = (ticker, data, price, eps, pe) => {
    const profile = data.profile || {};
    const quote = data.quote || {};
    const name = profile.companyName || profile.name || quote.name || ticker;
    const exchange = profile.exchangeShortName || profile.exchange || quote.exchange || 'US';
    const change = numberFrom(quote.changesPercentage, quote.changePercentage, quote.percentChange);
    const updated = quote.timestamp ? new Date(Number(quote.timestamp) * (Number(quote.timestamp) < 1e12 ? 1000 : 1)) : new Date();
    const validTime = !Number.isNaN(updated.getTime());
    $('#valuation-company-card').innerHTML = `<div class="toolkit-company-identity">${companyLogo(ticker, name, 'large')}<div><span>LIVE COMPANY INPUTS</span><h3>${escapeHtml(name)}</h3><small>${escapeHtml(ticker)} · ${escapeHtml(exchange)}${validTime ? ` · updated ${escapeHtml(updated.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }))}` : ''}</small></div></div><div class="toolkit-company-facts"><div><span>Live price</span><b>${price === null ? 'Not reported' : formatMoney(price)}</b>${change === null ? '' : `<small class="${change >= 0 ? 'positive' : 'down'}">${percent(change)} today</small>`}</div><div><span>TTM EPS</span><b>${eps === null ? 'Not reported' : formatMoney(eps)}</b><small>Latest reported</small></div><div><span>Current P/E</span><b>${pe === null ? 'Not reported' : `${Number(pe).toFixed(1)}x`}</b><small>Price ÷ TTM EPS</small></div></div>`;
  };
  const resolveValuationTicker = async symbolValue => {
    const input = $('#valuation-symbol');
    const selected = String(input.dataset.symbol || '').trim().toUpperCase();
    const raw = String(symbolValue || '').trim();
    if (selected && selected === raw.toUpperCase()) return selected;
    const directTicker = raw.toUpperCase();
    if (raw.length < 2) return /^[A-Z.]{1,10}$/.test(directTicker) ? directTicker : '';
    setValuationStatus(`Finding ${raw} in the live US directory...`, 'loading');
    try {
      const matches = await getJson(`/data/search?q=${encodeURIComponent(raw)}`, 15000);
      const exact = matches.find(item => String(item.symbol || item.ticker || '').toUpperCase() === directTicker);
      return String(exact?.symbol || exact?.ticker || matches?.[0]?.symbol || matches?.[0]?.ticker || '').toUpperCase();
    } catch {
      return /^[A-Z.]{1,10}$/.test(directTicker) ? directTicker : '';
    }
  };
  const loadValuation = async (symbolValue = $('#valuation-symbol').value) => {
    const requestId = ++valuationLoadRequest;
    const input = $('#valuation-symbol');
    let ticker = '';
    try { ticker = await resolveValuationTicker(symbolValue); } catch {}
    if (!/^[A-Z.]{1,10}$/.test(ticker)) {
      setValuationStatus('Choose a company from the live US stock directory.', 'error');
      return;
    }
    input.value = ticker;
    input.dataset.symbol = ticker;
    input.setAttribute('aria-expanded', 'false');
    $('#valuation-symbol-results').hidden = true;
    activeValuationSymbol = '';
    companyData = null;
    $('#valuation-price').value = '';
    $('#valuation-eps').value = '';
    $('#valuation-save').disabled = true;
    setValuationStatus(`Loading ${ticker} live quote and fundamentals...`, 'loading');
    try {
      const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`, 45000);
      if (requestId !== valuationLoadRequest) return;
      companyData = data;
      const quote = data.quote || {};
      const ratios = data.ratios || {};
      const metrics = data.metrics || {};
      const price = numberFrom(quote.price, data.price, data.profile?.price);
      const pe = numberFrom(quote.pe, ratios.peRatioTTM, ratios.priceEarningsRatioTTM, metrics.peRatioTTM);
      const eps = numberFrom(ratios.netIncomePerShareTTM, ratios.epsTTM, quote.eps, price && pe ? price / pe : null);
      if (price !== null) $('#valuation-price').value = Number(price).toFixed(2);
      if (eps !== null) $('#valuation-eps').value = Number(eps).toFixed(2);
      if (pe !== null && pe > 0) $('#valuation-pe').value = Math.min(Math.max(Number(pe), 5), 80).toFixed(1);
      const name = data.profile?.companyName || data.profile?.name || quote.name || ticker;
      activeValuationSymbol = ticker;
      drawValuationCompany(ticker, data, price, eps, pe);
      setValuationStatus(`${name} · live price and latest reported fundamentals loaded`, 'success');
      calculate();
    } catch {
      if (requestId !== valuationLoadRequest) return;
      companyData = null;
      activeValuationSymbol = '';
      setValuationStatus(`${ticker} fundamentals are temporarily unavailable. Try again shortly.`, 'error');
      $('#valuation-company-card').innerHTML = `<div class="toolkit-company-placeholder error"><span>DATA UNAVAILABLE</span><b>${escapeHtml(ticker)} could not be loaded</b><small>No values have been invented. Use Load company to retry the live providers.</small></div>`;
      calculate();
    }
  };
  const setupValuationSearch = () => {
    const input = $('#valuation-symbol');
    const results = $('#valuation-symbol-results');
    const close = () => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const select = button => {
      const ticker = button.dataset.valuationSymbol;
      input.value = ticker;
      input.dataset.symbol = ticker;
      input.title = button.dataset.valuationName || ticker;
      close();
      loadValuation(ticker);
    };
    input.dataset.symbol = 'AAPL';
    input.oninput = () => {
      input.dataset.symbol = '';
      activeValuationSymbol = '';
      $('#valuation-save').disabled = true;
      clearTimeout(valuationSearchTimer);
      const query = input.value.trim();
      if (query.length < 2) { close(); results.innerHTML = ''; return; }
      const requestId = ++valuationSearchRequest;
      valuationSearchTimer = setTimeout(async () => {
        results.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        results.innerHTML = '<button type="button" disabled>Searching the live US stock directory...</button>';
        try {
          const matches = await getJson(`/data/search?q=${encodeURIComponent(query)}`, 15000);
          if (requestId !== valuationSearchRequest) return;
          const list = (Array.isArray(matches) ? matches : []).slice(0, 8);
          const symbols = list.map(item => item.symbol || item.ticker).filter(Boolean);
          const liveRows = symbols.length ? await getJson(`/data/watchlist?symbols=${encodeURIComponent(symbols.join(','))}`, 15000).catch(() => []) : [];
          if (requestId !== valuationSearchRequest) return;
          const liveBySymbol = new Map((Array.isArray(liveRows) ? liveRows : []).map(item => [String(item.symbol || item.ticker || '').toUpperCase(), item]));
          results.innerHTML = list.length ? list.map(item => {
            const ticker = String(item.symbol || item.ticker || '').toUpperCase();
            const name = item.name || item.companyName || ticker;
            const exchange = item.exchangeShortName || item.exchange || 'US';
            const live = liveBySymbol.get(ticker) || {};
            const price = numberFrom(live.price);
            const change = numberFrom(live.changesPercentage, live.changePercentage, live.change);
            const quote = price === null ? 'Live quote loading' : `${formatMoney(price)}${change === null ? '' : ` · ${percent(change)}`}`;
            return `<button type="button" data-valuation-symbol="${escapeHtml(ticker)}" data-valuation-name="${escapeHtml(name)}">${companyLogo(ticker, name, 'small')}<span><b>${escapeHtml(name)}</b><small>${escapeHtml(ticker)} · ${escapeHtml(exchange)}</small></span><em>${escapeHtml(quote)}</em></button>`;
          }).join('') : '<button type="button" disabled>No matching US company found.</button>';
          results.querySelectorAll('[data-valuation-symbol]').forEach(button => button.onclick = () => select(button));
        } catch { results.innerHTML = '<button type="button" disabled>The live directory is temporarily unavailable. Enter an exact ticker.</button>'; }
      }, 220);
    };
    input.onfocus = () => { if (results.children.length && input.value.trim()) { results.hidden = false; input.setAttribute('aria-expanded', 'true'); } };
    input.onkeydown = event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Enter') {
        const first = results.querySelector('[data-valuation-symbol]');
        if (!results.hidden && first) { event.preventDefault(); select(first); }
        else { event.preventDefault(); loadValuation(); }
      }
    };
    input.onblur = () => setTimeout(close, 160);
  };
  const drawCases = () => {
    const holder = $('#valuation-cases');
    $('#saved-cases-count').textContent = `${valuationCases.length} saved ${valuationCases.length === 1 ? 'case' : 'cases'}`;
    holder.innerHTML = valuationCases.length ? valuationCases.map(item => `<article class="valuation-case"><div><span>${escapeHtml(item.symbol)}</span><time>${escapeHtml(item.savedLabel || '')}</time></div><h3>${escapeHtml(item.name)}</h3><strong>${formatMoney(item.presentValue)}</strong><p class="${Number(item.upside) >= 0 ? 'positive' : 'down'}">${Number(item.upside) >= 0 ? '+' : ''}${Number(item.upside).toFixed(1)}% scenario upside</p><dl><div><dt>EPS growth</dt><dd>${Number(item.growth).toFixed(1)}%</dd></div><div><dt>Exit P/E</dt><dd>${Number(item.exitPe).toFixed(1)}x</dd></div><div><dt>Period</dt><dd>${item.years}y</dd></div></dl><footer><button type="button" data-open-case="${escapeHtml(item.id)}">Open</button><button type="button" data-delete-case="${escapeHtml(item.id)}">Delete</button></footer></article>`).join('') : '<div class="saved-case-empty"><b>No saved valuation cases yet</b><span>Build a scenario above and save it for later comparison.</span></div>';
    holder.querySelectorAll('[data-open-case]').forEach(button => button.onclick = async () => {
      const item = valuationCases.find(entry => entry.id === button.dataset.openCase);
      if (!item) return;
      $('#valuation-symbol').value = item.symbol;
      $('#valuation-symbol').dataset.symbol = item.symbol;
      $('#valuation-growth').value = item.growth;
      $('#valuation-pe').value = item.exitPe;
      $('#valuation-discount').value = item.discount;
      $('#valuation-years').value = item.years;
      setValuationStatus(`${item.symbol} · refreshing live inputs for this saved case...`, 'loading');
      await loadValuation(item.symbol);
      // Preserve the investor's saved assumptions while refreshing the quote
      // and reported EPS used as the model's starting point.
      $('#valuation-growth').value = item.growth;
      $('#valuation-pe').value = item.exitPe;
      $('#valuation-discount').value = item.discount;
      $('#valuation-years').value = item.years;
      calculate();
      document.querySelector('#valuation-lab')?.scrollIntoView({ behavior:'smooth', block:'start' });
    });
    holder.querySelectorAll('[data-delete-case]').forEach(button => button.onclick = () => { valuationCases = valuationCases.filter(entry => entry.id !== button.dataset.deleteCase); saveToolState(); drawCases(); });
  };
  const normaliseEarnings = row => ({
    date:String(row.date || row.reportDate || row.fiscalDateEnding || '').slice(0, 10),
    symbol:String(row.symbol || row.ticker || '').toUpperCase(),
    name:row.name || row.companyName || row.symbol || row.ticker || 'Company',
    time:String(row.time || row.session || '').toLowerCase(),
    eps:numberFrom(row.epsEstimated, row.epsEstimate, row.estimatedEps),
    revenue:numberFrom(row.revenueEstimated, row.revenueEstimate, row.estimatedRevenue)
  });
  const normaliseIpo = row => ({
    date:String(row.date || row.filingDate || row.acceptedDate || '').slice(0, 10),
    symbol:String(row.symbol || row.ticker || '').toUpperCase(),
    name:row.company || row.companyName || row.name || row.symbol || row.ticker || 'Company',
    exchange:row.exchange || row.exchangeShortName || 'Not reported',
    shares:numberFrom(row.shares, row.numberOfShares),
    priceLow:numberFrom(row.priceRangeLow, row.priceLow, row.minPrice),
    priceHigh:numberFrom(row.priceRangeHigh, row.priceHigh, row.maxPrice)
  });
  const drawIpoCalendar = () => {
    const body = $('#ipo-calendar-body');
    if (!body) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const future = ipoRows.filter(row => {
      const date = new Date(`${row.date}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date >= today;
    }).slice(0, 80);
    body.innerHTML = future.length ? future.map(row => {
      const range = row.priceLow === null && row.priceHigh === null ? 'Not reported' : `${row.priceLow === null ? '—' : formatMoney(row.priceLow)} – ${row.priceHigh === null ? '—' : formatMoney(row.priceHigh)}`;
      return `<tr><td><b>${escapeHtml(row.date)}</b></td><td>${row.symbol ? companyIdentity(row.symbol, row.name) : `<b>${escapeHtml(row.name)}</b>`}</td><td>${escapeHtml(row.exchange)}</td><td>${row.shares === null ? 'Not reported' : Number(row.shares).toLocaleString('en-US')}</td><td>${range}</td></tr>`;
    }).join('') : '<tr><td colspan="5">No upcoming US IPO dates were reported by the connected provider.</td></tr>';
    $('#ipo-updated').textContent = future.length ? `${future.length} upcoming listings` : 'No upcoming listings reported';
  };
  const drawCalendar = () => {
    const search = $('#earnings-search').value.trim().toUpperCase();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = calendarPeriod === 'all' ? Infinity : Number(calendarPeriod);
    const filtered = calendarRows.filter(row => {
      const date = new Date(`${row.date}T00:00:00`);
      const distance = (date - today) / 86400000;
      return distance >= -1 && distance <= days && (!search || row.symbol.includes(search) || String(row.name).toUpperCase().includes(search));
    }).slice(0, 80);
    $('#earnings-visible').textContent = `${filtered.length} ${filtered.length === 1 ? 'event' : 'events'} shown${calendarRows.length ? ` from ${calendarRows.length} reported` : ''}`;
    $('#earnings-calendar-body').innerHTML = filtered.length ? filtered.map(row => {
      const session = /bmo|before/.test(row.time) ? 'Before open' : /amc|after/.test(row.time) ? 'After close' : 'Time not reported';
      const tracked = alerts.some(item => item.type === 'earnings' && item.ticker === row.symbol && item.date === row.date);
      return `<tr class="company-row" data-stock="${escapeHtml(row.symbol)}"><td><b>${escapeHtml(row.date || 'TBA')}</b></td><td>${companyIdentity(row.symbol, row.name)}</td><td>${session}</td><td>${row.eps === null ? 'Not reported' : formatMoney(row.eps)}</td><td>${row.revenue === null ? 'Not reported' : money(row.revenue)}</td><td><button class="track-earnings ${tracked ? 'tracked' : ''}" type="button" data-track-earnings="${escapeHtml(row.symbol)}" data-earnings-date="${escapeHtml(row.date)}" data-earnings-name="${escapeHtml(row.name)}">${tracked ? 'Tracking' : 'Track'}</button></td><td><button class="link-button" data-page="${escapeHtml(row.symbol)}">Research</button></td></tr>`;
    }).join('') : `<tr><td colspan="7"><div class="calendar-empty"><b>No reported earnings match this view</b><span>${search ? 'Clear the company filter or widen the date range.' : 'Widen the date range to see all provider-reported events.'}</span><button type="button" data-show-all-earnings>Show all available</button></div></td></tr>`;
    wireCommon();
    document.querySelectorAll('[data-track-earnings]').forEach(button => button.onclick = event => {
      event.stopPropagation();
      const ticker = button.dataset.trackEarnings; const date = button.dataset.earningsDate;
      const index = alerts.findIndex(item => item.type === 'earnings' && item.ticker === ticker && item.date === date);
      if (index >= 0) alerts.splice(index, 1);
      else alerts.unshift({ id:`earnings-${Date.now()}`, type:'earnings', ticker, date, name:button.dataset.earningsName, createdAt:new Date().toISOString() });
      localStorage.setItem('dd-price-alerts', JSON.stringify(alerts));
      recordResearchActivity('earnings', `${index >= 0 ? 'Stopped' : 'Started'} tracking ${ticker} earnings`, date, ticker);
      queueResearchStateSync(); drawCalendar();
    });
    document.querySelector('[data-show-all-earnings]')?.addEventListener('click', () => {
      calendarPeriod = 'all';
      document.querySelectorAll('[data-earnings-period]').forEach(item => item.classList.toggle('selected', item.dataset.earningsPeriod === 'all'));
      drawCalendar();
    });
  };
  const loadCalendar = async () => {
    try {
      const data = await getJson('/data/calendar', 45000);
      calendarRows = (Array.isArray(data.earnings) ? data.earnings : []).map(normaliseEarnings).filter(row => row.symbol && row.date).sort((a, b) => a.date.localeCompare(b.date));
      ipoRows = (Array.isArray(data.ipos) ? data.ipos : []).map(normaliseIpo).filter(row => row.date && (row.symbol || row.name)).sort((a, b) => a.date.localeCompare(b.date));
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const hasNearTermEvents = calendarRows.some(row => {
        const distance = (new Date(`${row.date}T00:00:00`) - today) / 86400000;
        return distance >= -1 && distance <= 7;
      });
      if (calendarRows.length && !hasNearTermEvents && calendarPeriod === '7') {
        calendarPeriod = 'all';
        document.querySelectorAll('[data-earnings-period]').forEach(item => item.classList.toggle('selected', item.dataset.earningsPeriod === 'all'));
      }
      $('#earnings-updated').textContent = `${calendarRows.length} reported events · updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
      drawCalendar();
      drawIpoCalendar();
    } catch {
      $('#earnings-updated').textContent = 'Calendar temporarily unavailable';
      $('#earnings-visible').textContent = 'Live calendar unavailable';
      $('#earnings-calendar-body').innerHTML = '<tr><td colspan="7">The provider calendar could not be loaded. Try again shortly.</td></tr>';
      if ($('#ipo-updated')) $('#ipo-updated').textContent = 'Calendar temporarily unavailable';
      if ($('#ipo-calendar-body')) $('#ipo-calendar-body').innerHTML = '<tr><td colspan="5">The provider IPO calendar could not be loaded. Try again shortly.</td></tr>';
    }
  };
  let liveUsdInr = 0;
  const calculateIndiaReturn = () => {
    const amount = Number($('#india-usd-amount').value); const stockReturn = Number($('#india-stock-return').value) / 100; const fxChange = Number($('#india-fx-change').value) / 100;
    if (!(amount >= 0) || !Number.isFinite(stockReturn) || !Number.isFinite(fxChange) || !(liveUsdInr > 0)) return;
    const initialInr = amount * liveUsdInr; const finalInr = amount * (1 + stockReturn) * liveUsdInr * (1 + fxChange); const total = initialInr ? ((finalInr / initialInr) - 1) * 100 : 0;
    $('#india-final-inr').textContent = inr(finalInr); $('#india-total-return').textContent = `${total >= 0 ? '+' : ''}${total.toFixed(2)}% combined INR return`; $('#india-total-return').className = total >= 0 ? 'positive' : 'down';
  };
  getJson('/data/fx-rate', 30000).then(data => { liveUsdInr = Number(data.rate); $('#india-fx-rate').textContent = `USD/INR ₹${liveUsdInr.toFixed(2)} · live`; calculateIndiaReturn(); }).catch(() => { $('#india-fx-rate').textContent = 'USD/INR unavailable'; });
  ['india-usd-amount','india-stock-return','india-fx-change'].forEach(id => $(`#${id}`).oninput = calculateIndiaReturn);
  $('#valuation-load').onclick = () => loadValuation();
  setupValuationSearch();
  ['valuation-price','valuation-eps','valuation-growth','valuation-pe','valuation-discount','valuation-years'].forEach(id => $(`#${id}`).oninput = calculate);
  $('#valuation-save').onclick = () => {
    const result = calculate();
    if (!result) return;
    const symbol = $('#valuation-symbol').value.trim().toUpperCase();
    if (!activeValuationSymbol || symbol !== activeValuationSymbol) {
      setValuationStatus('Load the selected company before saving this case.', 'error');
      return;
    }
    const caseName = $('#valuation-case-name').value.trim() || `${symbol} base case`;
    valuationCases.unshift({ id:`case-${Date.now()}`, symbol, name:caseName, ...result, savedAt:new Date().toISOString(), savedLabel:new Date().toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) });
    valuationCases = valuationCases.slice(0, 24);
    recordResearchActivity('valuation', `Saved ${symbol} valuation case`, caseName, symbol);
    $('#valuation-case-name').value = '';
    saveToolState();
    drawCases();
    setValuationStatus(`${caseName} saved to your research workspace.`, 'success');
  };
  document.querySelectorAll('[data-earnings-period]').forEach(button => button.onclick = () => { calendarPeriod = button.dataset.earningsPeriod; document.querySelectorAll('[data-earnings-period]').forEach(item => item.classList.toggle('selected', item === button)); drawCalendar(); });
  $('#earnings-search').oninput = drawCalendar;
  drawCases();
  loadValuation('AAPL');
  loadCalendar();
}

function savePortfolio() {
  portfolio.updatedAt = new Date().toISOString();
  try { localStorage.setItem('dd-portfolio', JSON.stringify(portfolio)); } catch {}
  queueResearchStateSync();
}
function inr(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 }).format(Number(value)) : '—';
}
async function hydratePortfolio() {
  const holder = $('#portfolio-body'); if (!holder) return;
  const holdings = Array.isArray(portfolio?.holdings) ? portfolio.holdings : [];
  if (!holdings.length) { holder.innerHTML = '<tr><td colspan="8">Add your first holding above.</td></tr>'; return; }
  try {
    const [rows, fx] = await Promise.all([
      getJson(`/data/watchlist?symbols=${encodeURIComponent(holdings.map(item => item.symbol).join(','))}`, 45000),
      getJson('/data/fx-rate', 20000).catch(() => ({ rate:null }))
    ]);
    if (page !== 'portfolio' || !$('#portfolio-body')) return;
    const bySymbol = new Map((rows || []).map(row => [String(row.symbol || '').toUpperCase(), row]));
    const enriched = holdings.map(item => ({ ...item, quote:bySymbol.get(item.symbol) || {} }));
    const marketValue = enriched.reduce((sum, item) => sum + Number(item.shares || 0) * Number(item.quote.price || 0), 0);
    const costValue = enriched.reduce((sum, item) => sum + Number(item.shares || 0) * Number(item.averageCost || 0), 0);
    const dayChange = enriched.reduce((sum, item) => { const price = Number(item.quote.price || 0); const change = Number(item.quote.changesPercentage ?? item.quote.changePercentage); return sum + (Number.isFinite(change) ? Number(item.shares || 0) * price * (change / (100 + change)) : 0); }, 0);
    const totalReturn = marketValue - costValue;
    $('#portfolio-market-value').textContent = money(marketValue);
    $('#portfolio-market-inr').textContent = Number.isFinite(Number(fx.rate)) ? `${inr(marketValue * Number(fx.rate))} at ₹${Number(fx.rate).toFixed(2)}/USD` : 'USD/INR temporarily unavailable';
    $('#portfolio-day-change').textContent = `${dayChange >= 0 ? '+' : '-'}${money(Math.abs(dayChange))}`;
    $('#portfolio-day-change').className = dayChange >= 0 ? 'positive' : 'down';
    $('#portfolio-total-return').textContent = costValue ? `${totalReturn >= 0 ? '+' : '-'}${money(Math.abs(totalReturn))} · ${percent((totalReturn / costValue) * 100)}` : '—';
    $('#portfolio-total-return').className = totalReturn >= 0 ? 'positive' : 'down';
    $('#portfolio-fx').textContent = Number.isFinite(Number(fx.rate)) ? `₹${Number(fx.rate).toFixed(2)}` : '—';
    $('#portfolio-updated').textContent = `updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    holder.innerHTML = enriched.map(item => {
      const price = Number(item.quote.price); const value = Number(item.shares) * (Number.isFinite(price) ? price : 0); const cost = Number(item.shares) * Number(item.averageCost || 0); const gain = value - cost; const change = Number(item.quote.changesPercentage ?? item.quote.changePercentage);
      return `<tr class="company-row" data-stock="${escapeHtml(item.symbol)}"><td>${companyIdentity(item.symbol, item.quote.name || item.name || item.symbol, item.quote.sector || 'US Equity')}</td><td>${Number(item.shares).toLocaleString('en-US', { maximumFractionDigits:6 })}</td><td>$${Number(item.averageCost).toFixed(2)}</td><td>${Number.isFinite(price) ? `$${price.toFixed(2)}` : '—'}</td><td>${value ? money(value) : '—'}</td><td class="${change >= 0 ? 'positive' : 'down'}">${Number.isFinite(change) ? percent(change) : '—'}</td><td class="${gain >= 0 ? 'positive' : 'down'}">${cost && value ? `${percent((gain / cost) * 100)} · ${gain >= 0 ? '+' : '-'}${money(Math.abs(gain))}` : '—'}</td><td><button type="button" data-remove-holding="${escapeHtml(item.symbol)}">Remove</button></td></tr>`;
    }).join('');
    const allocation = $('#portfolio-allocation');
    allocation.innerHTML = marketValue ? enriched.sort((a, b) => Number(b.shares) * Number(b.quote.price || 0) - Number(a.shares) * Number(a.quote.price || 0)).map(item => { const value = Number(item.shares) * Number(item.quote.price || 0); const weight = (value / marketValue) * 100; return `<div><span><b>${escapeHtml(item.symbol)}</b><small>${money(value)}</small></span><em>${weight.toFixed(1)}%</em><i style="--allocation:${Math.max(1, weight)}%"></i></div>`; }).join('') : '<p class="sub">Live values are unavailable.</p>';
    holder.querySelectorAll('[data-remove-holding]').forEach(button => button.onclick = event => { event.stopPropagation(); const ticker = button.dataset.removeHolding; portfolio.holdings = portfolio.holdings.filter(item => item.symbol !== ticker); savePortfolio(); recordResearchActivity('portfolio', `Removed ${ticker} from portfolio`, '', ticker); render(); });
    wireCommon();
  } catch {
    holder.innerHTML = '<tr><td colspan="8">Live portfolio data is temporarily unavailable. Your saved holdings are safe.</td></tr>';
  }
}
function setupPortfolio() {
  const input = $('#portfolio-symbol'); const results = $('#portfolio-symbol-results'); let timer; let selected = null;
  input.oninput = () => { selected = null; clearTimeout(timer); const query = input.value.trim(); if (query.length < 1) { results.hidden = true; return; } timer = setTimeout(async () => { results.hidden = false; results.innerHTML = '<button disabled>Searching live directory…</button>'; try { const found = await getJson(`/data/search?q=${encodeURIComponent(query)}`, 15000); results.innerHTML = (found || []).slice(0, 8).map(item => { const symbol = String(item.symbol || item.ticker || '').toUpperCase(); const name = item.name || item.companyName || symbol; return `<button type="button" data-portfolio-symbol="${escapeHtml(symbol)}" data-portfolio-name="${escapeHtml(name)}">${companyLogo(symbol, name, 'small')}<span><b>${escapeHtml(name)}</b><small>${escapeHtml(symbol)} · ${escapeHtml(item.exchangeShortName || item.exchange || 'NASDAQ/NYSE')}</small></span></button>`; }).join('') || '<button disabled>No matching US company</button>'; results.querySelectorAll('[data-portfolio-symbol]').forEach(button => button.onclick = () => { selected = { symbol:button.dataset.portfolioSymbol, name:button.dataset.portfolioName }; input.value = selected.symbol; results.hidden = true; $('#portfolio-shares').focus(); }); } catch { results.innerHTML = '<button disabled>Directory temporarily unavailable</button>'; } }, 180); };
  input.onblur = () => setTimeout(() => { results.hidden = true; }, 160);
  $('#portfolio-add').onclick = async () => { let symbol = String(selected?.symbol || input.value).trim().toUpperCase(); if (!/^[A-Z.]{1,10}$/.test(symbol)) return input.focus(); const shares = Number($('#portfolio-shares').value); const averageCost = Number($('#portfolio-cost').value); if (!(shares > 0) || !(averageCost >= 0)) return $('#portfolio-shares').focus(); const existing = portfolio.holdings.find(item => item.symbol === symbol); if (existing) { const oldShares = Number(existing.shares); const totalShares = oldShares + shares; existing.averageCost = totalShares ? ((oldShares * Number(existing.averageCost) + shares * averageCost) / totalShares) : averageCost; existing.shares = totalShares; } else portfolio.holdings.push({ symbol, name:selected?.name || symbol, shares, averageCost, addedAt:new Date().toISOString() }); savePortfolio(); recordResearchActivity('portfolio', `Added ${symbol} to portfolio`, `${shares} shares at $${averageCost.toFixed(2)}`, symbol); render(); };
  $('#portfolio-name').onchange = () => { portfolio.name = $('#portfolio-name').value.trim().slice(0, 60) || 'My US portfolio'; savePortfolio(); };
  $('#portfolio-refresh').onclick = () => { jsonRequestCache.clear(); hydratePortfolio(); };
  hydratePortfolio();
}
async function hydrateSystemStatus() {
  if (!$('#system-overall')) return;
  try {
    const status = await getJson('/data/system-status', 30000);
    if (page !== 'status' || !$('#system-overall')) return;
    const label = value => value ? 'Operational' : 'Unavailable';
    $('#system-overall').textContent = status.status === 'ok' ? 'All core systems operational' : 'Some live-data services are degraded';
    $('#system-checked').textContent = `Last checked ${new Date(status.checkedAt).toLocaleString()} · server uptime ${status.uptimeHours.toFixed(1)} hours`;
    $('#status-website').textContent = label(status.website);
    $('#status-fmp').textContent = label(status.providers?.fmp);
    $('#status-twelve').textContent = label(status.providers?.twelveData);
    $('#status-global').textContent = label(status.globalMarkets?.available);
    $('#status-database').textContent = status.databaseConfigured ? 'Connected' : 'Not configured';
    document.querySelector('.status-hero')?.classList.toggle('degraded', status.status !== 'ok');
  } catch { $('#system-overall').textContent = 'Live status check failed'; $('#system-checked').textContent = 'The website is open, but the operations endpoint did not respond.'; }
}
function setupSystemStatus() { $('#status-refresh').onclick = () => { jsonRequestCache.clear(); hydrateSystemStatus(); }; hydrateSystemStatus(); }

setupTheme();
setupSearch();
render();
setupAuth();
startLiveRefresh();
