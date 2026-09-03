import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(resolve(root, file), 'utf8');

test('homepage exposes canonical, structured search and large social preview metadata', async () => {
  const html = await read('index.html');
  assert.match(html, /rel="canonical" href="https:\/\/dollardisha\.in\/"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /dollardisha-social-card\.png/);
  assert.match(html, /https:\/\/dollardisha\.in\/stocks\/\{search_term_string\}/);
});

test('server has a health check, security headers, rate limiting and stock-page metadata', async () => {
  const source = await read('server.mjs');
  assert.match(source, /url\.pathname === '\/healthz'/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /Strict-Transport-Security/);
  assert.match(source, /isRateLimited\(req, url\.pathname\)/);
  assert.match(source, /\/stocks\//);
  assert.match(source, /Stock Research, Financials & SEC Filings/);
});

test('client routes stock research to durable URLs and syncs signed-in research state', async () => {
  const source = await read('app.js');
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /const routeFromPath/);
  assert.match(source, /`\/stocks\/\$\{encodeURIComponent/);
  assert.match(source, /async function syncResearchState/);
  assert.match(source, /from\('research_state'\)/);
  assert.match(source, /queueResearchStateSync\(\)/);
});

test('sitemap contains indexable stock research pages', async () => {
  const sitemap = await read('sitemap.xml');
  assert.match(sitemap, /https:\/\/dollardisha\.in\/stocks\/AAPL/);
  assert.match(sitemap, /https:\/\/dollardisha\.in\/stocks\/NVDA/);
  assert.ok((sitemap.match(/<url>/g) || []).length >= 20);
});

test('Supabase schema protects one research workspace per authenticated user', async () => {
  const schema = await readFile(resolve(root, '../../../../supabase/schema.sql'), 'utf8');
  assert.match(schema, /create table if not exists public\.research_state/);
  assert.match(schema, /auth\.uid\(\) = owner_id/);
  assert.match(schema, /to authenticated/);
});

test('research toolkit provides valuation scenarios, earnings calendar and saved screens', async () => {
  const [html, source, styles, server] = await Promise.all([
    read('index.html'),
    read('app.js'),
    read('ui-refresh.css'),
    read('server.mjs')
  ]);
  assert.match(html, /data-page="toolkit">Toolkit/);
  assert.match(source, /function toolkitView\(\)/);
  assert.match(source, /function setupToolkit\(\)/);
  assert.match(source, /dd-saved-screens/);
  assert.match(source, /dd-valuation-cases/);
  assert.match(source, /EPS growth \/ year/);
  assert.match(server, /url\.pathname === '\/data\/calendar'/);
  assert.match(styles, /\.valuation-workspace/);
  assert.match(styles, /\.saved-screen-workspace/);
});

test('research toolkit search uses the live stock directory and quote feed', async () => {
  const [source, styles, server] = await Promise.all([read('app.js'), read('ui-refresh.css'), read('server.mjs')]);
  assert.match(source, /id="valuation-symbol-results"/);
  assert.match(source, /id="valuation-company-card"/);
  assert.match(source, /id="earnings-visible"/);
  assert.match(source, /setupValuationSearch/);
  assert.match(source, /data-valuation-symbol/);
  assert.match(source, /activeValuationSymbol/);
  assert.match(source, /`\/data\/search\?q=\$\{encodeURIComponent\(query\)\}`/);
  assert.match(source, /`\/data\/watchlist\?symbols=\$\{encodeURIComponent\(symbols\.join\(','\)\)\}`/);
  assert.match(server, /optional\('earnings-calendar', range\)/);
  assert.match(server, /toDate\.setUTCDate\(toDate\.getUTCDate\(\) \+ 120\)/);
  assert.match(styles, /\.toolkit-symbol-search/);
  assert.match(styles, /\.valuation-symbol-results/);
  assert.match(styles, /\.toolkit-company-card/);
  assert.match(styles, /\.calendar-empty/);
});

test('navigation exposes one route per product and company research has no duplicate tabs', async () => {
  const [html, source] = await Promise.all([read('index.html'), read('app.js')]);
  assert.equal((html.match(/data-page="toolkit"/g) || []).length, 1);

  const activeCompanyView = source
    .split('// Company overview: keep the headline facts and the complete ratio explorer')[1]
    .split('function renderFilteredRatioExplorer')[0];
  assert.ok(activeCompanyView, 'active company view should be present');
  assert.match(activeCompanyView, /href="#earnings">Earnings<\/a>/);
  assert.match(activeCompanyView, /href="#intelligence">Outlook<\/a>/);
  assert.match(activeCompanyView, /href="#events">Events<\/a>/);
  assert.match(activeCompanyView, /href="#documents">Documents<\/a>/);
  assert.match(activeCompanyView, /id="company-earnings-dashboard"/);
  assert.match(activeCompanyView, /id="company-event-timeline"/);
  assert.doesNotMatch(activeCompanyView, /href="#updates"/);
  assert.doesNotMatch(activeCompanyView, /id="updates"/);
  assert.doesNotMatch(activeCompanyView, /News & company events/);
  assert.match(source, /const routeSections = new Set\(\['overview', 'chart', 'earnings', 'strengths', 'quarterly', 'financials', 'peers', 'intelligence', 'events', 'documents'\]\)/);
  assert.match(source, /function renderEarningsDashboard\(holder, intel\)/);
  assert.match(source, /function renderCompanyEventTimeline\(holder, intel, filingData, ticker\)/);
  assert.match(source, /Not reported/);
});

test('app-level hash navigation wins over the current company path', async () => {
  const source = await read('app.js');
  assert.match(source, /const routeFromLocation = \(\) => routeFromHash\(\) \|\| routeFromPath\(\);/);
});

test('toolkit calendar anchors remain in-page navigation', async () => {
  const source = await read('app.js');
  assert.match(source, /const toolkitSections = new Set\(\['valuation-lab', 'india-return-tool', 'earnings-calendar', 'ipo-calendar', 'saved-cases'\]\)/);
  assert.match(source, /routeSections\.has\(decoded\) \|\| toolkitSections\.has\(decoded\)/);
});

test('durable stock URLs load client assets from the site root', async () => {
  const html = await read('index.html');
  assert.match(html, /href="\/styles\.css/);
  assert.match(html, /href="\/ui-refresh\.css/);
  assert.match(html, /src="\/app\.js/);
  assert.doesNotMatch(html, /(?:src|href)="assets\//);
});

test('live quotes and every stock search share the official Nasdaq fallback directory', async () => {
  const [client, server] = await Promise.all([read('app.js'), read('server.mjs')]);
  assert.match(server, /async function nasdaqDirectory\(\)/);
  assert.match(server, /exchange', 'nasdaq'/);
  assert.match(server, /async function nasdaqDirectoryQuote\(ticker\)/);
  assert.match(server, /async function nasdaqDirectorySearch\(query, limit = 8\)/);
  assert.match(server, /const matches = await nasdaqDirectorySearch\(query\)/);
  assert.match(server, /return await nasdaqDirectoryQuote\(ticker\)/);
  assert.ok((client.match(/`\/data\/search\?q=\$\{encodeURIComponent\(query\)\}`/g) || []).length >= 3);
});

test('homepage live quote cards retain their ticker bindings', async () => {
  const client = await read('app.js');
  assert.match(client, /data-market-ticker="\$\{ticker\}"/);
  assert.match(client, /byTicker\.get\(card\.dataset\.marketTicker\)/);
});

test('homepage keeps the interactive global market performance panel', async () => {
  const client = await read('app.js');
  assert.match(client, /const html = legacyDashboardView\(\)/);
  assert.match(client, /id="market-leaders-panel"/);
  assert.match(client, /Best-performing markets/);
  assert.match(client, /data-market-period="10y"/);
  assert.match(client, /id="market-region-filter"/);
  assert.match(client, /\/data\/market-performance\?period=/);
  assert.match(client, /function dashboardQuickAccess\(\)/);
  assert.match(client, /data-page="latest-results"/);
  assert.match(client, /data-section="ipo-calendar"/);
  assert.match(client, /id="dashboard-results-count"/);
  assert.match(client, /id="dashboard-ipo-count"/);
  assert.doesNotMatch(client, /<em[^>]*>9 new<\/em>/);
});

test('homepage calendar shortcuts open real earnings and IPO data views', async () => {
  const [client, server, styles] = await Promise.all([read('app.js'), read('server.mjs'), read('ui-refresh.css')]);
  assert.match(client, /function revealRouteSection\(sectionId\)/);
  assert.match(client, /id="earnings-calendar"/);
  assert.match(client, /id="ipo-calendar"/);
  assert.match(client, /const drawIpoCalendar = \(\) =>/);
  assert.match(client, /Array\.isArray\(data\.ipos\)/);
  assert.match(server, /optional\('ipos-calendar', range\)/);
  assert.match(styles, /\.dashboard-quick-access/);
});

test('latest results view exposes Screener-style reported-results workflow', async () => {
  const [client, server, styles] = await Promise.all([read('app.js'), read('server.mjs'), read('ui-refresh.css')]);
  assert.match(client, /function latestResultsView\(\)/);
  assert.match(client, /async function setupLatestResults\(\)/);
  assert.match(client, /id="latest-results-search"/);
  assert.match(client, /data-results-view="turnaround"/);
  assert.match(client, /id="latest-results-body"/);
  assert.match(client, /\/data\/results\/latest/);
  assert.match(server, /async function latestReportedResults\(\)/);
  assert.match(server, /fmp\('earnings-calendar'/);
  assert.match(server, /fmp\('income-statement'/);
  assert.match(server, /exchange:'NASDAQ'/);
  assert.match(server, /trailingEpsValues\.length === 4/);
  assert.match(styles, /\.latest-results-page/);
  assert.match(styles, /html\[data-theme="light"\].*latest-results/);
});

test('global market rankings never treat missing returns as zero', async () => {
  const client = await read('app.js');
  assert.match(client, /const change = scanNumber\(row\.change\);[\s\S]*?if \(change === null\) return false;/);
  assert.match(client, /const itemChange = scanNumber\(item\.change\)/);
  assert.doesNotMatch(client, /Number\.isFinite\(Number\(item\.change\)\)/);
});

test('market and screener views stay useful during partial provider coverage', async () => {
  const [client, server] = await Promise.all([read('app.js'), read('server.mjs')]);
  assert.match(client, /const liveAssets = rows =>/);
  assert.match(client, /item\.dataStatus !== 'unavailable'/);
  assert.match(client, /page !== 'screener' \|\| !\$\('#screen-table'\)/);
  assert.match(client, /Active US listings loaded\. Adding live valuation and quality ratios/);
  assert.match(client, /calendarPeriod = 'all'/);
  assert.match(server, /fmp:'BZUSD'/);
  assert.match(server, /name: asset\.name, symbol: asset\.symbol/);
  assert.match(server, /const liveRows = rows\.filter\(item => item\.dataStatus !== 'unavailable'\)/);
});

test('phone and tablet layouts contain every tool without widening the page', async () => {
  const [html, styles] = await Promise.all([read('index.html'), read('ui-refresh.css')]);
  assert.match(html, /ui-refresh\.css\?v=20260825-mobile-audit/);
  assert.match(styles, /Complete phone and tablet containment pass/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.toolkit-page[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.filter-layout[\s\S]*?\.index-lab-grid/);
  assert.match(styles, /\.table-wrap \{[\s\S]*?overflow-x: auto !important/);
  assert.match(styles, /\.auth-dialog \{[\s\S]*?max-height: calc\(100dvh/);
});

test('research workspace combines alerts, thesis tracking, filings and activity', async () => {
  const [client, styles] = await Promise.all([read('app.js'), read('ui-refresh.css')]);
  assert.match(client, /function researchView\(\)/);
  assert.match(client, /Research alerts/);
  assert.match(client, /Thesis tracker/);
  assert.match(client, /Watchlist filing activity/);
  assert.match(client, /Recent research activity/);
  assert.match(client, /function recordResearchActivity/);
  assert.match(client, /dd-research-activity/);
  assert.match(styles, /\.workspace-summary/);
  assert.match(styles, /\.thesis-card/);
  assert.match(styles, /\.activity-feed/);
});

test('portfolio dashboard tracks holdings, INR value, allocation and live returns', async () => {
  const [html, client, server, styles] = await Promise.all([
    read('index.html'),
    read('app.js'),
    read('server.mjs'),
    read('ui-refresh.css')
  ]);
  assert.match(html, /data-page="portfolio">Portfolio/);
  assert.match(client, /function portfolioView\(\)/);
  assert.match(client, /function setupPortfolio\(\)/);
  assert.match(client, /function hydratePortfolio\(\)/);
  assert.match(client, /portfolio-market-inr/);
  assert.match(client, /Allocation/);
  assert.match(client, /dd-portfolio/);
  assert.match(server, /url\.pathname === '\/data\/fx-rate'/);
  assert.match(styles, /\.portfolio-kpis/);
  assert.match(styles, /\.portfolio-allocation/);
});

test('comparison charts and toolkit INR returns use live provider data', async () => {
  const [client, server, styles] = await Promise.all([read('app.js'), read('server.mjs'), read('ui-refresh.css')]);
  assert.match(client, /function drawComparisonChart\(tickers\)/);
  assert.match(client, /Relative performance/);
  assert.match(client, /INDIAN INVESTOR TOOL/);
  assert.match(client, /id="india-fx-rate"/);
  assert.match(client, /Track result changes/);
  assert.match(client, /data-track-earnings/);
  assert.match(server, /combinedQuote\(\{ symbol:'USDINR'/);
  assert.match(styles, /\.comparison-chart/);
  assert.match(styles, /\.india-return-grid/);
});

test('status dashboard reports website, providers, database and refresh policy', async () => {
  const [html, client, server, styles] = await Promise.all([
    read('index.html'),
    read('app.js'),
    read('server.mjs'),
    read('ui-refresh.css')
  ]);
  assert.match(html, /data-page="status"/);
  assert.match(client, /function statusView\(\)/);
  assert.match(client, /function setupSystemStatus\(\)/);
  assert.match(client, /AUTOMATIC UPDATE/);
  assert.match(client, /markDataFreshness/);
  assert.match(server, /url\.pathname === '\/data\/system-status'/);
  assert.match(styles, /\.status-grid/);
  assert.match(styles, /\.data-freshness/);
});

test('all tools hub exposes Screener-style research workflows and working calculators', async () => {
  const [html, client, styles] = await Promise.all([read('index.html'), read('app.js'), read('styles.css')]);
  assert.match(html, /data-page="tools">All tools/);
  assert.match(client, /function toolsView\(\)/);
  assert.match(client, /US stock screener/);
  assert.match(client, /Global market pulse/);
  assert.match(client, /Official filings/);
  assert.match(client, /Position sizing/);
  assert.match(client, /function setupTools\(\)/);
  assert.match(styles, /\.tool-library-grid/);
  assert.match(styles, /\.mini-calculator/);
});

test('stock screener supports an additional formula-style rule', async () => {
  const [client, styles] = await Promise.all([read('app.js'), read('ui-refresh.css')]);
  assert.match(client, /Advanced filter/);
  assert.match(client, /screen-formula-metric/);
  assert.match(client, /formulaPass/);
  assert.match(client, /screen-formula-clear/);
  assert.match(styles, /\.advanced-screen-builder/);
});

test('ratio gallery separates live US metrics from history still being synced', async () => {
  const [client, styles] = await Promise.all([read('app.js'), read('ui-refresh.css')]);
  for (const category of [/['"]most-used['"]\s*:/, /annual\s*:/, /quarterly\s*:/, /balance\s*:/, /['"]cash-flow['"]\s*:/, /ratios\s*:/, /price\s*:/]) {
    assert.match(client, category);
  }
  assert.match(client, /renderColumn\('Recent'/);
  assert.match(client, /renderColumn\('Preceding'/);
  assert.match(client, /renderColumn\('Historical'/);
  assert.match(client, /ratio-gallery-pending/);
  assert.match(styles, /\.ratio-gallery-pending/);
});

test('price-screen metrics are calculated from provider price history', async () => {
  const [client, server] = await Promise.all([read('app.js'), read('server.mjs')]);
  assert.match(client, /screener-price-metrics/);
  assert.match(client, /50-day moving average/);
  assert.match(client, /Return over 3 months/);
  assert.match(server, /function priceMetricsFromHistory/);
  assert.match(server, /screener-price-metrics/);
  assert.match(server, /rsi14/);
  assert.match(server, /macdSignal/);
});

test('financial-history screen metrics use reported annual and quarterly statements', async () => {
  const [client, server] = await Promise.all([read('app.js'), read('server.mjs')]);
  assert.match(client, /screener-financial-metrics/);
  assert.match(client, /financialHistoryLoaded/);
  assert.match(server, /function screenerFinancialValues/);
  assert.match(server, /annualCagr/);
  assert.match(server, /financialsLoaded/);
});

test('custom-query editor offers keyboard-accessible metric and operator suggestions', async () => {
  const [client, styles] = await Promise.all([read('app.js'), read('ui-refresh.css')]);
  assert.match(client, /screen-query-suggestions/);
  assert.match(client, /querySuggestionCatalog/);
  assert.match(client, /applyQuerySuggestion/);
  assert.match(client, /ArrowDown/);
  assert.match(client, /aria-expanded/);
  assert.match(styles, /\.screen-query-suggestions/);
  assert.match(styles, /\.screen-query-suggestion/);
});
