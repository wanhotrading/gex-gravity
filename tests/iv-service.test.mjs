import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPrivateStore,encode64} from '../lib/secure-store.mjs';
import {refreshIvTracking,readIvTracking} from '../src/iv-service.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-11-04T18:00:00Z'), CODE='US.Q1C2611P28750x0';
class MemoryBucket {
  rows=new Map();counter=0;
  async get(key){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.body,json:async()=>JSON.parse(row.body)}:null;}
  async put(key,body,options={}){const old=this.rows.get(key),condition=options.onlyIf;if(condition?.etagMatches&&old?.etag!==condition.etagMatches)return null;if(condition?.etagDoesNotMatch==='*'&&old)return null;const row={body:String(body),etag:String(++this.counter)};this.rows.set(key,row);return{etag:row.etag};}
  async delete(key){this.rows.delete(key);}
}
async function environment(){const env={BUCKET:new MemoryBucket(),FUTU_TOKEN_ENCRYPTION_KEY:encode64(new Uint8Array(32).fill(3))};await createPrivateStore(env).put('watch/state',{markets:{NQ:{underlyingCode:'US.NQ2612',contracts:[{code:CODE,underlyingCode:'US.NQ2612',strike:28750,expiryDate:'2026-11-04',expiryTimestamp:'2026-11-04T21:00:00Z',optionType:'PUT'}]}}});return env;}
const args={market:'NQ',underlyingCode:'US.NQ2612',codes:[CODE],allowedStrikes:[28750],now:NOW};
function mock({at=NOW,iv=50,missing=false,fail=false}={}){const calls=[];return{calls,dependencies:{wait:async()=>{},createQuoteClient:()=>({snapshots:async codes=>{calls.push(codes);if(fail)throw Error('sensitive fixture token must stay hidden');return[{code:'US.NQ2612',future_valid:true,last_price:28720,update_time:at},...(missing?[]:[{code:CODE,option_valid:true,option_strike_price:28750,option_implied_volatility:iv,delta:-.5,gamma:.001,option_open_interest:100,update_time:at}])];}})}};}

test('targeted refresh sends one bounded batch including exact future and persists comparisons',async()=>{
  const env=await environment(),first=mock();let state=await refreshIvTracking(env,{...args,dependencies:first.dependencies});
  assert.deepEqual(first.calls,[['US.NQ2612',CODE]]);assert.equal(state.rows[0].iv,.5);assert.equal(state.underlyingPrice,28720);
  assert.equal(state.rows[0].ivChangePoints,null);assert.equal(state.coverage.tracked,1);assert.equal(state.cooldownSeconds,60);
  const next=mock({at:NOW+60000,iv:51});state=await refreshIvTracking(env,{...args,now:NOW+60000,dependencies:next.dependencies});
  assert.ok(Math.abs(state.rows[0].ivChangePoints-1)<1e-10);assert.equal(state.rows[0].previousIv,.5);
  assert.equal((await readIvTracking(env,{...args,now:NOW+90000})).rows[0].quoteAgeSeconds,30);
});

test('server cooldown and full-collector lease prevent repeated quote queries',async()=>{
  const env=await environment(),fixture=mock();await refreshIvTracking(env,{...args,dependencies:fixture.dependencies});
  assert.equal((await refreshIvTracking(env,{...args,now:NOW+1000,dependencies:fixture.dependencies})).status,'cooldown');
  assert.equal(fixture.calls.length,1);const store=createPrivateStore(env),lease=await store.acquireLease('watch/refresh-lease',NOW+60000,60000);
  assert.equal((await refreshIvTracking(env,{...args,now:NOW+60000,dependencies:fixture.dependencies})).status,'waiting-for-chain-refresh');
  assert.equal(fixture.calls.length,1);await store.releaseLease('watch/refresh-lease',lease);
});

test('watchlist and underlying are checked before requests, including cooldown requests',async()=>{
  const env=await environment(),fixture=mock();await refreshIvTracking(env,{...args,dependencies:fixture.dependencies});
  await assert.rejects(refreshIvTracking(env,{...args,allowedStrikes:[28000],dependencies:fixture.dependencies}),{code:'IV_CONTRACT_NOT_WATCHED'});
  await assert.rejects(refreshIvTracking(env,{...args,underlyingCode:'US.NQ2703',dependencies:fixture.dependencies}),{code:'IV_UNDERLYING_CHANGED'});
  assert.equal(fixture.calls.length,1);
});

test('provider failures and missing contracts preserve previous valid IV and timestamps',async()=>{
  const env=await environment();await refreshIvTracking(env,{...args,dependencies:mock().dependencies});
  const failure=await refreshIvTracking(env,{...args,now:NOW+60000,dependencies:mock({fail:true}).dependencies});
  assert.equal(failure.status,'check-failed');assert.equal(failure.rows[0].iv,.5);assert.equal(failure.rows[0].quoteTimestamp,new Date(NOW).toISOString());
  assert.ok(!JSON.stringify(failure).includes('sensitive fixture'));
  const partial=await refreshIvTracking(env,{...args,now:NOW+120000,dependencies:mock({at:NOW+120000,missing:true}).dependencies});
  assert.equal(partial.status,'partial');assert.equal(partial.rows[0].iv,.5);assert.equal(partial.rows[0].comparisonStatus,'snapshot-unavailable');
  assert.equal(partial.coverage.returned,0);assert.equal(partial.coverage.tracked,1);
});

test('duplicate provider codes do not silently replace a verified series',async()=>{
  const env=await environment(),fixture=mock(),original=fixture.dependencies.createQuoteClient;
  fixture.dependencies.createQuoteClient=()=>({snapshots:async codes=>{const rows=await original().snapshots(codes);return[...rows,rows[1]];}});
  const state=await refreshIvTracking(env,{...args,dependencies:fixture.dependencies});
  assert.equal(state.rows[0].iv,null);assert.equal(state.coverage.duplicate,1);assert.equal(state.coverage.tracked,0);
});

test('canonical month is reread after acquiring the shared writer lease',async()=>{
  const env=await environment(),fixture=mock(),store=createPrivateStore(env),put=env.BUCKET.put.bind(env.BUCKET);
  let changed=false;
  env.BUCKET.put=async(key,body,options)=>{
    if(!changed&&key.endsWith('watch/refresh-lease')){
      changed=true;
      await store.put('watch/state',{markets:{NQ:{underlyingCode:'US.NQ2703',contracts:[]}}});
    }
    return put(key,body,options);
  };
  await assert.rejects(refreshIvTracking(env,{...args,dependencies:fixture.dependencies}),{code:'IV_UNDERLYING_CHANGED'});
  assert.equal(fixture.calls.length,0);
  assert.equal((await (await env.BUCKET.get('gamma-watch/v1/watch/refresh-lease')).json()).until,0);
});

test('provider quiet intervals are held before snapshot and before releasing the collector lease',async()=>{
  const env=await environment(),fixture=mock(),events=[],original=fixture.dependencies.createQuoteClient,put=env.BUCKET.put.bind(env.BUCKET);
  fixture.dependencies.wait=async ms=>events.push(['wait',ms]);
  fixture.dependencies.createQuoteClient=()=>({snapshots:async codes=>{events.push(['snapshot']);return original().snapshots(codes);}});
  env.BUCKET.put=async(key,body,options)=>{if(key.endsWith('watch/refresh-lease')&&JSON.parse(body).until===0)events.push(['release']);return put(key,body,options);};
  await refreshIvTracking(env,{...args,dependencies:fixture.dependencies});
  assert.deepEqual(events,[['wait',650],['snapshot'],['wait',650],['release']]);
});
