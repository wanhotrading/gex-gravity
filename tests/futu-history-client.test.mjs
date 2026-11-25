import test from 'node:test';
import assert from 'node:assert/strict';
import { createFutuQuoteClient, FutuQuoteError, safeFutuError } from '../lib/futu-client.mjs';

const NOW = Date.parse('2026-11-04T15:00:00Z');
const grant = { accessToken: 'private-test-token', scope: 'quote:read accid:1' };
const bar = { time_key: Date.parse('2026-11-03T14:30:00Z'), date: 20261103,
  time_zone: -300, open: 20000, high: 20005, low: 19995, close: 20001, volume: 1234 };
function harness(payload) {
  const calls = []; let clock = NOW;
  const client = createFutuQuoteClient({ getAccessToken: async () => grant, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options, time: clock });
      return new Response(JSON.stringify(typeof payload === 'function' ? payload(calls.length) : payload));
    } });
  return { client, calls };
}
const page = (extra = {}) => ({ ret_code: 0, data: { kline_list: [bar], next_time: bar.time_key - 1, volume_precision: 0 },
  pagination: { has_more: true }, ...extra });

test('futures history preserves provider fields, uses unadjusted 5-minute bars and top-level pagination', async () => {
  const { client, calls } = harness(page());
  const result = await client.historyKlinePage('US.NQ2612', { start: '2026-10-01', end: '2026-11-03' });
  const {responseShape,...observed}=result;
  assert.equal(responseShape.firstbarTimeUnit,'ms');
  assert.deepEqual(observed, { code: 'US.NQ2612', ktype: 6, bars: [bar], hasMore: true,
    nextTime: bar.time_key - 1,cursorBasis:'data-next-time', volumePrecision: 0 });
  const { url, options } = calls[0];
  assert.equal(url.origin, 'https://webapi.futunn.com');
  assert.equal(url.pathname, '/api/v1.0/quote/US.NQ2612/history-kline');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    ktype: '6', autype: '0', num: '370', start: '2026-10-01', end: '2026-11-03' });
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.authorization, `Bearer ${grant.accessToken}`);
  assert.equal(options.body, undefined);
});

test('history passes actual next_time backwards and preserves rate spacing across quote requests', async () => {
  const cursor = bar.time_key - 1;
  const { client, calls } = harness(n => n < 3 ? page({ data: { kline_list: [], next_time: cursor - n, volume_precision: 2 } })
    : { ret_code: 0, data: { snapshot_list: [] } });
  await client.historyKlinePage('US.ES2612', { start: '2026-10-01', nextTime: cursor, num: 100, ktype: 1 });
  await client.historyKlinePage('US.CL2612', { end: '2026-11-03', nextTime: cursor, ktype: 2 });
  await client.snapshots(['US.NQ2612']);
  assert.equal(calls[0].url.searchParams.get('next_time'), String(cursor));
  assert.equal(calls[0].url.searchParams.has('end'), false);
  assert.equal(calls[0].url.searchParams.get('ktype'), '1');
  assert.equal(calls[1].url.searchParams.has('end'), false);
  assert.equal(calls[1].url.searchParams.get('ktype'), '2');
  assert.ok(calls[1].time - calls[0].time >= 650);
  assert.ok(calls[2].time - calls[1].time >= 650);
});

test('terminal short and empty pages do not need a cursor; missing ordinary volume precision is zero', async () => {
  const { client } = harness({ ret_code: 0, data: { kline_list: [] }, pagination: { has_more: false } });
  const {responseShape,...observed}=await client.historyKlinePage('US.GC2612', { end: '2026-11-03' });
  assert.deepEqual(observed, {
    code: 'US.GC2612', ktype: 6, bars: [], hasMore: false, nextTime: null,cursorBasis:null, volumePrecision: 0 });
  const short = harness(page({ data: { kline_list: [bar], volume_precision: '2' }, pagination: { has_more: false } }));
  const result = await short.client.historyKlinePage('US.CL2612', { end: '2026-11-03' });
  assert.equal(result.hasMore, false); assert.equal(result.nextTime, null); assert.equal(result.volumePrecision, 2);
  assert.equal(result.bars[0].volume, 1234); // Scaling belongs to the consumer, exactly once.
});

