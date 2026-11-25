/** Observed IV comparisons for exact option contracts, never estimated live IV.
 * Futu documents IV in percent and update_time as a common quote timestamp:
 * https://open.futunn.com/api/quote/realtime/market-snapshot
 * It does not document an independent IV or Greek calculation timestamp.
 */
export const IV_CHECK_MS = 60000;
export const IV_OPTION_LIMIT = 399; // Reserve one of 400 snapshot slots for the future.
export const IV_HISTORY_LIMIT = 24;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const zonedTime = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const day = value => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));

export class IvTrackingError extends Error {
  constructor(code, message) { super(message); this.name = 'IvTrackingError'; this.code = code; }
}
function invalid(code, message) { throw new IvTrackingError(code, message); }

export function validateIvIdentity(market, underlyingCode) {
  if (!['NQ','ES','CL'].includes(market) || !new RegExp(`^US\\.${market}[0-9]{4}$`).test(underlyingCode ?? ''))
    invalid('IV_EXACT_FUTURE_REQUIRED', 'Select an exact NQ, ES or CL futures contract.');
}

/** Browser codes can only select saved exact series at server-approved strikes. */
export function selectIvContracts(savedMarket, {market,underlyingCode,codes,allowedStrikes,now=Date.now()}) {
  validateIvIdentity(market, underlyingCode);
  if (savedMarket?.underlyingCode !== underlyingCode)
    invalid('IV_UNDERLYING_CHANGED', 'Refresh the selected futures month before checking its IV.');
  if (!Array.isArray(allowedStrikes) || !allowedStrikes.some(value => finite(value) && value > 0))
    invalid('IV_WATCHLIST_REQUIRED', 'Save verified MenthorQ watched strikes before starting IV checks.');
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > IV_OPTION_LIMIT || new Set(codes).size !== codes.length || codes.some(code => typeof code !== 'string'))
    invalid('IV_INVALID_CODES', 'Select 1–399 unique watched option contracts.');
  const allowed = new Set(allowedStrikes.filter(value => finite(value) && value > 0));
  const rows = new Map((savedMarket.contracts ?? []).map(row => [row.code,row]));
  const today = day(now);
  return codes.map(code => {
    const row = rows.get(code);
    if (!row || row.underlyingCode !== underlyingCode || !allowed.has(row.strike) || !finite(row.strike) || row.strike <= 0 || !['CALL','PUT'].includes(String(row.optionType).toUpperCase()))
      invalid('IV_CONTRACT_NOT_WATCHED', 'Every IV contract must match a saved MenthorQ strike and the selected futures month.');
    if ((zonedTime(row.expiryTimestamp) && Date.parse(row.expiryTimestamp) <= now) || (typeof row.expiryDate === 'string' && row.expiryDate < today))
      invalid('IV_CONTRACT_EXPIRED', 'An expired option cannot be checked as a current watched contract.');
    return {code:row.code,underlyingCode,strike:row.strike,expiryDate:row.expiryDate,optionType:String(row.optionType).toLowerCase(),expirationCycle:row.expirationCycle ?? null};
  });
}

function observation(row, now) {
  if (row?.optionValid !== true || !finite(row.iv) || row.iv <= 0 || row.iv > 10 || !zonedTime(row.quoteAsOf)) return null;
  const asOf = Date.parse(row.quoteAsOf);
  if (asOf > now + 60000) return null;
  return {iv:row.iv,quoteTimestamp:new Date(asOf).toISOString(),collectedAt:new Date(now).toISOString(),
    delta:finite(row.delta)?row.delta:null,gamma:finite(row.gamma)?row.gamma:null,
    openInterest:finite(row.openInterest)?row.openInterest:null,bid:finite(row.bid)?row.bid:null,ask:finite(row.ask)?row.ask:null};
}

/** Advance only when the source quote time advances. Same-time revisions are
 * retained as a diagnostic observation, not assigned a fabricated IV timestamp.
 */
export function mergeIvObservation(previous, metadata, row, now=Date.now()) {
  const old = previous ?? {current:null,previous:null,baseline:null,history:[]};
  const common = {...old,metadata:{code:metadata.code,underlyingCode:metadata.underlyingCode,strike:metadata.strike,
    expiryDate:metadata.expiryDate,optionType:String(metadata.optionType).toUpperCase()},lastCheckedAt:new Date(now).toISOString()};
  const next = observation(row, now);
  if (!next) return {...common,observationStatus:!row?'snapshot-unavailable':!zonedTime(row.quoteAsOf)?'quote-time-unavailable':Date.parse(row.quoteAsOf)>now+60000?'future-quote-time':'iv-unavailable'};
  const oldTime = old.current ? Date.parse(old.current.quoteTimestamp) : null;
  const nextTime = Date.parse(next.quoteTimestamp);
  if (oldTime !== null && nextTime < oldTime) return {...common,observationStatus:'older-quote-retained'};
  if (oldTime !== null && nextTime === oldTime) return {...common,
    observationStatus:next.iv === old.current.iv?'no-newer-quote':'same-quote-time-revision',
    lastObservedRevision:next.iv === old.current.iv?null:{iv:next.iv,quoteTimestamp:next.quoteTimestamp,collectedAt:next.collectedAt}};
  const baseline = old.baseline && day(old.baseline.quoteTimestamp) === day(next.quoteTimestamp) ? old.baseline : next;
  return {...common,current:next,previous:old.current ?? null,baseline,
    history:[...(old.history ?? []),{iv:next.iv,quoteTimestamp:next.quoteTimestamp,collectedAt:next.collectedAt}].slice(-IV_HISTORY_LIMIT),
    observationStatus:old.current?'newer-quote':'baseline-only',lastObservedRevision:null};
}

export function publicIvRow(record, now=Date.now()) {
  const current = record.current, previous = record.previous, baseline = record.baseline;
  const change = current && previous ? current.iv-previous.iv : null;
  const age = current ? Math.max(0,Math.round((now-Date.parse(current.quoteTimestamp))/1000)) : null;
  return {...record.metadata,iv:current?.iv ?? null,delta:current?.delta ?? null,gamma:current?.gamma ?? null,
    openInterest:current?.openInterest ?? null,bid:current?.bid ?? null,ask:current?.ask ?? null,
    quoteTimestamp:current?.quoteTimestamp ?? null,collectedAt:current?.collectedAt ?? null,
    previousIv:previous?.iv ?? null,previousQuoteTimestamp:previous?.quoteTimestamp ?? null,
    ivChange:change,ivChangePoints:change === null?null:change*100,
    ivChangePercent:change === null||!(previous.iv>0)?null:change/previous.iv*100,
    baselineIv:baseline?.iv ?? null,baselineQuoteTimestamp:baseline?.quoteTimestamp ?? null,
    baselineChangePoints:current&&baseline?(current.iv-baseline.iv)*100:null,
    ivHistory:record.history ?? [],comparisonStatus:record.observationStatus,
    lastCheckedAt:record.lastCheckedAt ?? null,quoteAgeSeconds:age,
    quoteTimeStatus:age === null?'unavailable':age>120?'stale':'recent',
    ivTimestamp:null,greeksTimestamp:null,oiTimestamp:null,delayStatus:'unverified',
    lastObservedRevision:record.lastObservedRevision ?? null};
}
