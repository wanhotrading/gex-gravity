import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIvSurface,compareSurfacePoint,interpolateSurfaceIv,ivHistoryPoints,surfaceReadings} from './iv-surface.mjs';
const time='2026-11-06T19:30:00Z',expiry='2026-11-06T21:00:00Z';
const row=(strike,type='CALL',extra={})=>({code:`${strike}-${type}`,underlyingCode:'US.NQ2612',strike,optionType:type,iv:.2,quoteTimestamp:time,expiryTimestamp:expiry,...extra});
const market={underlyingCode:'US.NQ2612',underlyingPrice:100,priceTimestamp:time,collectedAt:time};
const build=(rows,extra={})=>buildIvSurface({market,rows,now:Date.parse(time),...extra});
test('OTM surface selects one side of each exact strike and retains original series identity',()=>{
 const s=build([row(98),row(98,'PUT',{iv:.3}),row(100),row(102),row(102,'PUT')]);
 assert.deepEqual(s.points.map(p=>p.code),['98-PUT','100-CALL','102-CALL']);assert.equal(s.points[0].days,1.5/24);assert.equal(s.counts.received,5);
 assert.equal(build([row(98),row(98,'PUT')],{side:'call'}).points[0].optionType,'call');
});
test('mixed futures, unknown expiry clocks, crossed quotes and expired series cannot form the mesh',()=>{
 const s=build([row(100),row(101,'CALL',{underlyingCode:'US.NQ2703'}),row(102,'CALL',{expiryTimestamp:null,expiryDate:'2026-11-06'}),row(103,'CALL',{bid:10,ask:2}),row(104,'CALL',{expiryTimestamp:'2026-11-06T19:00:00Z'})]);
 assert.equal(s.points.length,1);assert.equal(s.counts.wrongContract,1);assert.equal(s.counts.missing,1);assert.equal(s.counts.crossed,1);assert.equal(s.counts.expired,1);
});
test('older IV is excluded by default and explicitly marked when requested',()=>{
 const old=row(100,'CALL',{quoteTimestamp:'2026-11-06T18:00:00Z'});
 assert.equal(build([old]).points.length,0);assert.equal(build([old]).counts.older,1);
 const included=build([old],{includeOlder:true});assert.equal(included.points[0].older,true);assert.equal(included.points[0].quoteGapMinutes,90);
});
test('new capture time never makes an old quote current or admits a future observation',()=>{
 assert.equal(build([row(100,'CALL',{quoteTimestamp:'2026-11-06T20:00:00Z'})]).points.length,0);
 const s=build([row(100)],{market:{...market,collectedAt:'2026-11-07T05:00:00Z'},now:Date.parse('2026-11-07T05:00:00Z')});
 assert.equal(s.asOf,time);assert.equal(s.points[0].days,1.5/24);
});
test('change requires exact contract identity and strictly advancing quote times',()=>{
 const a=build([row(100)]),b=build([row(100,'CALL',{iv:.23,quoteTimestamp:'2026-11-06T19:31:00Z'})],{market:{...market,priceTimestamp:'2026-11-06T19:31:00Z',collectedAt:'2026-11-06T19:31:00Z'},now:Date.parse('2026-11-06T19:31:00Z')});
 assert.ok(Math.abs(compareSurfacePoint(b,b.points[0],a).change-3)<1e-10);
 assert.equal(compareSurfacePoint(a,a.points[0],a).status,'no-newer-quote');
 assert.equal(compareSurfacePoint(a,a.points[0],b).status,'later-baseline');
 assert.equal(compareSurfacePoint(b,{...b.points[0],code:'different'},a).status,'unmatched');
 assert.equal(compareSurfacePoint(b,b.points[0],{...a,contract:'US.ES2612'}).status,'no-baseline');
});
test('same-clock revisions are not presented as newly observed IV change',()=>{
 const a=build([row(100)]),b=build([row(100,'CALL',{iv:.3})]);
 assert.equal(compareSurfacePoint(b,b.points[0],a).change,null);
});
test('descriptive interpolation uses variance in log strike, brackets only and one expiry',()=>{
 const points=[{strike:90,iv:.2,expiry},{strike:110,iv:.4,expiry}];
 const middle=interpolateSurfaceIv(points,Math.sqrt(90*110));
 assert.ok(Math.abs(middle.iv-Math.sqrt(.1))<1e-12);assert.equal(middle.interpolated,true);
 assert.equal(interpolateSurfaceIv(points,111),null);assert.equal(interpolateSurfaceIv(points,89),null);
 assert.equal(interpolateSurfaceIv([points[0],{...points[1],expiry:'2026-12-01T21:00:00Z'}],100),null);
});
test('wing metrics are absolute volatility points, not relative percentages or risk reversals',()=>{
 const s=build([row(98,'PUT',{iv:.3}),row(100,'CALL',{iv:.2}),row(102,'CALL',{iv:.25})]);
 const m=surfaceReadings(s,expiry);assert.ok(Math.abs(m.downsidePremium-10)<1e-10);assert.ok(Math.abs(m.upsidePremium-5)<1e-10);assert.ok(Math.abs(m.wingDifference-5)<1e-10);
 assert.equal(surfaceReadings(build([row(100)]),expiry).downsidePremium,null);
});
test('history excludes future knowledge and does not invent points between observations',()=>{
 const p=row(100,'CALL',{ivHistory:[{iv:.1,quoteTimestamp:'2026-11-06T19:00:00Z',collectedAt:'2026-11-06T19:00:01Z'},{iv:.15,quoteTimestamp:'2026-11-06T19:20:00Z',collectedAt:'2026-11-06T20:00:00Z'},{iv:.9,quoteTimestamp:'2026-11-06T20:00:00Z'}]});
 const h=ivHistoryPoints(p,Date.parse(time));assert.deepEqual(h.map(p=>p.iv),[.1,.2]);
});
