import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../db-adapter.js';
import {importRows,validateMigration} from '../scripts/migrate-data.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
const pdf=Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
async function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-notice-files-')),listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',EMAIL_ENABLED:'false',VERCEL:'',WEBSITE_SITE_NAME:'',PUBLIC_ORIGIN:'',ALLOWED_HOSTS:''},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Notice test server did not start')),10000);child.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});});
 async function request(route,method='GET',body,cookie){const response=await fetch(`http://127.0.0.1:${port}/api`+route,{method,headers:{'X-Classnest-Request':'1',...(body===undefined||body instanceof FormData?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});const bytes=Buffer.from(await response.arrayBuffer());return{status:response.status,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(bytes):bytes,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 return {dir,request,async close(){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;assert.equal(path.dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}};
}
function form(name,bytes,semester=3){const data=new FormData();for(const[key,value]of Object.entries({semester,title:'Notice '+name,category:'General',content:'',pinned:'true'}))data.set(key,String(value));data.set('file',new Blob([bytes],{type:'application/octet-stream'}),name);return data;}
test('notice photos and PDFs publish with scoped direct alerts, public previews/downloads, and file cleanup',async()=>{
 const f=await fixture(),req=f.request;try{
  let r=await req('/setup','POST',{name:'Owner',email:'notice-owner@example.test',password:'Notice owner test password'});assert.equal(r.status,201);const owner=r.cookie;
  async function student(name,semester){const data={name,email:name+'@example.test',password:'Notice student test password',semester};assert.equal((await req('/register','POST',data)).status,202);const login=await req('/login','POST',data);assert.equal(login.status,200);assert.equal((await req('/users/'+login.body.id,'PATCH',{role:'member'},owner)).status,200);return login.cookie;}
  const own=await student('OwnSemester',3),other=await student('OtherSemester',4);
  assert.equal((await req('/notices','POST',form('forbidden.png',png),own)).status,403);
  const ids=[];
  for(const[name,bytes,mime]of[['Class Poster.PNG',png,'image/png'],['animation.gif',gif,'image/gif'],['class routine.pdf',pdf,'application/pdf']]){
   r=await req('/notices','POST',form(name,bytes),owner);assert.equal(r.status,201,JSON.stringify(r.body));const id=r.body.id;ids.push(id);
   const state=(await req('/state?semester=3')).body,notice=state.notices.find(n=>n.id===id);assert.equal(notice.content,'');assert.equal(notice.pinned,1);assert.deepEqual(notice.attachment,{originalName:name,mime,size:bytes.length,kind:mime==='application/pdf'?'pdf':'image'});assert.ok(!JSON.stringify(notice.attachment).includes('filename'));
   r=await req('/notices/'+id+'/preview');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),mime);assert.equal(r.headers.get('content-disposition'),'inline');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-security-policy'),/sandbox/);assert.deepEqual(r.body,bytes);
   r=await req('/notices/'+id+'/download');assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment/);assert.deepEqual(r.body,bytes);
  }
  r=await req('/notifications','GET',undefined,own);assert.equal(r.body.items.filter(n=>n.type==='notice').length,3);assert.ok(r.body.items.every(n=>n.semester===3&&n.url==='#notices/'+n.reference));
  r=await req('/notifications','GET',undefined,other);assert.deepEqual(r.body.items,[]);
  for(const[name,bytes]of[['fake.jpg',Buffer.from('<script>alert(1)</script>')],['fake.png',pdf],['active.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]])assert.equal((await req('/notices','POST',form(name,bytes),owner)).status,400);
  assert.equal((await req('/notices','POST',{semester:3,title:'Empty',category:'General',content:''},owner)).status,400);
  const db=new DatabaseSync(path.join(f.dir,'classnest.sqlite'),{readOnly:true});let stored;try{stored=db.prepare('SELECT filename FROM notice_attachments WHERE notice_id=?').get(ids[0]);}finally{db.close();}
  assert.equal(existsSync(path.join(f.dir,'uploads',stored.filename)),true);assert.equal((await req('/notices/'+ids[0],'DELETE',undefined,owner)).status,200);assert.equal(existsSync(path.join(f.dir,'uploads',stored.filename)),false);assert.equal((await req('/notices/'+ids[0]+'/preview')).status,404);
  r=await req('/notices','POST',{semester:3,title:'Text still works',category:'Exam',content:'Existing text-only notices are preserved.',pinned:false},owner);assert.equal(r.status,201);
 }finally{await f.close();}
});
test('notice attachment backups retain metadata, accept legacy exports, and reject shared-file aliases',async()=>{
 const dirs=Array.from({length:2},()=>mkdtempSync(path.join(tmpdir(),'classnest-notice-backup-'))),source=await openDatabase({dataDir:dirs[0]}),target=await openDatabase({dataDir:dirs[1],initialize:false});try{
  target.sqlite.exec(readFileSync(new URL('../schema/sqlite.sql',import.meta.url),'utf8'));await source.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)','notice-owner','Owner','owner@example.test','unchanged-hash','admin',new Date().toISOString(),3);
  await source.run('INSERT INTO notices VALUES(?,?,?,?,?,?,?,?)','notice-backup',3,'Photo notice','','General',0,'notice-owner',new Date().toISOString());const filename='11111111-1111-4111-8111-111111111111.png';await source.run('INSERT INTO notice_attachments VALUES(?,?,?,?,?)','notice-backup',filename,'Notice.PNG','image/png',png.length);
  const payload=await source.exportRows();assert.equal(Object.keys(payload.tables).length,15);await importRows(target,payload);assert.deepEqual((await target.exportRows()).tables.notice_attachments,payload.tables.notice_attachments);
  const legacy=structuredClone(payload);delete legacy.tables.notice_attachments;assert.deepEqual(validateMigration(legacy).tables.notice_attachments,[]);
  const alias=structuredClone(payload);alias.tables.notes.push({id:'alias',subjectId:'unused',title:'Alias',content:'',filename,originalName:'Alias.png',mime:'image/png',size:png.length,authorId:'notice-owner',created:new Date().toISOString()});assert.throws(()=>validateMigration(alias),/duplicate notice attachment/);
 }finally{await source.close();await target.close();for(const dir of dirs){assert.equal(path.dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}}
});
