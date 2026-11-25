/** Private, append-only copies of saved provider data. No OAuth records,
 * leases or collection jobs are admitted. Capture time never becomes source time.
 */
export const DATA_ARCHIVE_PREFIX='gamma-watch/v1/archive/data-v1/';
const encoder=new TextEncoder();
const markets=['NQ','ES','CL'];
const stamp=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&Number.isFinite(Date.parse(value));
const exact=(market,code)=>markets.includes(market)&&new RegExp('^US\\.'+market+'[0-9]{4}$').test(code??'');
const kinds=['menthorq','quotes','iv','history-bars','history-profile','metadata','selection','saved-capture'];
const credentialField=key=>/^(?:access[_-]?token|refresh[_-]?token|authorization|cookie|client[_-]?secret|password|code[_-]?verifier|encryption[_-]?key)$/i.test(key);
export class DataBackupError extends Error {
  constructor(){super('The server backup could not be saved. The previous saved data is retained; retry the update.');this.code='DATA_BACKUP_UNAVAILABLE';}
}
export function isDataRecordName(name){
  return typeof name==='string'&&(/^(?:watch\/state(?:-v3)?|watch\/menthorq-context|watch\/menthorq-(?:NQ|ES|CL)-(?:Intraday|EOD))$/.test(name)
    ||/^watch\/(?:metadata\/US\.(?:NQ|ES|CL)[0-9]{4}|selection\/(?:NQ|ES|CL)|iv\/(?:NQ|ES|CL)\/US\.(?:NQ|ES|CL)[0-9]{4}|history\/(?:NQ|ES|CL)\/US\.(?:NQ|ES|CL)[0-9]{4}\/(?:bars|state))$/.test(name));
}
function noCredentials(value){
  const queue=[value];
  while(queue.length){const item=queue.pop();if(!item||typeof item!=='object')continue;
    for(const [key,child]of Object.entries(item)){
      if(credentialField(key))throw Error('Credentials cannot be included in a data backup.');
      if(child&&typeof child==='object')queue.push(child);
    }
  }
}
function withoutCredentials(value,depth=0){
  if(depth>100)throw Error('Backup data nesting is too deep.');
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>withoutCredentials(item,depth+1));
  return Object.fromEntries(Object.entries(value).filter(([key])=>!credentialField(key)).map(([key,item])=>[key,withoutCredentials(item,depth+1)]));
}
function record(kind,market,data,capturedAt=null){
  return {kind,market,underlyingCode:data.underlyingCode??data.code??null,capturedAt:stamp(capturedAt)?capturedAt:null,data};
}
export function dataArchiveRecords(name,value){
  if(!isDataRecordName(name)||!value||typeof value!=='object')return [];
  const context=(market,data)=>exact(market,data?.underlyingCode)&&data.source==='MenthorQ'&&Array.isArray(data.levels)&&data.levels.length
    ?[record('menthorq',market,data,data.contextUpdatedAt??data.capturedAt)]:[];
  if(/^watch\/state(?:-v3)?$/.test(name))return markets.flatMap(market=>{
    const data=value.markets?.[market];
    return exact(market,data?.underlyingCode)&&data.underlyingPrice>0&&data.contracts?.length&&stamp(data.collectedAt)&&data.status!=='refresh-failed'
      ?[record('quotes',market,data,data.collectedAt)]:[];
  });
  if(name==='watch/menthorq-context')return markets.flatMap(market=>context(market,value[market]));
  let match=name.match(/^watch\/menthorq-(NQ|ES|CL)-(?:Intraday|EOD)$/);
  if(match)return context(match[1],value);
  match=name.match(/^watch\/iv\/(NQ|ES|CL)\/(US\.[A-Z]+[0-9]{4})$/);
  if(match)return exact(match[1],match[2])&&value.underlyingCode===match[2]&&stamp(value.lastSuccessAt)&&value.status!=='check-failed'&&Object.values(value.rows??{}).some(row=>row.current)
    ?[record('iv',match[1],value,value.lastSuccessAt)]:[];
  match=name.match(/^watch\/history\/(NQ|ES|CL)\/(US\.[A-Z]+[0-9]{4})\/(bars|state)$/);
  if(match){if(!exact(match[1],match[2])||value.underlyingCode!==match[2])return [];
    if(match[3]==='bars')return value.bars?.length?[record('history-bars',match[1],value)]:[];
    return value.profile&&stamp(value.lastSuccessAt)&&value.status!=='history-refresh-failed'?[record('history-profile',match[1],value,value.lastSuccessAt)]:[];
  }
  match=name.match(/^watch\/metadata\/(US\.(NQ|ES|CL)[0-9]{4})$/);
  if(match)return value.rows?.length?[record('metadata',match[2],value,value.retrievedAt)]:[];
  match=name.match(/^watch\/selection\/(NQ|ES|CL)$/);
  if(match&&exact(match[1],value.underlyingCode))return [record('selection',match[1],value)];
  return [];
}
export function recoveredFileRecord(name,value){
  if(!/^recovered\/(?:menthorq-[a-z0-9-]+|private-(?:market-snapshot-[0-9]+|(?:history|iv)-(?:NQ|ES|CL)-[0-9]+|redesign-snapshot|regime-preview))\.(?:json|txt)(?:\/(?:NQ|ES|CL|metadata))?$/.test(name))return [];
  return [{kind:'saved-capture',market:'ALL',underlyingCode:null,capturedAt:null,data:{fileName:name.slice(10),content:value}}];
}
export async function archiveDataRecords(bucket,name,value,{now=Date.now(),origin='automatic',recovered=false}={}){
  const records=recovered?recoveredFileRecord(name,value):dataArchiveRecords(name,value);
  const result=[];
  for(const item of records){
    if(origin==='automatic'||origin==='server-backfill')item.data=withoutCredentials(item.data);
    else noCredentials(item.data);
    const identity=JSON.stringify({kind:item.kind,market:item.market,data:item.data});
    const checksum=[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(identity)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const reverse=String(9999999999999-(item.capturedAt?Date.parse(item.capturedAt):0)).padStart(13,'0');
    const id=`${item.kind}/${item.market}/${reverse}-${checksum}.json`;
    const backedUpAt=new Date(now).toISOString();
    const envelope={schemaVersion:1,id,kind:item.kind,market:item.market,underlyingCode:item.underlyingCode,capturedAt:item.capturedAt,backedUpAt,origin,sourceRecord:name,checksum,data:item.data};
    const saved=await bucket.put(DATA_ARCHIVE_PREFIX+id,JSON.stringify(envelope),{
      onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'},
      customMetadata:{kind:item.kind,market:item.market,underlyingCode:item.underlyingCode??'',capturedAt:item.capturedAt??'',backedUpAt,checksum},
    });
    result.push({id,created:!!saved,checksum});
  }
  return result;
}
export function validArchiveId(id){return typeof id==='string'&&new RegExp('^(?:'+kinds.join('|')+')/(?:NQ|ES|CL|ALL)/[0-9]{13}-[a-f0-9]{64}\\.json$').test(id);}
export async function listDataArchives(bucket,{cursor,limit=25}={}){
  if(cursor&&(typeof cursor!=='string'||cursor.length>2048))throw Error('Invalid backup cursor.');
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Choose 1 to 100 backups per page.');
  const page=await bucket.list({prefix:DATA_ARCHIVE_PREFIX,limit,include:['customMetadata'],...(cursor?{cursor}:{})});
  return {entries:page.objects.map(object=>({id:object.key.slice(DATA_ARCHIVE_PREFIX.length),bytes:object.size,uploadedAt:object.uploaded?.toISOString()??null,...object.customMetadata})),cursor:page.truncated?page.cursor:null,hasMore:page.truncated};
}
