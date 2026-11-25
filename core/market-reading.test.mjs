import test from 'node:test';
import assert from 'node:assert/strict';
import {contextFreshness,regimeReading,quoteMovement,hedgeReaction,buildMarketCurve,buildOverallSensitivity,buildHedgeFlow,buildHedgeActivity,sampleMarketCurve,nyClock,sensitivityTransitions} from './market-reading.mjs';

test('activity keeps unsigned size separate from net cancellation and locates contiguous half-peak zones',()=>{
 const lens=(key,strike,peak=8)=>({key,strike,sensitivity:peak,slopeAt:x=>peak*Math.exp(-.5*((x-strike)/2)**2),profile:{peak,peakPrice:strike}});
 const short=lens('short',100),long=lens('long',100),sides=new Map([['short','short'],['long','long']]);
 const balanced=buildHedgeActivity([short,long],sides,.25,{lo:90,hi:110});
 assert.equal(balanced.sample(100).gross,4);assert.equal(balanced.sample(100).net,0);
 assert.equal(balanced.amplifying,null);assert.equal(balanced.damping,null);
 assert.equal(balanced.signed.peakBuy.buy,2);assert.equal(balanced.signed.peakSell.sell,2);
 const unsigned=lens('unsigned',100,1000),unknown=buildHedgeActivity([unsigned],sides,1,{lo:90,hi:110});
 assert.equal(unknown.peakGross.gross,1000);assert.equal(unknown.sample(100).net,null);
 assert.equal(unknown.signed,null);assert.equal(unknown.unsignedLevels,1);
 const mixed=buildHedgeActivity([short,unsigned],sides,1,{lo:90,hi:110});
 assert.equal(mixed.sample(100).net,8);assert.equal(mixed.sample(100).gross,1008);
 assert.equal(mixed.unsignedLevels,1);assert.equal(mixed.amplifying.price,100);
 assert.ok(Math.abs(mixed.amplifying.lower-(100-2*Math.sqrt(2*Math.log(2))))<.02);
 assert.ok(Math.abs(mixed.amplifying.upper-(100+2*Math.sqrt(2*Math.log(2))))<.02);
 assert.equal(mixed.amplifying.clipped,false);assert.equal(mixed.damping,null);
 const clipped=buildHedgeActivity([short],sides,1,{lo:99,hi:101});
 assert.equal(clipped.amplifying.clipped,true);assert.equal(clipped.amplifying.lower,99);assert.equal(clipped.amplifying.upper,101);
 assert.equal(buildHedgeActivity([short],sides,0,{lo:90,hi:110}).amplifying,null);
});

test('hedge rates retain absolute size and opposing signs, including a narrow peak outside the chosen curves', () => {
 const lens=(key,strike,width,peak)=>{
   const slopeAt=price=>peak*Math.exp(-.5*((price-strike)/width)**2);
   return {key,strike,sensitivity:slopeAt(100),slopeAt,profile:{peak,peakPrice:strike}};
 };
 const short=lens('short',100.123,.002,8), long=lens('long',100.127,.006,24);
 const unknown=lens('unsigned',100.123,.002,1000);
 const sides=new Map([['short','short'],['long','long']]);
 const flow=buildHedgeFlow([short,long,unknown],sides,.25,{lo:70,hi:130});
 assert.equal(flow.modeledLevels,2);
 assert.equal(flow.peakBuy.price,short.strike);
 assert.equal(flow.peakBuy.buy,2);
 assert.equal(flow.peakSell.price,long.strike);
 assert.equal(flow.peakSell.sell,6);
 assert.ok(flow.sample(short.strike).net<0,'selling can exceed buying at the gross buy peak');
 assert.equal(flow.peakNetBuy.net,0,'a gross buy peak need not produce a net buy peak');
 assert.equal(flow.peakNetSell.price,long.strike);
 const matched=lens('long',short.strike,.002,8);
 const balanced=buildHedgeFlow([short,matched],sides,.25,{lo:70,hi:130});
 assert.equal(balanced.sample(short.strike).net,0);
 assert.equal(balanced.peakNetBuy.net,0);
 assert.equal(balanced.peakNetSell.net,0);
 assert.equal(balanced.peakBuy.buy,2);
 assert.equal(balanced.peakSell.sell,2);
 assert.equal(buildHedgeFlow([unknown],sides,1,{lo:70,hi:130}),null);
});

test('wide windows preserve narrow expiry peaks and interpolate nonuniform prices',()=>{
 const peakPrice=100.123, slopeAt=x=>Math.exp(-.5*((x-peakPrice)/.002)**2);
 const l={key:'near-expiry',strike:100,sensitivity:slopeAt(100),profile:{peak:1,peakPrice,points:[{price:peakPrice-.002},{price:peakPrice},{price:peakPrice+.002}]},slopeAt};
 const c=buildMarketCurve([l],100,1,50);
 assert.equal(c.points.find(p=>p.price===peakPrice).ratios[0],1);
 assert.ok(Math.abs(sampleMarketCurve(c,peakPrice,100)[0]-1)<1e-12);
 assert.ok(sampleMarketCurve(c,peakPrice+.001,100)[0]>.7);
});

