import test from 'node:test';
import assert from 'node:assert/strict';
import {SESSION_WINDOWS,normalizeHistoryBars,mergeHistoryBars,newYorkBarTime,inferHistoryBarConvention,inferHistoryVolumeUnit,buildSessionHistory} from './session-history.mjs';
function bar(timestamp,i=0){const open=20000+i,close=open+1;return {timestamp,open,close,high:close+1,low:open-1,volume:100,turnover:(open+.5)*100*20};}
function session(date,offset='-05:00'){const start=Date.parse(date+'T09:30:00'+offset);return Array.from({length:78},(_,i)=>bar(start+i*300000,i));}
test('NY windows cover cash session once, including the explicit 10:30 gap',()=>{
  assert.equal(SESSION_WINDOWS[0].startMinute,570);assert.equal(SESSION_WINDOWS.at(-1).endMinute,960);
  assert.equal(SESSION_WINDOWS.reduce((sum,row)=>sum+row.durationMinutes,0),390);
  SESSION_WINDOWS.slice(1).forEach((row,i)=>assert.equal(row.startMinute,SESSION_WINDOWS[i].endMinute));
});
test('epoch time, not trading-date/offset labels, assigns DST-aware NY windows',()=>{
  assert.equal(newYorkBarTime(Date.parse('2026-10-30T13:30:00Z')).minute,570);
  assert.equal(newYorkBarTime(Date.parse('2026-11-03T14:30:00Z')).minute,570);
  const raw={...bar(Date.parse('2026-11-03T14:30:00Z')),time_key:Date.parse('2026-11-03T14:30:00Z'),volume:10000,date:20261104,time_zone:480};
  const [row]=normalizeHistoryBars([raw],{volumePrecision:2,now:Date.parse('2026-11-04')});assert.equal(row.volume,100);
});
test('completed full windows only: today and missing five-minute cells excluded',()=>{
  const rows=[...session('2026-11-02'),...session('2026-11-03'),...session('2026-11-04')];
  rows.splice(rows.findIndex(row=>row.timestamp===Date.parse('2026-11-03T14:35:00Z')),1);
  const profile=buildSessionHistory({market:'NQ',underlyingCode:'US.NQ2612',bars:rows,now:Date.parse('2026-11-04T21:30:00Z'),pointValue:20,barConvention:'start'});
  assert.equal(profile.windows[0].sampleCount,1);assert.equal(profile.windows[0].medianVolumeContracts,600);assert.equal(profile.windows[1].sampleCount,2);
  assert.equal(profile.windows[0].medianVolatilityPoints,Math.sqrt(6));assert.equal(profile.windows[0].medianAbsMovePoints,6);assert.equal(profile.windows.at(-1).medianVolumeContracts,200);
});
test('end-stamped windows shift once and never include the following interval',()=>{
  const rows=session('2026-11-03').map(row=>({...row,timestamp:row.timestamp+300000}));
  const p=buildSessionHistory({market:'NQ',underlyingCode:'US.NQ2612',bars:rows,now:Date.parse('2026-11-04T22:00:00Z'),pointValue:20,barConvention:'end'});
  assert.equal(p.windows[0].sampleCount,1);assert.equal(p.windows[0].medianAbsMovePoints,6);assert.equal(p.windows.at(-1).medianVolumeContracts,200);
});
test('clock convention requires corroborating pause evidence, never a silent default',()=>{
  const rows=['2026-11-02','2026-11-03'].flatMap(date=>[bar(Date.parse(date+'T16:55:00-05:00')),bar(Date.parse(date+'T18:00:00-05:00'))]);
  assert.equal(inferHistoryBarConvention(rows).convention,'start');assert.equal(inferHistoryBarConvention(rows.slice(0,2)).convention,'unverified');
  const p=buildSessionHistory({market:'NQ',underlyingCode:'US.NQ2612',bars:session('2026-11-03'),now:Date.parse('2026-11-04'),pointValue:20});assert.equal(p.status,'unverified-bar-time');assert.equal(p.windows[0].sampleCount,0);
});
test('volume contracts require dimensional corroboration; unknown units stay unavailable',()=>{
  const rows=session('2026-11-03');assert.equal(inferHistoryVolumeUnit(rows,20).unit,'contracts');assert.equal(inferHistoryVolumeUnit(rows,50).unit,'unverified');
  const p=buildSessionHistory({market:'NQ',underlyingCode:'US.NQ2612',bars:rows.map(row=>({...row,turnover:null})),now:Date.parse('2026-11-04T22:00:00Z'),pointValue:20,barConvention:'start'});
  assert.equal(p.volumeUnit,'unverified');assert.equal(p.windows[0].medianVolumeContracts,null);assert.equal(p.windows[0].medianReportedVolume,600);assert.equal(p.windows[0].sampleCount,1);
});
test('malformed or conflicting bars, continuous and mismatched futures are rejected',()=>{
  assert.throws(()=>normalizeHistoryBars([{time_key:Date.parse('2026-11-03T14:30:00Z'),open:2,close:3,high:1,low:1,volume:0}]));
  const row=bar(Date.parse('2026-11-03T14:30:00Z'));assert.equal(mergeHistoryBars([row],[row]).length,1);assert.throws(()=>mergeHistoryBars([row],[{...row,close:1}]));
  assert.throws(()=>buildSessionHistory({market:'NQ',underlyingCode:'US.NQmain',bars:[]}));
});
