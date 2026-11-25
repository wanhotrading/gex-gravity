/** Quote-only Futu REST adapter. No OAuth, persistence, telemetry or trading API.
 * Official contracts: https://open.futunn.com/api/quote/realtime/market-snapshot
 * https://open.futunn.com/api/quote/derivatives/option-chain
 * https://open.futunn.com/api/quote/derivatives/reference-future
 * https://open.futunn.com/api/quote/derivatives/future-info
 * https://open.futunn.com/api/quote/basic-data/history-kline
 * https://open.futunn.com/api/overview/rate-limit
 * A successful chain does not establish native futures-option Greek entitlement.
 */
export const FUTU_ORIGIN = 'https://webapi.futunn.com';
export const SNAPSHOT_BATCH_LIMIT = 400;
export const QUOTE_INTERVAL_MS = 650; // below the documented 100 requests/min/IP
const DAY_MS = 86400000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MARKETS = new Set(['NQ', 'ES', 'CL', 'GC']);
const DIAGNOSTIC_PATHS = Object.freeze({
  snapshot: '/api/v1.0/quote/snapshot', 'future-info': '/api/v1.0/quote/future-info',
  'option-chain': '/api/v1.0/quote/{symbol}/option-chain',
  'option-expiration': '/api/v1.0/quote/{symbol}/option-expiration',
  'reference-future': '/api/v1.0/quote/{symbol}/reference-future',
  'history-kline': '/api/v1.0/quote/{symbol}/history-kline',
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;

export class FutuQuoteError extends Error {
  constructor(code, message) { super(message); this.name = 'FutuQuoteError'; this.code = code; }
}
function fail(code, message) { throw new FutuQuoteError(code, message); }
const SHAPE_TYPES=new Set(['missing','null','array','object','boolean','number','string','other']);
const SHAPE_TYPE_FIELDS=['barsType','paginationType','paginationHasMoreType','paginationNextTimeType','dataHasMoreType','dataPaginationHasMoreType','nextTimeType','firstbarTimeType','dataExtraNextTimeType'];
function safeBarDiagnostics(value){
  if(!value||typeof value!=='object')return null;
  const result={};
  if(['validated','normalization','calendar-bounds','backward-progress','merge-conflict','page-cap','current-probe-invalid'].includes(value.reason))result.reason=value.reason;
  for(const key of ['rawBarCount','futureTimestampCount','invalidTimestampCount','badPriceCount','badVolumeCount','offGridCount','rawDateOutsideCount','priorBarCount','currentBarCount'])
    if(Number.isInteger(value[key])&&value[key]>=0&&value[key]<=100000)result[key]=value[key];
  for(const key of ['oldestMs','newestMs'])if(Number.isSafeInteger(value[key])&&value[key]>=946684800000&&value[key]<=4102444800000)result[key]=value[key];
  for(const key of ['minNYDate','maxNYDate'])if(typeof value[key]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value[key])&&Number.isFinite(Date.parse(value[key]))&&new Date(value[key]).toISOString().slice(0,10)===value[key])result[key]=value[key];
  if(value.samples&&typeof value.samples==='object'){
    result.samples={};
    for(const group of ['first','last','offending'])if(Array.isArray(value.samples[group]))result.samples[group]=value.samples[group].slice(0,2).map(row=>{
      const record={};
      for(const field of ['time_key','date','open','close','high','low','volume','turnover'])
        if(typeof row?.[field]==='number'&&Number.isFinite(row[field])&&Math.abs(row[field])<=1e15)record[field]=row[field];
      return record;
    });
  }
  return Object.keys(result).length?result:null;
}
function safeResponseShape(error){
  if(error.stage!=='history-kline'||error.path!==DIAGNOSTIC_PATHS['history-kline']||!error.responseShape||typeof error.responseShape!=='object')return null;
  const result={};
  for(const field of ['barsLength','requestedNum'])if(Number.isInteger(error.responseShape[field])&&error.responseShape[field]>=0&&error.responseShape[field]<=100000)result[field]=error.responseShape[field];
  for(const field of SHAPE_TYPE_FIELDS)if(SHAPE_TYPES.has(error.responseShape[field]))result[field]=error.responseShape[field];
  if(['ms','sec','other'].includes(error.responseShape.firstbarTimeUnit))result.firstbarTimeUnit=error.responseShape.firstbarTimeUnit;
  if(Number.isInteger(error.responseShape.firstpositivebarGapMs)&&error.responseShape.firstpositivebarGapMs>0&&error.responseShape.firstpositivebarGapMs<=86400000)
    result.firstpositivebarGapMs=error.responseShape.firstpositivebarGapMs;
  const barDiagnostics=safeBarDiagnostics(error.responseShape.barDiagnostics);if(barDiagnostics)result.barDiagnostics=barDiagnostics;
  return Object.keys(result).length?result:null;
}
export function safeFutuError(error) {
  // Never return upstream bodies, request headers, raw exception messages or tokens.
  if (!(error instanceof FutuQuoteError)) return { code: 'FUTU_REQUEST_FAILED', message: 'Futu quote request failed. Upstream details were withheld.' };
  const responseShape=safeResponseShape(error);
  return { code: error.code, message: error.message,
    ...(typeof error.providerRetCode === 'number' && Number.isFinite(error.providerRetCode) ? { providerRetCode: error.providerRetCode } : {}),
    ...(own(DIAGNOSTIC_PATHS, error.stage) && error.path === DIAGNOSTIC_PATHS[error.stage]
      ? { stage: error.stage, path: error.path } : {}),
    ...(responseShape?{responseShape}:{}) };
}
export function validateFutuSymbol(value) {
  if (typeof value !== 'string' || !/^[A-Z]{2,8}\.[A-Za-z0-9_.-]{1,80}$/.test(value))
    fail('INVALID_SYMBOL', 'Expected one exact MARKET.CODE quote symbol.');
  return value;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    fail('INVALID_DATE', 'Expected a valid YYYY-MM-DD calendar date.');
  return value;
}
function marketSymbol(market, code) {
  if (!MARKETS.has(market) || !new RegExp(`^US\\.${market}[0-9]{4}$`).test(code ?? ''))
    fail('EXACT_FUTURE_REQUIRED', 'Select an exact provider-listed futures contract for this market.');
  return code;
}
function tokensFromGrant(grant) {
  const scopes = typeof grant?.scope === 'string' ? grant.scope.trim().split(/\s+/) : [];
  if (!scopes.includes('quote:read') || scopes.length > 65 || new Set(scopes).size !== scopes.length
    || scopes.some(scope => scope !== 'quote:read' && !/^accid:[0-9]{1,30}$/.test(scope)))
    fail('QUOTE_SCOPE_REQUIRED', 'A verified quote:read-only grant is required. Trading and unknown scopes are rejected.');
  const token = grant.accessToken ?? grant.access_token;
  if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n\x00]/.test(token))
    fail('QUOTE_TOKEN_REQUIRED', 'A valid private quote token is required.');
  return token;
}
async function boundedJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BODY_BYTES)
    fail('INVALID_FUTU_RESPONSE', 'Futu response was absent or exceeded the size limit.');
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); fail('INVALID_FUTU_RESPONSE', 'Futu response exceeded the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail('INVALID_FUTU_RESPONSE', 'Futu response was not valid JSON.'); }
}

