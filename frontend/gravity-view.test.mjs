import test from 'node:test';
import assert from 'node:assert/strict';
import {exposureScale,primaryWalls,gravityDeck,expiryIdentity,expiryBadges} from './gravity-view.mjs';
const context={underlyingCode:'US.NQ2612',gexUnit:'provider units',levels:[
  {strike:100,labels:['Put Support'],gex:-400},
  {strike:110,labels:['Call Resistance'],gex:100},
  {strike:105,labels:['Call Resistance 0DTE'],gex:40},
  {strike:90,labels:['GEX 1'],gex:null},
  {strike:95,labels:['GEX 2'],gex:0}
]};
test('provider landmarks do not prove same-day contracts or change numerical mass',()=>{
 assert.equal(expiryIdentity(null,['Call Resistance 0DTE']).confirmed,false);
 assert.match(expiryBadges(null,['Call Resistance 0DTE']),/MenthorQ 0DTE level/);
 const lens={expiryScope:'all',elapsedMinutes:15,expiryCoverage:{zeroDteRows:2,laterRows:3,nearestMinutes:45}};
 assert.match(expiryBadges(lens),/Includes 0DTE/);assert.match(expiryBadges(lens),/30 min/);
 assert.equal(expiryIdentity({...lens,expiryScope:'later'}).confirmed,false);
 assert.equal(expiryIdentity({...lens,expiryScope:'0dte'}).mixed,false);
});
test('body area, not diameter, scales with absolute source GEX; sign is retained',()=>{
  const a=exposureScale(context,100,context.underlyingCode),b=exposureScale(context,110,context.underlyingCode);
  assert.equal(a.value,-400);assert.equal(a.scale,1);assert.equal(b.scale,.5);
  assert.equal(a.scale**2/b.scale**2,4);
  assert.equal(exposureScale(context,95,context.underlyingCode).scale,0);
});
test('provider ranks use an explicitly ordinal fallback while incompatible data stays unavailable',()=>{
  assert.equal(exposureScale(context,90,context.underlyingCode).basis,'rank');
  assert.equal(exposureScale(context,90,context.underlyingCode).score,100);
  assert.equal(exposureScale(context,90,context.underlyingCode).value,null);
  assert.equal(exposureScale({...context,gexUnit:null},100,context.underlyingCode).scale,null);
  assert.equal(exposureScale(context,100,'US.ES2612').scale,null);
  assert.equal(exposureScale({...context,levels:[...context.levels,context.levels[0]]},100,context.underlyingCode).scale,null);
});
test('main wall identity excludes 0DTE and does not infer option side from signed GEX',()=>{
  assert.deepEqual(primaryWalls(context).map(w=>w.level.strike),[100,110]);
  assert.equal(primaryWalls({levels:[{strike:100,labels:['GEX 1'],gex:-900}]}).filter(w=>w.level).length,0);
  assert.equal(primaryWalls({levels:[{strike:100,labels:['Put Support'],gex:null},{strike:101,labels:['Put Support'],gex:400}]} )[0].level,null);
});
test('equal peak percentages retain unequal exposure size, off-chart walls remain references',()=>{
  const curve={chosen:[{key:'a',strike:100,shareOfWatched:.8},{key:'b',strike:90,shareOfWatched:.2}],currentRatios:[.5,.5]};
  const html=gravityDeck(curve,{underlyingCode:context.underlyingCode,underlyingPrice:103,watchContext:context},{side:'short',selectedKey:'a'},['#fff','#fff']);
  assert.equal((html.match(/data-probe-ratio/g)||[]).length,2);
  assert.match(html,/GEX -400/);assert.match(html,/ordinal score 100\/100/);
  assert.match(html,/Call wall/);assert.match(html,/black-hole-lensed.png/);
  assert.doesNotMatch(html,/gravity-question|>\?</);
  assert.match(html,/No validated crossing probability/);
  assert.doesNotMatch(html,/Body size is decorative/);
});

test('independent numerical Exposure takes precedence, keeps sign and uses a normalized score',()=>{
  const c={...context,exposure:{metric:'Net GEX',scope:'all-expiries',sourceDate:null,rows:[{strike:100,display:'-1M',value:-1e6},{strike:110,display:'250K',value:250e3}]}};
  const x=exposureScale(c,110,context.underlyingCode);
  assert.equal(x.basis,'exposure');assert.equal(x.value,250e3);assert.equal(x.score,25);assert.equal(x.scale,.5);
  assert.equal(x.metric,'Net GEX');assert.equal(x.capture.sourceDate,null);
  assert.equal(exposureScale(null,110,undefined).basis,'missing');
});

test('importance sorting keeps curve indices so the probe updates the matching strike',()=>{
 const c={...context,exposure:{metric:'Net GEX',scope:'all-expiries',rows:[{strike:100,display:'100',value:100},{strike:90,display:'400',value:400}]}};
 const html=gravityDeck({chosen:[{key:'a',strike:100},{key:'b',strike:90}],currentRatios:[.2,.8]},{underlyingCode:context.underlyingCode,watchContext:c},{side:'long'},['#fff','#fff']);
 assert.ok(html.indexOf('data-probe-ratio="1"')<html.indexOf('data-probe-ratio="0"'));
 assert.match(html,/Exposure score 100\/100/);assert.match(html,/Futu sensitivity remaining/);
});
