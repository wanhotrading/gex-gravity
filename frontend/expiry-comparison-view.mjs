import {sampleExpiryComparison} from '../core/expiry-comparison.mjs';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const f=(value,digits=2)=>finite(value)?value.toLocaleString('en-US',{maximumFractionDigits:digits}):'Unavailable';
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>Number.isFinite(Date.parse(value??''))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value))+' NY':'unverified';
const PLOT={W:520,H:270,L:76,R:24,T:34,B:49},STEPS=1000;
const percent=value=>finite(value)?f(value*100,2)+'%':'Unavailable';
const ownPeak=(value,ratio)=>finite(ratio)?percent(ratio)+' of own peak':value===0?'No active curve':'Own peak unavailable';
const referenceChange=(value,reference)=>!finite(value)||!finite(reference)?'Change unavailable':reference>0?`${value>=reference?'+':'−'}${f(Math.abs(value/reference-1)*100,1)}% vs reference`:value===0?'No change from reference':'Reference is zero';

function comparisonPlot(data,shape){
  const c=data.chart;if(!c)return '';
  const {W,H,L,R,T,B}=PLOT;
  const x=price=>L+(price-c.lo)/(c.hi-c.lo)*(W-L-R);
  const y=value=>H-B-value*(H-B-T);
  const scale=shape?1:c.overallPeak;
  const value=(p,key)=>shape?p[key]/(key==='overall'?c.overallPeak:c.zeroDtePeak):p[key]/scale;
  const path=key=>c.points.map((p,index)=>`${index?'L':'M'}${x(p.price).toFixed(2)},${y(value(p,key)).toFixed(2)}`).join(' ');
  const zeroVisible=finite(data.zeroDte.sensitivity)&&(!shape||c.zeroDtePeak>0);
  const title=shape?'Shape · each curve’s own peak':'Size · same absolute scale';
  const sample=sampleExpiryComparison(data,c.snapshotPrice);
  return `<article class="expiry-plot" data-compare-plot="${shape?'shape':'size'}"><h5>${title}</h5><p>${shape?'Compare build and fade distances.':'Compare OI-scaled sensitivity across price.'}</p><div class="expiry-plot-scroll" tabindex="0" aria-label="${shape?'Curve shape':'Absolute sensitivity'} chart; scroll horizontally on small screens"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}. Strike ${f(data.strike)}. Overall is mint and solid. 0DTE is gold and dashed. ${shape?'Each curve is normalized separately; equal heights do not mean equal quantities.':'Both curves use the same futures-per-point units.'} Use the shared price slider for keyboard exploration.">
    <rect x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" rx="6" fill="#08111e"/>
    ${[0,.5,1].map(n=>`<line x1="${L}" x2="${W-R}" y1="${y(n)}" y2="${y(n)}" stroke="#2d3c50"/><text x="${L-9}" y="${y(n)+5}" text-anchor="end">${shape?f(n*100,0)+'%':f(n*scale,scale<10?2:0)}</text>`).join('')}
    <line x1="${x(c.snapshotPrice)}" x2="${x(c.snapshotPrice)}" y1="${T}" y2="${H-B}" stroke="#e4ebf5" stroke-opacity=".5" stroke-dasharray="3 5"/>
    <path d="${path('overall')}" fill="none" stroke="#98f5e1" stroke-width="2.6"/>
    ${zeroVisible?`<path d="${path('zeroDte')}" fill="none" stroke="#ffc68f" stroke-width="2.6" stroke-dasharray="7 5"/>`:''}
    <g class="expiry-compare-markers" pointer-events="none"><line data-compare-cursor x1="${x(c.snapshotPrice)}" x2="${x(c.snapshotPrice)}" y1="${T}" y2="${H-B}" stroke="#ffd18a" stroke-width="1.6" visibility="hidden"/>
    ${['overall','zeroDte'].map(key=>`<circle data-compare-dot="${key}" cx="${x(c.snapshotPrice)}" cy="${y(key==='overall'?sample.overallRatio:shape?sample.zeroDteRatio:sample.zeroDte/c.overallPeak)}" r="4.5" fill="${key==='overall'?'#98f5e1':'#ffc68f'}" stroke="#08111e" stroke-width="1.8"${key==='zeroDte'&&!zeroVisible?' visibility="hidden"':''}/>`).join('')}</g>
    <text data-compare-plot-label x="${Math.max(L+85,Math.min(W-R-85,x(c.snapshotPrice)))}" y="20" text-anchor="middle">Reference ${f(c.snapshotPrice)}</text>
    ${[0,.5,1].map(n=>{const price=c.lo+(c.hi-c.lo)*n;return `<text x="${x(price)}" y="${H-24}" text-anchor="middle">${f(price)}</text>`;}).join('')}
    <text x="${(L+W-R)/2}" y="${H-3}" text-anchor="middle">Futures price</text><rect data-compare-hit x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" fill="transparent" aria-hidden="true"/></svg></div>
    <small>${shape?'Own-peak percentages describe shape; use the size chart and share above to judge magnitude.':'Unsigned equivalent futures per price point under 100% of included OI. Actual dealer ownership is unknown.'}</small></article>`;
}

