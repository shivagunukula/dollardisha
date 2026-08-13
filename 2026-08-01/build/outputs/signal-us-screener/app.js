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
let authClient = null;
let authSession = null;
let authMode = 'login';

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
function row(stock) {
  const rawChange = stock.change ?? stock.changesPercentage ?? stock.changePercentage;
  const hasChange = Number.isFinite(Number(rawChange));
  const change = Number(rawChange || 0);
  const ticker = stock.symbol || stock.ticker;
  const name = stock.companyName || stock.name || ticker;
  const price = scanNumber(stock.price, stock.close);
  const cap = scanNumber(stock.marketCap, stock.mktCap, stock.cap ? stock.cap * 1e9 : null);
  const pe = scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM);
  return `<tr class="company-row" data-stock="${ticker}"><td class="company">${escapeHtml(name)}<span class="ticker">${escapeHtml(ticker)}</span></td><td>${price !== null ? `$${Number(price).toFixed(2)}` : 'Quote unavailable'}</td><td>${cap !== null ? money(cap) : 'Not reported'}</td><td>${pe !== null && Number(pe) > 0 ? `${Number(pe).toFixed(1)}x` : 'N/M'}</td><td class="${hasChange ? (change >= 0 ? 'positive' : 'down') : ''}">${hasChange ? percent(change) : 'Not reported'}</td><td>${watchButton(ticker)}</td></tr>`;
}
const scanNumber = (...values) => values.find(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) ?? null;
const scanPercent = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.abs(number) <= 2 ? number * 100 : number;
};
function screenerRow(stock) {
  const ticker = stock.symbol || stock.ticker;
  const name = stock.companyName || stock.name || ticker;
  const cap = scanNumber(stock.marketCap, stock.cap ? stock.cap * 1e9 : null);
  const pe = scanNumber(stock.pe, stock.peRatioTTM, stock.priceToEarningsRatioTTM);
  const roe = scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe));
  const volume = scanNumber(stock.volume, stock.avgVolume);
  const sector = stock.sector || 'Not classified';
  return `<tr class="company-row" data-stock="${ticker}"><td class="company">${escapeHtml(name)}<span class="ticker">${escapeHtml(ticker)}</span></td><td>${scanNumber(stock.price) !== null ? `$${Number(stock.price).toFixed(2)}` : 'Not available'}</td><td>${cap !== null ? money(cap) : 'Not available'}</td><td title="N/M means not meaningful or not reported">${pe !== null && pe > 0 ? `${Number(pe).toFixed(1)}x` : 'N/M'}</td><td>${roe !== null ? `${roe.toFixed(1)}%` : 'Not reported'}</td><td>${volume !== null ? whole(volume) : 'Not available'}</td><td>${escapeHtml(sector)}</td><td>${watchButton(ticker)}</td></tr>`;
}
function pageHeader(kicker, title, text) { return `<div class="section-header"><div><p class="crumb">${kicker}</p><h1 class="page-title">${title}</h1><p class="sub">${text}</p></div></div>`; }

