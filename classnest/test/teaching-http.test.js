import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../db-adapter.js';
import {importRows,validateMigration} from '../scripts/migrate-data.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-teaching-http-')),listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',EMAIL_ENABLED:'false',VERCEL:'',WEBSITE_SITE_NAME:'',PUBLIC_ORIGIN:'',ALLOWED_HOSTS:''},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Test server did not start')),10000);child.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});});
 async function request(route,method='GET',body,cookie){const response=await fetch(`http://127.0.0.1:${port}/api`+route,{method,headers:{'X-Classnest-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 return {request,async close(){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;assert.equal(path.dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}};
}
test('teacher approval, distinct login portals, owned note editing, daily alerts and class replies work through HTTP',async()=>{
 const f=await fixture(),req=f.request;try{
  let r=await req('/setup','POST',{name:'Admin',email:'admin@example.test',password:'Teacher admin test password'});assert.equal(r.status,201);const admin=r.cookie;
  async function account(name,type,semester){const data={name,email:name+'@example.test',password:'Teacher and student test password',semester,accountType:type,role:'admin',...(type==='teacher'?{semesters:[3,4]}:{})};let result=await req('/register','POST',data);assert.equal(result.status,202);result=await req('/login','POST',{email:data.email,password:data.password,accountType:type});assert.equal(result.status,200);assert.equal(result.body.role,'pending');return {...result.body,cookie:result.cookie,data};}
  const teacher=await account('teacher','teacher',3),student=await account('student','student',3),other=await account('other','student',4);
  assert.equal((await req('/teacher/dashboard','GET',undefined,teacher.cookie)).status,403);
  assert.equal((await req('/teacher/semesters','PUT',{semesters:[3,4]},student.cookie)).status,403);
  r=await req('/login','POST',{email:teacher.data.email,password:teacher.data.password,accountType:'student'});assert.equal(r.status,401);
  r=await req('/notes','POST',{subjectId:'missing',title:'No approval',content:'No'},teacher.cookie);assert.equal(r.status,403);
  assert.equal((await req('/users/'+teacher.id,'PATCH',{role:'teacher'},student.cookie)).status,403);
  for(const [u,role]of[[teacher,'teacher'],[student,'member'],[other,'member']])assert.equal((await req('/users/'+u.id,'PATCH',{role},admin)).status,200);
  r=await req('/teacher/dashboard','GET',undefined,teacher.cookie);assert.equal(r.status,200);assert.deepEqual(r.body.selectedSemesters,[3,4]);
  assert.equal((await req('/teacher/semesters','PUT',{semesters:[999]},teacher.cookie)).status,400);
  r=await req('/users','GET',undefined,admin);assert.deepEqual(r.body.find(u=>u.id===teacher.id).teachingSemesters,[3,4]);
  r=await req('/subjects','POST',{name:'Teacher HTTP subject',semester:3},admin);assert.equal(r.status,201);const subjectId=r.body.id;
  r=await req('/notes','POST',{subjectId,title:'Teacher shared note',content:'Original teacher explanation'},teacher.cookie);assert.equal(r.status,201);const noteId=r.body.id;
  r=await req('/my-notes','GET',undefined,teacher.cookie);assert.equal(r.body[0].id,noteId);
  r=await req('/teacher/dashboard?semester=4','GET',undefined,teacher.cookie);assert.equal(r.status,200);assert.equal(r.body.counts.notes,0);assert.equal(r.body.notes.length,0);
  assert.equal((await req('/notes/'+noteId,'PUT',{subjectId,title:'Attempted takeover',content:'Changed'},student.cookie)).status,403);
  assert.equal((await req('/notes/'+noteId,'PUT',{subjectId,title:'Edited teacher note',content:'Updated explanation'},teacher.cookie)).status,200);
  r=await req('/state?semester=3','GET',undefined,student.cookie);assert.equal(r.body.notes.find(n=>n.id===noteId).content,'Updated explanation');
  r=await req('/notifications','GET',undefined,student.cookie);assert.equal(r.status,200);assert.ok(r.body.items.some(n=>n.type==='note'));
  r=await req('/notifications','GET',undefined,other.cookie);assert.deepEqual(r.body.items,[]);
  const future=new Date(Date.now()+10*60000+345*60000);if(future.getUTCHours()===23&&future.getUTCMinutes()>20){future.setUTCDate(future.getUTCDate()+1);future.setUTCHours(0,10,0,0);}const date=future.toISOString().slice(0,10),start=future.toISOString().slice(11,16),end=new Date(future.getTime()+30*60000).toISOString().slice(11,16);
  const daily={semester:3,date,title:'Daily teacher HTTP routine',rows:[{teacherId:teacher.id,subjectId,start,end,room:'Room 12'}],revision:0};
  assert.equal((await req('/daily-routines','PUT',daily,teacher.cookie)).status,403);
  assert.equal((await req('/daily-routines','PUT',daily,admin)).status,200);
  assert.equal((await req('/daily-routines','PUT',daily,admin)).status,409);
  r=await req('/teaching/state?semester=3&date='+date,'GET',undefined,student.cookie);assert.equal(r.body.source,'daily');const session=r.body.sessions[0];assert.equal(session.teacherName,'teacher');
  assert.equal((await req('/teaching/sessions/'+session.id+'/respond','POST',{response:'coming',eta:'1-5',reason:'',revision:session.revision},student.cookie)).status,403);
  assert.equal((await req('/teaching/sessions/'+session.id+'/respond','POST',{response:'absent',eta:'',reason:'',revision:session.revision},teacher.cookie)).status,400);
  r=await req('/teaching/sessions/'+session.id+'/respond','POST',{response:'coming',eta:'5-10',reason:'',revision:session.revision},teacher.cookie);assert.equal(r.status,200);assert.equal(r.body.response,'coming');
  r=await req('/teaching/sessions/'+session.id+'/respond','POST',{response:'absent',eta:'',reason:'Unable to attend today',revision:r.body.revision},teacher.cookie);assert.equal(r.status,200);
  r=await req('/teaching/state?semester=3&date='+date,'GET',undefined,student.cookie);assert.ok(!JSON.stringify(r.body).includes('Unable to attend today'),'Absence reasons are private to class notifications');
  r=await req('/notifications','GET',undefined,student.cookie);assert.ok(r.body.items.some(n=>n.type==='daily-routine'));assert.ok(r.body.items.some(n=>n.body.includes('Unable to attend today')));const id=r.body.items[0].id;
  assert.equal((await req('/notifications/'+id+'/read','PATCH',{},other.cookie)).status,404);assert.equal((await req('/notifications/'+id+'/read','PATCH',{},student.cookie)).status,200);
  assert.equal((await req('/users/'+student.id,'PATCH',{semester:4},admin)).status,200);r=await req('/notifications','GET',undefined,student.cookie);assert.deepEqual(r.body.items,[],'Reassignment removes access to old class alerts');
  assert.equal((await req('/users/'+teacher.id,'PATCH',{role:'blocked'},admin)).status,200);
  assert.equal((await req('/notes/'+noteId,'PUT',{subjectId,title:'Revoked teacher edit',content:'Not allowed'},teacher.cookie)).status,403);
  assert.equal((await req('/teaching/workspace?semester=3','GET',undefined,teacher.cookie)).status,403);
 }finally{await f.close();}
});
test('portable backups preserve teacher type, assignments, daily routines and attendance with legacy defaults',async()=>{
 const dirs=Array.from({length:2},()=>mkdtempSync(path.join(tmpdir(),'classnest-teaching-backup-'))),source=await openDatabase({dataDir:dirs[0]}),target=await openDatabase({dataDir:dirs[1],initialize:false});try{
  const {readFileSync}=await import('node:fs');target.sqlite.exec(readFileSync(new URL('../schema/sqlite.sql',import.meta.url),'utf8'));
  await source.run('INSERT INTO users (id,name,email,password,role,created,semester,accounttype) VALUES(?,?,?,?,?,?,?,?)','teacher-backup','Teacher','teacher@example.test','unchanged-hash','teacher',new Date().toISOString(),3,'teacher');
  await source.run('INSERT INTO subjects VALUES(?,?,?,?,?,?)','subject-backup',3,'Backup subject','','','sage');
  await source.run('INSERT INTO teacher_slots VALUES(?,?,?,?,?,?,?,?,?,?,?)','slot-backup',3,'teacher-backup','subject-backup',1,600,660,'R1',1,1,Date.now());
  await source.run('INSERT INTO teacher_semesters VALUES(?,?,?)','teacher-backup',3,Date.now());
  const payload=await source.exportRows();assert.equal(payload.tables.teacher_slots.length,1);assert.equal(payload.tables.teacher_semesters.length,1);await importRows(target,payload);const restored=await target.exportRows();assert.deepEqual(restored.tables.users,payload.tables.users);assert.deepEqual(restored.tables.teacher_slots,payload.tables.teacher_slots);assert.deepEqual(restored.tables.teacher_semesters,payload.tables.teacher_semesters);
  const legacy=structuredClone(payload);for(const key of ['teacher_slots','daily_routines','class_occurrences','teacher_semesters'])delete legacy.tables[key];delete legacy.tables.users[0].accounttype;assert.equal(validateMigration(legacy).tables.users[0].accounttype,'teacher');assert.deepEqual(validateMigration(legacy).tables.teacher_semesters,[]);
 }finally{await source.close();await target.close();for(const dir of dirs){assert.equal(path.dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}}
});
