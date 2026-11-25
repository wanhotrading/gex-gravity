/**
 * Pure, per-underlying aggregation of option-on-futures snapshots and scenarios.
 * Prices: futures points. IV: decimal. Multipliers: currency / futures point.
 * Reported Delta/Gamma require an explicitly verified futures-price basis,
 * matching dated underlying and a trustworthy provider quote timestamp. Their
 * snapshot arithmetic does not require an exact option expiry clock. That clock
 * remains mandatory for time-dependent Black-76 scenarios and Gamma profiles.
 * Definitions: https://support.futunn.com/hant/topic473
 * https://www.futuhk.com/cn/en/support/topic2_1082
 * OI is unsigned concentration, never observed dealer ownership. The +/- OI
 * inventories below are explicitly hypothetical boundary scenarios.
 */
import { act365Time, greeks, gammaThresholds } from './engine.mjs';

const EXPOSURE_KEYS = [
  'deltaExposureCurrencyPerPoint', 'gammaExposureCurrencyPerPointSquared',
  'hedgeContracts', 'hedgeChangeContractsPerPoint', 'hedgeChangeContractsPerTick',
  'hedgeChangeContractsPerOnePercentMoveLinear', 'gammaNotionalPerOnePercentMove',
];
const CONCENTRATION_KEYS = [
  'openInterest', 'gammaCurrencyPerPointSquared', 'hedgeSensitivityContractsPerPoint',
  'hedgeSensitivityContractsPerTick', 'hedgeSensitivityContractsPerOnePercentMoveLinear',
  'gammaNotionalPerOnePercentMove',
];
const INVENTORIES = ['dealerAllLongOI', 'dealerAllShortOI', 'supplied'];
const BASELINE_MARKET_FIELDS = ['market', 'contract', 'currency', 'futuresPrice', 'optionMultiplier', 'hedgeMultiplier', 'tickSize', 'rate', 'greeksBasis'];
const BASELINE_ROW_FIELDS = ['id', 'strike', 'optionType', 'expiry', 'iv', 'openInterest', 'exerciseStyle', 'allowEuropeanApproximation', 'signedDealerPosition', 'delta', 'gamma', 'greeksBasis', 'underlyingCode', 'quoteTimestamp', 'expiryDate', 'expiryTimeZone'];
// Cache membership is private and is never serialized with an analysis result.
// Capture primitive inputs so a caller cannot reuse an older baseline after
// mutating its price, IV, inventory, model permission or contract metadata.
const reusableBaselines = new WeakMap();
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isPositive = value => isFiniteNumber(value) && value > 0;
const isNonnegative = value => isFiniteNumber(value) && value >= 0;
const maybe = value => isFiniteNumber(value) ? value : null;
const safeProduct = (...values) => values.every(isFiniteNumber) && Number.isFinite(values.reduce((a, b) => a * b, 1))
  ? values.reduce((a, b) => a * b, 1) : null;

function requiredPositive(value, name) {
  if (!isPositive(value)) throw new TypeError(`${name} must be a finite positive number.`);
  return value;
}

function metric(values) {
  const known = values.filter(isFiniteNumber);
  const knownSubtotal = known.reduce((a, b) => a + b, 0);
  const finiteSubtotal = Number.isFinite(knownSubtotal);
  const complete = known.length === values.length && finiteSubtotal;
  return {
    value: complete ? knownSubtotal : null,
    knownSubtotal: finiteSubtotal ? knownSubtotal : null,
    complete, includedRows: known.length, expectedRows: values.length,
  };
}

function quantities(row) {
  const oi = isNonnegative(row.openInterest) ? row.openInterest : null;
  return {
    dealerAllLongOI: oi,
    dealerAllShortOI: oi === null ? null : -oi,
    supplied: isFiniteNumber(row.signedDealerPosition) ? row.signedDealerPosition : null,
  };
}

