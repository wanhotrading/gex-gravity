import {createPrivateStore,randomId,digest} from './secure-store.mjs';
const ORIGIN='https://webapi.futunn.com';
const SECRET='oauth/connection';
const CALLBACK='/api/futu/callback';
const AUTH_LEASE='oauth/connection-writer';
const AUTH_LEASE_MS=45000;
const TERMINAL_REASONS=new Set(['invalid_grant','invalid_client','scope_rejected']);
export class ConnectionError extends Error { constructor(code,message) { super(message); this.code=code; } }
function confirmedReauthorization(value){return value?.reauthorizationRequired===true&&TERMINAL_REASONS.has(value.reauthorizationReason);}
function sameConnection(a,b){return !!a&&!!b&&['authorizedAt','clientId','siteOrigin','scope','refreshToken','accessToken','expiresAt','reauthorizationRequired','reauthorizationReason'].every(key=>a[key]===b[key]);}
function usableConnection(value,origin){return !!value&&value.siteOrigin===origin&&!confirmedReauthorization(value);}
function freshConnection(value,now){return value.reauthorizationRequired!==true&&value.expiresAt>now+120000;}
export function validateQuoteScope(scope) {
  const scopes=typeof scope==='string'?scope.trim().split(/\s+/):[];
  if (!scopes.includes('quote:read') || scopes.length>65 || scopes.length!==new Set(scopes).size || scopes.some(s=>s!=='quote:read'&&!/^accid:[0-9]{1,30}$/.test(s))) throw new ConnectionError('SCOPE_REJECTED','The connection must grant only market-data queries.');
  return scope;
}
function siteOrigin(env) {
  const url=new URL(env.GAMMA_SITE_ORIGIN);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/') throw new ConnectionError('CONNECTION_NOT_CONFIGURED','The site connection needs configuration.');
  return url.origin;
}
async function oauthRequest(path, body, fetcher) {
  try {
    if(!['/oauth2/register','/oauth2/token'].includes(path))throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Unsupported authorization request.');
    const form=body instanceof URLSearchParams;
    const response=await fetcher(ORIGIN+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{accept:'application/json','content-type':form?'application/x-www-form-urlencoded':'application/json'},body:form?body.toString():JSON.stringify(body)});
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu returned an unsupported authorization redirect.');}
    if(!response.body||Number(response.headers.get('content-length'))>100000)throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu returned an invalid authorization response.');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>100000){await reader.cancel();throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu returned an invalid authorization response.');}chunks.push(value);}}
    finally {reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let raw;try {raw=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu returned an invalid authorization response.');}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu returned an invalid authorization response.');
    // Only literal OAuth errors from a non-transient response establish that a
    // grant/client was rejected. Never persist response descriptions or bodies.
    if(response.status!==408&&response.status!==429&&response.status<500){
      if(raw.error==='invalid_grant')throw new ConnectionError('OAUTH_INVALID_GRANT','The saved Futu authorization expired or was revoked.');
      if(raw.error==='invalid_client')throw new ConnectionError('OAUTH_INVALID_CLIENT','Futu rejected the saved quote-only OAuth client.');
    }
    if(!response.ok||raw.error!==undefined)throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu could not complete the quote-only request. Try again shortly.');
    return raw;
  }catch(error){if(error instanceof ConnectionError)throw error;throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu could not complete the quote-only connection. Upstream details were withheld.');}
}
function validatedToken(raw, previous, now) {
  const scope=validateQuoteScope(raw.scope ?? previous?.scope);
  if(String(raw.token_type).toLowerCase()!=='bearer'||typeof raw.access_token!=='string'||!raw.access_token||/[\r\n\x00]/.test(raw.access_token)||raw.access_token.length>16384||!Number.isFinite(raw.expires_in)||raw.expires_in<60||raw.expires_in>2592000) throw new ConnectionError('FUTU_AUTHORIZATION_FAILED','Futu returned an invalid quote token.');
  const refreshToken=raw.refresh_token ?? previous?.refreshToken;
  if(typeof refreshToken!=='string'||!refreshToken||refreshToken.length>16384||/[\r\n\x00]/.test(refreshToken)) throw new ConnectionError('REFRESH_TOKEN_REQUIRED','Futu did not grant the renewable connection required for scheduled updates.');
  return {accessToken:raw.access_token,refreshToken,scope,expiresAt:now+raw.expires_in*1000,authorizedAt:previous?.authorizedAt??now,clientId:previous.clientId,siteOrigin:previous.siteOrigin,reauthorizationRequired:false};
}
export async function connectionStatus(env) {
  try {const value=await createPrivateStore(env).getSecret(SECRET);const matches=!!value&&value.siteOrigin===siteOrigin(env),terminal=confirmedReauthorization(value);return {configured:true,connected:matches&&!terminal,reauthorizationRequired:!!value&&(!matches||terminal),recoveryPending:matches&&value.reauthorizationRequired===true&&!terminal,tokenExpiresAt:matches?new Date(value.expiresAt).toISOString():null};}
  catch(error){if(error?.code==='PRIVATE_STORAGE_UNAVAILABLE')throw error;return {configured:false,connected:false,reauthorizationRequired:false,tokenExpiresAt:null};}
}
export async function startFutuConnection(request,env,fetcher=fetch,now=Date.now()) {
  const user=request.headers.get('oai-authenticated-user-id');
  if(!user)throw new ConnectionError('OWNER_SIGN_IN_REQUIRED','Sign in to GEX Gravity to connect Futu.');
  const store=createPrivateStore(env),origin=siteOrigin(env),redirect=origin+CALLBACK;
  if(new URL(request.url).origin!==origin)throw new ConnectionError('INVALID_ORIGIN','Start the Futu connection from the configured private site.');
  let client=await store.get('oauth/client');
  const previous=await store.getSecret(SECRET);
  if(previous?.reauthorizationRequired===true&&previous.reauthorizationReason==='invalid_client'&&previous.clientId===client?.clientId)client=null;
  if(!client||client.redirectUri!==redirect) {
    const raw=await oauthRequest('/oauth2/register',{redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],client_name:'GEX Gravity market data',scope:'quote:read'},fetcher);
    const scopes=typeof raw.scope==='string'?raw.scope.trim().split(/\s+/):[];
    if(!scopes.includes('quote:read')||scopes.some(s=>s!=='quote:read'&&s!=='accid:*')||typeof raw.client_id!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(raw.client_id)||raw.client_secret||raw.token_endpoint_auth_method&&raw.token_endpoint_auth_method!=='none'||!Array.isArray(raw.redirect_uris)||raw.redirect_uris.length!==1||raw.redirect_uris[0]!==redirect||raw.grant_types?.some(s=>!['authorization_code','refresh_token'].includes(s)))throw new ConnectionError('REGISTRATION_REJECTED','Futu registration did not match the quote-only connection.');
    client={clientId:raw.client_id,redirectUri:redirect};await store.put('oauth/client',client);
  }
  const state=randomId(),verifier=randomId();
  await store.putSecret('oauth/pending/'+state,{user,verifier,clientId:client.clientId,redirectUri:redirect,createdAt:now});
  const url=new URL(ORIGIN+'/oauth2/authorize/confirm');
  url.search=new URLSearchParams({client_id:client.clientId,redirect_uri:redirect,response_type:'code',scope:'quote:read',state,code_challenge:await digest(verifier),code_challenge_method:'S256'});
  return new Response(null,{status:302,headers:{location:url.toString(),'cache-control':'no-store','referrer-policy':'no-referrer'}});
}
export async function finishFutuConnection(request,env,fetcher=fetch,now=Date.now()) {
  const url=new URL(request.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
  if(url.origin!==siteOrigin(env)||url.pathname!==CALLBACK||!state||!/^[A-Za-z0-9_-]{43}$/.test(state)||url.searchParams.getAll('state').length!==1||url.searchParams.has('error')||!code||code.length>8192||/[\x00-\x20\x7f]/.test(code)||url.searchParams.getAll('code').length!==1)throw new ConnectionError('INVALID_CALLBACK','The Futu connection was declined or its callback was invalid.');
  const store=createPrivateStore(env),key='oauth/pending/'+state,session=await store.getSecret(key);
  if(!session||!Number.isFinite(session.createdAt)||now-session.createdAt>600000||session.createdAt>now||session.user!==request.headers.get('oai-authenticated-user-id')||session.redirectUri!==siteOrigin(env)+CALLBACK||!/^[A-Za-z0-9_-]{43}$/.test(session.verifier??''))throw new ConnectionError('INVALID_STATE','The Futu connection expired or belongs to a different signed-in session.');
  const lease=await store.acquireLease('oauth/consuming/'+state,now,600000);
  if(!lease)throw new ConnectionError('INVALID_STATE','This Futu authorization callback has already been consumed.');
  let writer=null;
  try {
    writer=await store.acquireLease(AUTH_LEASE,now,AUTH_LEASE_MS);
    if(!writer)throw new ConnectionError('AUTH_REFRESH_BUSY','Futu authorization is updating. Retry this callback shortly.');
    if(!await store.getSecret(key))throw new ConnectionError('INVALID_STATE','This Futu authorization callback has already been consumed.');
    await store.remove(key);
    const previousVersion=await store.getSecretVersion(SECRET);
    const raw=await oauthRequest('/oauth2/token',new URLSearchParams({grant_type:'authorization_code',code,client_id:session.clientId,redirect_uri:session.redirectUri,code_verifier:session.verifier}),fetcher);
    const connection=validatedToken(raw,{clientId:session.clientId,authorizedAt:now,siteOrigin:siteOrigin(env)},now);
    if(!await store.putSecretIfVersion(SECRET,connection,previousVersion.etag))throw new ConnectionError('CONNECTION_CHANGED','Another Futu authorization completed first. The newer saved connection was preserved.');
    return connectionStatus(env);
  }finally{try{if(writer)await store.releaseLease(AUTH_LEASE,writer);}finally{await store.releaseLease('oauth/consuming/'+state,lease);}}
}
const renewingByBucket=new WeakMap();
export async function getFutuAccess(env,fetcher=fetch,now=Date.now()) {
  const store=createPrivateStore(env),origin=siteOrigin(env);let current=await store.getSecret(SECRET);
  if(!usableConnection(current,origin))throw new ConnectionError('CONNECTION_REQUIRED','Connect Futu with market-data queries to start updates.');
  validateQuoteScope(current.scope);
  if(freshConnection(current,now))return {accessToken:current.accessToken,scope:current.scope};
  let renewals=renewingByBucket.get(env.BUCKET);if(!renewals){renewals=new Map();renewingByBucket.set(env.BUCKET,renewals);}
  const renewalKey=siteOrigin(env)+'|'+current.clientId+'|'+current.authorizedAt;
  if(renewals.has(renewalKey))return renewals.get(renewalKey);
  const renewing=(async()=>{
    let lease=null,expectedEtag=null;
    try {
      lease=await store.acquireLease(AUTH_LEASE,now,AUTH_LEASE_MS);
      if(!lease){
        const latest=await store.getSecret(SECRET);
        if(usableConnection(latest,origin)&&freshConnection(latest,now)){validateQuoteScope(latest.scope);return {accessToken:latest.accessToken,scope:latest.scope};}
        throw new ConnectionError('AUTH_REFRESH_BUSY','Futu authorization is renewing in another request. Retry shortly.');
      }
      // Another isolate or a consent callback may have completed after our first
      // read. All token writers use this lease and renewal rereads inside it.
      const version=await store.getSecretVersion(SECRET);current=version.value;expectedEtag=version.etag;
      if(!usableConnection(current,origin))throw new ConnectionError('CONNECTION_REQUIRED','Connect Futu with market-data queries to start updates.');
      validateQuoteScope(current.scope);
      if(freshConnection(current,now))return {accessToken:current.accessToken,scope:current.scope};
      const raw=await oauthRequest('/oauth2/token',new URLSearchParams({grant_type:'refresh_token',refresh_token:current.refreshToken,client_id:current.clientId}),fetcher);
      const next=validatedToken(raw,current,now),latest=await store.getSecret(SECRET);
      if(!sameConnection(latest,current))throw new ConnectionError('CONNECTION_CHANGED','The Futu connection changed during renewal. Retry the quote query.');
      if(!await store.putSecretIfVersion(SECRET,next,expectedEtag))throw new ConnectionError('CONNECTION_CHANGED','The Futu connection changed during renewal. Retry the quote query.');
      return {accessToken:next.accessToken,scope:next.scope};
    } catch(error) {
      if(error instanceof ConnectionError&&['CONNECTION_CHANGED','CONNECTION_REQUIRED','AUTH_REFRESH_BUSY'].includes(error.code))throw error;
      const latest=await store.getSecret(SECRET);
      if(!sameConnection(latest,current)){
        if(usableConnection(latest,origin)&&freshConnection(latest,now)){validateQuoteScope(latest.scope);return {accessToken:latest.accessToken,scope:latest.scope};}
        throw new ConnectionError('CONNECTION_CHANGED','The Futu connection changed during renewal. Retry the quote query.');
      }
      const reason=error?.code==='OAUTH_INVALID_GRANT'?'invalid_grant':error?.code==='OAUTH_INVALID_CLIENT'?'invalid_client':error?.code==='SCOPE_REJECTED'?'scope_rejected':null;
      if(reason){
        if(!await store.putSecretIfVersion(SECRET,{...current,reauthorizationRequired:true,reauthorizationReason:reason,reauthorizationCheckedAt:now},expectedEtag))
          throw new ConnectionError('CONNECTION_CHANGED','The Futu connection changed during renewal. Retry the quote query.');
        throw new ConnectionError('REAUTHORIZATION_REQUIRED','Futu needs renewed quote-only authorization.');
      }
      // Network, rate limits, upstream failures, malformed replies and storage
      // failures do not prove expiry/revocation. Preserve the renewable grant.
      throw new ConnectionError('AUTH_REFRESH_UNAVAILABLE','Futu token renewal is temporarily unavailable. Retry shortly; reconnecting is not required.');
    } finally {try{if(lease)await store.releaseLease(AUTH_LEASE,lease);}finally{renewals.delete(renewalKey);}}
  })();
  renewals.set(renewalKey,renewing);
  return renewing;
}
