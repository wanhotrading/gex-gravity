import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createPrivateStore, encode64, seal, unseal, digest } from '../lib/secure-store.mjs';
import { startFutuConnection, finishFutuConnection, getFutuAccess, connectionStatus, validateQuoteScope } from '../lib/futu-auth.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const NOW = Date.parse('2026-11-04T18:00:00Z');
const ORIGIN = 'https://gamma.test';
const ACCESS = 'fake-private-access-token', REFRESH = 'fake-private-refresh-token';
const USER = 'owner-fixture';
const keyName = 'oauth/connection';
const tokenPayload = (extra = {}) => ({ access_token: ACCESS, refresh_token: REFRESH,
  token_type: 'Bearer', expires_in: 7200, scope: 'quote:read accid:1 accid:2 accid:3', ...extra });
class MemoryBucket {
  rows = new Map(); counter = 0;
  async get(key) {
    const row = this.rows.get(key); if (!row) return null;
    return { etag: row.etag, text: async () => row.body, json: async () => JSON.parse(row.body) };
  }
  async put(key, body, options = {}) {
    const old = this.rows.get(key), condition = options.onlyIf;
    if (condition?.etagMatches && old?.etag !== condition.etagMatches) return null;
    if (condition?.etagDoesNotMatch === '*' && old) return null;
    const row = { body: String(body), etag: `etag-${++this.counter}`, options };
    this.rows.set(key, row); return { etag: row.etag };
  }
  async delete(key) { this.rows.delete(key); }
}
function environment(extra = {}) {
  return { BUCKET: new MemoryBucket(), GAMMA_SITE_ORIGIN: ORIGIN,
    FUTU_TOKEN_ENCRYPTION_KEY: encode64(new Uint8Array(32).fill(7)), ...extra };
}
function request(path, user = USER, origin = ORIGIN) {
  return new Request(origin + path, { headers: user ? { 'oai-authenticated-user-id': user } : {} });
}
function oauthMock({ token = tokenPayload(), failure } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (failure) throw Error(ACCESS + REFRESH);
    if (url.endsWith('/oauth2/register')) {
      const data = JSON.parse(options.body);
      return Response.json({ client_id: 'fixture-client', scope: 'quote:read accid:*', redirect_uris: data.redirect_uris,
        token_endpoint_auth_method: 'none', grant_types: data.grant_types });
    }
    assert.equal(url, 'https://webapi.futunn.com/oauth2/token'); return Response.json(token);
  };
  return { fetcher, calls };
}
async function pending(env, fetcher, now = NOW) {
  const response = await startFutuConnection(request('/api/futu/connect'), env, fetcher, now);
  const url = new URL(response.headers.get('location'));
  return { response, url, state: url.searchParams.get('state'), callback: request('/api/futu/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-authorization-code' })) };
}
async function connected(env, now = NOW) {
  const mock = oauthMock(); const session = await pending(env, mock.fetcher, now);
  const result = await finishFutuConnection(session.callback, env, mock.fetcher, now);
  return { ...mock, ...session, result };
}
async function expiring(env) {
  await connected(env); const store = createPrivateStore(env);
  const value = await store.getSecret(keyName); value.expiresAt = NOW + 60000;
  await store.putSecret(keyName, value); return { store, value };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('OAuth uses the supported Workers manual mode and rejects redirects without following them', async () => {
  let calls=0;
  await assert.rejects(startFutuConnection(request('/api/futu/connect'),environment(),async(url,options)=>{
    calls++;assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{location:'https://other.test/'}});
  },NOW),{code:'FUTU_AUTHORIZATION_FAILED'});
  assert.equal(calls,1);
});
test('AES-GCM storage hides secrets and authenticates record name, key and ciphertext', async () => {
  const env = environment(), data = { accessToken: ACCESS, refreshToken: REFRESH };
  const encrypted = await seal(env, keyName, data);
  assert.ok(!encrypted.includes(ACCESS)); assert.ok(!encrypted.includes(REFRESH));
  assert.deepEqual(await unseal(env, keyName, encrypted), data);
  await assert.rejects(unseal(env, 'different-record', encrypted));
  await assert.rejects(unseal(environment({ FUTU_TOKEN_ENCRYPTION_KEY: encode64(new Uint8Array(32).fill(8)) }), keyName, encrypted));
  const changed = JSON.parse(encrypted); changed.cipher = (changed.cipher[0] === 'A' ? 'B' : 'A') + changed.cipher.slice(1);
  await assert.rejects(unseal(env, keyName, JSON.stringify(changed)));
  await assert.rejects(seal(environment({ FUTU_TOKEN_ENCRYPTION_KEY: 'bad' }), keyName, data));
});

