const finite=x=>typeof x==='number'&&Number.isFinite(x);
const fmt=(x,d=1)=>finite(x)?x.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=x=>Number.isFinite(Date.parse(x??''))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(x))+' NY':'unknown';

export function primaryWalls(context){
  return ['put','call'].map(side=>{
    const pattern=side==='put'?/^(put wall|put support)$/i:/^(call wall|call resistance)$/i;
    const candidates=(context?.levels??[]).filter(l=>finite(l.strike)&&(l.labels??[]).some(label=>pattern.test(label.trim())));
    return {side,level:candidates.length===1?candidates[0]:null};
  });
}

// Relative exposure concentration is not a price-impact prediction.
export function exposureScale(context,strike,underlyingCode){
  const valid=!!context&&context.underlyingCode===underlyingCode;
  const capture=valid&&context.exposure?.scope==='all-expiries'&&['Net GEX','Absolute GEX'].includes(context.exposure.metric)?context.exposure:null;
  const allowed=new Set((context?.levels??[]).filter(l=>l.kind!=='reference').map(l=>l.strike));
  const rows=capture?capture.rows.filter(r=>allowed.has(r.strike)&&finite(r.value)):valid&&context.gexUnit?(context.levels??[]).filter(l=>l.kind!=='reference'&&finite(l.gex)).map(l=>({...l,value:l.gex})):[];
  const matches=rows.filter(r=>r.strike===strike),value=matches.length===1?matches[0].value:null;
  const maximum=Math.max(0,...rows.map(r=>Math.abs(r.value)));
  if(value!==null){const score=maximum>0?100*Math.abs(value)/maximum:0;return {value,maximum,score,scale:Math.sqrt(score/100),basis:'exposure',metric:capture?.metric??'GEX',display:matches[0].display??fmt(value,2),capture};}
  const level=valid?(context.levels??[]).find(l=>l.strike===strike):null;
  const ranks=(level?.labels??[]).map(x=>x.match(/^GEX\s+(10|[1-9])$/i)).filter(Boolean).map(m=>Number(m[1]));
  if(ranks.length===1){const score=10*(11-ranks[0]);return {value:null,maximum,score,scale:Math.sqrt(score/100),basis:'rank',rank:ranks[0],metric:null,capture};}
  return {value:null,maximum,score:null,scale:null,basis:'missing',metric:null,capture};
}
export function netGammaSign(exposure){
  if(exposure.metric!=='Net GEX'||!finite(exposure.value))return 'unknown';
  return exposure.value>0?'positive':exposure.value<0?'negative':'zero';
}
function scoreText(score){return finite(score)?score>0&&score<.1?'<0.1':fmt(score,1):'—';}
export function expiryIdentity(lens,labels=[]){
  const provider=labels.some(label=>/\b0\s*DTE\b/i.test(label));
  const c=lens?.expiryCoverage,confirmed=lens?.expiryScope!=='later'&&(c?.zeroDteRows??0)>0;
  const minutes=c?.nearestMinutes;
  const mixed=confirmed&&lens?.expiryScope!=='0dte'&&(c?.laterRows??0)>0;
  return {provider,confirmed,mixed,
    label:confirmed?(mixed?'Includes 0DTE':'0DTE contracts'):provider?'MenthorQ 0DTE level':null,
    clock:confirmed&&finite(minutes)?minutes<=(lens.elapsedMinutes??0)?'Expiry reached in this scenario':`${fmt(minutes-(lens.elapsedMinutes??0),1)} min to nearest expiry at model clock`:null};
}
export function expiryBadges(lens,labels=[]){
  const d=expiryIdentity(lens,labels);
  if(!d.label)return '';
  return `<span class="expiry-badges">${d.provider?'<span class="expiry-badge provider" title="Provider landmark may include expiry within 24 hours; not an expiry-specific exposure measurement.">MenthorQ 0DTE level</span>':''}${d.confirmed?`<span class="expiry-badge" title="Verified active expiry on the snapshot’s New York date. Clock is frozen to the saved snapshot or scenario.">${d.mixed?'Includes 0DTE':'0DTE contracts'}</span>`:''}${d.clock?`<small>${esc(d.clock)}</small>`:''}</span>`;
}
function body(wall,ratio,index,x){
  const diameter=wall?128:x.scale===null?54:Math.max(28,112*x.scale);
  const planet=index%8,col=planet%4,row=Math.floor(planet/4);
  return `<span class="gravity-body ${wall?'gravity-hole gravity-cinematic':'gravity-planet'} ${x.basis==='missing'?'gravity-unscaled':''}" aria-hidden="true" style="--activity:${finite(ratio)?ratio:0};--planet-size:${diameter}px;--atlas-x:${col*100/3}%;--atlas-y:${row*100}%"><span class="gravity-orbit orbit-one"></span><span class="gravity-orbit orbit-two"></span><span class="gravity-halo"></span>${wall?'<img class="gravity-hole-image" src="/black-hole-lensed.png" alt="">':`<span class="gravity-planet-art"></span><span class="gravity-number">${esc(scoreText(x.score))}</span>`}</span>`;
}
function exposureLabel(x){return x.basis==='exposure'?`${esc(x.metric)} ${esc(x.display)}`:x.basis==='rank'?`MenthorQ GEX ${x.rank} · ordinal score ${x.score}/100`:'Exposure reading unavailable';}

