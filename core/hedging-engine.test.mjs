import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHedgingMarket, analyzeHedgingScenario, analyzeHedgingSnapshot } from './hedging-engine.mjs';
import { greeks, YEAR_MS } from './engine.mjs';

const asOf = '2026-11-04T18:00:00Z';
const expiry = '2026-11-04T20:00:00Z';
const row = {
  id: 'put-28750', strike: 28750, optionType: 'put', expiry, iv: 0.2,
  openInterest: 100, exerciseStyle: 'european', signedDealerPosition: -30,
  underlyingCode: 'NQZ6', quoteTimestamp: asOf,
};
const market = {
  market: 'NQ', contract: 'NQZ6', currency: 'USD', futuresPrice: 28720,
  optionMultiplier: 20, hedgeMultiplier: 20, tickSize: 0.25, rate: 0,
  greeksBasis: 'futures-price', rows: [row],
};
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('multi-expiry aggregation equals individual positions, with no OI ownership inference', () => {
  const another = { ...row, id: 'call-next-day', optionType: 'call', expiry: '2026-11-05T20:00:00Z', openInterest: 200, signedDealerPosition: 10 };
  const result = analyzeHedgingMarket({ ...market, rows: [row, another] }, { asOf });
  assert.equal(result.expiryGroups.length, 2);
  assert.equal(result.strikeGroups.length, 1);
  assert.equal(result.totals.concentration.openInterest.value, 300);
  const sum = result.rows.reduce((total, entry) => total + entry.current.inventories.dealerAllShortOI.hedgeContracts, 0);
  close(result.totals.inventories.dealerAllShortOI.hedgeContracts.value, sum);
  close(result.totals.inventories.dealerAllLongOI.hedgeContracts.value, -sum);
  assert.equal(result.assumptions.dealerInventoryObserved, false);
  assert.match(result.assumptions.concentration, /no dealer sign inferred/);
});

test('current reported Greeks remain distinct from constant-IV scenario models', () => {
  const result = analyzeHedgingMarket({ ...market, rows: [{ ...row, delta: -0.7, gamma: 0.01 }] }, {
    asOf, scenarios: [{ id: 'lower', priceByContract: { NQZ6: 28700 }, ivScale: 1 }],
  });
  const current = result.rows[0];
  assert.equal(current.current.deltaSource, 'reported');
  assert.equal(current.current.gammaSource, 'reported');
  close(current.current.inventories.dealerAllShortOI.hedgeContracts, -70);
  const scenario = result.scenarios[0];
  const scenarioHedge = scenario.rows[0].current.inventories.dealerAllShortOI.hedgeContracts;
  const baselineHedge = current.modeledCurrentInventories.dealerAllShortOI.hedgeContracts;
  close(scenario.modeledHedgeChangeContracts.dealerAllShortOI.value, scenarioHedge - baselineHedge);
  assert.notEqual(baselineHedge, -70);
  assert.ok(scenario.modeledHedgeChangeContracts.dealerAllShortOI.value < 0);
});

test('missing IV preserves usable reported snapshot Greeks but prevents modeling', () => {
  const result = analyzeHedgingMarket({ ...market, rows: [{ ...row, iv: null, delta: -0.6, gamma: 0.004 }] }, {
    asOf, scenarios: [{ priceByContract: { NQZ6: 28700 } }],
  });
  assert.equal(result.rows[0].model.reason, 'positive-iv-unavailable');
  close(result.totals.inventories.dealerAllShortOI.hedgeContracts.value, -60);
  assert.equal(result.scenarios[0].modeledHedgeChangeContracts.dealerAllShortOI.value, null);
  assert.equal(result.scenarios[0].totals.concentration.gammaCurrencyPerPointSquared.value, null);
});