test('R2 records use private headers and leases resist concurrent acquisition and late release', async () => {
  const env = environment(), store = createPrivateStore(env);
  await store.putSecret(keyName, { accessToken: ACCESS });
  const record = env.BUCKET.rows.get('gamma-watch/v1/' + keyName);
  assert.equal(record.options.httpMetadata.cacheControl, 'private, no-store');
  assert.ok(!record.body.includes(ACCESS));
  const ids = await Promise.all([store.acquireLease('job', NOW, 100), store.acquireLease('job', NOW, 100)]);
  assert.equal(ids.filter(Boolean).length, 1);
  const old = ids.find(Boolean), newer = await store.acquireLease('job', NOW + 101, 100);
  assert.ok(newer); await store.releaseLease('job', old);
  assert.equal((await store.get('job')).id, newer);
});

test('quote scope accepts multiple numeric account selectors and rejects capabilities outside quote read', () => {
  assert.equal(validateQuoteScope('quote:read accid:1 accid:2 accid:3'), 'quote:read accid:1 accid:2 accid:3');
  for (const scope of ['quote:read trade:read', 'quote:read trade:write', 'quote:read quote:write',
    'quote:read accid:*', 'quote:read unknown:read', 'quote:read quote:read']) assert.throws(() => validateQuoteScope(scope), { code: 'SCOPE_REJECTED' });
});

test('OAuth start uses fixed provider origin, quote-only PKCE and encrypted pending state', async () => {
  const env = environment(), mock = oauthMock(), session = await pending(env, mock.fetcher);
  assert.equal(session.response.status, 302); assert.equal(session.url.origin, 'https://webapi.futunn.com');
  assert.equal(session.url.pathname, '/oauth2/authorize/confirm'); assert.equal(session.url.searchParams.get('scope'), 'quote:read');
  assert.equal(session.url.searchParams.get('redirect_uri'), ORIGIN + '/api/futu/callback');
  assert.equal(session.url.searchParams.get('code_challenge_method'), 'S256');
  const value = await createPrivateStore(env).getSecret('oauth/pending/' + session.state);
  assert.equal(value.user, USER); assert.equal(session.url.searchParams.get('code_challenge'), await digest(value.verifier));
  assert.ok([...env.BUCKET.rows.values()].every(row => !row.body.includes(value.verifier)));
  assert.equal(mock.calls[0].options.redirect, 'manual');
  const registration = JSON.parse(mock.calls[0].options.body);
  assert.equal(registration.scope, 'quote:read'); assert.deepEqual(registration.grant_types, ['authorization_code', 'refresh_token']);
});

test('OAuth start rejects unsigned and foreign-origin requests before provider access', async () => {
  const env = environment(), mock = oauthMock();
  await assert.rejects(startFutuConnection(request('/api/futu/connect', null), env, mock.fetcher, NOW), { code: 'OWNER_SIGN_IN_REQUIRED' });
  await assert.rejects(startFutuConnection(request('/api/futu/connect', USER, 'https://other.test'), env, mock.fetcher, NOW), { code: 'INVALID_ORIGIN' });
  assert.equal(mock.calls.length, 0);
});

