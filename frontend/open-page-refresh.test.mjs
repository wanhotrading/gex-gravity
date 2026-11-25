import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

let session = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));
async function setup({ lastAttemptAt, inProgress = false, pending = false, pendingState = false, pendingConnection = false, stateError = false, connectionError = false, actionError = null, connection = { connected: true }, statusConnection = connection, markets, saveMap } = {}) {
  const original = { now: Date.now, fetch: globalThis.fetch, interval: globalThis.setInterval, document: globalThis.document, window: globalThis.window };
  const clock = { now: Date.parse('2026-11-04T10:01:00Z') }, requests = [], events = {};
  class Element {
    constructor() { this.value = ''; this.hidden = false; this.attrs = {}; this.dataset = {}; this.events = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { (this.events[type] ??= []).push(fn); }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    closest() { return this.parent ??= new Element(); }
    focus() {}
  }
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const tabs = ['NQ', 'ES', 'CL'].map(market => { const element = new Element(); element.dataset.watchMarket = market; return element; });
  globalThis.document = { hidden: false, getElementById: id => elements.get(id), addEventListener: (type, fn) => { events[type] = fn; },
    querySelectorAll: () => tabs, querySelector: selector => ['.workspace-switch', '.watch-market-tabs', '.watch-toolkit'].includes(selector) ? new Element() : tabs.find(tab => selector.includes('"' + tab.dataset.watchMarket + '"')) };
  globalThis.window = { location: { search: '?futu=connected', pathname: '/', hash: '' }, history: { replaceState() {} } };
  let interval, finishPost, finishState, finishConnection;
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 30000); interval = fn; return 0; };
  Date.now = () => clock.now;
  const remote = { lastAttemptAt: lastAttemptAt ?? '2026-11-04T10:00:00Z', refreshInProgress: inProgress, connection }, controls = { stateError, connectionError, actionError };
  const state = () => ({ ...remote, serverTime: new Date(clock.now).toISOString(), scheduleEnabled: false,
    markets: markets ?? { NQ: { contracts: [] }, ES: { contracts: [] }, CL: { contracts: [] } } });
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/watch-context' && saveMap) return saveMap(JSON.parse(options.body));
    if (url.startsWith('/api/session-history?')) {
      const market = new URL(url, 'https://gamma.test').searchParams.get('market');
      const underlyingCode = state().markets[market]?.underlyingCode;
      return Response.json({ market, underlyingCode, status: 'history-partial', progress: { done: true },
        profile: { underlyingCode, asOf: new Date(clock.now).toISOString(), windows: [] } });
    }
    if (url === '/api/futu/status') {
      if (pendingConnection) await new Promise(resolve => { finishConnection = resolve; });
      return controls.connectionError ? Response.json({ code: 'PRIVATE_STORAGE_UNAVAILABLE' }, { status: 503 }) : Response.json({ connection: statusConnection });
    }
    if (options.method === 'POST') {
      if (pending) await new Promise(resolve => { finishPost = resolve; });
      if (controls.actionError) return Response.json(controls.actionError, { status: 503 });
      remote.lastAttemptAt = new Date(clock.now).toISOString(); remote.refreshInProgress = false;
    } else {
      if (pendingState) await new Promise(resolve => { finishState = resolve; });
      if (controls.stateError) throw new DOMException('Request timed out', 'AbortError');
    }
    return Response.json(state());
  };
  let source = await readFile(new URL('./market-watch.mjs', import.meta.url), 'utf8');
  for (const file of ['engine.mjs', 'hedging-engine.mjs', 'session-impact.mjs', 'session-history.mjs', 'manual-workflow.mjs','market-reading.mjs','menthorq-import.mjs']) source = source.replace('./core/' + file, new URL('../core/' + file, import.meta.url).href);
  source = source.replace('./session-impact-view.mjs', new URL('./session-impact-view.mjs', import.meta.url).href);
  source = source.replace('./level-lens-view.mjs', new URL('./level-lens-view.mjs', import.meta.url).href);
  source = source.replace('./replay-view.mjs', new URL('./replay-view.mjs', import.meta.url).href);
  source = source.replace('./iv-surface-view.mjs', new URL('./iv-surface-view.mjs', import.meta.url).href);
  source += `\nexport { state as __state, sessionState }; // test session ${session++}`;
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  elements.get('plan-levels').value = '28750,-107.84K'; module.initMarketWatch(); await settle();
  return { clock, requests, elements, events, remote, controls, state: module.__state, sessionState: module.sessionState, tick: () => interval(), finish: () => finishPost?.(), finishState: () => finishState?.(), finishConnection: () => finishConnection?.(),
    restore() { Date.now = original.now; globalThis.fetch = original.fetch; globalThis.setInterval = original.interval; globalThis.document = original.document; globalThis.window = original.window; } };
}

