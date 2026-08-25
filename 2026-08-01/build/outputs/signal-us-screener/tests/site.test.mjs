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
  assert.match(activeCompanyView, /href="#intelligence">Intelligence<\/a>/);
  assert.match(activeCompanyView, /href="#documents">Documents<\/a>/);
  assert.doesNotMatch(activeCompanyView, /href="#updates"/);
  assert.doesNotMatch(activeCompanyView, /id="updates"/);
  assert.match(source, /const routeSections = new Set\(\['overview', 'chart', 'strengths', 'quarterly', 'financials', 'peers', 'intelligence', 'documents'\]\)/);
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
