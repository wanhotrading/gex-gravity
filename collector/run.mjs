import {mkdir,readFile,writeFile,appendFile,open,unlink,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localSiteClient} from './site-client.mjs';
import {retryMenthorqUpload} from './menthorq-uploads.mjs';
import {futuresCollectionWindow} from '../core/trading-sessions.mjs';
import {ensureCollectorBrowser} from './browser-supervisor.mjs';
import {checkMenthorqAlert,showMenthorqAlert} from './menthorq-alert.mjs';
import {markMenthorqAttempt,menthorqCapturePlan,menthorqNeedsAccessAttention,recordMenthorqResult,shouldNotify} from './recovery.mjs';
const project=path.resolve(fileURLToPath(new URL('..',import.meta.url))),runtime=path.resolve(project,'../gex-gravity-collector');
const now=Date.now(),deadline=now+230000,window=futuresCollectionWindow(now);
const captureOnce=process.argv.includes('--capture-menthorq-once')&&!process.argv.includes('--check');
const checkOnly=process.argv.includes('--check');
await mkdir(runtime,{recursive:true});
const lockPath=path.join(runtime,'run.lock');let lock;
const exitBusy=()=>{
  if(captureOnce)console.log(JSON.stringify({status:'blocked',code:'MQ_COLLECTOR_BUSY'}));
  process.exit(captureOnce?1:0);
};
try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:now}));}
catch{try{const old=JSON.parse(await readFile(lockPath,'utf8'));try{process.kill(old.pid,0);exitBusy();}catch(e){if(e.code!=='ESRCH')exitBusy();}await unlink(lockPath);}catch{}exitBusy();}
let saved={};try{saved=JSON.parse(await readFile(path.join(runtime,'state.json'),'utf8'));}catch{}
const result={mode:'windows-software',enabled:false,futu:saved.futuLastResult??'idle',menthorq:'skipped',menthorqCode:null,...saved.menthorqLastResult,marketWindow:window.reason};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const persist=async()=>{const temp=path.join(runtime,'state.'+process.pid+'.tmp');await writeFile(temp,JSON.stringify(saved));await rename(temp,path.join(runtime,'state.json'));};
const safe=error=>/^(?:SITE|MQ)_[A-Z_0-9]+$/.test(error.message)?error.message:'COLLECTION_FAILED';
try{
  const config=JSON.parse(await readFile(path.join(runtime,'config.json'),'utf8'));result.enabled=config.taskInstalled===true;
  const menthorqEnabled=config.menthorqEnabled===true&&['exposure-map','levels-and-exposure'].includes(config.menthorqScope);
  result.menthorqScope=menthorqEnabled?config.menthorqScope:null;
  if(captureOnce&&!menthorqEnabled)throw Error('MQ_EXPOSURE_SCOPE_REQUIRED');
  if(captureOnce&&window.weekend)throw Error('MQ_WEEKEND_PAUSE');
  if(!captureOnce&&!checkOnly&&saved.siteRetryAt>now)process.exitCode=0;
  else{
  const request=localSiteClient(runtime,config.origin);
  const readMarketState=()=>request('/api/market-state?view=summary',undefined,{timeoutMs:15000});
  let state=await readMarketState();
  delete saved.siteRetryAt;
  if(checkOnly){console.log(JSON.stringify({connected:state.connection?.connected,exactContracts:Object.fromEntries(Object.entries(state.markets??{}).map(([m,r])=>[m,r.underlyingCode])),window}));process.exitCode=0;}
  else{
    const slot=Math.floor(now/300000);
    if(!menthorqEnabled)Object.assign(result,{menthorq:'skipped',menthorqCode:'manual-import',menthorqStage:null});
    if(menthorqEnabled&&saved.menthorqScope!==result.menthorqScope){
      // Earlier results cannot establish collection health under a new scope.
      for(const key of ['menthorqSlot','menthorqOvernightSlot','menthorqEodDate','menthorqDexEodDate','menthorqAttemptSlot','menthorqAttemptAt','menthorqLastResult',
        'menthorqLastCompletedAt','menthorqMarkets','menthorqRetryAt','menthorqFailures','menthorqUploadQueue'])delete saved[key];
      Object.assign(result,{menthorq:'idle',menthorqCode:null,menthorqStage:null});
    }
    saved.menthorqScope=result.menthorqScope;
    if(saved.menthorqRetryAt&&!menthorqNeedsAccessAttention(saved.menthorqLastResult,saved.menthorqMarkets))saved.menthorqRetryAt=null;
    if(menthorqEnabled&&!window.weekend&&saved.menthorqUploadQueue?.length){
      const uploadDeadline=Math.min(deadline-40_000,Date.now()+48_000);
      for(let step=0;step<2&&saved.menthorqUploadQueue.length&&uploadDeadline-Date.now()>=30_000;step++){
        const sent=await retryMenthorqUpload({request,state,saved,persist,date:window.date,deadline:uploadDeadline});
        if(!sent)break;
        state.markets[sent.market].watchContext=sent.context;
        (result.menthorqRecoveredUploads??=[]).push({market:sent.market,kind:sent.kind});
      }
    }
    const report=async()=>{
      try{
        await request('/api/collector-status',{...result,menthorqRetryAt:saved.menthorqRetryAt?new Date(saved.menthorqRetryAt).toISOString():null,
          futuLastCompletedAt:saved.futuLastCompletedAt??null,menthorqLastCompletedAt:saved.menthorqLastCompletedAt??null,
          menthorqLastCheckedAt:saved.menthorqLastCheckedAt??null,menthorqRetryResult:saved.menthorqRetryResult??null,
          menthorqMarkets:saved.menthorqMarkets??[]},{timeoutMs:8000});
        delete result.statusReportCode;
      }catch(error){
        result.statusReportCode=safe(error);
      }
    };
    const attemptMenthorq=async(plan,{requested=false}={})=>{
      markMenthorqAttempt(saved,now);
      await persist();
      try{
        if(config.browserApproved!==true||config.browserPort!==9337)throw Error('MQ_BROWSER_NOT_APPROVED');
        await ensureCollectorBrowser(runtime);
        const {collectMenthorq}=await import('./menthorq-browser.mjs');
        const browserDeadline=Math.min(deadline-25000,Date.now()+165000);
        const capture=await collectMenthorq({request,state,config,window,saved,persist,deadline:browserDeadline,
          plan,startedAt:now,captureOnce:requested});
        Object.assign(result,capture);
        if(capture.menthorqMarkets)saved.menthorqMarkets=capture.menthorqMarkets;
      }catch(error){
        Object.assign(result,{menthorq:'blocked',menthorqCode:error.message==='MQ_BROWSER_NOT_APPROVED'?error.message:'MQ_BROWSER_SETUP_REQUIRED',menthorqStage:'browser'});
      }
      saved.menthorqLastCheckedAt=new Date().toISOString();
      recordMenthorqResult(saved,result);
      await persist();
    };
    const finish=async()=>{
      saved.lastRunAt=new Date().toISOString();
      await persist();
      await appendFile(path.join(runtime,'runs.ndjson'),JSON.stringify({at:saved.lastRunAt,...result})+'\n');
      console.log(JSON.stringify(result));
    };
    if(captureOnce){
      if(saved.menthorqRetryAt>now||now-(saved.menthorqAttemptAt??0)<60000)throw Error('MQ_RETRY_BACKOFF');
      const plan=menthorqCapturePlan(window,saved,now,{requested:true});
      if(!plan)throw Error('MQ_PUBLICATION_PAUSE');
      result.futu=state.collector?.futu??'idle';
      await attemptMenthorq(plan,{requested:true});
      await report();
      await finish();
      if(!['updated','unchanged'].includes(result.menthorq))process.exitCode=1;
    }else{
    if(window.weekend)Object.assign(result,{futu:'skipped',menthorq:'skipped',menthorqCode:'weekend-pause',menthorqStage:null});
    // Browser collection runs first in its own bounded budget. Durable Futu
    // jobs resume in the remaining time and on later minute heartbeats.
    const queued=state.collector?.menthorqRetry;
    const pending=['queued','running'].includes(queued?.status);
    let checkedMenthorq=false;
    if(menthorqEnabled&&pending&&now-(saved.menthorqAttemptAt??0)>=60000){
      const prior=saved.menthorqRetryResult;
      if(prior?.id===queued.id){
        if(prior.status==='running')saved.menthorqRetryResult={id:queued.id,status:'error',code:'MQ_RETRY_INTERRUPTED',finishedAt:new Date().toISOString()};
      }else{
        const plan=menthorqCapturePlan(window,saved,now,{requested:true});
        if(plan){
          saved.menthorqRetryResult={id:queued.id,status:'running'};
          await persist();
          await report();
          await attemptMenthorq(plan,{requested:true});
          checkedMenthorq=true;
          saved.menthorqRetryResult={id:queued.id,status:result.menthorq,code:result.menthorqCode,finishedAt:new Date().toISOString()};
        }else saved.menthorqRetryResult={id:queued.id,status:'skipped',code:'MQ_PUBLICATION_PAUSE',finishedAt:new Date().toISOString()};
      }
      await persist();
      await report();
    }else if(menthorqEnabled&&!pending){
      const plan=menthorqCapturePlan(window,saved,now);
      if(plan){
        await attemptMenthorq(plan);
        checkedMenthorq=true;
      }
      // Report MenthorQ independently so a later Futu error cannot hide its result.
      if(checkedMenthorq)await report();
    }
    if(!menthorqEnabled){
      result.menthorq='skipped';
      result.menthorqCode='manual-import';
    }else if(!checkedMenthorq&&!window.weekend&&!['blocked','partial','error','auth-required'].includes(result.menthorq)){
      result.menthorqCode=window.menthorqIntraday||window.menthorqOvernight?'slot-complete':'provider-publication-pause';
    }
    if(result.enabled){
      if(checkedMenthorq&&(window.menthorqIntraday||window.menthorqEod))state=await readMarketState().catch(()=>state);
      const alert=checkMenthorqAlert({state,window,now:Date.now(),automatic:menthorqEnabled,result:{...result,menthorqMarkets:saved.menthorqMarkets}});
      if(!alert&&window.menthorqIntraday)saved.menthorqAlert=null;
      else if(shouldNotify(saved,alert,now)){
        try{
          await showMenthorqAlert(alert);
          saved.menthorqAlert=alert.key;
          saved.menthorqAlertAt=now;
          if(alert.key.endsWith('|save-conflict-overdue'))saved.menthorqConflictAlertAt=now;
          result.menthorqAlert='shown';
        }catch{result.menthorqAlert='notification-unavailable';}
      }
    }
    if(!window.open)result.futu='skipped';
    else if(!state.connection?.connected){result.futu='auth-required';}
    else if(state.refreshInProgress||saved.futuSlot!==slot){
      saved.futuSlot=slot;await persist();result.futu='collecting';
      while(Date.now()<deadline-20000){
        state=await request('/api/refresh?view=summary',{force:false});
        if(!state.refreshInProgress){result.futu=state.status==='updated'?'updated':'partial';break;}
        const delay=Math.min(60000,Math.max(750,state.progress?.retryAfterMs??2000));
        if(Date.now()+delay>=deadline-20000)break;
        await sleep(delay);
      }
      saved.futuLastResult=result.futu;
      if(result.futu==='updated'&&state.lastSuccessAt)saved.futuLastCompletedAt=state.lastSuccessAt;
    }
    // History progresses in bounded steps only after the chain has yielded its lease.
    if(window.open&&!state.refreshInProgress&&Date.now()<deadline-25000){try{
      const markets=['NQ','ES','CL'],market=markets[(saved.historyIndex??0)%3],underlyingCode=state.markets?.[market]?.underlyingCode;
      if(underlyingCode){await request('/api/session-history-refresh',{market,underlyingCode});saved.historyIndex=(saved.historyIndex??0)+1;}
    }catch{result.historyCode='HISTORY_REFRESH_FAILED';}
    }
    await report();
    await finish();
    }
  }
  }
}catch(error){
  if(!captureOnce&&!checkOnly&&error.route==='/api/market-state'&&/^SITE_(?:HTTP_(?:401|403|429|5\d\d)|NETWORK_UNAVAILABLE|REQUEST_TIMEOUT)$/.test(error.message)){
    saved.siteRetryAt=Date.now()+5*60000;
    await persist().catch(()=>{});
  }
  const failure={at:new Date().toISOString(),...result,status:'error',code:safe(error),serviceCode:error.serviceCode??null,route:error.route??null};
  await appendFile(path.join(runtime,'runs.ndjson'),JSON.stringify(failure)+'\n').catch(()=>{});
  console.log(JSON.stringify(failure));process.exitCode=1;
}
finally{await lock.close();await unlink(lockPath).catch(()=>{});}
