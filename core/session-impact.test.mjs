import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHedgingMarket } from './hedging-engine.mjs';
import { analyzeSessionImpact, decomposeHedgeChange, LOCAL_DELTA_CHANGE_LIMIT } from './session-impact.mjs';

const asOf = '2026-11-04T15:00:00Z';
const row = { id: 'call-100', strike: 100, optionType: 'call',
  expiry: '2026-11-05T21:00:00Z', exerciseStyle: 'european', iv: 0.3,
  openInterest: 100, underlyingCode: 'US.ES2612', quoteTimestamp: asOf };
const market = { market: 'ES', contract: 'US.ES2612', futuresPrice: 100,
  optionMultiplier: 50, hedgeMultiplier: 50, tickSize: 0.25, rate: 0,
  greeksBasis: 'futures-price', rows: [row] };
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function analyze(input = market, options = {}) {
  return analyzeSessionImpact({ market: input, baseline: analyzeHedgingMarket(input, { asOf }), shockPoints: 0.1, ...options });
}
function history(patch = {}) {
  return { underlyingCode: market.contract, asOf, volumeUnit: 'contracts', windows: [
    { id: 'opening', label: '09:30–10:00', startMinute: 570, endMinute: 600, durationMinutes: 30,
      sampleCount: 20, medianVolumeContracts: 1000, medianVolatilityPoints: 10, medianRangePoints: 15 },
    { id: 'midday', label: '11:00–13:00', startMinute: 660, endMinute: 780, durationMinutes: 120,
      sampleCount: 20, medianVolumeContracts: 250, medianVolatilityPoints: 10, medianRangePoints: 15 },
  ], ...patch };
}

test('position crossings conserve buys/sells and distinguish adds from hedge lifts', () => {
  const crossing = decomposeHedgeChange(-30, 20);
  assert.equal(crossing.changeContracts, 50);
  assert.equal(crossing.shortCovered, 30);
  assert.equal(crossing.longAdded, 20);
  assert.equal(crossing.buys, 50);
  assert.equal(crossing.sells, 0);
  const reverse = decomposeHedgeChange(20, -30);
  assert.equal(reverse.longLifted, 20);
  assert.equal(reverse.shortAdded, 30);
  assert.equal(reverse.sells, 50);
  assert.equal(reverse.optionDeltaChangeContracts, 50);
  assert.throws(() => decomposeHedgeChange(Infinity, 1), /finite/);
});

test('short-Gamma hypothetical adds longs/covers shorts on a rise and sells on a fall', () => {
  const input = { ...market, rows: [row, { ...row, id: 'put-100', optionType: 'put' }] };
  const result = analyze(input);
  assert.equal(result.up.flow.method, 'fixed-time-model');
  assert.equal(result.up.flow.status, 'complete');
  assert.ok(result.up.flow.changeContracts.value > 0);
  assert.ok(result.down.flow.changeContracts.value < 0);
  assert.ok(result.up.flow.longAdded.value > 0);
  assert.ok(result.up.flow.shortCovered.value > 0);
  assert.equal(result.up.flow.sells.value, 0);
  assert.ok(result.down.flow.longLifted.value > 0);
  assert.ok(result.down.flow.shortAdded.value > 0);
  assert.equal(result.up.feedback, 'procyclical');
  assert.equal(result.down.feedback, 'procyclical');
  assert.equal(result.dealerInventoryObserved, false);
  const inverse = analyze(input, { inventory: 'dealerAllLongOI' });
  close(inverse.up.flow.changeContracts.value, -result.up.flow.changeContracts.value);
  assert.equal(inverse.up.feedback, 'countercyclical');
});

test('scenario minus model baseline never mixes in a reported Delta difference', () => {
  const input = { ...market, rows: [{ ...row, delta: 0.9, gamma: 0.01 }] };
  const unchanged = analyze(input, { shockPoints: 0 });
  assert.equal(unchanged.up.flow.changeContracts.value, 0);
  assert.notEqual(unchanged.up.flow.hedgeBefore.value, 90);
  const small = analyze(input);
  close(small.up.localGamma.hedgeBefore.value, 90);
  close(small.up.localGamma.changeContracts.value, 0.1);
  assert.equal(small.up.flow.method, 'fixed-time-model');
});

