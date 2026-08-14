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
