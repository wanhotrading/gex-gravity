/**
 * Conditional, same-snapshot hedge changes and session-liquidity comparisons.
 * No dealer inventory, actual trading, causal impact coefficient or future
 * price move is inferred from unsigned OI or OHLCV bars.
 *
 * Gamma units: https://www.cmegroup.com/education/courses/option-greeks/options-gamma-the-greeks
 * Square-root impact reference (daily inputs, not an intraday calibration):
 * https://www.cmegroup.com/articles/2025/reassessing-liquidity-beyond-order-book-depth.html
 */
import { analyzeHedgingScenario } from './hedging-engine.mjs';

export const LOCAL_DELTA_CHANGE_LIMIT = 0.05;
export const MIN_IMPACT_STRESS_SESSIONS = 10;
const INVENTORIES = ['dealerAllLongOI', 'dealerAllShortOI', 'supplied'];
const FLOW_KEYS = ['hedgeBefore', 'hedgeAfter', 'changeContracts',
  'optionDeltaBeforeContracts', 'optionDeltaAfterContracts', 'optionDeltaChangeContracts',
  'buys', 'sells', 'grossTradedContracts', 'longAdded', 'longLifted', 'shortAdded', 'shortCovered'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;

function metric(values) {
  const known = values.filter(finite), subtotal = known.reduce((sum, value) => sum + value, 0);
  const validSubtotal = known.length > 0 && finite(subtotal);
  const complete = values.length > 0 && known.length === values.length && validSubtotal;
  return { value: complete ? subtotal : null, knownSubtotal: validSubtotal ? subtotal : null,
    complete, includedRows: known.length, expectedRows: values.length };
}

/** Positive net change is buying. A crossing is split into closing and opening. */
export function decomposeHedgeChange(before, after) {
  if (!finite(before) || !finite(after) || !finite(after - before)) {
    throw new TypeError('Hedge positions must be finite equivalent futures-contract counts.');
  }
  const change = after - before;
  const longBefore = Math.max(0, before), longAfter = Math.max(0, after);
  const shortBefore = Math.max(0, -before), shortAfter = Math.max(0, -after);
  return {
    hedgeBefore: before, hedgeAfter: after, changeContracts: change,
    optionDeltaBeforeContracts: -before, optionDeltaAfterContracts: -after,
    optionDeltaChangeContracts: -change,
    buys: Math.max(0, change), sells: Math.max(0, -change), grossTradedContracts: Math.abs(change),
    longAdded: Math.max(0, longAfter - longBefore), longLifted: Math.max(0, longBefore - longAfter),
    shortAdded: Math.max(0, shortAfter - shortBefore), shortCovered: Math.max(0, shortBefore - shortAfter),
  };
}

function finishFlow(method, rows, extra = {}) {
  const metrics = Object.fromEntries(FLOW_KEYS.map(key => [key, metric(rows.map(row => row.values?.[key]))]));
  const includedRows = metrics.changeContracts.includedRows, expectedRows = rows.length;
  // Row-wise position changes can contain a long addition and a short cover
  // even when the combined hedge starts at zero. Decompose the complete net
  // book separately so the displayed position additions/lifts reconcile with
  // the net hedge before and after. Preserve per-series gross fields below.
  let netBook = null;
  if (metrics.hedgeBefore.complete && metrics.hedgeAfter.complete
    && finite(metrics.hedgeAfter.value - metrics.hedgeBefore.value)) {
    const values = decomposeHedgeChange(metrics.hedgeBefore.value, metrics.hedgeAfter.value);
    netBook = { complete: true, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      { value, knownSubtotal: value, complete: true, includedRows: expectedRows, expectedRows }])) };
  }
  const reasons = new Map();
  for (const row of rows) if (row.reason) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  return {
    method, status: metrics.changeContracts.complete ? 'complete' : includedRows > 0 ? 'partial' : 'unavailable',
    includedRows, expectedRows, ...metrics, netBook,
    excludedReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
    // Gross figures describe offsetting hypothetical row requirements. They
    // are not an estimate of turnover after netting across a dealer's books.
    rows, ...extra,
  };
}

function pair(row, before, after, scale, reason) {
  if (!finite(before) || !finite(after) || !finite(before * scale) || !finite(after * scale)) {
    return { id: row.id, strike: row.strike, values: null, reason: reason ?? 'inventory-or-greek-unavailable' };
  }
  return { id: row.id, strike: row.strike,
    values: decomposeHedgeChange(before * scale, after * scale), reason: null };
}

function modelFlow(baselineRows, scenario, inventory, scale) {
  const future = new Map(scenario.rows.map(row => [row.id, row]));
  const rows = baselineRows.map(row => {
    const next = future.get(row.id);
    return pair(row, row.modeledCurrentInventories[inventory].hedgeContracts,
      next?.current.inventories[inventory].hedgeContracts, scale,
      row.model.reason ?? next?.model.reason ?? 'model-inventory-unavailable');
  });
  return finishFlow('fixed-time-model', rows, {
    basis: 'Scenario model minus snapshot model; snapshot time, IV and option positions stay fixed.',
  });
}

