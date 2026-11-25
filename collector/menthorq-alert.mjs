import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nyClock} from '../core/market-reading.mjs';
import {MENTHORQ_INTRADAY_START,MENTHORQ_EOD_START,MENTHORQ_CHECK_MAX_AGE_MINUTES} from '../core/trading-sessions.mjs';

const run=promisify(execFile);
const markets=['NQ','ES','CL'];
const minutes=60000;

/** Check the private site's saved state. This never queries MenthorQ. */
export function checkMenthorqAlert({state,window,now,automatic,result}){
  const mode=window.menthorqIntraday?'Intraday':window.menthorqEod?'EOD':null;
  const levelsAutomatic=result?.menthorqScope==='levels-and-exposure';
  const automaticMaxAge=MENTHORQ_CHECK_MAX_AGE_MINUTES*minutes;
  const feed=levelsAutomatic?'MenthorQ':'MenthorQ Exposure Map';
  if(!mode||['Sat','Sun'].includes(window.weekday))return null;
  if(automatic&&mode==='Intraday'&&result?.menthorqCode==='MQ_NEW_PUBLICATION_UNAVAILABLE'
    &&markets.every(market=>result.menthorqMarkets?.some(row=>row.market===market
      &&row.status==='saved'&&(['saved','already-saved'].includes(row.dexStatus)||row.dexCode==='MQ_DEX_NOT_DUE'))))return null;
  const failures=(result?.menthorqMarkets??[]).flatMap(row=>[row.code,row.levelsCode,row.dexCode]).filter(code=>code&&code!=='MQ_DEX_NOT_DUE');
  const conflictCode='MQ_SITE_HTTP_409';
  const recoverableConflict=automatic&&mode==='Intraday'&&result?.menthorqCode===conflictCode
    &&failures.every(code=>code===conflictCode);
  if(automatic&&!recoverableConflict&&['blocked','partial','auth-required','error'].includes(result?.menthorq)){
    const code=failures.find(code=>['MQ_LOGIN_REQUIRED','MQ_ACCESS_ATTENTION'].includes(code))
      ??(result.menthorqCode===conflictCode?failures.find(code=>code!==conflictCode):null)??result.menthorqCode;
    const login=code==='MQ_LOGIN_REQUIRED';
    const missingLevels=code==='MQ_WATCHED_LEVELS_REQUIRED';
    return {key:window.date+'|'+mode+'|'+(code??'failed'),
      title:login?'GEX Gravity · Sign in to MenthorQ':'GEX Gravity · '+feed+' update incomplete',
      body:login?'The MenthorQ session expired. Sign in to the dedicated Chrome window. Automatic recovery checks are slowed to 30 minutes.':
        code==='MQ_BROWSER_ATTACH_TIMEOUT'?'The collector could not connect to its dedicated Chrome window after retrying. Open that window and check whether the MenthorQ tabs respond. The collector will try again on schedule.':
        missingLevels?'Import the Levels export for the matching futures contract in GEX Gravity. Exposure collection needs saved watched strikes.':
        'The '+feed+' update did not complete ('+(code??'unavailable')+'). Open GEX Gravity to check the separately saved Levels and Exposure observations.'};
  }
  // Allow the first intraday collection slot time to finish.
  if(mode==='Intraday'&&automatic&&window.minute<MENTHORQ_INTRADAY_START+10)return null;
  const missing=markets.filter(market=>{
    const row=state.markets?.[market],map=row?.watchContext;
    if(automatic){
      const exposure=map?.exposure;
      const checked=Date.parse(exposure?.capturedAt??'');
      if(!row?.underlyingCode||map?.underlyingCode!==row.underlyingCode||exposure?.metric!=='Net GEX'
        ||exposure.scope!=='all-expiries'||exposure.mode!==mode||!exposure.rows?.length
        ||!Number.isFinite(checked)||checked>now+minutes)return true;
      const clock=nyClock(checked);
      return clock.date!==window.date||(mode==='Intraday'?now-checked>automaticMaxAge:clock.minute<MENTHORQ_EOD_START);
    }
    if(!map?.levels?.length||map.underlyingCode!==row.underlyingCode||map.sourceDate!==window.date||map.mode!==mode)return true;
    if(mode!=='Intraday')return false;
    const checked=Date.parse(map.lastCheckedAt??map.capturedAt??'');
    return !Number.isFinite(checked)||now-checked>15*minutes;
  });
  const missingLevels=levelsAutomatic?markets.filter(market=>{
    const row=state.markets?.[market],map=row?.watchContext;
    if(!map?.levels?.length||map.underlyingCode!==row.underlyingCode||map.sourceDate!==window.date||map.mode!==mode)return true;
    if(mode==='EOD')return false;
    const observation=result?.menthorqMarkets?.find(item=>item.market===market);
    const lastObserved=observation?.sourceDate===map.sourceDate&&observation?.sourceLocalTime===(map.sourceLocalTime??null)
      ?observation.levelsCheckedAt:null;
    const checked=Date.parse(lastObserved??map.lastCheckedAt??map.capturedAt??'');
    return !Number.isFinite(checked)||checked>now+minutes||now-checked>(automatic?automaticMaxAge:15*minutes);
  }):[];
  if(recoverableConflict){
    const missingDex=markets.filter(market=>{
      const row=state.markets?.[market],map=row?.watchContext,dex=map?.netDex;
      const checked=Date.parse(dex?.capturedAt??'');
      return !row?.underlyingCode||map?.underlyingCode!==row.underlyingCode||dex?.metric!=='Net DEX'
        ||dex.scope!=='all-expiries'||dex.mode!==mode||!dex.rows?.length||!Number.isFinite(checked)
        ||checked>now+minutes||nyClock(checked).date!==window.date||now-checked>30*minutes;
    });
    const overdue=[['Levels',missingLevels],['Net GEX',missing],['Net DEX',missingDex]]
      .filter(([,names])=>names.length).map(([metric,names])=>metric+' ('+names.join(', ')+')');
    if(!overdue.length)return null;
    return {key:window.date+'|'+mode+'|save-conflict-overdue',
      title:'GEX Gravity · MenthorQ data overdue',
      body:'GEX Gravity could not save a recent update for '+overdue.join(', ')+'. The collector will retry on schedule.'};
  }
  if(missingLevels.length&&!missing.length)return {
    key:window.date+'|'+mode+'|levels',
    title:'GEX Gravity · MenthorQ '+mode+' Levels check overdue',
    body:missingLevels.join(', ')+' still need a recent Levels check. Open GEX Gravity to see the last saved Levels and Exposure observations.'
  };
  if(!missing.length)return null;
  const time=mode==='Intraday'?'9:30 a.m.':'11:30 p.m.';
  return {
    key:window.date+'|'+mode+(automatic?'|exposure':''),
    title:automatic?'GEX Gravity · MenthorQ '+mode+' Exposure Map check overdue':'GEX Gravity · MenthorQ '+mode+' levels overdue',
    body:automatic
      ? missing.join(', ')+' still need a recent Exposure Map check. Open GEX Gravity to check the last saved observation.'+(levelsAutomatic?'':' Levels are imported separately.')
      : 'Automatic MenthorQ collection is paused. '+missing.join(', ')+' need a current '+mode+' export for '+window.date+'. Open GEX Gravity → Data & settings to import it. Scheduled window starts after '+time+' New York time.'
  };
}

/** Notify the same Windows account as the collector. The sender window stays hidden. */
export async function showMenthorqAlert({title,body}){
  const user=process.env.USERNAME;
  if(!user||user==='*'||/[\r\n]/.test(user))throw Error('Windows notification recipient unavailable');
  await run('msg.exe',[user,'/time:60',title+'\n\n'+body],{windowsHide:true,timeout:12000});
}
