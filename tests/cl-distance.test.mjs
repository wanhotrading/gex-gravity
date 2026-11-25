import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCmeClExpiry} from '../core/cl-expiry-rules.mjs';
import {analyzeHedgingMarket} from '../core/hedging-engine.mjs';
import {createLevelLens} from '../core/level-impact.mjs';
import {renderMarketReading} from '../frontend/market-reading-view.mjs';

function fixture() {
  const specs=[['LO1','2611','2026-11-06','WEEKFRI'],['ML2','2611','2026-11-09','WEEKMON'],['LCE','2612','2026-11-17','MONTH']];
  const rows=specs.map(([root,period,date,cycle],i)=>{
    const code=`US.${root}${period}P90x0`,rule=resolveCmeClExpiry({market:'CL',code,strike:90,underlyingCode:'US.CL2612',expiry_date:date,expiration_cycle:cycle});
    return {id:code,strike:90,optionType:'put',expiry:rule.expiry,expiryTimestamp:rule.expiry,expiryDate:date,expiryTimeZone:'America/New_York',iv:.4,openInterest:1000,delta:-.5,gamma:.1,exerciseStyle:rule.exerciseStyle,underlyingCode:'US.CL2612',quoteTimestamp:'2026-11-06T15:00:00Z',greeksBasis:'futures-price'};
  });
  return {market:'CL',contract:'US.CL2612',currency:'USD',futuresPrice:90,optionMultiplier:1000,hedgeMultiplier:1000,tickSize:.01,rate:0,rows};
}

test('mapped CL snapshots generate finite interactive fade curves with unresolved rows explicitly excluded',()=>{
  const market=fixture(),analysis=analyzeHedgingMarket(market,{asOf:'2026-11-06T15:00:00Z'});
  const lens=createLevelLens({market,analysis,strike:90,expectedRows:3});
  assert.equal(lens.modeledRows,2);assert.equal(lens.excludedRows,1);assert.equal(lens.complete,false);
  assert.equal(lens.americanApproximation,false);assert.ok(lens.profile.ratio>.95);
  for(const band of lens.profile.bands) {
    assert.ok(band.lower<90&&band.upper>90);
    for(const price of [band.lower,band.upper])assert.ok(Math.abs(lens.slopeAt(price)/lens.profile.peak-band.fraction)<1e-6);
  }
  assert.ok(lens.flow(91,'short').change>0);assert.ok(lens.flow(89,'short').change<0);
  assert.ok(lens.flow(91,'long').change<0);assert.ok(lens.flow(89,'long').change>0);
  lens.key='90';lens.labels=['Put Support'];lens.shareOfWatched=1;
  const view=renderMarketReading({market:{underlyingCode:market.contract,underlyingPrice:90,tickSize:.01,contracts:market.rows},lenses:[lens],prefs:{move:1,side:'long',regimeMode:'long'},selectedKey:'90'}).html;
  assert.match(view,/CL quotes available/);assert.match(view,/2\/3 series have mapped expiry times/);
  assert.match(view,/data-reading-viewport/);assert.match(view,/data-probe-hit/);
  assert.doesNotMatch(view,/no eligible distance curve/);
});

test('CL 0DTE stops contributing at 14:30 New York and later expiries retain curves',()=>{
  const market=fixture();
  for(const [asOf,expected] of [['2026-11-06T19:29:00Z','active'],['2026-11-06T19:30:00Z','expired']]) {
    const analysis=analyzeHedgingMarket(market,{asOf});assert.equal(analysis.rows[0].model.status,expected);
    const lens=createLevelLens({market,analysis,strike:90});assert.ok(lens.profile);
    assert.equal(lens.modeledRows,expected==='active'?2:1);
  }
});
