import {MENTHORQ_INTRADAY_START} from './trading-sessions.mjs';

const finite = x => typeof x === 'number' && Number.isFinite(x);
export function nyClock(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute),weekday:p.weekday};
}
export function contextFreshness(context, now = Date.now()) {
  if (!context?.levels?.length) return {state:'missing',label:'MenthorQ map needed',usable:false};
  const clock=nyClock(now),mode=context.mode??(/Intraday/i.test(context.expiryScope??'')?'Intraday':'EOD');
  const checked=Date.parse(context.lastCheckedAt??context.capturedAt??''),asOf=Date.parse(context.asOf??'');
  const sameDate=context.sourceDate===clock.date,session=clock.minute>=MENTHORQ_INTRADAY_START&&clock.minute<=960&&!['Sat','Sun'].includes(clock.weekday);
  const recentCheck=finite(checked)&&now-checked>=-60000&&now-checked<=10*60000;
  if(mode==='Intraday'&&session){
    if(!sameDate||!recentCheck)return {state:'stale',label:'Intraday check overdue',usable:false};
    if(!finite(asOf))return {state:'unverified',label:'Latest checked · source clock unverified',usable:false};
    const allowance=context.delayStatus==='delayed'?30*60000:10*60000;
    if(now-asOf>allowance||asOf>now+60000)return {state:'stale',label:'Provider snapshot behind schedule',usable:false};
    return {state:context.delayStatus==='delayed'?'delayed':'fresh',label:context.delayStatus==='delayed'?'Latest checked · provider delayed':'Current intraday snapshot',usable:true};
  }
  if(!finite(asOf))return {state:'reference',label:'Reference map · source clock unverified',usable:false};
  if(now-asOf>36*3600000)return {state:'stale',label:'Older reference map',usable:false};
  return {state:'reference',label:mode==='EOD'?'EOD reference · not intraday':'Session reference · outside update window',usable:false};
}
export function regimeReading(context, now=Date.now()) {
  const r=context?.regime;
  const valid=r&&finite(r.netGex)&&r.scope==='all-expiries'&&['Intraday','EOD'].includes(r.mode);
  if(!valid)return {sign:'unknown',side:null,label:'Regime not supplied',current:false};
  const sign=r.netGex>0?'positive':r.netGex<0?'negative':'zero',side=sign==='negative'?'short':sign==='positive'?'long':null;
  const fresh=contextFreshness({...context,mode:r.mode,asOf:r.asOf,sourceDate:r.sourceDate,delayStatus:r.delayStatus,lastCheckedAt:r.capturedAt},now);
  return {sign,side,label:sign==='zero'?'Zero net gamma':`${sign==='negative'?'Negative':'Positive'} gamma`,current:fresh.usable,source:r,freshness:fresh};
}
export function menthorqLevelsObservation(collector,market){
  if(!market?.underlyingCode)return null;
  return collector?.menthorqMarkets?.find(row=>row.underlyingCode===market.underlyingCode&&row.observedLevelsAt)??null;
}
export function menthorqFeedHealth(collector,market,now=Date.now()){
  const context=market?.watchContext,matched=context?.underlyingCode===market?.underlyingCode&&context?.levels?.length;
  const saved=matched?`Saved map ${context.sourceDate??'date unverified'}${context.sourceLocalTime?' '+context.sourceLocalTime+' (provider clock)':''}.`:'No matching saved map.';
  if(['exposure-map','levels-and-exposure'].includes(collector?.menthorqScope)){
    const levelsAutomatic=collector.menthorqScope==='levels-and-exposure';
    const levels=levelsAutomatic?saved:`${saved} Use Update MenthorQ levels for walls and watched strikes.`;
    const warning=(label,message)=>({warning:true,label,message:`${message} ${levels}`});
    if(collector.status==='offline')return warning('MenthorQ Exposure collector offline','Check that Windows is awake and signed in.');
    if(collector.menthorqCode==='MQ_LOGIN_REQUIRED')return warning('MenthorQ sign-in required','Sign in to the dedicated Chrome window.');
    if(collector.menthorqCode==='MQ_ACCESS_ATTENTION')return warning('MenthorQ access needs attention','Check MenthorQ’s access message.');
    const read=matched&&context.exposure?.collection==='exposure-map'?context.exposure:null;
    const checked=Date.parse(read?.capturedAt??'');
    const clock=nyClock(now);
    const intraday=clock.minute>=MENTHORQ_INTRADAY_START+10&&clock.minute<=960&&!['Sat','Sun'].includes(clock.weekday);
    const exposureAge=intraday?15*60000:36*3600000;
    if(levelsAutomatic&&collector.menthorq==='partial'&&collector.menthorqStage==='levels'&&read?.rows?.length
      &&finite(checked)&&now-checked>=-60000&&now-checked<=exposureAge){
      if(collector.menthorqCode==='MQ_NEW_PUBLICATION_UNAVAILABLE'){
        // A different contract can still be waiting while this market has today's map.
        if(matched&&context.sourceDate===clock.date)return {warning:false,label:'MenthorQ Exposure checked',message:levels};
        const observed=menthorqLevelsObservation(collector,market);
        const date=observed?.observedLevelsDate;
        return warning('MenthorQ Levels pending',date
          ?`The Levels page returned ${date}${observed.observedLevelsLocalTime?' '+observed.observedLevelsLocalTime+' (provider clock)':''}.`
          :'Waiting for a current Levels publication.');
      }
      if(/^(?:MQ_UI_TIMEOUT|MQ_LEVELS_[A-Z_]+_TIMEOUT)$/.test(collector.menthorqCode??'')){
        return warning('MenthorQ Levels check timed out','The collector retries Levels on its next scheduled check.');
      }
    }
    if(['blocked','partial','error','auth-required'].includes(collector.menthorq)){
      return warning(levelsAutomatic?'MenthorQ update incomplete':'MenthorQ Exposure update incomplete','Check the Levels and Exposure timestamps below.');
    }
    if(!read?.rows?.length||!finite(checked))return warning('Awaiting MenthorQ Exposure','Automatic Net GEX checks use the saved watched strikes.');
    if(now-checked>exposureAge)return warning('MenthorQ Exposure check overdue','Showing the last saved Exposure capture.');
    const outdatedLevels=!context.sourceDate||context.sourceDate<(intraday?clock.date:nyClock(now-36*3600000).date);
    return {warning:outdatedLevels,label:outdatedLevels?'MenthorQ Levels overdue':'MenthorQ Exposure checked',message:levels};
  }
  if(['manual-import','not-enabled'].includes(collector?.menthorqCode))return {warning:true,label:'MenthorQ automatic updates paused',message:`${saved} Import a current export in Data & settings. Futu connection status does not confirm MenthorQ updates.`};
  if(collector?.enabled&&collector.status==='offline')return {warning:true,label:'MenthorQ collector not responding',message:`${saved} Check that Windows is awake and signed in. The last saved map is retained.`};
  if(collector?.menthorqCode==='MQ_LOGIN_REQUIRED')return {warning:true,label:'MenthorQ sign-in required',message:`${saved} Sign in to the dedicated Chrome window. Saved levels are not a live feed.`};
  if(collector?.menthorqCode==='MQ_ACCESS_ATTENTION')return {warning:true,label:'MenthorQ access needs attention',message:`${saved} Open MenthorQ to check its access message. Repeated requests are slowed.`};
  if(['blocked','partial','error','auth-required'].includes(collector?.menthorq))return {warning:true,label:'MenthorQ update incomplete',message:`${saved} Levels or separate Exposure values may be missing. Check source dates before using the chart.`};
  const fresh=contextFreshness(matched?context:null,now);
  const olderDate=matched&&typeof context.sourceDate==='string'&&context.sourceDate<nyClock(now-36*3600000).date;
  if(olderDate||['stale','missing'].includes(fresh.state))return {warning:true,label:matched?'MenthorQ map outdated':'MenthorQ map missing',message:`${saved} A running collector is not proof of a successful data update.`};
  return {warning:false,label:context?.delayStatus==='delayed'?'MenthorQ saved map · delayed':'MenthorQ saved map',message:`${saved} ${fresh.label}.`};
}
export function quoteMovement(market,now=Date.now()) {
  const old=market?.previousPriceObservation,at=Date.parse(market?.priceTimestamp??''),before=Date.parse(old?.asOf??'');
  if(!old||old.underlyingCode!==market.underlyingCode||!finite(old.price)||!finite(market.underlyingPrice)||!finite(at)||!finite(before)||at<=before||at-before>15*60000||now-at>20*60000||at>now+60000)return null;
  return {change:market.underlyingPrice-old.price,from:old.price,to:market.underlyingPrice,fromTime:old.asOf,toTime:market.priceTimestamp,minutes:(at-before)/60000};
}
export function hedgeReaction(side, move) {
  if(!['short','long'].includes(side)||!finite(move))return 'unknown';
  if(move===0)return 'flat';
  return move*(side==='short'?1:-1)>0?'buy':'sell';
}
function modeledCurves(lenses) {
  return lenses.filter(lens => finite(lens.profile?.peak) && lens.profile.peak > 0 &&
    typeof lens.slopeAt === 'function' && finite(lens.sensitivity));
}

