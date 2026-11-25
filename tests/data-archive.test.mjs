import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateStore,encode64} from '../lib/secure-store.mjs';
import {DATA_ARCHIVE_PREFIX,archiveDataRecords,dataArchiveRecords,listDataArchives} from '../lib/data-archive.mjs';
import {handleBackupRoute,checkpointSavedData} from '../src/backup-service.mjs';
const NOW=Date.parse('2026-11-07T04:22:45Z');
class MemoryBucket{
  rows=new Map();counter=0;failArchives=false;
  async put(key,body,options={}){if(this.failArchives&&key.startsWith(DATA_ARCHIVE_PREFIX))throw Error('Unavailable');const old=this.rows.get(key);if(options.onlyIf?.etagDoesNotMatch==='*'&&old)return null;if(options.onlyIf?.etagMatches&&old?.etag!==options.onlyIf.etagMatches)return null;const entry={body:String(body),etag:String(++this.counter),options};this.rows.set(key,entry);return {etag:entry.etag};}
  async get(key){const row=this.rows.get(key);return row?{etag:row.etag,body:new Blob([row.body]).stream(),text:async()=>row.body}:null;}
  async delete(key){this.rows.delete(key);}
  async list({prefix='',cursor,limit=1000}={}){const keys=[...this.rows.keys()].filter(key=>key.startsWith(prefix)&&(!cursor||key>cursor)).sort(),page=keys.slice(0,limit);return {objects:page.map(key=>({key,size:this.rows.get(key).body.length,uploaded:new Date(NOW),customMetadata:this.rows.get(key).options.customMetadata})),truncated:keys.length>page.length,cursor:page.at(-1)};}
}
const env=()=>({BUCKET:new MemoryBucket(),FUTU_TOKEN_ENCRYPTION_KEY:encode64(new Uint8Array(32).fill(3))});
const context=(time='14:35')=>({source:'MenthorQ',underlyingCode:'US.NQ2612',sourceInstrument:'NQZ2026',mode:'Intraday',sourceDate:'2026-11-06',sourceLocalTime:time,asOf:null,capturedAt:'2026-11-06T20:56:06Z',delayStatus:'delayed',levels:[{strike:27000,labels:['GEX 1'],gex:null}],heatmap:null,regime:{netGex:-4100000,asOf:null,sourceDate:null,delayStatus:'delayed'}});
const request=(path,{method='GET',body,origin='https://gamma.test'}={})=>new Request('https://gamma.test'+path,{method,headers:{origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});

test('a new map archives the old and new capture before overwriting, deduplicates, and preserves unknown clocks',async()=>{
  const e=env(),store=createPrivateStore(e),old=context(),next={...context('14:40'),capturedAt:'2026-11-06T21:00:00Z'};
  // Seed a pre-archive legacy row directly, then update through normal storage.
  await e.BUCKET.put('gamma-watch/v1/watch/menthorq-NQ-Intraday',JSON.stringify(old));
  await store.put('watch/menthorq-NQ-Intraday',next);await store.put('watch/menthorq-context',{NQ:next});
  const page=await listDataArchives(e.BUCKET);assert.equal(page.entries.length,2);
  const values=await Promise.all(page.entries.map(async entry=>JSON.parse(await (await e.BUCKET.get(DATA_ARCHIVE_PREFIX+entry.id)).text())));
  assert.deepEqual(values.map(row=>row.data.sourceLocalTime).sort(),['14:35','14:40']);
  for(const row of values){assert.equal(row.data.asOf,null);assert.equal(row.data.regime.asOf,null);assert.equal(row.data.delayStatus,'delayed');assert.equal(row.data.levels[0].gex,null);assert.equal(row.data.heatmap,null);}
  assert.deepEqual(await store.get('watch/menthorq-NQ-Intraday'),next);
});
test('backup failure is explicit and cannot replace the last valid saved map',async()=>{
  const e=env(),store=createPrivateStore(e);await store.put('watch/menthorq-NQ-Intraday',context());e.BUCKET.failArchives=true;
  await assert.rejects(store.put('watch/menthorq-NQ-Intraday',context('14:40')),error=>error.code==='DATA_BACKUP_UNAVAILABLE');
  assert.equal((await store.get('watch/menthorq-NQ-Intraday')).sourceLocalTime,'14:35');
});
test('archives admit successful quote/IV/bar records and exclude failed attempts, OAuth and jobs',async()=>{
  const quote={underlyingCode:'US.NQ2612',underlyingPrice:27000,contracts:[{iv:.2,gamma:.001,quoteTimestamp:null}],collectedAt:new Date(NOW).toISOString(),status:'partial-snapshot',coverage:{fullChain:false}};
  assert.equal(dataArchiveRecords('watch/state-v3',{markets:{NQ:quote}}).length,1);
  assert.equal(dataArchiveRecords('watch/state-v3',{markets:{NQ:{...quote,status:'refresh-failed'}}}).length,0);
  assert.equal(dataArchiveRecords('watch/iv/NQ/US.NQ2612',{...quote,rows:{a:{current:{iv:.2}}},lastSuccessAt:new Date(NOW).toISOString(),status:'checked'}).length,1);
  assert.equal(dataArchiveRecords('watch/history/NQ/US.NQ2612/bars',{underlyingCode:'US.NQ2612',bars:[{asOf:'2026-11-06T14:30:00Z'}]}).length,1);
  for(const name of ['oauth/connection','oauth/pending','watch/refresh-job-v3','watch/refresh-lease','watch/progress/id/NQ/quotes-0'])assert.equal(dataArchiveRecords(name,quote).length,0);
  await assert.rejects(archiveDataRecords(env().BUCKET,'watch/menthorq-NQ-Intraday',{...context(),access_token:'must-not-archive'},{origin:'recovered-capture'}),/Credentials/);
  const e=env();await archiveDataRecords(e.BUCKET,'watch/menthorq-NQ-Intraday',{...context(),accessToken:'must-not-archive'});
  assert.ok(![...e.BUCKET.rows.values()].some(row=>row.body.includes('must-not-archive')));
});
test('private routes paginate and export exact archived bodies; arbitrary storage keys and cross-origin writes fail',async()=>{
  const e=env();await archiveDataRecords(e.BUCKET,'watch/menthorq-NQ-Intraday',context(),{now:NOW});await archiveDataRecords(e.BUCKET,'watch/menthorq-NQ-Intraday',context('14:40'),{now:NOW});
  const first=await (await handleBackupRoute(request('/api/backups?limit=1'),e)).json();assert.equal(first.entries.length,1);assert.equal(first.hasMore,true);
  const second=await (await handleBackupRoute(request('/api/backups?limit=1&cursor='+encodeURIComponent(first.cursor)),e)).json();assert.equal(second.entries.length,1);assert.notEqual(second.entries[0].id,first.entries[0].id);
  const single=await handleBackupRoute(request('/api/backups/export?id='+encodeURIComponent(first.entries[0].id)),e);assert.equal(single.headers.get('cache-control'),'private, no-store');assert.equal((await single.json()).data.asOf,null);
  assert.equal((await handleBackupRoute(request('/api/backups/export?id=../../oauth/connection'),e)).status,400);
  assert.equal((await handleBackupRoute(request('/api/backups/checkpoint',{method:'POST',body:{},origin:'https://evil.test'}),e)).status,403);
  const response=await handleBackupRoute(request('/api/backups/export'),e),lines=(await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type,'gamma-watch-backup-export');assert.equal(lines.at(-1).type,'export-complete');assert.equal(lines.at(-1).records,2);assert.equal(lines.filter(row=>row.data).length,2);
});
test('checkpoint backs up retained server data without touching current records or fetching a provider',async()=>{
  const e=env();await e.BUCKET.put('gamma-watch/v1/watch/menthorq-context',JSON.stringify({NQ:context()}));await e.BUCKET.put('gamma-watch/v1/watch/refresh-job',JSON.stringify({token:'operational'}));
  let cursor,records=[];do{const result=await checkpointSavedData(e,{cursor});records.push(...result.records);cursor=result.cursor;}while(cursor);
  assert.equal(records.length,1);assert.deepEqual(JSON.parse(await (await e.BUCKET.get('gamma-watch/v1/watch/menthorq-context')).text()),{NQ:context()});
  assert.equal((await listDataArchives(e.BUCKET)).entries.length,1);
});
test('recovery imports archive-only data with original timestamps and reject credentials or unsupported records',async()=>{
  const e=env();const call=records=>handleBackupRoute(request('/api/backups/import',{method:'POST',body:{records}}),e);
  const response=await call([{name:'watch/menthorq-NQ-Intraday',value:context()}]);assert.equal(response.status,200);assert.equal(await createPrivateStore(e).get('watch/menthorq-context'),null);
  const saved=await (await handleBackupRoute(request('/api/backups/export'),e)).text();assert.ok(saved.includes('2026-11-06T20:56:06Z'));
  assert.equal((await call([{name:'oauth/connection',value:{accessToken:'secret'}}])).status,400);
  assert.equal((await call([{name:'recovered/private-iv-NQ-20261104.json',value:{accessToken:'secret'}}])).status,400);
});