test('transition markers locate Gaussian shoulders, not its peak or a signed gamma flip',()=>{
 const points=Array.from({length:241},(_,i)=>{const price=70+i*.25;return {price,ratio:Math.exp(-.5*((price-100)/5)**2)};});
 const result=sensitivityTransitions({points});
 assert.equal(result.length,2);
 assert.ok(Math.abs(result[0].price-95)<=.25);
 assert.ok(Math.abs(result[1].price-105)<=.25);
 assert.ok(result[0].percentagePointsPerPoint>0);
 assert.ok(result[1].percentagePointsPerPoint<0);
 assert.ok(result.every(t=>t.ratio>.5&&t.ratio<.7));
 assert.equal(result[0].resolution,.25);
});
test('transition markers suppress flat, invalid and unresolved edge slopes',()=>{
 assert.deepEqual(sensitivityTransitions(null),[]);
 assert.deepEqual(sensitivityTransitions({points:Array.from({length:21},(_,i)=>({price:i+1,ratio:.5}))}),[]);
 assert.deepEqual(sensitivityTransitions({points:Array.from({length:21},(_,i)=>({price:i+1,ratio:(i/20)**2}))}),[]);
 assert.deepEqual(sensitivityTransitions({points:Array.from({length:21},(_,i)=>({price:1,ratio:i/20}))}),[]);
});
const NOW=Date.parse('2026-11-05T15:00:00Z');
const context={levels:[{}],mode:'Intraday',sourceDate:'2026-11-05',asOf:'2026-11-05T14:35:00Z',delayStatus:'delayed',lastCheckedAt:new Date(NOW).toISOString()};
test('freshness respects New York daylight time, delay and check age; capture is not source time',()=>{
 assert.equal(nyClock(Date.parse('2026-07-06T13:35:00Z')).minute,575);
 assert.equal(nyClock(Date.parse('2026-11-05T14:35:00Z')).minute,575);
 assert.equal(contextFreshness(context,NOW).state,'delayed');
 assert.equal(contextFreshness({...context,asOf:null},NOW).state,'unverified');
 assert.equal(contextFreshness({...context,lastCheckedAt:'2026-11-05T14:45:00Z'},NOW).state,'stale');
 assert.equal(contextFreshness({...context,sourceDate:'2026-11-04'},NOW).usable,false);
 assert.equal(contextFreshness(context,Date.parse('2026-11-05T21:05:00Z')).state,'reference');
});
test('regime sign requires an explicit all-expiry total, never put support or unsigned gamma',()=>{
 assert.equal(regimeReading({...context,levels:[{labels:['Put Support'],gex:-1}]},NOW).sign,'unknown');
 for(const [netGex,sign,side]of [[-1,'negative','short'],[1,'positive','long'],[0,'zero',null]]){
  const r=regimeReading({...context,regime:{netGex,scope:'all-expiries',mode:'Intraday',sourceDate:context.sourceDate,asOf:context.asOf,delayStatus:'delayed',capturedAt:context.lastCheckedAt}},NOW);
  assert.equal(r.sign,sign);assert.equal(r.side,side);assert.equal(r.current,true);
 }
});
test('short gamma reinforces both directions; long gamma opposes them; unknown is not bullish',()=>{
 assert.equal(hedgeReaction('short',-10),'sell');assert.equal(hedgeReaction('short',10),'buy');
 assert.equal(hedgeReaction('long',-10),'buy');assert.equal(hedgeReaction('long',10),'sell');
 assert.equal(hedgeReaction(null,-10),'unknown');assert.equal(hedgeReaction('short',0),'flat');
});
test('movement excludes stale, out-of-order, different-month and overnight comparisons',()=>{
 const m={underlyingCode:'US.NQ2612',underlyingPrice:20001,priceTimestamp:new Date(NOW).toISOString(),previousPriceObservation:{underlyingCode:'US.NQ2612',price:20000,asOf:new Date(NOW-300000).toISOString()}};
 assert.equal(quoteMovement(m,NOW).change,1);
 assert.equal(quoteMovement({...m,previousPriceObservation:{...m.previousPriceObservation,underlyingCode:'US.NQ2703'}},NOW),null);
 assert.equal(quoteMovement(m,NOW+21*60000),null);
 assert.equal(quoteMovement({...m,priceTimestamp:m.previousPriceObservation.asOf},NOW),null);
});
test('multi-strike curve preserves absolute relative strengths and includes all modeled curves in total',()=>{
 const a={key:'100',strike:100,sensitivity:2,profile:{peak:2},slopeAt:x=>2*Math.exp(-(((x-100)/5)**2))};
 const b={key:'105',strike:105,sensitivity:Math.exp(-1),profile:{peak:1},slopeAt:x=>Math.exp(-(((x-105)/5)**2))};
 const c=buildMarketCurve([a,b,{key:'90',strike:90,sensitivity:null}],100,1);
 assert.equal(c.modeledLevels,2);assert.equal(c.totalLevels,3);
 assert.ok(Math.abs(c.totalAtPrice-(2+Math.exp(-1)))<1e-10);
 assert.ok(c.peak.total>c.weak.total);assert.equal(buildMarketCurve([],100,1),null);
});

