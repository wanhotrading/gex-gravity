// Observed IV geometry only. This is not an arbitrage-free fitted pricing surface.
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
const stamp = x => typeof x === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(x) ? Date.parse(x) : NaN;
const day = 86400000;
export function buildIvSurface({market, rows = market?.contracts ?? [], now = Date.now(), side = 'otm', includeOlder = false} = {}) {
  const reference = stamp(market?.priceTimestamp), captured = stamp(market?.modelAsOf ?? market?.collectedAt);
  const cutoff = Math.min(now, Number.isFinite(captured) ? captured : now);
  const result = {contract:market?.underlyingCode ?? null, price:market?.underlyingPrice ?? null,
    asOf:market?.priceTimestamp ?? null, capturedAt:Number.isFinite(captured) ? new Date(captured).toISOString() : null,
    side, points:[], expiries:[], strikes:[], counts:{received:rows.length, missing:0, expired:0, older:0, wrongContract:0, future:0, crossed:0}, status:'unavailable'};
  if (!result.contract || !positive(result.price) || !Number.isFinite(reference) || reference > cutoff + 60000) return result;
  const grouped = new Map();
  for (const row of rows) {
    if (row?.underlyingCode !== result.contract) { result.counts.wrongContract++; continue; }
    const expiry = stamp(row.expiryTimestamp), quote = stamp(row.quoteTimestamp), type = String(row.optionType).toLowerCase();
    if (!positive(row.strike) || !positive(row.iv) || row.iv > 10 || !row.code || !['call','put'].includes(type) || !Number.isFinite(expiry) || !Number.isFinite(quote)) { result.counts.missing++; continue; }
    if (expiry <= reference) { result.counts.expired++; continue; }
    if (quote > cutoff + 60000 || quote > reference + 60000) { result.counts.future++; continue; }
    if (finite(row.bid) && finite(row.ask) && row.bid > row.ask) { result.counts.crossed++; continue; }
    const older = Math.abs(reference - quote) > 15 * 60000;
    if (older && !includeOlder) { result.counts.older++; continue; }
    const requiredSide = side === 'otm' ? (row.strike < result.price ? 'put' : 'call') : side;
    if (type !== requiredSide) continue;
    const point = {code:row.code, strike:row.strike, expiry:row.expiryTimestamp, expiryDate:row.expiryDate ?? row.expiryTimestamp.slice(0,10),
      days:(expiry-reference)/day, iv:row.iv, optionType:type, quoteTimestamp:row.quoteTimestamp,
      collectedAt:row.collectedAt ?? market?.collectedAt ?? null, quoteGapMinutes:Math.abs(reference-quote)/60000, older,
      ivTimestamp:row.ivTimestamp ?? null, delta:finite(row.delta)?row.delta:null,
      history:ivHistoryPoints(row, cutoff), previousIv:row.previousIv ?? null, previousQuoteTimestamp:row.previousQuoteTimestamp ?? null};
    const key = `${point.expiry}|${point.strike}`, old = grouped.get(key);
    if (!old || quote > stamp(old.quoteTimestamp) || (quote === stamp(old.quoteTimestamp) && point.code.localeCompare(old.code) < 0)) grouped.set(key, point);
  }
  result.points = [...grouped.values()].sort((a,b)=>stamp(a.expiry)-stamp(b.expiry)||a.strike-b.strike);
  result.expiries = [...new Set(result.points.map(p=>p.expiry))];
  result.strikes = [...new Set(result.points.map(p=>p.strike))].sort((a,b)=>a-b);
  result.status = result.points.length ? 'observed' : 'empty';
  return result;
}
export function ivHistoryPoints(row, cutoff = Infinity) {
  const current = stamp(row?.quoteTimestamp);
  const observations = [...(Array.isArray(row?.ivHistory)?row.ivHistory:[])];
  if (positive(row?.previousIv)) observations.push({iv:row.previousIv, quoteTimestamp:row.previousQuoteTimestamp});
  if (positive(row?.iv)) observations.push({iv:row.iv,quoteTimestamp:row.quoteTimestamp,collectedAt:row.collectedAt});
  const unique = new Map();
  for (const p of observations) {
    const t = stamp(p.quoteTimestamp), available = stamp(p.collectedAt);
    if (!positive(p.iv) || p.iv > 10 || !Number.isFinite(t) || t > cutoff || t > current || (Number.isFinite(available) && available > cutoff)) continue;
    // Do not treat a same-clock revision as a new observation.
    if (!unique.has(t)) unique.set(t,{iv:p.iv,quoteTimestamp:p.quoteTimestamp});
  }
  return [...unique.values()].sort((a,b)=>stamp(a.quoteTimestamp)-stamp(b.quoteTimestamp)).slice(-24);
}
export function compareSurfacePoint(surface, point, baseline) {
  if (!baseline || baseline.contract !== surface.contract) return {status:'no-baseline',change:null};
  if (stamp(baseline.capturedAt ?? baseline.asOf) > stamp(surface.capturedAt ?? surface.asOf)) return {status:'later-baseline',change:null};
  const previous = baseline.points.find(p=>p.code === point.code && p.strike === point.strike && p.expiry === point.expiry && p.optionType === point.optionType);
  if (!previous) return {status:'unmatched',change:null};
  if (stamp(point.quoteTimestamp) <= stamp(previous.quoteTimestamp)) return {status:'no-newer-quote',change:null,previous};
  return {status:'compared',change:(point.iv-previous.iv)*100,previous};
}
// Bracketed interpolation in total variance and log strike, at one exact expiry.
// Used for descriptive metrics, never as an extrapolating pricing engine.
export function interpolateSurfaceIv(points, strike) {
  if (!positive(strike) || !points.length || new Set(points.map(p=>p.expiry)).size !== 1) return null;
  const sorted = [...points].sort((a,b)=>a.strike-b.strike), exact = sorted.find(p=>p.strike === strike);
  if (exact) return {iv:exact.iv, interpolated:false};
  const left = sorted.filter(p=>p.strike < strike).at(-1), right = sorted.find(p=>p.strike > strike);
  if (!left || !right) return null;
  const weight = Math.log(strike/left.strike)/Math.log(right.strike/left.strike);
  return {iv:Math.sqrt(left.iv**2*(1-weight)+right.iv**2*weight),interpolated:true};
}
export function surfaceReadings(surface, expiry, wing = .02) {
  const points = surface.points.filter(p=>p.expiry === expiry), F = surface.price;
  const atm = interpolateSurfaceIv(points,F), down = interpolateSurfaceIv(points,F*(1-wing)), up = interpolateSurfaceIv(points,F*(1+wing));
  return {atm, down, up, wing,
    downsidePremium:atm&&down?(down.iv-atm.iv)*100:null,
    upsidePremium:atm&&up?(up.iv-atm.iv)*100:null,
    wingDifference:down&&up?(down.iv-up.iv)*100:null};
}
