import {expiryBadges} from './gravity-view.mjs';
import {buildOverallSensitivity,regimeReading} from '../core/market-reading.mjs';
import {renderMarketReading} from './market-reading-view.mjs';
import {createLevelLens,rankLevelLenses,compareLevelHistory} from '../core/level-impact.mjs';
import {compareExpirySensitivity} from '../core/expiry-comparison.mjs';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fmt=(v,d=1)=>finite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const direction=v=>!finite(v)?'Unavailable':Math.abs(v)<.000001?'No change':v>0?'Buy':'Sell';
const sign=(v,d=1)=>finite(v)?`${v>0?'+':''}${fmt(v,d)}`:'—';
const settings=new Map();let cache=null,comparisonCache=null;
function preferences(market){if(!settings.has(market))settings.set(market,{move:market==='CL'?.05:market==='ES'?10:50,ivScale:1,share:1,side:null,regimeMode:'auto',target:null,window:'opening',advanced:false,chartCenter:null,expiryScope:'all',elapsedMinutes:0});return settings.get(market);}
function clearStrikeFocus(prefs){
  prefs.focusedKey=null;
  prefs.deltaStrikeKey=null;
  prefs.compareOpen=false;
  prefs.comparisonProbe=null;
}

function resetChartView(prefs){
  prefs.chartProbe=null;
  prefs.chartCenter=null;
  prefs.chartMove=null;
}

function openStrike(root,key){
  const props=root._lensProps,prefs=preferences(props.marketName);
  prefs.focusedKey=key;
  prefs.deltaStrikeKey=key;
  prefs.compareOpen=true;
  root._compareReveal=true;
  if(props.onSelect)props.onSelect(key);
  else renderLevelLens(root,props);
}
function card(flow,title,price,partial){return `<article class="lens-flow ${flow?.change>0?'buy':flow?.change<0?'sell':''}"><span>${title} → ${fmt(price,2)}</span><h4>${direction(flow?.change)} <b>${fmt(Math.abs(flow?.change))}</b></h4><p>${partial?'Modeled subset · ':''}equivalent futures contracts</p>${flow?`<small>Net hedge ${sign(flow.before)} → ${sign(flow.after)}<br>+ long / − short · conditional inventory</small>`:'<small>Exact model inputs needed</small>'}</article>`;}
function chart(lens,target){
  const p=lens.profile;if(!p)return '<div class="lens-empty">A distance curve needs IV, OI, an exact expiry time and an eligible pricing model.</div>';
  const W=760,H=310,L=65,R=35,T=35,B=45,lo=p.points[0].price,hi=p.points.at(-1).price;
  const x=v=>L+(v-lo)/(hi-lo)*(W-L-R),y=v=>H-B-Math.min(1,Math.max(0,v))*(H-B-T);
  const path=p.points.map((v,i)=>`${i?'L':'M'}${x(v.price).toFixed(2)},${y(v.ratio).toFixed(2)}`).join(' ');
  const band=p.bands[0];const a=Math.max(lo,band.lower??lo),b=Math.min(hi,band.upper??hi);
  return `<svg class="lens-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Combined option sensitivity at strike ${fmt(lens.strike)}. Snapshot price ${fmt(lens.price)}. ${fmt(p.ratio*100)} percent of this cluster's modeled peak. This is not a price forecast.">
    <defs><linearGradient id="lens-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ae8ef" stop-opacity=".28"/><stop offset="1" stop-color="#8ae8ef" stop-opacity="0"/></linearGradient></defs>
    <rect x="${x(a)}" y="${T}" width="${Math.max(0,x(b)-x(a))}" height="${H-B-T}" fill="#8bb8ee" opacity=".09"/>
    ${[0,.5,1].map(r=>`<line x1="${L}" y1="${y(r)}" x2="${W-R}" y2="${y(r)}" stroke="#ffffff" stroke-opacity=".12"/><text x="${L-9}" y="${y(r)+4}" text-anchor="end">${r*100}%</text>`).join('')}
    <path d="${path} L${x(hi)},${y(0)} L${x(lo)},${y(0)} Z" fill="url(#lens-fill)"/><path d="${path}" fill="none" stroke="#a9eff3" stroke-width="3"/>
    <line x1="${x(lens.strike)}" y1="${T}" x2="${x(lens.strike)}" y2="${H-B}" stroke="#e3c2fc" stroke-dasharray="5 5"/><text x="${x(lens.strike)}" y="18" text-anchor="middle" fill="#e3c2fc">Strike ${fmt(lens.strike,2)}</text>
    <line x1="${x(lens.price)}" y1="${T}" x2="${x(lens.price)}" y2="${H-B}" stroke="#fff" stroke-opacity=".65"/><circle cx="${x(lens.price)}" cy="${y(p.ratio)}" r="5" fill="#fff"/>
    ${finite(target)&&target>=lo&&target<=hi?`<circle cx="${x(target)}" cy="${y(lens.slopeAt(target)/p.peak)}" r="6" fill="#ffc986" stroke="#172036" stroke-width="2"/>`:''}
    ${[lo,(lo+hi)/2,hi].map(v=>`<text x="${x(v)}" y="${H-15}" text-anchor="middle">${fmt(v,2)}</text>`).join('')}
    <text x="${Math.min(W-R-45,Math.max(L+45,x(lens.price)))}" y="${H-B-8}" text-anchor="middle" fill="#fff">Snapshot</text></svg>`;
}

