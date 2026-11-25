import {createPrivateStore} from '../lib/secure-store.mjs';
import {getFutuAccess} from '../lib/futu-auth.mjs';
import {createFutuQuoteClient,normalizeOptionSnapshot,reconcileSnapshots,safeFutuError,QUOTE_INTERVAL_MS} from '../lib/futu-client.mjs';
import {IV_CHECK_MS,selectIvContracts,validateIvIdentity,mergeIvObservation,publicIvRow} from '../core/iv-tracking.mjs';

const STATE_KEY='watch/state', LEASE_KEY='watch/refresh-lease';
const stateKey=env=>env.GAMMA_COMPACT_STATE==='true'?'watch/state-v3':STATE_KEY;
const key=(market,underlyingCode)=>`watch/iv/${market}/${underlyingCode}`;
const iso=value=>new Date(value).toISOString();
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const numeric=value=>finite(value)?value:typeof value==='string'&&/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)&&Number.isFinite(Number(value))?Number(value):null;
const quietInterval=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function empty(market,underlyingCode){return {schemaVersion:1,market,underlyingCode,status:'awaiting-check',rows:{},activeCodes:[],lastAttemptAt:null,lastSuccessAt:null,nextRefreshAt:null,underlyingPrice:null,priceTimestamp:null,coverage:{requested:0,returned:0,tracked:0},errors:[]};}
function publicState(saved,now,{allowedStrikes=null,status=null}={}) {
  const allowed=Array.isArray(allowedStrikes)?new Set(allowedStrikes):null;
  const rows=(saved.activeCodes??[]).map(code=>saved.rows?.[code]).filter(row=>row&&(!allowed||allowed.has(row.metadata.strike))).map(row=>publicIvRow(row,now));
  return {schemaVersion:1,market:saved.market,underlyingCode:saved.underlyingCode,status:status??saved.status,
    rows,underlyingPrice:saved.underlyingPrice??null,priceTimestamp:saved.priceTimestamp??null,
    lastAttemptAt:saved.lastAttemptAt,lastSuccessAt:saved.lastSuccessAt,nextRefreshAt:saved.nextRefreshAt,
    cooldownSeconds:IV_CHECK_MS/1000,serverTime:iso(now),coverage:saved.coverage,errors:saved.errors??[],
    source:{provider:'Futu OpenAPI',type:'polled-snapshot',delayStatus:'unverified',
      quoteTimestampMeaning:'Common quote update time; not an independent IV, Greek or OI calculation time.',
      documentation:'https://open.futunn.com/api/quote/realtime/market-snapshot'}};
}
export async function readIvTracking(env,{market,underlyingCode,allowedStrikes=null,now=Date.now()}={}) {
  validateIvIdentity(market,underlyingCode);
  const saved=await createPrivateStore(env).get(key(market,underlyingCode))??empty(market,underlyingCode);
  return publicState(saved,now,{allowedStrikes});
}

/** One bounded, quote-only snapshot for saved watched series plus their future.
 * Shares the full-chain collector's R2 lease. No independent source, token or
 * expiration assumptions are introduced by this quicker observation path.
 */
