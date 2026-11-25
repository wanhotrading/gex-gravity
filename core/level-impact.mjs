import { greeks, gammaThresholds } from './engine.mjs';
import {deltaTransitionRange} from './delta-transition.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const sum = values => values.reduce((a, b) => a + b, 0);
const YEAR_MINUTES = 365 * 24 * 60;
const nyDateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const dateInNewYork = ms => nyDateFormatter.format(ms);
const logGrid = (lower,upper,intervals) => Array.from({length:intervals+1},(_,i)=>i===0?lower:i===intervals?upper:Math.exp(Math.log(lower)+(Math.log(upper)-Math.log(lower))*i/intervals));
// A conditional, same-future sensitivity model. OI never identifies inventory.
// All deltas use the same pricing model. Elapsed time is an explicit scenario,
// never the computer clock or an assertion that provider inputs were refreshed.
export function createLevelLens({market, analysis, strike, expectedRows, ivScale = 1, expiryScope = 'all', elapsedMinutes = 0} = {}) {
  if (!market || !analysis || !positive(strike) || !positive(ivScale) || !['all','0dte','later'].includes(expiryScope) || !finite(elapsedMinutes) || elapsedMinutes < 0) return null;
  const source = analysis.rows.filter(row => row.strike === strike);
  const asOfMs=Date.parse(analysis.asOf), snapshotDate=finite(asOfMs)?dateInNewYork(asOfMs):null;
  const classification=row=>!finite(row.expiryMs)||snapshotDate===null?'unknown':row.expiryMs<=asOfMs?'expired':dateInNewYork(row.expiryMs)===snapshotDate?'0dte':'later';
  const counts=source.map(classification);
  const selected=row=>expiryScope==='all'||classification(row)===expiryScope;
  // Unresolved clocks remain missing coverage in each isolated slice. They
  // cannot be assigned to 0DTE from a date label or a provider landmark name.
  const active = source.filter(row => classification(row)!=='expired' && (selected(row)||classification(row)==='unknown'));
  const ratio = positive(market.optionMultiplier) && positive(market.hedgeMultiplier) ? market.optionMultiplier / market.hedgeMultiplier : null;
  const rows = active.filter(row => selected(row) && row.model.status === 'active' && finite(row.openInterest) && row.openInterest >= 0 && ratio !== null);
  const excluded = Math.max(0, (expectedRows ?? source.length) - source.length) + active.length - rows.length;
  const selectedClocks=active.filter(row=>selected(row)&&finite(row.expiryMs)).map(row=>(row.expiryMs-asOfMs)/60000);
  const expiryCoverage={zeroDteRows:counts.filter(x=>x==='0dte').length,laterRows:counts.filter(x=>x==='later').length,
    unknownRows:counts.filter(x=>x==='unknown').length,expiredRows:counts.filter(x=>x==='expired').length,
    nearestMinutes:selectedClocks.length?Math.min(...selectedClocks):null,asOf:analysis.asOf??null,
    zeroDteSensitivity:null,totalSensitivity:null};
  const result = {strike, price: market.futuresPrice, modeledRows: rows.length, excludedRows: excluded,
    expiredRows:expiryCoverage.expiredRows, complete: excluded === 0, ivScale, expiryScope,elapsedMinutes,expiryCoverage,profile: null,
    horizonCrossesExpiry:false,flowUnavailableReason:null,scenarioExpiredRows:0,
    sensitivity: null, reportedSensitivity: null, oi: rows.length ? sum(rows.map(row => row.openInterest)) : null};
  result.americanStyle = active.some(row=>row.exerciseStyle==='american');
  result.numericalAmerican = rows.some(row=>row.model.greeks.model.model==='American futures CRR' && (market.rate??0)>0);
  // Keep option identity separate from the combined strike curve. Only the
  // selected option is repriced for delta crossings, so all strikes stay cheap.
  result.deltaSeries=active.filter(row=>selected(row)&&row.model.status==='active'&&elapsedMinutes<row.model.time.minutes).map(row=>({
    id:row.id,optionType:row.optionType,expiry:row.expiry,expiryMs:row.expiryMs,
    iv:row.iv*ivScale,minutes:row.model.time.minutes-elapsedMinutes,
    quoteTimestamp:row.observed.quoteTimestamp,exerciseStyle:row.exerciseStyle,
    parameters:{futuresPrice:market.futuresPrice,strike,iv:row.iv*ivScale,timeYears:(row.model.time.minutes-elapsedMinutes)/YEAR_MINUTES,
      rate:finite(market.rate)?market.rate:0,optionType:row.optionType,exerciseStyle:row.exerciseStyle,
      allowEuropeanApproximation:row.model.greeks.model.europeanApproximation}
  })).sort((a,b)=>a.expiryMs-b.expiryMs||a.optionType.localeCompare(b.optionType)||String(a.id).localeCompare(String(b.id)));
  const deltaCache=new Map();
  result.deltaRange=(id,tail=.05)=>{
    const series=result.deltaSeries.find(row=>row.id===id);if(!series)return null;
    const key=JSON.stringify([id,tail]);
    if(!deltaCache.has(key)){try{deltaCache.set(key,{...deltaTransitionRange(series.parameters,{tail}),series});}catch{deltaCache.set(key,null);}}
    return deltaCache.get(key);
  };
  const reported = active.filter(row => selected(row) && row.observed.usable && finite(row.observed.gamma) && finite(row.openInterest));
  if(reported.length && ratio !== null) result.reportedSensitivity = sum(reported.map(row => row.observed.gamma * row.openInterest * ratio));
  if (!rows.length) {
    // Without exact expiry clocks, only use reported, compatible Greeks for a
    // bounded local approximation. Never invent a fade distance from a date.
    const local=reported.filter(row=>finite(row.observed.delta)&&row.observed.delta>=(row.optionType==='call'?0:-1)&&row.observed.delta<=(row.optionType==='call'?1:0));
    if(!local.length||ivScale!==1||ratio===null||expiryScope!=='all'||elapsedMinutes!==0)return result;
    result.method='reported-linear';result.localRows=local.length;
    result.excludedRows=Math.max(0,(expectedRows??source.length)-source.length)+active.length-local.length;result.complete=result.excludedRows===0;
    result.sensitivity=sum(local.map(row=>row.observed.gamma*row.openInterest*ratio));
    result.maximumMove=Math.min(market.futuresPrice*.001,...local.filter(row=>row.openInterest>0&&row.observed.gamma>0).map(row=>.05/row.observed.gamma));
    const base=sum(local.map(row=>row.observed.delta*row.openInterest*ratio));
    result.flow=(target,side='short',share=1)=>{
      const move=target-market.futuresPrice;
      if(!positive(target)||Math.abs(move)>result.maximumMove||!['short','long'].includes(side)||!finite(share)||share<0||share>1)return null;
      if(local.some(row=>row.openInterest>0&&(row.observed.delta+row.observed.gamma*move<(row.optionType==='call'?0:-1)-1e-12||row.observed.delta+row.observed.gamma*move>(row.optionType==='call'?1:0)+1e-12)))return null;
      const sign=side==='short'?1:-1,before=base*sign*share,change=result.sensitivity*move*sign*share,after=before+change;
      return {before,after,change,priceOnly:change,timeOnly:0,ivOnly:0,interaction:0,ivContribution:0,optionDeltaChange:-change,
        longAdded:Math.max(0,Math.max(0,after)-Math.max(0,before)),longReduced:Math.max(0,Math.max(0,before)-Math.max(0,after)),
        shortAdded:Math.max(0,Math.max(0,-after)-Math.max(0,-before)),shortCovered:Math.max(0,Math.max(0,-before)-Math.max(0,-after))};
    };
    return result;
  }
  result.method='modeled';
  const params = (row, price, scale=ivScale, elapsed=elapsedMinutes) => ({futuresPrice:price,strike,iv:row.iv*scale,timeYears:elapsed===0?row.model.time.years:(row.model.time.minutes-elapsed)/YEAR_MINUTES,
    rate:finite(market.rate)?market.rate:0,optionType:row.optionType,exerciseStyle:row.exerciseStyle,allowEuropeanApproximation:row.model.greeks.model.europeanApproximation});
  const liveRows=rows.filter(row=>elapsedMinutes<row.model.time.minutes);
  result.scenarioExpiredRows=rows.length-liveRows.length;
  result.horizonCrossesExpiry=rows.some(row=>row.openInterest>0&&elapsedMinutes>=row.model.time.minutes);
  result.flowUnavailableReason=result.horizonCrossesExpiry?'expiry-boundary':null;
  const slope = price => sum(liveRows.map(row => greeks(params(row,price)).gamma * row.openInterest * ratio));
  const delta = (price, scale, elapsed=elapsedMinutes) => sum(rows.map(row => row.openInterest===0?0:greeks(params(row,price,scale,elapsed)).delta * row.openInterest * ratio));
  const baseline = delta(market.futuresPrice,1,0);
  result.sensitivity = slope(market.futuresPrice);
  expiryCoverage.totalSensitivity=result.sensitivity;
  expiryCoverage.zeroDteSensitivity=sum(liveRows.filter(row=>classification(row)==='0dte').map(row=>greeks(params(row,market.futuresPrice)).gamma*row.openInterest*ratio));
  result.americanApproximation = rows.some(row => row.model.greeks.model.europeanApproximation);
  result.quoteTimes = rows.map(row=>row.observed.quoteTimestamp).filter(Boolean).sort();
  result.flow = (target, side='short', share=1) => {
    if(result.horizonCrossesExpiry||!positive(target)||!['short','long'].includes(side)||!finite(share)||share<0||share>1) return null;
    const sign=side==='short'?1:-1;
    const before=sign*baseline*share, after=sign*delta(target,ivScale)*share;
    const priceOnly=sign*(delta(target,1,0)-baseline)*share;
    const timeOnly=sign*(delta(market.futuresPrice,1)-baseline)*share;
    const ivOnly=sign*(delta(market.futuresPrice,ivScale,0)-baseline)*share;
    const change=after-before, interaction=change-priceOnly-timeOnly-ivOnly;
    // Incremental IV effect after price + time; isolated effects do not add
    // to the joint result without the explicitly retained interaction term.
    const ivContribution=sign*(delta(target,ivScale)-delta(target,1))*share;
    return {before,after,change,priceOnly,timeOnly,ivOnly,interaction,ivContribution,
      optionDeltaChange:before-after,shortAdded:Math.max(0,-after)-Math.min(Math.max(0,-before),Math.max(0,-after)),
      shortCovered:Math.max(0,-before)-Math.min(Math.max(0,-before),Math.max(0,-after)),
      longAdded:Math.max(0,after)-Math.min(Math.max(0,before),Math.max(0,after)),
      longReduced:Math.max(0,before)-Math.min(Math.max(0,before),Math.max(0,after))};
  };
  result.slopeAt = slope;
  if (!(result.oi > 0)) return result;
  const components = liveRows.filter(row=>row.openInterest>0).map(row=>gammaThresholds({...params(row,market.futuresPrice),fractions:[.01]}));
  if(!components.length)return result;
  // Every component is increasing below its own peak and decreasing above it.
  // Search the whole peak bracket, including individual peaks, then refine each
  // sampled local maximum. No single-expiry profile stands in for the cluster.
  const minPeak=Math.min(...components.map(p=>p.numerical?p.levels[0].lowerPrice:p.peakPrice)),maxPeak=Math.max(...components.map(p=>p.numerical?p.levels[0].upperPrice:p.peakPrice));
  const candidates=[...new Set([...components.map(p=>p.peakPrice),...Array.from({length:129},(_,i)=>minPeak+(maxPeak-minPeak)*i/128)])].sort((a,b)=>a-b);
  const values=candidates.map(slope);let peakPrice=candidates[values.indexOf(Math.max(...values))],peak=slope(peakPrice);
  for(let i=0;i<candidates.length;i++){
    if(values[i]<(values[i-1]??-Infinity)||values[i]<(values[i+1]??-Infinity))continue;
    let a=candidates[Math.max(0,i-1)],b=candidates[Math.min(candidates.length-1,i+1)];
    for(let step=0;step<48&&b>a;step++){const l=a+(b-a)/3,r=b-(b-a)/3;if(slope(l)>slope(r))b=r;else a=l;}
    const price=(a+b)/2,value=slope(price);if(value>peak){peak=value;peakPrice=price;}
  }
  if(!positive(peak))return result;
  const lower=Math.min(...components.map(p=>p.levels[0].lowerPrice)),upper=Math.max(...components.map(p=>p.levels[0].upperPrice));
  // A distant saved price or a later expiry must not erase a very narrow 0DTE
  // component between uniform samples. Resolve each component's 1%-of-peak
  // span as well as the combined envelope; reuse these nodes in the chart.
  const componentNodes=components.flatMap(p=>[p.peakPrice,...logGrid(p.levels[0].lowerPrice,p.levels[0].upperPrice,128)]);
  // Outer crossings: a mixture may have more than one local maximum. The band
  // spans the outermost crossing; it is never described as a support/resistance.
  const scan=[...new Set([lower,upper,peakPrice,...candidates,...componentNodes,...logGrid(lower,upper,512)])].sort((a,b)=>a-b);
  const scanValues=scan.map(slope);
  const bands=[.5,.25,.1].map(fraction=>{
    const crossings=[];
    for(let i=1;i<scan.length;i++){
      if((scanValues[i-1]>=peak*fraction)===(scanValues[i]>=peak*fraction))continue;
      let a=scan[i-1],b=scan[i],above=scanValues[i-1]>=peak*fraction;
      for(let j=0;j<44;j++){const m=(a+b)/2;if((slope(m)>=peak*fraction)===above)a=m;else b=m;}
      crossings.push((a+b)/2);
    }
    return {fraction,lower:crossings[0]??null,upper:crossings.at(-1)??null,disconnected:crossings.length>2};
  });
  const half=bands[0],low=Math.min(half.lower??lower,market.futuresPrice,strike),high=Math.max(half.upper??upper,market.futuresPrice,strike),pad=(high-low)*.15;
  const chartLow=Math.max(.000001,Math.min(lower,low-pad)),chartHigh=Math.max(upper,high+pad);
  const chartPrices=[...new Set([chartLow,chartHigh,peakPrice,strike,market.futuresPrice,...componentNodes,
    ...bands.flatMap(b=>[b.lower,b.upper]).filter(positive),
    ...Array.from({length:121},(_,i)=>chartLow+(chartHigh-chartLow)*i/120)])].filter(positive).sort((a,b)=>a-b);
  result.profile={peak,peakPrice,ratio:Math.min(1,result.sensitivity/peak),bands,
    points:chartPrices.map(price=>{const sensitivity=slope(price);return {price,sensitivity,ratio:sensitivity/peak};}),
    strengthens: slope(market.futuresPrice*(1+1e-5))>=slope(market.futuresPrice*(1-1e-5))?'up':'down'};
  return result;
}

export function rankLevelLenses(lenses) {
  const total=sum(lenses.filter(row=>finite(row.sensitivity)).map(row=>row.sensitivity));
  return lenses.map(row=>({...row,shareOfWatched:total>0&&finite(row.sensitivity)?row.sensitivity/total:null}))
    .sort((a,b)=>(b.sensitivity??-1)-(a.sensitivity??-1)||Math.abs(a.strike-a.price)-Math.abs(b.strike-b.price));
}

export function compareLevelHistory({profile,underlyingCode,windowId,flow}={}) {
  if(profile?.underlyingCode!==underlyingCode)return null;
  const window=profile.windows?.find(row=>row.id===windowId);
  if(!window||!window.sampleCount)return null;
  return {...window,flowShare:profile.volumeUnit==='contracts'&&positive(window.medianVolumeContracts)&&finite(flow)?Math.abs(flow)/window.medianVolumeContracts:null};
}
