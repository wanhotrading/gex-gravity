import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPrivateStore,encode64} from '../lib/secure-store.mjs';
import {refreshSessionHistory,readSessionHistory} from '../src/history-service.mjs';
import {newYorkBarTime,SESSION_WINDOWS} from '../core/session-history.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const NOW=Date.parse('2026-11-04T18:00:00Z'),CODE='US.NQ2612',BASE=`watch/history/NQ/${CODE}`;
class MemoryBucket{
  rows=new Map();counter=0;
  async get(key){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.body,json:async()=>JSON.parse(row.body)}:null;}
  async put(key,body,options={}){const old=this.rows.get(key),condition=options.onlyIf;if(condition?.etagMatches&&old?.etag!==condition.etagMatches)return null;if(condition?.etagDoesNotMatch==='*'&&old)return null;const row={body:String(body),etag:String(++this.counter)};this.rows.set(key,row);return{etag:row.etag};}
  async delete(key){this.rows.delete(key);}
}
async function environment(){const env={BUCKET:new MemoryBucket(),FUTU_TOKEN_ENCRYPTION_KEY:encode64(new Uint8Array(32).fill(5))};await createPrivateStore(env).put('watch/state',{markets:{NQ:{underlyingCode:CODE},ES:{underlyingCode:'US.ES2612'},CL:{underlyingCode:'US.CL2612'}}});return env;}
function fixtureBars({start='2026-10-01',end='2026-11-04',turnover=true}={}){
  const rows=[];
  for(let timestamp=Date.parse(start);timestamp<Date.parse(end);timestamp+=300000){
    const p=newYorkBarTime(timestamp);
    if(['Sat','Sun'].includes(p.weekday)||p.minute>=1020&&p.minute<1080)continue;
    const open=20000+(timestamp/300000)%100,close=open+1,volume=10;
    rows.push({time_key:timestamp,open,close,high:close+2,low:open-2,volume,...(turnover?{turnover:open*20*volume}:{})});
  }
  return rows.sort((a,b)=>b.time_key-a.time_key);
}
function provider(rows,{fail=false,endExclusive=false}={}){
  const calls=[],events=[];
  return {calls,events,dependencies:{wait:async ms=>events.push(['wait',ms]),createQuoteClient:()=>({historyKlinePage:async(code,args)=>{
    calls.push({code,args});events.push(['page']);if(fail)throw Error('sensitive private provider detail');
    const eligible=rows.filter(row=>{const date=newYorkBarTime(row.time_key).date;return date>=args.start&&(endExclusive?date<args.end:date<=args.end);});
    const bars=eligible.slice(0,1000),hasMore=false;
    return{code,ktype:6,bars,hasMore,nextTime:hasMore?bars.at(-1).time_key-1:null,volumePrecision:0};
  }})}};
}
const args={market:'NQ',underlyingCode:CODE,now:NOW};

test('history refresh is bounded, resumes private pages and exposes no licensed raw bars',async()=>{
  const env=await environment(),mock=provider(fixtureBars());
  const first=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(first.market,'NQ');assert.equal(first.underlyingCode,CODE);
  assert.equal(mock.calls.length,2);assert.equal(first.progress.pages,2);assert.equal(first.progress.done,false);
  assert.ok(first.progress.observedBars>0);assert.equal('bars' in first,false);assert.equal('bars' in first.profile,false);
  assert.equal(mock.calls[0].args.end,'2026-11-05');assert.equal(mock.calls[0].args.start,'2026-11-03');
  assert.equal(first.progress.queryDateEndMeaning,'following-calendar-boundary');assert.ok(first.progress.returnedDateRange.minNYDate);
  const nextEnd=mock.calls[1].args.end;
  const next=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(next.progress.pages,4);assert.ok(mock.calls[2].args.end<nextEnd);
  assert.equal(next.profile.volumeUnit,'contracts');assert.equal(next.profile.barConvention,'start');
  const stored=await createPrivateStore(env).get(`${BASE}/bars`);
  assert.equal(stored.bars.length,next.progress.observedBars);assert.ok(stored.bars[0].timestamp<stored.bars.at(-1).timestamp);
  assert.deepEqual(mock.events.slice(0,4),[['wait',650],['page'],['page'],['wait',650]]);
  assert.equal((await readSessionHistory(env,args)).progress.pages,4);
});

