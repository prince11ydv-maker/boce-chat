import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStorage,maxAttachmentBytes} from '../storage-adapter.js';
import {openDatabase} from '../db-adapter.js';
import {requestLimiter} from '../rate-limiter.js';

test('cloud limits persist between limiter instances and normalize client identity',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-rates-')),db=await openDatabase({dataDir:dir});
 try{
  db.sqlite.exec('CREATE TABLE rate_limits(identity TEXT PRIMARY KEY,attempts INTEGER,reset INTEGER)');
  const facade={provider:'postgres',get:db.get.bind(db),run:db.run.bind(db),transaction:db.transaction.bind(db)};
  const options={windowMs:60000,limit:2,message:{error:'Limited'}};
  const first=requestLimiter(facade,'test',options),second=requestLimiter(facade,'test',options);
  async function request(middleware,ip){const response={code:200,set(){return this;},status(n){this.code=n;return this;},json(value){this.body=value;}};await middleware({ip},response,error=>{if(error)throw error;});return response;}
  assert.equal((await request(first,'192.0.2.1')).code,200);
  assert.equal((await request(second,'192.0.2.1')).code,200);
  assert.equal((await request(first,'192.0.2.1')).code,429);
  assert.equal((await request(second,'192.0.2.2')).code,200);
  const row=await db.get('SELECT identity FROM rate_limits');assert.match(row.identity,/^[a-f0-9]{64}$/);
  await db.run('UPDATE rate_limits SET reset=?',Date.now()-1);
  assert.equal((await request(second,'192.0.2.1')).code,200);
 }finally{await db.close();rmSync(dir,{recursive:true,force:true});}
});

test('cloud storage enforces private bucket, seals before reading, and bounds bytes',async()=>{
 const calls=[],name='12345678-1234-4234-8234-123456789012.pdf';let publicBucket=false;
 const files={
  async move(from,to){calls.push(['move',from,to]);return {error:null};},
  async createSignedUrl(key,expiry,options){calls.push(['signed',key,expiry,options]);return {data:{signedUrl:'https://example.supabase.co/private'},error:null};},
  async createSignedUploadUrl(key,options){calls.push(['upload',key,options]);return {data:{signedUrl:'https://example.supabase.co/upload?token=test'},error:null};},
  async remove(keys){calls.push(['remove',keys]);return {error:null};}
 };
 const client={storage:{async getBucket(){return {data:{public:publicBucket,file_size_limit:maxAttachmentBytes},error:null};},from(){return files;}}};
 const options={url:'https://example.supabase.co',key:'x'.repeat(40),client};
 publicBucket=true;await assert.rejects(openStorage(options),/private/);publicBucket=false;
 const storage=await openStorage(options),originalFetch=globalThis.fetch;
 try{
  globalThis.fetch=async()=>{calls.push(['read']);return new Response('%PDF-1.4\nSafe test');};
  const bytes=await storage.sealUpload(name);assert.match(bytes.toString(),/%PDF/);
  assert.deepEqual(calls[0],['move','staged/'+name,'notes/'+name]);assert.equal(calls[2][0],'read');
  const upload=await storage.createSignedUpload(name);assert.equal(upload.method,'PUT');
  assert.deepEqual(calls.find(c=>c[0]==='upload'),['upload','staged/'+name,{upsert:false}]);
  await storage.signedDownload(name,'notes.pdf');assert.deepEqual(calls.at(-1),['signed','notes/'+name,60,{download:'notes.pdf'}]);
  await assert.rejects(storage.delete('../secret'),/Invalid/);
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(maxAttachmentBytes));controller.enqueue(new Uint8Array(1));controller.close();}}));
  await assert.rejects(storage.read(name),/20 MB/);
 }finally{globalThis.fetch=originalFetch;}
});
