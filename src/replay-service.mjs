import {DATA_ARCHIVE_PREFIX,validArchiveId} from '../lib/data-archive.mjs';
import {publicIvRow} from '../core/iv-tracking.mjs';
import {projectWatchContext} from './watch-context.mjs';
import {newYorkToIso} from '../core/manual-workflow.mjs';

const MARKETS=['NQ','ES','CL'];
const PAGE_SIZE=25,SEARCH_PAGE_SIZE=50,SEARCH_PAGES=8,MAX_RECORD_BYTES=16*1024*1024;
const stamp=x=>typeof x==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(x)&&Number.isFinite(Date.parse(x));
const millis=x=>stamp(x)?Date.parse(x):null;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const nyDate=x=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(x));
const dateValid=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T12:00:00Z'))&&new Date(x+'T12:00:00Z').toISOString().slice(0,10)===x;
const headers={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const reverseTime=at=>String(9999999999999-at).padStart(13,'0');

function identity(market,underlyingCode){
  if(!MARKETS.includes(market)||!new RegExp('^US\\.'+market+'[0-9]{4}$').test(underlyingCode??'')||Number(underlyingCode.slice(-2))<1||Number(underlyingCode.slice(-2))>12)throw Error('Choose the exact saved NQ, ES or CL futures contract.');
}
function cursorValid(cursor){if(cursor&&(typeof cursor!=='string'||cursor.length>2048))throw Error('Invalid replay cursor.');}
function metadata(object){return {...object.customMetadata,id:object.key.slice(DATA_ARCHIVE_PREFIX.length),bytes:object.size};}
function eligible(entry,{market,underlyingCode,at=null}){
  const t=millis(entry.capturedAt);
  return entry.market===market&&entry.underlyingCode===underlyingCode&&t!==null&&(at===null||t<=at);
}
async function readEnvelope(bucket,entry){
  if(entry.bytes>MAX_RECORD_BYTES)throw Error('This saved snapshot is too large for interactive replay. The complete original remains in Data backups.');
  const object=await bucket.get(DATA_ARCHIVE_PREFIX+entry.id);
  if(!object)throw Error('The selected saved snapshot is unavailable.');
  let text;
  if(object.body?.getReader){
    const reader=object.body.getReader(),decoder=new TextDecoder();let size=0;text='';
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_RECORD_BYTES){await reader.cancel();throw Error('This saved snapshot is too large for interactive replay.');}text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}
    finally{reader.releaseLock();}
  }else{text=await object.text();if(new TextEncoder().encode(text).byteLength>MAX_RECORD_BYTES)throw Error('This saved snapshot is too large for interactive replay.');}
  const envelope=JSON.parse(text);
  if(envelope.id!==entry.id||envelope.kind!==entry.kind||envelope.market!==entry.market||envelope.underlyingCode!==entry.underlyingCode||(entry.capturedAt&&envelope.capturedAt!==entry.capturedAt)||!envelope.data||typeof envelope.data!=='object')throw Error('Saved snapshot identity does not match its archive entry.');
  return envelope;
}

export async function listReplaySnapshots(env,{market,underlyingCode,date,cursor}={}){
  identity(market,underlyingCode);cursorValid(cursor);
  if(!dateValid(date))throw Error('Choose a valid New York calendar date.');
  const start=Date.parse(newYorkToIso(date+'T00:00'));
  const nextDate=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  const end=Date.parse(newYorkToIso(nextDate+'T00:00'))-1;
  const prefix=DATA_ARCHIVE_PREFIX+'menthorq/'+market+'/';
  // Native R2 startAfter seeks directly to the requested date's reverse-time
  // key range. Paging old dates does not scan every newer capture first.
  const page=await env.BUCKET.list({prefix,limit:PAGE_SIZE,include:['customMetadata'],...(cursor?{cursor}:{startAfter:prefix+reverseTime(end)+'-'})});
  const entries=page.objects.map(metadata).filter(entry=>eligible(entry,{market,underlyingCode})&&nyDate(entry.capturedAt)===date).map(entry=>({id:entry.id,kind:'menthorq',market,underlyingCode,capturedAt:entry.capturedAt,timeBasis:'capture-time'}));
  const passedDate=page.objects.some(object=>millis(object.customMetadata?.capturedAt)!==null&&millis(object.customMetadata.capturedAt)<start);
  const hasMore=page.truncated&&!passedDate;
  return {entries,cursor:hasMore?page.cursor:null,hasMore,date,timeZone:'America/New_York',timeBasis:'capture-time',notes:['Timeline uses saved capture times. Provider date, time and delay are retained in each selected snapshot; capture time does not establish fresh source data.','A page can be empty while older saved pages remain. Missing captures are gaps, not zero exposure.']};
}

