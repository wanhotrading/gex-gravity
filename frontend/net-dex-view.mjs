import { nyClock } from '../core/market-reading.mjs';

const minute = 60000;
const finite = Number.isFinite;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const strikeLabel = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const clock = value => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(value)) + ' NY';
const compactChange = new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 2, signDisplay: 'exceptZero',
});

export function netDexReading(market, now, allExpiries) {
  const context = market?.watchContext;
  const capture = context?.netDex;
  if (!allExpiries || context?.underlyingCode !== market?.underlyingCode ||
      capture?.scope !== 'all-expiries' || capture.metric !== 'Net DEX') return null;
  const capturedAt = Date.parse(capture.capturedAt);
  if (!finite(capturedAt) || capturedAt > now + minute) return null;
  const rows = (capture.rows ?? []).filter(row => finite(row.strike) && finite(row.value));
  const watched = (context.levels ?? []).filter(level => level.kind !== 'reference').length;
  const current = finite(Date.parse(capture.asOf)) ? Date.parse(capture.asOf) : capturedAt;
  const sourceClock = finite(Date.parse(capture.asOf));
  const candidates = (capture.history ?? []).map(row => ({
    time: Date.parse(sourceClock ? row.asOf : row.capturedAt),
    value: row.aggregateValue,
  })).filter(row => finite(row.time) && finite(row.value) && row.time < current && nyClock(row.time).date === nyClock(current).date);
  const changes = [15, 60].map(minutes => {
    const target = current - minutes * minute;
    const closest = candidates.reduce((best, row) =>
      !best || Math.abs(row.time - target) < Math.abs(best.time - target) ? row : best, null);
    if (!closest || Math.abs(closest.time - target) > 3 * minute || !finite(capture.aggregateValue)) return { minutes };
    return { minutes, value: capture.aggregateValue - closest.value, elapsed: Math.round((current - closest.time) / minute) };
  });
  const inSession = nyClock(now);
  const marketHours = inSession.minute >= 575 && inSession.minute <= 960 && !['Sat', 'Sun'].includes(inSession.weekday);
  const older = marketHours ? now - capturedAt > 15 * minute : now - capturedAt > 36 * 60 * minute;
  return { ...capture, rows, watched, changes, sourceClock, older, scale: Math.max(0, ...rows.map(row => Math.abs(row.value))) };
}

export function netDexSummary(dex, { allExpiries, selectedStrike } = {}) {
  const empty = allExpiries
    ? 'Waiting for a saved Net DEX capture for this futures contract.'
    : 'Select all expiries to compare the saved Net DEX with the curve.';
  if (!dex) return `<p class="reading-dex-status">${empty}</p>`;
  const selected = dex.rows.find(row => row.strike === selectedStrike);
  return `<section class="reading-dex-summary" aria-label="MenthorQ Net DEX reading">
    <div class="reading-dex-metrics"><div><span>Total Net DEX · all expiries</span><strong>${escape(dex.aggregateDisplay)}</strong></div>
    ${dex.changes.map(change => `<div><span>${change.elapsed ?? change.minutes}m snapshot change</span><strong>${finite(change.value) ? compactChange.format(change.value) : '—'}</strong></div>`).join('')}
    ${finite(selectedStrike) ? `<div><span>Strike ${strikeLabel(selectedStrike)} · Net DEX</span><strong>${selected ? escape(selected.display) : '—'}</strong></div>` : ''}
    </div>
    <p>MenthorQ · ${dex.rows.length}/${dex.watched} watched strikes · ${escape(dex.mode)} · checked ${clock(dex.capturedAt)}${dex.older ? ' · older capture' : ''} · ${dex.sourceClock ? 'source ' + clock(dex.asOf) : 'source clock unverified'}${dex.delayStatus === 'delayed' ? ' · delayed' : ''}.</p>
    <p>Bars show estimated directional exposure and scale to the largest captured strike. Changes compare matching snapshots in provider units.</p>
  </section>`;
}

export function netDexPlot(dex, { x, left, right, top, height, lo, hi, selectedStrike }) {
  const rows = dex.rows.filter(row => row.strike >= lo && row.strike <= hi).sort((a, b) => a.strike - b.strike);
  const zero = top + height * .58;
  const half = height * .29;
  const spacing = rows.slice(1).reduce((min, row, index) => Math.min(min, x(row.strike) - x(rows[index].strike)), 19);
  const width = Math.max(2, Math.min(10, spacing * .58));
  return `<g class="reading-dex-plot" role="group" aria-label="MenthorQ Net DEX by strike, all expiries. Positive extends above zero, negative below.">
    <rect x="${left}" y="${top}" width="${right-left}" height="${height}" rx="6" fill="#11182a"/>
    <text x="${left+12}" y="${top+20}" class="reading-dex-axis-title">Net DEX by strike</text>
    <line x1="${left}" x2="${right}" y1="${zero}" y2="${zero}" stroke="#a4b3d0" stroke-opacity=".48"/>
    <text x="${left-12}" y="${zero+5}" text-anchor="end">0</text>
    ${rows.map(row => {
      const position = x(row.strike);
      const barLeft = Math.max(left, position - width / 2);
      const barWidth = Math.min(right, position + width / 2) - barLeft;
      const amount = dex.scale > 0 ? Math.abs(row.value) / dex.scale : 0;
      const size = row.value === 0 ? 2 : Math.max(2, amount * half);
      const y = row.value > 0 ? zero - size : row.value < 0 ? zero : zero - size/2;
      const color = row.value > 0 ? '#8acdea' : row.value < 0 ? '#efa58e' : '#a4b3d0';
      const stroke = row.strike === selectedStrike ? ' stroke="#fff3da" stroke-width="1.4"' : '';
      return `<rect x="${barLeft}" y="${y}" width="${barWidth}" height="${size}" fill="${color}" rx="1"${stroke}><title>Strike ${strikeLabel(row.strike)} · Net DEX ${escape(row.display)}</title></rect>`;
    }).join('')}
    ${rows.length ? '' : `<text x="${(left+right)/2}" y="${zero+24}" text-anchor="middle">No captured DEX strikes in this price window</text>`}
  </g>`;
}

export function netDexAtProbe(dex, curve, price) {
  if (price < curve.lo || price > curve.hi) return '';
  let nearest = null;
  for (const row of dex.rows) {
    if (row.strike < curve.lo || row.strike > curve.hi) continue;
    if (!nearest || Math.abs(row.strike - price) < Math.abs(nearest.strike - price)) nearest = row;
  }
  if (!nearest || Math.abs(nearest.strike - price) > (curve.hi-curve.lo) * .012) return '';
  return `Net DEX at strike ${strikeLabel(nearest.strike)} · ${nearest.display}`;
}