export function buildOverallSensitivity(lenses, referencePrice) {
  const included = modeledCurves(lenses);
  if (!included.length) return null;
  if (included.length === 1) {
    const [lens] = included;
    return {...lens.profile, slopeAt: lens.slopeAt, modeledLevels: 1, totalLevels: lenses.length};
  }

  // Sum absolute sensitivities on a common price grid. The individual profile
  // nodes retain resolution near narrow expiry peaks across the whole range.
  const prices = new Set([referencePrice]);
  for (const lens of included) {
    prices.add(lens.profile.peakPrice);
    const points = lens.profile.points ?? [];
    for (let i = 0; i < points.length; i += 4) prices.add(points[i].price);
    if (points.length) prices.add(points.at(-1).price);
  }
  const anchors = [...prices].filter(price => finite(price) && price > 0).sort((a, b) => a - b);
  const lower = anchors[0], upper = anchors.at(-1);
  if (!(upper > lower)) return null;
  const grid = [...new Set([...anchors, ...Array.from({length: 361}, (_, i) => lower + (upper - lower) * i / 360)])].sort((a, b) => a - b);
  const slopeAt = price => included.reduce((total, lens) => total + lens.slopeAt(price), 0);
  const points = grid.map(price => ({price, sensitivity: slopeAt(price)}));
  const peakPoint = points.reduce((best, point) => point.sensitivity > best.sensitivity ? point : best);
  if (!finite(peakPoint.sensitivity) || peakPoint.sensitivity <= 0) return null;
  return {
    peak: peakPoint.sensitivity,
    peakPrice: peakPoint.price,
    points: points.map(point => ({...point, ratio: point.sensitivity / peakPoint.sensitivity})),
    slopeAt,
    modeledLevels: included.length,
    totalLevels: lenses.length
  };
}

