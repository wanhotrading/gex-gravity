import test from 'node:test';
import assert from 'node:assert/strict';
import { toNewYorkInput, newYorkToIso, parseWatchLevels, validateReading, applyReading } from './manual-workflow.mjs';

const now = Date.parse('2026-11-04T15:00:00Z');
function input(overrides = {}) {
  return { contract: 'NQZ6', futuresPrice: '28720.25', asOf: '2026-11-04T14:45:00Z',
    ivPercent: '20', optionType: 'put', expiry: '', exerciseStyle: '',
    observedDelta: '', observedGamma: '', openInterest: '', ...overrides };
}

test('New York 09:45 converts correctly in winter and summer', () => {
  assert.equal(toNewYorkInput('2026-01-15T14:45:00Z'), '2026-01-15T09:45');
  assert.equal(toNewYorkInput('2026-07-15T13:45:00Z'), '2026-07-15T09:45');
  assert.equal(newYorkToIso('2026-01-15T09:45'), '2026-01-15T14:45:00.000Z');
  assert.equal(newYorkToIso('2026-07-15T09:45'), '2026-07-15T13:45:00.000Z');
  assert.equal(newYorkToIso('2026-11-04T09:45'), '2026-11-04T14:45:00.000Z');
  assert.equal(toNewYorkInput(Date.parse('2026-07-15T13:45:29Z')), '2026-07-15T09:45');
});

test('New York nonexistent and ambiguous DST minutes are rejected', () => {
  assert.throws(() => newYorkToIso('2026-03-08T02:30'), /does not exist/);
  assert.throws(() => newYorkToIso('2026-11-01T01:30'), /ambiguous/);
  assert.equal(newYorkToIso('2026-03-08T03:00'), '2026-03-08T07:00:00.000Z');
  assert.equal(newYorkToIso('2026-11-01T02:00'), '2026-11-01T07:00:00.000Z');
  for (const local of ['2026-02-30T09:45', '2026-01-01T24:00', '2026-13-01T09:00', 'bad', '2026-07-15T09:45Z']) {
    assert.throws(() => newYorkToIso(local));
  }
  assert.throws(() => toNewYorkInput('2026-07-15T09:45'), /UTC offset/);
});

test('watch levels parse comma or whitespace columns and GEX suffixes', () => {
  assert.deepEqual(parseWatchLevels('28750,-107.84K\n28700 -23.62k\r\n\n28650, +1.5M\n70.25 0\n70.5 −.25B'), [
    { strike: 28750, gex: -107840 }, { strike: 28700, gex: -23620 },
    { strike: 28650, gex: 1500000 }, { strike: 70.25, gex: 0 },
    { strike: 70.5, gex: -250000000 },
  ]);
});

test('parser rejects ambiguous thousands, duplicate strikes and malformed lines', () => {
  for (const text of ['', '28,750,-107K', '28,750 -107K', '28750 -107,840',
    '28750 -100K extra', '28750', '0,-1K', '-70,-1K', 'NaN,1', '1,Infinity',
    '28750 -1K\n28750.0 -2K', '28750 $10K', '1,1e309']) {
    assert.throws(() => parseWatchLevels(text));
  }
});

test('parser enforces the 10,000-level bound', () => {
  const lines = Array.from({ length: 10000 }, (_, i) => `${i + 1},-1K`);
  assert.equal(parseWatchLevels(lines.join('\n')).length, 10000);
  assert.throws(() => parseWatchLevels([...lines, '10001,-1K'].join('\n')), /10,000/);
  assert.throws(() => parseWatchLevels(' '.repeat(1024 * 1024 + 1)), /too large/);
});

test('reading converts IV percentage and preserves optional missing values', () => {
  const reading = validateReading(input(), { now });
  assert.deepEqual(reading, {
    contract: 'NQZ6', futuresPrice: 28720.25, asOf: '2026-11-04T14:45:00.000Z',
    iv: 0.2, optionType: 'put', expiry: null, exerciseStyle: null,
    allowEuropeanApproximation: false, observedDelta: null, observedGamma: null,
    openInterest: null, provider: 'Futu manual reading',
  });
  const zeroes = validateReading(input({ observedDelta: '0', observedGamma: 0, openInterest: '0' }), { now });
  assert.equal(zeroes.observedDelta, 0);
  assert.equal(zeroes.observedGamma, 0);
  assert.equal(zeroes.openInterest, 0);
});

test('reading supports decimal commodity prices and explicit model approximation', () => {
  const reading = validateReading(input({ contract: ' CLZ6 ', futuresPrice: '70.38', ivPercent: '34.5',
    optionType: 'CALL', expiry: '2026-11-04T16:00:00-05:00', exerciseStyle: 'American',
    allowEuropeanApproximation: true, observedDelta: '.5', observedGamma: '.012', openInterest: '1234' }), { now });
  assert.equal(reading.contract, 'CLZ6');
  assert.equal(reading.futuresPrice, 70.38);
  assert.equal(reading.iv, 0.345);
  assert.equal(reading.expiry, '2026-11-04T21:00:00.000Z');
  assert.equal(reading.optionType, 'call');
  assert.equal(reading.exerciseStyle, 'american');
  assert.equal(reading.allowEuropeanApproximation, true);
});

