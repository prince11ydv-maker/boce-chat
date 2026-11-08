import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const origin='https://classnest.example.test';
const ownerEmail='owner@example.test',studentEmail='student@example.test';
const originalPassword='Original student secure password';
const resetPassword='Replacement student secure password';
const changedPassword='Updated student password after reset';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-email-http-')),free=net.createServer();
  await new Promise(resolve=>free.listen(0,'127.0.0.1',resolve));const port=free.address().port;await new Promise(resolve=>free.close(resolve));
  const cronSecret=randomBytes(32).toString('hex'),messages=[];let stderr='';
  const child=fork(path.join(root,'test','fixtures','email-server.mjs'),[],{cwd:root,execArgv:[],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',NODE_ENV:'test',VERCEL:'',VERCEL_URL:'',VERCEL_PROJECT_PRODUCTION_URL:'',WEBSITE_SITE_NAME:'',WEBSITE_HOSTNAME:'',PUBLIC_ORIGIN:origin,ALLOWED_HOSTS:'',EMAIL_ENABLED:'true',MAIL_HOST:'smtp-relay.brevo.com',MAIL_PORT:'587',MAIL_FROM:ownerEmail,MAIL_USER:'test-smtp-user',MAIL_PASSWORD:'fake-smtp-password-not-used',EMAIL_ENCRYPTION_KEY:randomBytes(32).toString('hex'),EMAIL_CRON_SECRET:cronSecret},stdio:['ignore','pipe','pipe','ipc']});
  child.on('message',message=>{if(message?.type==='mail')messages.push(message.message);});child.stderr.on('data',data=>{stderr+=data;});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Email test server did not start: '+stderr)),10000);child.stdout.on('data',data=>{if(String(data).includes('running')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Email test server exited '+code+': '+stderr));});});
  const base=`http://127.0.0.1:${port}`;
  async function request(route,{method='GET',body,cookie='',headers={}}={}){
    const options={method,headers:{'X-Classnest-Request':'1',Origin:origin,...headers}};if(cookie)options.headers.Cookie=cookie;
    if(body instanceof FormData)options.body=body;else if(body!==undefined){options.body=JSON.stringify(body);options.headers['Content-Type']='application/json';}
    const response=await fetch(base+route,options),result=response.headers.get('content-type')?.includes('json')?await response.json():await response.text();
    return {status:response.status,body:result,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  async function mail(predicate,after=0){for(let tries=0;tries<250;tries++){const match=messages.slice(after).find(predicate);if(match)return match;await wait(20);}throw new Error('Expected fake email was not received.');}
  async function flush(owner){
    const result=await request('/api/internal/email-delivery',{method:'POST',body:{},headers:{Authorization:'Bearer '+cronSecret}});assert.equal(result.status,200);
    for(let tries=0;tries<250;tries++){const state=await request('/api/state',{cookie:owner});assert.equal(state.status,200);if(state.body.emailDelivery?.pending===0)return;await wait(20);}throw new Error('Email queue did not settle.');
  }
  async function close(){if(!child.killed){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}rmSync(dir,{recursive:true,force:true});}
  return {request,mail,flush,messages,close};
}
function tokenFrom(message,kind){const prefix=origin+'/#'+kind+'/',url=message.text.split(/\s+/).find(value=>value.startsWith(prefix));assert.ok(url,'Expected a trusted application link in fake mail.');const token=url.slice(prefix.length);assert.match(token,/^[a-f0-9]{64}$/);return token;}
async function newNote(f,owner,subject,title){const body=new FormData();body.set('subjectId',subject);body.set('title',title);body.set('content','A class study note shared during the email integration test.');const result=await f.request('/api/notes',{method:'POST',cookie:owner,body});assert.equal(result.status,201);return result.body.id;}

test('HTTP email flows: verification, approved opt-in notifications, unsubscribe, and password recovery',async()=>{
  const f=await fixture();try{
    let result=await f.request('/api/setup',{method:'POST',body:{name:'Class Owner',email:ownerEmail,password:'Owner secure setup password'}});assert.equal(result.status,201);const owner=result.cookie;
    result=await f.request('/api/register',{method:'POST',body:{name:'Student One',email:studentEmail,password:originalPassword,semester:3}});assert.equal(result.status,202);
    result=await f.request('/api/login',{method:'POST',body:{email:studentEmail,password:originalPassword}});assert.equal(result.status,200);assert.equal(result.body.role,'pending');const student=result.cookie,studentId=result.body.id;
    result=await f.request('/api/email/preferences',{method:'PATCH',cookie:student,body:{semester:3,notes:true,notices:false,events:false}});assert.equal(result.status,200);assert.equal(result.body.verified,false);
    const verificationStart=f.messages.length;
    result=await f.request('/api/email/verification',{method:'POST',cookie:student,body:{}});assert.equal(result.status,202);assert.deepEqual(Object.keys(result.body),['message']);
    const verificationMail=await f.mail(message=>/Verify your/.test(message.subject),verificationStart),verificationToken=tokenFrom(verificationMail,'verify-email');assert.ok(!JSON.stringify(result.body).includes(verificationToken));assert.deepEqual(verificationMail.envelope.to,[studentEmail]);assert.ok(!('cc' in verificationMail));assert.ok(!('bcc' in verificationMail));
    result=await f.request('/#verify-email/'+verificationToken);assert.equal(result.status,200);
    result=await f.request('/api/email/verify?token='+verificationToken);assert.equal(result.status,404);
    result=await f.request('/api/email/verify',{method:'POST',body:{token:verificationToken}});assert.equal(result.status,200);
    result=await f.request('/api/email/verify',{method:'POST',body:{token:verificationToken}});assert.equal(result.status,400);
    result=await f.request('/api/state',{cookie:student});assert.equal(result.body.user.role,'pending');
    result=await f.request('/api/email/preferences',{cookie:student});assert.equal(result.body.verified,true);assert.equal(result.body.notes,true);

    result=await f.request('/api/subjects',{method:'POST',cookie:owner,body:{name:'Email flow subject',semester:3}});assert.equal(result.status,201);const subject=result.body.id;
    await f.flush(owner);const beforePending=f.messages.length;await newNote(f,owner,subject,'Pending student must not be notified');await f.flush(owner);assert.equal(f.messages.length,beforePending);
    result=await f.request('/api/users/'+studentId,{method:'PATCH',cookie:owner,body:{role:'member'}});assert.equal(result.status,200);
    const beforeApproved=f.messages.length;await newNote(f,owner,subject,'Approved student study notes');
    const notification=await f.mail(message=>message.subject.includes('Approved student study notes'),beforeApproved);assert.deepEqual(notification.envelope.to,[studentEmail]);assert.ok(!('cc' in notification));assert.ok(!('bcc' in notification));await f.flush(owner);
    const unsubscribe=notification.text.split(/\s+/).find(value=>value.startsWith(origin+'/#unsubscribe/'));assert.ok(unsubscribe);const [unsubscribeUser,unsubscribeToken]=unsubscribe.slice((origin+'/#unsubscribe/').length).split('/');assert.equal(unsubscribeUser,studentId);assert.match(unsubscribeToken,/^[a-f0-9]{64}$/);
    result=await f.request('/api/email/unsubscribe',{method:'POST',body:{userId:unsubscribeUser,token:unsubscribeToken}});assert.equal(result.status,200);
    result=await f.request('/api/email/preferences',{cookie:student});assert.equal(result.body.notes,false);assert.equal(result.body.notices,false);assert.equal(result.body.events,false);assert.equal(result.body.verified,true);
    const afterUnsubscribe=f.messages.length;await newNote(f,owner,subject,'Unsubscribed student must not be notified');await f.flush(owner);assert.equal(f.messages.length,afterUnsubscribe);

    result=await f.request('/api/login',{method:'POST',body:{email:studentEmail,password:originalPassword}});assert.equal(result.status,200);const secondStudentSession=result.cookie;
    const beforeReset=f.messages.length,known=await f.request('/api/forgot-password',{method:'POST',body:{email:studentEmail}}),unknown=await f.request('/api/forgot-password',{method:'POST',body:{email:'unknown@example.test'}});assert.equal(known.status,202);assert.equal(unknown.status,202);assert.deepEqual(known.body,unknown.body);
    const resetMail=await f.mail(message=>/Reset your/.test(message.subject),beforeReset),resetToken=tokenFrom(resetMail,'reset-password');assert.deepEqual(resetMail.envelope.to,[studentEmail]);assert.ok(!JSON.stringify(known.body).includes(resetToken));await f.flush(owner);
    result=await f.request('/#reset-password/'+resetToken);assert.equal(result.status,200);result=await f.request('/api/reset-password?token='+resetToken);assert.equal(result.status,404);
    result=await f.request('/api/reset-password',{method:'POST',body:{token:resetToken,password:resetPassword}});assert.equal(result.status,200);
    result=await f.request('/api/email/preferences',{cookie:student});assert.equal(result.status,401);result=await f.request('/api/email/preferences',{cookie:secondStudentSession});assert.equal(result.status,401);
    result=await f.request('/api/login',{method:'POST',body:{email:studentEmail,password:originalPassword}});assert.equal(result.status,401);
    result=await f.request('/api/login',{method:'POST',body:{email:studentEmail,password:resetPassword}});assert.equal(result.status,200);const resetSession=result.cookie;assert.equal(result.body.role,'member');
    result=await f.request('/api/reset-password',{method:'POST',body:{token:resetToken,password:'Attempted replay secure password'}});assert.equal(result.status,400);
    const beforePendingReset=f.messages.length;result=await f.request('/api/forgot-password',{method:'POST',body:{email:studentEmail}});assert.equal(result.status,202);const pendingResetMail=await f.mail(message=>/Reset your/.test(message.subject),beforePendingReset),pendingResetToken=tokenFrom(pendingResetMail,'reset-password');
    result=await f.request('/api/password',{method:'POST',cookie:resetSession,body:{current:resetPassword,password:changedPassword}});assert.equal(result.status,200);
    result=await f.request('/api/reset-password',{method:'POST',body:{token:pendingResetToken,password:'Attempted obsolete reset password'}});assert.equal(result.status,400);
    result=await f.request('/api/login',{method:'POST',body:{email:studentEmail,password:resetPassword}});assert.equal(result.status,401);result=await f.request('/api/login',{method:'POST',body:{email:studentEmail,password:changedPassword}});assert.equal(result.status,200);
    await f.flush(owner);
    assert.equal(f.messages.filter(message=>/Reset your/.test(message.subject)).length,2);assert.equal(f.messages.filter(message=>/Verify your/.test(message.subject)).length,1);assert.equal(f.messages.filter(message=>message.subject.startsWith('Classnest ·')).length,1);
  }finally{await f.close();}
});
