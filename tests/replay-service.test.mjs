import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {archiveDataRecords,DATA_ARCHIVE_PREFIX} from '../lib/data-archive.mjs';
import {handleReplayRoute,listReplaySnapshots,readReplaySnapshot} from '../src/replay-service.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const TARGET='2026-11-06T18:00:00.000Z',AT=Date.parse(TARGET);
class MemoryBucket{
  rows=new Map();lists=[];gets=[];
  async put(key,body,options={}){if(options.onlyIf?.etagDoesNotMatch==='*'&&this.rows.has(key))return null;this.rows.set(key,{body:String(body),options});return {etag:key};}
  async get(key){this.gets.push(key);const row=this.rows.get(key);return row?{body:new Blob([row.body]).stream(),text:async()=>row.body}:null;}
  async list(options){this.lists.push(options);const keys=[...this.rows.keys()].filter(key=>key.startsWith(options.prefix)&&(!options.cursor||key>options.cursor)&&(!options.startAfter||key>options.startAfter)).sort(),page=keys.slice(0,options.limit);return {objects:page.map(key=>({key,size:this.rows.get(key).body.length,customMetadata:this.rows.get(key).options.customMetadata})),truncated:keys.length>page.length,cursor:page.at(-1)};}
}
const env=()=>({BUCKET:new MemoryBucket()});
const context=(changes={})=>({source:'MenthorQ',underlyingCode:'US.NQ2612',sourceInstrument:'NQZ2026',capturedAt:TARGET,sourceDate:'2026-11-06',sourceLocalTime:'12:55',asOf:null,mode:'Intraday',delayStatus:'delayed',levels:[{strike:27000,labels:['GEX 1'],gex:null,kind:'option-strike'}],regime:{scope:'all-expiries',mode:'Intraday',sourceDate:null,asOf:null,capturedAt:TARGET,netGex:-4e6},exposure:null,...changes});
const quote=(changes={})=>({market:'NQ',provider:'Futu OpenAPI',status:'partial-snapshot',underlyingCode:'US.NQ2612',underlyingPrice:27020,priceTimestamp:'2026-11-06T17:45:00.000Z',collectedAt:'2026-11-06T17:50:00.000Z',hedgeMultiplier:20,contracts:[{code:'US.NQtest',underlyingCode:'US.NQ2612',strike:27000,iv:.2,delta:.4,gamma:.003,openInterest:100,expiryTimestamp:'2026-11-06T21:00:00.000Z',expiryDate:'2026-11-06',optionType:'CALL',quoteTimestamp:'2026-11-06T17:45:00.000Z'}],coverage:{returned:1},...changes});
async function addContext(e,value=context()){return (await archiveDataRecords(e.BUCKET,'watch/menthorq-NQ-Intraday',value))[0].id;}
async function addQuote(e,value=quote()){return (await archiveDataRecords(e.BUCKET,'watch/state',{markets:{NQ:value}}))[0].id;}
async function addIv(e,changes={}){
 const observation={iv:.3,delta:.5,gamma:.004,openInterest:110,quoteTimestamp:'2026-11-06T17:55:00.000Z',collectedAt:'2026-11-06T17:56:00.000Z'};
 const record={market:'NQ',underlyingCode:'US.NQ2612',lastSuccessAt:'2026-11-06T17:56:00.000Z',lastAttemptAt:'2026-11-06T17:56:00.000Z',status:'checked',underlyingPrice:27025,priceTimestamp:'2026-11-06T17:55:00.000Z',activeCodes:['US.NQtest'],rows:{'US.NQtest':{metadata:{code:'US.NQtest',underlyingCode:'US.NQ2612',strike:27000,expiryDate:'2026-11-06',optionType:'CALL'},current:observation,previous:null,baseline:observation,history:[observation]}},coverage:{tracked:1},...changes};
 return (await archiveDataRecords(e.BUCKET,'watch/iv/NQ/US.NQ2612',record))[0].id;
}
test('capture timeline is bounded, paginated, exact-contract and New York-date based',async()=>{
 const e=env();for(let i=0;i<28;i++)await addContext(e,context({capturedAt:new Date(AT+i*60000).toISOString(),sourceLocalTime:`13:${String(i).padStart(2,'0')}`}));
 await addContext(e,context({underlyingCode:'US.NQ2703',sourceInstrument:'NQH2027'}));
 await addContext(e,context({capturedAt:'2026-11-07T02:00:00.000Z'}));
 const first=await listReplaySnapshots(e,{market:'NQ',underlyingCode:'US.NQ2612',date:'2026-11-06'});
 assert.equal(first.entries.length,25);assert.equal(first.hasMore,true);assert.ok(first.entries.every(r=>r.underlyingCode==='US.NQ2612'&&r.timeBasis==='capture-time'));
 const second=await listReplaySnapshots(e,{market:'NQ',underlyingCode:'US.NQ2612',date:'2026-11-06',cursor:first.cursor});assert.equal(second.entries.length,4);
 assert.ok(e.BUCKET.lists.every(call=>call.limit===25&&call.prefix===DATA_ARCHIVE_PREFIX+'menthorq/NQ/'));
 assert.equal(e.BUCKET.gets.length,0);
});
test('snapshot joins only prior exact-future quotes and IV, freezes the clock and retains source uncertainty',async()=>{
 const e=env(),id=await addContext(e);const priorQuoteId=await addQuote(e);const priorIvId=await addIv(e);
 await addQuote(e,quote({collectedAt:'2026-11-06T18:05:00.000Z',underlyingPrice:99999}));
 await addQuote(e,quote({underlyingCode:'US.NQ2703',collectedAt:'2026-11-06T17:59:00.000Z',underlyingPrice:88888}));
 await addIv(e,{lastSuccessAt:'2026-11-06T18:01:00.000Z',underlyingPrice:77777});
 const result=await readReplaySnapshot(e,{id,market:'NQ',underlyingCode:'US.NQ2612'});
 assert.equal(result.replay.quoteId,priorQuoteId);assert.equal(result.replay.ivId,priorIvId);
 assert.equal(result.market.underlyingPrice,27025);assert.equal(result.market.contracts[0].iv,.3);
 assert.equal(result.market.modelAsOf,TARGET);assert.equal(result.context.asOf,null);assert.equal(result.context.regime.asOf,null);assert.equal(result.context.delayStatus,'delayed');
 assert.equal(result.market.watchContext.status,'stale');assert.equal(result.iv.rows.length,1);assert.equal(result.replay.searchLimited,false);
});
test('date seeking respects the 25-hour New York DST fall-back calendar day',async()=>{
 const e=env();for(const capturedAt of ['2026-11-01T03:59:59.000Z','2026-11-01T04:00:00.000Z','2026-11-02T04:59:59.000Z','2026-11-02T05:00:00.000Z'])await addContext(e,context({capturedAt}));
 const result=await listReplaySnapshots(e,{market:'NQ',underlyingCode:'US.NQ2612',date:'2026-11-01'});
 assert.deepEqual(result.entries.map(r=>r.capturedAt),['2026-11-02T04:59:59.000Z','2026-11-01T04:00:00.000Z']);
 assert.ok(e.BUCKET.lists[0].startAfter);assert.equal(result.hasMore,false);
});
test('future source observations and later nested context data never leak into historical models',async()=>{
 const futureExposure={capturedAt:'2026-11-06T18:03:00.000Z',asOf:null,rows:[{strike:27000,value:9e9}]};
 const e=env(),id=await addContext(e,context({exposure:futureExposure,netDex:futureExposure}));
 await addQuote(e,quote({priceTimestamp:'2026-11-06T18:01:00.000Z',contracts:[quote().contracts[0],{...quote().contracts[0],code:'US.future',quoteTimestamp:'2026-11-06T18:01:00.000Z'}]}));
 const old={iv:.25,quoteTimestamp:'2026-11-06T17:50:00.000Z',collectedAt:'2026-11-06T17:51:00.000Z'};
 await addIv(e,{rows:{'US.NQtest':{metadata:{code:'US.NQtest',underlyingCode:'US.NQ2612',strike:27000},current:{iv:.99,quoteTimestamp:'2026-11-06T18:01:00.000Z',collectedAt:'2026-11-06T17:56:00.000Z'},previous:old,baseline:old,history:[old,{iv:9,quoteTimestamp:'2026-11-06T18:01:00.000Z',collectedAt:'2026-11-06T17:56:00.000Z'}]}},priceTimestamp:'2026-11-06T18:01:00.000Z'});
 const result=await readReplaySnapshot(e,{id,market:'NQ',underlyingCode:'US.NQ2612'});
 assert.equal(result.context.exposure,null);assert.equal(result.context.netDex,null);assert.equal(result.market.underlyingPrice,null);assert.equal(result.market.contracts.length,1);assert.equal(result.market.contracts[0].iv,.25);assert.equal(result.iv.rows[0].iv,.25);assert.equal(result.iv.rows[0].ivHistory.length,1);
});
test('missing quote coverage remains missing, and bounded searches disclose truncation',async()=>{
 const e=env(),id=await addContext(e);for(let i=0;i<401;i++)await addQuote(e,quote({underlyingCode:'US.NQ2703',collectedAt:new Date(AT-60000-i*1000).toISOString()}));
 const result=await readReplaySnapshot(e,{id,market:'NQ',underlyingCode:'US.NQ2612'});
 assert.equal(result.market,null);assert.equal(result.iv,null);assert.equal(result.replay.searchLimited,true);assert.equal(result.context.levels[0].gex,null);
 assert.equal(e.BUCKET.lists.filter(call=>call.prefix.includes('/quotes/')).length,8);
});
test('independent later IV, Greeks and OI clocks suppress affected archived values',async()=>{
 const e=env(),id=await addContext(e),future='2026-11-06T18:01:00.000Z';
 await addQuote(e,quote({contracts:[{...quote().contracts[0],ivTimestamp:future,greeksTimestamp:future,quality:{oiTimestamp:future,greeksTimestamp:future},ivHistory:[{iv:.2,quoteTimestamp:'2026-11-06T17:40:00.000Z'},{iv:.9,quoteTimestamp:future}],previousIv:.9,previousQuoteTimestamp:future,ivChangePoints:70,baselineIv:.8,baselineQuoteTimestamp:future,baselineChangePoints:60,lastObservedRevision:{iv:.9,quoteTimestamp:future}}]}));
 const result=await readReplaySnapshot(e,{id,market:'NQ',underlyingCode:'US.NQ2612'}),row=result.market.contracts[0];
 assert.equal(row.iv,null);assert.equal(row.delta,null);assert.equal(row.gamma,null);assert.equal(row.openInterest,null);
 assert.equal(row.ivTimestamp,null);assert.equal(row.greeksTimestamp,null);assert.equal(row.quality.oiTimestamp,null);assert.equal(row.quality.greeksTimestamp,null);
 assert.equal(row.previousIv,null);assert.equal(row.baselineIv,null);assert.equal(row.ivHistory.length,1);assert.equal(row.lastObservedRevision,null);
 assert.ok(row.quality.issues.includes('replay-future-greeks-excluded'));
});
test('routes reject arbitrary archive paths, wrong futures, invalid dates and mutations',async()=>{
 const e=env(),id=await addContext(e);const call=(path,method='GET')=>handleReplayRoute(new Request('https://gamma.test'+path,{method}),e);
 assert.equal((await call('/api/replay?market=NQ&underlyingCode=US.NQ2612&date=2026-02-30')).status,400);
 assert.equal((await call('/api/replay/snapshot?market=NQ&underlyingCode=US.NQ2612&id=../../oauth/connection')).status,400);
 assert.equal((await call('/api/replay/snapshot?market=ES&underlyingCode=US.ES2612&id='+encodeURIComponent(id))).status,400);
 assert.equal((await call('/api/replay/snapshot?market=NQ&underlyingCode=US.NQ2703&id='+encodeURIComponent(id))).status,400);
 assert.equal((await call('/api/replay','POST')).status,405);
 const response=await call('/api/replay?market=NQ&underlyingCode=US.NQ2612&date=2026-11-06');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json()).entries.length,1);
});
