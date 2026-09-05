import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('daily country returns use percentages, preserve zero, and exclude missing quotes from breadth', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const finite = source.slice(source.indexOf('const finiteValue ='), source.indexOf('const safeDivide ='));
  const pulseCode = source.slice(source.indexOf('async function globalMarketPulse()'), source.indexOf('// Regional benchmark performance'));
  const performanceCode = source.slice(source.indexOf('const marketPerformanceCache ='), source.indexOf('// Keep the shared server snapshot warm'));
  const assets = [
    { symbol:'^N225', name:'Nikkei 225', region:'Asia', price:40000, change:806.46, changesPercentage:'2.06' },
    { symbol:'^HSI', name:'Hang Seng', region:'Asia', price:20000, change:437.58, changesPercentage:2.24 },
    { symbol:'MISSING', name:'Unavailable', region:'Asia', price:100, change:8, changesPercentage:null },
    { symbol:'FLAT', name:'Flat', region:'Asia', price:100, change:0, changesPercentage:0 },
    { symbol:'DOWN', name:'Down', region:'Asia', price:99, change:-1, changesPercentage:-1 }
  ];
  const run = new Function('assets', `${finite}
    const globalMarketCache = {};
    const globalMarketDefinitions = { indices:assets, commodities:[], crypto:[] };
    const globalAssetQuote = async asset => asset;
    ${pulseCode}
    ${performanceCode}
    return marketPerformance('day');`);
  const result = await run(assets);
  const region = result.regions[0];
  assert.deepEqual(region.benchmarks.map(item => item.change), [2.06, 2.24, null, 0, -1]);
  assert.ok(region.benchmarks.every(item => item.cagr === null));
  assert.equal(region.breadth, 3);
  assert.equal(region.total, 4);
  assert.ok(Math.abs(region.change - 0.825) < 1e-10);
});
