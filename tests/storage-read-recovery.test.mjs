import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateStore,StorageReadError} from '../lib/secure-store.mjs';
import {handleMarketRoute} from '../src/market-service.mjs';

test('stalled storage reads return a retryable error and cancel a late response body',async()=>{
  let resolve,canceled=0;
  const bucket={get:()=>new Promise(done=>{resolve=done;})};
  const store=createPrivateStore({BUCKET:bucket,FUTU_TOKEN_ENCRYPTION_KEY:'fixture'},{readTimeoutMs:10});
  await assert.rejects(store.get('watch/state'),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
  resolve({body:{cancel:()=>{canceled++;return Promise.resolve();}},text:()=>assert.fail('late body must not be parsed')});
  await new Promise(done=>setImmediate(done));
  assert.equal(canceled,1);
});

test('a stalled R2 body reader is canceled and unlocked at the read deadline',async()=>{
  let canceled=0;
  const body=new ReadableStream({cancel(){canceled++;}});
  const store=createPrivateStore({BUCKET:{get:async()=>({etag:'fixture',body})},FUTU_TOKEN_ENCRYPTION_KEY:'fixture'},{readTimeoutMs:10});
  await assert.rejects(store.get('watch/state'),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
  await new Promise(done=>setImmediate(done));
  assert.equal(canceled,1);
  assert.equal(body.locked,false);
});

test('lease reads also respect the storage read deadline',async()=>{
  const store=createPrivateStore({BUCKET:{get:()=>new Promise(()=>{})},FUTU_TOKEN_ENCRYPTION_KEY:'fixture'},{readTimeoutMs:10});
  await assert.rejects(store.acquireLease('fixture-lease',Date.now()),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
  await assert.rejects(store.releaseLease('fixture-lease','fixture'),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
});

test('large saved chains use bounded version-pinned ranges without corrupting split UTF-8',async()=>{
  const value={padding:'a'.repeat(1024*1024-14),label:'期權鏈',rows:[1,2,3],tail:'b'.repeat(1024*1024)};
  const bytes=new TextEncoder().encode(JSON.stringify(value));let calls=0,active=0,maxActive=0;
  const bucket={head:async()=>({etag:'snapshot-v1',size:bytes.length}),get:async(_key,options)=>{
    assert.ok(options?.range,'no unbounded full-object GET');assert.equal(options.onlyIf.etagMatches,'snapshot-v1');
    calls++;active++;maxActive=Math.max(maxActive,active);
    const {offset,length}=options.range;assert.ok(length<=1024*1024);
    return {etag:'snapshot-v1',body:new ReadableStream({start(controller){queueMicrotask(()=>{controller.enqueue(bytes.slice(offset,offset+length));controller.close();active--;});}})};
  }};
  const env={BUCKET:bucket,FUTU_TOKEN_ENCRYPTION_KEY:'fixture'};
  const [result,other]=await Promise.all([createPrivateStore(env).get('watch/state'),createPrivateStore(env).get('watch/state')]);
  assert.equal(result,other,'concurrent state reads share the one parsed snapshot');
  assert.deepEqual(result,value);assert.equal(calls,Math.ceil(bytes.length/(1024*1024)));assert.ok(maxActive<=3);
});

test('a changed large snapshot version never combines ranges from different updates',async()=>{
  const bucket={head:async()=>({etag:'snapshot-v1',size:2*1024*1024}),get:async()=>({etag:'snapshot-v2'})};
  await assert.rejects(createPrivateStore({BUCKET:bucket,FUTU_TOKEN_ENCRYPTION_KEY:'fixture'}).get('watch/state'),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
});

test('snapshot read failures are reported instead of replacing existing data with empty state',async()=>{
  const bucket={get:async()=>{throw new StorageReadError();}};
  const env={BUCKET:bucket,FUTU_TOKEN_ENCRYPTION_KEY:'fixture',GAMMA_SITE_ORIGIN:'https://gamma.test'};
  const response=await handleMarketRoute(new Request('https://gamma.test/api/market-state'),env);
  assert.equal(response.status,503);
  const result=await response.json();
  assert.equal(result.code,'PRIVATE_STORAGE_UNAVAILABLE');
  assert.equal(result.retryable,true);
  assert.equal(result.markets,undefined);
  assert.match(result.error,/authorization is kept/i);
});
