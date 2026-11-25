import {MENTHORQ_REFRESH_MINUTES} from '../core/trading-sessions.mjs';

const minute=60000;
const storedSlotMs=5*minute;
const refreshIntervalMs=MENTHORQ_REFRESH_MINUTES*minute;
const attentionCodes=['MQ_LOGIN_REQUIRED','MQ_ACCESS_ATTENTION'];
export function menthorqCapturePlan(window,saved,now,{requested=false}={}){
  const eodDue=window.menthorqEodSlot&&(saved.menthorqEodDate!==window.date||saved.menthorqDexEodDate!==window.date);
  if(requested){
    if(window.menthorqEodSlot||!window.open&&window.menthorqEod)return 'eod';
    if(window.menthorqIntraday)return 'regular';
    return window.menthorqOvernight?'overnight':null;
  }
  // Read the stored five-minute index so a restart or upgrade does not repeat an attempt.
  const lastAttempt=saved.menthorqAttemptSlot*storedSlotMs;
  if(Math.floor(lastAttempt/refreshIntervalMs)===Math.floor(now/refreshIntervalMs)||saved.menthorqRetryAt>now)return null;
  if(eodDue)return 'eod';
  if(window.menthorqIntraday)return 'regular';
  return window.menthorqOvernight?'overnight':null;
}
export function markMenthorqAttempt(saved,now){
  saved.menthorqAttemptSlot=Math.floor(now/storedSlotMs);
}
export function menthorqNeedsAccessAttention(result,markets=result?.menthorqMarkets){
  return attentionCodes.includes(result?.menthorqCode)
    ||(markets??[]).some(row=>[row.code,row.levelsCode,row.dexCode].some(code=>attentionCodes.includes(code)));
}
export function recordMenthorqResult(saved,result,now=Date.now()){
  saved.menthorqRetryAt=menthorqNeedsAccessAttention(result)?now+30*minute:null;
  saved.menthorqLastResult={menthorq:result.menthorq,menthorqCode:result.menthorqCode??null,menthorqStage:result.menthorqStage??null};
  return saved;
}
export function shouldNotify(saved,alert,now=Date.now()){
  if(alert?.key.endsWith('|save-conflict-overdue')&&now-(saved.menthorqConflictAlertAt??0)<30*minute)return false;
  return !!alert&&(saved.menthorqAlert!==alert.key||!Number.isFinite(saved.menthorqAlertAt)||now-saved.menthorqAlertAt>=30*minute);
}