test('CL reported snapshot hedges work without inventing an expiry clock or American approximation', () => {
  const input = { ...market, market: 'CL', contract: 'US.CL2612', futuresPrice: 96.17,
    optionMultiplier: 1000, hedgeMultiplier: 1000, tickSize: 0.01,
    rows: [{ ...row, id: 'cl-weekly-put', strike: 96, expiry: null,
      underlyingCode: 'US.CL2612', quoteTimestamp: '2026-11-04T17:45:00Z',
      expiryDate: '2026-11-04', expiryTimeZone: 'America/New_York',
      exerciseStyle: 'american', allowEuropeanApproximation: false,
      delta: -0.45, gamma: 0.1 }] };
  const result = analyzeHedgingMarket(input, { asOf, scenarios: [{ priceByContract: { 'US.CL2612': 95.5 } }] });
  const actual = result.rows[0];
  assert.equal(actual.observed.usable, true);
  assert.equal(actual.observed.timeBasis, 'as-reported-expiry-time-unknown');
  assert.equal(actual.observed.expiryStatus, 'expiry-day-clock-unknown');
  assert.equal(actual.observed.quoteAgeMilliseconds, 15 * 60000);
  assert.equal(actual.current.deltaSource, 'reported');
  close(actual.current.inventories.dealerAllShortOI.hedgeContracts, -45);
  close(actual.current.inventories.dealerAllShortOI.hedgeChangeContractsPerPoint, 10);
  close(actual.current.inventories.dealerAllShortOI.hedgeChangeContractsPerTick, 0.1);
  close(result.totals.concentration.gammaCurrencyPerPointSquared.value, 10000);
  assert.equal(actual.model.reason, 'exact-expiry-time-unavailable');
  assert.equal(actual.model.profile, null);
  assert.equal(actual.expiry, null);
  assert.equal(result.scenarios[0].modeledHedgeChangeContracts.dealerAllShortOI.value, null);
  assert.equal(result.scenarios[0].rows[0].model.profile, null);
  assert.ok(result.warnings.some(warning => /expiry-day active status is unknown/.test(warning)));
});

test('reported snapshot arithmetic requires exact matching owner, verified units and trustworthy timestamp', () => {
  const observed = { ...row, delta: -0.6, gamma: 0.004, iv: null };
  for (const [patch, reason] of [
    [{ underlyingCode: undefined }, 'matching-reported-underlying-required'],
    [{ underlyingCode: 'NQH7' }, 'matching-reported-underlying-required'],
    [{ greeksBasis: 'unverified' }, 'compatible-futures-price-basis-required'],
    [{ quoteTimestamp: undefined }, 'valid-reported-quote-timestamp-required'],
    [{ quoteTimestamp: '2026-11-04' }, 'valid-reported-quote-timestamp-required'],
    [{ quoteTimestamp: 1e17 }, 'valid-reported-quote-timestamp-required'],
    [{ quoteTimestamp: '2026-11-04T18:00:01Z' }, 'reported-quote-after-analysis-time'],
  ]) {
    const result = analyzeHedgingMarket({ ...market, rows: [{ ...observed, ...patch }] }, { asOf });
    assert.equal(result.rows[0].observed.delta, -0.6, 'Raw provider Greeks remain visible.');
    assert.equal(result.rows[0].observed.usable, false);
    assert.equal(result.rows[0].observed.reason, reason);
    assert.equal(result.rows[0].current.delta, null);
    assert.equal(result.totals.inventories.dealerAllShortOI.hedgeContracts.value, null);
  }
});

test('date-only snapshot guards use explicit exchange zone without treating midnight as expiration', () => {
  const observed = { ...row, expiry: null, expiryDate: '2026-11-04', expiryTimeZone: 'America/New_York',
    quoteTimestamp: '2026-11-04T23:30:00Z', delta: -0.6, gamma: 0.004 };
  const input = { ...market, rows: [observed] };
  const beforeLocalMidnight = analyzeHedgingMarket(input, { asOf: '2026-11-05T01:00:00Z' });
  assert.equal(beforeLocalMidnight.rows[0].observed.usable, true, 'Still Nov4 in New York; actual expiry clock remains unknown.');
  assert.equal(beforeLocalMidnight.rows[0].observed.expiryStatus, 'expiry-day-clock-unknown');
  assert.equal(beforeLocalMidnight.rows[0].model.profile, null);
  const nextLocalDate = analyzeHedgingMarket(input, { asOf: '2026-11-05T05:00:00Z' });
  assert.equal(nextLocalDate.rows[0].observed.usable, false);
  assert.equal(nextLocalDate.rows[0].observed.reason, 'reported-expiration-date-passed');
  assert.equal(nextLocalDate.rows[0].current.delta, null);
  const futureExpiry = analyzeHedgingMarket({ ...market, rows: [{ ...observed, expiryDate: '2026-11-06' }] }, { asOf: '2026-11-05T01:00:00Z' });
  assert.equal(futureExpiry.rows[0].observed.expiryStatus, 'expiry-date-not-reached');
});

