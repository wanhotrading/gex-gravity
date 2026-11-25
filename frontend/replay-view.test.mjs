import test from 'node:test';
import assert from 'node:assert/strict';
import {replayWindow,createReplayController} from './replay-view.mjs';
test('observation windows clamp both ends and keep the selected capture inside',()=>{
 const rows=Array.from({length:10},()=>({}));
 assert.deepEqual(replayWindow(rows,-5,20,30),{start:0,end:9,selected:9});
 assert.deepEqual(replayWindow(rows,3,7,1),{start:3,end:7,selected:3});
 assert.deepEqual(replayWindow([],0,0,0),{start:0,end:0,selected:0});
});
test('replay browses saved captures, selects exact snapshot, and returns to latest without writes',async()=>{
 const handlers={},changes=[],requests=[];
 const root={innerHTML:'',addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[],querySelector:()=>null};
 const entries=[{id:'early',capturedAt:'2026-11-06T15:00:00Z'},{id:'late',capturedAt:'2026-11-06T15:05:00Z'}];
 const fetcher=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.startsWith('/api/replay/snapshot')?{context:{underlyingCode:'US.NQ2612'},replay:{selectedId:'early',capturedAt:entries[0].capturedAt,quoteAvailable:false}}:{entries,cursor:null,hasMore:false}};};
 const c=createReplayController(root,{onChange:s=>changes.push(s),fetcher});c.update({market:'NQ',underlyingCode:'US.NQ2612',sourceDate:'2026-11-06'});
 const click=(attribute,dataset={})=>handlers.click({target:{closest:()=>({hasAttribute:name=>name===attribute,dataset})}});
 click('data-replay-load');for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.match(root.innerHTML,/2 saved captures/);assert.equal(c.snapshot,null);
 click('',{replayStep:'-1'});for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.equal(c.snapshot.replay.selectedId,'early');assert.ok(requests.some(r=>r.url.includes('id=early')));assert.ok(requests.every(r=>!r.options.method));
 assert.match(root.innerHTML,/No compatible prior Futu snapshot/);
 click('data-replay-live');assert.equal(c.snapshot,null);assert.equal(changes.at(-1),null);
});
