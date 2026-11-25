/**
 * Reviewed standard-size NYMEX WTI option identities and exercise styles.
 * CME identifies the families and expiration dates; tastytrade publishes the
 * standard American CL settlement/expiration clock. Tuesday/Thursday inherit
 * the same specifications per CME's FAQ. LCE and exceptional sessions remain
 * unresolved. No clock is borrowed from micro-WTI or general trading hours.
 */
import { newYorkToIso } from './manual-workflow.mjs';

export const CL_EXPIRY_RULE_VERSION = 'cl-american-expiry-2026-11-06.v3';
export const CL_EXPIRY_RULE_CHECKED_ON = '2026-11-06';
export const CL_EXPIRY_RULE_SOURCES = Object.freeze({
  americanClock: 'https://support.tastytrade.com/support/s/solutions/articles/43000503202',
  weekly: 'https://www.cmegroup.com/rulebook/NYMEX/10/1011.pdf',
  weeklyCodesAndSize: 'https://www.cmegroup.com/articles/faqs/faq-tuesday-and-thursday-weekly-wti-options.html',
  weeklyHolidayChange: 'https://www.cmegroup.com/notices/ser/2024/05/SER-9366.pdf',
  monthlyAmerican: 'https://www.cmegroup.com/rulebook/NYMEX/3/310.pdf',
  monthlyEuropean: 'https://www.cmegroup.com/rulebook/NYMEX/5/550.pdf',
  europeanGlobexCode: 'https://www.cmegroup.com/notices/ser/2017/12/SER-8062.pdf',
  calendar: 'https://www.cmegroup.com/trading-hours.html',
});

// Conservative review periods matching the equity module. These are not claims
// that CL is closed on each date; some equity/bank holidays have normal energy
// trading. A product-specific holiday/session review must clear those dates.
const REVIEW_WINDOWS_2026 = Object.freeze([
  ['2026-01-01', '2026-01-02'], ['2026-01-16', '2026-01-20'],
  ['2026-02-13', '2026-02-17'], ['2026-04-02', '2026-04-06'],
  ['2026-05-22', '2026-05-26'], ['2026-06-18', '2026-06-22'],
  ['2026-07-02', '2026-07-06'], ['2026-09-04', '2026-09-08'],
  ['2026-10-12', '2026-10-12'], ['2026-11-11', '2026-11-11'],
  ['2026-11-25', '2026-11-30'], ['2026-12-23', '2026-12-31'],
]);
const WEEKLY = Object.freeze({
  ML: { weekday: 1, cycle: 'WEEKMON' },
  NL: { weekday: 2, cycle: 'WEEKTUE' },
  WL: { weekday: 3, cycle: 'WEEKWED' },
  XL: { weekday: 4, cycle: 'WEEKTHU' },
  LO: { weekday: 5, cycle: 'WEEKFRI' },
});
const clockCache = new Map();
function americanExpiry(date) {
  if (!clockCache.has(date)) {
    if (clockCache.size >= 366) clockCache.clear();
    clockCache.set(date, newYorkToIso(`${date}T14:30`));
  }
  return clockCache.get(date);
}

function dateParts(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = +match[1], month = +match[2], day = +match[3];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, weekday: date.getUTCDay() };
}

function unresolved(reason, detail = null, extra = {}) {
  return {
    status: 'unresolved', expiry: null, exerciseStyle: null,
    contractMultiplier: null, automaticModelAllowed: false,
    americanApproximationRequiresOptIn: false,
    reason, detail, ruleVersion: CL_EXPIRY_RULE_VERSION,
    checkedOn: CL_EXPIRY_RULE_CHECKED_ON, ...extra,
  };
}

// Compare decimal text as well as Numbers, so an excessively precise suffix
// cannot round to a different provider strike and accidentally pass validation.
function decimalIdentity(value) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || !(match[1] || match[2])) return null;
  const whole = (match[1] || '0').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] || '').replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}

function verifyCodeStrike(encodedStrike, suffix, metadataStrike) {
  if (!encodedStrike) return { status: 'series-root-only', value: null };
  const fractionalSuffix = suffix !== undefined && suffix !== '0';
  if (fractionalSuffix && !/^\d+$/.test(encodedStrike)) return { reason: 'ambiguous-cl-strike-encoding' };
  const text = fractionalSuffix ? `${encodedStrike}.${suffix}` : encodedStrike;
  const value = Number(text), identity = decimalIdentity(text);
  if (!identity || !Number.isFinite(value) || value <= 0) return { reason: 'valid-code-strike-required' };
  const supplied = metadataStrike !== null && metadataStrike !== undefined;
  if (fractionalSuffix && !supplied) return { reason: 'provider-strike-required-for-decimal-suffix' };
  if (supplied && (typeof metadataStrike !== 'number' || !Number.isFinite(metadataStrike) || metadataStrike <= 0)) {
    return { reason: 'valid-provider-strike-required' };
  }
  if (supplied && (value !== metadataStrike || identity !== decimalIdentity(String(metadataStrike)))) {
    return { reason: 'code-strike-and-provider-strike-conflict' };
  }
  return { status: supplied ? 'provider-strike-crosschecked' : 'integer-or-literal-code-strike', value };
}