test('combined build and fade use absolute sensitivity across all eligible strikes, including off-chart strikes',()=>{
  const lenses=Array.from({length:10},(_,i)=>{
    const strike=100+i,peak=i===9?100:1;
    const slopeAt=price=>peak*Math.exp(-.5*((price-strike)/2)**2);
    return {key:String(strike),strike,slopeAt,sensitivity:slopeAt(100),profile:{peak,peakPrice:strike,
      points:Array.from({length:101},(_,j)=>({price:strike-10+j/5}))}};
  });
  lenses.push({key:'local',strike:100,sensitivity:10000,method:'reported-linear'});
  const chart=buildMarketCurve(lenses,100,1,5);
  assert.ok(!chart.chosen.some(lens=>lens.strike===109));
  const overall=buildOverallSensitivity(lenses,100);
  assert.equal(overall.modeledLevels,10);
  assert.equal(overall.totalLevels,11);
  assert.equal(overall.slopeAt(100),chart.totalAtPrice);
  assert.ok(overall.peakPrice>108.5);
  const transitions=sensitivityTransitions(overall);
  assert.ok(Math.abs(transitions.find(t=>t.kind==='build').price-107)<.5);
  assert.ok(Math.abs(transitions.find(t=>t.kind==='fade').price-111)<.5);
});
test('each strike uses its own full-profile peak; zoom and OI size do not change fade',()=>{
 const make=(key,size)=>({key,strike:110,sensitivity:size*Math.exp(-4),profile:{peak:size},slopeAt:x=>size*Math.exp(-(((x-110)/5)**2))});
 const lenses=[make('small',1),make('large',1000),{...make('unknown',1),profile:{}}];
 const narrow=buildMarketCurve(lenses,100,1,2),wide=buildMarketCurve(lenses,100,1,20);
 assert.equal(narrow.modeledLevels,2);
 assert.deepEqual(narrow.currentRatios,wide.currentRatios);
 assert.ok(Math.abs(narrow.currentRatios[0]-Math.exp(-4))<1e-12);
 assert.ok(Math.abs(narrow.currentRatios[0]-narrow.currentRatios[1])<1e-12);
 assert.ok(Math.max(...narrow.points.map(p=>p.ratios[0]))<.1);
 assert.ok(Math.abs(Math.max(...wide.points.map(p=>p.ratios[0]))-1)<1e-12);
 assert.equal(buildMarketCurve([{...make('zero',1),profile:{peak:0}}],100,1),null);
});

test('the price probe follows both plotted curves and restores the exact snapshot', () => {
 const curve = {lo: 100, hi: 120, currentRatios: [.875, .125], points: [
   {ratios: [1, 0]}, {ratios: [.5, .5]}, {ratios: [0, 1]},
 ]};
 assert.deepEqual(sampleMarketCurve(curve, 105, 103), [.75, .25]);
 assert.deepEqual(sampleMarketCurve(curve, 115, 103), [.25, .75]);
 assert.deepEqual(sampleMarketCurve(curve, 103, 103), [.875, .125]);
 assert.deepEqual(sampleMarketCurve(curve, 99, 103), [1, 0]);
 assert.deepEqual(sampleMarketCurve(curve, 121, 103), [0, 1]);
});

test('panning moves only the observation range and retains exact saved-price sensitivity',()=>{
 const lenses=[{key:'100',strike:100,sensitivity:1,profile:{peak:1},slopeAt:x=>Math.exp(-.5*((x-100)/5)**2)}];
 const base=buildMarketCurve(lenses,100,1,10,'100');
 const panned=buildMarketCurve(lenses,100,1,10,'100',120);
 assert.equal(base.lo,90);assert.equal(base.hi,110);
 assert.equal(panned.lo,110);assert.equal(panned.hi,130);assert.equal(panned.center,120);
 assert.deepEqual(panned.currentRatios,base.currentRatios);
 assert.equal(panned.totalAtPrice,base.totalAtPrice);
 assert.deepEqual(sampleMarketCurve(panned,100,100),[1]);
 assert.equal(buildMarketCurve(lenses,100,1,10,'100',-3).center,100);
});

test('a fully faded panned window stays navigable instead of removing the chart',()=>{
 const l={key:'100',strike:100,sensitivity:1,profile:{peak:1},slopeAt:x=>x===100?1:0};
 const c=buildMarketCurve([l],100,1,5,'100',150);
 assert.ok(c);assert.equal(c.max,0);assert.equal(c.currentRatios[0],1);
});