test('history rejects continuous aliases, nonfutures, injected symbols and bad bounds before fetch', async () => {
  const { client, calls } = harness(page());
  for (const code of ['US.NQmain', 'US.ES', 'US.AAPL', 'US.NQ2612/../trade', 'https://example.com'])
    await assert.rejects(client.historyKlinePage(code, { end: '2026-11-03' }));
  for (const params of [ {}, { start: '2026-11-01' }, { end: '2026-02-30' },
    { start: '2026-11-04', end: '2026-11-03' }, { end: '2026-11-03', num: 371 },
    { end: '2026-11-03', num: 0 }, { end: '2026-11-03', num: 1.5 },
    { end: '2026-11-03', ktype: 7 }, { nextTime: 0 }, { nextTime: String(NOW) },
    { nextTime: NOW + 0.5 } ])
    await assert.rejects(client.historyKlinePage('US.NQ2612', params));
  assert.equal(calls.length, 0);
});

test('history rejects missing or misplaced pagination, excess rows, invalid scaling and stalled cursors', async () => {
  const payloads = [
    page({ pagination: undefined }), page({ pagination: { has_more: 'false' } }),
    page({ data: { kline_list: [], pagination: { has_more: false } }, pagination: undefined }),
    page({ data: { kline_list: Array.from({length:1001},()=>bar), next_time: bar.time_key - 1 } }),
    page({ data: { kline_list: [null], next_time: bar.time_key - 1 } }),
    page({ data: { kline_list: [], volume_precision: 0 } }),
    page({ data: { kline_list: [], next_time: 'invalid', volume_precision: 0 } }),
    page({ data: { kline_list: [], next_time: NOW, volume_precision: 0 } }),
    page({ data: { kline_list: [], next_time: NOW - 1, volume_precision: -1 } }),
    page({ data: { kline_list: [], next_time: NOW - 1, volume_precision: null } }),
  ];
  for (const payload of payloads) {
    const { client } = harness(payload);
    await assert.rejects(client.historyKlinePage('US.NQ2612', { nextTime: NOW, num: 1 }), { code: 'INVALID_FUTU_RESPONSE' });
  }
});

test('history errors expose only safe fixed path diagnostics and retain quote-only authorization', async () => {
  const { client } = harness({ ret_code: -9, ret_msg: grant.accessToken });
  await assert.rejects(client.historyKlinePage('US.NQ2612', { end: '2026-11-03' }), error => {
    const diagnostic = safeFutuError(error);
    assert.equal(diagnostic.code, 'FUTU_PERMISSION_REQUIRED');
    assert.equal(diagnostic.stage, 'history-kline');
    assert.equal(diagnostic.path, '/api/v1.0/quote/{symbol}/history-kline');
    assert.equal(diagnostic.providerRetCode, -9);
    assert.equal(JSON.stringify(diagnostic).includes(grant.accessToken), false); return true;
  });
  let fetched = false;
  const wrongScope = createFutuQuoteClient({ getAccessToken: () => ({ ...grant, scope: 'quote:read trade:read' }),
    fetchImpl: async () => { fetched = true; } });
  await assert.rejects(wrongScope.historyKlinePage('US.NQ2612', { end: '2026-11-03' }), { code: 'QUOTE_SCOPE_REQUIRED' });
  assert.equal(fetched, false);
});

