import {gravityDeck,exposureScale,netGammaSign,primaryWalls,expiryIdentity} from './gravity-view.mjs';
import {renderExpiryComparison,bindExpiryComparison} from './expiry-comparison-view.mjs';
import {bindChartNavigation} from './chart-navigation.mjs';
import {netDexReading,netDexSummary,netDexPlot,netDexAtProbe} from './net-dex-view.mjs';
import {contextFreshness,nyClock,regimeReading,quoteMovement,hedgeReaction,buildMarketCurve,buildOverallSensitivity,buildHedgeActivity,sampleMarketCurve,sensitivityTransitions} from '../core/market-reading.mjs';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const f=(x,d=1)=>finite(x)?x.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
const e=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#98f5e1','#ffc68f','#b5afff','#ff99b7','#8fc9ff','#e9e59a','#cbb8a0','#b6d5db'];
const overallColor = '#eaf4ff';
const strikeGammaLabels = {positive:'Positive Net GEX',negative:'Negative Net GEX',zero:'Zero Net GEX',unknown:'Net GEX unavailable'};
const strikeGammaMarks = {positive:' +',negative:' −',zero:'',unknown:''};
const time=x=>Number.isFinite(Date.parse(x??''))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(x))+' NY':'unverified';
function expiryControls(prefs,lenses,zeroDteExposure){
  const scope=prefs.expiryScope??'all',elapsed=prefs.elapsedMinutes??0;
  const counts=lenses.reduce((a,l)=>{for(const k of ['zeroDteRows','laterRows','unknownRows'])a[k]+=l.expiryCoverage?.[k]??0;return a;},{zeroDteRows:0,laterRows:0,unknownRows:0});
  const asOf=lenses.find(l=>l.expiryCoverage?.asOf)?.expiryCoverage.asOf;
  return `<div class="expiry-controls" role="group" aria-label="Expiry and clock scenarios"><label>Futu curve expiries<select data-lens-field="expiryScope"><option value="all"${scope==='all'?' selected':''}>All selected expiries</option><option value="0dte"${scope==='0dte'?' selected':''}>0DTE · expires on snapshot day</option><option value="later"${scope==='later'?' selected':''}>Later expiries</option></select></label><label>Advance model clock<select data-lens-field="elapsedMinutes">${[0,5,15,30,60].map(m=>`<option value="${m}"${elapsed===m?' selected':''}>${m?'+'+m+' min scenario':'Snapshot time'}</option>`).join('')}</select></label><p>${counts.zeroDteRows} same-day · ${counts.laterRows} later · ${counts.unknownRows} unresolved expiry series in selected Futu inputs. Clock: ${e(time(asOf))}${elapsed?` + ${elapsed} min scenario`:''}.</p>${zeroDteExposure?`<p>0DTE signs checked ${e(time(zeroDteExposure.capturedAt))} · ${zeroDteExposure.asOf?`provider time ${e(time(zeroDteExposure.asOf))}`:'provider clock unverified'}${zeroDteExposure.delayStatus==='delayed'?' · Delayed feed':''}</p>`:scope==='0dte'?'<p class="lens-amber">Add matching same-day Net GEX in Data &amp; settings to use captured strike signs.</p>':''}</div>`;
}
function matchingZeroDteExposure(market,lenses,now,expiryScope,expiryDate){
  const context=market?.watchContext,capture=context?.exposure0dte;
  if(context?.underlyingCode!==market?.underlyingCode||capture?.scope!=='0dte'||capture.metric!=='Net GEX'||capture.mode!=='Intraday')return null;
  const checked=Date.parse(capture.capturedAt);
  const asOf=Date.parse(lenses.find(l=>l.expiryCoverage?.asOf)?.expiryCoverage.asOf??market?.priceTimestamp);
  if(!finite(checked)||checked>now||!finite(asOf))return null;
  const date=capture.expiryDate;
  if(nyClock(checked).date!==date||nyClock(asOf).date!==date||nyClock(now).date!==date)return null;
  if(expiryScope==='later'||(expiryDate!=='all'&&expiryDate!==date)||(expiryScope!=='0dte'&&expiryDate==='all'))return null;
  return capture;
}

