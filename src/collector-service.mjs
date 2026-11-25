import {createPrivateStore} from '../lib/secure-store.mjs';
const KEY='watch/collector-status';
const statuses=new Set(['idle','collecting','updated','partial','skipped','blocked','auth-required','error']);
const time=(value,now)=>typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now+60000?new Date(value).toISOString():null;
function publicationDate(value){
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return null;
  const midnight=new Date(value+'T00:00:00Z');
  return Number.isFinite(midnight.getTime())&&midnight.toISOString().slice(0,10)===value?value:null;
}
export async function readCollectorStatus(env,now=Date.now()){
  const saved=await createPrivateStore(env).get(KEY);
  if(!saved)return {enabled:false,status:'not-configured',cadenceMinutes:5};
  return {...saved,status:saved.enabled?(now-Date.parse(saved.lastSeenAt)>10*60000?'offline':'running'):'setup'};
}
export async function saveCollectorStatus(env,raw,now=Date.now()){
  if(raw?.mode!=='windows-software'||typeof raw.enabled!=='boolean'||!statuses.has(raw.futu)||!statuses.has(raw.menthorq))throw Error('Invalid local collector status.');
  const code=typeof raw.menthorqCode==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.menthorqCode)?raw.menthorqCode:null;
  const stage=typeof raw.menthorqStage==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.menthorqStage)?raw.menthorqStage:null;
  const retry=Date.parse(raw.menthorqRetryAt??'');
  const markets=Array.isArray(raw.menthorqMarkets)?raw.menthorqMarkets.filter(row=>['NQ','ES','CL'].includes(row?.market)).slice(0,3).map(row=>({
    market:row.market,
    underlyingCode:new RegExp('^US\\.'+row.market+'\\d{2}(?:0[1-9]|1[0-2])$').test(row.underlyingCode??'')?row.underlyingCode:null,
    levels:Number.isInteger(row.levels)&&row.levels>=0&&row.levels<=80?row.levels:0,
    exposureRows:Number.isInteger(row.exposureRows)&&row.exposureRows>=0&&row.exposureRows<=80?row.exposureRows:0,
    delayStatus:row.delayStatus==='delayed'?'delayed':'unverified',
    observedLevelsDate:publicationDate(row.observedLevelsDate),
    observedLevelsLocalTime:/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.observedLevelsLocalTime??'')?row.observedLevelsLocalTime:null,
    observedLevelsAt:time(row.observedLevelsAt,now),
  })):[];
  const value={mode:'windows-software',enabled:raw.enabled,cadenceMinutes:5,lastSeenAt:new Date(now).toISOString(),futu:raw.futu,menthorq:raw.menthorq,menthorqCode:code,
    menthorqScope:['exposure-map','levels-and-exposure'].includes(raw.menthorqScope)?raw.menthorqScope:null,
    menthorqStage:stage,menthorqRetryAt:Number.isFinite(retry)&&retry>now&&retry<=now+3600000?new Date(retry).toISOString():null,
    futuLastCompletedAt:time(raw.futuLastCompletedAt,now),menthorqLastCompletedAt:time(raw.menthorqLastCompletedAt,now),menthorqMarkets:markets};
  await createPrivateStore(env).put(KEY,value);return {saved:true,collector:await readCollectorStatus(env,now)};
}
