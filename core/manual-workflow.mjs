/**
 * Manual watch-plan helpers. A watch-plan GEX row and a later chain reading
 * remain separate observations. Provider Greeks retain their unverified units
 * and pricing-model basis; they do not establish actual dealer inventory.
 */

const NEW_YORK = 'America/New_York';
const MAX_LEVELS = 10000;
const MAX_TEXT_LENGTH = 1024 * 1024;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const ZONED_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i;
const nyFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: NEW_YORK,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function utcFromParts({ year, month, day, hour, minute, second = 0 }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function checkCalendar(parts, name) {
  const { year, month, day, hour, minute, second = 0 } = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new RangeError(`${name} is not a valid calendar date and time.`);
  }
  const date = new Date(utcFromParts(parts));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || !Number.isFinite(date.getTime())) {
    throw new RangeError(`${name} is not a valid calendar date and time.`);
  }
}

function zonedMilliseconds(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} needs an ISO timestamp with Z or an explicit UTC offset.`);
  const match = ZONED_PATTERN.exec(value.trim());
  if (!match) throw new TypeError(`${name} needs an ISO timestamp with Z or an explicit UTC offset.`);
  const parts = { year: +match[1], month: +match[2], day: +match[3],
    hour: +match[4], minute: +match[5], second: +(match[6] || 0) };
  checkCalendar(parts, name);
  const result = Date.parse(value.trim());
  if (!Number.isFinite(result)) throw new RangeError(`${name} is not a valid ISO timestamp.`);
  return result;
}

function timestamp(value, name) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') return zonedMilliseconds(value, name);
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError(`${name} must be a valid timestamp.`);
  }
  return value;
}

function nyParts(ms) {
  const result = {};
  for (const { type, value } of nyFormatter.formatToParts(new Date(ms))) {
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(type)) result[type] = Number(value);
  }
  return result;
}

function pad(value, width = 2) { return String(value).padStart(width, '0'); }
function localText(parts) {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Format an instant for a New York datetime-local input, at minute precision. */
export function toNewYorkInput(iso = Date.now()) {
  return localText(nyParts(timestamp(iso, 'Timestamp')));
}

/**
 * Convert a New York wall-clock minute into an instant. Both missing spring
 * minutes and repeated fall minutes are rejected instead of silently guessing.
 */
export function newYorkToIso(local) {
  if (typeof local !== 'string') throw new TypeError('Enter a New York date and time.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) throw new TypeError('Use a New York date and time in YYYY-MM-DDTHH:mm format.');
  const desired = { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: 0 };
  checkCalendar(desired, 'New York time');
  const localMs = utcFromParts(desired);
  // Derive offsets from the zone database on either side of any local DST
  // transition. No host-timezone assumptions or hard-coded UTC offsets.
  const offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probeMs = localMs + hours * 3600000;
    offsets.add(utcFromParts(nyParts(probeMs)) - probeMs);
  }
  const matches = new Set();
  for (const offset of offsets) {
    const candidate = localMs - offset;
    const actual = nyParts(candidate);
    if (Object.keys(desired).every(key => desired[key] === actual[key])) matches.add(candidate);
  }
  if (matches.size === 0) throw new RangeError('This New York time does not exist because the clocks move forward. Choose another minute.');
  if (matches.size > 1) throw new RangeError('This New York time is ambiguous because the clocks move back. Choose an unambiguous minute.');
  return new Date([...matches][0]).toISOString();
}

function numeric(value, name, { optional = false } = {}) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    if (optional) return null;
    throw new TypeError(`${name} is required.`);
  }
  if (typeof value === 'string') {
    if (!NUMBER_PATTERN.test(value.trim())) throw new TypeError(`${name} must be a number without thousands separators.`);
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
}

/** One strike/GEX pair per line. A comma separates columns, never thousands. */
export function parseWatchLevels(text) {
  if (typeof text !== 'string') throw new TypeError('Enter one strike and GEX value per line.');
  if (text.length > MAX_TEXT_LENGTH) throw new RangeError('The watch plan is too large. Use at most 10,000 levels.');
  const rows = [];
  const strikes = new Set();
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = original.trim().replace(/\u2212/g, '-');
    if (!line) continue;
    if (rows.length >= MAX_LEVELS) throw new RangeError('Use at most 10,000 watch levels.');
    const fields = line.includes(',') ? line.split(',').map(value => value.trim()) : line.split(/\s+/);
    if (fields.length !== 2 || fields.some(value => !value)) {
      throw new TypeError(`Line ${index + 1}: use strike,GEX or strike GEX; omit thousands separators.`);
    }
    const strike = numeric(fields[0], `Line ${index + 1} strike`);
    if (strike <= 0) throw new RangeError(`Line ${index + 1}: strike must be greater than zero.`);
    const gexMatch = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([KMB])?$/i.exec(fields[1]);
    if (!gexMatch) throw new TypeError(`Line ${index + 1}: GEX must be numeric, optionally followed by K, M or B.`);
    const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[(gexMatch[2] || '').toUpperCase()] || 1;
    const gex = Number(gexMatch[1]) * multiplier;
    if (!Number.isFinite(gex)) throw new RangeError(`Line ${index + 1}: GEX is too large.`);
    if (strikes.has(strike)) throw new RangeError(`Line ${index + 1}: duplicate strike ${strike}.`);
    strikes.add(strike);
    rows.push({ strike, gex: Object.is(gex, -0) ? 0 : gex });
  }
  if (!rows.length) throw new TypeError('Enter at least one strike and GEX value.');
  return rows;
}

/** Normalize a manually observed Futu chain reading, without inferring a model. */
export function validateReading(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Enter a chain-reading object.');
  const contract = typeof input.contract === 'string' ? input.contract.trim() : '';
  if (!contract || contract.length > 120) throw new TypeError('An exact underlying futures contract is required.');
  const futuresPrice = numeric(input.futuresPrice, 'Underlying futures price');
  if (futuresPrice <= 0) throw new RangeError('Underlying futures price must be greater than zero.');
  const asOfMs = zonedMilliseconds(input.asOf, 'Reading time');
  if (asOfMs > timestamp(now, 'Current time') + 5 * 60000) throw new RangeError('Reading time is more than five minutes in the future.');
  const ivPercent = numeric(input.ivPercent, 'IV percentage');
  if (ivPercent <= 0 || ivPercent > 1000) throw new RangeError('IV percentage must be greater than zero and at most 1000%.');
  const iv = ivPercent / 100;
  if (!Number.isFinite(iv) || iv <= 0) throw new RangeError('IV percentage is outside the supported numerical range.');
  const optionType = typeof input.optionType === 'string' ? input.optionType.trim().toLowerCase() : '';
  if (!['call', 'put'].includes(optionType)) throw new TypeError('Choose Call or Put.');
  let expiry = null;
  if (input.expiry !== null && input.expiry !== undefined && String(input.expiry).trim()) {
    const expiryMs = zonedMilliseconds(input.expiry, 'Option expiry');
    if (expiryMs <= asOfMs) throw new RangeError('Option expiry must be after the reading time.');
    expiry = new Date(expiryMs).toISOString();
  }
  let exerciseStyle = null;
  if (input.exerciseStyle !== null && input.exerciseStyle !== undefined && String(input.exerciseStyle).trim()) {
    if (typeof input.exerciseStyle !== 'string') throw new TypeError('Exercise style must be European, American or blank.');
    exerciseStyle = input.exerciseStyle.trim().toLowerCase();
    if (!['european', 'american'].includes(exerciseStyle)) throw new TypeError('Exercise style must be European, American or blank.');
  }
  const allowEuropeanApproximation = input.allowEuropeanApproximation ?? false;
  if (typeof allowEuropeanApproximation !== 'boolean') throw new TypeError('The approximation selection must be true or false.');
  const observedDelta = numeric(input.observedDelta, 'Observed Delta', { optional: true });
  if (observedDelta !== null && (observedDelta < -1 || observedDelta > 1)) throw new RangeError('Observed Delta must be between -1 and 1. Confirm the provider units.');
  const observedGamma = numeric(input.observedGamma, 'Observed Gamma', { optional: true });
  if (observedGamma !== null && observedGamma < 0) throw new RangeError('Observed option Gamma must be zero or greater. Confirm the provider units.');
  const openInterest = numeric(input.openInterest, 'Open interest', { optional: true });
  if (openInterest !== null && (!Number.isSafeInteger(openInterest) || openInterest < 0)) throw new RangeError('Open interest must be a nonnegative whole number.');
  return {
    contract, futuresPrice, asOf: new Date(asOfMs).toISOString(), iv, optionType,
    expiry, exerciseStyle, allowEuropeanApproximation,
    observedDelta, observedGamma, openInterest,
    provider: 'Futu manual reading',
  };
}

/** Attach a newer reading without overwriting the original GEX plan or peers. */
export function applyReading(snapshot, selectedKey, reading) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.levels)) throw new TypeError('A watch-plan snapshot is required.');
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) throw new TypeError('A validated chain reading is required.');
  const baselineContract = typeof snapshot.contract === 'string' ? snapshot.contract.trim() : '';
  const readingContract = typeof reading.contract === 'string' ? reading.contract.trim() : '';
  if (!baselineContract || !readingContract || baselineContract.toUpperCase() !== readingContract.toUpperCase()) {
    throw new RangeError('The chain reading must use the same exact underlying futures contract as the watch plan.');
  }
  const matches = snapshot.levels.filter(row => row?._key === selectedKey);
  if (matches.length !== 1) throw new RangeError('Choose one existing watch-plan strike before saving a reading.');
  const selected = matches[0];
  const nextTime = zonedMilliseconds(reading.asOf, 'Reading time');
  if (snapshot.asOf !== undefined && snapshot.asOf !== null) {
    const baselineTime = zonedMilliseconds(snapshot.asOf, 'Watch-plan time');
    if (nextTime < baselineTime) {
      throw new RangeError('This reading is older than the morning watch plan. Enter an observation at or after the watch-plan time.');
    }
  }
  if (selected.reading && nextTime < zonedMilliseconds(selected.reading.asOf, 'Saved reading time')) {
    throw new RangeError('This reading is older than the saved reading for this strike. Enter a newer observation.');
  }
  return {
    ...snapshot,
    levels: snapshot.levels.map(row => row === selected ? { ...row, reading: { ...reading } } : row),
  };
}