export function renderExpiryComparison(data,market,{showOverallReset=false}={}){
  if(!data)return '';
  const unit=market?.underlyingCode?.startsWith('US.CL')?'equivalent futures per $1/bbl move':'equivalent futures per 1-point move';
  const partial=!data.overall.complete||!data.zeroDte.complete;
  const transition=(row,kind)=>{const t=row.transitions.find(t=>t.kind===kind);return t?f(t.price):'Unavailable';};
  const expired=data.zeroDte.scenarioExpiredRows>0;
  const reference=data.chart?sampleExpiryComparison(data,data.chart.snapshotPrice):null;
  return `<section class="expiry-comparison" id="expiry-comparison-panel" data-expiry-comparison data-compare-strike="${e(data.strike)}" aria-label="0DTE versus all expiries at the selected strike">
    <div class="expiry-compare-heading"><div><span>SELECTED STRIKE · ${f(data.strike)}</span><h4>0DTE vs all expiries</h4><p>${e(data.contract)} · same strike, price, IV and model clock</p></div><div class="expiry-compare-actions">${showOverallReset?'<button type="button" data-reading-overall>Back to all strikes</button>':''}<button type="button" data-compare-toggle aria-label="Hide expiry comparison">Hide comparison</button></div></div>
    ${data.chart?`<div class="expiry-compare-probe"><label for="expiry-comparison-price">Explore a shared price <output for="expiry-comparison-price" data-compare-price>${f(data.chart.snapshotPrice)}</output></label><input id="expiry-comparison-price" type="range" min="0" max="${STEPS}" step="1" value="${Math.round((data.chart.snapshotPrice-data.chart.lo)/(data.chart.hi-data.chart.lo)*STEPS)}" data-compare-slider aria-label="Comparison futures price" aria-valuetext="${f(data.chart.snapshotPrice)} · reference price"><button type="button" data-compare-reset>Back to reference</button><p data-compare-status>Reference price · ${f(data.chart.snapshotPrice)} · fixed IV and model clock</p></div>`:''}
    <div class="expiry-compare-metrics"><div><span>Overall potential · <b data-compare-price-kind>reference price</b></span><strong data-compare-overall>${f(data.overall.sensitivity,3)}</strong><small>${unit}</small>${reference?`<small data-compare-overall-ratio>${ownPeak(reference.overall,reference.overallRatio)}</small><small data-compare-overall-change>At reference price</small>`:''}</div><div><span>0DTE potential · <b data-compare-price-kind>reference price</b></span><strong data-compare-zero>${f(data.zeroDte.sensitivity,3)}</strong><small>${unit}</small>${reference?`<small data-compare-zero-ratio>${ownPeak(reference.zeroDte,reference.zeroDteRatio)}</small><small data-compare-zero-change>At reference price</small>`:''}</div><div><span>0DTE share of included overall</span><strong data-compare-share>${percent(data.zeroDteShare)}</strong><small>${partial?'Partial inputs · excluded rows listed below':'Eligible loaded inputs'}</small></div></div>
    <div class="expiry-compare-legend"><span><i></i>Overall · solid</span><span><i></i>0DTE · dashed</span></div>
    ${data.chart?`<p class="expiry-compare-help">Hover or tap either chart, or move the shared slider. Both charts follow the same price.</p><p class="expiry-compare-mobile-hint">Swipe charts and the table sideways for the full range.</p><div class="expiry-compare-plots">${comparisonPlot(data,false)}${comparisonPlot(data,true)}</div>`:'<p class="expiry-compare-empty">A comparison curve needs eligible IV, open interest and mapped expiry clocks. Available values and missing coverage are listed below.</p>'}
    <div class="expiry-compare-table" tabindex="0" aria-label="Expiry comparison values; scroll horizontally on small screens"><table><thead><tr><th scope="col">View</th><th scope="col">Fastest build price</th><th scope="col">Fastest fade price</th><th scope="col">Model coverage</th></tr></thead><tbody>${[['Overall',data.overall],['0DTE',data.zeroDte]].map(([label,row])=>`<tr><th scope="row">${label}</th><td>${transition(row,'build')}</td><td>${transition(row,'fade')}</td><td>${row.modeledRows} modeled · ${row.excludedRows} excluded</td></tr>`).join('')}</tbody></table></div>
    <p class="expiry-compare-notes">Model clock ${e(stamp(data.asOf))}${data.elapsedMinutes?' + '+f(data.elapsedMinutes,0)+' min scenario':''} · IV ${f(data.ivScale*100,0)}% of snapshot. Overall includes eligible loaded expiries for this futures month. 0DTE uses the snapshot’s New York expiry date.${data.unresolvedExpiryRows?' '+data.unresolvedExpiryRows+' series have unresolved expiry clocks.':''}${expired?' '+data.zeroDte.scenarioExpiredRows+' included 0DTE series expire within the selected time scenario; settlement hedge trades remain unknown.':''} Values between sampled prices are interpolated. Missing values stay unavailable. Build/fade mark the fastest changes in gamma sensitivity; actual flow and the 0DTE dealer gamma sign remain unknown.</p>
  </section>`;
}

