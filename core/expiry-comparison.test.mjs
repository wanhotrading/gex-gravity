import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeHedgingMarket} from './hedging-engine.mjs';
import {compareExpirySensitivity,sampleExpiryComparison} from './expiry-comparison.mjs';
const asOf='2026-11-10T12:00:00Z';
function fixture(extra=[]){
  const base={strike:85,optionType:'call',iv:.5,openInterest:1000,exerciseStyle:'american'};
  const market={market:'CL',contract:'US.CL2612',futuresPrice:85,optionMultiplier:1000,hedgeMultiplier:1000,tickSize:.01,rate:0,rows:[{...base,id:'today',expiry:'2026-11-10T19:30:00Z'},{...base,id:'week',expiry:'2026-11-17T19:30:00Z',openInterest:30000},...extra]};
  return {market,analysis:analyzeHedgingMarket(market,{asOf}),strike:85};
}
test('0DTE and overall share one absolute scale and preserve the narrower own-peak shape',()=>{
  const result=compareExpirySensitivity(fixture());
  assert.equal(result.overall.modeledRows,2);assert.equal(result.zeroDte.modeledRows,1);
  assert.ok(result.zeroDteShare>0&&result.zeroDteShare<.2);
  for(const p of result.chart.points){assert.ok(p.zeroDte<=p.overall+1e-9);assert.ok(p.overall<=result.chart.overallPeak*(1+1e-8));}
  assert.ok(result.zeroDte.peak/result.overall.peak<.2);
  const span=row=>row.transitions.find(t=>t.kind==='fade').price-row.transitions.find(t=>t.kind==='build').price;
  assert.ok(span(result.zeroDte)<span(result.overall));
});
test('unknown expiry/IV and zero OI stay distinct and do not invent a 0DTE contribution',()=>{
  const data=fixture([{id:'unknown',strike:85,optionType:'put',iv:.4,openInterest:10000,expiry:null,exerciseStyle:'american'}]);
  const partial=compareExpirySensitivity(data);assert.equal(partial.unresolvedExpiryRows,1);assert.equal(partial.overall.complete,false);assert.equal(partial.zeroDte.complete,false);
  data.market.rows[0].iv=null;data.analysis=analyzeHedgingMarket(data.market,{asOf});
  const missing=compareExpirySensitivity(data);assert.equal(missing.zeroDte.sensitivity,null);assert.equal(missing.zeroDteShare,null);assert.ok(missing.chart.points.every(p=>p.zeroDte===null));
  data.market.rows[0].iv=.5;data.market.rows[0].openInterest=0;data.analysis=analyzeHedgingMarket(data.market,{asOf});
  const zero=compareExpirySensitivity(data);assert.equal(zero.zeroDte.sensitivity,0);assert.equal(zero.zeroDteShare,0);assert.ok(zero.chart.points.every(p=>p.zeroDte===0));
});
test('scenario clock and IV are applied identically, and a mismatched future is rejected',()=>{
  const data=fixture(),original=JSON.stringify(data.market);
  const a=compareExpirySensitivity(data),b=compareExpirySensitivity({...data,ivScale:1.2,elapsedMinutes:30});
  assert.equal(b.elapsedMinutes,30);assert.equal(b.ivScale,1.2);assert.notEqual(a.overall.peak,b.overall.peak);assert.equal(JSON.stringify(data.market),original);
  assert.equal(compareExpirySensitivity({...data,market:{...data.market,contract:'US.CL2701'}}),null);
  const expired=compareExpirySensitivity({...data,elapsedMinutes:480});assert.equal(expired.zeroDte.sensitivity,0);assert.equal(expired.zeroDte.scenarioExpiredRows,1);assert.equal(expired.zeroDteShare,0);
});

test('shared price sampling matches reference inputs and interpolates each scale without inventing missing values',()=>{
  const result=compareExpirySensitivity(fixture()),reference=sampleExpiryComparison(result,result.chart.snapshotPrice);
  assert.equal(reference.overall,result.overall.sensitivity);assert.equal(reference.zeroDte,result.zeroDte.sensitivity);
  assert.equal(reference.zeroDteShare,result.zeroDteShare);
  const data={chart:{lo:80,hi:90,overallPeak:100,zeroDtePeak:10,points:[{price:80,overall:50,zeroDte:0},{price:85,overall:100,zeroDte:10},{price:90,overall:50,zeroDte:null}]}};
  assert.deepEqual(sampleExpiryComparison(data,82.5),{price:82.5,overall:75,zeroDte:5,overallRatio:.75,zeroDteRatio:.5,zeroDteShare:5/75});
  assert.equal(sampleExpiryComparison(data,87.5).zeroDte,null);
  assert.equal(sampleExpiryComparison(data,85).zeroDte,10);
  assert.equal(sampleExpiryComparison(data,1).price,80);assert.equal(sampleExpiryComparison(data,100).price,90);
  assert.equal(sampleExpiryComparison(data,NaN),null);assert.equal(sampleExpiryComparison({},85),null);
  data.chart.zeroDtePeak=0;data.chart.points.forEach(p=>p.zeroDte=0);
  const zero=sampleExpiryComparison(data,82.5);assert.equal(zero.zeroDte,0);assert.equal(zero.zeroDteShare,0);assert.equal(zero.zeroDteRatio,null);
});
