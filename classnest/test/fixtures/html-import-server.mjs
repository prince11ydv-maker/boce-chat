// Local browser harness only. Never served by the production application.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
const base=new URL('../../',import.meta.url);
const paths=new Map([
  ['/', ['test/html-import-browser.html','text/html; charset=utf-8']],
  ['/routine-html-import.js',['public/routine-html-import.js','text/javascript; charset=utf-8']],
  ['/fixtures/html-import-checks.js',['test/fixtures/html-import-checks.js','text/javascript; charset=utf-8']]
]);
let canaryRequests=0;
http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1:5662').pathname;
  res.setHeader('Cache-Control','no-store');
  if(path==='/canary'){canaryRequests++;res.writeHead(200,{'Content-Type':'text/plain'});res.end('inert parser resource canary');return;}
  if(path==='/qa-stats'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({canaryRequests}));return;}
  const file=paths.get(path);if(!file){res.writeHead(404);res.end('Not found');return;}
  try{const bytes=await readFile(new URL(file[0],base));res.writeHead(200,{'Content-Type':file[1]});res.end(bytes);}catch{res.writeHead(503);res.end('Fixture not ready');}
}).listen(5662,'127.0.0.1',()=>console.log('HTML import browser QA at http://127.0.0.1:5662'));