function positionExposure(q, delta, gamma, market, price) {
  const M = isPositive(market.optionMultiplier) ? market.optionMultiplier : null;
  const H = isPositive(market.hedgeMultiplier) ? market.hedgeMultiplier : null;
  const tick = isPositive(market.tickSize) ? market.tickSize : null;
  const ratio = M !== null && H !== null ? M / H : null;
  const hedgeSlope = safeProduct(-1, q, ratio, gamma);
  return {
    signedOptionContracts: q,
    deltaExposureCurrencyPerPoint: safeProduct(q, M, delta),
    gammaExposureCurrencyPerPointSquared: safeProduct(q, M, gamma),
    hedgeContracts: safeProduct(-1, q, ratio, delta),
    // Sign means response to a positive futures-price move; negative is selling.
    hedgeChangeContractsPerPoint: hedgeSlope,
    hedgeChangeContractsPerTick: safeProduct(hedgeSlope, tick),
    hedgeChangeContractsPerOnePercentMoveLinear: safeProduct(hedgeSlope, price, 0.01),
    gammaNotionalPerOnePercentMove: safeProduct(q, M, gamma, price, price, 0.01),
  };
}

function concentration(oi, gamma, market, price) {
  const e = positionExposure(oi, null, gamma, market, price);
  return {
    openInterest: oi,
    gammaCurrencyPerPointSquared: e.gammaExposureCurrencyPerPointSquared,
    hedgeSensitivityContractsPerPoint: e.hedgeChangeContractsPerPoint === null ? null : Math.abs(e.hedgeChangeContractsPerPoint),
    hedgeSensitivityContractsPerTick: e.hedgeChangeContractsPerTick === null ? null : Math.abs(e.hedgeChangeContractsPerTick),
    hedgeSensitivityContractsPerOnePercentMoveLinear: e.hedgeChangeContractsPerOnePercentMoveLinear === null ? null : Math.abs(e.hedgeChangeContractsPerOnePercentMoveLinear),
    gammaNotionalPerOnePercentMove: e.gammaNotionalPerOnePercentMove,
  };
}

function inventories(row, delta, gamma, market, price) {
  return Object.fromEntries(Object.entries(quantities(row)).map(([key, q]) => [
    key, positionExposure(q, delta, gamma, market, price),
  ]));
}

function validCalendarDate(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() + 1 === +match[2] && date.getUTCDate() === +match[3];
}

/** Validate when a provider observation can be used for snapshot arithmetic.
 * A date-only expiry never supplies T. It only rejects dates already passed in
 * an explicitly supplied exchange time zone. On expiry day, active/expired
 * status remains unknown and is exposed as such rather than inferred.
 */
function reportedSnapshotUse(row, market, asOf, model, basis, calendarDates) {
  const result = { usable: false, reason: null, timeBasis: null,
    quoteTimestamp: null, quoteAgeMilliseconds: null, expiryStatus: 'unknown' };
  if (basis !== 'futures-price') return { ...result, reason: 'compatible-futures-price-basis-required' };
  if (typeof row.underlyingCode !== 'string' || row.underlyingCode !== market.contract) {
    return { ...result, reason: 'matching-reported-underlying-required' };
  }
  let quoteClock;
  try { quoteClock = act365Time({ expiry: row.quoteTimestamp, now: asOf }); }
  catch { return { ...result, reason: 'valid-reported-quote-timestamp-required' }; }
  const quoteDate = new Date(quoteClock.expiryMs);
  if (!Number.isFinite(quoteDate.getTime())) return { ...result, reason: 'valid-reported-quote-timestamp-required' };
  result.quoteTimestamp = quoteDate.toISOString();
  result.quoteAgeMilliseconds = quoteClock.asOfMs - quoteClock.expiryMs;
  if (result.quoteAgeMilliseconds < 0) return { ...result, reason: 'reported-quote-after-analysis-time' };
  if (model.time?.status === 'expired') return { ...result, reason: 'expired', expiryStatus: 'expired' };
  if (model.time?.status === 'active') {
    return { ...result, usable: true, timeBasis: 'verified-active-expiry', expiryStatus: 'active' };
  }
  // A supplied but malformed timestamp is a data conflict, not permission to
  // silently replace it with date-only metadata.
  if (row.expiry !== undefined && row.expiry !== null && row.expiry !== '') {
    return { ...result, reason: 'invalid-exact-expiry-time' };
  }
  if (!validCalendarDate(row.expiryDate)) return { ...result, reason: 'valid-reported-expiry-date-required' };
  if (typeof row.expiryTimeZone !== 'string' || !row.expiryTimeZone.trim()) {
    return { ...result, reason: 'reported-expiry-time-zone-required' };
  }
  if (!calendarDates.has(row.expiryTimeZone)) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: row.expiryTimeZone,
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(quoteClock.asOfMs));
      const part = type => parts.find(entry => entry.type === type)?.value;
      calendarDates.set(row.expiryTimeZone, `${part('year')}-${part('month')}-${part('day')}`);
    } catch { calendarDates.set(row.expiryTimeZone, null); }
  }
  const asOfDate = calendarDates.get(row.expiryTimeZone);
  if (!asOfDate) return { ...result, reason: 'valid-reported-expiry-time-zone-required' };
  if (asOfDate > row.expiryDate) return { ...result, reason: 'reported-expiration-date-passed', expiryStatus: 'date-passed' };
  return { ...result, usable: true, timeBasis: 'as-reported-expiry-time-unknown',
    expiryStatus: asOfDate === row.expiryDate ? 'expiry-day-clock-unknown' : 'expiry-date-not-reached' };
}

