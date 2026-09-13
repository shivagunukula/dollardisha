// Shared, side-effect-free research calculations. Missing is never zero.
export const SECTORS = [
  ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLV', 'Health care'],
  ['XLY', 'Consumer discretionary'], ['XLP', 'Consumer staples'], ['XLE', 'Energy'],
  ['XLI', 'Industrials'], ['XLB', 'Materials'], ['XLU', 'Utilities'],
  ['XLRE', 'Real estate'], ['XLC', 'Communication services']
].map(([symbol, name]) => ({ symbol, name }));
export const WINDOWS = { day:1, week:5, month:21, quarter:63, half:126, year:252 };
export function numeric(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function change(latest, prior) {
  const a = numeric(latest), b = numeric(prior);
  return a !== null && b !== null && b > 0 ? (a / b - 1) * 100 : null;
}
export function cleanHistory(rows, through = '9999-12-31') {
  const byDate = new Map();
  for (const row of rows || []) {
    const date = String(row.date || '').slice(0,10), close = numeric(row.close);
    if (validDate(date) && date <= through && close !== null && close > 0) byDate.set(date, { ...row, date, close, volume:numeric(row.volume) });
  }
  return [...byDate.values()].sort((a,b) => a.date.localeCompare(b.date));
}
const mean = values => values.length && values.every(v => numeric(v) !== null) ? values.reduce((s,v) => s + v,0) / values.length : null;
export function sectorSnapshot(histories) {
  const benchmark = cleanHistory(histories.SPY), asOf = benchmark.at(-1)?.date || null;
  const benchByDate = new Map(benchmark.map(r => [r.date,r]));
  const rows = SECTORS.map(sector => {
    const history = cleanHistory(histories[sector.symbol], asOf || '0000-01-01');
    const lookup = new Map(history.map(r => [r.date,r]));
    const current = lookup.get(asOf);
    const returns = {}, relative = {};
    for (const [period, sessions] of Object.entries(WINDOWS)) {
      const start = benchmark.at(-sessions - 1);
      returns[period] = change(current?.close, lookup.get(start?.date)?.close);
      const baseReturn = change(benchByDate.get(asOf)?.close, start?.close);
      relative[period] = returns[period] !== null && baseReturn !== null ? returns[period] - baseReturn : null;
    }
    const earlier = benchmark.at(-22), older = benchmark.at(-43);
    const previous = change(lookup.get(earlier?.date)?.close, lookup.get(older?.date)?.close);
    const previousBase = change(earlier?.close, older?.close);
    const momentum = relative.month !== null && previous !== null && previousBase !== null ? relative.month - (previous - previousBase) : null;
    const strength = relative.quarter;
    const regime = strength === null || momentum === null ? 'Insufficient history' : strength >= 0 ? (momentum >= 0 ? 'Leading' : 'Weakening') : (momentum >= 0 ? 'Improving' : 'Lagging');
    const last50Dates = benchmark.slice(-50).map(r => r.date);
    const ma50 = last50Dates.length === 50 ? mean(last50Dates.map(date => lookup.get(date)?.close)) : null;
    return { ...sector, asOf:current?.date || null, latestAvailable:history.at(-1)?.date || null, close:current?.close || null, provider:current?.provider || null, returns, relative, momentum, regime, above50:ma50 !== null && current ? current.close > ma50 : null };
  });
  const current = benchmark.at(-1), ma50 = benchmark.length >= 50 ? mean(benchmark.slice(-50).map(r => r.close)) : null;
  const ma200 = benchmark.length >= 200 ? mean(benchmark.slice(-200).map(r => r.close)) : null;
  const breadth = rows.filter(r => r.above50 !== null);
  const vix = cleanHistory(histories.VIX || [], asOf || '0000-01-01').at(-1);
  return { asOf, rows, covered:rows.filter(r => r.returns.month !== null).length, mood:{ spy:current?.close || null, ma50, ma200, trend:ma200 === null || ma50 === null ? 'Insufficient history' : current.close > ma50 && current.close > ma200 ? 'Above both averages' : current.close < ma50 && current.close < ma200 ? 'Below both averages' : 'Mixed trend', above50:breadth.filter(r => r.above50).length, covered:breadth.length, vix:vix?.date === asOf ? vix.close : null, vixAsOf:vix?.date || null } };
}
// Descriptive stock momentum snapshot. This deliberately keeps each stock's
// own trading calendar and never treats a missing horizon as zero.
export function stockMomentum(row, historyRows = []) {
  const history = cleanHistory(historyRows);
  const current = history.at(-1);
  const returns = {};
  for (const [period, sessions] of Object.entries(WINDOWS)) {
    returns[period] = current && history.length > sessions ? change(current.close, history.at(-sessions - 1)?.close) : null;
  }
  const ma = sessions => history.length >= sessions ? mean(history.slice(-sessions).map(r => r.close)) : null;
  const ma50 = ma(50), ma200 = ma(200);
  const above50 = current && ma50 !== null ? current.close > ma50 : null;
  const above200 = current && ma200 !== null ? current.close > ma200 : null;
  // The score is a sortable descriptor, not a forecast: medium-term return
  // leads, short-term confirmation adds weight, and trend flags are shown.
  const score = returns.quarter !== null
    ? returns.quarter + (returns.month !== null ? returns.month * 0.5 : 0) + (above50 === true ? 2 : 0) + (above200 === true ? 2 : 0)
    : null;
  const label = score === null ? 'Insufficient history' : score >= 15 && above50 !== false ? 'Strong momentum' : score >= 5 ? 'Positive momentum' : score <= -5 ? 'Weak momentum' : 'Mixed momentum';
  return { ...row, asOf:current?.date || null, price:current?.close || null, returns, ma50, ma200, above50, above200, score, label, history:history.slice(-90).map(r => ({date:r.date,close:r.close})) };
}
export function rankSectorStocks(rows) {
  return (rows || []).map(row => stockMomentum(row, row.history || [])).sort((a,b) =>
    (b.score ?? -Infinity) - (a.score ?? -Infinity)
      || (b.returns.quarter ?? -Infinity) - (a.returns.quarter ?? -Infinity)
      || String(a.symbol || '').localeCompare(String(b.symbol || ''))
  );
}
export function parseFredCsv(text, id) {
  const lines = String(text).trim().replace(/^\uFEFF/,'').split(/\r?\n/);
  const header = lines.shift()?.split(',');
  if (!['observation_date','DATE'].includes(header?.[0]) || header?.[1] !== id) throw new Error('Unexpected economic-data format');
  return lines.map(line => { const [date,value] = line.split(','); return { date, value:numeric(value) }; }).filter(r => validDate(r.date));
}
export function monthlySeries(rows) {
  const byMonth = new Map();
  for (const row of rows) if (validDate(row.date)) byMonth.set(row.date.slice(0,7), { date:row.date, value:numeric(row.value) });
  const ordered = [...byMonth.values()].sort((a,b) => a.date.localeCompare(b.date));
  const previousMonth = (date, months) => { const d = new Date(date); d.setUTCMonth(d.getUTCMonth() - months,1); return d.toISOString().slice(0,7); };
  return ordered.map(row => ({ ...row, mom:change(row.value, byMonth.get(previousMonth(row.date,1))?.value), yoy:change(row.value,byMonth.get(previousMonth(row.date,12))?.value) }));
}
export function peadAnalysis(event, stockRows, benchmarkRows) {
  const actual = numeric(event.actual), estimate = numeric(event.estimate);
  const stock = cleanHistory(stockRows), benchmark = cleanHistory(benchmarkRows);
  const lookup = new Map(stock.map(r => [r.date,r]));
  const baseLookup = new Map(benchmark.map(r => [r.date,r]));
  const session = ['bmo','amc'].includes(event.session) ? event.session : 'unknown';
  // Unknown release time: exclude the announcement date conservatively.
  const historyIncludesEvent = benchmark.length && event.date > benchmark[0].date;
  const reactionIndex = historyIncludesEvent ? benchmark.findIndex(r => session === 'bmo' ? r.date >= event.date : r.date > event.date) : -1;
  const reaction = benchmark[reactionIndex], prior = benchmark[reactionIndex - 1];
  const reactionReturn = change(lookup.get(reaction?.date)?.close,lookup.get(prior?.date)?.close);
  const benchmarkReaction = change(reaction?.close,prior?.close);
  const horizons = {};
  for (const sessions of [1,5,20]) {
    const end = reactionIndex >= 0 ? benchmark[reactionIndex + sessions] : null;
    const drift = change(lookup.get(end?.date)?.close,lookup.get(reaction?.date)?.close);
    const baseline = change(baseLookup.get(end?.date)?.close,reaction?.close);
    horizons[sessions] = { date:end?.date || null, return:drift, excess:drift !== null && baseline !== null ? drift - baseline : null };
  }
  const precedingVolumes = reactionIndex >= 20 ? benchmark.slice(reactionIndex - 20,reactionIndex).map(r => lookup.get(r.date)?.volume) : [];
  const avgVolume = precedingVolumes.length === 20 ? mean(precedingVolumes) : null;
  const reactionVolume = numeric(lookup.get(reaction?.date)?.volume);
  const surprise = actual !== null && estimate !== null && Math.abs(estimate) >= 0.01 ? (actual - estimate) / Math.abs(estimate) * 100 : null;
  return { ...event, actual, estimate, session, surprise, reactionDate:reaction?.date || null, reactionReturn, reactionExcess:reactionReturn !== null && benchmarkReaction !== null ? reactionReturn - benchmarkReaction : null, volumeRatio:reactionVolume !== null && avgVolume > 0 ? reactionVolume / avgVolume : null, horizons, asOf:benchmark.at(-1)?.date || null };
}
export function mergeTrackerRecords(...groups) {
  const records = new Map();
  for (const row of groups.flat()) {
    if (!row || typeof row.id !== 'string' || !row.updatedAt) continue;
    const previous = records.get(row.id);
    if (!previous || String(row.updatedAt) > String(previous.updatedAt) || (row.updatedAt === previous.updatedAt && row.deleted)) records.set(row.id,row);
  }
  return [...records.values()];
}
export function safeLink(value) {
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
export function toCsv(rows) {
  return rows.map(row => row.map(value => { let cell = String(value ?? ''); if (/^[=+@\-\t\r]/.test(cell)) cell = "'" + cell; return '"' + cell.replaceAll('"','""') + '"'; }).join(',')).join('\r\n');
}
