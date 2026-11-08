import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(env={}){
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-security-'));
 const free=net.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));
 const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',WEBSITE_SITE_NAME:'',WEBSITE_HOSTNAME:'',PUBLIC_ORIGIN:'',ALLOWED_HOSTS:'',...env},stdio:['ignore','pipe','pipe']});
 let log='';child.stderr.on('data',d=>log+=d);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start '+log)),10000);child.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+' '+log));});});
 async function request(route,{method='GET',body,cookie='',headers={},raw}={}){headers={'X-Classnest-Request':'1',...headers};if(cookie)headers.Cookie=cookie;if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';if(headers.Host){const data=raw??(body?JSON.stringify(body):undefined);return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers},res=>{const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>{const content=Buffer.concat(chunks).toString();resolve({status:res.statusCode,body:res.headers['content-type']?.includes('json')?JSON.parse(content):content});});});req.on('error',reject);req.end(data);});}const res=await fetch(base+route,{method,headers,body:raw??(body instanceof FormData?body:body?JSON.stringify(body):undefined)});const result=res.headers.get('content-type')?.includes('json')?await res.json():await res.text();return {status:res.status,body:result,cookie:res.headers.get('set-cookie')?.split(';')[0],headers:res.headers};}
 return {dir,request,db:()=>new DatabaseSync(path.join(dir,'classnest.sqlite')),async close(){if(!child.killed){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}rmSync(dir,{recursive:true,force:true});}};
}
const ownerBody={name:'Owner',email:'owner@example.com',password:'long secure password'};
async function createOwner(f){const r=await f.request('/api/setup',{method:'POST',body:ownerBody});assert.equal(r.status,201);return r.cookie;}
function noteForm(subject,title='Valid note',name='notes.pdf',content='%PDF-1.4\nTest document'){const fd=new FormData();fd.set('subjectId',subject);fd.set('title',title);fd.set('file',new Blob([content]),name);return fd;}
// Minimal OOXML-shaped ZIP directory. Upload checks never decompress its contents.
function officeFixture(){const chunks=[],central=[];let offset=0;for(const filename of ['[Content_Types].xml','word/document.xml']){const name=Buffer.from(filename),data=Buffer.from('<xml/>'),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);chunks.push(header,name,data);const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=header.length+name.length+data.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,directory,end]);}

test('security: rebinding, CSRF, malformed bodies, private registration, attachments, and ownership',async()=>{
 const f=await fixture();try{
 let r=await f.request('/api/setup',{method:'POST',headers:{Host:'attacker.example'},body:ownerBody});assert.equal(r.status,421);
 r=await f.request('/api/state');assert.equal(r.body.needsSetup,true);
 r=await f.request('/api/login',{method:'POST'});assert.equal(r.status,400);
 r=await f.request('/api/login',{method:'POST',raw:'{"password":"private broken',headers:{'Content-Type':'application/json'}});assert.equal(r.status,400);assert.equal(r.body.error,'Invalid JSON request.');
 r=await f.request('/api/login',{method:'POST',raw:'[]',headers:{'Content-Type':'application/json'}});assert.equal(r.status,400);
 const owner=await createOwner(f);
 r=await f.request('/api/subjects',{method:'POST',cookie:owner,headers:{Origin:'https://127.0.0.1'},body:{name:'Forged',semester:3}});assert.equal(r.status,403);
 r=await f.request('/api/subjects',{method:'POST',cookie:owner,headers:{'Sec-Fetch-Site':'cross-site'},body:{name:'Forged',semester:3}});assert.equal(r.status,403);
 r=await f.request('/api/login',{method:'POST',body:new FormData()});assert.equal(r.status,400);
 const signup={name:'Student',email:'student@example.com',password:'  exact spaces password  ',role:'admin',semester:3};
 const registration=await f.request('/api/register',{method:'POST',body:signup}),duplicate=await f.request('/api/register',{method:'POST',body:signup});assert.equal(registration.status,202);assert.deepEqual(registration.body,duplicate.body);assert.equal(registration.cookie,undefined);assert.equal(duplicate.cookie,undefined);
 r=await f.request('/api/login',{method:'POST',body:{email:signup.email,password:signup.password.trim()}});assert.equal(r.status,401);
 r=await f.request('/api/login',{method:'POST',body:{email:signup.email,password:signup.password}});assert.equal(r.status,200);assert.equal(r.body.role,'pending');const student=r.cookie,studentId=r.body.id;
 r=await f.request('/api/users/'+studentId,{method:'PATCH',cookie:owner,body:{role:'member'}});assert.equal(r.status,200);
 r=await f.request('/api/subjects',{method:'POST',cookie:owner,body:{name:'Security testing',semester:3}});const subject=r.body.id;assert.equal(r.status,201);
 const before=readdirSync(path.join(f.dir,'uploads')).length;
 const forgedOffice=officeFixture();forgedOffice.writeUInt32LE(0x5a4d0000,0);
 for(const [name,contents] of [['fake.pdf','<html>malicious</html>'],['fake.png','MZ executable'],['fake.docx','PK pretend Office document'],['forged.docx',forgedOffice],['fake.txt',Buffer.from([0,1,2])]]){r=await f.request('/api/notes',{method:'POST',cookie:student,body:noteForm(subject,'Disguised file',name,contents)});assert.equal(r.status,400);assert.match(r.body.error,/contents/);}
 assert.equal(readdirSync(path.join(f.dir,'uploads')).length,before);
 r=await f.request('/api/notes',{method:'POST',cookie:owner,body:noteForm(subject)});assert.equal(r.status,201);const ownerNote=r.body.id;
 r=await f.request('/api/notes/'+ownerNote,{method:'DELETE',cookie:student});assert.equal(r.status,403);
 r=await f.request('/api/notes/'+ownerNote+'/download');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.match(r.headers.get('content-security-policy'),/sandbox/);
 r=await f.request('/api/notes',{method:'POST',cookie:student,body:noteForm(subject,'Office handout','handout.docx',officeFixture())});assert.equal(r.status,201);
 r=await f.request('/api/notes',{method:'POST',cookie:student,body:noteForm(subject,'Text note','notes.txt','Plain UTF-8 study text')});assert.equal(r.status,201);
 const db=f.db();try{db.prepare('UPDATE notes SET size=? WHERE id=?').run(700*1024*1024,ownerNote);}finally{db.close();}
 r=await f.request('/api/notes',{method:'POST',cookie:student,body:noteForm(subject)});assert.equal(r.status,413);
 r=await f.request('/api/events',{method:'POST',cookie:owner,body:{title:'Bad date',date:'2026-02-30T10:00',kind:'Class',semester:3}});assert.equal(r.status,400);
 r=await f.request('/api/notices',{method:'POST',cookie:owner,body:{title:'Bad pin',content:'Info',category:'General',pinned:'false',semester:3}});assert.equal(r.status,400);
 r=await f.request('/api/state');assert.equal(r.body.user,null);assert.ok(!JSON.stringify(r.body).includes(signup.email));assert.ok(!JSON.stringify(r.body).includes('s2:'));
 }finally{await f.close();}
});