/** One instance should be shared by all markets to serialize requests below quota.
 * getAccessToken returns { accessToken, scope }; it may refresh through private auth.
 * Neither the grant nor access token is returned or included in diagnostic output.
 */
export function createFutuQuoteClient({ getAccessToken, fetchImpl = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), requestIntervalMs = QUOTE_INTERVAL_MS,
  notBeforeMs = 0, deadlineAtMs = Infinity } = {}) {
  if (typeof getAccessToken !== 'function') fail('QUOTE_TOKEN_REQUIRED', 'Provide a private quote-token getter.');
  if (!Number.isFinite(requestIntervalMs) || requestIntervalMs < QUOTE_INTERVAL_MS)
    fail('INVALID_RATE_LIMIT', 'Quote requests must be spaced at least 650 milliseconds apart.');
  if (!Number.isFinite(notBeforeMs) || !(Number.isFinite(deadlineAtMs) || deadlineAtMs === Infinity))
    fail('INVALID_REQUEST_BUDGET', 'Quote request timing bounds must be valid timestamps.');
  let queue = Promise.resolve(), previousStart = notBeforeMs - requestIntervalMs;
  const request = (path, { method = 'GET', query, body, includePagination = false } = {}) => {
    const task = queue.then(async () => {
      const url = new URL(path, FUTU_ORIGIN);
      const fixedPost = ['/api/v1.0/quote/snapshot', '/api/v1.0/quote/future-info'];
      const fixedGet = /^\/api\/v1\.0\/quote\/([A-Z]{2,8}\.[A-Za-z0-9_.-]{1,80})\/(option-chain|option-expiration|reference-future|history-kline)$/;
      if (url.origin !== FUTU_ORIGIN || url.hash || url.search || url.username || url.password
        || !(method === 'POST' ? fixedPost.includes(url.pathname) : method === 'GET' && fixedGet.test(url.pathname)))
        fail('REQUEST_NOT_ALLOWED', 'Only fixed, read-only Futu quote endpoints are allowed.');
      const stage = url.pathname.split('/').at(-1), diagnosticPath = DIAGNOSTIC_PATHS[stage];
      if (query) url.search = new URLSearchParams(query).toString();
      const pause = requestIntervalMs - (now() - previousStart); if (pause > 0) await sleep(pause);
      if (now() >= deadlineAtMs) fail('COLLECTION_STEP_YIELD', 'The bounded quote step is ready to continue in another request.');
      let token, providerRetCode;
      try {
        token = tokensFromGrant(await getAccessToken()); previousStart = now();
        if (now() >= deadlineAtMs) fail('COLLECTION_STEP_YIELD', 'The bounded quote step is ready to continue in another request.');
        const response = await fetchImpl(url.toString(), { method, redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(1,Math.min(15000,deadlineAtMs-now()))), headers: { accept: 'application/json', authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status)) fail('FUTU_PERMISSION_REQUIRED', 'Futu quote authentication or market entitlement needs attention.');
          if (response.status === 429) fail('FUTU_RATE_LIMIT', 'Futu quote request limit was reached.');
          fail('FUTU_HTTP_ERROR', 'Futu did not return a successful quote response.');
        }
        const payload = await boundedJson(response);
        if (typeof payload?.ret_code === 'number' && Number.isFinite(payload.ret_code)) providerRetCode = payload.ret_code;
        if (payload?.ret_code !== 0) {
          if ([-9, -12009, -12102, -12006].includes(payload?.ret_code)) fail('FUTU_PERMISSION_REQUIRED', 'Futu quote authentication or market entitlement needs attention.');
          if ([-11, -12011].includes(payload?.ret_code)) fail('FUTU_RATE_LIMIT', 'Futu quote request limit was reached.');
          if ([-7, -8, -10].includes(payload?.ret_code)) fail('FUTU_DATA_UNAVAILABLE', 'Futu has no available quote data for the requested instrument.');
          fail('FUTU_API_ERROR', 'Futu rejected the quote request. Upstream details were withheld.');
        }
        if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data))
          fail('INVALID_FUTU_RESPONSE', 'Futu returned an unexpected data structure.');
        return includePagination ? { data: payload.data, pagination: payload.pagination } : payload.data;
      } catch (error) {
        const safe = now() >= deadlineAtMs ? new FutuQuoteError('COLLECTION_STEP_YIELD', 'The bounded quote step is ready to continue in another request.') : error instanceof FutuQuoteError ? error
          : new FutuQuoteError('FUTU_REQUEST_FAILED', 'Futu quote request failed. Upstream details were withheld.');
        if (providerRetCode !== undefined) safe.providerRetCode = providerRetCode;
        safe.stage = stage; safe.path = diagnosticPath; throw safe;
      } finally { token = null; }
    });
    queue = task.catch(() => {}); return task;
  };
  const list = (data, key) => {
    if (!Array.isArray(data[key]) || data[key].length > 100000)
      fail('INVALID_FUTU_RESPONSE', 'Futu returned an unexpected quote list.');
    return data[key];
  };
  const batch = (codes) => {
    if (!Array.isArray(codes) || codes.length < 1 || codes.length > SNAPSHOT_BATCH_LIMIT || new Set(codes).size !== codes.length)
      fail('INVALID_BATCH', 'Supply 1–400 unique quote symbols.');
    return codes.map(validateFutuSymbol);
  };
  return Object.freeze({
    async optionChain(code, start, end) {
      validateFutuSymbol(code); validDate(start); validDate(end);
      const days = (Date.parse(end) - Date.parse(start)) / DAY_MS + 1;
      // A <=14-calendar-day window cannot hit the documented 20-expiry-date cap.
      if (days < 1 || days > 14) fail('INVALID_CHAIN_WINDOW', 'Use a chain window of at most 14 calendar days.');
      return list(await request(`/api/v1.0/quote/${code}/option-chain`, { query: { start, end } }), 'option_chain');
    },
    async optionExpirations(code) { validateFutuSymbol(code); return list(await request(`/api/v1.0/quote/${code}/option-expiration`), 'expiration_list'); },
    async snapshots(codes) { return list(await request('/api/v1.0/quote/snapshot', { method: 'POST', body: { code_list: batch(codes) } }), 'snapshot_list'); },
    async referenceFutures(code) { validateFutuSymbol(code); return list(await request(`/api/v1.0/quote/${code}/reference-future`), 'reference_list'); },
    async futureInfo(codes) { return list(await request('/api/v1.0/quote/future-info', { method: 'POST', body: { code_list: batch(codes) } }), 'future_info_list'); },
    /** Exact dated futures only. Preserve provider bar fields and absolute times;
     * consumers normalize OHLCV and group NY windows without using trading date.
     * Pagination is top-level, while its backward cursor belongs to data.
     */
    async historyKlinePage(code, { start, end, nextTime, num = 370, ktype = 6 } = {}) {
      validateFutuSymbol(code); marketSymbol(code.slice(3, 5), code);
      if (start !== undefined) validDate(start);
      if (end !== undefined) validDate(end);
      if (start !== undefined && end !== undefined && start > end)
        fail('INVALID_HISTORY_WINDOW', 'History start must not be later than its end date.');
      if (!Number.isInteger(num) || num < 1 || num > 370 || ![1, 2, 6].includes(ktype))
        fail('INVALID_HISTORY_PARAMETERS', 'History supports 1–370 bars of 1-minute, 5-minute or daily data.');
      if (nextTime !== undefined && (!Number.isSafeInteger(nextTime) || nextTime < 946684800000 || nextTime > 4102444800000))
        fail('INVALID_HISTORY_CURSOR', 'History cursor must be a valid millisecond timestamp.');
      if (end === undefined && nextTime === undefined)
        fail('INVALID_HISTORY_WINDOW', 'History requires an end date or backward cursor.');
      const query = { ktype, autype: 0, num,
        ...(start === undefined ? {} : { start }),
        ...(nextTime === undefined ? { end } : { next_time: nextTime }) };
      const { data, pagination } = await request(`/api/v1.0/quote/${code}/history-kline`, { query, includePagination: true });
      const type=value=>value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':SHAPE_TYPES.has(typeof value)?typeof value:'other';
      const bars=data.kline_list;
      const firstTime=number(bars?.[0]?.time_key),sampleTimes=Array.isArray(bars)?bars.map(row=>number(row?.time_key)):[];
      const firstbarTimeUnit=firstTime>=946684800000&&firstTime<=4102444800000?'ms':firstTime>=946684800&&firstTime<=4102444800?'sec':'other';
      let firstPositiveGap=null;
      for(let i=1;i<sampleTimes.length;i++)if(Number.isFinite(sampleTimes[i])&&Number.isFinite(sampleTimes[i-1])&&sampleTimes[i]!==sampleTimes[i-1]){firstPositiveGap=Math.abs(sampleTimes[i]-sampleTimes[i-1]);break;}
      const responseShape={barsLength:Array.isArray(bars)?bars.length:0,requestedNum:num,barsType:type(bars),paginationType:type(pagination),
        paginationHasMoreType:type(pagination?.has_more),paginationNextTimeType:type(pagination?.next_time),dataHasMoreType:type(data.has_more),dataPaginationHasMoreType:type(data.pagination?.has_more),
        nextTimeType:type(data.next_time),firstbarTimeType:type(bars?.[0]?.time_key),dataExtraNextTimeType:type(data.extra?.next_time),
        firstbarTimeUnit,
        ...(firstbarTimeUnit==='ms'&&Number.isInteger(firstPositiveGap)&&firstPositiveGap>0&&firstPositiveGap<=86400000?{firstpositivebarGapMs:firstPositiveGap}:{})};
      const historyFailure=message=>{
        const error=new FutuQuoteError('INVALID_FUTU_RESPONSE',message);
        error.stage='history-kline';error.path=DIAGNOSTIC_PATHS['history-kline'];
        error.responseShape=responseShape;
        throw error;
      };
      // Observed live futures responses ignore num=370 and return 1,000 rows.
      // Accept that bounded page without truncation or claiming requested size.
      if (!Array.isArray(bars)||bars.length > 1000 || bars.some(row => !row || typeof row !== 'object' || Array.isArray(row))
        || typeof pagination?.has_more !== 'boolean')
        historyFailure('Futu returned invalid historical bars or pagination.');
      const hasMore = pagination.has_more;
      const validTime=value=>Number.isSafeInteger(value)&&value>=946684800000&&value<=4102444800000;
      const dataCursor=number(data.next_time),paginationCursor=number(pagination.next_time);
      if((data.next_time!==undefined&&data.next_time!==null&&!validTime(dataCursor))
        ||(pagination.next_time!==undefined&&pagination.next_time!==null&&!validTime(paginationCursor))
        ||validTime(dataCursor)&&validTime(paginationCursor)&&dataCursor!==paginationCursor)
        historyFailure('Futu history returned invalid or conflicting cursors.');
      let cursor=validTime(dataCursor)?dataCursor:validTime(paginationCursor)?paginationCursor:null;
      let cursorBasis=validTime(dataCursor)?'data-next-time':validTime(paginationCursor)?'pagination-next-time':null;
      const barTimes=bars.map(row=>number(row.time_key));
      if(hasMore&&cursor===null&&barTimes.length&&barTimes.every(validTime)){
        cursor=Math.min(...barTimes)-1;cursorBasis='oldest-bar-minus-1';
      }
      if (hasMore && (!validTime(cursor) || nextTime !== undefined && cursor >= nextTime))
        historyFailure('Futu history pagination did not provide an older cursor.');
      if(nextTime!==undefined&&barTimes.some(value=>!validTime(value)||value>nextTime))
        historyFailure('Futu history bars did not honor the requested backward cursor.');
      // The documented scaling field may be omitted for ordinary futures (0).
      const volumePrecision = data.volume_precision === undefined ? 0 : number(data.volume_precision);
      if (!Number.isInteger(volumePrecision) || volumePrecision < 0 || volumePrecision > 12)
        historyFailure('Futu history volume precision was invalid.');
      return { code, ktype, bars, hasMore, nextTime: validTime(cursor) ? cursor : null, cursorBasis, volumePrecision, responseShape };
    },
  });
}

