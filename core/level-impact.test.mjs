import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeHedgingMarket} from './hedging-engine.mjs';
import {createLevelLens,rankLevelLenses,compareLevelHistory} from './level-impact.mjs';
const asOf='2026-11-05T15:00:00Z';
function make(overrides={}){
 const row={id:'put',strike:100,optionType:'put',expiry:'2026-11-05T21:00:00Z',expiryDate:'2026-11-05',expiryTimeZone:'America/New_York',iv:.3,openInterest:1000,exerciseStyle:'european',underlyingCode:'US.TEST',quoteTimestamp:asOf,greeksBasis:'futures-price',...overrides};
 const market={market:'NQ',contract:'US.TEST',currency:'USD',futuresPrice:100,optionMultiplier:20,hedgeMultiplier:20,tickSize:.25,rate:0,rows:[row]};
 return {market,analysis:analyzeHedgingMarket(market,{asOf}),strike:100};
}
test('short gamma buys rises and sells falls; long gamma reverses signs',()=>{
 const lens=createLevelLens(make());assert.ok(lens.flow(101).change>0);assert.ok(lens.flow(99).change<0);assert.equal(lens.flow(101,'long').change,-lens.flow(101,'short').change);
 assert.equal(lens.flow(100).change,0);assert.ok(lens.flow(101).shortCovered>0);assert.ok(lens.flow(99).shortAdded>0);
});
test('normalization is linear, bounded and not a price-impact prediction',()=>{
 const lens=createLevelLens(make());assert.equal(lens.flow(101,'short',.25).change,lens.flow(101).change/4);assert.equal(lens.flow(101,'short',0).change,0);
 assert.equal(lens.flow(101,'short',1.1),null);assert.equal(lens.flow(0),null);assert.equal(lens.flow(101).priceImpact,undefined);
 assert.ok(Math.abs(lens.flow(1000).change)<=1000);assert.ok(Math.abs(lens.flow(1).change)<=1000);
});
test('combined calls and puts add unsigned gamma, not offset it',()=>{
 const data=make(),single=createLevelLens(data);data.market.rows.push({...data.market.rows[0],id:'call',optionType:'call'});data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const both=createLevelLens(data);assert.ok(Math.abs(both.sensitivity-2*single.sensitivity)<1e-9);assert.ok(Math.abs(both.flow(101).change-2*single.flow(101).change)<1e-9);
});
test('fade thresholds match aggregate gamma across multiple expiries',()=>{
 const data=make();data.market.rows.push({...data.market.rows[0],id:'later',expiry:'2026-12-05T21:00:00Z',iv:.22,openInterest:3500});data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const lens=createLevelLens(data);for(const band of lens.profile.bands){for(const price of [band.lower,band.upper])assert.ok(Math.abs(lens.slopeAt(price)/lens.profile.peak-band.fraction)<1e-7);}
 assert.ok(lens.profile.bands[2].lower<lens.profile.bands[0].lower);assert.ok(lens.profile.bands[2].upper>lens.profile.bands[0].upper);
});
test('higher IV broadens near-expiry profile and reprices delta at the same price',()=>{
 const data=make(),base=createLevelLens(data),high=createLevelLens({...data,ivScale:1.2});
 assert.ok(high.profile.bands[0].upper-high.profile.bands[0].lower>base.profile.bands[0].upper-base.profile.bands[0].lower);
 const f=high.flow(100);assert.equal(f.priceOnly,0);assert.equal(f.change,f.ivContribution);assert.notEqual(f.change,0);
});
test('American style is modeled directly while unresolved clocks remain unavailable',()=>{
 const missing=createLevelLens(make({expiry:null}));assert.equal(missing.profile,null);assert.equal(missing.sensitivity,null);assert.equal(missing.excludedRows,1);
 const american=createLevelLens(make({exerciseStyle:'american'}));assert.ok(american.profile);assert.equal(american.americanApproximation,false);assert.equal(american.americanStyle,true);
 const unresolved=createLevelLens(make({exerciseStyle:'american',expiry:null}));assert.equal(unresolved.profile,null);assert.equal(unresolved.americanStyle,true);
 const approximate=createLevelLens(make({exerciseStyle:'american',allowEuropeanApproximation:true}));assert.equal(approximate.americanApproximation,true);
});
test('expired series excluded; missing series remain visible as partial coverage',()=>{
 const expired=createLevelLens(make({expiry:'2026-11-04T21:00:00Z'}));assert.equal(expired.expiredRows,1);assert.equal(expired.sensitivity,null);
 const partial=createLevelLens({...make(),expectedRows:3});assert.equal(partial.complete,false);assert.equal(partial.excludedRows,2);
});
test('zero OI stays zero, unavailable stays unavailable, rankings use known model only',()=>{
 const zero=createLevelLens(make({openInterest:0})),missing=createLevelLens(make({openInterest:null})),full=createLevelLens(make());
 assert.equal(zero.sensitivity,0);assert.equal(zero.profile,null);assert.equal(missing.sensitivity,null);
 const ranked=rankLevelLenses([zero,missing,full]);assert.equal(ranked[0].shareOfWatched,1);assert.equal(ranked[1].shareOfWatched,0);assert.equal(ranked[2].shareOfWatched,null);
});
test('window comparisons reject another future and unverified volume units',()=>{
 const profile={underlyingCode:'US.NQ2612',volumeUnit:'unverified',windows:[{id:'opening',sampleCount:20,medianVolumeContracts:1000,medianRangePoints:100}]};
 assert.equal(compareLevelHistory({profile,underlyingCode:'US.ES2612',windowId:'opening',flow:100}),null);
 assert.equal(compareLevelHistory({profile,underlyingCode:'US.NQ2612',windowId:'opening',flow:100}).flowShare,null);
 profile.volumeUnit='contracts';assert.equal(compareLevelHistory({profile,underlyingCode:'US.NQ2612',windowId:'opening',flow:100}).flowShare,.1);
});
test('reported fallback provides only bounded local flow and cannot invent fade or IV repricing',()=>{
 const data=make({expiry:null,delta:-.4,gamma:.1}),lens=createLevelLens(data);
 assert.equal(lens.method,'reported-linear');assert.equal(lens.profile,null);assert.equal(lens.sensitivity,100);
 assert.ok(Math.abs(lens.flow(100.05).change-5)<1e-9);assert.equal(lens.flow(102),null);
 assert.equal(createLevelLens({...data,ivScale:1.2}).flow,undefined);
 const bounded=createLevelLens(make({expiry:null,delta:-.999,gamma:.1}));assert.equal(bounded.flow(99.95),null);
});