export function renderLevelLens(root,props={}, {resetView=false}={}){
  if(!root)return;root._lensProps=props;
  const active=root.ownerDocument?.activeElement,field=active?.dataset?.lensField;
  const editing=root.contains?.(active)&&field&&!(resetView&&['chartMove','chartCenter'].includes(field))?{field,value:active.value}:null;
  const replayFocus=active&&props.replayRoot?.contains(active)?active:null;
  const plotScroll=root.querySelector?.('.reading-chart-scroll');
  const plotOffset=resetView?0:plotScroll?.scrollLeft,plotFocused=active&&active===plotScroll;
  const focusedCurve=active?.matches?.('.reading-legend button')&&root.contains(active)?active.dataset.lensStrike:null;
  const focusedLine=active?.matches?.('.reading-strike-line')&&root.contains(active)?active.dataset.lensStrike:null;
  const focusedProbe=['[data-probe-reset]','[data-compare-slider]','[data-compare-reset]','[data-compare-toggle]','[data-reading-overall]'].find(selector=>active?.matches?.(selector)&&root.contains(active));
  const {clusters=[],analysis,input,market,selected,history,windowId}=props,prefs=preferences(props.marketName),F=market?.underlyingPrice;
  const contract=market?.underlyingCode??input?.contract;
  const viewIdentity=contract?`${contract}:${props.replay?'replay':'live'}`:null;
  if(viewIdentity&&viewIdentity!==prefs.viewIdentity){
    clearStrikeFocus(prefs);
    prefs.viewIdentity=viewIdentity;
    resetChartView(prefs);
  }
  if(!prefs.initialWindow&&windowId){prefs.window=windowId;prefs.initialWindow=true;}
  const key=[input,analysis,prefs.ivScale,prefs.expiryScope,prefs.elapsedMinutes,clusters.map(c=>`${c.key}:${c.rows.length}`).join(',')];
  if(!cache||cache.key.some((v,i)=>v!==key[i])){
    const lenses=input&&analysis?clusters.map(cluster=>{const result=createLevelLens({market:input,analysis,strike:cluster.strike,expectedRows:cluster.rows.length,ivScale:prefs.ivScale,expiryScope:prefs.expiryScope,elapsedMinutes:prefs.elapsedMinutes});return result?{...result,key:cluster.key,labels:cluster.level.labels}:null;}).filter(Boolean):[];
    cache={key,lenses:rankLevelLenses(lenses)};
  }
  const ranked=cache.lenses,lens=ranked.find(row=>row.key===selected)??ranked[0],top=ranked.find(row=>finite(row.sensitivity)&&row.sensitivity>0);
  const focused=ranked.find(row=>row.key===prefs.focusedKey);
  if(prefs.focusedKey&&!focused&&ranked.length)clearStrikeFocus(prefs);
  if(!focused&&!Object.hasOwn(cache,'overall'))cache.overall=buildOverallSensitivity(ranked,F);
  const regime=regimeReading(market?.watchContext,props.now);
  prefs.side=prefs.regimeMode==='auto'?(prefs.expiryScope==='all'?regime.side:null):prefs.regimeMode;
  const mapDate=market?.watchContext?.sourceDate??'not imported';
  const basis=ranked.some(row=>row.method==='reported-linear')?'modeled / local':'modeled';
  const quoteMs=Date.parse(market?.priceTimestamp??''),age=Number.isFinite(quoteMs)?Math.max(0,(props.now-quoteMs)/60000):null;
  const scopeStale=!props.replay&&market?.watchContext?.status==='stale';
  if(focused&&prefs.deltaStrikeKey===focused.key){
    prefs.deltaSeriesByStrike??={};
    if(!Object.hasOwn(prefs.deltaSeriesByStrike,focused.key)&&focused.deltaSeries?.length)prefs.deltaSeriesByStrike[focused.key]=focused.deltaSeries[0].id;
  }
  let expiryComparison=null;
  if(prefs.compareOpen&&input&&analysis&&focused){
    const comparisonKey=[input,analysis,focused.strike,prefs.ivScale,prefs.elapsedMinutes,clusters.find(c=>c.key===focused.key)?.rows.length];
    if(!comparisonCache||comparisonCache.key.some((value,index)=>value!==comparisonKey[index]))comparisonCache={key:comparisonKey,value:compareExpirySensitivity({market:input,analysis,strike:focused.strike,expectedRows:comparisonKey[5],ivScale:prefs.ivScale,elapsedMinutes:prefs.elapsedMinutes})};
    expiryComparison=comparisonCache.value;
  }
  const reading=renderMarketReading({lenses:ranked,market,now:props.now,prefs,regime,selectedKey:focused?.key??lens?.key,focusedKey:focused?.key??null,overallProfile:cache.overall,expiryComparison,expiryDate:props.expiryDate,sessionComparison:props.history?.profile?.sessions});
  root.innerHTML=`${props.replay?'<div class="replay-lens-banner">Historical replay · source dates and quote clocks shown below belong to this saved capture. Live quote cards above remain separate.</div>':''}${reading.html}<div class="lens-heading"><div><h2>Strike detail</h2><p>Calls and puts combined · selected expiries.${prefs.ivScale!==1?` Curve and ranking use ${fmt(prefs.ivScale*100,0)}% of snapshot IV.`:''}</p></div></div>
    <div class="lens-evidence"><span>Futures quote ${age===null?'time unknown':`${fmt(age,0)} min old`} · option inputs may be older</span><span class="${scopeStale?'lens-amber':''}">MenthorQ map: ${esc(mapDate)}${scopeStale?' · update this map':''}</span></div>
    <div class="lens-summary" hidden><div><span>STRONGEST AT THE SAVED PRICE</span><strong>${top?fmt(top.strike,2):'Inputs needed'}</strong><p>${top?`${fmt(top.shareOfWatched*100)}% of ${basis} watched sensitivity${top.complete?'':' · partial coverage'}`:'Import the current map and fetch its option snapshots.'}</p></div><div><span>SELECTED LEVEL · ${lens?fmt(lens.strike,2):'—'}</span><strong>${lens?.profile?fmt(lens.profile.ratio*100)+'% of peak':lens?.method==='reported-linear'?fmt(lens.sensitivity,3)+' equivalent futures / point':'Fade unavailable'}</strong><p>${lens?.profile?`${fmt((1-lens.profile.ratio)*100)}% below its own modeled peak. ${lens.profile.strengthens==='up'?'Rising':'Falling'} prices increase sensitivity locally.`:lens?.method==='reported-linear'?'Reported local sensitivity only. Fade distance needs exact expiry clocks.':'Exact model inputs are needed for distance calculations.'}</p></div><div><span>SELECTED LEVEL · +${fmt(prefs.move,3)} POINT MOVE</span><strong>${lens?.flow?direction(lens.flow(F+prefs.move,prefs.side,prefs.share)?.change)+' '+fmt(Math.abs(lens.flow(F+prefs.move,prefs.side,prefs.share)?.change)):'Inputs needed'}</strong><p>Equivalent futures · ${fmt(prefs.share*100,0)}% OI / ${prefs.side}-gamma scenario. Actual dealer inventory is unknown.</p></div></div>
    <div class="lens-toolbar" hidden><div class="lens-sides" role="group" aria-label="Assumed dealer gamma side"><button data-lens-side="short" aria-pressed="${prefs.side==='short'}">Assume short gamma</button><button data-lens-side="long" aria-pressed="${prefs.side==='long'}">Assume long gamma</button></div><p>${prefs.side==='short'?'Buy into rises · sell into falls':'Sell into rises · buy into falls'} <span>· fixed-IV direction; actual dealer flow unknown</span></p></div>
    <div class="lens-layout"><section class="lens-level-list" aria-label="Watched strikes ranked by modeled sensitivity"><div class="lens-list-head"><h3>Watchlist</h3><span>Strongest first</span></div>${ranked.length?ranked.map(row=>`<button class="lens-level ${row.key===lens?.key?'selected':''}" data-lens-strike="${esc(row.key)}" aria-pressed="${row.key===lens?.key}"><span class="lens-level-top"><strong>${fmt(row.strike,2)}</strong><span class="lens-peak-value">${row.profile?`${fmt(row.profile.ratio*100)}%<small>of own peak</small>`:'Peak unknown'}</span></span>${expiryBadges(row,row.labels)}<span class="lens-level-meta">${esc(row.labels.join(' · '))} · ${fmt(Math.abs(row.strike-F),2)} pts ${row.strike>=F?'above':'below'}</span>${row.profile?`<span class="lens-meter"><i style="width:${Math.max(0,Math.min(100,row.profile.ratio*100))}%"></i></span>`:''}<span class="lens-level-foot">${row.profile?`${fmt((1-row.profile.ratio)*100)}% faded from peak`:'Model inputs incomplete'} <b>${row.profile?'At snapshot price':'Fade unknown'}</b></span>${!row.complete?`<span class="lens-partial">${row.localRows??row.modeledRows} ${row.method==='reported-linear'?'reported':'modeled'} · ${row.excludedRows} excluded active / unknown series</span>`:''}</button>`).join(''):'<div class="lens-empty">Your watched levels will appear here once a matching map and option snapshot are available.</div>'}</section>
    <section class="lens-focus" aria-label="Selected strike interpretation">${lens?detail(lens,prefs,props):'<div class="lens-empty">Choose a watched level to explore its distance and hedge response.</div>'}</section></div>
    <details class="lens-method"><summary>What do these numbers mean?</summary><div><p><b>OI-scaled potential:</b> the figures assume the selected dealer side holds ${fmt(prefs.share*100,0)}% of the included open interest and hedges it entirely in the matching future. This is a scenario size, not a measured or expected dealer trade. Offset positions, partial ownership and other hedges can make real flow much smaller or opposite.</p><p><b>Two strength measures:</b> The watchlist ranks strikes by absolute included sensitivity. Its percentage and bar show how active each strike is relative to its own modeled peak; they do not compare absolute size across strikes. Neither is a percentage of the price move caused by hedging.</p><p><b>Fade distance:</b> we add OI-weighted gamma for the eligible calls and puts at this strike across the selected expiries. Bands show where that combined sensitivity falls to 50%, 25% and 10% of its own peak. IV and the selected model clock are held fixed; there is no automatic reversal at a band.</p><p><b>No TradingView indicator required.</b> This site calculates the scenarios from Futu snapshots. Observing actual hedge flow or calibrating a price-impact forecast would additionally require dealer inventory evidence and synchronized futures trades / liquidity data. OHLC and total volume alone do not identify dealer impact.</p><p>Models: European Black-76 or American futures early-exercise model, chosen by contract style; ACT/365. Rate defaults to zero when unavailable, so the American futures model then has no early-exercise premium. Contract and expiry eligibility follow the verified source rules. <a href="https://www.cmegroup.com/education/courses/option-greeks/options-gamma-the-greeks.html" target="_blank" rel="noreferrer">CME: how gamma changes</a>.</p></div></details>`;
  if(props.replayRoot)root.querySelector?.('[data-reading-replay-slot]')?.appendChild(props.replayRoot);
  reading.bindProbe(root);
  if(!root._lensBound){root._lensBound=true;
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-lens-strike],[data-reading-overall],[data-reading-reset-chart],[data-compare-toggle],[data-reading-dex-toggle],[data-delta-hide],[data-lens-side],[data-lens-window],[data-lens-target],[data-lens-range],[data-lens-center],[data-lens-reset]');
      if(!button)return;
      const p=root._lensProps,s=preferences(p.marketName);
      if(button.hasAttribute('data-reading-dex-toggle')){
        s.showNetDex=s.showNetDex===false;
        renderLevelLens(root,p);
        root.querySelector('[data-reading-dex-toggle]')?.focus({preventScroll:true});
        return;
      }
      if(button.hasAttribute('data-reading-overall')){
        clearStrikeFocus(s);
        resetChartView(s);
        clearTimeout(root._lensRangeTimer);
        root._compareReveal=false;root._compareReturn=false;root._overallReturn=true;
        renderLevelLens(root,p);
        return;
      }
      if(button.hasAttribute('data-reading-reset-chart')){
        resetChartView(s);
        clearTimeout(root._lensRangeTimer);
        renderLevelLens(root,p,{resetView:true});
        return;
      }
      if(button.dataset.lensStrike){openStrike(root,button.dataset.lensStrike);return;}
      if(button.hasAttribute('data-compare-toggle')){
        const key=button.dataset.compareKey;
        s.compareOpen=!s.compareOpen&&!!key;
        if(s.compareOpen)s.focusedKey=key;
        root._compareReveal=s.compareOpen;root._compareReturn=!s.compareOpen;
      }
      if(button.hasAttribute('data-delta-hide'))s.deltaStrikeKey=null;
      if(button.dataset.lensSide){s.side=button.dataset.lensSide;s.regimeMode=s.side;}
      if(button.dataset.lensWindow)s.window=button.dataset.lensWindow;
      if(button.dataset.lensTarget)s.target=Number(button.dataset.lensTarget);
      if(button.dataset.lensRange){s.chartMove=Number(button.dataset.lensRange);s.chartCenter=null;}
      if(button.dataset.lensCenter)s.chartCenter=Number(button.dataset.lensCenter);
      if(button.hasAttribute('data-lens-reset')){s.target=null;s.ivScale=1;s.share=1;s.elapsedMinutes=0;}
      renderLevelLens(root,p);
    });
    root.addEventListener('change',event=>{const p=root._lensProps,s=preferences(p.marketName);if(event.target.hasAttribute('data-lens-regime')){s.regimeMode=event.target.value;renderLevelLens(root,p);return;}const field=event.target.dataset.lensField;if(!field)return;if(field==='deltaSeriesId'){s.deltaSeriesByStrike??={};s.deltaSeriesByStrike[s.deltaStrikeKey]=event.target.value;renderLevelLens(root,p);return;}if(field==='expiryScope'){if(['all','0dte','later'].includes(event.target.value)){s.expiryScope=event.target.value;s.chartProbe=null;renderLevelLens(root,p);}return;}const value=Number(event.target.value);if(!event.target.value.trim()||!finite(value)||!event.target.checkValidity()){event.target.reportValidity();return;}
      s[field]=field==='share'?value/100:value;renderLevelLens(root,p);
    });
    root.addEventListener('input',event=>{
      if(!['chartMove','chartCenter'].includes(event.target.dataset?.lensField))return;
      const value=Number(event.target.value);
      if(!event.target.value.trim()||!finite(value)||value<=0||!event.target.checkValidity())return;
      // Preserve a valid range immediately, even if a snapshot render replaces
      // the focused input before the browser can emit its blur/change event.
      preferences(root._lensProps.marketName)[event.target.dataset.lensField]=value;
      clearTimeout(root._lensRangeTimer);
      root._lensRangeTimer=setTimeout(()=>renderLevelLens(root,root._lensProps),180);
    });
    root.addEventListener('lens-strike-select',event=>openStrike(root,event.detail));
    root.addEventListener('keydown',event=>{if(!['Enter',' '].includes(event.key))return;const target=event.target.closest('[data-lens-strike]');if(target&&target.tagName?.toLowerCase()!=='button'){event.preventDefault();openStrike(root,target.dataset.lensStrike);}});
    root.addEventListener('toggle',event=>{if(event.target.matches('.lens-settings'))preferences(root._lensProps.marketName).advanced=event.target.open;},true);
  }
  if(editing){const field=root.querySelector?.(`[data-lens-field="${editing.field}"]`);if(field){field.value=editing.value;field.focus({preventScroll:true});}}
  if(focusedCurve){
    const button=[...root.querySelectorAll('.reading-legend button')].find(item=>item.dataset.lensStrike===focusedCurve);
    button?.focus({preventScroll:true});
  }
  if(focusedProbe)root.querySelector(focusedProbe)?.focus({preventScroll:true});
  const nextPlot=root.querySelector?.('.reading-chart-scroll');
  if(nextPlot&&finite(plotOffset))nextPlot.scrollLeft=plotOffset;
  if(plotFocused)nextPlot?.focus({preventScroll:true});
  if(resetView)root.querySelector?.('[data-reading-reset-chart]')?.focus?.({preventScroll:true});
  replayFocus?.focus({preventScroll:true});
  if(focusedLine)[...(root.querySelectorAll?.('.reading-strike-line')??[])].find(line=>line.dataset.lensStrike===focusedLine)?.focus({preventScroll:true});
  if(root._compareReveal){root._compareReveal=false;root.querySelector?.('[data-expiry-comparison]')?.scrollIntoView?.({block:'start',behavior:'instant'});}
  if(root._compareReturn){root._compareReturn=false;const control=root.querySelector?.('[data-compare-toggle]');control?.scrollIntoView?.({block:'nearest',behavior:'instant'});control?.focus?.({preventScroll:true});}
  if(root._overallReturn){root._overallReturn=false;root.querySelector?.('[data-reading-heading]')?.scrollIntoView?.({block:'start',behavior:'instant'});root.querySelector?.('[data-reading-overall]')?.focus?.({preventScroll:true});}
}

