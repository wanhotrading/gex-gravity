import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./entrance.js',import.meta.url),'utf8');
function harness({reduced=false,previous='0',storageFails=false}={}){
 let now=0,next=0;const timers=new Map(),handlers={},styles=new Map(),classes=new Set(),observations=[];
 function element(){const c=new Set(),s=new Map();return {id:'',inert:false,hidden:false,style:{setProperty:(k,v)=>s.set(k,v),removeProperty:k=>s.delete(k)},classList:{contains:x=>c.has(x),add:x=>c.add(x),remove:x=>c.delete(x)},closest:()=>null,getClientRects:()=>[{}],_style:s,_class:c};}
 const surfaces=[element(),element()],items=Array.from({length:14},element),skip={tabIndex:-1,addEventListener:(n,f)=>handlers[n]=f},intro={hidden:false};
 const document={readyState:'loading',documentElement:{style:{setProperty:(k,v)=>styles.set(k,v)},dataset:{},classList:{add:(...x)=>x.forEach(v=>classes.add(v)),remove:(...x)=>x.forEach(v=>classes.delete(v))}},querySelectorAll:s=>s==='.topbar,.workspace'?surfaces:s==='.gex-reveal-item'?items.filter(e=>e._class.has('gex-reveal-item')):items,getElementById:id=>id==='gex-skip-intro'?skip:intro,addEventListener:(n,f)=>handlers[n]=f};
 let image;class Image{constructor(){image=this;}}
 const context={document,window:{matchMedia:()=>({matches:reduced})},performance:{now:()=>now},sessionStorage:{getItem(){if(storageFails)throw Error('blocked');return previous;},setItem(){}},crypto:{getRandomValues:x=>{x[0]=0;}},Uint32Array,Math,Image,MutationObserver:class{constructor(fn){observations.push(fn);}observe(){}disconnect(){}},setTimeout:(f,ms)=>{timers.set(++next,{f,at:now+ms});return next;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(source,context);
 function advance(to){while(true){const due=[...timers.entries()].filter(([,t])=>t.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].f();}now=to;}
 return {document,styles,classes,surfaces,items,skip,intro,handlers,get image(){return image;},advance,observations};
}
test('background selection avoids the last visit and tolerates blocked storage',()=>{
 const h=harness();assert.equal(h.document.documentElement.dataset.backdrop,'2');assert.match(h.styles.get('--gex-backdrop'),/radial-gradient/);
 assert.ok(harness({storageFails:true}).styles.get('--gex-backdrop'));
});
test('missing data releases the cover; pairs finish in two seconds',()=>{
 const h=harness();h.handlers.DOMContentLoaded();assert.ok(h.surfaces.every(e=>e.inert));h.advance(1800);
 assert.ok(h.classes.has('gex-revealing'));assert.ok(h.surfaces.every(e=>!e.inert));
 const delays=h.items.map(e=>Number(e._style.get('--gex-delay').replace('ms','')));
 for(let i=0;i<delays.length;i+=2)assert.equal(delays[i],delays[i+1]);
 assert.equal(Math.max(...delays)+480,2000);h.advance(3800);assert.ok(h.intro.hidden);assert.ok(h.classes.has('gex-ready'));
});
test('ready data starts only after typing, reduced motion and skip reveal immediately',()=>{
 const h=harness();h.handlers.DOMContentLoaded();h.handlers['gex:data-ready']();h.advance(1099);assert.ok(!h.classes.has('gex-revealing'));h.advance(1100);assert.ok(h.classes.has('gex-revealing'));
 const reduced=harness({reduced:true});reduced.handlers.DOMContentLoaded();assert.ok(reduced.intro.hidden);assert.ok(reduced.surfaces.every(e=>!e.inert));
 const skipped=harness();skipped.handlers.DOMContentLoaded();skipped.handlers.click();assert.ok(skipped.intro.hidden);assert.ok(skipped.surfaces.every(e=>!e.inert));
});
test('late dynamic content receives remaining delay without restarting the two-second deadline',()=>{
 const h=harness();h.handlers.DOMContentLoaded();h.handlers['gex:data-ready']();h.advance(1100);h.advance(2100);
 h.items[0]._class.clear();h.observations[0]();assert.equal(h.items[0]._style.get('--gex-delay'),'-1000ms');h.advance(3100);assert.ok(h.intro.hidden);
});
test('a document that becomes ready after the safety timeout stays usable',()=>{
 const h=harness();h.advance(4300);assert.ok(h.classes.has('gex-ready'));h.handlers.DOMContentLoaded();
 assert.ok(h.intro.hidden);assert.ok(h.surfaces.every(e=>!e.inert));
});
