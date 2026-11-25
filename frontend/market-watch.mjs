import { analyzeHedgingMarket, analyzeHedgingScenario } from './core/hedging-engine.mjs';
import { greeks } from './core/engine.mjs';
import { analyzeSessionImpact } from './core/session-impact.mjs';
import { SESSION_WINDOWS, newYorkBarTime } from './core/session-history.mjs';
import { renderSessionImpact, bindSessionImpact } from './session-impact-view.mjs';
import { renderLevelLens } from './level-lens-view.mjs';
import { createReplayController, replayClock } from './replay-view.mjs';
import { renderIvSurface } from './iv-surface-view.mjs';
import { newYorkToIso } from './core/manual-workflow.mjs';
import { menthorqFeedHealth, menthorqLevelsObservation } from './core/market-reading.mjs';
import { menthorqInstrument, parseMenthorqExport } from './core/menthorq-import.mjs';

const $ = id => document.getElementById(id);
const MARKETS = ['NQ', 'ES', 'CL'];
const REFRESH_INTERVAL_MS = 5 * 60000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, digits = 2) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const clock = value => { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms) + ' NY' : 'Not supplied'; };
const validTime = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const signed = (value, digits = 2) => finite(value) ? `${value > 0 ? '+' : ''}${number(value, digits)}` : 'Unavailable';
const state = { market: 'NQ', data: null, connectionStatus: null, fetching: false, autoChecking: false, clockOffsetMs: 0, refreshing: false, refreshProgress: null, changingContract: false, networkError: null, expiry: 'all', inventory: 'dealerAllShortOI', sort: 'strike', strike: null, series: null, scenarioPrice: null, ivScale: 1, allowApproximation: false, analysis: null, analysisKey: null, modelInput: null, eligibility: null, scenarioKey: null, scenarioResult: null, scenarioTimer: null, clusters: [], ivData: new Map(), ivAttempts: new Map(), ivRefreshing: false, ivError: null, contextEditing: false, contextSaving: false };
const pageNow = () => Date.now() + state.clockOffsetMs;
const sessionState = { histories: new Map(), attempts: new Map(), pendingForce: new Set(), loadingKey: null, errors: new Map(), shockByMarket: { NQ:25, ES:5, CL:.05 }, positionScale:1, impactCoefficient:null, volatilityScale:1, allowUnverifiedContractVolume:false, windowId:null, resultKey:null, result:null, resultError:null };
function currentSessionWindow(now=pageNow()) { const minute=newYorkBarTime(now).minute; return SESSION_WINDOWS.find(row=>minute>=row.startMinute&&minute<row.endMinute)?.id??(minute<570?'opening':'closing'); }
function renderSession(market) {
  renderLens(market);
  const root=$('watch-session-impact'); if(!root)return;
  const key=ivKey(), history=sessionState.histories.get(key), profile=history?.profile??{underlyingCode:market?.underlyingCode,volumeUnit:'unverified',windows:SESSION_WINDOWS.map(row=>({...row,sampleCount:0}))};
  const shockPoints=sessionState.shockByMarket[state.market], resultKey=JSON.stringify([state.analysisKey,state.inventory,shockPoints,sessionState.positionScale,sessionState.impactCoefficient,sessionState.volatilityScale,sessionState.allowUnverifiedContractVolume,profile.asOf,profile.observedBars,history?.status]);
  let error=sessionState.resultError;
  if(resultKey!==sessionState.resultKey){
    sessionState.resultKey=resultKey;sessionState.result=null;sessionState.resultError=null;error=null;
    if(state.modelInput&&state.analysis)try{sessionState.result=analyzeSessionImpact({market:state.modelInput,baseline:state.analysis,inventory:state.inventory,shockPoints,positionScale:sessionState.positionScale,historyProfile:profile,impactCoefficient:sessionState.impactCoefficient,volatilityScale:sessionState.volatilityScale,allowUnverifiedContractVolume:sessionState.allowUnverifiedContractVolume});}catch{error='This move cannot be estimated from the available series inputs.';sessionState.resultError=error;}
  }
  const progress=history?.progress;
  const historicalMessage=sessionState.loadingKey===key?`Collecting ${market?.underlyingCode} history · ${progress?.pages??0} pages · ${number(progress?.observedBars??0,0)} bars`:
    sessionState.errors.get(key)??(profile.status==='unverified-bar-time'?'Historical bar timing is still unverified. Exact window comparisons are held back.':profile.observedBars>0&&profile.volumeUnit!=='contracts'?'Historical price behavior is available; futures volume units are not yet verified.':['partial','history-partial'].includes(history?.status)?'Showing the available completed sessions; the sample count is listed for each window.':null);
  const inventoryLabel={dealerAllShortOI:'Assume dealers short the selected OI',dealerAllLongOI:'Assume dealers long the selected OI',supplied:'Assume calls long / puts short'}[state.inventory];
  renderSessionImpact(root,{analysis:sessionState.result,market:state.market,underlyingCode:market?.underlyingCode,currentPrice:market?.underlyingPrice,shockPoints,selectedWindowId:sessionState.windowId??currentSessionWindow(),positionScale:sessionState.positionScale,impactCoefficient:sessionState.impactCoefficient,volatilityScale:sessionState.volatilityScale,tickSize:market?.tickSize,inventoryLabel,allowUnverifiedContractVolume:sessionState.allowUnverifiedContractVolume,selectedSeriesCount:state.eligibility?.total,calibratedSeriesCount:state.eligibility?.included,canRefreshHistory:state.data?.connection?.connected===true&&!!market?.underlyingCode,loading:sessionState.loadingKey===key,historyStatus:history?.status,historyMessage:historicalMessage,error});
}
async function loadSessionHistory({refresh=false,force=false}={}) {
  const market=currentMarket(),marketName=state.market,underlyingCode=market?.underlyingCode,key=ivKey(marketName,underlyingCode);
  if(force)sessionState.pendingForce.add(key);
  force=force||sessionState.pendingForce.has(key);
  if(!underlyingCode||sessionState.loadingKey||document.hidden)return;
  if(!refresh&&sessionState.histories.has(key))return;
  if(refresh&&!force&&pageNow()-(sessionState.attempts.get(key)??0)<5*60000)return;
  sessionState.loadingKey=key;sessionState.errors.delete(key);renderSession(market);
  try{
    if(!sessionState.histories.has(key)){
      const response=await fetch(`/api/session-history?market=${encodeURIComponent(marketName)}&underlyingCode=${encodeURIComponent(underlyingCode)}`,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('Historical reference is unavailable. Existing readings are retained.');
      const result=await response.json();if(result.underlyingCode!==underlyingCode)throw Error('Historical reference returned another futures month.');sessionState.histories.set(key,result);
    }
    const saved=sessionState.histories.get(key),sameDay=saved?.profile?.asOf&&newYorkBarTime(Date.parse(saved.profile.asOf)).date===newYorkBarTime(pageNow()).date;
    if(!refresh||(sameDay&&saved.progress?.done&&!force))return;
    sessionState.attempts.set(key,pageNow());
    for(let step=0;step<45;step++){
      if(document.hidden||state.market!==marketName||currentMarket()?.underlyingCode!==underlyingCode)break;
      const result=await postAction('/api/session-history-refresh',{market:marketName,underlyingCode,...(step===0&&force?{force:true}:{})});
      if(result.underlyingCode!==underlyingCode)throw Error('Historical reference returned another futures month.');
      sessionState.histories.set(key,result);renderSession(currentMarket());
      if(result.status==='waiting-for-chain-refresh'){sessionState.attempts.set(key,pageNow()-5*60000+30000);break;}
      if(result.status!=='cooldown')sessionState.pendingForce.delete(key);
      if(result.progress?.done||['failed','history-refresh-failed','cooldown','connection-required'].includes(result.status)){
        if(result.errors?.length)sessionState.errors.set(key,result.errors.map(row=>row.message??row.code).filter(Boolean).slice(0,2).join(' · '));break;
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(5000,Math.max(750,result.progress?.retryAfterMs??750))));
    }
  }catch(error){sessionState.errors.set(key,error.name==='AbortError'?'Historical reference request timed out. Existing readings remain visible.':error.message);}
    finally{sessionState.loadingKey=null;if(ivKey()===key){renderSession(currentMarket());}else void loadSessionHistory({refresh:true});}
}
function automaticRefreshDue() {
  if (state.data?.connection?.connected !== true || state.data.connection.reauthorizationRequired === true) return false;
  if(state.data?.collectionWindow?.open===false||state.data?.collector?.status==='running'&&state.data.collector.enabled===true)return false;
  if (state.data.refreshInProgress === true) return true;
  const attempted = Date.parse(state.data.lastAttemptAt ?? '');
  return !Number.isFinite(attempted) || Math.floor(attempted / REFRESH_INTERVAL_MS) < Math.floor(pageNow() / REFRESH_INTERVAL_MS);
}