test('0DTE means active exact expiry on the snapshot New York date, not the next 24 hours',()=>{
 const data=make();
 data.market.rows.push({...data.market.rows[0],id:'tomorrow',expiry:'2026-11-06T14:00:00Z'});
 data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const all=createLevelLens(data),today=createLevelLens({...data,expiryScope:'0dte'}),later=createLevelLens({...data,expiryScope:'later'});
 assert.equal(all.expiryCoverage.zeroDteRows,1);assert.equal(all.expiryCoverage.laterRows,1);
 assert.equal(today.modeledRows,1);assert.equal(later.modeledRows,1);assert.equal(today.complete,true);assert.equal(later.complete,true);
 assert.equal(today.expiryCoverage.nearestMinutes,360);
 assert.ok(Math.abs(all.sensitivity-today.sensitivity-later.sensitivity)<1e-9);
 assert.equal(all.expiryCoverage.zeroDteSensitivity,today.sensitivity);
 assert.equal(all.expiryCoverage.totalSensitivity,all.sensitivity);
});

test('0DTE uses New York calendar across UTC rollover and daylight-saving transition',()=>{
 for(const [snapshot,expiry,zero] of [
   ['2026-07-10T23:30:00Z','2026-07-11T02:00:00Z',true],
   ['2026-11-07T00:30:00Z','2026-11-07T03:00:00Z',true],
   ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z',true],
   ['2026-11-07T03:30:00Z','2026-11-07T05:30:00Z',false],
 ]) {
   const data=make({expiry,quoteTimestamp:snapshot});data.analysis=analyzeHedgingMarket(data.market,{asOf:snapshot});
   const lens=createLevelLens({...data,expiryScope:'0dte'});
   assert.equal(lens.expiryCoverage.zeroDteRows,Number(zero));assert.equal(lens.modeledRows,Number(zero));
 }
});

test('unknown clocks stay excluded in isolated slices and date labels cannot supply 0DTE curves',()=>{
 const data=make();data.market.rows.push({...data.market.rows[0],id:'unknown',expiry:null,delta:-.5,gamma:.1});
 data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const today=createLevelLens({...data,expiryScope:'0dte',expectedRows:3});
 assert.equal(today.expiryCoverage.unknownRows,1);assert.equal(today.modeledRows,1);assert.equal(today.excludedRows,2);assert.equal(today.complete,false);
 const onlyUnknown=createLevelLens({...make({expiry:null,delta:-.5,gamma:.1}),expiryScope:'0dte'});
 assert.equal(onlyUnknown.profile,null);assert.equal(onlyUnknown.sensitivity,null);assert.equal(onlyUnknown.flow,undefined);
 const timeUnknown=createLevelLens({...make({expiry:null,delta:-.5,gamma:.1}),elapsedMinutes:5});
 assert.equal(timeUnknown.flow,undefined);assert.equal(timeUnknown.sensitivity,null);
});

test('time scenario concentrates ATM gamma but collapses distant-strike gamma',()=>{
 const data=make({expiry:'2026-11-05T16:00:00Z'}),now=createLevelLens(data),nearExpiry=createLevelLens({...data,elapsedMinutes:55});
 assert.ok(nearExpiry.sensitivity>now.sensitivity*3);
 assert.ok(nearExpiry.profile.bands[0].upper-nearExpiry.profile.bands[0].lower<(now.profile.bands[0].upper-now.profile.bands[0].lower)/3);
 assert.ok(nearExpiry.slopeAt(102)<now.slopeAt(102));
 assert.equal(nearExpiry.expiryCoverage.nearestMinutes,60);
 assert.equal(nearExpiry.elapsedMinutes,55);
});

