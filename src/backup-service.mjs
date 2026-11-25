import {createPrivateStore} from '../lib/secure-store.mjs';
import {DATA_ARCHIVE_PREFIX,archiveDataRecords,isDataRecordName,validArchiveId,listDataArchives} from '../lib/data-archive.mjs';

const encoder=new TextEncoder();
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,'content-type':'application/json; charset=utf-8'}});
async function boundedBody(request,maxBytes){
  const reader=request.body?.getReader();if(!reader)throw Error('Supply the backup request.');
  const chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('Backup import is too large; split it into smaller records.');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function checkpointSavedData(env,{cursor}={}){
  if(cursor&&(typeof cursor!=='string'||cursor.length>2048))throw Error('Invalid backup cursor.');
  // One source object per request bounds legacy full-chain reads and retries.
  const prefix='gamma-watch/v1/';
  const page=await env.BUCKET.list({prefix:prefix+'watch/',limit:1,...(cursor?{cursor}:{})});
  const records=[];
  for(const object of page.objects){const name=object.key.slice(prefix.length);if(!isDataRecordName(name))continue;
    const value=await createPrivateStore(env,{readTimeoutMs:90000}).get(name);
    records.push(...await archiveDataRecords(env.BUCKET,name,value,{origin:'server-backfill'}));
  }
  return {records,cursor:page.truncated?page.cursor:null,done:!page.truncated};
}
function exportArchives(bucket){
  let cursor,entries=[],index=0,finished=false,reader=null,count=0,started=false,cancelled=false;
  return new ReadableStream({
    async pull(controller){
      try{
        if(!started){started=true;controller.enqueue(encoder.encode(JSON.stringify({type:'gamma-watch-backup-export',schemaVersion:1,exportedAt:new Date().toISOString()})+'\n'));return;}
        for(;;){
          if(reader){const next=await reader.read();if(cancelled)return;if(!next.done){controller.enqueue(next.value);return;}reader.releaseLock();reader=null;count++;controller.enqueue(encoder.encode('\n'));return;}
          if(index<entries.length){const object=await bucket.get(DATA_ARCHIVE_PREFIX+entries[index++].id);if(!object?.body)throw Error('An archived record could not be read.');reader=object.body.getReader();continue;}
          if(finished){controller.enqueue(encoder.encode(JSON.stringify({type:'export-complete',records:count})+'\n'));controller.close();return;}
          const page=await listDataArchives(bucket,{cursor,limit:25});entries=page.entries;index=0;cursor=page.cursor;finished=!page.hasMore;
        }
      }catch{controller.error(Error('Backup download was interrupted. Retry the download.'));}
    },
    async cancel(){cancelled=true;if(reader){await reader.cancel();reader.releaseLock();reader=null;}},
  });
}
export async function handleBackupRoute(request,env){
  const url=new URL(request.url);
  if(!['/api/backups','/api/backups/checkpoint','/api/backups/import','/api/backups/export'].includes(url.pathname))return null;
  try{
    if(!env.BUCKET?.list)return json({error:'Private backup storage is unavailable.'},503);
    if(url.pathname==='/api/backups'&&request.method==='GET')return json(await listDataArchives(env.BUCKET,{cursor:url.searchParams.get('cursor')||undefined,limit:Number(url.searchParams.get('limit')??25)}));
    if(url.pathname==='/api/backups/export'&&request.method==='GET'){
      const id=url.searchParams.get('id');
      if(id){if(!validArchiveId(id))return json({error:'Choose a saved data backup.'},400);const object=await env.BUCKET.get(DATA_ARCHIVE_PREFIX+id);if(!object)return json({error:'Backup not found.'},404);
        return new Response(object.body,{headers:{...headers,'content-type':'application/json','content-disposition':'attachment; filename="gamma-watch-capture.json"'}});
      }
      return new Response(exportArchives(env.BUCKET),{headers:{...headers,'content-type':'application/x-ndjson','content-disposition':'attachment; filename="gamma-watch-backups.ndjson"'}});
    }
    if(['/api/backups/checkpoint','/api/backups/import'].includes(url.pathname)&&request.method==='POST'){
      if(request.headers.get('origin')!==url.origin)return json({error:'Open GEX Gravity to save data backups.'},403);
      const data=await boundedBody(request,url.pathname.endsWith('import')?16*1024*1024:3000);
      if(url.pathname.endsWith('checkpoint'))return json(await checkpointSavedData(env,data));
      if(!Array.isArray(data.records)||!data.records.length||data.records.length>30)throw Error('Import 1 to 30 saved records at a time.');
      const results=[];
      for(const row of data.records){
        const records=await archiveDataRecords(env.BUCKET,row.name,row.value,{origin:'recovered-capture',recovered:row.name?.startsWith('recovered/')});
        if(!records.length)throw Error('Only recognized saved provider captures can be archived.');
        results.push(...records);
      }
      return json({saved:true,records:results});
    }
    return json({error:'Method not allowed.'},405);
  }catch(error){return json({error:error.message??'The data backup could not complete.',code:'BACKUP_REQUEST_FAILED'},400);}
}
