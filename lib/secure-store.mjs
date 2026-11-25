import {archiveDataRecords,isDataRecordName,DataBackupError} from './data-archive.mjs';

/** Encrypted OAuth storage. The encryption key is a hosted runtime secret.
 * Tokens and PKCE verifiers are never stored in source, browser state or logs.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const snapshotReadsByBucket=new WeakMap();
export function encode64(bytes) {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decode64(value) {
  const text = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(text, char => char.charCodeAt(0));
}
export function randomId() { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
export async function digest(value) { return encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function encryptionKey(env) {
  const bytes = decode64(env.FUTU_TOKEN_ENCRYPTION_KEY || '');
  if (bytes.length !== 32) throw Error('Encrypted connection storage is not configured.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, name, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(name)}, await encryptionKey(env), encoder.encode(JSON.stringify(value)));
  return JSON.stringify({v:1,iv:encode64(iv),cipher:encode64(new Uint8Array(cipher))});
}
export async function unseal(env, name, text) {
  const value = JSON.parse(text);
  if (value.v !== 1) throw Error('Unsupported encrypted record.');
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(value.iv),additionalData:encoder.encode(name)}, await encryptionKey(env), decode64(value.cipher));
  return JSON.parse(decoder.decode(plain));
}
export class StorageReadError extends Error {
  constructor() { super('Saved market data is temporarily unavailable. Your Futu authorization is kept. Try Check saved update again shortly.'); this.code='PRIVATE_STORAGE_UNAVAILABLE'; }
}
export function createPrivateStore(env, {readTimeoutMs=10000}={}) {
  if (!env.BUCKET || typeof env.BUCKET.get !== 'function' || !env.FUTU_TOKEN_ENCRYPTION_KEY) throw Error('Private connection storage is not configured.');
  const key = name => 'gamma-watch/v1/' + name;
  // A stalled storage body must not make a valid Futu grant look disconnected.
  // Reads only: writes retain their normal atomic storage semantics.
  async function readRecord(name, secret=false) {
    let expired=false,timer,phase='get',bytesRead=0;
    const readers=new Set();
    const cancelBody=object=>{try{object?.body?.cancel()?.catch(()=>{});}catch{}};
    const cancel=()=>{for(const reader of readers){try{reader.cancel()?.catch(()=>{});}catch{}}};
    async function consume(object,expectedLength=null){
      if(expired){cancelBody(object);throw new StorageReadError();}
      if(!object)return null;
      if(!object.body?.getReader){
        if(typeof object.text!=='function')throw new StorageReadError();
        const bytes=encoder.encode(await object.text());bytesRead+=bytes.length;
        if(expectedLength!==null&&bytes.length!==expectedLength)throw new StorageReadError();
        return bytes;
      }
      const reader=object.body.getReader();readers.add(reader);const chunks=[];let size=0;
      try{
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;bytesRead+=value.byteLength;if(size>(expectedLength??64*1024*1024)){await reader.cancel();throw new StorageReadError();}chunks.push(value);}
        if(expectedLength!==null&&size!==expectedLength)throw new StorageReadError();
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
      }finally{reader.releaseLock();readers.delete(reader);}
    }
    const operation=(async()=>{
      // Large chain records are read in pinned 1 MiB ranges. A cold full-object
      // transfer must not block connection status or consume a whole request.
      if(!secret&&name==='watch/state'&&typeof env.BUCKET.head==='function'){
        phase='metadata';const metadata=await env.BUCKET.head(key(name));
        if(expired)throw new StorageReadError();
        if(!metadata)return {value:null,etag:null};
        if(metadata.size>64*1024*1024)throw new StorageReadError();
        if(metadata.size>1024*1024){
          const rangeSize=1024*1024,parts=[],decoder=new TextDecoder();phase='ranges';
          for(let offset=0;offset<metadata.size;offset+=3*rangeSize){
            if(expired)throw new StorageReadError();
            const ranges=Array.from({length:Math.min(3,Math.ceil((metadata.size-offset)/rangeSize))},(_,i)=>({offset:offset+i*rangeSize,length:Math.min(rangeSize,metadata.size-offset-i*rangeSize)}));
            const batch=await Promise.all(ranges.map(async range=>{
              const object=await env.BUCKET.get(key(name),{range,onlyIf:{etagMatches:metadata.etag}});
              if(object?.etag!==metadata.etag){cancelBody(object);throw new StorageReadError();}
              return consume(object,range.length);
            }));
            for(const bytes of batch)parts.push(decoder.decode(bytes,{stream:true}));
          }
          parts.push(decoder.decode());phase='parse';const text=parts.join('');parts.length=0;
          return {value:JSON.parse(text),etag:metadata.etag};
        }
      }
      phase='get';const object=await env.BUCKET.get(key(name));
      if(expired){cancelBody(object);throw new StorageReadError();}
      if(!object)return {value:null,etag:null};
      phase='body';const text=decoder.decode(await consume(object));phase='parse';
      return {value:secret?await unseal(env,name,text):JSON.parse(text),etag:object.etag};
    })();
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;cancel();console.warn(JSON.stringify({event:'private_storage_read_timeout',record:name==='watch/state'?'market-snapshot':name==='oauth/connection'?'connection':'other',phase,bytesRead}));reject(new StorageReadError());},readTimeoutMs);});
    try{return await Promise.race([operation,timeout]);}catch(error){expired=true;cancel();throw error;}finally{clearTimeout(timer);}
  }
  return {
    async get(name) {
      if(name!=='watch/state')return (await readRecord(name)).value;
      // Share an in-flight large read within an isolate, never a stale cache.
      let active=snapshotReadsByBucket.get(env.BUCKET);
      if(!active){active=new Map();snapshotReadsByBucket.set(env.BUCKET,active);}
      if(active.has(name))return active.get(name);
      const pending=readRecord(name).then(record=>record.value);active.set(name,pending);
      try{return await pending;}finally{if(active.get(name)===pending)active.delete(name);}
    },
    async put(name, value) {
      if(isDataRecordName(name)){
        try{
          // Preserve the last existing capture before the first archive-aware
          // overwrite, and await the new archive before committing latest data.
          const old=await readRecord(name);
          if(old.value)await archiveDataRecords(env.BUCKET,name,old.value);
          await archiveDataRecords(env.BUCKET,name,value);
        }catch{throw new DataBackupError();}
      }
      return env.BUCKET.put(key(name), JSON.stringify(value), {httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
    },
    async remove(name) { await env.BUCKET.delete(key(name)); },
    async getSecret(name) { return (await readRecord(name,true)).value; },
    async getSecretVersion(name) { return readRecord(name,true); },
    async putSecretIfVersion(name,value,etag) {
      const result=await env.BUCKET.put(key(name),await seal(env,name,value),{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
      return !!result;
    },
    async putSecret(name, value) { await env.BUCKET.put(key(name), await seal(env,name,value), {httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}}); },
    async acquireLease(name, now, ttlMs = 240000) {
      const started=Date.now(),record=await readRecord(name),leaseNow=now+Math.max(0,Date.now()-started);
      if (record.value && record.value.until > leaseNow) return null;
      const id=randomId();
      const result=await env.BUCKET.put(key(name), JSON.stringify({id,until:leaseNow+ttlMs}), {onlyIf:record.etag?{etagMatches:record.etag}:{etagDoesNotMatch:'*'}});
      return result ? id : null;
    },
    async releaseLease(name, id) {
      const record=await readRecord(name);
      if (!record.value) return;
      const body=record.value;
      // Leave the object and release it conditionally so a late worker cannot
      // delete a newer lease acquired after the former worker timed out.
      if (body.id === id) await env.BUCKET.put(key(name), JSON.stringify({id,until:0}), {onlyIf:{etagMatches:record.etag}});
    },
  };
}
