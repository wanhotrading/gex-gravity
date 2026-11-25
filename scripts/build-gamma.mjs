import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const frontend = path.join(root, 'frontend');
const assets = {};
for(const [file,type] of [['iv-surface-view.mjs','text/javascript; charset=utf-8'],['iv-surface.css','text/css; charset=utf-8'],['expiry-comparison-view.mjs','text/javascript; charset=utf-8'],['chart-navigation.mjs','text/javascript; charset=utf-8'],['net-dex-view.mjs','text/javascript; charset=utf-8']])assets['/'+file]={type,body:await readFile(path.join(frontend,file),'utf8')};
assets['/core/iv-surface.mjs']={type:'text/javascript; charset=utf-8',body:await readFile(path.join(root,'core/iv-surface.mjs'),'utf8')};
for (const [file, type] of [['index.html','text/html; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['level-lens.css','text/css; charset=utf-8'],['level-lens-view.mjs','text/javascript; charset=utf-8'],['market-reading-view.mjs','text/javascript; charset=utf-8'],['gravity-view.mjs','text/javascript; charset=utf-8'],['replay-view.mjs','text/javascript; charset=utf-8'],['replay.css','text/css; charset=utf-8'],['gravity-shell.css','text/css; charset=utf-8'],['entrance.js','text/javascript; charset=utf-8'],['space-chart.css','text/css; charset=utf-8'],['app.mjs','text/javascript; charset=utf-8'],['market-watch.mjs','text/javascript; charset=utf-8'],['session-impact-view.mjs','text/javascript; charset=utf-8']]) {
  try {
    assets['/'+file] = {type, body: await readFile(path.join(frontend,file), 'utf8')};
  } catch (error) {
    if (error.code === 'ENOENT') throw Error(`Missing frontend/${file}. Restore the complete source package before building.`);
    throw error;
  }
}
assets['/core/engine.mjs'] = {type: 'text/javascript; charset=utf-8',
  body: await readFile(path.join(root, 'core/engine.mjs'), 'utf8')};
assets['/core/manual-workflow.mjs'] = {type: 'text/javascript; charset=utf-8',
  body: await readFile(path.join(root, 'core/manual-workflow.mjs'), 'utf8')};
assets['/core/hedging-engine.mjs'] = {type: 'text/javascript; charset=utf-8',
  body: await readFile(path.join(root, 'core/hedging-engine.mjs'), 'utf8')};
for(const file of ['session-impact.mjs','session-history.mjs','level-impact.mjs','market-reading.mjs','delta-transition.mjs','trading-sessions.mjs','expiry-comparison.mjs','menthorq-import.mjs'])assets['/core/'+file]={type:'text/javascript; charset=utf-8',body:await readFile(path.join(root,'core',file),'utf8')};
for(const file of ['black-hole-lensed.png','planet-atlas.png'])assets['/'+file]={type:'image/png',base64:(await readFile(path.join(frontend,file))).toString('base64')};
// Bundle isolated, dependency-free server modules into a single Worker ESM.
// Each IIFE preserves private module scope, including credential variables.
async function bundleModule(file,name,aliases='') {
  const source=await readFile(path.join(root,file),'utf8');
  const names=[...source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map(match=>match[1]);
  const stripped=source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm,'').replace(/^export\s+/gm,'');
  return `const ${name}=(()=>{\n${aliases}\n${stripped}\nreturn {${names.join(',')}};\n})();\n`;
}
let modules='';
modules+=await bundleModule('lib/data-archive.mjs','DataArchiveModule');
modules+=await bundleModule('lib/secure-store.mjs','SecureStoreModule','const {archiveDataRecords,isDataRecordName,DataBackupError}=DataArchiveModule;');
modules+=await bundleModule('src/backup-service.mjs','BackupServiceModule','const {createPrivateStore}=SecureStoreModule; const {DATA_ARCHIVE_PREFIX,archiveDataRecords,isDataRecordName,validArchiveId,listDataArchives}=DataArchiveModule;');
modules+=await bundleModule('lib/futu-auth.mjs','FutuAuthModule','const {createPrivateStore,randomId,digest}=SecureStoreModule;');
modules+=await bundleModule('lib/futu-client.mjs','FutuClientModule');
modules+=await bundleModule('core/engine.mjs','EngineModule');
modules+=await bundleModule('core/manual-workflow.mjs','ManualModule');
modules+=await bundleModule('core/expiry-rules.mjs','ExpiryModule','const {newYorkToIso}=ManualModule;');
modules+=await bundleModule('core/cl-expiry-rules.mjs','ClExpiryModule','const {newYorkToIso}=ManualModule;');
modules+=await bundleModule('src/refresh-collection.mjs','RefreshCollectionModule','const {normalizeOptionMetadata,normalizeOptionSnapshot,reconcileSnapshots}=FutuClientModule;');
modules+=await bundleModule('core/trading-sessions.mjs','TradingSessionsModule');
modules+=await bundleModule('core/market-reading.mjs','MarketReadingModule','const {MENTHORQ_INTRADAY_START}=TradingSessionsModule;');
modules+=await bundleModule('src/watch-context.mjs','WatchContextModule','const {createPrivateStore}=SecureStoreModule; const {contextFreshness,nyClock}=MarketReadingModule;');
modules+=await bundleModule('core/menthorq-import.mjs','MenthorqImportModule');
modules+=await bundleModule('core/iv-tracking.mjs','IvTrackingModule');
modules+=await bundleModule('src/replay-service.mjs','ReplayServiceModule','const {DATA_ARCHIVE_PREFIX,validArchiveId}=DataArchiveModule; const {publicIvRow}=IvTrackingModule; const {projectWatchContext}=WatchContextModule; const {newYorkToIso}=ManualModule;');
modules+=await bundleModule('core/session-history.mjs','SessionHistoryModule','const {buildSessionComparison}=TradingSessionsModule;');
modules+=await bundleModule('src/history-service.mjs','HistoryServiceModule',`const {createPrivateStore}=SecureStoreModule;
const {getFutuAccess}=FutuAuthModule;
const {createFutuQuoteClient,FutuQuoteError,safeFutuError,QUOTE_INTERVAL_MS}=FutuClientModule;
const {buildSessionComparison}=TradingSessionsModule;
const {SESSION_WINDOWS,normalizeHistoryBars,mergeHistoryBars,newYorkBarTime,buildSessionHistory}=SessionHistoryModule;`);
modules+=await bundleModule('src/iv-service.mjs','IvServiceModule',`const {createPrivateStore}=SecureStoreModule;
const {getFutuAccess}=FutuAuthModule;
const {createFutuQuoteClient,normalizeOptionSnapshot,reconcileSnapshots,safeFutuError,QUOTE_INTERVAL_MS}=FutuClientModule;
const {IV_CHECK_MS,selectIvContracts,validateIvIdentity,mergeIvObservation,publicIvRow}=IvTrackingModule;`);
modules+=await bundleModule('src/collector-service.mjs','CollectorServiceModule','const {createPrivateStore}=SecureStoreModule;');
modules+=await bundleModule('src/market-service.mjs','MarketServiceModule',`const {createPrivateStore}=SecureStoreModule;
const {readCollectorStatus,saveCollectorStatus}=CollectorServiceModule;
const {futuresCollectionWindow}=TradingSessionsModule;
const {connectionStatus,getFutuAccess,startFutuConnection,finishFutuConnection}=FutuAuthModule;
const {createFutuQuoteClient,collectFutuMarket,selectActiveFuture,safeFutuError}=FutuClientModule;
const {resolveCmeWeeklyExpiry}=ExpiryModule;
const {resolveCmeClExpiry}=ClExpiryModule;
const {advanceFutuCollection}=RefreshCollectionModule;
const {readWatchContexts,saveWatchContext,projectWatchContext}=WatchContextModule;
const {readIvTracking,refreshIvTracking}=IvServiceModule;
const {parseMenthorqExport}=MenthorqImportModule;
const {readSessionHistory,refreshSessionHistory}=HistoryServiceModule;`);
const core = (await readFile(path.join(root,'src/server-core.mjs'),'utf8')).replace(/^import[^\n]+\n/gm,'');
const worker = modules+'const {handleMarketRoute,handleWatchMcp}=MarketServiceModule; const {handleBackupRoute}=BackupServiceModule; const {handleReplayRoute}=ReplayServiceModule;\n'+core + '\nconst assets = ' + JSON.stringify(assets) + ';\nexport default createHandler(assets);\n';
await mkdir(path.join(root,'worker'),{recursive:true});
await writeFile(path.join(root,'worker/index.js'),worker);
await mkdir(path.join(root,'dist/server'),{recursive:true});
await mkdir(path.join(root,'dist/.openai'),{recursive:true});
await writeFile(path.join(root,'dist/server/index.js'),worker);
await cp(path.join(root,'.openai/hosting.json'), path.join(root,'dist/.openai/hosting.json'));
console.log(JSON.stringify({assets:Object.keys(assets).length,workerBytes:Buffer.byteLength(worker)}));