test('date-only fallback cannot hide malformed expiry clocks, missing calendar metadata or actual expiry', () => {
  const observed = { ...row, expiry: null, expiryDate: '2026-11-04', expiryTimeZone: 'America/New_York', delta: -0.6, gamma: 0.004 };
  for (const [patch, reason] of [
    [{ expiry: '2026-11-04' }, 'invalid-exact-expiry-time'],
    [{ expiry: asOf }, 'expired'],
    [{ expiryDate: null }, 'valid-reported-expiry-date-required'],
    [{ expiryDate: '2026-02-30' }, 'valid-reported-expiry-date-required'],
    [{ expiryTimeZone: null }, 'reported-expiry-time-zone-required'],
    [{ expiryTimeZone: 'Not/AZone' }, 'valid-reported-expiry-time-zone-required'],
  ]) {
    const result = analyzeHedgingMarket({ ...market, rows: [{ ...observed, ...patch }] }, { asOf });
    assert.equal(result.rows[0].observed.usable, false);
    assert.equal(result.rows[0].observed.reason, reason);
    assert.equal(result.rows[0].current.delta, null);
  }
});

test('unknown Greek units never silently enter hedge estimates', () => {
  const result = analyzeHedgingMarket({ ...market, greeksBasis: undefined, rows: [{ ...row, iv: null, delta: -0.6, gamma: 0.004 }] }, { asOf });
  assert.equal(result.rows[0].observed.delta, -0.6);
  assert.equal(result.rows[0].observed.usable, false);
  assert.equal(result.rows[0].current.delta, null);
  assert.equal(result.totals.inventories.dealerAllShortOI.hedgeContracts.value, null);
});

test('missing OI cannot become zero and incomplete totals expose coverage', () => {
  const result = analyzeHedgingMarket({ ...market, rows: [row, { ...row, id: 'unknown', openInterest: null }] }, { asOf });
  const metric = result.totals.concentration.gammaCurrencyPerPointSquared;
  assert.equal(metric.value, null);
  assert.equal(metric.complete, false);
  assert.equal(metric.includedRows, 1);
  assert.equal(metric.expectedRows, 2);
  close(metric.knownSubtotal, result.rows[0].current.concentration.gammaCurrencyPerPointSquared);
  assert.notEqual(result.totals.inventories.supplied.hedgeContracts.value, null);
});

test('omitted supplied positions stay unknown, while explicit zero remains a position', () => {
  const result = analyzeHedgingMarket({ ...market, rows: [{ ...row, signedDealerPosition: undefined }, { ...row, id: 'zero', signedDealerPosition: 0 }] }, { asOf });
  assert.equal(result.totals.inventories.supplied.hedgeContracts.value, null);
  assert.equal(result.totals.inventories.supplied.hedgeContracts.includedRows, 1);
  close(result.rows[1].current.inventories.supplied.hedgeContracts, 0);
});

test('multipliers cancel for same-sized futures and scale for micro hedges', () => {
  const standard = analyzeHedgingMarket(market, { asOf });
  const micro = analyzeHedgingMarket({ ...market, hedgeMultiplier: 2 }, { asOf });
  const a = standard.rows[0].current.inventories.dealerAllShortOI;
  const b = micro.rows[0].current.inventories.dealerAllShortOI;
  close(b.hedgeContracts, 10 * a.hedgeContracts);
  close(a.hedgeChangeContractsPerTick, a.hedgeChangeContractsPerPoint * 0.25);
  close(a.hedgeChangeContractsPerOnePercentMoveLinear, a.hedgeChangeContractsPerPoint * market.futuresPrice * 0.01);
  close(a.gammaNotionalPerOnePercentMove, a.gammaExposureCurrencyPerPointSquared * market.futuresPrice ** 2 * 0.01);
});