export function gravityDeck(curve,market,options,colors){
  const context=market?.watchContext&&market.watchContext.underlyingCode===market.underlyingCode?market.watchContext:null;
  const walls=primaryWalls(context),chosen=curve?.chosen??[],lenses=options.allLenses??chosen;
  const rows=(context?.levels??[]).filter(l=>l.kind!=='reference'),levels=rows.length?rows:chosen;
  const entries=levels.map((level,index)=>({level,index,lens:lenses.find(l=>l.strike===level.strike),x:exposureScale(context,level.strike,market?.underlyingCode),walls:walls.filter(w=>w.level?.strike===level.strike)}));
  const basisOrder={exposure:0,rank:1,missing:2};
  entries.sort((a,b)=>basisOrder[a.x.basis]-basisOrder[b.x.basis]||(b.x.score??-1)-(a.x.score??-1)||a.level.strike-b.level.strike);
  const cards=entries.map(({level,index,lens,x,walls:ws},position)=>{
    const ci=chosen.findIndex(l=>l.strike===level.strike),ratio=ci>=0?curve.currentRatios[ci]:null;
    const wall=ws.length>0,name=wall?ws.map(w=>`${w.side==='put'?'Put':'Call'} wall`).join(' + '):(level.labels??lens?.labels??[]).join(' · ')||'Watched strike';
    const tag=lens?'button':'article',active=lens&&(lens.key===options.selectedKey||(!options.selectedKey&&ci===0)),color=ci>=0?colors[ci]:'#a7bed6';
    const divider=x.basis==='rank'&&entries[position-1]?.x.basis!=='rank'?'<div class="gravity-basis-divider">Rank-only levels · separate ordinal scale. Compare these scores within this group; numerical exposure has not been captured.</div>':'';
    return `${divider}<${tag} ${lens?`type="button" data-lens-strike="${esc(lens.key)}" aria-pressed="${!!active}"`:''} class="gravity-card" style="--curve-color:${color}"><span class="gravity-card-top"><span>${esc(name)}</span><span>${active?'Selected':lens?'Explore':'Provider level'}</span></span>${expiryBadges(lens,level.labels??[])}${body(wall,ratio,index,x)}<span class="gravity-strike" data-net-gamma="${netGammaSign(x)}">${fmt(level.strike,2)}</span><span class="gravity-gex">${exposureLabel(x)}</span><span class="gravity-score-caption">${wall?'Primary provider wall':x.basis==='exposure'?`Exposure score ${esc(scoreText(x.score))}/100 · all expiries`:x.basis==='rank'?`Ordinal score ${x.score}/100 · rank only`:'Importance unavailable'}</span><span class="gravity-ratio"><b ${ci>=0?`data-probe-ratio="${ci}"`:''}>${finite(ratio)?fmt(ratio*100)+'%':'—'}</b><small>Futu sensitivity remaining</small></span><small ${ci>=0?`data-probe-change="${ci}"`:''}>${finite(ratio)?fmt((1-ratio)*100)+'% faded · at snapshot price':lens?'Select to explore its curve':'Futu model inputs needed'}</small>${lens?.complete===false?'<small class="gravity-incomplete">Partial Futu option coverage</small>':''}</${tag}>`;
  }).join('');
  const exposure=context?.exposure,metric=exposure?.metric??'Net GEX',measured=entries.filter(r=>r.x.basis==='exposure').length,ranked=entries.filter(r=>r.x.basis==='rank').length;
  return `<section class="gravity-system" aria-label="MenthorQ exposure and Futu sensitivity"><div class="gravity-heading"><div><p class="gravity-kicker">MENTHORQ × FUTU</p><h3>Exposure gives it weight.</h3></div><span class="gravity-mode">${options.side==='short'?'Negative gamma · amplification scenario':options.side==='long'?'Positive gamma · damping scenario':'Gamma direction unknown'}</span></div><details class="gravity-source"><summary>Sources &amp; capture times</summary><p>MenthorQ Exposure: ${esc(exposure?.mode??context?.mode??'mode unknown')} · all expiries · provider date ${esc(exposure?.sourceDate??'unverified')} · ${esc(exposure?.delayStatus??'delay unverified')} · source clock ${exposure?.asOf?esc(time(exposure.asOf)):'unverified'} · checked ${esc(time(exposure?.capturedAt))}. Levels map: ${esc(context?.sourceDate??'unknown date')}. Futu quote: ${esc(time(market?.priceTimestamp))}. These are separate snapshots.</p></details><div class="reading-legend gravity-deck" role="group" aria-label="Select a numbered planet or wall">${cards}</div><div class="gravity-key"><span><b>Size + number</b> MenthorQ all-expiry exposure</span><span><b>Black holes</b> call / put walls</span><span><b>Halo + percentage</b> Futu sensitivity</span></div><p class="gravity-caveat">Exposure score = 100 × strike magnitude / largest captured watched-strike magnitude in this market. Planet area follows that ratio, with a 28px visibility minimum. It measures concentration, not a probability or calibrated price impact. For Net GEX we use its magnitude; this differs from MenthorQ’s separate Absolute GEX metric. Rank-only scores use GEX 1 → 100 and GEX 10 → 10 on a separate ordinal scale. Compare them within their own group. Body size stays fixed to the provider snapshot as the scenario changes.</p><details class="gravity-research"><summary>0DTE: concentration, clock and hedge pressure</summary><p>A 0DTE badge identifies an expiry or provider landmark, not an automatic strength multiplier. Near the strike, gamma can grow and narrow as the clock runs down; away from the strike it can collapse. Use the Futu curve filter and time scenario to isolate that behavior. Planet size and score remain the separately captured all-expiry MenthorQ exposure. The 0DTE curve can use signed strike values from a matching same-day Net GEX capture.</p><p>Price, elapsed time (charm) and IV (vanna) change delta. Finite scenarios reprice delta at both endpoints; they do not extrapolate one gamma number through expiry. OI is a conditional position-size assumption. Signed dealer inventory and synchronized liquidity are needed to estimate actual hedging pressure or price impact.</p><p><a href="https://www.cmegroup.com/education/courses/option-greeks/options-gamma-the-greeks" target="_blank" rel="noopener noreferrer">CME: gamma</a> · <a href="https://cdn.cboe.com/resources/education/research_publications/gammasqueezes.pdf" target="_blank" rel="noopener noreferrer">0DTE inventory research</a> · <a href="https://menthorq.com/guide/key-levels-and-key-terms/" target="_blank" rel="noopener noreferrer">MenthorQ level definitions</a></p></details><details class="gravity-research"><summary>How the two models form a playbook</summary><p><a href="https://menthorq.com/guide/options-menu/" target="_blank" rel="noopener noreferrer">MenthorQ Exposure</a> supplies a dealer-positioning estimate by strike. <a href="https://menthorq.com/guide/what-is-gex/" target="_blank" rel="noopener noreferrer">MenthorQ describes GEX as a hedging proxy</a>; this app does not recreate its proprietary model. The Futu calculation uses observed option inputs plus an explicit inventory scenario. Its remaining-peak percentage and equivalent hedge size are calculated independently of MenthorQ’s exposure number.</p><p>A high exposure score with high remaining sensitivity highlights a concentration to study. Falling sensitivity can weaken the modeled hedge response. Positive dealer gamma implies counter-move hedging; negative implies same-direction hedging. Liquidity and other flows determine the resulting price move. No validated crossing probability or event horizon follows from these observations.</p><p>Different expiry coverage, timestamps and model conventions prevent multiplying the provider number by the Futu percentage and calling it measured dealer exposure. <a href="https://menthorq.com/academy/gamma-levels/lessons/trade-gex-levels-1-to-10/" target="_blank" rel="noopener noreferrer">Provider rank guide</a> · <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3725454" target="_blank" rel="noopener noreferrer">Gamma Fragility research</a> · <a href="https://experts.illinois.edu/en/publications/stock-price-clustering-on-option-expiration-dates/" target="_blank" rel="noopener noreferrer">Expiration pinning research</a>.</p><p>The black hole is an original cinematic lensing illustration based on your reference. It represents wall identity and has no numerical overlay.</p></details></section>`;
}
