import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createPrivateStore, encode64 } from '../lib/secure-store.mjs';
import { analyzeHedgingMarket } from '../core/hedging-engine.mjs';
import { refreshMarketState as refreshMarketStep, readMarketState, handleMarketRoute, handleWatchMcp, REFRESH_MS } from '../src/market-service.mjs';
import {readCollectorStatus} from '../src/collector-service.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const NOW = Date.parse('2026-11-04T18:00:00Z');
test('weekend and maintenance refresh calls preserve snapshots without requesting provider data',async()=>{
  const env=await environment(),mock=collector();await refreshMarketState(env,{now:NOW,dependencies:mock.dependencies});
  const before=await createPrivateStore(env).get('watch/state'),count=mock.counts.collected.length;
  for(const now of [Date.parse('2026-11-07T15:00:00Z'),Date.parse('2026-11-09T22:30:00Z')]){
    const value=await refreshMarketStep(env,{now,force:true,dependencies:mock.dependencies});assert.equal(value.refreshDeferred,'market-closed');assert.equal(value.refreshInProgress,false);
  }
  assert.equal(mock.counts.collected.length,count);assert.deepEqual(await createPrivateStore(env).get('watch/state'),before);
});
test('local collector status is origin checked, bounded, projected into summaries and expires visibly',async()=>{
  const env=await environment(),checked=new Date().toISOString();
  const body={mode:'windows-software',enabled:true,futu:'updated',menthorq:'blocked',menthorqCode:'MQ_LOGIN_REQUIRED',futuLastCompletedAt:checked,secret:'must-not-persist',menthorqMarkets:[
    {market:'NQ',underlyingCode:'US.NQ2612',observedLevelsDate:'2026-11-03',observedLevelsLocalTime:'13:29',observedLevelsAt:checked},
    {market:'ES',underlyingCode:'US.NQ2612',observedLevelsDate:'2026-11-31',observedLevelsLocalTime:'29:00',observedLevelsAt:'unverified'},
  ]};
  const post=origin=>new Request('https://gamma.test/api/collector-status',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handleMarketRoute(post('https://other.test'),env)).status,403);
  const result=await (await handleMarketRoute(post('https://gamma.test'),env)).json();assert.equal(result.saved,true);assert.equal(result.collector.status,'running');assert.equal(result.collector.menthorqCode,'MQ_LOGIN_REQUIRED');
  assert.equal(JSON.stringify(await createPrivateStore(env).get('watch/collector-status')).includes('must-not-persist'),false);
  assert.equal((await readCollectorStatus(env,Date.parse(result.collector.lastSeenAt)+11*60000)).status,'offline');
  const summary=await (await handleMarketRoute(new Request('https://gamma.test/api/market-state?view=summary'),env)).json();assert.equal(summary.collector.enabled,true);assert.ok(summary.collectionWindow);
  const [nq,es]=summary.collector.menthorqMarkets;
  assert.deepEqual([nq.underlyingCode,nq.observedLevelsDate,nq.observedLevelsLocalTime,nq.observedLevelsAt],['US.NQ2612','2026-11-03','13:29',checked]);
  assert.deepEqual([es.underlyingCode,es.observedLevelsDate,es.observedLevelsLocalTime,es.observedLevelsAt],[null,null,null,null]);
});
test('MenthorQ MCP writer saves bounded provider context and rejects another futures month',async()=>{
 const env=await environment(),mock=collector();await refreshMarketState(env,{now:NOW,dependencies:mock.dependencies});
 const context={source:'MenthorQ',underlyingCode:'US.NQ2612',sourceInstrument:'NQZ2026',sourceDate:'2026-11-04',asOf:null,mode:'Intraday',levels:[{strike:28000,labels:['Put Support']}],regime:{netGex:-1000,display:'-1K',scope:'all-expiries',mode:'Intraday',asOf:null,sourceDate:null,sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=NQZ2026'}};
 const call=async c=>(await handleWatchMcp(new Request('https://gamma.test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'save_menthorq_context',arguments:{market:'NQ',context:c}}})}),env)).json();
 const good=await call(context);assert.equal(JSON.parse(good.result.content[0].text).saved,true);
 const saved=await readMarketState(env);assert.equal(saved.markets.NQ.watchContext.regime.netGex,-1000);assert.equal(saved.markets.NQ.watchContext.regime.asOf,null);
 const wrong=await call({...context,underlyingCode:'US.NQ2703',sourceInstrument:'NQH2027'});assert.equal(wrong.result.isError,true);
});
const SECRET = 'fixture-private-access-token-not-for-state';
async function refreshMarketState(env,options){let result;for(let step=0;step<60;step++){result=await refreshMarketStep(env,{...options,force:step===0&&options?.force===true});if(!result.refreshInProgress)return result;}throw Error('Fixture refresh did not finish.');}
// Same conditional-R2 behavior as the auth tests; no external OAuth requests.
class MemoryBucket {
  rows = new Map(); counter = 0;
  async get(key) {
    const row = this.rows.get(key); if (!row) return null;
    return { etag: row.etag, text: async () => row.body, json: async () => JSON.parse(row.body) };
  }
  async put(key, body, options = {}) {
    const old = this.rows.get(key), condition = options.onlyIf;
    if (condition?.etagMatches && old?.etag !== condition.etagMatches) return null;
    if (condition?.etagDoesNotMatch === '*' && old) return null;
    const row = { body: String(body), etag: `etag-${++this.counter}`, options };
    this.rows.set(key, row); return { etag: row.etag };
  }
  async delete(key) { this.rows.delete(key); }
}
async function environment(origin = 'https://gamma.test') {
  const env = { BUCKET: new MemoryBucket(), GAMMA_SITE_ORIGIN: origin,
    FUTU_TOKEN_ENCRYPTION_KEY: encode64(new Uint8Array(32).fill(7)) };
  await createPrivateStore(env).putSecret('oauth/connection', {
    accessToken: SECRET, refreshToken: 'fixture-refresh-token', scope: 'quote:read',
    expiresAt: NOW + 86400000, authorizedAt: NOW - 3600000, clientId: 'fixture',
    siteOrigin: origin, reauthorizationRequired: false,
  });
  return env;
}
const codeFor = market => `US.${market}2612`;

test('compact snapshot recovery preserves the original source and restores only saved watched strikes',async()=>{
  const env=await environment(),store=createPrivateStore(env),mock=collector();
  await refreshMarketState(env,{now:NOW,dependencies:mock.dependencies});
  const legacy=await store.get('watch/state'),contexts={};
  for(const market of ['NQ','ES','CL']){
    const row=legacy.markets[market].contracts[0];
    legacy.markets[market].contracts.push({...row,code:row.code+'OTHER',strike:row.strike+100});
    contexts[market]={source:'MenthorQ',underlyingCode:codeFor(market),capturedAt:new Date(NOW).toISOString(),asOf:null,levels:[{strike:row.strike,kind:'option-strike',labels:['GEX 1']}]};
  }
  await store.put('watch/state',legacy);await store.put('watch/menthorq-context',contexts);
  env.GAMMA_COMPACT_STATE='true';
  const req=origin=>new Request('https://gamma.test/api/recover-market-snapshot',{method:'POST',headers:{origin}});
  assert.equal((await handleMarketRoute(req('https://other.test'),env)).status,403);
  const result=await (await handleMarketRoute(req('https://gamma.test'),env)).json();
  assert.equal(result.status,'recovered');
  for(const market of ['NQ','ES','CL'])assert.deepEqual(result.markets[market],{sourceRows:2,watchedRows:1});
  assert.deepEqual(await store.get('watch/state'),legacy,'Original complete source is unchanged.');
  const current=await store.get('watch/state-v3');assert.equal(current.storageRecoveryComplete,true);
  assert.equal(current.markets.NQ.contracts.length,1);
  assert.equal((await readMarketState(env,NOW)).markets.NQ.contracts.length,1);
  assert.equal((await (await handleMarketRoute(req('https://gamma.test'),env)).json()).status,'already-recovered');
});

test('compact recovery waits for the shared quote lease without changing either snapshot',async()=>{
  const env=await environment();env.GAMMA_COMPACT_STATE='true';const store=createPrivateStore(env);
  const lease=await store.acquireLease('watch/refresh-lease',Date.now(),120000);
  const response=await handleMarketRoute(new Request('https://gamma.test/api/recover-market-snapshot',{method:'POST',headers:{origin:'https://gamma.test'}}),env);
  assert.equal((await response.json()).status,'waiting');
  assert.equal(await store.get('watch/state-v3'),null);
  await store.releaseLease('watch/refresh-lease',lease);
});
test('saved decimal CL strikes gain verified style and point value only when the encoded strike agrees',async()=>{
  const env=await environment(),store=createPrivateStore(env);
  const row={code:'US.WL12611C95x5',underlyingCode:'US.CL2612',strike:95.5,optionType:'CALL',expiryDate:'2026-11-04',expiryTimestamp:null,expirationCycle:'WEEKWED',exerciseStyle:null,multiplier:1,multiplierBasis:'provider-units-unverified',iv:.4,delta:.5,gamma:.1,openInterest:10,quoteTimestamp:new Date(NOW-60000).toISOString(),quality:{optionCategoryVerified:true,greeksBasis:'unverified'}};
  await store.put('watch/state',{schemaVersion:2,markets:{CL:{market:'CL',underlyingCode:'US.CL2612',underlyingPrice:95.31,collectedAt:new Date(NOW).toISOString(),priceTimestamp:row.quoteTimestamp,contracts:[row,{...row,code:'US.WL12611P95x5',optionType:'PUT',strike:95.25}],coverage:{}}}});
  const result=await readMarketState(env,NOW),[valid,mismatch]=result.markets.CL.contracts;
  assert.equal(valid.multiplier,1000);assert.equal(valid.multiplierBasis,'cme-verified-point-value');assert.equal(valid.exerciseStyle,'american');assert.equal(valid.expiryTimestamp,"2026-11-04T19:30:00.000Z");assert.equal(valid.automaticModelAllowed,true);assert.equal(valid.quality.greeksBasis,'futures-price');
  assert.equal(mismatch.multiplierBasis,'provider-units-unverified');assert.equal(mismatch.exerciseStyle,null);
  assert.ok(result.markets.CL.provenance.expiryRules[valid.expiryRuleVersion].sources.length);
  assert.equal((await store.get('watch/state')).markets.CL.contracts[0].multiplier,1,'on-read migration never rewrites the original provider record');
});
const prices = { NQ: 28720, ES: 6100, CL: 70.25 };
function resultFor(market, underlyingCode, now = NOW, changes = {}) {
  const prefix = { NQ: 'Q1C', ES: 'E1C', CL: 'LO' }[market];
  const strike = { NQ: 28750, ES: 6100, CL: 70 }[market];
  return {
    market, underlyingCode, provider: 'Futu OpenAPI', status: 'complete-range-snapshot',
    underlying: { futuresPrice: prices[market], quoteAsOf: new Date(now).toISOString() },
    options: [{ code: `US.${prefix}2611P${strike}x0`, underlyingCode,
      strike, optionType: 'put', expiryDate: '2026-11-04', expirationCycle: 'WEEKWED',
      iv: 0.2, delta: -0.6, gamma: 0.004, openInterest: 100,
      optionMultiplier: market === 'CL' ? 1000 : null,
      quoteAsOf: new Date(now).toISOString(), bid: 1, ask: 2,
      issues: [], evidence: { gamma: 'reported' }, quoteTimeStatus: 'fresh', optionValid: true,
      delayStatus: 'unverified' }],
    coverage: { expected: 1, requested: 1, returned: 1, fullChain: true },
    chainCoverage: { validContracts: 1, completeWithinRequestedRange: true },
    requestedExpiryRange: { start: '2026-11-04', end: '2026-12-19' },
    metadataCache: { start: '2026-11-04', end: '2026-12-19', retrievedAt: new Date(now).toISOString(),
      rows: [{ serverOnly: 'SERVER_ONLY_METADATA' }] },
    limitations: ['OI does not establish dealer ownership.'], errors: [], ...changes,
  };
}
function collector(extra = {}) {
  const counts = { clients: 0, selected: [], collected: [] };
  const dependencies = {
    createQuoteClient: () => { counts.clients++; return {}; },
    selectActiveFuture: async (_client, market) => {
      counts.selected.push(market);
      return { selectedCode: codeFor(market), selectionBasis: 'Fixture volume leader',
        candidates: [{ code: codeFor(market) }, { code: `US.${market}2703` }] };
    },
    collectFutuMarket: async (_client, args) => {
      counts.collected.push(args);
      if (extra.beforeCollect) await extra.beforeCollect(args);
      return extra.result ? extra.result(args) : resultFor(args.market, args.underlyingCode, args.now);
    },
  };
  return { counts, dependencies };
}

test('one refresh collects all three markets once and resolves actual x0 expiry codes', async () => {
  const env = await environment(), mock = collector();
  const state = await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  assert.equal(state.status, 'updated');
  assert.deepEqual(mock.counts.selected, ['NQ', 'ES', 'CL']);
  assert.equal(mock.counts.collected.length, 3);
  for (const market of ['NQ', 'ES', 'CL']) {
    assert.equal(state.markets[market].underlyingCode, codeFor(market));
    assert.equal(state.markets[market].currency, 'USD');
    assert.equal(state.markets[market].contracts.length, 1);
  }
  const nq = state.markets.NQ.contracts[0], es = state.markets.ES.contracts[0];
  assert.equal(nq.expiryTimestamp, '2026-11-04T21:00:00.000Z');
  assert.equal(es.expiryTimestamp, '2026-11-04T21:00:00.000Z');
  assert.equal(nq.exerciseStyle, 'european');
  assert.equal(state.markets.CL.contracts[0].expiryTimestamp, null);
  assert.equal(state.serverTime, new Date(NOW).toISOString());
  assert.equal(state.lastSuccessAt, new Date(NOW).toISOString());
  assert.equal(state.scheduleEnabled, false);
  assert.equal((await readMarketState({ ...env, GAMMA_SCHEDULE_ENABLED: 'true' }, NOW)).scheduleEnabled, true);
});

test('verified CME point values remain distinct from provider multiplier fields with unverified units', async () => {
  const env = await environment(), mock = collector();
  const state = await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  assert.equal(state.markets.NQ.contracts[0].multiplier, 20);
  assert.equal(state.markets.ES.contracts[0].multiplier, 50);
  assert.equal(state.markets.CL.contracts[0].multiplier, 1000);
  assert.equal(state.markets.NQ.contracts[0].multiplierBasis, 'cme-verified-point-value');
  assert.equal(state.markets.NQ.contracts[0].reportedOptionContractMultiplier, null);
  assert.equal(state.markets.CL.contracts[0].multiplierBasis, 'provider-units-unverified');
  assert.match(state.markets.NQ.provenance.contractPointValue.source, /cmegroup.com/);
  const conflictEnv = await environment('https://conflict.test');
  const conflictMock = collector({ result: args => {
    const result = resultFor(args.market, args.underlyingCode, args.now);
    result.options[0].optionMultiplier = args.market === 'NQ' ? 1 : args.market === 'ES' ? 100 : null;
    result.options[0].quoteTimeStatus = 'stale';
    return result;
  } });
  const conflicts = await refreshMarketState(conflictEnv, { now: NOW, dependencies: conflictMock.dependencies });
  assert.equal(conflicts.markets.NQ.contracts[0].multiplier, 20);
  assert.equal(conflicts.markets.ES.contracts[0].multiplier, 50);
  assert.equal(conflicts.markets.NQ.contracts[0].reportedOptionContractMultiplier, 1);
  assert.equal(conflicts.markets.ES.contracts[0].reportedOptionContractMultiplier, 100);
  assert.equal(conflicts.markets.NQ.provenance.reportedOptionContractMultiplierUnit, 'provider units unverified');
  assert.equal(conflicts.markets.NQ.provenance.contractPointValue.unit, 'USD per futures point');
  assert.ok(conflicts.markets.NQ.contracts[0].quality.issues.includes('provider-option-multiplier-units-unverified'));
  assert.equal(conflicts.markets.NQ.contracts[0].quality.modelInputFreshness, 'stale-or-unverified-inputs');
  assert.equal(conflicts.markets.CL.contracts[0].multiplier, null);
});

test('American CL clocks are mapped while European and special-session clocks remain unresolved', async () => {
  const env = await environment(), mock = collector({ result: args => {
    const result = resultFor(args.market, args.underlyingCode, args.now);
    if(args.market !== 'CL') return result;
    const template = result.options[0];
    result.options = [
      { code: 'US.WL12611P101x0', expiryDate: '2026-11-04', expirationCycle: 'WEEKWED' },
      { code: 'US.LO2612P101x0', expiryDate: '2026-11-17', expirationCycle: 'MONTH' },
      { code: 'US.LCE2612P101x0', expiryDate: '2026-11-17', expirationCycle: 'MONTH' },
      { code: 'US.WL22611P101x0', expiryDate: '2026-11-11', expirationCycle: 'WEEKWED' },
      { code: 'US.MW12611P101x0', expiryDate: '2026-11-06', expirationCycle: 'WEEKFRI' },
    ].map(row=>({...template,...row,strike:101,optionMultiplier:1}));
    result.coverage = { expected: 5, requested: 5, returned: 5, fullChain: true };
    return result;
  } });
  const state = await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  const cl = state.markets.CL, [weekly, monthly, european, holiday, micro] = cl.contracts;
  for(const row of [weekly,monthly,european,holiday]) {
    const mapped=[weekly,monthly].includes(row);
    assert.equal(row.expiryTimestamp,mapped?`${row.expiryDate}T19:30:00.000Z`:null);
    assert.equal(row.expiryRuleStatus,mapped?'resolved':'unresolved');
    assert.equal(row.multiplier,1000);
    assert.equal(row.multiplierBasis,'cme-verified-point-value');
    assert.equal(row.reportedOptionContractMultiplier,1);
    assert.equal(row.exerciseStyleBasis,'cme-verified-product-family');
    assert.equal(row.automaticModelAllowed,mapped);
    assert.equal(row.allowEuropeanApproximation,undefined);
    assert.equal(row.quality.issues.includes('exact-cl-expiration-clock-unverified'),!mapped);
  }
  assert.equal(weekly.exerciseStyle,'american');
  assert.equal(monthly.exerciseStyle,'american');
  assert.equal(european.exerciseStyle,'european');
  assert.equal(weekly.americanApproximationRequiresOptIn,false);
  assert.equal(monthly.americanApproximationRequiresOptIn,false);
  assert.equal(european.americanApproximationRequiresOptIn,false);
  assert.equal(weekly.expiryRuleReason,null);
  assert.equal(holiday.expiryRuleReason,'holiday-or-special-session-needs-review');
  assert.equal(micro.exerciseStyle,null);
  assert.equal(micro.multiplier,1);
  assert.equal(micro.multiplierBasis,'provider-units-unverified');
  assert.equal(cl.coverage.exactExpiryCount,2);
  const provenance = Object.values(cl.provenance.expiryRules)[0];
  assert.ok(provenance.sources.some(url=>url.endsWith('/1011.pdf')));
  assert.ok(provenance.sources.some(url=>url.endsWith('/550.pdf')));
  assert.equal(provenance.productFamilies.WL1.exerciseStyle,'american');
  assert.equal(provenance.productFamilies.LO.exerciseStyle,'american');
  assert.equal(provenance.productFamilies.LCE.exerciseStyle,'european');
  assert.equal(european.expiryProductRoot,'LCE');
  assert.equal(provenance.productFamilies.WL1.expirationClock,'14:30');
  assert.equal(provenance.productFamilies.LCE.expirationClock,null);
  assert.match(cl.provenance.optionMultiplierBasis,/classified standard-size CL/);
});

test('saved CL snapshots gain published expiry clocks on read without another quote request', async () => {
  const env=await environment(),mock=collector(),store=createPrivateStore(env);
  await refreshMarketState(env,{now:NOW,dependencies:mock.dependencies});
  const saved=await store.get('watch/state'),previous=saved.markets.CL.contracts[0];
  const quoteTimestamp=new Date(NOW-5*60000).toISOString();
  saved.markets.CL.priceTimestamp=new Date(NOW-10*60000).toISOString();
  saved.markets.CL.contracts=[{...previous,code:'US.WL12611P70x0',underlyingCode:'US.CL2612',
    expiryTimestamp:null,expiryDate:'2026-11-04',exerciseStyle:'american',
    exerciseStyleBasis:'cme-verified-product-family',multiplier:1000,multiplierBasis:'cme-verified-point-value',
    quoteTimestamp,quality:{...previous.quality,optionCategoryVerified:true,greeksBasis:'unverified',privateToken:SECRET}}];
  await store.put('watch/state',saved);
  const beforeRequests=mock.counts.collected.length,state=await readMarketState(env,NOW);
  const cl=state.markets.CL,row=cl.contracts[0];
  assert.equal(mock.counts.collected.length,beforeRequests,'Read migration never requests provider quotes.');
  assert.equal(row.quality.greeksBasis,'futures-price');
  assert.equal(row.quality.greeksDefinitionSource,'https://support.futunn.com/hant/topic473');
  assert.match(row.quality.greeksMethodology,/model and calculation timestamp unspecified/);
  assert.equal(row.expiryTimeZone,'America/New_York');
  assert.equal(row.expiryTimestamp,"2026-11-04T19:30:00.000Z");
  assert.equal(row.allowEuropeanApproximation,undefined);
  assert.equal(row.quoteTimestamp,quoteTimestamp,'Collection time must not replace provider quote time.');
  assert.equal(row.quality.privateToken,undefined);
  assert.equal(row.delta,previous.delta);assert.equal(row.gamma,previous.gamma);assert.equal(row.iv,previous.iv);
  const analysis=analyzeHedgingMarket({market:'CL',contract:cl.underlyingCode,futuresPrice:cl.underlyingPrice,
    optionMultiplier:row.multiplier,hedgeMultiplier:cl.hedgeMultiplier,tickSize:cl.tickSize,
    rows:[{...row,optionType:row.optionType.toLowerCase(),expiry:row.expiryTimestamp,greeksBasis:row.quality.greeksBasis}]},
    {asOf:cl.collectedAt});
  assert.equal(analysis.rows[0].observed.usable,true);
  assert.equal(analysis.rows[0].observed.timeBasis,'verified-active-expiry');
  assert.equal(analysis.rows[0].observed.quoteAgeMilliseconds,5*60000);
  assert.equal(analysis.rows[0].current.inventories.dealerAllShortOI.hedgeContracts,-60);
  assert.ok(analysis.rows[0].model.profile);
  assert.equal(analysis.rows[0].model.reason,null);
  const summary=await readMarketState(env,NOW,{summary:true});
  assert.equal(summary.markets.CL.fieldCounts.expiryTimestamp,1);
  assert.equal(summary.markets.CL.coverage.exactExpiryCount,1);
  assert.equal((await store.get('watch/state')).markets.CL.contracts[0].expiryTimestamp,null);
});

test('Greek basis migration needs verified option category and an exact dated futures owner', async()=>{
  const env=await environment(),mock=collector(),store=createPrivateStore(env);
  await refreshMarketState(env,{now:NOW,dependencies:mock.dependencies});
  const saved=await store.get('watch/state'),template=saved.markets.CL.contracts[0];
  const cases=[
    {underlyingCode:'US.CL2612',verified:true,expected:'futures-price'},
    {underlyingCode:'US.CLmain',verified:true,expected:'unverified'},
    {underlyingCode:'US.USO',verified:true,expected:'unverified'},
    {underlyingCode:'US.CL2612',verified:false,expected:'unverified'},
    {underlyingCode:'US.CL2612',verified:undefined,expected:'unverified'},
  ];
  saved.markets.CL.contracts=cases.map((entry,index)=>({...template,code:`fixture-${index}`,
    underlyingCode:entry.underlyingCode,quality:{...template.quality,greeksBasis:'unverified',optionCategoryVerified:entry.verified}}));
  await store.put('watch/state',saved);
  const state=await readMarketState(env,NOW);
  state.markets.CL.contracts.forEach((row,index)=>{
    assert.equal(row.quality.greeksBasis,cases[index].expected);
    assert.equal(row.expiryTimestamp,null);
    assert.equal(row.quality.greeksDefinitionSource,cases[index].expected==='futures-price'?'https://support.futunn.com/hant/topic473':undefined);
  });
});

test('MenthorQ context routes preserve exact-month source data separately from Futu contract rows', async()=>{
  const env=await environment(),mock=collector();
  await refreshMarketState(env,{now:NOW,dependencies:mock.dependencies});
  const context={source:'MenthorQ',underlyingCode:'US.CL2612',sourceInstrument:'CLZ2026',asOf:null,
    sourceDate:'2026-11-04',expiryScope:'All expirations shown by MenthorQ',
    sourceUrl:'https://dashboard.menthorq.io/en/chats',gexUnit:'USD per 1% move',
    levels:[{strike:70,labels:['Put Support'],gex:-120000,openInterest:500,iv:0.35},
      {strike:69.37,labels:['High Volatility Level'],kind:'reference'}]};
  const request=body=>new Request('https://gamma.test/api/watch-context',{method:'POST',headers:{origin:'https://gamma.test','content-type':'application/json'},body:JSON.stringify(body)});
  const response=await handleMarketRoute(request({market:'CL',context}),env);
  assert.equal(response.status,200);const accepted=await response.json();
  assert.equal(accepted.saved,true);assert.equal(accepted.context.status,'stale');
  assert.equal(accepted.context.asOf,null,'Unknown provider time remains unknown rather than using capture time.');
  assert.match(accepted.context.capturedAt,/Z$/);
  const stored=await (await handleMarketRoute(new Request('https://gamma.test/api/watch-context'),env)).json();
  assert.equal(stored.contexts.CL.sourceInstrument,'CLZ2026');
  assert.equal(stored.contexts.CL.levels.find(row=>row.strike===70).gex,-120000);
  assert.equal(stored.contexts.CL.levels.find(row=>row.strike===69.37).kind,'reference');
  const netDexUpdate={
    metric:'Net DEX',scope:'all-expiries',mode:'Intraday',sourceDate:null,asOf:null,
    sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=CLZ2026',
    delayStatus:'unverified',capturedAt:new Date().toISOString(),aggregateDisplay:'+2.5M',
    rows:[{strike:70,display:'-25.5K'},{strike:69.37,display:'7K'}],
  };
  const dexResponse=await handleMarketRoute(request({market:'CL',underlyingCode:'US.CL2612',netDexUpdate}),env);
  assert.equal(dexResponse.status,200);
  const dexResult=await dexResponse.json();
  assert.deepEqual(dexResult.context.netDex.rows,[{strike:70,display:'-25.5K',value:-25500}]);
  const mixed=await handleMarketRoute(request({market:'CL',underlyingCode:'US.CL2612',netDexUpdate,context}),env);
  assert.equal(mixed.status,400);
  const state=await readMarketState(env,NOW);
  assert.equal(state.markets.CL.watchContext.levels.length,2);
  assert.equal(state.markets.CL.watchContext.netDex.aggregateValue,2500000);
  assert.equal(state.markets.CL.watchContextRevision,dexResult.context.contextUpdatedAt);
  assert.equal(state.markets.CL.contracts.length,1,'Reference levels do not fabricate an option contract.');
  assert.equal(state.markets.CL.contracts[0].iv,0.2,'MenthorQ IV is not substituted for a Futu contract quote.');
  assert.equal(state.markets.CL.contracts[0].openInterest,100);
  const viewStore=createPrivateStore(env),viewSaved=await viewStore.get('watch/state');
  viewSaved.markets.CL.contracts.push({...viewSaved.markets.CL.contracts[0],code:'US.LO2611P80x0',strike:80});
  await viewStore.put('watch/state',viewSaved);
  const page=await (await handleMarketRoute(new Request('https://gamma.test/api/market-state'),env)).json();
  assert.deepEqual(page.markets.CL.contracts.map(row=>row.strike),[70]);
  assert.equal(page.markets.CL.sourceContractCount,2);
  const pageSummary=await (await handleMarketRoute(new Request('https://gamma.test/api/market-state?view=summary'),env)).json();
  assert.equal(pageSummary.markets.CL.contractCount,1);
  assert.equal(pageSummary.markets.CL.sourceContractCount,2);
  assert.equal((await viewStore.get('watch/state')).markets.CL.contracts.length,2,'Watched projection preserves the complete private source.');
  const wrongMonth=await handleMarketRoute(request({market:'CL',context:{...context,underlyingCode:'US.CL2701',sourceInstrument:'CLF2027'}}),env);
  assert.equal(wrongMonth.status,400);
  const continuous=await handleMarketRoute(request({market:'CL',context:{...context,sourceInstrument:'CLmain'}}),env);
  assert.equal(continuous.status,400);
  const crossOrigin=await handleMarketRoute(new Request('https://gamma.test/api/watch-context',{method:'POST',headers:{origin:'https://other.test'},body:JSON.stringify({market:'CL',context})}),env);
  assert.equal(crossOrigin.status,403);
  const retained=await (await handleMarketRoute(new Request('https://gamma.test/api/watch-context'),env)).json();
  assert.equal(retained.contexts.CL.sourceInstrument,'CLZ2026');
  const store=createPrivateStore(env),saved=await store.get('watch/state');saved.markets.CL.underlyingCode='US.CL2701';await store.put('watch/state',saved);
  const changed=await readMarketState(env,NOW);
  assert.equal(changed.markets.CL.watchContext.status,'contract-mismatch');
  assert.deepEqual(changed.markets.CL.watchContext.levels,[],'Different futures months cannot inherit the previous MenthorQ levels.');
});

test('same five-minute bucket is skipped, manual refresh has a 60-second cooldown', async () => {
  assert.equal(REFRESH_MS, 300000);
  const env = await environment(), mock = collector();
  await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  await refreshMarketState(env, { now: NOW + 120000, dependencies: mock.dependencies });
  assert.equal(mock.counts.collected.length, 3);
  await refreshMarketState(env, { now: NOW + 30000, force: true, dependencies: mock.dependencies });
  assert.equal(mock.counts.collected.length, 3);
  await refreshMarketState(env, { now: NOW + 61000, force: true, dependencies: mock.dependencies });
  assert.equal(mock.counts.collected.length, 6);
  await refreshMarketState(env, { now: NOW + REFRESH_MS, dependencies: mock.dependencies });
  assert.equal(mock.counts.collected.length, 9);
  assert.equal(mock.counts.selected.length, 3, 'daily contract discovery remains cached');
});

test('cached selectedCode is normalized and a user-listed override remains selected', async () => {
  const env = await environment(), mock = collector(), store = createPrivateStore(env);
  await store.put('watch/selection/NQ', { selectedCode: 'US.NQ2612', asOfDate: '2026-11-04', candidates: [{ code: 'US.NQ2612' }] });
  await store.put('watch/settings', { ES: { underlyingCode: 'US.ES2703' } });
  const state = await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  assert.equal(state.markets.NQ.underlyingCode, 'US.NQ2612');
  assert.equal(state.markets.ES.underlyingCode, 'US.ES2703');
  assert.equal((await store.get('watch/selection/ES')).underlyingCode, 'US.ES2703');
  assert.equal(state.markets.ES.selectionBasis, 'User-selected provider-listed contract');
  assert.ok(!mock.counts.selected.includes('NQ'));
});

test('failed provider requests preserve valid snapshots and withhold arbitrary upstream details', async () => {
  const env = await environment(), initial = collector();
  const original = await refreshMarketState(env, { now: NOW, dependencies: initial.dependencies });
  const failure = collector({ beforeCollect: async () => { throw Error(SECRET + ' metadataCache upstream account details'); } });
  const result = await refreshMarketState(env, { now: NOW + REFRESH_MS, dependencies: failure.dependencies });
  assert.equal(result.status, 'partial-or-unavailable');
  assert.equal(result.lastSuccessAt, original.lastSuccessAt);
  for (const market of ['NQ', 'ES', 'CL']) {
    assert.equal(result.markets[market].status, 'refresh-failed');
    assert.equal(result.markets[market].underlyingPrice, original.markets[market].underlyingPrice);
    assert.deepEqual(result.markets[market].contracts, original.markets[market].contracts);
    assert.equal(result.markets[market].errors[0].code, 'FUTU_REQUEST_FAILED');
  }
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes('upstream account details'));
});

test('zero/negative underlying and empty option results cannot replace a prior usable snapshot', async () => {
  const env = await environment(), initial = collector();
  const original = await refreshMarketState(env, { now: NOW, dependencies: initial.dependencies });
  const bad = collector({ result: args => resultFor(args.market, args.underlyingCode, args.now, {
    underlying: { futuresPrice: args.market === 'CL' ? -1 : 0, quoteAsOf: new Date(args.now).toISOString() },
  }) });
  const state = await refreshMarketState(env, { now: NOW + REFRESH_MS, dependencies: bad.dependencies });
  for (const market of ['NQ', 'ES', 'CL']) {
    assert.equal(state.markets[market].underlyingPrice, original.markets[market].underlyingPrice);
    assert.equal(state.markets[market].status, 'refresh-failed');
    assert.equal(state.markets[market].errors.at(-1).code, 'UNDERLYING_PRICE_UNAVAILABLE');
  }
  const empty = collector({ result: args => resultFor(args.market, args.underlyingCode, args.now, {
    options: [], coverage: { expected: 2, requested: 2, returned: 0 }, status: 'probe-fields-unavailable',
  }) });
  const again = await refreshMarketState(env, { now: NOW + 2 * REFRESH_MS, dependencies: empty.dependencies });
  assert.deepEqual(again.markets.NQ.contracts, original.markets.NQ.contracts);
  assert.equal(again.markets.NQ.errors.at(-1).code, 'OPTION_SNAPSHOT_UNAVAILABLE');
});

test('zero price is unavailable even when no previous snapshot exists', async () => {
  const env = await environment(), bad = collector({ result: args => resultFor(args.market, args.underlyingCode, args.now, {
    underlying: { futuresPrice: 0, quoteAsOf: new Date(args.now).toISOString() },
  }) });
  const state = await refreshMarketState(env, { now: NOW, dependencies: bad.dependencies });
  assert.equal(state.markets.NQ.underlyingPrice, null);
  assert.equal(state.lastSuccessAt, null);
});

test('concurrent jobs are coalesced within one environment and isolated across buckets', async () => {
  const a = await environment('https://a.test'), b = await environment('https://b.test');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const mockA = collector({ beforeCollect: async () => gate }), mockB = collector();
  const first = refreshMarketState(a, { now: NOW, dependencies: mockA.dependencies });
  const duplicate = refreshMarketState(a, { now: NOW, dependencies: mockA.dependencies });
  const separate = await refreshMarketState(b, { now: NOW, dependencies: mockB.dependencies });
  assert.equal(separate.connection.connected, true);
  assert.equal(mockB.counts.collected.length, 3);
  release();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.deepEqual(one, two);
  assert.equal(mockA.counts.collected.length, 3);
});

test('public responses omit private metadata caches and unsolicited stored token fields', async () => {
  const env = await environment(), mock = collector(), store = createPrivateStore(env);
  await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  const saved = await store.get('watch/state');
  saved.accessToken = SECRET; saved.metadataCache = { sentinel: 'PRIVATE_TOP_LEVEL_CACHE' };
  saved.markets.NQ.refreshToken = 'PRIVATE_MARKET_TOKEN';
  saved.markets.NQ.metadataCache = { sentinel: 'PRIVATE_MARKET_CACHE' };
  await store.put('watch/state', saved);
  const result = await readMarketState(env, NOW + 1000), text = JSON.stringify(result);
  for (const forbidden of [SECRET, 'metadataCache', 'SERVER_ONLY_METADATA', 'PRIVATE_TOP_LEVEL_CACHE', 'PRIVATE_MARKET_TOKEN', 'PRIVATE_MARKET_CACHE']) assert.ok(!text.includes(forbidden));
  assert.ok(await store.get('watch/metadata/US.NQ2612'), 'metadata cache remains server-side');
});

test('freshness uses source timestamp and invalid times stay explicitly unavailable', async () => {
  const env = await environment(), mock = collector();
  await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  const stale = await readMarketState(env, NOW + 21 * 60000);
  assert.equal(stale.markets.NQ.stale, true);
  assert.equal(stale.markets.NQ.quoteAgeSeconds, 1260);
  const store = createPrivateStore(env), state = await store.get('watch/state');
  state.markets.NQ.priceTimestamp = 'invalid'; await store.put('watch/state', state);
  const invalid = await readMarketState(env, NOW);
  assert.equal(invalid.markets.NQ.stale, true);
  assert.equal(invalid.markets.NQ.quoteAgeSeconds, null);
});

test('canonical rows share provenance/evidence once per market and preserve numeric zero/null', async () => {
  const env = await environment(), mock = collector({ result: args => {
    const result = resultFor(args.market, args.underlyingCode, args.now);
    result.options[0].delta = 0; result.options[0].gamma = 0; result.options[0].openInterest = 0;
    result.options[0].iv = null; result.options[0].evidence = { delta: 'reported-zero', gamma: 'reported-zero', option_open_interest: 'reported-zero' };
    return result;
  } });
  const state = await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  const row = state.markets.NQ.contracts[0];
  assert.equal(row.delta, 0); assert.equal(row.gamma, 0); assert.equal(row.openInterest, 0); assert.equal(row.iv, null);
  assert.equal(row.expiryRuleStatus, 'resolved'); assert.match(row.expiryRuleVersion, /cme-equity-weekly/);
  assert.equal(row.expirySource, undefined); assert.equal(row.multiplierProvenance, undefined); assert.equal(row.quality.evidence, undefined);
  assert.equal(state.markets.NQ.evidenceSummary.gamma['reported-zero'], 1);
  assert.ok(Object.values(state.markets.NQ.provenance.expiryRules)[0].sources.length > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(row)).length < 1000, 'representative row remains below 1 KB');
});

test('legacy oversized rows compact on read and summary/MCP coverage contains counts only', async () => {
  const env = await environment(), mock = collector(), store = createPrivateStore(env);
  await refreshMarketState(env, { now: NOW, dependencies: mock.dependencies });
  const saved = await store.get('watch/state');
  const original = saved.markets.NQ.contracts[0];
  const largeRows = Array.from({ length: 1000 }, (_, i) => ({ ...original, code: `US.Q1C2611P${28000 + i}x0`,
    expirySource: { ruleVersion: 'legacy-rule', provenance: { sources: ['https://www.cmegroup.com/documented-source'], repeatedDescription: 'Repeated metadata '.repeat(200) } },
    multiplierProvenance: { verifiedWeeklyStandard: 20, repeatedDescription: 'Repeated unit note '.repeat(100) },
    quality: { ...original.quality, evidence: { delta: 'reported', gamma: 'reported' } },
  }));
  saved.markets.NQ.contracts = largeRows; delete saved.markets.NQ.provenance; delete saved.markets.NQ.evidenceSummary;
  saved.markets.NQ.coverage.missingCodes = Array.from({ length: 1000 }, (_, i) => `US.PRIVATE_MISSING_${i}`);
  saved.markets.NQ.coverage.expiryCoverage = { omittedExpiries: ['2026-12-01', '2026-12-02'] };
  await store.put('watch/state', saved);
  const full = await readMarketState(env, NOW);
  assert.equal(full.markets.NQ.contracts.length, 1000);
  assert.equal(full.markets.NQ.contracts[0].expirySource, undefined);
  assert.equal(full.markets.NQ.evidenceSummary.gamma.reported, 1000);
  assert.ok(JSON.stringify(full).length < JSON.stringify(saved).length / 3);
  const response = await handleMarketRoute(new Request('https://gamma.test/api/market-state?view=summary'), env);
  const summary = await response.json();
  assert.equal(summary.markets.NQ.contracts, 0,'No watched scope exists for this fixture.');
  assert.equal(summary.markets.NQ.sourceContractCount, 1000);
  assert.equal(summary.markets.NQ.coverage.missingCodesCount, 1000);
  assert.equal(summary.markets.NQ.coverage.expiryCoverage.omittedExpiriesCount, 2);
  assert.ok(JSON.stringify(summary).length < 10000);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE_MISSING'));
  const mcp = await handleWatchMcp(new Request('https://gamma.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_watch', arguments: {} } }) }), env);
  const payload = await mcp.json(), mcpState = JSON.parse(payload.result.content[0].text);
  assert.equal(mcpState.markets.NQ.coverage.missingCodesCount, 1000);
  assert.equal(mcpState.markets.NQ.contracts, 1000);
  assert.ok(JSON.stringify(payload).length < 12000);
});

