import { evaluateSnapshot, greeks, hedgeAdjustment } from './core/engine.mjs';
import { initMarketWatch } from './market-watch.mjs';
import { toNewYorkInput, newYorkToIso, parseWatchLevels, validateReading, applyReading } from './core/manual-workflow.mjs';

const $ = (id) => document.getElementById(id);
const MARKET_INFO = {
  NQ: { name: 'Nasdaq 100', multiplier: 20, step: 25, price: 28720, iv: .2 },
  ES: { name: 'S&P 500', multiplier: 50, step: 10, price: 6852, iv: .18 },
  CL: { name: 'Crude oil', multiplier: 1000, step: .25, price: 70.38, iv: .34 },
  GC: { name: 'Gold', multiplier: 100, step: 5, price: 3987.5, iv: .22 },
};
const state = { market: 'NQ', snapshots: new Map(), selectedStrike: null, detailKey: null, selectedProvider: 'menthorq', connected: false, fetching: false, timer: null, analyses: new Map(), lastImportName: null };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const fmt = (n, digits = 0) => finite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const priceFmt = (n) => fmt(n, state.market === 'CL' || state.market === 'GC' ? 2 : (finite(n) && n % 1 ? 2 : 0));
const compact = (n) => {
  if (!finite(n)) return '—';
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  return sign + (a >= 1e9 ? fmt(a / 1e9, 2) + 'B' : a >= 1e6 ? fmt(a / 1e6, 2) + 'M' : a >= 1e3 ? fmt(a / 1e3, 2) + 'K' : fmt(a, 2));
};
const current = () => state.snapshots.get(state.market);
const sourceStatus = (s) => s?.source?.status || s?.status || 'snapshot';
const isExample = (s) => sourceStatus(s) === 'example';
const localClock = (iso) => new Date(iso).toISOString().slice(11,19) + ' UTC';
const utcClock = (iso) => new Date(iso).toISOString().slice(11,19);
const absoluteTime = (iso) => new Date(iso).toISOString().replace('T',' ').replace(/\.\d{3}Z$/,' UTC');
const nyTime = (iso) => new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
const series = (row) => row.reading ? {...row,...row.reading,modelBasis:'single-series'} : row;
const readingPrice = (snapshot,row) => row.reading?.futuresPrice ?? snapshot.futuresPrice;

function showToast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function showNotice(message, error = false) { $('notice').textContent = message; $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = !message; }

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose a JSON snapshot object with market, futuresPrice, asOf and levels.');
  const market = String(raw.market || '').toUpperCase();
  if (!MARKET_INFO[market]) throw new Error('The snapshot market must be NQ, ES, CL or GC.');
  const futuresPrice = raw.futuresPrice ?? raw.underlyingPrice;
  if (!finite(futuresPrice) || futuresPrice <= 0) throw new Error('The snapshot needs a positive futuresPrice.');
  if (!raw.asOf || !Number.isFinite(Date.parse(raw.asOf))) throw new Error('The snapshot needs a valid asOf timestamp including its time zone.');
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(raw.asOf)) throw new Error('The asOf timestamp must include Z or an explicit time-zone offset.');
  if (Date.parse(raw.asOf) > Date.now() + 5 * 60 * 1000) throw new Error('The snapshot timestamp is in the future. Check the source clock and time zone.');
  const inputLevels = raw.levels || raw.rows;
  if (!Array.isArray(inputLevels) || !inputLevels.length || inputLevels.length > 10000) throw new Error('The snapshot needs between 1 and 10,000 option levels.');
  const levels = inputLevels.map((row, index) => {
    if (!row || !finite(row.strike) || row.strike <= 0 || !finite(row.gex)) throw new Error(`Level ${index + 1} needs a positive strike and a numeric gex.`);
    const iv = row.iv ?? raw.iv ?? null;
    if (iv !== null && (!finite(iv) || iv <= 0 || iv > 10)) throw new Error(`Level ${index + 1}: enter IV as a decimal, such as 0.20 for 20%.`);
    const expiry = row.expiry || raw.expiry || null;
    if (expiry !== null && (!Number.isFinite(Date.parse(expiry)) || !/(Z|[+-]\d\d:\d\d)$/i.test(expiry))) throw new Error(`Level ${index + 1} needs an exact expiry timestamp with a time-zone offset.`);
    const optionType = String(row.optionType || '').toLowerCase();
    const dealerSide = String(row.dealerSide || 'unknown').toLowerCase();
    let reading=null;
    if(row.reading){reading=validateReading({...row.reading,ivPercent:row.reading.iv*100});if(reading.contract.toUpperCase()!==String(raw.contract||market).trim().toUpperCase())throw new Error(`Level ${index+1}: chain reading uses a different underlying contract.`);if(Date.parse(reading.asOf)<Date.parse(raw.asOf))throw new Error(`Level ${index+1}: chain reading is older than the GEX snapshot.`);}
    return { ...row, reading, _key: `${row.strike}|${expiry || ''}|${optionType}|${index}`, iv, expiry, modelBasis:row.modelBasis || raw.modelBasis || null, optionType: ['put','call'].includes(optionType) ? optionType : null, dealerSide: ['short','long'].includes(dealerSide) ? dealerSide : 'unknown', exerciseStyle: row.exerciseStyle || raw.exerciseStyle || null, allowEuropeanApproximation: row.allowEuropeanApproximation ?? raw.allowEuropeanApproximation ?? false, optionMultiplier: row.optionMultiplier ?? raw.optionMultiplier ?? null, hedgeMultiplier: row.hedgeMultiplier ?? raw.hedgeMultiplier ?? null };
  });
  const source = typeof raw.source === 'object' && raw.source ? {...raw.source} : {provider: String(raw.source || 'Imported snapshot'),status:'snapshot'};
  const validStatuses = ['live','delayed','example','snapshot','frozen','stale'];
  if (!validStatuses.includes(source.status)) source.status = 'snapshot';
  return {...raw, market, futuresPrice, source, levels, rate: finite(raw.rate) ? raw.rate : 0, gexUnit: String(raw.gexUnit || 'Source units'), contract: String(raw.contract || market), asOf: new Date(raw.asOf).toISOString()};
}