export async function refreshIvTracking(env,{market,underlyingCode,codes,allowedStrikes,fetcher=fetch,now=Date.now(),dependencies={}}={}) {
  validateIvIdentity(market,underlyingCode);
  const store=createPrivateStore(env),recordKey=key(market,underlyingCode);
  // Validate even during cooldown; browser input cannot expand the server list.
  let canonical=await store.get(stateKey(env));
  selectIvContracts(canonical?.markets?.[market],{market,underlyingCode,codes,allowedStrikes,now});
  let saved=await store.get(recordKey)??empty(market,underlyingCode);
  if(now-Date.parse(saved.lastAttemptAt??'')<IV_CHECK_MS)return publicState(saved,now,{allowedStrikes,status:'cooldown'});
  const lease=await store.acquireLease(LEASE_KEY,now,45000);
  if(!lease)return {...publicState(saved,now,{allowedStrikes,status:'waiting-for-chain-refresh'}),retryAfterMs:5000};
  const wait=dependencies.wait??quietInterval;
  let providerAttempted=false;
  try {
    // Reconcile the selected future and watch scope against the latest state
    // after obtaining the same lease used by the resumable full collection.
    canonical=await store.get(stateKey(env));
    const metadata=selectIvContracts(canonical?.markets?.[market],{market,underlyingCode,codes,allowedStrikes,now});
    saved=await store.get(recordKey)??empty(market,underlyingCode);
    if(now-Date.parse(saved.lastAttemptAt??'')<IV_CHECK_MS)return publicState(saved,now,{allowedStrikes,status:'cooldown'});
    const next={...saved,rows:{...saved.rows},activeCodes:codes,lastAttemptAt:iso(now),nextRefreshAt:iso(now+IV_CHECK_MS),errors:[]};
    try {
      const client=(dependencies.createQuoteClient??createFutuQuoteClient)({getAccessToken:()=>getFutuAccess(env,fetcher),fetchImpl:fetcher,deadlineAtMs:Date.now()+18000});
      // A shared lease prevents overlap but alone does not space requests at
      // the handoff between the full collector and this single-batch client.
      // Hold one quiet provider interval on each side of the targeted call.
      await wait(QUOTE_INTERVAL_MS);
      providerAttempted=true;
      const requested=[underlyingCode,...codes],raw=await client.snapshots(requested),result=reconcileSnapshots(requested,raw);
      const quote=result.matched.get(underlyingCode),timestamp=numeric(quote?.update_time),price=numeric(quote?.last_price),oldTime=Date.parse(saved.priceTimestamp??'');
      if(quote?.future_valid===true&&price>0&&timestamp>=946684800000&&timestamp<=now+60000&&(!Number.isFinite(oldTime)||timestamp>=oldTime)){
        next.underlyingPrice=price;next.priceTimestamp=iso(timestamp);
      }
      let returned=0,advanced=0;
      for(const row of metadata){
        const rawRow=result.matched.get(row.code),normalized=rawRow?normalizeOptionSnapshot(row,rawRow,{now,staleAfterMs:120000}):null;
        const updated=mergeIvObservation(next.rows[row.code],row,normalized,now);
        if(normalized?.optionValid===true)returned++;
        if(updated.observationStatus==='newer-quote'||updated.observationStatus==='baseline-only')advanced++;
        next.rows[row.code]=updated;
      }
      // Retain a bounded number of previously selected expiry-series baselines.
      const protectedCodes=new Set(codes),older=Object.entries(next.rows).filter(([code])=>!protectedCodes.has(code)).sort((a,b)=>String(b[1].lastCheckedAt).localeCompare(String(a[1].lastCheckedAt)));
      next.rows=Object.fromEntries([...codes.map(code=>[code,next.rows[code]]),...older.slice(0,1200-codes.length)]);
      next.coverage={requested:codes.length,returned,tracked:codes.filter(code=>next.rows[code]?.current).length,advanced,
        missing:result.missingCodes.filter(code=>code!==underlyingCode).length,duplicate:result.duplicateCodes.length,
        unexpected:result.unexpectedCodes.length,limit:399};
      next.status=returned===codes.length?'checked':'partial';
      if(returned>0)next.lastSuccessAt=iso(now);
      if(!result.complete)next.errors=[{code:'IV_PARTIAL_SNAPSHOT',message:'Some requested snapshots were missing, duplicated or unexpected. Prior valid observations were retained.'}];
    } catch(error) {
      next.status='check-failed';next.errors=[safeFutuError(error)];
      next.coverage={requested:codes.length,returned:0,tracked:codes.filter(code=>next.rows[code]?.current).length,advanced:0,limit:399};
    }
    await store.put(recordKey,next);
    return publicState(next,now,{allowedStrikes});
  } finally {
    try {if(providerAttempted)await wait(QUOTE_INTERVAL_MS);}
    finally {await store.releaseLease(LEASE_KEY,lease);}
  }
}
