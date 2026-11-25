import {MENTHORQ_REFRESH_MINUTES} from '../core/trading-sessions.mjs';

export function datedInstrument(market,code){
  if(!['NQ','ES','CL'].includes(market)||!new RegExp(`^US\\.${market}\\d{4}$`).test(code??''))throw Error('MQ_EXACT_FUTURE_REQUIRED');
  const month=Number(code.slice(-2));if(month<1||month>12)throw Error('MQ_EXACT_FUTURE_REQUIRED');
  return market+'FGHJKMNQUVXZ'[month-1]+'20'+code.slice(-4,-2);
}
export function displayedNumber(display){
  const match=String(display??'').replaceAll(',','').replaceAll('−','-').trim().match(/^([+-]?\d+(?:\.\d+)?)\s*([KMB])?$/i);
  if(!match)return null;const value=Number(match[1])*({K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]??1);
  return Number.isFinite(value)?value:null;
}
export function levelClock(text){
  const clocks=new Set(Array.from(String(text).matchAll(/\b(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2})\b/g),match=>match[1]+' '+match[2]));
  if(clocks.size!==1)throw Error('MQ_SOURCE_CLOCK_UNREADABLE');
  const [sourceDate,sourceLocalTime]=[...clocks][0].split(' ');
  const midnight=new Date(sourceDate+'T00:00:00Z');
  const validDate=Number.isFinite(midnight.getTime())&&midnight.toISOString().slice(0,10)===sourceDate;
  if(!validDate||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(sourceLocalTime))throw Error('MQ_SOURCE_CLOCK_UNREADABLE');
  return {sourceDate,sourceLocalTime};
}
export function aggregateDisplay(text){
  const match=String(text).replace(/\s+/g,' ').trim().match(/^All\s+(.+?)\s+Expirations$/i);if(!match||displayedNumber(match[1])===null)throw Error('MQ_AGGREGATE_UNREADABLE');
  return {display:match[1],netGex:displayedNumber(match[1])};
}
export function visibleExposureRow(cells){
  if(!Array.isArray(cells)||cells.length!==4)return null;
  const strike=Number(String(cells[0]).replaceAll(',','').trim()),display=String(cells[2]).trim();
  if(!Number.isFinite(strike)||strike<=0||displayedNumber(display)===null)return null;
  return {strike,display};
}
export function isOlderMap(old,next){
  if(old?.underlyingCode!==next.underlyingCode)return false;
  return !!(old.sourceDate&&next.sourceDate&&next.sourceDate<old.sourceDate||old.mode===next.mode&&old.sourceDate===next.sourceDate&&old.sourceLocalTime&&next.sourceLocalTime&&next.sourceLocalTime<old.sourceLocalTime);
}

export function hasIntradayDexCapture(snapshot,slotStartedAt){
  const capturedAt=Date.parse(snapshot?.capturedAt??'');
  const quarterHour=MENTHORQ_REFRESH_MINUTES*60_000;
  const windowStart=Math.floor(slotStartedAt/quarterHour)*quarterHour;
  return snapshot?.metric==='Net DEX'&&snapshot.scope==='all-expiries'&&snapshot.mode==='Intraday'
    &&!!snapshot.rows?.length&&capturedAt>=windowStart&&capturedAt<=slotStartedAt;
}

export function sameExposureSnapshot(saved,observed){
  if(!saved?.rows?.length||!observed?.rows?.length||saved.rows.length!==observed.rows.length)return false;
  if(['metric','scope','mode','delayStatus','sourceDate','asOf','aggregateDisplay'].some(key=>(saved[key]??null)!==(observed[key]??null)))return false;
  const byStrike=new Map(saved.rows.map(row=>[row.strike,displayedNumber(row.display)]));
  return observed.rows.every(row=>byStrike.get(row.strike)===displayedNumber(row.display));
}
