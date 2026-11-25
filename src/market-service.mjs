import {createPrivateStore} from '../lib/secure-store.mjs';
import {connectionStatus,getFutuAccess,startFutuConnection,finishFutuConnection} from '../lib/futu-auth.mjs';
import {createFutuQuoteClient,collectFutuMarket,selectActiveFuture,safeFutuError} from '../lib/futu-client.mjs';
import {resolveCmeWeeklyExpiry} from '../core/expiry-rules.mjs';
import {resolveCmeClExpiry} from '../core/cl-expiry-rules.mjs';
import {advanceFutuCollection} from './refresh-collection.mjs';
import {readWatchContexts,saveWatchContext,projectWatchContext} from './watch-context.mjs';
import {readIvTracking,refreshIvTracking} from './iv-service.mjs';
import {parseMenthorqExport} from '../core/menthorq-import.mjs';
import {readSessionHistory,refreshSessionHistory} from './history-service.mjs';
import {readCollectorStatus,saveCollectorStatus} from './collector-service.mjs';
import {futuresCollectionWindow} from '../core/trading-sessions.mjs';

export const WATCH_MARKETS=['NQ','ES','CL'];
export const REFRESH_MS=5*60*1000;
const STATE_KEY='watch/state', SETTINGS_KEY='watch/settings';
const stateKey=env=>env.GAMMA_COMPACT_STATE==='true'?'watch/state-v3':STATE_KEY;
const iso=ms=>new Date(ms).toISOString();
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const specifications={
  NQ:{hedgeMultiplier:20,tickSize:.25,source:'https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html'},
  ES:{hedgeMultiplier:50,tickSize:.25,source:'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html'},
  CL:{hedgeMultiplier:1000,tickSize:.01,source:'https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.contractSpecs.html'},
};
const publicMarketKeys=['market','provider','status','underlyingCode','underlyingPrice','priceTimestamp','previousPriceObservation','hedgeMultiplier','tickSize','currency','multiplierSource','sourceStatus','delayStatus','collectedAt','availableContracts','selectionBasis','coverage','limitations','errors','lastAttemptAt','lastAttemptStatus','attemptedUnderlyingCode','attemptCoverage','provenance','evidenceSummary','fieldCounts','optionQuoteTimes'];
const publicContractKeys=['code','underlyingCode','expiryDate','expiryTimeZone','expiryTimestamp','exerciseStyle','exerciseStyleBasis','expiryProductRoot','expiryRuleReason','americanApproximationRequiresOptIn','automaticModelAllowed','strike','optionType','iv','delta','gamma','openInterest','multiplier','reportedOptionContractMultiplier','quoteTimestamp','bid','ask','expirationCycle'];
const publicQualityKeys=['issues','quoteTimeStatus','optionCategoryVerified','greeksBasis','greeksDefinitionSource','greeksMethodology','oiTimestamp','greeksTimestamp','delayStatus','modelInputFreshness'];
function compactContract(row,expiryRules=null){
  const compact=Object.fromEntries(publicContractKeys.filter(key=>Object.prototype.hasOwnProperty.call(row,key)).map(key=>[key,row[key]]));
  compact.expiryRuleVersion=row.expiryRuleVersion??row.expirySource?.ruleVersion??null;
  compact.expiryRuleStatus=row.expiryRuleStatus??(row.expiryTimestamp?'resolved':'unresolved');
  compact.multiplierBasis=row.multiplierBasis??(row.multiplierProvenance?.verifiedWeeklyStandard!==null&&row.multiplierProvenance?.verifiedWeeklyStandard!==undefined?'cme-verified-point-value':row.multiplier!==null?'provider-units-unverified':null);
  compact.quality=Object.fromEntries(publicQualityKeys.filter(key=>Object.prototype.hasOwnProperty.call(row.quality??{},key)).map(key=>[key,row.quality[key]]));
  if(row.quality?.optionCategoryVerified===true&&/^US\.(?:NQ|ES|CL)\d{4}$/.test(row.underlyingCode??'')){
    compact.quality.greeksBasis='futures-price';
    compact.quality.greeksDefinitionSource='https://support.futunn.com/hant/topic473';
    compact.quality.greeksMethodology='Provider calculation model and calculation timestamp unspecified.';
    compact.expiryTimeZone='America/New_York';
    if(/^US\.CL\d{4}$/.test(row.underlyingCode)){
      const rule=resolveCmeClExpiry({market:'CL',code:row.code,strike:row.strike,underlyingCode:row.underlyingCode,expiry_date:row.expiryDate,expiration_cycle:row.expirationCycle});
      if(rule.classificationStatus==='resolved'){
        // Upgrade saved rows using the reviewed clock without fetching quotes
        // or changing their observation timestamps or reported Greeks.
        Object.assign(compact,{multiplier:specifications.CL.hedgeMultiplier,multiplierBasis:'cme-verified-point-value',exerciseStyle:rule.exerciseStyle,exerciseStyleBasis:'cme-verified-product-family',expiryTimestamp:rule.expiry,expiryProductRoot:rule.productRoot,expiryRuleReason:rule.reason,expiryRuleVersion:rule.ruleVersion,expiryRuleStatus:rule.status,expiryClockBasis:rule.provenance.clockBasis??null,americanApproximationRequiresOptIn:rule.americanApproximationRequiresOptIn,automaticModelAllowed:rule.automaticModelAllowed});
        compact.quality.issues=(compact.quality.issues??[]).filter(issue=>issue!=='exact-cl-expiration-clock-unverified');
        if(rule.status!=='resolved')compact.quality.issues.push('exact-cl-expiration-clock-unverified');
        if(expiryRules){
          const previous=expiryRules[rule.ruleVersion];
          expiryRules[rule.ruleVersion]={authority:'CME family rules with separately attributed clocks; consult each product family.',sources:[...new Set([...(previous?.sources??[]),...rule.provenance.sources])],productFamilies:{...previous?.productFamilies,[rule.productRoot]:{exerciseStyle:rule.exerciseStyle,contractMultiplier:rule.contractMultiplier,exactExpiryStatus:rule.exactExpiryStatus,...rule.provenance}}};
        }
      }
    }
  }
  return compact;
}
function addEvidence(summary,evidence){for(const [field,status]of Object.entries(evidence??{})){if(typeof status!=='string')continue;summary[field]??={};summary[field][status]=(summary[field][status]??0)+1;}}
function sharedProvenance(market,expiryRules={}){return {expiryRules,contractPointValue:{currency:'USD',hedgeMultiplier:market.hedgeMultiplier??specifications[market.market]?.hedgeMultiplier??null,unit:'USD per futures point',source:market.multiplierSource??specifications[market.market]?.source??null},optionMultiplierBasis:'Verified CME point values for resolved NQ/ES weekly families and classified standard-size CL weekly/LO/LCE families; other provider values have unverified units. A verified point value does not resolve an expiration timestamp or permit American approximation.',reportedOptionContractMultiplierUnit:'provider units unverified',reportedGreeksBasis:'Futures-price units only for verified option-category snapshots with an exact dated NQ/ES/CL underlying; other rows remain unverified. This verifies the derivative units, not the provider calculation model or calculation timestamp.',reportedGreeksDefinitionSource:'https://support.futunn.com/hant/topic473',oiAndGreekCalculationTimes:'unavailable'};}
function publicMarket(market,{summary=false,watchedStrikes=null}={}){
  const result=Object.fromEntries(publicMarketKeys.filter(key=>Object.prototype.hasOwnProperty.call(market,key)).map(key=>[key,market[key]]));
  const sourceRows=Array.isArray(market.contracts)?market.contracts:[];
  const rows=watchedStrikes?sourceRows.filter(row=>watchedStrikes.has(row.strike)):sourceRows;
  if(watchedStrikes){result.sourceContractCount=sourceRows.length;result.payloadScope='MenthorQ watched option strikes';}
  if(summary){
    const normalized=rows.map(row=>compactContract(row));
    result.contracts=[];result.contractCount=rows.length;
    result.fieldCounts=Object.fromEntries(['iv','delta','gamma','openInterest','expiryTimestamp','multiplier'].map(key=>[key,normalized.filter(row=>key==='expiryTimestamp'?!!row[key]:finite(row[key])).length]));
    result.coverage={...result.coverage,exactExpiryCount:result.fieldCounts.expiryTimestamp};
    return result;
  }
  // Also compact snapshots saved before this payload revision, so deployment
  // fixes oversized responses without waiting for another provider refresh.
  const expiryRules={},evidenceSummary=market.evidenceSummary??{};
  if(!market.provenance||!market.evidenceSummary)for(const row of rows){
    if(row.expirySource?.provenance&&row.expirySource.ruleVersion)expiryRules[row.expirySource.ruleVersion]=row.expirySource.provenance;
    if(!market.evidenceSummary)addEvidence(evidenceSummary,row.quality?.evidence);
  }
  result.provenance=market.provenance??sharedProvenance(market,expiryRules);
  const greekPolicy=sharedProvenance(market,expiryRules);
  result.provenance={...result.provenance,reportedGreeksBasis:greekPolicy.reportedGreeksBasis,reportedGreeksDefinitionSource:greekPolicy.reportedGreeksDefinitionSource};
  result.evidenceSummary=evidenceSummary;
  result.contracts=rows.map(row=>compactContract(row,expiryRules));
  result.fieldCounts=Object.fromEntries(['iv','delta','gamma','openInterest','expiryTimestamp','multiplier'].map(key=>[key,result.contracts.filter(row=>key==='expiryTimestamp'?!!row[key]:finite(row[key])).length]));
  result.coverage={...result.coverage,exactExpiryCount:result.fieldCounts.expiryTimestamp};
  result.provenance.expiryRules={...result.provenance.expiryRules,...expiryRules};
  return result;
}
function emptyMarket(market){return {market,status:'awaiting-connection',underlyingCode:null,underlyingPrice:null,priceTimestamp:null,contracts:[],availableContracts:[],coverage:{expected:0,returned:0},errors:[]};}
function emptyState(){return {schemaVersion:2,status:'awaiting-connection',provider:'Futu OpenAPI',intervalMinutes:15,expiryHorizonDays:45,lastAttemptAt:null,lastSuccessAt:null,nextRefreshAt:null,markets:Object.fromEntries(WATCH_MARKETS.map(m=>[m,emptyMarket(m)]))};}
export async function readMarketState(env,now=Date.now(),{summary=false,watchOnly=false}={}) {
  const [connection,watchContexts,saved,collector]=await Promise.all([connectionStatus(env),readWatchContexts(env),createPrivateStore(env).get(stateKey(env)),readCollectorStatus(env,now)]);
  const state=saved??emptyState();
  const collectionWindow=futuresCollectionWindow(now);
  return {schemaVersion:state.schemaVersion,status:state.status,provider:state.provider,intervalMinutes:state.intervalMinutes,scheduleEnabled:env.GAMMA_SCHEDULE_ENABLED==='true'||collector.enabled===true,collector,collectionWindow,expiryHorizonDays:state.expiryHorizonDays,lastAttemptAt:state.lastAttemptAt,lastSuccessAt:state.lastSuccessAt,nextRefreshAt:state.nextRefreshAt,refreshInProgress:collectionWindow.open&&state.refreshInProgress===true,progress:state.refreshProgress??null,refreshProgress:state.refreshProgress??null,connection,serverTime:iso(now),markets:Object.fromEntries(WATCH_MARKETS.map(m=>{
    const market=state.markets?.[m]??emptyMarket(m);
    const age=market.priceTimestamp?now-Date.parse(market.priceTimestamp):null;
    const context=projectWatchContext(watchContexts[m],market.underlyingCode,now);
    const watchedStrikes=watchOnly?new Set(context?.underlyingCode===market.underlyingCode?(context.levels??[]).filter(level=>level.kind!=='reference').map(level=>level.strike):[]):null;
    return [m,{...publicMarket(market,{summary,watchedStrikes}),watchContextRevision:watchContexts[m]?.contextUpdatedAt??watchContexts[m]?.capturedAt??null,watchContext:context,quoteAgeSeconds:age===null||!finite(age)?null:Math.max(0,Math.round(age/1000)),stale:age===null||!finite(age)||age>20*60000}];
  }))};
}
function canonicalMarket(result,selection,now) {
  const spec=specifications[result.market],expiryRules={},evidenceSummary={},contracts=result.options.map(row=>{
    const ruleInput={market:result.market,code:row.code,strike:row.strike,expiration_cycle:row.expirationCycle,expiry_date:row.expiryDate,underlyingCode:row.underlyingCode};
    const rule=result.market==='CL'?resolveCmeClExpiry(ruleInput):resolveCmeWeeklyExpiry(ruleInput);
    const standardWeekly=rule.status==='resolved'&&['NQ','ES'].includes(result.market);
    const standardCl=result.market==='CL'&&rule.classificationStatus==='resolved';
    const verifiedPointValue=standardWeekly||standardCl;
    const reportedMultiplier=finite(row.optionMultiplier)&&row.optionMultiplier>0?row.optionMultiplier:null;
    // The generic provider field has no verified currency-per-futures-point
    // unit. Retain it as reported metadata; do not compare it numerically with
    // CME's documented $20/$50 point value or assume a conversion from 1.
    const multiplier=verifiedPointValue?spec.hedgeMultiplier:reportedMultiplier;
    const issues=[...(row.issues??[]),...(reportedMultiplier!==null?['provider-option-multiplier-units-unverified']:[]),...(standardCl&&rule.status!=='resolved'?['exact-cl-expiration-clock-unverified']:[])];
    if(standardCl){
      const existing=expiryRules[rule.ruleVersion];
      expiryRules[rule.ruleVersion]={...rule.provenance,
        sources:[...new Set([...(existing?.sources??[]),...rule.provenance.sources])],
        productFamilies:{...existing?.productFamilies,[rule.productRoot]:{exerciseStyle:rule.exerciseStyle,
          contractMultiplier:rule.contractMultiplier,multiplierUnit:rule.multiplierUnit,settlementType:rule.settlementType,
          sources:rule.provenance.sources,dateVerification:rule.provenance.dateVerification,holidayPolicy:rule.provenance.holidayPolicy}}};
    }else if(rule.status==='resolved')expiryRules[rule.ruleVersion]=rule.provenance;
    addEvidence(evidenceSummary,row.evidence);
    return {code:row.code,underlyingCode:row.underlyingCode,expiryDate:row.expiryDate,
      expiryTimestamp:rule.status==='resolved'?rule.expiry:null,exerciseStyle:rule.status==='resolved'||standardCl?rule.exerciseStyle:null,
      ...(standardCl?{exerciseStyleBasis:'cme-verified-product-family',expiryProductRoot:rule.productRoot,expiryRuleReason:rule.reason,
        americanApproximationRequiresOptIn:rule.americanApproximationRequiresOptIn,automaticModelAllowed:rule.automaticModelAllowed}:{}),
      expiryRuleVersion:rule.ruleVersion,expiryRuleStatus:rule.status,strike:row.strike,optionType:row.optionType.toUpperCase(),
      iv:row.iv,delta:row.delta,gamma:row.gamma,openInterest:row.openInterest,
      multiplier,multiplierBasis:verifiedPointValue?'cme-verified-point-value':reportedMultiplier!==null?'provider-units-unverified':null,
      reportedOptionContractMultiplier:reportedMultiplier,
      quoteTimestamp:row.quoteAsOf,bid:row.bid,ask:row.ask,
      quality:{issues,quoteTimeStatus:row.quoteTimeStatus,optionCategoryVerified:row.optionValid,
        greeksBasis:'unverified',oiTimestamp:null,greeksTimestamp:null,delayStatus:row.delayStatus,
        modelInputFreshness:row.quoteTimeStatus==='fresh'?'quote-fresh-greeks-oi-time-unverified':'stale-or-unverified-inputs'},
      expirationCycle:row.expirationCycle};
  });
  const fieldCounts=Object.fromEntries(['iv','delta','gamma','openInterest','expiryTimestamp','multiplier'].map(key=>[key,contracts.filter(row=>key==='expiryTimestamp'?row[key]!==null:finite(row[key])).length]));
  const quoteTimes=contracts.map(row=>Date.parse(row.quoteTimestamp)).filter(finite);
  const optionQuoteTimes={oldest:quoteTimes.length?iso(Math.min(...quoteTimes)):null,newest:quoteTimes.length?iso(Math.max(...quoteTimes)):null,known:quoteTimes.length,total:contracts.length};
  return {market:result.market,provider:result.provider,status:result.status,underlyingCode:result.underlyingCode,fieldCounts,optionQuoteTimes,
    underlyingPrice:finite(result.underlying?.futuresPrice)&&result.underlying.futuresPrice>0?result.underlying.futuresPrice:null,priceTimestamp:result.underlying?.quoteAsOf??null,
    hedgeMultiplier:spec.hedgeMultiplier,tickSize:spec.tickSize,currency:'USD',multiplierSource:spec.source,
    provenance:sharedProvenance({market:result.market,hedgeMultiplier:spec.hedgeMultiplier,multiplierSource:spec.source},expiryRules),evidenceSummary,
    sourceStatus:'snapshot',delayStatus:'unverified',collectedAt:iso(now),contracts,
    availableContracts:selection?.candidates??selection?.contracts??[],selectionBasis:selection?.selectionBasis??selection?.basis??null,
    coverage:{...result.coverage,...result.chainCoverage,expiryRange:result.requestedExpiryRange,
      exactExpiryCount:contracts.filter(r=>r.expiryTimestamp).length,scope:'Requested expiry range only; other futures months and expiries are excluded.'},
    limitations:result.limitations,errors:result.errors};
}
const refreshJobsByBucket=new WeakMap();
const REFRESH_JOB_KEY='watch/refresh-job';
const refreshJobKey=env=>env.GAMMA_COMPACT_STATE==='true'?'watch/refresh-job-v3':REFRESH_JOB_KEY;
function refreshProgress(job,done=false){
  const current=job.current,market=current?.market??WATCH_MARKETS[job.marketIndex]??null;
  return {jobId:job.id,market,stage:done?'complete':current?.stage??'selection',completed:current?.stage==='metadata'?current.metadataCursor??0:current?.requested??0,total:current?.stage==='metadata'?current.metadataTotal??4:current?.expected??0,completedBatches:current?.quoteCursor??0,totalBatches:current?.quoteBatchTotal??0,completedMarkets:job.completedMarkets??[],failedMarkets:job.failedMarkets??[],totalMarkets:WATCH_MARKETS.length,done,retryAfterMs:done?0:job.retryAfterMs??750};
}
function cacheSelection(value){return value?{...value,underlyingCode:value.underlyingCode??value.code??value.selectedCode??value.selected?.code??null}:null;}
function commitCollectedMarket(next,old,result,selection,now){
  const market=result.market,candidate=canonicalMarket(result,selection,now),previous=old.markets?.[market];
  if(previous?.underlyingCode===candidate.underlyingCode){
    candidate.previousPriceObservation=Date.parse(candidate.priceTimestamp)>Date.parse(previous.priceTimestamp)
      ?{underlyingCode:previous.underlyingCode,price:previous.underlyingPrice,asOf:previous.priceTimestamp}
      :previous.previousPriceObservation??null;
  }
  const previousComplete=previous?.coverage?.collectionComplete===true||(previous?.coverage?.expected>4&&previous.coverage.requested===previous.coverage.expected);
  const incompleteProbe=previousComplete&&result.coverage.collectionComplete===false;
  if(candidate.underlyingPrice!==null&&result.coverage.returned>0&&!incompleteProbe){next.markets[market]=candidate;next.lastSuccessAt=iso(now);return true;}
  const retain=previous&&finite(previous.underlyingPrice)&&previous.underlyingPrice>0;
  const failure={code:candidate.underlyingPrice===null?'UNDERLYING_PRICE_UNAVAILABLE':incompleteProbe?'OPTION_CAPABILITY_UNAVAILABLE':'OPTION_SNAPSHOT_UNAVAILABLE',message:candidate.underlyingPrice===null?'No supported positive underlying futures price was returned. The last valid snapshot is retained.':incompleteProbe?'The capability probe could not complete this market. The previous completed snapshot is retained.':'No verified option snapshots were returned. The last valid snapshot is retained.'};
  next.markets[market]={...(retain?previous:candidate),status:'refresh-failed',lastAttemptAt:iso(now),lastAttemptStatus:result.status,attemptedUnderlyingCode:result.underlyingCode,attemptCoverage:candidate.coverage,errors:[...(result.errors??[]),failure]};return false;
}
export async function refreshMarketState(env,{force=false,fetcher=fetch,now=Date.now(),dependencies={},summary=false,maxSnapshotBatches=5}={}) {
  const bucket=env.BUCKET;if(!bucket||typeof bucket!=='object')throw Error('Private connection storage is not configured.');
  if(!futuresCollectionWindow(now).open)return {...await readMarketState(env,now,{summary}),refreshDeferred:'market-closed'};
  if(!Number.isInteger(maxSnapshotBatches)||maxSnapshotBatches<1||maxSnapshotBatches>5)throw Error('Use one to five snapshot batches per refresh step.');
  let jobs=refreshJobsByBucket.get(bucket);if(!jobs){jobs=new Map();refreshJobsByBucket.set(bucket,jobs);}
  const jobKey=env.GAMMA_SITE_ORIGIN??'';if(jobs.has(jobKey))return jobs.get(jobKey);
  const running=(async()=>{
    const store=createPrivateStore(env);let old=await store.get(stateKey(env))??emptyState();
    let job=await store.get(refreshJobKey(env));
    if(job&&(job.siteOrigin!==jobKey||now-Date.parse(job.startedAt)>3600000))job=null;
    const observedJobId=job?.id??null;
    const last=Date.parse(old.lastAttemptAt??'');
    // An active durable job always resumes, even inside the slot/cooldown.
    // Legacy interrupted "refreshing" state without a job starts recovery.
    if(!job&&old.status!=='refreshing'&&finite(last)&&((!force&&Math.floor(last/REFRESH_MS)===Math.floor(now/REFRESH_MS))||(force&&now-last<60000)))return readMarketState(env,now,{summary});
    const connection=await connectionStatus(env);if(!connection.connected)return readMarketState(env,now,{summary});
    const lease=await store.acquireLease('watch/refresh-lease',now,60000);
    if(!lease){const state=await readMarketState(env,now,{summary}),progress={...(state.refreshProgress??{}),stage:'waiting',retryAfterMs:2000,done:false};return {...state,refreshInProgress:true,progress,refreshProgress:progress};}
    try{
      // Another isolate may finish a batch/market between our speculative read
      // and acquisition. Only data reread inside this lease may drive writes.
      old=await store.get(stateKey(env))??emptyState();job=await store.get(refreshJobKey(env));
      if(job&&(job.siteOrigin!==jobKey||now-Date.parse(job.startedAt)>3600000)){await store.remove(refreshJobKey(env));job=null;}
      // State may have committed before a previous worker was interrupted while
      // removing the finished job. Complete cleanup without selecting market 4.
      if(job&&job.marketIndex>=WATCH_MARKETS.length){
        await store.put(stateKey(env),{...old,status:job.successfulMarkets?.length===WATCH_MARKETS.length?'updated':'partial-or-unavailable',refreshInProgress:false,refreshProgress:refreshProgress(job,true)});
        await store.remove(refreshJobKey(env));return readMarketState(env,now,{summary});
      }
      const lockedLast=Date.parse(old.lastAttemptAt??'');
      // An in-flight request that observed a job resumes that job; if another
      // writer just finished it, even force=true must not start a replacement.
      if(!job&&(observedJobId||(old.status!=='refreshing'&&finite(lockedLast)&&((!force&&Math.floor(lockedLast/REFRESH_MS)===Math.floor(now/REFRESH_MS))||(force&&now-lockedLast<60000)))))return readMarketState(env,now,{summary});
      const settings=await store.get(SETTINGS_KEY)??{};
      if(!job){
        const start=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
        job={id:crypto.randomUUID(),storageKey:refreshJobKey(env),siteOrigin:jobKey,startedAt:iso(now),updatedAt:iso(now),start,end:iso(Date.parse(start+'T00:00:00Z')+45*86400000).slice(0,10),marketIndex:0,completedMarkets:[],successfulMarkets:[],failedMarkets:[],current:null};
        await store.put(refreshJobKey(env),job);
      }
      const next={...old,status:'refreshing',lastAttemptAt:job.startedAt,nextRefreshAt:iso((Math.floor(now/REFRESH_MS)+1)*REFRESH_MS),markets:{...old.markets},refreshInProgress:true,refreshProgress:refreshProgress(job)};
      await store.put(stateKey(env),next);
      const market=WATCH_MARKETS[job.marketIndex];
      const deadlineAtMs=Date.now()+20000;
      const client=(dependencies.createQuoteClient??createFutuQuoteClient)({getAccessToken:()=>getFutuAccess(env,fetcher),fetchImpl:fetcher,notBeforeMs:job.nextRequestAtMs??job.current?.nextRequestAtMs??0,deadlineAtMs});
      job.current??={market,stage:null,retryCount:0};
      const current=job.current;
      try{
        if(!current.underlyingCode){
          let selection=cacheSelection(await store.get('watch/selection/'+market));
          const override=settings[market]?.underlyingCode;
          if(!selection||selection.asOfDate!==job.start||(override&&selection.underlyingCode!==override)){
            selection=cacheSelection(await (dependencies.selectActiveFuture??selectActiveFuture)(client,market,{now}));
            selection.asOfDate=job.start;
            if(override){const candidates=selection.candidates??selection.contracts??[];if(!candidates.some(row=>row.code===override))throw Error('Selected contract is no longer listed.');selection.underlyingCode=override;selection.selectionBasis='User-selected provider-listed contract';}
            await store.put('watch/selection/'+market,selection);
          }
          if(!selection.underlyingCode){
            next.markets[market]={...old.markets?.[market]??emptyMarket(market),status:'contract-selection-required',availableContracts:selection.candidates??selection.contracts??[],errors:[{code:'CONTRACT_SELECTION_REQUIRED',message:'Choose a provider-listed futures month. Automatic selection had no unique volume leader.'}]};
            job.failedMarkets.push(market);job.completedMarkets.push(market);job.marketIndex++;job.current=null;
          }else{current.underlyingCode=selection.underlyingCode;current.selection=selection;await store.put(refreshJobKey(env),job);}
        }
        if(job.current){
          let step;
          // A supplied collector is an adapter/testing seam; the default path
          // checkpoints each individual metadata window and quote batch.
          if(dependencies.collectFutuMarket){
            const result=await dependencies.collectFutuMarket(client,{market,underlyingCode:current.underlyingCode,start:job.start,end:job.end,chainData:await store.get('watch/metadata/'+current.underlyingCode),fullChain:true,now});
            if(result.metadataCache)await store.put('watch/metadata/'+current.underlyingCode,result.metadataCache);
            step={done:true,result,cleanupKeys:[]};
          }else {
            const map=env.GAMMA_COMPACT_STATE==='true'?(await readWatchContexts(env))[current.market]:null;
            const scope=env.GAMMA_COMPACT_STATE==='true'?{allowedStrikes:map?.underlyingCode===current.underlyingCode?map.levels.filter(row=>row.kind!=='reference').map(row=>row.strike):[]}:{};
            step=await advanceFutuCollection(client,{store,job,current,now,maxBatches:maxSnapshotBatches,deadlineAtMs,...scope});
          }
          if(step.done){
            const succeeded=commitCollectedMarket(next,old,step.result,current.selection,now);
            (succeeded?job.successfulMarkets:job.failedMarkets).push(market);job.completedMarkets.push(market);job.marketIndex++;job.current=null;
            await store.put(stateKey(env),next);await store.put(refreshJobKey(env),job);
            await Promise.allSettled((step.cleanupKeys??[]).map(key=>store.remove(key)));
          }
        }
      }catch(error){
        if(error?.code!=='COLLECTION_STEP_YIELD'){
          const safe=safeFutuError(error);current.retryCount=(current.retryCount??0)+1;
          job.retryAfterMs=error?.code==='FUTU_RATE_LIMIT'?60000:750;
          current.lastError=safe;
          const terminal=['FUTU_PERMISSION_REQUIRED','QUOTE_SCOPE_REQUIRED','CONNECTION_REQUIRED','REAUTHORIZATION_REQUIRED'].includes(error?.code)||current.retryCount>=3||!!dependencies.collectFutuMarket;
          if(terminal){next.markets[market]={...old.markets?.[market]??emptyMarket(market),status:'refresh-failed',lastAttemptAt:iso(now),errors:[safe]};job.failedMarkets.push(market);job.completedMarkets.push(market);job.marketIndex++;job.current=null;}
        }
      }
      const done=job.marketIndex>=WATCH_MARKETS.length;
      next.refreshInProgress=!done;next.refreshProgress=refreshProgress(job,done);
      if(done){next.status=job.successfulMarkets.length===WATCH_MARKETS.length?'updated':'partial-or-unavailable';await store.put(stateKey(env),next);await store.remove(refreshJobKey(env));}
      else{job.updatedAt=iso(now);await store.put(refreshJobKey(env),job);await store.put(stateKey(env),next);}
      return readMarketState(env,now,{summary});
    }finally{await store.releaseLease('watch/refresh-lease',lease);}
  })().finally(()=>{jobs.delete(jobKey);});
  jobs.set(jobKey,running);return running;
}
function jsonResponse(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});}
function sameOrigin(request){return request.headers.get('origin')===new URL(request.url).origin;}
function errorResponse(error){const allowed=['OWNER_SIGN_IN_REQUIRED','INVALID_CALLBACK','INVALID_STATE','SCOPE_REJECTED','REGISTRATION_REJECTED','CONNECTION_REQUIRED','REAUTHORIZATION_REQUIRED','REFRESH_TOKEN_REQUIRED','FUTU_AUTHORIZATION_FAILED','AUTH_REFRESH_BUSY','AUTH_REFRESH_UNAVAILABLE','PRIVATE_STORAGE_UNAVAILABLE','DATA_BACKUP_UNAVAILABLE'];return jsonResponse({error:allowed.includes(error?.code)?error.message:'The market-data connection needs attention. No credentials were exposed.',code:allowed.includes(error?.code)?error.code:'CONNECTION_UNAVAILABLE',retryable:['AUTH_REFRESH_BUSY','AUTH_REFRESH_UNAVAILABLE','PRIVATE_STORAGE_UNAVAILABLE','DATA_BACKUP_UNAVAILABLE'].includes(error?.code)},503);}
export async function handleMarketRoute(request,env,ctx,fetcher=fetch) {
  const url=new URL(request.url);
  try {
    if(url.pathname==='/api/recover-market-snapshot'&&request.method==='POST'){
      if(!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to recover the saved snapshot.'},403);
      if(env.GAMMA_COMPACT_STATE!=='true')return jsonResponse({error:'Snapshot recovery is not enabled.'},503);
      const store=createPrivateStore(env,{readTimeoutMs:90000});
      const complete=value=>value?.storageRecoveryComplete===true||WATCH_MARKETS.every(m=>(value?.markets?.[m]?.contracts?.length??0)>0);
      const existing=await store.get(stateKey(env));
      if(complete(existing))return jsonResponse({status:'already-recovered'});
      const lease=await store.acquireLease('watch/refresh-lease',Date.now(),120000);
      if(!lease)return jsonResponse({status:'waiting',retryAfterMs:5000});
      try{
        const current=await store.get(stateKey(env));
        if(complete(current))return jsonResponse({status:'already-recovered'});
        const legacy=await store.get(STATE_KEY),contexts=await readWatchContexts(env);
        if(!legacy?.markets)return jsonResponse({error:'No saved source snapshot was found.'},404);
        const markets=Object.fromEntries(WATCH_MARKETS.map(market=>{
          if(current?.markets?.[market]?.contracts?.length)return [market,current.markets[market]];
          const previous=legacy.markets[market]??emptyMarket(market),context=contexts[market];
          const strikes=new Set(context?.underlyingCode===previous.underlyingCode?context.levels.filter(row=>row.kind!=='reference').map(row=>row.strike):[]);
          const sourceRows=previous.contracts??[];
          return [market,{...previous,contracts:sourceRows.filter(row=>strikes.has(row.strike)),legacySourceContractCount:sourceRows.length,storageScope:'MenthorQ watched strikes; original full snapshot preserved'}];
        }));
        await store.put(stateKey(env),{...legacy,...current,schemaVersion:3,storageRecoveryComplete:true,status:'snapshot-recovered',refreshInProgress:false,refreshProgress:null,markets});
        return jsonResponse({status:'recovered',markets:Object.fromEntries(WATCH_MARKETS.map(m=>[m,{sourceRows:markets[m].legacySourceContractCount,watchedRows:markets[m].contracts.length}]))});
      }finally{await store.releaseLease('watch/refresh-lease',lease);}
    }
    if(url.pathname==='/api/futu/status'&&request.method==='GET'){
      const connection=await connectionStatus(env);
      if(url.searchParams.get('snapshotMetadata')!=='true')return jsonResponse({connection});
      // Owner-private diagnostics expose size/timing only, never stored bodies.
      let timer;
      const snapshotStorage=await Promise.race([
        (async()=>{const object=await env.BUCKET.head('gamma-watch/v1/'+stateKey(env));return object?{status:'present',bytes:object.size,uploadedAt:object.uploaded?.toISOString()??null}:{status:'missing'};})(),
        new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'unavailable'}),5000);})
      ]).catch(()=>({status:'unavailable'})).finally(()=>clearTimeout(timer));
      return jsonResponse({connection,snapshotStorage});
    }
    if(url.pathname==='/api/market-state'&&request.method==='GET'){
      const summary=url.searchParams.get('view')==='summary',state=await readMarketState(env,Date.now(),{summary,watchOnly:true});
      return jsonResponse(summary?compactState(state):state);
    }
    if(url.pathname==='/api/watch-context'&&request.method==='GET')return jsonResponse({contexts:await readWatchContexts(env)});
    if(url.pathname==='/api/collector-status'){
      if(request.method==='GET')return jsonResponse({collector:await readCollectorStatus(env)});
      if(request.method!=='POST')return jsonResponse({error:'Method not allowed.'},405);
      if(!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to update collector status.'},403);
      try{const text=await request.text();if(text.length>5000)throw Error('Too large');return jsonResponse(await saveCollectorStatus(env,JSON.parse(text)));}
      catch{return jsonResponse({error:'Invalid local collector status.'},400);}
    }
    if(['/api/session-history','/api/session-history-refresh'].includes(url.pathname)){
      const read=url.pathname==='/api/session-history';
      if(request.method!==(read?'GET':'POST'))return jsonResponse({error:'Method not allowed.'},405);
      if(!read&&!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to refresh historical comparisons.'},403);
      try{
        let data;
        if(read)data={market:url.searchParams.get('market'),underlyingCode:url.searchParams.get('underlyingCode')};
        else{const text=await request.text();if(text.length>2000)throw Error('History request is too large.');data=JSON.parse(text);}
        const args={market:data.market,underlyingCode:data.underlyingCode,force:data.force===true,fetcher};
        return jsonResponse(read?await readSessionHistory(env,args):await refreshSessionHistory(env,args));
      }catch{return jsonResponse({error:'Historical reference request could not be completed for the selected contract.',code:'HISTORY_REQUEST_INVALID'},400);}
    }
    if(['/api/iv-state','/api/iv-refresh'].includes(url.pathname)){
      if(request.method!==(url.pathname==='/api/iv-state'?'GET':'POST'))return jsonResponse({error:'Method not allowed.'},405);
      if(request.method==='POST'&&!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to check watched IV.'},403);
      try{
        let data;
        if(request.method==='POST'){const text=await request.text();if(text.length>30000)throw Error('IV request is too large.');data=JSON.parse(text);}
        else data={market:url.searchParams.get('market'),underlyingCode:url.searchParams.get('underlyingCode')};
        const contexts=await readWatchContexts(env),context=contexts[data.market];
        const allowedStrikes=context?.underlyingCode===data.underlyingCode?context.levels.filter(row=>row.kind!=='reference').map(row=>row.strike):[];
        const args={market:data.market,underlyingCode:data.underlyingCode,codes:data.codes,allowedStrikes,fetcher};
        return jsonResponse(request.method==='GET'?await readIvTracking(env,args):await refreshIvTracking(env,args));
      }catch(error){return jsonResponse({error:error.message,code:error.code??'IV_REQUEST_INVALID'},400);}
    }
    if(url.pathname==='/api/watch-context'&&request.method==='POST'){
      if(!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to save MenthorQ levels.'},403);
      const text=await request.text();if(text.length>80000)return jsonResponse({error:'Watchlist snapshot is too large.'},400);
      try{
        const data=JSON.parse(text),state=await readMarketState(env,Date.now(),{summary:true}),current=state.markets[data.market];
        if(data.underlyingCode&&data.underlyingCode!==current?.underlyingCode)return jsonResponse({error:'The selected futures contract changed. Check the contract and export before importing.'},400);
        const onlyZeroDte=data.exposure0dte!=null;
        const onlyExposure=data.exposureUpdate!=null;
        const onlyNetDex=data.netDexUpdate!=null;
        if(onlyNetDex&&(onlyExposure||onlyZeroDte||data.context!=null||data.exportText!=null))return jsonResponse({error:'Save Net DEX separately from GEX, Levels and 0DTE imports.'},400);
        if(onlyExposure&&(onlyZeroDte||data.context!=null||data.exportText!=null))return jsonResponse({error:'Save the Exposure Map separately from Levels and 0DTE imports.'},400);
        const imported=onlyNetDex?{underlyingCode:data.underlyingCode,netDexUpdate:data.netDexUpdate}:
          onlyExposure?{underlyingCode:data.underlyingCode,exposureUpdate:data.exposureUpdate}:
          onlyZeroDte?{underlyingCode:data.underlyingCode,exposure0dte:data.exposure0dte}:
          typeof data.exportText==='string'?parseMenthorqExport({market:data.market,underlyingCode:current?.underlyingCode,exportText:data.exportText,sourceDate:data.sourceDate,sourceLocalTime:data.sourceLocalTime,mode:data.mode}):data.context;
        if(!current||imported?.underlyingCode!==current.underlyingCode)return jsonResponse({error:'Select the matching Futu futures month before importing these MenthorQ levels.'},400);
        if(typeof data.exportText==='string'&&current.watchContext?.underlyingCode===imported.underlyingCode)imported.heatmap=current.watchContext.heatmap??null;
        const context=await saveWatchContext(env,data.market,imported,{onlyZeroDte,onlyExposure,onlyNetDex});
        return jsonResponse({saved:true,market:data.market,context:projectWatchContext(context,current.underlyingCode)});
      }catch(error){return jsonResponse({error:error.message},400);}
    }
    if(url.pathname==='/api/futu/connect'&&request.method==='GET')return await startFutuConnection(request,env,fetcher);
    if(url.pathname==='/api/futu/callback'&&request.method==='GET'){
      await finishFutuConnection(request,env,fetcher);
      // The returning page starts a foreground refresh. A multi-market chain
      // collection can exceed Workers' short post-response waitUntil window.
      return new Response(null,{status:303,headers:{location:'/?futu=connected','cache-control':'no-store','referrer-policy':'no-referrer'}});
    }
    if(url.pathname==='/api/refresh'&&request.method==='POST'){
      if(!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to request an update.'},403);
      const text=await request.text();if(text.length>1000)return jsonResponse({error:'Refresh request is too large.'},400);
      const data=text?JSON.parse(text):{},summary=url.searchParams.get('view')==='summary';
      const state=await refreshMarketState(env,{force:data.force===true,fetcher,summary});
      return jsonResponse(summary?compactState(state):state);
    }
    if(url.pathname==='/api/watch-settings'&&request.method==='POST'){
      if(!sameOrigin(request))return jsonResponse({error:'Open GEX Gravity to change the selected contract.'},403);
      const text=await request.text();if(text.length>2000)return jsonResponse({error:'Settings request is too large.'},400);
      const data=JSON.parse(text),market=data.market;
      if(!WATCH_MARKETS.includes(market)||!new RegExp('^US\\.'+market+'[0-9]{4}$').test(data.underlyingCode??''))return jsonResponse({error:'Select one listed futures month.'},400);
      const store=createPrivateStore(env),state=await readMarketState(env,Date.now(),{summary:true}),candidates=state.markets[market].availableContracts;
      if(!candidates.some(row=>row.code===data.underlyingCode))return jsonResponse({error:'That futures month is not in the provider-listed catalogue.'},400);
      const settings=await store.get(SETTINGS_KEY)??{};settings[market]={underlyingCode:data.underlyingCode};await store.put(SETTINGS_KEY,settings);
      return jsonResponse({saved:true,market,underlyingCode:data.underlyingCode});
    }
    return null;
  } catch(error){return errorResponse(error);}
}
const watchTools=[
  {name:'save_menthorq_context',description:'Save a user-authorized MenthorQ export, independently observed all-expiry regime and strike Exposure values for the matching selected future. Unknown source clocks must remain null; never infer GEX magnitudes from ranked labels.',inputSchema:{type:'object',properties:{market:{type:'string',enum:['NQ','ES','CL']},context:{type:'object'}},required:['market','context'],additionalProperties:false}},
  {name:'get_market_watch',description:'Read GEX Gravity NQ, ES and CL quote freshness and coverage. No provider requests.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'refresh_market_watch',description:'Refresh the private GEX Gravity NQ, ES and CL option snapshots if the current 5-minute slot is due. Quote queries only. Preserve last valid snapshots and report unavailable fields.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
];
function compactCoverage(value){
  if(!value||typeof value!=='object')return value;
  const result={};for(const [key,item]of Object.entries(value)){if(Array.isArray(item))result[key+'Count']=item.length;else result[key]=item&&typeof item==='object'?compactCoverage(item):item;}return result;
}
function compactState(state){return {status:state.status,lastAttemptAt:state.lastAttemptAt,lastSuccessAt:state.lastSuccessAt,nextRefreshAt:state.nextRefreshAt,scheduleEnabled:state.scheduleEnabled,collector:state.collector,collectionWindow:state.collectionWindow,refreshDeferred:state.refreshDeferred??null,refreshInProgress:state.refreshInProgress===true,progress:state.progress??state.refreshProgress??null,refreshProgress:state.refreshProgress??state.progress??null,connection:{connected:state.connection.connected,reauthorizationRequired:state.connection.reauthorizationRequired},markets:Object.fromEntries(Object.entries(state.markets).map(([m,r])=>[m,{underlyingCode:r.underlyingCode,underlyingPrice:r.underlyingPrice,priceTimestamp:r.priceTimestamp,quoteAgeSeconds:r.quoteAgeSeconds,stale:r.stale,status:r.status,contracts:r.contractCount??r.contracts?.length??0,contractCount:r.contractCount??r.contracts?.length??0,sourceContractCount:r.sourceContractCount??r.contractCount??r.contracts?.length??0,payloadScope:r.payloadScope??null,collectedAt:r.collectedAt,watchContextRevision:r.watchContextRevision??null,watchContext:r.watchContext??null,previousPriceObservation:r.previousPriceObservation??null,fieldCounts:r.fieldCounts??null,optionQuoteTimes:r.optionQuoteTimes??null,coverage:compactCoverage(r.coverage),attemptCoverage:compactCoverage(r.attemptCoverage),errors:(r.errors??[]).slice(0,3),errorCount:r.errors?.length??0}]))};}
export async function handleWatchMcp(request,env,fetcher=fetch) {
  if(request.method!=='POST')return jsonResponse({error:'Use the connected GEX Gravity tools.'},405);
  let body;try{const text=await request.text();if(text.length>10000)throw Error();body=JSON.parse(text);}catch{return jsonResponse({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON.'}},400);}
  const id=body.id??null,reply=result=>jsonResponse({jsonrpc:'2.0',id,result});
  if(body.method==='server/discover')return reply({serverInfo:{name:'GEX Gravity',version:'3.0.0'},supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if(body.method==='initialize')return reply({protocolVersion:'2026-07-28',serverInfo:{name:'GEX Gravity',version:'3.0.0'},capabilities:{tools:{}}});
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  if(body.method==='tools/list')return reply({tools:watchTools});
  if(body.method==='tools/call'){
    const name=body.params?.name;
    if(name==='save_menthorq_context'){
      try{const args=body.params.arguments??{};if(Object.keys(args).some(k=>!['market','context'].includes(k)))throw Error('Unexpected import field.');
        const state=await readMarketState(env,Date.now(),{summary:true});if(args.context?.underlyingCode!==state.markets[args.market]?.underlyingCode)throw Error('Select the matching futures month before importing.');
        const saved=await saveWatchContext(env,args.market,args.context);return reply({content:[{type:'text',text:JSON.stringify({saved:true,market:args.market,context:projectWatchContext(saved,saved.underlyingCode)})}]});
      }catch(error){return reply({isError:true,content:[{type:'text',text:error.message}]});}
    }
    if(!watchTools.some(t=>t.name===name)||Object.keys(body.params?.arguments??{}).length)return reply({isError:true,content:[{type:'text',text:'Unknown tool or unsupported arguments.'}]});
    try{const state=name==='refresh_market_watch'?await refreshMarketState(env,{fetcher,summary:true}):await readMarketState(env,Date.now(),{summary:true});return reply({content:[{type:'text',text:JSON.stringify(compactState(state))}]});}
    catch{return reply({isError:true,content:[{type:'text',text:'The quote update could not complete. Check GEX Gravity connection status.'}]});}
  }
  return jsonResponse({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found.'}},404);
}
