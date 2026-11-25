import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const runtime=path.resolve('../gex-gravity-collector');
const target = new URL(process.env.GAMMA_SITE_ORIGIN ?? '');
if (target.protocol !== 'https:' || target.username || target.password || target.href !== target.origin + '/') {
  throw Error('Set GAMMA_SITE_ORIGIN to the HTTPS origin of your own private deployment.');
}
await mkdir(runtime,{recursive:true});
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');process.stdin.resume();
console.log('Ready for existing Site service access on hidden stdin.');
const input=await new Promise((resolve,reject)=>{let value='';process.stdin.on('data',chunk=>{value+=chunk;if(value.length>30000)reject(Error('Input too large'));if(/[\r\n]/.test(value)){process.stdin.pause();try{resolve(JSON.parse(value.trim()));}catch{reject(Error('Invalid input'));}}});});
if(process.stdin.isTTY)process.stdin.setRawMode(false);
if(typeof input.bearer!=='string'||input.bearer.length<16||/[\r\n]/.test(input.bearer))throw Error('Existing service access required.');
const script="$ErrorActionPreference='Stop'; try { $taskInput=[Console]::In.ReadToEnd() | ConvertFrom-Json; $taskSecure=ConvertTo-SecureString -String $taskInput.bearer -AsPlainText -Force; $taskEncrypted=ConvertFrom-SecureString -SecureString $taskSecure; [IO.File]::WriteAllText($taskInput.destination,$taskEncrypted); Write-Output 'Saved existing access with Windows current-user encryption.' } catch { [Console]::Out.WriteLine($_.Exception.GetType().FullName); exit 1 }";
await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')},stdio:['pipe','pipe','pipe']});child.stdin.end(JSON.stringify({bearer:input.bearer,destination:path.join(runtime,'site-access.dpapi')}));child.stdout.on('data',c=>process.stdout.write(c));child.stderr.on('data',()=>{});child.on('exit',code=>code===0?resolve():reject(Error('Windows encryption failed.')));});
input.bearer=null;
await writeFile(path.join(runtime,'config.json'),JSON.stringify({origin:target.origin,cadenceMinutes:5,browserPort:9337,browserApproved:true,menthorqEnabled:false},null,2));