async function priorRecord(bucket,kind,query){
  let cursor,scanned=0;
  const prefix=DATA_ARCHIVE_PREFIX+kind+'/'+query.market+'/';
  for(let pageNumber=0;pageNumber<SEARCH_PAGES;pageNumber++){
    const page=await bucket.list({prefix,limit:SEARCH_PAGE_SIZE,include:['customMetadata'],...(cursor?{cursor}:{startAfter:prefix+reverseTime(query.at)+'-'})});
    scanned+=page.objects.length;
    // Reverse capture-time archive keys put the newest compatible capture first.
    const candidate=page.objects.map(metadata).find(entry=>eligible(entry,query));
    if(candidate)return {entry:candidate,scanned,limited:false};
    if(!page.truncated)return {entry:null,scanned,limited:false};
    cursor=page.cursor;
  }
  return {entry:null,scanned,limited:true};
}
const knownFuture=(value,at)=>millis(value)!==null&&millis(value)>at;
function safeQuoteRow(row,at){
  const future=(key)=>knownFuture(row[key],at)||knownFuture(row.quality?.[key],at);
  const iv=future('ivTimestamp'),greeks=future('greeksTimestamp'),oi=future('oiTimestamp');
  const quality={...row.quality};
  const issues=[...(quality.issues??[])];
  if(iv){quality.ivTimestamp=null;issues.push('replay-future-iv-excluded');}
  if(greeks){quality.greeksTimestamp=null;issues.push('replay-future-greeks-excluded');}
  if(oi){quality.oiTimestamp=null;issues.push('replay-future-oi-excluded');}
  const observed=observation=>observation&&!knownFuture(observation.quoteTimestamp,at)&&!knownFuture(observation.collectedAt,at);
  return {...row,...(iv?{iv:null,ivTimestamp:null}:{}),...(greeks?{delta:null,gamma:null,greeksTimestamp:null}:{}),...(oi?{openInterest:null,oiTimestamp:null}:{}),
    quality:{...quality,issues},
    ...(Array.isArray(row.ivHistory)?{ivHistory:row.ivHistory.filter(observed)}:{}),
    ...(row.lastObservedRevision&&!observed(row.lastObservedRevision)?{lastObservedRevision:null}:{}),
    ...(knownFuture(row.previousQuoteTimestamp,at)?{previousIv:null,previousQuoteTimestamp:null,ivChange:null,ivChangePoints:null,ivChangePercent:null}:{}),
    ...(knownFuture(row.baselineQuoteTimestamp,at)?{baselineIv:null,baselineQuoteTimestamp:null,baselineChangePoints:null}:{})};
}
function safeQuoteMarket(data,context,at){
  const allowed=new Set((context.levels??[]).filter(level=>level.kind!=='reference').map(level=>level.strike));
  const contracts=(data.contracts??[]).filter(row=>row.underlyingCode===data.underlyingCode&&allowed.has(row.strike)&&!knownFuture(row.quoteTimestamp,at)&&!knownFuture(row.quoteAsOf,at)&&!knownFuture(row.collectedAt,at)&&!knownFuture(row.capturedAt,at)).map(row=>safeQuoteRow(row,at));
  const futurePrice=knownFuture(data.priceTimestamp,at);
  const old=data.previousPriceObservation;
  return {...data,underlyingPrice:futurePrice?null:data.underlyingPrice,priceTimestamp:futurePrice?null:data.priceTimestamp,
    previousPriceObservation:old&&old.underlyingCode===data.underlyingCode&&!knownFuture(old.asOf,at)?old:null,contracts,
    watchContext:context,modelAsOf:new Date(at).toISOString(),watchContextRevision:context.contextUpdatedAt??context.capturedAt??null,
    replay:true,quoteAgeSeconds:millis(data.priceTimestamp)!==null?Math.max(0,Math.round((at-millis(data.priceTimestamp))/1000)):null,
    stale:futurePrice||millis(data.priceTimestamp)===null||at-millis(data.priceTimestamp)>20*60000,
    coverage:{...data.coverage,replayIncluded:contracts.length,replayExcluded:(data.contracts??[]).length-contracts.length},
    limitations:[...(data.limitations??[]),'Replay uses a saved earlier quote snapshot. Missing IV, OI, clocks or series are not backfilled from later captures.']};
}
function replayContext(data,underlyingCode,at){
  const after=snapshot=>snapshot&&(knownFuture(snapshot.capturedAt,at)||knownFuture(snapshot.asOf,at));
  const netDex=data.netDex&&!after(data.netDex)?
    {...data.netDex,history:(data.netDex.history??[]).filter(snapshot=>!after(snapshot))}:null;
  return projectWatchContext({...data,
    exposure:after(data.exposure)?null:data.exposure??null,
    exposure0dte:after(data.exposure0dte)?null:data.exposure0dte??null,
    netDex,
    regime:after(data.regime)?null:data.regime??null,
    heatmap:after(data.heatmap)?null:data.heatmap??null,
    levels:(data.levels??[]).map(level=>knownFuture(level.sourceAsOf,at)?{...level,gex:null,deltaExposure:null,openInterest:null,iv:null}:level),
    notes:[...(data.notes??[]),'Replay retains only saved information available by this capture. Provider timestamps may remain unverified.']},underlyingCode,at);
}
function safeIvState(data,at,allowed){
  const before=observation=>observation&&finite(observation.iv)&&observation.iv>0&&observation.iv<=10&&millis(observation.quoteTimestamp)!==null&&millis(observation.quoteTimestamp)<=at&&millis(observation.collectedAt)!==null&&millis(observation.collectedAt)<=at&&!knownFuture(observation.ivTimestamp,at)&&!knownFuture(observation.quality?.ivTimestamp,at);
  const rows=[];
  for(const code of data.activeCodes??[]){
    const record=data.rows?.[code];if(!record||record.metadata?.underlyingCode!==data.underlyingCode||!allowed.has(record.metadata?.strike))continue;
    // Use only observations actually present in a prior archived IV record.
    // A later-source current value must never displace a valid prior value.
    const observations=[record.current,record.previous,record.baseline].filter(before).map(observation=>safeQuoteRow(observation,at)).sort((a,b)=>Date.parse(b.quoteTimestamp)-Date.parse(a.quoteTimestamp));
    const current=observations[0]??null;if(!current)continue;
    const previous=observations.find(o=>Date.parse(o.quoteTimestamp)<Date.parse(current.quoteTimestamp))??null;
    const baseline=before(record.baseline)?safeQuoteRow(record.baseline,at):null;
    rows.push(publicIvRow({...record,current,previous,baseline,history:(record.history??[]).filter(before),lastObservedRevision:null},at));
  }
  const futurePrice=knownFuture(data.priceTimestamp,at);
  return {schemaVersion:1,market:data.market,underlyingCode:data.underlyingCode,status:'saved-replay',rows,
    underlyingPrice:futurePrice?null:data.underlyingPrice??null,priceTimestamp:futurePrice?null:data.priceTimestamp??null,
    lastAttemptAt:knownFuture(data.lastAttemptAt,at)?null:data.lastAttemptAt??null,lastSuccessAt:knownFuture(data.lastSuccessAt,at)?null:data.lastSuccessAt??null,nextRefreshAt:null,
    serverTime:new Date(at).toISOString(),coverage:{...data.coverage,replayIncluded:rows.length},errors:[],
    source:{provider:'Futu OpenAPI',type:'archived-polled-snapshot',delayStatus:'unverified'}};
}

