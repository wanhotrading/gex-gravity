import {createPrivateStore} from '../lib/secure-store.mjs';
import {contextFreshness,nyClock} from '../core/market-reading.mjs';

const MARKETS=['NQ','ES','CL'];
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const stamp=x=>typeof x==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(x)&&Number.isFinite(Date.parse(x));
const clean=(x,n=300)=>typeof x==='string'?x.trim().slice(0,n):'';
const calendarDate=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const minutes=60*1000;
function displayNumber(display){
  const match=display.replaceAll(',','').replaceAll('−','-').match(/^([+-]?\d+(?:\.\d+)?)\s*([KMB])?$/i);
  return match?Number(match[1])*({K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]??1):null;
}
function watchedStrikeSet(levels){
  return new Set(levels.filter(level=>level.kind!=='reference').map(level=>level.strike));
}
function exposureRows(raw,strikes,metric){
  const seen=new Set();
  return raw.map(row=>{
    if(!row||!finite(row.strike)||row.strike<=0||seen.has(row.strike))throw Error('Exposure needs unique positive strikes.');
    seen.add(row.strike);
    const display=clean(row.display,40),value=displayNumber(display);
    // Provider display text is the evidence. Ignore separately supplied numeric values.
    if(!finite(value)||(metric==='Absolute GEX'&&value<0))throw Error('Invalid exposure value. Supply the displayed number or omit the unavailable row.');
    return {strike:row.strike,display,value};
  }).filter(row=>strikes.has(row.strike));
}
function validateRegime(raw,now){
  if(raw==null)return null;
  if(!finite(raw.netGex)||raw.scope!=='all-expiries'||!['Intraday','EOD'].includes(raw.mode))throw Error('Regime needs the provider all-expiry Net GEX total and its mode.');
  if(raw.asOf!=null&&(!stamp(raw.asOf)||Date.parse(raw.asOf)>now+60000))throw Error('Invalid regime source timestamp.');
  if(raw.sourceDate!=null&&!calendarDate(raw.sourceDate))throw Error('Invalid regime source date.');
  const sourceUrl=clean(raw.sourceUrl,500);if(!/^https:\/\/dashboard\.menthorq\.io\//.test(sourceUrl))throw Error('Regime needs its MenthorQ source URL.');
  return {netGex:raw.netGex,display:clean(raw.display,40),scope:'all-expiries',mode:raw.mode,asOf:raw.asOf??null,sourceDate:raw.sourceDate??null,sourceUrl,delayStatus:raw.delayStatus==='delayed'?'delayed':'unverified',capturedAt:new Date(now).toISOString()};
}
function validateExposure(raw,strikes,sourceInstrument,now,scope='all-expiries'){
  if(raw==null)return null;
  const zeroDte=scope==='0dte';
  const metrics=zeroDte?['Net GEX']:['Net GEX','Absolute GEX'],modes=zeroDte?['Intraday']:['Intraday','EOD'];
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!metrics.includes(raw.metric)||raw.scope!==scope||!modes.includes(raw.mode)||!Array.isArray(raw.rows)||raw.rows.length>80){
    throw Error(zeroDte?'0DTE exposure requires the signed Net GEX view for a single Intraday expiry.':'Exposure needs a bounded all-expiry MenthorQ GEX snapshot and its mode.');
  }
  if(raw.asOf!=null&&(!stamp(raw.asOf)||Date.parse(raw.asOf)>now+60000))throw Error('Invalid exposure source timestamp.');
  if(raw.sourceDate!=null&&!calendarDate(raw.sourceDate))throw Error('Invalid exposure source date.');
  if(raw.capturedAt!=null&&(!stamp(raw.capturedAt)||Date.parse(raw.capturedAt)>now+60000))throw Error('Invalid exposure capture timestamp.');
  const sourceUrl=clean(raw.sourceUrl,500);
  if(!/^https:\/\/dashboard\.menthorq\.io\//.test(sourceUrl))throw Error('Exposure needs its MenthorQ source URL.');
  const url=new URL(sourceUrl),symbol=url.searchParams.get('symbol');
  if(symbol&&symbol!==sourceInstrument)throw Error('Exposure must use the same dated futures contract.');
  if(zeroDte){
    if(symbol!==sourceInstrument||!/^\/[a-z]{2}\/options\/exposure\/?$/.test(url.pathname))throw Error('Paste the MenthorQ Exposure link for this exact dated future.');
    if(!calendarDate(raw.expiryDate)||!stamp(raw.capturedAt)||nyClock(Date.parse(raw.capturedAt)).date!==raw.expiryDate)throw Error('The single expiry card and the capture must have the same New York date.');
    if(raw.sourceDate!=null&&raw.sourceDate!==raw.expiryDate)throw Error('The source date and 0DTE expiration must match.');
    if(raw.asOf&&(nyClock(Date.parse(raw.asOf)).date!==raw.expiryDate||Date.parse(raw.asOf)>Date.parse(raw.capturedAt)))throw Error('The source clock must be on the expiry date and at or before the capture.');
  }
  const rows=exposureRows(raw.rows,strikes,raw.metric);
  if(zeroDte&&!rows.length)throw Error('Supply a signed Net GEX value for at least one saved watched strike.');
  return {metric:raw.metric,scope,mode:raw.mode,...(zeroDte?{expiryDate:raw.expiryDate}:{}),sourceDate:raw.sourceDate??null,asOf:raw.asOf?new Date(raw.asOf).toISOString():null,sourceUrl,delayStatus:raw.delayStatus==='delayed'?'delayed':'unverified',capturedAt:raw.capturedAt?new Date(raw.capturedAt).toISOString():new Date(now).toISOString(),rows,notes:['Captured displayed strike values only; omitted strikes are unavailable, not zero.','Provider display scale retained; the futures per-point or per-percent denominator is unverified.','Net GEX is signed net exposure. Its absolute value is not the provider Absolute GEX metric.']};
}
function updateExposure(old,raw,now){
  if(!old?.levels?.length||old.underlyingCode!==raw.underlyingCode){
    throw Error('Import watched levels for this exact future before collecting Exposure.');
  }
  const update=raw.exposureUpdate;
  const sourceUrl=new URL(update.exposure?.sourceUrl??'https://menthorq.com/');
  if(sourceUrl.origin!=='https://dashboard.menthorq.io'||sourceUrl.pathname!=='/en/options/exposure'||sourceUrl.searchParams.get('symbol')!==old.sourceInstrument){
    throw Error('Use the MenthorQ Exposure Map for this exact dated future.');
  }
  const strikes=new Set(old.levels.filter(level=>level.kind!=='reference').map(level=>level.strike));
  const exposure=validateExposure(update.exposure,strikes,old.sourceInstrument,now);
  const regime=validateRegime(update.regime,now);
  if(exposure?.metric!=='Net GEX'||!exposure.rows.length||!stamp(update.exposure.capturedAt)||
     !regime||regime.mode!==exposure.mode||regime.sourceUrl!==exposure.sourceUrl||
     regime.sourceDate!==exposure.sourceDate||ms(regime.asOf)!==ms(exposure.asOf)||
     ms(update.regime.capturedAt)!==ms(exposure.capturedAt)){
    throw Error('Supply the displayed Net GEX total and watched strikes from the same Exposure Map capture.');
  }
  const previousSourceTime=ms(old.exposure?.asOf),newSourceTime=ms(exposure.asOf);
  if(ms(old.exposure?.capturedAt)>ms(exposure.capturedAt)||
     (previousSourceTime!==null&&newSourceTime!==null&&previousSourceTime>newSourceTime)){
    throw Error('A newer Exposure Map capture is already saved.');
  }
  return {
    ...old,
    exposure:{...exposure,collection:'exposure-map'},
    regime:{...regime,capturedAt:exposure.capturedAt},
    contextUpdatedAt:new Date(now).toISOString(),
  };
}
function ms(value){return stamp(value)?Date.parse(value):null;}
function validateNetDex(input,levels,instrument,now){
  if(input?.metric!=='Net DEX'||input.scope!=='all-expiries'||!['Intraday','EOD'].includes(input.mode)||
     !Array.isArray(input.rows)||input.rows.length>80){
    throw Error('Supply all-expiry Net DEX and up to 80 watched strikes from the Exposure Map.');
  }
  const capture=ms(input.capturedAt),source=ms(input.asOf);
  if(capture===null||capture>now+minutes)throw Error('Invalid Net DEX capture timestamp.');
  if(input.asOf!=null&&(source===null||source>capture))throw Error('Invalid Net DEX provider timestamp.');
  if(input.sourceDate!=null&&!calendarDate(input.sourceDate))throw Error('Invalid Net DEX provider date.');
  const url=new URL(clean(input.sourceUrl,500)||'https://menthorq.com/');
  if(url.origin!=='https://dashboard.menthorq.io'||url.username||url.password||
     url.pathname!=='/en/options/exposure'||url.searchParams.getAll('symbol').length!==1||url.searchParams.get('symbol')!==instrument){
    throw Error('Use the MenthorQ Exposure Map for this exact dated future.');
  }
  const aggregateDisplay=clean(input.aggregateDisplay,40),aggregateValue=displayNumber(aggregateDisplay);
  if(!finite(aggregateValue))throw Error('Supply the displayed all-expiry Net DEX total.');
  const rows=exposureRows(input.rows,watchedStrikeSet(levels),'Net DEX').sort((a,b)=>a.strike-b.strike);
  if(!rows.length)throw Error('Supply Net DEX for at least one saved watched strike.');
  return {
    metric:'Net DEX',scope:'all-expiries',mode:input.mode,
    sourceUrl:url.origin+url.pathname+'?symbol='+encodeURIComponent(instrument),
    sourceDate:input.sourceDate??null,asOf:source===null?null:new Date(source).toISOString(),
    delayStatus:input.delayStatus==='delayed'?'delayed':'unverified',
    capturedAt:new Date(capture).toISOString(),aggregateDisplay,aggregateValue,rows,
  };
}
function netDexHistory(previous,next){
  if(!previous||previous.metric!==next.metric||previous.scope!==next.scope||
     previous.mode!==next.mode||previous.sourceUrl!==next.sourceUrl||
     previous.delayStatus!==next.delayStatus||Boolean(previous.asOf)!==Boolean(next.asOf))return [];
  const latest=ms(next.asOf??next.capturedAt);
  const {capturedAt,asOf,aggregateValue}=previous;
  const records=[{capturedAt,asOf,aggregateValue},...(previous.history??[])];
  const seen=new Set();
  return records.filter(record=>{
    const observed=ms(record.asOf??record.capturedAt);
    if(observed===null||observed>=latest||observed<latest-120*minutes||seen.has(observed))return false;
    seen.add(observed);
    return true;
  }).slice(0,40);
}
function updateNetDex(old,raw,now){
  if(!old?.levels?.length||old.underlyingCode!==raw.underlyingCode){
    throw Error('Import watched levels for this exact future before collecting Net DEX.');
  }
  const next=validateNetDex(raw.netDexUpdate,old.levels,old.sourceInstrument,now);
  const previous=old.netDex,previousCapture=ms(previous?.capturedAt),capture=ms(next.capturedAt);
  if(previousCapture===capture){
    const {history,...saved}=previous;
    if(JSON.stringify(saved)===JSON.stringify(next))return old;
    throw Error('A different Net DEX observation already uses this capture timestamp.');
  }
  const previousSource=ms(previous?.asOf),source=ms(next.asOf);
  if(previousCapture!==null&&previousCapture>capture||
     previous?.mode===next.mode&&previousSource!==null&&source!==null&&previousSource>source){
    throw Error('A newer Net DEX capture is already saved.');
  }
  return {...old,netDex:{...next,history:netDexHistory(previous,next)},contextUpdatedAt:new Date(now).toISOString()};
}
function validateHeatmap(raw,strikes,now){
  if(raw==null)return null;
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.metrics)||raw.metrics.length>4)throw Error('Invalid MenthorQ heatmap snapshot.');
  const metrics=raw.metrics.map(metric=>{
    if(!['Net GEX','Net DEX','OI','IV x OI'].includes(metric.name)||!Array.isArray(metric.rows)||metric.rows.length>80)throw Error('Invalid heatmap metric.');
    const seen=new Set();
    return {name:metric.name,rows:metric.rows.filter(row=>strikes.has(row.strike)).map(row=>{
      if(seen.has(row.strike)||!Array.isArray(row.cells)||row.cells.length>100)throw Error('Invalid heatmap row.');seen.add(row.strike);
      const expiries=new Set();
      return {strike:row.strike,cells:row.cells.map(cell=>{
        if(!calendarDate(cell.expiry)||expiries.has(cell.expiry))throw Error('Invalid heatmap expiry.');expiries.add(cell.expiry);
        const display=clean(cell.display,40),match=display.replaceAll(',','').match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?$/i);
        const value=match?Number(match[1])*({K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]??1):null;
        return {expiry:cell.expiry,display:display||'—',value};
      })};
    })};
  });
  const capturedAt=stamp(raw.capturedAt)&&Date.parse(raw.capturedAt)<=now+60000?new Date(raw.capturedAt).toISOString():new Date(now).toISOString();
  if(raw.asOf!=null&&(!stamp(raw.asOf)||Date.parse(raw.asOf)>now+60000))throw Error('Invalid heatmap source timestamp.');
  return {capturedAt,asOf:raw.asOf??null,mode:['Intraday','EOD'].includes(raw.mode)?raw.mode:'unspecified',delayStatus:raw.delayStatus==='delayed'?'delayed':'unverified',metrics,notes:['Captured visible provider cells only; omitted strikes and expiries are unavailable, not zero.','Rounded provider displays; exposure units and exact source timestamp are not supplied by this capture.','IV x OI is the provider weighted metric, not per-contract IV.']};
}
function optionalNumber(value,key,{positive=false}={}){
  if(value===null||value===undefined)return null;
  if(!finite(value)||(positive&&value<0))throw Error(`Invalid ${key}.`);
  return value;
}
export function validateWatchContext(market,raw,now=Date.now()){
  if(!MARKETS.includes(market)||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Choose NQ, ES or CL and a MenthorQ snapshot.');
  if(raw.source!=='MenthorQ')throw Error('This watchlist requires a MenthorQ source snapshot.');
  if(!new RegExp('^US\\.'+market+'[0-9]{4}$').test(raw.underlyingCode??''))throw Error('Use the exact dated futures contract.');
  const code=raw.underlyingCode,month=Number(code.slice(-2));
  if(month<1||month>12)throw Error('Invalid futures month.');
  const expected=market+'FGHJKMNQUVXZ'[month-1]+'20'+code.slice(-4,-2);
  if(clean(raw.sourceInstrument,40)!==expected)throw Error(`MenthorQ must name the same dated contract: ${expected}. Continuous or cash symbols need a separately verified conversion.`);
  if(raw.asOf!==null&&raw.asOf!==undefined&&(!stamp(raw.asOf)||Date.parse(raw.asOf)>now+60000))throw Error('Source asOf needs its actual timestamp and timezone; use null when unavailable.');
  if(raw.sourceDate!==undefined&&raw.sourceDate!==null&&!calendarDate(raw.sourceDate))throw Error('Invalid provider source date.');
  if(!Array.isArray(raw.levels)||!raw.levels.length||raw.levels.length>80)throw Error('Import between 1 and 80 selected MenthorQ levels.');
  const seen=new Set();
  const levels=raw.levels.map(row=>{
    if(!row||!finite(row.strike)||row.strike<=0||seen.has(row.strike))throw Error('Use unique positive strikes.');
    seen.add(row.strike);
    const labels=Array.isArray(row.labels)?row.labels.map(x=>clean(x,100)).filter(Boolean).slice(0,12):[];
    if(!labels.length)throw Error('Every watched level needs its provider label.');
    if(row.sourceAsOf!=null&&(!stamp(row.sourceAsOf)||Date.parse(row.sourceAsOf)>now+60000))throw Error('Invalid per-level source timestamp.');
    const iv=optionalNumber(row.iv,'decimal IV',{positive:true});if(iv!==null&&iv>10)throw Error('Use decimal IV, for example 0.25 for 25%.');
    return {strike:row.strike,labels,gex:optionalNumber(row.gex,'GEX'),deltaExposure:optionalNumber(row.deltaExposure,'delta exposure'),openInterest:optionalNumber(row.openInterest,'open interest',{positive:true}),iv,sourceAsOf:row.sourceAsOf??raw.asOf??null,scope:clean(row.scope??raw.expiryScope??'unspecified',100),kind:row.kind==='reference'?'reference':'option-strike'};
  }).sort((a,b)=>a.strike-b.strike);
  const url=clean(raw.sourceUrl,500);if(url&&!/^https:\/\/(?:dashboard\.)?menthorq\.(?:io|com)\//.test(url))throw Error('Use a MenthorQ source link.');
  const watchedStrikes=new Set(levels.filter(x=>x.kind!=='reference').map(x=>x.strike));
  return {schemaVersion:2,source:'MenthorQ',underlyingCode:code,sourceInstrument:expected,asOf:raw.asOf?new Date(raw.asOf).toISOString():null,sourceDate:raw.sourceDate??null,capturedAt:new Date(now).toISOString(),lastCheckedAt:new Date(now).toISOString(),mode:['Intraday','EOD'].includes(raw.mode)?raw.mode:/Intraday/i.test(raw.expiryScope??'')?'Intraday':'EOD',sourceLocalTime:/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.sourceLocalTime??'')?raw.sourceLocalTime:null,delayStatus:raw.delayStatus==='delayed'?'delayed':'unverified',regime:validateRegime(raw.regime,now),exposure:validateExposure(raw.exposure,new Set(levels.map(x=>x.strike)),expected,now),exposure0dte:validateExposure(raw.exposure0dte,watchedStrikes,expected,now,'0dte'),expiryScope:clean(raw.expiryScope,150)||'unspecified',sourceUrl:url||null,gexUnit:clean(raw.gexUnit,120)||null,deltaExposureUnit:clean(raw.deltaExposureUnit,120)||null,levels,heatmap:validateHeatmap(raw.heatmap,new Set(levels.map(x=>x.strike)),now),notes:(Array.isArray(raw.notes)?raw.notes:[]).map(x=>clean(x,500)).filter(Boolean).slice(0,12)};
}
export function projectWatchContext(context,underlyingCode,now=Date.now()){
  if(!context)return {source:'MenthorQ',status:'missing',underlyingCode,levels:[],exposure:null,notes:['Import MenthorQ levels for this exact dated futures contract.']};
  if(context.underlyingCode!==underlyingCode)return {...context,status:'contract-mismatch',levels:[],exposure:null,exposure0dte:null,netDex:null,notes:[...(context.notes??[]),'Saved MenthorQ levels belong to a different futures month.']};
  const stale=!context.asOf||now-Date.parse(context.asOf)>36*3600000;
  return {...context,exposure:context.exposure??null,status:stale?'stale':'available',freshness:contextFreshness(context,now),notes:[...(context.notes??[]),...(!context.asOf?['Provider timestamp unavailable; capture time is not the source data time.']:[])]};
}
export async function readWatchContexts(env){if(!env.BUCKET||!env.FUTU_TOKEN_ENCRYPTION_KEY)return {};return await createPrivateStore(env).get('watch/menthorq-context')??{};}
export async function saveWatchContext(env,market,raw,{now=Date.now(),onlyZeroDte=false,onlyExposure=false,onlyNetDex=false}={}){
  const context=onlyZeroDte||onlyExposure||onlyNetDex?null:validateWatchContext(market,raw,now),store=createPrivateStore(env);
  const lease=await store.acquireLease('watch/context-lease',now,60000);if(!lease)throw Error('A watchlist update is already saving; try again.');
  try{const contexts=await readWatchContexts(env),old=contexts[market];
    if(onlyExposure||onlyNetDex){
      if(!MARKETS.includes(market))throw Error('Choose NQ, ES or CL.');
      const updated=onlyNetDex?updateNetDex(old,raw,now):updateExposure(old,raw,now);
      if(updated===old)return old;
      contexts[market]=updated;
      await store.put('watch/menthorq-context',contexts);
      return updated;
    }
    if(onlyZeroDte){
      if(!MARKETS.includes(market)||!old?.levels?.length||old.underlyingCode!==raw?.underlyingCode)throw Error('Save watched levels for this exact future before adding 0DTE values.');
      const strikes=new Set(old.levels.filter(level=>level.kind!=='reference').map(level=>level.strike));
      const exposure0dte=validateExposure(raw.exposure0dte,strikes,old.sourceInstrument,now,'0dte');
      if(!exposure0dte||exposure0dte.expiryDate!==nyClock(now).date)throw Error('Use the current New York date for a live 0DTE import.');
      if(Date.parse(old.exposure0dte?.capturedAt)>Date.parse(exposure0dte.capturedAt))throw Error('A newer 0DTE capture is already saved.');
      const updated={...old,exposure0dte,contextUpdatedAt:new Date(now).toISOString()};
      contexts[market]=updated;
      await store.put('watch/menthorq-context',contexts);
      return updated;
    }
    if(old?.underlyingCode===context.underlyingCode&&old.sourceDate&&context.sourceDate&&context.sourceDate<old.sourceDate)throw Error('Older provider date rejected; the newer saved map is retained.');
    if(old?.underlyingCode===context.underlyingCode&&old.mode===context.mode&&old.sourceDate===context.sourceDate&&old.sourceLocalTime&&context.sourceLocalTime&&context.sourceLocalTime<old.sourceLocalTime)throw Error('Older provider snapshot rejected; the newer saved map is retained.');
    if(!Object.hasOwn(raw,'exposure')&&old?.underlyingCode===context.underlyingCode&&old.exposure?.collection==='exposure-map'){
      const strikes=new Set(context.levels.filter(level=>level.kind!=='reference').map(level=>level.strike));
      context.exposure={...old.exposure,rows:old.exposure.rows.filter(row=>strikes.has(row.strike))};
      if(!Object.hasOwn(raw,'regime'))context.regime=old.regime??null;
    }
    if(!Object.hasOwn(raw,'exposure0dte')&&old?.underlyingCode===context.underlyingCode&&old.exposure0dte?.expiryDate===context.sourceDate){
      const strikes=new Set(context.levels.filter(level=>level.kind!=='reference').map(level=>level.strike));
      const rows=old.exposure0dte.rows.filter(row=>strikes.has(row.strike));
      if(rows.length)context.exposure0dte={...old.exposure0dte,rows};
    }
    if(old?.underlyingCode===context.underlyingCode&&old.netDex){
      const strikes=watchedStrikeSet(context.levels);
      context.netDex={...old.netDex,rows:old.netDex.rows.filter(row=>strikes.has(row.strike))};
    }
    await store.put(`watch/menthorq-${market}-${context.mode}`,context);
    contexts[market]=context;await store.put('watch/menthorq-context',contexts);return context;}
  finally{await store.releaseLease('watch/context-lease',lease);}
}
