const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=x=>Number.isFinite(Date.parse(x??''));
export const replayClock=x=>stamp(x)?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(x))+' NY':'Unknown time';
const nyDate=x=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(x));
export function replayWindow(entries,start,end,selected){
 const last=Math.max(0,entries.length-1),lo=Math.max(0,Math.min(last,Math.round(start||0))),hi=Math.max(lo,Math.min(last,Math.round(end??last)));
 return {start:lo,end:hi,selected:Math.max(lo,Math.min(hi,Math.round(selected??hi)))};
}
export function createReplayController(root,{onChange=()=>{},fetcher=(url,options)=>fetch(url,options)}={}){
 if(!root)return {update(){},get snapshot(){return null;}};
 const s={key:null,market:null,code:null,date:null,entries:[],cursor:null,hasMore:false,loading:false,error:null,start:0,end:0,selected:0,snapshot:null,reading:false,generation:0,request:0,cache:new Map()};
 let timer;
 async function get(url){const response=await fetcher(url,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});const data=await response.json();if(!response.ok)throw Error(data.error??'Saved history could not be read.');return data;}
 function label(index){return replayClock(s.entries[index]?.capturedAt);}
 function updateControls(){
  root.querySelectorAll('[data-replay-input]').forEach(input=>{const field=input.dataset.replayInput;input.max=String(Math.max(0,s.entries.length-1));if(field==='selected'){input.min=String(s.start);input.max=String(s.end);}input.value=String(s[field]);});
  for(const field of ['start','end','selected']){const el=root.querySelector(`[data-replay-label="${field}"]`);if(el)el.textContent=label(s[field]);}
 }
 function render(){
  const n=s.entries.length,entry=s.entries[s.selected],active=!!s.snapshot;
  const focused=root.ownerDocument?.activeElement;
  const input=focused&&root.contains(focused)?focused.dataset.replayInput:null;
  root.innerHTML=`<section class="replay-panel" aria-label="Saved intraday replay"><div class="replay-heading"><div><span class="replay-eyebrow">TIME OBSERVATORY</span><h2>Revisit the market.</h2></div><span class="replay-state ${active?'replay-active':''}">${active?'Historical replay':'Latest saved view'}</span></div><div class="replay-toolbar"><label>New York date<input type="date" data-replay-date value="${esc(s.date)}"></label><button type="button" data-replay-load ${s.loading?'disabled':''}>${s.loading?'Reading archive…':'Browse captures'}</button><button type="button" data-replay-live ${active||s.reading?'':'disabled'}>Return to latest</button>${s.hasMore?`<button type="button" data-replay-more ${s.loading?'disabled':''}>Load more captures</button>`:''}</div>${n?`<div class="replay-window"><div class="replay-window-heading"><span>Time window · ${n} saved captures</span><div><button type="button" data-replay-shift="-1" aria-label="Move time window earlier">←</button><button type="button" data-replay-shift="1" aria-label="Move time window later">→</button><button type="button" data-replay-full>Full day</button></div></div><div class="replay-window-handles"><label>From <b data-replay-label="start">${label(s.start)}</b><input type="range" data-replay-input="start" aria-label="Observation window start" min="0" max="${n-1}" value="${s.start}"></label><label>To <b data-replay-label="end">${label(s.end)}</b><input type="range" data-replay-input="end" aria-label="Observation window end" min="0" max="${n-1}" value="${s.end}"></label></div><div class="replay-scrubber"><button type="button" data-replay-step="-1" aria-label="Previous saved capture">‹</button><div><div class="replay-ticks" aria-hidden="true">${s.entries.map((_,i)=>`<i style="left:${n>1?100*i/(n-1):50}%"></i>`).join('')}</div><input type="range" data-replay-input="selected" aria-label="Replay saved capture" min="${s.start}" max="${s.end}" value="${s.selected}"></div><button type="button" data-replay-step="1" aria-label="Next saved capture">›</button></div><div class="replay-capture-label"><strong data-replay-label="selected">${label(s.selected)}</strong><span>${s.reading?'Loading selected snapshot…':active?'Viewing this saved capture':'Move the bar to open a capture'}</span></div></div>`:''}${s.error?`<p class="replay-error" role="status">${esc(s.error)}</p>`:!n&&!s.loading?'<p class="replay-empty">Browse a date to see the captures that were actually saved.</p>':''}${active?`<div class="replay-coverage"><b>Historical lens · ${esc(replayClock(s.snapshot.replay?.capturedAt??entry?.capturedAt))}</b><span>${s.snapshot.replay?.quoteAvailable?'Prior saved Futu inputs included.':'No compatible prior Futu snapshot; curves and hedge scenarios are unavailable.'} ${s.snapshot.context?.exposure?.rows?.length?'Numerical strike exposure captured.':'Numerical strike exposure was not saved in this capture.'}</span></div>`:''}<details class="replay-notes"><summary>Capture timing &amp; coverage</summary><p>The bar steps through saved capture times, with one step per capture. Provider dates, clocks and delays stay separate. Missing intervals are not interpolated. The latest quote cards above stay on the latest saved data; this replay controls the chart and strike detail below.</p>${(s.snapshot?.replay?.notes??[]).map(note=>`<p>${esc(note)}</p>`).join('')}</details></section>`;
  if(input)root.querySelector(`[data-replay-input="${input}"]`)?.focus({preventScroll:true});
 }
 async function browse(more=false){
  if(s.loading||!s.code)return;clearTimeout(timer);const generation=++s.generation; s.request++;s.loading=true;s.reading=false;s.error=null;
  if(!more){s.entries=[];s.cursor=null;s.hasMore=false;s.snapshot=null;s.cache.clear();onChange(null);}
  render();
  try{
   let cursor=more?s.cursor:null;
   for(let page=0;page<12;page++){
    const data=await get(`/api/replay?market=${encodeURIComponent(s.market)}&underlyingCode=${encodeURIComponent(s.code)}&date=${encodeURIComponent(s.date)}${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
    if(generation!==s.generation)return;
    s.entries=[...new Map([...s.entries,...(data.entries??[])].map(e=>[e.id,e])).values()].filter(e=>stamp(e.capturedAt)).sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt)||a.id.localeCompare(b.id));
    s.hasMore=!!data.hasMore;s.cursor=data.cursor??null;cursor=s.cursor;
    if(!s.hasMore||!cursor)break;
   }
   s.start=0;s.end=Math.max(0,s.entries.length-1);const retained=more?s.entries.findIndex(e=>e.id===s.snapshot?.replay?.selectedId):-1;s.selected=retained>=0?retained:s.end;
   if(!s.entries.length)s.error=s.hasMore?'No matches in the pages read. Load more captures to continue searching.':'No captures were saved for this date and exact futures contract.';
  }catch(error){if(generation===s.generation)s.error=error.message;}
  finally{if(generation===s.generation){s.loading=false;render();}}
 }
 async function select(){
  const entry=s.entries[s.selected];if(!entry)return;const request=++s.request,key=s.key;s.reading=true;s.error=null;render();
  try{
   let snapshot=s.cache.get(entry.id);
   if(!snapshot){snapshot=await get(`/api/replay/snapshot?market=${encodeURIComponent(s.market)}&underlyingCode=${encodeURIComponent(s.code)}&id=${encodeURIComponent(entry.id)}`);if(snapshot.context?.underlyingCode!==s.code)throw Error('The saved capture belongs to another futures contract.');s.cache.set(entry.id,snapshot);while(s.cache.size>3)s.cache.delete(s.cache.keys().next().value);}
   if(request!==s.request||key!==s.key)return;
   s.snapshot=snapshot;onChange(snapshot);
  }catch(error){if(request===s.request){s.error=error.message;s.snapshot=null;onChange(null);}}
  finally{if(request===s.request){s.reading=false;render();}}
 }
 root.addEventListener('input',event=>{
  const field=event.target.dataset?.replayInput;if(!field)return;
  const value=Number(event.target.value);if(!Number.isFinite(value))return;s.request++;s[field]=value;
  if(field==='start'&&s.start>s.end)s.end=s.start;if(field==='end'&&s.end<s.start)s.start=s.end;
  Object.assign(s,replayWindow(s.entries,s.start,s.end,s.selected));updateControls();clearTimeout(timer);timer=setTimeout(select,220);
 });
 root.addEventListener('change',event=>{if(event.target.hasAttribute('data-replay-date')){s.date=event.target.value;s.snapshot=null;s.entries=[];s.generation++;s.request++;s.loading=false;s.reading=false;s.error=null;onChange(null);render();}});
 root.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-replay-load')){void browse();return;}if(b.hasAttribute('data-replay-more')){void browse(true);return;}
  if(b.hasAttribute('data-replay-live')){clearTimeout(timer);s.request++;s.reading=false;s.snapshot=null;s.error=null;onChange(null);render();return;}
  if(b.hasAttribute('data-replay-full')){s.start=0;s.end=s.entries.length-1;updateControls();return;}
  if(b.dataset.replayShift){const width=s.end-s.start,step=Math.max(1,Math.round((width+1)/4)),start=Math.max(0,Math.min(s.entries.length-1-width,s.start+Number(b.dataset.replayShift)*step));s.start=start;s.end=start+width;}
  if(b.dataset.replayStep)s.selected+=Number(b.dataset.replayStep);
  Object.assign(s,replayWindow(s.entries,s.start,s.end,s.selected));updateControls();void select();
 });
 return {get snapshot(){return s.snapshot;},update({market,underlyingCode,sourceDate}={}){const key=market+'|'+underlyingCode;if(key===s.key)return;s.key=key;s.market=market;s.code=underlyingCode;s.date=sourceDate||nyDate(Date.now());s.entries=[];s.cursor=null;s.hasMore=false;s.loading=false;s.reading=false;s.snapshot=null;s.error=null;s.generation++;s.request++;s.cache.clear();render();}};
}
