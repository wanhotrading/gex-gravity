import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YEAR_MS, normalCdf, act365Time, greeks, gammaThresholds,
  hedgeAdjustment, evaluateSnapshot,
} from './engine.mjs';

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

const benchmark = { futuresPrice: 100, strike: 100, iv: 0.2, timeYears: 1, rate: 0.05 };
const nq = { futuresPrice: 28720, strike: 28750, iv: 0.2, timeYears: 120 / (365 * 24 * 60), rate: 0 };

test('normal CDF central and tail benchmarks', () => {
  close(normalCdf(0), 0.5, 1e-15);
  close(normalCdf(0.1), 0.539827837277029, 1e-14);
  close(normalCdf(-2), 0.0227501319481792, 1e-14);
  close(normalCdf(8), 0.9999999999999993, 1e-15);
  close(normalCdf(-8), 6.22096057427178e-16, 1e-20);
});

test('Black-76 known price and Greek benchmarks', () => {
  const call = greeks({ ...benchmark, optionType: 'call' });
  const put = greeks({ ...benchmark, optionType: 'put' });
  close(call.price, 7.57708214642728, 1e-11);
  close(put.price, call.price, 1e-12);
  close(call.delta, 0.513500122982494, 1e-12);
  close(put.delta, -0.437729301518205, 1e-12);
  close(call.gamma, 0.0188796471645325, 1e-13);
  close(call.gamma, put.gamma, 1e-15);
  close(call.delta - put.delta, Math.exp(-0.05), 1e-14);
});

test('Delta and Gamma agree with independent finite differences', () => {
  const parameters = { futuresPrice: 102, strike: 100, iv: 0.23, timeYears: 0.17, rate: 0.04, optionType: 'put' };
  const h = 0.001;
  const current = greeks(parameters);
  const lower = greeks({ ...parameters, futuresPrice: parameters.futuresPrice - h });
  const upper = greeks({ ...parameters, futuresPrice: parameters.futuresPrice + h });
  close((upper.price - lower.price) / (2 * h), current.delta, 1e-9);
  close((upper.delta - lower.delta) / (2 * h), current.gamma, 1e-9);
  close((upper.price - 2 * current.price + lower.price) / (h * h), current.gamma, 1e-7);
});

test('known NQ 120-minute threshold values', () => {
  const result = gammaThresholds(nq);
  close(result.peakPrice, 28749.606167081052, 1e-8);
  close(result.gammaAtStrike, 0.004591755772257176, 1e-13);
  close(result.levels[0].lowerPrice, 28647.493372589477, 1e-8);
  close(result.levels[1].lowerPrice, 28605.3031696861, 1e-8);
  close(result.levels[2].lowerPrice, 28563.765727207476, 1e-8);
});

test('100/50/25/10 percent thresholds reproduce the exact peak ratios', () => {
  const result = gammaThresholds({ ...nq, fractions: [1, 0.5, 0.25, 0.1] });
  for (const level of result.levels) {
    for (const futuresPrice of [level.lowerPrice, level.upperPrice]) {
      close(greeks({ ...nq, futuresPrice }).gamma / result.peakGamma, level.fraction, 1e-11);
    }
  }
  close(result.levels[0].lowerPrice, result.peakPrice);
  close(result.levels[0].upperPrice, result.peakPrice);
});

test('the fixed-strike Gamma peak is slightly below strike', () => {
  const result = gammaThresholds(nq);
  assert.ok(result.peakPrice < nq.strike);
  assert.ok(result.peakGamma > result.gammaAtStrike);
  assert.ok(greeks({ ...nq, futuresPrice: result.peakPrice - 1 }).gamma < result.peakGamma);
  assert.ok(greeks({ ...nq, futuresPrice: result.peakPrice + 1 }).gamma < result.peakGamma);
});