test('reading validates required numbers, optional bounds and explicit time zones', () => {
  const invalid = [
    { contract: '' }, { futuresPrice: '' }, { futuresPrice: 0 }, { futuresPrice: Infinity },
    { futuresPrice: '28,720' }, { ivPercent: '' }, { ivPercent: 0 }, { ivPercent: -20 }, { ivPercent: 1000.01 },
    { optionType: '' }, { optionType: 'both' }, { observedDelta: 1.01 }, { observedDelta: -1.01 },
    { observedGamma: -1 }, { openInterest: 1.5 }, { openInterest: -1 }, { observedDelta: false },
    { exerciseStyle: 'unknown' }, { allowEuropeanApproximation: 'true' },
    { asOf: '2026-11-04T14:45:00' }, { asOf: '2026-02-30T14:45:00Z' },
    { expiry: '2026-11-04T14:45:00Z' }, { expiry: '2026-11-04T14:44:00Z' },
    { expiry: '2026-11-04T21:00:00' },
  ];
  for (const override of invalid) assert.throws(() => validateReading(input(override), { now }), JSON.stringify(override));
  assert.throws(() => validateReading(input({ asOf: '2026-11-04T15:05:01Z' }), { now }), /future/);
  assert.equal(validateReading(input({ asOf: '2026-11-04T15:05:00Z' }), { now }).asOf, '2026-11-04T15:05:00.000Z');
  assert.equal(validateReading(input({ ivPercent: 1000 }), { now }).iv, 10);
});

function baseline() {
  return { contract: 'NQZ6', futuresPrice: 28800, asOf: '2026-11-04T14:45:00.000Z',
    source: { provider: 'Morning GEX plan', status: 'snapshot' },
    levels: [
      { _key: 'a', strike: 28750, gex: -107840, modelBasis: 'aggregate', iv: null },
      { _key: 'b', strike: 28700, gex: -23620, otherMetadata: { keep: true } },
    ] };
}

test('applying one reading preserves baseline, original GEX and every other row', () => {
  const snapshot = baseline();
  const reading = validateReading(input({ asOf: '2026-11-04T14:55:00Z' }), { now });
  const updated = applyReading(snapshot, 'a', reading);
  assert.notEqual(updated, snapshot);
  assert.notEqual(updated.levels, snapshot.levels);
  assert.notEqual(updated.levels[0], snapshot.levels[0]);
  assert.equal(updated.levels[1], snapshot.levels[1]);
  assert.equal(updated.source, snapshot.source);
  assert.equal(updated.futuresPrice, 28800);
  assert.equal(updated.asOf, '2026-11-04T14:45:00.000Z');
  assert.equal(updated.levels[0].gex, -107840);
  assert.equal(updated.levels[0].iv, null);
  assert.equal(updated.levels[0].modelBasis, 'aggregate');
  assert.deepEqual(updated.levels[0].reading, reading);
  assert.notEqual(updated.levels[0].reading, reading);
  assert.equal(snapshot.levels[0].reading, undefined);
  assert.equal(updated.levels[1].reading, undefined);
});

test('contract mismatches, missing rows and older saved readings are rejected', () => {
  const snapshot = baseline();
  const reading = validateReading(input({ asOf: '2026-11-04T14:55:00Z' }), { now });
  const saved = applyReading(snapshot, 'a', reading);
  assert.throws(() => applyReading(snapshot, 'a', { ...reading, contract: 'NQH7' }), /same exact/);
  assert.throws(() => applyReading(snapshot, 'missing', reading), /existing/);
  assert.throws(() => applyReading(saved, 'a', { ...reading, asOf: '2026-11-04T14:54:59Z' }), /older/);
  assert.equal(applyReading(snapshot, 'a', { ...reading, contract: ' nqz6 ' }).levels[0].reading.contract, ' nqz6 ');
  const newer = applyReading(saved, 'a', { ...reading, asOf: '2026-11-04T14:56:00Z' });
  assert.equal(newer.levels[0].reading.asOf, '2026-11-04T14:56:00Z');
  assert.equal(newer.levels[1], snapshot.levels[1]);
});

test('a chain reading cannot precede the morning watch-plan observation', () => {
  const snapshot = baseline();
  const beforeMorning = validateReading(input({ asOf: '2026-11-04T14:44:59Z' }), { now });
  assert.throws(() => applyReading(snapshot, 'a', beforeMorning), /older than the morning watch plan/);
  const atMorning = validateReading(input({ asOf: snapshot.asOf }), { now });
  assert.equal(applyReading(snapshot, 'a', atMorning).levels[0].reading.asOf, snapshot.asOf);
  assert.equal(snapshot.levels[0].reading, undefined);
});
