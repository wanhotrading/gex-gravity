import test from 'node:test';
import assert from 'node:assert/strict';
import { createFutuQuoteClient, collectFutuMarket, discoverFutures, selectActiveFuture, fetchListedOptionChains,
  fetchOptionChainRange, normalizeOptionMetadata, normalizeOptionSnapshot, reconcileSnapshots, safeFutuError } from '../lib/futu-client.mjs';

const NOW = Date.parse('2026-11-04T15:00:00Z');
const grant = { accessToken: 'private-test-token', scope: 'quote:read accid:1 accid:2 accid:3' };
const rawMeta = (i = 0, extra = {}) => ({ code: `US.Q1C2611${i % 2 ? 'P' : 'C'}${20000 + i}x0`,
  stock_owner: 'US.NQ2612', stock_type: 'DRVT', strike_price: 20000 + i,
  option_type: i % 2 ? 'PUT' : 'CALL', strike_time: '2026-11-04', expiration_cycle: 'WEEKWED', ...extra });
const meta = (i = 0) => normalizeOptionMetadata(rawMeta(i), 'US.NQ2612');
const snapshot = (metadata = meta(), extra = {}) => ({ code: metadata.code, option_valid: true,
  option_strike_price: metadata.strike, option_implied_volatility: 20, gamma: 0.002, delta: 0.5,
  option_open_interest: 100, option_contract_multiplier: 20, bid_price: 10, ask_price: 11,
  last_price: 10.5, update_time: NOW, ...extra });
const future = { code: 'US.NQ2612', future_valid: true, last_price: 20000, update_time: NOW };
const reply = data => new Response(JSON.stringify({ ret_code: 0, data }), { headers: { 'content-type': 'application/json' } });
function mockClient(responder) {
  let clock = NOW; const calls = [];
  const client = createFutuQuoteClient({ getAccessToken: async () => grant, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options, time: clock }); return responder(url, options);
    } });
  return { client, calls };
}

test('only quote routes are called, lowercase native symbols retained, multi-account quote grant accepted', async () => {
  const { client, calls } = mockClient(() => reply({ snapshot_list: [] }));
  await Promise.all([client.snapshots(['US.Q1C2611C20000x0']), client.snapshots(['US.NQ2612'])]);
  assert.equal(calls[0].url.origin, 'https://webapi.futunn.com');
  assert.equal(calls[0].url.pathname, '/api/v1.0/quote/snapshot');
  assert.deepEqual(JSON.parse(calls[0].options.body), { code_list: ['US.Q1C2611C20000x0'] });
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.authorization, 'Bearer private-test-token');
  assert.ok(calls[1].time - calls[0].time >= 650);
  await assert.rejects(client.optionChain('US.NQ2612/../trade', '2026-11-04', '2026-11-04'), { code: 'INVALID_SYMBOL' });
  await assert.rejects(client.snapshots(Array.from({ length: 401 }, (_, i) => `US.O${i}`)), { code: 'INVALID_BATCH' });
  assert.equal(calls.length, 2);
});

test('resumed clients honor the prior request boundary and yield at their bounded deadline',async()=>{
  let clock=NOW,calls=0;
  const client=createFutuQuoteClient({getAccessToken:()=>grant,now:()=>clock,notBeforeMs:NOW+650,deadlineAtMs:NOW+1000,
    sleep:async ms=>{clock+=ms;},fetchImpl:async()=>{calls++;return reply({snapshot_list:[]});}});
  await client.snapshots(['US.NQ2612']);assert.equal(clock,NOW+650);assert.equal(calls,1);
  await assert.rejects(client.snapshots(['US.NQ2612']),{code:'COLLECTION_STEP_YIELD'});assert.equal(calls,1);
});

test('trading, wildcard and unknown token scopes fail before any request', async () => {
  for (const scope of ['quote:read trade:read', 'quote:read accid:*', 'quote:read unknown:x', 'quote:write']) {
    let called = false;
    const client = createFutuQuoteClient({ getAccessToken: () => ({ ...grant, scope }), fetchImpl: async () => { called = true; } });
    await assert.rejects(client.snapshots(['US.NQ2612']), { code: 'QUOTE_SCOPE_REQUIRED' });
    assert.equal(called, false);
  }
});

