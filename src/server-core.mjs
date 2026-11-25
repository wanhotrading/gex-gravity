import {handleMarketRoute,handleWatchMcp} from './market-service.mjs';
import {handleBackupRoute} from './backup-service.mjs';
import {handleReplayRoute} from './replay-service.mjs';
const MARKETS = new Set(['NQ', 'ES', 'CL', 'GC']);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LEVELS = 10000;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const zoned = x => typeof x === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(x) && Number.isFinite(Date.parse(x));

export function validateSnapshot(raw, requestedMarket, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Feed must return a snapshot object.');
  if (raw.schemaVersion !== 1) throw Error('Unsupported feed schema version.');
  if (!MARKETS.has(raw.market) || raw.market !== requestedMarket) throw Error('Feed returned a different market.');
  if (!finite(raw.futuresPrice) || raw.futuresPrice <= 0) throw Error('Invalid underlying futures price.');
  if (!zoned(raw.asOf) || Date.parse(raw.asOf) > now + 60000) throw Error('Invalid source timestamp.');
  if (typeof raw.contract !== 'string' || !raw.contract.trim() || raw.contract.length > 120) throw Error('Exact underlying contract is required.');
  if (!raw.source || typeof raw.source.provider !== 'string' || raw.source.provider.length > 120) throw Error('Source provider is required.');
  if (!['live', 'delayed', 'frozen', 'stale', 'snapshot'].includes(raw.source.status)) throw Error('Feed must identify its actual data type.');
  if (raw.source.status === 'delayed' && (!finite(raw.source.delaySeconds) || raw.source.delaySeconds <= 0)) throw Error('Delayed data needs its delay in seconds.');
  if (typeof raw.gexUnit !== 'string' || !raw.gexUnit.trim() || raw.gexUnit.length > 100) throw Error('GEX units are required.');
  if (!Array.isArray(raw.levels) || !raw.levels.length || raw.levels.length > MAX_LEVELS) throw Error('Invalid number of levels.');
  if (raw.rate !== undefined && !finite(raw.rate)) throw Error('Invalid interest rate.');
  const levels = raw.levels.map((row, i) => {
    if (!row || !finite(row.strike) || row.strike <= 0 || !finite(row.gex)) throw Error(`Invalid strike or GEX at level ${i + 1}.`);
    const iv = row.iv ?? null;
    if (iv !== null && (!finite(iv) || iv <= 0 || iv > 10)) throw Error(`Invalid decimal IV at level ${i + 1}.`);
    const expiry = row.expiry ?? raw.expiry ?? null;
    if (expiry !== null && !zoned(expiry)) throw Error(`Invalid option expiry at level ${i + 1}.`);
    const exerciseStyle = row.exerciseStyle ?? raw.exerciseStyle ?? null;
    if (exerciseStyle !== null && !['european', 'american'].includes(exerciseStyle)) throw Error(`Invalid exercise style at level ${i + 1}.`);
    const basis = row.modelBasis ?? raw.modelBasis ?? null;
    if (basis !== null && !['single-series', 'aggregate'].includes(basis)) throw Error(`Invalid model basis at level ${i + 1}.`);
    for (const key of ['optionMultiplier', 'hedgeMultiplier']) {
      if (row[key] !== undefined && (!finite(row[key]) || row[key] <= 0)) throw Error(`Invalid ${key}.`);
    }
    return { strike: row.strike, gex: row.gex, iv, expiry, exerciseStyle,
      modelBasis: basis,
      optionType: ['put', 'call'].includes(row.optionType) ? row.optionType : null,
      dealerSide: ['short', 'long'].includes(row.dealerSide) ? row.dealerSide : 'unknown',
      allowEuropeanApproximation: row.allowEuropeanApproximation === true,
      ...(row.optionMultiplier !== undefined ? { optionMultiplier: row.optionMultiplier } : {}),
      ...(row.hedgeMultiplier !== undefined ? { hedgeMultiplier: row.hedgeMultiplier } : {}),
    };
  });
  // Preserve a source's delayed/frozen classification. Never turn old quotes live.
  const source = {provider: raw.source.provider, status: raw.source.status,
    delaySeconds: finite(raw.source.delaySeconds) ? raw.source.delaySeconds : null};
  if (source.status === 'live' && now - Date.parse(raw.asOf) > 120000) source.status = 'stale';
  return {schemaVersion: 1, market: raw.market, contract: raw.contract,
    futuresPrice: raw.futuresPrice, asOf: new Date(raw.asOf).toISOString(), source,
    gexUnit: raw.gexUnit, rate: raw.rate ?? 0, levels,
    positionMethod: typeof raw.positionMethod === 'string' ? raw.positionMethod.slice(0, 1000) : 'Provider estimate; dealer inventory not independently verified.'};
}

