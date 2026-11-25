import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let session = 0;
async function loadView(extra = '') {
  let source = await readFile(new URL('./market-watch.mjs', import.meta.url), 'utf8');
  for (const file of ['engine.mjs', 'hedging-engine.mjs', 'session-impact.mjs', 'session-history.mjs', 'manual-workflow.mjs','market-reading.mjs','menthorq-import.mjs']) source = source.replace('./core/' + file, new URL('../core/' + file, import.meta.url).href);
  source = source.replace('./session-impact-view.mjs', new URL('./session-impact-view.mjs', import.meta.url).href);
  source = source.replace('./level-lens-view.mjs', new URL('./level-lens-view.mjs', import.meta.url).href);
  source = source.replace('./replay-view.mjs', new URL('./replay-view.mjs', import.meta.url).href);
  source = source.replace('./iv-surface-view.mjs', new URL('./iv-surface-view.mjs', import.meta.url).href);
  return import('data:text/javascript;base64,' + Buffer.from(source + `\n// session ${session++}\n` + extra).toString('base64'));
}
const view = await loadView();
const context = { source: 'MenthorQ', status: 'stale', sourceDate: '2026-11-03', asOf: null, capturedAt: '2026-11-04T10:00:00Z', underlyingCode: 'US.NQ2612', sourceInstrument: 'NQZ2026', levels: [{ strike: 100, kind: 'option-strike', labels: ['Put Support'], gex: null }, { strike: 105, kind: 'option-strike', labels: ['Call Resistance'], gex: null }, { strike: 103.4, kind: 'reference', labels: ['1D Max'] }] };