test('position share and option/hedge multipliers scale every flow and position', () => {
  const base = analyze();
  const input = { ...market, optionMultiplier: 500 };
  const scaled = analyze(input, { positionScale: 0.2 });
  for (const key of ['hedgeBefore', 'hedgeAfter', 'changeContracts', 'longAdded', 'buys']) {
    close(scaled.up.flow[key].value, 2 * base.up.flow[key].value);
  }
});

test('CL uses only a labeled small-shock current-Gamma approximation without inventing expiry', () => {
  const input = { ...market, market: 'CL', contract: 'US.CL2612', futuresPrice: 95,
    optionMultiplier: 1000, hedgeMultiplier: 1000, tickSize: 0.01,
    rows: [{ ...row, id: 'cl-put', optionType: 'put', strike: 95, expiry: null,
      expiryDate: '2026-11-06', expiryTimeZone: 'America/New_York', exerciseStyle: 'american',
      underlyingCode: 'US.CL2612', delta: -0.4, gamma: 0.1 }] };
  const result = analyze(input, { shockPoints: 0.1 });
  assert.equal(result.up.model.status, 'unavailable');
  assert.equal(result.up.flow.method, 'local-snapshot-gamma');
  close(result.up.flow.hedgeBefore.value, -40);
  close(result.up.flow.hedgeAfter.value, -39);
  close(result.up.flow.shortCovered.value, 1);
  close(result.down.flow.shortAdded.value, 1);
  close(result.up.localGamma.maximumSuggestedShockPoints, LOCAL_DELTA_CHANGE_LIMIT / 0.1);
  const large = analyze(input, { shockPoints: 1 });
  assert.equal(large.up.localGamma.status, 'unavailable');
  assert.equal(large.up.localGamma.excludedReasons[0].reason, 'local-delta-change-exceeds-limit');
  assert.equal(large.up.flow.changeContracts.value, null);
});

test('local approximation rejects Delta outside call/put bounds even within the slope guard', () => {
  const input = { ...market, rows: [{ ...row, expiry: null, expiryDate: '2026-11-05',
    expiryTimeZone: 'America/New_York', delta: 0.999, gamma: 0.02 }] };
  const result = analyze(input);
  assert.equal(result.up.localGamma.status, 'unavailable');
  assert.equal(result.up.localGamma.excludedReasons[0].reason, 'local-delta-outside-option-bounds');
  assert.equal(result.down.localGamma.status, 'complete');
});

test('offsetting row requirements preserve gross buying/selling when net flow is zero', () => {
  const input = { ...market, rows: [{ ...row, signedDealerPosition: 100 },
    { ...row, id: 'same-call-short', signedDealerPosition: -100 }] };
  const result = analyze(input, { inventory: 'supplied' });
  close(result.up.flow.changeContracts.value, 0);
  assert.ok(result.up.flow.buys.value > 0);
  assert.ok(result.up.flow.sells.value > 0);
  close(result.up.flow.grossTradedContracts.value, 2 * result.up.flow.buys.value);
  assert.equal(result.up.flow.netBook.complete, true);
  close(result.up.flow.netBook.changeContracts.value, 0);
  close(result.up.flow.netBook.longAdded.value, 0);
  close(result.up.flow.netBook.shortCovered.value, 0);
  assert.equal(result.up.feedback, 'neutral');
});

test('net-book additions reconcile with net hedge positions while preserving gross per-series changes', () => {
  const input = { ...market, market: 'CL', contract: 'US.CL2612', futuresPrice: 95,
    optionMultiplier: 1000, hedgeMultiplier: 1000, tickSize: 0.01,
    rows: ['call', 'put'].map(optionType => ({ ...row, id: `cl-${optionType}`, optionType,
      strike: 95, expiry: null, expiryDate: '2026-11-06', expiryTimeZone: 'America/New_York',
      underlyingCode: 'US.CL2612', delta: optionType === 'call' ? 0.5 : -0.5, gamma: 0.1 })) };
  const result = analyze(input, { shockPoints: 0.5 }), flow = result.up.flow;
  assert.equal(flow.method, 'local-snapshot-gamma');
  close(flow.hedgeBefore.value, 0);
  close(flow.hedgeAfter.value, 10);
  close(flow.longAdded.value, 5, 1e-8);
  close(flow.shortCovered.value, 5, 1e-8);
  close(flow.netBook.longAdded.value, 10);
  close(flow.netBook.shortCovered.value, 0);
  close(flow.netBook.shortAdded.value, 0);
  close(result.down.flow.netBook.shortAdded.value, 10);
  close(result.down.flow.netBook.longLifted.value, 0);
  assert.equal(flow.netBook.longAdded.includedRows, 2);
});