function modeled(row, market, asOf, price, ivScale = 1) {
  let time;
  try {
    if (row.expiry === undefined || row.expiry === null || row.expiry === '') {
      return { status: 'unavailable', reason: 'exact-expiry-time-unavailable', time: null, greeks: null, profile: null };
    }
    time = act365Time({ expiry: row.expiry, now: asOf });
  } catch (error) {
    return { status: 'unavailable', reason: 'invalid-expiry-time', detail: error.message, time: null, greeks: null, profile: null };
  }
  if (time.status === 'expired') return { status: 'expired', reason: 'expired', time, greeks: null, profile: null };
  if (!isPositive(row.iv)) return { status: 'unavailable', reason: 'positive-iv-unavailable', time, greeks: null, profile: null };
  if (!isPositive(row.strike)) return { status: 'unavailable', reason: 'positive-strike-unavailable', time, greeks: null, profile: null };
  if (!['call', 'put'].includes(row.optionType)) return { status: 'unavailable', reason: 'option-type-unavailable', time, greeks: null, profile: null };
  if (!['european', 'american'].includes(row.exerciseStyle)) return { status: 'unavailable', reason: 'exercise-style-unavailable', time, greeks: null, profile: null };
  const inputs = {
    futuresPrice: price, strike: row.strike, iv: row.iv * ivScale,
    optionType: row.optionType, timeYears: time.years, rate: market.rate ?? 0,
    exerciseStyle: row.exerciseStyle,
    allowEuropeanApproximation: row.allowEuropeanApproximation === true,
  };
  try {
    const calculated = greeks(inputs);
    const thresholds = gammaThresholds(inputs);
    const ratio = thresholds.peakGamma > 0 ? Math.min(1, Math.max(0, calculated.gamma / thresholds.peakGamma)) : null;
    return {
      status: 'active', reason: null, time, greeks: calculated,
      profile: {
        ...thresholds,
        ratioToOwnPeak: ratio,
        distanceToPeakPoints: price - thresholds.peakPrice,
        sensitivityIncreasesToward: price < thresholds.peakPrice ? 'higher-price' : price > thresholds.peakPrice ? 'lower-price' : 'at-peak',
        reference: 'This row only: fixed strike, scenario IV and remaining time. Not a probability, support/resistance level or aggregate-portfolio peak.',
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: 'model-input-or-numerical-error', detail: error.message, time, greeks: null, profile: null };
  }
}

function analyzeRow(row, index, market, asOf, calendarDates) {
  const model = modeled(row, market, asOf, market.futuresPrice);
  const basis = row.greeksBasis ?? market.greeksBasis;
  const observed = {
    delta: maybe(row.delta), gamma: isNonnegative(row.gamma) ? row.gamma : null,
    greeksBasis: basis ?? 'unknown', source: 'reported snapshot',
    ...reportedSnapshotUse(row, market, asOf, model, basis, calendarDates),
  };
  const selectedDelta = observed.usable && observed.delta !== null ? observed.delta : model.greeks?.delta ?? null;
  const selectedGamma = observed.usable && observed.gamma !== null ? observed.gamma : model.greeks?.gamma ?? null;
  const oi = quantities(row).dealerAllLongOI;
  return {
    id: row.id ?? `row-${index + 1}`,
    strike: maybe(row.strike), optionType: row.optionType ?? null,
    expiry: row.expiry ?? null, expiryMs: model.time?.expiryMs ?? null,
    exerciseStyle: row.exerciseStyle ?? null, iv: isPositive(row.iv) ? row.iv : null,
    openInterest: oi,
    signedDealerPosition: quantities(row).supplied,
    observed, model,
    current: {
      delta: selectedDelta, gamma: selectedGamma,
      deltaSource: observed.usable && observed.delta !== null ? 'reported' : selectedDelta !== null ? 'modeled' : 'unavailable',
      gammaSource: observed.usable && observed.gamma !== null ? 'reported' : selectedGamma !== null ? 'modeled' : 'unavailable',
      concentration: concentration(oi, selectedGamma, market, market.futuresPrice),
      inventories: inventories(row, selectedDelta, selectedGamma, market, market.futuresPrice),
    },
    modeledCurrentInventories: inventories(row, model.greeks?.delta ?? null, model.greeks?.gamma ?? null, market, market.futuresPrice),
  };
}

function aggregateRows(rows) {
  // Unknown expiry is included in required coverage; it is not treated as expired.
  const eligible = rows.filter(row => row.model.status !== 'expired');
  const concentrationTotals = Object.fromEntries(CONCENTRATION_KEYS.map(key => [
    key, metric(eligible.map(row => row.current.concentration[key])),
  ]));
  const inventoryTotals = Object.fromEntries(INVENTORIES.map(inventory => [inventory,
    Object.fromEntries(EXPOSURE_KEYS.map(key => [
      key, metric(eligible.map(row => row.current.inventories[inventory][key])),
    ])),
  ]));
  return {
    totalRows: rows.length, activeOrUnknownRows: eligible.length,
    expiredRows: rows.length - eligible.length,
    modeledRows: eligible.filter(row => row.model.status === 'active').length,
    rowIds: rows.map(row => row.id),
    concentration: concentrationTotals,
    inventories: inventoryTotals,
  };
}

function grouped(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, members]) => ({ key, ...aggregateRows(members) }));
}

