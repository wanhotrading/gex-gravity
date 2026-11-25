import {buildIvSurface, compareSurfacePoint, surfaceReadings} from '../core/iv-surface.mjs';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const fmt = (x,d=2) => finite(x)?x.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
const signed = x => finite(x)?`${x>0?'+':''}${fmt(x)}`:'—';
const esc = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = x => Number.isFinite(Date.parse(x??''))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(x))+' NY':'Unknown';
const expiryLabel = x => clock(x);
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const pointsAttr = points => points.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
const line = (a,b,cls='iv-grid') => `<line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
const label = (p,text,anchor='middle',cls='') => `<text class="${cls}" x="${p.x}" y="${p.y}" text-anchor="${anchor}">${esc(text)}</text>`;
export function projectIvPoint(x,y,z,{angle=-23,tilt=39}={}) {
  const a=angle*Math.PI/180;
  return {x:450+x*Math.cos(a)+y*Math.sin(a),y:350+(-x*Math.sin(a)+y*Math.cos(a))*tilt/80-z,depth:-x*Math.sin(a)+y*Math.cos(a)};
}
function chart(surface, selected, s) {
  if (!surface.points.length) return '<div class="iv-empty">No eligible IV points in this view. Try “Include older quotes” to inspect the dated reference, or wait for a compatible chain capture. No surface is invented.</div>';
  const points=surface.points.map(p=>({...p,comparison:compareSurfacePoint(surface,p,s.baseline)}));
  const value=p=>s.mode==='change'?p.comparison.change:p.iv*100;
  const visible=points.filter(p=>finite(value(p)));
  if (!visible.length) return '<div class="iv-empty">A change surface needs a pinned earlier view and newer quotes for the same option contracts. Pin a view, then move replay forward or let a newer saved observation arrive.</div>';
  const lo=Math.min(...surface.strikes),hi=Math.max(...surface.strikes),span=hi-lo||Math.max(1,lo*.02);
  const maxDays=Math.max(...surface.points.map(p=>p.days));
  const values=visible.map(value),bound=Math.max(.1,...values.map(Math.abs));
  const zMin=s.mode==='change'?-bound:Math.max(0,Math.min(...values)-Math.max(1,(Math.max(...values)-Math.min(...values))*.12));
  const zMax=s.mode==='change'?bound:Math.max(...values)+Math.max(1,(Math.max(...values)-Math.min(...values))*.12);
  const X=k=>(k-(lo+hi)/2)/span*570;
  const Y=d=>120-240*Math.log1p(d*24)/Math.max(.001,Math.log1p(maxDays*24));
  const Z=v=>(v-zMin)/(zMax-zMin)*195;
  const project=(k,d,v=zMin)=>projectIvPoint(X(k),Y(d),Z(v),s);
  const base=(x,y)=>projectIvPoint(x,y,0,s);
  const color=v=>s.mode==='change'?(v>=0?'#f1bb8c':'#85decb'):`hsl(${170+100*(v-zMin)/(zMax-zMin)} 62% 68%)`;
  const floor=[base(-285,-120),base(285,-120),base(285,120),base(-285,120)];
  const byCell=new Map(visible.map(p=>[p.expiry+'|'+p.strike,p])),cells=[];
  for(let e=1;e<surface.expiries.length;e++)for(let k=1;k<surface.strikes.length;k++){
    const corners=[[e-1,k-1],[e-1,k],[e,k],[e,k-1]].map(([ei,ki])=>byCell.get(surface.expiries[ei]+'|'+surface.strikes[ki]));
    if(corners.some(p=>!p))continue;
    const vertices=corners.map(p=>project(p.strike,p.days,value(p))),v=corners.reduce((n,p)=>n+value(p),0)/4;
    cells.push({depth:vertices.reduce((n,p)=>n+p.depth,0)/4,html:`<polygon points="${pointsAttr(vertices)}" fill="${color(v)}" fill-opacity=".2" stroke="${color(v)}" stroke-opacity=".27" stroke-width=".6"/>`});
  }
  let geometry=cells.sort((a,b)=>a.depth-b.depth).map(c=>c.html).join('');
  for(const expiry of surface.expiries){
    const group=visible.filter(p=>p.expiry===expiry),active=expiry===selected?.expiry;
    for(let i=1;i<group.length;i++){
      const a=group[i-1],b=group[i];
      if(surface.strikes.indexOf(b.strike)-surface.strikes.indexOf(a.strike)!==1)continue;
      geometry+=`<line x1="${project(a.strike,a.days,value(a)).x}" y1="${project(a.strike,a.days,value(a)).y}" x2="${project(b.strike,b.days,value(b)).x}" y2="${project(b.strike,b.days,value(b)).y}" stroke="${active?'#f3f5ff':color(value(a))}" stroke-opacity="${active?'.9':'.48'}" stroke-width="${active?'2':'1'}"/>`;
    }
  }
  const sampleStrikes=[lo,(lo+hi)/2,hi],sampleDays=[0,maxDays*.1,maxDays*.4,maxDays];
  const priceInside=surface.price>=lo&&surface.price<=hi;
  const pricePlane=priceInside?`<polygon points="${pointsAttr([project(surface.price,0),project(surface.price,maxDays),project(surface.price,maxDays,zMax),project(surface.price,0,zMax)])}" fill="#fff" fill-opacity=".025"/>${line(project(surface.price,0),project(surface.price,maxDays),'iv-price-line')}${label({...project(surface.price,0),y:project(surface.price,0).y+47},'F '+fmt(surface.price),'middle','iv-price-label')}`:'';
  const dotPoints=visible.map(p=>({p,v:project(p.strike,p.days,value(p))})).sort((a,b)=>a.v.depth-b.v.depth);
  const dots=dotPoints.map(({p,v})=>`<circle data-iv-point="${esc(p.code)}" cx="${v.x}" cy="${v.y}" r="${p.code===selected?.code?6:3.2}" fill="${p.code===selected?.code?'#fff':p.older?'#edba83':color(value(p))}" class="iv-point"><title>${esc(`${p.optionType} ${fmt(p.strike)} · ${expiryLabel(p.expiry)} · ${fmt(p.iv*100)}% IV · quote ${clock(p.quoteTimestamp)}`)}</title></circle>`).join('');
  const chosen=dotPoints.find(p=>p.p.code===selected?.code);
  const marker=chosen?`${line(project(chosen.p.strike,chosen.p.days),chosen.v,'iv-marker-line')}<circle cx="${chosen.v.x}" cy="${chosen.v.y}" r="11" fill="none" stroke="#fff" stroke-opacity=".55"/>${label({x:chosen.v.x+15,y:chosen.v.y-16},`${fmt(chosen.p.strike)} · ${s.mode==='change'?signed(value(chosen.p))+' vol pts':fmt(chosen.p.iv*100)+'%'}`,'start','iv-marker-label')}`:'';
  return `<svg class="iv-surface-svg" viewBox="0 0 900 530" role="img" aria-label="Observed implied volatility surface. Strike runs across, expiry runs into depth with log time spacing, and ${s.mode==='change'?'change in IV':'IV'} runs vertically. Use the expiry and strike controls to select an accessible marker.">
    <polygon points="${pointsAttr(floor)}" fill="#07121f" fill-opacity=".5" stroke="#c3d6e8" stroke-opacity=".17"/>
    ${sampleStrikes.map(k=>line(project(k,0),project(k,maxDays))+label({...project(k,0),y:project(k,0).y+22},fmt(k))).join('')}
    ${sampleDays.map(d=>line(project(lo,d),project(hi,d))+label({...project(hi,d),x:project(hi,d).x+12},d<1?fmt(d*24,1)+'h':fmt(d,1)+'d','start')).join('')}
    ${[zMin,(zMin+zMax)/2,zMax].map(v=>line(project(lo,maxDays,v),project(hi,maxDays,v))+label({...project(lo,maxDays,v),x:project(lo,maxDays,v).x-12},fmt(v,1)+(s.mode==='change'?'':'%'),'end')).join('')}
    ${line(project(lo,maxDays),project(lo,maxDays,zMax),'iv-axis')}${pricePlane}${geometry}${dots}${marker}
    ${label({x:450,y:511},'Strike price')}${label({x:24,y:36},s.mode==='change'?'IV change · vol points':'Implied volatility · %','start','iv-axis-title')}
    ${label({x:875,y:505},'Expiry · log time spacing','end','iv-axis-title')}
  </svg>`;
}
function slice(surface,selected,baseline){
  if(!selected)return '';
  const points=surface.points.filter(p=>p.expiry===selected.expiry),prior=new Map((baseline?.contract===surface.contract?baseline.points:[]).map(p=>[p.code,p]));
  const safeBaseline=Date.parse(baseline?.capturedAt??baseline?.asOf)<=Date.parse(surface.capturedAt??surface.asOf);
  const old=points.filter(p=>safeBaseline&&prior.has(p.code)).map(p=>({...p,iv:prior.get(p.code).iv}));
  const lo=Math.min(...points.map(p=>p.strike)),hi=Math.max(...points.map(p=>p.strike)),ivs=[...points,...old].map(p=>p.iv*100);
  const min=Math.min(...ivs)-1,max=Math.max(...ivs)+1;
  const x=k=>48+(k-lo)/(hi-lo||1)*620,y=iv=>168-(iv*100-min)/(max-min)*125;
  const path=list=>list.map((p,i)=>`${i?'L':'M'}${x(p.strike)},${y(p.iv)}`).join(' ');
  return `<svg class="iv-slice" viewBox="0 0 720 210" role="img" aria-label="Selected expiry skew. Solid line is the selected view. Dashed line is the pinned view when matched.">${[min,(min+max)/2,max].map(v=>`<line class="iv-grid" x1="48" y1="${y(v/100)}" x2="668" y2="${y(v/100)}"/>${label({x:40,y:y(v/100)+4},fmt(v,1)+'%','end')}`).join('')}${old.length>1?`<path d="${path(old)}" class="iv-prior-path"/>`:''}<path d="${path(points)}" class="iv-current-path"/>${surface.price>=lo&&surface.price<=hi?`<line class="iv-price-line" x1="${x(surface.price)}" y1="25" x2="${x(surface.price)}" y2="175"/>`:''}<circle cx="${x(selected.strike)}" cy="${y(selected.iv)}" r="5" fill="#fff"/>${[lo,(lo+hi)/2,hi].map(k=>label({x:x(k),y:198},fmt(k))).join('')}</svg>`;
}
function history(point){
  const rows=point?.history??[];
  if(rows.length<2)return '<p class="iv-small">No earlier IV observation saved for this exact option.</p>';
  const a=Date.parse(rows[0].quoteTimestamp),b=Date.parse(rows.at(-1).quoteTimestamp),low=Math.min(...rows.map(p=>p.iv)),high=Math.max(...rows.map(p=>p.iv));
  const path=rows.map((p,i)=>`${i?'L':'M'}${10+(Date.parse(p.quoteTimestamp)-a)/(b-a||1)*270},${58-(p.iv-low)/(high-low||.01)*43}`).join(' ');
  return `<p class="iv-small">Exact-series history · ${rows.length} source quotes</p><svg class="iv-history" viewBox="0 0 290 75" role="img" aria-label="Saved IV observations from ${esc(clock(rows[0].quoteTimestamp))} to ${esc(clock(rows.at(-1).quoteTimestamp))}"><path d="${path}" class="iv-current-path"/></svg><p class="iv-small">${esc(clock(rows[0].quoteTimestamp))} → ${esc(clock(rows.at(-1).quoteTimestamp))}</p>`;
}
export function renderIvSurface(root,props={}){
  if(!root)return;root._ivProps=props;
  const key=props.market?.underlyingCode??'none';root._ivStates??=new Map();
  if(!root._ivStates.has(key))root._ivStates.set(key,{side:'otm',mode:'iv',older:false,angle:-23,tilt:39,selectedCode:null,baseline:null});
  const s=root._ivStates.get(key),active=root.ownerDocument?.activeElement,focus=root.contains?.(active)?active?.dataset?.ivField:null;
  const surface=buildIvSurface({market:props.market,rows:props.rows,now:props.now,side:s.side,includeOlder:s.older});
  const matching=surface.points.filter(p=>p.strike===Number(props.selectedStrike));
  let selected=surface.points.find(p=>p.code===s.selectedCode);
  if(matching.length&&selected?.strike!==Number(props.selectedStrike))selected=matching.find(p=>p.expiry===selected?.expiry)??matching[0];
  selected??=surface.points.reduce((a,p)=>!a||Math.abs(p.strike-surface.price)<Math.abs(a.strike-surface.price)?p:a,null);
  s.selectedCode=selected?.code??null;
  const comparison=selected?compareSurfacePoint(surface,selected,s.baseline):null,metrics=selected?surfaceReadings(surface,selected.expiry):null;
  root._ivView={surface,selected,s};
  const shiftText=comparison?.status==='compared'?`${signed(comparison.change)} vol pts vs pinned quote`:comparison?.status==='no-newer-quote'?'No newer source quote':comparison?.status==='later-baseline'?'Pinned view is later than this replay':s.baseline?'No matching earlier option quote':'Pin a view to measure change';
  const detail=selected?`<p class="iv-eyebrow">SELECTED OPTION</p><h3>${fmt(selected.strike)} <span>${selected.optionType.toUpperCase()}</span></h3><p class="iv-value">${fmt(selected.iv*100)}<span>% IV</span></p><p class="iv-shift">${esc(shiftText)}</p><dl><div><dt>Expiry</dt><dd>${esc(expiryLabel(selected.expiry))}</dd></div><div><dt>Time at snapshot</dt><dd>${selected.days<1?fmt(selected.days*24,2)+' hours':fmt(selected.days,2)+' days'}</dd></div><div><dt>Strike vs future</dt><dd>${signed((selected.strike/surface.price-1)*100)}%</dd></div><div><dt>Quote clock</dt><dd>${esc(clock(selected.quoteTimestamp))}</dd></div></dl><p class="iv-small ${selected.older?'iv-older':''}">${selected.older?'Older reference · '+fmt(selected.quoteGapMinutes,0)+' min from future quote':'Within 15 min of the saved future quote'} · separate IV clock unverified</p>${history(selected)}`:'<p class="iv-small">Choose a valid expiry and strike when observations are available.</p>';
  root.innerHTML=`<section class="iv-observatory" aria-label="Implied volatility surface"><div class="iv-heading"><div><p class="iv-eyebrow">VOLATILITY OBSERVATORY</p><h2>The shape of uncertainty.</h2></div><p>${props.replay?'Historical replay':'Latest saved chain'}<br><span>${esc(surface.contract??'Select a future')} · ${esc(clock(surface.asOf))}</span></p></div>
    <div class="iv-toolbar"><label>Option side<select data-iv-field="side"><option value="otm" ${s.side==='otm'?'selected':''}>OTM puts + calls</option><option value="call" ${s.side==='call'?'selected':''}>Calls</option><option value="put" ${s.side==='put'?'selected':''}>Puts</option></select></label><label>Height<select data-iv-field="mode"><option value="iv" ${s.mode==='iv'?'selected':''}>Implied volatility</option><option value="change" ${s.mode==='change'?'selected':''}>Change vs pinned view</option></select></label><label>Expiry<select data-iv-field="expiry" ${selected?'':'disabled'}>${surface.expiries.map(e=>`<option value="${esc(e)}" ${e===selected?.expiry?'selected':''}>${esc(expiryLabel(e))}</option>`).join('')||'<option>No exact expiry</option>'}</select></label><label>Strike<select data-iv-field="strike" ${selected?'':'disabled'}>${surface.points.filter(p=>p.expiry===selected?.expiry).map(p=>`<option value="${esc(p.code)}" ${p.code===selected?.code?'selected':''}>${fmt(p.strike)} · ${p.optionType}</option>`).join('')||'<option>No IV point</option>'}</select></label></div>
    <div class="iv-layout"><div><div class="iv-scene" data-iv-scene>${chart(surface,selected,s)}</div><div class="iv-view-controls"><span>Drag to rotate · click a dot</span><label>Rotate<input type="range" min="-38" max="38" value="${s.angle}" data-iv-field="angle" aria-label="Rotate IV surface"></label><label>Tilt<input type="range" min="22" max="60" value="${s.tilt}" data-iv-field="tilt" aria-label="Tilt IV surface"></label><button type="button" data-iv-action="reset">Reset view</button></div></div><aside class="iv-inspector" aria-live="polite">${detail}</aside></div>
    <div class="iv-comparison"><button type="button" data-iv-action="pin" ${surface.points.length?'':'disabled'}>${s.baseline?'Replace pinned view':'Pin this view for comparison'}</button>${s.baseline?'<button type="button" data-iv-action="clear">Clear comparison</button>':''}<span>${s.baseline?'Pinned '+esc(clock(s.baseline.asOf))+' · this tab only':'Pin an earlier replay capture, then move the time bar forward.'}</span><label><input type="checkbox" data-iv-field="older" ${s.older?'checked':''}>Include older quotes</label></div>
    ${selected?`<div class="iv-slice-heading"><h3>One expiry. Read across the strikes.</h3><span>${esc(expiryLabel(selected.expiry))} · solid: selected view · dashed: pinned</span></div>${slice(surface,selected,s.baseline)}<div class="iv-readings"><div><span>ATM IV${metrics.atm?.interpolated?' · interpolated':''}</span><strong>${fmt(metrics.atm?.iv*100)}%</strong></div><div><span>−2% strike vs ATM</span><strong>${signed(metrics.downsidePremium)} <small>vol pts</small></strong></div><div><span>+2% strike vs ATM</span><strong>${signed(metrics.upsidePremium)} <small>vol pts</small></strong></div><div><span>Downside − upside IV</span><strong>${signed(metrics.wingDifference)} <small>vol pts</small></strong></div></div>`:''}
    <p class="iv-coverage">${surface.points.length} observed points · ${surface.expiries.length} expiries · watched strikes only. ${surface.points.some(p=>p.older)?surface.points.filter(p=>p.older).length+' older quotes included in amber; this view is not synchronized. ':''}${surface.counts.older?surface.counts.older+' older quotes excluded. ':''}${surface.counts.missing?surface.counts.missing+' rows lack IV, quote time or an exact expiry. ':''}Source delay unverified. Lines connect observations; missing mesh cells stay empty.</p>
    <details class="iv-guide"><summary>How to read the surface</summary><div><p><b>Across:</b> hold expiry fixed and compare strikes. Higher IV on the downside means downside options are relatively more expensive in volatility terms; it is not a measured probability of a fall.</p><p><b>Into the distance:</b> compare expiries. A front-end bump can be consistent with near-term event risk. It is not proof of a specific narrative. Expiry spacing is logarithmic so short maturities stay visible.</p><p><b>The white dot:</b> one exact strike, expiry and call or put. The dashed floor line is the saved futures price. A price alone has no unique IV without an expiry.</p><p><b>Over time:</b> pin a capture and move replay forward. The change surface uses the same option codes and strictly newer source quotes. Compare near-ATM level, wing premiums and front/back expiries; changing price also changes moneyness. Missing matches are not filled in.</p><p><b>Skew metrics:</b> the wing prices are 2% below and above the saved future. Metrics interpolate total variance between bracketing strikes at one expiry; there is no extrapolation. They are not 25-delta risk reversals. A vol point is an absolute IV change: 20% to 23% is +3 points.</p><p><b>Model limit:</b> this is an observed, sparse IV surface, not an arbitrage-free fit or a forecast of future IV. It does not change the existing fade/build engine or turn OI into signed dealer positions.</p></div></details></section>`;
  if(focus)root.querySelector?.(`[data-iv-field="${focus}"]`)?.focus();
  if(root._ivBound)return;root._ivBound=true;
  const redraw=()=>{const v=root._ivView,el=root.querySelector?.('[data-iv-scene]');if(el)el.innerHTML=chart(v.surface,v.selected,v.s);};
  const choose=code=>{const p=root._ivView.surface.points.find(p=>p.code===code);if(!p)return;root._ivView.s.selectedCode=code;root._ivProps={...root._ivProps,selectedStrike:String(p.strike)};root._ivProps.onSelect?.(String(p.strike),p.code);renderIvSurface(root,root._ivProps);};
  root.addEventListener('input',e=>{const field=e.target.dataset?.ivField;if(!['angle','tilt'].includes(field))return;root._ivView.s[field]=clamp(Number(e.target.value),field==='angle'?-38:22,field==='angle'?38:60);redraw();});
  root.addEventListener('change',e=>{
    const field=e.target.dataset?.ivField,v=root._ivView;if(!field||['angle','tilt'].includes(field))return;
    if(field==='strike'){choose(e.target.value);return;}
    if(field==='expiry'){const points=v.surface.points.filter(p=>p.expiry===e.target.value);const p=points.find(p=>p.strike===v.selected?.strike)??points.reduce((a,p)=>!a||Math.abs(p.strike-v.surface.price)<Math.abs(a.strike-v.surface.price)?p:a,null);if(p)choose(p.code);return;}
    if(field==='older')v.s.older=e.target.checked;
    if(field==='side'&&['otm','call','put'].includes(e.target.value))v.s.side=e.target.value;
    if(field==='mode'&&['iv','change'].includes(e.target.value))v.s.mode=e.target.value;
    renderIvSurface(root,root._ivProps);
  });
  root.addEventListener('click',e=>{
    if(root._ivIgnoreClick){root._ivIgnoreClick=false;return;}
    const point=e.target.closest?.('[data-iv-point]');if(point){choose(point.dataset.ivPoint);return;}
    const action=e.target.closest?.('[data-iv-action]')?.dataset.ivAction,s=root._ivView.s;
    if(action==='pin')s.baseline=JSON.parse(JSON.stringify(root._ivView.surface));
    if(action==='clear'){s.baseline=null;s.mode='iv';}
    if(action==='reset'){s.angle=-23;s.tilt=39;}
    if(action)renderIvSurface(root,root._ivProps);
  });
  root.addEventListener('pointerdown',e=>{if(!e.target.closest?.('.iv-surface-svg')||e.button!==0)return;root._ivIgnoreClick=false;root._ivDrag={x:e.clientX,y:e.clientY,angle:root._ivView.s.angle,tilt:root._ivView.s.tilt,moved:false,code:e.target.closest?.('[data-iv-point]')?.dataset.ivPoint};root.setPointerCapture?.(e.pointerId);});
  root.addEventListener('pointermove',e=>{const drag=root._ivDrag;if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)<5)return;drag.moved=true;const s=root._ivView.s;s.angle=clamp(drag.angle+dx*.15,-38,38);s.tilt=clamp(drag.tilt-dy*.15,22,60);redraw();for(const field of ['angle','tilt']){const el=root.querySelector?.(`[data-iv-field="${field}"]`);if(el)el.value=String(s[field]);}});
  const end=e=>{const drag=root._ivDrag;if(!drag)return;root._ivIgnoreClick=drag.moved;root._ivDrag=null;if(root.hasPointerCapture?.(e.pointerId))root.releasePointerCapture(e.pointerId);if(e.type!=='pointercancel'&&!drag.moved&&drag.code){root._ivIgnoreClick=true;choose(drag.code);}};
  root.addEventListener('pointerup',end);root.addEventListener('pointercancel',end);
}