test('twenty complete completed sessions finish even with unverified volume units',async()=>{
  const env=await environment(),mock=provider(fixtureBars({turnover:false}));let result;
  for(let step=0;step<20;step++){
    result=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
    if(result.progress.done)break;
  }
  assert.equal(result.progress.done,true);assert.equal(result.progress.reason,'target-sessions');
  assert.equal(result.status,'history-partial');assert.equal(result.profile.volumeUnit,'unverified');
  assert.ok(result.profile.windows.every(row=>row.sampleCount===20&&row.medianVolumeContracts===null&&row.medianRangePoints>0));
  assert.ok(result.profile.windows.every(row=>row.lastSessionDate<'2026-11-04'));
  const calls=mock.calls.length;
  assert.equal((await refreshSessionHistory(env,{...args,dependencies:mock.dependencies})).progress.done,true);
  assert.equal(mock.calls.length,calls);
  const read=await readSessionHistory(env,{...args,now:NOW+86400000});
  assert.equal(read.status,'history-refresh-due');assert.equal(read.progress.done,false);assert.deepEqual(read.profile,result.profile);
});

test('a failed forced refresh retains the previous reference and blocks rapid retries',async()=>{
  const env=await environment(),good=provider(fixtureBars({start:'2026-11-02',end:'2026-11-04'}));
  const first=await refreshSessionHistory(env,{...args,dependencies:good.dependencies});assert.ok(first.profile);
  const bad=provider([],{fail:true}),failed=await refreshSessionHistory(env,{...args,now:NOW+61000,force:true,dependencies:bad.dependencies});
  assert.equal(failed.status,'history-refresh-failed');assert.deepEqual(failed.profile,first.profile);
  assert.equal(failed.errors[0].code,'FUTU_REQUEST_FAILED');assert.equal(JSON.stringify(failed).includes('sensitive private'),false);
  const rapid=await refreshSessionHistory(env,{...args,now:NOW+62000,force:true,dependencies:bad.dependencies});
  assert.equal(rapid.status,'cooldown');assert.equal(rapid.progress.retryAfterMs,59000);assert.equal(bad.calls.length,1);
});

test('shared writer lease and exact canonical identity prevent unauthorized or overlapping requests',async()=>{
  const env=await environment(),mock=provider(fixtureBars()),store=createPrivateStore(env);
  await assert.rejects(refreshSessionHistory(env,{...args,underlyingCode:'US.NQmain',dependencies:mock.dependencies}),{code:'HISTORY_EXACT_FUTURE_REQUIRED'});
  await assert.rejects(refreshSessionHistory(env,{...args,underlyingCode:'US.NQ2703',dependencies:mock.dependencies}),{code:'HISTORY_UNDERLYING_CHANGED'});
  await assert.rejects(readSessionHistory(env,{...args,underlyingCode:'US.NQ2703'}),{code:'HISTORY_UNDERLYING_CHANGED'});
  const lease=await store.acquireLease('watch/refresh-lease',NOW,60000);
  assert.equal((await refreshSessionHistory(env,{...args,dependencies:mock.dependencies})).status,'waiting-for-chain-refresh');
  assert.equal(mock.calls.length,0);await store.releaseLease('watch/refresh-lease',lease);
});

test('canonical month is checked again after lease acquisition and lease is released',async()=>{
  const env=await environment(),mock=provider(fixtureBars()),store=createPrivateStore(env),put=env.BUCKET.put.bind(env.BUCKET);
  let changed=false;
  env.BUCKET.put=async(key,body,options)=>{
    if(!changed&&key.endsWith('watch/refresh-lease')){changed=true;await store.put('watch/state',{markets:{NQ:{underlyingCode:'US.NQ2703'}}});}
    return put(key,body,options);
  };
  await assert.rejects(refreshSessionHistory(env,{...args,dependencies:mock.dependencies}),{code:'HISTORY_UNDERLYING_CHANGED'});
  assert.equal(mock.calls.length,0);
  assert.equal((await (await env.BUCKET.get('gamma-watch/v1/watch/refresh-lease')).json()).until,0);
});

