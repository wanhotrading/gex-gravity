/** Durable, bounded quote collection. Progress and batches are private R2 data.
 * A completed market result is returned only after the planned snapshot batches
 * have been attempted. Missing Greeks in the first four contracts do not prove
 * that the account lacks data access to the remaining selected expiries.
 */
import { normalizeOptionMetadata, normalizeOptionSnapshot, reconcileSnapshots } from '../lib/futu-client.mjs';

const DAY_MS=86400000;
const JOB_KEY='watch/refresh-job';
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)?Number(value):null;
const iso=value=>new Date(value).toISOString();
const prefix=(job,current)=>`watch/progress/${job.id}/${current.market}`;
const metadataKey=(job,current,index)=>`${prefix(job,current)}/metadata-${index}`;
const quoteKey=(job,current,index,revision=current.quoteScopeRevision??0)=>`${prefix(job,current)}/quotes-${revision?revision+'-':''}${index}`;
function selectScope(current,allowedStrikes){
  let scope;
  if(allowedStrikes===undefined)scope=current.snapshotAllowedStrikes??null;
  else{
    if(!Array.isArray(allowedStrikes)||allowedStrikes.length>80||allowedStrikes.some(value=>typeof value!=='number'||!Number.isFinite(value)||value<=0))
      throw Object.assign(Error('Supply at most 80 positive server-selected watched strikes.'),{code:'INVALID_WATCHED_STRIKES'});
    scope=[...new Set(allowedStrikes)].sort((a,b)=>a-b);
  }
  const changed=current.snapshotScopeKey!==undefined&&current.snapshotScopeKey!==JSON.stringify(scope);
  const legacyQuotes=current.snapshotScopeKey===undefined&&scope!==null&&current.stage==='quotes';
  if(changed||legacyQuotes){
    // Retain the old revision/cursor for cleanup; a changed watchlist gets a
    // different quote-key namespace, including a partially persisted batch.
    current.supersededQuoteScopes??=[];
    current.supersededQuoteScopes.push({revision:current.quoteScopeRevision??0,count:(current.quoteCursor??0)+1});
    current.quoteScopeRevision=(current.quoteScopeRevision??0)+1;
    current.quoteCursor=0;current.requested=0;current.returned=0;delete current.supportsRequiredFields;
  }
  current.snapshotAllowedStrikes=scope;current.snapshotScopeKey=JSON.stringify(scope);
  return scope===null?null:new Set(scope);
}
function cleanupQuotes(job,current){
  return [...new Set([...(current.supersededQuoteScopes??[]).flatMap(scope=>Array.from({length:scope.count},(_,index)=>quoteKey(job,current,index,scope.revision))),
    ...Array.from({length:current.quoteCursor??0},(_,index)=>quoteKey(job,current,index))])];
}

