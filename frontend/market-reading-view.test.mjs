import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarketReading} from './market-reading-view.mjs';
import {buildMarketCurve} from '../core/market-reading.mjs';
function lens(strike,key=String(strike)){
 const slopeAt=x=>Math.exp(-.5*((x-strike)/5)**2);
 return {key,strike,sensitivity:slopeAt(100),shareOfWatched:.5,slopeAt,
 profile:{peak:1,points:Array.from({length:241},(_,i)=>({price:strike-30+i*.25,ratio:slopeAt(strike-30+i*.25)})),bands:[]}};
}
const market={underlyingPrice:100,underlyingCode:'US.CL2612',tickSize:.01};
const prefs={side:'long',regimeMode:'long',move:1,chartMove:15};
test('Net DEX adds separate signed bars, a timed comparison and no change to the gamma curve',()=>{
 const now=Date.parse('2026-11-17T15:00:00Z');
 const netDex={metric:'Net DEX',scope:'all-expiries',mode:'Intraday',capturedAt:'2026-11-17T15:00:00Z',
   aggregateDisplay:'-1.6B',aggregateValue:-1.6e9,rows:[{strike:95,value:-2e8,display:'-200M'},{strike:105,value:1e8,display:'+100M'}],
   history:[{capturedAt:'2026-11-17T14:45:00Z',aggregateValue:-1.7e9}]};
 const supportedMarket={...market,watchContext:{underlyingCode:market.underlyingCode,levels:[{strike:95},{strike:105}],netDex}};
 const render=(changes,chartMarket=supportedMarket)=>renderMarketReading({lenses:[lens(95),lens(105)],market:chartMarket,
   prefs:{...prefs,...changes},now,selectedKey:'95'}).html;
 const displayed=render({});
 const hidden=render({showNetDex:false});
 assert.match(displayed,/15m snapshot change<\/span><strong>\+100M/);
 assert.match(displayed,/60m snapshot change<\/span><strong>—/);
 assert.match(displayed,/Strike 95 · Net DEX<\/span><strong>-200M/);
 assert.match(displayed,/reading-dex-plot/);
 assert.match(displayed,/Strike 105 · Net DEX \+100M/);
 assert.doesNotMatch(hidden,/reading-dex-plot|reading-dex-summary/);
 const line=html=>html.match(/<path class="reading-overall-line"[^>]+>/)?.[0];
 assert.ok(line(displayed));
 assert.equal(line(displayed),line(hidden));
 const narrowed=render({expiryScope:'0dte'});
 assert.match(narrowed,/Select all expiries to compare/);
 assert.doesNotMatch(narrowed,/reading-dex-plot/);
 assert.doesNotMatch(render({}, {...supportedMarket,underlyingCode:'US.CL2701'}),/reading-dex-plot/);
});
test('selected strike transitions stay fixed across zoom and are labeled out of view',()=>{
 const render=chartMove=>renderMarketReading({lenses:[lens(100)],market,prefs:{...prefs,chartMove},selectedKey:'100',focusedKey:'100'}).html;
 assert.match(render(15),/Fastest build ≈ 95/);
 assert.match(render(15),/Fastest fade ≈ 105/);
 assert.equal((render(15).match(/class="reading-transition"/g)||[]).length,2);
 assert.equal((render(2).match(/class="reading-transition"/g)||[]).length,0);
 assert.match(render(2),/Fastest build ≈ 95/);
 assert.match(render(2),/outside view/);
 assert.match(render(2),/data-lens-range="5.75"/);
 assert.match(render(2),/Show transition prices/);
 assert.doesNotMatch(render(15),/Show transition prices/);
 assert.match(render(15),/Strike 100 · Build ≈ 95/);
});
test('selecting a different strike changes markers and keeps a distant selected level on the chart',()=>{
 const lenses=Array.from({length:12},(_,i)=>lens(90+i*5));
 const c=buildMarketCurve(lenses,100,1,60,'145');
 assert.ok(c.chosen.some(l=>l.key==='145'));
 assert.ok(c.chosen.length<=8);
 const html=renderMarketReading({lenses,market,prefs:{...prefs,chartMove:60},selectedKey:'145',focusedKey:'145'}).html;
 assert.match(html,/Fastest build ≈ 140/);
 assert.match(html,/Fastest fade ≈ 150/);
});