function analyzeScenario(market, originals, currentRows, asOf, scenario, index) {
  const scenarioAsOf = scenario.asOf ?? asOf;
  const scenarioClock = act365Time({ expiry: scenarioAsOf, now: asOf });
  if (scenarioClock.expiryMs < scenarioClock.asOfMs) throw new RangeError('Scenario asOf cannot precede the snapshot asOf.');
  const price = scenario.priceByContract?.[market.contract] ?? market.futuresPrice;
  requiredPositive(price, 'scenario futures price');
  const ivScale = scenario.ivScale ?? 1;
  requiredPositive(ivScale, 'scenario ivScale');
  const rows = originals.map((row, rowIndex) => {
    const model = modeled(row, market, scenarioAsOf, price, ivScale);
    const delta = model.greeks?.delta ?? null;
    const gamma = model.greeks?.gamma ?? null;
    const positions = inventories(row, delta, gamma, market, price);
    const current = currentRows[rowIndex];
    const changes = Object.fromEntries(INVENTORIES.map(inventory => {
      const baseline = current.modeledCurrentInventories[inventory].hedgeContracts;
      const future = positions[inventory].hedgeContracts;
      return [inventory, isFiniteNumber(baseline) && isFiniteNumber(future) ? future - baseline : null];
    }));
    return {
      id: current.id, strike: current.strike, expiry: current.expiry, expiryMs: model.time?.expiryMs ?? null,
      model,
      current: { delta, gamma, concentration: concentration(quantities(row).dealerAllLongOI, gamma, market, price), inventories: positions },
      modeledHedgeChangeContracts: changes,
      gammaRatioToCurrentModel: isPositive(current.model.greeks?.gamma) && isFiniteNumber(gamma) ? gamma / current.model.greeks.gamma : null,
    };
  });
  const baselineEligibleIds = new Set(currentRows.filter(row => row.model.status !== 'expired').map(row => row.id));
  const eligibleScenarioRows = rows.filter(row => baselineEligibleIds.has(row.id));
  const hedgeChanges = Object.fromEntries(INVENTORIES.map(inventory => [inventory,
    metric(eligibleScenarioRows.map(row => row.modeledHedgeChangeContracts[inventory])),
  ]));
  return {
    id: scenario.id ?? `scenario-${index + 1}`,
    asOf: new Date(scenarioClock.expiryMs).toISOString(), futuresPrice: price, ivScale,
    reference: 'Scenario minus snapshot using the same exercise-style model, not scenario minus reported Greeks. Inventories stay fixed. No execution or realized-flow estimate.',
    rows, totals: aggregateRows(rows), modeledHedgeChangeContracts: hedgeChanges,
    strikeGroups: grouped(rows, row => row.strike === null ? 'unavailable' : String(row.strike)),
    expiryGroups: grouped(rows, row => row.expiryMs === null ? 'unavailable' : new Date(row.expiryMs).toISOString()),
  };
}