/** Link both plots and the accessible slider without rerendering on every pointer move. */
export function bindExpiryComparison(root,data,prefs={}){
  const panel=root.querySelector?.('[data-expiry-comparison]'),chart=data?.chart;
  const slider=panel?.querySelector('[data-compare-slider]'),reset=panel?.querySelector('[data-compare-reset]');
  if(!chart||!slider||!reset)return;
  const span=chart.hi-chart.lo,reference=sampleExpiryComparison(data,chart.snapshotPrice);
  if(!reference||!(span>0))return;
  const {W,H,L,R,T,B}=PLOT,plots=[...panel.querySelectorAll('[data-compare-plot]')];
  const write=(selector,value)=>{const node=panel.querySelector(selector);if(node)node.textContent=value;};
  const showPrice=price=>{
    const point=sampleExpiryComparison(data,price);if(!point)return;
    const atReference=Math.abs(point.price-chart.snapshotPrice)<1e-8;
    prefs.comparisonProbe=atReference?null:{contract:data.contract,strike:data.strike,price:point.price};
    slider.value=String(Math.round((point.price-chart.lo)/span*STEPS));
    slider.setAttribute('aria-valuetext',`${f(point.price)} · ${atReference?'reference price':'price scenario'}`);
    write('[data-compare-price]',f(point.price));
    write('[data-compare-status]',atReference?`Reference price · ${f(chart.snapshotPrice)} · fixed IV and model clock`:`Price scenario · ${point.price>=chart.snapshotPrice?'+':'−'}${f(Math.abs(point.price-chart.snapshotPrice))} from reference ${f(chart.snapshotPrice)} · fixed IV and model clock`);
    for(const node of panel.querySelectorAll('[data-compare-price-kind]'))node.textContent=atReference?'reference price':'explored price';
    write('[data-compare-overall]',f(point.overall,3));write('[data-compare-zero]',f(point.zeroDte,3));write('[data-compare-share]',percent(point.zeroDteShare));
    for(const [key,selector] of [['overall','overall'],['zeroDte','zero']]){
      write(`[data-compare-${selector}-ratio]`,ownPeak(point[key],point[key+'Ratio']));
      write(`[data-compare-${selector}-change]`,atReference?'At reference price':referenceChange(point[key],reference[key]));
    }
    const x=L+(point.price-chart.lo)/span*(W-L-R);
    for(const plot of plots){
      const shape=plot.dataset.comparePlot==='shape',cursor=plot.querySelector('[data-compare-cursor]');
      cursor?.setAttribute('x1',x);cursor?.setAttribute('x2',x);cursor?.setAttribute('visibility',atReference?'hidden':'visible');
      const label=plot.querySelector('[data-compare-plot-label]');
      if(label){label.textContent=`${atReference?'Reference':'Explore'} ${f(point.price)}`;label.setAttribute('x',Math.max(L+85,Math.min(W-R-85,x)));}
      for(const key of ['overall','zeroDte']){
        const dot=plot.querySelector(`[data-compare-dot="${key}"]`),ratio=shape?point[key+'Ratio']:finite(point[key])?point[key]/chart.overallPeak:null;
        dot?.setAttribute('visibility',finite(ratio)?'visible':'hidden');
        if(finite(ratio)){dot?.setAttribute('cx',x);dot?.setAttribute('cy',H-B-ratio*(H-B-T));}
      }
    }
  };
  for(const plot of plots){
    const hit=plot.querySelector('[data-compare-hit]');if(!hit)continue;
    const pointAt=clientX=>{const bounds=hit.getBoundingClientRect();if(bounds.width>0&&finite(clientX))showPrice(chart.lo+Math.max(0,Math.min(1,(clientX-bounds.left)/bounds.width))*span);};
    hit.addEventListener('pointermove',event=>{if(event.pointerType!=='touch')pointAt(event.clientX);});
    // Native clicks include touch taps; leaving touch moves alone preserves swipe scrolling.
    hit.addEventListener('click',event=>pointAt(event.clientX));
  }
  slider.addEventListener('input',()=>showPrice(chart.lo+Number(slider.value)/STEPS*span));
  reset.addEventListener('click',()=>showPrice(chart.snapshotPrice));
  const saved=prefs.comparisonProbe;
  showPrice(saved?.contract===data.contract&&saved?.strike===data.strike&&finite(saved.price)?saved.price:chart.snapshotPrice);
}
