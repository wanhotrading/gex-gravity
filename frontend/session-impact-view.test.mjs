import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bindSessionImpact, renderSessionImpact, sessionFlowLabel, sessionMetricValue } from './session-impact-view.mjs';

const metric = value => ({ value, knownSubtotal: value, complete: true, includedRows: 2, expectedRows: 2 });
const flow = value => ({ method: 'exact-repricing', status: 'complete', changeContracts: metric(value), hedgeBefore: metric(-120), hedgeAfter: metric(-120 + value), longAdded: metric(0), shortCovered: metric(value > 0 ? value : 0), longLifted: metric(0), shortAdded: metric(value < 0 ? -value : 0), includedRows: 2, expectedRows: 2 });
function model(extra = {}) {
  return { underlyingCode: 'US.NQ2612', currentPrice: 100, shockPoints: 2, selectedWindowId: 'opening', positionScale: 1, inventoryLabel: 'Dealers short all OI', analysis: { shockPoints: 2, positionScale: 1, up: { targetPrice: 102, flow: flow(20) }, down: { targetPrice: 98, flow: flow(-18) }, windows: [{ id: 'opening', label: '09:30–10:00', sampleCount: 12, medianVolumeContracts: 1000, medianVolatilityPoints: 3, medianRangePoints: 6, up: { volumeShare: .02, stressImpactPoints: .6 }, down: { volumeShare: .018, stressImpactPoints: -.57 } }] }, ...extra };
}

test('net buying and net selling preserve direction and zero is an observed no-change result', () => {
  assert.deepEqual(sessionFlowLabel(metric(20)), { action: 'Net buying', amount: '20', className: 'is-buy', partial: false });
  assert.deepEqual(sessionFlowLabel(metric(-18)), { action: 'Net selling', amount: '18', className: 'is-sell', partial: false });
  assert.equal(sessionFlowLabel(metric(0)).action, 'No net change');
  assert.equal(sessionFlowLabel(null).action, 'Unavailable');
  assert.deepEqual(sessionMetricValue({ value: null, knownSubtotal: 40, complete: false, includedRows: 1, expectedRows: 3 }), { value: 40, partial: true });
});

test('flow view shows target prices, add/unwind components and all seven NY windows without fabricating missing history', () => {
  const root = {};
  renderSessionImpact(root, model());
  assert.match(root.innerHTML, /Target <strong>102<\/strong>/);
  assert.match(root.innerHTML, /Target <strong>98<\/strong>/);
  assert.match(root.innerHTML, /Net buying/);
  assert.match(root.innerHTML, /Net selling/);
  for (const label of ['Add long', 'Cover shorts', 'Reduce longs', 'Add short', '10:30–11:00', '15:50–16:00']) assert.ok(root.innerHTML.includes(label), label);
  assert.match(root.innerHTML, /2%/);
  assert.match(root.innerHTML, /1\.8%/);
  assert.match(root.innerHTML, /12 complete sessions/);
  assert.match(root.innerHTML, /Point impact is not calibrated/);
  assert.match(root.innerHTML, /Show Y = 1 stress example/);
  assert.doesNotMatch(root.innerHTML, /0\.6 pts/);
  assert.match(root.innerHTML, /data-session-field="impactCoefficient"[^>]+value=""/);
  assert.match(root.innerHTML, /data-session-window="morning"[^>]+aria-selected="false"/);
});

test('only an explicit impact factor enables the illustrative point-impact column and zero remains a valid assumption', () => {
  const root = {};
  renderSessionImpact(root, model({ impactCoefficient: 0 }));
  assert.match(root.innerHTML, /Assumed Y = 0/);
  assert.match(root.innerHTML, /ILLUSTRATIVE IMPACT · UP \/ DOWN/);
  assert.match(root.innerHTML, /stress scenario, not a measured share/);
  assert.match(root.innerHTML, /Clear impact assumption/);
  renderSessionImpact(root, model({ impactCoefficient: null }));
  assert.doesNotMatch(root.innerHTML, /ILLUSTRATIVE IMPACT · UP \/ DOWN/);
});