function dashboardView() {
  return `<div class="page">${pageHeader('US EQUITY RESEARCH', 'Your research desk.', 'Screen US stocks, read official filings, compare companies and organise your ideas.')}
  <section class="market-grid" id="market-cards">${['NVDA', 'MSFT', 'AAPL', 'GOOGL'].map((ticker) => `<div class="market-card"><span>${ticker}</span><strong>Loading…</strong><b>Latest available quote</b></div>`).join('')}</section>
  <section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>Research workflow</h2><p>Everything starts with a question.</p></div></div><div class="workflow"><button data-page="screener"><b>1</b><span>Screen US equities<small>Use filters and export your list</small></span></button><button data-page="markets"><b>2</b><span>See market scans<small>Find leaders, gainers and laggards</small></span></button><button data-page="research"><b>3</b><span>Write your thesis<small>Read SEC filings and save notes</small></span></button></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Your watchlist</h2><p>${watchlist.length ? `${watchlist.length} saved companies` : 'No companies saved yet'}</p></div><button data-page="watchlist">Open</button></div>${watchlist.slice(0, 3).map((ticker) => { const stock = stocks.find((item) => item.ticker === ticker) || { ticker, name: ticker, change: 0 }; return `<div class="idea"><div class="avatar">${ticker.slice(0, 2)}</div><div><b>${escapeHtml(stock.name)}</b><small>${ticker}</small></div><strong class="${stock.change >= 0 ? 'positive' : 'down'}">${percent(stock.change)}</strong></div>`; }).join('') || '<div class="watch-empty"><b>Your research list is waiting</b>Add companies from Market Scans or the Stock Screener.</div>'}</div></section>
  <section class="panel" style="margin-top:18px"><div class="panel-head"><div><h2>What you can do now</h2><p>Research features are ready to use.</p></div></div><div class="workflow"><button data-page="markets"><b>◆</b><span>Market Scans<small>Gainers, losers, leaders</small></span></button><button data-page="indexlab"><b>◎</b><span>Custom Index<small>Make your own US-stock basket</small></span></button><button data-page="compare"><b>↔</b><span>Compare Companies<small>Review two stocks side by side</small></span></button></div></section></div>`;
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
  <div class="query-card"><div><b>Build a US equity screen</b><small>Search once, then combine size, liquidity, valuation and quality filters.</small></div><input id="screen-search" placeholder="Search a company or ticker"><button class="solid-btn" id="screen-run">Refresh data</button><button class="link-button" id="export-screen">Export CSV</button></div>
  <div class="screen-presets" aria-label="Quick screening presets"><span>Popular screens</span><button data-screen-preset="mega">Mega-cap leaders</button><button data-screen-preset="value">Profitable value</button><button data-screen-preset="quality">High ROE</button><button data-screen-preset="liquid">Highly liquid</button><button data-screen-preset="dividend">Dividend payers</button><button data-screen-preset="reset">Clear all</button></div>
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
  </aside><section class="table-panel"><div class="result-meta"><span id="screen-count">Loading active US stocks…</span><span>Click a company to research it</span></div><div class="screen-data-note" id="screen-data-note">Funds and ETFs are excluded. Financial ratios appear when reported by the company.</div><div class="table-wrap"><table class="screener-table"><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>ROE</th><th>Volume</th><th>Sector</th><th></th></tr></thead><tbody id="screen-table"><tr><td colspan="8">Loading the US stock directory…</td></tr></tbody></table></div></section></div></div>`;
}

function indexView() {
  const equal = basket.symbols.length ? (100 / basket.symbols.length).toFixed(1) : '0.0';
  return `<div class="page">${pageHeader('BUILD YOUR OWN BENCHMARK', 'Custom Index', 'Create a personal US-stock basket to organise your research ideas.')}
  <section class="index-hero"><div><span>YOUR INDEX</span><h2>${escapeHtml(basket.name)}</h2><p>${basket.symbols.length} companies · Equal weight <b>${equal}%</b> each</p></div><div class="index-actions"><input id="basket-ticker" maxlength="10" placeholder="Add ticker, e.g. TSLA"><button id="basket-add" class="solid-btn">Add company</button></div></section>
  <section class="index-lab-grid"><div class="panel"><div class="panel-head"><div><h2>Index holdings</h2><p>Add tickers you want to study together.</p></div><button id="basket-rename" class="link-button">Rename</button></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Reference price</th><th>Weight</th><th></th></tr></thead><tbody>${basket.symbols.map((ticker) => { const stock = stocks.find((item) => item.ticker === ticker); return `<tr><td class="company">${escapeHtml(stock ? stock.name : ticker)}<span class="ticker">${ticker}</span></td><td>${stock ? `$${stock.price.toFixed(2)}` : 'Open research'}</td><td>${equal}%</td><td><button data-remove-basket="${ticker}">Remove</button></td></tr>`; }).join('') || '<tr><td colspan="4">Add a ticker above to create your index.</td></tr>'}</tbody></table></div></div><aside class="panel"><div class="panel-head"><div><h2>How to use it</h2><p>A research tool, not a portfolio tracker</p></div></div><div class="callout"><b>Compare ideas consistently</b>Build a theme, a watchlist or a personal benchmark, then review its holdings against broad US indices.</div></aside></section></div>`;
}

function researchView() {
  return `<div class="page">${pageHeader('COMPANY DISCLOSURES & YOUR RESEARCH', 'Research Hub', 'Read official SEC filings, save price-alert ideas and record your own investment research.')}
  <div class="research-grid"><section class="panel"><div class="panel-head"><div><h2>SEC filing finder</h2><p>Official company disclosures from EDGAR</p></div></div><div class="filing-search"><input id="filing-ticker" value="AAPL" maxlength="10" placeholder="Ticker e.g. AAPL"><button id="filing-find" class="solid-btn">Find filings</button></div><div id="filing-results" class="filing-results"><p class="sub">Search a US ticker to see its latest SEC filings.</p></div></section>
  <section class="panel"><div class="panel-head"><div><h2>Price-alert ideas</h2><p>Saved in this browser</p></div></div><div class="alert-form"><input id="alert-ticker" placeholder="Ticker"><select id="alert-direction"><option value="above">Price goes above</option><option value="below">Price goes below</option></select><input id="alert-price" type="number" placeholder="Price"><button id="alert-add" class="solid-btn">Save alert</button></div><div id="alerts-list" class="alert-list"></div></section></div>
  <section class="panel journal-panel"><div class="panel-head"><div><h2>Research journal</h2><p>Write the reason, risk and evidence behind every idea.</p></div></div><div class="journal-form"><input id="note-ticker" placeholder="Ticker, e.g. NVDA"><textarea id="note-text" placeholder="What do you believe? What would prove you wrong?"></textarea><button id="note-save" class="solid-btn">Save research note</button></div><div id="notes-list" class="notes-list"></div></section></div>`;
}

function compareView() { return `<div class="page">${pageHeader('RESEARCH SIDE BY SIDE', 'Compare companies', 'Search the complete US stock directory and compare two companies side by side.')}<section class="panel compare-panel"><div class="compare-controls"><div class="compare-picker"><label for="compare-a">First company</label><div class="compare-search"><span>⌕</span><input id="compare-a" value="AAPL" maxlength="50" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="compare-a-results"><div id="compare-a-results" class="compare-results" hidden></div></div></div><span class="compare-vs">VS</span><div class="compare-picker"><label for="compare-b">Second company</label><div class="compare-search"><span>⌕</span><input id="compare-b" value="MSFT" maxlength="50" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="compare-b-results"><div id="compare-b-results" class="compare-results" hidden></div></div></div><button id="compare-run" class="solid-btn">Compare stocks</button></div><div id="comparison"></div></section></div>`; }
function watchlistView() { const placeholders = watchlist.map(ticker => `<tr class="company-row" data-stock="${ticker}"><td class="company">${ticker}<span class="ticker">Updating live data…</span></td><td colspan="4">Loading latest values…</td><td>${watchButton(ticker)}</td></tr>`).join(''); return `<div class="page">${pageHeader('YOUR RESEARCH', 'Watchlist', 'Latest available prices and fundamentals. Values refresh every minute while this page is open.')}<section class="panel"><div class="watchlist-toolbar"><span id="watchlist-status" role="status" aria-live="polite">${watchlist.length ? 'Loading live prices…' : 'Add a company to begin.'}</span>${watchlist.length ? '<button type="button" class="link-button" data-refresh-watchlist>Refresh now</button>' : ''}</div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>Today</th><th></th></tr></thead><tbody id="watchlist-body">${placeholders || '<tr><td colspan="6">Your watchlist is empty. Add a company from any scan.</td></tr>'}</tbody></table></div></section></div>`; }
function companyView(ticker) { const stock = stocks.find((item) => item.ticker === ticker) || { ticker, name: ticker, sector: 'US Equity' }; return `<div class="page">${pageHeader(`US STOCKS / ${escapeHtml(stock.sector).toUpperCase()}`, escapeHtml(stock.name), `${ticker} · US EQUITY`)}<section class="detail-grid"><div><section class="panel"><div class="panel-head"><div><h2>Company research</h2><p id="company-description">Loading company profile and latest available quote…</p></div>${watchButton(ticker)}</div><div class="key-metrics"><div><span>Price</span><b id="company-price">${stock.price ? `$${stock.price.toFixed(2)}` : '—'}</b></div><div><span>Today</span><b id="company-change" class="${stock.change >= 0 ? 'positive' : 'down'}">${percent(stock.change)}</b></div><div><span>Market cap</span><b id="company-cap">${money(stock.cap * 1e9)}</b></div><div><span>P/E ratio</span><b id="company-pe">${stock.pe ? `${stock.pe}x` : '—'}</b></div><div><span>ROE</span><b>${stock.roe ? `${stock.roe}%` : '—'}</b></div></div></section><section class="panel" style="margin-top:18px"><div class="panel-head"><div><h2>Research checklist</h2><p>Keep your decision process consistent</p></div></div><div class="checklist"><label><input type="checkbox"> Understand the business</label><label><input type="checkbox"> Review revenue and profit trend</label><label><input type="checkbox"> Compare valuation and peers</label><label><input type="checkbox"> Write the risk case</label></div></section></div><aside class="panel"><div class="panel-head"><div><h2>Next steps</h2><p>Use the Research Hub for filings and notes.</p></div></div><button data-page="research" class="solid-btn">Open Research Hub</button></aside></section></div>`; }

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
function companyView(ticker) { return `<div class="page company-page"><div class="company-top"><div><p class="crumb">US EQUITY RESEARCH</p><h1 class="page-title" id="company-title">${escapeHtml(ticker)}</h1><p class="sub" id="company-subtitle">${escapeHtml(ticker)} · Loading company research…</p></div><button class="solid-btn" data-watch="${ticker}">Follow</button></div><nav class="company-tabs"><a href="#overview">Overview</a><a href="#chart">Chart</a><a href="#financials">Financials</a><a href="#ratios">Ratios</a><a href="#documents">Documents</a></nav><section id="overview" class="panel company-summary"><div class="summary-main"><div><b id="company-price">—</b><span id="company-change">Quote loading…</span></div><p id="company-description">Loading company profile and latest available quote…</p></div><div class="company-metrics"><div><span>Market cap</span><b id="company-cap">—</b></div><div><span>P/E ratio</span><b id="company-pe">—</b></div><div><span>Day high / low</span><b id="company-range">—</b></div><div><span>Volume</span><b id="company-volume">—</b></div><div><span>Sector</span><b id="company-sector">—</b></div><div><span>Website</span><b id="company-site">—</b></div></div></section><section id="chart" class="panel chart-panel"><div class="panel-head"><div><h2>Price & volume</h2><p>One-year daily history · latest available market data</p></div></div><div id="company-chart" class="chart-area">Loading chart…</div></section><div id="financials" class="financial-stack"></div><section id="ratios" class="panel ratios-panel"><div class="panel-head"><div><h2>Key ratios</h2><p>Trailing twelve months where available</p></div></div><div id="company-ratios" class="ratio-grid"><span>Loading ratios…</span></div></section><section class="research-grid"><div class="panel"><div class="panel-head"><div><h2>Research points</h2><p>Automatically calculated only from reported data</p></div></div><div id="company-points" class="research-points"><p class="data-empty">Loading reported financial data…</p></div></div><div class="panel"><div class="panel-head"><div><h2>Peers & ownership</h2><p>Provider coverage varies by company</p></div></div><div class="data-empty">Peer comparison and institutional ownership will appear once the connected data plan supports this company.</div></div></section><section id="documents" class="panel documents-panel"><div class="panel-head"><div><h2>SEC documents</h2><p>Official company filings</p></div><button class="link-button" data-page="research">Open filing search</button></div><div id="company-documents" class="data-empty">Search this ticker in Research Hub to view 10-K, 10-Q and other SEC filings.</div></section></div>`; }
function companyView(ticker) { return `<div class="page company-page"><div class="company-top"><div><p class="crumb">US EQUITY RESEARCH</p><h1 class="page-title" id="company-title">${escapeHtml(ticker)}</h1><p class="sub" id="company-subtitle">${escapeHtml(ticker)} · Loading company research…</p></div><button class="solid-btn" data-watch="${ticker}">Follow</button></div><nav class="company-tabs"><a href="#overview">Overview</a><a href="#chart">Chart</a><a href="#financials">Financials</a><a href="#ratios">Ratios</a><a href="#peers">Peers</a><a href="#documents">Documents</a></nav><section id="overview" class="panel company-summary"><div class="summary-main"><div><b id="company-price">—</b><span id="company-change">Quote loading…</span></div><p id="company-description">Loading company profile and latest available quote…</p></div><div class="company-metrics"><div><span>Market cap</span><b id="company-cap">—</b></div><div><span>P/E ratio</span><b id="company-pe">—</b></div><div><span>Day high / low</span><b id="company-range">—</b></div><div><span>Volume</span><b id="company-volume">—</b></div><div><span>Sector</span><b id="company-sector">—</b></div><div><span>Website</span><b id="company-site">—</b></div></div></section><section id="chart" class="panel chart-panel"><div class="panel-head"><div><h2>Price & volume</h2><p>One-year daily history · latest available market data</p></div></div><div id="company-chart" class="chart-area">Loading chart…</div></section><div id="financials" class="financial-stack"></div><section id="ratios" class="panel ratios-panel"><div class="panel-head"><div><h2>Key ratios</h2><p>Trailing twelve months where available</p></div></div><div id="company-ratios" class="ratio-grid"><span>Loading ratios…</span></div></section><section id="peers" class="panel documents-panel"><div class="panel-head"><div><h2>Peer comparison</h2><p>Companies in the same sector and industry</p></div></div><div id="company-peers" class="data-empty">Peer data is loading…</div></section><section id="documents" class="panel documents-panel"><div class="panel-head"><div><h2>Recent SEC filings</h2><p>Official documents, direct from the SEC</p></div></div><div id="company-documents" class="data-empty">Loading recent filings…</div></section></div>`; }
function render() {
  const view = page === 'dashboard' ? dashboardView() : page === 'markets' ? marketsView() : page === 'screener' ? screenerView() : page === 'indexlab' ? indexView() : page === 'research' ? researchView() : page === 'compare' ? compareView() : page === 'watchlist' ? watchlistView() : companyView(page);
  $('#content').innerHTML = view;
  document.querySelectorAll('.nav').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('#watch-count').textContent = watchlist.length;
  wireCommon();
  if (page === 'dashboard') hydrateDashboard();
  if (page === 'markets') setupMarkets();
  if (page === 'screener') setupScreener();
  if (page === 'indexlab') setupIndex();
  if (page === 'research') setupResearch();
  if (page === 'compare') setupCompare();
  if (page === 'watchlist') hydrateWatchlist();
  else { clearTimeout(watchlistRefreshTimer); watchlistRefreshTimer = null; }
  if (!['dashboard', 'markets', 'screener', 'indexlab', 'research', 'compare', 'watchlist'].includes(page)) { hydrateCompany(page); hydrateCompanyExtras(page); }
}

// Refresh only the live regions on the current screen once per minute. This
// keeps prices, scans, charts, ratios, peers and filings current without
// reloading the whole document or interrupting the user's scroll position.
const LIVE_REFRESH_MS = 60 * 1000;
let liveRefreshTimer = null;
let liveRefreshBusy = false;
const isCompanyRoute = route => !['dashboard', 'markets', 'screener', 'indexlab', 'research', 'compare', 'watchlist'].includes(route);
async function refreshLiveData() {
  if (document.hidden || liveRefreshBusy) return;
  liveRefreshBusy = true;
  try {
    jsonRequestCache.clear();
    if (page === 'dashboard') await hydrateDashboard();
    else if (page === 'watchlist') await hydrateWatchlist();
    else if (isCompanyRoute(page)) await Promise.allSettled([hydrateCompany(page), hydrateCompanyExtras(page)]);
    else if (page === 'markets' || page === 'screener' || page === 'indexlab' || page === 'compare') render();
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

const routeSections = new Set(['overview', 'chart', 'strengths', 'quarterly', 'ownership', 'financials', 'ratios', 'peers', 'intelligence', 'updates', 'documents']);
const routeFromHash = () => {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw.includes('=') || raw.startsWith('access_token') || raw.startsWith('error')) return null;
  const decoded = decodeURIComponent(raw);
  return routeSections.has(decoded) ? null : decoded;
};
const routeHref = target => `${window.location.pathname}${window.location.search}#${encodeURIComponent(target)}`;
function navigateTo(target, { replace = false } = {}) {
  const next = String(target || 'dashboard');
  const href = routeHref(next);
  if (window.location.hash !== `#${encodeURIComponent(next)}`) {
    window.history[replace ? 'replaceState' : 'pushState']({ page: next }, '', href);
  }
  page = next;
  render();
}
function openRouteInNewTab(target) {
  const opened = window.open(routeHref(target), '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}
function wireCommon() {
  document.querySelectorAll('[data-page]').forEach((button) => {
    const target = button.dataset.page;
    if (button.tagName === 'A') return;
    button.setAttribute('title', 'Open with Ctrl/Cmd-click or middle-click in a new tab');
    button.onclick = event => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); openRouteInNewTab(target); return; }
      navigateTo(target);
    };
    button.onauxclick = event => {
      if (event.button === 1) { event.preventDefault(); openRouteInNewTab(target); }
    };
  });
  document.querySelectorAll('[data-stock]').forEach((element) => {
    const target = element.dataset.stock;
    element.onclick = event => {
      if (event.target.closest('[data-watch]')) return;
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); openRouteInNewTab(target); return; }
      navigateTo(target); window.scrollTo(0, 0);
    };
    element.onauxclick = event => {
      if (event.button === 1 && !event.target.closest('[data-watch]')) { event.preventDefault(); openRouteInNewTab(target); }
    };
  });
  document.querySelectorAll('[data-watch]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); const ticker = button.dataset.watch; watchlist = watchlist.includes(ticker) ? watchlist.filter((item) => item !== ticker) : [...watchlist, ticker]; localStorage.setItem('dd-watchlist', JSON.stringify(watchlist)); render(); });
  document.querySelectorAll('[data-refresh-watchlist]').forEach((button) => button.onclick = () => hydrateWatchlist());
}
const jsonRequestCache = new Map();
async function getJson(url, timeout = 9000) {
  const cacheable = url.startsWith('/data/company?') || url.startsWith('/data/market') || url.startsWith('/data/indices') || url.startsWith('/data/global-markets') || url.startsWith('/data/watchlist?');
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
        return await response.json();
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
async function hydrateDashboard() { try { const quotes = await getJson('/data/market'); document.querySelectorAll('#market-cards .market-card').forEach((card, index) => { const quote = quotes[index]; if (!quote) return; card.querySelector('strong').textContent = quote.price ? `$${Number(quote.price).toFixed(2)}` : '—'; const rawChange = quote.changesPercentage; const hasChange = Number.isFinite(Number(rawChange)); const change = Number(rawChange || 0); card.classList.toggle('gain', hasChange && change >= 0); card.classList.toggle('loss', hasChange && change < 0); const note = card.querySelector('b'); note.textContent = hasChange ? `${percent(change)} today` : 'Latest quote available'; note.className = hasChange ? (change >= 0 ? 'positive' : 'down') : ''; }); } catch { document.querySelectorAll('#market-cards .market-card').forEach((card) => { card.classList.remove('gain', 'loss'); card.querySelector('strong').textContent = 'Unavailable'; card.querySelector('b').textContent = 'Live quote unavailable'; }); } }
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
    renderList($('#global-commodities'), Array.isArray(data?.commodities) ? data.commodities : [], 'Commodity quotes are temporarily unavailable.');
    renderList($('#global-crypto'), Array.isArray(data?.crypto) ? data.crypto : [], 'Crypto quotes are temporarily unavailable.');
    const regions = Array.isArray(data?.regions) ? data.regions.slice().sort((a, b) => Number(b.change ?? -Infinity) - Number(a.change ?? -Infinity)) : [];
    const regionHolder = $('#region-pulse');
    if (regionHolder) regionHolder.innerHTML = regions.length ? regions.map((item, index) => {
      const change = scanNumber(item.change);
      const breadth = Number.isFinite(Number(item.breadth)) && Number.isFinite(Number(item.total)) ? `${item.breadth}/${item.total} indexes higher` : 'Breadth unavailable';
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
  let universe = [];
  let results = [];
  const resultMeta = document.querySelector('.result-meta');
  if (resultMeta && !document.querySelector('#screen-freshness')) resultMeta.insertAdjacentHTML('beforeend', '<span id="screen-freshness">Waiting for live directory data</span>');
  const metricSymbols = new Set();
  let metricRequest = 0;
  const value = id => $(`#${id}`).value;
  const inCapBand = (cap, band) => band === 'all' || (band === 'mega' && cap >= 2e11) || (band === 'large' && cap >= 1e10 && cap < 2e11) || (band === 'mid' && cap >= 2e9 && cap < 1e10) || (band === 'small' && cap >= 3e8 && cap < 2e9) || (band === 'micro' && cap < 3e8);
  const inPriceBand = (price, band) => band === 'all' || (band === 'under10' && price < 10) || (band === '10to50' && price >= 10 && price < 50) || (band === '50to200' && price >= 50 && price <= 200) || (band === 'over200' && price > 200);
  const enrichVisible = async list => {
    const tickers = list.slice(0, 60).map(stock => stock.symbol || stock.ticker).filter(ticker => ticker && !metricSymbols.has(ticker));
    if (!tickers.length) return;
    tickers.forEach(ticker => metricSymbols.add(ticker));
    const request = ++metricRequest;
    try {
      const metricRows = await getJson(`/data/screener-metrics?symbols=${encodeURIComponent(tickers.join(','))}`, 45000);
      if (request !== metricRequest || !Array.isArray(metricRows)) return;
      const metricsBySymbol = new Map(metricRows.map(item => [String(item.symbol || '').toUpperCase(), item]));
      universe = universe.map(stock => ({ ...stock, ...(metricsBySymbol.get(String(stock.symbol || stock.ticker || '').toUpperCase()) || {}) }));
      draw(true);
    } catch {
      tickers.forEach(ticker => metricSymbols.delete(ticker));
    }
  };
  const draw = (skipEnrichment = false) => {
    const search = value('screen-search').trim().toUpperCase();
    const sector = value('screen-sector');
    const exchange = value('screen-exchange');
    const capBand = value('screen-cap');
    const priceBand = value('screen-price');
    const maxPe = Number(value('screen-pe'));
    const minRoe = Number(value('screen-roe'));
    const minEps = Number(value('screen-eps'));
    const minGrowth = Number(value('screen-growth'));
    const minVolume = Number(value('screen-volume'));
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
        (dividend === 'all' || paysDividend);
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
    $('#screen-count').textContent = `${results.length.toLocaleString()} matches · showing up to 60 detailed rows from ${universe.length.toLocaleString()} active US stocks`;
    $('#screen-table').innerHTML = results.slice(0, 60).map(screenerRow).join('') || '<tr><td colspan="8">No active US stocks match these filters. Try clearing one or two filters.</td></tr>';
    wireCommon();
    if (!skipEnrichment) enrichVisible(results);
  };
  const load = async force => {
    const freshness = $('#screen-freshness');
    if (freshness) freshness.textContent = force ? 'Refreshing live data…' : 'Loading live data…';
    $('#screen-count').textContent = force ? 'Refreshing the US stock directory…' : 'Loading active US stocks…';
    try {
      const data = await getJson(`/data/screener${force ? `?refresh=${Date.now()}` : ''}`, 25000);
      universe = Array.isArray(data) ? data : stocks;
      const symbols = [...universe].sort((a, b) => Number(b.marketCap || 0) - Number(a.marketCap || 0)).slice(0, 60).map(stock => stock.symbol || stock.ticker).filter(Boolean);
      symbols.forEach(ticker => metricSymbols.add(ticker));
      const metricRows = await getJson(`/data/screener-metrics?symbols=${encodeURIComponent(symbols.join(','))}`, 45000).catch(() => []);
      const metricsBySymbol = new Map(metricRows.map(item => [String(item.symbol || '').toUpperCase(), item]));
      universe = universe.map(stock => ({ ...stock, ...(metricsBySymbol.get(String(stock.symbol || stock.ticker || '').toUpperCase()) || {}) }));
      const ratioCount = universe.filter(stock => scanNumber(stock.pe, stock.peRatioTTM, stock.returnOnEquityTTM) !== null).length;
      $('#screen-data-note').textContent = `Funds and ETFs are excluded. TTM valuation or quality data is loaded for ${ratioCount.toLocaleString()} companies in this scan; open any company for its complete ratios.`;
      if (freshness) freshness.textContent = `Live directory updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
    } catch {
      universe = stocks;
      $('#screen-data-note').textContent = 'The live directory is temporarily unavailable. Showing a small local company list.';
      if (freshness) freshness.textContent = 'Live directory unavailable';
    }
    draw();
  };
  const presets = {
    mega: { cap:'mega', sort:'cap' },
    value: { cap:'large', pe:'20', sort:'pe' },
    quality: { cap:'large', roe:'20', sort:'roe' },
    liquid: { cap:'large', volume:'10000000', sort:'volume' },
    dividend: { dividend:'payer', sort:'cap' },
    reset: { sector:'all', exchange:'all', cap:'all', price:'all', pe:'999', roe:'0', eps:'-999999', growth:'-999999', volume:'0', dividend:'all', sort:'cap' }
  };
  document.querySelectorAll('[data-screen-preset]').forEach(button => button.onclick = () => {
    const preset = presets[button.dataset.screenPreset];
    Object.entries(presets.reset).forEach(([name, selected]) => { const input = $(`#screen-${name}`); if (input) input.value = selected; });
    Object.entries(preset).forEach(([name, selected]) => { const input = $(`#screen-${name}`); if (input) input.value = selected; });
    $('#screen-search').value = '';
    document.querySelectorAll('[data-screen-preset]').forEach(item => item.classList.toggle('selected', item === button && button.dataset.screenPreset !== 'reset'));
    draw();
  });
  ['screen-search', 'screen-sector', 'screen-exchange', 'screen-cap', 'screen-price', 'screen-pe', 'screen-roe', 'screen-eps', 'screen-growth', 'screen-volume', 'screen-dividend', 'screen-sort'].forEach(id => $(`#${id}`).oninput = draw);
  $('#screen-run').onclick = () => load(true);
  $('#export-screen').onclick = () => {
    const csv = ['Symbol,Company,Price,Market Cap,P/E,ROE,Volume,Sector', ...results.map(stock => {
      const fields = [stock.symbol || stock.ticker, stock.companyName || stock.name || '', stock.price || '', stock.marketCap || '', scanNumber(stock.pe, stock.peRatioTTM) ?? '', scanPercent(scanNumber(stock.returnOnEquityTTM, stock.roeTTM, stock.roe)) ?? '', stock.volume || '', stock.sector || ''];
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
function setupIndex() { const save = () => localStorage.setItem('dd-custom-index', JSON.stringify(basket)); $('#basket-add').onclick = () => { const input = $('#basket-ticker'); const ticker = input.value.trim().toUpperCase(); if (/^[A-Z.]{1,10}$/.test(ticker) && !basket.symbols.includes(ticker)) { basket.symbols.push(ticker); save(); render(); } }; $('#basket-rename').onclick = () => { const name = prompt('Name your index', basket.name); if (name && name.trim()) { basket.name = name.trim(); save(); render(); } }; document.querySelectorAll('[data-remove-basket]').forEach((button) => button.onclick = () => { basket.symbols = basket.symbols.filter((ticker) => ticker !== button.dataset.removeBasket); save(); render(); }); }
function drawResearchLists() { $('#alerts-list').innerHTML = alerts.map((alert, index) => `<div class="alert-item"><span><b>${alert.ticker}</b> · price ${alert.direction} $${alert.price}</span><button data-delete-alert="${index}">Remove</button></div>`).join('') || '<div class="empty-small">No alert ideas saved yet.</div>'; $('#notes-list').innerHTML = notes.slice().reverse().map((note, index) => `<article class="note-item"><div><b>${note.ticker}</b><small>${note.date}</small></div><p>${escapeHtml(note.text)}</p><button data-delete-note="${notes.length - 1 - index}">Delete</button></article>`).join('') || '<div class="empty-small">No research notes yet.</div>'; document.querySelectorAll('[data-delete-alert]').forEach((button) => button.onclick = () => { alerts.splice(Number(button.dataset.deleteAlert), 1); localStorage.setItem('dd-price-alerts', JSON.stringify(alerts)); drawResearchLists(); }); document.querySelectorAll('[data-delete-note]').forEach((button) => button.onclick = () => { notes.splice(Number(button.dataset.deleteNote), 1); localStorage.setItem('dd-research-notes', JSON.stringify(notes)); drawResearchLists(); }); }
function setupResearch() { const findFilings = async () => { const ticker = $('#filing-ticker').value.trim().toUpperCase(); if (!/^[A-Z.]{1,10}$/.test(ticker)) return; $('#filing-results').innerHTML = '<p class="sub">Loading official SEC filings…</p>'; try { const data = await getJson(`/data/filings?symbol=${ticker}`); $('#filing-results').innerHTML = `<div class="filing-company"><b>${escapeHtml(data.companyName)}</b><small>${data.symbol} · CIK ${data.cik}</small></div>` + (data.filings || []).map((filing) => `<a class="filing-row" href="${filing.url || '#'}" target="_blank" rel="noreferrer"><span class="filing-form">${escapeHtml(filing.form || 'Filing')}</span><span>${escapeHtml(filing.description || filing.reportDate || 'SEC filing')}<small>Filed ${escapeHtml(filing.filedAt || '—')}</small></span><b>Open ↗</b></a>`).join(''); } catch { $('#filing-results').innerHTML = '<p class="sub">Filings are temporarily unavailable. Try again shortly.</p>'; } }; $('#filing-find').onclick = findFilings; $('#alert-add').onclick = () => { const ticker = $('#alert-ticker').value.trim().toUpperCase(); const price = Number($('#alert-price').value); if (/^[A-Z.]{1,10}$/.test(ticker) && price > 0) { alerts.push({ ticker, price, direction: $('#alert-direction').value }); localStorage.setItem('dd-price-alerts', JSON.stringify(alerts)); drawResearchLists(); } }; $('#note-save').onclick = () => { const ticker = $('#note-ticker').value.trim().toUpperCase(); const text = $('#note-text').value.trim(); if (/^[A-Z.]{1,10}$/.test(ticker) && text) { notes.push({ ticker, text, date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) }); localStorage.setItem('dd-research-notes', JSON.stringify(notes)); $('#note-text').value = ''; drawResearchLists(); } }; drawResearchLists(); }
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
            return `<button type="button" data-compare-symbol="${escapeHtml(ticker)}" data-compare-name="${escapeHtml(name)}"><span><b>${escapeHtml(name)}</b><small>${escapeHtml(ticker)}</small></span><em>${escapeHtml(exchange)}</em></button>`;
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
      $('#comparison').innerHTML = `<div class="comparison-grid"><div></div>${data.map(d => `<div class="compare-company"><b>${escapeHtml(d.profile?.companyName || d.quote?.symbol)}</b><small>${escapeHtml(d.quote?.symbol || '')}</small></div>`).join('')}${fields.map(([name, fn]) => `<div class="compare-label">${name}</div>${data.map(d => `<div class="compare-value">${fn(d)}</div>`).join('')}`).join('')}</div>`;
    } catch { $('#comparison').innerHTML = '<p class="sub">Live comparison is unavailable. Please try again shortly.</p>'; }
  };
  wirePicker('compare-a', 'compare-a-results');
  wirePicker('compare-b', 'compare-b-results');
  $('#compare-run').onclick = run;
  run();
}
async function hydrateCompany(ticker) { try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const profile = data.profile || {}; const quote = data.quote || {}; const ratios = data.ratios || {}; $('#company-description').textContent = profile.description || 'Review the business, financial statements, valuation and balance-sheet strength together.'; $('#company-price').textContent = quote.price ? `$${Number(quote.price).toFixed(2)}` : 'Quote unavailable'; const change = Number(quote.changesPercentage || 0); $('#company-change').textContent = `${percent(change)} today`; $('#company-change').className = change >= 0 ? 'positive' : 'down'; $('#company-cap').textContent = money(profile.mktCap); $('#company-pe').textContent = ratios.peRatioTTM ? `${Number(ratios.peRatioTTM).toFixed(1)}x` : '—'; } catch { $('#company-description').textContent = 'Live data is temporarily unavailable. Reference research data is shown.'; } }
function drawCompanyChart(values) { if (!values.length) return '<p class="data-empty">Price history is unavailable.</p>'; const closes = values.map(item => Number(item.close)).filter(Number.isFinite); const min = Math.min(...closes); const max = Math.max(...closes); const scaleX = index => (index / Math.max(values.length - 1, 1)) * 760 + 20; const scaleY = value => 170 - ((value - min) / Math.max(max - min, 0.01)) * 145; const line = values.map((item, index) => `${index ? 'L' : 'M'} ${scaleX(index).toFixed(1)} ${scaleY(Number(item.close)).toFixed(1)}`).join(' '); return `<svg viewBox="0 0 800 190" role="img" aria-label="One year price chart"><path class="chart-grid" d="M20 25H780M20 75H780M20 125H780M20 170H780"/><path class="chart-line" d="${line}"/><text x="20" y="187">${escapeHtml(values[0].date)}</text><text x="680" y="187">${escapeHtml(values[values.length - 1].date)}</text><text x="735" y="25">${Number(max).toFixed(2)}</text><text x="735" y="170">${Number(min).toFixed(2)}</text></svg>`; }
function ratioCard(label, value) { return `<div><span>${label}</span><b>${value}</b></div>`; }
async function hydrateCompany(ticker) { try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const profile = data.profile || {}; const quote = data.quote || {}; const ratios = data.ratios || {}; const metrics = data.metrics || {}; const companyName = profile.companyName || ticker; $('#company-title').textContent = companyName; $('#company-subtitle').textContent = `${ticker} · ${profile.exchangeShortName || profile.exchange || 'US Equity'}`; $('#company-description').textContent = profile.description || 'Company profile is unavailable from the current provider.'; $('#company-price').textContent = quote.price ? `$${Number(quote.price).toFixed(2)}` : 'Quote unavailable'; const change = quote.changesPercentage; $('#company-change').textContent = Number.isFinite(Number(change)) ? `${percent(change)} today` : 'Latest available quote'; $('#company-change').className = Number(change) >= 0 ? 'positive' : 'down'; $('#company-cap').textContent = usd(profile.mktCap || quote.marketCap); $('#company-pe').textContent = ratios.peRatioTTM ? `${Number(ratios.peRatioTTM).toFixed(1)}x` : '—'; $('#company-range').textContent = quote.dayHigh && quote.dayLow ? `$${Number(quote.dayLow).toFixed(2)} / $${Number(quote.dayHigh).toFixed(2)}` : '—'; $('#company-volume').textContent = whole(quote.volume); $('#company-sector').textContent = profile.sector || '—'; $('#company-site').innerHTML = profile.website ? `<a href="${escapeHtml(profile.website)}" target="_blank" rel="noreferrer">Website ↗</a>` : '—'; $('#financials').innerHTML = financialTable('Income statement', data.income || [], [['Revenue','revenue'],['Gross profit','grossProfit'],['Operating income','operatingIncome'],['Net income','netIncome'],['EPS','eps']]) + financialTable('Balance sheet', data.balance || [], [['Cash & equivalents','cashAndCashEquivalents'],['Total assets','totalAssets'],['Total debt','totalDebt'],['Total liabilities','totalLiabilities'],['Total equity','totalStockholdersEquity']]) + financialTable('Cash flow', data.cashflow || [], [['Operating cash flow','operatingCashFlow'],['Capital expenditure','capitalExpenditure'],['Free cash flow','freeCashFlow'],['Net income','netIncome']]); $('#company-ratios').innerHTML = ratioCard('P/E', ratios.peRatioTTM ? `${Number(ratios.peRatioTTM).toFixed(1)}x` : '—') + ratioCard('Price to book', ratios.priceToBookRatioTTM ? `${Number(ratios.priceToBookRatioTTM).toFixed(1)}x` : '—') + ratioCard('Return on equity', ratios.returnOnEquityTTM ? `${(Number(ratios.returnOnEquityTTM) * 100).toFixed(1)}%` : '—') + ratioCard('Current ratio', ratios.currentRatioTTM ? Number(ratios.currentRatioTTM).toFixed(2) : '—') + ratioCard('Debt to equity', ratios.debtToEquityRatioTTM ? Number(ratios.debtToEquityRatioTTM).toFixed(2) : '—') + ratioCard('Dividend yield', ratios.dividendYieldTTM ? `${(Number(ratios.dividendYieldTTM) * 100).toFixed(2)}%` : '—'); const income = data.income || []; const latest = income[0] || {}; const prior = income[1] || {}; const points = []; if (latest.revenue && prior.revenue) points.push(`Revenue changed ${percent(((latest.revenue - prior.revenue) / Math.abs(prior.revenue)) * 100)} versus the previous reported year.`); if (latest.netIncome && latest.revenue) points.push(`Latest reported net margin: ${((latest.netIncome / latest.revenue) * 100).toFixed(1)}%.`); $('#company-points').innerHTML = points.length ? `<ul>${points.map(point => `<li>${point}</li>`).join('')}</ul>` : '<p class="data-empty">There is not enough reported financial data to calculate research points for this company.</p>'; getJson(`/data/chart?symbol=${encodeURIComponent(ticker)}`).then(chart => { $('#company-chart').innerHTML = drawCompanyChart(chart.values || []); }).catch(() => { $('#company-chart').innerHTML = '<p class="data-empty">Price history is temporarily unavailable.</p>'; }); } catch { $('#company-description').textContent = 'Live company data is temporarily unavailable. No fallback figures are shown.'; $('#company-chart').textContent = 'Price history is unavailable.'; } }
async function hydrateCompany(ticker) { try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const profile = data.profile || {}; const quote = data.quote || {}; const ratios = data.ratios || {}; const set = (id, value) => { const element = $(`#${id}`); if (element) element.textContent = value; }; set('company-title', profile.companyName || ticker); set('company-subtitle', `${ticker} · ${profile.exchangeShortName || profile.exchange || 'US Equity'}`); set('company-description', profile.description || 'Company profile is unavailable from the current provider.'); set('company-price', quote.price ? `$${Number(quote.price).toFixed(2)}` : 'Quote unavailable'); const change = quote.changesPercentage; const changeElement = $('#company-change'); if (changeElement) { changeElement.textContent = Number.isFinite(Number(change)) ? `${percent(change)} today` : 'Latest available quote'; changeElement.className = Number(change) >= 0 ? 'positive' : 'down'; } set('company-cap', usd(profile.mktCap || quote.marketCap)); set('company-pe', ratios.peRatioTTM ? `${Number(ratios.peRatioTTM).toFixed(1)}x` : '—'); set('company-range', quote.dayHigh && quote.dayLow ? `$${Number(quote.dayLow).toFixed(2)} / $${Number(quote.dayHigh).toFixed(2)}` : '—'); set('company-volume', whole(quote.volume)); set('company-sector', profile.sector || '—'); const site = $('#company-site'); if (site) site.innerHTML = profile.website ? `<a href="${escapeHtml(profile.website)}" target="_blank" rel="noreferrer">Website ↗</a>` : '—'; const financials = $('#financials'); if (financials) financials.innerHTML = financialTable('Income statement', data.income || [], [['Revenue','revenue'],['Gross profit','grossProfit'],['Operating income','operatingIncome'],['Net income','netIncome'],['EPS','eps']]) + financialTable('Balance sheet', data.balance || [], [['Cash & equivalents','cashAndCashEquivalents'],['Total assets','totalAssets'],['Total debt','totalDebt'],['Total liabilities','totalLiabilities'],['Total equity','totalStockholdersEquity']]) + financialTable('Cash flow', data.cashflow || [], [['Operating cash flow','operatingCashFlow'],['Capital expenditure','capitalExpenditure'],['Free cash flow','freeCashFlow'],['Net income','netIncome']]); const ratiosElement = $('#company-ratios'); if (ratiosElement) ratiosElement.innerHTML = ratioCard('P/E', ratios.peRatioTTM ? `${Number(ratios.peRatioTTM).toFixed(1)}x` : '—') + ratioCard('Price to book', ratios.priceToBookRatioTTM ? `${Number(ratios.priceToBookRatioTTM).toFixed(1)}x` : '—') + ratioCard('Return on equity', ratios.returnOnEquityTTM ? `${(Number(ratios.returnOnEquityTTM) * 100).toFixed(1)}%` : '—') + ratioCard('Current ratio', ratios.currentRatioTTM ? Number(ratios.currentRatioTTM).toFixed(2) : '—') + ratioCard('Debt to equity', ratios.debtToEquityRatioTTM ? Number(ratios.debtToEquityRatioTTM).toFixed(2) : '—') + ratioCard('Dividend yield', ratios.dividendYieldTTM ? `${(Number(ratios.dividendYieldTTM) * 100).toFixed(2)}%` : '—'); getJson(`/data/chart?symbol=${encodeURIComponent(ticker)}&points=${companyChartOptions.points}`).then(chart => { const holder = $('#company-chart'); if (holder) holder.innerHTML = drawCompanyChart(chart.values || []); }).catch(() => { const holder = $('#company-chart'); if (holder) holder.innerHTML = '<p class="data-empty">Price history is unavailable.</p>'; }); } catch { setTimeout(() => { const description = $('#company-description'); if (description) description.textContent = 'Live company data is temporarily unavailable. No fallback figures are shown.'; }, 0); } }
var companyChartOptions = { points:260, ma50:true, ma200:true, volume:true };
function movingAverage(values, window) { return values.map((item, index) => index < window - 1 ? null : values.slice(index - window + 1, index + 1).reduce((sum, value) => sum + value, 0) / window); }
function drawCompanyChart(values) { if (!values.length) return '<p class="data-empty">Price history is unavailable.</p>'; const closes = values.map(item => Number(item.close)); const ma50 = movingAverage(closes, 50); const ma200 = movingAverage(closes, 200); const max = Math.max(...closes); const min = Math.min(...closes); const scaleX = index => 28 + (index / Math.max(values.length - 1, 1)) * 744; const scaleY = value => 174 - ((value - min) / Math.max(max - min, 0.01)) * 135; const pathFor = series => series.map((value, index) => value == null ? '' : `${index && series[index - 1] != null ? 'L' : 'M'} ${scaleX(index).toFixed(1)} ${scaleY(value).toFixed(1)}`).join(' '); const maxVolume = Math.max(...values.map(item => Number(item.volume || 0)), 1); const bars = companyChartOptions.volume ? values.map((item, index) => `<rect x="${scaleX(index) - 1.2}" y="${(174 - (Number(item.volume || 0) / maxVolume) * 42).toFixed(1)}" width="2.4" height="${((Number(item.volume || 0) / maxVolume) * 42).toFixed(1)}"/>`).join('') : ''; setTimeout(() => document.querySelectorAll('[data-chart-points],[data-chart-toggle]').forEach(button => button.onclick = async () => { if (button.dataset.chartPoints) companyChartOptions.points = Number(button.dataset.chartPoints); if (button.dataset.chartToggle) companyChartOptions[button.dataset.chartToggle] = !companyChartOptions[button.dataset.chartToggle]; const holder = $('#company-chart'); holder.innerHTML = '<p class="data-empty">Loading chart…</p>'; try { const chart = await getJson(`/data/chart?symbol=${encodeURIComponent(page)}&points=${companyChartOptions.points}`); holder.innerHTML = drawCompanyChart(chart.values || []); } catch { holder.innerHTML = '<p class="data-empty">Price history is unavailable.</p>'; } }), 0); return `<div class="chart-controls"><div>${[[22,'1M'],[130,'6M'],[260,'1Y'],[780,'3Y'],[1300,'5Y'],[2600,'10Y']].map(([points,label]) => `<button class="${companyChartOptions.points === points ? 'selected' : ''}" data-chart-points="${points}">${label}</button>`).join('')}</div><div><button class="${companyChartOptions.ma50 ? 'selected' : ''}" data-chart-toggle="ma50">50 DMA</button><button class="${companyChartOptions.ma200 ? 'selected' : ''}" data-chart-toggle="ma200">200 DMA</button><button class="${companyChartOptions.volume ? 'selected' : ''}" data-chart-toggle="volume">Volume</button></div></div><svg viewBox="0 0 800 200" role="img" aria-label="Historical price and volume chart"><path class="chart-grid" d="M28 30H772M28 78H772M28 126H772M28 174H772"/><g class="chart-volume">${bars}</g><path class="chart-line" d="${pathFor(closes)}"/>${companyChartOptions.ma50 ? `<path class="chart-ma50" d="${pathFor(ma50)}"/>` : ''}${companyChartOptions.ma200 ? `<path class="chart-ma200" d="${pathFor(ma200)}"/>` : ''}<text x="28" y="193">${escapeHtml(values[0].date)}</text><text x="676" y="193">${escapeHtml(values[values.length - 1].date)}</text><text x="720" y="30">${max.toFixed(2)}</text><text x="720" y="174">${min.toFixed(2)}</text></svg><div class="chart-legend"><span class="legend-price">Price</span>${companyChartOptions.ma50 ? '<span class="legend-ma50">50 DMA</span>' : ''}${companyChartOptions.ma200 ? '<span class="legend-ma200">200 DMA</span>' : ''}${companyChartOptions.volume ? '<span class="legend-volume">Volume</span>' : ''}</div>`; }
async function hydrateCompanyExtras(ticker) { const documents = $('#company-documents'); const peers = $('#company-peers'); if (peers) { peers.textContent = 'Loading peer comparison…'; getJson(`/data/peers?symbol=${encodeURIComponent(ticker)}`).then(rows => { peers.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>Today</th></tr></thead><tbody>${rows.map(peerTableRow).join('')}</tbody></table></div>` : 'No comparable companies were returned for this stock.'; wireCommon(); }).catch(() => { peers.textContent = 'Peer comparison is unavailable for this company.'; }); } if (!documents) return; try { const data = await getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`); const filings = (data.filings || []).slice(0, 8); documents.innerHTML = filings.length ? `<div class="filings-inline">${filings.map((filing) => `<a href="${escapeHtml(filing.url || '#')}" target="_blank" rel="noreferrer"><b>${escapeHtml(filing.form || 'Filing')}</b><span>${escapeHtml(filing.description || filing.reportDate || 'SEC filing')}<small>Filed ${escapeHtml(filing.filedAt || '—')}</small></span><em>Open ↗</em></a>`).join('')}</div>` : 'No recent SEC filings are available for this company.'; } catch { documents.textContent = 'Recent SEC filings are unavailable for this company.'; } }
function setupSearch() { const input = $('#global-search'); const results = $('#global-results'); let timer; const openCompany = () => document.querySelectorAll('[data-find]').forEach((button) => { const target = button.dataset.find; button.setAttribute('title', 'Open with Ctrl/Cmd-click or middle-click in a new tab'); button.onclick = event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); openRouteInNewTab(target); return; } input.value = ''; results.hidden = true; navigateTo(target); }; button.onauxclick = event => { if (event.button === 1) { event.preventDefault(); openRouteInNewTab(target); } }; }); input.oninput = () => { clearTimeout(timer); const query = input.value.trim(); if (!query) { results.hidden = true; return; } timer = setTimeout(async () => { results.hidden = false; results.innerHTML = '<button disabled>Searching global exchanges…</button>'; try { const found = await getJson(`/data/search?q=${encodeURIComponent(query)}`); results.innerHTML = found.map((stock) => { const ticker = stock.symbol || stock.ticker; const name = stock.name || stock.companyName || ticker; const exchange = stock.exchangeShortName || stock.exchange || stock.sector || 'Global'; return `<button data-find="${escapeHtml(ticker)}"><span>${escapeHtml(name)} <small>${escapeHtml(ticker)}</small></span><small>${escapeHtml(exchange)}</small></button>`; }).join('') || '<button disabled>No matching company in the connected directories</button>'; } catch { const needle = query.toUpperCase(); const found = stocks.filter((stock) => stock.ticker.includes(needle) || stock.name.toUpperCase().includes(needle)); results.innerHTML = found.map((stock) => `<button data-find="${stock.ticker}"><span>${escapeHtml(stock.name)} <small>${stock.ticker}</small></span><small>${escapeHtml(stock.sector)}</small></button>`).join('') || '<button disabled>Global directory temporarily unavailable</button>'; } openCompany(); }, 220); }; }
// Expanded company workspace. Provider results remain optional so a missing
// premium endpoint never breaks charts, filings, or financial statements.
function companyView(ticker) { return `<div class="page company-page"><div class="company-top"><div><p class="crumb">US EQUITY RESEARCH</p><h1 class="page-title" id="company-title">${escapeHtml(ticker)}</h1><p class="sub" id="company-subtitle">${escapeHtml(ticker)} · Loading company research…</p></div><button class="solid-btn" data-watch="${ticker}">Follow</button></div><nav class="company-tabs"><a href="#overview">Overview</a><a href="#chart">Chart</a><a href="#financials">Financials</a><a href="#ratios">Ratios</a><a href="#peers">Peers</a><a href="#intelligence">Intelligence</a><a href="#updates">Updates</a><a href="#documents">Filings</a></nav><section id="overview" class="panel company-summary"><div class="summary-main"><div><b id="company-price">—</b><span id="company-change">Quote loading…</span></div><p id="company-description">Loading company profile and latest available quote…</p></div><div class="company-metrics"><div><span>Market cap</span><b id="company-cap">—</b></div><div><span>P/E ratio</span><b id="company-pe">—</b></div><div><span>Day high / low</span><b id="company-range">—</b></div><div><span>Volume</span><b id="company-volume">—</b></div><div><span>Sector</span><b id="company-sector">—</b></div><div><span>Website</span><b id="company-site">—</b></div></div></section><section id="chart" class="panel chart-panel"><div class="panel-head"><div><h2>Price & volume</h2><p>Historical market data · select the time range below</p></div></div><div id="company-chart" class="chart-area">Loading chart…</div></section><div id="financials" class="financial-stack"></div><section id="ratios" class="panel ratios-panel"><div class="panel-head"><div><h2>Key ratios</h2><p>Trailing twelve months where available</p></div></div><div id="company-ratios" class="ratio-grid"><span>Loading ratios…</span></div></section><section id="peers" class="panel documents-panel"><div class="panel-head"><div><h2>Peer comparison</h2><p>Companies in the same sector and industry</p></div></div><div id="company-peers" class="data-empty">Peer data is loading…</div></section><section id="intelligence" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>Analyst & financial strength</h2><p>Consensus, financial scores and owner earnings</p></div></div><div id="company-intel" class="data-empty">Loading analyst and financial-strength data…</div></div><div class="panel"><div class="panel-head"><div><h2>Company leadership</h2><p>Executives reported by the provider</p></div></div><div id="company-executives" class="data-empty">Loading executive data…</div></div></section><section id="updates" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>News & company events</h2><p>Latest available provider headlines, earnings and dividends</p></div></div><div id="company-updates" class="data-empty">Loading company updates…</div></div><div class="panel"><div class="panel-head"><div><h2>Insider activity</h2><p>Reported insider transactions</p></div></div><div id="company-insiders" class="data-empty">Loading insider activity…</div></div></section><section id="documents" class="panel documents-panel"><div class="panel-head"><div><h2>Recent SEC filings</h2><p>Official documents, direct from the SEC</p></div></div><div id="company-documents" class="data-empty">Loading recent filings…</div></section></div>`; }
function intelNumber(value, digits = 1) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits:digits }) : '—'; }
function intelDate(value) { return value ? String(value).slice(0, 10) : '—'; }
function peerTableRow(row) { const valid = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); const change = valid(row.change) ? Number(row.change) : null; return `<tr class="company-row" data-page="${escapeHtml(row.symbol || '')}"><td><span class="company">${escapeHtml(row.companyName || row.symbol || 'Company')}</span><span class="ticker">${escapeHtml(row.symbol || '')}</span><small>${escapeHtml(row.industry || row.sector || 'US Equity')}</small></td><td>${valid(row.price) ? `$${Number(row.price).toFixed(2)}` : '&mdash;'}</td><td>${valid(row.marketCap) ? usd(row.marketCap) : '&mdash;'}</td><td>${valid(row.pe) ? `${Number(row.pe).toFixed(1)}x` : '&mdash;'}</td><td class="${change === null ? '' : change >= 0 ? 'positive' : 'down'}">${change === null ? '&mdash;' : percent(change)}</td></tr>`; }
function hydrateCompanyExtras(ticker) { const documents = $('#company-documents'); const peers = $('#company-peers'); if (peers) { peers.textContent = 'Loading peer comparison…'; getJson(`/data/peers?symbol=${encodeURIComponent(ticker)}`).then(rows => { peers.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>P/E</th><th>Today</th></tr></thead><tbody>${rows.map(peerTableRow).join('')}</tbody></table></div>` : 'No comparable companies were returned for this stock.'; wireCommon(); }).catch(() => { peers.textContent = 'Peer comparison is unavailable for this company.'; }); }
  if (documents) getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`).then(data => { const filings = (data.filings || []).slice(0, 20); documents.innerHTML = filings.length ? `<div class="filings-inline">${filings.map((filing) => `<a href="${escapeHtml(filing.url || '#')}" target="_blank" rel="noreferrer"><b>${escapeHtml(filing.form || 'Filing')}</b><span><strong>${escapeHtml(filing.category || 'Company filing')}</strong> · ${escapeHtml(filing.description || filing.reportDate || 'Issuer filing')}<small>Filed ${escapeHtml(filing.filedAt || '—')}</small></span><em>Open ↗</em></a>`).join('')}</div><p class="filings-source-note">Issuer filings only · sourced from SEC EDGAR. Third-party ratings, analyst notes and conference-call summaries are excluded.</p>` : 'No issuer filings are available for this company.'; }).catch(() => { documents.textContent = 'Issuer filings are unavailable for this company.'; });
  getJson(`/data/company-intel?symbol=${encodeURIComponent(ticker)}`).then(intel => { const target = $('#company-intel'); const executives = $('#company-executives'); const updates = $('#company-updates'); const insiders = $('#company-insiders'); const score = intel.scores || {}; const priceTarget = intel.priceTarget || {}; const rating = intel.ratings || {}; const cards = [['Analyst target', priceTarget.consensusTargetPrice || priceTarget.targetConsensus, value => value ? `$${intelNumber(value, 2)}` : '—'], ['Financial score', score.altmanZScore || score.piotroskiScore, value => intelNumber(value, 2)], ['Rating', rating.rating || rating.ratingRecommendation, value => value || '—'], ['Owner earnings', intel.ownerEarnings?.[0]?.ownerEarnings, value => usd(value)]]; if (target) target.innerHTML = `<div class="intel-cards">${cards.map(([label,value,format]) => `<div><span>${label}</span><b>${format(value)}</b></div>`).join('')}</div>${intel.estimates?.length ? `<p class="intel-note">Latest annual revenue estimate: <b>${usd(intel.estimates[0].estimatedRevenueAvg || intel.estimates[0].revenueAvg)}</b> · estimated EPS: <b>${intelNumber(intel.estimates[0].estimatedEpsAvg || intel.estimates[0].epsAvg, 2)}</b></p>` : '<p class="intel-note">No analyst-estimate data was returned for this company.</p>'}`; if (executives) executives.innerHTML = intel.executives?.length ? `<div class="compact-list">${intel.executives.slice(0,6).map(person => `<div><b>${escapeHtml(person.name || person.title || 'Executive')}</b><span>${escapeHtml(person.title || person.position || 'Company executive')}</span></div>`).join('')}</div>` : 'Executive data is not available for this company.'; const events = [...(intel.earnings || []).slice(0,2).map(item => ({ type:'Earnings', title:`EPS estimate ${intelNumber(item.epsEstimated,2)} · reported ${intelNumber(item.eps,2)}`, date:item.date || item.fiscalDateEnding })), ...(intel.dividends || []).slice(0,2).map(item => ({ type:'Dividend', title:`${item.dividend ? `$${intelNumber(item.dividend, 2)} per share` : 'Dividend event'}`, date:item.paymentDate || item.recordDate || item.date }))]; const articles = (intel.news || []).slice(0,4); if (updates) updates.innerHTML = (articles.length || events.length) ? `<div class="compact-list">${articles.map(article => `<a href="${escapeHtml(article.url || '#')}" target="_blank" rel="noreferrer"><b>${escapeHtml(article.title || article.text || 'Company news')}</b><span>${escapeHtml(article.site || article.publisher || 'Market news')} · ${intelDate(article.publishedDate || article.date)}</span></a>`).join('')}${events.map(event => `<div><b>${event.type}</b><span>${event.title} · ${intelDate(event.date)}</span></div>`).join('')}</div>` : 'No news, earnings or dividend events were returned for this company.'; if (insiders) insiders.innerHTML = intel.insiders?.length ? `<div class="compact-list">${intel.insiders.slice(0,6).map(item => `<div><b>${escapeHtml(item.reportingName || item.name || 'Insider transaction')}</b><span>${escapeHtml(item.transactionType || item.transactionTypeName || 'Reported transaction')} · ${intelDate(item.transactionDate || item.filingDate)}</span></div>`).join('')}</div>` : 'No reported insider activity was returned for this company.'; }).catch(() => { ['company-intel','company-executives','company-updates','company-insiders'].forEach(id => { const element = $(`#${id}`); if (element) element.textContent = 'This dataset is not available for this company right now.'; }); }); }
function dashboardView() { return `<div class="page"><section class="panel" style="padding:30px;margin-bottom:18px;overflow:hidden;position:relative"><div style="position:absolute;width:300px;height:300px;right:-80px;top:-120px;background:radial-gradient(circle,#637cff55 0%,transparent 68%);pointer-events:none"></div><p class="crumb">DOLLARDISHA TERMINAL · US EQUITIES</p><div style="max-width:690px"><h1 class="page-title" style="font-size:42px;line-height:1.12;margin:6px 0 12px">Research US markets with <span style="color:#9eafff">clarity.</span></h1><p class="sub" style="font-size:14px;max-width:560px">Live prices, deep company financials, SEC filings and market intelligence — built for Indian investors studying US equities.</p><div style="display:flex;gap:9px;margin-top:20px;flex-wrap:wrap"><button class="solid-btn" data-page="screener">Explore US stocks</button><button class="link-button" data-page="markets" style="padding:9px 6px">View market pulse →</button></div></div><div style="display:grid;grid-template-columns:repeat(3,minmax(105px,1fr));gap:10px;max-width:500px;margin-top:26px"><div><b style="font-size:18px">US</b><small style="display:block;color:#94a1c0;margin-top:3px">Equity coverage</small></div><div><b style="font-size:18px">Live</b><small style="display:block;color:#94a1c0;margin-top:3px">Quotes & charts</small></div><div><b style="font-size:18px">SEC</b><small style="display:block;color:#94a1c0;margin-top:3px">Official filings</small></div></div></section><div class="section-header"><div><p class="crumb">MARKET PULSE</p><h2 style="margin:0;font:700 19px Inter">Major US stocks</h2></div><button class="link-button" data-page="markets">See full market →</button></div><section class="market-grid" id="market-cards">${['NVDA','MSFT','AAPL','GOOGL'].map(ticker => `<div class="market-card"><span>${ticker}</span><strong>Loading…</strong><b>Latest available quote</b></div>`).join('')}</section><section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>Research workflow</h2><p>Start with a question. Build your decision with evidence.</p></div></div><div class="workflow"><button data-page="screener"><b>1</b><span>Screen stocks<small>Filter the US equity universe</small></span></button><button data-page="markets"><b>2</b><span>Read market pulse<small>See leaders, laggards and indices</small></span></button><button data-page="research"><b>3</b><span>Study the filings<small>Open official SEC documents</small></span></button></div></div><div class="panel"><div class="panel-head"><div><h2>Your watchlist</h2><p>${watchlist.length ? `${watchlist.length} saved companies` : 'No companies saved yet'}</p></div><button class="link-button" data-page="watchlist">Open</button></div>${watchlist.slice(0,3).map(ticker => `<div class="idea"><div class="avatar">${ticker.slice(0,2)}</div><div><b>${ticker}</b><small>Saved research idea</small></div><button class="link-button" data-page="${ticker}">Research →</button></div>`).join('') || '<div class="watch-empty"><b>Your research list is waiting</b>Add companies from Market Scans or the Stock Screener.</div>'}</div></section></div>`; }
document.head.insertAdjacentHTML('beforeend', '<style>.intelligence-grid{margin-top:16px}.intel-cards{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid #dedede}.intel-cards>div{padding:13px 16px;border-right:1px solid #dedede;border-bottom:1px solid #dedede}.intel-cards span,.compact-list span{display:block;color:#888;font-size:10px}.intel-cards b{display:block;margin-top:5px;font-size:14px}.intel-note{margin:0;padding:13px 16px;color:#666;font-size:11px;line-height:1.6}.compact-list{padding:0 16px 12px}.compact-list>div,.compact-list>a{display:block;padding:11px 0;border-top:1px solid #eee;color:#333;text-decoration:none;font-size:11px;line-height:1.45}.compact-list>a:hover{color:#276d3d;background:#fafdf9}.compact-list b{display:block;font-size:11px}.compact-list span{margin-top:3px}@media(max-width:700px){.intel-cards{grid-template-columns:1fr}.intel-cards>div{border-right:0}}</style>');
function companyView(ticker) { return `<div class="page company-page"><div class="company-top"><div><p class="crumb">US EQUITY RESEARCH</p><h1 class="page-title" id="company-title">${escapeHtml(ticker)}</h1><p class="sub" id="company-subtitle">${escapeHtml(ticker)} · Loading company research…</p></div><button class="solid-btn" data-watch="${ticker}">Follow</button></div><nav class="company-tabs"><a href="#overview">Overview</a><a href="#chart">Chart</a><a href="#financials">Financials</a><a href="#ratios">Ratios</a><a href="#peers">Peers</a><a href="#intelligence">Intelligence</a><a href="#updates">Updates</a><a href="#documents">Filings</a></nav><section id="overview" class="panel company-summary company-research-card"><div class="summary-main ratio-board"><div class="ratio-cell"><span>Market cap</span><b id="company-cap">—</b></div><div class="ratio-cell price-cell"><span>Current price</span><b id="company-price">—</b><small id="company-change">Quote loading…</small></div><div class="ratio-cell"><span>Day high / low</span><b id="company-range">—</b></div><div class="ratio-cell emphasis"><span>Stock P/E</span><b id="company-pe">—</b></div><div class="ratio-cell emphasis"><span>Book value / share</span><b id="company-book">—</b></div><div class="ratio-cell emphasis"><span>Dividend yield</span><b id="company-dividend">—</b></div><div class="ratio-cell"><span>Return on equity</span><b id="company-roe">—</b></div><div class="ratio-cell"><span>Current ratio</span><b id="company-current">—</b></div><div class="ratio-cell"><span>Debt to equity</span><b id="company-debt">—</b></div><div class="ratio-cell emphasis"><span>Price to book</span><b id="company-pb">—</b></div><div class="ratio-cell"><span>Volume</span><b id="company-volume">—</b></div><div class="ratio-cell"><span>Sector</span><b id="company-sector">—</b></div></div><aside class="company-about"><p class="about-label">ABOUT</p><p id="company-description">Loading company profile and latest available quote…</p><div class="about-meta"><span>Website</span><b id="company-site">—</b></div><div id="company-keypoints" class="key-points"></div></aside></section><section id="chart" class="panel chart-panel"><div class="panel-head"><div><h2>Price & volume</h2><p>Historical market data · select the time range below</p></div></div><div id="company-chart" class="chart-area">Loading chart…</div></section><div id="financials" class="financial-stack"></div><section id="ratios" class="panel ratios-panel"><div class="panel-head"><div><h2>Key ratios</h2><p>Trailing twelve months where available</p></div></div><div id="company-ratios" class="ratio-grid"><span>Loading ratios…</span></div></section><section id="peers" class="panel documents-panel"><div class="panel-head"><div><h2>Peer comparison</h2><p>Companies in the same sector and industry</p></div></div><div id="company-peers" class="data-empty">Peer data is loading…</div></section><section id="intelligence" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>Analyst & financial strength</h2><p>Consensus, financial scores and owner earnings</p></div></div><div id="company-intel" class="data-empty">Loading analyst and financial-strength data…</div></div><div class="panel"><div class="panel-head"><div><h2>Company leadership</h2><p>Executives reported by the provider</p></div></div><div id="company-executives" class="data-empty">Loading executive data…</div></div></section><section id="updates" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>News & company events</h2><p>Latest available provider headlines, earnings and dividends</p></div></div><div id="company-updates" class="data-empty">Loading company updates…</div></div><div class="panel"><div class="panel-head"><div><h2>Insider activity</h2><p>Reported insider transactions</p></div></div><div id="company-insiders" class="data-empty">Loading insider activity…</div></div></section><section id="documents" class="panel documents-panel"><div class="panel-head"><div><h2>Recent SEC filings</h2><p>Official documents, direct from the SEC</p></div></div><div id="company-documents" class="data-empty">Loading recent filings…</div></section></div>`; }
async function hydrateCompany(ticker) { try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const profile = data.profile || {}; const quote = data.quote || {}; const ratios = data.ratios || {}; const metrics = data.metrics || {}; const set = (id, value) => { const element = $(`#${id}`); if (element) element.textContent = value; }; const valid = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); const ratio = (value, digits = 2) => valid(value) ? Number(value).toFixed(digits) : '—'; const pct = (value, digits = 1) => valid(value) ? `${(Number(value) * 100).toFixed(digits)}%` : '—'; set('company-title', profile.companyName || ticker); set('company-subtitle', `${ticker} · ${profile.exchangeShortName || profile.exchange || 'US Equity'}`); set('company-description', profile.description || 'Company profile is unavailable from the current provider.'); set('company-cap', usd(profile.mktCap || quote.marketCap)); set('company-price', quote.price ? `$${Number(quote.price).toFixed(2)}` : '—'); const change = quote.changesPercentage; const changeElement = $('#company-change'); if (changeElement) { changeElement.textContent = Number.isFinite(Number(change)) ? `${percent(change)} today` : 'Latest available quote'; changeElement.className = Number(change) >= 0 ? 'positive' : 'down'; } set('company-range', quote.dayHigh && quote.dayLow ? `$${Number(quote.dayLow).toFixed(2)} / $${Number(quote.dayHigh).toFixed(2)}` : '—'); set('company-pe', valid(ratios.peRatioTTM) ? `${ratio(ratios.peRatioTTM, 1)}x` : '—'); set('company-book', valid(metrics.bookValuePerShareTTM) ? `$${ratio(metrics.bookValuePerShareTTM, 2)}` : '—'); set('company-dividend', pct(ratios.dividendYieldTTM, 2)); set('company-roe', pct(ratios.returnOnEquityTTM)); set('company-current', ratio(ratios.currentRatioTTM)); set('company-debt', ratio(ratios.debtToEquityRatioTTM)); set('company-pb', valid(ratios.priceToBookRatioTTM) ? `${ratio(ratios.priceToBookRatioTTM, 1)}x` : '—'); set('company-volume', whole(quote.volume)); set('company-sector', profile.sector || '—'); const site = $('#company-site'); if (site) site.innerHTML = profile.website ? `<a href="${escapeHtml(profile.website)}" target="_blank" rel="noreferrer">Website ↗</a>` : '—'; const points = $('#company-keypoints'); const income = data.income || []; if (points) { const latest = income[0] || {}; const previous = income[1] || {}; const growth = latest.revenue && previous.revenue ? ((latest.revenue - previous.revenue) / Math.abs(previous.revenue)) * 100 : null; points.innerHTML = `<p class="about-label">KEY POINTS</p><ul>${Number.isFinite(growth) ? `<li>Revenue changed ${percent(growth)} in the latest reported year.</li>` : ''}${latest.netIncome && latest.revenue ? `<li>Latest reported net margin: ${((latest.netIncome / latest.revenue) * 100).toFixed(1)}%.</li>` : ''}</ul>`; } const financials = $('#financials'); if (financials) financials.innerHTML = financialTable('Income statement', data.income || [], [['Revenue','revenue'],['Gross profit','grossProfit'],['Operating income','operatingIncome'],['Net income','netIncome'],['EPS','eps']]) + financialTable('Balance sheet', data.balance || [], [['Cash & equivalents','cashAndCashEquivalents'],['Total assets','totalAssets'],['Total debt','totalDebt'],['Total liabilities','totalLiabilities'],['Total equity','totalStockholdersEquity']]) + financialTable('Cash flow', data.cashflow || [], [['Operating cash flow','operatingCashFlow'],['Capital expenditure','capitalExpenditure'],['Free cash flow','freeCashFlow'],['Net income','netIncome']]); const ratiosElement = $('#company-ratios'); if (ratiosElement) ratiosElement.innerHTML = ratioCard('P/E', valid(ratios.peRatioTTM) ? `${ratio(ratios.peRatioTTM, 1)}x` : '—') + ratioCard('Price to book', valid(ratios.priceToBookRatioTTM) ? `${ratio(ratios.priceToBookRatioTTM, 1)}x` : '—') + ratioCard('Return on equity', pct(ratios.returnOnEquityTTM)) + ratioCard('Current ratio', ratio(ratios.currentRatioTTM)) + ratioCard('Debt to equity', ratio(ratios.debtToEquityRatioTTM)) + ratioCard('Dividend yield', pct(ratios.dividendYieldTTM, 2)); getJson(`/data/chart?symbol=${encodeURIComponent(ticker)}&points=${companyChartOptions.points}`).then(chart => { const holder = $('#company-chart'); if (holder) holder.innerHTML = drawCompanyChart(chart.values || []); }).catch(() => { const holder = $('#company-chart'); if (holder) holder.innerHTML = '<p class="data-empty">Price history is temporarily unavailable.</p>'; }); } catch { const description = $('#company-description'); if (description) description.textContent = 'Live company data is temporarily unavailable.'; } }
document.head.insertAdjacentHTML('beforeend', '<style>.company-research-card{grid-template-columns:minmax(0,2.1fr) minmax(280px,1fr);overflow:hidden}.ratio-board{display:grid;grid-template-columns:repeat(3,1fr);padding:12px;border-right:1px solid #2c3657}.ratio-cell{padding:13px 12px;min-height:74px}.ratio-cell span{display:block;color:#95a5cd;font-size:10px}.ratio-cell b{display:block;margin-top:7px;color:#fff;font-size:14px}.ratio-cell small{display:block;margin-top:3px;font-size:10px}.ratio-cell.emphasis{background:#0d1426;border-radius:7px}.price-cell b{font-size:22px}.company-about{padding:20px 22px}.company-about>p:not(.about-label){margin:8px 0 18px;color:#bac5dc;font-size:11px;line-height:1.65;max-height:196px;overflow:auto}.about-label{margin:0;color:#9faeff;font-size:10px;font-weight:700;letter-spacing:.12em}.about-meta{padding:12px 0;border-top:1px solid #2c3657}.about-meta span,.about-meta b{display:block}.about-meta span{color:#94a3c4;font-size:10px}.about-meta b{margin-top:5px;font-size:11px}.about-meta a{color:#9eafff}.key-points{margin-top:18px}.key-points ul{margin:8px 0 0;padding-left:16px;color:#bac5dc;font-size:11px;line-height:1.55}@media(max-width:850px){.company-research-card{grid-template-columns:1fr}.ratio-board{border-right:0;border-bottom:1px solid #2c3657}}@media(max-width:550px){.ratio-board{grid-template-columns:repeat(2,1fr)}}</style>');
const originalHydrateCompanyExtras = hydrateCompanyExtras;
hydrateCompanyExtras = async function(ticker) { originalHydrateCompanyExtras(ticker); const holder = $('#company-ratios'); if (!holder) return; try { const data = await getJson(`/data/company?symbol=${encodeURIComponent(ticker)}`); const r = data.ratios || {}; const n = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; const x = (value, digits = 1) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '—'; const groups = [['Valuation', [['P/E', r.peRatioTTM ? `${n(r.peRatioTTM, 1)}x` : '—'], ['Price to book', r.priceToBookRatioTTM ? `${n(r.priceToBookRatioTTM, 1)}x` : '—'], ['Price to sales', r.priceToSalesRatioTTM ? `${n(r.priceToSalesRatioTTM, 1)}x` : '—'], ['Price to free cash flow', r.priceToFreeCashFlowsRatioTTM ? `${n(r.priceToFreeCashFlowsRatioTTM, 1)}x` : '—'], ['EV / EBITDA', r.enterpriseValueMultipleTTM ? `${n(r.enterpriseValueMultipleTTM, 1)}x` : '—'], ['Dividend yield', x(r.dividendYieldTTM, 2)]]], ['Profitability', [['Gross margin', x(r.grossProfitMarginTTM)], ['Operating margin', x(r.operatingProfitMarginTTM)], ['Net margin', x(r.netProfitMarginTTM)], ['Return on equity', x(r.returnOnEquityTTM)], ['Return on assets', x(r.returnOnAssetsTTM)], ['Return on capital employed', x(r.returnOnCapitalEmployedTTM)]]], ['Balance sheet', [['Current ratio', n(r.currentRatioTTM)], ['Quick ratio', n(r.quickRatioTTM)], ['Debt to equity', n(r.debtToEquityRatioTTM)], ['Debt ratio', n(r.debtRatioTTM)], ['Interest coverage', n(r.interestCoverageTTM)], ['Equity multiplier', n(r.companyEquityMultiplierTTM)]]], ['Cash flow & efficiency', [['Operating cash flow / sales', x(r.operatingCashFlowSalesRatioTTM)], ['Free cash flow / operating cash flow', x(r.freeCashFlowOperatingCashFlowRatioTTM)], ['Asset turnover', n(r.assetTurnoverTTM)], ['Inventory turnover', n(r.inventoryTurnoverTTM)], ['Receivables turnover', n(r.receivablesTurnoverTTM)], ['Payout ratio', x(r.payoutRatioTTM)]]]]; holder.innerHTML = `<div class="ratio-explorer-head"><div><b>Ratio explorer</b><span>Most recent trailing-twelve-month values</span></div></div><div class="ratio-explorer">${groups.map(([name, rows]) => `<section><h3>${name}</h3>${rows.map(([label,value]) => `<div><span>${label}</span><b>${value}</b></div>`).join('')}</section>`).join('')}</div>`; } catch { holder.innerHTML = '<p class="data-empty">Detailed ratios are temporarily unavailable for this company.</p>'; } };
document.head.insertAdjacentHTML('beforeend', '<style>.ratios-panel{overflow:hidden}.ratio-explorer-head{padding:2px 16px 14px}.ratio-explorer-head b,.ratio-explorer-head span{display:block}.ratio-explorer-head b{font-size:12px}.ratio-explorer-head span{margin-top:4px;color:#94a3c4;font-size:10px}.ratio-explorer{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:0 16px 16px}.ratio-explorer section{border:1px solid #2d395a;border-radius:9px;overflow:hidden;background:#10182b}.ratio-explorer h3{margin:0;padding:11px 12px;background:#17213b;color:#b7c5ff;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.ratio-explorer section>div{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-top:1px solid #273250;font-size:11px}.ratio-explorer span{color:#a6b2cb}.ratio-explorer b{color:#f0f4ff}@media(max-width:700px){.ratio-explorer{grid-template-columns:1fr}}</style>');
document.head.insertAdjacentHTML('beforeend', '<style>.ratio-cell{padding:11px 12px!important;min-height:64px!important}.ratio-cell span{font-size:9px!important}.ratio-cell b{margin-top:5px!important;font-size:12px!important;line-height:1.25!important;word-break:break-word}.ratio-cell.price-cell b{font-size:18px!important}.ratio-cell small{font-size:9px!important}.company-research-card{grid-template-columns:minmax(0,2.2fr) minmax(270px,.9fr)!important}.company-about{padding:18px 20px!important}</style>');
// Company overview: keep the headline facts and the complete ratio explorer
// together, with controls for finding and hiding individual metrics.
function companyView(ticker) {
  return `<div class="page company-page">
    <div class="company-top">
      <div><p class="crumb">US EQUITY RESEARCH</p><h1 class="page-title" id="company-title">${escapeHtml(ticker)}</h1><p class="sub" id="company-subtitle">${escapeHtml(ticker)} · Loading company research…</p></div>
      <button class="solid-btn ${watchlist.includes(ticker) ? 'saved' : ''}" data-watch="${ticker}">${watchlist.includes(ticker) ? 'Following' : 'Follow'}</button>
    </div>
    <nav class="company-tabs"><a href="#overview">Overview</a><a href="#chart">Chart</a><a href="#strengths">Pros &amp; cons</a><a href="#quarterly">Quarterly</a><a href="#ownership">Shareholding</a><a href="#financials">Financials</a><a href="#peers">Peers</a><a href="#intelligence">Intelligence</a><a href="#updates">Updates</a><a href="#documents">Filings</a></nav>
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
      <section class="panel ratios-panel overview-ratios">
        <div class="panel-head"><div><h2>Financial ratio explorer</h2><p>Filter the latest trailing-twelve-month valuation, quality and efficiency metrics</p></div></div>
        <div id="company-ratios"><p class="data-empty">Loading ratios…</p></div>
      </section>
    </div>
    <section id="chart" class="panel chart-panel"><div class="panel-head"><div><h2>Price & volume</h2><p>Historical market data · select the time range below</p></div></div><div id="company-chart" class="chart-area">Loading chart…</div></section>
    <section id="strengths" class="panel company-signals-panel" aria-labelledby="company-signals-title">
      <div class="panel-head"><div><h2 id="company-signals-title">Pros &amp; cons</h2><p>Automatically calculated from reported financial data</p></div><span class="signals-badge">Rules-based</span></div>
      <div id="company-signals" class="company-signals-loading">Analysing the latest reported figures...</div>
    </section>
    <section id="quarterly" class="panel financial-panel quarterly-panel"><div class="panel-head"><div><h2>Quarterly results</h2><p>USD millions except per-share data · latest reported quarters</p></div><span class="quarterly-source">Reported data</span></div><div id="company-quarterly"><p class="data-empty">Loading quarterly results…</p></div></section>
    <section id="ownership" class="panel ownership-panel"><div class="panel-head"><div><h2>Shareholding pattern</h2><p>Institutional ownership and insider activity by reported period</p></div><span class="quarterly-source">Quarterly &amp; yearly</span></div><div id="company-ownership"><p class="data-empty">Loading shareholding updatesâ€¦</p></div></section>
    <div id="financials" class="financial-stack"></div>
    <section id="peers" class="panel documents-panel"><div class="panel-head"><div><h2>Peer comparison</h2><p>Companies in the same sector and industry</p></div></div><div id="company-peers" class="data-empty">Peer data is loading…</div></section>
    <section id="intelligence" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>Analyst & financial strength</h2><p>Consensus, financial scores and owner earnings</p></div></div><div id="company-intel" class="data-empty">Loading analyst and financial-strength data…</div></div><div class="panel"><div class="panel-head"><div><h2>Company leadership</h2><p>Executives reported by the provider</p></div></div><div id="company-executives" class="data-empty">Loading executive data…</div></div></section>
    <section id="updates" class="research-grid intelligence-grid"><div class="panel"><div class="panel-head"><div><h2>News & company events</h2><p>Latest available provider headlines, earnings and dividends</p></div></div><div id="company-updates" class="data-empty">Loading company updates…</div></div><div class="panel"><div class="panel-head"><div><h2>Insider activity</h2><p>Reported insider transactions</p></div></div><div id="company-insiders" class="data-empty">Loading insider activity…</div></div></section>
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
    const query = holder.querySelector('#ratio-search')?.value.trim().toLowerCase() || '';
    const visibleGroups = groups.map(group => ({ ...group, rows:group.rows.filter(row => (!query || row.label.toLowerCase().includes(query)) && (!hideUnavailable || row.available)) })).filter(group => (activeGroup === 'all' || group.id === activeGroup) && group.rows.length);
    holder.innerHTML = `<div class="ratio-filter-bar"><div class="ratio-category-filter"><button class="${activeGroup === 'all' ? 'active' : ''}" data-ratio-group="all">All</button>${groups.map(group => `<button class="${activeGroup === group.id ? 'active' : ''}" data-ratio-group="${group.id}">${group.name}</button>`).join('')}</div><div class="ratio-filter-actions"><label class="ratio-search"><span>⌕</span><input id="ratio-search" value="${escapeHtml(query)}" placeholder="Find a ratio"></label><label class="ratio-hide"><input id="ratio-hide-unavailable" type="checkbox" ${hideUnavailable ? 'checked' : ''}> Hide unavailable</label></div></div><div class="ratio-explorer">${visibleGroups.map(group => `<section data-ratio-section="${group.id}"><h3>${group.name}</h3>${group.rows.map(row => `<div data-ratio-name="${escapeHtml(row.label.toLowerCase())}"><span>${row.label}</span><b>${formatValue(row)}</b></div>`).join('')}</section>`).join('') || '<p class="data-empty">No ratios match this filter.</p>'}</div>`;
    holder.querySelectorAll('[data-ratio-group]').forEach(button => button.onclick = () => { activeGroup = button.dataset.ratioGroup; draw(); });
    const search = holder.querySelector('#ratio-search');
    if (search) { search.oninput = draw; search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
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
  .ratio-search{display:flex;align-items:center;gap:6px;min-width:180px;border:1px solid #334163;border-radius:7px;background:#0d1527;padding:0 9px;color:#94a3c4}
  .ratio-search input{width:100%;border:0;outline:0;background:transparent;color:#f3f6ff;padding:8px 0;font:500 10px Inter}
  .ratio-hide{display:flex;align-items:center;gap:6px;color:#aebad3;font-size:10px;white-space:nowrap}
  .overview-ratios .ratio-explorer{grid-template-columns:repeat(4,minmax(0,1fr));padding-top:16px}
  @media(max-width:1100px){.overview-ratios .ratio-explorer{grid-template-columns:repeat(2,minmax(0,1fr))}.ratio-filter-bar{align-items:flex-start;flex-direction:column}.ratio-filter-actions{width:100%}.ratio-search{flex:1}}
  @media(max-width:650px){.overview-ratios .ratio-explorer{grid-template-columns:1fr}.ratio-filter-actions{align-items:flex-start;flex-direction:column}.ratio-search{box-sizing:border-box;width:100%}}
</style>`);

