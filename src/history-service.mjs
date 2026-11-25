import {createPrivateStore} from '../lib/secure-store.mjs';
import {getFutuAccess} from '../lib/futu-auth.mjs';
import {createFutuQuoteClient,FutuQuoteError,safeFutuError,QUOTE_INTERVAL_MS} from '../lib/futu-client.mjs';
import {normalizeHistoryBars,mergeHistoryBars,buildSessionHistory,newYorkBarTime} from '../core/session-history.mjs';
import {buildSessionComparison} from '../core/trading-sessions.mjs';

const STATE_KEY='watch/state',LEASE_KEY='watch/refresh-lease';
const stateKey=env=>env.GAMMA_COMPACT_STATE==='true'?'watch/state-v3':STATE_KEY;
const TARGET_SESSIONS=20,MAX_PAGES=40,LOOKBACK_DAYS=60,FORCE_COOLDOWN_MS=60000;
const POINT_VALUES={NQ:20,ES:50,CL:1000};
const iso=value=>new Date(value).toISOString();
const waitQuietly=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rootKey=(market,code)=>`watch/history/${market}/${code}`;
const dayOffset=(date,days)=>new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
const fail=(code,message)=>{throw new FutuQuoteError(code,message);};
function validateIdentity(market,code){
  if(!Object.hasOwn(POINT_VALUES,market)||!new RegExp(`^US\\.${market}[0-9]{4}$`).test(code??''))
    fail('HISTORY_EXACT_FUTURE_REQUIRED','Select the exact saved NQ, ES or CL futures contract.');
}
function validateCanonical(state,market,code){
  validateIdentity(market,code);
  if(state?.markets?.[market]?.underlyingCode!==code)
    fail('HISTORY_UNDERLYING_CHANGED','Refresh the selected futures month before loading its historical reference.');
}
const emptyState=(market,underlyingCode)=>({schemaVersion:1,market,underlyingCode,status:'awaiting-history',profile:null,lastAttemptAt:null,lastSuccessAt:null,errors:[]});
function progress(job,status,now){
  const failedRetry=status==='history-refresh-failed'?Math.max(0,FORCE_COOLDOWN_MS-(now-Date.parse(job?.lastAttemptAt??''))):0;
  return {done:job?.done===true,retryAfterMs:Number.isFinite(failedRetry)&&failedRetry>0?failedRetry:job?.done?0:750,
    pages:job?.pages??0,observedBars:job?.observedBars??0,targetSessions:TARGET_SESSIONS,maxPages:MAX_PAGES,
    reason:job?.reason??null,startDate:job?.startDate??null,endDate:job?.endDate??null,cursorBasis:job?.cursorBasis??null,
    returnedDateRange:job?.returnedDateRange??null,queryDateEndMeaning:'following-calendar-boundary',
    barDiagnostics:job?.barDiagnostics??null,
    unitProbeDiagnostics:job?.unitProbeDiagnostics??null,
    unitEvidence:job?.unitEvidence?Object.fromEntries(['unit','reason','bracketed','beforeAfterAvailable','matchingTradingDate','expectedBarCount','observedBarCount','barVolumeVsBracket']
      .filter(field=>Object.hasOwn(job.unitEvidence,field)).map(field=>[field,job.unitEvidence[field]])):null};
}
function publicState(saved,job,now,status=null,retryAfterMs=null){
  let profile=saved.profile??null,projectedJob=job;
  const sameIdentity=profile&&job&&profile.market===job.market&&profile.underlyingCode===job.underlyingCode
    &&(saved.market??job.market)===job.market&&(saved.underlyingCode??job.underlyingCode)===job.underlyingCode;
  if(sameIdentity&&job.volumeProbe){
    const evidence=bracketVolumeEvidence(job.volumeProbe,profile.barConvention);
    projectedJob={...job,unitEvidence:evidence};
    if(profile.volumeUnit!=='contracts'&&evidence.unit==='contracts'&&Array.isArray(profile.windows)&&profile.windows.length>0
      &&profile.windows.every(row=>row.underlyingCode===profile.underlyingCode&&typeof row.medianReportedVolume==='number'&&Number.isFinite(row.medianReportedVolume)&&row.medianReportedVolume>=0)){
      profile={...profile,volumeUnit:'contracts',volumeEvidence:evidence,
        status:profile.windows.every(row=>row.sampleCount>=10)?'ready':profile.status,
        windows:profile.windows.map(row=>({...row,medianVolumeContracts:row.medianReportedVolume}))};
    }
  }
  const projectedStatus=saved.status==='history-partial'&&job?.done&&profile?.status==='ready'
    &&profile.windows.every(row=>row.sampleCount>=TARGET_SESSIONS)?'history-ready':saved.status;
  const result={market:saved.market??job?.market??saved.profile?.market,underlyingCode:saved.underlyingCode??job?.underlyingCode??saved.profile?.underlyingCode,
    status:status??projectedStatus,profile,progress:progress(projectedJob,status??projectedStatus,now),errors:saved.errors??[],
    lastAttemptAt:saved.lastAttemptAt??null,lastSuccessAt:saved.lastSuccessAt??null,serverTime:iso(now)};
  if(retryAfterMs!==null)result.progress.retryAfterMs=retryAfterMs;
  if(status==='waiting-for-chain-refresh'||status==='cooldown')result.progress.done=false;
  return result;
}
function newJob(market,underlyingCode,today,now){
  return {schemaVersion:1,market,underlyingCode,createdDate:today,startedAt:iso(now),lastAttemptAt:null,
    startDate:dayOffset(today,-LOOKBACK_DAYS),endDate:dayOffset(today,-1),nextTime:null,phase:'unit-probe',historyPages:0,
    pages:0,observedBars:0,done:false,reason:null};
}
function elapsed(now,value){const parsed=Date.parse(value??'');return Number.isFinite(parsed)?Math.max(0,now-parsed):Infinity;}
function profileSamples(profile){return Math.min(...(profile?.windows??[]).map(row=>row.sampleCount??0),TARGET_SESSIONS);}
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)?Number(value):null;
function tradingDate(value){
  const text=String(value??'').replaceAll('-','');
  if(!/^\d{8}$/.test(text))return null;
  const date=`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6)}`;
  return Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date?date:null;
}
function snapshotVolume(rows,code,now){
  const matches=Array.isArray(rows)?rows.filter(row=>row?.code===code):[];
  if(matches.length!==1||matches[0].future_valid!==true)return null;
  const row=matches[0],volume=numeric(row.volume),timestamp=numeric(row.update_time),date=tradingDate(row.data_date);
  if(Number.isSafeInteger(timestamp)&&date){const quoteDate=newYorkBarTime(timestamp).date;if(date<dayOffset(quoteDate,-1)||date>dayOffset(quoteDate,1))return null;}
  return Number.isSafeInteger(volume)&&volume>=0&&Number.isSafeInteger(timestamp)&&timestamp>=946684800000&&timestamp<=now+60000&&date
    ?{volume,timestamp,tradingDate:date}:null;
}
function nyWallTime(date,minute){
  const guess=Date.parse(date)+minute*60000;
  for(let offset=-14*60;offset<=14*60;offset+=15){const value=guess+offset*60000,p=newYorkBarTime(value);if(p.date===date&&p.minute===minute&&p.second===0)return value;}
  return null;
}
function bracketVolumeEvidence(probe,convention){
  const before=probe?.before,after=probe?.after,rows=probe?.bars??[];
  const unverified={unit:'unverified',bracketed:false,beforeAfterAvailable:!!before&&!!after,matchingTradingDate:!!before&&!!after&&before.tradingDate===after.tradingDate,
    expectedBarCount:null,observedBarCount:rows.length,
    basis:'A complete matching trading-day bar sum has not been bracketed by exact-futures snapshot contract volumes.'};
  if(!before||!after)return {...unverified,reason:'snapshot-unavailable'};
  if(before.tradingDate!==after.tradingDate||before.timestamp>after.timestamp||before.volume>after.volume)return {...unverified,reason:'snapshot-bracket-mismatch'};
  if(!['start','end'].includes(convention))return {...unverified,reason:'clock-unverified'};
  const interval=300000,sessionOpen=nyWallTime(dayOffset(after.tradingDate,-1),1080);
  if(sessionOpen===null)return {...unverified,reason:'clock-unverified'};
  const start=sessionOpen+(convention==='end'?interval:0);
  const last=(convention==='end'?Math.ceil(after.timestamp/interval):Math.floor(after.timestamp/interval))*interval;
  if(!Number.isSafeInteger(start)||last<start)return {...unverified,reason:'clock-unverified'};
  const sorted=rows.filter(row=>row.timestamp>=start&&row.timestamp<=last).sort((a,b)=>a.timestamp-b.timestamp);
  unverified.observedBarCount=sorted.length;
  if(probe?.invalidCurrentBars&&(!Array.isArray(probe.invalidCurrentTimes)||probe.invalidCurrentTimes.some(time=>time>=start&&time<=last)))
    return {...unverified,reason:'invalid-current-probe-bars'};
  const expected=(last-start)/interval+1;
  unverified.expectedBarCount=Number.isInteger(expected)&&expected>=0&&expected<=1000?expected:null;
  if(!Number.isInteger(expected)||expected<1||sorted.length!==expected||sorted[0]?.timestamp!==start||sorted.at(-1)?.timestamp!==last
    ||sorted.some((row,i)=>!Number.isSafeInteger(row.volume)||row.volume<0||i&&row.timestamp-sorted[i-1].timestamp!==interval))return {...unverified,reason:'missing-or-incomplete-bars'};
  const volume=sorted.reduce((sum,row)=>sum+row.volume,0);
  if(volume<=0||volume<before.volume||volume>after.volume)return {...unverified,reason:'volume-outside-bracket',barVolumeVsBracket:volume<before.volume?'below':volume>after.volume?'above':'zero'};
  return {unit:'contracts',bracketed:true,basis:'Complete contiguous current-trading-day five-minute volume falls between two same-contract snapshot volumes, documented in contracts.',
    tradingDate:after.tradingDate,barConvention:convention,barCount:sorted.length,barVolumeSum:volume,
    beforeVolume:before.volume,afterVolume:after.volume,beforeQuoteAt:iso(before.timestamp),afterQuoteAt:iso(after.timestamp),
    source:'https://open.futunn.com/api/quote/realtime/market-snapshot'};
}
function diagnoseBars(raw,{now,requestStart,requestEnd,today}){
  const times=[],dates=[],offending=[];let future=0,invalidTime=0,badPrice=0,badVolume=0,offGrid=0,outside=0,prior=0,current=0;
  for(const row of raw){
    const time=numeric(row.time_key),open=numeric(row.open),close=numeric(row.close),high=numeric(row.high),low=numeric(row.low),volume=numeric(row.volume);
    const validTime=Number.isSafeInteger(time)&&time>=946684800000&&time<=4102444800000;
    const badP=![open,close,high,low].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0)||low>Math.min(open,close)||high<Math.max(open,close)||high<low;
    const badV=typeof volume!=='number'||!Number.isFinite(volume)||volume<0;
    const date=tradingDate(row.date),badDate=!!date&&(date<dayOffset(requestStart,-1)||date>dayOffset(requestEnd,1));
    if(!validTime)invalidTime++;
    if(validTime){times.push(time);const p=newYorkBarTime(time);dates.push(p.date);if(p.date<today)prior++;else current++;if(time>now+300000)future++;if(time%300000!==0)offGrid++;}
    if(badP)badPrice++;if(badV)badVolume++;if(badDate)outside++;
    if((!validTime||badP||badV||badDate||validTime&&(time>now+300000||time%300000!==0))&&offending.length<2)offending.push(row);
  }
  dates.sort();
  return {reason:'validated',rawBarCount:raw.length,futureTimestampCount:future,invalidTimestampCount:invalidTime,badPriceCount:badPrice,badVolumeCount:badVolume,offGridCount:offGrid,rawDateOutsideCount:outside,
    priorBarCount:prior,currentBarCount:current,...(times.length?{oldestMs:Math.min(...times),newestMs:Math.max(...times),minNYDate:dates[0],maxNYDate:dates.at(-1)}:{}),
    samples:{first:raw.slice(0,2),last:raw.slice(-2),offending}};
}
function sanitizedDiagnostics(diagnostics){
  const error=new FutuQuoteError('HISTORY_INVALID_DATA','Historical bar diagnostic.');error.stage='history-kline';error.path='/api/v1.0/quote/{symbol}/history-kline';error.responseShape={barDiagnostics:diagnostics};
  return safeFutuError(error).responseShape?.barDiagnostics??null;
}