test('callback is user/state/origin bound and returns no credentials after encrypted persistence', async () => {
  const env = environment(), mock = oauthMock(), session = await pending(env, mock.fetcher);
  const path = new URL(session.callback.url).pathname + new URL(session.callback.url).search;
  await assert.rejects(finishFutuConnection(request(path, 'different-owner'), env, mock.fetcher, NOW), { code: 'INVALID_STATE' });
  await assert.rejects(finishFutuConnection(request(path, USER, 'https://other.test'), env, mock.fetcher, NOW), { code: 'INVALID_CALLBACK' });
  assert.equal(mock.calls.length, 1);
  const result = await finishFutuConnection(session.callback, env, mock.fetcher, NOW);
  assert.equal(result.connected, true); assert.ok(!JSON.stringify(result).includes(ACCESS));
  const value = await createPrivateStore(env).getSecret(keyName);
  assert.equal(value.accessToken, ACCESS); assert.equal(value.refreshToken, REFRESH); assert.equal(value.siteOrigin, ORIGIN);
  assert.equal(await createPrivateStore(env).getSecret('oauth/pending/' + session.state), null);
  const exchange = new URLSearchParams(mock.calls[1].options.body);
  assert.equal(exchange.get('grant_type'), 'authorization_code'); assert.equal(exchange.get('redirect_uri'), ORIGIN + '/api/futu/callback');
  assert.equal(exchange.get('code'), 'fixture-authorization-code'); assert.match(exchange.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(finishFutuConnection(session.callback, env, mock.fetcher, NOW), { code: 'INVALID_STATE' });
});

test('concurrent callbacks exchange one authorization code once', async () => {
  const env = environment(), mock = oauthMock(), session = await pending(env, mock.fetcher);
  const results = await Promise.allSettled([finishFutuConnection(session.callback, env, mock.fetcher, NOW), finishFutuConnection(session.callback, env, mock.fetcher, NOW)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(mock.calls.filter(call => call.url.endsWith('/oauth2/token')).length, 1);
});

test('expired, duplicate and malformed callback state do not consume usable state', async () => {
  const env = environment(), mock = oauthMock(), session = await pending(env, mock.fetcher);
  await assert.rejects(finishFutuConnection(session.callback, env, mock.fetcher, NOW + 600001), { code: 'INVALID_STATE' });
  const path = '/api/futu/callback?' + new URLSearchParams({ state: session.state, code: 'abc' });
  await assert.rejects(finishFutuConnection(request(path + '&state=' + session.state), env, mock.fetcher, NOW), { code: 'INVALID_CALLBACK' });
  assert.equal(mock.calls.length, 1);
});

test('fresh token bypasses network and wrong site origin cannot reuse encrypted connection', async () => {
  const env = environment(); await connected(env); let requests = 0;
  const result = await getFutuAccess(env, async () => { requests++; throw Error('unexpected'); }, NOW);
  assert.equal(result.accessToken, ACCESS); assert.equal(requests, 0);
  const changed = { ...env, GAMMA_SITE_ORIGIN: 'https://other.test' };
  await assert.rejects(getFutuAccess(changed, async () => assert.fail('foreign origin must not query'), NOW), { code: 'CONNECTION_REQUIRED' });
  assert.equal((await connectionStatus(changed)).connected, false);
});

test('refresh reuses nonrotated refresh token and preserves quote-only scope when omitted', async () => {
  const env = environment(), { store } = await expiring(env); let seen;
  const refreshed = await getFutuAccess(env, async (url, options) => {
    assert.equal(url, 'https://webapi.futunn.com/oauth2/token'); assert.equal(options.redirect, 'manual');
    seen = new URLSearchParams(options.body);
    return Response.json({ access_token: 'new-access', token_type: 'bearer', expires_in: 7200 });
  }, NOW);
  assert.equal(seen.get('grant_type'), 'refresh_token'); assert.equal(seen.get('refresh_token'), REFRESH);
  assert.equal(refreshed.accessToken, 'new-access');
  const persisted = await store.getSecret(keyName);
  assert.equal(persisted.refreshToken, REFRESH); assert.equal(persisted.siteOrigin, ORIGIN);
  assert.equal(persisted.scope, 'quote:read accid:1 accid:2 accid:3');
});

test('refresh never persists a broadened scope and records its literal rejection reason', async () => {
  const env = environment(), { store } = await expiring(env);
  await assert.rejects(getFutuAccess(env, async () => Response.json(tokenPayload({scope:'quote:read trade:write',access_token:'rejected-access'})), NOW), {code:'REAUTHORIZATION_REQUIRED'});
  const value=await store.getSecret(keyName);
  assert.equal(value.accessToken,ACCESS);assert.equal(value.reauthorizationRequired,true);assert.equal(value.reauthorizationReason,'scope_rejected');
  assert.ok(!value.scope.includes('trade:'));
});

test('concurrent renewal is shared only within the same bucket and connection', async () => {
  const a = environment(), b = environment(); await expiring(a); await expiring(b);
  const startedA = deferred(), startedB = deferred(), release = deferred(); let aCalls = 0, bCalls = 0;
  const fa = async () => { aCalls++; startedA.resolve(); await release.promise; return Response.json(tokenPayload({ access_token: 'access-a' })); };
  const fb = async () => { bCalls++; startedB.resolve(); await release.promise; return Response.json(tokenPayload({ access_token: 'access-b' })); };
  const pa = getFutuAccess(a, fa, NOW); await startedA.promise;
  const pa2 = getFutuAccess(a, fa, NOW), pb = getFutuAccess(b, fb, NOW); await startedB.promise;
  release.resolve(); const [ra, ra2, rb] = await Promise.all([pa, pa2, pb]);
  assert.equal(ra.accessToken, 'access-a'); assert.equal(ra2.accessToken, 'access-a'); assert.equal(rb.accessToken, 'access-b');
  assert.equal(aCalls, 1); assert.equal(bCalls, 1);
});

test('late refresh cannot overwrite a newly authorized connection', async () => {
  const env = environment(), { store, value } = await expiring(env), started = deferred(), release = deferred();
  const old = getFutuAccess(env, async () => { started.resolve(); await release.promise; return Response.json(tokenPayload({ access_token: 'late-access' })); }, NOW);
  await started.promise;
  await store.putSecret(keyName, { ...value, accessToken: 'newer-connection-access', refreshToken: 'newer-refresh', authorizedAt: NOW + 1 });
  release.resolve(); await assert.rejects(old, { code: 'CONNECTION_CHANGED' });
  assert.equal((await store.getSecret(keyName)).accessToken, 'newer-connection-access');
  assert.equal((await store.getSecret(keyName)).reauthorizationRequired, false);
});

test('oversized/invalid provider response fails without storing credentials', async () => {
  const env = environment(), mock = oauthMock();
  await assert.rejects(startFutuConnection(request('/api/futu/connect'), env, async () => new Response('x'.repeat(100001)), NOW), { code: 'FUTU_AUTHORIZATION_FAILED' });
  await assert.rejects(startFutuConnection(request('/api/futu/connect'), env, async () => { throw Error(ACCESS); }, NOW), error => !error.message.includes(ACCESS));
  assert.equal(await createPrivateStore(env).getSecret(keyName), null); assert.equal(mock.calls.length, 0);
});

test('network, timeout, rate limits, upstream failures and malformed refresh replies preserve the renewable grant',async()=>{
  const failures=[
    async()=>{throw Error(ACCESS+REFRESH);},async()=>{throw new DOMException(ACCESS,'TimeoutError');},
    async()=>Response.json({error:'invalid_grant',error_description:ACCESS},{status:429}),
    async()=>Response.json({error:'invalid_grant',error_description:ACCESS},{status:500}),
    async()=>new Response(REFRESH,{status:503}),async()=>new Response('malformed-json'),
    async()=>Response.json({error:'temporarily_unavailable',error_description:REFRESH},{status:400}),
    async()=>Response.json({access_token:ACCESS,token_type:'bearer',expires_in:0}),
  ];
  for(const fetcher of failures){
    const env=environment(),{store,value}=await expiring(env);
    await assert.rejects(getFutuAccess(env,fetcher,NOW),error=>error.code==='AUTH_REFRESH_UNAVAILABLE'&&!error.message.includes(ACCESS)&&!error.message.includes(REFRESH));
    assert.deepEqual(await store.getSecret(keyName),value);
    assert.equal((await connectionStatus(env)).connected,true);
  }
});

test('confirmed invalid_grant is terminal while legacy flags get one bounded quote-only recovery attempt',async()=>{
  const env=environment(),{store,value}=await expiring(env);let calls=0;
  await assert.rejects(getFutuAccess(env,async()=>{calls++;return Response.json({error:'invalid_grant',error_description:ACCESS},{status:400});},NOW),{code:'REAUTHORIZATION_REQUIRED'});
  const rejected=await store.getSecret(keyName);assert.equal(rejected.reauthorizationReason,'invalid_grant');
  assert.equal((await connectionStatus(env)).reauthorizationRequired,true);
  await assert.rejects(getFutuAccess(env,async()=>assert.fail('confirmed invalid grant must not retry'),NOW),{code:'CONNECTION_REQUIRED'});assert.equal(calls,1);
  await store.putSecret(keyName,{...value,reauthorizationRequired:true});
  let status=await connectionStatus(env);assert.equal(status.connected,true);assert.equal(status.recoveryPending,true);assert.equal(status.reauthorizationRequired,false);
  await assert.rejects(getFutuAccess(env,async()=>{throw Error(ACCESS);},NOW),{code:'AUTH_REFRESH_UNAVAILABLE'});
  assert.equal((await store.getSecret(keyName)).reauthorizationRequired,true);
  const recovered=await getFutuAccess(env,async(url,options)=>{
    assert.equal(new URLSearchParams(options.body).get('grant_type'),'refresh_token');calls++;return Response.json(tokenPayload({access_token:'recovered-access'}));
  },NOW);
  assert.equal(recovered.accessToken,'recovered-access');assert.equal((await store.getSecret(keyName)).reauthorizationRequired,false);
  status=await connectionStatus(env);assert.equal(status.connected,true);assert.equal(status.recoveryPending,false);assert.equal(calls,2);
});

test('separate bucket wrappers sharing R2 cannot perform overlapping renewals',async()=>{
  const env=environment();await expiring(env);const bucket=env.BUCKET;
  const other={...env,BUCKET:{get:bucket.get.bind(bucket),put:bucket.put.bind(bucket),delete:bucket.delete.bind(bucket)}};
  const started=deferred(),release=deferred();let calls=0,otherCalls=0;
  const first=getFutuAccess(env,async()=>{calls++;started.resolve();await release.promise;return Response.json(tokenPayload({access_token:'single-renewal'}));},NOW);
  await started.promise;
  await assert.rejects(getFutuAccess(other,async()=>{otherCalls++;return Response.json(tokenPayload());},NOW),{code:'AUTH_REFRESH_BUSY'});
  release.resolve();await first;
  const latest=await getFutuAccess(other,async()=>{otherCalls++;throw Error('must use fresh encrypted token');},NOW);
  assert.equal(latest.accessToken,'single-renewal');assert.equal(calls,1);assert.equal(otherCalls,0);
});

test('consent callback shares the token writer lease and preserves pending state while renewal runs',async()=>{
  const env=environment();await expiring(env);const consentMock=oauthMock({token:tokenPayload({access_token:'new-consent-access'})});
  const session=await pending(env,consentMock.fetcher,NOW+1),started=deferred(),release=deferred();
  const renewing=getFutuAccess(env,async()=>{started.resolve();await release.promise;return Response.json(tokenPayload({access_token:'renewed-old-access'}));},NOW);
  await started.promise;
  await assert.rejects(finishFutuConnection(session.callback,env,consentMock.fetcher,NOW+2),{code:'AUTH_REFRESH_BUSY'});
  assert.ok(await createPrivateStore(env).getSecret('oauth/pending/'+session.state));assert.equal(consentMock.calls.length,0);
  release.resolve();await renewing;
  assert.equal((await finishFutuConnection(session.callback,env,consentMock.fetcher,NOW+3)).connected,true);
  const saved=await createPrivateStore(env).getSecret(keyName);assert.equal(saved.accessToken,'new-consent-access');assert.equal(saved.authorizedAt,NOW+3);
});

test('late failure cannot overwrite a newly renewed token with unchanged authorization identity',async()=>{
  const env=environment(),{store,value}=await expiring(env),started=deferred(),release=deferred();
  const old=getFutuAccess(env,async()=>{started.resolve();await release.promise;return Response.json({error:'invalid_grant'},{status:400});},NOW);
  await started.promise;
  await store.putSecret(keyName,{...value,accessToken:'newer-access-same-grant',expiresAt:NOW+7200000});
  release.resolve();assert.equal((await old).accessToken,'newer-access-same-grant');
  const saved=await store.getSecret(keyName);assert.equal(saved.accessToken,'newer-access-same-grant');assert.equal(saved.reauthorizationRequired,false);
});

test('confirmed invalid_client reconnect registers a new quote-only client',async()=>{
  const env=environment();await expiring(env);
  await assert.rejects(getFutuAccess(env,async()=>Response.json({error:'invalid_client'},{status:401}),NOW),{code:'REAUTHORIZATION_REQUIRED'});
  const mock=oauthMock();await startFutuConnection(request('/api/futu/connect'),env,mock.fetcher,NOW+1);
  assert.equal(mock.calls.length,1);assert.ok(mock.calls[0].url.endsWith('/oauth2/register'));
  assert.equal(JSON.parse(mock.calls[0].options.body).scope,'quote:read');
});

test('connection status propagates unavailable private storage rather than claiming disconnected',async()=>{
  const env=environment();env.BUCKET.get=async()=>{const error=Error('safe storage failure');error.code='PRIVATE_STORAGE_UNAVAILABLE';throw error;};
  await assert.rejects(connectionStatus(env),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
});

test('expired-lease renewal success and terminal rejection cannot overwrite a newer consent at the conditional write',async()=>{
  for(const rejected of [false,true]){
    const env=environment();await expiring(env);const consent=oauthMock({token:tokenPayload({access_token:'new-consent-after-lease'})});
    const session=await pending(env,consent.fetcher,NOW+1),bucket=env.BUCKET,atomicPut=bucket.put.bind(bucket),atWrite=deferred(),releaseWrite=deferred();
    let intercepted=false;
    bucket.put=async(key,body,options)=>{
      if(!intercepted&&key==='gamma-watch/v1/'+keyName&&options?.onlyIf?.etagMatches){intercepted=true;atWrite.resolve();await releaseWrite.promise;}
      return atomicPut(key,body,options);
    };
    const stale=getFutuAccess(env,async()=>rejected?Response.json({error:'invalid_grant'},{status:400}):Response.json(tokenPayload({access_token:'stale-renewal'})),NOW);
    await atWrite.promise;
    const other={...env,BUCKET:{get:bucket.get.bind(bucket),put:bucket.put.bind(bucket),delete:bucket.delete.bind(bucket)}};
    assert.equal((await finishFutuConnection(session.callback,other,consent.fetcher,NOW+50000)).connected,true);
    releaseWrite.resolve();await assert.rejects(stale,{code:'CONNECTION_CHANGED'});
    const saved=await createPrivateStore(env).getSecret(keyName);
    assert.equal(saved.accessToken,'new-consent-after-lease');assert.equal(saved.reauthorizationRequired,false);
    assert.equal(saved.authorizedAt,NOW+50000);
  }
});

test('an expired-lease consent callback cannot overwrite a later completed consent',async()=>{
  const env=environment();await expiring(env);
  const earlyMock=oauthMock({token:tokenPayload({access_token:'stale-consent'})}),lateMock=oauthMock({token:tokenPayload({access_token:'latest-consent'})});
  const early=await pending(env,earlyMock.fetcher,NOW+1),late=await pending(env,lateMock.fetcher,NOW+2);
  const bucket=env.BUCKET,atomicPut=bucket.put.bind(bucket),atWrite=deferred(),releaseWrite=deferred();let intercepted=false;
  bucket.put=async(key,body,options)=>{
    if(!intercepted&&key==='gamma-watch/v1/'+keyName&&options?.onlyIf?.etagMatches){intercepted=true;atWrite.resolve();await releaseWrite.promise;}
    return atomicPut(key,body,options);
  };
  const stale=finishFutuConnection(early.callback,env,earlyMock.fetcher,NOW+3);await atWrite.promise;
  const other={...env,BUCKET:{get:bucket.get.bind(bucket),put:bucket.put.bind(bucket),delete:bucket.delete.bind(bucket)}};
  await finishFutuConnection(late.callback,other,lateMock.fetcher,NOW+50000);
  releaseWrite.resolve();await assert.rejects(stale,{code:'CONNECTION_CHANGED'});
  const saved=await createPrivateStore(env).getSecret(keyName);
  assert.equal(saved.accessToken,'latest-consent');assert.equal(saved.authorizedAt,NOW+50000);
});