function buildExample(market) {
  const info = MARKET_INFO[market], asOf = new Date(), expiry = new Date(asOf.getTime() + 120 * 60000);
  const baseStrike = Math.round(info.price / info.step) * info.step;
  const offsets = [1,-1,-3,-5,3,5,-7,7,-9,9,11,-11];
  const exposures = [-107840,-23620,-31670,-26510,-17240,-52150,18600,-16640,-14850,12900,-22700,-9400];
  const scale = market === 'NQ' ? 1 : market === 'ES' ? 1.3 : market === 'CL' ? .7 : .8;
  return normalizeSnapshot({ schemaVersion:1, market, contract:`${market} · illustrative future`, futuresPrice: info.price, asOf: asOf.toISOString(), expiry: expiry.toISOString(), source:{provider:'Illustrative example',status:'example'}, gexUnit:'Illustrative USD per 1% move', rate:0, exerciseStyle:'european', modelBasis:'single-series', levels: offsets.map((offset,i) => ({strike: Number((baseStrike + offset * info.step).toFixed(4)), gex:exposures[i] * scale, iv: info.iv + .003 * (i % 3), optionType:'put', dealerSide:exposures[i] < 0 ? 'short' : 'long', optionMultiplier:info.multiplier,hedgeMultiplier:info.multiplier})) });
}

function parameters(snapshot, row, overrides = {}) {
  const input=series(row);
  return {futuresPrice:readingPrice(snapshot,row),strike:row.strike,iv:input.iv,expiry:input.expiry,now:row.reading?.asOf??snapshot.asOf,rate:snapshot.rate,optionType:input.optionType,exerciseStyle:input.exerciseStyle,allowEuropeanApproximation:input.allowEuropeanApproximation,...overrides};
}
function analyze(snapshot, row) {
  const original=row;row=series(row);
  if (row.modelBasis !== 'single-series') return {available:false,reason:'Needs chain data'};
  if (!['european','american'].includes(row.exerciseStyle)) return {available:false,reason:'Exercise style missing'};
  if (!row.iv) return {available:false,reason:'IV missing'};
  if (!row.expiry) return {available:false,reason:'Expiry missing'};
  if (!row.optionType) return {available:false,reason:'Option type missing'};
  try {
    const result = evaluateSnapshot(parameters(snapshot,original));
    if (result.status === 'expired') return {available:false,reason:'Expired',result};
    if (!result.greeks || !result.thresholds) return {available:false,reason:'Model unavailable',result};
    const remaining = Math.max(0,Math.min(100,100 * result.greeks.gamma / result.thresholds.peakGamma));
    return {available:true,result,remaining};
  } catch (error) { return {available:false,reason: 'Model input unavailable',detail:error.message}; }
}

function freshness(snapshot) {
  const original = sourceStatus(snapshot), age = Math.max(0,(Date.now()-Date.parse(snapshot.asOf))/1000);
  if (original === 'example') return {className:'example',label:'Example data',time:`Illustration · ${localClock(snapshot.asOf)}`};
  if(snapshot._manual)return {className:'',label:'Morning GEX snapshot',time:`${snapshot.source.provider} · ${nyTime(snapshot.asOf)}`};
  if (snapshot._imported) return {className:'',label:'Imported snapshot',time:`${snapshot.source.provider || 'Imported source'} · ${localClock(snapshot.asOf)}`};
  if (original === 'live' && age > (snapshot.source.staleAfterSeconds || 30)) return {className:'stale',label:'Stale data',time:`Last update ${Math.floor(age)}s ago`};
  const labels = {live:'Live data',delayed:'Delayed data',frozen:'Frozen data',snapshot:'Imported snapshot',stale:'Stale data'};
  return {className:original === 'live' ? 'live' : ['delayed','stale','frozen'].includes(original) ? 'delayed' : '',label:labels[original] || 'Snapshot',time:`${snapshot.source.provider || 'Data source'} · ${localClock(snapshot.asOf)}`};
}

