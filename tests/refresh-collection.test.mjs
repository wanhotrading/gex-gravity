import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceFutuCollection} from '../src/refresh-collection.mjs';
const NOW=Date.parse('2026-11-05T15:00:00Z'),OWNER='US.NQ2612';
const iso=value=>new Date(value).toISOString();
function fixture({cached=true,storageKey}={}){
  const rows=[];
  for(let strikeIndex=0;strikeIndex<20;strikeIndex++)for(let expiryIndex=0;expiryIndex<25;expiryIndex++)for(const type of ['CALL','PUT']){
    const strike=28500+strikeIndex*10,expiry=iso(Date.parse('2026-11-05')+expiryIndex*86400000).slice(0,10);
    rows.push({code:`US.F${expiryIndex}${type[0]}${strike}`,stock_owner:OWNER,stock_type:'DRVT',strike_price:strike,option_type:type,strike_time:expiry,expiration_cycle:'WEEK'});
  }
  const values=new Map(),writes=[],calls={metadata:[],snapshots:[]},byCode=new Map(rows.map(row=>[row.code,row]));
  const store={get:async key=>values.get(key)??null,put:async(key,value)=>{writes.push(key);values.set(key,structuredClone(value));},remove:async key=>values.delete(key)};
  const job={id:'scope-test',start:'2026-11-05',end:'2026-12-19',...(storageKey?{storageKey}:{})};
  const current={market:'NQ',underlyingCode:OWNER,...(cached?{stage:'quotes'}:{})};job.current=current;
  if(cached)values.set(`watch/metadata/${OWNER}`,{underlyingCode:OWNER,start:job.start,end:job.end,retrievedAt:iso(NOW),rows,
    windows:[{start:job.start,end:job.end,returned:rows.length}],collectionDiagnostics:{returnedRows:rows.length,validContracts:rows.length,completeWithinRequestedRange:true}});
  const client={optionChain:async(code,start,end)=>{calls.metadata.push({code,start,end});return rows.filter(row=>row.strike_time>=start&&row.strike_time<=end);},
    snapshots:async codes=>{calls.snapshots.push(codes);return codes.map(code=>code===OWNER?{code,future_valid:true,last_price:28550,update_time:NOW}
      :{code,option_valid:true,option_strike_price:byCode.get(code).strike_price,option_implied_volatility:20,delta:byCode.get(code).option_type==='CALL'?.5:-.5,gamma:.001,option_open_interest:100,update_time:NOW});}};
  return{rows,values,writes,store,job,current,client,calls};
}
const step=(value,options={})=>advanceFutuCollection(value.client,{store:value.store,job:value.job,current:value.current,now:NOW,...options});

test('missing IV in first four options does not abort the remaining watched expiries',async()=>{
  const value=fixture(),snapshots=value.client.snapshots;let calls=0;
  value.client.snapshots=async codes=>{const rows=await snapshots(codes);return ++calls===1?rows.map(row=>row.option_valid?{...row,option_implied_volatility:0}:row):rows;};
  const first=await step(value,{allowedStrikes:[28500,28520],maxBatches:1});
  assert.equal(first.done,false);assert.equal(value.current.supportsRequiredFields,false);
  const final=await step(value,{allowedStrikes:[28500,28520]});
  assert.equal(final.done,true);assert.equal(final.result.coverage.collectionComplete,true);
  assert.equal(final.result.coverage.requested,100);assert.equal(value.current.supportsRequiredFields,true);
});
test('provider permission failures still propagate without requesting later batches',async()=>{
  const value=fixture();let calls=0;value.client.snapshots=async()=>{calls++;throw Object.assign(Error('Entitlement missing'),{code:'NO_PERMISSION'});};
  await assert.rejects(step(value),{code:'NO_PERMISSION'});assert.equal(calls,1);
});

