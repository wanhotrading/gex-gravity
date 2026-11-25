import test from 'node:test';
import assert from 'node:assert/strict';
import {futuresCollectionWindow,comparisonWindows,localSessionTime,buildSessionComparison} from './trading-sessions.mjs';
const ny=(date,hour,minute=0)=>localSessionTime(date,hour*60+minute,'America/New_York');
test('collection follows New York weekdays, maintenance and provider publication windows',()=>{
  const closedSlots = [[0,0],[9,30],[16,0],[17,59]];
  for(const [saturday,sunday] of [['2026-07-11','2026-07-12'],['2026-11-14','2026-11-15']]) {
    for(const [hour,minute] of [...closedSlots,[18,0],[23,30],[23,59]]) {
      const slot=futuresCollectionWindow(ny(saturday,hour,minute));
      assert.equal(slot.reason,'weekend');
      assert.equal(slot.weekend,true);
      assert.deepEqual([slot.open,slot.menthorqIntraday,slot.menthorqDexSlot,slot.menthorqEodSlot],[false,false,false,false]);
    }
    for(const [hour,minute] of closedSlots) {
      const slot=futuresCollectionWindow(ny(sunday,hour,minute));
      assert.equal(slot.reason,'weekend');
      assert.equal(slot.weekend,true);
      assert.deepEqual([slot.open,slot.menthorqIntraday,slot.menthorqDexSlot,slot.menthorqEodSlot],[false,false,false,false]);
    }
    const reopened=futuresCollectionWindow(ny(sunday,18));
    assert.equal(reopened.open,true);
    assert.equal(reopened.weekend,false);
    assert.equal(reopened.menthorqIntraday,false);
    assert.equal(reopened.menthorqEod,false);
  }
  for(const date of ['2026-07-13','2026-11-09']){
    assert.equal(futuresCollectionWindow(ny(date,0)).open,true);
    assert.equal(futuresCollectionWindow(ny(date,9,29)).menthorqIntraday,false);
    assert.equal(futuresCollectionWindow(ny(date,9,30)).menthorqIntraday,true);
    assert.equal(futuresCollectionWindow(ny(date,9,30)).menthorqDexSlot,true);
    assert.equal(futuresCollectionWindow(ny(date,9,34)).menthorqDexSlot,true);
    assert.equal(futuresCollectionWindow(ny(date,9,35)).menthorqDexSlot,false);
    assert.equal(futuresCollectionWindow(ny(date,9,40)).menthorqDexSlot,false);
    assert.equal(futuresCollectionWindow(ny(date,9,45)).menthorqDexSlot,true);
    assert.equal(futuresCollectionWindow(ny(date,16)).menthorqIntraday,true);
    assert.equal(futuresCollectionWindow(ny(date,16)).menthorqDexSlot,true);
    assert.equal(futuresCollectionWindow(ny(date,16,1)).menthorqIntraday,false);
    assert.equal(futuresCollectionWindow(ny(date,16,1)).menthorqDexSlot,false);
    assert.equal(futuresCollectionWindow(ny(date,23,15)).menthorqEodSlot,false);
    assert.equal(futuresCollectionWindow(ny(date,23,29)).menthorqEod,false);
    assert.equal(futuresCollectionWindow(ny(date,23,30)).menthorqEodSlot,true);
    assert.equal(futuresCollectionWindow(ny(date,23,34)).menthorqEodSlot,true);
    assert.equal(futuresCollectionWindow(ny(date,23,35)).menthorqEodSlot,false);
    assert.equal(futuresCollectionWindow(ny(date,23,45)).menthorqEodSlot,false);
    assert.equal(futuresCollectionWindow(ny(date,23,45)).menthorqEod,true);
  }
  assert.equal(futuresCollectionWindow(ny('2026-11-09',16,59)).open,true);
  assert.equal(futuresCollectionWindow(ny('2026-11-09',17)).reason,'daily-maintenance');
  assert.equal(futuresCollectionWindow(ny('2026-11-13',17)).reason,'weekend');
  const fridayEod=futuresCollectionWindow(ny('2026-11-13',23,30));assert.equal(fridayEod.open,false);assert.equal(fridayEod.menthorqEodSlot,true);
});
test('London and New York daylight-saving mismatch weeks produce contiguous UTC boundaries',()=>{
  for(const [date,europeMinutes,nyOpenUTC]of [['2026-03-06',330,'14:30'],['2026-03-09',270,'13:30'],['2026-03-30',330,'13:30'],['2026-10-26',270,'13:30'],['2026-11-02',330,'14:30']]){
    const windows=comparisonWindows(date);assert.equal(windows[1].durationMinutes,europeMinutes,date);
    assert.equal(new Date(windows[3].start).toISOString().slice(11,16),nyOpenUTC,date);
    for(let i=1;i<windows.length;i++)assert.equal(windows[i-1].end,windows[i].start);
    assert.equal(windows.reduce((s,w)=>s+w.durationMinutes,0),1380);
  }
});
function fixture({count=12,convention='end'}={}){
  const bars=[];let date='2026-10-01',added=0;
  while(added<count){const weekday=new Date(date+'T12:00:00Z').getUTCDay();if(weekday>0&&weekday<6){
    for(const window of comparisonWindows(date))for(let t=window.start;t<window.end;t+=300000){const index=(t-window.start)/300000;bars.push({timestamp:t+(convention==='end'?300000:0),open:100+index,close:101+index,high:102+index,low:99+index,volume:window.id==='regular'?1000:window.id==='asia'?100:500});}added++;
  }date=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);}
  return bars;
}
test('complete windows compare equal quantities per five minutes, with source-unit and sample gates',()=>{
  const bars=fixture(),args={underlyingCode:'US.NQ2612',bars,barConvention:'end',volumeUnit:'contracts',now:Date.parse('2026-11-10T12:00:00Z')};
  const result=buildSessionComparison(args);assert.deepEqual(result.windows.map(w=>w.sampleCount),[12,12,12,12,12]);
  assert.equal(result.windows[0].sameQuantityParticipationVsNY,10);assert.equal(result.windows[2].sameQuantityParticipationVsNY,2);
  assert.equal(result.windows[0].medianFiveMinuteVolatility,1);assert.equal(result.windows[0].medianFiveMinuteVolume,100);
  const unknown=buildSessionComparison({...args,volumeUnit:'unverified'});assert.ok(unknown.windows.every(w=>w.medianFiveMinuteVolume===null&&w.sameQuantityParticipationVsNY===null));
  const small=buildSessionComparison({...args,bars:fixture({count:9})});assert.ok(small.windows.every(w=>w.sameQuantityParticipationVsNY===null));
  assert.ok(buildSessionComparison({...args,barConvention:'unverified'}).windows.every(w=>w.sampleCount===0));
});
test('missing bars and an unfinished window cannot enter the overnight sample',()=>{
  const date='2026-10-01',windows=comparisonWindows(date),bars=fixture({count:1,convention:'start'});
  bars.splice(bars.findIndex(b=>b.timestamp===windows[0].start),1);
  const result=buildSessionComparison({underlyingCode:'US.CL2612',bars,barConvention:'start',volumeUnit:'contracts',now:windows[3].start+300000});
  assert.deepEqual(result.windows.map(w=>w.sampleCount),[0,1,1,0,0]);
});