function sampleStrikeSensitivity(lens, price) {
  const points = lens.profile.points;
  if (!points?.length || price < points[0].price || price > points.at(-1).price) return lens.slopeAt(price);
  let low = 0, high = points.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    if (points[middle].price <= price) low = middle;
    else high = middle;
  }
  const a = points[low], b = points[high];
  const start = a.sensitivity ?? a.ratio * lens.profile.peak;
  const end = b.sensitivity ?? b.ratio * lens.profile.peak;
  if (!finite(start) || !finite(end)) return lens.slopeAt(price);
  return b.price > a.price ? start + (end - start) * (price - a.price) / (b.price - a.price) : start;
}

// Local hedge rates on a rising price. Falling prices reverse each side.
// The signed position assumption sets direction. Futu and included OI set
// the magnitude. Net flow offsets opposing hedge rates at the same price.
export function buildHedgeFlow(lenses, sides, share, {lo, hi}) {
  const included = modeledCurves(lenses).filter(lens => sides.has(lens.key));
  if (!included.length || !finite(share) || share < 0 || share > 1 || !(hi > lo)) return null;
  const sample = price => {
    let buy = 0, sell = 0;
    for (const lens of included) {
      const rate = Math.max(0, sampleStrikeSensitivity(lens, price)) * share;
      if (sides.get(lens.key) === 'short') buy += rate;
      else sell += rate;
    }
    return {price, buy, sell, net: buy - sell};
  };
  // Include profile nodes and peaks for all contributors, even when the main
  // chart omits their individual curves or they have a very narrow 0DTE peak.
  const prices = [...new Set([
    lo, hi, ...Array.from({length: 179}, (_, i) => lo + (hi - lo) * (i + 1) / 180),
    ...included.flatMap(lens => [lens.profile.peakPrice,
      ...(lens.profile.points ?? []).filter((_, i) => i % 8 === 0).map(point => point.price)
    ]).filter(price => finite(price) && price > lo && price < hi)
  ])].sort((a, b) => a - b);
  const points = prices.map(sample);
  const peak = side => points.reduce((best, point) => point[side] > best[side] ? point : best);
  return {points, peakBuy: peak('buy'), peakSell: peak('sell'),
    peakNetBuy: peak('net'), peakNetSell: points.reduce((best, point) => point.net < best.net ? point : best), sample,
    modeledLevels: included.length, partialCoverage: included.some(lens => lens.complete === false)};
}