function render() {
  const snapshot = current();
  $('export-button').disabled=!snapshot;
  document.querySelectorAll('[data-market]').forEach((button) => { const active = button.dataset.market === state.market; button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex = active ? 0 : -1; });
  $('empty-state').hidden = !!snapshot; $('levels-table-wrap').hidden = !snapshot;
  $('detail-placeholder').hidden = !!snapshot; $('detail-content').hidden = !snapshot;
  $('level-count').textContent = snapshot ? `${snapshot.levels.length} watched levels` : '0 levels';
  if (!snapshot) {
    $('source-badge').className='status-pill'; $('source-badge').innerHTML='<span></span>Not connected'; $('source-time').textContent='Waiting for a snapshot';
    $('market-price').innerHTML='—<span class="metric-unit">pts</span>';$('market-contract').textContent='Save a morning watchlist to begin';$('net-gex').textContent='—';$('net-gex').className='metric-value';$('gex-caption').textContent='Position assumptions stay visible';$('expiry-value').textContent='—';$('expiry-caption').textContent='Exact expiration time is required';$('quality-value').textContent='No data';$('quality-caption').textContent='IV, price and time checked together';$('detail-title').textContent='Choose a strike';$('detail-option').textContent='—';renderHistory();return;
  }
  const fresh = freshness(snapshot);
  $('source-badge').className='status-pill '+fresh.className;$('source-badge').innerHTML=`<span></span>${esc(fresh.label)}`;$('source-time').textContent=fresh.time;$('source-time').title=absoluteTime(snapshot.asOf);
  $('market-price').innerHTML=`${esc(priceFmt(snapshot.futuresPrice))}<span class="metric-unit">${snapshot.market === 'CL' || snapshot.market === 'GC' ? 'USD' : 'pts'}</span>`;
  $('market-contract').textContent=snapshot.contract;
  const net=snapshot.levels.reduce((sum,row)=>sum+row.gex,0);$('net-gex').textContent=compact(net);$('net-gex').className='metric-value '+(net<0?'negative':'positive');$('gex-caption').textContent=snapshot.gexUnit;
  const expiries=[...new Set(snapshot.levels.map(row=>series(row).expiry).filter(Boolean))].sort();
  if (expiries.length===1) { $('expiry-value').textContent=nyTime(expiries[0]);$('expiry-caption').textContent='Exact expiry · remaining time uses each reading'; }
  else { $('expiry-value').textContent=expiries.length?'Multiple expirations':'Not supplied';$('expiry-caption').textContent=expiries.length?`${expiries.length} expirations in supplied scope`:'Supply the exact option expiration'; }
  state.analyses.clear();snapshot.levels.forEach(row=>state.analyses.set(row._key,analyze(snapshot,row)));
  const available=[...state.analyses.values()].filter(a=>a.available).length;
  $('quality-value').textContent=available===snapshot.levels.length?'Model ready':available?`${available} series ready`:snapshot.levels.some(r=>r.reading)?'Reading saved':'GEX only';
  $('quality-caption').textContent=available?'Selected series · IV and time held fixed': 'Add a chain reading at a watched level';
  const rows=[...snapshot.levels].sort((a,b)=>Math.abs(b.gex)-Math.abs(a.gex));
  if (!rows.some(row=>row._key===state.selectedStrike)) state.selectedStrike=rows[0]?._key;
  const maximum=Math.max(...rows.map(row=>Math.abs(row.gex)),1);
  $('levels-body').innerHTML=rows.map((row,index)=>{
    const a=state.analyses.get(row._key),distance=snapshot.futuresPrice-row.strike,selected=row._key===state.selectedStrike;
    const direction=row.dealerSide==='unknown'?'Unknown':row.dealerSide==='short'?'Sell more':'Buy more';
    const directionClass=row.dealerSide==='short'?'negative':row.dealerSide==='long'?'positive':'';
    return `<tr class="level-row${selected?' selected':''}" data-level="${esc(row._key)}" tabindex="0" aria-label="Explore strike ${esc(priceFmt(row.strike))}"><td><div class="strike-cell"><span class="rank">${String(index+1).padStart(2,'0')}</span><div class="strike-data"><div class="strike-value">${esc(priceFmt(row.strike))}</div><div class="exposure-line"><span class="exposure-value ${row.gex<0?'negative':'positive'}">${esc(compact(row.gex))}</span><span class="gex-track"><span class="${row.gex>=0?'pos':''}" style="width:${100*Math.abs(row.gex)/maximum}%"></span></span></div></div></div></td><td><span class="distance-value">${distance>0?'+':distance<0?'−':''}${esc(priceFmt(Math.abs(distance)))}</span><span class="distance-label">at GEX snapshot</span></td><td>${a.available?`<span class="gamma-percent">${fmt(a.remaining,1)}%</span><div class="gamma-meter"><span style="width:${a.remaining}%"></span></div><span class="small-assumption">${esc(nyTime(row.reading?.asOf??snapshot.asOf))}</span>`:`<span class="no-estimate">${row.reading?'Reading saved':'Unavailable'}</span><span class="small-assumption">${esc(a.reason)}</span>`}</td><td><span class="hedge-label ${directionClass}">${esc(direction)}</span><span class="small-assumption">${row.dealerSide==='unknown'?'Dealer side missing':`Assumed ${row.dealerSide} Gamma`}</span></td></tr>`;
  }).join('');
  renderDetail();renderHistory();
}