test('provider and network errors never expose tokens or raw response messages', async () => {
  const { client } = mockClient(() => new Response(JSON.stringify({ ret_code: -4, ret_msg: grant.accessToken })));
  await assert.rejects(client.snapshots(['US.NQ2612']), error => {
    assert.equal(error.code, 'FUTU_API_ERROR'); assert.ok(!JSON.stringify(safeFutuError(error)).includes(grant.accessToken)); return true;
  });
  const broken = createFutuQuoteClient({ getAccessToken: () => grant, fetchImpl: async () => { throw Error(grant.accessToken); } });
  await assert.rejects(broken.snapshots(['US.NQ2612']), error => !error.message.includes(grant.accessToken));
});

test('safe provider diagnostics include only a numeric return code and fixed quote path template', async () => {
  const { client } = mockClient(() => new Response(JSON.stringify({ ret_code: -9, ret_msg: grant.accessToken, error_description: grant.accessToken })));
  await assert.rejects(client.optionChain('US.NQ2612', '2026-11-04', '2026-11-04'), error => {
    const safe = safeFutuError(error);
    assert.equal(safe.providerRetCode, -9); assert.equal(safe.stage, 'option-chain');
    assert.equal(safe.path, '/api/v1.0/quote/{symbol}/option-chain');
    assert.ok(!JSON.stringify(safe).includes(grant.accessToken)); return true;
  });
  const malformed = mockClient(() => new Response(JSON.stringify({ ret_code: grant.accessToken, ret_msg: grant.accessToken })));
  await assert.rejects(malformed.client.snapshots(['US.NQ2612']), error => {
    const safe = safeFutuError(error); assert.equal('providerRetCode' in safe, false);
    assert.equal(safe.stage, 'snapshot'); assert.equal(safe.path, '/api/v1.0/quote/snapshot');
    assert.ok(!JSON.stringify(safe).includes(grant.accessToken)); return true;
  });
});

test('permission failures are recognizable without echoing upstream details', async () => {
  for (const response of [new Response(grant.accessToken, { status: 403 }), new Response(JSON.stringify({ ret_code: -9, ret_msg: grant.accessToken }))]) {
    const { client } = mockClient(() => response);
    await assert.rejects(client.snapshots(['US.NQ2612']), { code: 'FUTU_PERMISSION_REQUIRED' });
  }
});

test('IV percent conversion, genuine reported zeros and missing fields stay distinct', () => {
  const record = normalizeOptionSnapshot(meta(), snapshot(meta(), { gamma: 0, delta: 0, option_open_interest: 0 }), { now: NOW });
  assert.equal(record.iv, 0.2); assert.equal(record.gamma, 0); assert.equal(record.openInterest, 0);
  assert.equal(record.evidence.gamma, 'reported-zero'); assert.equal(record.usableForGex, true);
  assert.equal(record.exactExpiry, null); assert.equal(record.usableForScenario, false);
  assert.equal(record.greeksAsOf, null); assert.equal(record.oiAsOf, null);
  const raw = snapshot(); delete raw.option_open_interest;
  const missing = normalizeOptionSnapshot(meta(), raw, { now: NOW });
  assert.equal(missing.openInterest, null); assert.equal(missing.evidence.option_open_interest, 'missing');
  assert.equal(missing.usableForGex, false);
  const unavailable = normalizeOptionSnapshot(meta(), snapshot(meta(), { option_valid: false, gamma: 0, option_open_interest: 0 }), { now: NOW });
  assert.equal(unavailable.gamma, null); assert.equal(unavailable.openInterest, null);
  assert.equal(unavailable.evidence.gamma, 'category-unavailable');
});