test('invalid completed bars never replace a previous valid reference',async()=>{
  const env=await environment(),rows=fixtureBars({start:'2026-11-02',end:'2026-11-04'}),first=await refreshSessionHistory(env,{...args,dependencies:provider(rows).dependencies});
  const conflict=rows.map((row,i)=>i?row:{...row,high:row.low-1}),bad=provider(conflict);
  const state=await refreshSessionHistory(env,{...args,now:NOW+61000,force:true,dependencies:bad.dependencies});
  assert.equal(state.status,'history-refresh-failed');assert.equal(state.errors[0].code,'HISTORY_INVALID_DATA');
  assert.equal(state.errors[0].responseShape.barDiagnostics.reason,'normalization');
  assert.ok(state.errors[0].responseShape.barDiagnostics.badPriceCount>0);
  assert.deepEqual(state.profile,first.profile);
});

test('a forced fresh pass can recover corrected history without conflicting with its prior cache',async()=>{
  const env=await environment(),rows=fixtureBars({start:'2026-11-02',end:'2026-11-04'});
  const first=await refreshSessionHistory(env,{...args,dependencies:provider(rows).dependencies});
  const corrected=rows.map((row,i)=>i?row:{...row,close:row.close+.25});
  const correctedProvider=provider(corrected);let state=await refreshSessionHistory(env,{...args,now:NOW+61000,force:true,dependencies:correctedProvider.dependencies});
  for(let i=0;i<30&&!state.progress.done;i++)state=await refreshSessionHistory(env,{...args,now:NOW+61000,dependencies:correctedProvider.dependencies});
  assert.equal(state.progress.done,true);assert.notEqual(state.status,'history-refresh-failed');
  assert.equal(state.errors.length,0);assert.notEqual(state.profile.asOf,first.profile.asOf);
  const cached=await createPrivateStore(env).get(`${BASE}/bars`);
  assert.equal(cached.bars.find(row=>row.timestamp===corrected[0].time_key).close,corrected[0].close);
});

test('calendar requests reject repeated data even if the provider cursor decreases',async()=>{
  const env=await environment(),mock=provider(fixtureBars()),original=mock.dependencies.createQuoteClient;
  let firstResponse;
  mock.dependencies.createQuoteClient=()=>({historyKlinePage:async(code,request)=>{
    if(!firstResponse){firstResponse=await original().historyKlinePage(code,request);return firstResponse;}
    return {...firstResponse,nextTime:firstResponse.nextTime-1};
  }});
  await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  const result=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(result.status,'history-refresh-failed');assert.equal(result.progress.pages,2);
  assert.equal(result.errors[0].code,'HISTORY_INVALID_DATA');
});

test('pagination is bounded by forty pages and stalled cursors fail safely',async()=>{
  const env=await environment(),store=createPrivateStore(env),rows=fixtureBars();
  const job={schemaVersion:1,market:'NQ',underlyingCode:CODE,createdDate:'2026-11-04',startedAt:new Date(NOW).toISOString(),startDate:'2026-09-05',endDate:'2026-11-03',nextTime:null,phase:'history',historyPages:0,pages:39,observedBars:0,done:false};
  await store.put(`${BASE}/job`,job);
  const state=await refreshSessionHistory(env,{...args,dependencies:provider(rows).dependencies});
  assert.equal(state.progress.done,true);assert.equal(state.progress.pages,40);assert.equal(state.progress.reason,'page-limit');
  const bad=provider([]);bad.dependencies.createQuoteClient=()=>({historyKlinePage:async()=>({code:CODE,ktype:6,bars:[{...rows[0],time_key:Date.parse('2026-09-07T13:30:00Z')}],hasMore:false,nextTime:null,volumePrecision:0})});
  await store.put(`${BASE}/job`,{...job,pages:0,nextTime:NOW});
  const stalled=await refreshSessionHistory(env,{...args,now:NOW+61000,dependencies:bad.dependencies});
  assert.equal(stalled.status,'history-refresh-failed');assert.equal(stalled.errors[0].code,'HISTORY_INVALID_DATA');
});

test('a slow first page yields before the second page and failed provider calls hold the quiet handoff',async()=>{
  const env=await environment(),mock=provider(fixtureBars()),clock=[0,14000];
  mock.dependencies.wallNow=()=>clock.shift()??14000;
  const result=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(mock.calls.length,1);assert.equal(result.progress.pages,1);assert.equal(result.progress.done,false);
  const failed=provider([],{fail:true});
  await refreshSessionHistory(env,{...args,now:NOW+61000,force:true,dependencies:failed.dependencies});
  assert.deepEqual(failed.events,[['wait',650],['page'],['wait',650]]);
  assert.equal((await (await env.BUCKET.get('gamma-watch/v1/watch/refresh-lease')).json()).until,0);
});

