import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCmeClOption, resolveCmeClExpiry } from './cl-expiry-rules.mjs';

const base = { market: 'CL', code: 'US.WL12611C101x0', expiry_date: '2026-11-04',
  expiration_cycle: 'WEEKWED', underlyingCode: 'US.CL2612' };

test('observed standard CL weekday roots classify as American, 1000 barrels', () => {
  for (const [root, date, cycle] of [
    ['ML2', '2026-11-09', 'WEEKMON'], ['NL2', '2026-11-10', 'WEEKTUE'],
    ['WL1', '2026-11-04', 'WEEKWED'], ['XL1', '2026-11-05', 'WEEKTHU'],
    ['LO1', '2026-11-06', 'WEEKFRI'], ['LO2', '2026-11-13', 'WEEKFRI'],
    ['ML3', '2026-11-16', 'WEEKMON'],
  ]) {
    const value = classifyCmeClOption({ ...base, code: `US.${root}2611P101x0`, expiry_date: date, expiration_cycle: cycle });
    assert.equal(value.status, 'resolved', root);
    assert.equal(value.exerciseStyle, 'american', root);
    assert.equal(value.contractMultiplier, 1000);
    assert.equal(value.americanApproximationRequiresOptIn, true);
    assert.equal(value.automaticModelAllowed, false);
    assert.equal(value.expiry, null);
    assert.equal(value.underlyingCode, 'US.CL2612');
  }
});

test('LO and LCE monthly period follows provider underlying, not expiry month', () => {
  for (const [root, style, settlement] of [['LO', 'american', 'exercise-into-futures'], ['LCE', 'european', 'financial']]) {
    const value = classifyCmeClOption({ ...base, code: `US.${root}2612C101x0`, expiry_date: '2026-11-17', expiration_cycle: 'MONTH' });
    assert.equal(value.status, 'resolved');
    assert.equal(value.productFamily, 'monthly');
    assert.equal(value.exerciseStyle, style);
    assert.equal(value.settlementType, settlement);
    assert.equal(value.contractMultiplier, 1000);
    assert.equal(value.expiry, null);
    assert.equal(value.americanApproximationRequiresOptIn, style === 'american');
    assert.equal(value.automaticModelAllowed, false, 'An exact timestamp is still required for European modelling.');
  }
});

test('actual CL x5 half-strike and decimal suffixes require the exact provider strike',()=>{
  for(const [encoded,strike] of [['95x5',95.5],['95x25',95.25],['95x75',95.75],['95x05',95.05],['95x125',95.125]]){
    const input={...base,code:`US.WL12611C${encoded}`,strike};
    const value=classifyCmeClOption(input);
    assert.equal(value.status,'resolved',encoded);
    assert.equal(value.codeStrike,strike);
    assert.equal(value.strikeVerification,'provider-strike-crosschecked');
    assert.equal(value.exerciseStyle,'american');
    assert.equal(value.contractMultiplier,1000);
    assert.equal(value.expiry,null);
    assert.equal(value.automaticModelAllowed,false);
    assert.equal(resolveCmeClExpiry(input).expiry,'2026-11-04T19:30:00.000Z');
  }
  const monthly=classifyCmeClOption({...base,code:'US.LCE2612P95x25',strike:95.25,expiry_date:'2026-11-17',expiration_cycle:'MONTH'});
  assert.equal(monthly.exerciseStyle,'european');
  assert.equal(monthly.codeStrike,95.25);
  assert.equal(monthly.expiry,null);
});

test('suffix mismatches, missing metadata, ambiguous encoding and arbitrary suffixes fail closed',()=>{
  for(const [code,strike,reason] of [
    ['US.WL12611C95x5',95,'code-strike-and-provider-strike-conflict'],
    ['US.WL12611C95x25',95.5,'code-strike-and-provider-strike-conflict'],
    ['US.WL12611C95x5',undefined,'provider-strike-required-for-decimal-suffix'],
    ['US.WL12611C95x5',null,'provider-strike-required-for-decimal-suffix'],
    ['US.WL12611C95x5','95.5','valid-provider-strike-required'],
    ['US.WL12611C95x5',NaN,'valid-provider-strike-required'],
    ['US.WL12611C95x5',-95.5,'valid-provider-strike-required'],
    ['US.WL12611C95.5x5',95.55,'ambiguous-cl-strike-encoding'],
    ['US.WL12611C95x500000000000000000001',95.5,'code-strike-and-provider-strike-conflict'],
    ['US.WL12611C95x0',95.5,'code-strike-and-provider-strike-conflict'],
    ['US.WL12611C95x5junk',95.5,'recognized-cl-product-code-required'],
    ['US.WL12611C95xfoo',95.5,'recognized-cl-product-code-required'],
    ['US.WL12611C95x-5',95.5,'recognized-cl-product-code-required'],
    ['US.WL12611C95x.5',95.5,'recognized-cl-product-code-required'],
    ['US.WL12611C95x5x0',95.5,'recognized-cl-product-code-required'],
  ]){
    const value=classifyCmeClOption({...base,code,strike});
    assert.equal(value.status,'unresolved',code);
    assert.equal(value.reason,reason,code);
    assert.equal(value.exerciseStyle,null);
    assert.equal(value.contractMultiplier,null);
    assert.equal(value.expiry,null);
  }
  assert.equal(classifyCmeClOption({...base,code:'US.WL12611C95x0',strike:95}).status,'resolved');
  assert.equal(classifyCmeClOption({...base,code:'US.WL12611C95.5',strike:95.5}).status,'resolved');
});

