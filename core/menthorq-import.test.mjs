import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMenthorqExport} from './menthorq-import.mjs';
import {validateWatchContext} from '../src/watch-context.mjs';
const NOW=Date.parse('2026-11-04T18:00:00Z');
const text='$CLZ2026: Call Resistance, 76, Put Support, 69\n\n$NQZ2026: Call Resistance, 25000, Put Support, 24000, HVL, 24500, 1D Min, 24123.45, 1D Max, 24987.65, Call Resistance 0DTE, 25000, Gamma Wall 0DTE, 25000, GEX 1, 24600, GEX 2, 24400\n\n$ESZ2026: GEX 1, 6500';
const args={market:'NQ',underlyingCode:'US.NQ2612',exportText:text,sourceDate:'2026-11-04',sourceLocalTime:'04:20',mode:'Intraday'};

test('provider text selects only the exact dated future and merges duplicate-strike labels',()=>{
  const context=parseMenthorqExport(args,NOW);
  assert.equal(context.sourceInstrument,'NQZ2026');assert.equal(context.levels.length,7);
  assert.deepEqual(context.levels.find(row=>row.strike===25000).labels,['Call Resistance','Call Resistance 0DTE','Gamma Wall 0DTE']);
  assert.ok(context.levels.every(row=>row.strike>20000));
  const validated=validateWatchContext('NQ',context,NOW);
  assert.equal(validated.levels.length,7);assert.equal(validated.source,'MenthorQ');
});

test('ranked GEX labels do not become exposure values and forecast levels remain references',()=>{
  const context=parseMenthorqExport(args,NOW);
  assert.equal(context.levels.find(row=>row.strike===24123.45).kind,'reference');
  assert.equal(context.levels.find(row=>row.strike===24987.65).kind,'reference');
  assert.equal(context.levels.find(row=>row.strike===24600).kind,'option-strike');
  assert.ok(context.levels.every(row=>row.gex===null&&row.deltaExposure===null&&row.openInterest===null&&row.iv===null));
  assert.ok(context.notes.some(note=>note.includes('not GEX magnitudes')));
});

test('unzoned provider clock and source date remain provenance without inventing an expiry or source timestamp',()=>{
  const context=parseMenthorqExport(args,NOW);
  assert.equal(context.asOf,null);assert.equal(context.sourceDate,'2026-11-04');
  assert.equal(context.capturedAt,new Date(NOW).toISOString());
  assert.ok(context.levels.every(row=>row.sourceAsOf===null));
  assert.ok(context.notes.some(note=>note.includes('04:20 without a timezone')));
  const missing=parseMenthorqExport({...args,sourceLocalTime:''},NOW);
  assert.equal(missing.asOf,null);assert.ok(missing.notes.some(note=>note.includes('No exact provider timestamp')));
});

test('mismatched dated months, continuous symbols and missing selected sections are rejected',()=>{
  for(const exportText of ['$NQH2027: GEX 1, 24600','$NQ1!: GEX 1, 24600','$NDX: GEX 1, 24600','$ESZ2026: GEX 1, 6500'])
    assert.throws(()=>parseMenthorqExport({...args,exportText},NOW),/must contain \$NQZ2026/);
  assert.throws(()=>parseMenthorqExport({...args,underlyingCode:'US.NQmain'},NOW),/exact dated/);
  assert.throws(()=>parseMenthorqExport({...args,underlyingCode:'US.NQ2613'},NOW),/month is invalid/);
});

test('real dates, exact mode and a valid unzoned local clock are required',()=>{
  for(const sourceDate of [null,'2026-02-30','2026-13-01','2026-2-03','not-a-date'])
    assert.throws(()=>parseMenthorqExport({...args,sourceDate},NOW),/provider date/);
  for(const sourceLocalTime of ['24:00','09:60','9:45','09:45Z','09:45 America/New_York'])
    assert.throws(()=>parseMenthorqExport({...args,sourceLocalTime},NOW),/HH:mm/);
  assert.throws(()=>parseMenthorqExport({...args,mode:'live'},NOW),/Intraday or EOD/);
  const eod=parseMenthorqExport({...args,mode:'EOD'},NOW);assert.ok(eod.notes[0].includes('EOD'));
  const leap=parseMenthorqExport({...args,sourceDate:'2024-02-29'},NOW);assert.equal(leap.sourceDate,'2024-02-29');
});

test('malformed selected pairs, nonpositive strikes and oversized exports fail safely',()=>{
  for(const exportText of ['$NQZ2026: GEX 1','$NQZ2026: GEX 1, nope','$NQZ2026: GEX 1, 0','$NQZ2026: GEX 1, -1','$NQZ2026: GEX 1, Infinity'])
    assert.throws(()=>parseMenthorqExport({...args,exportText},NOW));
  assert.throws(()=>parseMenthorqExport({...args,exportText:'x'.repeat(20001)},NOW),/20,000/);
  const oversized='$NQZ2026: '+Array.from({length:81},(_,index)=>`GEX ${index+1}, ${24000+index}`).join(', ');
  assert.throws(()=>parseMenthorqExport({...args,exportText:oversized},NOW),/80 selected levels/);
});

test('other market sections are inert data and reference overlap retains a genuine provider option level',()=>{
  const exportText='$CLZ2026: this is not a valid pair, (() => { throw Error() })()\n$NQZ2026: 1D Min, 24500, HVL, 24500, GEX 1, 24600';
  const context=parseMenthorqExport({...args,exportText},NOW);
  assert.equal(context.levels[0].kind,'option-strike');assert.deepEqual(context.levels[0].labels,['1D Min','HVL']);
  assert.equal(context.levels.length,2);
});