/** Discover actual listed contracts; never guess a CL month from wall-clock date.
 * `future_main_contract` means a continuous alias, not the winning dated contract.
 * Selection remains explicit because first expiry and highest-volume month differ.
 */
export async function discoverFutures(client, market, { now = Date.now() } = {}) {
  if (!MARKETS.has(market)) fail('INVALID_MARKET', 'Choose NQ, ES, CL or GC.');
  const rows = await client.referenceFutures(`US.${market}main`);
  const codes = [...new Set(rows.filter(row => row?.future_valid === true
    && row.future_main_contract === false && new RegExp(`^US\\.${market}[0-9]{4}$`).test(row.code)).map(row => row.code))];
  const info = [];
  for (let i = 0; i < codes.length; i += SNAPSHOT_BATCH_LIMIT) info.push(...await client.futureInfo(codes.slice(i, i + SNAPSHOT_BATCH_LIMIT)));
  const byCode = new Map(info.filter(row => codes.includes(row?.code)).map(row => [row.code, row]));
  return { market, continuousCode: `US.${market}main`, selectionRequired: true,
    contracts: codes.map(code => {
      const entry = byCode.get(code); let expires = number(entry?.last_trade_time);
      if (!(expires >= 946684800000 && expires <= 4102444800000)) expires = null;
      return { code, exchange: typeof entry?.exchange === 'string' ? entry.exchange.slice(0, 20) : null,
        contractMultiplier: number(entry?.size), expiryTimestamp: expires && expires > 0 ? new Date(expires).toISOString() : null,
        expired: expires && expires > 0 ? expires <= now : null,
        hasProviderInfo: !!entry };
    }), coverage: { referenceCount: rows.length, exactContractCount: codes.length, infoCount: byCode.size,
      complete: codes.length > 0 && byCode.size === codes.length } };
}

