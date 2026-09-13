import test from 'node:test';
import assert from 'node:assert/strict';
import { numeric, validDate, cleanHistory, sectorSnapshot, stockMomentum, rankSectorStocks, monthlySeries, parseFredCsv, peadAnalysis, mergeTrackerRecords, safeLink, toCsv } from '../deep-dive-core.js';
import { createDeepDiveService, completeThrough, cacheLoader, pooled, filingEvidence } from '../deep-dive-data.mjs';
const days = (n=270, price=i=>100+i) => Array.from({length:n},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),close:price(i),volume:100}));
const approximately = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('missing, blank, boolean and non-finite numbers are not zero',()=>{
  for(const value of [null,undefined,'',' ',true,false,'NaN',Infinity,'.'])assert.equal(numeric(value),null);
  assert.equal(numeric(0),0); assert.equal(numeric('-0.2'),-.2);
});
test('invalid dates, future prices and zero/null closes are excluded',()=>{
  assert.equal(validDate('2026-02-30'),false);
  assert.deepEqual(cleanHistory([{date:'2026-01-01',close:null},{date:'2026-01-02',close:0},{date:'2026-01-03',close:5},{date:'2026-01-04',close:6}],'2026-01-03').map(r=>r.close),[5]);
});
test('sectors always include all 11 categories but report actual coverage',()=>{
  const s=sectorSnapshot({SPY:days(),XLK:days(270,i=>200+i)});
  assert.equal(s.rows.length,11);assert.equal(s.covered,1);
  const x=s.rows.find(r=>r.symbol==='XLK');
  approximately(x.returns.month,(469/448-1)*100);
  approximately(x.relative.month,(469/448-369/348)*100);
  assert.equal(s.rows.find(r=>r.symbol==='XLF').returns.day,null);
});
test('sector returns align to SPY dates rather than a shorter sector array',()=>{
  const spy=days(),sector=days();sector.splice(-22,1);
  const s=sectorSnapshot({SPY:spy,XLK:sector});
  assert.equal(s.rows[0].returns.month,null);
  assert.notEqual(s.rows[0].returns.week,null);
});
test('stale sector close is not silently compared with a newer benchmark',()=>{
  const s=sectorSnapshot({SPY:days(),XLK:days(269)});
  assert.equal(s.rows[0].returns.day,null);assert.equal(s.rows[0].above50,null);
});
test('stock momentum ranks medium-term leaders and preserves missing horizons',()=>{
  const leader=stockMomentum({symbol:'AAA'},days(270,i=>100+i));
  const laggard=stockMomentum({symbol:'BBB'},days(270,i=>400-i));
  const ranked=rankSectorStocks([{symbol:'BBB',history:days(270,i=>400-i)},{symbol:'AAA',history:days(270,i=>100+i)}]);
  assert.equal(ranked[0].symbol,'AAA'); assert.equal(leader.label,'Strong momentum'); assert.equal(laggard.label,'Weak momentum');
  assert.equal(stockMomentum({symbol:'SHORT'},days(40)).returns.year,null);
});
test('flat prices do not count as above moving average; stale VIX is missing',()=>{
  const s=sectorSnapshot({SPY:days(),XLK:days(270,()=>100),VIX:days(269,()=>20)});
  assert.equal(s.mood.above50,0);assert.equal(s.mood.vix,null);assert.equal(s.rows[0].returns.day,0);
});
test('US market mood exposes an equal-weight component score without inventing missing inputs',()=>{
  const histories={SPY:days(),VIX:days(270,()=>20)};
  for(const sector of ['XLK','XLF','XLV','XLY','XLP','XLE','XLI','XLB','XLU','XLRE','XLC']) histories[sector]=days(270,i=>100+i);
  const s=sectorSnapshot(histories);
  assert.equal(s.mood.components.length,5);
  assert.equal(s.mood.componentsCovered,5);
  assert.ok(Number.isFinite(s.mood.score));
  assert.match(s.mood.zone,/^(Greed|Extreme greed)$/);
  assert.match(s.mood.methodology,/Equal-weight descriptive US mood composite/);
});
test('year return needs 252 prior benchmark sessions',()=>{
  assert.equal(sectorSnapshot({SPY:days(252),XLK:days(252)}).rows[0].returns.year,null);
  assert.notEqual(sectorSnapshot({SPY:days(253),XLK:days(253)}).rows[0].returns.year,null);
});
test('no benchmark means no invented sector coverage or mood',()=>{
  const s=sectorSnapshot({XLK:days()});assert.equal(s.covered,0);assert.equal(s.asOf,null);assert.equal(s.mood.spy,null);
});
test('monthly growth uses exact calendar months, not row offsets',()=>{
  const result=monthlySeries([{date:'2025-01-01',value:100},{date:'2025-12-01',value:150},{date:'2026-01-01',value:200},{date:'2026-03-01',value:220}]);
  approximately(result[2].yoy,100);approximately(result[2].mom,100/3);
  assert.equal(result[3].mom,null);assert.equal(result[3].yoy,null);
});
test('FRED parser preserves missing observations and rejects HTML/wrong series',()=>{
  assert.deepEqual(parseFredCsv('observation_date,TOTALSA\n2026-01-01,.\n2026-02-01,17','TOTALSA'),[{date:'2026-01-01',value:null},{date:'2026-02-01',value:17}]);
  assert.throws(()=>parseFredCsv('<html>Error</html>','TOTALSA'));
  assert.throws(()=>parseFredCsv('DATE,OTHER\n2026-01-01,10','TOTALSA'));
});
test('PEAD respects before-open, after-close and unknown release timing',()=>{
  const prices=days(80),date=prices[30].date;
  assert.equal(peadAnalysis({date,session:'bmo'},prices,prices).reactionDate,prices[30].date);
  assert.equal(peadAnalysis({date,session:'amc'},prices,prices).reactionDate,prices[31].date);
  assert.equal(peadAnalysis({date,session:'unknown'},prices,prices).reactionDate,prices[31].date);
});
test('PEAD drift excludes reaction return and compares identical horizons',()=>{
  const spy=days(80,()=>100),stock=days(80,i=>i<31?100:i===31?120:132);
  const result=peadAnalysis({date:stock[30].date,session:'amc',actual:1.1,estimate:1},stock,spy);
  approximately(result.reactionReturn,20);approximately(result.horizons[1].return,10);approximately(result.surprise,10);
  approximately(result.horizons[5].excess,10);assert.equal(result.volumeRatio,1);
});
test('PEAD does not fabricate unelapsed, prehistory or future windows',()=>{
  const prices=days(40);
  assert.equal(peadAnalysis({date:prices[30].date},prices,prices).horizons[20].return,null);
  for(const date of ['2024-12-01','2027-01-01']) {
    const r=peadAnalysis({date},prices,prices);assert.equal(r.reactionDate,null);assert.equal(r.horizons[1].return,null);assert.equal(r.horizons[1].date,null);
  }
});
test('negative EPS estimates use absolute denominator; near-zero suppressed',()=>{
  const rows=days(80),base={date:rows[30].date};
  approximately(peadAnalysis({...base,actual:-.5,estimate:-1},rows,rows).surprise,50);
  for(const estimate of [null,0,.005])assert.equal(peadAnalysis({...base,actual:1,estimate},rows,rows).surprise,null);
});
test('missing reaction volume is not zero or normal volume',()=>{
  const rows=days(80);rows[31].volume=null;
  assert.equal(peadAnalysis({date:rows[30].date},rows,days(80)).volumeRatio,null);
});
test('US daily bars exclude the open session and observe daylight saving',()=>{
  assert.equal(completeThrough(new Date('2026-09-11T19:59:00Z')),'2026-09-10');
  assert.equal(completeThrough(new Date('2026-09-11T20:15:00Z')),'2026-09-11');
  assert.equal(completeThrough(new Date('2026-01-09T20:15:00Z')),'2026-01-08');
  assert.equal(completeThrough(new Date('2026-01-09T21:15:00Z')),'2026-01-09');
});
test('cache coalesces, expires and retries rejected requests',async()=>{
  let now=0,count=0;const load=cacheLoader(()=>now);const work=async()=>++count;
  assert.deepEqual(await Promise.all([load('a',10,work),load('a',10,work)]),[1,1]);
  now=11;assert.equal(await load('a',10,work),2);
  await assert.rejects(load('b',10,()=>Promise.reject(new Error('offline'))));
  assert.equal(await load('b',10,work),3);
});
test('pool bounds simultaneous upstream calls and preserves partial results',async()=>{
  let current=0,max=0;
  const rows=await pooled([1,2,3,4],2,async n=>{current++;max=Math.max(max,current);await new Promise(r=>setTimeout(r,1));current--;if(n===3)throw Error('offline');return n*2;});
  assert.ok(max<=2);assert.deepEqual(rows,[2,4,null,8]);
});
test('filing evidence strips scripts and decodes numeric entities',()=>{
  assert.equal(filingEvidence('<script>spin-off</script><p>No disclosure</p>','demergers'),null);
  assert.match(filingEvidence('<p>The proposed spin&#8209;off remains conditional.</p>','demergers').excerpt,/spin-off/);
  assert.equal(filingEvidence('<p>Revenue is up</p>','orders'),null);
  assert.ok(filingEvidence('<p>Remaining performance obligations increased.</p>','orders'));
});
test('tracker merge keeps newest edit and deletion tombstone',()=>{
  const old={id:'a',updatedAt:'2026-01-01',title:'old'},fresh={id:'a',updatedAt:'2026-02-01',title:'new'},deleted={...fresh,deleted:true};
  assert.deepEqual(mergeTrackerRecords([old,fresh],[deleted]),[deleted]);
  assert.deepEqual(mergeTrackerRecords([deleted],[old]),[deleted]);
});
test('links reject script schemes and CSV neutralizes formulas',()=>{
  assert.equal(safeLink('javascript:alert(1)'),'');assert.equal(safeLink('https://u:p@example.com'),'');
  assert.equal(safeLink('https://www.sec.gov/'),'https://www.sec.gov/');
  assert.equal(toCsv([['=1+2','hello,"world"']]),'"\'=1+2","hello,""world"""');
});
test('unconfigured earnings source returns an explicit capability boundary',async()=>{
  const route=createDeepDiveService({fetcher:()=>{throw Error('should not fetch');}});
  const result=await route(new URL('https://local/data/deep-dive/pead'));
  assert.equal(result.status,'unavailable');assert.equal(result.calendarAvailable,false);assert.deepEqual(result.rows,[]);
});
test('endpoint rejects injected certificates and invalid tickers before fetching',async()=>{
  const route=createDeepDiveService({fetcher:()=>{throw Error('should not fetch');}});
  for(const path of ['banking?cert=628%20OR%20*','orders?symbol=../../foo','demergers?symbol=https://x','pead?symbol=MSFT&date=2026-02-30'])
    assert.equal((await route(new URL('https://local/data/deep-dive/'+path))).httpStatus,400);
});
test('banking keeps FDIC dollar-thousand units and computes book-equity ratio',async()=>{
  const route=createDeepDiveService({fetcher:async()=>new Response(JSON.stringify({data:[{data:{REPDTE:'20260630',NAME:'Test bank',ASSET:2000,DEP:1000,LNLSNET:800,EQ:200,NIMY:3,ROA:1}},{data:{REPDTE:'20250630',NAME:'Test bank',DEP:800}}]})),clock:()=>new Date('2026-09-12')});
  const result=await route(new URL('https://local/data/deep-dive/banking?cert=628'));
  assert.equal(result.rows[0].current.deposits,1000);assert.equal(result.rows[0].current.loanDepositRatio,80);assert.equal(result.rows[0].current.equityAssets,10);
  approximately(result.rows[0].current.depositsGrowth,25);
});
