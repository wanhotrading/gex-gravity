import {execFileSync} from 'node:child_process';
import path from 'node:path';
export function localSiteClient(runtime, configuredOrigin){
  const target = new URL(configuredOrigin);
  if (target.protocol !== 'https:' || target.username || target.password || target.href !== target.origin + '/') {
    throw Error('SITE_ORIGIN_REJECTED');
  }
  const siteOrigin = target.origin;
  const destination=path.join(runtime,'site-access.dpapi').replaceAll("'","''");
  const script=`$ErrorActionPreference='Stop'; $taskSecure=Get-Content -LiteralPath '${destination}' -Raw | ConvertTo-SecureString; $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure); try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)}`;
  let bearer;try{bearer=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{throw Error('SITE_ACCESS_UNAVAILABLE');}
  const paths=new Set(['/api/market-state','/api/refresh','/api/watch-context','/api/watch-settings','/api/session-history','/api/session-history-refresh','/api/collector-status']);
  return async function request(route,body,{timeoutMs=60000}={}){
    const url=new URL(route,siteOrigin);if(url.origin!==siteOrigin||!paths.has(url.pathname))throw Error('SITE_ROUTE_REJECTED');
    const read=async action=>{
      try{return await action();}
      catch(error){
        if(['AbortError','TimeoutError'].includes(error.name))throw Object.assign(Error('SITE_REQUEST_TIMEOUT'),{route:url.pathname});
        if(error.name==='TypeError')throw Object.assign(Error('SITE_NETWORK_UNAVAILABLE'),{route:url.pathname});
        throw error;
      }
    };
    const response=await read(()=>fetch(url,{method:body===undefined?'GET':'POST',headers:{accept:'application/json','OAI-Sites-Authorization':'Bearer '+bearer,...(body===undefined?{}:{origin:siteOrigin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(timeoutMs)}));
    if(!response.ok){
      let serviceCode=null;
      try{const body=await response.json();if(/^[A-Z][A-Z0-9_]{0,79}$/.test(body?.code??''))serviceCode=body.code;}catch{}
      const error=Error('SITE_HTTP_'+response.status);error.serviceCode=serviceCode;error.route=url.pathname;throw error;
    }
    if(Number(response.headers.get('content-length'))>4*1024*1024)throw Error('SITE_RESPONSE_TOO_LARGE');
    const text=await read(()=>response.text());if(text.length>4*1024*1024)throw Error('SITE_RESPONSE_TOO_LARGE');
    try{return JSON.parse(text);}catch{throw Error('SITE_RESPONSE_INVALID');}
  };
}

export function isBusySave(error){
  return error.message==='SITE_HTTP_409'&&(!error.serviceCode||error.serviceCode==='WATCH_CONTEXT_BUSY');
}

export async function saveMenthorqUpdate(request,body,{deadline,verify,unverified,readFirst=false,writeTimeoutMs=10000,deferRetries=false}){
  const route='/api/watch-context';
  const remaining=limit=>{
    const milliseconds=deadline-Date.now()-1000;
    if(milliseconds<2000)throw Error('MQ_TIME_BUDGET');
    return Math.min(limit,milliseconds);
  };
  const matches=context=>context?.underlyingCode===body.underlyingCode&&verify(context);
  const readCurrent=async()=>(await request(route,undefined,{timeoutMs:remaining(4000)})).contexts?.[body.market];
  if(readFirst){
    const current=await readCurrent();
    if(matches(current))return current;
    if(!body.exportText&&current?.underlyingCode!==body.underlyingCode)throw Error('MQ_WATCHLIST_CHANGED');
    const observed=body.netDexUpdate??body.exposureUpdate?.exposure;
    const stored=body.netDexUpdate?current?.netDex:current?.exposure;
    if(Date.parse(stored?.capturedAt)>Date.parse(observed?.capturedAt))throw Error('MQ_NEWER_CAPTURE_SAVED');
  }
  const write=async()=>{
    const response=await request(route,body,{timeoutMs:remaining(writeTimeoutMs)});
    if(response?.saved!==true||!matches(response.context))throw Error(unverified);
    return response.context;
  };
  if(deferRetries)return write();
  // A busy save may outlive an immediate retry. Reuse this observation and
  // its original clock, within the time reserved for this market.
  const delays=[1000,2500,5000,8000];
  for(let attempt=0;;attempt++){
    try{return await write();}
    catch(error){
      const busy=isBusySave(error);
      const uncertain=/^SITE_(?:REQUEST_TIMEOUT|NETWORK_UNAVAILABLE|HTTP_(?:408|5\d\d))$/.test(error.message);
      if(!busy&&!uncertain)throw error;
      let current;
      try{current=await readCurrent();}
      catch{throw error;}
      if(matches(current))return current;
      if(current?.underlyingCode&&current.underlyingCode!==body.underlyingCode&&!body.exportText)throw error;
      // For a lost response keep the single verified retry. Multiple retries
      // are reserved for write conflicts and must leave room for the request.
      if(attempt>=(busy?delays.length:1))throw error;
      const delay=busy?delays[attempt]:0;
      if(deadline-Date.now()<delay+3500)throw error;
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    }
  }
}
