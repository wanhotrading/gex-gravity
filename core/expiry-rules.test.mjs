import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCmeWeeklyExpiry, EXPIRY_RULE_VERSION, EXPIRY_RULE_SOURCES } from './expiry-rules.mjs';

const nq = { market: 'NQ', code: 'US.Q1C2611', expiration_cycle: 'WEEKWED', expiry_date: '2026-11-04' };

test('observed NQ Wednesday/Thursday roots resolve to 16 New York, after the November DST transition', () => {
  const wed = resolveCmeWeeklyExpiry(nq);
  assert.equal(wed.status, 'resolved');
  assert.equal(wed.expiry, '2026-11-04T21:00:00.000Z');
  assert.equal(wed.exerciseStyle, 'european');
  assert.equal(wed.ruleVersion, EXPIRY_RULE_VERSION);
  assert.ok(wed.provenance.sources.includes(EXPIRY_RULE_SOURCES.nqWeekly));
  const thu = resolveCmeWeeklyExpiry({ market: 'NQ', code: 'US.Q1D2611P28750', expiration_cycle: 'WEEKTHU', expiry_date: '2026-11-05' });
  assert.equal(thu.expiry, '2026-11-05T21:00:00.000Z');
});

test('actual Futu option suffix x0 is accepted exactly; arbitrary suffixes are rejected', () => {
  for (const code of ['US.Q1C2611C28750x0', 'US.Q1C2611P28750x0']) {
    const result = resolveCmeWeeklyExpiry({ ...nq, code });
    assert.equal(result.status, 'resolved');
    assert.equal(result.expiry, '2026-11-04T21:00:00.000Z');
  }
  const thursday = resolveCmeWeeklyExpiry({ ...nq, code: 'US.Q1D2611P28750x0', expiration_cycle: 'WEEKTHU', expiry_date: '2026-11-05' });
  assert.equal(thursday.status, 'resolved');
  assert.equal(thursday.expiry, '2026-11-05T21:00:00.000Z');
  for (const code of ['US.Q1C2611C28750x1', 'US.Q1C2611C28750x00', 'US.Q1C2611C28750junk', 'US.Q1C2611x0']) {
    assert.equal(resolveCmeWeeklyExpiry({ ...nq, code }).status, 'unresolved');
  }
});

test('ordinal week is the nth occurrence of that weekday within the month', () => {
  // November 2026 starts on Sunday: days 1..7 contain each first weekday,
  // days 8..14 each second weekday, etc. The rule also holds in every month.
  const result = resolveCmeWeeklyExpiry({ ...nq, code: 'Q3C2611', expiry_date: '2026-11-18' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.productRoot, 'Q3C');
  assert.equal(resolveCmeWeeklyExpiry({ ...nq, code: 'Q2C2611', expiry_date: '2026-11-18' }).reason, 'product-week-number-and-expiration-date-conflict');
});

test('IANA time conversion handles the DST season without a hard-coded UTC offset', () => {
  const summer = resolveCmeWeeklyExpiry({ market: 'NQ', code: 'Q1C2606', expiration_cycle: 'WEEKWED', expiry_date: '2026-06-03' });
  assert.equal(summer.status, 'resolved');
  assert.equal(summer.expiry, '2026-06-03T20:00:00.000Z');
  const beforeFall = resolveCmeWeeklyExpiry({ market: 'NQ', code: 'Q5D2610', expiration_cycle: 'WEEKTHU', expiry_date: '2026-10-29' });
  assert.equal(beforeFall.expiry, '2026-10-29T20:00:00.000Z');
});

test('documented ES weekday and Friday weekly roots resolve with matching metadata', () => {
  for (const [code, cycle, date] of [
    ['E1A2611', 'WEEKMON', '2026-11-02'],
    ['E1B2611', 'WEEKTUE', '2026-11-03'],
    ['E1C2611', 'WEEKWED', '2026-11-04'],
    ['E1D2611', 'WEEKTHU', '2026-11-05'],
    ['EW12611', 'WEEKFRI', '2026-11-06'],
  ]) {
    const result = resolveCmeWeeklyExpiry({ market: 'ES', code, expiration_cycle: cycle, expiry_date: date });
    assert.equal(result.expiry, `${date}T21:00:00.000Z`);
    assert.equal(result.exerciseStyle, 'european');
  }
});

test('missing, conflicting and unknown metadata never falls back to an assumed time', () => {
  for (const [changes, reason] of [
    [{ expiry_date: undefined }, 'valid-provider-expiration-date-required'],
    [{ expiry_date: '2026-11-31' }, 'valid-provider-expiration-date-required'],
    [{ code: 'NQ2612' }, 'recognized-weekly-product-code-required'],
    [{ market: 'CL', code: 'LO2612' }, 'product-family-not-reviewed'],
    [{ market: 'ES' }, 'market-and-product-code-conflict'],
    [{ code: 'Q1C2612' }, 'code-period-and-expiration-date-conflict'],
    [{ expiry_date: '2026-11-05' }, 'product-weekday-and-expiration-date-conflict'],
    [{ code: 'Q2C2611' }, 'product-week-number-and-expiration-date-conflict'],
    [{ expiration_cycle: 'MONTH' }, 'expiration-cycle-and-product-code-conflict'],
  ]) {
    const result = resolveCmeWeeklyExpiry({ ...nq, ...changes });
    assert.equal(result.status, 'unresolved');
    assert.equal(result.expiry, null);
    assert.equal(result.reason, reason);
  }
});

test('holiday/early-close review windows and unreviewed calendar years remain unresolved', () => {
  const holiday = resolveCmeWeeklyExpiry({ market: 'NQ', code: 'QN42611', expiration_cycle: 'WEEKFRI', expiry_date: '2026-11-27' });
  assert.equal(holiday.reason, 'holiday-or-special-session-needs-review');
  const nextYear = resolveCmeWeeklyExpiry({ market: 'NQ', code: 'Q1C2701', expiration_cycle: 'WEEKWED', expiry_date: '2027-01-06' });
  assert.equal(nextYear.reason, 'calendar-year-not-reviewed');
});

test('documented weekly root and provider date suffice without guessing from a futures month', () => {
  const input = { ...nq, expiration_cycle: undefined };
  const before = JSON.stringify(input);
  const result = resolveCmeWeeklyExpiry(input);
  assert.equal(result.status, 'resolved');
  assert.equal(result.provenance.expiryDateSource, 'provider option-series expiration date');
  assert.equal(JSON.stringify(input), before);
});