/** Public historical reference only; raw licensed bars stay in private R2. */
export async function readSessionHistory(env,{market,underlyingCode,now=Date.now()}={}){
  validateIdentity(market,underlyingCode);
  const store=createPrivateStore(env),base=rootKey(market,underlyingCode);
  validateCanonical(await store.get(stateKey(env)),market,underlyingCode);
  const [saved,job,retained]=await Promise.all([store.get(`${base}/state`),store.get(`${base}/job`),store.get(`${base}/bars`)]);
  const result=job?.createdDate!==newYorkBarTime(now).date&&saved?.profile
    ?publicState(saved,{...job,done:false,reason:'new-session-day'},now,'history-refresh-due')
    :publicState(saved??emptyState(market,underlyingCode),job,now);
  if(result.profile&&Array.isArray(retained?.bars))result.profile={...result.profile,sessions:buildSessionComparison({underlyingCode,bars:retained.bars,barConvention:result.profile.barConvention,volumeUnit:result.profile.volumeUnit,now:Math.min(now,Date.parse(result.profile.asOf)||now)})};
  return result;
}

/** At most two unadjusted five-minute pages per call, using the collector's lease.
 * A completed prior profile survives failures and the next day's collection.
 */
export async function refreshSessionHistory(env,{market,underlyingCode,fetcher=fetch,now=Date.now(),force=false,dependencies={}}={}){
  validateIdentity(market,underlyingCode);
  const store=createPrivateStore(env),base=rootKey(market,underlyingCode),today=newYorkBarTime(now).date;
  validateCanonical(await store.get(stateKey(env)),market,underlyingCode);
  let saved=await store.get(`${base}/state`)??emptyState(market,underlyingCode),job=await store.get(`${base}/job`);
  if(job?.done&&job.createdDate===today&&!force)return publicState(saved,job,now);
  if((force||saved.status==='history-refresh-failed')&&elapsed(now,saved.lastAttemptAt)<FORCE_COOLDOWN_MS)
    return publicState(saved,job,now,'cooldown',FORCE_COOLDOWN_MS-elapsed(now,saved.lastAttemptAt));
  const lease=await store.acquireLease(LEASE_KEY,now,45000);
  if(!lease)return publicState(saved,job,now,'waiting-for-chain-refresh',5000);
  const wait=dependencies.wait??waitQuietly,wallNow=dependencies.wallNow??Date.now;
  let providerAttempted=false;
  try{
    validateCanonical(await store.get(stateKey(env)),market,underlyingCode);
    saved=await store.get(`${base}/state`)??emptyState(market,underlyingCode);job=await store.get(`${base}/job`);
    if(job?.done&&job.createdDate===today&&!force)return publicState(saved,job,now);
    if((force||saved.status==='history-refresh-failed')&&elapsed(now,saved.lastAttemptAt)<FORCE_COOLDOWN_MS)
      return publicState(saved,job,now,'cooldown',FORCE_COOLDOWN_MS-elapsed(now,saved.lastAttemptAt));
    if(!job||job.createdDate!==today||force)job={...newJob(market,underlyingCode,today,now),forced:force};
    let bars=force||job.forced&&job.pages===0?[]:(await store.get(`${base}/bars`))?.bars??[];
    bars=bars.filter(row=>{const date=newYorkBarTime(row.timestamp).date;return date>=job.startDate&&date<today;});
    saved={...saved,status:'loading-history',lastAttemptAt:iso(now),errors:[]};
    job={...job,lastAttemptAt:iso(now)};
    await store.put(`${base}/state`,saved);await store.put(`${base}/job`,job);
    const deadline=wallNow()+18000;
    try{
      const client=(dependencies.createQuoteClient??createFutuQuoteClient)({getAccessToken:()=>getFutuAccess(env,fetcher),fetchImpl:fetcher,deadlineAtMs:deadline});
      await wait(QUOTE_INTERVAL_MS);
      for(let pageIndex=0;pageIndex<2&&!job.done;pageIndex++){
        if(pageIndex&&wallNow()>=deadline-5000)break;
        providerAttempted=true;
        const probe=job.phase==='unit-probe',requestEnd=probe?today:job.endDate;
        const requestStart=probe?dayOffset(today,-1):[job.startDate,dayOffset(requestEnd,-1)].sort().at(-1);
        let before=null,after=null;
        if(probe&&typeof client.snapshots==='function')try{before=snapshotVolume(await client.snapshots([underlyingCode]),underlyingCode,now);}catch{}
        const response=await client.historyKlinePage(underlyingCode,{start:requestStart,end:dayOffset(requestEnd,1),num:370,ktype:6});
        if(probe&&typeof client.snapshots==='function')try{after=snapshotVolume(await client.snapshots([underlyingCode]),underlyingCode,now);}catch{}
        if(response.code!==underlyingCode||response.ktype!==6||typeof response.hasMore!=='boolean')
          fail('HISTORY_INVALID_DATA','Historical response did not match the selected futures contract.');
        let incoming,combined,probeRows=[],invalidCurrentBars=false,invalidCurrentTimes=[],failureReason='normalization';
        const diagnostics=diagnoseBars(response.bars,{now,requestStart,requestEnd,today});
        try{
          if(response.bars.length>=1000){failureReason='page-cap';throw Error('History bounded response reached its cap.');}
          const priorRaw=[],currentRaw=[];
          for(const row of response.bars){
            const time=numeric(row.time_key),knownMs=Number.isSafeInteger(time)&&time>=946684800000&&time<=4102444800000;
            if(knownMs&&time>now+300000)continue;
            if(knownMs&&newYorkBarTime(time).date>=today)currentRaw.push(row);else priorRaw.push(row);
          }
          incoming=normalizeHistoryBars(priorRaw,{volumePrecision:response.volumePrecision,now});
          probeRows=incoming.map((row,i)=>({...row,tradingDate:tradingDate(priorRaw[i].date)}));
          for(const raw of currentRaw)try{const [row]=normalizeHistoryBars([raw],{volumePrecision:response.volumePrecision,now});probeRows.push({...row,tradingDate:tradingDate(raw.date)});}
          catch{invalidCurrentBars=true;invalidCurrentTimes.push(numeric(raw.time_key));diagnostics.reason='current-probe-invalid';}
          failureReason='calendar-bounds';
          if(incoming.some(row=>{const date=newYorkBarTime(row.timestamp).date;return date<dayOffset(requestStart,-1)||date>dayOffset(requestEnd,1);})
            ||priorRaw.some(row=>{const date=tradingDate(row.date);return date&&(date<dayOffset(requestStart,-1)||date>dayOffset(requestEnd,1));}))
            throw Error('Calendar request boundaries were not honored.');
          const inScope=incoming.filter(row=>newYorkBarTime(row.timestamp).date<=requestEnd);
          failureReason='backward-progress';
          if(!probe&&job.historyPages>0&&inScope.length&&bars.length
            &&Math.min(...inScope.map(row=>row.timestamp))>=Math.min(...bars.map(row=>row.timestamp)))
            throw Error('Backward request returned no older data.');
          failureReason='merge-conflict';
          combined=mergeHistoryBars(bars,incoming).filter(row=>{const date=newYorkBarTime(row.timestamp).date;return date>=job.startDate&&date<today;});
        }catch{
          const messages={normalization:'Prior-session historical bars contain invalid prices, volume or timestamps.',
            'calendar-bounds':'Historical bars did not match the requested calendar dates.','backward-progress':'Historical date sweep returned no older in-scope bars.',
            'merge-conflict':'Historical pages contain conflicting completed bars.','page-cap':'Historical two-date response reached its safety cap.'};
          const error=new FutuQuoteError('HISTORY_INVALID_DATA',messages[failureReason]);
          job.barDiagnostics=sanitizedDiagnostics({...diagnostics,reason:failureReason});
          error.stage='history-kline';error.path='/api/v1.0/quote/{symbol}/history-kline';error.responseShape={...response.responseShape,barDiagnostics:job.barDiagnostics};
          throw error;
        }
        validateCanonical(await store.get(stateKey(env)),market,underlyingCode);
        bars=combined;
        if(probe){job.volumeProbe={before,after,invalidCurrentBars,invalidCurrentTimes,bars:probeRows.map(row=>({timestamp:row.timestamp,volume:row.volume,tradingDate:row.tradingDate}))};job.unitProbeDiagnostics=sanitizedDiagnostics(diagnostics);}
        let candidate=buildSessionHistory({market,underlyingCode,bars,now,sampleLimit:TARGET_SESSIONS,pointValue:POINT_VALUES[market]});
        const unitEvidence=job.unitEvidence?.unit==='contracts'?job.unitEvidence:bracketVolumeEvidence(job.volumeProbe,candidate.barConvention);
        job={...job,pages:job.pages+1,observedBars:bars.length,nextTime:null,cursorBasis:'bounded-calendar-end',unitEvidence,
          barDiagnostics:sanitizedDiagnostics(diagnostics),returnedDateRange:{minNYDate:diagnostics.minNYDate??null,maxNYDate:diagnostics.maxNYDate??null},
          phase:'history',historyPages:(job.historyPages??0)+(probe?0:1),endDate:probe?dayOffset(today,-1):dayOffset(requestStart,-1)};
        if(unitEvidence.unit==='contracts'){
          candidate=buildSessionHistory({market,underlyingCode,bars,now,sampleLimit:TARGET_SESSIONS,pointValue:POINT_VALUES[market],volumeUnit:'contracts'});
          candidate.volumeEvidence=unitEvidence;
        }else if(candidate.volumeUnit!=='contracts')candidate.volumeEvidence={...candidate.volumeEvidence,...unitEvidence};
        candidate.source={...candidate.source,queryDateEndMeaning:'following-calendar-boundary',pagination:'Backward batches cover two desired calendar dates plus the following-day boundary; overlaps are deduplicated. Provider has_more does not establish full historical coverage.'};
        const reachedRange=job.endDate<job.startDate;
        const target=candidate.windows.length>0&&candidate.windows.every(row=>row.sampleCount>=TARGET_SESSIONS);
        if(target||job.pages>=MAX_PAGES||reachedRange){
          job.done=true;job.completedAt=iso(now);
          job.reason=target?'target-sessions':reachedRange?'lookback-limit':'page-limit';
        }
        // Avoid replacing an established reference with an incomplete new pass.
        const retainPrior=saved.profile&&!job.done&&(job.forced===true||profileSamples(saved.profile)>profileSamples(candidate));
        saved={...saved,status:job.done?(target&&candidate.status==='ready'?'history-ready':'history-partial'):'loading-history',
          profile:retainPrior?saved.profile:candidate,lastSuccessAt:iso(now),errors:[]};
        await store.put(`${base}/bars`,{schemaVersion:1,market,underlyingCode,bars});
        await store.put(`${base}/state`,saved);await store.put(`${base}/job`,job);
      }
    }catch(error){
      saved={...saved,status:'history-refresh-failed',errors:[safeFutuError(error)]};
      await store.put(`${base}/state`,saved);await store.put(`${base}/job`,job);
    }
    return publicState(saved,job,now);
  }finally{
    try{if(providerAttempted)await wait(QUOTE_INTERVAL_MS);}
    finally{await store.releaseLease(LEASE_KEY,lease);}
  }
}
