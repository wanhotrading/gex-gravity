import test from 'node:test';
import assert from 'node:assert/strict';
import {renderExpiryComparison,bindExpiryComparison} from './expiry-comparison-view.mjs';
import {compareExpirySensitivity} from '../core/expiry-comparison.mjs';
import {analyzeHedgingMarket} from '../core/hedging-engine.mjs';
test('comparison shows absolute magnitude, separately normalized shape, coverage and source scope',()=>{
  const market={market:'CL',contract:'US.CL2612',futuresPrice:85,optionMultiplier:1000,hedgeMultiplier:1000,tickSize:.01,rows:[{id:'today',strike:85,optionType:'call',iv:.5,openInterest:100,expiry:'2026-11-10T19:30:00Z',exerciseStyle:'american'},{id:'later',strike:85,optionType:'put',iv:.5,openInterest:30000,expiry:'2026-11-17T19:30:00Z',exerciseStyle:'american'}]};
  const analysis=analyzeHedgingMarket(market,{asOf:'2026-11-10T12:00:00Z'}),data=compareExpirySensitivity({market,analysis,strike:85});
  const html=renderExpiryComparison(data,{underlyingCode:market.contract});
  assert.match(html,/data-compare-slider/);assert.equal((html.match(/data-compare-hit/g)||[]).length,2);assert.match(html,/Back to reference/);assert.match(html,/Values between sampled prices are interpolated/);
  assert.match(html,/data-compare-strike="85"/);assert.match(html,/Size · same absolute scale/);assert.match(html,/Shape · each curve’s own peak/);assert.match(html,/2 modeled · 0 excluded/);assert.match(html,/1 modeled · 0 excluded/);assert.match(html,/equivalent futures per \$1\/bbl move/);assert.match(html,/0DTE dealer gamma sign remain unknown/);assert.doesNotMatch(html,/NaN|undefined/);
  const unavailable=renderExpiryComparison({...data,zeroDte:{...data.zeroDte,sensitivity:null,peak:null},zeroDteShare:null,chart:null},{underlyingCode:market.contract});assert.match(unavailable,/Unavailable/);assert.doesNotMatch(unavailable,/NaN|undefined/);
});

// A small DOM boundary fixture exercises the shared interaction state and SVG updates.
function element(dataset={}){
  return {dataset,attrs:{},handlers:{},nodes:{},lists:{},textContent:'',value:'',
    setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,h){this.handlers[k]=h;},
    querySelector(k){return this.nodes[k];},querySelectorAll(k){return this.lists[k]??[];},
    getBoundingClientRect(){return {left:100,width:200};}};
}
function harness(data,prefs){
  const panel=element(),slider=element(),reset=element();
  panel.nodes['[data-compare-slider]']=slider;panel.nodes['[data-compare-reset]']=reset;
  const fields=['price','status','overall','zero','share','overall-ratio','zero-ratio','overall-change','zero-change'];
  for(const field of fields)panel.nodes[`[data-compare-${field}]`]=element();
  panel.lists['[data-compare-price-kind]']=[element(),element()];
  const plots=['size','shape'].map(kind=>{
    const plot=element({comparePlot:kind});
    for(const selector of ['[data-compare-cursor]','[data-compare-plot-label]','[data-compare-hit]','[data-compare-dot="overall"]','[data-compare-dot="zeroDte"]'])plot.nodes[selector]=element();
    return plot;
  });
  panel.lists['[data-compare-plot]']=plots;
  bindExpiryComparison({querySelector:()=>panel},data,prefs);
  return {panel,slider,reset,plots,read:field=>panel.nodes[`[data-compare-${field}]`].textContent,
    hit:(i,event,args)=>plots[i].nodes['[data-compare-hit]'].handlers[event](args)};
}
const interactiveData=()=>({contract:'US.CL2612',strike:85,chart:{lo:80,hi:90,snapshotPrice:85,overallPeak:100,zeroDtePeak:10,
  points:[{price:80,overall:50,zeroDte:0},{price:85,overall:100,zeroDte:10},{price:90,overall:50,zeroDte:0}]}});