test('only the matching MenthorQ map selects exact strikes; absent or mismatched maps do not expose the chain', () => {
  const rows = [{ code: 'a', strike: 100 }, { code: 'b', strike: 101 }, { code: 'c', strike: 105.25 }];
  assert.deepEqual(view.buildFocusedClusters(rows, null, 'US.NQ2612'), []);
  assert.deepEqual(view.buildFocusedClusters(rows, context, 'US.NQ2703'), []);
  const result = view.buildFocusedClusters(rows, context, 'US.NQ2612');
  assert.deepEqual(result.map(row => row.strike), [100, 105]);
  assert.deepEqual(result[0].rows.map(row => row.code), ['a']);
  assert.equal(result[1].rows.length, 0, 'a nearby 105.25 contract must not replace the provider 105 level');
  assert.equal(result[0].level.gex, null);
});
test('raw Greek ranges preserve zero, distinguish missing data and never combine Greeks across expiries', () => {
  assert.deepEqual(view.reportedRange([{ delta: 0 }, { delta: -.4 }, { delta: null }], 'delta', 2), { text: '-0.4–0', known: 2, total: 3, range: true });
  assert.equal(view.reportedRange([{ iv: .2 }, { iv: .4 }], 'iv', 2, 100, '%').text, '20–40%');
  assert.equal(view.reportedRange([{ gamma: null }], 'gamma').known, 0);
});
test('IV request codes exclude expired contracts while preserving same-day unresolved quote observations', () => {
  const now = Date.parse('2026-11-04T10:01:00Z');
  assert.deepEqual(view.eligibleIvCodes([{ code: 'yesterday', expiryDate: '2026-11-03' }, { code: 'expired', expiryDate: '2026-11-04', expiryTimestamp: '2026-11-04T09:00:00Z' }, { code: 'cl-unresolved', expiryDate: '2026-11-04' }, { code: 'tomorrow', expiryDate: '2026-11-05' }, { code: 'tomorrow', expiryDate: '2026-11-05' }], now), ['cl-unresolved', 'tomorrow']);
});
test('rotating IV batches retain earlier overlays with their own timestamps and discard removed or older-source rows', () => {
  const underlyingCode = 'US.NQ2612', canonical = Array.from({ length: 450 }, (_, index) => ({ code: `code${index}`, underlyingCode }));
  const observation = (row, timestamp, gamma) => ({ ...row, iv: .3, gamma, quoteTimestamp: timestamp });
  const firstTime = '2026-11-04T10:01:00Z', secondTime = '2026-11-04T10:02:00Z';
  const first = view.mergeIvObservations(null, { underlyingCode, lastSuccessAt: firstTime, rows: canonical.slice(0, 399).map(row => observation(row, firstTime, .02)) }, canonical);
  const second = view.mergeIvObservations(first, { underlyingCode, lastSuccessAt: secondTime, rows: canonical.slice(399).map(row => observation(row, secondTime, .03)) }, canonical);
  assert.equal(second.rows.length, 450);
  assert.equal(second.rows.find(row => row.code === 'code0').gamma, .02);
  assert.equal(second.rows.find(row => row.code === 'code0').quoteTimestamp, firstTime, 'a newer batch must not retimestamp an earlier observation');
  assert.equal(second.rows.find(row => row.code === 'code449').gamma, .03);
  const older = view.mergeIvObservations(second, { underlyingCode, rows: [observation(canonical[0], '2026-11-04T09:00:00Z', null)] }, canonical);
  assert.equal(older.rows.find(row => row.code === 'code0').gamma, .02);
  const changedMap = view.mergeIvObservations(second, { underlyingCode, rows: [] }, canonical.slice(399));
  assert.equal(changedMap.rows.length, 51);
  assert.equal(changedMap.rows.some(row => row.code === 'code0'), false);
});
test('only a completed response matching the exact requested batch can advance rotation', () => {
  const requested = ['a', 'b'], response = { status: 'checked', coverage: { requested: 2, returned: 2 }, rows: [{ code: 'a' }, { code: 'b' }] };
  assert.equal(view.ivBatchMatchesRequest(response, requested), true);
  assert.equal(view.ivBatchMatchesRequest({ ...response, status: 'partial' }, requested), true);
  for (const status of ['cooldown', 'waiting-for-chain-refresh', 'check-failed']) assert.equal(view.ivBatchMatchesRequest({ ...response, status }, requested), false);
  assert.equal(view.ivBatchMatchesRequest({ ...response, rows: [{ code: 'c' }, { code: 'd' }] }, requested), false);
  assert.equal(view.ivBatchMatchesRequest({ ...response, coverage: { requested: 1 } }, requested), false);
});
test('default series prioritizes verified point value, valid IV and then the earliest expiry', () => {
  const rows = [{ code: 'unverified', iv: .3, expiryDate: '2026-11-04' }, { code: 'no-iv', multiplier: 20, multiplierBasis: 'cme-verified-point-value', iv: null, expiryDate: '2026-11-04' }, { code: 'later', multiplier: 20, multiplierBasis: 'cme-verified-point-value', iv: .3, expiryDate: '2026-11-06' }, { code: 'preferred', multiplier: 20, multiplierBasis: 'cme-verified-point-value', iv: .3, expiryDate: '2026-11-05' }];
  assert.equal(view.preferredSeries(rows).code, 'preferred');
  assert.equal(rows[0].code, 'unverified', 'the source row order is preserved');
});