function metricText(metric, digits = 2) {
  if (!metric || metric.includedRows === 0 || !finite(metric.knownSubtotal)) return 'Unavailable';
  return `${metric.complete ? '' : 'Partial '}${signed(metric.complete ? metric.value : metric.knownSubtotal, digits)}`;
}
function metricCoverage(metric) { return metric ? `${metric.includedRows} / ${metric.expectedRows} series included` : 'Inputs unavailable'; }
function concentrationText(metric) { return metric?.includedRows > 0 && finite(metric.knownSubtotal) ? `${metric.complete ? '' : 'Partial '}${number(metric.complete ? metric.value : metric.knownSubtotal)}` : 'Unavailable'; }
function sumKnown(rows, key) { const known = rows.map(row => row[key]).filter(finite); return { value: known.length ? known.reduce((sum, value) => sum + value, 0) : null, known: known.length, total: rows.length }; }
function ivKey(market = state.market, underlyingCode = state.data?.markets?.[market]?.underlyingCode) { return `${market}|${underlyingCode || ''}`; }
function currentMarket() {
  const market = state.data?.markets?.[state.market] ?? null, update = state.ivData.get(ivKey());
  if (!market || !update || update.underlyingCode !== market.underlyingCode) return market;
  const newer = positive(update.underlyingPrice) && validTime(update.priceTimestamp) && (!validTime(market.priceTimestamp) || Date.parse(update.priceTimestamp) >= Date.parse(market.priceTimestamp));
  const modelTimes = [market.collectedAt, update.lastSuccessAt].filter(validTime).sort((left, right) => Date.parse(right) - Date.parse(left));
  return { ...market, ...(newer ? { underlyingPrice: update.underlyingPrice, priceTimestamp: update.priceTimestamp, quoteAgeSeconds: Math.max(0, (pageNow() - Date.parse(update.priceTimestamp)) / 1000) } : {}), ivRevision: update.lastSuccessAt ?? update.lastAttemptAt, modelAsOf: modelTimes[0] ?? market.collectedAt };
}
function rawContracts(market) {
  const overlays = new Map((state.ivData.get(ivKey(state.market, market?.underlyingCode))?.rows ?? []).map(row => [row.code, row]));
  return Array.isArray(market?.contracts) ? market.contracts.filter(row => row && positive(row.strike)).map(row => {
    const update = overlays.get(row.code);
    if (!update || update.underlyingCode !== row.underlyingCode || !validTime(update.quoteTimestamp) || (validTime(row.quoteTimestamp) && Date.parse(update.quoteTimestamp) < Date.parse(row.quoteTimestamp))) return row;
    const observationKeys = ['iv', 'delta', 'gamma', 'openInterest', 'bid', 'ask', 'quoteTimestamp', 'collectedAt', 'previousIv', 'previousQuoteTimestamp', 'ivChange', 'ivChangePoints', 'ivChangePercent', 'baselineIv', 'baselineQuoteTimestamp', 'baselineChangePoints', 'ivHistory', 'comparisonStatus', 'quoteTimeStatus', 'quoteAgeSeconds', 'greeksTimestamp', 'ivTimestamp', 'lastObservedRevision'];
    const observation = Object.fromEntries(observationKeys.filter(key => Object.prototype.hasOwnProperty.call(update, key)).map(key => [key, update[key]]));
    return { ...row, ...observation };
  }) : [];
}
function contractId(row, index) { return String(row.code || `${row.strike}|${row.expiryTimestamp || row.expiryDate || ''}|${row.optionType || ''}|${index}`); }
export function watchedLevels(context, underlyingCode) {
  if (!context || context.source !== 'MenthorQ' || context.underlyingCode !== underlyingCode || !['available', 'stale'].includes(context.status) || !Array.isArray(context.levels)) return [];
  const unique = new Map();
  for (const level of context.levels) {
    if (!positive(level?.strike) || level.kind === 'reference') continue;
    const existing = unique.get(String(level.strike));
    if (existing) existing.labels = [...new Set([...existing.labels, ...(Array.isArray(level.labels) ? level.labels.filter(label => typeof label === 'string') : [])])];
    else unique.set(String(level.strike), { ...level, labels: Array.isArray(level.labels) ? level.labels.filter(label => typeof label === 'string') : [] });
  }
  return [...unique.values()];
}
function selectedContracts(market) { const strikes = new Set(watchedLevels(market?.watchContext, market?.underlyingCode).map(level => level.strike)); return rawContracts(market).filter(row => strikes.has(row.strike) && (state.expiry === 'all' || (row.expiryDate || row.expiryTimestamp?.slice(0, 10) || 'unknown') === state.expiry)); }
export function reportedRange(rows, field, digits = 4, scale = 1, suffix = '') {
  const values = rows.map(row => row?.[field]).filter(finite).map(value => value * scale);
  if (!values.length) return { text: '—', known: 0, total: rows.length, range: false };
  const low = Math.min(...values), high = Math.max(...values);
  return { text: `${number(low, digits)}${low !== high ? `–${number(high, digits)}` : ''}${suffix}`, known: values.length, total: rows.length, range: low !== high };
}
export function mergeIvObservations(previous, incoming, canonicalRows) {
  const underlyingCode = incoming?.underlyingCode, allowed = new Set(canonicalRows.filter(row => row.underlyingCode === underlyingCode).map(row => row.code));
  const observations = new Map();
  if (previous?.underlyingCode === underlyingCode) for (const row of previous.rows ?? []) {
    if (allowed.has(row.code) && row.underlyingCode === underlyingCode && validTime(row.quoteTimestamp)) observations.set(row.code, row);
  }
  for (const row of incoming.rows ?? []) {
    if (!allowed.has(row.code) || row.underlyingCode !== underlyingCode || !validTime(row.quoteTimestamp)) continue;
    const existing = observations.get(row.code);
    if (!existing || Date.parse(row.quoteTimestamp) > Date.parse(existing.quoteTimestamp)) observations.set(row.code, row);
  }
  const rows = [...observations.values()].sort((left, right) => Date.parse(right.quoteTimestamp) - Date.parse(left.quoteTimestamp)).slice(0, Math.min(4000, allowed.size));
  return { ...incoming, rows, coverage: { ...incoming.coverage, cached: rows.length } };
}
export function buildFocusedClusters(rows, context, underlyingCode) {
  const grouped = new Map();
  rows.forEach((row, index) => { const key = String(row.strike); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push({ ...row, _watchId: contractId(row, index) }); });
  return watchedLevels(context, underlyingCode).map(level => {
    const members = grouped.get(String(level.strike)) ?? [];
    return { key: String(level.strike), strike: level.strike, level, rows: members, expiries: new Set(members.map(row => row.expiryDate || row.expiryTimestamp?.slice(0, 10) || 'unknown')).size, oi: sumKnown(members, 'openInterest') };
  });
}
function calibratedRow(row) { return row.multiplierBasis === 'cme-verified-point-value' && positive(row.multiplier); }
export function preferredSeries(rows) {
  return [...rows].sort((left, right) => Number(calibratedRow(right)) - Number(calibratedRow(left)) || Number(positive(right.iv)) - Number(positive(left.iv)) || String(left.expiryTimestamp || left.expiryDate || '9999').localeCompare(String(right.expiryTimestamp || right.expiryDate || '9999')) || String(left.code || '').localeCompare(String(right.code || '')))[0] ?? null;
}
export function ivBatchMatchesRequest(result, requested) {
  if (!['checked', 'partial'].includes(result?.status) || result.coverage?.requested !== requested.length || !Array.isArray(result.rows)) return false;
  const returnedCodes = new Set(result.rows.map(row => row.code));
  return returnedCodes.size === requested.length && requested.every(code => returnedCodes.has(code));
}
function oneMultiplier(rows) { const values = [...new Set(rows.filter(calibratedRow).map(row => row.multiplier))]; return values.length === 1 ? values[0] : null; }
function buildModelInput(market, rows) {
  return { market: state.market, contract: market.underlyingCode, futuresPrice: market.underlyingPrice,
    currency: market.currency === 'USD' ? 'USD' : null,
    optionMultiplier: oneMultiplier(rows),
    hedgeMultiplier: positive(market.hedgeMultiplier) ? market.hedgeMultiplier : null,
    tickSize: positive(market.tickSize) ? market.tickSize : null,
    rate: finite(market.rate) ? market.rate : 0,
    greeksBasis: market.greeksBasis ?? market.coverage?.greeksBasis ?? 'unknown',
    rows: rows.map((row, index) => ({ id: contractId(row, index), strike: row.strike, underlyingCode: row.underlyingCode, quoteTimestamp: row.quoteTimestamp, expiryDate: row.expiryDate, expiryTimeZone: row.expiryTimeZone ?? 'America/New_York',
      optionType: ['CALL', 'PUT'].includes(row.optionType) ? row.optionType.toLowerCase() : null,
      expiry: validTime(row.expiryTimestamp) ? row.expiryTimestamp : null,
      iv: positive(row.iv) ? row.iv : null, openInterest: finite(row.openInterest) && row.openInterest >= 0 ? row.openInterest : null,
      delta: finite(row.delta) ? row.delta : null, gamma: finite(row.gamma) && row.gamma >= 0 ? row.gamma : null,
      greeksBasis: row.quality?.greeksBasis ?? row.greeksBasis ?? market.greeksBasis ?? market.coverage?.greeksBasis ?? 'unknown',
      exerciseStyle: row.quality?.exerciseStyle ?? row.exerciseStyle ?? null,
      allowEuropeanApproximation: state.allowApproximation,
      signedDealerPosition: finite(row.openInterest) && row.openInterest >= 0 ? (row.optionType === 'CALL' ? row.openInterest : row.optionType === 'PUT' ? -row.openInterest : null) : null,
    })) };
}
function refreshAnalysis(market, rows) {
  const multiplier = oneMultiplier(rows), eligible = rows.filter(row => calibratedRow(row) && row.multiplier === multiplier);
  state.eligibility = { included: eligible.length, total: rows.length, multiplier };
  const key = JSON.stringify([state.market, market?.underlyingCode, market?.collectedAt, market?.priceTimestamp, market?.underlyingPrice, market?.ivRevision, rows.map(row => [row.code, row.iv, row.quoteTimestamp, row.expiryTimestamp, row.exerciseStyle]), state.expiry, state.allowApproximation, multiplier, market?.hedgeMultiplier, market?.rate, market?.currency]);
  if (key === state.analysisKey) return;
  state.analysisKey = key; state.scenarioKey = null; state.scenarioResult = null;
  state.analysis = null; state.modelInput = null;
  if (!positive(market?.underlyingPrice) || !market?.underlyingCode || !validTime(market.priceTimestamp) || !eligible.length) return;
  try { state.modelInput = buildModelInput(market, eligible); state.analysis = analyzeHedgingMarket(state.modelInput, { asOf: validTime(market.modelAsOf) ? market.modelAsOf : validTime(market.collectedAt) ? market.collectedAt : market.priceTimestamp }); }
  catch { state.analysis = null; }
}
function statusMessage(market) {
  if (!market || !positive(market.underlyingPrice)) return 'Underlying quote unavailable';
  if (!validTime(market.priceTimestamp)) return 'Quote time unavailable';
  const sourceStatus = market.sourceStatus ?? market.source?.status ?? market.coverage?.sourceStatus;
  if (sourceStatus === 'delayed') return 'Delayed underlying snapshot';
  if (sourceStatus === 'frozen') return 'Frozen underlying snapshot';
  return Date.now() - Date.parse(market.priceTimestamp) > 20 * 60000 ? 'Stale underlying snapshot' : 'Underlying snapshot';
}
function renderService() {
  const data = state.data, connection = data?.connection ?? state.connectionStatus;
  const connectionKnown = typeof connection?.connected === 'boolean' && connection.configured !== false;
  const checking = !connectionKnown && (state.fetching || (!state.data && !state.networkError));
  const connected = connectionKnown && connection.connected === true && connection.reauthorizationRequired !== true;
  $('watch-connect').hidden = !connectionKnown || connected;
  $('watch-connect').textContent = connection?.reauthorizationRequired ? 'Reconnect Futu' : 'Connect Futu';
  $('watch-refresh').disabled = !connectionKnown || !connected || state.refreshing || state.changingContract;
  $('watch-connection').className = 'status-pill ' + (connected ? 'live' : '');
  $('watch-connection').innerHTML = `<span></span>${!connectionKnown ? checking ? 'Checking connection…' : 'Connection status unavailable' : connected ? 'Futu connected' : connection?.reauthorizationRequired ? 'Authorization expired' : 'Not connected'}`;
  const collector=data?.collector,collectionWindow=data?.collectionWindow;
  const collectorActive=collector?.enabled===true&&collector.status==='running';
  const exposureOnly=collector?.menthorqScope==='exposure-map';
  const exposureEnabled=exposureOnly||collector?.menthorqScope==='levels-and-exposure';
  const selected=currentMarket(),context=selected?.watchContext,matching=context?.underlyingCode===selected?.underlyingCode;
  const mqHealth=menthorqFeedHealth(collector,selected,pageNow());
  const mqText=['manual-import','not-enabled'].includes(collector?.menthorqCode)?'automatic collection paused':collector?.menthorq==='blocked'?'needs attention ('+(collector.menthorqCode??'source unavailable')+')':collector?.menthorq==='partial'?mqHealth.label.replace(/^MenthorQ /,''):collector?.menthorqMarkets?.some(row=>row.delayStatus==='delayed')?'provider delayed':collector?.menthorq??'awaiting check';
  $('watch-service-message').textContent = collector?.enabled===true
    ?`${collectorActive?'Windows collector active':'Windows collector not recently seen'} · five-minute collection slots · ${collectionWindow?.session??(collectionWindow?.reason==='weekend'?'weekend pause':'daily maintenance')}. Futu: ${collector.futu??'awaiting check'} · MenthorQ${exposureOnly?' Exposure':''}: ${mqText}. Last collector check ${clock(collector.lastSeenAt)}. Last complete MenthorQ capture ${clock(collector.menthorqLastCompletedAt)}.${exposureOnly?' Levels use manual import.':''}${collector.menthorqRetryAt?' Next recovery check '+clock(collector.menthorqRetryAt)+'.':''} Runs independently of this page while Windows stays on and signed in.`
    :!connectionKnown ? checking ? 'Checking the saved Futu connection. This does not require a new authorization.' : 'The saved connection status could not be checked. Choose Check saved update to retry.' : `${connected ? 'Updates every 5 minutes while this page is open.' : 'Connect Futu to update every 5 minutes while this page is open.'} Closing the page stops automatic updates; background-tab timers may delay a refresh.`;
  const nextSlot = (Math.floor(pageNow() / REFRESH_INTERVAL_MS) + 1) * REFRESH_INTERVAL_MS;
  $('watch-next').textContent = collectionWindow?.open===false?`Collection paused · ${collectionWindow.reason==='weekend'?'weekend':'17:00–18:00 New York maintenance'}`:collectorActive?`Windows collector · next slot ${clock(new Date(nextSlot).toISOString())}`:!connectionKnown ? checking ? 'Next update · checking connection' : 'Next update · connection status unavailable' : !connected ? 'Next update · connect Futu' : state.refreshing ? 'Collection in progress' : automaticRefreshDue() ? 'Next update · due now' : `Next update · ${clock(new Date(nextSlot).toISOString())}${document.hidden ? ' · background timing may delay' : ''}`;
  $('watch-refresh-times').textContent = `Last attempt ${clock(data?.lastAttemptAt)} · successful ${clock(data?.lastSuccessAt)}`;
  const progress = state.refreshProgress ?? data?.progress;
  $('watch-refresh-progress').hidden = !state.refreshing && !data?.refreshInProgress && !state.refreshProgress;
  if (!$('watch-refresh-progress').hidden) {
    const done = progress?.completed ?? progress?.completedContracts ?? progress?.processed ?? progress?.completedBatches;
    const total = progress?.total ?? progress?.totalContracts ?? progress?.totalBatches;
    $('watch-refresh-progress').textContent = `${state.refreshing || data?.refreshInProgress ? 'Collecting quotes' : 'Refresh paused'}${progress?.market ? ` · ${progress.market}` : ''}${finite(done) && finite(total) ? ` · ${number(done, 0)} / ${number(total, 0)}` : ''}. Completed market snapshots appear as they are ready; the previous snapshot stays visible meanwhile.`;
  }
  const hasMap=matching&&watchedLevels(context,selected?.underlyingCode).length>0;
  const mapState=$('watch-menthorq-state');
  if(mapState){mapState.textContent=mqHealth.label;mapState.className=mqHealth.warning?'lens-amber':'';}
  const mqAlert=$('watch-menthorq-alert');
  if(mqAlert){mqAlert.hidden=!mqHealth.warning;mqAlert.textContent=mqHealth.label+'. '+mqHealth.message;}
  const captureClock=$('watch-update-futu'),quoteClock=$('watch-update-quote'),mapClock=$('watch-update-menthorq');
  const collecting=state.refreshing||data?.refreshInProgress;
  if(captureClock)captureClock.textContent=`Futu · last ${state.market} capture ${clock(selected?.collectedAt)}${collecting?` · updating${progress?.market?' '+progress.market:''}…`:''}`;
  if(quoteClock){
    const age=validTime(selected?.priceTimestamp)?Math.max(0,(pageNow()-Date.parse(selected.priceTimestamp))/60000):null;
    quoteClock.textContent=`${selected?.underlyingCode??state.market} quote ${clock(selected?.priceTimestamp)}${finite(age)?' · '+number(age,1)+' min old':''} · ${selected?.delayStatus==='delayed'?'delayed feed':'delay unverified'}`;
  }
  const levelsCheck=menthorqLevelsObservation(collector,selected)?.observedLevelsAt;
  if(mapClock)mapClock.textContent=hasMap?`MenthorQ Levels · captured ${clock(context.capturedAt)} · provider ${context.sourceDate??'date unverified'}${context.sourceLocalTime?' '+context.sourceLocalTime:''}${validTime(context.asOf)?' · '+clock(context.asOf):' · timezone unverified'} · ${context.delayStatus==='delayed'?'delayed feed':'delay unverified'}${validTime(levelsCheck)?' · checked '+clock(levelsCheck):''}`:'MenthorQ Levels · no matching saved map';
  const exposureClock=$('watch-update-exposure'),exposure=matching?context?.exposure:null;
  if(exposureClock){
    exposureClock.hidden=!exposureEnabled&&exposure?.collection!=='exposure-map';
    exposureClock.textContent=exposure?`MenthorQ Exposure · ${exposure.metric} · ${exposure.rows.length} watched strikes · checked ${clock(exposure.capturedAt)} · ${validTime(exposure.asOf)?'source '+clock(exposure.asOf):'source clock unverified'} · ${exposure.delayStatus==='delayed'?'delayed feed':'delay unverified'}`:'MenthorQ Exposure · awaiting first capture';
  }
  const dexClock=$('watch-update-dex'),netDex=matching?context?.netDex:null;
  if(dexClock){
    dexClock.hidden=!exposureEnabled&&!netDex;
    dexClock.textContent=netDex?`MenthorQ Exposure · Net DEX · ${netDex.rows.length} watched strikes · checked ${clock(netDex.capturedAt)} · ${validTime(netDex.asOf)?'source '+clock(netDex.asOf):'source clock unverified'} · ${netDex.delayStatus==='delayed'?'delayed feed':'delay unverified'}`:'MenthorQ Exposure · Net DEX awaiting first capture';
  }
  const gamma=matching?context?.regime:null,known=gamma?.scope==='all-expiries'&&finite(gamma.netGex);
  const gammaText=$('watch-hero-gamma');
  if(gammaText){gammaText.textContent=known?gamma.netGex>0?'Positive gamma':gamma.netGex<0?'Negative gamma':'Zero net gamma':'Not supplied';gammaText.className=known?(gamma.netGex>0?'positive':gamma.netGex<0?'negative':''):'';}
  const gammaLabel=$('watch-hero-gamma-label');if(gammaLabel)gammaLabel.textContent=state.market+' gamma · all expiries';
  const gammaSource=$('watch-hero-gamma-source');
  if(gammaSource)gammaSource.textContent=known?`${gamma.display||compact(gamma.netGex)} · ${gamma.mode??'saved'} · ${gamma.sourceDate??'provider date unverified'} · ${gamma.asOf?clock(gamma.asOf):'source clock unverified'} · ${gamma.delayStatus==='delayed'?'delayed feed':'delay unverified'}`:'Saved dealer-positioning estimate unavailable';
  for (const market of MARKETS) {
    const item = market === state.market ? currentMarket() : data?.markets?.[market];
    $(`watch-tab-${market}`).textContent = positive(item?.underlyingPrice) ? number(item.underlyingPrice, market === 'CL' ? 2 : 2) : 'Unavailable';
  }
}
function renderFilters(market) {
  const available = Array.isArray(market?.availableContracts) ? market.availableContracts.filter(item => typeof item?.code === 'string' && item.code) : [];
  const codes = new Set(available.map(item => item.code));
  if (market?.underlyingCode && !codes.has(market.underlyingCode)) available.unshift({ code: market.underlyingCode });
  $('watch-month').innerHTML = available.length ? available.map(item => `<option value="${esc(item.code)}"${item.expired === true ? ' disabled' : ''}>${esc(item.code)}${item.expired === true ? ' · expired' : ''}${finite(item.volume) ? ` · volume ${number(item.volume, 0)}` : ''}</option>`).join('') : '<option value="">No contract list received</option>';
  $('watch-month').value = market?.underlyingCode ?? '';
  $('watch-month').disabled = !available.some(item => item.expired !== true) || state.changingContract || state.refreshing;
  const levels = watchedLevels(market?.watchContext, market?.underlyingCode), strikes = new Set(levels.map(level => level.strike));
  const expiries = [...new Set(rawContracts(market).filter(row => strikes.has(row.strike)).map(row => row.expiryDate || row.expiryTimestamp?.slice(0, 10) || 'unknown'))].sort();
  if (state.expiry !== 'all' && !expiries.includes(state.expiry)) state.expiry = 'all';
  $('watch-expiry').innerHTML = '<option value="all">All watched expirations</option>' + expiries.map(expiry => `<option value="${esc(expiry)}">${esc(expiry === 'unknown' ? 'Expiry unavailable' : expiry)}</option>`).join('');
  $('watch-expiry').value = state.expiry;
  $('watch-expiry-tabs').innerHTML = [['all', 'All expiries'], ...expiries.map(expiry => [expiry, expiry === 'unknown' ? 'Unknown expiry' : expiry.slice(5)])].map(([value, label]) => `<button role="tab" aria-selected="${value === state.expiry}" tabindex="${value === state.expiry ? 0 : -1}" data-watch-expiry="${esc(value)}">${esc(label)}</button>`).join('');
}
function compact(value) { if (!finite(value)) return '—'; const abs = Math.abs(value), divisor = abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1; return `${value < 0 ? '−' : value > 0 ? '+' : ''}${number(abs / divisor, 2)}${divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : divisor === 1e3 ? 'K' : ''}`; }
function menthorqImportTargets(allMatching) {
  const targets = [];
  for (const market of allMatching ? MARKETS : [state.market]) {
    const underlyingCode = state.data?.markets?.[market]?.underlyingCode;
    if (!underlyingCode) continue;
    try {
      targets.push({ market, underlyingCode, instrument: menthorqInstrument(market, underlyingCode) });
    } catch {
      // The provider export requires a dated futures contract.
    }
  }
  return targets;
}
function renderMenthorqImportSymbols() {
  const symbols = menthorqImportTargets($('watch-context-bulk').checked).map(target => target.instrument);
  $('watch-context-symbols').textContent = symbols.length ? `Tickers for the selected contracts: ${symbols.join(', ')}` : 'Select a dated futures contract to see its MenthorQ ticker.';
}
function renderContext(market) {
  const context = market?.watchContext, levels = watchedLevels(context, market?.underlyingCode), usable = levels.length > 0;
  const mismatch = context?.underlyingCode && context.underlyingCode !== market?.underlyingCode;
  $('watch-context-status').textContent = mismatch ? 'Contract mismatch' : usable ? !validTime(context.asOf) ? 'Source clock unverified' : context.status === 'stale' ? 'Older map' : 'Map saved' : 'Map needed';
  $('watch-context-status').className = 'status-pill ' + (usable && context.status !== 'stale' ? 'live' : 'stale');
  $('watch-context-title').textContent = usable ? `${levels.length} MenthorQ levels · ${context.sourceInstrument || context.underlyingCode}` : 'Add the MenthorQ map to choose your strikes';
  const sameDay = usable ? context.exposure0dte : null;
  $('watch-0dte-submit').disabled = !usable || state.contextSaving;
  $('watch-0dte-status').textContent = !usable ? 'Save watched levels for this futures contract first.'
    : sameDay?.rows?.length ? `${context.sourceInstrument} · ${sameDay.rows.length} strikes saved for expiry ${sameDay.expiryDate} · checked ${clock(sameDay.capturedAt)}`
    : `${context.sourceInstrument} · No 0DTE values saved`;
  $('watch-context-copy').hidden = usable;
  $('watch-context-copy').textContent = usable ? '' : mismatch ? `Import the MenthorQ map for ${market.underlyingCode}. The saved map belongs to ${context.underlyingCode}.` : 'Import a MenthorQ map for the selected futures contract to choose your watched strikes.';
  $('watch-context-editor').hidden = !state.contextEditing;
  $('watch-edit-context').textContent = state.contextEditing ? 'Close map editor' : usable ? 'Update MenthorQ map' : 'Import MenthorQ map';
  if (state.contextEditing) renderMenthorqImportSymbols();
  const update = state.ivData.get(ivKey());
  $('watch-iv-status').textContent = state.ivRefreshing ? 'Checking watched IV…' : state.ivError || (update ? `Watched IV · checked ${clock(update.lastSuccessAt)} · ${update.coverage?.returned ?? update.rows?.length ?? 0} / ${update.coverage?.requested ?? '—'} returned. Quote time is not an IV calculation timestamp.` : 'Watched IV checks every 60 seconds while this page is visible. First distinct quote establishes the change baseline.');
  $('watch-refresh-iv').disabled = !usable || !selectedContracts(market).length || state.ivRefreshing || state.data?.connection?.connected !== true;
}
function renderAssumption() {
  const captions = { dealerAllShortOI: 'This scenario assumes dealers are short every reported open-interest contract.', dealerAllLongOI: 'This scenario assumes dealers are long every reported open-interest contract.', supplied: 'Heuristic only: every call is assigned long OI and every put short OI. This sign rule is not observed ownership.' };
  $('watch-assumption').innerHTML = `<strong>Hypothetical inventory.</strong> ${esc(captions[state.inventory])} OI does not establish actual dealer positions or trades.`;
}
function renderOverview(market, rows) {
  const result = state.analysis, hedge = result?.totals.inventories[state.inventory]?.hedgeContracts;
  const gamma = result?.totals.concentration.gammaCurrencyPerPointSquared;
  const modeled = result?.rows.filter(row => row.current.deltaSource === 'modeled').length ?? 0;
  const reported = result?.rows.filter(row => row.current.deltaSource === 'reported').length ?? 0;
  $('watch-price').textContent = positive(market?.underlyingPrice) ? number(market.underlyingPrice, 2) : 'Unavailable';
  $('watch-underlying').textContent = market?.underlyingCode || 'Exact underlying not received';
  $('watch-hedge').textContent = metricText(hedge);
  const subset = state.eligibility?.included < rows.length;
  $('watch-hedge-label').textContent = modeled && !reported ? `MODELED HEDGE · ${subset ? 'VERIFIED SUBSET' : 'ASSUMPTION'}` : reported && !modeled ? 'REPORTED DELTA · ASSUMPTION' : 'DELTA HEDGE · ASSUMPTION';
  $('watch-hedge-caption').textContent = `${state.eligibility?.included ?? 0} / ${rows.length} point-value-verified series · ${modeled} modeled / ${reported} reported · + long / − short futures`;
  $('watch-gamma').textContent = concentrationText(gamma);
  $('watch-gamma-caption').textContent = `${metricCoverage(gamma)} in verified subset · ${result?.currency || 'currency unverified'} / point²`;
  $('watch-coverage').textContent = `${result?.totals.modeledRows ?? 0} / ${rows.length}`;
  $('watch-coverage-caption').textContent = 'Watched series with complete model inputs';
  const coverage = [ ['IV', rows.filter(row => positive(row.iv)).length], ['Delta', rows.filter(row => finite(row.delta)).length], ['Gamma', rows.filter(row => finite(row.gamma)).length], ['OI', rows.filter(row => finite(row.openInterest)).length], ['Exact expiry time', rows.filter(row => validTime(row.expiryTimestamp)).length] ];
  $('watch-coverage-details').innerHTML = coverage.map(([label, count]) => `<span><b>${count} / ${rows.length}</b> ${label}</span>`).join('');
  const quoteAge = finite(market?.quoteAgeSeconds) && market.quoteAgeSeconds >= 0 ? market.quoteAgeSeconds : validTime(market?.priceTimestamp) ? Math.max(0, (Date.now() - Date.parse(market.priceTimestamp)) / 1000) : null;
  const delayLabel = market?.delayStatus === 'delayed' ? 'source classified as delayed' : 'source delay unverified';
  $('watch-source').textContent = `${statusMessage(market)} · quote age ${quoteAge === null ? 'unavailable' : number(quoteAge / 60, 1) + ' min'} · ${delayLabel} · ${clock(market?.priceTimestamp)}`;
  $('watch-footer-status').textContent = rows.length ? 'Snapshot-based scenarios. Actual dealer inventory is unknown.' : 'No quotes or Greek values are generated when coverage is missing.';
}
function buildClusters(rows) {
  const market = currentMarket();
  const resultGroups = new Map((state.analysis?.strikeGroups ?? []).map(group => [group.key, group]));
  const clusters = buildFocusedClusters(rows, market?.watchContext, market?.underlyingCode).map(cluster => ({ ...cluster, result: resultGroups.get(cluster.key) ?? null }));
  const hasGamma = clusters.some(cluster => cluster.result?.concentration.gammaCurrencyPerPointSquared?.includedRows > 0);
  const score = cluster => state.sort === 'strike' ? -cluster.strike : state.sort === 'gex' ? finite(cluster.level.gex) ? Math.abs(cluster.level.gex) : -Infinity : state.sort === 'distance' ? positive(currentMarket()?.underlyingPrice) ? -Math.abs(currentMarket().underlyingPrice - cluster.strike) : 0 : state.sort === 'oi' || !hasGamma ? cluster.oi.value ?? -1 : cluster.result?.concentration.gammaCurrencyPerPointSquared?.includedRows > 0 ? cluster.result.concentration.gammaCurrencyPerPointSquared.knownSubtotal : -Infinity;
  clusters.sort((left, right) => score(right) - score(left) || left.strike - right.strike);
  state.clusters = clusters;
  if (!clusters.some(cluster => cluster.key === state.strike)) {
    const closest = positive(market?.underlyingPrice) ? clusters.reduce((nearest, cluster) => !nearest || Math.abs(cluster.strike - market.underlyingPrice) < Math.abs(nearest.strike - market.underlyingPrice) ? cluster : nearest, null) : clusters[0];
    state.strike = closest?.key ?? null; state.series = null;
  }
}
function renderClusters(market) {
  const clusters = state.clusters, hasRows = clusters.length > 0;
  $('watch-empty').hidden = hasRows; $('watch-table-wrap').hidden = !hasRows;
  $('watch-cluster-count').textContent = `${clusters.length} watched levels`;
  $('watch-rank-note').textContent = hasRows ? `${clusters.length} MenthorQ levels only · ${state.expiry === 'all' ? 'IV / Delta / Gamma show ranges across received expiries' : 'reported values for ' + state.expiry} · OI is summed when several series match` : 'No matching MenthorQ map. No strike ranking has been invented from the Futu chain.';
  $('watch-chain-reading').textContent = state.expiry === 'all' ? 'All expiries: IV / Δ / Γ are reported min–max ranges, not combined Greeks. Select a date to narrow the chain.' : `Expiry ${state.expiry}: individual values when one series matches; ranges when multiple styles or series match. Select a strike for exact codes.`;
  const rangeValue = range => {
    if (!range.range) return esc(range.text);
    const [lower, upper] = range.text.split('–');
    return `<span class="chain-value-range"><span>${esc(lower)}–</span><span>${esc(upper)}</span></span>`;
  };
  const sideCells = (rows, side) => {
    const iv = reportedRange(rows, 'iv', 2, 100, '%'), delta = reportedRange(rows, 'delta', 4), gamma = reportedRange(rows, 'gamma', 6), oi = sumKnown(rows, 'openInterest');
    const changeRows = rows.filter(row => finite(row.ivChangePoints) && validTime(row.previousQuoteTimestamp) && validTime(row.quoteTimestamp) && Date.parse(row.quoteTimestamp) > Date.parse(row.previousQuoteTimestamp));
    const change = reportedRange(changeRows, 'ivChangePoints', 2, 1, ' pp');
    const ivCell = `<td class="chain-iv">${rangeValue(iv)}<small>${iv.known} / ${iv.total} IV known</small>${change.known ? `<span class="iv-change ${changeRows.every(row => row.ivChangePoints >= 0) ? 'up' : changeRows.every(row => row.ivChangePoints <= 0) ? 'down' : ''}">${esc(change.text)} vs prior quote</span>` : '<small>Change baseline pending</small>'}</td>`;
    const deltaCell = `<td>${rangeValue(delta)}<small>${delta.known} / ${delta.total} Δ known</small></td>`, gammaCell = `<td>${rangeValue(gamma)}<small>${gamma.known} / ${gamma.total} Γ known</small></td>`, oiCell = `<td>${oi.value === null ? '—' : number(oi.value, 0)}<small>${oi.known} / ${oi.total} OI known</small></td>`;
    return side === 'CALL' ? oiCell + gammaCell + deltaCell + ivCell : ivCell + deltaCell + gammaCell + oiCell;
  };
  $('watch-cluster-body').innerHTML = clusters.map(cluster => {
    const distance = positive(market?.underlyingPrice) ? market.underlyingPrice - cluster.strike : null;
    const calls = cluster.rows.filter(row => row.optionType === 'CALL'), puts = cluster.rows.filter(row => row.optionType === 'PUT');
    const tags = cluster.level.labels.map(label => `<span class="level-tag">${esc(label)}</span>`).join('');
    const gex = finite(cluster.level.gex) ? `<small class="source-gex ${cluster.level.gex < 0 ? 'negative' : 'positive'}">MenthorQ GEX ${compact(cluster.level.gex)}</small>` : '<small>MenthorQ GEX value not supplied</small>';
    return `<tr data-watch-strike="${esc(cluster.key)}" class="${cluster.key === state.strike ? 'selected' : ''}">${sideCells(calls, 'CALL')}<th scope="row" class="chain-strike"><button class="watch-strike-button" aria-label="Inspect strike ${esc(cluster.strike)}" aria-pressed="${cluster.key === state.strike}" data-watch-strike="${esc(cluster.key)}">${number(cluster.strike)}</button><div class="level-tags">${tags}</div>${gex}<small>${finite(distance) ? signed(distance) + ' pts · price ' + (distance > 0 ? 'above' : distance < 0 ? 'below' : 'at strike') : 'Distance unavailable'}</small><small>${cluster.rows.length ? `${cluster.rows.length} series · ${cluster.expiries} expiries` : 'No exact Futu strike match'}</small></th>${sideCells(puts, 'PUT')}</tr>`;
  }).join('');
}
function reasonText(reason) {
  return ({ 'exact-expiry-time-unavailable': 'No verified expiry clock is available for this contract family. Its reported IV and Greeks remain readable; time-based fade calculations are withheld.', 'exercise-style-unavailable': 'Exercise style is unverified for this series.', 'positive-iv-unavailable': 'This series has no valid IV.', 'american-exercise-needs-explicit-approximation': 'This is an American-style contract. Enable the clearly labeled European approximation below to view a conditional fade model.', 'expired': 'This series had expired at the snapshot time.', 'invalid-expiry-time': 'The exact expiry timestamp is invalid.' })[reason] || 'Complete, verified price, IV, expiry and contract inputs are needed.';
}
function currentCluster() { return state.clusters.find(cluster => cluster.key === state.strike); }
function renderHeatmap(market, strike) {
  const heatmap = market?.watchContext?.heatmap, metrics = Array.isArray(heatmap?.metrics) ? heatmap.metrics : [], names = ['Net GEX', 'Net DEX', 'OI', 'IV x OI'];
  const cells = names.map(name => ({ name, cells: metrics.find(metric => metric.name === name)?.rows?.find(row => row.strike === strike)?.cells ?? [] }));
  const expiries = [...new Set(cells.flatMap(metric => metric.cells.map(cell => cell.expiry)))].filter(expiry => state.expiry === 'all' || expiry === state.expiry).sort();
  $('watch-heatmap').innerHTML = `<div class="watch-heatmap-heading"><h3>MenthorQ heatmap</h3><span>${heatmap ? `${esc(heatmap.mode || 'Mode unknown')} · ${esc(heatmap.delayStatus || 'delay unknown')}` : 'Not captured'}</span></div>${heatmap ? `<p>Captured ${esc(clock(heatmap.capturedAt))} · ${validTime(heatmap.asOf) ? 'source as of ' + esc(clock(heatmap.asOf)) : 'source clock not supplied'}. Provider values below are separate from Futu readings.</p>` : '<p>Heatmap exposure has not been captured for this map. Missing values remain unavailable.</p>'}${expiries.length ? `<div class="watch-heatmap-scroll"><table><caption class="sr-only">MenthorQ captured exposure cells for strike ${esc(strike)}</caption><thead><tr><th scope="col">EXPIRY</th><th scope="col">NET GEX</th><th scope="col">NET DEX</th><th scope="col">OI</th><th scope="col">IV × OI</th></tr></thead><tbody>${expiries.map(expiry => `<tr><th scope="row">${esc(expiry)}</th>${cells.map(metric => { const cell = metric.cells.find(item => item.expiry === expiry); return `<td>${cell && typeof cell.display === 'string' && cell.display ? esc(cell.display) : '—'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>` : '<p>No captured heatmap cells match this strike and expiry filter.</p>'}<small>IV × OI is the provider IV-times-OI metric, not the contract’s IV. Captured viewport coverage may be partial; — means unavailable.</small>${Array.isArray(heatmap?.notes) ? `<small>${esc(heatmap.notes.join(' · '))}</small>` : ''}`;
}
function renderInspector(market) {
  const cluster = currentCluster(), hasSeries = !!cluster?.rows.length;
  $('watch-detail-empty').hidden = hasSeries; $('watch-detail').hidden = !hasSeries;
  $('watch-detail-title').textContent = cluster ? `Strike ${number(cluster.strike)}` : 'Choose a strike';
  $('watch-detail-caption').textContent = cluster ? `${cluster.level.labels.join(' · ') || 'MenthorQ watched level'} · ${cluster.rows.length} series across ${cluster.expiries} expirations` : 'Inspect each series before modeling a price move.';
  $('watch-detail-empty').innerHTML = cluster ? `<p>No exact Futu contract matches this level in the selected expiry. The MenthorQ level remains visible. Choose another expiry or verify the source contract; nearby strikes are not substituted.</p>` : '<p>Choose a MenthorQ level to inspect exact contract inputs, sensitivity zones and conditional hedges.</p>';
  $('watch-heatmap').hidden = !cluster;
  if (cluster) renderHeatmap(market, cluster.strike);
  if (!hasSeries) return;
  if (!cluster.rows.some(row => row._watchId === state.series)) state.series = preferredSeries(cluster.rows)?._watchId ?? null;
  $('watch-series').innerHTML = cluster.rows.map(row => `<option value="${esc(row._watchId)}">${esc(row.optionType || '?')} · ${esc(row.expiryDate || row.expiryTimestamp?.slice(0, 10) || 'Expiry unknown')} · ${esc(row.code || 'Code unavailable')}</option>`).join('');
  $('watch-series').value = state.series;
  const raw = cluster.rows.find(row => row._watchId === state.series), row = state.analysis?.rows.find(item => item.id === state.series);
  const ivChange = finite(raw.ivChangePoints) && validTime(raw.previousQuoteTimestamp) && validTime(raw.quoteTimestamp) && Date.parse(raw.quoteTimestamp) > Date.parse(raw.previousQuoteTimestamp) ? `${signed(raw.ivChangePoints)} percentage points vs ${clock(raw.previousQuoteTimestamp)}` : 'First distinct quote needed for IV change';
  const history = Array.isArray(raw.ivHistory) ? raw.ivHistory.slice(-8) : [];
  $('watch-series-reading').innerHTML = `<strong>${esc(raw.code || 'Contract code unavailable')}</strong><span>Reported IV ${positive(raw.iv) ? number(raw.iv * 100) + '%' : 'unavailable'} · OI ${finite(raw.openInterest) ? number(raw.openInterest, 0) : 'unavailable'}</span><span>IV change · ${esc(ivChange)}</span>${finite(raw.baselineChangePoints) ? `<span>Since tracking baseline · ${signed(raw.baselineChangePoints)} percentage points</span>` : ''}<span>Contract quote · ${esc(clock(raw.quoteTimestamp))}</span><span>Exact expiry · ${esc(clock(raw.expiryTimestamp))} · ${esc(raw.exerciseStyle || 'style unverified')}${raw.expiryClockBasis?' · published CL clock':''}</span>${history.length > 1 ? `<details class="iv-history"><summary>${history.length} distinct IV observations</summary><ol>${history.map(point => `<li>${esc(clock(point.quoteTimestamp))}<b>${positive(point.iv) ? number(point.iv * 100) + '%' : '—'}</b></li>`).join('')}</ol></details>` : ''}`;
  const profile = row?.model.profile;
  $('watch-model-status').className = 'watch-model-status ' + (profile ? 'available' : '');
  $('watch-model-status').textContent = profile ? `${row.model.greeks.model.label} · ${number(row.model.time.minutes, 0)} minutes remaining at collection time ${clock(market.modelAsOf ?? market.collectedAt ?? market.priceTimestamp)}. Underlying, IV and Greek quote times can differ.` : !calibratedRow(raw) ? 'The contract point value is unverified. Reported readings remain visible; this series is excluded from calibrated hedge totals.' : reasonText(row?.model.reason);
  const half = profile?.levels.find(level => level.fraction === 0.5);
  $('watch-zone-summary').innerHTML = profile ? `<strong>${number(profile.ratioToOwnPeak * 100, 1)}% of this series’ modeled Gamma peak</strong><span>${profile.sensitivityIncreasesToward === 'at-peak' ? 'At the modeled peak.' : `Sensitivity strengthens toward ${profile.sensitivityIncreasesToward === 'higher-price' ? 'higher' : 'lower'} prices near ${number(profile.peakPrice)}.`}</span>${half ? `<span>Stronger-sensitivity band (at least 50% of peak): ${number(half.lowerPrice)}–${number(half.upperPrice)}. This threshold is descriptive, not a hedge trigger.</span>` : ''}` : '<strong>Sensitivity zones unavailable</strong><span>No expiry time or exercise style is inferred from the strike or expiry date.</span>';
  $('watch-profile').innerHTML = profile ? renderProfile(market, raw, row) : '<p>Save an exact series reading in the morning-plan workspace if the feed does not provide enough inputs.</p>';
  $('watch-fade-grid').innerHTML = profile ? profile.levels.map(level => `<div><strong>${number(level.fraction * 100, 0)}% remains</strong><span>↓ ${number(level.lowerPrice)}</span><span>↑ ${number(level.upperPrice)}</span></div>`).join('') : [50, 25, 10].map(percent => `<div><strong>${percent}% remains</strong><span>—</span><span>Inputs needed</span></div>`).join('');
  $('watch-series-body').innerHTML = cluster.rows.map(item => `<tr class="${item._watchId === state.series ? 'selected' : ''}"><td><button data-watch-series="${esc(item._watchId)}">${esc(item.optionType || '?')} · ${esc(item.expiryDate || 'Date unavailable')}</button><small>${esc(item.code || 'Code unavailable')}</small><small>Reported · ${esc(clock(item.quoteTimestamp))}</small></td><td>${positive(item.iv) ? number(item.iv * 100) + '%' : '—'}<small>${finite(item.ivChangePoints) ? signed(item.ivChangePoints) + ' pp' : 'Baseline pending'}</small></td><td>${finite(item.delta) ? number(item.delta, 4) : '—'}</td><td>${finite(item.gamma) ? number(item.gamma, 6) : '—'}</td><td>${finite(item.openInterest) ? number(item.openInterest, 0) : '—'}</td></tr>`).join('');
  $('watch-assumption-details').textContent = `Reported Greeks above are preserved as provider observations. Their price basis is ${row?.observed?.greeksBasis ?? raw.quality?.greeksBasis ?? raw.greeksBasis ?? 'unverified'}. The provider’s Greek pricing model and calculation timestamp are not supplied. Exposure figures use only a verified futures-price basis or the explicitly labeled model. No actual dealer ownership is observed.`;
  $('watch-scenario-price').step = String(positive(market.tickSize) ? market.tickSize : state.market === 'CL' ? 0.01 : 0.25);
  if (state.scenarioPrice === null && positive(market.underlyingPrice)) state.scenarioPrice = market.underlyingPrice;
  $('watch-scenario-price').value = state.scenarioPrice ?? '';
  renderScenario();
}
function renderProfile(market, raw, row) {
  const profile = row.model.profile, outer = profile.levels.at(-1), F = market.underlyingPrice;
  let low = Math.min(outer.lowerPrice, F), high = Math.max(outer.upperPrice, F); const padding = (high - low) * 0.08; low = Math.max(0.000001, low - padding); high += padding;
  const W = 340, H = 142, L = 12, R = 12, T = 10, B = 25, plotW = W - L - R, plotH = H - T - B;
  const x = value => L + (value - low) / (high - low) * plotW, y = gamma => T + plotH * (1 - Math.min(1, gamma / profile.peakGamma));
  const args = { strike: raw.strike, iv: raw.iv, timeYears: row.model.time.years, rate: finite(market.rate) ? market.rate : 0, optionType: raw.optionType.toLowerCase(), exerciseStyle: row.exerciseStyle, allowEuropeanApproximation: state.allowApproximation };
  const points = Array.from({ length: 91 }, (_, index) => { const price = low + (high - low) * index / 90; return `${index ? 'L' : 'M'}${x(price).toFixed(2)},${y(greeks({ ...args, futuresPrice: price }).gamma).toFixed(2)}`; }).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><line class="chart-grid" x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}"/><line class="chart-grid" x1="${L}" x2="${W - R}" y1="${T + plotH / 2}" y2="${T + plotH / 2}"/><line class="chart-strike" x1="${x(raw.strike)}" x2="${x(raw.strike)}" y1="${T}" y2="${T + plotH}"/><path class="chart-line" d="${points}"/><circle class="chart-current-dot" cx="${x(F)}" cy="${y(row.model.greeks.gamma)}" r="4"/><text class="chart-label" x="${L}" y="${H - 5}">${esc(number(low))}</text><text class="chart-label" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(number(high))}</text></svg>`;
}
function renderScenario() {
  const market = currentMarket(), selected = currentCluster()?.rows.find(row => row._watchId === state.series);
  $('watch-iv-label').textContent = `${number(state.ivScale * 100, 0)}% of current IV`;
  $('watch-iv-example').textContent = positive(selected?.iv) ? `Selected series IV: ${number(selected.iv * 100)}% → ${number(selected.iv * state.ivScale * 100)}%. Time and assumed positions stay fixed.` : 'A 110% setting takes 20% IV to 22% IV. Time and assumed positions stay fixed.';
  if (!state.analysis || !state.modelInput || !positive(state.scenarioPrice)) { $('watch-scenario-result').textContent = 'A valid futures price and complete series inputs are needed for a conditional hedge scenario.'; return; }
  try {
    const scenarioKey = JSON.stringify([state.analysisKey, state.scenarioPrice, state.ivScale]);
    if (scenarioKey !== state.scenarioKey) {
      state.scenarioResult = analyzeHedgingScenario(state.modelInput, state.analysis, { scenario: { id: 'user', priceByContract: { [state.modelInput.contract]: state.scenarioPrice }, ivScale: state.ivScale } });
      state.scenarioKey = scenarioKey;
    }
    const scenario = state.scenarioResult, metric = scenario.modeledHedgeChangeContracts[state.inventory];
    const series = scenario.rows.find(row => row.id === state.series), modeled = series?.model.greeks;
    const scenarioProfile = series?.model.profile, scenarioBand = scenarioProfile?.levels.find(level => level.fraction === 0.5);
    const scenarioZones = scenarioProfile ? `<span>Scenario Gamma: ${number(scenarioProfile.ratioToOwnPeak * 100, 1)}% of this series’ peak at ${number(state.ivScale * 100, 0)}% of snapshot IV.</span>${scenarioBand ? `<span>Scenario 50%-of-peak band: ${number(scenarioBand.lowerPrice)}–${number(scenarioBand.upperPrice)}.</span>` : ''}<small>The curve above stays at snapshot price, IV and time. This scenario band uses the IV slider; time and assumed inventory stay fixed.</small>` : '';
    $('watch-scenario-result').innerHTML = `<strong>${metricText(metric)} <small>equivalent futures</small></strong><span>Verified subset: ${state.eligibility?.included ?? 0} of ${state.eligibility?.total ?? 0} selected series, across the expiration filter · ${metricCoverage(metric)}.</span>${modeled ? `<span>Selected series: Delta ${number(modeled.delta, 4)} · Gamma ${number(modeled.gamma, 6)}.</span>${scenarioZones}` : '<span>Selected series has incomplete or unverified model inputs.</span>'}<small>Positive = buying / negative = selling in this hypothetical scenario. Compared with the snapshot model, not an executed hedge.</small>`;
  } catch { $('watch-scenario-result').textContent = 'This combination cannot be modeled with the available inputs.'; }
}
function scheduleScenario() {
  clearTimeout(state.scenarioTimer);
  $('watch-iv-label').textContent = `${number(state.ivScale * 100, 0)}% of current IV`;
  $('watch-scenario-result').textContent = 'Updating the conditional scenario…';
  state.scenarioTimer = setTimeout(renderScenario, 220);
}
function render() {
  renderService(); renderAssumption();
  document.querySelectorAll('[data-watch-market]').forEach(button => { const active = button.dataset.watchMarket === state.market; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  const market = currentMarket(); renderFilters(market); renderContext(market);
  const rows = selectedContracts(market); refreshAnalysis(market, rows); renderOverview(market, rows); buildClusters(rows); renderSession(market); renderClusters(market); renderInspector(market);
  const errors = Array.isArray(market?.errors) ? market.errors.map(error => typeof error === 'string' ? error : error?.message || error?.code || 'Market coverage unavailable').filter(Boolean) : [];
  const message = errors.length ? errors.slice(0, 3).join(' · ') : state.networkError;
  $('watch-error').hidden = !message; $('watch-error').textContent = message || '';
}
let replayController=null,replaySnapshot=null,replayContractKey=null,replayAnalysisCache=null;
function renderLens(market) {
  const replayRoot=$('watch-replay'),contractKey=state.market+'|'+market?.underlyingCode;
  if(replayRoot){
    if(!replayController)replayController=createReplayController(replayRoot,{onChange:snapshot=>{replaySnapshot=snapshot;replayAnalysisCache=null;renderLens(currentMarket());}});
    if(replayContractKey!==contractKey){replayContractKey=contractKey;replaySnapshot=null;replayAnalysisCache=null;}
    replayController.update({market:state.market,underlyingCode:market?.underlyingCode,sourceDate:market?.watchContext?.sourceDate});
  }
  if(replaySnapshot){
    const saved=replaySnapshot,at=saved.replay?.capturedAt??saved.context?.capturedAt;
    const historical=saved.market??{underlyingCode:saved.context?.underlyingCode,underlyingPrice:null,contracts:[],watchContext:{...saved.context,status:'stale'},collectedAt:at,modelAsOf:at};
    const allRows=historical.contracts??[],strikes=new Set(watchedLevels(historical.watchContext,historical.underlyingCode).map(l=>l.strike));
    const rows=allRows.filter(row=>strikes.has(row.strike)&&(state.expiry==='all'||(row.expiryDate||row.expiryTimestamp?.slice(0,10))===state.expiry));
    const key=[saved.replay?.selectedId,at,state.expiry,state.allowApproximation].join('|');
    if(replayAnalysisCache?.key!==key){
      let input=null,analysis=null;
      const multiplier=oneMultiplier(rows),eligible=rows.filter(row=>calibratedRow(row)&&row.multiplier===multiplier);
      if(positive(historical.underlyingPrice)&&eligible.length&&validTime(historical.priceTimestamp))try{input=buildModelInput(historical,eligible);analysis=analyzeHedgingMarket(input,{asOf:historical.modelAsOf??at});}catch{input=null;analysis=null;}
      replayAnalysisCache={key,input,analysis,clusters:buildFocusedClusters(rows,historical.watchContext,historical.underlyingCode)};
    }
    const cached=replayAnalysisCache;
    renderLevelLens($('watch-level-lens'),{clusters:cached.clusters,analysis:cached.analysis,input:cached.input,market:historical,marketName:state.market,selected:state.strike,expiryDate:state.expiry,history:null,windowId:currentSessionWindow(Date.parse(at)),now:Date.parse(at),replayRoot,replay:{capturedAt:at},onSelect:key=>{state.strike=key;renderLens(currentMarket());}});
    renderIvSurface($('watch-iv-surface'),{market:historical,rows:allRows,now:Date.parse(at),replay:true,selectedStrike:state.strike,onSelect:(key,code)=>{state.strike=key;state.series=code;renderLens(currentMarket());}});
    return;
  }
  renderLevelLens($('watch-level-lens'), {clusters:state.clusters,analysis:state.analysis,input:state.modelInput,replayRoot,
    market,marketName:state.market,selected:state.strike,expiryDate:state.expiry,history:sessionState.histories.get(ivKey()),windowId:currentSessionWindow(),now:pageNow(),
    onSelect:key=>{state.strike=key;state.series=null;renderLens(currentMarket());renderClusters(currentMarket());renderInspector(currentMarket());}});
  renderIvSurface($('watch-iv-surface'),{market,rows:rawContracts(market),now:pageNow(),selectedStrike:state.strike,onSelect:(key,code)=>{state.strike=key;state.series=code;renderLens(currentMarket());renderClusters(currentMarket());renderInspector(currentMarket());}});
}
function quoteRevision(market) {
  const count = market?.contractCount ?? market?.contracts?.length ?? 0;
  const strikes = watchedLevels(market?.watchContext, market?.underlyingCode)
    .map(level => level.strike).sort((a, b) => a - b);
  return JSON.stringify([market?.underlyingCode, market?.collectedAt, market?.priceTimestamp, count, strikes]);
}

let loadedQuoteRevisions = {};
function showSavedState(data) {
  if (validTime(data.serverTime)) state.clockOffsetMs = Date.parse(data.serverTime) - Date.now();
  state.data = data;
  state.networkError = null;
  render();
}

async function loadState({ duringRefresh = false } = {}) {
  if (state.fetching || (state.refreshing && !duringRefresh)) return; state.fetching = true; $('watch-check').disabled = true; $('watch-check').textContent = 'Checking…';
  renderService();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  const options = { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal };
  const connectionCheck = !state.data ? fetch('/api/futu/status', options).then(async response => {
    if (!response.ok) return;
    const result = await response.json();
    if (typeof result?.connection?.connected !== 'boolean' || result.connection.configured === false) return;
    state.connectionStatus = result.connection;
    renderService();
  }).catch(() => {}) : Promise.resolve();
  try {
    const response = await fetch(state.data ? '/api/market-state?view=summary' : '/api/market-state', options);
    if (!response.ok) throw new Error('The saved market state is unavailable. Try Check saved update again shortly.');
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.markets || typeof data.markets !== 'object') throw new Error('The service has not returned a valid market snapshot.');
    let full = data;
    if (state.data) {
      const revisions = Object.fromEntries(MARKETS.map(market => [market, quoteRevision(data.markets[market])]));
      const markets = Object.fromEntries(MARKETS.map(market => {
        const previous = state.data.markets[market], next = data.markets[market];
        if (previous?.underlyingCode !== next?.underlyingCode) return [market, previous];
        if (revisions[market] === loadedQuoteRevisions[market]) {
          return [market, { ...previous, ...next, contracts: previous?.contracts ?? [] }];
        }
        return [market, { ...previous, watchContext: next?.watchContext, watchContextRevision: next?.watchContextRevision }];
      }));
      // The summary already carries the complete MenthorQ context. Render it even
      // when a separate Futu snapshot is due or its download fails.
      showSavedState({ ...data, markets });
      if (MARKETS.every(market => revisions[market] === loadedQuoteRevisions[market])) {
        void loadSessionHistory();
        return;
      }
      const fullResponse = await fetch('/api/market-state', options);
      if (!fullResponse.ok) throw new Error('The latest Futu snapshot could not be loaded. Showing the previous Futu quotes.');
      full = await fullResponse.json();
      if (!full?.markets || typeof full.markets !== 'object') throw new Error('The latest Futu snapshot could not be read.');
    }
    loadedQuoteRevisions = Object.fromEntries(MARKETS.map(market => [market, quoteRevision(full.markets[market])]));
    showSavedState(full);
    void loadSessionHistory();
  } catch (error) { state.networkError = error.name === 'AbortError' ? state.data ? 'The market-state check timed out. Existing snapshots remain visible.' : 'The saved market snapshot could not be loaded because the check timed out. Choose Check saved update to retry.' : error.message; $('watch-error').hidden = false; $('watch-error').textContent = state.networkError; if (!state.data) renderService(); }
  finally { await connectionCheck; clearTimeout(timer); state.fetching = false; $('watch-check').disabled = false; $('watch-check').textContent = 'Check saved update'; renderService(); document.dispatchEvent?.(new Event('gex:data-ready')); }
}
async function postAction(path, body = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : typeof result.error === 'string' ? result.error : ['AUTH_REFRESH_BUSY', 'AUTH_REFRESH_UNAVAILABLE'].includes(result.code) ? 'Futu connection renewal is temporarily unavailable. Try again shortly; a new authorization is not required.' : response.status === 429 ? 'A recent refresh is still within the cooldown. Check the saved update shortly.' : 'The requested update is unavailable. Try again shortly.');
    return result;
  } finally { clearTimeout(timer); }
}
export function eligibleIvCodes(rows, now = Date.now()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  return [...new Set(rows.filter(row => typeof row.code === 'string' && row.code && !(validTime(row.expiryTimestamp) && Date.parse(row.expiryTimestamp) <= now) && !(typeof row.expiryDate === 'string' && row.expiryDate < today)).sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)) || a.strike - b.strike).map(row => row.code))];
}
async function refreshWatchedIV({ force = false } = {}) {
  const marketName = state.market, market = currentMarket(), key = ivKey(), codes = eligibleIvCodes(selectedContracts(market), pageNow());
  if (document.hidden || state.ivRefreshing || state.refreshing || !market?.underlyingCode || !codes.length || state.data?.connection?.connected !== true) return;
  const attempted = state.ivAttempts.get(key) ?? 0;
  if (!force && pageNow() - attempted < 60000) return;
  state.ivRefreshing = true; state.ivError = null; state.ivAttempts.set(key, pageNow()); renderContext(market);
  try {
    if (!state.ivData.has(key)) {
      const response = await fetch(`/api/iv-state?market=${encodeURIComponent(marketName)}&underlyingCode=${encodeURIComponent(market.underlyingCode)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.ok) { const saved = await response.json(); if (saved?.underlyingCode === market.underlyingCode) state.ivData.set(key, saved); }
    }
    const cursor = state.ivCursor?.get(key) ?? 0;
    const requested = codes.length <= 399 ? codes : Array.from({ length: 399 }, (_, index) => codes[(cursor + index) % codes.length]);
    const result = await postAction('/api/iv-refresh', { market: marketName, underlyingCode: market.underlyingCode, codes: requested });
    if (result?.underlyingCode !== market.underlyingCode || !Array.isArray(result.rows)) throw new Error('The IV check returned a different contract or no usable rows. Previous readings are retained.');
    const latestMarket = state.data?.markets?.[marketName], allowedStrikes = new Set(watchedLevels(latestMarket?.watchContext, latestMarket?.underlyingCode).map(level => level.strike));
    const canonicalRows = latestMarket?.underlyingCode === market.underlyingCode && Array.isArray(latestMarket.contracts) ? latestMarket.contracts.filter(row => allowedStrikes.has(row.strike)) : [];
    state.ivData.set(key, mergeIvObservations(state.ivData.get(key), result, canonicalRows));
    const confirmedBatch = ivBatchMatchesRequest(result, requested);
    if (confirmedBatch) { state.ivCursor ??= new Map(); state.ivCursor.set(key, (cursor + requested.length) % codes.length); }
    const errors = Array.isArray(result.errors) ? result.errors.map(error => typeof error === 'string' ? error : error?.message || error?.code).filter(Boolean).slice(0, 2).join(' · ') : '';
    if (result.status === 'cooldown') state.ivError = `The IV check is cooling down${validTime(result.nextRefreshAt) ? ' until ' + clock(result.nextRefreshAt) : ''}. Showing saved readings; no new batch was checked.`;
    else if (result.status === 'waiting-for-chain-refresh') state.ivError = 'The full-chain refresh is using the connection. Showing saved IV readings while this batch waits.';
    else if (result.status === 'check-failed') state.ivError = `${errors || 'The IV check failed.'} Showing saved readings; this batch has not advanced.`;
    else if (!confirmedBatch) state.ivError = 'Showing saved IV readings. A completed check of the requested batch has not been confirmed.';
    else if (codes.length > 399) state.ivError = `This pass returned ${result.coverage.returned ?? 0} / ${requested.length} requested series (${codes.length} eligible). Later passes rotate through the remaining series. Each value keeps its own timestamp.${errors ? ' ' + errors : ''}`;
    else state.ivError = errors || null;
  } catch (error) { state.ivError = error.name === 'AbortError' ? 'The watched-IV check timed out. Previous readings are retained.' : error.message; }
  finally { state.ivRefreshing = false; render(); }
}
async function saveWatchContext(event, { advanced = false } = {}) {
  event.preventDefault(); if (state.contextSaving) return;
  if (!advanced && $('watch-context-bulk').checked) return saveMatchingMenthorqLevels();
  const market = state.market, underlyingCode = currentMarket()?.underlyingCode;
  $('watch-context-error').hidden = true;
  try {
    let body, context;
    if (advanced) {
      context = JSON.parse($('watch-context-json').value);
      if (!context || Array.isArray(context) || context.source !== 'MenthorQ' || context.underlyingCode !== underlyingCode) throw new Error(`Use a MenthorQ context for the exact selected future ${underlyingCode || '(not yet loaded)'}.`);
      body = { market, context };
    } else {
      const exportText = $('watch-context-export').value.trim(), sourceDate = $('watch-context-source-date').value;
      if (!exportText) throw new Error('Paste the MenthorQ level export, including its dated futures symbol.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) throw new Error('Enter the date shown on the MenthorQ map.');
      body = { market, exportText, sourceDate, sourceLocalTime: $('watch-context-source-time').value.trim(), mode: $('watch-context-source-mode').value };
    }
    state.contextSaving = true; $('watch-save-context').disabled = true; $('watch-save-context-json').disabled = true;
    const result = await postAction('/api/watch-context', body);
    const saved = result.context ?? result.contexts?.[market] ?? context;
    if (!saved) throw new Error('The map was submitted but its saved levels were not returned. Check the saved update before trying again.');
    if (state.data?.markets?.[market]) state.data.markets[market].watchContext = saved;
    state.contextEditing = false; state.strike = null; state.series = null; state.analysisKey = null; await loadState(); render();
    await refreshWatchedIV();
  } catch (error) { $('watch-context-error').textContent = error instanceof SyntaxError ? 'This is not valid JSON. Check the commas, quotes and brackets in the imported context.' : error.message; $('watch-context-error').hidden = false; }
  finally { state.contextSaving = false; $('watch-save-context').disabled = false; $('watch-save-context-json').disabled = false; }
}
async function saveMatchingMenthorqLevels() {
  const input = {
    exportText: $('watch-context-export').value.trim(),
    sourceDate: $('watch-context-source-date').value,
    sourceLocalTime: $('watch-context-source-time').value.trim(),
    mode: $('watch-context-source-mode').value,
  };
  const errorBox = $('watch-context-error');
  const status = $('watch-menthorq-import-status');
  errorBox.hidden = true;
  status.hidden = true;
  const tickers = new Set([...input.exportText.matchAll(/\$([A-Za-z0-9_.!-]+)\s*:/g)].map(header => header[1]));
  const targets = menthorqImportTargets(true).filter(target => tickers.has(target.instrument));
  if (!targets.length) {
    errorBox.textContent = 'Paste the complete MenthorQ export for at least one of the dated contracts shown above.';
    errorBox.hidden = false;
    return;
  }
  const saved = [];
  const failures = [];
  const saveButton = $('watch-save-context');
  const jsonButton = $('watch-save-context-json');
  state.contextSaving = true;
  saveButton.disabled = jsonButton.disabled = true;
  try {
    // The service has a shared save lock. Wait for each market before saving the next.
    for (const { market, underlyingCode } of targets) {
      try {
        parseMenthorqExport({ ...input, market, underlyingCode });
        const result = await postAction('/api/watch-context', { ...input, market, underlyingCode });
        if (!result?.saved || result.context?.underlyingCode !== underlyingCode || result.context?.sourceDate !== input.sourceDate) {
          throw new Error('The new map could not be confirmed.');
        }
        saved.push(market);
        const current = state.data?.markets?.[market];
        if (current?.underlyingCode === underlyingCode) current.watchContext = result.context;
      } catch (error) {
        failures.push(`${market}: ${error.message}`);
      }
    }
    if (saved.length) {
      if (saved.includes(state.market)) {
        state.strike = null;
        state.series = null;
        state.analysisKey = null;
      }
      const skipped = MARKETS.filter(market => !targets.some(target => target.market === market));
      status.textContent = `Saved ${input.mode} levels dated ${input.sourceDate} for ${saved.join(', ')}.${skipped.length ? ' No matching sections for ' + skipped.join(', ') + '.' : ''}`;
      status.hidden = false;
      if (!failures.length) state.contextEditing = false;
      await loadState();
      render();
    }
    if (failures.length) {
      errorBox.textContent = failures.join(' ');
      errorBox.hidden = false;
    }
  } finally {
    state.contextSaving = false;
    saveButton.disabled = jsonButton.disabled = false;
  }
}
function openMenthorqEditor({ newExport = false } = {}) {
  const market = currentMarket();
  const existing = market?.watchContext;
  state.contextEditing = true;
  $('watch-context-json').value = JSON.stringify(existing ?? {
    source: 'MenthorQ', underlyingCode: market?.underlyingCode ?? '', sourceInstrument: '',
    asOf: null, sourceDate: '', capturedAt: new Date(pageNow()).toISOString(),
    expiryScope: 'Provider scope not supplied', status: 'stale', levels: [], notes: [],
  }, null, 2);
  $('watch-context-export').value = newExport ? '' : existing?.exportText ?? '';
  $('watch-context-source-date').value = newExport ? '' : existing?.sourceDate ?? '';
  $('watch-context-source-time').value = newExport ? '' : existing?.sourceLocalTime ?? '';
  $('watch-context-source-mode').value = newExport || String(existing?.mode ?? '').toLowerCase() === 'intraday' ? 'Intraday' : 'EOD';
  $('watch-context-bulk').checked = newExport;
  $('watch-context-error').hidden = true;
  renderContext(market);
  $('watch-context-export').focus();
}
async function saveZeroDteExposure(event) {
  event.preventDefault();
  if (state.contextSaving) return;
  const market = state.market, underlyingCode = currentMarket()?.underlyingCode;
  const button = $('watch-0dte-submit'), errorBox = $('watch-0dte-error');
  state.contextSaving = true;
  button.disabled = true;
  errorBox.hidden = true;
  try {
    const expiryDate = $('watch-0dte-date').value;
    const capturedAt = newYorkToIso(expiryDate + 'T' + $('watch-0dte-time').value);
    const rows = $('watch-0dte-rows').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
      const match = line.match(/^([\d,]+(?:\.\d+)?)\s+([+−-]?[\d,]+(?:\.\d+)?\s*[KMB]?)$/i);
      if (!match) throw Error('Line ' + (index + 1) + ' needs a strike, a space, and a signed Net GEX number.');
      return { strike: Number(match[1].replaceAll(',', '')), display: match[2].trim() };
    });
    const exposure0dte = { metric: 'Net GEX', scope: '0dte', mode: 'Intraday', expiryDate, capturedAt, rows,
      sourceUrl: $('watch-0dte-url').value.trim(), delayStatus: $('watch-0dte-delayed').checked ? 'delayed' : 'unverified' };
    const result = await postAction('/api/watch-context', { market, underlyingCode, exposure0dte });
    if (!result.context?.exposure0dte?.rows?.length) throw Error('The saved 0DTE rows were not returned.');
    if (state.data?.markets?.[market]) state.data.markets[market].watchContext = result.context;
    $('watch-0dte-rows').value = '';
    render();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    state.contextSaving = false;
    $('watch-0dte-submit').disabled = !watchedLevels(currentMarket()?.watchContext, currentMarket()?.underlyingCode).length;
  }
}
async function refreshQuotes({ force = true } = {}) {
  if (state.refreshing || state.fetching) return;
  state.refreshing = true; $('watch-refresh').disabled = true; $('watch-refresh').textContent = 'Refreshing quotes…';
  let complete = false;
  try {
    for (let step = 0; step < 100; step++) {
      const response = await postAction('/api/refresh?view=summary', step === 0 && force ? { force: true } : {});
      state.refreshProgress = response.progress ?? response.refreshProgress ?? null;
      renderService(); await loadState({ duringRefresh: true });
      if (response.refreshInProgress !== true) { complete = true; state.refreshProgress = null; break; }
      const delay = state.refreshProgress?.retryAfterMs;
      await new Promise(resolve => setTimeout(resolve, finite(delay) ? Math.min(60000, Math.max(150, delay)) : 750));
    }
    if (!complete) throw new Error('The bounded collection paused after 100 steps. Choose Refresh quotes now to resume; completed snapshots are retained.');
    state.networkError = null;
  }
  catch (error) { state.networkError = error.name === 'AbortError' ? 'The refresh request timed out. Check the saved update before requesting another.' : error.message; $('watch-error').textContent = state.networkError; $('watch-error').hidden = false; }
  finally { state.refreshing = false; $('watch-refresh').textContent = 'Refresh quotes now'; renderService(); }
}
async function checkOpenPage() {
  if (state.autoChecking || state.fetching || state.refreshing || state.changingContract) return;
  state.autoChecking = true;
  try {
    await loadState();
    if (!state.changingContract && automaticRefreshDue()) await refreshQuotes({ force: false });
    if (!state.changingContract && !document.hidden) void refreshWatchedIV();
    if (!state.changingContract && !document.hidden) void loadSessionHistory({refresh:true});
  } finally { state.autoChecking = false; renderService(); }
}
function switchView(view) {
  for (const [name, tab, panel] of [['market', 'market-watch-tab', 'market-watch-view'], ['manual', 'manual-watch-tab', 'manual-watch-view']]) {
    const active = name === view; $(tab).setAttribute('aria-selected', String(active)); $(tab).tabIndex = active ? 0 : -1; $(panel).hidden = !active;
  }
}
export function initMarketWatch() {
  let backupsLoading=false;
  async function checkBackups(){
    if(backupsLoading)return;backupsLoading=true;
    const status=$('watch-backup-status'),button=$('watch-backup-check');button.disabled=true;status.textContent='Checking the private archive…';
    try{
      const response=await fetch('/api/backups?limit=10',{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.error??'The archive could not be checked.');
      status.textContent=data.entries.length?`${data.entries.length} archived captures shown${data.hasMore?' · more in the download':''}.`:'No captures have been archived yet.';
      const list=$('watch-backup-list');list.replaceChildren();
      for(const entry of data.entries){const li=document.createElement('li'),a=document.createElement('a');a.href='/api/backups/export?id='+encodeURIComponent(entry.id);a.download='gamma-watch-capture.json';
        a.textContent=`${entry.market??entry.id.split('/')[1]} · ${entry.kind??entry.id.split('/')[0]} · ${entry.capturedAt?new Date(entry.capturedAt).toLocaleString():'Capture clock unavailable'}`;li.append(a);list.append(li);}
    }catch(error){status.textContent=error.message;}
    finally{backupsLoading=false;button.disabled=false;}
  }
  $('watch-backup-check').addEventListener('click',checkBackups);
  $('watch-backups').addEventListener('toggle',()=>{if($('watch-backups').open)void checkBackups();});
  bindSessionImpact($('watch-session-impact'),{onChange:patch=>{
    if(Object.hasOwn(patch,'shockPoints'))sessionState.shockByMarket[state.market]=patch.shockPoints;
    for(const key of ['positionScale','impactCoefficient','volatilityScale','allowUnverifiedContractVolume'])if(Object.hasOwn(patch,key))sessionState[key]=patch[key];
    if(patch.windowId)sessionState.windowId=patch.windowId;
    renderSession(currentMarket());
  },onRefreshHistory:()=>loadSessionHistory({refresh:true,force:true})});
  $('market-watch-tab').addEventListener('click', () => switchView('market'));
  $('manual-watch-tab').addEventListener('click', () => switchView('manual'));
  for (const id of ['watch-open-manual', 'watch-switch-manual']) $(id).addEventListener('click', () => { switchView('manual'); $('manual-watch-tab').focus(); });
  document.querySelector('.workspace-switch').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'market' : event.key === 'End' ? 'manual' : $('market-watch-tab').getAttribute('aria-selected') === 'true' ? 'manual' : 'market'; switchView(next); $(next === 'market' ? 'market-watch-tab' : 'manual-watch-tab').focus(); });
  document.querySelectorAll('[data-watch-market]').forEach(button => button.addEventListener('click', () => { state.market = button.dataset.watchMarket; state.expiry = 'all'; state.strike = null; state.series = null; state.scenarioPrice = null; state.contextEditing = false; state.ivError = null; render(); refreshWatchedIV(); void loadSessionHistory({refresh:true}); }));
  document.querySelector('.watch-market-tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = MARKETS.indexOf(state.market), next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3; const button = document.querySelector(`[data-watch-market="${MARKETS[next]}"]`); button.click(); button.focus(); });
  $('watch-check').addEventListener('click', loadState);
  $('watch-refresh').addEventListener('click', refreshQuotes);
  $('watch-refresh-iv').addEventListener('click', () => refreshWatchedIV({ force: true }));
  $('watch-context-form').addEventListener('submit', saveWatchContext);
  $('watch-0dte-form').addEventListener('submit', saveZeroDteExposure);
  $('watch-save-context-json').addEventListener('click', event => saveWatchContext(event, { advanced: true }));
  $('watch-context-bulk').addEventListener('change', renderMenthorqImportSymbols);
  $('watch-open-menthorq-levels').addEventListener('click', () => {
    document.querySelector('.watch-toolkit').open = true;
    $('watch-context-editor').closest('details').open = true;
    if (!state.contextEditing) openMenthorqEditor({ newExport: true });
    else $('watch-context-export').focus();
  });
  $('watch-edit-context').addEventListener('click', () => {
    if (!state.contextEditing) return openMenthorqEditor();
    state.contextEditing = false;
    renderContext(currentMarket());
  });
  $('watch-month').addEventListener('change', async event => {
    const underlyingCode = event.target.value, market = state.market;
    if (!underlyingCode || state.changingContract) return;
    state.changingContract = true; $('watch-month').disabled = true; $('watch-refresh').disabled = true;
    try { await postAction('/api/watch-settings', { market, underlyingCode }); state.strike = null; state.series = null; state.scenarioPrice = null; await refreshQuotes(); await loadState(); }
    catch (error) { state.networkError = error.message; $('watch-error').textContent = state.networkError; $('watch-error').hidden = false; }
    finally { state.changingContract = false; render(); }
  });
  $('watch-expiry').addEventListener('change', event => { state.expiry = event.target.value; state.strike = null; state.series = null; render(); });
  $('watch-expiry-tabs').addEventListener('click', event => { const tab = event.target.closest('[data-watch-expiry]'); if (!tab) return; state.expiry = tab.dataset.watchExpiry; state.strike = null; state.series = null; render(); });
  $('watch-expiry-tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...$('watch-expiry-tabs').querySelectorAll('[data-watch-expiry]')], current = tabs.findIndex(tab => tab.dataset.watchExpiry === state.expiry); if (!tabs.length) return; event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; const value = tabs[index].dataset.watchExpiry; tabs[index].click(); $('watch-expiry-tabs').querySelector(`[data-watch-expiry="${value}"]`)?.focus(); });
  $('watch-inventory').addEventListener('change', event => { state.inventory = event.target.value; render(); });
  $('watch-sort').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('watch-cluster-body').addEventListener('click', event => { const row = event.target.closest('[data-watch-strike]'); if (!row) return; state.strike = row.dataset.watchStrike; state.series = null; renderClusters(currentMarket()); renderInspector(currentMarket()); });
  $('watch-cluster-body').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.closest('[data-watch-strike]')?.click(); } });
  $('watch-series').addEventListener('change', event => { state.series = event.target.value; renderInspector(currentMarket()); });
  $('watch-series-body').addEventListener('click', event => { const button = event.target.closest('[data-watch-series]'); if (button) { state.series = button.dataset.watchSeries; renderInspector(currentMarket()); } });
  $('watch-scenario-price').addEventListener('input', event => { state.scenarioPrice = event.target.value.trim() ? Number(event.target.value) : null; scheduleScenario(); });
  $('watch-iv-scale').addEventListener('input', event => { state.ivScale = Number(event.target.value) / 100; scheduleScenario(); });
  $('watch-reset-scenario').addEventListener('click', () => { state.scenarioPrice = currentMarket()?.underlyingPrice ?? null; state.ivScale = 1; $('watch-iv-scale').value = '100'; $('watch-scenario-price').value = state.scenarioPrice ?? ''; renderScenario(); });
  $('watch-allow-approx').addEventListener('change', event => { state.allowApproximation = event.target.checked; render(); });
  render();
  const justConnected = new URLSearchParams(window.location.search).get('futu') === 'connected';
  if (justConnected) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  checkOpenPage();
  setInterval(checkOpenPage, 30000);
  document.addEventListener('visibilitychange', () => { renderService(); if (!document.hidden) checkOpenPage(); });
}