// Activity magnitude does not require a direction assumption. Signed rates are
// a separate subset; an unavailable sign must never become a zero contribution.
export function buildHedgeActivity(lenses, sides, share, window) {
  const included=modeledCurves(lenses),{lo,hi}=window;
  if(!included.length||!finite(share)||share<0||share>1||!(hi>lo))return null;
  const signed=buildHedgeFlow(lenses,sides,share,window);
  const sample=price=>({price,gross:included.reduce((total,lens)=>total+Math.max(0,sampleStrikeSensitivity(lens,price))*share,0),
    net:signed?.sample(price).net??null});
  const prices=[...new Set([lo,hi,...Array.from({length:181},(_,i)=>lo+(hi-lo)*i/180),
    ...(signed?.points??[]).map(p=>p.price),...included.flatMap(l=>[l.profile.peakPrice,...(l.profile.points??[])
      .filter((_,i)=>i%8===0).map(p=>p.price)]).filter(p=>finite(p)&&p>lo&&p<hi)])].sort((a,b)=>a-b);
  const points=prices.map(sample),peakGross=points.reduce((a,b)=>b.gross>a.gross?b:a);
  // Contiguous half-peak region around each behavior's strongest point in view.
  // Split at valleys/sign changes; these are sensitivity bands, not barriers.
  const zone=sign=>{
    if(!signed)return null;
    const rate=p=>Math.max(0,sign*p.net),peak=points.reduce((a,b)=>rate(b)>rate(a)?b:a);
    if(!(rate(peak)>0))return null;
    const index=points.indexOf(peak),threshold=rate(peak)*.5;
    let left=index,right=index;
    while(left>0&&rate(points[left-1])>=threshold)left--;
    while(right<points.length-1&&rate(points[right+1])>=threshold)right++;
    const crossing=(a,b)=>a.price+(b.price-a.price)*(threshold-rate(a))/(rate(b)-rate(a));
    return {price:peak.price,rate:rate(peak),lower:left?crossing(points[left-1],points[left]):lo,
      upper:right<points.length-1?crossing(points[right],points[right+1]):hi,
      clipped:left===0||right===points.length-1};
  };
  return {points,sample,signed,peakGross,amplifying:zone(1),damping:zone(-1),
    modeledLevels:included.length,totalLevels:lenses.length,unsignedLevels:included.length-(signed?.modeledLevels??0),
    partialCoverage:included.some(l=>l.complete===false)};
}