/** Explicit liquidity-based selection, not an assertion about the vendor's main
 * alias or the nearest delivery month. Every candidate remains visible for review.
 */
export async function selectActiveFuture(client, market, { now = Date.now(), staleAfterMs = 20 * 60000 } = {}) {
  const catalog = await discoverFutures(client, market, { now });
  const eligible = catalog.contracts.filter(row => row.expired === false && row.hasProviderInfo);
  const rows = [];
  for (let i = 0; i < eligible.length; i += SNAPSHOT_BATCH_LIMIT)
    rows.push(...await client.snapshots(eligible.slice(i, i + SNAPSHOT_BATCH_LIMIT).map(row => row.code)));
  const reconciled = reconcileSnapshots(eligible.map(row => row.code), rows);
  const candidates = eligible.map(entry => {
    const quote = reconciled.matched.get(entry.code), time = sourceTimestamp(quote?.update_time, now, staleAfterMs);
    const volume = number(quote?.volume), price = number(quote?.last_price);
    return { ...entry, volume: quote?.future_valid === true && volume >= 0 ? volume : null,
      futuresPrice: quote?.future_valid === true ? price : null, quoteAsOf: time.asOf, quoteTimeStatus: time.status,
      eligible: quote?.future_valid === true && volume > 0 && price !== null && time.status === 'fresh' };
  });
  const ranked = candidates.filter(row => row.eligible).sort((a, b) => b.volume - a.volume || a.expiryTimestamp.localeCompare(b.expiryTimestamp));
  const tied = ranked.length > 1 && ranked[0].volume === ranked[1].volume;
  return { market, selectedCode: !tied && ranked.length ? ranked[0].code : null,
    selectionBasis: 'Highest reported snapshot volume among provider-listed, nonexpired dated futures with recent timestamps; not a continuous-alias mapping.',
    selectionIssue: tied ? 'equal-volume-candidates' : ranked.length ? null : 'no-verified-active-volume', candidates,
    coverage: { ...catalog.coverage, snapshotComplete: reconciled.complete } };
}

