import {createLevelLens} from './level-impact.mjs';
import {sensitivityTransitions} from './market-reading.mjs';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;

/** Sample the two displayed curves at one shared price, without filling missing inputs. */
export function sampleExpiryComparison(data,price){
  const chart=data?.chart,points=chart?.points;
  if(!finite(price)||!points?.length||!positive(chart.hi-chart.lo))return null;
  price=Math.max(chart.lo,Math.min(chart.hi,price));
  let lo=0,hi=points.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].price<price)lo=mid+1;else hi=mid;}
  const right=points[lo],left=points[Math.max(0,lo-1)];
  const value=key=>{
    if(price===right.price)return finite(right[key])?right[key]:null;
    if(price===left.price)return finite(left[key])?left[key]:null;
    if(!finite(left[key])||!finite(right[key])||right.price<=left.price)return null;
    return left[key]+(right[key]-left[key])*(price-left.price)/(right.price-left.price);
  };
  const overall=value('overall'),zeroDte=value('zeroDte');
  const ratio=(value,peak)=>finite(value)&&positive(peak)?Math.max(0,Math.min(1,value/peak)):null;
  return {price,overall,zeroDte,overallRatio:ratio(overall,chart.overallPeak),zeroDteRatio:ratio(zeroDte,chart.zeroDtePeak),
    zeroDteShare:positive(overall)&&finite(zeroDte)?zeroDte/overall:null};
}

/** Compare one strike with identical inputs, clock, IV and OI scaling.
 * The unsigned 0DTE subset never supplies a dealer inventory sign.
 */
export function compareExpirySensitivity({market,analysis,strike,expectedRows,ivScale=1,elapsedMinutes=0}={}){
  if(!market||!analysis||market.contract!==analysis.contract||!positive(strike))return null;
  const options={market,analysis,strike,expectedRows,ivScale,elapsedMinutes};
  const overall=createLevelLens({...options,expiryScope:'all'}),zeroDte=createLevelLens({...options,expiryScope:'0dte'});
  if(!overall||!zeroDte)return null;
  const summarize=lens=>({sensitivity:lens.sensitivity,modeledRows:lens.modeledRows,excludedRows:lens.excludedRows,complete:lens.complete,
    scenarioExpiredRows:lens.scenarioExpiredRows,transitions:sensitivityTransitions(lens.profile),peak:lens.profile?.peak??null,peakPrice:lens.profile?.peakPrice??null});
  const result={contract:market.contract,strike,asOf:analysis.asOf,ivScale,elapsedMinutes,overall:summarize(overall),zeroDte:summarize(zeroDte),
    zeroDteShare:positive(overall.sensitivity)&&finite(zeroDte.sensitivity)?zeroDte.sensitivity/overall.sensitivity:null,
    unresolvedExpiryRows:overall.expiryCoverage?.unknownRows??0,chart:null};
  if(!overall.profile||!positive(overall.profile.peak))return result;
  const profiles=[overall.profile,zeroDte.profile].filter(Boolean),bounds=profiles.flatMap(profile=>{
    const band=profile.bands.find(row=>row.fraction===.1);return [band?.lower??profile.points[0]?.price,band?.upper??profile.points.at(-1)?.price];
  }).filter(positive);
  const lower=Math.min(market.futuresPrice,strike,...bounds),upper=Math.max(market.futuresPrice,strike,...bounds),pad=Math.max(market.tickSize??.01,(upper-lower)*.05);
  const lo=Math.max(.000001,lower-pad),hi=upper+pad;
  const prices=[...new Set([lo,hi,strike,market.futuresPrice,...profiles.flatMap(profile=>profile.points.map(row=>row.price)),...Array.from({length:161},(_,i)=>lo+(hi-lo)*i/160)])].filter(price=>price>=lo&&price<=hi).sort((a,b)=>a-b);
  result.chart={lo,hi,snapshotPrice:market.futuresPrice,overallPeak:overall.profile.peak,zeroDtePeak:zeroDte.profile?.peak??null,
    points:prices.map(price=>({price,overall:overall.slopeAt(price),zeroDte:finite(zeroDte.sensitivity)?zeroDte.slopeAt?.(price)??null:null}))};
  return result;
}