function resumableFixture({countsByMarket={NQ:900,ES:1400,CL:20},failSnapshotCall=null}={}){
  const metadataByMarket={},byCode=new Map(),calls={snapshots:[],metadata:[],selection:[]};let failureSent=false;
  for(const market of ['NQ','ES','CL']){
    const root={NQ:'Q1C',ES:'E1C',CL:'LO'}[market];
    metadataByMarket[market]=Array.from({length:countsByMarket[market]},(_,index)=>{
      const strike={NQ:28000,ES:6000,CL:70}[market]+index;
      const row={code:`US.${root}2611P${strike}x0`,stock_owner:codeFor(market),stock_type:'DRVT',strike_price:strike,option_type:'PUT',strike_time:'2026-11-04',expiration_cycle:'WEEKWED'};
      byCode.set(row.code,row);return row;
    });
  }
  const client={
    async optionChain(code,start,end){calls.metadata.push({code,start,end});const market=code.split('.')[1].slice(0,2);return start<='2026-11-04'&&end>='2026-11-04'?metadataByMarket[market]:[];},
    async snapshots(codes){calls.snapshots.push([...codes]);if(failSnapshotCall===calls.snapshots.length&&!failureSent){failureSent=true;throw Error(SECRET);}
      return codes.map(code=>{const meta=byCode.get(code);if(!meta)return {code,future_valid:true,last_price:prices[code.split('.')[1].slice(0,2)],update_time:NOW};
        return {code,option_valid:true,option_strike_price:meta.strike_price,option_implied_volatility:20,delta:-0.6,gamma:0.004,option_open_interest:0,option_contract_multiplier:1,bid_price:1,ask_price:2,update_time:NOW};});
    },
  };
  const dependencies={createQuoteClient:()=>client,selectActiveFuture:async(_client,market)=>{calls.selection.push(market);return {selectedCode:codeFor(market),candidates:[{code:codeFor(market)}]};}};
  return {metadataByMarket,byCode,calls,dependencies};
}
async function seedMetadata(env,fixture){const store=createPrivateStore(env);for(const market of ['NQ','ES','CL'])await store.put('watch/metadata/'+codeFor(market),{underlyingCode:codeFor(market),start:'2026-11-04',end:'2026-12-19',retrievedAt:new Date(NOW).toISOString(),rows:fixture.metadataByMarket[market],windows:[{start:'2026-11-04',end:'2026-12-19',returned:fixture.metadataByMarket[market].length}]});}