export function renderMarketReading({lenses=[],market,now=Date.now(),prefs,regime,selectedKey,focusedKey=null,overallProfile,sessionComparison,expiryComparison,expiryDate='all'}={}){
  const context=market?.watchContext, fresh=contextFreshness(context,now),r=regime??regimeReading(context,now);
  const expiryScope=prefs.expiryScope??'all',autoFlow=prefs.regimeMode==='auto';
  const allFlowExpiries=expiryScope==='all'&&expiryDate==='all';
  const zeroDteExposure=matchingZeroDteExposure(market,lenses,now,expiryScope,expiryDate);
  const zeroDteRows=new Map((zeroDteExposure?.rows??[]).map(row=>[row.strike,row]));
  const strikeGamma=lens=>{
    if(allFlowExpiries)return exposureScale(context,lens.strike,market?.underlyingCode);
    const row=zeroDteRows.get(lens.strike);
    const active=row&&lens.deltaSeries?.some(option=>option.expiryMs>now+(prefs.elapsedMinutes??0)*60000&&nyClock(option.expiryMs).date===zeroDteExposure.expiryDate);
    return active?{metric:'Net GEX',...row}:{};
  };
  const movement=quoteMovement(market,now),F=market?.underlyingPrice,side=autoFlow&&!allFlowExpiries?null:prefs.side;
  const reaction=hedgeReaction(side,movement?.change);
  const focused=lenses.find(lens=>lens.key===focusedKey);
  const selected=lenses.find(lens=>lens.key===selectedKey);
  const overall=focused?null:overallProfile===undefined?buildOverallSensitivity(lenses,F):overallProfile;
  const activeProfile=focused?focused.profile:overall;
  const transitions=sensitivityTransitions(activeProfile);
  const transitionPrices=[activeProfile?.peakPrice,...transitions.map(transition=>transition.price)].filter(finite);
  const scopeLabel=focused?`Strike ${f(focused.strike,2)}`:'All watched strikes';
  const expiryLabel={all:'All loaded expiries', '0dte':'0DTE',later:'Later expiries'}[prefs.expiryScope??'all'];
  const partialCoverage=lenses.some(lens=>lens.complete===false||lens.method==='reported-linear');
  const coverage=overall?`${overall.modeledLevels} of ${overall.totalLevels} watched strikes modeled${partialCoverage?' · partial inputs':''}`:focused?`${focused.modeledRows??0} modeled series · ${focused.excludedRows??0} excluded`:'No eligible curves';
  const mode=prefs.regimeMode==='auto'?'Provider regime scenario':'Manual scenario';
  const top=lenses.find(l=>finite(l.sensitivity)&&l.sensitivity>0),weak=[...lenses].filter(l=>finite(l.sensitivity)).sort((a,b)=>a.sensitivity-b.sensitivity)[0];
  const directional=side==='short'?'Rises → buying · falls → selling':side==='long'?'Rises → selling · falls → buying':'Both gamma signs remain possible';
  const title=!side?(zeroDteExposure?'0DTE direction by strike':'Direction unknown'):!movement?(side==='short'?'Reinforces the move':'Dampens the move'):reaction==='flat'?'Price unchanged':`${reaction==='buy'?'Buying':'Selling'} scenario`;
  const movementCopy=movement?`Quoted price ${movement.change>=0?'rose':'fell'} ${f(Math.abs(movement.change),2)} points over ${f(movement.minutes)} min (${time(movement.fromTime)} → ${time(movement.toTime)}).`:'Two increasing source timestamps from the same future, no more than 15 minutes apart, are needed. Stale quotes are excluded.';
  const reading=side==='short'?'Hedging can amplify rises and falls. Smaller absolute gamma means less response per additional price point.':side==='long'?'Hedging can cushion rises and falls. Smaller absolute gamma means less cushioning per additional price point.':'Choose a gamma scenario to explore buying and selling responses.';
  const clRows=market?.underlyingCode?.startsWith("US.CL")?(market.contracts??[]):null;
  const clClockCount=clRows?.filter(row=>Number.isFinite(Date.parse(row.expiryTimestamp??""))).length??0;
  const clStatus=clRows?.length?`<p class="reading-unit"><strong>CL quotes available · ${clClockCount}/${clRows.length} series have mapped expiry times.</strong> American CL standard sessions use 14:30 New York, with DST. LCE and unverified special sessions stay excluded from curves. <a href="https://support.tastytrade.com/support/s/solutions/articles/43000503202" target="_blank" rel="noopener noreferrer">Clock source</a></p>`:"";
  const deltaLens=focused&&prefs.deltaStrikeKey===focused.key?focused:null;
  const deltaId=prefs.deltaSeriesByStrike?.[focused?.key];
  const deltaRange=deltaLens?.deltaRange?.(deltaId,prefs.deltaTail??.05)??null;
  const delta={lens:deltaLens,range:deltaRange,id:deltaId,tail:prefs.deltaTail??.05,now};
  const flowLenses=focused?[focused]:lenses, flowSides=new Map();
  const gammaSide={positive:'long',negative:'short'};
  for(const lens of flowLenses){
    const flowSide=autoFlow?gammaSide[netGammaSign(strikeGamma(lens))]:side;
    if(flowSide)flowSides.set(lens.key,flowSide);
  }
  const showNetDex=prefs.showNetDex!==false;
  const netDex=showNetDex?netDexReading(market,now,allFlowExpiries):null;
  const dexStrike=focused?.strike??selected?.strike;
  const plotOptions={side,regime:r,regimeMode:prefs.regimeMode,selectedKey:focused?.key,focused,overall,scopeLabel,transitions,netDex,dexStrike,
    allLenses:lenses,expiryScope,elapsedMinutes:prefs.elapsedMinutes,delta,comparison:expiryComparison,
    flowLenses,flowShare:prefs.share??1,autoFlow,allFlowExpiries,zeroDteExposure,strikeGamma};
  const makeCurve=(halfRange,center,preview=false)=>{
    const view=buildMarketCurve(lenses,F,prefs.move,halfRange,focused?.key,center,transitionPrices,preview);
    if(view)view.hedgeFlow=buildHedgeActivity(flowLenses,flowSides,plotOptions.flowShare,view);
    return view;
  };
  let curve=makeCurve(prefs.chartMove,prefs.chartCenter);
  const html = `<section class="reading-overview" aria-label="Market regime and current price response">
    <div class="reading-status"><span class="lens-chip">${e(market?.underlyingCode??'Choose a market')}</span><span class="${fresh.usable?'':'lens-amber'}">${e(fresh.label)}</span>${context?.delayStatus==='delayed'?'<b>Delayed feed</b>':''}<details class="reading-source"><summary>Source details</summary><p>Provider: ${e(context?.sourceDate??'unknown date')} ${e(context?.sourceLocalTime??'')} ${context?.asOf?'· '+time(context.asOf):'· timezone unverified'}<br>Last checked: ${time(context?.lastCheckedAt??context?.capturedAt)}</p>${clStatus}</details></div>
    <div class="reading-cards"><article><span>Market gamma</span><h3>${e(r.label)}</h3><p>${r.source?`${e(r.source.display||f(r.source.netGex))} · all expiries · ${e(r.source.mode)}`:'Not inferred from calls, puts or level names.'}</p><small>${r.current?'Current provider snapshot':r.source?'Reference · source time unverified':'All-expiry Net GEX required'}</small></article><article class="${reaction==='buy'?'buy':reaction==='sell'?'sell':''}"><span>Price-only hedge response</span><h3>${title}</h3><p>${e(directional)}</p><small>${e(mode)} · fixed time / IV · ${r.current&&prefs.regimeMode==='auto'?'Scenario · actual flow unknown':'Reference scenario · actual flow unknown'}</small></article><article><span>Strongest watched level</span><h3>${top?f(top.strike,2):'Inputs needed'}</h3><p>${top?`${f(top.shareOfWatched*100)}% of included sensitivity`:'Eligible IV, OI and exact expiry inputs are needed.'}</p><small>${weak?`Weakest included level: ${f(weak.strike,2)}`:'Missing inputs are not zero exposure.'}</small></article></div>
    <div class="reading-controls"><label>Gamma scenario<select data-lens-regime aria-label="Gamma regime basis"><option value="auto"${prefs.regimeMode==='auto'?' selected':''}>MenthorQ reported regime</option><option value="short"${prefs.regimeMode==='short'?' selected':''}>Scenario: negative / short gamma</option><option value="long"${prefs.regimeMode==='long'?' selected':''}>Scenario: positive / long gamma</option></select></label><p>${reading}</p></div>
    ${sessionComparisonView(sessionComparison,market,lenses.find(l=>l.key===selectedKey),prefs)}
    <details class="reading-observations"><summary>Price action &amp; what to watch</summary><div class="reading-evidence"><article><h3>Price change</h3><p>${movementCopy}</p></article><article><h3>Order flow</h3><p>No trade or order-book feed is connected. Actual dealer buying, selling and absorption are unknown.</p></article><article><h3>Watch for a mismatch</h3><p>${side==='short'?'Price keeps moving while sensitivity fades? Other orders or thinner liquidity may be driving the move.':side==='long'?'Price keeps moving despite a strong cushioning scenario? Other flows may outweigh it, or the inventory assumption may be wrong.':'Choose a gamma scenario first.'}</p></article></div></details>
    <section class="reading-curve" data-reading-scope="${focused?'strike':'overall'}">${expiryControls(prefs,lenses,zeroDteExposure)}
    <div class="reading-heading" data-reading-heading>
      <div><h3>Sensitivity by price</h3><div class="reading-scope-label"><strong>${scopeLabel}</strong><span>${expiryLabel} · ${coverage}</span></div>
      <p>${focused?'Build and fade are for this strike.':'The bright curve combines modeled sensitivity across watched strikes.'} Select a strike line to compare its expiries and view its delta range.</p></div>
      <div class="reading-chart-actions"><button type="button" data-reading-overall aria-pressed="${!focused}">All watched strikes</button>
      <button type="button" data-compare-toggle data-compare-key="${e(selected?.key)}" aria-pressed="${prefs.compareOpen===true}" aria-controls="expiry-comparison-panel"${!selected?' disabled':''}>${selected?`Compare strike ${f(selected.strike,2)} expiries`:'Compare strike expiries'}</button>
      <button type="button" data-reading-dex-toggle aria-pressed="${showNetDex}">Net DEX</button>
      <label>Range ± points<input data-lens-field="chartMove" aria-label="Chart range step" type="number" min="${market?.tickSize??.01}" step="any" value="${Number((prefs.chartMove??curve?.halfRange??prefs.move).toFixed(2))}"></label></div>
    </div>
    ${showNetDex?netDexSummary(netDex,{allExpiries:allFlowExpiries,selectedStrike:dexStrike}):''}
    ${hedgingReminder()}
    ${drawMarketCurve(curve,F,market,plotOptions)}
    <details class="reading-chart-notes"><summary>How to read this chart</summary><p class="reading-unit">The combined curve sums open-interest-weighted gamma across eligible watched strikes before scaling to its own peak. Individual curves use their own peaks. Short-dashed lines include verified same-day expiry. The expiry filter changes the Futu curves. Planet scores show all-expiry MenthorQ exposure. Build and fade mark where the active curve changes fastest as price rises, with IV and the model clock held fixed.</p><p class="reading-unit">Above zero, hedging amplifies the move by buying a rise or selling a fall. Below zero, hedging dampens the move by selling a rise or buying a fall. The filled dots mark peak net rates after offsetting buys and sells at each price. The hollow dots mark gross peaks. The shaded boxes cover the prices around each net peak with at least half its rate in the chart range.</p><p class="reading-unit">Futu gamma and open interest set scenario size. The chart uses the saved signed Net GEX for the selected scope. 0DTE signs need a matching same-day capture. A manual gamma scenario supplies an assumed sign. When signs are unknown, the chart shows total unsigned sensitivity. Actual dealer inventory, executions and price impact are unknown.</p></details></section>
    <details class="reading-schedule"><summary>Collection schedule</summary><p>Ordinary Windows software checks five-minute collection slots through the nominal futures week: Sunday 18:00 to Friday 17:00 New York, excluding daily 17:00–18:00 maintenance. MenthorQ levels are due from 09:35 New York for Intraday and 23:15 New York for EOD on weekdays. A missing update triggers a Windows alert. This computer must stay awake and signed in; Codex can be closed. The status above confirms the last collector check, and source clocks show data age. Exchange holiday overrides and economic-release filtering are unverified. Downloading an older publication does not make it fresh.</p></details>
  </section>`;
  return {
    html,
    bindProbe(root) {
      const surface=root.querySelector?.('[data-reading-viewport]');
      if (curve && surface) {
        const navigation=bindChartNavigation(surface,{
          getWindow:()=>curve,
          floor:F*.01,
          tick:market?.tickSize??.01,
          applyWindow(view,preview){
            const halfRange=(view.hi-view.lo)/2,center=view.lo+halfRange;
            const next=makeCurve(halfRange,center,preview);
            if(!next)return;
            const previous=curve;
            curve=next;
            prefs.chartCenter=center;
            prefs.chartMove=halfRange;
            root.querySelector('[data-lens-field="chartMove"]').value=String(Number(halfRange.toFixed(2)));
            const windowTools=root.querySelector('[data-reading-window-tools]');
            if(preview)windowTools.querySelector('[data-window-summary]').textContent=windowSummary(next);
            else windowTools.innerHTML=drawWindowTools(next,F,market,plotOptions);
            if(previous.chosen.length!==next.chosen.length||previous.chosen.some((lens,index)=>lens!==next.chosen[index])){
              root.querySelector('[data-reading-gravity]').innerHTML=gravityDeck(next,market,plotOptions,colors);
              root.querySelector('[data-reading-distance]').innerHTML=drawDistanceTable(next,plotOptions);
            }
            const oldScroll=surface.querySelector('.reading-chart-scroll');
            const scrollLeft=oldScroll.scrollLeft,focusedPlot=oldScroll===surface.ownerDocument.activeElement;
            const flowPanel=root.querySelector('[data-reading-flow-controls]');
            flowPanel.innerHTML=flowControls(next.hedgeFlow,market,plotOptions);
            surface.innerHTML=drawPricePlot(next,F,market,plotOptions);
            const newScroll=surface.querySelector('.reading-chart-scroll');
            newScroll.scrollLeft=scrollLeft;
            if(focusedPlot)newScroll.focus({preventScroll:true});
            bindPriceProbe(root,next,F,market?.underlyingCode,prefs,overall,navigation,plotOptions);
          }
        });
        bindPriceProbe(root,curve,F,market?.underlyingCode,prefs,overall,navigation,plotOptions);
      }
      bindExpiryComparison(root,expiryComparison,prefs);
    }
  };
}
function hedgingReminder(){
  return `<aside class="reading-hedge-reminder" aria-label="Build and fade interpretation reminder">
    <strong class="reading-reminder-title">Lower sensitivity does not promise a bounce.</strong>
    <p>Build marks the fastest increase in the active sensitivity curve <b>as price rises</b>. Fade marks the fastest decrease. Both hold IV and the model clock fixed. Neither marks support, resistance or completed hedging.</p>
    <div class="reading-reminder-cases">
      <div><h4>Assumed short gamma</h4><p>Price falls → selling to hedge.<br>Smaller gamma magnitude → <b>less additional selling per point</b>.</p></div>
      <div><h4>Assumed long gamma</h4><p>Price falls → buying to hedge.<br>Smaller gamma magnitude → <b>less buying to cushion the fall</b>.</p></div>
    </div>
    <p class="reading-reminder-key">Less short-gamma amplification can help calm a move, all else equal. It does not establish lower volatility. Existing hedges, other orders and liquidity still matter.</p>
    <details><summary>Per point, per minute &amp; portfolio offsets</summary>
      <p><b>A faster move can outweigh smaller gamma.</b> For a small price move, modeled hedge change ≈ − signed portfolio gamma × futures price change. Divide by elapsed source minutes for an average rate. Positive means buying, negative means selling.</p>
      <p class="reading-reminder-example"><b>Illustrative short-gamma example</b><br>100 equivalent futures per point × a 2-point fall per minute = 200 sold per minute.<br>50 equivalent futures per point × a 6-point fall per minute = 300 sold per minute.<br>Sensitivity halves, but modeled selling per minute rises 50%.</p>
      <p>Use absolute sensitivity, not the curve’s percentage of its own peak. A start-to-end price change misses selling and buying within the interval. Changes in IV, time and positions also change hedge needs.</p>
      <p>Positions at other strikes, expiries or related products may offset this exposure. The same number of options does not mean the same gamma. Futu OI and MenthorQ strike signs describe a scenario, not verified dealer inventory or executions.</p>
      <p><b>This chart shows sensitivity per price point.</b> It does not measure actual dealer buying or selling per minute. Volume alone cannot identify who hedged.</p>
      <p class="reading-reminder-sources"><a href="https://www.cmegroup.com/education/courses/option-greeks/options-gamma-the-greeks" target="_blank" rel="noopener noreferrer">CME · gamma</a><a href="https://www.cboe.com/insights/posts/volatility-insights-evaluating-the-market-impact-of-spx-0-dte-options/" target="_blank" rel="noopener noreferrer">Cboe · net exposure</a></p>
    </details>
  </aside>`;
}
function sessionComparisonView(profile,market,lens,prefs){
  const valid=!!profile&&!!market?.underlyingCode&&profile.underlyingCode===market.underlyingCode;
  const rows=valid?profile.windows??[]:[];
  const flow=prefs.side?lens?.flow?.(market.underlyingPrice+prefs.move,prefs.side,prefs.share??1)?.change:null;
  const quantity=finite(flow)?Math.abs(flow):null;
  return `<section class="session-comparison" aria-label="Overnight session comparison"><div class="session-comparison-heading"><div><span>ASIA · EUROPE · NEW YORK</span><h3>Same hedge scenario. Different trading conditions.</h3></div><small>${e(market?.underlyingCode??'Exact future needed')}</small></div>
    <p>${quantity===null?'Select a gamma scenario and an eligible strike to compare its modeled hedge quantity.':`Strike ${f(lens.strike,2)} · +${f(prefs.move,3)} price scenario · ${f(quantity,1)} equivalent futures under the selected inventory assumption.`} The delta calculation has no session multiplier. Liquidity and other flows determine actual price impact.</p>
    ${rows.length?`<p class="session-comparison-mobile-hint">Swipe the table sideways for volume and sample details.</p><div class="session-comparison-scroll" tabindex="0" aria-label="Session comparison table; scroll horizontally on small screens"><table><thead><tr><th>Window</th><th>Typical 5m price volatility</th><th>Typical 5m volume</th><th>Same quantity vs NY</th><th>Scenario / 5m volume</th><th>Samples</th></tr></thead><tbody>${rows.map(row=>`<tr><th>${e(row.label)}<small>${e(row.boundary)}</small></th><td>${row.sampleCount>=10&&finite(row.medianFiveMinuteVolatility)?f(row.medianFiveMinuteVolatility,3)+' pts':'Insufficient'}</td><td>${row.sampleCount>=10&&finite(row.medianFiveMinuteVolume)?f(row.medianFiveMinuteVolume,0)+' contracts':'Unverified / insufficient'}</td><td>${finite(row.sameQuantityParticipationVsNY)?f(row.sameQuantityParticipationVsNY,2)+'× participation':'—'}</td><td>${quantity!==null&&row.sampleCount>=10&&row.medianFiveMinuteVolume>0?f(quantity/row.medianFiveMinuteVolume*100,2)+'%':'—'}</td><td>${row.sampleCount}<small>${e(row.firstDate??'')} → ${e(row.lastDate??'')}</small></td></tr>`).join('')}</tbody></table></div>`:'<p class="session-comparison-empty">Session history is loading or has no verified complete windows yet. No overnight impact multiplier is assumed.</p>'}
    <p class="session-comparison-note">At least 10 complete windows and verified futures volume units are required for ratios. Five-minute volume uses each window’s average bar volume; it is not resting order-book depth. Equal-quantity participation is not a price-impact estimate or measured dealer flow. Windows follow New York and London daylight saving. Economic-release periods have not been filtered; the US pre-open is listed separately.</p></section>`;
}
function chartDirection({side,regime,regimeMode,allFlowExpiries,zeroDteExposure}){
  if(regimeMode==='auto'&&zeroDteExposure)return '<p class="reading-unit">0DTE direction uses the captured signs at each strike. See the modeled buying and selling zones below.</p>';
  const scenario=side==='short'?'Negative gamma':side==='long'?'Positive gamma':!allFlowExpiries?'Subset gamma unknown':regime.label;
  const source=!side&&!allFlowExpiries?'Choose a manual subset scenario':regimeMode!=='auto'?'Manual scenario':regime.current?'MenthorQ scenario':regime.source?'MenthorQ reference':'Choose a gamma scenario above';
  const arrow=(move,label)=>{
    const reaction=hedgeReaction(side,move);
    const effect=side==='short'?'can reinforce the move':'can dampen the move';
    return `<div class="reading-direction-side" data-reaction="${reaction}"><strong>${label}</strong><span>${reaction==='unknown'?'Hedge direction unavailable':`${reaction==='buy'?'Buy':'Sell'} futures to hedge · ${effect}`}</span></div>`;
  };
  return `<div class="reading-direction" aria-label="Gamma scenario for market price response">
    <p>${e(scenario)} · ${e(source)}</p>
    <div>${arrow(-1,'← Price falls')}${arrow(1,'Price rises →')}</div>
  </div>`;
}