test('zero IV, stale/future timestamps and conflicting strikes do not support scenarios', () => {
  const zero = normalizeOptionSnapshot(meta(), snapshot(meta(), { option_implied_volatility: 0 }), { now: NOW });
  assert.equal(zero.iv, null); assert.ok(zero.issues.includes('zero-iv-unusable'));
  const stale = normalizeOptionSnapshot(meta(), snapshot(meta(), { update_time: NOW - 21 * 60000 }), { now: NOW });
  assert.equal(stale.quoteTimeStatus, 'stale'); assert.equal(stale.usableForGex, false);
  const futureTime = normalizeOptionSnapshot(meta(), snapshot(meta(), { update_time: NOW + 120000 }), { now: NOW });
  assert.equal(futureTime.quoteTimeStatus, 'future'); assert.equal(futureTime.usableForGex, false);
  const mismatch = normalizeOptionSnapshot(meta(), snapshot(meta(), { option_strike_price: 9999 }), { now: NOW });
  assert.equal(mismatch.gamma, null); assert.equal(mismatch.usableForGex, false);
});

test('metadata preserves provider owner/expiry without decoding the option code', () => {
  const record = normalizeOptionMetadata(rawMeta(), 'US.NQ2612');
  assert.equal(record.underlyingCode, 'US.NQ2612'); assert.equal(record.expiryDate, '2026-11-04');
  assert.equal(normalizeOptionMetadata(rawMeta(0, { stock_owner: 'US.NQ2703' }), 'US.NQ2612'), null);
  assert.equal(normalizeOptionMetadata(rawMeta(0, { strike_time: '2026-02-30' }), 'US.NQ2612'), null);
});

test('missing, unexpected and duplicate snapshot codes remain explicit', () => {
  const result = reconcileSnapshots(['US.A', 'US.B'], [{ code: 'US.A' }, { code: 'US.A' }, { code: 'US.C' }]);
  assert.equal(result.matched.size, 0); assert.deepEqual(result.missingCodes, ['US.A', 'US.B']);
  assert.deepEqual(result.duplicateCodes, ['US.A']); assert.deepEqual(result.unexpectedCodes, ['US.C']);
  assert.equal(result.complete, false);
});

test('calendar windows prevent loss from the maximum 20 expiry dates per chain response', async () => {
  const windows = [];
  const result = await fetchOptionChainRange({ optionChain: async (code, start, end) => { windows.push({ code, start, end }); return []; } }, 'US.NQ2612', '2026-11-01', '2026-12-15');
  assert.deepEqual(windows.map(row => [row.start, row.end]), [
    ['2026-11-01', '2026-11-14'], ['2026-11-15', '2026-11-28'], ['2026-11-29', '2026-12-12'], ['2026-12-13', '2026-12-15']]);
  assert.equal(result.windows.length, 4);
});

test('expiry list budget exposes omitted expiries and never claims all-market coverage', async () => {
  const expiryCalls = [];
  const fake = { optionExpirations: async () => [
    { strike_time: '2026-11-04' }, { strike_time: '2026-11-05' }, { strike_time: '2026-11-06' }, { strike_time: 'invalid' }],
  optionChain: async (code, start) => { expiryCalls.push(start); return [rawMeta(0, { strike_time: start })]; } };
  const result = await fetchListedOptionChains(fake, 'US.NQ2612', { asOfDate: '2026-11-04', maxExpiries: 2 });
  assert.deepEqual(expiryCalls, ['2026-11-04', '2026-11-05']);
  assert.deepEqual(result.expiryCoverage.missingDates, ['2026-11-06']);
  assert.equal(result.expiryCoverage.completeListedExpiries, false);
  assert.equal(result.expiryCoverage.allMarketExpiries, false); assert.equal(result.expiryCoverage.rejectedExpiryRows, 1);
});

test('CL contract discovery uses provider catalog and never infers wall-clock month', async () => {
  const fake = { referenceFutures: async code => {
    assert.equal(code, 'US.CLmain'); return [
      { code: 'US.CLmain', future_valid: true, future_main_contract: true },
      { code: 'US.CL2701', future_valid: true, future_main_contract: false }];
  }, futureInfo: async codes => { assert.deepEqual(codes, ['US.CL2701']);
    return [{ code: 'US.CL2701', size: 1000, exchange: 'NYMEX', last_trade_time: NOW + 5 * 86400000 }]; } };
  const result = await discoverFutures(fake, 'CL', { now: NOW });
  assert.equal(result.selectionRequired, true); assert.equal(result.contracts[0].code, 'US.CL2701');
  assert.equal(result.contracts[0].contractMultiplier, 1000); assert.equal(result.contracts[0].expired, false);
});

