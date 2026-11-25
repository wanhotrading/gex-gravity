import test from 'node:test';
import assert from 'node:assert/strict';
import {saveMenthorqUpdate} from '../collector/site-client.mjs';
import {rememberMenthorqUpload,retryMenthorqUpload} from '../collector/menthorq-uploads.mjs';

const body={market:'CL',underlyingCode:'US.CL2701',netDexUpdate:{capturedAt:'2026-11-18T16:40:00.000Z'}};
const context={underlyingCode:body.underlyingCode,netDex:{capturedAt:body.netDexUpdate.capturedAt}};
const upload=request=>saveMenthorqUpdate(request,body,{
  deadline:Date.now()+30_000,unverified:'MQ_DEX_SAVE_NOT_VERIFIED',
  verify:value=>value.netDex?.capturedAt===body.netDexUpdate.capturedAt,
});

test('a lost upload response is recovered by reading the saved capture without a second write',async()=>{
  const requests=[];
  const result=await upload(async(route,payload)=>{
    assert.equal(route,'/api/watch-context');
    requests.push(payload);
    if(payload)throw Error('SITE_REQUEST_TIMEOUT');
    return {contexts:{CL:context}};
  });
  assert.equal(result,context);
  assert.deepEqual(requests,[body,undefined]);
});

test('a temporary upload failure retries the same capture once if the site still holds the previous one',async()=>{
  const requests=[];
  const result=await upload(async(_route,payload)=>{
    requests.push(payload);
    if(requests.length===1)throw Object.assign(Error('SITE_HTTP_409'),{serviceCode:'WATCH_CONTEXT_BUSY'});
    if(!payload)return {contexts:{CL:{...context,netDex:{capturedAt:'2026-11-18T16:30:00.000Z'}}}};
    return {saved:true,context};
  });
  assert.equal(result,context);
  assert.deepEqual(requests,[body,undefined,body]);
});

test('a validation error or a changed contract cannot be retried as the same exposure upload',async()=>{
  let writes=0;
  await assert.rejects(upload(async()=>{writes++;throw Error('SITE_HTTP_400');}),/SITE_HTTP_400/);
  assert.equal(writes,1);
  writes=0;
  await assert.rejects(upload(async(_route,payload)=>{
    if(payload){writes++;throw Error('SITE_HTTP_503');}
    return {contexts:{CL:{underlyingCode:'US.CL2702'}}};
  }),/SITE_HTTP_503/);
  assert.equal(writes,1);
});

test('a second busy response backs off again with the same observed payload',async()=>{
  let writes=0,reads=0;
  const actual=await upload(async(_route,payload)=>{
    if(!payload){reads++;return {contexts:{}};}
    assert.equal(payload,body);
    if(++writes<=2)throw Error('SITE_HTTP_409');
    return {saved:true,context};
  });
  assert.equal(actual,context);
  assert.equal(writes,3);
  assert.equal(reads,2);
});

test('a conflict cannot extend the deadline or retry a known non-busy rejection',async()=>{
  for(const serviceCode of [null,'DIFFERENT_CONFLICT']){
    let writes=0,reads=0;
    await assert.rejects(saveMenthorqUpdate(async(_route,payload)=>{
      if(!payload){reads++;return {contexts:{}};}
      writes++;
      throw Object.assign(Error('SITE_HTTP_409'),{serviceCode});
    },body,{deadline:Date.now()+4000,verify:()=>false,unverified:'failed'}),/SITE_HTTP_409/);
    assert.equal(writes,1);
    assert.equal(reads,serviceCode?0:1);
  }
});

test('a deferred exposure save checks the exact contract and clock before writing',async()=>{
  for(const [stored,expected] of [
    [context,'saved'],[{...context,netDex:{capturedAt:'2026-11-18T16:50:00Z'}},'MQ_NEWER_CAPTURE_SAVED'],
    [{...context,underlyingCode:'US.CL2702'},'MQ_WATCHLIST_CHANGED'],
    [{...context,netDex:null},'write'],
  ]){
    const calls=[];
    const operation=saveMenthorqUpdate(async(_route,data)=>{
      calls.push(data);
      return data?{saved:true,context}:{contexts:{CL:stored}};
    },body,{deadline:Date.now()+8000,readFirst:true,unverified:'failed',
      verify:record=>record.netDex?.capturedAt===body.netDexUpdate.capturedAt});
    if(expected.startsWith('MQ_'))await assert.rejects(operation,{message:expected});
    else assert.deepEqual(await operation,context);
    assert.deepEqual(calls,expected==='write'?[undefined,body]:[undefined]);
  }
});

test('the scheduler replays a persisted capture after the site recovers',async()=>{
  const payload={...body,netDexUpdate:{...body.netDexUpdate,mode:'Intraday',metric:'Net DEX',rows:[{strike:81,display:'-25K'}]}};
  const saved={};
  let persisted;
  const persist=async()=>{persisted=JSON.stringify(saved);};
  await rememberMenthorqUpload(saved,payload,persist);
  const schedulerState=JSON.parse(persisted);
  const state={markets:{CL:{underlyingCode:payload.underlyingCode}}};
  const retry=async request=>retryMenthorqUpload({request,state,saved:schedulerState,persist:async()=>{},
    date:'2026-11-18',deadline:Date.now()+6000});
  assert.equal(await retry(async()=>{throw Error('SITE_NETWORK_UNAVAILABLE');}),null);
  assert.deepEqual(schedulerState.menthorqUploadQueue,[payload]);
  const savedContext={underlyingCode:payload.underlyingCode,netDex:payload.netDexUpdate};
  const calls=[];
  assert.deepEqual(await retry(async(route,data)=>{
    assert.equal(route,'/api/watch-context');
    calls.push(data);
    return data?{saved:true,context:savedContext}:{contexts:{CL:{underlyingCode:payload.underlyingCode}}};
  }),{market:'CL',kind:'netDex',context:savedContext});
  assert.deepEqual(calls,[undefined,payload]);
  assert.deepEqual(schedulerState.menthorqUploadQueue,[]);
});

test('a pending upload for a previous futures month is retired without writing',async()=>{
  const saved={menthorqUploadQueue:[body]};
  const result=await retryMenthorqUpload({
    request:async()=>assert.fail('unexpected site request'),
    state:{markets:{CL:{underlyingCode:'US.CL2702'}}},
    saved,persist:async()=>{},date:'2026-11-18',deadline:Date.now()+6000,
  });
  assert.equal(result,null);
  assert.deepEqual(saved.menthorqUploadQueue,[]);
});

test('a browser capture can leave a busy upload for the scheduler without retrying it',async()=>{
  const calls=[];
  await assert.rejects(saveMenthorqUpdate(async(_route,payload)=>{
    calls.push(payload);
    throw Object.assign(Error('SITE_HTTP_409'),{serviceCode:'WATCH_CONTEXT_BUSY'});
  },body,{deadline:Date.now()+10_000,verify:()=>false,unverified:'failed',deferRetries:true}),/SITE_HTTP_409/);
  assert.deepEqual(calls,[body]);
});