test('complete end-stamped current-trading-day bars corroborate snapshot contract volumes; gaps do not',async()=>{
  const base=fixtureBars({end:'2026-11-04T18:00:00Z',turnover:false});
  const rows=base.map(row=>{
    const p=newYorkBarTime(row.time_key),date=p.minute>=1080?new Date(Date.parse(p.date)+86400000).toISOString().slice(0,10):p.date;
    return{...row,time_key:row.time_key+300000,date:Number(date.replaceAll('-',''))};
  });
  const total=rows.filter(row=>row.date===20261104).reduce((sum,row)=>sum+row.volume,0);
  for(const missing of [false,true]){
    const env=await environment(),input=missing?rows.filter(row=>row.time_key!==NOW):rows,mock=provider(input),original=mock.dependencies.createQuoteClient;
    mock.dependencies.createQuoteClient=()=>({...original(),snapshots:async()=>[{code:CODE,future_valid:true,volume:total,update_time:NOW,data_date:'2026-11-04'}]});
    const state=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
    assert.equal(state.profile.barConvention,'end');
    assert.equal(state.profile.volumeUnit,missing?'unverified':'contracts');
    assert.equal(state.profile.volumeEvidence.bracketed,!missing);
    if(missing)assert.equal(state.profile.volumeEvidence.reason,'missing-or-incomplete-bars');
    else assert.equal(state.profile.volumeEvidence.barVolumeSum,total);
  }
});

test('a forced refresh waiting behind another writer remains pending despite a completed prior job',async()=>{
  const env=await environment(),store=createPrivateStore(env);
  await store.put(`${BASE}/job`,{market:'NQ',underlyingCode:CODE,createdDate:'2026-11-04',done:true,pages:10,observedBars:1000});
  const lease=await store.acquireLease('watch/refresh-lease',NOW,60000);
  const state=await refreshSessionHistory(env,{...args,force:true,dependencies:provider([]).dependencies});
  assert.equal(state.status,'waiting-for-chain-refresh');assert.equal(state.progress.done,false);
  await store.releaseLease('watch/refresh-lease',lease);
});

test('following-day boundary covers every desired day when the provider excludes end-date midnight',async()=>{
  const env=await environment(),rows=fixtureBars(),mock=provider(rows,{endExclusive:true});let state;
  for(let step=0;step<20;step++){
    state=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
    if(state.progress.done)break;
  }
  assert.equal(state.progress.reason,'target-sessions');
  const dates=[...new Set(rows.map(row=>newYorkBarTime(row.time_key).date))].filter(date=>date<'2026-11-04').sort().slice(-20);
  assert.ok(state.profile.windows.every(row=>row.sampleCount===20&&row.firstSessionDate===dates[0]&&row.lastSessionDate===dates.at(-1)));
  assert.equal(state.progress.queryDateEndMeaning,'following-calendar-boundary');
  assert.equal(state.progress.unitEvidence.reason,'snapshot-unavailable');
});

test('invalid current-day and future placeholder bars cannot block valid prior-session benchmarks',async()=>{
  const env=await environment(),past=fixtureBars({start:'2026-11-02',end:'2026-11-04'});
  const placeholder=time=>({time_key:time,open:0,close:0,high:0,low:0,volume:0,privateField:'sensitive account text'});
  const mock=provider([...past,placeholder(NOW),placeholder(NOW+86400000)]);
  const state=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(state.status,'loading-history');assert.equal(state.errors.length,0);
  assert.ok(state.profile.windows.some(row=>row.sampleCount>0));assert.equal(state.profile.volumeUnit,'contracts'); // Valid past turnover is independently corroborated.
  assert.equal(state.progress.unitEvidence.reason,'snapshot-unavailable');
  assert.equal(state.progress.unitProbeDiagnostics.futureTimestampCount,1);
  assert.equal(state.progress.unitProbeDiagnostics.reason,'current-probe-invalid');
  assert.equal(JSON.stringify(state).includes('sensitive account text'),false);
});