function distanceTable(lens,color){
  const {strike,profile}=lens;
  const crossing=price=>{
    if(!finite(price))return '—';
    const offset=price-strike;
    const distance=f(Math.abs(offset),2);
    return `<strong>${f(price,2)}</strong><small>${distance==='0'?'at strike':`${distance} pts ${offset<0?'below':'above'}`}</small>`;
  };
  return `<table class="reading-distance" style="--curve-color:${color}">
    <caption><span>Fade bands · Strike ${f(strike,2)}</span><small>Distance from the selected strike · fixed IV and time.</small></caption>
    <thead><tr><th scope="col">Peak remaining</th><th scope="col">Lower crossing</th><th scope="col">Upper crossing</th></tr></thead>
    <tbody>${profile.bands.map(band=>`<tr><th scope="row">${f(band.fraction*100)}%</th><td>${crossing(band.lower)}</td><td>${crossing(band.upper)}</td></tr>`).join('')}</tbody>
    ${profile.bands.some(band=>band.disconnected)?'<tfoot><tr><td colspan="3">Outer crossings shown. Some bands have gaps between them.</td></tr></tfoot>':''}
  </table>`;
}

function windowSummary(c){return `${f(c.lo,2)} → ${f(c.hi,2)} · center ${f(c.center,2)}`;}

