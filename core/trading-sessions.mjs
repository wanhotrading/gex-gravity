const formatters=new Map();
const parts=(ms,zone)=>{if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}));return Object.fromEntries(formatters.get(zone).formatToParts(ms).map(p=>[p.type,p.value]));};
const dateOf=p=>`${p.year}-${p.month}-${p.day}`;
const offsetDate=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const MENTHORQ_INTRADAY_START=9*60+30;
export const MENTHORQ_EOD_START=23*60+30;
export const MENTHORQ_OVERNIGHT_START=22*60+30;
export const MENTHORQ_REFRESH_MINUTES=15;
export const MENTHORQ_CHECK_MAX_AGE_MINUTES=MENTHORQ_REFRESH_MINUTES+5;
export function localSessionTime(date,minute,zone){
  const target=Date.parse(date+'T00:00:00Z')+minute*60000;let result=target;
  for(let i=0;i<4;i++){const p=parts(result,zone),shown=Date.parse(dateOf(p)+'T00:00:00Z')+(+p.hour*60+ +p.minute)*60000;result+=target-shown;}
  const p=parts(result,zone);if(dateOf(p)!==date||+p.hour*60+ +p.minute!==minute)throw Error('Unresolved local session boundary.');
  return result;
}
export function futuresCollectionWindow(now=Date.now()){
  const p=parts(now,'America/New_York'),minute=+p.hour*60+ +p.minute,date=dateOf(p);
  const weekend=p.weekday==='Sat'||(p.weekday==='Sun'&&minute<1080);
  const open=!weekend&&(minute<1020||(p.weekday!=='Fri'&&minute>=1080));
  const tradingDate=minute>=1080?offsetDate(date,1):date;
  const session=open?comparisonWindows(tradingDate).find(w=>now>=w.start&&now<w.end):null;
  const menthorqIntraday=!weekend&&minute>=MENTHORQ_INTRADAY_START&&minute<=16*60;
  const menthorqOvernight=open&&(minute>=MENTHORQ_OVERNIGHT_START||minute<MENTHORQ_INTRADAY_START);
  const menthorqEod=p.weekday!=='Sat'&&p.weekday!=='Sun'&&minute>=MENTHORQ_EOD_START;
  return {open,weekend,minute,date,tradingDate,weekday:p.weekday,session:session?.label??null,reason:open?'scheduled-market-week':weekend||p.weekday==='Fri'?'weekend':'daily-maintenance',
    menthorqIntraday,menthorqDexSlot:menthorqIntraday&&(minute-MENTHORQ_INTRADAY_START)%MENTHORQ_REFRESH_MINUTES<5,
    menthorqOvernight,
    menthorqEod,menthorqEodSlot:menthorqEod&&minute<MENTHORQ_EOD_START+5,
    holidayCalendarVerified:false};
}
export function comparisonWindows(date){
  const ny=(d,m)=>localSessionTime(d,m,'America/New_York'),london=localSessionTime(date,480,'Europe/London');
  return [
    {id:'asia',label:'Asia / early Globex',start:ny(offsetDate(date,-1),1080),end:london,boundary:'18:00 New York (prior day) → 08:00 London'},
    {id:'europe',label:'Europe',start:london,end:ny(date,510),boundary:'08:00 London → 08:30 New York'},
    {id:'preopen',label:'US pre-open',start:ny(date,510),end:ny(date,570),boundary:'08:30 → 09:30 New York · may include US data releases'},
    {id:'regular',label:'New York regular',start:ny(date,570),end:ny(date,960),boundary:'09:30 → 16:00 New York'},
    {id:'late-us',label:'Late US',start:ny(date,960),end:ny(date,1020),boundary:'16:00 → 17:00 New York'},
  ].map(w=>({...w,durationMinutes:(w.end-w.start)/60000}));
}
const median=values=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
export function buildSessionComparison({underlyingCode,bars=[],barConvention,volumeUnit,now=Date.now(),sampleLimit=20}={}){
  if(!/^US\.(NQ|ES|CL|GC)\d{4}$/.test(underlyingCode??'')||Number(underlyingCode.slice(-2))<1||Number(underlyingCode.slice(-2))>12)throw Error('Session comparison requires an exact dated future.');
  const valid=['start','end'].includes(barConvention),byTime=new Map(),dates=new Set();
  if(valid)for(const bar of bars){const start=bar.timestamp-(barConvention==='end'?300000:0);if(start+300000>now)continue;byTime.set(start,bar);const p=parts(start,'America/New_York');dates.add(+p.hour>=18?offsetDate(dateOf(p),1):dateOf(p));}
  const definitions=comparisonWindows(futuresCollectionWindow(now).tradingDate),observations=new Map(definitions.map(w=>[w.id,[]]));
  for(const date of [...dates].sort().reverse()){
    if(['Sat','Sun'].includes(parts(Date.parse(date+'T12:00:00Z'),'America/New_York').weekday))continue;
    for(const w of comparisonWindows(date)){
      const samples=observations.get(w.id);if(samples.length>=sampleLimit||w.end>now)continue;
      const rows=[];for(let t=w.start;t<w.end;t+=300000)rows.push(byTime.get(t));
      if(!rows.length||rows.some(r=>!r))continue;
      let previous=rows[0].open,squared=0;for(const row of rows){squared+=(row.close-previous)**2;previous=row.close;}
      samples.push({date,bars:rows.length,volumePer5m:rows.reduce((s,r)=>s+r.volume,0)/rows.length,
        volatilityPer5m:Math.sqrt(squared/rows.length),range:Math.max(...rows.map(r=>r.high))-Math.min(...rows.map(r=>r.low))});
    }
  }
  const windows=definitions.map(w=>{const samples=observations.get(w.id);return {id:w.id,label:w.label,boundary:w.boundary,durationMinutes:w.durationMinutes,sampleCount:samples.length,
    medianFiveMinuteVolume:volumeUnit==='contracts'?median(samples.map(s=>s.volumePer5m)):null,
    medianFiveMinuteVolatility:median(samples.map(s=>s.volatilityPer5m)),medianRange:median(samples.map(s=>s.range)),
    firstDate:samples.at(-1)?.date??null,lastDate:samples[0]?.date??null};});
  const regular=windows.find(w=>w.id==='regular');
  for(const w of windows)w.sameQuantityParticipationVsNY=w.sampleCount>=10&&regular.sampleCount>=10&&w.medianFiveMinuteVolume>0&&regular.medianFiveMinuteVolume>0?regular.medianFiveMinuteVolume/w.medianFiveMinuteVolume:null;
  return {underlyingCode,calculatedAt:new Date(now).toISOString(),barConvention,volumeUnit,windows,status:valid?'available-subsets':'bar-timing-unverified',
    methodology:'Complete non-overlapping windows only; Asia is early Globex until London cash open. Five-minute volume is the median across session-average bar volumes. Ratios compare equal quantities against traded volume, not book depth or price impact. Economic releases are not filtered; pre-open is labeled separately. Holiday/short sessions with missing bars are excluded.'};
}