// Final live-data views. These override the early static prototypes above so
// every rendered summary uses the same server-normalised market data.
function dashboardView() {
  const saved = watchlist.slice(0, 3).map(ticker => `<div class="idea company-row" data-stock="${escapeHtml(ticker)}" data-dashboard-watch="${escapeHtml(ticker)}"><div class="avatar">${escapeHtml(ticker.slice(0, 2))}</div><div><b>${escapeHtml(ticker)}</b><small>Loading company and live price…</small></div><strong>Loading…</strong></div>`).join('');
  return `<div class="page"><section class="panel dashboard-hero"><p class="crumb">DOLLARDISHA TERMINAL · US EQUITIES</p><div><h1 class="page-title">Research US markets with <span>clarity.</span></h1><p class="sub">Live prices, deep company financials, SEC filings and market intelligence — built for Indian investors studying US equities.</p><div class="hero-actions"><button class="solid-btn" data-page="screener">Explore US stocks</button><button class="link-button" data-page="markets">View market pulse →</button></div></div><div class="hero-proof"><div><b>US</b><small>Equity coverage</small></div><div><b>Live</b><small>Quotes & charts</small></div><div><b>SEC</b><small>Official filings</small></div></div></section><div class="section-header"><div><p class="crumb">MARKET PULSE</p><h2>Major US stocks</h2></div><button class="link-button" data-page="markets">See full market →</button></div><section class="market-grid" id="market-cards">${['NVDA','MSFT','AAPL','GOOGL'].map(ticker => `<div class="market-card" data-market-ticker="${ticker}"><span>${ticker}</span><strong>Loading…</strong><b>Latest available quote</b></div>`).join('')}</section><section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>Research workflow</h2><p>Start with a question. Build your decision with evidence.</p></div></div><div class="workflow"><button data-page="screener"><b>1</b><span>Screen stocks<small>Filter the US equity universe</small></span></button><button data-page="markets"><b>2</b><span>Read market pulse<small>See leaders, laggards and indices</small></span></button><button data-page="research"><b>3</b><span>Study the filings<small>Open official SEC documents</small></span></button></div></div><div class="panel"><div class="panel-head"><div><h2>Your watchlist</h2><p>${watchlist.length ? `${watchlist.length} saved companies · live values` : 'No companies saved yet'}</p></div><button class="link-button" data-page="watchlist">Open</button></div>${saved || '<div class="watch-empty"><b>Your research list is waiting</b>Add companies from Market Scans or the Stock Screener.</div>'}</div></section></div>`;
}

