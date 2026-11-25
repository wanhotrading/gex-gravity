import test from 'node:test';
import assert from 'node:assert/strict';
import {connectCollectorBrowser, wakeStalledMenthorqTabs} from '../collector/browser-attach.mjs';

const deadline = () => Date.now() + 30000;
const timeout = () => Object.assign(Error('timed out'), {name: 'TimeoutError'});

test('a healthy attach leaves all existing tabs alone', async () => {
  const browser = {};
  assert.equal(await connectCollectorBrowser({connectOverCDP: async () => browser}, deadline(),
    () => assert.fail('unexpected recovery')), browser);
});

test('an attach timeout gets one recovery and one reconnect before any capture', async () => {
  const calls = [];
  const chromium = {connectOverCDP: async () => {
    calls.push('attach');
    if (calls.length === 1) throw timeout();
    return 'connected';
  }};
  assert.equal(await connectCollectorBrowser(chromium, deadline(), () => calls.push('wake')), 'connected');
  assert.deepEqual(calls, ['attach', 'wake', 'attach']);
});

test('persistent attach failures are identifiable and the retry is bounded', async () => {
  let attempts = 0;
  const chromium = {connectOverCDP: async () => { attempts++; throw timeout(); }};
  await assert.rejects(connectCollectorBrowser(chromium, deadline(), async () => {}), /MQ_BROWSER_ATTACH_TIMEOUT/);
  assert.equal(attempts, 2);
  await assert.rejects(connectCollectorBrowser(chromium, Date.now(), async () => {}), /MQ_TIME_BUDGET/);
  assert.equal(attempts, 2);
});

test('recovery activates only stalled, still-unattached provider pages', async () => {
  const url = 'https://dashboard.menthorq.io/en/levels';
  const page = (id, overrides) => ({targetId: id, type: 'page', url, attached: false, ...overrides});
  const tabs = [page('a'), page('b'), page('c', {attached: true}), page('d', {url: 'https://example.org/'}),
    page('e', {type: 'iframe'}), page('f'), page('ff')];
  let first = true;
  const list = async () => {
    if (!first) tabs.at(-1).attached = true;
    first = false;
    return {targetInfos: tabs};
  };
  const probed = [], woken = [];
  await wakeStalledMenthorqTabs(list, async id => {
    probed.push(id);
    if (['b', 'ff'].includes(id)) throw Error('MQ_TAB_PROBE_TIMEOUT');
    if (id === 'f') throw Error('MQ_BROWSER_UNAVAILABLE');
  }, async id => woken.push(id));
  assert.deepEqual(probed, ['a', 'b', 'f', 'ff']);
  assert.deepEqual(woken, ['b']);
});