function observationControls(c,price,market,options){
  const strikes=(options.allLenses??c.chosen).map(l=>l.strike).filter(finite);
  const center=c.center??(c.lo+c.hi)/2,span=c.halfRange??(c.hi-c.lo)/2;
  const min=Math.max(price*.01,Math.min(price,center,...strikes)-span),max=Math.max(price,center,...strikes)+span;
  const target=value=>Number(Math.max(price*.01,value).toPrecision(12));
  return `<div class="reading-window" role="group" aria-label="Observation price window"><div><strong>Price window</strong><small data-window-summary>${windowSummary(c)}</small></div><div class="reading-window-controls"><button type="button" data-lens-center="${target(center-span/2)}" aria-label="Move observation window lower">←</button><label><span>Move the observation window</span><input type="range" data-lens-field="chartCenter" aria-label="Observation window center" min="${min}" max="${max}" step="${market?.tickSize??.01}" value="${center}"></label><button type="button" data-lens-center="${target(center+span/2)}" aria-label="Move observation window higher">→</button><button type="button" data-lens-center="${price}">Center on snapshot</button></div></div>`;
}

function spaceBodies(c,market,options,palette,x,bodyY){
  const context=market?.watchContext?.underlyingCode===market?.underlyingCode?market?.watchContext:null;
  const walls=primaryWalls(context),contextLevels=(context?.levels??[]).filter(l=>l.kind!=='reference');
  const visible=c.chosen.map((lens,index)=>({lens,index})).filter(({lens})=>lens.strike>=c.lo&&lens.strike<=c.hi);
  visible.sort((a,b)=>Number(a.lens.key===options.selectedKey)-Number(b.lens.key===options.selectedKey));
  return `<g class="reading-space-bodies" aria-label="Strike centers of gravity">${visible.map(({lens,index})=>{
    const selected=lens.key===options.selectedKey,wall=walls.some(w=>w.level?.strike===lens.strike),source=exposureScale(context,lens.strike,market?.underlyingCode);
    const signed=options.strikeGamma(lens),gamma=netGammaSign(signed);
    const diameter=wall?90:source.scale===null?30:Math.max(22,74*source.scale),cx=x(lens.strike),cy=bodyY+(index%2?9:-9),size=diameter*1.58;
    const contextIndex=contextLevels.findIndex(l=>l.strike===lens.strike),sprite=(contextIndex>=0?contextIndex:index)%8,col=sprite%4,row=Math.floor(sprite/4);
    const score=finite(source.score)?source.score>0&&source.score<.1?'<0.1':f(source.score):'—';
    const expiry=expiryIdentity(lens,contextLevels.find(l=>l.strike===lens.strike)?.labels??lens.labels??[]);
    const title=`${expiry.label?expiry.label+' · ':''}Strike ${f(lens.strike,2)} · ${strikeGammaLabels[gamma]}${gamma!=='unknown'?` ${signed.display}`:''} · ${wall?'provider wall':source.basis==='exposure'?`exposure score ${score}/100`:source.basis==='rank'?`ordinal importance ${score}/100`:'exposure unavailable'} · center of gravity is a visual analogy`;
    return `<g class="reading-space-body${selected?' selected':''}" data-lens-strike="${e(lens.key)}" role="button" tabindex="0" aria-label="Explore ${e(title)}"><title>${e(title)}</title><line x1="${cx}" x2="${cx}" y1="${cy-diameter*.65}" y2="${cy-diameter*.9}" stroke="${palette[index]}" stroke-opacity=".65" stroke-dasharray="2 3"/><ellipse cx="${cx+4}" cy="${cy+diameter*.43}" rx="${diameter*.49}" ry="${diameter*.1}" fill="#01040b" fill-opacity=".8"/>${wall?`<image href="/black-hole-lensed.png" x="${cx-90}" y="${cy-90}" width="180" height="180" aria-hidden="true"/>`:`<svg x="${cx-size/2}" y="${cy-size/2}" width="${size}" height="${size}" viewBox="${col*442} ${row*444} 442 444" overflow="hidden" aria-hidden="true"><image href="/planet-atlas.png" width="1768" height="888" filter="url(#reading-planet-shadow)"/></svg><circle cx="${cx}" cy="${cy}" r="${diameter/2}" fill="url(#reading-planet-shade)" aria-hidden="true"/><rect x="${cx-18}" y="${cy-10}" width="36" height="20" rx="10" fill="#061020" fill-opacity=".82"/><text class="reading-space-score" x="${cx}" y="${cy+4}" text-anchor="middle">${source.basis==='rank'?'R':''}${e(score)}</text>`}<circle cx="${cx}" cy="${cy}" r="${wall?diameter*.54:diameter*.6}" fill="transparent" stroke="${selected?palette[index]:'#c5deff'}" stroke-opacity="${selected?'.9':'.15'}" stroke-width="${selected?'2':'1'}"/><text class="reading-space-strike" data-net-gamma="${gamma}" x="${cx}" y="${bodyY+53+(index%2?0:-12)}" text-anchor="middle">${f(lens.strike,2)}${strikeGammaMarks[gamma]}</text>${expiry.label?`<text class="reading-expiry-badge" x="${cx}" y="${bodyY+68+(index%2?0:-12)}" text-anchor="middle">${expiry.confirmed?'0DTE':'MQ 0DTE'}</text>`:''}</g>`;
  }).join('')}</g>`;
}