test('volume proof selects the exact epoch grid despite extra bars and raw calendar-date labels',async()=>{
  const base=fixtureBars({end:'2026-11-04T18:00:00Z',turnover:false});
  const rows=base.map(row=>{const timestamp=row.time_key+300000;return{...row,time_key:timestamp,date:Number(newYorkBarTime(timestamp).date.replaceAll('-',''))};});
  const sessionFirst=Date.parse('2026-11-03T23:05:00Z');
  const total=rows.filter(row=>row.time_key>=sessionFirst&&row.time_key<=NOW).reduce((sum,row)=>sum+row.volume,0);
  rows.push({...rows[0],time_key:NOW+300000,date:20261104,volume:999,open:0,close:0,high:0,low:0});
  const env=await environment(),mock=provider(rows),original=mock.dependencies.createQuoteClient;
  mock.dependencies.createQuoteClient=()=>({...original(),snapshots:async()=>[{code:CODE,future_valid:true,volume:total,update_time:NOW,data_date:'2026-11-04'}]});
  const state=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(state.profile.barConvention,'end');assert.equal(state.profile.volumeUnit,'contracts');
  assert.equal(state.profile.volumeEvidence.bracketed,true);assert.equal(state.profile.volumeEvidence.barVolumeSum,total);
  assert.equal(state.profile.volumeEvidence.barCount,(NOW-sessionFirst)/300000+1);
  assert.ok(state.progress.unitProbeDiagnostics.rawBarCount>state.profile.volumeEvidence.barCount);
});

test('cached completed references are reclassified from the exact proof grid without fetching or mutating storage',async()=>{
  const env=await environment(),store=createPrivateStore(env),first=Date.parse('2026-11-03T23:05:00Z'),probe=[];
  for(let timestamp=first;timestamp<=NOW;timestamp+=300000)probe.push({timestamp,volume:10,tradingDate:newYorkBarTime(timestamp).date});
  const total=probe.length*10;
  probe.push({timestamp:first-300000,volume:999,tradingDate:'2026-11-04'},{timestamp:NOW+300000,volume:999,tradingDate:'2026-11-04'});
  const profile={market:'NQ',underlyingCode:CODE,asOf:new Date(NOW-60000).toISOString(),volumeUnit:'unverified',status:'partial',barConvention:'end',
    source:{provider:'Futu OpenAPI'},volumeEvidence:{unit:'unverified'},
    windows:SESSION_WINDOWS.map(row=>({...row,underlyingCode:CODE,sampleCount:20,medianReportedVolume:1234,medianVolumeContracts:null,medianRangePoints:20}))};
  const saved={schemaVersion:1,market:'NQ',underlyingCode:CODE,status:'history-partial',profile,errors:[]};
  const job={market:'NQ',underlyingCode:CODE,createdDate:'2026-11-04',done:true,pages:15,observedBars:6000,
    volumeProbe:{before:{timestamp:NOW-1000,tradingDate:'2026-11-04',volume:total},after:{timestamp:NOW,tradingDate:'2026-11-04',volume:total},bars:probe},
    unitEvidence:{unit:'unverified',reason:'missing-or-incomplete-bars'}};
  await store.put(`${BASE}/state`,saved);await store.put(`${BASE}/job`,job);
  const mock=provider([]),read=await readSessionHistory(env,args);
  const done=await refreshSessionHistory(env,{...args,dependencies:mock.dependencies});
  assert.equal(mock.calls.length,0);assert.equal(read.profile.volumeUnit,'contracts');assert.equal(done.profile.volumeUnit,'contracts');
  assert.equal(read.status,'history-ready');assert.equal(read.profile.status,'ready');
  assert.ok(read.profile.windows.every(row=>row.medianVolumeContracts===1234));
  assert.equal(read.profile.asOf,profile.asOf);assert.deepEqual(read.profile.source,profile.source);
  assert.equal(read.progress.unitEvidence.unit,'contracts');assert.deepEqual((await store.get(`${BASE}/state`)).profile,profile);
  for(const bad of [{...profile,windows:profile.windows.map((row,i)=>i?row:{...row,medianReportedVolume:null})},
    {...profile,underlyingCode:'US.NQ2703'}]){
    await store.put(`${BASE}/state`,{...saved,profile:bad});
    assert.equal((await readSessionHistory(env,args)).profile.volumeUnit,'unverified');
  }
});