/** Analyze one underlying contract. Missing observations stay unavailable. */
export function analyzeHedgingMarket(market, { asOf, scenarios = [] } = {}) {
  if (!market || typeof market !== 'object') throw new TypeError('market must be an object.');
  if (typeof market.contract !== 'string' || !market.contract.trim()) throw new TypeError('contract is required.');
  requiredPositive(market.futuresPrice, 'futuresPrice');
  // Validate snapshot timestamp once; do not silently use the computer clock.
  const clock = act365Time({ expiry: asOf, now: asOf });
  if (!Array.isArray(market.rows)) throw new TypeError('market.rows must be an array.');
  if (!Array.isArray(scenarios)) throw new TypeError('scenarios must be an array.');
  const calendarDates = new Map();
  const rows = market.rows.map((row, index) => analyzeRow(row, index, market, asOf, calendarDates));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new TypeError('Row ids must be unique within an underlying contract.');
  const warnings = [];
  if (!isPositive(market.optionMultiplier) || !isPositive(market.hedgeMultiplier)) warnings.push('Contract multipliers unavailable: hedge contracts and monetary exposure are unavailable.');
  if (!isPositive(market.tickSize)) warnings.push('Tick size unavailable: per-tick sensitivity is unavailable.');
  if (rows.some(row => row.model.greeks?.model.europeanApproximation)) warnings.push('At least one American-style option uses an explicitly enabled European Black-76 approximation.');
  if (rows.some(row => row.model.status === 'unavailable')) warnings.push('Some rows cannot be modeled. Partial subtotals are labeled; complete totals remain unavailable.');
  if (rows.some(row => row.observed.greeksBasis !== 'futures-price' && (row.observed.delta !== null || row.observed.gamma !== null))) warnings.push('Reported Greeks with unknown or incompatible underlying basis are retained as observations but excluded from exposure calculations.');
  if (rows.some(row => row.observed.usable && row.observed.timeBasis === 'as-reported-expiry-time-unknown')) warnings.push('Some hedge figures use provider snapshot Greeks without an exact expiry clock. They describe conditional exposure as quoted; expiry-day active status is unknown. Gamma fade and time-dependent scenarios remain unavailable for those rows.');
  const result = {
    market: market.market ?? null, contract: market.contract,
    currency: market.currency ?? null,
    asOf: new Date(clock.asOfMs).toISOString(), futuresPrice: market.futuresPrice,
    optionMultiplier: isPositive(market.optionMultiplier) ? market.optionMultiplier : null,
    hedgeMultiplier: isPositive(market.hedgeMultiplier) ? market.hedgeMultiplier : null,
    tickSize: isPositive(market.tickSize) ? market.tickSize : null,
    warnings,
    assumptions: {
      dealerInventoryObserved: false,
      dealerAllLongOI: 'Hypothetical dealers long all reported OI for every included row.',
      dealerAllShortOI: 'Hypothetical dealers short all reported OI for every included row.',
      supplied: 'User-supplied signed dealer option contracts: positive long, negative short; missing does not mean zero.',
      concentration: 'Unsigned reported OI weighted by long-option Gamma; no dealer sign inferred.',
      gammaNotionalPerOnePercentMove: 'Gamma × signed quantity (unsigned OI for concentration) × option multiplier × F² × 0.01. A local linear Delta-notional sensitivity, not cash selling or total futures notional.',
      timeConvention: 'ACT/365 calendar time using exact expiry and snapshot/scenario timestamps.',
      hedgeUnits: 'Equivalent contracts of this underlying only; option multiplier / hedge multiplier. Do not sum contract counts across different underlyings.',
      actualPositions: 'Reported Greeks and OI do not reveal dealer ownership, existing hedge positions, hedge timing or actual trades.',
      reportedSnapshotUse: 'Reported Delta/Gamma require a verified futures-price basis, matching underlying, and a valid quote timestamp at or before analysis time. Without an exact expiry clock, a valid provider expiry date and explicit exchange time zone can permit as-quoted arithmetic until that date ends. This does not resolve time remaining or expiry-day active status, and does not make an older quote live.',
    },
    rows, totals: aggregateRows(rows),
    strikeGroups: grouped(rows, row => row.strike === null ? 'unavailable' : String(row.strike)),
    expiryGroups: grouped(rows, row => row.expiryMs === null ? 'unavailable' : new Date(row.expiryMs).toISOString()),
    scenarios: scenarios.map((scenario, index) => analyzeScenario(market, market.rows, rows, asOf, scenario, index)),
  };
  reusableBaselines.set(result, {
    market, marketValues: BASELINE_MARKET_FIELDS.map(key => market[key]),
    rowValues: market.rows.map(row => BASELINE_ROW_FIELDS.map(key => row[key])),
  });
  return result;
}

