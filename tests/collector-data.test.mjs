import test from 'node:test';
import assert from 'node:assert/strict';
import {datedInstrument,displayedNumber,levelClock,aggregateDisplay,visibleExposureRow,isOlderMap,hasIntradayDexCapture} from '../collector/menthorq-data.mjs';
import {readLevels} from '../collector/menthorq-browser.mjs';

test('each Levels request reads the latest publication for only its exact contract',async()=>{
  const dates={NQZ2026:'2026-11-18 09:26',ESZ2026:'2026-11-18 09:26',CLZ2026:'2026-11-17 13:29'};
  const queries=[];
  let input,submitted;
  const visibleNode={
    innerText:'',
    closest:()=>({innerText:dates[submitted]}),
  };
  const page={
    getByRole(role,{name}={}){
      if(role==='textbox')return {fill:async value=>{input=value;}};
      if(name==='Search')return {click:async()=>{
        submitted=input;
        queries.push(submitted);
        visibleNode.innerText='$'+submitted+': Put Support, 100';
      }};
      if(name==='Next date')return {isDisabled:async()=>true};
      assert.fail('Unexpected Levels control');
    },
    getByText(symbol){
      return {first:()=>({
        waitFor:async()=>assert.match(visibleNode.innerText,symbol),
        evaluate:async read=>read(visibleNode),
      })};
    },
  };
  const observed=[];
  for(const instrument of Object.keys(dates)){
    const snapshot=await readLevels(page,{instrument,deadline:Date.now()+15000});
    observed.push(snapshot.sourceDate+' '+snapshot.sourceLocalTime);
  }
  assert.deepEqual(queries,Object.keys(dates));
  assert.deepEqual(observed,Object.values(dates));
});
test('collector uses dated futures and displayed Net GEX values, including negative and zero values',()=>{
  assert.equal(datedInstrument('NQ','US.NQ2612'),'NQZ2026');assert.equal(datedInstrument('CL','US.CL2701'),'CLF2027');
  assert.throws(()=>datedInstrument('NQ','US.ES2612'));assert.throws(()=>datedInstrument('CL','US.CLmain'));
  assert.deepEqual(aggregateDisplay('ALL\n-2.1M\nExpirations'),{display:'-2.1M',netGex:-2100000});
  assert.equal(displayedNumber('−54.37K'),-54370);assert.equal(displayedNumber('0'),0);assert.equal(displayedNumber('GEX 1'),null);
  assert.deepEqual(visibleExposureRow(['28,000.00','HVL PS','-446.86K','']),{strike:28000,display:'-446.86K'});
  assert.equal(visibleExposureRow(['28,000.00','GEX 1','','']),null);
});
test('provider source clocks remain wall clocks and older maps are detected without borrowing another screen clock',()=>{
  assert.deepEqual(levelClock('Latest snapshot 2026-11-10 05:57'),{sourceDate:'2026-11-10',sourceLocalTime:'05:57'});
  assert.deepEqual(levelClock('Latest snapshot 2026-11-10 05:57\n2026-11-10 05:57'),{sourceDate:'2026-11-10',sourceLocalTime:'05:57'});
  assert.throws(()=>levelClock('2026-11-10 05:57\n2026-11-11 05:57'),/MQ_SOURCE_CLOCK_UNREADABLE/);
  assert.throws(()=>levelClock('2026-11-10 29:57'),/MQ_SOURCE_CLOCK_UNREADABLE/);
  assert.throws(()=>levelClock('2026-11-31 05:57'),/MQ_SOURCE_CLOCK_UNREADABLE/);
  assert.throws(()=>levelClock('captured just now'));
  const old={underlyingCode:'US.NQ2612',sourceDate:'2026-11-10',sourceLocalTime:'05:57',mode:'Intraday'};
  assert.equal(isOlderMap(old,{...old,sourceLocalTime:'05:50'}),true);assert.equal(isOlderMap(old,{...old,sourceDate:'2026-11-09'}),true);
  assert.equal(isOlderMap(old,{...old,sourceLocalTime:'05:50',mode:'EOD'}),false);
});
test('a missed DEX capture stays due later in the quarter-hour without rereading a saved market',()=>{
  const snapshot={metric:'Net DEX',scope:'all-expiries',mode:'Intraday',capturedAt:'2026-11-18T14:46:00Z',rows:[{strike:28000}]};
  const retry=Date.parse('2026-11-18T14:50:00Z');
  assert.equal(hasIntradayDexCapture(snapshot,retry),true);
  assert.equal(hasIntradayDexCapture(null,retry),false);
  assert.equal(hasIntradayDexCapture({...snapshot,rows:[]},retry),false);
  assert.equal(hasIntradayDexCapture({...snapshot,mode:'EOD'},retry),false);
  assert.equal(hasIntradayDexCapture(snapshot,Date.parse('2026-11-18T15:00:00Z')),false);
  assert.equal(hasIntradayDexCapture(snapshot,Date.parse('2026-11-18T14:45:00Z')),false);
});