test('exact expiry resolver never substitutes general trading or clearing hours', () => {
  for (const input of [{ ...base, code: 'US.LCE2612C101x0', expiry_date: '2026-11-17', expiration_cycle: 'MONTH' }]) {
    const value = resolveCmeClExpiry(input);
    assert.equal(value.status, 'unresolved');
    assert.equal(value.classificationStatus, 'resolved');
    assert.equal(value.reason, 'exact-cl-expiration-clock-not-verified');
    assert.equal(value.expiry, null);
    assert.equal(value.provenance.expirationClock, null);
    assert.equal(value.automaticModelAllowed, false);
  }
});

test('American CL weekly and monthly clocks resolve with separate broker and CME provenance', () => {
  for(const [root,date,cycle] of [
    ['ML2','2026-11-09','WEEKMON'],['NL2','2026-11-10','WEEKTUE'],
    ['WL1','2026-11-04','WEEKWED'],['XL1','2026-11-05','WEEKTHU'],
    ['LO1','2026-11-06','WEEKFRI'],['LO','2026-11-17','MONTH'],
  ]) {
    const result=resolveCmeClExpiry({...base,code:`US.${root}${root==='LO'?'2612':'2611'}C101x0`,expiry_date:date,expiration_cycle:cycle});
    assert.equal(result.status,'resolved',root);
    assert.equal(result.expiry,`${date}T19:30:00.000Z`);
    assert.equal(result.exerciseStyle,'american');
    assert.equal(result.automaticModelAllowed,true);
    assert.equal(result.provenance.expirationTimeZone,'America/New_York');
    assert.ok(result.provenance.sources.some(url=>url.includes('tastytrade.com')));
    assert.equal(!!result.provenance.clockInference,/^(NL|XL)/.test(root));
  }
});

test('CL clock conversion handles both DST seasons rather than a fixed UTC offset',()=>{
  for(const [code,date,expected] of [['US.WL12606C101x0','2026-06-03','18:30'],['US.LO52610C101x0','2026-10-30','18:30'],['US.WL12611C101x0','2026-11-04','19:30']]) {
    const cycle=code.includes('LO5')?'WEEKFRI':'WEEKWED';
    assert.equal(resolveCmeClExpiry({...base,code,expiry_date:date,expiration_cycle:cycle}).expiry,`${date}T${expected}:00.000Z`);
  }
});

test('Thanksgiving, Christmas and unknown products cannot silently inherit the normal CL clock',()=>{
  for(const [code,date,cycle] of [['US.XL42611C101x0','2026-11-26','WEEKTHU'],['US.LO42611C101x0','2026-11-27','WEEKFRI'],['US.XL42612C101x0','2026-12-24','WEEKTHU']]) {
    const result=resolveCmeClExpiry({...base,code,expiry_date:date,expiration_cycle:cycle});
    assert.equal(result.expiry,null);assert.equal(result.reason,'holiday-or-special-session-needs-review');
  }
});

test('0DTE date, weekly month, weekday, week number and cycle must agree', () => {
  for (const [patch, reason] of [
    [{ expiry_date: '2026-11-05' }, 'product-weekday-and-expiration-date-conflict'],
    [{ code: 'US.WL22611C101x0' }, 'product-week-number-and-expiration-date-conflict'],
    [{ code: 'US.WL12612C101x0' }, 'code-period-and-expiration-date-conflict'],
    [{ expiration_cycle: 'MONTH' }, 'expiration-cycle-and-product-code-conflict'],
    [{ expiry_date: '2026-02-30' }, 'valid-provider-expiration-date-required'],
    [{ underlyingCode: 'US.CLmain' }, 'provider-dated-cl-underlying-required'],
    [{ underlyingCode: 'US.NQ2612' }, 'provider-dated-cl-underlying-required'],
    [{ code: 'US.MW12611C101x0' }, 'recognized-cl-product-code-required'],
    [{ code: 'US.LM12611C101x0' }, 'recognized-cl-product-code-required'],
  ]) assert.equal(classifyCmeClOption({ ...base, ...patch }).reason, reason);
});

test('monthly owner, cycle and impossible delivery period conflicts are rejected', () => {
  const monthly = { ...base, code: 'US.LO2612C101x0', expiry_date: '2026-11-17', expiration_cycle: 'MONTH' };
  assert.equal(classifyCmeClOption({ ...monthly, underlyingCode: 'US.CL2701' }).reason, 'monthly-code-and-provider-underlying-conflict');
  assert.equal(classifyCmeClOption({ ...monthly, expiration_cycle: 'WEEKFRI' }).reason, 'expiration-cycle-and-product-code-conflict');
  assert.equal(classifyCmeClOption({ ...monthly, expiry_date: '2026-12-17' }).reason, 'monthly-expiration-not-before-delivery-month');
  assert.equal(classifyCmeClOption({ ...monthly, expiry_date: '2026-11-15' }).reason, 'monthly-provider-date-not-a-weekday');
});

test('holiday and unreviewed-year dates retain style but do not resolve expiry', () => {
  const holiday = resolveCmeClExpiry({ ...base, code: 'US.WL22611C101x0', expiry_date: '2026-11-11' });
  assert.equal(holiday.reason, 'holiday-or-special-session-needs-review');
  assert.equal(holiday.exerciseStyle, 'american');
  assert.equal(holiday.expiry, null);
  const later = resolveCmeClExpiry({ ...base, code: 'US.WL12701C101x0', expiry_date: '2027-01-06' });
  assert.equal(later.reason, 'calendar-year-not-reviewed');
  assert.equal(later.expiry, null);
});
