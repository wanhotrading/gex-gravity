const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = (value, digits = 2) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const signed = (value, digits = 2) => finite(value) ? `${value > 0 ? '+' : ''}${number(value, digits)}` : '—';
const WINDOWS = [
  { id: 'opening', label: '09:30–10:00' },
  { id: 'morning', label: '10:00–10:30' },
  { id: 'late-morning', label: '10:30–11:00', extra: true },
  { id: 'midday', label: '11:00–13:00' },
  { id: 'afternoon', label: '13:00–14:30' },
  { id: 'late', label: '14:30–15:50' },
  { id: 'closing', label: '15:50–16:00' },
];

export function sessionMetricValue(metric) {
  if (finite(metric)) return { value: metric, partial: false };
  if (!metric || !(metric.includedRows > 0)) return { value: null, partial: false };
  if (metric.complete === true && finite(metric.value)) return { value: metric.value, partial: false };
  return { value: finite(metric.knownSubtotal) ? metric.knownSubtotal : null, partial: true };
}

function quantity(metric, { sign = false, digits = 1 } = {}) {
  const result = sessionMetricValue(metric);
  return `${result.partial && finite(result.value) ? 'Partial ' : ''}${sign ? signed(result.value, digits) : number(result.value, digits)}`;
}

export function sessionFlowLabel(metric) {
  const { value, partial } = sessionMetricValue(metric);
  if (!finite(value)) return { action: 'Unavailable', amount: '—', className: '', partial };
  return { action: value > 0 ? 'Net buying' : value < 0 ? 'Net selling' : 'No net change', amount: number(Math.abs(value), 1), className: value > 0 ? 'is-buy' : value < 0 ? 'is-sell' : 'is-neutral', partial };
}

function chooseFlow(direction) {
  if (direction?.flow) return direction.flow;
  if (direction?.model?.status === 'complete') return direction.model;
  if (direction?.localGamma?.status === 'complete') return direction.localGamma;
  return direction?.model?.includedRows > 0 ? direction.model : direction?.localGamma ?? direction?.model ?? null;
}

function isLinear(flow) { return /gamma|linear/i.test(flow?.method ?? ''); }
function basisLabel(flow) { return isLinear(flow) ? 'Current Gamma approximation' : flow ? 'Repriced option model' : 'Inputs needed'; }
function windowPercent(value) { return finite(value) && value >= 0 ? `${number(value * 100, 2)}%` : '—'; }
function impactText(value) { return finite(value) ? `${signed(value)} pts` : '—'; }
function stressReason(window) {
  const reason = window?.up?.reason ?? window?.down?.reason;
  return ({ 'insufficient-history-for-stress': 'Needs 10 completed sessions for the impact scale.', 'flow-exceeds-typical-window-volume': 'Flow exceeds typical window volume; point impact is outside this comparison.', 'historical-volume-unit-unverified': 'Futures volume units are still unverified.', 'complete-hedge-flow-unavailable': 'A complete hedge-flow estimate is needed for the impact scale.' })[reason] ?? null;
}

