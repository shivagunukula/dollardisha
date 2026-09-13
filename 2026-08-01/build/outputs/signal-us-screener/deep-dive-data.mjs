import { SECTORS, numeric, validDate, cleanHistory, sectorSnapshot, stockMomentum, parseFredCsv, monthlySeries, peadAnalysis, change } from './deep-dive-core.js';

const UA = 'DollarDisha research contact@dollardisha.in';
const MONTHLY = {
  shipping:[
    { id:'PCU483111483111', name:'Deep sea freight prices', unit:'Index Jun 1988 = 100 · not seasonally adjusted', publisher:'US Bureau of Labor Statistics' },
    { id:'TSIFRGHT', name:'US freight activity', unit:'Index 2000 = 100 · seasonally adjusted', publisher:'US Bureau of Transportation Statistics' }
  ],
  auto:[
    { id:'TOTALSA', name:'US vehicle sales', unit:'Million vehicles · seasonally adjusted annual rate', publisher:'US Bureau of Economic Analysis' },
    { id:'IPG3361T3S', name:'Motor vehicles & parts production', unit:'Index 2017 = 100 · seasonally adjusted', publisher:'Federal Reserve Board' }
  ]
};
const BANKS = [{symbol:'JPM',cert:628},{symbol:'BAC',cert:3510},{symbol:'WFC',cert:3511},{symbol:'C',cert:7213}];
const DIRECTORY_SECTORS = {
  XLK:['Technology'], XLF:['Finance'], XLV:['Health Care'], XLY:['Consumer Discretionary'],
  XLP:['Consumer Staples'], XLE:['Energy'], XLI:['Industrials'], XLB:['Basic Materials'],
  XLU:['Utilities'], XLRE:['Real Estate'], XLC:['Telecommunications']
};
export async function pooled(items, limit, work) {
  const results = new Array(items.length); let index = 0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async () => {
    while(index < items.length) { const position = index++; try { results[position] = await work(items[position]); } catch { results[position] = null; } }
  }));
  return results;
}
export function cacheLoader(now = Date.now, maxEntries = 150) {
  const cache = new Map();
  return async (id, ttl, work) => {
    const existing = cache.get(id);
    if (existing && existing.until > now()) return existing.promise;
    if (cache.size >= maxEntries) { for (const [key,value] of cache) if (value.until <= now()) cache.delete(key); if(cache.size >= maxEntries) cache.delete(cache.keys().next().value); }
    const entry = { until:now() + ttl, promise:Promise.resolve().then(work) };
    cache.set(id,entry);
    try { return await entry.promise; } catch(error) { if(cache.get(id) === entry) cache.delete(id); throw error; }
  };
}
// Only completed US sessions: today's daily bar is excluded until 16:15 ET.
export function completeThrough(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p => [p.type,p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) * 60 + Number(parts.minute) >= 975) return date;
  return new Date(Date.parse(date) - 86400000).toISOString().slice(0,10);
}
export function filingEvidence(html, kind) {
  const text = String(html).replace(/<(script|style|ix:header)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,code) => {const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : ' ';}).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/[\u2010-\u2015]/g,'-').replace(/\s+/g,' ');
  const pattern = kind === 'demergers' ? /\b(spin[ -]?off|split[ -]?off|demerger|separation agreement)\b/i : /\b(backlog|bookings|contract award(?:ed)?|remaining performance obligations|order book|purchase orders?)\b/i;
  const match = pattern.exec(text);
  if (!match) return null;
  // A short evidence excerpt, not a full document copy or confirmed catalyst.
  const words = text.slice(Math.max(0,match.index - 35),match.index + 180).trim().split(/\s+/).slice(0,23);
  return { matched:match[0], excerpt:words.join(' ') + '…' };
}
export function createDeepDiveService({ fmp, fmpConfigured = false, directoryLoader = null, fetcher = fetch, clock = () => new Date() } = {}) {
  const cached = cacheLoader(() => clock().getTime());
  const checkedAt = () => clock().toISOString();
  async function request(url, type = 'json', maxBytes = 8_000_000) {
    const response = await fetcher(url,{headers:{'User-Agent':UA,Accept:type === 'json' ? 'application/json' : '*/*'},signal:AbortSignal.timeout(12000)});
    if(!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    // Bound document memory even when Content-Length is absent.
    const reader = response.body.getReader(); const parts = []; let size = 0;
    try { while(true) { const {done,value} = await reader.read(); if(done) break; size += value.byteLength; if(size > maxBytes) throw new Error('Source document exceeds the size limit'); parts.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const text = Buffer.concat(parts).toString('utf8');
    return type === 'json' ? JSON.parse(text) : text;
  }
  const history = ticker => cached(`history:${ticker}`,300000,async () => {
    let rows = [];
    if(fmpConfigured) {
      try {
        const data = await fmp('historical-price-eod/full',{symbol:ticker});
        rows = (Array.isArray(data) ? data : data?.historical || []).map(r => ({date:r.date,close:r.close,volume:r.volume,provider:'FMP'}));
      } catch { /* Use a single fallback series; never splice provider prices. */ }
    }
    if(cleanHistory(rows).length < 64) {
      const data = await request(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`);
      const result = data.chart?.result?.[0], quote = result?.indicators?.quote?.[0];
      rows = (result?.timestamp || []).map((t,i) => ({date:new Date(t * 1000).toISOString().slice(0,10),close:quote?.close?.[i],volume:quote?.volume?.[i],provider:'Yahoo Finance fallback'}));
    }
    const clean = cleanHistory(rows,completeThrough(clock()));
    if(!clean.length) throw new Error('No completed price history');
    return clean;
  });
  const sectors = () => cached('sectors',300000,async () => {
    const symbols = [...SECTORS.map(r => r.symbol),'SPY','^VIX'];
    const histories = await pooled(symbols,3,history);
    const data = Object.fromEntries(symbols.map((s,i) => [s === '^VIX' ? 'VIX' : s,histories[i] || []]));
    const result = sectorSnapshot(data);
    return { ...result, checkedAt:checkedAt(), status:result.covered === 11 ? 'available' : result.covered ? 'partial' : 'unavailable', sourceUrl:'https://www.ssga.com/us/en/individual/capabilities/equities/sector-investing/select-sector-etfs', methodology:'Completed-session closing-price returns, excluding dividends. 1D/1W/1M/3M/6M/1Y use 1/5/21/63/126/252 SPY sessions. Excess is sector return minus SPY return in percentage points on matching dates. Rotation compares 63-session excess with the change in excess between the latest and preceding 21 sessions. ETF coverage is not constituent breadth.' };
  });
  const sectorStocks = sectorSymbol => cached(`sector-stocks:${sectorSymbol}`,300000,async () => {
    const sector = SECTORS.find(item => item.symbol === sectorSymbol);
    if (!sector) throw new Error('Unknown sector ETF');
    if (typeof directoryLoader !== 'function') return {sector:sectorSymbol,sectorName:sector.name,rows:[],scanned:0,matched:0,status:'unavailable',checkedAt:checkedAt(),reason:'The public US equity directory is unavailable in this environment.'};
    let directory;
    try { directory = await directoryLoader(); } catch { directory = []; }
    const allowed = new Set(DIRECTORY_SECTORS[sectorSymbol] || []);
    const candidates = (directory || []).filter(row => allowed.has(String(row?.sector || '')))
      .filter(row => /^[A-Z][A-Z0-9.-]{0,9}$/.test(String(row?.symbol || '').toUpperCase()))
      .filter(row => !/(WARRANT|RIGHTS?|PREFERRED|DEPOSITARY SHARES|UNITS?|ETF|ETN)\b/i.test(String(row?.name || '')))
      .map(row => ({row,ticker:String(row.symbol).toUpperCase(),marketCap:numeric(String(row.marketCap || '').replace(/,/g,''))}))
      .filter(item => item.marketCap === null || item.marketCap > 0)
      .sort((a,b) => (b.marketCap ?? -Infinity) - (a.marketCap ?? -Infinity) || a.ticker.localeCompare(b.ticker));
    // Keep the drill-down responsive while exposing how many directory names
    // were eligible. This is a top-by-market-cap NASDAQ directory sample, not
    // a claim that it is the complete ETF holdings file.
    const selected = candidates.slice(0,24);
    const rows = (await pooled(selected,3,async item => {
      try {
        const historyRows = await history(item.ticker);
        return stockMomentum({symbol:item.ticker,name:String(item.row.name || item.ticker).replace(/\s+(Common Stock|Common Shares?|Class [A-Z] Common Stock)\s*$/i,'').trim(),sector:sector.name,marketCap:item.marketCap,provider:'Yahoo Finance fallback'}, historyRows);
      } catch { return null; }
    })).filter(Boolean);
    return {sector:sectorSymbol,sectorName:sector.name,rows,scanned:candidates.length,matched:rows.length,checkedAt:checkedAt(),status:rows.length ? rows.length === selected.length ? 'available' : 'partial' : 'unavailable',sourceUrl:'https://api.nasdaq.com/api/screener/stocks',methodology:'Stocks are ranked from completed Yahoo Finance daily closes. Candidates are the top 24 positive-market-cap NASDAQ directory listings mapped to the selected sector label; this is not a complete ETF holdings file and excludes non-operating security types. Momentum score = 3-month return + 0.5 × 1-month return + 2 points each when price is above its 50- and 200-session averages. It is descriptive, not a recommendation.'};
  });
  const monthly = category => cached(`monthly:${category}`,3600000,async () => {
    const rows = await pooled(MONTHLY[category],2,async meta => {
      const start = new Date(clock()); start.setUTCFullYear(start.getUTCFullYear() - 4);
      try {
        const csv = await request(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${meta.id}&cosd=${start.toISOString().slice(0,10)}`,'text');
        const observations = monthlySeries(parseFredCsv(csv,meta.id).filter(r => r.date <= checkedAt().slice(0,10))).slice(-36);
        const latest = observations.filter(r => r.value !== null).at(-1);
        if(!latest) throw new Error('No observations');
        return {...meta,sourceUrl:`https://fred.stlouisfed.org/series/${meta.id}`,observations,latest,status:'available'};
      } catch { return {...meta,sourceUrl:`https://fred.stlouisfed.org/series/${meta.id}`,observations:[],latest:null,status:'unavailable'}; }
    });
    return {rows,checkedAt:checkedAt(),status:rows.every(r => r?.latest) ? 'available' : rows.some(r => r?.latest) ? 'partial' : 'unavailable'};
  });
  const banking = cert => cached(`banking:${cert || 'large-banks'}`,3600000,async () => {
    const selected = cert ? [{cert:Number(cert),symbol:BANKS.find(b => b.cert === Number(cert))?.symbol || null}] : BANKS;
    const rows = await pooled(selected,3,async bank => {
      const sourceUrl = `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${bank.cert}`;
      try {
        const params = new URLSearchParams({filters:`CERT:${bank.cert}`,fields:'CERT,NAME,REPDTE,ASSET,DEP,LNLSNET,NIMY,EQ,ROA,ROE',sort_by:'REPDTE',sort_order:'DESC',limit:'9',format:'json'});
        const data = await request(`https://api.fdic.gov/banks/financials?${params}`);
        const history = (data.data || []).map(r => r.data).filter(r => /^\d{8}$/.test(String(r.REPDTE))).map(r => ({date:String(r.REPDTE).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),assets:numeric(r.ASSET),deposits:numeric(r.DEP),loans:numeric(r.LNLSNET),nim:numeric(r.NIMY),equity:numeric(r.EQ),roa:numeric(r.ROA),roe:numeric(r.ROE),name:r.NAME})).filter(r => r.date <= checkedAt().slice(0,10)).sort((a,b) => b.date.localeCompare(a.date));
        const current = history[0], priorYear = current ? history.find(r => r.date === `${Number(current.date.slice(0,4)) - 1}${current.date.slice(4)}`) : null;
        return {...bank,name:current?.name || `FDIC ${bank.cert}`,sourceUrl,history,current:current ? {...current,depositsGrowth:change(current.deposits,priorYear?.deposits),loansGrowth:change(current.loans,priorYear?.loans),loanDepositRatio:current.loans !== null && current.deposits > 0 ? current.loans/current.deposits*100 : null,equityAssets:current.equity !== null && current.assets > 0 ? current.equity/current.assets*100 : null} : null,status:current ? 'available' : 'unavailable'};
      } catch { return {...bank,name:`FDIC ${bank.cert}`,sourceUrl,history:[],current:null,status:'unavailable'}; }
    });
    return {rows,checkedAt:checkedAt(),status:rows.every(r => r?.current) ? 'available' : rows.some(r => r?.current) ? 'partial' : 'unavailable',methodology:'FDIC-insured bank subsidiaries, not consolidated listed holding companies. Monetary fields are USD thousands. NIM, ROA and ROE are the FDIC reported annualized year-to-date ratios. Equity/assets is book equity, not regulatory CET1.'};
  });
  const directory = () => cached('sec-directory',86400000,async () => Object.values(await request('https://www.sec.gov/files/company_tickers.json')));
  const issuer = ticker => cached(`issuer:${ticker}`,3600000,async () => {
    const company = (await directory()).find(r => String(r.ticker).toUpperCase() === ticker);
    if(!company) throw new Error('No SEC issuer found for this ticker');
    const cik = String(company.cik_str).padStart(10,'0');
    const submission = await request(`https://data.sec.gov/submissions/CIK${cik}.json`);
    return {company,cik,submission};
  });
  const filings = (ticker, kind) => cached(`filings:${ticker}:${kind}`,900000,async () => {
    const {company,cik,submission} = await issuer(ticker), recent = submission.filings?.recent || {};
    const allowed = kind === 'demergers' ? /^(8-K|10-12B|10-12G|10|S-4|S-1)(\/A)?$/ : /^(10-K|10-Q|8-K|20-F|6-K)(\/A)?$/;
    const forms = (recent.accessionNumber || []).map((accession,i) => ({accession,form:recent.form?.[i],date:recent.filingDate?.[i],document:recent.primaryDocument?.[i],description:recent.primaryDocDescription?.[i] || ''})).filter(r => allowed.test(r.form || '') && validDate(r.date) && r.date <= checkedAt().slice(0,10) && /^[\w.-]+$/.test(r.document || '') && /^[\d-]+$/.test(r.accession)).slice(0,6);
    // Sequential per issuer keeps SEC traffic comfortably below fair-access limits.
    const examined = await pooled(forms,1,async row => {
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${row.accession.replaceAll('-','')}/${row.document}`;
      try {
        const html = await request(url,'text',12_000_000);
        const evidence = filingEvidence(html,kind);
        return {...row,url,examined:true,evidence};
      } catch { return {...row,url,examined:false,evidence:null}; }
    });
    const rows = examined.filter(r => r?.evidence);
    let obligations = [], obligationsStatus = 'not-requested';
    if(kind === 'orders') {
      try {
        const facts = await cached(`facts:${ticker}`,3600000,() => request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`));
        const byEnd = new Map();
        for(const fact of facts.facts?.['us-gaap']?.RevenueRemainingPerformanceObligation?.units?.USD || []) {
          if(fact.start || !validDate(fact.end) || fact.end > checkedAt().slice(0,10) || !validDate(fact.filed) || fact.filed > checkedAt().slice(0,10) || numeric(fact.val) === null || !['10-K','10-Q','20-F'].includes(fact.form))continue;
          const prior = byEnd.get(fact.end);
          if(!prior || prior.filed < fact.filed)byEnd.set(fact.end,{date:fact.end,value:Number(fact.val),filed:fact.filed,form:fact.form});
        }
        obligations = [...byEnd.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
        obligationsStatus = obligations.length ? 'available' : 'not-reported';
      } catch { obligationsStatus = 'unavailable'; }
    }
    return {symbol:ticker,name:submission.name || company.title,rows,documents:examined,obligations,obligationsStatus,obligationsSource:`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,examined:examined.filter(r => r?.examined).length,attempted:forms.length,checkedAt:checkedAt(),status:examined.some(r => r?.examined) ? examined.every(r => r?.examined) ? 'available' : 'partial' : 'unavailable',methodology:'Keyword candidates from up to six recent primary issuer documents; exhibits and older filings are not searched. Mentions may be historical, conditional, cancelled, or about another company. Read the linked filing before confirming an event or a contract.'};
  });
  const pead = async params => {
    const ticker = params.get('symbol');
    if(ticker) {
      const date = params.get('date');
      if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !validDate(date) || date > completeThrough(clock())) throw new Error('Enter a valid ticker and a past earnings date');
      const [prices,benchmark] = await Promise.all([history(ticker),history('SPY')]);
      const row = peadAnalysis({symbol:ticker,date,actual:numeric(params.get('actual')),estimate:numeric(params.get('estimate')),session:params.get('session'),source:'User-entered earnings inputs'},prices,benchmark);
      return {rows:[row],status:'available',checkedAt:checkedAt(),source:'User-entered earnings inputs; connected daily prices',calendarAvailable:fmpConfigured};
    }
    return cached('pead-calendar',900000,async () => {
      if(!fmpConfigured) return {rows:[],status:'unavailable',checkedAt:checkedAt(),calendarAvailable:false,reason:'Automatic earnings discovery needs the configured FMP earnings-calendar entitlement. You can still analyse a reported event below using your own EPS inputs.'};
      const from = new Date(clock()); from.setUTCDate(from.getUTCDate() - 30);
      let events;
      try { events = await fmp('earnings-calendar',{from:from.toISOString().slice(0,10),to:completeThrough(clock())}); } catch { events = []; }
      const seen = new Set();
      const eligible = (Array.isArray(events) ? events : []).map(r => ({symbol:String(r.symbol || '').toUpperCase(),date:String(r.date || '').slice(0,10),actual:numeric(r.epsActual ?? r.eps),estimate:numeric(r.epsEstimated),session:r.time})).filter(r => /^[A-Z][A-Z0-9.-]{0,9}$/.test(r.symbol) && validDate(r.date) && r.date >= from.toISOString().slice(0,10) && r.date <= completeThrough(clock()) && r.actual !== null && r.estimate !== null).sort((a,b) => b.date.localeCompare(a.date)).filter(r => {const id = r.symbol + r.date; if(seen.has(id)) return false; seen.add(id); return true;}).slice(0,12);
      const benchmark = await history('SPY').catch(() => []);
      const rows = (await pooled(eligible,3,async event => {
        const profile = await fmp('profile',{symbol:event.symbol});
        if(!['NASDAQ','NYSE','AMEX'].includes(String(profile?.[0]?.exchangeShortName || profile?.[0]?.exchange || '').toUpperCase())) return null;
        return peadAnalysis({...event,source:'FMP reported earnings'},await history(event.symbol),benchmark);
      })).filter(Boolean);
      return {rows,checkedAt:checkedAt(),status:rows.length ? 'available' : 'unavailable',calendarAvailable:true,attempted:eligible.length,reason:rows.length ? null : 'No usable reported US earnings returned in this 30-day provider sample. Use event analysis below.'};
    });
  };
  return async function route(url) {
    const module = url.pathname.replace('/data/deep-dive/','');
    if(module === 'sectors') return sectors();
    if(module === 'sector-stocks') {
      const sector = String(url.searchParams.get('sector') || '').toUpperCase();
      if (!SECTORS.some(item => item.symbol === sector)) return {error:'Enter a valid sector ETF',httpStatus:400};
      try { return await sectorStocks(sector); } catch(error) { return {error:error.message,httpStatus:502}; }
    }
    if(module === 'shipping' || module === 'auto') return monthly(module);
    if(module === 'banking') {const cert = url.searchParams.get('cert'); if(cert && !/^\d{1,6}$/.test(cert)) return {error:'Invalid FDIC certificate',httpStatus:400}; return banking(cert);}
    if(module === 'demergers' || module === 'orders') { const ticker = String(url.searchParams.get('symbol') || '').toUpperCase(); if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return {error:'Enter a valid US ticker',httpStatus:400}; return filings(ticker,module); }
    if(module === 'pead') {
      try { return await pead(url.searchParams); } catch(error) { return {error:error.message,httpStatus:400}; }
    }
    return {error:'Unknown Deep Dive tool',httpStatus:404};
  };
}