function deltaPanel(delta,price,market,curve){
  const lens=delta?.lens;if(!lens)return '';
  const {range,id,tail,now}=delta,series=lens.deltaSeries??[],chosen=series.find(s=>s.id===id);
  const crossings=range?[range.lower,range.upper]:[],outside=crossings.some(b=>finite(b?.price)&&curve&&(b.price<curve.lo||b.price>curve.hi));
  const span=Math.max(...crossings.filter(b=>finite(b?.price)).map(b=>Math.abs(b.price-price)),market?.tickSize??.01)*1.12;
  const signed=(v,d=2)=>finite(v)?`${v>0?'+':''}${f(v,d)}`:'—';
  const unit=market?.underlyingCode?.startsWith('US.CL')?'$/bbl':'pts';
  const quoteMs=Date.parse(chosen?.quoteTimestamp??''),age=finite(quoteMs)&&finite(now)?(now-quoteMs)/60000:null;
  const stale=age!==null&&(age>20||age<0);
  const quoteLabel=age===null?'Quote clock unknown':age<0?'Quote clock is after the reference clock':`${stale?'Stale option quote':'Option quote'} ${f(age,0)} min old`;
  return `<section class="delta-panel" data-delta-panel aria-label="Selected option delta transition range">
    <div class="delta-heading"><div><span>SELECTED STRIKE · ${f(lens.strike,2)}</span><h4>Delta transition range</h4></div><button type="button" data-delta-hide>Hide range</button></div>
    ${series.length?`<div class="delta-controls"><label>Option &amp; expiry<select data-lens-field="deltaSeriesId" aria-label="Option and expiry">${!chosen?'<option value="" selected>Choose an eligible option</option>':''}${series.map(s=>`<option value="${e(s.id)}"${s.id===id?' selected':''}>${s.optionType==='call'?'Call':'Put'} · ${e(time(s.expiry))} · ${e(s.id)}</option>`).join('')}</select></label><label>Delta endpoints<select data-lens-field="deltaTail" aria-label="Delta endpoints"><option value="0.05"${tail===.05?' selected':''}>0.05 / 0.95 magnitude</option><option value="0.01"${tail===.01?' selected':''}>0.01 / 0.99 magnitude</option></select></label></div>`:''}
    ${range?.status==='active'?`<div class="delta-metrics"><div><span>Modeled delta</span><strong>${signed(range.currentDelta,3)}</strong><small>IV ${f(chosen.iv*100,2)}% · ${f(chosen.minutes/60,2)} hours remain</small></div>${crossings.map((b,i)=>`<div><span>${i===0?'Lower':'Upper'} price · Δ ${signed(b.targetDelta,2)}</span><strong>${finite(b.price)?'≈ '+f(b.price,2):'Unavailable'}</strong><small>${finite(b.price)?`${signed(b.distance)} ${unit} (${signed(b.percent)}%) from snapshot${b.alreadyBeyond?' · already beyond endpoint':''}${curve&&(b.price<curve.lo||b.price>curve.hi)?' · outside chart':''}`:e(b.reason)}</small><small>Δ change to endpoint ${signed(b.deltaChange,3)}</small></div>`).join('')}</div>
    <p class="delta-evidence${stale?' lens-amber':''}">${e(quoteLabel)} · ${e(time(chosen.quoteTimestamp))}. IV calculation clock unverified. Model clock: ${e(time(lens.expiryCoverage?.asOf))}${lens.elapsedMinutes?` + ${lens.elapsedMinutes} min scenario`:''}.</p>
    <p class="delta-note">One ${chosen.optionType}, one expiry · ${e(range.model.label)} · fixed IV/time · ${f(chosen.parameters.rate*100,2)}% rate assumption. Vertical markers show option delta endpoints; the strike line still combines eligible series. These endpoints do not establish completed dealer hedging or a reversal.</p>
    ${outside?`<button type="button" class="delta-fit" data-lens-range="${span}">Show delta endpoints</button>`:''}`:`<p class="delta-note">${series.length?'The selected option is unavailable in this expiry/time selection. Choose an eligible option.':'This strike needs an active option with valid IV, a verified expiry time and a supported model. Delta endpoints are unavailable for the current selection.'}</p>`}
  </section>`;
}

function deltaMarkers(delta,c,x,{L,R,W,T,bottom}){
  if(!delta?.lens||delta.range?.status!=='active')return '';
  const {lower,upper}=delta.range;
  const visible=[lower,upper].filter(b=>finite(b?.price)&&b.price>=c.lo&&b.price<=c.hi);
  const band=finite(lower?.price)&&finite(upper?.price)&&upper.price>c.lo&&lower.price<c.hi?
    `<rect x="${x(Math.max(c.lo,lower.price))}" y="${T}" width="${Math.max(0,x(Math.min(c.hi,upper.price))-x(Math.max(c.lo,lower.price)))}" height="${bottom-T}" fill="#e6be7c" fill-opacity=".045"/>`:'';
  return `<g class="delta-chart-markers" data-delta-strike="${e(delta.lens.key)}" aria-label="Selected option delta endpoints">${band}${visible.map((b,i)=>{
    const labelX=Math.max(L+108,Math.min(W-R-108,x(b.price))),labelY=T+22+i*33;
    return `<g class="delta-chart-boundary"><line x1="${x(b.price)}" x2="${x(b.price)}" y1="${T}" y2="${bottom}" stroke="#e6be7c" stroke-width="1.8" stroke-dasharray="9 5"/><rect x="${labelX-107}" y="${labelY-19}" width="214" height="27" rx="4" fill="#272318"/><text x="${labelX}" y="${labelY}" text-anchor="middle">Δ ${b.targetDelta>0?'+':''}${f(b.targetDelta,2)} ≈ ${f(b.price,2)}</text></g>`;
  }).join('')}</g>`;
}

function drawMarketCurve(c,price,market,options){
  const comparison=renderExpiryComparison(options.comparison,market,{showOverallReset:!!options.focused});
  const replaySlot='<div data-reading-replay-slot></div>';
  if(!c)return replaySlot+flowControls(null,market,options)+comparison+deltaPanel(options.delta,price,market,null)+gravityDeck(null,market,options,colors)+`<div class="lens-empty"><strong>${market?.underlyingCode?.includes('.CL')?'CL quotes available; no eligible distance curve in this selection.':'Peak percentages are not available for this snapshot.'}</strong><p>${market?.underlyingCode?.includes('.CL')?'Curves need an active mapped expiry, valid IV and OI. Try a supported American weekly or monthly expiry. LCE and unverified special-session clocks remain unresolved; reported readings are still available.':'A complete distance model needs eligible IV, OI, compatible units and an exact expiry time.'}</p><p>Missing percentages are unknown, not 0%.</p></div>`;
  return `${chartDirection(options)}
    <div data-reading-window-tools>${drawWindowTools(c,price,market,options)}</div>
    ${replaySlot}
    <div data-reading-flow-controls>${flowControls(c.hedgeFlow,market,options)}</div>
    <div class="reading-chart-toolbar">
      <p id="reading-probe-hint" class="reading-probe-hint"><span class="reading-mouse-help">Drag to pan · wheel to zoom · hover to explore a price.</span><span class="mobile-chart-help">Swipe sideways to see the plot. Tap to explore a price.</span></p>
      <button type="button" data-reading-reset-chart title="Restore the default zoom and center on the snapshot price">Reset chart</button>
    </div>
    <div data-reading-viewport>${drawPricePlot(c,price,market,options)}</div>
    ${comparison}
    <div data-reading-gravity>${gravityDeck(c,market,options,colors)}</div>
    <div data-reading-distance>${drawDistanceTable(c,options)}</div>`;
}

function drawWindowTools(c,price,market,options){
  return observationControls(c,price,market,options)+deltaPanel(options.delta,price,market,c);
}

function drawDistanceTable(c,options){
  const index=c.chosen.findIndex(lens=>lens.key===options.selectedKey);
  return index<0?'':distanceTable(c.chosen[index],colors[index]);
}

const flowUnits = market => market?.underlyingCode?.startsWith('US.CL') ? 'eq. futures per $1/bbl' : 'eq. futures per point';
const flowNumber = value => value>0&&value<.01?'<0.01':f(value,2);
const hedgePeakLane = 26;