function metadataWindows(start,end){
  const windows=[];
  for(let value=Date.parse(start);value<=Date.parse(end);value+=14*DAY_MS)
    windows.push({start:iso(value).slice(0,10),end:iso(Math.min(Date.parse(end),value+13*DAY_MS)).slice(0,10)});
  return windows;
}
function normalizeCache(chain,underlyingCode,start,end,now){
  const seen=new Map(),conflicting=new Set();let rejected=0;
  for(const raw of chain.rows){
    const row=normalizeOptionMetadata(raw,underlyingCode);
    if(!row||row.expiryDate<start||row.expiryDate>end){rejected++;continue;}
    if(seen.has(row.code)){if(JSON.stringify(seen.get(row.code))!==JSON.stringify(row))conflicting.add(row.code);}
    else seen.set(row.code,row);
  }
  const rows=[...seen.values()].filter(row=>!conflicting.has(row.code)).map(row=>({
    code:row.code,stock_owner:row.underlyingCode,stock_type:'DRVT',strike_price:row.strike,
    option_type:row.optionType.toUpperCase(),strike_time:row.expiryDate,expiration_cycle:row.expirationCycle,
  }));
  return {underlyingCode,start,end,retrievedAt:iso(now),rows,windows:chain.windows,expiryCoverage:chain.expiryCoverage??null,
    collectionDiagnostics:{returnedRows:chain.rows.length,validContracts:rows.length,rejectedMetadataCount:rejected,
      conflictingCodes:[...conflicting],windows:chain.windows,expiryCoverage:chain.expiryCoverage??null,
      completeWithinRequestedRange:rejected===0&&conflicting.size===0&&!chain.expiryCoverage?.contractLimitReached&&(!chain.expiryCoverage||chain.expiryCoverage.completeListedExpiries===true)}};
}
function batchPlan(metadata,underlyingCode){
  if(!metadata.length)return [];
  const target=[...metadata].sort((a,b)=>a.strike-b.strike)[Math.floor(metadata.length/2)].strike;
  const probes=[...metadata].sort((a,b)=>a.expiryDate.localeCompare(b.expiryDate)||Math.abs(a.strike-target)-Math.abs(b.strike-target)||a.optionType.localeCompare(b.optionType)).slice(0,4).map(row=>row.code);
  const probeSet=new Set(probes),rest=metadata.filter(row=>!probeSet.has(row.code)).map(row=>row.code);
  const batches=[[underlyingCode,...probes]];
  for(let offset=0;offset<rest.length;offset+=400)batches.push(rest.slice(offset,offset+400));
  return batches;
}
function underlyingSnapshot(raw,code,now){
  const ms=numeric(raw?.update_time),validTime=ms!==null&&ms>=946684800000&&ms<=4102444800000;
  const price=raw?.future_valid===true?numeric(raw.last_price):null;
  return {code,futuresPrice:price,quoteAsOf:validTime?iso(ms):null,
    quoteTimeStatus:!validTime?'unavailable':ms>now+60000?'future':now-ms>20*60000?'stale':'fresh',
    categoryVerified:raw?.future_valid===true,modelPriceSupported:price!==null&&price>0,delayStatus:'unverified'};
}
async function saveProgress(store,job,current){
  current.nextRequestAtMs=Date.now()+650;job.updatedAt=iso(Date.now());
  job.nextRequestAtMs=current.nextRequestAtMs;
  await store.put(job.storageKey==='watch/refresh-job-v3'?job.storageKey:JOB_KEY,job);
}
async function finish(client,store,job,current,cache,metadata,batches,now){
  const byCode=new Map(),missingCodes=[],duplicateCodes=[],unexpectedCodes=[];let underlying=null;
  for(let index=0;index<current.quoteCursor;index++){
    const part=await store.get(quoteKey(job,current,index));
    if(!part)throw Error('A private quote batch is unavailable.');
    for(const row of part.options)byCode.set(row.code,row);
    if(part.underlying)underlying=part.underlying;
    missingCodes.push(...part.missingCodes);duplicateCodes.push(...part.duplicateCodes);unexpectedCodes.push(...part.unexpectedCodes);
  }
  const options=metadata.map(row=>byCode.get(row.code)??normalizeOptionSnapshot(row,null,{now}));
  const requested=current.requested??0,returned=options.filter(row=>row.optionValid).length;
  const usableGexContracts=options.filter(row=>row.usableForGex).length;
  const collectionComplete=current.quoteCursor===batches.length;
  const complete=collectionComplete&&requested===metadata.length&&missingCodes.length===0&&duplicateCodes.length===0&&unexpectedCodes.length===0;
  const chainCoverage=cache.collectionDiagnostics??{returnedRows:cache.rows.length,validContracts:current.metadataContracts??cache.rows.length,rejectedMetadataCount:0,conflictingCodes:[],windows:cache.windows,expiryCoverage:cache.expiryCoverage??null,completeWithinRequestedRange:!cache.expiryCoverage||cache.expiryCoverage.completeListedExpiries===true};
  const full=complete&&usableGexContracts===metadata.length&&chainCoverage.completeWithinRequestedRange&&underlying?.modelPriceSupported&&underlying?.quoteTimeStatus==='fresh';
  const watched=current.snapshotAllowedStrikes!==null;
  const result={provider:'Futu OpenAPI',market:current.market,underlyingCode:current.underlyingCode,
    collectedAt:iso(now),requestedExpiryRange:{start:job.start,end:job.end},underlying,options,
    sourceStatus:'snapshot',refreshIntervalSeconds:300,exactExpiryAvailable:false,chainCoverage,
    status:full?'complete-range-snapshot':current.supportsRequiredFields?'partial-snapshot':'probe-fields-unavailable',
    coverage:{expected:metadata.length,requested,returned,missingCodes:[...new Set([...missingCodes,...metadata.filter(row=>!byCode.has(row.code)).map(row=>row.code)])],
      duplicateCodes:[...new Set(duplicateCodes)],unexpectedCodes:[...new Set(unexpectedCodes)],usableGexContracts,fullChain:!!full&&!watched,fullSelectedScope:!!full,collectionComplete,
      metadataContracts:cache.rows.length,selectedContracts:metadata.length,snapshotScope:watched?'menthorq-watched-strikes':'all-requested-strikes',watchedStrikes:watched?[...current.snapshotAllowedStrikes]:null},
    limitations:['Quote timestamps do not establish Greek or OI calculation times.','OI does not reveal dealer position direction.','Coverage is limited to the explicitly requested expiry range.','Different batches can have different source timestamps; this is a completed collection, not an instantaneous chain.'],errors:[]};
  return {done:true,result,cleanupKeys:cleanupQuotes(job,current)};
}

