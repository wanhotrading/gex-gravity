import test from 'node:test';
import assert from 'node:assert/strict';
import {menthorqNeedsAccessAttention,recordMenthorqResult,shouldNotify} from '../collector/recovery.mjs';
import {checkMenthorqAlert} from '../collector/menthorq-alert.mjs';
import {menthorqFeedHealth} from '../core/market-reading.mjs';

test('a late crude publication does not mark today’s saved index Levels as pending',()=>{
  const now=Date.parse('2026-11-18T15:50:00Z');
  const collector={
    menthorqScope:'levels-and-exposure',menthorq:'partial',menthorqStage:'levels',
    menthorqCode:'MQ_NEW_PUBLICATION_UNAVAILABLE',
    menthorqMarkets:[{underlyingCode:'US.CL2612',observedLevelsAt:'2026-11-18T15:49:00Z',observedLevelsDate:'2026-11-17'}],
  };
  const market=(underlyingCode,sourceDate)=>({
    underlyingCode,watchContext:{underlyingCode,sourceDate,levels:[{strike:100}],
      exposure:{collection:'exposure-map',capturedAt:'2026-11-18T15:49:00Z',rows:[{strike:100}]}},
  });
  assert.equal(menthorqFeedHealth(collector,market('US.NQ2612','2026-11-18'),now).warning,false);
  assert.equal(menthorqFeedHealth(collector,market('US.ES2612','2026-11-18'),now).warning,false);
  assert.equal(menthorqFeedHealth(collector,market('US.CL2612','2026-11-17'),now).label,'MenthorQ Levels pending');
});
const now=Date.parse('2026-11-17T15:00:00Z');
const window={menthorqIntraday:true,date:'2026-11-17',minute:600};
const market={underlyingCode:'US.NQ2612',watchContext:{underlyingCode:'US.NQ2612',levels:[{strike:27000}],mode:'Intraday',sourceDate:'2026-11-13',capturedAt:'2026-11-13T15:00:00Z'}};
test('only provider access trouble imposes a delay across slots',()=>{
  const saved={menthorqRetryAt:now+30*60000};
  recordMenthorqResult(saved,{menthorq:'blocked',menthorqCode:'MQ_UI_TIMEOUT'},now);
  assert.equal(saved.menthorqRetryAt,null);
  recordMenthorqResult(saved,{menthorq:'blocked',menthorqCode:'MQ_LOGIN_REQUIRED'},now);assert.equal(saved.menthorqRetryAt,now+30*60000);
  recordMenthorqResult(saved,{menthorq:'updated'},now);assert.equal(saved.menthorqRetryAt,null);
});
test('Levels timeouts retain the partial result and a DEX access challenge still pauses capture',()=>{
  const menthorqMarkets=['NQ','ES','CL'].map(market=>({market,status:'saved',dexStatus:'saved'}));
  const partial={menthorq:'partial',menthorqCode:'MQ_LEVELS_EXPORT_TIMEOUT',menthorqStage:'levels',menthorqMarkets};
  const saved={menthorqRetryAt:now+30*60000};
  recordMenthorqResult(saved,partial,now);
  assert.equal(saved.menthorqRetryAt,null);
  assert.equal(saved.menthorqLastResult.menthorq,'partial');
  assert.equal(menthorqNeedsAccessAttention(saved.menthorqLastResult,menthorqMarkets),false);
  menthorqMarkets[2].dexCode='MQ_ACCESS_ATTENTION';
  recordMenthorqResult(saved,partial,now);
  assert.equal(saved.menthorqRetryAt,now+30*60000);
});
test('an older intraday Levels publication alone does not trigger a Windows alert when Exposure saved',()=>{
  const menthorqMarkets=['NQ','ES','CL'].map(market=>({market,status:'saved',dexStatus:'skipped',dexCode:'MQ_DEX_NOT_DUE'}));
  const result={menthorq:'partial',menthorqCode:'MQ_NEW_PUBLICATION_UNAVAILABLE',menthorqMarkets};
  const args={state:{},window,now,automatic:true,result};
  assert.equal(checkMenthorqAlert(args),null);
  menthorqMarkets[0].dexStatus='already-saved';
  menthorqMarkets[0].dexCode=null;
  assert.equal(checkMenthorqAlert(args),null);
  menthorqMarkets[2].status='failed';
  assert.ok(checkMenthorqAlert(args));
});
test('login failure alerts even when a recent map exists and throttles repeated notifications',()=>{
  const alert=checkMenthorqAlert({state:{},window,now,automatic:true,result:{menthorq:'blocked',menthorqCode:'MQ_LOGIN_REQUIRED'}});
  assert.match(alert.title,/Sign in/);const saved={menthorqAlert:alert.key,menthorqAlertAt:now};
  assert.equal(shouldNotify(saved,alert,now+60000),false);assert.equal(shouldNotify(saved,alert,now+30*60000),true);
});
test('manual-import pause alerts and is never represented as a working MenthorQ feed',()=>{
  const state={markets:{NQ:market}},collector={enabled:true,status:'running',menthorq:'skipped',menthorqCode:'manual-import'};
  assert.match(checkMenthorqAlert({state,window,now,automatic:false}).body,/collection is paused/);
  assert.deepEqual(menthorqFeedHealth(collector,market,now).warning,true);
  assert.match(menthorqFeedHealth(collector,market,now).message,/2026-11-13/);
  assert.match(menthorqFeedHealth({...collector,menthorqCode:null},market,now).label,/outdated/);
});
test('a current-day manual capture ages out and stale maps remain warned outside update hours',()=>{
  const m={...market,watchContext:{...market.watchContext,sourceDate:window.date,capturedAt:new Date(now-20*60000).toISOString()}};
  const state={markets:Object.fromEntries(['NQ','ES','CL'].map(k=>[k,m]))};
  assert.ok(checkMenthorqAlert({state,window,now,automatic:false}));
  assert.equal(menthorqFeedHealth({},market,now+8*3600000).warning,true);
});