function sellingPeaks(activity) {
  const {signed, amplifying, damping} = activity;
  // The signed rates use a rising price. Gross buying on a rise is gross selling on a fall.
  return [
    {behavior:'amplifying', sellOn:'fall', buyOn:'rise', sign:1, zone:amplifying,
      grossPrice:signed.peakBuy.price, grossRate:signed.peakBuy.buy},
    {behavior:'damping', sellOn:'rise', buyOn:'fall', sign:-1, zone:damping,
      grossPrice:signed.peakSell.price, grossRate:signed.peakSell.sell}
  ];
}

function flowControls(activity,market,options){
  const {flowLenses,flowShare,autoFlow,allFlowExpiries,zeroDteExposure,side}=options;
  const units=flowUnits(market);
  const gammaBasis=allFlowExpiries?'all expiries':zeroDteExposure?'0DTE':null;
  const legend=`<div class="reading-gamma-key"><span>${gammaBasis?`Strike labels · saved MenthorQ Net GEX · ${gammaBasis}`:'Strike signs unavailable for this expiry selection'}</span>${gammaBasis?'<b data-net-gamma="positive">+ Positive</b><b data-net-gamma="negative">− Negative</b><span>Gray · zero or unavailable</span>':''}</div>`;
  if(!activity){
    return `<div class="reading-hedge" aria-label="Hedge activity zones"><strong>Hedge activity zones</strong><p>Peak prices require an eligible sensitivity curve.</p>${legend}</div>`;
  }
  const flow=activity.signed;
  const metrics=flow?sellingPeaks(activity).map(({behavior,sellOn,buyOn,zone,grossRate,grossPrice})=>
    `<div data-flow-behavior="${behavior}"><span>Most net selling on a ${sellOn}</span>
      ${zone?`<b>${f(zone.price,2)}</b><small>${e(flowNumber(zone.rate))} ${units} after offsetting</small>
      <small class="reading-hedge-response">Also peak net buying on a ${buyOn}</small>
      <small>Shaded range ${f(zone.lower,2)}–${f(zone.upper,2)}${zone.clipped?' · reaches the chart edge':''}</small>`:'<b>None in chart range</b>'}
      ${grossRate>0?`<small class="reading-hedge-reference">Gross sell peak ${f(grossPrice,2)} · ${e(flowNumber(grossRate))} ${units}</small>`:''}
    </div>`).join(''):
    `<div data-flow-behavior="unknown"><span>Strongest total sensitivity in view</span><b>${activity.peakGross.gross>0?f(activity.peakGross.price,2):'None in view'}</b><small>${e(flowNumber(activity.peakGross.gross))} ${units} · before any offsetting</small></div><div data-flow-behavior="unknown"><span>Net buying / selling</span><b>Direction unavailable</b><small>${autoFlow&&!allFlowExpiries?'This expiry subset has no matching signed gamma.':'Signed strike gamma is unavailable.'} Total sensitivity remains visible; it cannot establish net pressure.</small></div>`;
  const basis=autoFlow?(zeroDteExposure?'Saved 0DTE Net GEX signs with Futu OI sizes':'Saved strike-sign scenario with Futu OI sizes'):`Manual ${side}-gamma scenario`;
  return `<div class="reading-hedge" aria-label="Hedge activity zones">
    <div class="reading-hedge-heading"><strong>Hedge activity zones</strong><span class="reading-hedge-caption">${options.scopeLabel} · modeled peaks in chart range</span></div>
    <div class="reading-hedge-peaks" aria-label="Modeled hedge peaks and price ranges">${metrics}</div>
    ${flow?'<p>Each box covers the prices around its net peak with at least half its rate. Hollow dots show gross peaks before offsetting.</p>':''}
    <p>${flow?`${basis} · ${flow.modeledLevels}/${flowLenses.length} strikes signed${activity.unsignedLevels?` · ${activity.unsignedLevels} unsigned strikes excluded from net zones`:''}`:`Unsigned sensitivity · ${activity.modeledLevels}/${flowLenses.length} strikes modeled`}${activity.partialCoverage?' · partial option coverage':''} · ${f(flowShare*100,1)}% OI assumption · Fixed IV and time · Actual dealer inventory unknown</p>
    ${legend}</div>`;
}

function flowPlot(activity,{x,L,right,top,height}){
  const flow=activity.signed;
  const plotTop=top+(flow?hedgePeakLane:0),plotHeight=height-(flow?2*hedgePeakLane:0);
  const bottom=plotTop+plotHeight;
  const max=Math.max(flow?Math.max(flow.peakBuy.buy,flow.peakSell.sell):activity.peakGross.gross,Number.MIN_VALUE);
  const middle=flow?plotTop+plotHeight/2:bottom-8,amplitude=flow?plotHeight/2-9:plotHeight-20;
  const y=rate=>middle-rate/max*amplitude;
  const path=activity.points.map((point,i)=>`${i?'L':'M'}${x(point.price).toFixed(2)},${y(flow?point.net:point.gross).toFixed(2)}`).join(' ');
  const groups=flow?sellingPeaks(activity):[
    {behavior:'unknown', sign:1, grossPrice:activity.peakGross.price, grossRate:activity.peakGross.gross}
  ];
  const zones=groups.filter(({zone})=>zone).map(({behavior,sign,sellOn,zone})=>
    `<g data-flow-behavior="${behavior}">
      <rect class="reading-hedge-zone" x="${x(zone.lower)}" y="${sign===1?plotTop:middle}" width="${Math.max(0,x(zone.upper)-x(zone.lower))}" height="${plotHeight/2}">
        <title>Net selling on a ${sellOn}, at least half its peak rate from ${f(zone.lower,2)} to ${f(zone.upper,2)}</title>
      </rect>
    </g>`).join('');
  const grossMarkers=groups.map(({behavior,sign,grossPrice,grossRate,zone})=>{
    if(!(grossRate>0))return '';
    const px=x(grossPrice),py=y(sign*grossRate);
    const label=`${flow?'Gross':'Total peak'} ${f(grossPrice,2)}`;
    const width=label.length*7.5+12;
    const netX=zone?x(zone.price):px;
    const netCrowdsLabel=netX>px&&netX<px+width;
    const anchor=px+width>right||(netCrowdsLabel&&px-width>=L)?'end':'start';
    const labelX=px+(anchor==='end'?-9:9);
    const labelY=sign===1?Math.min(middle-5,py+4):Math.max(middle+13,py+4);
    return `<g data-flow-behavior="${behavior}">
      <line class="reading-hedge-peak-line" x1="${px}" x2="${px}" y1="${middle}" y2="${py}"/>
      <circle class="reading-hedge-gross-peak" cx="${px}" cy="${py}" r="5.5"/>
      <text class="reading-hedge-peak-price" x="${labelX}" y="${labelY}" text-anchor="${anchor}">${label}</text>
    </g>`;
  }).join('');
  const netMarkers=groups.filter(({zone})=>zone).map(({behavior,sign,sellOn,zone})=>{
    const px=x(zone.price),py=y(sign*zone.rate);
    const label=`Net sell on ${sellOn} ≈ ${f(zone.price,2)}`;
    const width=label.length*8+16;
    const labelX=Math.max(L+width/2,Math.min(right-width/2,px));
    const labelY=sign===1?top:bottom+6;
    return `<g data-flow-behavior="${behavior}" class="reading-hedge-net-marker">
      <line class="reading-hedge-peak-line" x1="${px}" x2="${px}" y1="${sign===1?labelY+20:labelY}" y2="${py}"/>
      <circle class="reading-hedge-net-peak" cx="${px}" cy="${py}" r="3.5"/>
      <rect class="reading-hedge-net-label" x="${labelX-width/2}" y="${labelY}" width="${width}" height="20" rx="4"/>
      <text class="reading-hedge-peak-price" x="${labelX}" y="${labelY+14}" text-anchor="middle">${label}</text>
    </g>`;
  }).join('');
  const description=flow?'Modeled net selling peaks for rising and falling prices. Filled dots mark net peaks, hollow dots mark gross peaks.':'Total unsigned sensitivity by price. Net direction is unavailable.';
  return `<g class="reading-hedge-plot${flow?'':' reading-hedge-unsigned'}" role="img" aria-label="${description}">
    <defs><linearGradient id="reading-net-flow-color" gradientUnits="userSpaceOnUse" x1="0" y1="${plotTop}" x2="0" y2="${bottom}"><stop offset="50%" class="reading-hedge-buy-stop"/><stop offset="50%" class="reading-hedge-sell-stop"/></linearGradient></defs>
    <rect class="reading-hedge-background" x="${L}" y="${plotTop}" width="${right-L}" height="${plotHeight}" rx="7"/>
    ${zones}
    <path class="reading-hedge-net-area" d="${path} L${right},${middle} L${L},${middle} Z"/><path class="reading-hedge-net-line" d="${path}"/>
    <line x1="${L}" x2="${right}" y1="${middle}" y2="${middle}"/>
    <text data-flow-behavior="${flow?'amplifying':'unknown'}" x="${L-10}" y="${plotTop+16}" text-anchor="end">${flow?'Amplify':'Total'}</text>
    <text x="${L-10}" y="${middle+4}" text-anchor="end">0</text>
    ${flow?`<text data-flow-behavior="damping" x="${L-10}" y="${bottom-6}" text-anchor="end">Dampen</text>`:''}
    ${grossMarkers}${netMarkers}
  </g>`;
}

