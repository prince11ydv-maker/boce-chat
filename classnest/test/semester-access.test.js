import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-semesters-')),server=net.createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',EMAIL_ENABLED:'false',VERCEL:'',VERCEL_URL:'',VERCEL_PROJECT_PRODUCTION_URL:'',WEBSITE_SITE_NAME:'',WEBSITE_HOSTNAME:'',PUBLIC_ORIGIN:'',ALLOWED_HOSTS:''},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Semester server did not start: '+stderr)),10000);child.stdout.on('data',data=>{if(String(data).includes('running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Semester server exited '+code+': '+stderr));});});
 async function request(route,{method='GET',body,cookie}={}){const headers={'X-Classnest-Request':'1'};if(cookie)headers.Cookie=cookie;let payload;if(body instanceof FormData)payload=body;else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}const response=await fetch(`http://127.0.0.1:${port}`+route,{method,headers,body:payload});return {status:response.status,body:response.headers.get('content-type')?.includes('json')?await response.json():await response.text(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 return {request,async close(){if(!child.killed){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}rmSync(dir,{recursive:true,force:true});}};
}

test('semester membership locks signed students while guests receive only login metadata and discussions stay private',async()=>{
 const f=await fixture();try{
  let r=await f.request('/api/setup',{method:'POST',body:{name:'Owner',email:'owner@example.com',password:'Owner semester test password'}});assert.equal(r.status,201);const owner=r.cookie;assert.equal(r.body.semester,3);
  for(const [index,value] of [undefined,999,'invalid',2.5].entries()){
   const body={name:'Invalid semester',email:`invalid-${index}@example.com`,password:'A valid registration password'};if(value!==undefined)body.semester=value;
   r=await f.request('/api/register',{method:'POST',body});assert.equal(r.status,400,'Registration requires an existing integer semester');
  }
  async function student(name,semester,approved=true){const email=name.toLowerCase()+'@example.com',password='Student semester test password';let result=await f.request('/api/register',{method:'POST',body:{name,email,password,semester}});assert.equal(result.status,202);assert.equal(result.cookie,undefined);result=await f.request('/api/login',{method:'POST',body:{email,password}});assert.equal(result.status,200);assert.equal(result.body.semester,semester);assert.equal(result.body.role,'pending');const user={id:result.body.id,cookie:result.cookie};if(approved){result=await f.request('/api/users/'+user.id,{method:'PATCH',cookie:owner,body:{role:'member'}});assert.equal(result.status,200);}return user;}
  const third=await student('Third',3),fourth=await student('Fourth',4),pending=await student('Pending',3,false);
  r=await f.request('/api/users',{cookie:owner});assert.equal(r.status,200);assert.equal(r.body.find(u=>u.id===fourth.id).semester,4);
  const secrets={third:'Third-semester private conversation',fourth:'Fourth-semester private conversation'};
  async function thread(user,semester,title){const result=await f.request('/api/threads',{method:'POST',cookie:user.cookie,body:{semester,title,content:title+' content'}});assert.equal(result.status,201);return result.body.id;}
  const thread3=await thread(third,3,secrets.third),thread4=await thread(fourth,4,secrets.fourth);
  r=await f.request('/api/threads/'+thread3+'/replies',{method:'POST',cookie:third.cookie,body:{content:'Private third-semester reply'}});assert.equal(r.status,201);
  r=await f.request('/api/threads/'+thread4+'/replies',{method:'POST',cookie:fourth.cookie,body:{content:'Private fourth-semester reply'}});assert.equal(r.status,201);
  for(const [viewer,own,other,forbidden] of [[third,3,4,secrets.fourth],[fourth,4,3,secrets.third]]){
   r=await f.request('/api/state?semester='+own,{cookie:viewer.cookie});assert.equal(r.status,200);assert.equal(r.body.threads.length,1);assert.ok(!JSON.stringify(r.body).includes(forbidden));
   r=await f.request('/api/state?semester='+other,{cookie:viewer.cookie});assert.equal(r.status,403);assert.match(r.body.error,/assigned semester/);assert.ok(!JSON.stringify(r.body).includes(forbidden));
  }
  for(const cookie of [undefined,pending.cookie]){
   r=await f.request('/api/state?semester=3',{cookie});assert.deepEqual(r.body.threads,[]);assert.ok(!JSON.stringify(r.body).includes(secrets.third));
   r=await f.request('/api/threads/'+thread3+'/replies',{cookie});assert.equal(r.status,403);assert.ok(!JSON.stringify(r.body).includes('Private third-semester reply'));
   r=await f.request('/api/threads/'+thread3+'/replies',{method:'POST',cookie,body:{content:'Must not appear'}});assert.equal(r.status,403);
  }
  r=await f.request('/api/threads',{method:'POST',cookie:third.cookie,body:{semester:4,title:'Forged enrollment',content:'Must not appear',role:'admin',userId:fourth.id}});assert.equal(r.status,403);
  r=await f.request('/api/threads/'+thread4+'/replies',{cookie:third.cookie});assert.equal(r.status,404);
  r=await f.request('/api/threads/'+thread4+'/replies',{method:'POST',cookie:third.cookie,body:{content:'Cross-semester attempt',semester:3}});assert.equal(r.status,404);
  r=await f.request('/api/threads/'+thread4,{method:'DELETE',cookie:third.cookie});assert.equal(r.status,404);
  r=await f.request('/api/email/preferences',{method:'PATCH',cookie:third.cookie,body:{semester:4,notes:false,notices:false,events:false}});assert.equal(r.status,200);
  r=await f.request('/api/state?semester=4',{cookie:third.cookie});assert.equal(r.status,403);r=await f.request('/api/state',{cookie:third.cookie});assert.equal(r.body.user.semester,3);assert.equal(r.body.selectedSemester,3,'Email choices never change the current class membership');
  r=await f.request('/api/threads/'+thread3+'/replies',{cookie:third.cookie});assert.equal(r.status,200);assert.equal(r.body[0].content,'Private third-semester reply');
  r=await f.request('/api/state?semester=4',{cookie:owner});assert.equal(r.body.threads[0].id,thread4);
  r=await f.request('/api/threads/'+thread4+'/replies',{cookie:owner});assert.equal(r.status,200);assert.equal(r.body[0].content,'Private fourth-semester reply');
  r=await f.request('/api/subjects',{method:'POST',cookie:owner,body:{semester:4,name:'Public semester four subject'}});assert.equal(r.status,201);const subjectId=r.body.id;
  const note=new FormData();note.set('subjectId',subjectId);note.set('title','Public note from semester four');note.set('content','Shared study notes remain available to everyone.');
  r=await f.request('/api/notes',{method:'POST',cookie:owner,body:note});assert.equal(r.status,201);
  r=await f.request('/api/state?semester=4');assert.equal(r.status,200);assert.equal(r.body.requiresLogin,true);assert.deepEqual(r.body.notes,[]);assert.deepEqual(r.body.subjects,[]);assert.deepEqual(r.body.threads,[]);assert.ok(!JSON.stringify(r.body).includes('Public note from semester four'));
  for(const cookie of [third.cookie,pending.cookie]){r=await f.request('/api/state?semester=4',{cookie});assert.equal(r.status,403);assert.match(r.body.error,/assigned semester/);}
  r=await f.request('/api/users/'+third.id,{method:'PATCH',cookie:third.cookie,body:{semester:4}});assert.equal(r.status,403,'Students cannot move themselves into another private discussion');
  r=await f.request('/api/users/'+third.id,{method:'PATCH',cookie:owner,body:{semester:999,role:'blocked'}});assert.equal(r.status,400);
  r=await f.request('/api/state?semester=3',{cookie:third.cookie});assert.equal(r.body.user.semester,3);assert.equal(r.body.user.role,'member','Invalid assignment does not partially change approval');
  r=await f.request('/api/users/'+third.id,{method:'PATCH',cookie:owner,body:{semester:4}});assert.equal(r.status,200);
  r=await f.request('/api/state?semester=4',{cookie:third.cookie});assert.equal(r.body.user.semester,4);assert.equal(r.body.user.role,'member');assert.equal(r.body.threads[0].id,thread4);
  r=await f.request('/api/threads/'+thread3+'/replies',{cookie:third.cookie});assert.equal(r.status,404,'Old cookie immediately loses the previous semester');
  r=await f.request('/api/threads/'+thread3,{method:'DELETE',cookie:third.cookie});assert.equal(r.status,404,'Even the original author cannot act outside their current semester');
  r=await f.request('/api/threads',{method:'POST',cookie:third.cookie,body:{semester:3,title:'Old assignment',content:'Must not appear'}});assert.equal(r.status,403);
  r=await f.request('/api/threads/'+thread4+'/replies',{method:'POST',cookie:third.cookie,body:{content:'New semester access works with the existing cookie'}});assert.equal(r.status,201);
  r=await f.request('/api/users/'+third.id,{method:'PATCH',cookie:owner,body:{role:'pending'}});assert.equal(r.status,200);
  r=await f.request('/api/threads/'+thread4+'/replies',{cookie:third.cookie});assert.equal(r.status,403);
  r=await f.request('/api/users/'+pending.id,{method:'PATCH',cookie:owner,body:{role:'blocked'}});assert.equal(r.status,200);
  r=await f.request('/api/state?semester=3',{cookie:pending.cookie});assert.deepEqual(r.body.threads,[]);
  r=await f.request('/api/threads/'+thread3+'/replies',{cookie:pending.cookie});assert.equal(r.status,403);
  r=await f.request('/api/threads/'+thread3,{method:'DELETE',cookie:owner});assert.equal(r.status,200);
  r=await f.request('/api/threads/'+thread3+'/replies',{cookie:owner});assert.equal(r.status,404);
 }finally{await f.close();}
});
