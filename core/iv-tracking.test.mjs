import test from 'node:test';
import assert from 'node:assert/strict';
import {selectIvContracts,mergeIvObservation,publicIvRow,IV_HISTORY_LIMIT} from './iv-tracking.mjs';

const NOW=Date.parse('2026-11-04T18:00:00Z');
const metadata={code:'US.Q1C2611P28750x0',underlyingCode:'US.NQ2612',strike:28750,expiryDate:'2026-11-04',optionType:'put'};
const quote=(iv,asOf=NOW)=>({optionValid:true,iv,quoteAsOf:new Date(asOf).toISOString(),delta:0,gamma:0,openInterest:0,bid:0,ask:0});
const market={underlyingCode:'US.NQ2612',contracts:[{...metadata,optionType:'PUT',expiryTimestamp:'2026-11-04T21:00:00Z'}]};
const request={market:'NQ',underlyingCode:'US.NQ2612',codes:[metadata.code],allowedStrikes:[28750],now:NOW};

test('selection requires saved watched strikes, exact underlying and nonexpired series',()=>{
  assert.equal(selectIvContracts(market,request)[0].optionType,'put');
  for(const changes of [{allowedStrikes:[]},{allowedStrikes:[28000]},{underlyingCode:'US.NQ2703'},{codes:[metadata.code,metadata.code]},{codes:Array(400).fill('US.X').map((code,index)=>code+index)},{now:NOW+4*3600000}])
    assert.throws(()=>selectIvContracts(market,{...request,...changes}));
});

test('first observation has no invented previous comparison and preserves reported zeros',()=>{
  const row=publicIvRow(mergeIvObservation(null,metadata,quote(.5),NOW),NOW);
  assert.equal(row.iv,.5);assert.equal(row.delta,0);assert.equal(row.gamma,0);assert.equal(row.openInterest,0);
  assert.equal(row.ivChangePoints,null);assert.equal(row.previousIv,null);assert.equal(row.baselineChangePoints,0);
  assert.equal(row.ivTimestamp,null);assert.equal(row.greeksTimestamp,null);assert.equal(row.delayStatus,'unverified');
});

test('advancing quote compares same contract in IV percentage points and relative percent',()=>{
  const first=mergeIvObservation(null,metadata,quote(.5),NOW);
  const second=mergeIvObservation(first,metadata,quote(.51,NOW+60000),NOW+60000);
  const row=publicIvRow(second,NOW+90000);
  assert.ok(Math.abs(row.ivChangePoints-1)<1e-10);assert.ok(Math.abs(row.ivChangePercent-2)<1e-10);
  assert.equal(row.previousIv,.5);assert.equal(row.ivHistory.length,2);assert.equal(row.quoteAgeSeconds,30);
});

test('duplicate, regressed, missing and future snapshots retain baseline and current readings',()=>{
  const first=mergeIvObservation(null,metadata,quote(.5),NOW);
  for(const [candidate,status]of [[quote(.5),'no-newer-quote'],[quote(.6,NOW-60000),'older-quote-retained'],[null,'snapshot-unavailable'],[quote(.6,NOW+3600000),'future-quote-time'],[{...quote(.6),quoteAsOf:null},'quote-time-unavailable'],[quote(0),'iv-unavailable']]){
    const result=mergeIvObservation(first,metadata,candidate,NOW+60000);
    assert.equal(result.current.iv,.5);assert.equal(result.observationStatus,status);assert.equal(result.history.length,1);
  }
});

test('same-time IV revisions are identified without fabricating a new calculation time',()=>{
  const first=mergeIvObservation(null,metadata,quote(.5),NOW);
  const second=mergeIvObservation(first,metadata,quote(.6),NOW+60000);
  assert.equal(second.current.iv,.5);assert.equal(second.observationStatus,'same-quote-time-revision');
  assert.equal(second.lastObservedRevision.iv,.6);assert.equal(second.previous,null);assert.equal(second.history.length,1);
});

test('new source day resets its first-observed baseline; bounded history remains exact',()=>{
  let record=mergeIvObservation(null,metadata,quote(.5),NOW);
  for(let index=1;index<40;index++)record=mergeIvObservation(record,metadata,quote(.5+index/10000,NOW+index*60000),NOW+index*60000);
  assert.equal(record.history.length,IV_HISTORY_LIMIT);assert.equal(record.baseline.iv,.5);
  record=mergeIvObservation(record,metadata,quote(.6,NOW+86400000),NOW+86400000);
  assert.equal(record.baseline.iv,.6);assert.equal(publicIvRow(record,NOW+86400000).baselineChangePoints,0);
  assert.equal(publicIvRow(record,NOW+86400000+10*60000).quoteTimeStatus,'stale');
});