export function normalizeOptionMetadata(raw, underlyingCode) {
  try {
    const code = validateFutuSymbol(raw?.code); marketSymbol(underlyingCode.split('.')[1]?.slice(0, 2), underlyingCode);
    const strike = number(raw.strike_price), optionType = String(raw.option_type).toLowerCase(); validDate(raw.strike_time);
    if (!code.startsWith('US.') || raw.stock_owner !== underlyingCode || !(strike > 0)
      || !['call', 'put'].includes(optionType) || raw.stock_type !== 'DRVT') return null;
    return { code, underlyingCode, strike, optionType, expiryDate: raw.strike_time,
      expirationCycle: typeof raw.expiration_cycle === 'string' ? raw.expiration_cycle.slice(0, 30) : null,
      exactExpiry: null, exerciseStyle: null };
  } catch { return null; }
}
function sourceTimestamp(raw, now, staleAfterMs) {
  const ms = number(raw); if (!ms || ms < 946684800000 || ms > 4102444800000) return { asOf: null, status: 'unavailable' };
  if (ms > now + 60000) return { asOf: new Date(ms).toISOString(), status: 'future' };
  return { asOf: new Date(ms).toISOString(), status: now - ms > staleAfterMs ? 'stale' : 'fresh' };
}
export function normalizeOptionSnapshot(metadata, raw, { now = Date.now(), staleAfterMs = 20 * 60000 } = {}) {
  const issues = [], evidence = {};
  const category = raw?.code === metadata.code && raw?.option_valid === true;
  if (!raw) issues.push('missing-snapshot'); else if (!category) issues.push('option-category-unverified');
  const field = (key, validator = () => true) => {
    if (!category) { evidence[key] = 'category-unavailable'; return null; }
    if (!own(raw, key)) { evidence[key] = 'missing'; return null; }
    const value = number(raw[key]);
    if (value === null || !validator(value)) { evidence[key] = 'invalid'; return null; }
    evidence[key] = value === 0 ? 'reported-zero' : 'reported'; return value;
  };
  const reportedStrike = field('option_strike_price', value => value > 0);
  if (reportedStrike !== null && reportedStrike !== metadata.strike) issues.push('snapshot-strike-mismatch');
  const ivPercent = field('option_implied_volatility', value => value >= 0 && value <= 1000);
  const gamma = field('gamma', value => value >= 0), delta = field('delta', value => Math.abs(value) <= 1.1);
  const openInterest = field('option_open_interest', value => Number.isSafeInteger(value) && value >= 0);
  const optionMultiplier = field('option_contract_multiplier', value => value > 0);
  const bid = field('bid_price', value => value >= 0), ask = field('ask_price', value => value >= 0);
  const quote = sourceTimestamp(raw?.update_time, now, staleAfterMs);
  if (quote.status !== 'fresh') issues.push(`quote-time-${quote.status}`);
  if (ivPercent === 0) issues.push('zero-iv-unusable');
  if (bid !== null && ask !== null && bid > ask) issues.push('crossed-quote');
  const identityValid = category && !issues.includes('snapshot-strike-mismatch');
  const usableForGex = identityValid && gamma !== null && openInterest !== null && quote.status === 'fresh';
  return { ...metadata, optionValid: category, iv: identityValid && ivPercent > 0 ? ivPercent / 100 : null,
    ivPercent: identityValid ? ivPercent : null, gamma: identityValid ? gamma : null, delta: identityValid ? delta : null,
    openInterest: identityValid ? openInterest : null, optionMultiplier: identityValid ? optionMultiplier : null,
    bid: identityValid ? bid : null, ask: identityValid ? ask : null,
    lastPrice: identityValid ? number(raw?.last_price) : null, quoteAsOf: quote.asOf, quoteTimeStatus: quote.status,
    evidence, issues, usableForGex, usableForScenario: false,
    scenarioBlockers: ['exact-option-expiry-required', 'exercise-style-required'],
    oiAsOf: null, greeksAsOf: null, delayStatus: 'unverified' };
}