export function buildMarketCurve(lenses,price,move,halfRange=null,selectedKey=null,observationCenter=null,transitionPrices=[],preview=false) {
  if(!finite(price)||price<=0)return null;
  const available=modeledCurves(lenses);
  if(!available.length)return null;
  // Normalize against each complete profile's peak, never the visible range.
  // Absolute totals stay available for strength ranking, not the percent chart.
  const ratio=(l,x)=>Math.max(0,Math.min(1,l.slopeAt(x)/l.profile.peak));
  const center=finite(observationCenter)&&observationCenter>0?observationCenter:price;
  const near=[...available].sort((a,b)=>Math.abs(a.strike-center)-Math.abs(b.strike-center)).slice(0,4);
  const chosen=[...new Map([...available.slice(0,4),...near].map(l=>[l.key,l])).values()].slice(0,8);
  const selected=available.find(l=>l.key===selectedKey);
  if(selected&&!chosen.includes(selected)){
    if(chosen.length>=8)chosen.pop();
    chosen.push(selected);
  }
  const priceNear=center===price?near:[...available].sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price)).slice(0,4);
  const span=finite(halfRange)&&halfRange>0?halfRange:Math.max(move*8,price*.005,...priceNear.map(l=>Math.abs(l.strike-price)*1.15),...transitionPrices.map(value=>Math.abs(value-price)*1.12));
  const lo=Math.max(price*.01,center-span),hi=center+span;
  // Preserve narrow near-expiry peaks even when the price window is wide.
  // During gestures reuse the already modeled profiles to keep redraws light.
  // Once the viewport settles, evaluate the displayed points at exact prices.
  const profilePrices=chosen.flatMap(lens=>[lens.profile.peakPrice,...(lens.profile.points??[])
    .filter((point,index)=>!preview||index%6===0).map(point=>point.price)]);
  const prices=[...new Set([...Array.from({length:181},(_,i)=>lo+(hi-lo)*i/180),...transitionPrices,...profilePrices].filter(x=>finite(x)&&x>=lo&&x<=hi))].sort((a,b)=>a-b);
  const otherCurves=available.filter(lens=>!chosen.includes(lens));
  const sensitivity=preview?sampleStrikeSensitivity:(lens,at)=>lens.slopeAt(at);
  const points=prices.map(x=>{
    const values=chosen.map(lens=>sensitivity(lens,x));
    const total=otherCurves.reduce((sum,lens)=>sum+sensitivity(lens,x),values.reduce((sum,value)=>sum+value,0));
    return {price:x,total,values,ratios:values.map((value,index)=>Math.max(0,Math.min(1,value/chosen[index].profile.peak)))};
  });
  const max=Math.max(...points.map(p=>p.total));
  // A panned window can legitimately contain only zero sensitivity. Keep the
  // chart and its pan controls so users can return to the active region.
  if(!finite(max)||max<0)return null;
  const peak=points.reduce((a,b)=>b.total>a.total?b:a),weak=points.reduce((a,b)=>b.total<a.total?b:a);
  const nearest=points.reduce((a,b)=>Math.abs(b.price-price)<Math.abs(a.price-price)?b:a);
  return {lo,hi,center,halfRange:span,max,points,chosen,peak,weak,current:nearest,currentRatios:chosen.map(l=>ratio(l,price)),totalAtPrice:available.reduce((s,l)=>s+l.slopeAt(price),0),modeledLevels:available.length,totalLevels:lenses.length};
}

export function sampleMarketCurve(curve, price, snapshotPrice) {
  if (price === snapshotPrice) return curve.currentRatios;
  const last = curve.points.length - 1;
  const at=i=>curve.points[i].price??curve.lo+(curve.hi-curve.lo)*i/last;
  const target=Math.max(curve.lo,Math.min(curve.hi,price));
  let a=0,b=last;
  while(b-a>1){const m=Math.floor((a+b)/2);if(at(m)<=target)a=m;else b=m;}
  const lower=curve.points[a].ratios,upper=curve.points[b].ratios;
  const weight=at(b)>at(a)?(target-at(a))/(at(b)-at(a)):0;
  return lower.map((ratio, i) => ratio + (upper[i] - ratio) * weight);
}

// Steepest build/fade on the full strike profile, not on the zoomed chart.
// These are numerical sensitivity transitions, never signed-GEX zero crossings.
export function sensitivityTransitions(profile) {
  const points = profile?.points;
  if (!Array.isArray(points) || points.length < 7) return [];
  if (points.some((p,i)=>!finite(p.price)||!finite(p.ratio)||(i>0&&p.price<=points[i-1].price))) return [];
  // Five-point secant suppresses isolated numerical gamma noise. Omit edges:
  // a boundary maximum would mean that the actual transition is not resolved.
  const slopes = points.slice(2,-2).map((p,j)=>{
    const i=j+2,a=points[i-2],b=points[i+2];
    return {price:p.price,ratio:p.ratio,slope:(b.ratio-a.ratio)/(b.price-a.price),index:i};
  });
  const extent=Math.max(...points.map(p=>p.ratio))-Math.min(...points.map(p=>p.ratio));
  if (extent < .1) return [];
  return ['build','fade'].flatMap(kind=>{
    const best=slopes.reduce((a,b)=>kind==='build'?(b.slope>a.slope?b:a):(b.slope<a.slope?b:a));
    if ((kind==='build'?best.slope<=0:best.slope>=0)||best.index===2||best.index===points.length-3) return [];
    return [{kind,price:best.price,ratio:best.ratio,percentagePointsPerPoint:best.slope*100,
      resolution:(points[best.index+2].price-points[best.index-2].price)/4}];
  });
}