export async function readBoundedJson(response, limit = MAX_BYTES) {
  const statedSize = Number(response.headers.get('content-length'));
  if (statedSize > limit) throw Error('Feed snapshot is too large.');
  if (!response.body) throw Error('Feed returned no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Error('Feed snapshot is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(merged));
}

function feedConfig(env) {
  if (!env.GAMMA_FEED_URL) return null;
  const url = new URL(env.GAMMA_FEED_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('The configured feed needs a credential-free HTTPS URL.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) throw Error('The feed must use a public HTTPS hostname.');
  return {url, provider: String(env.GAMMA_FEED_PROVIDER || 'Licensed snapshot feed')};
}

const baseHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: {...baseHeaders,
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});
}

export function createHandler(assets, fetcher = fetch) {
  return {async fetch(request, env = {}, ctx) {
    void ctx;
    const url = new URL(request.url);
    if(url.pathname.startsWith('/api/backups'))return await handleBackupRoute(request,env)??json({error:'Not found.'},404);
    if(url.pathname.startsWith('/api/replay'))return await handleReplayRoute(request,env)??json({error:'Not found.'},404);
    if (url.pathname === '/mcp') return handleWatchMcp(request,env,fetcher);
    if (['/api/market-state','/api/recover-market-snapshot','/api/futu/status','/api/futu/connect','/api/futu/callback','/api/refresh','/api/watch-settings','/api/watch-context','/api/iv-state','/api/iv-refresh','/api/session-history','/api/session-history-refresh','/api/collector-status'].includes(url.pathname)) {
      const response=await handleMarketRoute(request,env,ctx,fetcher);
      return response??json({error:'Method not allowed.'},405);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({error: 'Read-only service.'}, 405);
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'HEAD') return new Response(null, {status: 405, headers: baseHeaders});
      if (url.pathname === '/api/status') {
        try {
          const config = feedConfig(env);
          return json({configured: !!config, provider: config?.provider ?? null,
            message: config ? 'An entitled feed is configured. Quote freshness is checked on each snapshot.'
              : 'No live feed is connected. Choose a licensed provider before activating live tracking.',
            supportedMarkets: [...MARKETS], refreshSeconds: 60});
        } catch {return json({configured: false, provider: null, message: 'Feed configuration needs attention.'}, 503);}
      }
      if (url.pathname === '/api/snapshot') {
        const market = url.searchParams.get('market') || 'NQ';
        if (!MARKETS.has(market)) return json({error: 'Choose NQ, ES, CL or GC.'}, 400);
        let config;
        try {config = feedConfig(env);} catch {return json({error: 'Feed configuration needs attention.'}, 503);}
        if (!config) return json({error: 'Live data is not connected. No subscriptions have been purchased.', code: 'FEED_NOT_CONFIGURED'}, 503);
        const target = new URL(config.url);
        target.searchParams.set('market', market);
        const headers = {accept: 'application/json'};
        if (env.GAMMA_FEED_TOKEN) headers.authorization = `Bearer ${env.GAMMA_FEED_TOKEN}`;
        try {
          const response = await fetcher(target.toString(), {headers, redirect: 'manual', signal: AbortSignal.timeout(10000)});
          if (!response.ok) return json({error: 'The licensed feed did not return a snapshot. Check its entitlement or availability.', code: 'UPSTREAM_UNAVAILABLE'}, 502);
          const raw = await readBoundedJson(response);
          return json(validateSnapshot(raw, market));
        } catch (error) {
          console.error(JSON.stringify({event: 'snapshot_failed', market, kind: error?.name || 'Error'}));
          return json({error: 'The feed returned an invalid snapshot or did not respond in time.', code: 'INVALID_SNAPSHOT'}, 502);
        }
      }
      return json({error: 'Not found.'}, 404);
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = assets[path];
    if (!asset) return new Response('Not found', {status: 404, headers: baseHeaders});
    const headers = {...baseHeaders, 'content-type': asset.type, 'cache-control': 'no-cache'};
    if (path.endsWith('.html')) headers['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
    if(asset.base64)headers['cache-control']='private, max-age=86400';
    return new Response(request.method === 'HEAD' ? null : asset.base64 ? Uint8Array.from(atob(asset.base64),char=>char.charCodeAt(0)) : asset.body, {headers});
  }};
}