function localFlow(baselineRows, inventory, scale, movePoints) {
  const suggestions = [];
  const rows = baselineRows.map(row => {
    const current = row.current, position = current.inventories[inventory];
    const before = position.hedgeContracts, slope = position.hedgeChangeContractsPerPoint;
    const gamma = current.gamma, delta = current.delta;
    let reason = null;
    if (!finite(before) || !finite(slope) || !finite(delta) || !finite(gamma) || gamma < 0) {
      reason = 'snapshot-inventory-or-greek-unavailable';
    } else {
      if (gamma > 0) suggestions.push(LOCAL_DELTA_CHANGE_LIMIT / gamma);
      const change = gamma * movePoints, projected = delta + change;
      const lower = row.optionType === 'call' ? 0 : row.optionType === 'put' ? -1 : null;
      const upper = row.optionType === 'call' ? 1 : row.optionType === 'put' ? 0 : null;
      if (lower === null) reason = 'option-type-unavailable';
      else if (!finite(change) || Math.abs(change) > LOCAL_DELTA_CHANGE_LIMIT + 1e-12) reason = 'local-delta-change-exceeds-limit';
      else if (!finite(projected) || projected < lower - 1e-12 || projected > upper + 1e-12) reason = 'local-delta-outside-option-bounds';
    }
    return reason ? { id: row.id, strike: row.strike, values: null, reason }
      : pair(row, before, before + slope * movePoints, scale);
  });
  return finishFlow('local-snapshot-gamma', rows, {
    basis: 'Current selected Delta/Gamma; constant-Gamma, small-price-move approximation. No expiry clock or Gamma fade is inferred.',
    maximumDeltaChange: LOCAL_DELTA_CHANGE_LIMIT,
    maximumSuggestedShockPoints: suggestions.length ? Math.min(...suggestions) : null,
  });
}

function chooseFlow(model, localGamma) {
  if (model.status === 'complete') return model;
  if (localGamma.status === 'complete') return localGamma;
  return localGamma.includedRows > model.includedRows ? localGamma : model;
}

function windowVolume(profile, window, allowUnverifiedContractVolume) {
  if (profile?.volumeUnit === 'contracts') return { value: window.medianVolumeContracts, basis: 'contracts' };
  if (profile?.volumeUnit === 'unverified' && allowUnverifiedContractVolume) {
    return { value: window.medianReportedVolume, basis: 'user-assumed-native-contracts' };
  }
  return { value: null, basis: 'unverified' };
}

function historyReason(profile, window, contract, volume) {
  if (!profile) return 'history-unavailable';
  if (profile.underlyingCode !== contract) return 'historical-underlying-mismatch';
  if (volume.basis === 'unverified') return 'historical-volume-unit-unverified';
  if (!Number.isInteger(window.sampleCount) || window.sampleCount < 1) return 'historical-window-unavailable';
  if (!positive(volume.value)) return 'historical-volume-unavailable';
  return null;
}

function compareWindow(direction, window, profile, contract, coefficient, volatilityScale, shockPoints, allowUnverifiedContractVolume) {
  const flow = direction.flow, completeFlow = flow.changeContracts.value;
  const volume = profile?.underlyingCode === contract ? windowVolume(profile, window, allowUnverifiedContractVolume)
    : { value: null, basis: 'unverified' };
  const result = {
    flowMethod: flow.method, flowContracts: completeFlow, knownFlowSubtotal: flow.changeContracts.knownSubtotal,
    windowVolumeBasis: volume.basis,
    volumeShare: null, stressImpactPoints: null, stressVsTypicalMove: null,
    stressVsConditioningMove: null, stressStatus: 'unavailable', reason: null,
  };
  const reason = historyReason(profile, window, contract, volume);
  if (reason) return { ...result, reason };
  if (!flow.changeContracts.complete || !finite(completeFlow)) return { ...result, reason: 'complete-hedge-flow-unavailable' };
  result.volumeShare = Math.abs(completeFlow) / volume.value;
  if (coefficient === null) return { ...result, reason: 'explicit-impact-coefficient-required' };
  if (window.sampleCount < MIN_IMPACT_STRESS_SESSIONS) return { ...result, reason: 'insufficient-history-for-stress' };
  if (!positive(window.medianVolatilityPoints)) return { ...result, reason: 'historical-volatility-unavailable' };
  // A same-window order larger than the entire typical window volume is
  // outside this stress comparison's domain; retain the volume comparison.
  if (result.volumeShare > 1) return { ...result, reason: 'flow-exceeds-typical-window-volume' };
  const sigma = window.medianVolatilityPoints * volatilityScale;
  const impact = coefficient * sigma * Math.sign(completeFlow) * Math.sqrt(result.volumeShare);
  if (!finite(impact)) return { ...result, reason: 'stress-numerical-overflow' };
  return { ...result, stressImpactPoints: impact,
    stressVsTypicalMove: Math.abs(impact) / sigma,
    stressVsConditioningMove: shockPoints > 0 ? Math.abs(impact) / shockPoints : null,
    stressStatus: 'user-assumption', reason: null };
}