/**
 * Model one scenario against a previously computed immutable baseline. This
 * avoids recalculating every baseline Greek/profile during interactive input.
 * The baseline must come from this module and the exact same unchanged market
 * object. Changing inputs requires a new analyzeHedgingMarket() baseline.
 */
export function analyzeHedgingScenario(market, baseline, { asOf = baseline?.asOf, scenario = {} } = {}) {
  const source = baseline && typeof baseline === 'object' ? reusableBaselines.get(baseline) : null;
  if (!source || source.market !== market || !Array.isArray(market?.rows)
    || source.rowValues.length !== market.rows.length
    || BASELINE_MARKET_FIELDS.some((key, index) => !Object.is(market[key], source.marketValues[index]))
    || market.rows.some((row, index) => BASELINE_ROW_FIELDS.some((key, field) => !Object.is(row[key], source.rowValues[index][field])))) {
    throw new TypeError('Scenario baseline must belong to the same unchanged market input. Recalculate the baseline after changing inputs.');
  }
  const clock = act365Time({ expiry: asOf, now: asOf });
  if (new Date(clock.asOfMs).toISOString() !== baseline.asOf) throw new RangeError('Scenario baseline asOf must match its snapshot timestamp.');
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new TypeError('scenario must be an object.');
  return analyzeScenario(market, market.rows, baseline.rows, baseline.asOf, scenario, 0);
}

/** No cross-underlying grand total is produced: futures contract units differ. */
export function analyzeHedgingSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.markets)) throw new TypeError('snapshot.markets must be an array.');
  const contracts = snapshot.markets.map(market => market.contract);
  if (new Set(contracts).size !== contracts.length) throw new TypeError('Each underlying contract must have its own unique market group.');
  return {
    schemaVersion: 1, asOf: snapshot.asOf,
    source: snapshot.source ?? null,
    markets: snapshot.markets.map(market => analyzeHedgingMarket(market, { asOf: snapshot.asOf, scenarios: snapshot.scenarios ?? [] })),
    aggregation: 'Separate per underlying contract; no combined hedge count or dealer-flow forecast.',
  };
}