const settle = () => new Promise(resolve => setImmediate(resolve));
async function setup({ price = 101, nullGreeks = false, ivQuoteOffsetMs = 0, historyReturnCode = null, historyRefreshStatuses = [] } = {}) {
  const original = { now: Date.now, fetch: globalThis.fetch, interval: globalThis.setInterval, document: globalThis.document, window: globalThis.window };
  const now = { value: Date.parse('2026-11-04T10:01:00Z') }, requests = [], events = {};
  class Element {
    constructor() { this.value = ''; this.hidden = false; this.attrs = {}; this.dataset = {}; this.events = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { (this.events[type] ??= []).push(fn); }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    focus() {}
  }
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8'), elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const tabs = ['NQ', 'ES', 'CL'].map(market => { const element = new Element(); element.dataset.watchMarket = market; return element; });
  globalThis.document = { hidden: false, getElementById: id => elements.get(id), addEventListener: (type, fn) => { events[type] = fn; }, querySelectorAll: () => tabs, querySelector: selector => selector === '.workspace-switch' || selector === '.watch-market-tabs' ? new Element() : tabs.find(tab => selector.includes('"' + tab.dataset.watchMarket + '"')) };
  globalThis.window = { location: { search: '', pathname: '/', hash: '' }, history: { replaceState() {} } };
  let tick; globalThis.setInterval = fn => { tick = fn; return 0; }; Date.now = () => now.value;
  const contract = (code, strike, optionType, iv) => ({ code, strike, optionType, iv, delta: .5, gamma: .01, openInterest: 10, underlyingCode: 'US.NQ2612', expiryDate: '2026-11-04', expiryTimestamp: '2026-11-04T21:00:00Z', exerciseStyle: 'european', multiplier: 20, multiplierBasis: 'cme-verified-point-value', quoteTimestamp: '2026-11-04T10:00:00Z', quality: { greeksBasis: 'futures-price' } });
  const remote = { serverTime: new Date(now.value).toISOString(), connection: { connected: true }, lastAttemptAt: '2026-11-04T10:00:00Z', markets: { NQ: { market: 'NQ', underlyingCode: 'US.NQ2612', underlyingPrice: price, priceTimestamp: '2026-11-04T10:00:00Z', collectedAt: '2026-11-04T10:00:00Z', currency: 'USD', hedgeMultiplier: 20, tickSize: .25, watchContext: structuredClone(context), contracts: [contract('call100', 100, 'CALL', .2), contract('put100', 100, 'PUT', .22), contract('hidden101', 101, 'CALL', .3)] }, ES: { underlyingCode: 'US.ES2612', underlyingPrice: 7650, contracts: [] }, CL: { underlyingCode: 'US.CL2612', underlyingPrice: 95, contracts: [] } } };
  let ivPosts = 0, failFullSnapshot = false;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/market-state?view=summary') {
      const markets = Object.fromEntries(Object.entries(remote.markets).map(([market, snapshot]) =>
        [market, { ...snapshot, contractCount: snapshot.contracts.length, contracts: [] }]));
      return Response.json({ ...remote, markets, serverTime: new Date(now.value).toISOString() });
    }
    if (url === '/api/market-state' && failFullSnapshot) return new Response(null, { status: 503 });
    if (url.startsWith('/api/session-history?') || url === '/api/session-history-refresh') {
      const requested = options.body ? JSON.parse(options.body).underlyingCode : new URL(url, 'https://gamma.test').searchParams.get('underlyingCode');
      const underlyingCode = historyReturnCode ?? requested;
      const status = url === '/api/session-history-refresh' ? historyRefreshStatuses.shift() ?? 'ready' : 'ready';
      return Response.json({ underlyingCode, status, progress: { done: true }, profile: { underlyingCode, asOf: new Date(now.value).toISOString(), volumeUnit: 'contracts', observedBars: 240, windows: [{ id: 'opening', label: '09:30–10:00', sampleCount: 12, medianVolumeContracts: 1000, medianVolatilityPoints: 2, medianRangePoints: 4 }] } });
    }
    if (url === '/api/watch-context' && options.method === 'POST') {
      const body = JSON.parse(options.body); remote.markets.NQ.watchContext = { ...remote.markets.NQ.watchContext, sourceDate: body.sourceDate ?? body.context?.sourceDate, mode: body.mode ?? body.context?.mode };
      return Response.json({ context: remote.markets.NQ.watchContext });
    }
    if (url.startsWith('/api/iv-state')) return Response.json({ underlyingCode: 'US.NQ2612', rows: [] });
    if (url === '/api/iv-refresh') {
      ivPosts++; const time = new Date(now.value + ivQuoteOffsetMs).toISOString();
      return Response.json({ market: 'NQ', underlyingCode: 'US.NQ2612', underlyingPrice: price, priceTimestamp: time, lastSuccessAt: time, rows: [{ code: 'call100', underlyingCode: 'US.NQ2612', strike: 100, optionType: 'CALL', expiryDate: '2026-11-04', iv: .25, delta: nullGreeks ? null : .51, gamma: nullGreeks ? null : .011, openInterest: nullGreeks ? null : 11, bid: null, ask: null, quoteTimestamp: time, previousIv: .2, previousQuoteTimestamp: '2026-11-04T10:00:00Z', ivChangePoints: 5, baselineChangePoints: 5, ivHistory: [{ iv: .2, quoteTimestamp: '2026-11-04T10:00:00Z' }, { iv: .25, quoteTimestamp: time }] }], coverage: { requested: 2, returned: 1 }, errors: [] });
    }
    return Response.json({ ...remote, serverTime: new Date(now.value).toISOString() });
  };
  const module = await loadView('\nexport const __state=state; export const __rows=()=>rawContracts(currentMarket()); export const __loadSessionHistory=loadSessionHistory; export const __sessionState=sessionState;'); elements.get('plan-levels').value = '28750,-107.84K'; module.initMarketWatch();
  for (let attempt = 0; attempt < 20; attempt++) await settle();
  return { requests, elements, events, now, tabs, remote, failFull: value => { failFullSnapshot = value; }, state: module.__state, sessionState: module.__sessionState, loadHistory: module.__loadSessionHistory, rows: module.__rows, tick: () => tick(), ivPosts: () => ivPosts, restore() { Date.now = original.now; globalThis.fetch = original.fetch; globalThis.setInterval = original.interval; globalThis.document = original.document; globalThis.window = original.window; } };
}
test('open dashboard applies saved MenthorQ updates independently of the full Futu download', async () => {
  const app = await setup();
  try {
    const market = app.remote.markets.NQ;
    const capturedAt = '2026-11-04T10:01:20Z';
    market.watchContextRevision = capturedAt;
    market.watchContext.netDex = { capturedAt, metric: 'Net DEX', scope: 'all-expiries', mode: 'Intraday', rows: [{ strike: 100, display: '-10K', value: -10000 }] };
    const fullRequests = () => app.requests.filter(request => request.url === '/api/market-state').length;
    const initial = fullRequests();
    app.now.value += 30000;
    await app.tick();
    assert.equal(fullRequests(), initial);
    assert.match(app.elements.get('watch-update-dex').textContent, /5:01 AM NY/);
    assert.equal(app.state.data.markets.NQ.contracts.length, 3);

    app.failFull(true);
    market.collectedAt = '2026-11-04T10:02:00Z';
    market.watchContext.sourceDate = '2026-11-04';
    market.watchContext.sourceLocalTime = '05:02';
    app.now.value += 30000;
    await app.tick();
    assert.equal(fullRequests(), initial + 1);
    assert.match(app.elements.get('watch-update-menthorq').textContent, /provider 2026-11-04 05:02/);
    assert.equal(app.state.data.markets.NQ.collectedAt, '2026-11-04T10:00:00Z');

    app.failFull(false);
    app.now.value += 30000;
    await app.tick();
    assert.equal(fullRequests(), initial + 2);
    assert.equal(app.state.data.markets.NQ.collectedAt, market.collectedAt);
  } finally { app.restore(); }
});
test('watched chain overlays timestamped IV, checks at 60 seconds only while visible, and preserves the morning plan', async () => {
  const app = await setup();
  try {
    const table = app.elements.get('watch-cluster-body').innerHTML;
    assert.match(table, /Inspect strike 100/); assert.match(table, /Inspect strike 105/); assert.doesNotMatch(table, /Inspect strike 101/);
    assert.match(table, /25%/); assert.match(table, /5 pp vs prior quote/); assert.match(table, /No exact Futu strike match/);
    assert.equal(app.elements.get('watch-context-copy').textContent, '');
    assert.equal(app.elements.get('watch-context-copy').hidden, true);
    assert.equal(app.elements.get('watch-context-status').textContent, 'Source clock unverified');
    assert.equal(app.ivPosts(), 1); assert.deepEqual(app.requests.find(request => request.url === '/api/iv-refresh').body.codes, ['call100', 'put100']);
    app.now.value += 30000; await app.tick(); assert.equal(app.ivPosts(), 1);
    document.hidden = true; app.now.value += 31000; await app.tick(); assert.equal(app.ivPosts(), 1);
    document.hidden = false; app.events.visibilitychange(); for (let attempt = 0; attempt < 20; attempt++) await settle(); assert.equal(app.ivPosts(), 2);
    assert.equal(app.elements.get('plan-levels').value, '28750,-107.84K');
  } finally { app.restore(); }
});
test('primary map import accepts copied MenthorQ text and provider date without requiring JSON', async () => {
  const app = await setup();
  try {
    app.elements.get('watch-edit-context').events.click[0]();
    assert.equal(app.elements.get('watch-context-source-date').value, '2026-11-03');
    app.elements.get('watch-context-export').value = '$NQZ2026: Put Support, 100, Call Resistance, 105';
    app.elements.get('watch-context-source-date').value = '2026-11-04';
    app.elements.get('watch-context-source-time').value = '';
    app.elements.get('watch-context-source-mode').value = 'Intraday';
    await app.elements.get('watch-context-form').events.submit[0]({ preventDefault() {} });
    const request = app.requests.find(request => request.url === '/api/watch-context');
    assert.deepEqual(request.body, { market: 'NQ', exportText: '$NQZ2026: Put Support, 100, Call Resistance, 105', sourceDate: '2026-11-04', sourceLocalTime: '', mode: 'Intraday' });
    assert.equal(app.elements.get('watch-context-error').hidden, true);
    assert.equal(app.elements.get('watch-context-editor').hidden, true);
    assert.equal(app.elements.get('plan-levels').value, '28750,-107.84K');
  } finally { app.restore(); }
});
test('the initial focus is the watched strike nearest price, and later refreshes preserve the chosen level', async () => {
  const app = await setup({ price: 104 });
  try {
    assert.equal(app.state.strike, '105', 'the nearest MenthorQ level may remain visible without an exact Futu match');
    app.state.strike = '100';
    await app.tick();
    assert.equal(app.state.strike, '100', 'an existing explicit choice is preserved when the page checks new state');
  } finally { app.restore(); }
});
test('new timestamped IV clears missing reported Greeks and OI without changing canonical contract metadata', async () => {
  const app = await setup({ nullGreeks: true });
  try {
    const row = app.rows().find(row => row.code === 'call100');
    assert.equal(row.iv, .25);
    for (const key of ['delta', 'gamma', 'openInterest', 'bid', 'ask']) assert.equal(row[key], null, `${key} must not retain an older value under the new quote timestamp`);
    assert.equal(row.quoteTimestamp, '2026-11-04T10:01:00.000Z');
    assert.equal(row.expiryTimestamp, '2026-11-04T21:00:00Z');
    assert.equal(row.exerciseStyle, 'european');
    assert.equal(row.multiplier, 20);
    assert.deepEqual(row.quality, { greeksBasis: 'futures-price' });
  } finally { app.restore(); }
  const older = await setup({ nullGreeks: true, ivQuoteOffsetMs: -120000 });
  try {
    const row = older.rows().find(row => row.code === 'call100');
    assert.equal(row.iv, .2); assert.equal(row.delta, .5); assert.equal(row.gamma, .01); assert.equal(row.openInterest, 10);
    assert.equal(row.quoteTimestamp, '2026-11-04T10:00:00Z');
  } finally { older.restore(); }
});

