import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPrivateStore,encode64} from '../lib/secure-store.mjs';
import {validateWatchContext,projectWatchContext,saveWatchContext,readWatchContexts} from '../src/watch-context.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-11-04T18:00:00Z');
function snapshot(changes={}){return{source:'MenthorQ',underlyingCode:'US.NQ2612',sourceInstrument:'NQZ2026',asOf:'2026-11-04T12:45:00-05:00',sourceDate:'2026-11-04',expiryScope:'All expiries shown by provider',sourceUrl:'https://dashboard.menthorq.io/en/futures',gexUnit:'Provider GEX units',deltaExposureUnit:'Provider delta units',levels:[{strike:28750,labels:['Negative GEX concentration'],gex:-100000,deltaExposure:-5000,openInterest:100,iv:.25},{strike:28720,labels:['Reference: current price'],kind:'reference'}],notes:['Captured from the dated futures dashboard.'],...changes};}
class MemoryBucket {
  rows=new Map();counter=0;
  async get(key){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.body,json:async()=>JSON.parse(row.body)}:null;}
  async put(key,body,options={}){const old=this.rows.get(key),condition=options.onlyIf;if(condition?.etagMatches&&old?.etag!==condition.etagMatches)return null;if(condition?.etagDoesNotMatch==='*'&&old)return null;const row={body:String(body),etag:String(++this.counter),options};this.rows.set(key,row);return{etag:row.etag};}
  async delete(key){this.rows.delete(key);}
}
const environment=()=>({BUCKET:new MemoryBucket(),FUTU_TOKEN_ENCRYPTION_KEY:encode64(new Uint8Array(32).fill(9))});
test('provider regime retains a separately unknown clock and rejects nonaggregate scope',()=>{
 const r={netGex:-5000000,display:'-5M',scope:'all-expiries',mode:'Intraday',sourceDate:null,asOf:null,sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=NQZ2026',delayStatus:'delayed'};
 const saved=validateWatchContext('NQ',snapshot({mode:'Intraday',sourceLocalTime:'12:45',regime:r}),NOW);
 assert.equal(saved.regime.asOf,null);assert.equal(saved.regime.netGex,-5000000);assert.equal(saved.mode,'Intraday');
 assert.throws(()=>validateWatchContext('NQ',snapshot({regime:{...r,scope:'0DTE'}}),NOW));
});

const exposureSnapshot=(changes={})=>({metric:'Net GEX',scope:'all-expiries',mode:'EOD',sourceDate:null,asOf:null,sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=NQZ2026',delayStatus:'unverified',capturedAt:'2026-11-04T17:55:00Z',rows:[{strike:28750,display:'-1.13M',value:999},{strike:28720,display:'0'},{strike:29999,display:'2.2K'}],...changes});
test('an independent Exposure Map save keeps Levels clocks and archives at the time the exposure became available',async()=>{
  const env=environment();
  const before=await saveWatchContext(env,'NQ',snapshot(),{now:NOW-10*60000});
  const exposure=exposureSnapshot();
  const regime={
    netGex:-1500000,display:'-1.5M',scope:exposure.scope,mode:exposure.mode,
    capturedAt:exposure.capturedAt,sourceUrl:exposure.sourceUrl,sourceDate:null,asOf:null,
  };
  const raw={underlyingCode:before.underlyingCode,exposureUpdate:{exposure,regime}};
  const updated=await saveWatchContext(env,'NQ',raw,{onlyExposure:true,now:NOW});
  assert.deepEqual(updated.levels,before.levels);
  for(const field of ['sourceDate','sourceLocalTime','asOf','mode','capturedAt','lastCheckedAt']){
    assert.equal(updated[field],before[field]);
  }
  assert.equal(updated.contextUpdatedAt,new Date(NOW).toISOString());
  assert.equal(updated.regime.capturedAt,'2026-11-04T17:55:00.000Z');
  assert.equal(updated.exposure.asOf,null);
  assert.deepEqual(updated.exposure.rows,[{strike:28750,display:'-1.13M',value:-1130000}]);
  const archives=[...env.BUCKET.rows.values()].map(row=>JSON.parse(row.body));
  assert.ok(archives.some(row=>row.kind==='menthorq'&&row.capturedAt===updated.contextUpdatedAt&&row.data.exposure?.collection==='exposure-map'));
  for(const sourceUrl of ['https://dashboard.menthorq.io/en/levels','https://dashboard.menthorq.io/en/options/exposure?symbol=ESZ2026']){
    const wrong={...raw,exposureUpdate:{exposure:{...exposure,sourceUrl},regime:{...regime,sourceUrl}}};
    await assert.rejects(saveWatchContext(env,'NQ',wrong,{onlyExposure:true,now:NOW}),/exact dated future/);
  }
  const newLevels=await saveWatchContext(env,'NQ',snapshot({sourceDate:'2026-11-05',asOf:null}),{now:NOW+24*3600000});
  assert.equal(newLevels.sourceDate,'2026-11-05');
  assert.deepEqual(newLevels.exposure,updated.exposure);
});
test('strike exposure keeps its independent clock and derives rounded values from provider displays',()=>{
 const context=validateWatchContext('NQ',snapshot({exposure:exposureSnapshot()}),NOW);
 assert.equal(context.asOf,'2026-11-04T17:45:00.000Z');
 assert.equal(context.exposure.asOf,null);assert.equal(context.exposure.sourceDate,null);
 assert.equal(context.exposure.capturedAt,'2026-11-04T17:55:00.000Z');
 assert.equal(context.exposure.rows.length,2);
 assert.deepEqual(context.exposure.rows[0],{strike:28750,display:'-1.13M',value:-1130000});
 assert.deepEqual(context.exposure.rows[1],{strike:28720,display:'0',value:0});
 assert.equal(context.levels.find(row=>row.strike===28750).gex,-100000);
 assert.deepEqual(projectWatchContext(context,'US.NQ2612',NOW).exposure,context.exposure);
 assert.equal(projectWatchContext(context,'US.NQ2703',NOW).exposure,null);
 const timed=validateWatchContext('NQ',snapshot({exposure:exposureSnapshot({mode:'Intraday',sourceDate:'2026-11-03',asOf:'2026-11-03T12:00:00-05:00'})}),NOW);
 assert.equal(timed.exposure.sourceDate,'2026-11-03');assert.equal(timed.exposure.asOf,'2026-11-03T17:00:00.000Z');
});
test('strike exposure rejects incompatible scope, contract, invalid clocks and invented or duplicate rows',()=>{
 const invalid=[{metric:'GEX rank'},{scope:'0DTE'},{mode:'unspecified'},{sourceDate:'2026-02-30'},{asOf:'2026-11-04T12:00:00'},{asOf:'2026-11-04T19:00:00Z'},{capturedAt:'yesterday'},{capturedAt:'2026-11-04T19:00:00Z'},{sourceUrl:'https://dashboard.menthorq.io.evil.test/'},{sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=ESZ2026'},{rows:[{strike:28750,display:'GEX 1',value:100}]},{rows:[{strike:28750,display:'—',value:100}]},{rows:[{strike:28750,display:'1K'},{strike:28750,display:'2K'}]},{rows:[{strike:0,display:'1K'}]},{rows:Array.from({length:81},(_,i)=>({strike:28750+i,display:'1'}))}];
 for(const changes of invalid)assert.throws(()=>validateWatchContext('NQ',snapshot({exposure:exposureSnapshot(changes)}),NOW));
 assert.throws(()=>validateWatchContext('NQ',snapshot({exposure:exposureSnapshot({metric:'Absolute GEX'})}),NOW),/Invalid exposure value/);
 const absolute=validateWatchContext('NQ',snapshot({exposure:exposureSnapshot({metric:'Absolute GEX',rows:[{strike:28750,display:'+2.5B'}]})}),NOW);
 assert.equal(absolute.exposure.metric,'Absolute GEX');assert.equal(absolute.exposure.rows[0].value,2500000000);
});
test('new map saves do not carry old strike exposure forward when no capture is supplied',async()=>{
 const env=environment();
 await saveWatchContext(env,'NQ',snapshot({exposure:exposureSnapshot()}),{now:NOW});
 assert.equal((await readWatchContexts(env)).NQ.exposure.rows.length,2);
 await saveWatchContext(env,'NQ',snapshot({sourceDate:'2026-11-05',asOf:null}),{now:NOW+24*3600000});
 assert.equal((await readWatchContexts(env)).NQ.exposure,null);
 assert.equal(validateWatchContext('NQ',snapshot(),NOW).exposure,null);
});
test('Net DEX preserves provenance, comparable prior samples and other context across independent saves',async()=>{
  const env=environment();
  const original=await saveWatchContext(env,'NQ',snapshot({
    asOf:'2026-11-04T16:42:00Z',exposure:exposureSnapshot({capturedAt:'2026-11-04T16:45:00Z'}),
  }),{now:NOW-70*60000});
  const request=(stamp,changes={})=>({
    underlyingCode:original.underlyingCode,
    netDexUpdate:{
      metric:'Net DEX',scope:'all-expiries',mode:'Intraday',sourceDate:null,asOf:null,
      sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=NQZ2026',
      delayStatus:'delayed',capturedAt:stamp,aggregateDisplay:'−16.46B',aggregateValue:999,
      rows:[{strike:28750,display:'−1.13M',value:999},{strike:28720,display:'0'},{strike:29999,display:'+2.2K'}],
      ...changes,
    },
  });
  const save=(raw,now=NOW)=>saveWatchContext(env,'NQ',raw,{now,onlyNetDex:true});
  const earlier=request('2026-11-04T17:44:00Z',{aggregateDisplay:'−18.40B'});
  await save(earlier,NOW-15*60000);
  const latest=request('2026-11-04T17:59:00Z');
  const next=await save(latest);
  assert.equal(next.netDex.aggregateValue,-16460000000);
  assert.equal(next.netDex.aggregateDisplay,'−16.46B');
  assert.deepEqual(next.netDex.rows,[{strike:28750,display:'−1.13M',value:-1130000}]);
  assert.equal(next.netDex.sourceDate,null);
  assert.equal(next.netDex.asOf,null);
  assert.deepEqual(next.netDex.history,[{capturedAt:'2026-11-04T17:44:00.000Z',asOf:null,aggregateValue:-18400000000}]);
  assert.equal(next.capturedAt,original.capturedAt);
  assert.equal(next.lastCheckedAt,original.lastCheckedAt);
  assert.deepEqual(next.exposure,original.exposure);
  assert.equal(next.contextUpdatedAt,new Date(NOW).toISOString());
  assert.equal(projectWatchContext(next,'US.NQ2703',NOW).netDex,null);
  assert.equal((await save(latest,NOW+1000)).contextUpdatedAt,next.contextUpdatedAt);
  for(const [payload,error] of [
    [earlier,/newer Net DEX/],
    [{...latest,netDexUpdate:{...latest.netDexUpdate,aggregateDisplay:'-12B'}},/already uses this capture/],
    [request('2026-11-04T18:00:00Z',{scope:'0dte'}),/all-expiry Net DEX/],
    [request('2026-11-04T18:00:00Z',{sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=ESZ2026'}),/exact dated future/],
    [request('2026-11-04T18:00:00Z',{asOf:'2026-11-04T18:00:01Z'}),/provider timestamp/],
  ])await assert.rejects(save(payload),error);
  const records=[...env.BUCKET.rows.values()].map(row=>JSON.parse(row.body));
  assert.ok(records.some(row=>row.kind==='menthorq'&&row.capturedAt===next.contextUpdatedAt&&row.data.netDex?.aggregateValue===-16460000000));
  const changed=await saveWatchContext(env,'NQ',snapshot({levels:[{strike:28000,labels:['New watched strike']}]}),{now:NOW+2000});
  assert.equal(changed.netDex.aggregateValue,next.netDex.aggregateValue);
  assert.deepEqual(changed.netDex.history,next.netDex.history);
  assert.deepEqual(changed.netDex.rows,[]);
  const close=await save(request('2026-11-04T18:00:00Z',{mode:'EOD',rows:[{strike:28000,display:'-42K'}]}),NOW+3000);
  assert.deepEqual(close.netDex.history,[]);
});
test('same-day strike signs save independently and reject other contract or expiry dates',async()=>{
  const env=environment(),all=exposureSnapshot();
  const before=await saveWatchContext(env,'NQ',snapshot({exposure:all}),{now:NOW-60000});
  const capture={...all,scope:'0dte',mode:'Intraday',expiryDate:'2026-11-04',rows:[{strike:28750,display:'+22K'}]};
  const request={underlyingCode:before.underlyingCode,exposure0dte:capture};
  const updated=await saveWatchContext(env,'NQ',request,{now:NOW,onlyZeroDte:true});
  assert.deepEqual(updated.exposure,before.exposure);
  assert.deepEqual(updated.levels,before.levels);
  assert.equal(updated.lastCheckedAt,before.lastCheckedAt);
  assert.equal(updated.exposure0dte.asOf,null);
  assert.equal(updated.exposure0dte.rows[0].value,22000);
  assert.deepEqual((await readWatchContexts(env)).NQ.exposure0dte,updated.exposure0dte);
  assert.equal(projectWatchContext(updated,'US.NQ2703',NOW).exposure0dte,null);
  for(const change of [{metric:'Absolute GEX'},{scope:'all-expiries'},{expiryDate:'2026-11-05'},{mode:'EOD'},
    {sourceUrl:'https://dashboard.menthorq.io/en/options/exposure?symbol=ESZ2026'}]){
    await assert.rejects(saveWatchContext(env,'NQ',{...request,exposure0dte:{...capture,...change}},{now:NOW,onlyZeroDte:true}));
  }
  await assert.rejects(saveWatchContext(env,'NQ',request,{now:NOW+24*3600000,onlyZeroDte:true}),/current New York date/);
});
test('older maps never overwrite a newer provider date or intraday time',async()=>{
 const env=environment();
 await saveWatchContext(env,'NQ',snapshot({mode:'Intraday',sourceLocalTime:'12:45'}),{now:NOW});
 await assert.rejects(saveWatchContext(env,'NQ',snapshot({sourceDate:'2026-11-03'}),{now:NOW}),/Older provider date/);
 await assert.rejects(saveWatchContext(env,'NQ',snapshot({mode:'Intraday',sourceLocalTime:'12:30'}),{now:NOW}),/Older provider snapshot/);
 const read=await readWatchContexts(env);assert.equal(read.NQ.sourceLocalTime,'12:45');
});

test('captured heatmap preserves expiry/display, bounds scope and never substitutes IV x OI for IV',()=>{
  const raw=snapshot({heatmap:{mode:'Intraday',asOf:null,capturedAt:'2026-11-04T17:50:00Z',delayStatus:'delayed',metrics:[{name:'IV x OI',rows:[{strike:28750,cells:[{expiry:'2026-11-04',display:'2.26K',value:999}]},{strike:99999,cells:[]}]}]}});
  const context=validateWatchContext('NQ',raw,NOW),heatmap=context.heatmap;
  assert.equal(heatmap.metrics[0].name,'IV x OI');assert.equal(heatmap.metrics[0].rows.length,1);
  assert.equal(heatmap.metrics[0].rows[0].cells[0].value,2260);
  assert.equal(context.levels.find(r=>r.strike===28750).iv,.25);
  assert.equal(heatmap.asOf,null);assert.ok(heatmap.notes.some(note=>note.includes('not per-contract IV')));
  assert.throws(()=>validateWatchContext('NQ',snapshot({sourceDate:'2026-02-30'}),NOW));
  raw.heatmap.metrics[0].rows[0].cells.push({expiry:'2026-11-04',display:'0'});
  assert.throws(()=>validateWatchContext('NQ',raw,NOW),/heatmap expiry/);
});

test('validated context binds the same dated future, normalizes source time and preserves reference kind',()=>{
  const context=validateWatchContext('NQ',snapshot(),NOW);
  assert.equal(context.underlyingCode,'US.NQ2612');assert.equal(context.sourceInstrument,'NQZ2026');
  assert.equal(context.asOf,'2026-11-04T17:45:00.000Z');assert.equal(context.capturedAt,new Date(NOW).toISOString());
  assert.deepEqual(context.levels.map(row=>row.strike),[28720,28750]);
  assert.equal(context.levels[0].kind,'reference');assert.equal(context.levels[1].kind,'option-strike');
  assert.equal(context.levels[0].gex,null);assert.equal(context.levels[1].gex,-100000);
  assert.equal(context.levels[1].sourceAsOf,'2026-11-04T12:45:00-05:00');
});

test('continuous, cash, mismatched market and mismatched dated-month sources are rejected',()=>{
  for(const changes of [{underlyingCode:'US.NQmain'},{sourceInstrument:'NQ1!'},{sourceInstrument:'NDX'},{sourceInstrument:'NQH2027'},{sourceInstrument:'ESZ2026'},{underlyingCode:'US.NQ2613'},{source:'Futu'}])
    assert.throws(()=>validateWatchContext('NQ',snapshot(changes),NOW));
  assert.throws(()=>validateWatchContext('GC',snapshot(),NOW));
  const cl=validateWatchContext('CL',snapshot({underlyingCode:'US.CL2701',sourceInstrument:'CLF2027'}),NOW);
  assert.equal(cl.sourceInstrument,'CLF2027');
});

test('future or timezone-free source timestamps are rejected at snapshot and level scope',()=>{
  for(const asOf of ['2026-11-04T19:00:00Z','2026-11-04T17:45:00','not-a-time'])
    assert.throws(()=>validateWatchContext('NQ',snapshot({asOf}),NOW));
  assert.throws(()=>validateWatchContext('NQ',snapshot({levels:[{strike:28750,labels:['GEX'],sourceAsOf:'2026-11-04T19:00:00Z'}]}),NOW));
  assert.throws(()=>validateWatchContext('NQ',snapshot({levels:[{strike:28750,labels:['GEX'],sourceAsOf:'2026-11-04T17:45:00'}]}),NOW));
});

test('missing source time remains unknown and capture time cannot masquerade as data time',()=>{
  const context=validateWatchContext('NQ',snapshot({asOf:null,sourceDate:'2026-11-04',levels:[{strike:28750,labels:['GEX']}]}),NOW);
  assert.equal(context.asOf,null);assert.equal(context.levels[0].sourceAsOf,null);
  assert.equal(context.capturedAt,new Date(NOW).toISOString());
  const projection=projectWatchContext(context,'US.NQ2612',NOW);
  assert.equal(projection.status,'stale');assert.equal(projection.asOf,null);
  assert.ok(projection.notes.some(note=>note.includes('capture time is not the source data time')));
  const perLevel=validateWatchContext('NQ',snapshot({asOf:null,levels:[{strike:28750,labels:['GEX'],sourceAsOf:'2026-11-04T17:40:00Z'}]}),NOW);
  assert.equal(perLevel.asOf,null);assert.equal(perLevel.levels[0].sourceAsOf,'2026-11-04T17:40:00Z');
});

test('projection separates missing, mismatched, current and stale contexts without inventing conversion',()=>{
  const context=validateWatchContext('NQ',snapshot(),NOW);
  assert.equal(projectWatchContext(null,'US.NQ2612',NOW).status,'missing');
  const mismatch=projectWatchContext(context,'US.NQ2703',NOW);
  assert.equal(mismatch.status,'contract-mismatch');assert.deepEqual(mismatch.levels,[]);
  assert.equal(mismatch.underlyingCode,'US.NQ2612');
  assert.ok(mismatch.notes.some(note=>note.includes('different futures month')));
  assert.equal(projectWatchContext(context,'US.NQ2612',NOW).status,'available');
  assert.equal(projectWatchContext(context,'US.NQ2612',NOW+37*3600000).status,'stale');
  assert.equal(context.levels.length,2);
});

test('level validation preserves missing values and explicit zero without synthesizing GEX',()=>{
  const context=validateWatchContext('NQ',snapshot({levels:[{strike:28750,labels:['Zero exposure reported'],gex:0,deltaExposure:0,openInterest:0,iv:null}]}),NOW);
  assert.equal(context.levels[0].gex,0);assert.equal(context.levels[0].deltaExposure,0);
  assert.equal(context.levels[0].openInterest,0);assert.equal(context.levels[0].iv,null);
  for(const levels of [[],[{strike:0,labels:['Invalid']}],[{strike:28750,labels:[]}],[{strike:28750,labels:['A']},{strike:28750,labels:['B']}],[{strike:28750,labels:['A'],iv:25}],[{strike:28750,labels:['A'],openInterest:-1}],[{strike:28750,labels:['A'],gex:'100'}]])
    assert.throws(()=>validateWatchContext('NQ',snapshot({levels}),NOW));
  assert.throws(()=>validateWatchContext('NQ',snapshot({sourceUrl:'https://menthorq.io.evil.test/'}),NOW));
});

test('saving keeps contexts in private R2 with scope metadata and preserves other markets',async()=>{
  const env=environment();assert.deepEqual(await readWatchContexts(env),{});
  await saveWatchContext(env,'NQ',snapshot(),{now:NOW});
  await saveWatchContext(env,'ES',snapshot({underlyingCode:'US.ES2612',sourceInstrument:'ESZ2026',levels:[{strike:7580,labels:['Put support']}]}),{now:NOW+1000});
  const contexts=await readWatchContexts(env);
  assert.deepEqual(Object.keys(contexts).sort(),['ES','NQ']);assert.equal(contexts.NQ.source,'MenthorQ');
  const row=env.BUCKET.rows.get('gamma-watch/v1/watch/menthorq-context');
  assert.equal(row.options.httpMetadata.cacheControl,'private, no-store');
  assert.equal(row.options.httpMetadata.contentType,'application/json');
  assert.equal(JSON.parse(env.BUCKET.rows.get('gamma-watch/v1/watch/context-lease').body).until,0);
  assert.ok([...env.BUCKET.rows.keys()].every(key=>key.startsWith('gamma-watch/v1/')));
});

test('an active context lease prevents overwrites and invalid snapshots never touch storage',async()=>{
  const env=environment(),store=createPrivateStore(env);
  await saveWatchContext(env,'NQ',snapshot(),{now:NOW});
  const previous=JSON.stringify(await readWatchContexts(env));
  const lease=await store.acquireLease('watch/context-lease',NOW+1000,15000);
  await assert.rejects(saveWatchContext(env,'NQ',snapshot({levels:[{strike:28000,labels:['Changed']}]}),{now:NOW+1000}),/already saving/);
  assert.equal(JSON.stringify(await readWatchContexts(env)),previous);
  await store.releaseLease('watch/context-lease',lease);
  await assert.rejects(saveWatchContext(env,'NQ',snapshot({sourceInstrument:'NQ1!'}),{now:NOW+2000}),/same dated contract/);
  assert.equal(JSON.stringify(await readWatchContexts(env)),previous);
});