test('security: owner setup race is closed and sessions are bounded and rotated',async()=>{
 const f=await fixture();try{
 const created=await Promise.all([f.request('/api/setup',{method:'POST',body:ownerBody}),f.request('/api/setup',{method:'POST',body:{...ownerBody,email:'second@example.com'}})]);assert.deepEqual(created.map(r=>r.status).sort(),[201,409]);
 const email=created.find(r=>r.status===201).body.email;let first;
 for(let i=0;i<11;i++){const r=await f.request('/api/login',{method:'POST',body:{email,password:ownerBody.password}});assert.equal(r.status,200);first??=r.cookie;}
 const db=f.db();try{assert.equal(db.prepare('SELECT COUNT(*) count FROM sessions').get().count,10);}finally{db.close();}
 const r=await f.request('/api/users',{cookie:first});assert.equal(r.status,403);
 }finally{await f.close();}
});

test('security: password migration and per-account failed-login throttle',async()=>{
 const f=await fixture();try{
 const owner=await createOwner(f),db=f.db();
 try{const salt='1'.repeat(32),legacy=salt+':'+scryptSync(ownerBody.password,salt,64).toString('hex');db.prepare('UPDATE users SET password=? WHERE email=?').run(legacy,ownerBody.email);}finally{db.close();}
 let r=await f.request('/api/login',{method:'POST',body:{email:ownerBody.email,password:ownerBody.password}});assert.equal(r.status,200);
 const check=f.db();try{assert.match(check.prepare('SELECT password FROM users').get().password,/^s2:/);}finally{check.close();}
 r=await f.request('/api/users',{cookie:owner});assert.equal(r.status,200);
 for(let i=0;i<10;i++){r=await f.request('/api/login',{method:'POST',body:{email:'nonexistent@example.com',password:'wrong password'}});assert.equal(r.status,401);}
 r=await f.request('/api/login',{method:'POST',body:{email:'nonexistent@example.com',password:'wrong password'}});assert.equal(r.status,429);
 }finally{await f.close();}
});

test('security: production setup requires token and session cookies are secure',async()=>{
 const f=await fixture({NODE_ENV:'production',SETUP_TOKEN:'one-time-setup-token'});try{
 let r=await f.request('/api/setup',{method:'POST',body:ownerBody});assert.equal(r.status,403);
 r=await f.request('/api/setup',{method:'POST',body:{...ownerBody,token:'one-time-setup-token'}});assert.equal(r.status,201);const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
 r=await f.request('/api/state',{headers:{Host:'arbitrary.example'}});assert.equal(r.status,421);
 }finally{await f.close();}
});