test('the manual shortcut clears old clock fields and saves only exact matching exports', async t => {
  const app = await setup({
    markets: {
      NQ: { underlyingCode: 'US.NQ2612', contracts: [], watchContext: { sourceDate: '2026-11-03', sourceLocalTime: '08:19', levels: [] } },
      ES: { underlyingCode: 'US.ES2612', contracts: [] },
      CL: { underlyingCode: 'US.CL2701', contracts: [] },
    },
    saveMap: ({ market, underlyingCode, sourceDate }) => market === 'ES'
      ? Response.json({ error: 'Please retry the save.' }, { status: 400 })
      : Response.json({ saved: true, context: { underlyingCode, sourceDate, levels: [] } }),
  });
  t.after(() => app.restore());
  try {
    const get = id => app.elements.get(id);
    get('watch-open-menthorq-levels').events.click[0]();
    assert.equal(get('watch-context-source-date').value, '');
    assert.equal(get('watch-context-source-time').value, '');
    assert.match(get('watch-context-symbols').textContent, /NQZ2026, ESZ2026, CLF2027/);
    assert.equal(app.requests.filter(r => r.url === '/api/watch-context').length, 0);
    const exportText = '$NQZ2026: Call Wall, 28000\n$ESZ2026: Call Wall, 7400\n$CLZ2026: Call Wall, 85';
    get('watch-context-export').value = exportText;
    get('watch-context-source-date').value = '2026-11-04';
    await get('watch-context-form').events.submit[0]({ preventDefault() {} });
    assert.deepEqual(app.requests.filter(r => r.url === '/api/watch-context').map(r => r.body.market), ['NQ', 'ES']);
    assert.match(get('watch-menthorq-import-status').textContent, /for NQ\. No matching sections for CL\./);
    assert.match(get('watch-context-error').textContent, /ES: Please retry/);
    assert.equal(get('watch-context-export').value, exportText);
    assert.equal(get('watch-context-editor').hidden, false);
  } finally {
    const signal = AbortSignal.timeout(5000);
    while (app.sessionState.loadingKey) await delay(5, undefined, { signal });
  }
  assert.equal(app.sessionState.histories.get('NQ|US.NQ2612')?.status, 'history-partial');
});