test('session history follows only the selected exact futures month and reuses a ready same-day profile', async () => {
  const app = await setup();
  try {
    const firstReads = app.requests.filter(request => request.url.startsWith('/api/session-history?'));
    assert.equal(firstReads.length, 1);
    assert.equal(new URL(firstReads[0].url, 'https://gamma.test').searchParams.get('underlyingCode'), 'US.NQ2612');
    assert.equal(app.sessionState.histories.get('NQ|US.NQ2612').profile.windows[0].sampleCount, 12);
    await app.loadHistory({ refresh: true });
    assert.equal(app.requests.filter(request => request.url === '/api/session-history-refresh').length, 0, 'a completed same-day profile does not start another provider backfill');
    app.tabs[1].events.click[0]();
    for (let attempt = 0; attempt < 20; attempt++) await settle();
    const reads = app.requests.filter(request => request.url.startsWith('/api/session-history?'));
    assert.deepEqual(reads.map(request => new URL(request.url, 'https://gamma.test').searchParams.get('underlyingCode')), ['US.NQ2612', 'US.ES2612']);
    await app.loadHistory({ refresh: true, force: true });
    assert.deepEqual(app.requests.filter(request => request.url === '/api/session-history-refresh').map(request => request.body), [{ market: 'ES', underlyingCode: 'US.ES2612', force: true }]);
    assert.equal(app.sessionState.histories.get('ES|US.ES2612').underlyingCode, 'US.ES2612');
  } finally { app.restore(); }
});