test('partial and empty selections never become a complete hedge or full-volume comparison', () => {
  const input = { ...market, rows: [row, { ...row, id: 'missing-oi', openInterest: null }] };
  const result = analyze(input, { historyProfile: history(), impactCoefficient: 1 });
  assert.equal(result.up.flow.status, 'partial');
  assert.equal(result.up.flow.changeContracts.value, null);
  assert.equal(result.up.flow.netBook, null);
  assert.ok(result.up.flow.changeContracts.knownSubtotal > 0);
  assert.equal(result.windows[0].up.volumeShare, null);
  assert.equal(result.windows[0].up.stressImpactPoints, null);
  assert.equal(result.windows[0].up.reason, 'complete-hedge-flow-unavailable');
  const empty = analyze({ ...market, rows: [] });
  assert.equal(empty.up.flow.status, 'unavailable');
  assert.equal(empty.up.flow.changeContracts.value, null);
});

test('history alone supplies volume participation but no fitted or default price impact', () => {
  const result = analyze(market, { historyProfile: history() });
  close(result.windows[0].up.volumeShare, result.up.flow.changeContracts.value / 1000);
  assert.equal(result.windows[0].up.flowMethod, result.up.flow.method);
  assert.equal(result.windows[0].up.stressImpactPoints, null);
  assert.equal(result.windows[0].up.reason, 'explicit-impact-coefficient-required');
  assert.equal(result.impactBasis.coefficientSource, 'not-supplied');
  assert.equal(result.impactBasis.calibratedFromHistoricalOrderFlow, false);
});

test('explicit stress factor follows signed square-root size and volatility scaling separately for every window', () => {
  const result = analyze(market, { historyProfile: history(), impactCoefficient: 2, volatilityScale: 1.5 });
  const first = result.windows[0].up, second = result.windows[1].up;
  close(first.stressImpactPoints, 2 * 10 * 1.5 * Math.sqrt(first.volumeShare));
  close(second.stressImpactPoints, 2 * first.stressImpactPoints);
  assert.ok(result.windows[0].down.stressImpactPoints < 0);
  assert.equal(first.stressStatus, 'user-assumption');
  assert.equal(result.impactBasis.coefficientSource, 'user-assumption');
  const halfShare = analyze(market, { positionScale: 0.25, historyProfile: history(), impactCoefficient: 2, volatilityScale: 1.5 });
  close(halfShare.windows[0].up.stressImpactPoints, 0.5 * first.stressImpactPoints);
});

test('fewer than ten completed windows retain volume comparison but cannot yield point-impact stress', () => {
  const profile = history({ windows: [{ ...history().windows[0], sampleCount: 9 }] });
  const result = analyze(market, { historyProfile: profile, impactCoefficient: 1 });
  assert.ok(result.windows[0].up.volumeShare > 0);
  assert.equal(result.windows[0].up.stressImpactPoints, null);
  assert.equal(result.windows[0].up.reason, 'insufficient-history-for-stress');
  assert.equal(result.impactBasis.minimumHistoricalSessions, 10);
});

test('unverified volume, mismatched underlying and missing windows do not yield impact estimates', () => {
  for (const [patch, reason] of [
    [{ volumeUnit: 'unverified' }, 'historical-volume-unit-unverified'],
    [{ underlyingCode: 'US.ES2703' }, 'historical-underlying-mismatch'],
    [{ windows: [{ ...history().windows[0], sampleCount: 0 }] }, 'historical-window-unavailable'],
  ]) {
    const result = analyze(market, { historyProfile: history(patch), impactCoefficient: 1 });
    assert.equal(result.windows[0].up.volumeShare, null);
    assert.equal(result.windows[0].up.stressImpactPoints, null);
    assert.equal(result.windows[0].up.reason, reason);
  }
});