test('more remaining time and higher IV widen the Gamma region', () => {
  const base = gammaThresholds(nq);
  const moreTime = gammaThresholds({ ...nq, timeYears: nq.timeYears * 4 });
  const higherIV = gammaThresholds({ ...nq, iv: nq.iv * 2 });
  for (let i = 0; i < base.levels.length; i++) {
    const width = r => r.levels[i].upperPrice - r.levels[i].lowerPrice;
    assert.ok(width(moreTime) > width(base));
    close(width(moreTime), width(higherIV), 1e-9);
  }
});

test('ACT/365 uses exact UTC milliseconds and respects explicit offsets', () => {
  const utc = act365Time({ expiry: '2026-11-02T21:00:00Z', now: '2026-11-02T19:00:00Z' });
  const offset = act365Time({ expiry: '2026-11-02T16:00:00-05:00', now: '2026-11-02T14:00:00-05:00' });
  close(utc.minutes, 120);
  close(utc.years, 7200000 / YEAR_MS);
  close(offset.years, utc.years);
  assert.throws(() => act365Time({ expiry: '2026-11-02T21:00:00', now: 0 }), /explicit UTC offset/);
  assert.throws(() => act365Time({ expiry: 'badZ', now: 0 }), /finite/);
});

test('expiry at or before now clears calculations without carrying prior Greeks', () => {
  const expiry = '2026-11-02T21:00:00Z';
  const active = evaluateSnapshot({ ...nq, expiry, now: '2026-11-02T20:59:59Z' });
  assert.equal(active.status, 'active');
  assert.ok(active.greeks.gamma > 0);
  for (const now of [expiry, '2026-11-02T21:00:01Z']) {
    const expired = evaluateSnapshot({ ...nq, expiry, now });
    assert.equal(expired.status, 'expired');
    assert.equal(expired.greeks, null);
    assert.equal(expired.thresholds, null);
  }
  assert.equal(greeks({ ...nq, timeYears: 0 }).gamma, null);
  assert.equal(gammaThresholds({ ...nq, timeYears: -1 }).peakGamma, null);
});

test('invalid model inputs are rejected explicitly', () => {
  for (const key of ['futuresPrice', 'strike', 'iv']) {
    for (const value of [0, -1, Infinity, NaN, '20']) {
      assert.throws(() => greeks({ ...nq, [key]: value }));
    }
  }
  assert.throws(() => greeks({ ...nq, timeYears: NaN }));
  assert.throws(() => greeks({ ...nq, rate: Infinity }));
  assert.throws(() => greeks({ ...nq, optionType: 'unknown' }));
  for (const fractions of [[], [0], [-0.1], [1.1], [NaN], '50']) {
    assert.throws(() => gammaThresholds({ ...nq, fractions }));
  }
});

test('American exercise uses its own model; European approximation stays optional', () => {
  const american=greeks({...nq,exerciseStyle:'american'});
  assert.equal(american.model.model,'American futures CRR');
  assert.equal(american.model.europeanApproximation,false);
  const approx = greeks({ ...nq, exerciseStyle: 'american', allowEuropeanApproximation: true });
  assert.equal(approx.model.europeanApproximation, true);
  assert.match(approx.model.label, /approximation/);
  assert.throws(() => greeks({ ...nq, exerciseStyle: 'bermudan' }));
});

test('American futures price respects exercise, zero-rate equivalence and tree convergence',()=>{
  for(const optionType of ['call','put']){
    const base={futuresPrice:90,strike:90,iv:.35,timeYears:.25,rate:0,optionType};
    const eu=greeks(base),am=greeks({...base,exerciseStyle:'american'});
    close(am.price,eu.price,1e-12);close(am.gamma,eu.gamma,1e-12);
    const input={...base,rate:.08,exerciseStyle:'american'};
    const coarse=greeks({...input,treeSteps:300}),fine=greeks({...input,treeSteps:1000});
    close(coarse.price,fine.price,.015);close(coarse.delta,fine.delta,.003);close(coarse.gamma,fine.gamma,.001);
    assert.ok(coarse.price>=greeks({...input,exerciseStyle:'european'}).price-.01);
    const itm=greeks({...input,futuresPrice:optionType==='call'?140:40});
    assert.ok(itm.price>=50-1e-9);
    assert.ok(itm.gamma>=0);
    assert.ok(optionType==='call'?itm.delta>=0&&itm.delta<=1:itm.delta>=-1&&itm.delta<=0);
  }
});