// Fill the dashboard's open lower fold with three useful research entry
// points, while keeping all navigation on the existing single-page router.
const baseDashboardView = dashboardView;
dashboardView = function() {
  const html = baseDashboardView();
  const insights = '<section class="dashboard-insights"><article class="dashboard-insight"><span class="insight-icon">↗</span><div><p class="crumb">FIND MOMENTUM</p><h3>Market scans</h3><p>Spot today’s leaders, laggards and unusual volume across the US universe.</p><button class="link-button" data-page="markets">Open scans →</button></div></article><article class="dashboard-insight"><span class="insight-icon">⌕</span><div><p class="crumb">BUILD A VIEW</p><h3>Screen your way</h3><p>Combine valuation, growth and quality filters to create a focused shortlist.</p><button class="link-button" data-page="screener">Open screener →</button></div></article><article class="dashboard-insight"><span class="insight-icon">▦</span><div><p class="crumb">GO DEEPER</p><h3>Company research</h3><p>Review financials, ratios, filings and technicals on one company page.</p><button class="link-button" data-page="research">Research hub →</button></div></article></section>';
  return html.replace('<section class="dashboard-grid">', `${insights}<section class="dashboard-grid">`);
};

// Correctly replace the hero contents (rather than nesting a second copy of
// the hero) while preserving the original dashboard markup below it.
const dashboardViewBaseForLeaders = baseDashboardView;
dashboardView = function() {
  const html = dashboardViewBaseForLeaders();
  const panel = '<aside class="market-leaders-panel" id="market-leaders-panel"><div class="market-leaders-head"><div><p class="crumb">GLOBAL MARKET PULSE</p><h2>Best-performing markets</h2><small class="market-leaders-subtitle">Compare country benchmarks across every available region.</small></div><small id="market-leaders-updated">Updating...</small></div><div class="market-periods" role="tablist" aria-label="Market performance period"><button type="button" class="selected" data-market-period="day">Day</button><button type="button" data-market-period="week">1W</button><button type="button" data-market-period="month">1M</button><button type="button" data-market-period="ytd">YTD</button><button type="button" data-market-period="3m">3M</button><button type="button" data-market-period="6m">6M</button><button type="button" data-market-period="year">1Y</button><button type="button" data-market-period="3y">3Y</button><button type="button" data-market-period="5y">5Y</button><button type="button" data-market-period="10y">10Y</button></div><div class="market-leader-toolbar"><div class="market-leader-mode"><button type="button" class="selected" data-market-direction="leaders">Leaders</button><button type="button" data-market-direction="laggards">Laggards</button></div><div class="market-filter-group"><select id="market-region-filter" aria-label="Filter by region"><option value="all">All regions</option><option>US</option><option>Europe</option><option>Asia</option><option>India</option><option>Americas</option><option>Asia-Pacific</option><option>Africa</option></select><select id="market-move-filter" aria-label="Filter by minimum move"><option value="0">Any move</option><option value="1">Move 1%+</option><option value="3">Move 3%+</option><option value="5">Move 5%+</option><option value="10">Move 10%+</option></select></div></div><div class="market-leaders-content"><div id="market-leaders-list" class="market-leaders-list"><div class="market-leader-loading">Loading regional performance...</div></div><div id="market-benchmark-details" class="market-benchmark-details"><p class="crumb">SELECT A REGION</p><strong>Benchmark details</strong><small>Click a market to see the country, exchange and benchmark behind the ranking.</small></div></div><button class="link-button market-leaders-link" data-page="markets">View market pulse →</button></aside>';
  const match = html.match(/<section class="panel dashboard-hero">([\s\S]*?)<\/section><div class="section-header">/);
  if (!match) return html;
  const insights = '<section class="dashboard-insights"><article class="dashboard-insight"><span class="insight-icon">↗</span><div><p class="crumb">FIND MOMENTUM</p><h3>Market scans</h3><p>Spot today’s leaders, laggards and unusual volume across the US universe.</p><button class="link-button" data-page="markets">Open scans →</button></div></article><article class="dashboard-insight"><span class="insight-icon">⌕</span><div><p class="crumb">BUILD A VIEW</p><h3>Screen your way</h3><p>Combine valuation, growth and quality filters to create a focused shortlist.</p><button class="link-button" data-page="screener">Open screener →</button></div></article><article class="dashboard-insight"><span class="insight-icon">▦</span><div><p class="crumb">GO DEEPER</p><h3>Company research</h3><p>Review financials, ratios, filings and technicals on one company page.</p><button class="link-button" data-page="research">Research hub →</button></div></article></section>';
  const hero = `<section class="panel dashboard-hero"><div class="dashboard-hero-layout"><div class="dashboard-hero-copy">${match[1]}</div>${panel}</div></section><div class="section-header">`;
  return html.replace(match[0], hero).replace('<section class="dashboard-grid">', `${insights}<section class="dashboard-grid">`);
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
    const rows = (data.regions || []).filter(row => row && row.region && (regionFilter === 'all' || row.region === regionFilter)).sort((a, b) => {
      const left = Number(a.change); const right = Number(b.change);
      return marketLeadersDirection === 'leaders' ? (right || -Infinity) - (left || -Infinity) : (left || Infinity) - (right || Infinity);
    }).filter(row => {
      const change = Number(row.change);
      return !moveFilter || (Number.isFinite(change) && Math.abs(change) >= moveFilter);
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
      details.innerHTML = `<p class="crumb">${escapeHtml(row.region)} BENCHMARKS</p><strong>${escapeHtml(row.region)} market detail</strong><div class="market-benchmark-list">${(row.benchmarks || []).map(item => `<div><span><b>${escapeHtml(item.country || item.name)}</b><small>${escapeHtml(item.name)} · ${escapeHtml(item.exchange || 'Global')}</small></span><strong class="${Number(item.change) >= 0 ? 'positive' : 'down'}"><em>${Number.isFinite(Number(item.change)) ? percent(item.change) : 'Unavailable'}</em><small>CAGR ${Number.isFinite(Number(item.cagr)) ? percent(item.cagr) : '—'}</small></strong></div>`).join('') || '<small>No benchmark detail is available for this region yet.</small>'}</div>`;
    };
    document.querySelectorAll('[data-market-region-row]').forEach(rowButton => rowButton.addEventListener('click', () => showDetails(rowButton.dataset.marketRegionRow)));
    if (rows[0]) showDetails(rows[0].region);
    if (details) {
      const allBenchmarks = (data.regions || [])
        .filter(item => item && item.region && (regionFilter === 'all' || item.region === regionFilter))
        .flatMap(item => (item.benchmarks || []).map(benchmark => ({ ...benchmark, region: item.region })));
      const rising = marketLeadersDirection === 'leaders';
      const matching = allBenchmarks
        .filter(item => Number.isFinite(Number(item.change)) && (rising ? (moveFilter ? Number(item.change) >= moveFilter : Number(item.change) >= 0) : (moveFilter ? Number(item.change) <= -moveFilter : Number(item.change) < 0)))
        .sort((a, b) => rising ? Number(b.change) - Number(a.change) : Number(a.change) - Number(b.change))
        .slice(0, 8);
      details.innerHTML = `<p class="crumb">${rising ? 'RISING' : 'FALLING'} COUNTRIES</p><strong>${rising ? 'Country benchmarks rising' : 'Country benchmarks falling'}</strong><small>${rising ? 'Benchmarks with a positive return' : 'Benchmarks with a negative return'} for the selected period. Click a region to narrow the list.</small><div class="market-benchmark-list">${matching.map(item => `<div><span><b>${escapeHtml(item.country || item.name)}</b><small>${escapeHtml(item.name)} Â· ${escapeHtml(item.region || 'Global')} Â· ${escapeHtml(item.exchange || 'Global')}</small></span><strong class="${Number(item.change) >= 0 ? 'positive' : 'down'}"><em>${percent(item.change)}</em><small>CAGR ${Number.isFinite(Number(item.cagr)) ? percent(item.cagr) : 'â€”'}</small></strong></div>`).join('') || '<small>No country benchmark matches this filter yet.</small>'}</div>`;
    }
    const updated = document.querySelector('#market-leaders-updated');
    if (updated) updated.textContent = data.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : 'Latest snapshot';
  } catch {
    holder.innerHTML = '<div class="market-leader-loading">Market performance is temporarily unavailable.</div>';
  }
}
function setupMarketLeaders() {
  document.querySelectorAll('[data-market-period]').forEach(button => {
    button.addEventListener('click', () => hydrateMarketLeaders(button.dataset.marketPeriod));
  });
  document.querySelectorAll('[data-market-direction]').forEach(button => {
    button.addEventListener('click', () => {
      marketLeadersDirection = button.dataset.marketDirection;
      document.querySelectorAll('[data-market-direction]').forEach(item => item.classList.toggle('selected', item.dataset.marketDirection === marketLeadersDirection));
      hydrateMarketLeaders(document.querySelector('[data-market-period].selected')?.dataset.marketPeriod || 'day');
    });
  });
  document.querySelector('#market-region-filter')?.addEventListener('change', () => hydrateMarketLeaders(document.querySelector('[data-market-period].selected')?.dataset.marketPeriod || 'day'));
  document.querySelector('#market-move-filter')?.addEventListener('change', () => hydrateMarketLeaders(document.querySelector('[data-market-period].selected')?.dataset.marketPeriod || 'day'));
  hydrateMarketLeaders();
}