test('invalid history includes only known response field types and bounded counts',async()=>{
  const {client}=harness(page({data:{kline_list:[{...bar,time_key:grant.accessToken}],has_more:true,pagination:{has_more:false},next_time:grant.accessToken,extra:{next_time:123}},pagination:undefined}));
  await assert.rejects(client.historyKlinePage('US.NQ2612',{end:'2026-11-03'}),error=>{
    const safe=safeFutuError(error);
    assert.deepEqual(safe.responseShape,{barsLength:1,requestedNum:370,barsType:'array',paginationType:'missing',paginationHasMoreType:'missing',paginationNextTimeType:'missing',
      dataHasMoreType:'boolean',dataPaginationHasMoreType:'boolean',nextTimeType:'string',firstbarTimeType:'string',dataExtraNextTimeType:'number',firstbarTimeUnit:'other'});
    assert.equal(safe.path,'/api/v1.0/quote/{symbol}/history-kline');assert.equal(JSON.stringify(safe).includes(grant.accessToken),false);return true;
  });
  const forged=new FutuQuoteError('INVALID_FUTU_RESPONSE','Safe fixed message.');
  forged.stage='history-kline';forged.path='/api/v1.0/quote/{symbol}/history-kline';
  forged.responseShape={barsLength:-1,requestedNum:Infinity,paginationHasMoreType:grant.accessToken,nextTimeType:'number',secret:grant.accessToken};
  assert.deepEqual(safeFutuError(forged).responseShape,{nextTimeType:'number'});
  forged.stage='snapshot';forged.path='/api/v1.0/quote/snapshot';
  assert.equal('responseShape' in safeFutuError(forged),false);
});

test('observed live 1000-bar pages infer an explicitly labeled cursor without truncating',async()=>{
  const bars=Array.from({length:1000},(_,i)=>({...bar,time_key:bar.time_key-i*300000}));
  const {client}=harness(page({data:{kline_list:bars,volume_precision:0}}));
  const result=await client.historyKlinePage('US.NQ2612',{end:'2026-11-03'});
  assert.equal(result.bars.length,1000);assert.equal(result.nextTime,bars.at(-1).time_key-1);
  assert.equal(result.cursorBasis,'oldest-bar-minus-1');assert.equal(result.responseShape.firstpositivebarGapMs,300000);
  const bad=harness(page({data:{kline_list:bars,volume_precision:0}}));
  await assert.rejects(bad.client.historyKlinePage('US.NQ2612',{nextTime:bar.time_key-1}),{code:'INVALID_FUTU_RESPONSE'});
});

test('pagination-level cursor is accepted only when valid and consistent with data cursor',async()=>{
  const cursor=bar.time_key-1;
  const {client}=harness(page({data:{kline_list:[bar]},pagination:{has_more:true,next_time:cursor}}));
  const result=await client.historyKlinePage('US.ES2612',{end:'2026-11-03'});
  assert.equal(result.nextTime,cursor);assert.equal(result.cursorBasis,'pagination-next-time');
  const bad=harness(page({pagination:{has_more:true,next_time:cursor-1}}));
  await assert.rejects(bad.client.historyKlinePage('US.ES2612',{end:'2026-11-03'}),{code:'INVALID_FUTU_RESPONSE'});
});

test('bar diagnostics retain bounded numeric quote fields and remove arbitrary text or excessive samples',()=>{
  const error=new FutuQuoteError('HISTORY_INVALID_DATA','Prior-session historical bars contain invalid prices, volume or timestamps.');
  error.stage='history-kline';error.path='/api/v1.0/quote/{symbol}/history-kline';
  const sample={...bar,authorization:grant.accessToken,privateField:grant.accessToken,open:grant.accessToken,volume:Infinity};
  error.responseShape={barDiagnostics:{reason:'normalization',badPriceCount:1,badVolumeCount:-1,oldestMs:bar.time_key,minNYDate:'2026-11-03',maxNYDate:grant.accessToken,
    arbitraryField:grant.accessToken,samples:{first:[sample,sample,sample],last:[sample,sample,sample],offending:[sample,sample,sample],secret:[sample]}}};
  const safe=safeFutuError(error),diagnostics=safe.responseShape.barDiagnostics;
  assert.equal(diagnostics.reason,'normalization');assert.equal(diagnostics.badPriceCount,1);assert.equal(diagnostics.oldestMs,bar.time_key);
  assert.equal('badVolumeCount' in diagnostics,false);assert.equal('maxNYDate' in diagnostics,false);assert.equal('arbitraryField' in diagnostics,false);
  assert.deepEqual(Object.keys(diagnostics.samples),['first','last','offending']);assert.ok(Object.values(diagnostics.samples).every(rows=>rows.length===2));
  assert.equal('open' in diagnostics.samples.first[0],false);assert.equal('volume' in diagnostics.samples.first[0],false);
  assert.equal(JSON.stringify(safe).includes(grant.accessToken),false);
});
