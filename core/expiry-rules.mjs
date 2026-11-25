/**
 * Reviewed CME E-mini equity weekly PM-expiry rules, not a universal options
 * calendar. A provider's expiration DATE and product code are required. No date
 * is inferred from the underlying futures month. Holiday/exception windows and
 * years outside the reviewed calendar remain unresolved.
 */
import { newYorkToIso } from './manual-workflow.mjs';

export const EXPIRY_RULE_VERSION = 'cme-equity-weekly-pm-2026-11-04.v1';
export const EXPIRY_RULE_CHECKED_ON = '2026-11-04';
export const EXPIRY_RULE_SOURCES = Object.freeze({
  nqWeekly: 'https://www.cmegroup.com/trading/equity-index/e-mini-nasdaq-100-weekly-options.html',
  nqTuesdayThursday: 'https://www.cmegroup.com/articles/faqs/e-mini-nasdaq-100-tuesday-and-thursday-options-frequently-asked-questions.html',
  esMondayWednesdayFriday: 'https://www.cmegroup.com/trading/equity-index/weekly-eom-options-faq.html',
  esTuesdayThursday: 'https://www.cmegroup.com/articles/faqs/e-mini-s-p-500-tuesday-and-thursday-options-frequently-asked-questions.html',
  calendar: 'https://www.cmegroup.com/trading-hours.html',
});

// Conservative review windows, not assertions that every listed date is closed.
// They encompass the CME 2026 holiday schedules and adjacent settlement/early-
// close review periods. Exact holiday-session rules require separate review.
const REVIEW_WINDOWS_2026 = Object.freeze([
  ['2026-01-01', '2026-01-02'], ['2026-01-16', '2026-01-20'],
  ['2026-02-13', '2026-02-17'], ['2026-04-02', '2026-04-06'],
  ['2026-05-22', '2026-05-26'], ['2026-06-18', '2026-06-22'],
  ['2026-07-02', '2026-07-06'], ['2026-09-04', '2026-09-08'],
  ['2026-10-12', '2026-10-12'], ['2026-11-11', '2026-11-11'],
  ['2026-11-25', '2026-11-30'], ['2026-12-23', '2026-12-31'],
]);
const DAY = {
  A: { weekday: 1, cycle: 'WEEKMON', name: 'Monday' },
  B: { weekday: 2, cycle: 'WEEKTUE', name: 'Tuesday' },
  C: { weekday: 3, cycle: 'WEEKWED', name: 'Wednesday' },
  D: { weekday: 4, cycle: 'WEEKTHU', name: 'Thursday' },
  F: { weekday: 5, cycle: 'WEEKFRI', name: 'Friday' },
};

function unresolved(reason, detail = null, extra = {}) {
  return {
    status: 'unresolved', expiry: null, exerciseStyle: null,
    reason, detail, ruleVersion: EXPIRY_RULE_VERSION,
    checkedOn: EXPIRY_RULE_CHECKED_ON, ...extra,
  };
}

function dateParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = +match[1], month = +match[2], day = +match[3];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, weekday: date.getUTCDay() };
}

/**
 * Accepts Futu-style product/option codes such as US.Q1C2611 or
 * US.Q1C2611P28750 or the observed Futu terminal suffix x0, for example
 * US.Q1C2611P28750x0. YYMM must agree with the supplied expiry date.
 * Supported families are Q1A..Q5D, QN1..QN4, E1A..E5D and EW1..EW4 only.
 */
export function resolveCmeWeeklyExpiry(input = {}) {
  const { market, code, expiration_cycle: expirationCycle, expiry_date: expiryDate } = input;
  if (!['NQ', 'ES'].includes(market)) return unresolved('product-family-not-reviewed', 'CL, quarterly, monthly, EOM and micro-option expiry rules are not inferred by this module.');
  const parts = dateParts(expiryDate);
  if (!parts) return unresolved('valid-provider-expiration-date-required', 'Provide the option series expiration DATE as YYYY-MM-DD; the futures delivery month is insufficient.');
  if (typeof code !== 'string') return unresolved('recognized-weekly-product-code-required');
  const match = /^(?:US\.)?(Q[1-5][ABCD]|QN[1-4]|E[1-5][ABCD]|EW[1-4])(\d{4})(?:[CP](?:\d+(?:\.\d*)?|\.\d+)(?:x0)?)?$/i.exec(code.trim());
  if (!match) return unresolved('recognized-weekly-product-code-required');
  const root = match[1].toUpperCase();
  const isNq = root.startsWith('Q');
  if ((market === 'NQ') !== isNq) return unresolved('market-and-product-code-conflict');
  const period = match[2];
  if (+period.slice(0, 2) !== parts.year % 100 || +period.slice(2) !== parts.month) return unresolved('code-period-and-expiration-date-conflict');
  const friday = /^(?:QN|EW)/.test(root);
  const week = +(friday ? root.at(-1) : root[1]);
  const dayRule = DAY[friday ? 'F' : root.at(-1)];
  if (parts.weekday !== dayRule.weekday) return unresolved('product-weekday-and-expiration-date-conflict', 'A holiday-shifted or otherwise exceptional expiry needs an independently verified rule.');
  if (Math.ceil(parts.day / 7) !== week) return unresolved('product-week-number-and-expiration-date-conflict');
  const cycle = typeof expirationCycle === 'string' ? expirationCycle.trim().toUpperCase() : null;
  if (cycle && cycle !== 'WEEK' && cycle !== dayRule.cycle) return unresolved('expiration-cycle-and-product-code-conflict');
  if (parts.year !== 2026) return unresolved('calendar-year-not-reviewed', 'Only the reviewed 2026 calendar is supported; refresh the calendar rules before inferring another year.');
  if (REVIEW_WINDOWS_2026.some(([start, end]) => expiryDate >= start && expiryDate <= end)) {
    return unresolved('holiday-or-special-session-needs-review', 'No standard 16:00 New York time is assumed inside the conservative holiday review windows.');
  }
  const sources = market === 'NQ'
    ? [EXPIRY_RULE_SOURCES.nqWeekly, EXPIRY_RULE_SOURCES.nqTuesdayThursday, EXPIRY_RULE_SOURCES.calendar]
    : [EXPIRY_RULE_SOURCES.esMondayWednesdayFriday, EXPIRY_RULE_SOURCES.esTuesdayThursday, EXPIRY_RULE_SOURCES.calendar];
  const expiry = newYorkToIso(`${expiryDate}T16:00`);
  return {
    status: 'resolved', expiry, exerciseStyle: 'european',
    reason: null, productRoot: root, expirationCycle: dayRule.cycle,
    ruleVersion: EXPIRY_RULE_VERSION, checkedOn: EXPIRY_RULE_CHECKED_ON,
    provenance: {
      ruleVersion: EXPIRY_RULE_VERSION, checkedOn: EXPIRY_RULE_CHECKED_ON,
      authority: 'CME Group official weekly equity-index specifications and reviewed 2026 holiday calendar',
      sources, timeZone: 'America/New_York', localTime: '16:00',
      expiryDateSource: 'provider option-series expiration date',
      productCodeSource: 'provider Futu-format option product code mapped to documented CME root',
      sessionScope: 'Standard session outside conservative holiday review windows; extraordinary exchange schedule changes still require refreshed rules.',
      exerciseStyleSource: 'CME documented European-style weekly product family',
      expiryPurpose: 'PM option fixing/expiry, not the underlying futures daily settlement or a quarterly AM expiry',
    },
  };
}