test('either chart links both crosshairs, absolute values and own-peak percentages; slider and reset share that state',()=>{
  const prefs={},ui=harness(interactiveData(),prefs);
  assert.match(ui.read('status'),/^Reference price/);assert.equal(ui.read('share'),'10%');
  ui.hit(0,'pointermove',{clientX:150,pointerType:'mouse'});
  assert.equal(prefs.comparisonProbe.price,82.5);assert.equal(ui.read('overall'),'75');assert.equal(ui.read('zero'),'5');
  assert.equal(ui.read('share'),'6.67%');assert.equal(ui.read('zero-ratio'),'50% of own peak');assert.equal(ui.read('overall-change'),'−25% vs reference');
  assert.equal(ui.plots[0].nodes['[data-compare-cursor]'].attrs.x1,ui.plots[1].nodes['[data-compare-cursor]'].attrs.x1);
  assert.notEqual(ui.plots[0].nodes['[data-compare-dot="zeroDte"]'].attrs.cy,ui.plots[1].nodes['[data-compare-dot="zeroDte"]'].attrs.cy);
  ui.hit(1,'click',{clientX:260});assert.equal(prefs.comparisonProbe.price,88);
  ui.hit(0,'pointermove',{clientX:120,pointerType:'touch'});assert.equal(prefs.comparisonProbe.price,88);
  ui.slider.value='1000';ui.slider.handlers.input();assert.equal(prefs.comparisonProbe.price,90);assert.equal(ui.read('zero'),'0');
  assert.match(ui.slider.attrs['aria-valuetext'],/90 · price scenario/);
  ui.reset.handlers.click();assert.equal(prefs.comparisonProbe,null);assert.equal(ui.read('price'),'85');assert.equal(ui.slider.value,'500');
  assert.ok(ui.plots.every(plot=>plot.nodes['[data-compare-cursor]'].attrs.visibility==='hidden'));
});

test('comparison probe survives refresh for its strike, resets on new strike or future, and follows new references after reset',()=>{
  const data=interactiveData(),prefs={},first=harness(data,prefs);first.hit(1,'click',{clientX:260});
  assert.equal(harness({...data,chart:{...data.chart,snapshotPrice:86}},prefs).read('price'),'88');
  assert.equal(harness({...data,strike:90},prefs).read('price'),'85');assert.equal(prefs.comparisonProbe,null);
  first.hit(1,'click',{clientX:260});assert.equal(harness({...data,contract:'US.CL2701'},prefs).read('price'),'85');
  first.reset.handlers.click();assert.equal(harness({...data,chart:{...data.chart,snapshotPrice:86}},prefs).read('price'),'86');
});

test('unavailable and true-zero 0DTE readings remain distinct during price exploration',()=>{
  const missing=interactiveData();missing.chart.zeroDtePeak=null;missing.chart.points.forEach(p=>p.zeroDte=null);
  const ui=harness(missing,{});ui.hit(1,'click',{clientX:260});
  assert.equal(ui.read('zero'),'Unavailable');assert.equal(ui.read('share'),'Unavailable');
  assert.ok(ui.plots.every(plot=>plot.nodes['[data-compare-dot="zeroDte"]'].attrs.visibility==='hidden'));
  const zero=interactiveData();zero.chart.zeroDtePeak=0;zero.chart.points.forEach(p=>p.zeroDte=0);
  const zi=harness(zero,{});zi.hit(0,'click',{clientX:260});
  assert.equal(zi.read('zero'),'0');assert.equal(zi.read('share'),'0%');assert.equal(zi.read('zero-ratio'),'No active curve');
  assert.equal(zi.plots[1].nodes['[data-compare-dot="zeroDte"]'].attrs.visibility,'hidden');
  bindExpiryComparison({},null,{});
});