test('American nonzero-rate fade bands are numerical and bracket their sampled peak',()=>{
  const input={strike:90,iv:.35,timeYears:5/365,rate:.04,optionType:'put',exerciseStyle:'american'};
  const p=gammaThresholds(input);
  assert.equal(p.numerical,true);assert.equal(p.model.europeanApproximation,false);
  for(const b of p.levels){assert.ok(b.lowerPrice<p.peakPrice&&b.upperPrice>p.peakPrice);}
  assert.ok(p.levels[2].lowerPrice<p.levels[0].lowerPrice);
  assert.ok(p.levels[2].upperPrice>p.levels[0].upperPrice);
});

test('CL decimal prices, short-Put selling, rebound buying and multiplier scaling', () => {
  const cl = {
    currentFuturesPrice: 70.25, scenarioFuturesPrice: 69.75,
    strike: 70, iv: 0.35, timeYears: 2 / (365 * 24), rate: 0,
    optionType: 'put', exerciseStyle: 'american', allowEuropeanApproximation: true,
    signedQuantity: -100, optionMultiplier: 1000, hedgeMultiplier: 1000,
  };
  const down = hedgeAdjustment(cl);
  assert.equal(down.hedge.adjustmentDirection, 'sell');
  assert.ok(down.hedge.scenarioHedgeContracts < down.hedge.currentHedgeContracts);
  const up = hedgeAdjustment({ ...cl, currentFuturesPrice: cl.scenarioFuturesPrice, scenarioFuturesPrice: cl.currentFuturesPrice });
  assert.equal(up.hedge.adjustmentDirection, 'buy');
  close(up.hedge.adjustmentContracts, -down.hedge.adjustmentContracts, 1e-12);
  const long = hedgeAdjustment({ ...cl, signedQuantity: 100 });
  close(long.hedge.adjustmentContracts, -down.hedge.adjustmentContracts, 1e-12);
  const micro = hedgeAdjustment({ ...cl, hedgeMultiplier: 100 });
  close(micro.hedge.adjustmentContracts, 10 * down.hedge.adjustmentContracts, 1e-10);
});

test('missing quantity gives no inferred hedge; supplied quantity requires multipliers', () => {
  const parameters = { ...nq, currentFuturesPrice: 28750, scenarioFuturesPrice: 28720 };
  const noPosition = hedgeAdjustment(parameters);
  assert.equal(noPosition.positionProvided, false);
  assert.equal(noPosition.hedge, null);
  assert.ok(noPosition.current.gamma > 0);
  assert.throws(() => hedgeAdjustment({ ...parameters, signedQuantity: -1 }), /optionMultiplier/);
  const zero = hedgeAdjustment({ ...parameters, signedQuantity: 0, optionMultiplier: 20, hedgeMultiplier: 20 });
  close(zero.hedge.adjustmentContracts, 0);
  assert.equal(zero.hedge.adjustmentDirection, 'unchanged');
});

test('deep ITM Put has little additional Delta sensitivity', () => {
  const closeToStrike = greeks({ ...nq, futuresPrice: nq.strike, optionType: 'put' });
  const deepITM = greeks({ ...nq, futuresPrice: nq.strike - 6 * 86.882196, optionType: 'put' });
  assert.ok(deepITM.delta < -0.999999);
  assert.ok(deepITM.gamma < closeToStrike.gamma / 1000000);
});