test('finite price, time and IV delta changes retain interactions and reverse by inventory sign',()=>{
 const data=make({expiry:'2026-11-05T16:00:00Z'}),lens=createLevelLens({...data,elapsedMinutes:30,ivScale:1.2}),flow=lens.flow(100.2);
 assert.ok(Math.abs(flow.change-flow.priceOnly-flow.timeOnly-flow.ivOnly-flow.interaction)<1e-9);
 assert.ok(Math.abs(flow.change)<=1000);
 assert.equal(lens.flow(100.2,'long').change,-flow.change);
 assert.equal(lens.flow(100.2,'short',.25).change,flow.change/4);
 assert.notEqual(flow.timeOnly,0);assert.notEqual(flow.ivOnly,0);assert.notEqual(flow.interaction,0);
 const priceAndTime=createLevelLens({...data,elapsedMinutes:30}).flow(100.2);
 assert.ok(Math.abs(flow.ivContribution-(flow.change-priceAndTime.change))<1e-9);
 const timeOnly=createLevelLens({...data,elapsedMinutes:30}).flow(100);
 assert.equal(timeOnly.priceOnly,0);assert.equal(timeOnly.ivOnly,0);assert.ok(Math.abs(timeOnly.interaction)<1e-9);
});

test('expiry boundary removes gamma but withholds settlement and hedge-unwind assumptions',()=>{
 const data=make({expiry:'2026-11-05T16:00:00Z'});
 for(const elapsedMinutes of [60,90]) {
   const lens=createLevelLens({...data,elapsedMinutes});
   assert.equal(lens.horizonCrossesExpiry,true);assert.equal(lens.flowUnavailableReason,'expiry-boundary');
   assert.equal(lens.sensitivity,0);assert.equal(lens.profile,null);assert.equal(lens.flow(101),null);assert.equal(lens.scenarioExpiredRows,1);
 }
 data.market.rows.push({...data.market.rows[0],id:'later',expiry:'2026-11-06T21:00:00Z'});data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const mixed=createLevelLens({...data,elapsedMinutes:60}),later=createLevelLens({...data,expiryScope:'later',elapsedMinutes:60});
 assert.ok(mixed.profile);assert.equal(mixed.sensitivity,later.sensitivity);assert.equal(mixed.flow(101),null);assert.ok(later.flow(101));
});

test('invalid horizon and expiry-scope inputs do not silently select another model',()=>{
 assert.equal(createLevelLens({...make(),elapsedMinutes:-1}),null);
 assert.equal(createLevelLens({...make(),elapsedMinutes:NaN}),null);
 assert.equal(createLevelLens({...make(),expiryScope:'0-5'}),null);
});

test('sub-minute 0DTE profile preserves its peak and shoulders far from the saved price',()=>{
 const data=make({expiry:'2026-11-05T15:00:30Z'});data.market.futuresPrice=300;
 data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const lens=createLevelLens({...data,expiryScope:'0dte'}),profile=lens.profile;
 assert.equal(lens.expiryCoverage.nearestMinutes,.5);
 assert.ok(profile.points.some(p=>p.price===profile.peakPrice&&p.ratio===1));
 assert.ok(profile.points.filter(p=>p.ratio>.5).length>=40);
 assert.ok(profile.points.some(p=>p.price===300));
 assert.ok(profile.points.every((p,i)=>i===0||p.price>profile.points[i-1].price));
 for(const band of profile.bands)for(const price of [band.lower,band.upper]){
   assert.ok(profile.points.some(p=>p.price===price));
   assert.ok(Math.abs(lens.slopeAt(price)/profile.peak-band.fraction)<1e-7);
 }
});

test('mixed wide and sub-minute expiry sampling retains the narrow component',()=>{
 const data=make({expiry:'2026-11-05T15:00:30Z'});
 data.market.futuresPrice=300;
 data.market.rows.push({...data.market.rows[0],id:'wide',expiry:'2026-12-05T21:00:00Z',openInterest:2000});
 data.analysis=analyzeHedgingMarket(data.market,{asOf});
 const lens=createLevelLens(data),half=lens.profile.bands[0];
 assert.ok(lens.profile.points.filter(p=>p.price>half.lower&&p.price<half.upper).length>=40);
 assert.ok(lens.profile.points.some(p=>p.price===lens.profile.peakPrice&&p.ratio===1));
 assert.ok(Math.abs(lens.slopeAt(half.lower)/lens.profile.peak-.5)<1e-7);
 assert.ok(Math.abs(lens.slopeAt(half.upper)/lens.profile.peak-.5)<1e-7);
});