/** One metadata window or at most maxBatches snapshot calls per HTTP step. */
export async function advanceFutuCollection(client,{store,job,current,now,maxBatches=5,deadlineAtMs=Infinity,allowedStrikes}={}){
  const allowed=selectScope(current,allowedStrikes);
  const cacheKey='watch/metadata/'+current.underlyingCode;
  let cache=await store.get(cacheKey);
  if(cache&&(cache.underlyingCode!==current.underlyingCode||cache.start!==job.start||cache.end!==job.end||!Array.isArray(cache.rows)||now-Date.parse(cache.retrievedAt)>6*3600000))cache=null;
  if(!current.stage)current.stage=cache?'quotes':'metadata';
  if(current.stage==='metadata'){
    const windows=metadataWindows(job.start,job.end),index=current.metadataCursor??0;
    current.metadataTotal=windows.length;
    const key=metadataKey(job,current,index);
    let part=await store.get(key);
    if(!part){const window=windows[index];part={...window,rows:await client.optionChain(current.underlyingCode,window.start,window.end)};await store.put(key,part);}
    current.metadataCursor=index+1;await saveProgress(store,job,current);
    if(current.metadataCursor<windows.length)return {done:false};
    const rows=[],savedWindows=[],keys=[];
    for(let i=0;i<windows.length;i++){const saved=await store.get(metadataKey(job,current,i));rows.push(...saved.rows);savedWindows.push({start:saved.start,end:saved.end,returned:saved.rows.length});keys.push(metadataKey(job,current,i));}
    cache=normalizeCache({rows,windows:savedWindows},current.underlyingCode,job.start,job.end,now);
    await store.put(cacheKey,cache);current.stage='quotes';current.metadataContracts=cache.rows.length;
    current.expected=allowed===null?cache.rows.length:cache.rows.filter(row=>allowed.has(row.strike_price)).length;current.quoteCursor=0;
    await saveProgress(store,job,current);await Promise.allSettled(keys.map(key=>store.remove(key)));
    return {done:false};
  }
  if(!cache){current.stage='metadata';current.metadataCursor=0;current.quoteCursor=0;await saveProgress(store,job,current);return {done:false};}
  const sourceMetadata=cache.rows.map(raw=>normalizeOptionMetadata(raw,current.underlyingCode)).filter(Boolean);
  const metadata=allowed===null?sourceMetadata:sourceMetadata.filter(row=>allowed.has(row.strike)),batches=batchPlan(metadata,current.underlyingCode);
  current.metadataContracts=sourceMetadata.length;
  current.expected=metadata.length;current.quoteBatchTotal=batches.length;current.quoteCursor??=0;current.requested??=0;current.returned??=0;
  if(!metadata.length)return {done:true,result:{provider:'Futu OpenAPI',market:current.market,underlyingCode:current.underlyingCode,underlying:null,options:[],coverage:{expected:0,requested:0,returned:0,collectionComplete:true,fullChain:false,fullSelectedScope:true,metadataContracts:sourceMetadata.length,selectedContracts:0,snapshotScope:allowed===null?'all-requested-strikes':'menthorq-watched-strikes',watchedStrikes:current.snapshotAllowedStrikes},chainCoverage:cache.collectionDiagnostics??{},requestedExpiryRange:{start:job.start,end:job.end},status:allowed===null?'metadata-only':'no-watched-contracts',limitations:[],errors:[]},cleanupKeys:cleanupQuotes(job,current)};
  const byCode=new Map(metadata.map(row=>[row.code,row]));
  for(let step=0;step<maxBatches&&current.quoteCursor<batches.length;step++){
    if(Date.now()>=deadlineAtMs)break;
    const index=current.quoteCursor,codes=batches[index],key=quoteKey(job,current,index);
    let part=await store.get(key);
    if(!part){
      const raw=await client.snapshots(codes),reconciled=reconcileSnapshots(codes,raw);
      const options=codes.filter(code=>code!==current.underlyingCode).map(code=>normalizeOptionSnapshot(byCode.get(code),reconciled.matched.get(code),{now}));
      const supports=options.some(row=>row.iv>0&&row.gamma!==null&&row.openInterest!==null&&row.optionValid&&row.quoteTimeStatus!=='future');
      part={options,underlying:index===0?underlyingSnapshot(reconciled.matched.get(current.underlyingCode),current.underlyingCode,now):null,
        requested:options.length,returned:options.filter(row=>row.optionValid).length,supportsRequiredFields:supports,
        missingCodes:reconciled.missingCodes,duplicateCodes:reconciled.duplicateCodes,unexpectedCodes:reconciled.unexpectedCodes};
      await store.put(key,part);
    }
    current.quoteCursor=index+1;current.requested+=part.requested;current.returned+=part.returned;
    current.supportsRequiredFields=current.supportsRequiredFields===true||part.supportsRequiredFields===true;
    current.retryCount=0;await saveProgress(store,job,current);
  }
  if(current.quoteCursor===batches.length)return finish(client,store,job,current,cache,metadata,batches,now);
  return {done:false};
}