function drawPricePlot(c,price,market,options){
  const W=1100,H=570,L=78,R=45,T=62,B=155,x=v=>L+(v-c.lo)/(c.hi-c.lo)*(W-L-R),y=v=>H-B-v*(H-B-T);
  const flow=c.hedgeFlow,flowHeight=flow?126+(flow.signed?2*hedgePeakLane:0):0;
  const dexHeight=options.netDex?114:0,bandHeight=flowHeight+dexHeight,chartHeight=H+bandHeight;
  const path=fn=>c.points.map((p,i)=>`${i?'L':'M'}${x(p.price).toFixed(2)},${y(fn(p)).toFixed(2)}`).join(' ');
  const selectedIndex=c.chosen.findIndex(lens=>lens.key===options.selectedKey);
  const selected=c.chosen[selectedIndex];
  const {overall,transitions,scopeLabel}=options;
  const transitionColor=selected?colors[selectedIndex]:overallColor;
  const visibleTransitions=transitions.filter(t=>t.price>=c.lo&&t.price<=c.hi);
  return `<div class="reading-chart-scroll" tabindex="0" aria-label="Strike curves. Left and right arrow keys pan. Plus and minus zoom. Up and down explore prices." aria-describedby="reading-probe-hint"><svg class="reading-chart reading-space-chart" viewBox="0 0 ${W} ${chartHeight}" role="group" aria-label="${scopeLabel} build and fade. Curves are normalized to their own peaks. Snapshot price ${f(price,2)}. Planets are centered at their strike prices.">
    <defs><clipPath id="reading-space-plot"><rect x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" rx="8"/></clipPath><radialGradient id="reading-planet-shade"><stop offset="0" stop-color="#d9efff" stop-opacity=".13"/><stop offset=".56" stop-color="#071020" stop-opacity="0"/><stop offset="1" stop-color="#020611" stop-opacity=".68"/></radialGradient><filter id="reading-planet-shadow" x="-35%" y="-35%" width="170%" height="170%"><feDropShadow dx="2" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".8"/></filter></defs>
    <rect class="reading-chart-backdrop" x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B+120+bandHeight}" fill="#142039" opacity=".4"/>
    <rect x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B+120+bandHeight}" rx="8" fill="#020711" fill-opacity=".54"/>
    ${[0,.25,.5,.75,1].map(n=>`<line x1="${L}" x2="${W-R}" y1="${y(n)}" y2="${y(n)}" stroke="#fff" stroke-opacity=".08"/><text x="${L-12}" y="${y(n)+6}" text-anchor="end">${n*100}%</text>`).join('')}
    <g clip-path="url(#reading-space-plot)">${c.chosen.map((l,i)=>`<path class="reading-strike-line" data-lens-strike="${e(l.key)}" role="button" tabindex="0" aria-label="Select strike ${f(l.strike,2)} delta range" d="${path(p=>p.ratios[i])}" fill="none" stroke="${colors[i]}" stroke-width="${i===selectedIndex?'3':'1.6'}" stroke-opacity="${i===selectedIndex?'1':'.42'}" stroke-linecap="round" ${l.expiryScope!=='later'&&l.expiryCoverage?.zeroDteRows>0?'stroke-dasharray="3 4"':i>=4?'stroke-dasharray="7 5"':''}/>${price>=c.lo&&price<=c.hi?`<circle cx="${x(price)}" cy="${y(c.currentRatios[i])}" r="${i===selectedIndex?'5':'3.5'}" fill="${colors[i]}" stroke="#0c131d" stroke-width="1.5"><title>Strike ${f(l.strike)}: ${f(c.currentRatios[i]*100)}% of own peak at snapshot price</title></circle>`:''}`).join('')}
    ${overall?`<path class="reading-overall-line" d="${path(p=>Math.min(1,p.total/overall.peak))}" fill="none" stroke="${overallColor}" stroke-width="3.5" stroke-linecap="round"/>${price>=c.lo&&price<=c.hi?`<circle cx="${x(price)}" cy="${y(Math.min(1,c.totalAtPrice/overall.peak))}" r="5" fill="${overallColor}" stroke="#0c131d" stroke-width="1.5"/>`:''}`:''}</g>
    ${deltaMarkers(options.delta,c,x,{L,R,W,T,bottom:H-B})}
    ${visibleTransitions.map((transition,index)=>{
      const label=`${overall?'All strikes':scopeLabel} · ${transition.kind==='build'?'Build':'Fade'} ≈ ${f(transition.price,2)}`;
      const width=label.length*10+18;
      const labelX=Math.max(L+width/2,Math.min(W-R-width/2,x(transition.price)));
      const labelY=H-B-24-index*32;
      return `<g class="reading-transition"><line x1="${x(transition.price)}" x2="${x(transition.price)}" y1="${T}" y2="${H-B}" stroke="${transitionColor}" stroke-opacity=".75" stroke-width="1.5" stroke-dasharray="2 5"/><rect x="${labelX-width/2}" y="${labelY-17}" width="${width}" height="27" rx="4" fill="#111e2c"/><text x="${labelX}" y="${labelY+2}" text-anchor="middle">${label}</text></g>`;
    }).join('')}
    ${flowHeight?flowPlot(flow,{x,L,right:W-R,top:H-B+7,height:flowHeight-11}):''}
    ${dexHeight?netDexPlot(options.netDex,{x,left:L,right:W-R,top:H-B+flowHeight+7,height:dexHeight-11,lo:c.lo,hi:c.hi,selectedStrike:options.dexStrike}):''}
    ${price>=c.lo&&price<=c.hi?`<line x1="${x(price)}" x2="${x(price)}" y1="${T}" y2="${H-B+bandHeight}" stroke="#fff" stroke-opacity=".6" stroke-dasharray="4 5" stroke-width="1"/><text class="reading-price-label" x="${Math.max(L+100,Math.min(W-R-100,x(price)))}" y="36" text-anchor="middle">Snapshot ${f(price,2)}</text>`:`<text class="reading-offscreen-price" x="${L}" y="36">Snapshot ${f(price,2)} · outside observation window</text>`}
    <g data-probe-marker visibility="hidden" aria-hidden="true">
      <line x1="0" x2="0" y1="${T}" y2="${H-B+bandHeight}" stroke="#ffd48b" stroke-width="2.5"/>
      <text class="reading-scenario-label" data-probe-marker-label y="18" text-anchor="middle"></text>
      ${c.chosen.map((_,i)=>`<circle data-probe-dot cx="0" cy="0" r="6" fill="${colors[i]}" stroke="#0a1525" stroke-width="2"/>`).join('')}
      ${overall?`<circle data-overall-dot cx="0" cy="0" r="6.5" fill="${overallColor}" stroke="#0a1525" stroke-width="2"/>`:''}
    </g>
    <rect data-probe-hit data-sensitivity-height="${H-T-B}" x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B+bandHeight}" fill="transparent" aria-hidden="true"/>
    ${spaceBodies(c,market,options,colors,x,H-B+55+bandHeight)}
    ${[0,.25,.5,.75,1].map(n=>`<text x="${x(c.lo+n*(c.hi-c.lo))}" y="${chartHeight-22}" text-anchor="middle">${f(c.lo+n*(c.hi-c.lo),2)}</text>`).join('')}<text x="${(L+W-R)/2}" y="${chartHeight-3}" text-anchor="middle">Futures price · planets anchored at strikes</text></svg></div>
    <div class="reading-plot-readout"><div><strong data-probe-price>Scenario ${f(price,2)}</strong><small data-probe-summary>At snapshot price</small>${overall?'<small data-overall-probe></small>':''}${flow?'<small data-hedge-probe></small>':''}${dexHeight?'<small data-dex-probe hidden></small>':''}</div><button data-probe-reset type="button">Back to snapshot</button></div>
    <div class="reading-transitions"><strong>${scopeLabel} · sensitivity transitions</strong>${transitions.length>visibleTransitions.length?`<button type="button" class="reading-fit" data-lens-range="${Math.max(...transitions.map(t=>Math.abs(t.price-price)))*1.15}">Show transition prices</button>`:''}<div>${transitions.length?transitions.map(t=>`<span><b>${t.kind==='build'?'Fastest build':'Fastest fade'} ≈ ${f(t.price,2)}</b><small>${f(t.percentagePointsPerPoint,2)} percentage points / price point${t.price<c.lo||t.price>c.hi?' · outside view':''}</small></span>`).join(''):'<span>No clear transition resolved for this profile.</span>'}</div><p>As price rises → · fixed IV at ${options.elapsedMinutes?'selected +'+options.elapsedMinutes+' min scenario':'snapshot time'}</p></div>`;
}