/** Invalid/duplicate/unexpected rows never silently stand in for missing codes. */
export function reconcileSnapshots(requestedCodes, rows) {
  const expected = new Set(requestedCodes), matched = new Map(), duplicates = new Set(), unexpected = new Set();
  for (const row of rows) {
    if (!expected.has(row?.code)) { if (typeof row?.code === 'string') unexpected.add(row.code); continue; }
    if (matched.has(row.code)) duplicates.add(row.code); else matched.set(row.code, row);
  }
  for (const code of duplicates) matched.delete(code);
  const missingCodes = requestedCodes.filter(code => !matched.has(code));
  return { matched, missingCodes, duplicateCodes: [...duplicates], unexpectedCodes: [...unexpected],
    complete: missingCodes.length === 0 && duplicates.size === 0 && unexpected.size === 0 };
}

export async function fetchOptionChainRange(client, code, start, end) {
  validateFutuSymbol(code); validDate(start); validDate(end);
  const from = Date.parse(start), until = Date.parse(end);
  if (until < from || until - from > 366 * DAY_MS) fail('INVALID_CHAIN_WINDOW', 'Select an expiry range of at most one year.');
  const rows = [], windows = [];
  for (let cursor = from; cursor <= until; cursor += 14 * DAY_MS) {
    const a = new Date(cursor).toISOString().slice(0, 10), b = new Date(Math.min(until, cursor + 13 * DAY_MS)).toISOString().slice(0, 10);
    const batch = await client.optionChain(code, a, b);
    rows.push(...batch); windows.push({ start: a, end: b, returned: batch.length });
  }
  return { rows, windows };
}

