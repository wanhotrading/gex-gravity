import {nyClock} from '../core/market-reading.mjs';
import {parseMenthorqExport} from '../core/menthorq-import.mjs';
import {MENTHORQ_EOD_START} from '../core/trading-sessions.mjs';
import {datedInstrument,aggregateDisplay,visibleExposureRow,isOlderMap,levelClock,hasIntradayDexCapture,sameExposureSnapshot} from './menthorq-data.mjs';
import {isBusySave,saveMenthorqUpdate} from './site-client.mjs';
import {clearMenthorqUpload,rejectedMenthorqUpload,rememberMenthorqUpload} from './menthorq-uploads.mjs';
import {connectCollectorBrowser} from './browser-attach.mjs';

const ORIGIN='https://dashboard.menthorq.io',PORT=9337;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requireTime=deadline=>{if(Date.now()>deadline-3000)throw Error('MQ_TIME_BUDGET');};
const stepTimeout=(deadline,max)=>{
  requireTime(deadline);
  return Math.min(max,deadline-Date.now()-1000);
};
async function ready(page){
  if(new URL(page.url()).origin!==ORIGIN||/\/(?:login|sign-in|signin)(?:\/|$)/i.test(new URL(page.url()).pathname))throw Error('MQ_LOGIN_REQUIRED');
  if(await page.getByRole('textbox',{name:/password/i}).count())throw Error('MQ_LOGIN_REQUIRED');
  if(await page.getByText(/verify you are human|checking your browser|access denied|too many requests/i).count())throw Error('MQ_ACCESS_ATTENTION');
}
async function navigate(page,url,timeout=30000){
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout});
  if([401,403,429].includes(response?.status()))throw Error(response.status()===401?'MQ_LOGIN_REQUIRED':'MQ_ACCESS_ATTENTION');
  await ready(page);
}
export const allExpirationsName=/^All\s+.+\s+Expirations$/i;
function levelsSteps(deadline){
  return async(name,action,limit=5000)=>{
    try{return await action(stepTimeout(deadline,limit));}
    catch(error){
      if(error.name==='TimeoutError')throw Error('MQ_LEVELS_'+name+'_TIMEOUT');
      throw error;
    }
  };
}
async function openLevels(page,{mode,deadline}){
  const step=levelsSteps(deadline);
  await step('PAGE',timeout=>navigate(page,ORIGIN+'/en/levels',timeout),10000);
  if(new URL(page.url()).pathname!=='/en/levels')throw Error('MQ_LEVELS_PAGE_UNVERIFIED');
  await step('TICKER_TAB',timeout=>page.getByRole('tab',{name:'Paste Tickers',exact:true}).click({timeout}),10000);
  await step('MODE_MENU',timeout=>page.getByRole('combobox').click({timeout}));
  await step('MODE',timeout=>page.getByRole('option',{name:'Gamma Levels '+mode,exact:true}).click({timeout}));
}
export async function readLevels(page,{instrument,deadline}){
  const step=levelsSteps(deadline);
  // A multi-ticker export can use the oldest available date in the batch.
  await step('TICKERS',timeout=>page.getByRole('textbox').fill(instrument,{timeout}));
  await step('SEARCH',timeout=>page.getByRole('button',{name:'Search',exact:true}).click({timeout}));
  const exportNode=page.getByText(new RegExp(`\\$${instrument}:`)).first();
  await step('EXPORT',timeout=>exportNode.waitFor({state:'visible',timeout}),7000);
  if(!await step('DATE',timeout=>page.getByRole('button',{name:'Next date',exact:false}).isDisabled({timeout})))throw Error('MQ_LATEST_DATE_UNVERIFIED');
  const observed=await step('EXPORT',timeout=>exportNode.evaluate(node=>({
    exportText:node.innerText,
    clockText:node.closest('main')?.innerText??'',
  }),undefined,{timeout}));
  return {exportText:observed.exportText,...levelClock(observed.clockText)};
}
function exposureModeControl(page){
  return page.locator('main').locator('button, [role="combobox"]').filter({hasText:/^\s*(?:Intraday|EOD)\s*$/});
}
async function chooseMode(page,mode,deadline){
  const control=exposureModeControl(page);
  await control.waitFor({state:'visible',timeout:stepTimeout(deadline,15000)});
  if((await control.innerText({timeout:stepTimeout(deadline,7000)})).trim()!==mode){
    await control.click({timeout:stepTimeout(deadline,7000)});
    await page.getByRole('option',{name:mode,exact:true}).click({timeout:stepTimeout(deadline,7000)});
  }
  if((await control.innerText({timeout:stepTimeout(deadline,7000)})).trim()!==mode)throw Error('MQ_MODE_UNVERIFIED');
}
function checkExposurePage(page,instrument){
  const source=new URL(page.url());
  if(source.origin!==ORIGIN||source.pathname!=='/en/options/exposure'||source.searchParams.get('symbol')!==instrument){
    throw Error('MQ_EXPOSURE_PAGE_UNVERIFIED');
  }
  return `${source.origin}${source.pathname}?symbol=${encodeURIComponent(instrument)}`;
}
async function readExposure(page,{instrument,strikes,mode,metric,deadline}){
  const sourceUrl=checkExposurePage(page,instrument);
  const symbol=page.getByRole('button',{name:new RegExp(`^[A-Z] ${instrument} Ctrl`)});
  await symbol.waitFor({state:'visible',timeout:stepTimeout(deadline,15000)});
  const control=page.getByRole('combobox').nth(0);
  await control.waitFor({state:'visible',timeout:stepTimeout(deadline,15000)});
  if((await control.innerText({timeout:stepTimeout(deadline,7000)})).trim()!==metric){
    await control.click({timeout:stepTimeout(deadline,7000)});
    await page.getByRole('option',{name:metric,exact:true}).click({timeout:stepTimeout(deadline,7000)});
  }
  const title=metric==='Net DEX'?/^(?:Exposure|Net (?:DEX|Delta) Exposure)$/:/^(?:Exposure|Net GEX Exposure)$/;
  const heading=page.locator('main').getByText(title);
  await heading.waitFor({state:'visible',timeout:stepTimeout(deadline,20000)});
  await chooseMode(page,mode,deadline);
  const all=page.getByRole('button',{name:allExpirationsName});
  await all.waitFor({state:'visible',timeout:stepTimeout(deadline,20000)});
  if(await all.getAttribute('aria-pressed',{timeout:stepTimeout(deadline,7000)})!=='true'){
    await all.click({timeout:stepTimeout(deadline,7000)});
  }
  const verifySelection=async()=>{
    checkExposurePage(page,instrument);
    if(!await symbol.isVisible()||!await heading.isVisible()
      ||(await control.innerText({timeout:stepTimeout(deadline,7000)})).trim()!==metric)throw Error('MQ_METRIC_UNVERIFIED');
    const labels=await page.locator('main').getByText(metric,{exact:true}).all();
    let metricColumn=false;
    for(const label of labels){
      if(await label.isVisible()&&await label.evaluate(node=>!node.closest('button,[role="combobox"]'),undefined,{timeout:stepTimeout(deadline,4000)})){
        metricColumn=true;
        break;
      }
    }
    if(!metricColumn)throw Error('MQ_METRIC_COLUMN_UNVERIFIED');
    if((await exposureModeControl(page).innerText({timeout:stepTimeout(deadline,7000)})).trim()!==mode)throw Error('MQ_MODE_UNVERIFIED');
    if(await all.getAttribute('aria-pressed',{timeout:stepTimeout(deadline,7000)})!=='true')throw Error('MQ_SCOPE_UNVERIFIED');
  };
  // Metric, mode and expiry changes can render asynchronously.
  stepTimeout(deadline,1500);
  await wait(1500);
  await verifySelection();
  const aggregate=aggregateDisplay(await all.innerText({timeout:stepTimeout(deadline,7000)}));
  const delayStatus=await page.getByRole('button',{name:'Delayed',exact:true}).isVisible()?'delayed':'unverified';
  const capturedAt=new Date().toISOString(),found=new Map(),wanted=new Set(strikes);
  // Read the displayed third column of each visible four-column strike row.
  // Bar widths, ranks, OI graphics and off-screen overscan are never values.
  async function viewport(position){return page.locator('main').evaluate((main,position)=>{
    const rows=[...main.querySelectorAll('div[style*="translateY("]')].filter(el=>el.children.length===4&&/^\d[\d,]*\.\d+$/.test(el.children[0].innerText.trim()));
    let view=rows[0]?.parentElement;while(view&&!(getComputedStyle(view).overflowY==='auto'&&view.scrollHeight>view.clientHeight))view=view.parentElement;
    if(!view)return null;
    if(position!==null){view.scrollTop=position;return {position:view.scrollTop,height:view.clientHeight,total:view.scrollHeight};}
    const box=view.getBoundingClientRect(),top=Math.max(0,box.top),bottom=Math.min(innerHeight,box.bottom);
    const visible=rows.map(el=>({el,box:el.getBoundingClientRect()})).filter(row=>row.box.bottom>top&&row.box.top<bottom).sort((a,b)=>a.box.top-b.box.top);
    const settled=visible.length>0&&visible[0].box.top<=top+44&&visible.at(-1).box.bottom>=bottom-44&&visible.every((row,index)=>!index||row.box.top-visible[index-1].box.bottom<2);
    return {position:view.scrollTop,height:Math.max(44,bottom-top),total:view.scrollHeight,clientHeight:view.clientHeight,settled,rows:visible.map(row=>[...row.el.children].map(c=>c.innerText))};
  },position,{timeout:stepTimeout(deadline,4000)});}
  async function settledFrame(position=null){
    const target=position===null?null:await viewport(position);if(position!==null&&!target)throw Error('MQ_ROWS_UNREADABLE');
    const stop=Math.min(deadline-3000,Date.now()+4000);
    while(Date.now()<stop){await wait(100);const frame=await viewport(null);if(!frame)throw Error('MQ_ROWS_UNREADABLE');
      if(frame.settled&&(target===null||Math.abs(frame.position-target.position)<2))return frame;
      if(target&&Math.abs(frame.position-target.position)>=2)await viewport(target.position);
    }
    throw Error('MQ_ROWS_NOT_SETTLED');
  }
  const remember=frame=>{for(const cells of frame.rows){const row=visibleExposureRow(cells);if(row&&wanted.has(row.strike))found.set(row.strike,row);}};
  const wantedHigh=Math.max(...strikes),wantedLow=Math.min(...strikes);
  let frame=await settledFrame();
  // Begin around the provider's normal price-centered viewport, then scan only
  // the watched range. Wait for virtualized rows to render in background Chrome.
  for(let step=0;step<80;step++){
    requireTime(deadline);remember(frame);const shown=frame.rows.map(visibleExposureRow).filter(Boolean);
    if(found.size===wanted.size||frame.position<=0||Math.max(...shown.map(row=>row.strike))>=wantedHigh)break;
    frame=await settledFrame(Math.max(0,frame.position-Math.max(44,Math.floor(frame.height*.7))));
  }
  for(let step=0;step<80;step++){
    requireTime(deadline);remember(frame);const shown=frame.rows.map(visibleExposureRow).filter(Boolean);
    if(found.size===wanted.size||frame.position+frame.clientHeight>=frame.total-2||Math.min(...shown.map(row=>row.strike))<=wantedLow)break;
    frame=await settledFrame(frame.position+Math.max(44,Math.floor(frame.height*.7)));
  }
  await verifySelection();
  if(aggregateDisplay(await all.innerText({timeout:stepTimeout(deadline,7000)})).display!==aggregate.display)throw Error('MQ_SNAPSHOT_CHANGED');
  if(!found.size)throw Error('MQ_WATCHED_ROWS_UNAVAILABLE');
  const source={scope:'all-expiries',mode,asOf:null,sourceDate:null,sourceUrl,delayStatus,capturedAt};
  const rows=[...found.values()].sort((a,b)=>a.strike-b.strike);
  if(metric==='Net DEX')return {metric,...source,aggregateDisplay:aggregate.display,rows};
  return {regime:{...aggregate,...source},exposure:{metric,...source,rows}};
}