test('a focused strike with missing model inputs never inherits another strike’s markers',()=>{
 const missing={key:'105',strike:105,sensitivity:null,excludedRows:1};
 const html=renderMarketReading({lenses:[lens(100),missing],market,prefs,selectedKey:'105',focusedKey:'105'}).html;
 assert.match(html,/Strike 105 · sensitivity transitions/);
 assert.match(html,/No clear transition resolved for this profile/);
 assert.doesNotMatch(html,/class="reading-transition"|class="reading-overall-line"/);
});

test('space bodies anchor to visible strike prices and expose an independent observation control',()=>{
 const html=renderMarketReading({lenses:[lens(100),lens(110)],market,prefs:{...prefs,chartMove:20},selectedKey:'100',focusedKey:'100'}).html;
 assert.match(html,/class="reading-chart-backdrop"/);
 assert.match(html,/data-lens-field="chartCenter"/);
 assert.match(html,/aria-label="Observation window center"/);
 assert.match(html,/data-lens-center="100"/);
 assert.match(html,/data-lens-strike="100" role="button" tabindex="0"/);
 assert.match(html,/Planets are centered at their strike prices/);
 assert.match(html,/href="\/planet-atlas.png"/);
 assert.match(html,/center of gravity is a visual analogy/);
 assert.equal((html.match(/class="reading-space-body selected"/g)||[]).length,1);
 assert.ok(html.indexOf('data-reading-replay-slot')<html.indexOf('data-reading-viewport'));
 assert.doesNotMatch(html,/data-probe-slider/);
});