test('another futures month is rejected before its historical profile can enter the flow calculation', async () => {
  const app = await setup({ historyReturnCode: 'US.NQ2703' });
  try {
    assert.equal(app.sessionState.histories.has('NQ|US.NQ2612'), false);
    assert.match(app.sessionState.errors.get('NQ|US.NQ2612'), /another futures month/);
    assert.match(app.elements.get('watch-session-impact').innerHTML, /another futures month/);
    assert.equal(app.requests.filter(request => request.url === '/api/session-history-refresh').length, 0);
  } finally { app.restore(); }
});

test('hidden-page history requests stay idle while the current saved profile remains available', async () => {
  const app = await setup();
  try {
    const requestCount = app.requests.length;
    document.hidden = true;
    await app.loadHistory({ refresh: true, force: true });
    assert.equal(app.requests.length, requestCount);
    assert.equal(app.sessionState.histories.get('NQ|US.NQ2612').profile.windows[0].sampleCount, 12);
  } finally { app.restore(); }
});

test('a forced history refresh survives a busy collector and cooldown even with a prior completed profile', async () => {
  const app = await setup({ historyRefreshStatuses: ['waiting-for-chain-refresh', 'cooldown', 'history-ready'] });
  try {
    assert.equal(app.sessionState.histories.get('NQ|US.NQ2612').progress.done, true);
    await app.loadHistory({ refresh: true, force: true });
    assert.equal(app.sessionState.pendingForce.has('NQ|US.NQ2612'), true, 'the busy response must not consume the explicit refresh request');
    assert.equal(app.sessionState.histories.get('NQ|US.NQ2612').profile.windows[0].sampleCount, 12, 'prior completed observations remain visible');
    app.now.value += 30000; await app.tick();
    for (let attempt = 0; attempt < 20; attempt++) await settle();
    assert.equal(app.sessionState.pendingForce.has('NQ|US.NQ2612'), true, 'cooldown retains the force request for the next check');
    app.now.value += 30000; await app.tick();
    for (let attempt = 0; attempt < 20; attempt++) await settle();
    const posts = app.requests.filter(request => request.url === '/api/session-history-refresh');
    assert.deepEqual(posts.map(request => request.body), Array.from({ length: 3 }, () => ({ market: 'NQ', underlyingCode: 'US.NQ2612', force: true })));
    assert.equal(app.sessionState.pendingForce.has('NQ|US.NQ2612'), false, 'a successful refresh consumes the retained request');
    assert.equal(app.sessionState.histories.get('NQ|US.NQ2612').status, 'history-ready');
  } finally { app.restore(); }
});