test('exact expiry is required; American modeling no longer needs European opt-in', () => {
  for (const [changes, reason] of [
    [{ expiry: null }, 'exact-expiry-time-unavailable'],
    [{ expiry: '2026-11-04' }, 'invalid-expiry-time'],
    [{ exerciseStyle: undefined }, 'exercise-style-unavailable'],
  ]) {
    const result = analyzeHedgingMarket({ ...market, rows: [{ ...row, ...changes }] }, { asOf });
    assert.equal(result.rows[0].model.reason, reason);
  }
  const american=analyzeHedgingMarket({...market,rows:[{...row,exerciseStyle:'american'}]},{asOf});
  assert.equal(american.rows[0].model.status,'active');
  assert.equal(american.rows[0].model.greeks.model.model,'American futures CRR');
  const permitted = analyzeHedgingMarket({ ...market, rows: [{ ...row, exerciseStyle: 'american', allowEuropeanApproximation: true }] }, { asOf });
  assert.equal(permitted.rows[0].model.greeks.model.europeanApproximation, true);
  assert.ok(permitted.warnings.some(warning => /American/.test(warning)));
});

test('expired rows do not carry prior Greeks, and expiration-crossing hedge change is unavailable', () => {
  const result = analyzeHedgingMarket({ ...market, rows: [row, { ...row, id: 'expired', expiry: asOf, delta: -0.9, gamma: 0.02 }] }, {
    asOf, scenarios: [{ id: 'at-expiry', asOf: expiry }],
  });
  assert.equal(result.rows[1].model.status, 'expired');
  assert.equal(result.rows[1].current.delta, null);
  assert.equal(result.totals.activeOrUnknownRows, 1);
  assert.equal(result.scenarios[0].rows[0].model.status, 'expired');
  assert.equal(result.scenarios[0].modeledHedgeChangeContracts.dealerAllShortOI.value, null);
});

test('Gamma fade is relative to the same modeled row peak and IV can widen its region', () => {
  const result = analyzeHedgingMarket(market, {
    asOf, scenarios: [
      { id: 'deep', priceByContract: { NQZ6: 28400 } },
      { id: 'iv-up', ivScale: 2 },
    ],
  });
  const current = result.rows[0].model;
  close(current.profile.ratioToOwnPeak, current.greeks.gamma / current.profile.peakGamma);
  assert.equal(current.profile.sensitivityIncreasesToward, 'higher-price');
  assert.ok(result.scenarios[0].rows[0].model.profile.ratioToOwnPeak < 0.001);
  const width = profile => profile.levels[0].upperPrice - profile.levels[0].lowerPrice;
  assert.ok(width(result.scenarios[1].rows[0].model.profile) > width(current.profile));
  assert.ok(result.scenarios[1].rows[0].model.profile.peakGamma < current.profile.peakGamma);
});

test('per-market boundaries, positive-price domain, and pure deterministic results', () => {
  const cl = { ...market, market: 'CL', contract: 'CLZ6', futuresPrice: 70.25, optionMultiplier: 1000, hedgeMultiplier: 1000, tickSize: 0.01, rows: [{ ...row, strike: 70, iv: 0.35 }] };
  const snapshot = { asOf, markets: [market, cl] };
  const before = JSON.stringify(snapshot);
  const result = analyzeHedgingSnapshot(snapshot);
  assert.equal(result.markets.length, 2);
  assert.equal(result.totals, undefined);
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(result, analyzeHedgingSnapshot(snapshot));
  for (const futuresPrice of [0, -1, Infinity, NaN]) assert.throws(() => analyzeHedgingMarket({ ...market, futuresPrice }, { asOf }));
  assert.throws(() => analyzeHedgingMarket(market, { asOf: undefined }), /finite/);
  assert.throws(() => analyzeHedgingMarket(market, { asOf, scenarios: [{ asOf: '2026-11-04T17:00:00Z' }] }), /precede/);
  assert.throws(() => analyzeHedgingSnapshot({ asOf, markets: [market, market] }), /unique/);
});

test('same snapshot no-change scenario has zero modeled adjustments; changing clock is recalculated', () => {
  const result = analyzeHedgingMarket(market, { asOf, scenarios: [{ id: 'unchanged' }, { id: 'later', asOf: '2026-11-04T19:00:00Z' }] });
  close(result.scenarios[0].modeledHedgeChangeContracts.dealerAllShortOI.value, 0);
  assert.notEqual(result.scenarios[1].modeledHedgeChangeContracts.dealerAllShortOI.value, 0);
  const expected = greeks({ futuresPrice: market.futuresPrice, strike: row.strike, iv: row.iv, timeYears: 3600000 / YEAR_MS, optionType: row.optionType, exerciseStyle: row.exerciseStyle, rate: 0 });
  close(result.scenarios[1].rows[0].model.greeks.delta, expected.delta);
});

