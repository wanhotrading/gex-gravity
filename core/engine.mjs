/**
 * Provider-independent European Black-76 / American CRR engine for futures options.
 * IV is decimal (20% = 0.20), rates are continuously compounded decimals,
 * prices/strikes use native futures points, and time uses ACT/365 calendar time.
 * Scenarios hold the selected option's IV and remaining time constant. They
 * describe model sensitivity, not price probabilities, targets, or dealer flows.
 * American tree uses zero futures carry and early exercise at every node.
 * Numerical Greeks use the first two tree layers, as in standard lattice methods.
 */

export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function positive(value, name) {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be greater than zero.`);
  return value;
}

function timestamp(value, name) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') {
    // Reject local/ambiguous date-times; the provider must identify the zone.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      throw new TypeError(`${name} must include Z or an explicit UTC offset.`);
    }
    value = Date.parse(value);
  }
  return finite(value, name);
}

function modelDetails({ exerciseStyle = 'european', allowEuropeanApproximation = false } = {}) {
  if (!['european', 'american'].includes(exerciseStyle)) {
    throw new RangeError('exerciseStyle must be european or american.');
  }
  if (typeof allowEuropeanApproximation !== 'boolean') {
    throw new TypeError('allowEuropeanApproximation must be a boolean.');
  }
  const approximation = exerciseStyle === 'american' && allowEuropeanApproximation;
  const american = exerciseStyle === 'american' && !approximation;
  return {
    model: american ? 'American futures CRR' : 'Black-76',
    exerciseStyle,
    europeanApproximation: approximation,
    label: american ? 'American futures model with early exercise; numerical CRR lattice' : approximation
      ? 'European Black-76 approximation for an American-style option'
      : 'European Black-76, constant-IV price scenario',
  };
}

function modelInputs(input) {
  const model = modelDetails(input);
  positive(input.strike, 'strike');
  positive(input.iv, 'iv');
  finite(input.timeYears, 'timeYears');
  finite(input.rate ?? 0, 'rate');
  return model;
}

/** Normal CDF. Rational central approximation and a continued-fraction tail. */
export function normalCdf(x) {
  finite(x, 'x');
  const y = Math.abs(x);
  if (y > 37) return x < 0 ? 0 : 1;
  const exponential = Math.exp(-y * y / 2);
  let tail;
  if (y < 7.0710678118654755) {
    const numerator = ((((((0.0352624965998911 * y + 0.700383064443688) * y
      + 6.37396220353165) * y + 33.912866078383) * y + 112.079291497871) * y
      + 221.213596169931) * y + 220.206867912376);
    const denominator = (((((((0.0883883476483184 * y + 1.75566716318264) * y
      + 16.064177579207) * y + 86.7807322029461) * y + 296.564248779674) * y
      + 637.333633378831) * y + 793.826512519948) * y + 440.413735824752);
    tail = exponential * numerator / denominator;
  } else {
    const denominator = y + 1 / (y + 2 / (y + 3 / (y + 4 / (y + 0.65))));
    tail = exponential / denominator / SQRT_TWO_PI;
  }
  return x > 0 ? 1 - tail : tail;
}

export function normalPdf(x) {
  finite(x, 'x');
  return Math.exp(-x * x / 2) / SQRT_TWO_PI;
}

// Recombining futures tree: E[F(t+dt)|F(t)] = F(t), hence p=1/(u+1).
// At every node compare discounted continuation with immediate exercise.
// Greeks use the first two tree layers; average adjacent step counts to reduce
// odd/even oscillation. These are numerical estimates, especially near exercise.
function futuresTree(input, steps) {
  const {futuresPrice:F,strike:K,iv,timeYears:T,rate=0,optionType='put'}=input;
  const dt=T/steps, h=iv*Math.sqrt(dt), u=Math.exp(h), p=1/(1+u), df=Math.exp(-rate*dt), sign=optionType==='call'?1:-1;
  if (!(h>1e-9) || h*steps>500 || !Number.isFinite(df)) throw new RangeError('American tree inputs exceed the supported numerical range.');
  const values=new Float64Array(steps+1), intrinsic=s=>Math.max(0,sign*(s-K));
  let s=F*Math.exp(-h*steps), step=u*u;
  for(let j=0;j<=steps;j++,s*=step)values[j]=intrinsic(s);
  let delta=null,gamma=null;
  for(let i=steps-1;i>=0;i--){
    s=F*Math.exp(-h*i);
    for(let j=0;j<=i;j++,s*=step)values[j]=Math.max(intrinsic(s),df*((1-p)*values[j]+p*values[j+1]));
    if(i===2){const lo=F/(u*u),hi=F*u*u;gamma=((values[2]-values[1])/(hi-F)-(values[1]-values[0])/(F-lo))/((hi-lo)/2);}
    if(i===1)delta=(values[1]-values[0])/(F*u-F/u);
  }
  if(intrinsic(F)>0 && Math.abs(values[0]-intrinsic(F))<1e-10*Math.max(1,K)){delta=sign;gamma=0;}
  if(![values[0],delta,gamma].every(Number.isFinite))throw new RangeError('American tree could not calculate finite Greeks.');
  return {price:values[0],delta,gamma:Math.max(0,gamma)};
}

function americanFuturesGreeks(input,model){
  const steps=input.treeSteps??300;
  if(!Number.isInteger(steps)||steps<50||steps>1600)throw new RangeError('treeSteps must be an integer from 50 to 1600.');
  const a=futuresTree(input,steps),b=futuresTree(input,steps+1);
  return {status:'active',model:{...model,steps:[steps,steps+1],numericalMethod:'adjacent-step averaged CRR; futures carry zero'},
    price:(a.price+b.price)/2,delta:(a.delta+b.delta)/2,gamma:(a.gamma+b.gamma)/2,d1:null,d2:null};
}

const americanProfileCache=new Map();
function americanThresholds(input,model){
  const {strike:K,iv,timeYears:T,rate=0,optionType='put',fractions=[.5,.25,.1]}=input;
  const key=JSON.stringify([K,iv,T,rate,optionType,input.treeSteps??300,fractions]);
  if(americanProfileCache.has(key))return structuredClone(americanProfileCache.get(key));
  const width=Math.min(10,Math.max(.03,8*iv*Math.sqrt(T)+1.5*iv*iv*T));
  const points=Array.from({length:161},(_,i)=>{const price=K*Math.exp(-width+2*width*i/160);return {price,gamma:greeks({...input,futuresPrice:price}).gamma};});
  const peak=points.reduce((a,b)=>b.gamma>a.gamma?b:a);
  if(!(peak.gamma>0))throw new RangeError('American gamma profile could not resolve a peak.');
  const levels=fractions.map(fraction=>{
    if(fraction===1)return {fraction,lowerPrice:peak.price,upperPrice:peak.price,pointsBelowStrike:K-peak.price,pointsAboveStrike:peak.price-K};
    const target=peak.gamma*fraction,crossings=[];
    if(points[0].gamma>=target||points.at(-1).gamma>=target)throw new RangeError('American gamma band is outside the numerical search range.');
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if((a.gamma>=target)===(b.gamma>=target))continue;crossings.push(a.price+(b.price-a.price)*(target-a.gamma)/(b.gamma-a.gamma));}
    if(crossings.length<2)throw new RangeError('American gamma band could not be resolved.');
    const lowerPrice=crossings[0],upperPrice=crossings.at(-1);
    return {fraction,lowerPrice,upperPrice,pointsBelowStrike:K-lowerPrice,pointsAboveStrike:upperPrice-K,disconnected:crossings.length>2};
  });
  const result={status:'active',model,numerical:true,reference:'Numerical American gamma profile; outer crossings on a finite price grid',peakPrice:peak.price,peakGamma:peak.gamma,gammaAtStrike:greeks({...input,futuresPrice:K}).gamma,levels};
  if(americanProfileCache.size>=128)americanProfileCache.delete(americanProfileCache.keys().next().value);
  americanProfileCache.set(key,result);return structuredClone(result);
}

/** Explicit time zone required for strings. Negative time is an expired state. */
export function act365Time({ expiry, now = Date.now() }) {
  const expiryMs = timestamp(expiry, 'expiry');
  const asOfMs = timestamp(now, 'now');
  const remainingMs = expiryMs - asOfMs;
  return {
    status: remainingMs > 0 ? 'active' : 'expired',
    expiryMs,
    asOfMs,
    remainingMs: Math.max(0, remainingMs),
    minutes: Math.max(0, remainingMs / 60000),
    years: Math.max(0, remainingMs / YEAR_MS),
    convention: 'ACT/365 calendar time',
  };
}

/**
 * Long-option price and derivatives with respect to the futures price.
 * Delta: per futures point; Gamma: change in Delta per futures point.
 * Multipliers are deliberately excluded here. They belong in exposure sizing.
 */
export function greeks(input) {
  const model = modelInputs(input);
  const {
    futuresPrice: F, strike: K, iv, timeYears: T,
    rate = 0, optionType = 'put',
  } = input;
  positive(F, 'futuresPrice');
  if (!['call', 'put'].includes(optionType)) throw new RangeError('optionType must be call or put.');
  if (T <= 0) return { status: 'expired', model, price: null, delta: null, gamma: null, d1: null, d2: null };
  if (model.model === 'American futures CRR') {
    // With zero carry on a futures underlying and a nonpositive discount rate,
    // convex payoff + conditional Jensen implies waiting dominates exercise.
    // Use the analytic value in that special case, without changing the style.
    if (rate <= 0) return {...greeks({...input, exerciseStyle:'european', allowEuropeanApproximation:false}),
      model:{...model, numericalMethod:'analytic no-early-exercise limit', rateAssumption:rate}};
    return americanFuturesGreeks(input, model);
  }
  const a = iv * Math.sqrt(T);
  const discount = Math.exp(-rate * T);
  const d1 = (Math.log(F / K) + 0.5 * a * a) / a;
  const d2 = d1 - a;
  if (![a, discount, d1, d2].every(Number.isFinite) || a <= 0 || discount <= 0) {
    throw new RangeError('Inputs exceed the supported numerical range.');
  }
  const delta = optionType === 'call' ? discount * normalCdf(d1) : -discount * normalCdf(-d1);
  const gamma = discount * normalPdf(d1) / (F * a);
  const price = optionType === 'call'
    ? discount * (F * normalCdf(d1) - K * normalCdf(d2))
    : discount * (K * normalCdf(-d2) - F * normalCdf(-d1));
  if (![delta, gamma, price].every(Number.isFinite)) throw new RangeError('Calculated values exceed the supported numerical range.');
  return { status: 'active', model, price: Math.max(0, price), delta, gamma, d1, d2 };
}

/**
 * Exact constant-IV Gamma profile relative to its own peak at this expiry/time.
 * It is not the same as the Gamma of an ATM contract with a changing strike.
 */
export function gammaThresholds(input) {
  const model = modelInputs(input);
  const { strike: K, iv, timeYears: T, rate = 0, fractions = [0.5, 0.25, 0.1] } = input;
  if (!Array.isArray(fractions) || fractions.length === 0) throw new TypeError('fractions must be a nonempty array.');
  for (const fraction of fractions) {
    finite(fraction, 'Gamma fraction');
    if (fraction <= 0 || fraction > 1) throw new RangeError('Each Gamma fraction must be greater than zero and at most one.');
  }
  if (T <= 0) return { status: 'expired', model, peakPrice: null, peakGamma: null, gammaAtStrike: null, levels: [] };
  if (model.model === 'American futures CRR' && rate > 0) return americanThresholds(input, model);
  const a = iv * Math.sqrt(T);
  const peakPrice = K * Math.exp(-1.5 * a * a);
  positive(peakPrice, 'calculated peakPrice');
  const peakGamma = greeks({ ...input, futuresPrice: peakPrice, rate }).gamma;
  const gammaAtStrike = greeks({ ...input, futuresPrice: K, rate }).gamma;
  const levels = fractions.map(fraction => {
    const width = a * Math.sqrt(2 * Math.log(1 / fraction));
    const lowerPrice = peakPrice * Math.exp(-width);
    const upperPrice = peakPrice * Math.exp(width);
    if (![lowerPrice, upperPrice].every(Number.isFinite) || lowerPrice <= 0) {
      throw new RangeError('Threshold prices exceed the supported numerical range.');
    }
    return {
      fraction,
      lowerPrice,
      upperPrice,
      pointsBelowStrike: K - lowerPrice,
      pointsAboveStrike: upperPrice - K,
    };
  });
  return {
    status: 'active', model,
    reference: 'modeled Gamma peak for this fixed strike, IV and time',
    peakPrice, peakGamma, gammaAtStrike, levels,
  };
}

/**
 * Theoretical futures hedge for a user-specified signed option position.
 * q > 0: long options; q < 0: short options. Multipliers: currency per point.
 * No quantity => no inferred inventory or hedge sizes. Fractional contracts are
 * mathematical equivalents, not instructions about executable order sizes.
 */
export function hedgeAdjustment(input) {
  const { currentFuturesPrice, scenarioFuturesPrice, signedQuantity = null,
    optionMultiplier, hedgeMultiplier } = input;
  const current = greeks({ ...input, futuresPrice: currentFuturesPrice });
  const scenario = greeks({ ...input, futuresPrice: scenarioFuturesPrice });
  if (current.status === 'expired') return { status: 'expired', current, scenario, positionProvided: false, hedge: null };
  if (signedQuantity === null || signedQuantity === undefined) {
    return { status: 'active', current, scenario, positionProvided: false, hedge: null };
  }
  finite(signedQuantity, 'signedQuantity');
  positive(optionMultiplier, 'optionMultiplier');
  positive(hedgeMultiplier, 'hedgeMultiplier');
  const multiplierRatio = optionMultiplier / hedgeMultiplier;
  const currentHedgeContracts = -signedQuantity * multiplierRatio * current.delta;
  const scenarioHedgeContracts = -signedQuantity * multiplierRatio * scenario.delta;
  const adjustmentContracts = scenarioHedgeContracts - currentHedgeContracts;
  const hedge = {
    interpretation: 'theoretical hedge for the supplied signed position; actual dealer inventory is unknown',
    signedQuantity,
    optionMultiplier,
    hedgeMultiplier,
    currentHedgeContracts,
    scenarioHedgeContracts,
    adjustmentContracts,
    adjustmentDirection: adjustmentContracts > 0 ? 'buy' : adjustmentContracts < 0 ? 'sell' : 'unchanged',
    currentDeltaExposurePerPoint: signedQuantity * optionMultiplier * current.delta,
    scenarioDeltaExposurePerPoint: signedQuantity * optionMultiplier * scenario.delta,
    currentGammaExposurePerPointSquared: signedQuantity * optionMultiplier * current.gamma,
  };
  if (Object.values(hedge).some(value => typeof value === 'number' && !Number.isFinite(value))) {
    throw new RangeError('Hedge size exceeds the supported numerical range.');
  }
  return { status: 'active', current, scenario, positionProvided: true, hedge };
}

/** Fresh calculation only; this engine never caches or carries old Greeks. */
export function evaluateSnapshot(input) {
  const time = act365Time({ expiry: input.expiry, now: input.now });
  if (time.status === 'expired') return { status: 'expired', time, greeks: null, thresholds: null };
  const parameters = { ...input, timeYears: time.years };
  return {
    status: 'active',
    time,
    greeks: greeks(parameters),
    thresholds: gammaThresholds(parameters),
  };
}
