/* One lightweight entry sequence per document; market data keeps its own clocks. */
(() => {
  'use strict';
  const root=document.documentElement,started=performance.now();
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
  let previous=-1;
  try{previous=Number(sessionStorage.getItem('gex:last-backdrop')??-1);}catch{}
  const choices=Array.from({length:8},(_,i)=>i).filter(i=>i!==previous);
  let random=Math.floor(Math.random()*choices.length);
  try{const bytes=new Uint32Array(1);crypto.getRandomValues(bytes);random=bytes[0]%choices.length;}catch{}
  const selected=choices[random];
  const colors=['#26395c','#352c5a','#192f47','#152e3b','#39324f','#1d3748','#362d42','#232c48'];
  try{sessionStorage.setItem('gex:last-backdrop',String(selected));}catch{}
  root.style.setProperty('--gex-backdrop','radial-gradient(ellipse at 36% 22%, '+colors[selected]+', #070b15 75%)');
  root.dataset.backdrop=String(selected+1);
  root.classList.add('gex-boot');
  let domReady=false,dataReady=false,revealing=false,finished=false;
  let observer=null,revealStarted=0,minimumTimer,finishTimer;
  const selectors='[data-reveal],.reading-status,.reading-cards>article,.reading-controls,.reading-observations,.expiry-controls,.reading-heading,.reading-direction,.reading-window,.reading-probe,.reading-probe-hint,.reading-chart-scroll,.gravity-heading,.gravity-source,.gravity-deck,.gravity-key,.gravity-caveat,.gravity-research,.reading-transitions,.reading-distance,.reading-chart-notes,.reading-schedule,.lens-heading,.lens-evidence,.lens-level-list,.lens-focus,.lens-method,.site-footer';
  const surfaces=()=>document.querySelectorAll('.topbar,.workspace');
  function finish(){
    if(finished)return;finished=true;observer?.disconnect();
    clearTimeout(minimumTimer);clearTimeout(finishTimer);clearTimeout(safetyTimer);clearTimeout(loadDeadline);
    root.classList.remove('gex-boot','gex-revealing');root.classList.add('gex-ready');
    for(const element of surfaces())element.inert=false;
    for(const element of document.querySelectorAll('.gex-reveal-item')){element.classList.remove('gex-reveal-item');element.style.removeProperty('--gex-delay');}
    const intro=document.getElementById('gex-intro');if(intro)intro.hidden=true;
    if(document.activeElement?.id==='gex-skip-intro')document.querySelector('.brand')?.focus();
    root.dataset.revealElapsed=String(Math.round(performance.now()-revealStarted));
  }
  function assignPairs(){
    const items=[...document.querySelectorAll(selectors)].filter(element=>{
      const closed=element.closest('details:not([open])');
      return (!closed||closed===element)&&element.getClientRects().length>0;
    });
    const pairs=Math.max(1,Math.ceil(items.length/2)-1),step=1520/pairs;
    const elapsed=performance.now()-revealStarted;
    items.forEach((element,index)=>{
      if(element.classList.contains('gex-reveal-item'))return;
      element.style.setProperty('--gex-delay',`${Math.floor(index/2)*step-elapsed}ms`);
      element.classList.add('gex-reveal-item');
    });
    root.dataset.revealItems=String(items.length);
  }
  function reveal(){
    if(finished||revealing||!domReady)return;
    if(reduced){finish();return;}
    revealing=true;revealStarted=performance.now();root.dataset.revealStarted=String(revealStarted);
    assignPairs();root.classList.add('gex-revealing');
    for(const element of surfaces())element.inert=false;
    observer=new MutationObserver(()=>{if(performance.now()-revealStarted<2000)assignPairs();});
    observer.observe(document.body,{childList:true,subtree:true});
    finishTimer=setTimeout(finish,2000);
  }
  function attempt(){
    if(!domReady||finished||revealing)return;
    const elapsed=performance.now()-started;
    if(reduced){finish();return;}
    if(elapsed<1100){clearTimeout(minimumTimer);minimumTimer=setTimeout(attempt,1100-elapsed);return;}
    if(dataReady||elapsed>=1800)reveal();
  }
  document.addEventListener('gex:data-ready',()=>{dataReady=true;attempt();});
  function ready(){
    domReady=true;
    if(finished){
      for(const element of surfaces())element.inert=false;
      const intro=document.getElementById('gex-intro');if(intro)intro.hidden=true;
      return;
    }
    const skip=document.getElementById('gex-skip-intro');if(skip){skip.tabIndex=0;skip.addEventListener('click',finish);}
    if(!reduced)for(const element of surfaces())element.inert=true;
    attempt();
  }
  const loadDeadline=setTimeout(attempt,1800);
  // Release the cover even if data or a later application module never loads.
  const safetyTimer=setTimeout(finish,4200);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();