export async function readReplaySnapshot(env,{id,market,underlyingCode}={}){
  identity(market,underlyingCode);
  if(!validArchiveId(id)||!id.startsWith('menthorq/'+market+'/'))throw Error('Choose a saved MenthorQ replay capture.');
  const selected=await readEnvelope(env.BUCKET,{id,kind:'menthorq',market,underlyingCode});
  const at=millis(selected.capturedAt);
  if(at===null||selected.data.source!=='MenthorQ'||selected.data.underlyingCode!==underlyingCode)throw Error('This capture does not match the selected dated future.');
  const context=replayContext(selected.data,underlyingCode,at);
  const readNotes=[];
  const quoteSearch=await priorRecord(env.BUCKET,'quotes',{market,underlyingCode,at});
  let quote=null,quoteId=null;
  if(quoteSearch.entry){try{const envelope=await readEnvelope(env.BUCKET,quoteSearch.entry);if(envelope.data.underlyingCode===underlyingCode){quote=safeQuoteMarket(envelope.data,context,at);quoteId=envelope.id;}}catch(error){readNotes.push('The earlier Futu quote archive could not be loaded: '+error.message);}}
  const ivSearch=await priorRecord(env.BUCKET,'iv',{market,underlyingCode,at});
  let iv=null,ivId=null;
  if(ivSearch.entry){try{const envelope=await readEnvelope(env.BUCKET,ivSearch.entry);if(envelope.data.underlyingCode===underlyingCode){iv=safeIvState(envelope.data,at,new Set((context.levels??[]).filter(l=>l.kind!=='reference').map(l=>l.strike)));ivId=envelope.id;}}catch(error){readNotes.push('The earlier Futu IV archive could not be loaded: '+error.message);}}
  if(quote&&iv){
    const updates=new Map(iv.rows.map(row=>[row.code,row]));let merged=0;
    quote.contracts=quote.contracts.map(row=>{
      const update=updates.get(row.code);if(!update||millis(update.quoteTimestamp)===null||(millis(row.quoteTimestamp)!==null&&millis(update.quoteTimestamp)<millis(row.quoteTimestamp)))return row;
      merged++;const keys=['iv','delta','gamma','openInterest','bid','ask','quoteTimestamp','collectedAt','previousIv','previousQuoteTimestamp','ivChange','ivChangePoints','ivChangePercent','baselineIv','baselineQuoteTimestamp','baselineChangePoints','ivHistory','comparisonStatus','quoteTimeStatus','quoteAgeSeconds','greeksTimestamp','ivTimestamp'];
      return {...row,...Object.fromEntries(keys.filter(key=>Object.prototype.hasOwnProperty.call(update,key)).map(key=>[key,update[key]])),quality:{...row.quality,quoteTimeStatus:update.quoteTimeStatus,greeksTimestamp:update.greeksTimestamp??null,oiTimestamp:null}};
    });
    if(finite(iv.underlyingPrice)&&iv.underlyingPrice>0&&millis(iv.priceTimestamp)!==null&&(millis(quote.priceTimestamp)===null||millis(iv.priceTimestamp)>=millis(quote.priceTimestamp))){quote.underlyingPrice=iv.underlyingPrice;quote.priceTimestamp=iv.priceTimestamp;quote.quoteAgeSeconds=Math.max(0,Math.round((at-millis(iv.priceTimestamp))/1000));quote.stale=at-millis(iv.priceTimestamp)>20*60000;}
    quote.ivRevision=ivId;quote.coverage={...quote.coverage,replayIvMerged:merged};
  }
  return {context,market:quote,iv,replay:{selectedId:id,capturedAt:selected.capturedAt,timeBasis:'capture-time',quoteId,quoteCapturedAt:quoteSearch.entry?.capturedAt??null,ivId,ivCapturedAt:ivSearch.entry?.capturedAt??null,quoteAvailable:!!quote,ivAvailable:!!iv?.rows?.length,searchLimited:quoteSearch.limited||ivSearch.limited,
    notes:['Selected time is when this context was captured; provider clocks and delay may differ.','Futu quote and IV snapshots are the latest compatible archived captures at or before that time. No later snapshot is borrowed.',...readNotes,...(!quote?['No compatible earlier Futu quote snapshot is available in the bounded search. Level and exposure replay is still available.']:[]),...(quoteSearch.limited||ivSearch.limited?['The bounded archive search reached its limit; older compatible Futu captures may exist in Data backups.']:[])]}};
}

export async function handleReplayRoute(request,env){
  const url=new URL(request.url);if(!['/api/replay','/api/replay/snapshot'].includes(url.pathname))return null;
  if(request.method!=='GET')return json({error:'Replay is read-only.'},405);
  if(!env.BUCKET?.list||!env.BUCKET?.get)return json({error:'Private replay storage is unavailable.'},503);
  try{
    const query=Object.fromEntries(url.searchParams);
    return json(url.pathname==='/api/replay'?await listReplaySnapshots(env,query):await readReplaySnapshot(env,query));
  }catch(error){return json({error:error.message??'The saved replay could not be loaded.',code:'REPLAY_REQUEST_FAILED'},400);}
}