/**
 * Classify only the observed Futu standard-size CL roots. The supplied expiry
 * DATE remains authoritative; the underlying is supplied from stock_owner.
 * Weekly YYMM denotes expiry month; monthly LO/LCE YYMM denotes the underlying
 * contract month and MUST NOT be treated as the expiry month.
 *
 * A resolved classification is NOT a resolved expiry timestamp. No automatic
 * Black-76 or American approximation permission is granted by classification.
 */
export function classifyCmeClOption(input = {}) {
  const { market, code, expiry_date: expiryDate, expiration_cycle: expirationCycle,
    underlyingCode, strike } = input;
  if (market !== 'CL') return unresolved('product-family-not-reviewed');
  const parts = dateParts(expiryDate);
  if (!parts) return unresolved('valid-provider-expiration-date-required');
  const match = typeof code === 'string' && /^(?:US\.)?((?:ML|NL|WL|XL|LO)[1-5]|LCE|LO)(\d{4})(?:([CP])(\d+(?:\.\d*)?|\.\d+)(?:x(\d+))?)?$/i.exec(code.trim());
  if (!match) return unresolved('recognized-cl-product-code-required');
  const codeStrike = verifyCodeStrike(match[4], match[5], strike);
  if (codeStrike.reason) return unresolved(codeStrike.reason);
  const productRoot = match[1].toUpperCase(), period = match[2];
  if (+period.slice(2) < 1 || +period.slice(2) > 12) return unresolved('valid-code-contract-period-required');
  const owner = typeof underlyingCode === 'string' && /^US\.CL(\d{4})$/i.exec(underlyingCode.trim());
  if (!owner || +owner[1].slice(2) < 1 || +owner[1].slice(2) > 12) return unresolved('provider-dated-cl-underlying-required');
  const weekly = /[1-5]$/.test(productRoot);
  const cycle = typeof expirationCycle === 'string' ? expirationCycle.trim().toUpperCase() : null;
  let expirationCycleResolved;
  if (weekly) {
    const dayRule = WEEKLY[productRoot.slice(0, 2)];
    if (+period.slice(0, 2) !== parts.year % 100 || +period.slice(2) !== parts.month) return unresolved('code-period-and-expiration-date-conflict');
    if (parts.weekday !== dayRule.weekday) return unresolved('product-weekday-and-expiration-date-conflict', 'Current CME CL weeklies are not listed on an exchange holiday; a shifted weekday is not inferred.');
    if (Math.ceil(parts.day / 7) !== +productRoot.at(-1)) return unresolved('product-week-number-and-expiration-date-conflict');
    if (cycle && cycle !== 'WEEK' && cycle !== dayRule.cycle) return unresolved('expiration-cycle-and-product-code-conflict');
    expirationCycleResolved = dayRule.cycle;
  } else {
    if (period !== owner[1]) return unresolved('monthly-code-and-provider-underlying-conflict');
    if (parts.weekday === 0 || parts.weekday === 6) return unresolved('monthly-provider-date-not-a-weekday');
    if (cycle && cycle !== 'MONTH') return unresolved('expiration-cycle-and-product-code-conflict');
    // Verify an obvious delivery-period conflict, without deriving or inventing
    // a monthly option expiry from the futures month or a generic US calendar.
    const deliveryYear = 2000 + +period.slice(0, 2), deliveryMonth = +period.slice(2);
    if (Date.UTC(parts.year, parts.month - 1, parts.day) >= Date.UTC(deliveryYear, deliveryMonth - 1, 1)) return unresolved('monthly-expiration-not-before-delivery-month');
    expirationCycleResolved = 'MONTH';
  }
  const exerciseStyle = productRoot === 'LCE' ? 'european' : 'american';
  const sources = weekly
    ? [CL_EXPIRY_RULE_SOURCES.weekly, CL_EXPIRY_RULE_SOURCES.weeklyCodesAndSize, CL_EXPIRY_RULE_SOURCES.weeklyHolidayChange]
    : productRoot === 'LCE'
      ? [CL_EXPIRY_RULE_SOURCES.monthlyEuropean, CL_EXPIRY_RULE_SOURCES.europeanGlobexCode]
      : [CL_EXPIRY_RULE_SOURCES.monthlyAmerican, CL_EXPIRY_RULE_SOURCES.weeklyCodesAndSize];
  const calendarReason = parts.year !== 2026 ? 'calendar-year-not-reviewed'
    : REVIEW_WINDOWS_2026.some(([start, end]) => expiryDate >= start && expiryDate <= end)
      ? 'holiday-or-special-session-needs-review' : null;
  return {
    status: 'resolved', expiry: null, exerciseStyle, productRoot,
    codeStrike: codeStrike.value, strikeVerification: codeStrike.status,
    productFamily: weekly ? 'weekly' : 'monthly', expirationCycle: expirationCycleResolved,
    contractMultiplier: 1000, multiplierUnit: 'barrels',
    settlementType: productRoot === 'LCE' ? 'financial' : 'exercise-into-futures',
    underlyingCode: `US.CL${owner[1]}`, providerExpiryDate: expiryDate,
    calendarStatus: calendarReason ? 'unresolved' : 'standard-session-review-passed',
    calendarReason, exactExpiryStatus: 'unresolved',
    automaticModelAllowed: false,
    americanApproximationRequiresOptIn: exerciseStyle === 'american',
    reason: null, ruleVersion: CL_EXPIRY_RULE_VERSION, checkedOn: CL_EXPIRY_RULE_CHECKED_ON,
    provenance: {
      authority: 'CME Group NYMEX rulebook and official product notices', sources,
      calendarSource: CL_EXPIRY_RULE_SOURCES.calendar,
      expiryDateSource: 'provider option-series expiration date, not inferred from a futures month',
      underlyingSource: 'provider dated stock_owner; weekly exercise can refer to a second nearby future',
      strikeVerification: 'An x decimal suffix reconstructs the code strike and must exactly match the provider numeric strike. Decimal digits are not an expiration clock or permission to approximate American exercise.',
      expirationClock: null, expirationTimeZone: null,
      unresolvedClockReason: 'Current primary rules retrieved specify close of trading without an exact expiration clock. An independently verified option-series timestamp is required.',
      dateVerification: weekly ? 'Code expiry month, weekday, week number and optional cycle crosschecked.' : 'Provider date retained; delivery period and optional cycle crosschecked. Three-business-day monthly expiry calendar not inferred.',
      holidayPolicy: weekly ? 'An exchange-holiday weekly expiry is not listed; no shifting is assumed.' : 'Exchange-announced provider date retained; holiday session needs separate review.',
    },
  };
}