function detail(lens,s,props){
  const p=lens.profile,F=lens.price,partial=!lens.complete,scale=s.share;
  const up=lens.flow?.(F+s.move,s.side,scale),down=lens.flow?.(F-s.move,s.side,scale),target=s.target??lens.strike,flow=lens.flow?.(target,s.side,scale);
  const next=lens.slopeAt?.(target),sensitivityChange=positiveRatio(next,lens.sensitivity);
  const toward=F<lens.strike?'up':'down',awayTarget=Math.max(props.market?.tickSize??.000001,F+(toward==='up'?-s.move:s.move));
  const awayFlow=lens.flow?.(awayTarget,s.side,scale),backFlow=lens.flow?.(F,s.side,scale);
  const retrace=awayFlow&&backFlow?backFlow.after-awayFlow.after:null;
  const movement=price=>Math.abs(price-lens.strike)<Math.abs(F-lens.strike)?'toward level':'away from level';
  const half=p?.bands[0],active=p?p.ratio>=.5?'In the stronger sensitivity region':p.ratio>=.1?'Sensitivity is fading':'Low sensitivity versus its own peak':'Distance curve unavailable';
  const history=props.history?.profile,comparison=compareLevelHistory({profile:history,underlyingCode:props.market?.underlyingCode,windowId:s.window,flow:flow?.change});
  return `<div class="lens-focus-heading"><div><p class="eyebrow">SELECTED LEVEL · ${esc(lens.labels.join(' / '))}</p><h3>${fmt(lens.strike,2)} <span>${fmt(Math.abs(lens.strike-F),2)} pts ${lens.strike>=F?'above':'below'} price</span></h3></div><span class="lens-chip">${lens.localRows??lens.modeledRows} ${lens.method==='reported-linear'?'reported':'modeled'} series</span></div>
    ${expiryBadges(lens,lens.labels)}<div class="expiry-effects"><strong>${finite(lens.sensitivity)?fmt(lens.sensitivity,3):'—'} equivalent futures / point</strong><small>Unsigned Futu OI-scaled sensitivity · ${s.expiryScope==='0dte'?'0DTE subset':s.expiryScope==='later'?'later-expiry subset':'all selected expiries'}${s.elapsedMinutes?` · +${s.elapsedMinutes} min scenario`:' · snapshot clock'}${!lens.complete?' · partial coverage':''}. This is separate from MenthorQ’s planet score.</small></div><p class="lens-reading">${active}${p?` · <b>${fmt(p.ratio*100)}% of own peak</b>`:''}.</p>
    ${lens.americanStyle?`<details class="lens-model-details"><summary>Pricing model</summary><p class="lens-basis"><b>American-style options:</b> ${lens.americanApproximation?'European approximation selected.':'early-exercise model selected.'} ${p?(lens.numericalAmerican?'Gamma and fade bands are numerical estimates.':'The zero-rate assumption has no early-exercise premium in this futures model; results match the European limit.'):'The model is supported; this curve still needs eligible IV and a verified expiry clock.'}</p></details>`:''}
    <div class="lens-chart-heading"><span>${s.expiryScope==='0dte'?'0DTE':s.expiryScope==='later'?'Later-expiry':'Combined'} gamma sensitivity · % of own peak</span><span>● snapshot price <b>●</b> scenario target</span></div>${chart(lens,target)}
    <p class="lens-interpretation">${p?`Sensitivity strengthens toward ${p.strengthens==='up'?'higher':'lower'} prices near ${fmt(p.peakPrice,2)}. Holding IV fixed under the <b>${s.side??'unselected'}-gamma assumption</b>, ${s.side==='short'?'rises imply buying and falls imply selling':s.side==='long'?'rises imply selling and falls imply buying':'direction needs a gamma regime'}.`:'Eligible IV and exact expiry clocks are needed to model how sensitivity changes with distance.'} ${s.side==='short'?'If a fall reverses into a rise, the hedge response switches to buying; fading alone does not start the reversal.':s.side==='long'?'The assumed hedge response leans against the move; it does not guarantee the level will hold.':'Select a provider or hypothetical gamma regime above to evaluate the reaction.'}</p>
    ${partial?`<p class="lens-amber">Partial model: ${lens.modeledRows} series included; ${lens.excludedRows} active / unknown series excluded. Rankings, flows and bands describe this subset.</p>`:''}
    ${lens.method==='reported-linear'?`<p class="lens-amber">Local reported-Gamma approximation · ${lens.localRows} series. Keep the move within ${fmt(lens.maximumMove,3)} points; individual Delta bounds may limit it further. Exact expiry clocks are unavailable, so distance bands and IV repricing are withheld.</p>`:''}
    <div class="lens-flow-heading"><h4>Hedge scenarios</h4><label>Compare a move of <input aria-label="Price move in points" data-lens-field="move" type="number" min="${props.market?.tickSize??.01}" step="any" value="${s.move}"> points</label></div>
    <p class="lens-basis">${fmt(scale*100,0)}% OI scenario · ${s.side??'unselected'} gamma · ${fmt(s.ivScale*100,0)}% of snapshot IV${s.elapsedMinutes?` · +${s.elapsedMinutes} min; clock changes can override price-only direction`:''}${s.ivScale!==1?' · price + IV repricing; IV can override the price-only direction':''}${lens.americanApproximation?' · European approximation includes American options':''}</p>
    ${lens.horizonCrossesExpiry?'<p class="lens-amber">This time scenario reaches an included expiry. Hedge changes are withheld across settlement; expired curve components are removed.</p>':''}<div class="lens-flow-grid">${card(up,`+${fmt(s.move,3)} pts · ${movement(F+s.move)}`,F+s.move,partial)}${card(down,`−${fmt(s.move,3)} pts · ${movement(F-s.move)}`,F-s.move,partial)}</div>
    <p class="lens-retrace"><b>If price reverses back:</b> a move away to ${fmt(awayTarget,2)}, then a return to ${fmt(F,2)}, implies <b>${direction(retrace).toLowerCase()} ${fmt(Math.abs(retrace))} futures</b> on that return leg under the same assumption. Both endpoints use the same selected model clock; this does not simulate elapsed time along an away-and-back path. This measures a conditional hedge response, not the probability or size of a reversal.</p>
    ${flow&&s.elapsedMinutes>0?`<div class="expiry-effects"><strong>Finite hedge change · +${s.elapsedMinutes} min</strong><span>Price only ${sign(flow.priceOnly)} futures</span><span>Clock only ${sign(flow.timeOnly)} futures</span><span>IV only ${sign(flow.ivOnly)} futures</span><span>Interaction ${sign(flow.interaction)} futures</span><span>Combined ${sign(flow.change)} futures</span><small>Same inventory assumption; clock response is delta decay, not option-premium theta.</small></div>`:''}<div class="lens-target"><div><label>Explore a price <input aria-label="Scenario target price" data-lens-field="target" type="number" min=".000001" step="any" value="${target}"></label><button data-lens-target="${lens.strike}">At the strike</button><button data-lens-target="${awayTarget}">Move away</button></div><p><b>${direction(flow?.change)} ${fmt(Math.abs(flow?.change))} futures</b> over ${sign(target-F,3)} points. ${finite(sensitivityChange)?`Sensitivity at target: ${fmt(sensitivityChange*100,0)}% of its current value.`:''}</p>${s.ivScale!==1&&flow?`<small>Price-only change ${sign(flow.priceOnly)} · additional IV effect ${sign(flow.ivContribution)} futures. Both are model scenarios; with elapsed time selected the IV contribution is incremental after price and time.</small>`:''}${flow?`<small>Net hedge change: add long ${fmt(flow.longAdded)} · cover short ${fmt(flow.shortCovered)} · reduce long ${fmt(flow.longReduced)} · add short ${fmt(flow.shortAdded)}.</small>`:''}</div>
    <div class="lens-fade"><h4>Fade bands</h4><p>Prices where ${fmt(lens.strike,2)} retains each fraction of its own peak. Crossing the strike itself does not turn hedging off.</p><div>${[.5,.25,.1].map(fraction=>{const band=p?.bands.find(b=>b.fraction===fraction);return `<article><span>${fraction*100}% remains</span><strong>${fmt(band?.lower,2)} <small>to</small> ${fmt(band?.upper,2)}</strong><small>${band?`${fmt(Math.abs(lens.strike-band.lower),2)} below / ${fmt(Math.abs(band.upper-lens.strike),2)} above strike${band.disconnected?' · outer span; sensitivity dips inside':''}`:'Exact model inputs needed'}</small></article>`;}).join('')}</div></div>
    <details class="lens-settings"${s.advanced?' open':''}><summary>Adjust IV or the position assumption</summary><div><label>IV relative to snapshot<select data-lens-field="ivScale"><option value="0.8"${s.ivScale===.8?' selected':''}>80% · lower IV</option><option value="1"${s.ivScale===1?' selected':''}>100% · unchanged</option><option value="1.2"${s.ivScale===1.2?' selected':''}>120% · higher IV</option></select></label><label>Dealer inventory scenario · % of OI<input data-lens-field="share" type="number" min="0" max="100" step="any" value="${s.share*100}"></label><p>100% assigns all included OI to the chosen dealer side; 25% uses one quarter, so flow sizes divide by four. Futu does not tell us the true percentage. Leave 100% to compare the same OI-scaled potential across levels; do not read it as a measured position.</p><p>IV changes the width and height of the sensitivity curve. Lower IV generally concentrates near-expiry sensitivity more tightly around the strike.</p><button data-lens-reset>Reset assumptions</button></div></details>
    <details class="lens-history"><summary>Session comparison</summary><p>The history is context for the price move, not a conversion from contracts into points.</p><div class="lens-window-tabs">${(history?.windows??[]).map(w=>`<button data-lens-window="${esc(w.id)}" aria-pressed="${w.id===s.window}">${esc(w.label)}</button>`).join('')}</div>${comparison?`<div class="lens-history-metrics"><div><span>Typical range · ${esc(comparison.label)} NY</span><strong>${fmt(comparison.medianRangePoints)} pts</strong><small>${comparison.sampleCount} completed sessions</small></div><div><span>Your scenario distance / typical range</span><strong>${comparison.medianRangePoints>0?fmt(Math.abs(target-F)/comparison.medianRangePoints*100):'—'}%</strong><small>Distance comparison, not likelihood</small></div><div><span>Scenario flow / typical window volume</span><strong>${finite(comparison.flowShare)?fmt(comparison.flowShare*100,3)+'%':'Not calibrated'}</strong><small>${finite(comparison.flowShare)?'Total traded volume is not book depth':'Futures volume units not verified'}</small></div></div><small>${esc(comparison.firstSessionDate)} to ${esc(comparison.lastSessionDate)} · same dated future</small>`:'<p>Historical windows are loading or unavailable. The strike model remains usable on its own.</p>'}<p class="lens-impact-note"><b>Price impact: unavailable.</b> 100 contracts do not equal 100 points. Execution speed, resting liquidity, cancellations and opposing trades determine impact; the current data cannot measure that causal effect.</p></details>`;
}
function positiveRatio(a,b){return finite(a)&&finite(b)&&b>0?a/b:null;}