/** List-driven multi-expiry metadata pull. Results are suitable for a server-only
 * daily metadata cache. The expiry list's native-futures coverage must be tested;
 * this function never claims coverage beyond that exact underlying's returned list.
 * https://open.futunn.com/zh-cn/api/quote/derivatives/option-expiration
 */
export async function fetchListedOptionChains(client, code, { asOfDate, maxExpiries = 60, maxContracts = 60000 } = {}) {
  validateFutuSymbol(code); validDate(asOfDate);
  if (!Number.isInteger(maxExpiries) || maxExpiries < 1 || maxExpiries > 120
    || !Number.isInteger(maxContracts) || maxContracts < 1 || maxContracts > 100000)
    fail('INVALID_METADATA_BUDGET', 'Metadata limits must be 1–120 expiries and 1–100000 contracts.');
  const entries = await client.optionExpirations(code); let rejectedExpiryRows = 0;
  const dates = [...new Set(entries.flatMap(row => {
    try { const date = validDate(row?.strike_time); return date >= asOfDate ? [date] : []; }
    catch { rejectedExpiryRows++; return []; }
  }))].sort();
  const selected = dates.slice(0, maxExpiries), rows = [], windows = [], fetchedDates = [];
  let contractLimitReached = false;
  for (const expiry of selected) {
    const batch = await client.optionChain(code, expiry, expiry); fetchedDates.push(expiry);
    windows.push({ start: expiry, end: expiry, returned: batch.length });
    if (rows.length + batch.length > maxContracts) {
      rows.push(...batch.slice(0, Math.max(0, maxContracts - rows.length))); contractLimitReached = true; break;
    }
    rows.push(...batch);
  }
  const missingDates = dates.filter(date => !fetchedDates.includes(date));
  return { underlyingCode: code, rows, windows,
    expiryCoverage: { source: 'provider-expiration-list', listedDates: dates, fetchedDates,
      missingDates, rejectedExpiryRows, contractLimitReached,
      completeListedExpiries: dates.length > 0 && missingDates.length === 0 && !contractLimitReached && rejectedExpiryRows === 0,
      allMarketExpiries: false } };
}
function probeCodes(metadata, count, referencePrice) {
  const target = number(referencePrice) ?? [...metadata].sort((a, b) => a.strike - b.strike)[Math.floor(metadata.length / 2)]?.strike;
  return [...metadata].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)
    || Math.abs(a.strike - target) - Math.abs(b.strike - target) || a.optionType.localeCompare(b.optionType)).slice(0, count).map(row => row.code);
}

/** Returns normalized research records, not a signed dealer-position estimate.
 * Metadata first; one small underlying+option probe precedes any full-chain pull.
 * No exact expiry, model exercise style, live entitlement or OI timestamp is invented.
 */