/** Apply the published American CL clock only to reviewed standard sessions. */
export function resolveCmeClExpiry(input = {}) {
  const classification = classifyCmeClOption(input);
  if (classification.status !== 'resolved') return classification;
  if (!classification.calendarReason && classification.exerciseStyle === 'american') {
    const tuesdayThursday = /^(NL|XL)/.test(classification.productRoot);
    return {
      ...classification, status: 'resolved', classificationStatus: 'resolved',
      expiry: americanExpiry(classification.providerExpiryDate),
      exactExpiryStatus: 'resolved', automaticModelAllowed: true,
      americanApproximationRequiresOptIn: false, reason: null, detail: null,
      provenance: {
        ...classification.provenance,
        authority: 'CME family rules; tastytrade published American CL settlement/expiration clock',
        sources: [...classification.provenance.sources, CL_EXPIRY_RULE_SOURCES.americanClock],
        expirationClock: '14:30', expirationTimeZone: 'America/New_York',
        publishedClock: '13:30 America/Chicago',
        clockBasis: tuesdayThursday ? 'broker-published-clock-with-cme-equivalent-weekly-specifications' : 'broker-published-contract-expiration-clock',
        clockScope: 'Standard American CL monthly and weekly sessions only. Not a Futu-supplied timestamp.',
        clockInference: tuesdayThursday ? 'CME states Tuesday/Thursday have the same specifications as the existing weekly suite.' : null,
        unresolvedClockReason: null,
      },
    };
  }
  return {
    ...classification, status: 'unresolved', classificationStatus: 'resolved',
    reason: classification.calendarReason ?? 'exact-cl-expiration-clock-not-verified',
    detail: classification.calendarReason
      ? 'The date lies outside the reviewed standard 2026 session scope.'
      : 'The published American CL clock does not establish the European LCE expiration clock.',
  };
}