function flowCard(direction, props, window) {
  const movement = direction === 'up' ? 'rises' : 'falls', result = props.analysis?.[direction], flow = chooseFlow(result), label = sessionFlowLabel(flow?.changeContracts);
  const currentPrice = props.currentPrice ?? props.analysis?.futuresPrice;
  const shock = props.shockPoints ?? props.analysis?.shockPoints;
  const targetPrice = result?.targetPrice ?? (positive(currentPrice) && positive(shock) ? currentPrice + (direction === 'up' ? shock : -shock) : null);
  const reference = window?.[direction], share = reference?.volumeShare;
  const coverage = flow?.includedRows > 0 ? `${number(flow.includedRows, 0)} / ${number(flow.expectedRows, 0)} series` : 'No eligible series';
  const decomposition = [['longAdded', 'Add long'], ['shortCovered', 'Cover shorts'], ['longLifted', 'Reduce longs'], ['shortAdded', 'Add short']];
  const hasNetBook = flow?.status === 'complete' && flow.netBook?.complete === true && decomposition.every(([field]) => {
    const quantity = sessionMetricValue(flow.netBook[field]);
    return finite(quantity.value) && quantity.partial === false;
  });
  const positionChanges = hasNetBook ? flow.netBook : flow;
  return `<article class="session-flow-card ${label.className}">
    <div class="session-flow-title"><h3>If price ${movement}</h3><span>${direction === 'up' ? '+' : '−'}${number(shock)} pts</span></div>
    <p class="session-target">Target <strong>${number(targetPrice)}</strong></p>
    <p class="session-flow-action">${label.partial && label.amount !== '—' ? 'Partial · ' : ''}${label.action}</p>
    <div class="session-flow-number">${label.amount}<span>equivalent futures</span></div>
    <p class="session-decomposition-heading">${hasNetBook ? 'Net hedge position changes' : 'Per-series requirements · before netting'}</p>
    <div class="session-flow-decomposition">${decomposition.map(([field, title]) => `<div><span>${title}</span><strong>${quantity(positionChanges?.[field])}</strong></div>`).join('')}</div>
    <p class="session-hedge-target">Hedge <strong>${quantity(flow?.hedgeBefore, { sign: true })}</strong><span aria-hidden="true"> → </span><span class="sr-only"> to </span><strong>${quantity(flow?.hedgeAfter, { sign: true })}</strong></p>
    <p class="session-option-delta">Option Δ change <strong>${quantity(flow?.optionDeltaChangeContracts, { sign: true })}</strong><span>futures equivalent</span></p>
    ${['procyclical', 'countercyclical', 'neutral'].includes(result?.feedback) ? `<p class="session-feedback">${result.feedback === 'procyclical' ? 'Modeled hedge flow moves with price' : result.feedback === 'countercyclical' ? 'Modeled hedge flow moves against price' : 'No directional hedge feedback'}</p>` : ''}
    <div class="session-participation"><span>Net flow / historical window volume</span><strong>${windowPercent(share)}</strong></div>
    <div class="session-participation-track" aria-hidden="true"><span style="width:${finite(share) && share >= 0 ? Math.min(100, share * 100) : 0}%"></span></div>
    <p class="session-basis">${basisLabel(flow)} · ${coverage}${isLinear(flow) ? ' · fixed Gamma' : ''}</p>
    ${flow?.status === 'unavailable' ? '<p class="session-unavailable">A usable price move and eligible Greeks are needed.</p>' : ''}
  </article>`;
}