test('panning keeps build/fade prices intact and labels an off-window saved price',()=>{
 const html=renderMarketReading({lenses:[lens(100)],market,prefs:{...prefs,chartMove:2,chartCenter:120},selectedKey:'100'}).html;
 assert.match(html,/Fastest build ≈ 95/);assert.match(html,/Fastest fade ≈ 105/);
 assert.match(html,/Snapshot 100 · outside observation window/);
 assert.equal((html.match(/class="reading-space-body/g)||[]).length,0);
});

test('main walls use the black hole without a score overlay',()=>{
 const m={...market,watchContext:{underlyingCode:market.underlyingCode,levels:[{strike:100,labels:['Put Support']}],exposure:{metric:'Net GEX',scope:'all-expiries',rows:[{strike:100,display:'-1M',value:-1e6}]}}};
 const html=renderMarketReading({lenses:[lens(100)],market:m,prefs,selectedKey:'100'}).html;
 assert.match(html,/href="\/black-hole-lensed.png"/);
 const bodies=html.slice(html.indexOf('<g class="reading-space-bodies"'),html.indexOf('Futures price · planets'));
 assert.doesNotMatch(bodies,/reading-space-score|>\?</);
});

test('activity zones do not swap with price direction and unsigned expiry slices remain visible',()=>{
 const lenses=[lens(95),lens(105),lens(110)];
 const rows=[{strike:95,value:-250,display:'-250'},{strike:105,value:500,display:'500'}];
 const m={...market,watchContext:{underlyingCode:market.underlyingCode,
   levels:lenses.map(({strike})=>({strike,labels:['Watched level']})),
   exposure:{metric:'Net GEX',scope:'all-expiries',rows}}};
 const render=(changes={},marketOverrides={})=>renderMarketReading({lenses,market:m,
   prefs:{...prefs,regimeMode:'auto',side:null,...changes},...marketOverrides}).html;
 const up=render(), down=render({flowMove:-1});
 assert.equal(up,down,'a previous movement toggle cannot change zone positions or responses');
 assert.doesNotMatch(up,/data-flow-move|Peak net buy|Peak net sell/);
 assert.match(up,/Gross sell peak 95 · 1 eq\. futures per \$1\/bbl/);
 assert.match(up,/Gross sell peak 105 · 1 eq\. futures per \$1\/bbl/);
 assert.match(up,/Most net selling on a fall<\/span>\s*<b>94/);
 assert.match(up,/Most net selling on a rise<\/span>\s*<b>106/);
 assert.match(up,/Net sell on fall ≈ 94/);
 assert.match(up,/Net sell on rise ≈ 106/);
 assert.match(up,/Also peak net buying on a rise/);
 assert.match(up,/Also peak net buying on a fall/);
 assert.match(up,/2\/3 strikes signed · 1 unsigned strikes excluded from net zones/);
 for(const html of [up,down]){
   assert.match(html,/reading-space-strike" data-net-gamma="negative"[^>]*>95 −</);
   assert.match(html,/reading-space-strike" data-net-gamma="positive"[^>]*>105 \+</);
   assert.match(html,/reading-space-strike" data-net-gamma="unknown"[^>]*>110</);
 }
 const slice=render({expiryScope:'0dte'});
 assert.match(slice,/This expiry subset has no matching signed gamma/);
 assert.match(slice,/reading-hedge-unsigned/);
 assert.doesNotMatch(slice,/class="reading-hedge-plot"|Most net selling|Net sell on (fall|rise)/);
 assert.match(render({},{expiryDate:'2026-11-13'}),/reading-hedge-unsigned/);
 assert.match(render({expiryScope:'0dte',regimeMode:'long',side:'long'}),/3\/3 strikes signed/);
 const unsigned={...m,watchContext:{...m.watchContext,exposure:{...m.watchContext.exposure,metric:'Absolute GEX',
   rows:rows.map(row=>({...row,value:Math.abs(row.value)}))}}};
 const unknown=render({},{market:unsigned});
 assert.doesNotMatch(unknown,/reading-space-strike" data-net-gamma="(?:positive|negative)"|class="reading-hedge-plot"/);
 assert.match(unknown,/reading-hedge-unsigned/);
});

test('0DTE zones use only captured same-day signs for modeled live series',()=>{
 const now=Date.parse('2026-11-16T15:00:00Z'),expiryMs=Date.parse('2026-11-16T19:30:00Z');
 const lenses=[95,105,110].map(strike=>({...lens(strike),deltaSeries:[{expiryMs}]}));
 const capture={metric:'Net GEX',scope:'0dte',mode:'Intraday',expiryDate:'2026-11-16',
   capturedAt:'2026-11-16T14:50:00Z',rows:[{strike:95,value:250,display:'+250'},{strike:105,value:-500,display:'-500'}]};
 const watchContext={underlyingCode:market.underlyingCode,levels:lenses.map(({strike})=>({strike})),exposure0dte:capture,
   exposure:{metric:'Net GEX',scope:'all-expiries',rows:[{strike:95,value:-250,display:'-250'}]}};
 const render=(scope='0dte',overrides={})=>renderMarketReading({lenses,market:{...market,
   priceTimestamp:'2026-11-16T14:55:00Z',watchContext},now,prefs:{...prefs,regimeMode:'auto',side:null,expiryScope:scope},...overrides}).html;
 const html=render();
 assert.match(html,/Saved 0DTE Net GEX signs with Futu OI sizes · 2\/3 strikes signed/);
 assert.match(html,/reading-space-strike" data-net-gamma="positive"[^>]*>95 \+</);
 assert.match(html,/reading-space-strike" data-net-gamma="negative"[^>]*>105 −</);
 assert.match(html,/reading-space-strike" data-net-gamma="unknown"[^>]*>110</);
 assert.match(render('all'),/reading-space-strike" data-net-gamma="negative"[^>]*>95 −</);
 assert.match(render('all',{expiryDate:capture.expiryDate}),/2\/3 strikes signed/);
 for(const overrides of [{now:expiryMs},{now:now-30*60000},{now:now+24*3600000},{expiryDate:'2026-11-17'}]){
   assert.doesNotMatch(render('0dte',overrides),/Net sell on (fall|rise)/);
 }
});