test('unverified native volume requires explicit opt-in and remains labeled an assumption', () => {
  const profile = history({ volumeUnit: 'unverified', windows: [{ ...history().windows[0],
    medianVolumeContracts: null, medianReportedVolume: 1000 }] });
  const strict = analyze(market, { historyProfile: profile, impactCoefficient: 1 });
  assert.equal(strict.volumeUnit, 'unverified');
  assert.equal(strict.windows[0].up.volumeShare, null);
  assert.equal(strict.windows[0].up.stressImpactPoints, null);
  const opted = analyze(market, { historyProfile: profile, impactCoefficient: 1, allowUnverifiedContractVolume: true });
  close(opted.windows[0].up.volumeShare, opted.up.flow.changeContracts.value / 1000);
  assert.ok(opted.windows[0].up.stressImpactPoints > 0);
  assert.equal(opted.volumeUnit, 'contracts-assumed');
  assert.equal(opted.windows[0].windowVolumeBasis, 'user-assumed-native-contracts');
  assert.equal(opted.windows[0].up.windowVolumeBasis, 'user-assumed-native-contracts');
  assert.equal(opted.impactBasis.volumeBasis, 'user-assumption');
  assert.equal(opted.impactBasis.calibratedFromHistoricalOrderFlow, false);
  const noFactor = analyze(market, { historyProfile: profile, allowUnverifiedContractVolume: true });
  assert.ok(noFactor.windows[0].up.volumeShare > 0);
  assert.equal(noFactor.windows[0].up.stressImpactPoints, null);
  assert.equal(noFactor.windows[0].up.reason, 'explicit-impact-coefficient-required');
});

test('native-volume opt-in cannot bypass missing volume, sample minimum or exact-underlying matching', () => {
  for (const [patch, reason] of [
    [{ medianReportedVolume: null }, 'historical-volume-unavailable'],
    [{ sampleCount: 9 }, 'insufficient-history-for-stress'],
  ]) {
    const profile = history({ volumeUnit: 'unverified', windows: [{ ...history().windows[0],
      medianVolumeContracts: null, medianReportedVolume: 1000, ...patch }] });
    const result = analyze(market, { historyProfile: profile, impactCoefficient: 1, allowUnverifiedContractVolume: true });
    assert.equal(result.windows[0].up.stressImpactPoints, null);
    assert.equal(result.windows[0].up.reason, reason);
  }
  const mismatch = analyze(market, { historyProfile: history({ underlyingCode: 'US.ES2703', volumeUnit: 'unverified' }),
    impactCoefficient: 1, allowUnverifiedContractVolume: true });
  assert.equal(mismatch.volumeUnit, 'unverified');
  assert.equal(mismatch.windows[0].windowVolumeBasis, 'unverified');
  assert.equal(mismatch.windows[0].up.windowVolumeBasis, 'unverified');
  assert.equal(mismatch.windows[0].up.volumeShare, null);
  assert.equal(mismatch.windows[0].up.reason, 'historical-underlying-mismatch');
});

test('an assumed order beyond typical window volume retains participation but blocks stress extrapolation', () => {
  const result = analyze(market, { historyProfile: history({ windows: [{ ...history().windows[0], medianVolumeContracts: 0.001 }] }), impactCoefficient: 1 });
  assert.ok(result.windows[0].up.volumeShare > 1);
  assert.equal(result.windows[0].up.stressImpactPoints, null);
  assert.equal(result.windows[0].up.reason, 'flow-exceeds-typical-window-volume');
});

test('scenario baseline identity and invalid user assumptions are rejected', () => {
  const input = { ...market, rows: [{ ...row }] }, baseline = analyzeHedgingMarket(input, { asOf });
  input.rows[0].openInterest = 500;
  assert.throws(() => analyzeSessionImpact({ market: input, baseline, shockPoints: 0.1 }), /unchanged/);
  for (const invalid of [{ shockPoints: -1 }, { shockPoints: 100 }, { positionScale: 1.01 },
    { impactCoefficient: NaN }, { impactCoefficient: -1 }, { volatilityScale: 0 }, { inventory: 'known-dealers' },
    { allowUnverifiedContractVolume: 1 }]) {
    assert.throws(() => analyze(market, invalid));
  }
});