function bindPriceProbe(root, curve, snapshot, contract, prefs, overall, navigation, options) {
  const hit = root.querySelector('[data-probe-hit]');
  const reset = root.querySelector('[data-probe-reset]');
  const priceLabel = root.querySelector('[data-probe-price]');
  const summary = root.querySelector('[data-probe-summary]');
  const marker = root.querySelector('[data-probe-marker]');
  const markerLabel = marker.querySelector('[data-probe-marker-label]');
  const overallDot = marker.querySelector('[data-overall-dot]');
  const overallReadout = root.querySelector('[data-overall-probe]');
  const hedgeReadout = root.querySelector('[data-hedge-probe]');
  const dexReadout = root.querySelector('[data-dex-probe]');
  const dots = [...marker.querySelectorAll('[data-probe-dot]')];
  const values = [...root.querySelectorAll('[data-probe-ratio]')].sort((a,b)=>Number(a.dataset.probeRatio)-Number(b.dataset.probeRatio));
  const changes = [...root.querySelectorAll('[data-probe-change]')].sort((a,b)=>Number(a.dataset.probeChange)-Number(b.dataset.probeChange));
  const plotX = Number(hit.getAttribute('x'));
  const plotY = Number(hit.getAttribute('y'));
  const width = Number(hit.getAttribute('width'));
  const height = Number(hit.dataset.sensitivityHeight);
  const span = curve.hi - curve.lo;

  function showPrice(requestedPrice) {
    const price = finite(requestedPrice)&&requestedPrice>0?requestedPrice:snapshot;
    const insideWindow=price>=curve.lo&&price<=curve.hi;
    const move = price - snapshot;
    const atSnapshot = Math.abs(move) < .005;
    const ratios = !insideWindow&&!atSnapshot?curve.chosen.map(l=>Math.max(0,Math.min(1,l.slopeAt(price)/l.profile.peak))):sampleMarketCurve(curve, atSnapshot ? snapshot : price, snapshot);
    const plotFraction = (price - curve.lo) / span;
    priceLabel.textContent = `Scenario ${f(atSnapshot ? snapshot : price, 2)}`;
    summary.textContent = atSnapshot ? `At snapshot price${insideWindow?'':' · outside observation window'}` : `${f(Math.abs(move),2)} pts ${move < 0 ? 'below' : 'above'} snapshot${insideWindow?'':' · outside observation window'}`;
    prefs.chartProbe = atSnapshot ? null : {contract, price};
    marker.setAttribute('visibility', atSnapshot||!insideWindow ? 'hidden' : 'visible');
    const cursorX=plotX+plotFraction*width;
    marker.setAttribute('transform', `translate(${cursorX}, 0)`);
    markerLabel.textContent=`Scenario ${f(price,2)}`;
    markerLabel.setAttribute('x',String(Math.max(plotX+100,Math.min(plotX+width-100,cursorX))-cursorX));
    if (overall && overallDot && overallReadout) {
      const sensitivity = atSnapshot ? curve.totalAtPrice : overall.slopeAt(price);
      const ratio = Math.min(1, sensitivity / overall.peak);
      overallDot.setAttribute('cy', String(plotY + (1 - ratio) * height));
      overallReadout.textContent = `${f(ratio * 100)}% of combined peak`;
    }
    if (hedgeReadout) {
      const {net,gross}=curve.hedgeFlow.sample(atSnapshot?snapshot:price),units=flowUnits({underlyingCode:contract});
      const reading=net===null?'Net direction unavailable':net===0?'Signed contributions cancel here':
        `${curve.hedgeFlow.unsignedLevels?'Signed subset net':'Net'} ${flowNumber(Math.abs(net))} ${units} · Rise → ${net>0?'buy':'sell'} · Fall → ${net>0?'sell':'buy'}`;
      hedgeReadout.textContent=`${reading} · Total potential ${flowNumber(gross)} ${units}`;
    }
    if (dexReadout) {
      const reading=netDexAtProbe(options.netDex,curve,price);
      dexReadout.textContent=reading;
      dexReadout.hidden=!reading;
    }
    ratios.forEach((ratio, i) => {
      const change = Math.round((ratio - curve.currentRatios[i]) * 1000) / 10;
      dots[i].setAttribute('cy', String(plotY + (1 - ratio) * height));
      values[i].closest?.('.gravity-card')?.querySelector('.gravity-body')?.style.setProperty('--activity', String(ratio));
      values[i].textContent = `${f(ratio * 100)}%`;
      changes[i].textContent = atSnapshot
        ? `${f((1 - ratio) * 100)}% faded · at snapshot price`
        : `${change > 0 ? '+' : ''}${f(change || 0)} pp vs snapshot`;
    });
  }

  function pointAt(clientX) {
    const bounds = hit.getBoundingClientRect();
    if (bounds.width > 0) showPrice(curve.lo + Math.max(0,Math.min(1,(clientX - bounds.left) / bounds.width)) * span);
  }

  hit.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch' && !navigation.isPressing()) pointAt(event.clientX);
  });
  hit.addEventListener('click', event => {
    pointAt(event.clientX);
    const bounds=hit.getBoundingClientRect();if(!(bounds.width>0&&bounds.height>0))return;
    const price=curve.lo+Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width))*span;
    const sensitivityHeight=bounds.height*height/Number(hit.getAttribute('height')),offset=event.clientY-bounds.top;
    if(offset>sensitivityHeight)return;
    const ratios=sampleMarketCurve(curve,price,snapshot);
    const nearest=ratios.map((ratio,i)=>({key:curve.chosen[i].key,distance:Math.abs((1-ratio)*sensitivityHeight-offset)})).sort((a,b)=>a.distance-b.distance)[0];
    if(nearest?.distance<=14){
      if(overall?.modeledLevels>1){
        const ratio=Math.min(1,overall.slopeAt(price)/overall.peak);
        const overallDistance=Math.abs((1-ratio)*sensitivityHeight-offset);
        if(overallDistance<=nearest.distance)return;
      }
      hit.dispatchEvent(new CustomEvent('lens-strike-select',{bubbles:true,detail:nearest.key}));
    }
  });
  const scroller=hit.closest('.reading-chart-scroll');
  scroller.addEventListener('keydown',event=>{
    if(event.target!==scroller||event.ctrlKey||event.metaKey||event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();
    const current=prefs.chartProbe?.price??snapshot;
    showPrice(Math.max(curve.lo,Math.min(curve.hi,current+(event.key==='ArrowUp'?1:-1)*span/100)));
  });
  reset.addEventListener('click', () => showPrice(snapshot));
  const saved = prefs.chartProbe;
  showPrice(saved?.contract === contract && finite(saved?.price) ? saved.price : snapshot);
}