test('server watched strikes filter option snapshots across every enumerated expiry',async()=>{
  const value=fixture({cached:false});let result;
  for(let i=0;i<10;i++){result=await step(value,{allowedStrikes:[28500,28520,28540]});if(result.done)break;}
  const expected=value.rows.filter(row=>[28500,28520,28540].includes(row.strike_price));
  assert.equal(result.done,true);assert.equal(value.calls.metadata.length,4);
  assert.equal(result.result.options.length,expected.length);assert.equal(result.result.chainCoverage.validContracts,value.rows.length);
  assert.equal(result.result.chainCoverage.returnedRows,value.rows.length);
  assert.equal(new Set(result.result.options.map(row=>row.expiryDate)).size,25);
  const allowedCodes=new Set(expected.map(row=>row.code));
  assert.ok(value.calls.snapshots.flat().every(code=>code===OWNER||allowedCodes.has(code)));
  assert.equal(result.result.coverage.expected,150);assert.equal(result.result.coverage.requested,150);
  assert.equal(result.result.coverage.metadataContracts,1000);assert.equal(result.result.coverage.selectedContracts,150);
  assert.equal(result.result.coverage.fullChain,false);assert.equal(result.result.coverage.fullSelectedScope,true);
  assert.equal(value.values.get(`watch/metadata/${OWNER}`).rows.length,1000);
});

test('omitted scope on a new job retains full-chain compatibility and bounded batches',async()=>{
  const value=fixture(),result=await step(value);
  assert.equal(result.done,true);assert.equal(result.result.options.length,1000);assert.equal(result.result.coverage.fullChain,true);
  assert.deepEqual(value.calls.snapshots.map(codes=>codes.length),[5,400,400,196]);
  assert.equal(result.result.coverage.snapshotScope,'all-requested-strikes');
});

test('explicit empty or unmatched watched selections return no series and make no snapshot request',async()=>{
  for(const allowedStrikes of [[],[99999]]){
    const value=fixture(),result=await step(value,{allowedStrikes});
    assert.equal(result.done,true);assert.equal(result.result.status,'no-watched-contracts');
    assert.equal(result.result.options.length,0);assert.equal(result.result.coverage.expected,0);
    assert.equal(result.result.coverage.metadataContracts,1000);assert.equal(result.result.chainCoverage.validContracts,1000);
    assert.equal(value.calls.snapshots.length,0);assert.equal(result.result.underlying,null);
  }
});

test('changing the server watchlist cannot reuse an earlier scope batch or its counters',async()=>{
  const value=fixture(),oldStrikes=Array.from({length:10},(_,i)=>28500+i*10);
  const first=await step(value,{allowedStrikes:oldStrikes,maxBatches:1});
  assert.equal(first.done,false);assert.equal(value.current.requested,4);
  const oldKey=[...value.values.keys()].find(key=>key.includes('/quotes-'));
  const changed=await step(value,{allowedStrikes:[28690]});
  assert.equal(changed.done,true);assert.equal(changed.result.options.length,50);
  assert.ok(changed.result.options.every(row=>row.strike===28690));assert.equal(changed.result.coverage.requested,50);
  assert.ok(changed.cleanupKeys.includes(oldKey));
  assert.ok(value.calls.snapshots.slice(1).flat().every(code=>code===OWNER||value.rows.find(row=>row.code===code).strike_price===28690));
});

test('resumed scoped jobs keep their captured scope when the optional argument is omitted',async()=>{
  const value=fixture();await step(value,{allowedStrikes:[28500],maxBatches:1});
  const version=value.current.quoteScopeRevision,result=await step(value);
  assert.equal(value.current.quoteScopeRevision,version);assert.equal(result.result.options.length,50);
  assert.ok(result.result.options.every(row=>row.strike===28500));
});

test('invalid scope values are rejected and progress storage keys use a fixed allowlist',async()=>{
  for(const allowedStrikes of [[NaN],[0],['28500'],Array.from({length:81},(_,i)=>i+1)]){
    const value=fixture();await assert.rejects(step(value,{allowedStrikes}),{code:'INVALID_WATCHED_STRIKES'});
    assert.equal(value.calls.snapshots.length,0);
  }
  const compact=fixture({storageKey:'watch/refresh-job-v3'});await step(compact,{allowedStrikes:[28500],maxBatches:1});
  assert.ok(compact.writes.includes('watch/refresh-job-v3'));assert.equal(compact.writes.includes('watch/refresh-job'),false);
  const other=fixture({storageKey:'oauth/connection'});await step(other,{allowedStrikes:[28500],maxBatches:1});
  assert.ok(other.writes.includes('watch/refresh-job'));assert.equal(other.writes.includes('oauth/connection'),false);
});