async function hydrateDashboard() {
  setupMarketLeaders();
  hydrateProviderStatus();
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
  await Promise.allSettled([quoteTask, watchTask]);
}

function indexView() {
  const equal = basket.symbols.length ? (100 / basket.symbols.length).toFixed(1) : '0.0';
  const legacyNames = legacyIndexNames;
  const visibleName = authSession?.user && legacyNames.has(String(basket.name || '').trim())
    ? accountDisplayName(authSession.user)
    : basket.name;
  const placeholders = basket.symbols.map(ticker => `<tr><td class="company">${escapeHtml(ticker)}<span class="ticker">Loading company…</span></td><td colspan="3">Loading live values…</td><td>${equal}%</td><td><button data-remove-basket="${escapeHtml(ticker)}">Remove</button></td></tr>`).join('');
  return `<div class="page">${pageHeader('BUILD YOUR OWN BENCHMARK', 'Custom Index', 'Create a personal US-stock basket and monitor every holding with live market data.')}<section class="index-hero"><div><span>YOUR INDEX</span><h2>${escapeHtml(visibleName)}</h2><p>${basket.symbols.length} companies · Equal weight <b>${equal}%</b> each</p></div><div class="index-actions"><input id="basket-ticker" maxlength="10" placeholder="Add ticker, e.g. TSLA"><button id="basket-add" class="solid-btn">Add company</button></div></section><section class="index-lab-grid"><div class="panel"><div class="panel-head"><div><h2>Index holdings</h2><p id="basket-status">${basket.symbols.length ? 'Loading live holding values…' : 'Add tickers you want to study together.'}</p></div><button id="basket-rename" class="link-button">Rename</button></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Live price</th><th>Market cap</th><th>Today</th><th>Weight</th><th></th></tr></thead><tbody id="basket-body">${placeholders || '<tr><td colspan="6">Add a ticker above to create your index.</td></tr>'}</tbody></table></div></div><aside class="panel"><div class="panel-head"><div><h2>How to use it</h2><p>A research tool, not a portfolio tracker</p></div></div><div class="callout"><b>Compare ideas consistently</b>Build a theme, watchlist or personal benchmark, then review its holdings against broad US indices.</div></aside></section></div>`;
}