test('large mixed-coverage scenario preserves baseline eligibility and all inventory subtotals', () => {
  const bulk = { ...market, rows: Array.from({ length: 1200 }, (_, index) => ({
    ...row, id: `contract-${index}`, strike: 28700 + index % 50,
    expiry: index % 6 === 0 ? asOf : index % 6 === 1 ? null : expiry,
    iv: index % 6 === 2 ? null : 0.2,
    openInterest: index % 5 === 0 ? null : 10 + index % 100,
    signedDealerPosition: index % 7 === 0 ? null : (index % 2 ? -1 : 1) * (index % 40),
  })) };
  const result = analyzeHedgingMarket(bulk, { asOf, scenarios: [{ priceByContract: { NQZ6: 28650 } }] });
  const scenario = result.scenarios[0], eligibleIndexes = bulk.rows.flatMap((entry, index) => entry.expiry === asOf ? [] : [index]);
  assert.equal(eligibleIndexes.length, 1000);
  for(const inventory of ['dealerAllLongOI','dealerAllShortOI','supplied']) {
    const values = eligibleIndexes.map(index=>scenario.rows[index].modeledHedgeChangeContracts[inventory]);
    const known = values.filter(value=>typeof value === 'number' && Number.isFinite(value));
    const metric = scenario.modeledHedgeChangeContracts[inventory];
    assert.equal(metric.expectedRows, eligibleIndexes.length);
    assert.equal(metric.includedRows, known.length);
    assert.equal(metric.complete, false);
    assert.equal(metric.value, null);
    close(metric.knownSubtotal, known.reduce((sum,value)=>sum+value,0), 1e-8);
  }
  assert.equal(scenario.rows.length, 1200, 'Expired and unavailable rows remain visible rather than silently disappearing.');
});

test('cached single-scenario analysis equals the full API without recalculating a baseline', () => {
  const input = { ...market, rows: [row, { ...row, id:'call-later',optionType:'call',expiry:'2026-11-05T20:00:00Z' }] };
  const scenario = { id:'interactive',priceByContract:{NQZ6:28650},ivScale:1.1,asOf:'2026-11-04T19:00:00Z' };
  const baseline = analyzeHedgingMarket(input, { asOf });
  const expected = analyzeHedgingMarket(input, { asOf, scenarios:[scenario] }).scenarios[0];
  const before = JSON.stringify(baseline);
  assert.deepEqual(analyzeHedgingScenario(input,baseline,{scenario}),expected);
  assert.equal(JSON.stringify(baseline),before,'An interactive scenario does not mutate the cached baseline.');
  assert.throws(()=>analyzeHedgingScenario({...input},baseline,{scenario}),/same unchanged market/);
  assert.throws(()=>analyzeHedgingScenario(input,baseline,{asOf:'2026-11-04T19:00:00Z',scenario}),/snapshot timestamp/);
  assert.throws(()=>analyzeHedgingScenario(input,{...baseline},{scenario}),/same unchanged market/);
});

test('cached scenarios reject changed input values including approximation permission and multiplier', () => {
  for(const mutate of [
    input=>{input.futuresPrice++;}, input=>{input.optionMultiplier=2;},
    input=>{input.rows[0].iv=.3;}, input=>{input.rows[0].expiry='2026-11-05T20:00:00Z';},
    input=>{input.rows[0].allowEuropeanApproximation=true;}, input=>{input.rows[0].signedDealerPosition=-50;},
    input=>{input.rows[0].greeksBasis='unverified';}, input=>{input.rows.push({...row,id:'added'});},
    input=>{input.rows[0].quoteTimestamp='2026-11-04T17:00:00Z';},
    input=>{input.rows[0].underlyingCode='NQH7';},
    input=>{input.rows[0].expiryDate='2026-11-05';},
    input=>{input.rows[0].expiryTimeZone='America/Chicago';},
  ]) {
    const input = {...market,rows:[{...row}]},baseline=analyzeHedgingMarket(input,{asOf});
    mutate(input);
    assert.throws(()=>analyzeHedgingScenario(input,baseline,{scenario:{}}),/same unchanged market/);
  }
});