function renderDetail() {
  const snapshot=current(),row=snapshot?.levels.find(item=>item._key===state.selectedStrike);if(!row)return;
  const input=series(row),a=state.analyses.get(row._key);$('detail-title').textContent=priceFmt(row.strike);$('detail-option').textContent=input.optionType?`${input.optionType.toUpperCase()} · SINGLE SERIES`:'NET EXPOSURE';
  const r=row.reading;
  $('reading-summary').innerHTML=r?`<strong>${esc(r.provider)} · ${esc(nyTime(r.asOf))}</strong><span>Future ${esc(priceFmt(r.futuresPrice))} · ${esc(r.contract)} · ${esc(r.optionType.toUpperCase())}</span><div class="observed-greeks"><span>IV <b>${fmt(r.iv*100,2)}%</b></span><span>Delta <b>${fmt(r.observedDelta,4)}</b></span><span>Gamma <b>${fmt(r.observedGamma,4)}</b></span><span>OI <b>${fmt(r.openInterest)}</b></span></div><span>Displayed values as entered; Greek model and units unverified. These are not live.</span>`:'No arrival reading yet. Open the option chain when price reaches this level, then enter that series’ values here.';
  $('gamma-value').textContent=a.available?`${fmt(a.remaining,1)}%`:'Unavailable';$('gamma-description').textContent=a.available?`${fmt(100-a.remaining,1)}% faded from modeled peak`:a.reason;
  $('gamma-ring').style.background=`conic-gradient(var(--cyan) ${(a.remaining||0)*3.6}deg,#21373d 0deg)`;$('gamma-ring-label').textContent=a.available?`${fmt(a.remaining,0)}%`:'—';
  $('detail-iv').textContent=input.iv?`IV ${fmt(input.iv*100,2)}% · one series`:'IV missing';
  $('profile-chart').innerHTML=a.available?renderProfile(snapshot,row,a):'<div class="no-estimate" style="padding:28px 12px;line-height:1.8">The gamma curve needs strike-level IV, exact expiration and option type. Imported GEX levels remain visible.</div>';
  $('fade-grid').innerHTML=a.available?a.result.thresholds.levels.map(level=>`<div class="fade-card"><strong>${fmt(level.fraction*100)}%</strong><span>↓ ${esc(priceFmt(level.lowerPrice))}</span><span>↑ ${esc(priceFmt(level.upperPrice))}</span><small>−${esc(priceFmt(level.pointsBelowStrike))} / +${esc(priceFmt(level.pointsAboveStrike))} PTS</small></div>`).join(''):[50,25,10].map(n=>`<div class="fade-card"><strong>${n}%</strong><span>—</span><span>—</span><small>INPUTS NEEDED</small></div>`).join('');
  $('fade-note').textContent=a.available?'These boundaries describe this one series at its reading time and IV. They do not measure the percentage fade of the entire GEX bar or cluster.':'Save IV, exact expiry and exercise style to calculate this series’ fading distances.';
  const target=$('scenario-target'),detailKey=`${state.market}|${row._key}`;target.step=String(state.market==='CL'?.01:state.market==='GC'?.1:.25);if(state.detailKey!==detailKey){target.value=String(readingPrice(snapshot,row));state.detailKey=detailKey;}target.disabled=!a.available;
  $('scenario-down').disabled=!a.available;$('scenario-up').disabled=!a.available;
  $('detail-assumptions').innerHTML=`<b>Original GEX:</b> ${esc(snapshot.source.provider || 'Imported source')} · ${esc(nyTime(snapshot.asOf))}<br>${esc(compact(row.gex))} ${esc(snapshot.gexUnit)} · future ${esc(priceFmt(snapshot.futuresPrice))}<br><b>Curve inputs:</b> ${esc(nyTime(r?.asOf??snapshot.asOf))} · IV ${input.iv?fmt(input.iv*100,2)+'%':'unknown'} · rate ${fmt(snapshot.rate*100,2)}%<br>${a.available?`${esc(a.result.greeks.model?.label || 'Futures-option model')} · `:''}${input.expiry?esc(nyTime(input.expiry)):'Exact expiry not supplied'}<br>${row.dealerSide==='unknown'?'Dealer inventory side is not supplied.':`Dealer side: <b>${esc(row.dealerSide)}</b>, supplied assumption.`}`;
  renderScenario();
}

