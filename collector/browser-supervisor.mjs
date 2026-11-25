import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
export async function ensureCollectorBrowser(runtime){
  try{await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',fileURLToPath(new URL('./browser-supervisor.ps1',import.meta.url)),'-Runtime',path.resolve(runtime)],{windowsHide:true,timeout:25000,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')}});}
  catch{throw Error('MQ_BROWSER_SETUP_REQUIRED');}
}