test('active futures selection uses verified reported volume and rejects an equal-volume guess', async () => {
  let tied = false;
  const fake = { referenceFutures: async () => ['US.CL2612', 'US.CL2701'].map(code => ({ code, future_valid: true, future_main_contract: false })),
    futureInfo: async codes => codes.map((code, i) => ({ code, exchange: 'NYMEX', size: 1000, last_trade_time: NOW + (i + 1) * 86400000 })),
    snapshots: async codes => codes.map((code, i) => ({ code, future_valid: true, last_price: 70, update_time: NOW, volume: tied ? 500 : i ? 1000 : 500 })) };
  const selected = await selectActiveFuture(fake, 'CL', { now: NOW });
  assert.equal(selected.selectedCode, 'US.CL2701'); assert.equal(selected.candidates.length, 2);
  assert.match(selected.selectionBasis, /not a continuous-alias mapping/);
  tied = true; const ambiguous = await selectActiveFuture(fake, 'CL', { now: NOW });
  assert.equal(ambiguous.selectedCode, null); assert.equal(ambiguous.selectionIssue, 'equal-volume-candidates');
});

test('collector stops after small probe when native Greek fields are absent', async () => {
  const calls = []; const metadata = Array.from({ length: 40 }, (_, i) => rawMeta(i));
  const fake = { optionChain: async () => { calls.push('metadata'); return metadata; },
    snapshots: async codes => { calls.push(codes); return codes.includes(future.code) ? [future] : []; } };
  const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', now: NOW });
  assert.equal(calls.length, 2); assert.equal(calls[0], 'metadata'); assert.equal(calls[1].length, 5);
  assert.equal(result.status, 'probe-fields-unavailable'); assert.equal(result.coverage.expected, 40);
  assert.equal(result.coverage.requested, 4); assert.equal(result.coverage.usableGexContracts, 0);
  assert.equal(result.coverage.fullChain, false); assert.equal(result.options.length, 40);
});

test('collector retrieves full chain in at most 400-code batches after successful probe', async () => {
  const raw = Array.from({ length: 405 }, (_, i) => rawMeta(i));
  const normalized = new Map(raw.map(row => { const n = normalizeOptionMetadata(row, 'US.NQ2612'); return [n.code, n]; }));
  const batches = [];
  const fake = { optionChain: async () => raw, snapshots: async codes => {
    batches.push(codes); return codes.map(code => code === future.code ? future : snapshot(normalized.get(code))); } };
  const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', now: NOW });
  assert.deepEqual(batches.map(batch => batch.length), [5, 400, 1]);
  assert.equal(result.coverage.fullChain, true); assert.equal(result.coverage.usableGexContracts, 405);
  assert.equal(result.status, 'complete-range-snapshot'); assert.equal(result.sourceStatus, 'snapshot');
  assert.equal(result.underlying.futuresPrice, 20000); assert.equal(result.exactExpiryAvailable, false);
});