function setupIndex() {
  const save = () => localStorage.setItem('dd-custom-index', JSON.stringify(basket));
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
    tickerInput.setAttribute('placeholder', 'Search ticker or company, e.g. TSLA');
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
        results.innerHTML = '<div class="basket-search-loading">Searching live directory…</div>';
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
            return `<button type="button" class="basket-search-item" data-basket-symbol="${escapeHtml(symbol)}"><b>${escapeHtml(symbol)}</b><span>${escapeHtml(name)} · ${escapeHtml(venue)} · <strong>${escapeHtml(quote)}</strong></span></button>`;
          }).join('') : '<div class="basket-search-loading">No matching listing found.</div>';
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
      return `<tr class="company-row" data-stock="${escapeHtml(ticker)}"><td class="company">${escapeHtml(item.companyName || ticker)}<span class="ticker">${escapeHtml(ticker)}</span></td><td>${scanNumber(item.price) !== null ? `$${Number(item.price).toFixed(2)}` : 'Quote unavailable'}</td><td>${scanNumber(item.marketCap) !== null ? money(item.marketCap) : 'Not reported'}</td><td class="${change === null ? '' : Number(change) >= 0 ? 'positive' : 'down'}">${change !== null ? percent(change) : 'Not reported'}</td><td>${equal}%</td><td><button data-remove-basket="${escapeHtml(ticker)}">Remove</button></td></tr>`;
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
  if (label) label.textContent = user ? firstName : 'Sign in';
  if (avatar) {
    if (user) {
      avatar.classList.remove('account-brand-mark');
      avatar.textContent = firstName.slice(0, 1).toUpperCase();
    } else {
      avatar.classList.add('account-brand-mark');
      avatar.innerHTML = '<img src="assets/dollardisha-app-icon.png" alt="">';
    }
  }
  button.title = user ? `Signed in as ${email || displayName}` : 'Log in or create a DollarDisha account';
  button.setAttribute('aria-label', user ? `Account: ${email || displayName}` : 'Log in or create a DollarDisha account');
  button.classList.toggle('signed-in', Boolean(user));
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
function epsGrowth(values) {
  const points = values.map(item => Number(item.eps)).filter(value => Number.isFinite(value));
  if (points.length < 2 || points[points.length - 2] <= 0) return null;
  return ((points[points.length - 1] - points[points.length - 2]) / Math.abs(points[points.length - 2])) * 100;
}
function drawMetricChart(values, mode) {
  const key = mode === 'pe' ? 'pe' : 'eps';
  const rows = chartMetricRows(values, key);
  if (!rows.length) return `<div class="chart-mode-header">${chartModeButtons(mode)}</div><p class="data-empty">${mode === 'pe' ? 'Historical P/E data is unavailable for this company.' : 'Reported EPS history is unavailable for this company.'}</p>`;
  const min = Math.min(...rows.map(item => item.metric));
  const max = Math.max(...rows.map(item => item.metric));
  const scaleX = index => 28 + (index / Math.max(values.length - 1, 1)) * 744;
  const scaleY = value => 174 - ((value - min) / Math.max(max - min, 0.01)) * 135;
  const path = rows.map((item, index) => `${index ? 'L' : 'M'} ${scaleX(item.index).toFixed(1)} ${scaleY(item.metric).toFixed(1)}`).join(' ');
  const bars = mode === 'eps' ? rows.map(item => `<rect class="metric-bars" x="${(scaleX(item.index) - 4).toFixed(1)}" y="${scaleY(item.metric).toFixed(1)}" width="8" height="${Math.max(1, 174 - scaleY(item.metric)).toFixed(1)}"/>`).join('') : '';
  const latest = rows[rows.length - 1];
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
    const show = target => { const item = values[Number(target.dataset.chartIndex)]; if (!item || !tooltip) return; const fmt = (v, suffix = '') => Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('en-US', { maximumFractionDigits:2 })}${suffix}` : 'Unavailable'; tooltip.innerHTML = `<b>${escapeHtml(item.date || 'Historical point')}</b><span>Price: <strong>${fmt(item.close, ' USD')}</strong></span><span>P/E: <strong>${fmt(item.pe, 'x')}</strong></span><span>EPS: <strong>${fmt(item.eps, ' USD')}</strong></span>`; tooltip.hidden = false; };
    holder.querySelectorAll('.chart-hover-target').forEach(target => { target.addEventListener('mouseenter', () => show(target)); target.addEventListener('focus', () => show(target)); target.addEventListener('mouseleave', () => { if (tooltip) tooltip.hidden = true; }); target.addEventListener('blur', () => { if (tooltip) tooltip.hidden = true; }); });
  }, 0);
  return `<div class="chart-mode-header"><div><b>${mode === 'pe' ? 'Valuation history' : 'EPS history'}</b><span>Reported values aligned to daily market dates</span></div>${chartModeButtons(mode)}</div><div class="chart-live-stats metric-stats"><div><span>${label}</span><b>${value}${mode === 'pe' ? 'x' : ' USD'}</b></div><div><span>EPS growth</span><b>${growthLabel}</b></div><div><span>Latest report</span><b>${escapeHtml(String(latest.date || '—'))}</b></div></div><div class="chart-controls"><div>${[[22,'1M'],[130,'6M'],[260,'1Y'],[780,'3Y'],[1300,'5Y'],[2600,'10Y']].map(([points,labelText]) => `<button class="${companyChartOptions.points === points ? 'selected' : ''}" data-chart-points="${points}">${labelText}</button>`).join('')}</div></div><svg class="metric-chart" viewBox="0 0 800 200" role="img" aria-label="Historical ${mode === 'pe' ? 'price to earnings ratio' : 'earnings per share'} chart"><path class="chart-grid" d="M28 30H772M28 78H772M28 126H772M28 174H772"/><g>${bars}</g><path class="chart-line metric-line" d="${path}"/><g class="chart-hover-points">${targets}</g><text x="28" y="193">${escapeHtml(String(values[0].date || ''))}</text><text x="676" y="193">${escapeHtml(String(values[values.length - 1].date || ''))}</text><text x="720" y="30">${max.toFixed(2)}</text><text x="720" y="174">${min.toFixed(2)}</text></svg><div class="chart-legend"><span class="legend-price">${mode === 'pe' ? 'P/E' : 'EPS'}</span><span>Hover for price, P/E and EPS</span></div><div class="chart-hover-tooltip" data-chart-tooltip hidden></div>`;
}
const metricAwareChart = drawCompanyChart;
drawCompanyChart = function(values) {
  if (companyChartMode === 'price') {
    const output = metricAwareChart(values);
    const markup = output.replace('<div class="chart-controls">', `${chartModeButtons('price')}<div class="chart-controls">`);
    setTimeout(() => document.querySelectorAll('#company-chart [data-chart-mode]').forEach(button => { button.onclick = () => { companyChartMode = button.dataset.chartMode; const holder = $('#company-chart'); if (holder) holder.innerHTML = drawCompanyChart(values); }; }), 0);
    return markup;
  }
  return drawMetricChart(values, companyChartMode);
};

// Issuer document workspace: keep the visual grouping close to the reference
// while limiting content to SEC/company-reported material.
const baseCompanyView = companyView;
companyView = function(ticker) {
  const html = baseCompanyView(ticker);
  const documents = `<section id="documents" class="panel documents-panel issuer-documents-panel"><div class="panel-head"><div><h2>Documents</h2><p>Company announcements, reports and reported earnings materials</p></div></div><div class="issuer-documents-grid"><article class="issuer-doc-card issuer-announcements"><h3>Announcements</h3><div class="issuer-doc-tabs"><span class="active">Recent</span><span>Important</span><span>Search</span><span>All</span></div><div id="doc-announcements" class="issuer-doc-list"><p class="data-empty">Loading issuer announcements…</p></div></article><article class="issuer-doc-card"><h3>Annual reports</h3><div id="doc-annual" class="issuer-doc-list"><p class="data-empty">Loading annual reports…</p></div></article><article class="issuer-doc-card"><h3>Credit ratings</h3><div id="doc-ratings" class="issuer-doc-list"><p class="data-empty">Loading ratings…</p></div></article><article class="issuer-doc-card issuer-concalls"><h3>Earnings &amp; calls</h3><div id="doc-concalls" class="issuer-doc-list"><p class="data-empty">Loading earnings materials…</p></div></article></div><p class="filings-source-note">Company/issuer documents are sourced from SEC EDGAR and provider-reported company data. Third-party research is excluded.</p></section>`;
  return html.replace(/<section id="documents"[\s\S]*?<\/section>\s*<\/div>\s*$/, `${documents}</div>`);
};

function renderCompanyDocuments(ticker) {
  const safe = value => escapeHtml(value || '—');
  const list = (rows, empty, render) => rows.length ? rows.map(render).join('') : `<p class="data-empty">${empty}</p>`;
  const filingLink = filing => `<a class="issuer-doc-item" href="${escapeHtml(filing.url || '#')}" target="_blank" rel="noreferrer"><b>${safe(filing.description || filing.form || 'Company filing')}</b><span>${safe(filing.filedAt || filing.reportDate)} · ${safe(filing.form)}</span></a>`;
  Promise.all([getJson(`/data/filings?symbol=${encodeURIComponent(ticker)}`), getJson(`/data/company-intel?symbol=${encodeURIComponent(ticker)}`)])
    .then(([filingData, intel]) => {
      const filings = filingData.filings || [];
      const announcements = filings.filter(item => /^(8-K|8-K\/A|6-K|6-K\/A)$/.test(String(item.form || '').toUpperCase())).slice(0, 8);
      const annual = filings.filter(item => /10-K|20-F|40-F|ARS/.test(String(item.form || '').toUpperCase())).slice(0, 6);
      const announcementHolder = $('#doc-announcements'); const annualHolder = $('#doc-annual'); const ratingHolder = $('#doc-ratings'); const callsHolder = $('#doc-concalls');
      if (announcementHolder) announcementHolder.innerHTML = list(announcements, 'No recent issuer announcements were returned.', filingLink);
      if (annualHolder) annualHolder.innerHTML = list(annual, 'No annual reports were returned.', filingLink);
      const rating = intel.ratings || {};
      if (ratingHolder) ratingHolder.innerHTML = rating.rating || rating.ratingRecommendation ? `<div class="issuer-rating-card"><b>${safe(rating.rating || rating.ratingRecommendation)}</b><span>${safe(rating.date || rating.ratingDate || 'Latest provider snapshot')}</span></div>` : '<p class="data-empty">No credit-rating update was returned for this company.</p>';
      const earnings = (intel.earnings || []).slice(0, 6);
      if (callsHolder) callsHolder.innerHTML = list(earnings, 'No earnings-call records were returned.', item => `<div class="issuer-call-row"><span>${safe(item.date || item.fiscalDateEnding || 'Reported')}</span><div><b>${safe(item.epsEstimated !== undefined ? `EPS estimate ${item.epsEstimated}` : 'Earnings update')}</b><small>${item.eps !== undefined ? `Reported EPS ${safe(item.eps)}` : 'Provider-reported earnings data'}</small></div><span class="issuer-doc-actions"><button type="button" disabled>Transcript</button><button type="button" disabled>Summary</button></span></div>`);
    })
    .catch(() => ['doc-announcements','doc-annual','doc-ratings','doc-concalls'].forEach(id => { const holder = $(`#${id}`); if (holder) holder.innerHTML = '<p class="data-empty">Document data is temporarily unavailable.</p>'; }));
}
const previousCompanyExtras = hydrateCompanyExtras;
hydrateCompanyExtras = function(ticker) { previousCompanyExtras(ticker); renderCompanyDocuments(ticker); };

// Keep SPA routes shareable and make them usable as real browser tabs. Section
// anchors on a company page (for example #chart) remain normal in-page links.
window.addEventListener('hashchange', () => {
  const next = routeFromHash();
  if (next && next !== page) { page = next; render(); window.scrollTo(0, 0); }
});
const initialRoute = routeFromHash();
if (initialRoute) page = initialRoute;

setupTheme();
setupSearch();
render();
setupAuth();
startLiveRefresh();