test('intraday write conflicts use saved metric ages and stay quiet after a brief recovery',()=>{
  const checked=new Date(now-3*60000).toISOString();
  const snapshot={scope:'all-expiries',mode:'Intraday',rows:[{strike:100}],capturedAt:checked};
  const markets=Object.fromEntries(['NQ','ES','CL'].map(m=>[m,{underlyingCode:m,watchContext:{
    underlyingCode:m,mode:'Intraday',sourceDate:window.date,levels:[{strike:100}],lastCheckedAt:checked,
    exposure:{...snapshot,metric:'Net GEX'},netDex:{...snapshot,metric:'Net DEX'},
  }}]));
  const result={menthorq:'partial',menthorqCode:'MQ_SITE_HTTP_409',menthorqScope:'levels-and-exposure',
    menthorqMarkets:[{market:'ES',code:'MQ_SITE_HTTP_409'}]};
  const args={state:{markets},result,automatic:true,now,window};
  assert.equal(checkMenthorqAlert(args),null);
  markets.ES.watchContext.netDex.capturedAt=new Date(now-31*60000).toISOString();
  const overdue=checkMenthorqAlert(args);
  assert.match(overdue.body,/Net DEX \(ES\)/);
  assert.doesNotMatch(overdue.body,/Net GEX/);
  const saved={menthorqAlert:null,menthorqConflictAlertAt:now};
  assert.equal(shouldNotify(saved,overdue,now+5*60000),false);
  assert.equal(shouldNotify(saved,overdue,now+30*60000),true);
  result.menthorqMarkets[0].dexCode='MQ_LOGIN_REQUIRED';
  assert.match(checkMenthorqAlert(args).title,/Sign in/);
  const eod=checkMenthorqAlert({...args,window:{...window,menthorqIntraday:false,menthorqEod:true},
    result:{...result,menthorqMarkets:[]}});
  assert.match(eod.body,/MQ_SITE_HTTP_409/);
});