export async function collectMenthorq({request,state,config,window,saved,persist,deadline,plan,startedAt=Date.now(),captureOnce=false,dryRun=false}){
  const scope=config.menthorqScope;
  if(config.menthorqEnabled!==true||!['exposure-map','levels-and-exposure'].includes(scope))throw Error('MQ_EXPOSURE_SCOPE_REQUIRED');
  if(dryRun)throw Error('MQ_DRY_RUN_UNAVAILABLE');
  if(config.browserApproved!==true||config.browserPort!==PORT)throw Error('MQ_BROWSER_NOT_APPROVED');
  if(!['regular','overnight','eod'].includes(plan))return {menthorq:'skipped',menthorqCode:'provider-publication-pause'};
  const eod=plan==='eod',overnight=plan==='overnight';
  if(Date.now()-(saved.menthorqAttemptAt??0)<60000)return {menthorq:'skipped',menthorqCode:'retry-backoff'};

  const mode=eod?'EOD':'Intraday';
  const includeLevels=scope==='levels-and-exposure'&&!overnight;
  const menthorqMarkets=[];
  const selections=[];
  async function saveCapture(body,options){
    await rememberMenthorqUpload(saved,body,persist);
    // Leave slow site writes to the scheduler when the browser step is ending.
    if(options.deadline-Date.now()<26_000)throw Error('MQ_UPLOAD_QUEUED');
    try{
      const context=await saveMenthorqUpdate(request,body,{...options,deferRetries:true,writeTimeoutMs:25_000});
      clearMenthorqUpload(saved,body);
      return context;
    }catch(error){
      if(rejectedMenthorqUpload(error))clearMenthorqUpload(saved,body);
      throw error;
    }
  }
  let browser,page,stage='browser';
  const errorCode=error=>{
    if(error.message==='SITE_HTTP_409'&&error.serviceCode&&!isBusySave(error))return 'MQ_SITE_'+error.serviceCode;
    if(/^MQ_[A-Z_]+$/.test(error.message))return error.message;
    if(/^SITE_[A-Z_0-9]+$/.test(error.message))return 'MQ_'+error.message;
    if(error.name==='TimeoutError')return 'MQ_UI_TIMEOUT';
    return ['TypeError','ReferenceError'].includes(error.name)?'MQ_READER_ERROR':'MQ_BROWSER_UNAVAILABLE';
  };
  const stoppedForAccess=code=>['MQ_LOGIN_REQUIRED','MQ_ACCESS_ATTENTION'].includes(code);
  const outcome=(menthorq,menthorqCode=null,menthorqStage=null)=>{
    for(const result of menthorqMarkets){
      if(result.dexStatus==='pending')Object.assign(result,{dexStatus:'skipped',dexCode:menthorqCode??'MQ_CAPTURE_UNAVAILABLE'});
    }
    return {menthorq,menthorqCode,menthorqStage,menthorqMode:mode,menthorqMarkets};
  };
  const checkedEod=(snapshot,metric)=>{
    const checked=Date.parse(snapshot?.capturedAt??'');
    if(!eod||snapshot?.mode!=='EOD'||snapshot.metric!==metric||snapshot.scope!=='all-expiries'
      ||!snapshot.rows?.length||!Number.isFinite(checked))return false;
    const clock=nyClock(checked);
    return clock.date===window.date&&clock.minute>=MENTHORQ_EOD_START;
  };
  try{
    for(const market of ['NQ','ES','CL']){
      const row=state.markets?.[market];
      const map=row?.watchContext?.underlyingCode===row?.underlyingCode?row?.watchContext:null;
      const strikes=map?.levels?.filter(level=>level.kind!=='reference'&&Number.isFinite(level.strike)&&level.strike>0).map(level=>level.strike)??[];
      if(!row?.underlyingCode||!includeLevels&&!strikes.length){
        menthorqMarkets.push({market,status:'missing-levels',levelsStatus:includeLevels?'missing':'manual',code:'MQ_WATCHED_LEVELS_REQUIRED',
          dexStatus:'skipped',dexRows:0,dexCode:'MQ_WATCHED_LEVELS_REQUIRED'});
        continue;
      }
      const instrument=datedInstrument(market,row.underlyingCode);
      const levelsCovered=eod&&map?.mode==='EOD'&&map.sourceDate===window.date&&strikes.length>0;
      const result={market,instrument,underlyingCode:row.underlyingCode,levels:strikes.length,exposureRows:0,status:'pending',
        levelsStatus:includeLevels?(levelsCovered?'unchanged':'pending'):overnight?'reference':'manual',
        dexStatus:'pending',dexRows:0,dexCode:null,
        sourceDate:map?.sourceDate??null,sourceLocalTime:map?.sourceLocalTime??null};
      menthorqMarkets.push(result);
      const savedExposure=map?.exposure;
      if(checkedEod(savedExposure,'Net GEX')){
        Object.assign(result,{status:'already-saved',exposureRows:savedExposure.rows.length,capturedAt:savedExposure.capturedAt,delayStatus:savedExposure.delayStatus});
      }
      const savedDex=map?.netDex;
      if(checkedEod(savedDex,'Net DEX')||(!captureOnce&&plan==='regular'&&hasIntradayDexCapture(savedDex,startedAt))){
        Object.assign(result,{dexStatus:'already-saved',dexRows:savedDex.rows.length,dexCapturedAt:savedDex.capturedAt});
      }
      if(result.status==='pending'||result.levelsStatus==='pending'||result.dexStatus==='pending'){
        selections.push({market,instrument,underlyingCode:row.underlyingCode,map,strikes,result});
      }
    }
    if(!selections.length){
      if(eod&&menthorqMarkets.every(row=>row.status==='already-saved')){
        saved.menthorqEodDate=window.date;
        saved.menthorqDexEodDate=window.date;
        return outcome('unchanged','eod-already-saved');
      }
      return outcome('partial','MQ_WATCHED_LEVELS_REQUIRED','watchlist');
    }

    requireTime(deadline);
    saved.menthorqAttemptAt=Date.now();
    const {chromium}=await import('playwright');
    stage='browser-attach';
    browser=await connectCollectorBrowser(chromium,deadline);
    const context=browser.contexts()[0];
    if(!context)throw Error('MQ_BROWSER_UNAVAILABLE');
    stage='browser-new-tab';
    page=await context.newPage();
    await page.setViewportSize({width:1440,height:900});
    page.setDefaultTimeout(12000);

    let failure=null,failureStage=null;
    const levelSelections=selections.filter(selection=>selection.result.levelsStatus==='pending');
    if(levelSelections.length){
      stage='levels';
      const levelsDeadline=Math.min(deadline,Date.now()+45000);
      const markLevelFailure=(result,code)=>{
        result.levelsStatus=result.levels?'retained':'failed';
        result.levelsCode=code;
        failure=code;failureStage=stage;
      };
      try{
        await openLevels(page,{mode,deadline:levelsDeadline});
        for(const selection of levelSelections){
          const {market,instrument,underlyingCode,map,result}=selection;
          stage='levels';
          try{
            const input=await readLevels(page,{instrument,deadline:Math.min(levelsDeadline,Date.now()+10000)});
            result.observedLevelsDate=input.sourceDate;
            result.observedLevelsLocalTime=input.sourceLocalTime;
            result.observedLevelsAt=new Date().toISOString();
            if(input.sourceDate!==window.date)throw Error('MQ_NEW_PUBLICATION_UNAVAILABLE');
            const proposed=parseMenthorqExport({market,underlyingCode,...input,mode});
            const levels=rows=>JSON.stringify(rows.map(row=>[row.strike,row.labels]));
            if(isOlderMap(map,proposed)||map?.mode===mode&&map.sourceDate===proposed.sourceDate
              &&map.sourceLocalTime===proposed.sourceLocalTime&&levels(map.levels)===levels(proposed.levels)){
              result.levelsStatus='unchanged';
              result.levelsCheckedAt=new Date().toISOString();
              continue;
            }
            stage='save-levels-'+market;
            const actual=await saveCapture({market,underlyingCode,...input,mode,observedAt:result.observedLevelsAt},{
              deadline:levelsDeadline,unverified:'MQ_LEVELS_SAVE_NOT_VERIFIED',
              verify:context=>context.mode===mode&&context.sourceDate===proposed.sourceDate
                &&context.sourceLocalTime===proposed.sourceLocalTime&&levels(context.levels??[])===levels(proposed.levels),
            });
            const updatedStrikes=actual.levels.filter(level=>level.kind!=='reference').map(level=>level.strike);
            if(updatedStrikes.length!==selection.strikes.length||updatedStrikes.some((strike,index)=>strike!==selection.strikes[index])){
              if(result.status==='already-saved')result.status='pending';
              if(result.dexStatus==='already-saved')result.dexStatus='pending';
            }
            selection.strikes=updatedStrikes;
            Object.assign(result,{levelsStatus:'saved',levels:selection.strikes.length,sourceDate:actual.sourceDate,
              sourceLocalTime:actual.sourceLocalTime,levelsCheckedAt:actual.lastCheckedAt??actual.capturedAt});
          }catch(error){
            try{await ready(page);}catch(attention){error=attention;}
            const code=errorCode(error);
            markLevelFailure(result,code);
            if(stoppedForAccess(code))return outcome('blocked',code,stage);
          }
        }
      }catch(error){
        try{await ready(page);}catch(attention){error=attention;}
        const code=errorCode(error);
        for(const {result} of levelSelections)markLevelFailure(result,code);
        if(stoppedForAccess(code))return outcome('blocked',code,stage);
      }
    }
    // Give a market that lost its DEX time allowance the first opportunity next time.
    const previouslyDeferred=saved.menthorqMarkets?.find(row=>row.dexStatus==='deferred'||row.dexCode==='MQ_TIME_BUDGET');
    if(previouslyDeferred){
      const position=selections.findIndex(selection=>selection.market===previouslyDeferred.market);
      if(position>0)selections.unshift(...selections.splice(position,1));
    }
    for(const [index,{market,instrument,underlyingCode,strikes,map,result}] of selections.entries()){
      if(result.status==='skipped'&&result.dexStatus!=='pending')continue;
      if(result.status==='already-saved'&&result.dexStatus==='already-saved')continue;
      if(!strikes.length){
        Object.assign(result,{status:'missing-levels',code:'MQ_WATCHED_LEVELS_REQUIRED',
          dexStatus:'skipped',dexCode:'MQ_WATCHED_LEVELS_REQUIRED'});
        continue;
      }
      // Reserve time for later markets even if this browser page stalls.
      const remainingGex=selections.slice(index+1).filter(selection=>selection.result.status==='pending').length;
      const laterMarketsDeadline=deadline-remainingGex*23_000;
      const marketDeadline=Math.min(laterMarketsDeadline,Date.now()+35_000);
      stage='exposure-'+market;
      try{
        await navigate(page,`${ORIGIN}/en/options/exposure?symbol=${encodeURIComponent(instrument)}`,stepTimeout(marketDeadline,15000));
        checkExposurePage(page,instrument);
      }catch(error){
        try{await ready(page);}catch(attention){error=attention;}
        const code=errorCode(error);
        if(result.status==='pending'){
          Object.assign(result,{status:'failed',code});
          failure=code;failureStage=stage;
        }
        if(result.dexStatus==='pending')Object.assign(result,{dexStatus:'failed',dexCode:code});
        if(stoppedForAccess(code)||Date.now()>=deadline-3000)break;
        continue;
      }
      if(result.status==='pending'){
        try{
          const exposureUpdate=await readExposure(page,{instrument,strikes,mode,metric:'Net GEX',deadline:marketDeadline});
          const unchanged=overnight&&map?.regime?.display===exposureUpdate.regime.display&&sameExposureSnapshot(map?.exposure,exposureUpdate.exposure);
          const accept=({exposure},status='saved')=>Object.assign(result,{status,code:null,capturedAt:exposure.capturedAt,exposureRows:exposure.rows.length,
            missingExposureRows:strikes.length-exposure.rows.length,delayStatus:exposure.delayStatus});
          if(unchanged)accept({exposure:map.exposure},'unchanged');
          else {
            stage='save-exposure-'+market;
            accept(await saveCapture({market,underlyingCode,exposureUpdate},{
              deadline:marketDeadline,unverified:'MQ_SAVE_NOT_VERIFIED',
              verify:({exposure})=>exposure?.capturedAt===exposureUpdate.exposure.capturedAt&&exposure.mode===mode
                &&exposure.metric==='Net GEX'&&!!exposure.rows?.length,
            }));
          }
        }catch(error){
          try{await ready(page);}catch(attention){error=attention;}
          const code=errorCode(error);
          Object.assign(result,{status:'failed',code});
          failure=code;failureStage=stage;
          if(stoppedForAccess(code)||Date.now()>=deadline-3000){
            if(result.dexStatus==='pending')Object.assign(result,{dexStatus:'skipped',dexCode:code});
            break;
          }
        }
      }
      if(result.dexStatus!=='pending')continue;
      // Reserve time for the existing GEX readings on remaining markets.
      const dexDeadline=Math.min(laterMarketsDeadline,Date.now()+17000);
      if(dexDeadline-Date.now()<6500){
        Object.assign(result,{dexStatus:'deferred',dexCode:'MQ_TIME_BUDGET'});
        continue;
      }
      stage='net-dex-'+market;
      try{
        const netDexUpdate=await readExposure(page,{instrument,strikes,mode,metric:'Net DEX',deadline:dexDeadline});
        const unchanged=overnight&&sameExposureSnapshot(map?.netDex,netDexUpdate);
        const accept=({netDex},dexStatus='saved')=>Object.assign(result,{dexStatus,dexCode:null,dexRows:netDex.rows.length,dexCapturedAt:netDex.capturedAt});
        if(unchanged)accept({netDex:map.netDex},'unchanged');
        else {
          stage='save-net-dex-'+market;
          accept(await saveCapture({market,underlyingCode,netDexUpdate},{
            deadline:laterMarketsDeadline,unverified:'MQ_DEX_SAVE_NOT_VERIFIED',
            verify:({netDex})=>netDex?.capturedAt===netDexUpdate.capturedAt&&netDex.mode===mode
              &&netDex.metric==='Net DEX'&&!!netDex.rows?.length,
          }));
        }
      }catch(error){
        try{await ready(page);}catch(attention){error=attention;}
        let code=errorCode(error);
        if(code==='MQ_UI_TIMEOUT'){
          if(stage.startsWith('save-net-dex-'))code='MQ_DEX_SAVE_TIMEOUT';
          else if(Date.now()>=dexDeadline-3000)code='MQ_TIME_BUDGET';
        }
        Object.assign(result,{dexStatus:code==='MQ_TIME_BUDGET'?'deferred':'failed',dexCode:code});
        if(!failure||stoppedForAccess(code)){failure=code;failureStage=stage;}
        if(stoppedForAccess(code)){
          break;
        }
      }
    }
    const successfulRead=status=>['saved','already-saved','unchanged'].includes(status);
    if(eod&&menthorqMarkets.every(row=>successfulRead(row.dexStatus)))saved.menthorqDexEodDate=window.date;
    const gexAndLevelsComplete=menthorqMarkets.every(row=>successfulRead(row.status)
      &&(!includeLevels||['saved','unchanged'].includes(row.levelsStatus)));
    if(eod&&gexAndLevelsComplete)saved.menthorqEodDate=window.date;
    const incompleteDex=menthorqMarkets.find(row=>!successfulRead(row.dexStatus));
    if(gexAndLevelsComplete&&!incompleteDex){
      saved.menthorqLastCompletedAt=new Date().toISOString();
      return outcome(menthorqMarkets.some(row=>[row.status,row.levelsStatus,row.dexStatus].includes('saved'))?'updated':'unchanged');
    }
    if(gexAndLevelsComplete&&incompleteDex){
      return outcome('partial',failure??incompleteDex.dexCode??'MQ_CAPTURE_UNAVAILABLE',failureStage??'net-dex-'+incompleteDex.market);
    }
    return outcome(menthorqMarkets.some(row=>successfulRead(row.status)||row.status==='missing-levels')?'partial':'blocked',
      failure??'MQ_WATCHED_LEVELS_REQUIRED',failureStage??'watchlist');
  }catch(error){
    return outcome('blocked',errorCode(error),stage);
  }finally{
    await page?.close().catch(()=>{});
    await browser?.close().catch(()=>{});
  }
}
