import test from 'node:test';
import assert from 'node:assert/strict';
import {renderIvSurface,projectIvPoint} from './iv-surface-view.mjs';
const time='2026-11-06T19:30:00Z';
const root=()=>({innerHTML:'',handlers:{},addEventListener(n,f){this.handlers[n]=f;}});
const props={now:Date.parse(time),selectedStrike:'100',market:{underlyingCode:'US.NQ2612',underlyingPrice:100,priceTimestamp:time,collectedAt:time},rows:[98,100,102].flatMap(strike=>[0,1].map(e=>({code:`${strike}-${e}`,underlyingCode:'US.NQ2612',strike,optionType:strike<100?'PUT':'CALL',iv:.2+e*.02,quoteTimestamp:time,expiryTimestamp:e?'2026-11-09T21:00:00Z':'2026-11-06T21:00:00Z'})))};
test('surface provides numeric marker, expiry slice, keyboard selection and explicit source limitations',()=>{
 const r=root();renderIvSurface(r,props);assert.match(r.innerHTML,/6 observed points/);assert.match(r.innerHTML,/data-iv-field="strike"/);assert.match(r.innerHTML,/20%/);assert.match(r.innerHTML,/One expiry/);assert.match(r.innerHTML,/not an arbitrage-free fit/);assert.doesNotMatch(r.innerHTML,/NaN|undefined/);
 assert.equal(r._ivView.selected.strike,100);
});
test('empty surface stays empty with no invented numerical values',()=>{
 const r=root();renderIvSurface(r,{});assert.match(r.innerHTML,/No eligible IV points/);assert.doesNotMatch(r.innerHTML,/NaN|undefined/);assert.equal(r._ivView.surface.points.length,0);
});
test('pinned comparison is isolated by exact future and holds back changes without a newer quote',()=>{
 const r=root();renderIvSurface(r,props);
 r.handlers.click({target:{closest:s=>s==='[data-iv-action]'?{dataset:{ivAction:'pin'}}:null}});
 assert.ok(r._ivView.s.baseline);assert.match(r.innerHTML,/No newer source quote/);
 r.handlers.change({target:{dataset:{ivField:'mode'},value:'change'}});assert.match(r.innerHTML,/strictly newer source quotes|newer quotes for the same option/);
 renderIvSurface(r,{...props,market:{...props.market,underlyingCode:'US.ES2612'},rows:[]});assert.equal(r._ivView.s.baseline,null);
});
test('projection changes viewpoint without changing the surface data',()=>{
 const a=projectIvPoint(10,20,30,{angle:0,tilt:40}),b=projectIvPoint(10,20,30,{angle:30,tilt:40});
 assert.equal(a.x,460);assert.equal(a.y,330);assert.notEqual(a.x,b.x);assert.ok(Number.isFinite(b.y));
});
test('clicking a dot selects it even when drag capture retargets the subsequent click',()=>{
 const r=root();renderIvSurface(r,props);
 const target={closest:selector=>selector==='[data-iv-point]'?{dataset:{ivPoint:'102-1'}}:selector==='.iv-surface-svg'?{}:null};
 r.handlers.pointerdown({target,button:0,clientX:10,clientY:20,pointerId:1});
 r.handlers.pointerup({type:'pointerup',pointerId:1});
 assert.equal(r._ivView.selected.code,'102-1');
 r.handlers.click({target:{closest:()=>null}});assert.equal(r._ivView.selected.code,'102-1');
});
