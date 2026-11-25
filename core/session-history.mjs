import {buildSessionComparison} from './trading-sessions.mjs';
/** Completed, exact-contract NY session observations. No dealer-flow attribution. */
export const SESSION_WINDOWS = [
  {id:'opening',label:'09:30–10:00',startMinute:570,endMinute:600},
  {id:'morning',label:'10:00–10:30',startMinute:600,endMinute:630},
  {id:'late-morning',label:'10:30–11:00',startMinute:630,endMinute:660},
  {id:'midday',label:'11:00–13:00',startMinute:660,endMinute:780},
  {id:'afternoon',label:'13:00–14:30',startMinute:780,endMinute:870},
  {id:'late',label:'14:30–15:50',startMinute:870,endMinute:950},
  {id:'closing',label:'15:50–16:00',startMinute:950,endMinute:960},
].map(row=>({...row,durationMinutes:row.endMinute-row.startMinute}));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const numeric=value=>finite(value)?value:typeof value==='string'&&/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)?Number(value):null;
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'});
export function newYorkBarTime(ms){
  const p=Object.fromEntries(formatter.formatToParts(ms).map(part=>[part.type,part.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute),second:Number(p.second),weekday:p.weekday};
}
export function normalizeHistoryBars(raw,{volumePrecision=0,now=Date.now()}={}){
  if(!Array.isArray(raw)||raw.length>1000||!Number.isInteger(volumePrecision)||volumePrecision<0||volumePrecision>8)throw Error('Invalid historical bar page.');
  return raw.map(row=>{
    const timestamp=numeric(row.time_key),open=numeric(row.open),close=numeric(row.close),high=numeric(row.high),low=numeric(row.low),volume=numeric(row.volume),turnover=numeric(row.turnover);
    if(!Number.isSafeInteger(timestamp)||timestamp<946684800000||timestamp>now+300000||timestamp%300000!==0||![open,close,high,low].every(v=>finite(v)&&v>0)||low>Math.min(open,close)||high<Math.max(open,close)||high<low||!finite(volume)||volume<0)throw Error('Historical bars contain invalid prices, volume or time.');
    return {timestamp,open,close,high,low,volume:volume/10**volumePrecision,turnover:finite(turnover)&&turnover>=0?turnover:null};
  });
}
export function mergeHistoryBars(previous,incoming){
  const byTime=new Map();
  for(const row of [...previous,...incoming]){
    const old=byTime.get(row.timestamp);
    // Pages may overlap, but conflicting completed bars invalidate the sample.
    if(old&&['open','close','high','low','volume'].some(field=>old[field]!==row[field]))throw Error('Conflicting historical bars at the same time.');
    if(old&&finite(old.turnover)&&finite(row.turnover)&&old.turnover!==row.turnover)throw Error('Conflicting historical turnover at the same time.');
    byTime.set(row.timestamp,{...row,turnover:finite(row.turnover)?row.turnover:old?.turnover??null});
  }
  return [...byTime.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-16000);
}
export function inferHistoryBarConvention(bars){
  const days=new Map();
  for(const row of bars){const p=newYorkBarTime(row.timestamp);if(!['Mon','Tue','Wed','Thu'].includes(p.weekday))continue;if(!days.has(p.date))days.set(p.date,new Set());days.get(p.date).add(p.minute);}
  let start=0,end=0;
  for(const times of days.values()){
    // Empirical identification around the daily 17:00–18:00 NY CME pause.
    if(times.has(1015)&&times.has(1080)&&!times.has(1020)&&![...times].some(m=>m>=1020&&m<1080))start++;
    if(times.has(1020)&&times.has(1085)&&!times.has(1080)&&![...times].some(m=>m>1020&&m<=1080))end++;
  }
  return {convention:start>=2&&end===0?'start':end>=2&&start===0?'end':'unverified',startEvidenceDays:start,endEvidenceDays:end,basis:'Observed five-minute timestamps around the CME daily maintenance pause; at least two agreeing sessions required.'};
}
export function inferHistoryVolumeUnit(bars,pointValue){
  // Independent dimensional corroboration: turnover / contracts = price × USD/point.
  const tested=bars.filter(row=>row.volume>0&&row.turnover>0);
  const matching=tested.filter(row=>{const perUnit=row.turnover/row.volume;return perUnit>=row.low*pointValue*.995&&perUnit<=row.high*pointValue*1.005;});
  const verified=pointValue>0&&tested.length>=20&&matching.length/tested.length>=.98&&bars.every(row=>Math.abs(row.volume-Math.round(row.volume))<1e-8);
  return {unit:verified?'contracts':'unverified',testedBars:tested.length,matchingBars:matching.length,basis:verified?'Turnover/volume corroborates the exact CME contract point value in at least 98% of 20+ bars.':'Historical API labels volume generically; contract units have not been corroborated.'};
}
function quantile(values,q){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*q,lo=Math.floor(index),hi=Math.ceil(index);return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);}
export function buildSessionHistory({market,underlyingCode,bars,now=Date.now(),sampleLimit=20,pointValue,barConvention=null,volumeUnit=null}={}){
  if(!['NQ','ES','CL','GC'].includes(market)||!new RegExp(`^US\\.${market}\\d{4}$`).test(underlyingCode??''))throw Error('Historical reference requires the same exact dated futures contract.');
  const timeEvidence=inferHistoryBarConvention(bars),convention=['start','end'].includes(barConvention)?barConvention:timeEvidence.convention;
  const volumeEvidence=inferHistoryVolumeUnit(bars,pointValue),unit=volumeUnit==='contracts'?'contracts':volumeEvidence.unit;
  const today=newYorkBarTime(now).date,days=new Map(),interval=300000;
  if(convention!=='unverified')for(const bar of bars){
    const start=bar.timestamp-(convention==='end'?interval:0),p=newYorkBarTime(start);
    if(p.date>=today||['Sat','Sun'].includes(p.weekday)||p.second!==0)continue;
    if(!days.has(p.date))days.set(p.date,new Map());days.get(p.date).set(p.minute,{...bar,start});
  }
  const windows=SESSION_WINDOWS.map(window=>{
    const observations=[];let rejectedSessions=0;
    for(const [date,byMinute]of [...days].sort(([a],[b])=>b.localeCompare(a))){
      const rows=[];for(let minute=window.startMinute;minute<window.endMinute;minute+=5)rows.push(byMinute.get(minute));
      if(rows.some(row=>!row)){if(rows.some(Boolean))rejectedSessions++;continue;}
      if(rows.some((row,i)=>i&&row.start-rows[i-1].start!==interval)){rejectedSessions++;continue;}
      let previous=rows[0].open,squared=0;for(const row of rows){squared+=(row.close-previous)**2;previous=row.close;}
      observations.push({date,volume:rows.reduce((sum,row)=>sum+row.volume,0),volatility:Math.sqrt(squared),range:Math.max(...rows.map(row=>row.high))-Math.min(...rows.map(row=>row.low)),absMove:Math.abs(rows.at(-1).close-rows[0].open)});
      if(observations.length>=sampleLimit)break;
    }
    const values=field=>observations.map(row=>row[field]);
    return {...window,underlyingCode,sampleCount:observations.length,rejectedSessions,
      medianVolumeContracts:unit==='contracts'?quantile(values('volume'),.5):null,
      medianReportedVolume:quantile(values('volume'),.5),
      medianVolatilityPoints:quantile(values('volatility'),.5),medianRangePoints:quantile(values('range'),.5),medianAbsMovePoints:quantile(values('absMove'),.5),
      p25RangePoints:quantile(values('range'),.25),p75RangePoints:quantile(values('range'),.75),
      firstSessionDate:observations.at(-1)?.date??null,lastSessionDate:observations[0]?.date??null};
  });
  return {schemaVersion:1,market,underlyingCode,asOf:new Date(now).toISOString(),volumeUnit:unit,barConvention:convention,barMinutes:5,requestedSessions:sampleLimit,observedBars:bars.length,
    status:convention==='unverified'?'unverified-bar-time':windows.every(row=>row.sampleCount>=10)&&unit==='contracts'?'ready':windows.some(row=>row.sampleCount)?'partial':'awaiting-history',
    timeEvidence,volumeEvidence,windows,sessions:buildSessionComparison({underlyingCode,bars,barConvention:convention,volumeUnit:unit,now,sampleLimit}),
    methodology:'Completed prior NY calendar sessions only; full contiguous five-minute windows; same exact future. Historical volatility is sqrt(sum of close-to-close point changes squared), starting at the first bar open. This is a reference scale, not a forecast confidence interval or identified dealer impact.',
    source:{provider:'Futu OpenAPI',documentation:'https://open.futunn.com/api/quote/basic-data/history-kline'}};
}