export async function collectFutuMarket(client, { market, underlyingCode, start, end,
  fullChain = true, probeCount = 4, referencePrice, chainData = null, now = Date.now(), staleAfterMs = 20 * 60000 } = {}) {
  marketSymbol(market, underlyingCode); validDate(start); validDate(end);
  if (!Number.isInteger(probeCount) || probeCount < 1 || probeCount > 8) fail('INVALID_PROBE', 'Probe 1–8 option contracts.');
  if (chainData && (chainData.underlyingCode !== underlyingCode || !Array.isArray(chainData.rows)
    || !Array.isArray(chainData.windows) || chainData.rows.length > 100000))
    fail('INVALID_METADATA_CACHE', 'Cached metadata must match the exact underlying and supported bounds.');
  const chain = chainData ?? await fetchOptionChainRange(client, underlyingCode, start, end);
  const metadata = [], seen = new Map(), conflictingCodes = new Set(); let rejectedMetadataCount = 0;
  for (const raw of chain.rows) {
    const row = normalizeOptionMetadata(raw, underlyingCode);
    if (!row || row.expiryDate < start || row.expiryDate > end) { rejectedMetadataCount++; continue; }
    if (seen.has(row.code)) {
      if (JSON.stringify(seen.get(row.code)) !== JSON.stringify(row)) conflictingCodes.add(row.code);
    } else seen.set(row.code, row);
  }
  for (const [code, row] of seen) if (!conflictingCodes.has(code)) metadata.push(row);
  const collectedAt = new Date(now).toISOString();
  const metadataCache = { underlyingCode, retrievedAt: chainData?.retrievedAt ?? collectedAt, start, end,
    rows: metadata.map(row => ({ code: row.code, stock_owner: row.underlyingCode, stock_type: 'DRVT',
      strike_price: row.strike, option_type: row.optionType.toUpperCase(), strike_time: row.expiryDate,
      expiration_cycle: row.expirationCycle })), windows: chain.windows, expiryCoverage: chain.expiryCoverage ?? null };
  const base = { provider: 'Futu OpenAPI', market, underlyingCode, collectedAt, requestedExpiryRange: { start, end },
    sourceStatus: 'snapshot', refreshIntervalSeconds: 300, exactExpiryAvailable: false,
    metadataCache,
    chainCoverage: { returnedRows: chain.rows.length, validContracts: metadata.length, rejectedMetadataCount,
      conflictingCodes: [...conflictingCodes], windows: chain.windows,
      expiryCoverage: chain.expiryCoverage ?? null,
      completeWithinRequestedRange: rejectedMetadataCount === 0 && conflictingCodes.size === 0
        && !chain.expiryCoverage?.contractLimitReached && (!chain.expiryCoverage || chain.expiryCoverage.completeListedExpiries === true) },
    limitations: ['Quote timestamps do not establish Greek or OI calculation times.',
      'OI does not reveal dealer position direction.', 'Coverage is limited to the explicitly requested expiry range.'] };
  if (!metadata.length) return { ...base, status: 'metadata-only', underlying: null, options: [],
    coverage: { expected: 0, requested: 0, returned: 0, missingCodes: [], usableGexContracts: 0, fullChain: false }, errors: [] };
  const probes = probeCodes(metadata, probeCount, referencePrice);
  const requested = [underlyingCode, ...probes], rawRows = [...await client.snapshots([...requested])], errors = [];
  const first = reconcileSnapshots(requested, rawRows);
  const normalizedProbe = metadata.filter(row => probes.includes(row.code)).map(row => normalizeOptionSnapshot(row, first.matched.get(row.code), { now, staleAfterMs }));
  // Endpoint capability and quote freshness are separate. Delayed or timestamp-
  // missing records can establish that the endpoint supplies IV/Greeks/OI; they
  // retain their original quality flags and never become fresh/live by doing so.
  const supportsRequiredFields = normalizedProbe.some(row => row.iv > 0 && row.gamma !== null
    && row.openInterest !== null && row.optionValid && row.quoteTimeStatus !== 'future');
  if (fullChain && supportsRequiredFields) {
    const rest = metadata.map(row => row.code).filter(code => !probes.includes(code));
    for (let i = 0; i < rest.length; i += SNAPSHOT_BATCH_LIMIT) {
      const batch = rest.slice(i, i + SNAPSHOT_BATCH_LIMIT); requested.push(...batch);
      try { rawRows.push(...await client.snapshots(batch)); }
      catch (error) { errors.push(safeFutuError(error)); break; }
    }
  }
  const reconciled = reconcileSnapshots(requested, rawRows);
  const options = metadata.map(row => normalizeOptionSnapshot(row, reconciled.matched.get(row.code), { now, staleAfterMs }));
  const future = reconciled.matched.get(underlyingCode), timestamp = sourceTimestamp(future?.update_time, now, staleAfterMs);
  const underlying = { code: underlyingCode, futuresPrice: future?.future_valid === true ? number(future.last_price) : null,
    quoteAsOf: timestamp.asOf, quoteTimeStatus: timestamp.status, categoryVerified: future?.future_valid === true,
    modelPriceSupported: future?.future_valid === true && number(future.last_price) > 0, delayStatus: 'unverified' };
  const requestedOptions = requested.length - 1, usableGexContracts = options.filter(row => row.usableForGex).length;
  const all = requestedOptions === metadata.length && reconciled.complete && errors.length === 0;
  const full = all && usableGexContracts === metadata.length && base.chainCoverage.completeWithinRequestedRange
    && underlying.categoryVerified && underlying.modelPriceSupported && underlying.quoteTimeStatus === 'fresh';
  return { ...base, status: full ? 'complete-range-snapshot' : supportsRequiredFields ? 'partial-snapshot' : 'probe-fields-unavailable',
    underlying, options, probe: { requested: probes, supportsRequiredFields },
    coverage: { expected: metadata.length, requested: requestedOptions,
      returned: options.filter(row => row.optionValid).length, missingCodes: options.filter(row => !reconciled.matched.has(row.code)).map(row => row.code),
      duplicateCodes: reconciled.duplicateCodes, unexpectedCodes: reconciled.unexpectedCodes,
      usableGexContracts, fullChain: full }, errors };
}