test('startup checks the connection before showing any authorization action', async () => {
  const app = await setup({ pendingState: true, pendingConnection: true });
  try {
    assert.match(app.elements.get('watch-connection').innerHTML, /Checking connection/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
    assert.equal(app.elements.get('watch-refresh').disabled, true);
    assert.doesNotMatch(app.elements.get('watch-service-message').textContent, /Connect Futu/);
    app.finishConnection(); app.finishState(); await settle(); await settle();
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
  } finally { app.finishConnection(); app.finishState(); app.restore(); }
});
test('a failed initial state check is unknown and retries without asking for authorization', async () => {
  const app = await setup({ stateError: true, connectionError: true });
  try {
    assert.match(app.elements.get('watch-connection').innerHTML, /Connection status unavailable/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
    assert.match(app.elements.get('watch-service-message').textContent, /Check saved update to retry/);
    assert.doesNotMatch(app.elements.get('watch-next').textContent, /connect Futu/);
    app.controls.stateError = false; app.controls.connectionError = false; await app.tick();
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
  } finally { app.restore(); }
});
test('the independent status request can confirm Futu while the initial snapshot is still loading', async () => {
  const app = await setup({ pendingState: true });
  try {
    assert.ok(app.requests.some(request => request.url === '/api/futu/status'));
    assert.ok(app.requests.some(request => request.url === '/api/market-state'));
    assert.equal(app.state.fetching, true);
    assert.equal(app.state.data, null);
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
    app.finishState(); await settle(); await settle();
  } finally { app.finishState(); app.restore(); }
});
test('a snapshot failure and later status-service failure do not erase independently confirmed authorization', async () => {
  const app = await setup({ stateError: true });
  try {
    assert.equal(app.state.data, null);
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
    assert.match(app.elements.get('watch-error').textContent, /saved market snapshot could not be loaded/);
    app.controls.connectionError = true; await app.tick();
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
  } finally { app.restore(); }
});
test('a successfully loaded market state remains the primary connection source', async () => {
  const app = await setup({ statusConnection: { connected: false, reauthorizationRequired: true } });
  try {
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
  } finally { app.restore(); }
});
test('a later state timeout retains the last confirmed connection', async () => {
  const app = await setup();
  try {
    app.controls.stateError = true; await app.tick();
    assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
    assert.equal(app.elements.get('watch-connect').hidden, true);
    assert.match(app.elements.get('watch-error').textContent, /timed out/);
  } finally { app.restore(); }
});
test('only a confirmed disconnected connection offers the connect action', async () => {
  for (const connection of [{ connected: false }, { connected: false, reauthorizationRequired: true }]) {
    const app = await setup({ connection });
    try {
      assert.equal(app.elements.get('watch-connect').hidden, false);
      assert.equal(app.elements.get('watch-connect').textContent, connection.reauthorizationRequired ? 'Reconnect Futu' : 'Connect Futu');
      assert.match(app.elements.get('watch-connection').innerHTML, connection.reauthorizationRequired ? /Authorization expired/ : /Not connected/);
    } finally { app.restore(); }
  }
  const app = await setup({ connection: { configured: false, connected: false } });
  try {
    assert.equal(app.elements.get('watch-connect').hidden, true);
    assert.match(app.elements.get('watch-connection').innerHTML, /Connection status unavailable/);
  } finally { app.restore(); }
});
test('temporary authorization renewal failures offer a retry while retaining the confirmed connection', async () => {
  for (const code of ['AUTH_REFRESH_BUSY', 'AUTH_REFRESH_UNAVAILABLE']) {
    const app = await setup({ lastAttemptAt: '2026-11-04T09:45:00Z', actionError: { code } });
    try {
      await settle(); await settle();
      assert.match(app.elements.get('watch-error').textContent, /Try again shortly; a new authorization is not required/);
      assert.match(app.elements.get('watch-connection').innerHTML, /Futu connected/);
      assert.equal(app.elements.get('watch-connect').hidden, true);
      assert.equal(app.state.refreshing, false);
    } finally { app.restore(); }
  }
});

test('not-due startup including OAuth return does not force; new five-minute slot refreshes once', async () => {
  const app = await setup();
  try {
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 0);
    await app.tick(); assert.equal(app.requests.filter(request => request.method === 'POST').length, 0);
    app.clock.now = Date.parse('2026-11-04T10:04:59Z'); await app.tick();
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 0);
    app.clock.now = Date.parse('2026-11-04T10:05:01Z'); await app.tick();
    const posts = app.requests.filter(request => request.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual(posts[0].body, {});
    await app.tick(); assert.equal(app.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(app.elements.get('plan-levels').value, '28750,-107.84K');
    assert.match(app.elements.get('watch-service-message').textContent, /Updates every 5 minutes/);
    assert.match(app.elements.get('watch-service-message').textContent, /Closing the page stops automatic updates/);
  } finally { app.restore(); }
});
test('due startup resumes a seven-minute in-flight session without overlap', async () => {
  const app = await setup({ lastAttemptAt: '2026-11-04T09:45:00Z', pending: true });
  try {
    assert.equal(app.state.refreshing, true); assert.equal(app.requests.filter(request => request.method === 'POST').length, 1);
    app.clock.now += 7 * 60000; await app.tick(); await app.tick();
    document.hidden = true; app.events.visibilitychange(); document.hidden = false; app.events.visibilitychange();
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 1);
    app.finish(); await settle(); await settle(); assert.equal(app.state.refreshing, false);
    assert.deepEqual(app.requests.find(request => request.method === 'POST').body, {});
    assert.equal(app.elements.get('plan-levels').value, '28750,-107.84K');
  } finally { app.finish(); app.restore(); }
});
test('active jobs resume within a slot; background checks and visibility resume remain enabled', async () => {
  const app = await setup({ inProgress: true });
  try {
    await settle(); assert.equal(app.requests.filter(request => request.method === 'POST').length, 1);
    document.hidden = true; app.clock.now += 5 * 60000; await app.tick();
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 2);
    app.clock.now += 5 * 60000; document.hidden = false; app.events.visibilitychange(); await settle(); await settle();
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 3);
    assert.ok(app.requests.filter(request => request.method === 'POST').every(request => !request.body.force));
  } finally { app.restore(); }
});