/**
 * Compare one current snapshot under +/- shockPoints across historical windows.
 * positionScale is the explicitly assumed fraction of the selected inventory.
 * The optional Y coefficient is a user assumption; OHLCV cannot fit dealer impact.
 * Native historical volume may be interpreted as contracts only after explicit
 * allowUnverifiedContractVolume opt-in; it remains a user assumption in outputs.
 */
export function analyzeSessionImpact({ market, baseline, inventory = 'dealerAllShortOI',
  shockPoints, positionScale = 1, historyProfile = null,
  impactCoefficient = null, volatilityScale = 1, allowUnverifiedContractVolume = false } = {}) {
  if (!INVENTORIES.includes(inventory)) throw new TypeError('Select a supported hypothetical or supplied inventory.');
  if (!finite(shockPoints) || shockPoints < 0) throw new TypeError('shockPoints must be a finite nonnegative price move.');
  if (!finite(positionScale) || positionScale < 0 || positionScale > 1) throw new TypeError('positionScale must be between zero and one.');
  if (impactCoefficient !== null && (!finite(impactCoefficient) || impactCoefficient < 0)) throw new TypeError('An explicit nonnegative impact coefficient or null is required.');
  if (!positive(volatilityScale)) throw new TypeError('volatilityScale must be finite and positive.');
  if (typeof allowUnverifiedContractVolume !== 'boolean') throw new TypeError('allowUnverifiedContractVolume must be an explicit boolean.');
  if (!positive(market?.futuresPrice) || market.futuresPrice - shockPoints <= 0) throw new RangeError('Both scenario futures prices must remain positive.');
  // The engine checks the immutable baseline identity and exact same asOf.
  const baselineRows = baseline?.rows?.filter(row => row.model.status !== 'expired') ?? [];
  const directions = Object.fromEntries([['up', 1], ['down', -1]].map(([name, sign]) => {
    const targetPrice = market.futuresPrice + sign * shockPoints;
    const scenario = analyzeHedgingScenario(market, baseline, {
      scenario: { id: `session-${name}`, asOf: baseline.asOf, ivScale: 1,
        priceByContract: { [market.contract]: targetPrice } },
    });
    const model = modelFlow(baselineRows, scenario, inventory, positionScale);
    const localGamma = localFlow(baselineRows, inventory, positionScale, sign * shockPoints);
    const flow = chooseFlow(model, localGamma), q = flow.changeContracts.value;
    return [name, { targetPrice, priceChangePoints: sign * shockPoints, model, localGamma, flow,
      feedback: !finite(q) ? 'unavailable' : q === 0 || shockPoints === 0 ? 'neutral'
        : Math.sign(q) === sign ? 'procyclical' : 'countercyclical' }];
  }));
  const matchingHistory = historyProfile?.underlyingCode === market.contract;
  const windows = (Array.isArray(historyProfile?.windows) ? historyProfile.windows : []).map(window => ({
    ...window, windowVolumeBasis: matchingHistory ? windowVolume(historyProfile, window, allowUnverifiedContractVolume).basis : 'unverified',
    up: compareWindow(directions.up, window, historyProfile, market.contract, impactCoefficient, volatilityScale, shockPoints, allowUnverifiedContractVolume),
    down: compareWindow(directions.down, window, historyProfile, market.contract, impactCoefficient, volatilityScale, shockPoints, allowUnverifiedContractVolume),
  }));
  const assumedVolume = matchingHistory && historyProfile?.volumeUnit === 'unverified' && allowUnverifiedContractVolume;
  const volumeUnit = matchingHistory && historyProfile?.volumeUnit === 'contracts' ? 'contracts' : assumedVolume ? 'contracts-assumed' : 'unverified';
  return {
    schemaVersion: 1, contract: market.contract, market: market.market ?? null,
    asOf: baseline.asOf, futuresPrice: market.futuresPrice, inventory, positionScale, shockPoints,
    dealerInventoryObserved: false, ...directions, windows,
    historyStatus: historyProfile ? historyProfile.underlyingCode === market.contract ? 'available' : 'underlying-mismatch' : 'unavailable',
    historyAsOf: historyProfile?.asOf ?? null, volumeUnit, allowUnverifiedContractVolume,
    impactBasis: { method: 'window-scaled-square-root-stress', coefficient: impactCoefficient,
      coefficientSource: impactCoefficient === null ? 'not-supplied' : 'user-assumption', volatilityScale,
      volumeBasis: assumedVolume ? 'user-assumption' : volumeUnit === 'contracts' ? 'corroborated-contracts' : 'unverified',
      minimumHistoricalSessions: MIN_IMPACT_STRESS_SESSIONS,
      calibratedFromHistoricalOrderFlow: false,
      formula: 'Y × historical window volatility × volatility scale × sign(net hedge change) × sqrt(abs(net hedge change) / median window volume)',
      interpretation: 'Illustrative one-pass pressure, not a causal forecast, fraction of an observed move, or an addition to the conditioning price shock. Same snapshot and price shock across every window.',
      excludedEffects: 'Actual ownership, execution pace, passive fills, cross-book netting, other traders, news, changing IV/time and feedback re-hedging are not observed or simulated.',
    },
  };
}