test('resumable batch steps preserve prior snapshots, retry only the failed batch, and finish all markets once', async()=>{
  const env=await environment(),initial=collector(),store=createPrivateStore(env);
  const prior=await refreshMarketState(env,{now:NOW,dependencies:initial.dependencies});
  const fixture=resumableFixture({failSnapshotCall:2});await seedMetadata(env,fixture);
  const options={now:NOW+REFRESH_MS,dependencies:fixture.dependencies,maxSnapshotBatches:1,summary:true};
  const first=await refreshMarketStep(env,options);
  assert.equal(first.refreshInProgress,true);assert.equal(first.progress.market,'NQ');
  assert.equal(first.progress.completed,4);assert.equal(first.progress.total,900);
  assert.equal(first.markets.NQ.contractCount,prior.markets.NQ.contracts.length,'old market remains visible until completion');
  assert.equal(fixture.calls.snapshots.length,1);
  const failed=await refreshMarketStep(env,options);
  assert.equal(failed.progress.completed,4);assert.equal(failed.refreshInProgress,true);
  const job=await store.get('watch/refresh-job');assert.equal(job.current.quoteCursor,1);assert.equal(job.current.retryCount,1);
  let last=failed;
  for(let step=0;step<30&&last.refreshInProgress;step++)last=await refreshMarketStep(env,options);
  assert.equal(last.refreshInProgress,false);assert.equal(last.status,'updated');assert.equal(last.progress.done,true);
  const full=await readMarketState(env,NOW+REFRESH_MS);
  for(const market of ['NQ','ES','CL']){
    assert.equal(full.markets[market].contracts.length,fixture.metadataByMarket[market].length);
    assert.equal(full.markets[market].coverage.collectionComplete,true);
    assert.equal(full.markets[market].coverage.returned,fixture.metadataByMarket[market].length);
    assert.equal(full.markets[market].fieldCounts.openInterest,fixture.metadataByMarket[market].length,'reported zero OI counts as present');
    assert.equal(full.markets[market].optionQuoteTimes.oldest,new Date(NOW).toISOString());
  }
  assert.equal(fixture.calls.snapshots.filter(batch=>batch.includes(codeFor('NQ'))).length,1,'the underlying/probe is not restarted after a later failed batch');
  assert.equal(fixture.calls.selection.length,0,'provider-listed selections are reused within the same day');
  assert.equal(await store.get('watch/refresh-job'),null);
  assert.ok(![...env.BUCKET.rows.keys()].some(key=>key.includes('/watch/progress/')),'temporary metadata and quote chunks are cleaned');
  assert.ok(await store.get('watch/metadata/'+codeFor('NQ')),'provider metadata cache is retained');
  assert.ok(!JSON.stringify(full).includes(SECRET));
  const count=fixture.calls.snapshots.length;await refreshMarketStep(env,options);assert.equal(fixture.calls.snapshots.length,count,'completed five-minute slots are idempotent');
});

