import {parseMenthorqExport} from '../core/menthorq-import.mjs';
import {isOlderMap} from './menthorq-data.mjs';
import {saveMenthorqUpdate} from './site-client.mjs';

const kind = body => body.netDexUpdate ? 'netDex' : body.exposureUpdate ? 'exposure' : 'levels';
const key = body => body.market + ':' + kind(body);

export async function rememberMenthorqUpload(saved, body, persist) {
  saved.menthorqUploadQueue = [
    ...(saved.menthorqUploadQueue ?? []).filter(queued => key(queued) !== key(body)),
    body,
  ];
  await persist();
}

export function clearMenthorqUpload(saved, body) {
  if (saved.menthorqUploadQueue) {
    saved.menthorqUploadQueue = saved.menthorqUploadQueue.filter(queued => queued !== body);
  }
}

function matchesUpload(body) {
  const field = kind(body);
  if (field === 'levels') {
    const proposed = parseMenthorqExport(body);
    const levels = rows => JSON.stringify(rows.map(row => [row.strike, row.labels]));
    const expectedLevels = levels(proposed.levels);
    return context => context.mode === body.mode && context.sourceDate === proposed.sourceDate
      && context.sourceLocalTime === proposed.sourceLocalTime && levels(context.levels ?? []) === expectedLevels;
  }
  const observed = body.netDexUpdate ?? body.exposureUpdate.exposure;
  return context => context[field]?.capturedAt === observed.capturedAt
    && context[field]?.mode === observed.mode && context[field]?.metric === observed.metric
    && !!context[field]?.rows?.length;
}

function superseded(body, context, date) {
  if (kind(body) !== 'levels') return false;
  if (body.sourceDate !== date || isOlderMap(context, body)) return true;
  if (context?.underlyingCode !== body.underlyingCode || context.sourceDate !== body.sourceDate) return false;
  return (body.mode === 'Intraday' && context.mode === 'EOD')
    || (context.mode === body.mode && context.sourceLocalTime === body.sourceLocalTime
      && Date.parse(context.capturedAt) > Date.parse(body.observedAt));
}

export function rejectedMenthorqUpload(error) {
  return /^SITE_HTTP_(400|404|405|413|422)$/.test(error.message)
    || ['MQ_NEWER_CAPTURE_SAVED', 'MQ_WATCHLIST_CHANGED'].includes(error.message);
}

/** Retry one saved observation during a scheduler run without contacting MenthorQ. */
export async function retryMenthorqUpload({request, state, saved, persist, date, deadline}) {
  for (const body of saved.menthorqUploadQueue ?? []) {
    const market = state.markets?.[body.market];
    if (!market?.underlyingCode) continue;
    if (market.underlyingCode !== body.underlyingCode || superseded(body, market.watchContext, date)) {
      clearMenthorqUpload(saved, body);
      await persist();
      continue;
    }
    try {
      const context = await saveMenthorqUpdate(request, body, {
        deadline, readFirst: true, writeTimeoutMs: 25_000,
        verify: matchesUpload(body), unverified: 'MQ_DEFERRED_SAVE_NOT_VERIFIED',
      });
      clearMenthorqUpload(saved, body);
      await persist();
      return {market: body.market, kind: kind(body), context};
    } catch (error) {
      clearMenthorqUpload(saved, body);
      if (!rejectedMenthorqUpload(error)) {
        saved.menthorqUploadQueue.push(body);
      }
      await persist();
      return null;
    }
  }
  return null;
}
