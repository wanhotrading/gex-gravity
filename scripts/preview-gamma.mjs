import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
const source = await readFile(new URL('../worker/index.js',import.meta.url),'utf8');
const {default:worker} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const server=http.createServer(async(req,res)=>{
 try {
  const response=await worker.fetch(new Request('http://127.0.0.1:4317'+req.url,{method:req.method}));
  res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
 }catch{res.writeHead(500);res.end('Preview error');}
});
server.listen(4317,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4317'));
