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
test('notice photos and PDFs publish with scoped direct alerts, authenticated previews/downloads, and file cleanup',async()=>{
 const f=await fixture(),req=f.request;try{
  let r=await req('/setup','POST',{name:'Owner',email:'notice-owner@example.test',password:'Notice owner test password'});assert.equal(r.status,201);const owner=r.cookie;
  async function student(name,semester){const data={name,email:name+'@example.test',password:'Notice student test password',semester};assert.equal((await req('/register','POST',data)).status,202);const login=await req('/login','POST',data);assert.equal(login.status,200);assert.equal((await req('/users/'+login.body.id,'PATCH',{role:'member'},owner)).status,200);return login.cookie;}
  const own=await student('OwnSemester',3),other=await student('OtherSemester',4);
  assert.equal((await req('/notices','POST',form('forbidden.png',png),own)).status,403);
  const ids=[];
  for(const[name,bytes,mime]of[['Class Poster.PNG',png,'image/png'],['animation.gif',gif,'image/gif'],['class routine.pdf',pdf,'application/pdf']]){
   r=await req('/notices','POST',form(name,bytes),owner);assert.equal(r.status,201,JSON.stringify(r.body));const id=r.body.id;ids.push(id);
   const state=(await req('/state?semester=3','GET',undefined,own)).body,notice=state.notices.find(n=>n.id===id);assert.equal(notice.content,'');assert.equal(notice.pinned,1);assert.deepEqual(notice.attachment,{originalName:name,mime,size:bytes.length,kind:mime==='application/pdf'?'pdf':'image'});assert.ok(!JSON.stringify(notice.attachment).includes('filename'));
   r=await req('/notices/'+id+'/preview','GET',undefined,own);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),mime);assert.equal(r.headers.get('content-disposition'),'inline');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-security-policy'),/sandbox/);assert.deepEqual(r.body,bytes);
   r=await req('/notices/'+id+'/download','GET',undefined,own);assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment/);assert.deepEqual(r.body,bytes);
  }
  r=await req('/notifications','GET',undefined,own);assert.equal(r.body.items.filter(n=>n.type==='notice').length,3);assert.ok(r.body.items.every(n=>n.semester===3&&n.url==='#notices/'+n.reference));
  r=await req('/notifications','GET',undefined,other);assert.deepEqual(r.body.items,[]);
  for(const[name,bytes]of[['fake.jpg',Buffer.from('<script>alert(1)</script>')],['fake.png',pdf],['active.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]])assert.equal((await req('/notices','POST',form(name,bytes),owner)).status,400);
  assert.equal((await req('/notices','POST',{semester:3,title:'Empty',category:'General',content:''},owner)).status,400);
  const db=new DatabaseSync(path.join(f.dir,'classnest.sqlite'),{readOnly:true});let stored;try{stored=db.prepare('SELECT filename FROM notice_attachments WHERE notice_id=?').get(ids[0]);}finally{db.close();}
  assert.equal(existsSync(path.join(f.dir,'uploads',stored.filename)),true);assert.equal((await req('/notices/'+ids[0],'DELETE',undefined,owner)).status,200);assert.equal(existsSync(path.join(f.dir,'uploads',stored.filename)),false);assert.equal((await req('/notices/'+ids[0]+'/preview','GET',undefined,owner)).status,404);
  r=await req('/notices','POST',{semester:3,title:'Text still works',category:'Exam',content:'Existing text-only notices are preserved.',pinned:false},owner);assert.equal(r.status,201);
 }finally{await f.close();}
});
test('approved teachers announce to selected and assigned semesters with scoped alerts and author-only editing',async()=>{
 const f=await fixture(),req=f.request;try{
  let r=await req('/setup','POST',{name:'Announcement owner',email:'announcement-owner@example.test',password:'Announcement owner test password'});assert.equal(r.status,201);const owner=r.cookie;
  async function account(name,semester,role,semesters){const body={name,email:name+'@example.test',password:'Announcement account test password',semester,accountType:semesters?'teacher':'student',...(semesters?{semesters}:{})};assert.equal((await req('/register','POST',body)).status,202);const login=await req('/login','POST',body);assert.equal(login.status,200);if(role!=='pending')assert.equal((await req('/users/'+login.body.id,'PATCH',{role},owner)).status,200);return {...login.body,cookie:login.cookie};}
  const author=await account('AnnouncementTeacher',3,'teacher',[3,4]),peer=await account('PeerTeacher',3,'teacher',[3,4]),pending=await account('PendingTeacher',4,'pending',[4]),blocked=await account('BlockedTeacher',4,'blocked',[4]);
  const students={};for(const selected of[3,4,5])students[selected]=await account('AnnouncementStudent'+selected,selected,'member');
  const announcement=selected=>({semester:selected,title:'Teacher message '+selected,category:'General',content:'Please bring your lab notebook.',pinned:false});
  for(const user of[pending,blocked,students[4]])assert.equal((await req('/notices','POST',announcement(4),user.cookie)).status,403);
  assert.equal((await req('/notices','POST',announcement(6),author.cookie)).status,403);
  r=await req('/subjects','POST',{semester:5,name:'Assigned semester subject'},owner);assert.equal(r.status,201);const subject=r.body.id;
  assert.equal((await req('/teaching/slots','POST',{semester:5,teacherId:author.id,subjectId:subject,weekday:1,start:'09:00',end:'10:00',room:'',revision:0},owner)).status,201);
  r=await req('/notices','POST',announcement(4),author.cookie);assert.equal(r.status,201,JSON.stringify(r.body));const textId=r.body.id;assert.ok(r.body.notified>=1);
  const alerts=async user=>(await req('/notifications','GET',undefined,user.cookie)).body.items.filter(n=>n.type==='notice');
  assert.equal((await alerts(students[4])).length,1);for(const selected of[3,5])assert.equal((await alerts(students[selected])).length,0);
  for(const user of[pending,blocked])assert.equal((await req('/notifications','GET',undefined,user.cookie)).status,403);
  const inboxDb=new DatabaseSync(path.join(f.dir,'classnest.sqlite'),{readOnly:true});try{for(const user of[pending,blocked])assert.equal(inboxDb.prepare('SELECT COUNT(*) count FROM app_notifications WHERE user_id=?').get(user.id).count,0);}finally{inboxDb.close();}
  const alert=(await alerts(students[4]))[0];assert.equal(alert.semester,4);assert.equal(alert.url,'#notices/'+textId);assert.match(alert.body,/AnnouncementTeacher/);
  for(const method of['PATCH','DELETE'])assert.equal((await req('/notices/'+textId,method,method==='PATCH'?{content:'Peer overwrite'}:undefined,peer.cookie)).status,403);
  assert.equal((await req('/notices/'+textId,'PATCH',{semester:3},author.cookie)).status,400);
  assert.equal((await req('/notices/'+textId,'PATCH',{content:''},author.cookie)).status,400);
  assert.equal((await req('/notices/'+textId,'PATCH',{title:'Updated teacher message',content:'Bring a calculator instead.',category:'Deadline',pinned:true},author.cookie)).status,200);
  let notice=(await req('/state?semester=4','GET',undefined,students[4].cookie)).body.notices.find(n=>n.id===textId);assert.equal(notice.authorId,author.id);assert.equal(notice.content,'Bring a calculator instead.');assert.equal(notice.pinned,1);assert.equal((await alerts(students[4])).length,1);
  r=await req('/notices','POST',form('teacher-post.png',png,3),author.cookie);assert.equal(r.status,201,JSON.stringify(r.body));const photoId=r.body.id;
  assert.equal((await req('/notices/'+photoId+'/preview','GET',undefined,students[3].cookie)).status,200);assert.equal((await req('/notices/'+photoId+'/preview','GET',undefined,students[4].cookie)).status,403);
  assert.equal((await req('/notices/'+photoId,'PATCH',{content:'',title:'Retained photo'},author.cookie)).status,200);assert.equal((await alerts(students[3])).length,1);
  r=await req('/notices','POST',announcement(5),author.cookie);assert.equal(r.status,201,JSON.stringify(r.body));const assignedId=r.body.id;assert.equal((await alerts(students[5])).length,1);
  assert.equal((await req('/teacher/semesters','PUT',{semesters:[3]},author.cookie)).status,200);
  assert.equal((await req('/notices/'+textId,'PATCH',{content:'Outside current scope'},author.cookie)).status,403);
  assert.equal((await req('/notices/'+textId,'DELETE',undefined,author.cookie)).status,403);
  assert.equal((await req('/notices/'+assignedId,'PATCH',{content:'Still assigned here.'},author.cookie)).status,200);
  assert.equal((await req('/notices/'+textId,'PATCH',{content:'Administrator correction.'},owner)).status,200);
  assert.equal((await req('/users/'+author.id,'PATCH',{role:'member'},owner)).status,200);
  assert.equal((await req('/notices','POST',announcement(3),author.cookie)).status,403);assert.equal((await req('/notices/'+photoId,'DELETE',undefined,author.cookie)).status,403);
  assert.equal((await req('/notices/'+photoId,'DELETE',undefined,owner)).status,200);
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