test('metadata collection advances one window per request and reuses a saved window after interrupted cursor persistence',async()=>{
  const env=await environment(),fixture=resumableFixture({countsByMarket:{NQ:8,ES:8,CL:8}}),store=createPrivateStore(env);
  const options={now:NOW,dependencies:fixture.dependencies,maxSnapshotBatches:1,summary:true};
  let state=await refreshMarketStep(env,options);
  assert.equal(state.progress.stage,'metadata');assert.equal(state.progress.completed,1);assert.equal(fixture.calls.metadata.length,1);
  const job=await store.get('watch/refresh-job');job.current.metadataCursor=0;await store.put('watch/refresh-job',job);
  state=await refreshMarketStep(env,options);assert.equal(state.progress.completed,1);assert.equal(fixture.calls.metadata.length,1,'durable window is reused before another provider call');
  for(let step=0;step<40&&state.refreshInProgress;step++)state=await refreshMarketStep(env,options);
  assert.equal(state.refreshInProgress,false);assert.equal(fixture.calls.metadata.length,12);
  assert.ok(![...env.BUCKET.rows.keys()].some(key=>key.includes('/watch/progress/')));
});

test('a writer rereads state and job inside the lease when another isolate commits after its speculative read',async()=>{
  for(const entireJobDone of [false,true]){
    const env=await environment(),initial=collector(),store=createPrivateStore(env);
    await refreshMarketState(env,{now:NOW,dependencies:initial.dependencies});
    const at=NOW+REFRESH_MS,startedAt=new Date(at-120000).toISOString(),state=await store.get('watch/state');
    state.status='refreshing';state.lastAttemptAt=startedAt;state.refreshInProgress=true;
    const oldJob={id:'cross-isolate-job',siteOrigin:env.GAMMA_SITE_ORIGIN,startedAt,updatedAt:startedAt,start:'2026-11-04',end:'2026-12-19',marketIndex:0,completedMarkets:[],successfulMarkets:[],failedMarkets:[],current:{market:'NQ',underlyingCode:codeFor('NQ'),selection:{underlyingCode:codeFor('NQ')},stage:'quotes',quoteCursor:10}};
    await store.put('watch/state',state);await store.put('watch/refresh-job',oldJob);
    await store.put('watch/refresh-lease',{id:'other-isolate',until:at+30000});
    const committed=structuredClone(state);committed.markets.NQ.underlyingPrice=29222;committed.markets.NQ.collectedAt=new Date(at).toISOString();
    committed.refreshInProgress=!entireJobDone;committed.status=entireJobDone?'updated':'refreshing';
    const newJob={...oldJob,marketIndex:1,completedMarkets:['NQ'],successfulMarkets:['NQ'],current:null};
    const rawGet=env.BUCKET.get.bind(env.BUCKET);let observedJob=false,otherWriterCommitted=false;
    env.BUCKET.get=async key=>{
      // The caller reads old state/job while the other writer still owns its
      // lease. That writer commits/releases immediately before acquisition.
      if(key==='gamma-watch/v1/watch/refresh-job'&&!otherWriterCommitted)observedJob=true;
      if(key==='gamma-watch/v1/oauth/connection'&&observedJob&&!otherWriterCommitted){
        otherWriterCommitted=true;await store.put('watch/state',committed);
        if(entireJobDone)await store.remove('watch/refresh-job');else await store.put('watch/refresh-job',newJob);
        await store.put('watch/refresh-lease',{id:'other-isolate',until:0});
      }
      return rawGet(key);
    };
    const mock=collector(),result=await refreshMarketStep(env,{now:at,force:true,dependencies:mock.dependencies,summary:true});
    assert.equal(otherWriterCommitted,true);
    assert.equal(result.markets.NQ.underlyingPrice,29222,'newly committed market must never be replaced by the stale pre-lease state');
    assert.deepEqual(mock.counts.collected.map(args=>args.market),entireJobDone?[]:['ES']);
    if(entireJobDone){assert.equal(result.refreshInProgress,false);assert.equal(await store.get('watch/refresh-job'),null,'a forced request that observed an active job does not restart it after another writer finishes');}
    else assert.equal(result.progress.market,'CL');
  }
});

test('a completed job left after interrupted cleanup finalizes without selecting an undefined market',async()=>{
  const env=await environment(),initial=collector(),store=createPrivateStore(env);
  const previous=await refreshMarketState(env,{now:NOW,dependencies:initial.dependencies});
  const state=await store.get('watch/state');state.status='refreshing';state.refreshInProgress=true;await store.put('watch/state',state);
  await store.put('watch/refresh-job',{id:'cleanup-interrupted',siteOrigin:env.GAMMA_SITE_ORIGIN,startedAt:new Date(NOW).toISOString(),marketIndex:3,completedMarkets:['NQ','ES','CL'],successfulMarkets:['NQ','ES','CL'],failedMarkets:[],current:null});
  const mock=collector(),result=await refreshMarketStep(env,{now:NOW+1000,dependencies:mock.dependencies,summary:true});
  assert.equal(result.status,'updated');assert.equal(result.refreshInProgress,false);assert.equal(result.progress.done,true);
  assert.deepEqual(mock.counts.selected,[]);assert.deepEqual(mock.counts.collected,[]);
  assert.equal(result.markets.NQ.underlyingPrice,previous.markets.NQ.underlyingPrice);
  assert.equal(await store.get('watch/refresh-job'),null);
});
