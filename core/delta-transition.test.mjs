import test from 'node:test';
import assert from 'node:assert/strict';
import {deltaTransitionRange} from './delta-transition.mjs';
import {greeks} from './engine.mjs';
const base={futuresPrice:7500,strike:7500,iv:.15,timeYears:6/(365*24),optionType:'call',exerciseStyle:'european',rate:0};
test('individual delta endpoints recover actual signed delta for ES, NQ and CL scales',()=>{
  for(const [strike,iv]of [[7500,.15],[28000,.2],[85,.35]])for(const optionType of ['call','put'])for(const tail of [.05,.01]){
    const input={...base,strike,futuresPrice:strike,iv,optionType},r=deltaTransitionRange(input,{tail});
    assert.ok(r.lower.price<strike&&r.upper.price>strike);
    assert.ok(Math.abs(greeks({...input,futuresPrice:r.lower.price}).delta-r.lower.targetDelta)<1e-8);
    assert.ok(Math.abs(greeks({...input,futuresPrice:r.upper.price}).delta-r.upper.targetDelta)<1e-8);
    assert.ok(r.lower.deltaChange<0&&r.upper.deltaChange>0);
  }
  const es=deltaTransitionRange(base);assert.ok(Math.abs(es.lower.distance+48.3301588)<1e-5);assert.ok(Math.abs(es.upper.distance-48.5272884)<1e-5);
});
test('IV/time change endpoint width, snapshot price only changes distance and already-beyond state',()=>{
  const initial=deltaTransitionRange(base),wide=deltaTransitionRange({...base,iv:.3}),later=deltaTransitionRange({...base,timeYears:base.timeYears*4});
  assert.ok(wide.upper.distance>initial.upper.distance*1.9);assert.equal(wide.upper.price,later.upper.price);
  const moved=deltaTransitionRange({...base,futuresPrice:initial.upper.price+1});
  assert.equal(moved.upper.price,initial.upper.price);assert.ok(moved.upper.alreadyBeyond);assert.ok(moved.upper.distance<0);
});
test('discounted deltas are solved without normalizing away the rate; unreachable endpoints stay unavailable',()=>{
  const input={...base,timeYears:1,rate:.1},r=deltaTransitionRange(input);
  assert.equal(r.upper.price,null);assert.match(r.upper.reason,/discounted/);
  assert.ok(Math.abs(greeks({...input,futuresPrice:r.lower.price}).delta-.05)<1e-8);
  assert.equal(deltaTransitionRange({...input,optionType:'put'}).lower.price,null);
});
test('American model is retained, including early-exercise numerical crossings',()=>{
  for(const optionType of ['call','put'])for(const rate of [0,.05]){
    const input={...base,futuresPrice:85,strike:85,iv:.35,exerciseStyle:'american',optionType,rate,timeYears:2/365};
    const r=deltaTransitionRange(input);assert.equal(r.model.model,'American futures CRR');
    for(const b of [r.lower,r.upper]){assert.ok(b.price>0);assert.ok(Math.abs(greeks({...input,futuresPrice:b.price}).delta-b.targetDelta)<.001);}
  }
});
test('expired and invalid model inputs never create plausible endpoints',()=>{
  assert.equal(deltaTransitionRange({...base,timeYears:0}).status,'expired');
  assert.throws(()=>deltaTransitionRange({...base,iv:null}));assert.throws(()=>deltaTransitionRange(base,{tail:.2}));
});