test('delayed option timestamps permit full retrieval while remaining stale and partial', async () => {
  const raw = Array.from({ length: 405 }, (_, i) => rawMeta(i));
  const normalized = new Map(raw.map(row => { const n = normalizeOptionMetadata(row, 'US.NQ2612'); return [n.code, n]; }));
  const batches = [], delayed = NOW - 35 * 60000;
  const fake = { optionChain: async () => raw, snapshots: async codes => {
    batches.push(codes); return codes.map(code => code === future.code ? { ...future, update_time: delayed }
      : snapshot(normalized.get(code), { update_time: delayed })); } };
  const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', now: NOW });
  assert.deepEqual(batches.map(batch => batch.length), [5, 400, 1]);
  assert.equal(result.probe.supportsRequiredFields, true); assert.equal(result.coverage.returned, 405);
  assert.equal(result.coverage.requested, 405); assert.equal(result.coverage.usableGexContracts, 0);
  assert.equal(result.status, 'partial-snapshot'); assert.equal(result.coverage.fullChain, false);
  assert.equal(result.underlying.quoteTimeStatus, 'stale'); assert.equal(result.options[0].quoteTimeStatus, 'stale');
  assert.equal(result.options[0].quoteAsOf, new Date(delayed).toISOString());
  assert.equal(result.options[0].gamma, 0.002); assert.equal(result.options[0].iv, 0.2);
  assert.equal(result.sourceStatus, 'snapshot'); assert.equal(result.options[0].delayStatus, 'unverified');
});

test('missing quote timestamps establish fields but never fresh data; future timestamps fail probe', async () => {
  for (const update_time of [undefined, NOW + 120000]) {
    const raw = Array.from({ length: 6 }, (_, i) => rawMeta(i)); let count = 0;
    const normalized = new Map(raw.map(row => { const n = normalizeOptionMetadata(row, 'US.NQ2612'); return [n.code, n]; }));
    const fake = { optionChain: async () => raw, snapshots: async codes => { count++;
      return codes.map(code => code === future.code ? future : snapshot(normalized.get(code), { update_time })); } };
    const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', now: NOW });
    assert.equal(result.coverage.usableGexContracts, 0); assert.equal(result.coverage.fullChain, false);
    if (update_time === undefined) {
      assert.equal(result.probe.supportsRequiredFields, true); assert.equal(count, 2);
      assert.equal(result.coverage.returned, 6); assert.equal(result.options[0].quoteAsOf, null);
      assert.equal(result.options[0].quoteTimeStatus, 'unavailable');
    } else {
      assert.equal(result.probe.supportsRequiredFields, false); assert.equal(count, 1);
      assert.equal(result.status, 'probe-fields-unavailable');
    }
  }
});

test('missing symbols or batch failures remain partial and credential-safe', async () => {
  const raw = Array.from({ length: 12 }, (_, i) => rawMeta(i)); let count = 0;
  const fake = { optionChain: async () => raw, snapshots: async codes => {
    count++; if (count > 1) throw Error(grant.accessToken);
    return codes.map(code => code === future.code ? future : snapshot(normalizeOptionMetadata(raw.find(row => row.code === code), 'US.NQ2612')));
  } };
  const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', now: NOW });
  assert.equal(result.coverage.fullChain, false); assert.equal(result.coverage.missingCodes.length, 8);
  assert.equal(result.errors.length, 1); assert.ok(!JSON.stringify(result).includes(grant.accessToken));
});

test('daily cached chain bypasses metadata calls without broadening requested coverage', async () => {
  const fake = { optionChain: async () => assert.fail('cached metadata should be reused'),
    snapshots: async codes => codes.map(code => code === future.code ? future : snapshot(meta())) };
  const chainData = { underlyingCode: 'US.NQ2612', rows: [rawMeta()], windows: [{ start: '2026-11-04', end: '2026-11-04', returned: 1 }] };
  const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', chainData, now: NOW });
  assert.equal(result.coverage.usableGexContracts, 1);
  await assert.rejects(collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04',
    chainData: { ...chainData, underlyingCode: 'US.ES2612' }, now: NOW }), { code: 'INVALID_METADATA_CACHE' });
});

test('complete option responses cannot conceal a missing underlying futures quote', async () => {
  const fake = { optionChain: async () => [rawMeta()], snapshots: async codes => codes.filter(code => code !== future.code).map(() => snapshot(meta())) };
  const result = await collectFutuMarket(fake, { market: 'NQ', underlyingCode: 'US.NQ2612', start: '2026-11-04', end: '2026-11-04', now: NOW });
  assert.equal(result.coverage.fullChain, false); assert.equal(result.underlying.futuresPrice, null);
  assert.equal(result.underlying.categoryVerified, false);
});