test('unavailable and partial coverage stay visible, and untrusted source text is escaped', () => {
  const root = {}, props = model({ historyMessage: '<img src=x onerror=bad()>', inventoryLabel: '<script>bad()</script>' });
  props.analysis.up.flow = { method: 'current-gamma-linear', status: 'partial', changeContracts: { value: null, knownSubtotal: 5, complete: false, includedRows: 1, expectedRows: 2 }, includedRows: 1, expectedRows: 2 };
  props.analysis.down.flow = { status: 'unavailable', includedRows: 0, expectedRows: 2 };
  props.analysis.windows[0].up.volumeShare = null;
  renderSessionImpact(root, props);
  assert.match(root.innerHTML, /Partial · Net buying/);
  assert.match(root.innerHTML, /Current Gamma approximation · 1 \/ 2 series · fixed Gamma/);
  assert.match(root.innerHTML, /No eligible series/);
  assert.match(root.innerHTML, /&lt;img/);
  assert.match(root.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(root.innerHTML, /<script>bad/);
});

test('panel scope identifies the point-value subset separately from complete model coverage', () => {
  const root = {};
  renderSessionImpact(root, model({ selectedSeriesCount: 458, calibratedSeriesCount: 354 }));
  assert.match(root.innerHTML, /Watched strikes · selected expiry · 354 \/ 458 point-value series/);
  assert.match(root.innerHTML, /Repriced option model · 2 \/ 2 series/);
  renderSessionImpact(root, model({ selectedSeriesCount: 0, calibratedSeriesCount: 0 }));
  assert.match(root.innerHTML, /0 \/ 0 point-value series/);
  renderSessionImpact(root, model());
  assert.doesNotMatch(root.innerHTML, /point-value series/);
});

test('offsetting option rows show net book openings rather than gross row requirements', () => {
  const root = {}, props = model();
  props.analysis.up.flow = { ...flow(20), hedgeBefore: metric(0), hedgeAfter: metric(20), longAdded: metric(10), shortCovered: metric(10), netBook: { complete: true, hedgeBefore: metric(0), hedgeAfter: metric(20), changeContracts: metric(20), longAdded: metric(20), shortCovered: metric(0), longLifted: metric(0), shortAdded: metric(0) } };
  renderSessionImpact(root, props);
  const upCard = root.innerHTML.split('</article>')[0];
  assert.match(upCard, /Net hedge position changes/);
  assert.match(upCard, /Add long<\/span><strong>20<\/strong>/);
  assert.match(upCard, /Cover shorts<\/span><strong>0<\/strong>/);
  assert.doesNotMatch(upCard, /Add long<\/span><strong>10<\/strong>/);
  assert.match(upCard, /Hedge <strong>0<\/strong>/);
  props.analysis.up.flow.status = 'partial';
  props.analysis.up.flow.changeContracts = { value: null, knownSubtotal: 20, complete: false, includedRows: 1, expectedRows: 2 };
  renderSessionImpact(root, props);
  const partialCard = root.innerHTML.split('</article>')[0];
  assert.match(partialCard, /Per-series requirements · before netting/);
  assert.match(partialCard, /Add long<\/span><strong>10<\/strong>/);
});

test('selected historical sample dates remain visible during updates and stress-size comparison requires verified history', () => {
  const root = {}, props = model({ impactCoefficient: 1, loading: true });
  props.analysis.volumeUnit = 'contracts';
  Object.assign(props.analysis.windows[0], { firstSessionDate: '2026-10-19', lastSessionDate: '2026-11-03' });
  props.analysis.windows[0].up.stressVsConditioningMove = .3;
  props.analysis.windows[0].down.stressVsConditioningMove = .285;
  renderSessionImpact(root, props);
  assert.match(root.innerHTML, /12 complete sessions · 2026-10-19–2026-11-03 · US.NQ2612 · updating/);
  assert.match(root.innerHTML, /Stress size vs chosen move · up 30% \/ down 28\.5% · size comparison only/);
  props.analysis.volumeUnit = 'unverified';
  renderSessionImpact(root, props);
  assert.doesNotMatch(root.innerHTML, /Stress size vs chosen move/);
  props.analysis.volumeUnit = 'contracts'; props.analysis.windows[0].sampleCount = 9;
  renderSessionImpact(root, props);
  assert.doesNotMatch(root.innerHTML, /Stress size vs chosen move/);
});

test('unverified native volume remains an explicit assumption and does not automatically select an impact factor', () => {
  const root = {}, props = model();
  props.analysis.volumeUnit = 'unverified';
  props.analysis.windows[0].medianVolumeContracts = null;
  props.analysis.windows[0].medianReportedVolume = 1000;
  renderSessionImpact(root, props);
  assert.match(root.innerHTML, /12 complete sessions/);
  assert.match(root.innerHTML, /Treat native futures volume as contracts \(assumption\)/);
  assert.match(root.innerHTML, /data-session-field="allowUnverifiedContractVolume">/);
  assert.doesNotMatch(root.innerHTML, /Volume units: assumed native contracts/);
  assert.match(root.innerHTML, /Point impact is not calibrated/);

  props.allowUnverifiedContractVolume = true;
  props.analysis.volumeUnit = 'contracts-assumed';
  props.analysis.windows[0].windowVolumeBasis = 'user-assumed-native-contracts';
  props.analysis.windows[0].up.stressVsConditioningMove = .3;
  props.analysis.windows[0].down.stressVsConditioningMove = .285;
  renderSessionImpact(root, props);
  assert.match(root.innerHTML, /Volume units: assumed native contracts/);
  assert.match(root.innerHTML, /<td>1,000<\/td>/);
  assert.match(root.innerHTML, /data-session-field="allowUnverifiedContractVolume" checked/);
  assert.match(root.innerHTML, /Point impact is not calibrated/);
  assert.doesNotMatch(root.innerHTML, /Stress size vs chosen move/);

  props.impactCoefficient = 1;
  renderSessionImpact(root, props);
  assert.match(root.innerHTML, /Stress size vs chosen move · up 30% \/ down 28\.5% · size comparison only · volume assumed/);
  props.allowUnverifiedContractVolume = false;
  renderSessionImpact(root, props);
  assert.doesNotMatch(root.innerHTML, /Stress size vs chosen move/);
  assert.doesNotMatch(root.innerHTML, /\+0\.6 pts/);

  const events = {}, changes = [], boundRoot = { dataset: {}, addEventListener: (name, handler) => { events[name] = handler; } };
  bindSessionImpact(boundRoot, { onChange: change => changes.push(change) });
  for (const checked of [true, false]) events.change({ target: { dataset: { sessionField: 'allowUnverifiedContractVolume' }, checked } });
  assert.deepEqual(changes, [{ allowUnverifiedContractVolume: true }, { allowUnverifiedContractVolume: false }]);
});

test('background rerenders preserve expanded assumptions and an uncommitted focused model input', () => {
  let details = { open: true }, input = { dataset: { sessionField: 'shockPoints' }, type: 'number', value: '125', selectionStart: null, selectionEnd: null };
  const oldInput = input;
  let focused = false, markup = '';
  const root = {
    ownerDocument: { activeElement: oldInput }, contains: element => element === oldInput,
    querySelector: selector => selector === '.session-impact-assumptions' ? details : selector === 'input[data-session-field="shockPoints"]' ? input : null,
    set innerHTML(value) { markup = value; details = { open: false }; input = { type: 'number', value: '2', focus(options) { focused = options.preventScroll; } }; },
    get innerHTML() { return markup; },
  };
  renderSessionImpact(root, model());
  assert.equal(details.open, true, 'the user can keep the assumptions open while quotes update');
  assert.equal(input.value, '125', 'a background update must not replace uncommitted typing with the last committed move');
  assert.equal(focused, true);
  assert.match(root.innerHTML, /Target <strong>102<\/strong>/, 'calculated results still use the committed model inputs');
  root.ownerDocument.activeElement = null; details.open = false;
  renderSessionImpact(root, model());
  assert.equal(details.open, false, 'a deliberately closed disclosure stays closed');
});

test('default price shocks and volatility multipliers align with their native number-input step origins', () => {
  const root = {};
  for (const [market, tickSize, shockPoints] of [['NQ', .25, 25], ['ES', .25, 5], ['CL', .01, .05]]) {
    renderSessionImpact(root, model({ market, tickSize, shockPoints, volatilityScale: 1 }));
    for (const name of ['session-shock', 'session-volatility']) {
      const tag = root.innerHTML.match(new RegExp(`<input[^>]+name="${name}"[^>]*>`))[0];
      const attribute = name => Number(tag.match(new RegExp(`${name}="([^"]+)"`))[1]);
      const min = attribute('min'), value = attribute('value'), step = attribute('step');
      assert.equal(min, 0, `${market} ${name} uses a zero step origin`);
      assert.ok(Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-9, `${market} ${name} default must not have a native stepMismatch`);
    }
  }
});

test('a restored draft commits on focusout once and ignores detached or rendering-time events', () => {
  const events = {}, changes = [], attached = new Set();
  const root = { dataset: {}, contains: target => attached.has(target), addEventListener: (name, handler) => { events[name] = handler; } };
  bindSessionImpact(root, { onChange: patch => changes.push(patch) });
  const input = { dataset: { sessionField: 'shockPoints', sessionCommitted: '.05' }, value: '.01' };
  attached.add(input);
  events.focusout({ target: input });
  events.change({ target: input });
  assert.deepEqual(changes, [{ shockPoints: .01 }], 'blur commits a restored draft without a duplicate native change');
  attached.delete(input); input.value = '.02'; events.focusout({ target: input });
  attached.add(input); root.dataset.sessionRendering = 'true'; events.focusout({ target: input });
  assert.equal(changes.length, 1, 'DOM replacement must not recursively commit the removed input');
  root.dataset.sessionRendering = 'false'; input.value = '0'; events.focusout({ target: input });
  assert.equal(changes.length, 1, 'the model still requires a strictly positive shock');
  const coefficient = { dataset: { sessionField: 'impactCoefficient', sessionCommitted: '1' }, value: '' };
  attached.add(coefficient); events.focusout({ target: coefficient });
  assert.deepEqual(changes.at(-1), { impactCoefficient: null });
});

test('delegated controls normalize OI percentages, clear an impact factor and reject invalid values', () => {
  const events = {}, changes = [], root = { dataset: {}, addEventListener: (name, handler) => { events[name] = handler; } };
  bindSessionImpact(root, { onChange: change => changes.push(change) });
  const change = (field, value) => events.change({ target: { dataset: { sessionField: field }, value } });
  change('positionScale', '25'); change('shockPoints', '.05'); change('impactCoefficient', '0'); change('impactCoefficient', '');
  change('positionScale', '101'); change('shockPoints', '-2'); change('volatilityScale', 'NaN');
  assert.deepEqual(changes, [{ positionScale: .25 }, { shockPoints: .05 }, { impactCoefficient: 0 }, { impactCoefficient: null }]);
});

test('window buttons and keyboard navigation use the same valid window IDs', () => {
  const events = {}, changes = [], root = { dataset: {}, addEventListener: (name, handler) => { events[name] = handler; } };
  let refreshes = 0, focused = '';
  root.querySelector = selector => ({ focus() { focused = selector; } });
  bindSessionImpact(root, { onChange: change => changes.push(change), onRefreshHistory: () => { refreshes++; } });
  events.click({ target: { closest: selector => selector === '[data-session-window]' ? { dataset: { sessionWindow: 'late-morning' } } : null } });
  events.click({ target: { closest: selector => selector === '[data-session-refresh]' ? {} : null } });
  let prevented = false;
  events.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; }, target: { closest: () => ({ dataset: { sessionWindow: 'closing' } }) } });
  assert.deepEqual(changes, [{ windowId: 'late-morning' }, { windowId: 'opening' }]);
  assert.equal(refreshes, 1); assert.equal(prevented, true); assert.ok(focused.includes('opening'));
});

test('the stress example is an explicit user action and can be cleared without changing the shock', () => {
  const events = {}, changes = [], root = { dataset: {}, addEventListener: (name, handler) => { events[name] = handler; } };
  bindSessionImpact(root, { onChange: change => changes.push(change) });
  for (const selector of ['[data-session-impact-example]', '[data-session-clear-impact]']) events.click({ target: { closest: requested => requested === selector ? {} : null } });
  assert.deepEqual(changes, [{ impactCoefficient: 1 }, { impactCoefficient: null }]);
});

test('session panel retains readable numeric type and a horizontal table at narrow widths', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.session-history-table td,[^{]+\{[^}]*font-size:16px/);
  assert.match(css, /\.session-history-scroll\{overflow-x:auto/);
  assert.match(css, /\.session-flow-grid\{grid-template-columns:minmax\(0,1fr\)/);
});