function renderWindowTable(windows, selectedId, hasImpact) {
  return `<div class="session-history-scroll"><table class="session-history-table"><caption>Compare the same snapshot flow across New York time windows</caption><thead><tr><th scope="col">WINDOW · NY</th><th scope="col">SESSIONS</th><th scope="col">TYPICAL VOLUME</th><th scope="col">VOLATILITY SCALE</th><th scope="col">UP FLOW / VOLUME</th><th scope="col">DOWN FLOW / VOLUME</th>${hasImpact ? '<th scope="col">ILLUSTRATIVE IMPACT · UP / DOWN</th>' : ''}</tr></thead><tbody>${windows.map(window => `<tr${window.id === selectedId ? ' class="selected"' : ''}><th scope="row"><button type="button" data-session-window="${esc(window.id)}"${window.id === selectedId ? ' aria-current="true"' : ''}>${esc(window.label)}${window.extra ? '<small>Added to complete the session</small>' : ''}</button></th><td>${number(window.sampleCount, 0)}</td><td>${number(window.medianVolumeContracts, 0)}</td><td>${number(window.medianVolatilityPoints)}<small>points${finite(window.medianRangePoints) ? ` · range ${number(window.medianRangePoints)}` : ''}</small></td><td>${windowPercent(window.up?.volumeShare)}</td><td>${windowPercent(window.down?.volumeShare)}</td>${hasImpact ? `<td>${impactText(window.up?.stressImpactPoints)}<small>${impactText(window.down?.stressImpactPoints)}</small></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

export function renderSessionImpact(root, props = {}) {
  if (!root) return;
  const priorAssumptionsOpen = root.querySelector?.('.session-impact-assumptions')?.open;
  const activeInput = root.ownerDocument?.activeElement;
  const focusedField = root.contains?.(activeInput) === true && ['shockPoints', 'positionScale', 'impactCoefficient', 'volatilityScale', 'allowUnverifiedContractVolume'].includes(activeInput?.dataset?.sessionField)
    ? { field: activeInput.dataset.sessionField, value: activeInput.value, checked: activeInput.checked,
      start: activeInput.selectionStart, end: activeInput.selectionEnd, direction: activeInput.selectionDirection } : null;
  const analysis = props.analysis, selectedId = props.selectedWindowId ?? 'opening';
  const assumedVolume = props.allowUnverifiedContractVolume === true && analysis?.volumeUnit === 'contracts-assumed';
  const windows = WINDOWS.map(fallback => {
    const window = { ...fallback, ...(analysis?.windows ?? props.windows ?? []).find(window => window.id === fallback.id) };
    if (assumedVolume && window.windowVolumeBasis === 'user-assumed-native-contracts' && positive(window.medianReportedVolume)) window.medianVolumeContracts = window.medianReportedVolume;
    if (analysis?.volumeUnit === 'contracts-assumed' && !assumedVolume) {
      window.medianVolumeContracts = null;
      for (const direction of ['up', 'down']) window[direction] = { ...window[direction], volumeShare: null, stressImpactPoints: null, stressVsConditioningMove: null };
    }
    return window;
  });
  const selected = windows.find(window => window.id === selectedId) ?? windows[0];
  const shock = props.shockPoints ?? analysis?.shockPoints, positionScale = props.positionScale ?? analysis?.positionScale ?? 1;
  const selectedSeriesCount = props.selectedSeriesCount, calibratedSeriesCount = props.calibratedSeriesCount;
  const hasCoverage = finite(selectedSeriesCount) && selectedSeriesCount >= 0 && finite(calibratedSeriesCount) && calibratedSeriesCount >= 0 && calibratedSeriesCount <= selectedSeriesCount;
  const coefficient = props.impactCoefficient, volatilityScale = props.volatilityScale ?? 1;
  const hasImpact = finite(coefficient) && coefficient >= 0;
  const observedHistory = windows.some(window => window.sampleCount > 0 && positive(window.medianVolumeContracts));
  const hasHistoricalSample = windows.some(window => window.sampleCount > 0);
  const historyDates = selected.sampleCount > 0 && [selected.firstSessionDate, selected.lastSessionDate].every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    ? selected.firstSessionDate === selected.lastSessionDate ? selected.firstSessionDate : `${selected.firstSessionDate}–${selected.lastSessionDate}` : null;
  const historyStatus = hasHistoricalSample ? `${number(selected.sampleCount, 0)} complete sessions${historyDates ? ` · ${historyDates}` : ''} · ${props.underlyingCode || analysis?.contract || 'selected futures contract'}${props.loading ? ' · updating…' : ''}` : props.loading ? 'Loading historical bars…' : 'Historical comparison needs intraday bars';
  const stressComparison = hasImpact && observedHistory && (analysis?.volumeUnit === 'contracts' || assumedVolume) && selected.sampleCount >= 10 && ['up', 'down'].some(direction => finite(selected[direction]?.stressVsConditioningMove));
  const linearLimit = Math.min(...['up', 'down'].map(direction => analysis?.[direction]?.localGamma?.maximumSuggestedShockPoints).filter(positive));
  const showSmallMove = finite(linearLimit) && positive(shock) && shock > linearLimit && ['up', 'down'].some(direction => chooseFlow(analysis?.[direction])?.status !== 'complete');
  if (root.dataset) root.dataset.sessionRendering = 'true';
  root.innerHTML = `<div class="panel-heading session-heading"><div><p class="eyebrow">03 / SESSION HEDGE FLOW</p><h2 id="watch-session-title">How much hedging could this move trigger?</h2><p>Same snapshot, different session liquidity.</p></div>${props.canRefreshHistory ? `<button class="button button-secondary" type="button" data-session-refresh${props.loading ? ' disabled' : ''}>${props.loading ? 'Loading history…' : 'Refresh history'}</button>` : ''}</div>
    <div class="session-impact-body">
      <div class="session-impact-controls"><label>Price move · ± points<input type="number" name="session-shock" data-session-field="shockPoints" data-session-committed="${finite(shock) ? shock : ''}" inputmode="decimal" min="0" step="${positive(props.tickSize) ? props.tickSize : 'any'}" value="${finite(shock) ? shock : ''}" placeholder="Enter a price move"></label><label>Assumed share of OI · %<input type="number" name="session-share" data-session-field="positionScale" data-session-committed="${finite(positionScale) ? positionScale : 1}" inputmode="decimal" min="0" max="100" step="5" value="${finite(positionScale) ? positionScale * 100 : 100}"></label><div class="session-scope"><strong>${esc(props.inventoryLabel ?? 'Selected hypothetical inventory')}</strong><span>Watched strikes · selected expiry${hasCoverage ? ` · ${number(calibratedSeriesCount, 0)} / ${number(selectedSeriesCount, 0)} point-value series` : ''}</span></div></div>
      <div class="session-window-heading"><strong>New York time window</strong><span>${esc(historyStatus)}</span></div>
      ${assumedVolume ? '<p class="session-volume-assumption">Volume units: assumed native contracts</p>' : ''}
      <div class="session-window-tabs" role="tablist" aria-label="Historical session comparison window">${windows.map(window => `<button type="button" role="tab" data-session-window="${esc(window.id)}" aria-selected="${window.id === selected.id}" tabindex="${window.id === selected.id ? 0 : -1}">${esc(window.label)}${window.extra ? '<small>Added window</small>' : ''}</button>`).join('')}</div>
      ${props.historyMessage ? `<p class="session-history-message"${props.historyStatus === 'error' ? ' role="alert"' : ''}>${esc(props.historyMessage)}</p>` : ''}
      ${props.error ? `<p class="session-error" role="alert">${esc(props.error)}</p>` : ''}
      ${showSmallMove ? `<p class="session-small-move">The current Gamma approximation needs a smaller move. <button type="button" class="text-button" data-session-small-move="${linearLimit}">Use ${number(linearLimit)} points</button></p>` : ''}
      <div class="session-flow-grid">${flowCard('up', props, selected)}${flowCard('down', props, selected)}</div>
      ${hasImpact ? `<div class="session-impact-scale"><div><span>ILLUSTRATIVE IMPACT SCALE · ${esc(selected.label)} NY</span><strong>${impactText(selected.up?.stressImpactPoints)} <small>if up</small><span aria-hidden="true"> / </span>${impactText(selected.down?.stressImpactPoints)} <small>if down</small></strong></div><div class="session-impact-scale-caption"><p>Assumed Y = ${number(coefficient, 3)}. This is a stress scenario, not a measured share of the price move.</p><button type="button" class="text-button" data-session-clear-impact>Clear impact assumption</button></div></div>` : '<div class="session-no-impact"><p>Point impact is not calibrated. The flow estimates above show buying or selling size.</p><button type="button" class="button button-secondary" data-session-impact-example>Show Y = 1 stress example</button><span>An explicit illustration, not a forecast.</span></div>'}
      ${stressComparison ? `<p class="session-history-message">Stress size vs chosen move · up ${windowPercent(selected.up?.stressVsConditioningMove)} / down ${windowPercent(selected.down?.stressVsConditioningMove)} · size comparison only${assumedVolume ? ' · volume assumed' : ''}</p>` : ''}
      ${hasImpact && stressReason(selected) ? `<p class="session-history-message">${esc(stressReason(selected))}</p>` : ''}
      <details class="session-impact-assumptions"><summary>Impact assumptions</summary><div class="session-assumption-fields"><label>Impact factor Y · optional assumption<input type="number" name="session-coefficient" data-session-field="impactCoefficient" data-session-committed="${hasImpact ? coefficient : ''}" inputmode="decimal" min="0" step="0.1" value="${hasImpact ? coefficient : ''}" placeholder="Uncalibrated"></label><label>Historical volatility multiplier<input type="number" name="session-volatility" data-session-field="volatilityScale" data-session-committed="${positive(volatilityScale) ? volatilityScale : 1}" inputmode="decimal" min="0" step="0.1" value="${positive(volatilityScale) ? volatilityScale : 1}"></label></div>${analysis?.volumeUnit !== 'contracts' ? `<label class="session-volume-choice"><input type="checkbox" data-session-field="allowUnverifiedContractVolume"${props.allowUnverifiedContractVolume === true ? ' checked' : ''}><span>Treat native futures volume as contracts (assumption)<small>Reported volume units have not been independently verified.</small></span></label>` : ''}<p>Illustrative points = direction × Y × historical volatility scale × volatility multiplier × √(net flow / window volume). Volume is total trading activity, not available market depth.</p></details>
      ${renderWindowTable(windows, selected.id, hasImpact)}
      <p class="session-method-note">Conditional inventory scenario. Historical comparisons do not establish actual dealer trades or causal price impact. Option time and IV stay at this snapshot.</p>
    </div>`;
  const assumptions = root.querySelector?.('.session-impact-assumptions');
  if (assumptions && typeof priorAssumptionsOpen === 'boolean') assumptions.open = priorAssumptionsOpen;
  if (focusedField) {
    const input = root.querySelector?.(`input[data-session-field="${focusedField.field}"]`);
    if (input) {
      if (input.type === 'checkbox') input.checked = focusedField.checked === true;
      else input.value = focusedField.value ?? '';
      input.focus?.({ preventScroll: true });
      if (Number.isInteger(focusedField.start) && Number.isInteger(focusedField.end)) {
        try { input.setSelectionRange?.(focusedField.start, focusedField.end, focusedField.direction ?? 'none'); } catch { /* Number inputs do not support selection ranges. */ }
      }
    }
  }
  if (root.dataset) root.dataset.sessionRendering = 'false';
}

export function bindSessionImpact(root, { onChange = () => {}, onRefreshHistory = () => {} } = {}) {
  if (!root || root.dataset?.sessionBound === 'true') return;
  if (root.dataset) root.dataset.sessionBound = 'true';
  function commitField(event, onFocusOut = false) {
    if (root.dataset?.sessionRendering === 'true' || typeof root.contains === 'function' && !root.contains(event.target)) return;
    const field = event.target?.dataset?.sessionField;
    if (field === 'allowUnverifiedContractVolume') { if (!onFocusOut) onChange({ allowUnverifiedContractVolume: event.target.checked === true }); return; }
    if (!['shockPoints', 'positionScale', 'impactCoefficient', 'volatilityScale'].includes(field)) return;
    const text = String(event.target.value ?? '').trim(), value = text === '' ? null : Number(text);
    if (!(field === 'impactCoefficient' && value === null) && (!finite(value) || (field === 'positionScale' && (value < 0 || value > 100)) || (field === 'impactCoefficient' && value < 0) || (['shockPoints', 'volatilityScale'].includes(field) && value <= 0))) {
      event.target.setCustomValidity?.('Enter a valid positive value. OI share must be between 0 and 100.');
      event.target.reportValidity?.(); return;
    }
    event.target.setCustomValidity?.('');
    const committed = field === 'positionScale' ? value / 100 : value;
    const baseline = event.target.dataset.sessionCommitted;
    if (baseline !== undefined && Object.is(baseline === '' ? null : Number(baseline), committed)) return;
    event.target.dataset.sessionCommitted = committed === null ? '' : String(committed);
    onChange({ [field]: committed });
  }
  root.addEventListener('change', event => commitField(event));
  root.addEventListener('focusout', event => commitField(event, true));
  root.addEventListener('click', event => {
    const window = event.target?.closest?.('[data-session-window]');
    if (window && WINDOWS.some(item => item.id === window.dataset.sessionWindow)) { onChange({ windowId: window.dataset.sessionWindow }); return; }
    if (event.target?.closest?.('[data-session-refresh]')) { onRefreshHistory(); return; }
    if (event.target?.closest?.('[data-session-impact-example]')) { onChange({ impactCoefficient: 1 }); return; }
    if (event.target?.closest?.('[data-session-clear-impact]')) { onChange({ impactCoefficient: null }); return; }
    const smallMove = event.target?.closest?.('[data-session-small-move]');
    if (positive(Number(smallMove?.dataset?.sessionSmallMove))) onChange({ shockPoints: Number(smallMove.dataset.sessionSmallMove) });
  });
  root.addEventListener('keydown', event => {
    const tab = event.target?.closest?.('[role="tab"][data-session-window]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = WINDOWS.findIndex(window => window.id === tab.dataset.sessionWindow);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? WINDOWS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + WINDOWS.length) % WINDOWS.length;
    onChange({ windowId: WINDOWS[next].id });
    root.querySelector?.(`[role="tab"][data-session-window="${WINDOWS[next].id}"]`)?.focus();
  });
}
