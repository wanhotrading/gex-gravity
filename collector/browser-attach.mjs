const endpoint = 'http://127.0.0.1:9337';
const socketOrigin = 'ws://127.0.0.1:9337';

function budget(deadline, maximum) {
  const remaining = deadline - Date.now() - 1000;
  if (remaining < 1) throw Error('MQ_TIME_BUDGET');
  return Math.min(remaining, maximum);
}

// One local DevTools command. Close the diagnostic socket even if the
// renderer never answers. Do not include browser URLs or protocol data in logs.
function command(url, method, params, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(reject, Error('MQ_TAB_PROBE_TIMEOUT')), timeout);
    function finish(callback, value) {
      clearTimeout(timer);
      socket.onerror = null;
      socket.onclose = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.close();
      callback(value);
    }
    socket.onerror = socket.onclose = () => finish(reject, Error('MQ_BROWSER_UNAVAILABLE'));
    socket.onopen = () => socket.send(JSON.stringify({id: 1, method, params}));
    socket.onmessage = ({data}) => {
      const reply = JSON.parse(data);
      if (reply.id !== 1) return;
      if (reply.error) finish(reject, Error('MQ_BROWSER_UNAVAILABLE'));
      else finish(resolve, reply.result);
    };
  });
}

async function wakeProviderTabs(deadline) {
  const response = await fetch(endpoint + '/json/version', {
    signal: AbortSignal.timeout(budget(deadline, 1500)), redirect: 'error',
  });
  if (!response.ok) throw Error('MQ_BROWSER_UNAVAILABLE');
  const {webSocketDebuggerUrl} = await response.json();
  if (!webSocketDebuggerUrl?.startsWith(socketOrigin + '/devtools/browser/')) throw Error('MQ_BROWSER_UNAVAILABLE');
  const send = (url, method, params) => command(url, method, params, budget(deadline, 1500));
  return wakeStalledMenthorqTabs(
    () => send(webSocketDebuggerUrl, 'Target.getTargets', {}),
    id => send(socketOrigin + '/devtools/page/' + id, 'Page.getFrameTree', {}),
    async id => {
      await send(webSocketDebuggerUrl, 'Target.activateTarget', {targetId: id});
      await send(socketOrigin + '/devtools/page/' + id, 'Page.setWebLifecycleState', {state: 'active'});
    },
  );
}

export async function wakeStalledMenthorqTabs(list, probe, wake) {
  const {targetInfos} = await list();
  const eligible = tab => tab.type === 'page' && !tab.attached &&
    tab.url.startsWith('https://dashboard.menthorq.io/') && /^[a-f0-9]+$/i.test(tab.targetId);
  const candidates = targetInfos.filter(eligible);
  const stalled = await Promise.all(candidates.map(async tab => {
    try { await probe(tab.targetId); }
    catch (error) { if (error.message === 'MQ_TAB_PROBE_TIMEOUT') return tab.targetId; }
  }));
  for (const id of stalled.filter(Boolean)) {
    const current = (await list()).targetInfos.find(tab => tab.targetId === id);
    if (current && eligible(current)) await wake(id);
  }
}

export async function connectCollectorBrowser(chromium, deadline, wake = wakeProviderTabs) {
  const attach = () => chromium.connectOverCDP(endpoint, {timeout: budget(deadline, 7000)});
  try { return await attach(); }
  catch (error) { if (error.name !== 'TimeoutError') throw error; }
  // Playwright initializes every existing page before handing us a new one.
  // A single sleeping background tab can block the whole signed-in profile.
  try { await wake(deadline); }
  catch (error) { if (error.message === 'MQ_TIME_BUDGET') throw error; }
  try { return await attach(); }
  catch (error) {
    if (error.name === 'TimeoutError') throw Error('MQ_BROWSER_ATTACH_TIMEOUT');
    throw error;
  }
}