function renderProfile(snapshot,row,analysis) {
  snapshot={...snapshot,futuresPrice:readingPrice(snapshot,row)};
  const thresholds=analysis.result.thresholds,outer=thresholds.levels.find(level=>level.fraction===.1)||thresholds.levels.at(-1);
  let low=Math.min(outer.lowerPrice,snapshot.futuresPrice),high=Math.max(outer.upperPrice,snapshot.futuresPrice);const pad=(high-low)*.12;low=Math.max(.001,low-pad);high+=pad;
  const width=320,height=132,left=12,right=12,top=8,bottom=22,plotW=width-left-right,plotH=height-top-bottom;
  const x=(p)=>left+(p-low)/(high-low)*plotW,y=(g)=>top+plotH*(1-Math.min(g/thresholds.peakGamma,1));
  const args={...parameters(snapshot,row),timeYears:analysis.result.time.years};
  const points=Array.from({length:101},(_,i)=>{const price=low+(high-low)*i/100;return [x(price),y(greeks({...args,futuresPrice:price}).gamma)];});
  const line=points.map((p,i)=>(i?'L':'M')+p.map(v=>v.toFixed(2)).join(',')).join(' '),base=top+plotH;
  const currentX=x(snapshot.futuresPrice),currentY=y(analysis.result.greeks.gamma),strikeX=x(row.strike);
  return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><linearGradient id="gammaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60d8cd" stop-opacity=".20"/><stop offset="1" stop-color="#60d8cd" stop-opacity="0"/></linearGradient></defs>${[0,.5,1].map(f=>`<line class="chart-grid" x1="${left}" x2="${width-right}" y1="${top+plotH*f}" y2="${top+plotH*f}"/>`).join('')}<path class="chart-area" d="${line} L${width-right},${base} L${left},${base} Z"/><line class="chart-strike" x1="${strikeX}" x2="${strikeX}" y1="${top}" y2="${base}"/><path class="chart-line" d="${line}"/><line class="chart-current" x1="${currentX}" x2="${currentX}" y1="${currentY}" y2="${base}" opacity=".5"/><circle class="chart-current-dot" cx="${currentX}" cy="${currentY}" r="4"/><text class="chart-label" x="${left}" y="${height-5}">${esc(priceFmt(low))}</text><text class="chart-label" x="${width-right}" y="${height-5}" text-anchor="end">${esc(priceFmt(high))}</text><text class="chart-label" x="${strikeX}" y="${height-5}" text-anchor="middle">${esc(priceFmt(row.strike))}</text></svg>`;
}

function renderScenario() {
  const snapshot=current(),row=snapshot?.levels.find(item=>item._key===state.selectedStrike),a=row&&state.analyses.get(row._key);if(!row)return;
  if (!a?.available) {$('scenario-result').textContent='Sensitivity inputs are incomplete for this level.';return;}
  if(row.dealerSide==='unknown'){$('scenario-result').textContent='Dealer side is unknown. GEX alone cannot determine a contract hedge.';return;}
  if(!finite(row.optionMultiplier)||row.optionMultiplier<=0||!finite(row.hedgeMultiplier)||row.hedgeMultiplier<=0){$('scenario-result').textContent='Exact option and hedge-contract multipliers are needed to size this hypothetical hedge.';return;}
  const target=Number($('scenario-target').value);
  if(!finite(target)||target<=0){$('scenario-result').textContent='Enter a positive scenario price.';return;}
  try {
    const result=hedgeAdjustment({...parameters(snapshot,row),currentFuturesPrice:readingPrice(snapshot,row),scenarioFuturesPrice:target,timeYears:a.result.time.years,signedQuantity:row.dealerSide==='short'?-100:100,optionMultiplier:row.optionMultiplier,hedgeMultiplier:row.hedgeMultiplier});
    const hedge=result.hedge,amount=Math.abs(hedge.adjustmentContracts),notional=amount*target*row.hedgeMultiplier,direction=hedge.adjustmentDirection;
    if(direction==='unchanged'||amount<1e-5){$('scenario-result').innerHTML='<strong>0.00</strong> additional futures contracts<small>Same price, IV and remaining time.</small>';return;}
    $('scenario-result').innerHTML=`<strong class="${direction==='buy'?'positive':'negative'}">${direction==='buy'?'Buy':'Sell'} ${fmt(amount,2)}</strong> futures contracts<small>≈ $${fmt(notional,0)} of additional hedge notional<br>Hypothetical ${row.dealerSide} position of 100 ${esc(series(row).optionType)} contracts.</small>`;
  } catch(error){$('scenario-result').textContent='This scenario cannot be calculated with the supplied inputs.';}
}

const HISTORY_KEY='gammawatch-observations-v1';
function readHistory(){try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]').filter(row=>row&&MARKET_INFO[row.market]&&Array.isArray(row.levels));}catch{return[];}}
function recordObservation(snapshot){
  if(isExample(snapshot))return;
  const history=readHistory(),identity=`${snapshot.market}|${snapshot.source.provider}|${snapshot.contract}|${snapshot.asOf}`;
  const index=history.findIndex(item=>item.identity===identity),observation={identity,market:snapshot.market,asOf:snapshot.asOf,provider:snapshot.source.provider||'Imported snapshot',contract:snapshot.contract,levels:snapshot.levels.map(row=>({strike:row.strike,gex:row.gex})),unit:snapshot.gexUnit};
  if(index>=0)history[index]=observation;else history.push(observation);
  try{localStorage.setItem(HISTORY_KEY,JSON.stringify(history.slice(-200)));}catch{/* Current analysis remains usable if storage is unavailable. */}
}
function renderHistory(){
  const snapshot=current();
  $('observation-title').textContent='Strongest observed today';
  if(!snapshot||isExample(snapshot)){$('observation-caption').textContent='Starts with your first real snapshot. Example data is excluded.';$('observation-value').textContent='—';return;}
  const day=snapshot.asOf.slice(0,10),history=readHistory().filter(item=>item.market===state.market&&item.asOf.slice(0,10)===day&&item.provider===(snapshot.source.provider||'Imported snapshot')&&item.contract===snapshot.contract&&item.unit===snapshot.gexUnit).sort((a,b)=>Date.parse(a.asOf)-Date.parse(b.asOf));
  if(day!==new Date().toISOString().slice(0,10))$('observation-title').textContent=`Strongest observed · ${day}`;
  let strongest=null;for(const observation of history)for(const level of observation.levels){if(!strongest||Math.abs(level.gex)>Math.abs(strongest.gex))strongest={...level,asOf:observation.asOf};}
  const first=history[0]?.asOf,last=history.at(-1)?.asOf;
  $('observation-caption').textContent=history.length?`${history.length} saved observation${history.length===1?'':'s'} · ${day} UTC · ${utcClock(first)}–${utcClock(last)} · same source, contract & units. This is not full-day coverage.`:'No saved observations yet. Local storage may be unavailable.';
  $('observation-value').textContent=strongest?`${priceFmt(strongest.strike)} · ${compact(strongest.gex)}`:'—';
  $('observation-value').title=strongest?`Observed at ${absoluteTime(strongest.asOf)}`:'';
}

function acceptSnapshot(raw,{imported=false,preserveSelection=false}={}){
  const snapshot=normalizeSnapshot(raw);snapshot._imported=imported;state.snapshots.set(snapshot.market,snapshot);state.market=snapshot.market;if(!preserveSelection){state.selectedStrike=null;state.detailKey=null;}recordObservation(snapshot);persistPlans();render();
  if(isExample(snapshot))showNotice('Example data — these prices, exposures and positions are illustrative. Nothing here is live.');
  else if(sourceStatus(snapshot)==='delayed')showNotice('Delayed snapshot — the model uses the snapshot time. It does not represent the current market.');
  else if(imported)showNotice('Imported snapshot — provider and dealer-side labels come from your file and are not independently verified.');
  else showNotice('');
  if(!state.storageSaved)showNotice('Browser storage is unavailable. Export your watchlist before closing this tab; changes may not survive a reload.',true);
  return snapshot;
}

const providerCopy={
  menthorq:'<p><strong>Check the access included with your existing subscription.</strong> Confirm whether MenthorQ permits a documented API or timestamped export, which products it covers, and whether strike-level IV and expiration are supplied.</p><p>Native futures-option data and index or ETF levels converted to futures prices are different inputs. No MenthorQ connection is active here.</p>',
  zerogex:'<p><strong>A limited index-proxy option to verify.</strong> The annual API offering has limited index coverage; confirm access, timing and fields before considering it.</p><p>Index levels converted to NQ or ES are proxies. They do not establish native CME option-chain Gamma, IV or CL / GC coverage. No ZeroGEX connection is active here.</p>',
  other:'<p><strong>Use a documented, authorized feed or export.</strong> Ask your platform for timestamped GEX, the underlying contract, calculation units and position assumptions. Native option sensitivity also needs series-level IV, option type and exact expiration.</p><p>A supported JSON snapshot can be imported now. A live connection needs separate API permission and a private data service; a chart subscription alone is insufficient.</p>',
};
function selectProvider(provider){state.selectedProvider=provider;$('provider-copy').innerHTML=providerCopy[provider];document.querySelectorAll('[data-provider]').forEach(button=>{button.classList.toggle('selected',button.dataset.provider===provider);button.setAttribute('aria-pressed',String(button.dataset.provider===provider));});}

async function requestJSON(path){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(path,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.message||body.error||`The data service returned ${response.status}.`);return body;}finally{clearTimeout(timer);}}
async function loadConnectedSnapshot(){
  if(state.fetching)return null;
  const market=state.market;state.fetching=true;
  try{const body=await requestJSON(`/api/snapshot?market=${encodeURIComponent(market)}`);if(market!==state.market)return null;const snapshot=body.snapshot||body;if(String(snapshot.market||'').toUpperCase()!==market)throw new Error('The data service returned a different market.');return acceptSnapshot(snapshot,{preserveSelection:true});}
  finally{state.fetching=false;}
}
function stopRefresh(){clearInterval(state.timer);state.timer=null;state.connected=false;}
async function checkConnection(){
  const button=$('check-connection-button');button.disabled=true;$('connection-result').textContent='Checking the configured data service…';
  try{
    const status=await requestJSON('/api/status');
    if(!status.configured){stopRefresh();$('connection-result').textContent=status.message||'No live feed is configured yet. The calculator is ready for an authorized data connection or a snapshot import.';return;}
    await loadConnectedSnapshot();stopRefresh();$('connection-result').textContent=`Snapshot loaded from ${status.provider||'the configured feed'}. Refresh again only when needed.`;
    $('connection-dialog').close();showToast('Snapshot loaded from the configured data service.');
  }catch(error){stopRefresh();$('connection-result').textContent=location.protocol==='file:'?'Open the app through its included local server to check a data connection. Example data and JSON import still work here.':`Connection unavailable. ${error.message}`;}
  finally{button.disabled=false;}
}

document.querySelectorAll('[data-market]').forEach(button=>button.addEventListener('click',async()=>{state.market=button.dataset.market;state.selectedStrike=null;showNotice('');render();if(current()&&isExample(current()))showNotice('Example data — illustrative values only. Nothing here is live.');if(state.connected){try{await loadConnectedSnapshot();}catch(error){showNotice(error.message,true);}}}));
document.querySelector('.market-tabs').addEventListener('keydown',(event)=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...document.querySelectorAll('[data-market]')],index=buttons.findIndex(button=>button.dataset.market===state.market),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();});
$('example-button').addEventListener('click',()=>{stopRefresh();acceptSnapshot(buildExample(state.market));});
$('import-button').addEventListener('click',()=>$('snapshot-file').click());
$('snapshot-file').addEventListener('change',async(event)=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>3*1024*1024)throw new Error('Choose a snapshot smaller than 3 MB.');const raw=JSON.parse(await file.text());stopRefresh();acceptSnapshot(raw,{imported:true});showToast('Snapshot imported.');}catch(error){showNotice(`Import failed: ${error.message}`,true);}finally{event.target.value='';}});
$('levels-body').addEventListener('click',(event)=>{const row=event.target.closest('[data-level]');if(row){state.selectedStrike=row.dataset.level;render();}});
$('levels-body').addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.target.closest('[data-level]')?.click();}});
$('scenario-target').addEventListener('input',renderScenario);
for(const [id,sign] of [['scenario-down',-1],['scenario-up',1]])$(id).addEventListener('click',()=>{const input=$('scenario-target');input.value=String(Number((Number(input.value)+sign*MARKET_INFO[state.market].step).toFixed(4)));renderScenario();});
$('connect-button').addEventListener('click',()=>{$('connection-dialog').showModal();});
$('check-connection-button').addEventListener('click',checkConnection);
document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>selectProvider(button.dataset.provider)));
for(const id of ['learn-button','method-button'])$(id).addEventListener('click',()=>$('method-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
$('clear-button').addEventListener('click',()=>{stopRefresh();state.snapshots.delete(state.market);persistPlans();state.selectedStrike=null;showNotice(state.storageSaved?'':'Browser storage is unavailable. This view is cleared, but an older saved watchlist may return after reload.',!state.storageSaved);render();showToast('Current watchlist cleared from this view.');});
setInterval(()=>{const snapshot=current();if(!snapshot)return;const fresh=freshness(snapshot);$('source-badge').className='status-pill '+fresh.className;$('source-badge').innerHTML=`<span></span>${esc(fresh.label)}`;$('source-time').textContent=fresh.time;},1000);
const PLANS_KEY='gammawatch-plans-v1';
function persistPlans(){try{localStorage.setItem(PLANS_KEY,JSON.stringify([...state.snapshots.values()].filter(s=>!isExample(s))));state.storageSaved=true;}catch{state.storageSaved=false;showNotice('Browser storage is unavailable. Export your watchlist before closing this tab; changes may not survive a reload.',true);}return state.storageSaved;}
function restorePlans(){try{const saved=JSON.parse(localStorage.getItem(PLANS_KEY)||'[]');if(!Array.isArray(saved))return;for(const raw of saved){try{const s=normalizeSnapshot(raw);if(!isExample(s))state.snapshots.set(s.market,s);}catch{/* Skip an invalid saved record. */}}}catch{/* A new watchlist can still be created. */}}
function formError(id,error){$(id).textContent=error?.message||'';$(id).hidden=!error;}
$('plan-button').addEventListener('click',()=>{const s=current();$('plan-market').value=state.market;$('plan-contract').value=s&&!isExample(s)?s.contract:'';$('plan-price').value=s&&!isExample(s)?s.futuresPrice:'';const now=toNewYorkInput();$('plan-time').value=now.slice(11)>='09:45'?now.slice(0,10)+'T09:45':now;$('plan-provider').value=s?.source.provider&&!isExample(s)?s.source.provider:'MenthorQ';$('plan-unit').value=s&&!isExample(s)?s.gexUnit:'Source units (unverified)';$('plan-levels').value=s&&!isExample(s)?s.levels.map(r=>`${r.strike},${r.gex}`).join('\n'):'';formError('plan-error');$('plan-dialog').showModal();});
$('plan-form').addEventListener('submit',event=>{event.preventDefault();try{const contract=$('plan-contract').value.trim(),provider=$('plan-provider').value.trim(),unit=$('plan-unit').value.trim();if(!contract||!provider||!unit)throw Error('Enter the underlying contract, provider and GEX units.');const asOf=newYorkToIso($('plan-time').value);stopRefresh();acceptSnapshot({market:$('plan-market').value,contract,futuresPrice:Number($('plan-price').value),asOf,source:{provider,status:'snapshot'},gexUnit:unit,_manual:true,levels:parseWatchLevels($('plan-levels').value)});$('plan-dialog').close();showNotice(state.storageSaved?'Morning GEX saved. Select a strike and add a fresh chain reading when price arrives. Values stay fixed between readings.':'Browser storage is unavailable. Export your watchlist before closing this tab; changes may not survive a reload.',!state.storageSaved);showToast(state.storageSaved?'Watchlist saved on this device.':'Watchlist available in this tab only.');}catch(error){formError('plan-error',error);}});
$('reading-button').addEventListener('click',()=>{const s=current(),row=s?.levels.find(r=>r._key===state.selectedStrike);if(!row)return;const r=row.reading;$('reading-strike').textContent=priceFmt(row.strike);$('reading-contract').value=s.contract;$('reading-price').value='';$('reading-time').value=toNewYorkInput();$('reading-type').value=r?.optionType??row.optionType??'';$('reading-iv').value='';$('reading-delta').value='';$('reading-gamma').value='';$('reading-oi').value='';$('reading-expiry').value=(r?.expiry??row.expiry)?toNewYorkInput(r?.expiry??row.expiry):'';$('reading-style').value=r?.exerciseStyle??row.exerciseStyle??'';$('reading-approx').checked=r?.allowEuropeanApproximation??false;formError('reading-error');$('reading-dialog').showModal();});
$('reading-form').addEventListener('submit',event=>{event.preventDefault();try{const r=validateReading({contract:$('reading-contract').value,futuresPrice:$('reading-price').value,asOf:newYorkToIso($('reading-time').value),ivPercent:$('reading-iv').value,optionType:$('reading-type').value,expiry:$('reading-expiry').value?newYorkToIso($('reading-expiry').value):null,exerciseStyle:$('reading-style').value,allowEuropeanApproximation:$('reading-approx').checked,observedDelta:$('reading-delta').value,observedGamma:$('reading-gamma').value,openInterest:$('reading-oi').value});const updated=applyReading(current(),state.selectedStrike,r);state.snapshots.set(state.market,updated);state.detailKey=null;persistPlans();render();$('reading-dialog').close();showNotice(state.storageSaved?'Chain reading saved for this strike. Morning GEX and the other strikes remain at their original snapshot. Calculations use the saved reading time, not the clock.':'Browser storage is unavailable. Export your watchlist before closing this tab; changes may not survive a reload.',!state.storageSaved);showToast(state.storageSaved?'Fresh chain reading saved.':'Reading available in this tab only.');}catch(error){formError('reading-error',error);}});
$('export-button').addEventListener('click',()=>{const s=current();if(!s)return;const blob=new Blob([JSON.stringify(s,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`gamma-watch-${s.market}-${s.asOf.slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
restorePlans();selectProvider('menthorq');render();initMarketWatch();
