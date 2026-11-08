import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
async function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-student-lock-')),listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',EMAIL_ENABLED:'false',VERCEL:'',VERCEL_URL:'',VERCEL_PROJECT_PRODUCTION_URL:'',WEBSITE_SITE_NAME:'',WEBSITE_HOSTNAME:'',PUBLIC_ORIGIN:'',ALLOWED_HOSTS:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',data=>errors+=data);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'Student lock server did not start')),10000);child.stdout.on('data',data=>{if(String(data).includes('running')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});});
  async function request(route,method='GET',body,cookie){
    const response=await fetch(`http://127.0.0.1:${port}/api`+route,{method,headers:{'X-Classnest-Request':'1',...(body===undefined||body instanceof FormData?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(bytes):bytes,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function delayedNote(cookie,subject){
    const boundary='classnest-student-lock-boundary',prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="subjectId"\r\n\r\n${subject}\r\n--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nDelayed upload\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="delayed.txt"\r\nContent-Type: text/plain\r\n\r\nA partially uploaded note.`),tail=Buffer.from(` Remaining content.\r\n--${boundary}--\r\n`);
    const existing=new Set(readdirSync(path.join(dir,'uploads')));
    let upload;
    const response=new Promise((resolve,reject)=>{upload=http.request({host:'127.0.0.1',port,path:'/api/notes',method:'POST',headers:{'X-Classnest-Request':'1',Cookie:cookie,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':prefix.length+tail.length}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});upload.on('error',reject);});
    upload.write(prefix);
    for(let attempts=0;attempts<250;attempts++){if(readdirSync(path.join(dir,'uploads')).some(name=>!existing.has(name)))return {finish(){upload.end(tail);return response;},cancel(){upload.destroy();}};await delay(20);}
    upload.destroy();await response.catch(()=>{});throw Error('Delayed upload did not enter its file handler');
  }
  return {dir,request,delayedNote,async close(){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit;assert.equal(path.dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}};
}
function noteForm(subject,title){const body=new FormData();body.set('subjectId',subject);body.set('title',title);body.set('content','Study material for '+title);body.set('file',new Blob(['Attachment for '+title],{type:'text/plain'}),title+'.txt');return body;}
function noticeForm(selected){const body=new FormData();for(const[key,value]of Object.entries({semester:selected,title:'Semester '+selected+' notice',category:'General',content:'',pinned:'false'}))body.set(key,String(value));body.set('file',new Blob([png],{type:'image/png'}),'notice.png');return body;}

test('signed students stay in their assigned semester across state, timetable, notes and notice files while guests and approved staff retain public browsing',async()=>{
  const f=await fixture(),req=f.request;
  try{
    let result=await req('/setup','POST',{name:'Owner',email:'lock-owner@example.test',password:'Student lock owner password'});assert.equal(result.status,201);const admin=result.cookie;
    async function account(name,type='student',selected=3){const body={name,email:name+'@example.test',password:'Student lock account password',semester:selected,accountType:type,...(type==='teacher'?{semesters:[3,4]}:{})};assert.equal((await req('/register','POST',body)).status,202);const login=await req('/login','POST',body);assert.equal(login.status,200);return {...login.body,cookie:login.cookie};}
    const student=await account('locked-student'),teacher=await account('approved-teacher','teacher'),pendingTeacher=await account('pending-teacher','teacher');
    for(const[user,role]of[[student,'member'],[teacher,'teacher']])assert.equal((await req('/users/'+user.id,'PATCH',{role},admin)).status,200);
    const subjects={},notes={},notices={};
    for(const selected of[3,4]){
      result=await req('/subjects','POST',{semester:selected,name:'Locked semester '+selected},admin);assert.equal(result.status,201);subjects[selected]=result.body.id;
      result=await req('/notes','POST',noteForm(subjects[selected],'Semester '+selected),admin);assert.equal(result.status,201);notes[selected]=result.body.id;
      result=await req('/notices','POST',noticeForm(selected),admin);assert.equal(result.status,201);notices[selected]=result.body.id;
    }
    result=await req('/state','GET',undefined,student.cookie);assert.equal(result.status,200);assert.equal(result.body.selectedSemester,3);assert.equal(result.body.semesterLocked,true);assert.deepEqual(result.body.semesters.map(s=>s.id),[3]);assert.equal(result.body.notes[0].id,notes[3]);
    for(const user of[student,pendingTeacher]){
      result=await req('/state?semester=4','GET',undefined,user.cookie);assert.equal(result.status,403);assert.match(result.body.error,/assigned semester/);assert.ok(!JSON.stringify(result.body).includes('Study material'));
      assert.equal((await req('/teaching/state?semester=4','GET',undefined,user.cookie)).status,403);
      for(const type of['notes','notices'])for(const action of['preview','download'])assert.equal((await req(`/${type}/${type==='notes'?notes[4]:notices[4]}/${action}`,'GET',undefined,user.cookie)).status,403);
    }
    assert.equal((await req('/teaching/workspace?semester=4','GET',undefined,student.cookie)).status,403);
    for(const userCookie of[undefined,admin,teacher.cookie]){
      result=await req('/state?semester=4','GET',undefined,userCookie);assert.equal(result.status,200);assert.equal(result.body.selectedSemester,4);assert.equal(result.body.semesterLocked,false);assert.equal(result.body.notes[0].id,notes[4]);
      assert.equal((await req('/teaching/state?semester=4','GET',undefined,userCookie)).status,200);
      for(const type of['notes','notices'])for(const action of['preview','download'])assert.equal((await req(`/${type}/${type==='notes'?notes[4]:notices[4]}/${action}`,'GET',undefined,userCookie)).status,200);
    }
    for(const type of['notes','notices'])for(const action of['preview','download'])assert.equal((await req(`/${type}/${type==='notes'?notes[3]:notices[3]}/${action}`,'GET',undefined,student.cookie)).status,200);
    assert.equal((await req('/notes','POST',{subjectId:subjects[4],title:'Forged subject',content:'Must not publish',semester:3,role:'teacher'},student.cookie)).status,403);
    result=await req('/notes','POST',{subjectId:subjects[3],title:'Student own note',content:'Own semester note'},student.cookie);assert.equal(result.status,201);const ownNote=result.body.id;
    assert.equal((await req('/notes/'+ownNote,'PUT',{subjectId:subjects[4],title:'Move outside membership',content:'Must not move'},student.cookie)).status,403);
    assert.equal((await req('/notes/'+ownNote,'PUT',{subjectId:subjects[3],title:'Updated in class',content:'Allowed own class edit'},student.cookie)).status,200);
    assert.equal((await req('/users/'+student.id,'PATCH',{semester:4},student.cookie)).status,403);
    assert.equal((await req('/notes/'+ownNote,'PUT',{subjectId:subjects[4],title:'Admin moved note',content:'Retained history'},admin)).status,200);
    assert.equal((await req('/notes/'+ownNote,'PUT',{subjectId:subjects[3],title:'Try old ownership',content:'Must not edit'},student.cookie)).status,403);
    assert.equal((await req('/notes/'+ownNote,'DELETE',undefined,student.cookie)).status,403);
    result=await req('/my-notes','GET',undefined,student.cookie);assert.equal(result.status,200);assert.ok(!result.body.some(note=>note.id===ownNote));
    for(const selected of[3,4])assert.equal((await req('/notes','POST',{subjectId:subjects[selected],title:'Teacher '+selected,content:'Teaching material'},teacher.cookie)).status,201);
    result=await req('/my-notes','GET',undefined,teacher.cookie);assert.deepEqual(new Set(result.body.map(note=>note.semester)),new Set([3,4]));
    const delayed=await f.delayedNote(student.cookie,subjects[3]);
    try{assert.equal((await req('/users/'+student.id,'PATCH',{semester:4},admin)).status,200);result=await delayed.finish();assert.equal(result.status,403,'Reassignment during multipart body receipt must use fresh stored membership');}catch(error){delayed.cancel();throw error;}
    result=await req('/state','GET',undefined,student.cookie);assert.equal(result.status,200);assert.equal(result.body.selectedSemester,4);assert.equal(result.body.user.semester,4);assert.ok(result.body.notes.every(note=>note.title!=='Delayed upload'));
    assert.equal((await req('/state?semester=3','GET',undefined,student.cookie)).status,403);
    assert.equal((await req('/notes/'+notes[3]+'/download','GET',undefined,student.cookie)).status,403);
    result=await req('/my-notes','GET',undefined,student.cookie);assert.ok(result.body.some(note=>note.id===ownNote),'A previously owned note becomes visible only when its current semester matches the current membership');
    assert.equal((await req('/users/'+teacher.id,'PATCH',{role:'member'},admin)).status,200);
    assert.equal((await req('/state?semester=4','GET',undefined,teacher.cookie)).status,403,'A stale teacher cookie must not retain multi-semester access after demotion');
  }finally{await f.close();}
});
