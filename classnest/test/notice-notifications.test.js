import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../db-adapter.js';
import {createTeachingService} from '../teaching.js';
import {createEmailPreferences} from '../email-preferences.js';
import {createEmailOutbox} from '../email-outbox.js';
import {createMailer} from '../mailer.js';

const origin='https://classnest.example.com';
async function fixture({rejectAfterQueue=false}={}){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-notice-alerts-')),db=await openDatabase({provider:'sqlite',dataDir:dir});
  const at=Date.parse('2026-11-09T03:00:00.000Z'),calls=[],announcements=[];
  const outbox=createEmailOutbox({db,key:'de'.repeat(32),now:()=>at,mailer:{enabled:true,async sendEmail(message){calls.push(message);return {accepted:true};}}});
  const preferences=createEmailPreferences({db,now:()=>at});
  for(const [id,role,semester] of [['owner','admin',3],['student3','member',3],['student4','member',4],['teacher3','teacher',3],['assignedTeacher','teacher',4],['profileTeacher','teacher',4],['pending','pending',3],['blocked','blocked',3]])await db.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',id,id+' name',id+'@example.com','unused-existing-hash',role,new Date(at).toISOString(),semester);
  await db.run('INSERT INTO subjects(id,semester,name,code,description,color) VALUES(?,?,?,?,?,?)','s3',3,'Semester 3 subject','','','sage');
  await db.run('INSERT INTO teacher_slots(id,semester,teacher_id,subject_id,weekday,start_minute,end_minute,room,revision,active,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)','assigned-slot',3,'assignedTeacher','s3',1,600,660,'',1,1,at);
  await db.run('INSERT INTO teacher_semesters(user_id,semester,updated) VALUES(?,?,?)','profileTeacher',3,at);
  const service=createTeachingService({db,now:()=>at,onNotify:async n=>{
    announcements.push(n);const recipient=await preferences.teachingRecipient(n.userId,n.type,n.semester);
    if(recipient)await outbox.enqueue({userId:n.userId,kind:'class-notification',expires:n.expiresAt,message:{template:'class-notification',notificationId:n.id,type:n.type,semester:n.semester,title:n.title,body:n.body,actionUrl:origin+'/'+n.url,unsubscribeUrl:origin+'/#unsubscribe/'+recipient.id+'/'+outbox.unsubscribeToken(recipient)}});
    if(rejectAfterQueue)throw new Error('Simulated notification queue failure');
  }});
  async function optIn(id,extra={}){await preferences.save(id,{semester:3,notes:false,notices:true,events:false,...extra});await preferences.markVerified(id);}
  async function notice(id='notice-1',content='Read this current notice.',semester=3){await db.run('INSERT INTO notices(id,semester,title,content,category,pinned,authorId,created) VALUES(?,?,?,?,?,?,?,?)',id,semester,'Exam <notice>',content,'Exam',0,'owner',new Date(at).toISOString());return {id,semester,title:'Untrusted caller title',authorId:'student4'};}
  return {db,service,preferences,outbox,calls,announcements,optIn,notice,async close(){await db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('classnest-notice-alerts-'));rmSync(dir,{recursive:true,force:true});}};
}

test('notice publication creates scoped private account alerts once and uses current stored notice/author',async()=>{
  const f=await fixture();try{
    await f.optIn('student3');await f.optIn('assignedTeacher');await f.optIn('teacher3',{notices:false,events:true});await f.optIn('owner');await f.optIn('student4');await f.optIn('profileTeacher');
    const payload=await f.notice();assert.equal((await f.service.notifyNotice(payload)).notified,3);
    assert.deepEqual(f.announcements.map(n=>n.userId).sort(),['assignedTeacher','student3','teacher3']);
    const alert=(await f.service.notifications({id:'student3'})).items[0];assert.equal(alert.title,'Exam <notice>');assert.match(alert.body,/Read this current notice/);assert.match(alert.body,/owner name/);assert.equal(alert.url,'#notices/'+payload.id);assert.equal(alert.reference,payload.id);assert.equal(alert.type,'notice');
    for(const id of ['owner','student4','profileTeacher'])assert.equal((await f.service.notifications({id})).unread,0);
    assert.equal((await f.service.notifyNotice(payload)).notified,0);assert.equal(f.announcements.length,3);
    await assert.rejects(f.service.notifyNotice({...payload,semester:4}),error=>error.status===404);await assert.rejects(f.service.notifyNotice({...payload,id:'not-published'}),error=>error.status===404);
    assert.equal((await f.outbox.drain()).accepted,2);assert.deepEqual(f.calls.map(message=>message.to).sort(),['assignedTeacher@example.com','student3@example.com']);assert.equal((await f.db.get('SELECT notifications FROM email_budget')).notifications,2);
  }finally{await f.close();}
});

test('body-empty notices produce direct alerts and respect notice email consent rather than event consent',async()=>{
  const f=await fixture();try{
    await f.optIn('student3',{notices:false,events:true});const payload=await f.notice('body-empty-notice','');
    await f.service.notifyNotice(payload);const inbox=await f.service.notifications({id:'student3'});assert.equal(inbox.unread,1);assert.match(inbox.items[0].body,/any attachment/);assert.equal(inbox.items[0].title,'Exam <notice>');assert.equal(await f.preferences.teachingRecipient('student3','notice',3),null);assert.equal((await f.outbox.drain()).accepted,0);
    await f.optIn('student3',{notices:true,events:false});assert.equal((await f.preferences.teachingRecipient('student3','notice',3)).id,'student3');
  }finally{await f.close();}
});

test('notice mail rechecks opt-out, verification, role, semester and notice existence before transport',async()=>{
  const changes=[
    f=>f.db.run("UPDATE email_preferences SET notices=0 WHERE userId='student3'"),
    f=>f.db.run("UPDATE email_preferences SET verified=0 WHERE userId='student3'"),
    f=>f.db.run("UPDATE users SET role='blocked' WHERE id='student3'"),
    f=>f.db.run("UPDATE users SET semester=4 WHERE id='student3'"),
    f=>f.db.run("DELETE FROM notices WHERE id='notice-1'"),
    f=>f.db.run("UPDATE notices SET semester=4 WHERE id='notice-1'")
  ];
  for(const change of changes){const f=await fixture();try{
    await f.optIn('student3');await f.service.notifyNotice(await f.notice());assert.equal((await f.outbox.status()).pending,1);await change(f);await f.outbox.drain();assert.equal(f.calls.length,0);assert.equal((await f.outbox.status()).pending,0);assert.equal((await f.outbox.status()).attemptsToday,0);
  }finally{await f.close();}}
  const f=await fixture();try{
    await f.optIn('assignedTeacher');await f.service.notifyNotice(await f.notice());await f.db.run("UPDATE teacher_slots SET active=0 WHERE id='assigned-slot'");assert.equal(await f.preferences.teachingRecipient('assignedTeacher','notice',3),null);await f.outbox.drain();assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('notice insertion, direct account alerts and encrypted mail enqueue roll back together on failure',async()=>{
  const f=await fixture({rejectAfterQueue:true});try{
    await f.optIn('assignedTeacher');
    await assert.rejects(f.db.transaction(async()=>{const payload=await f.notice();await f.service.notifyNotice(payload);}),/Simulated notification queue failure/);
    assert.equal(await f.db.get("SELECT id FROM notices WHERE id='notice-1'"),undefined);assert.equal((await f.db.get('SELECT COUNT(*) count FROM app_notifications')).count,0);assert.equal((await f.outbox.status()).pending,0);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('notice email template escapes content, links to the board and rejects external destinations',async()=>{
  const sent=[];const mailer=createMailer({env:{EMAIL_ENABLED:'true',MAIL_HOST:'smtp-relay.brevo.com',MAIL_PORT:'587',MAIL_USER:'local-test',MAIL_PASSWORD:'test-only-private-password',MAIL_FROM:'owner@example.com',MAIL_FROM_NAME:'Classnest',PUBLIC_ORIGIN:origin},transportFactory:()=>({async sendMail(message){sent.push(message);return {accepted:[message.to.address]};}})});
  const message={id:'notice-email-test',to:'student@example.com',name:'Student <profile>',template:'class-notification',type:'notice',title:'Exam <notice>',body:'Read <script>bad()</script> & its attachment.',actionUrl:origin+'/#notices/notice-1',unsubscribeUrl:origin+'/#unsubscribe/student/token'};
  await mailer.sendEmail(message);assert.equal(sent.length,1);assert.match(sent[0].html,/Exam &lt;notice&gt;/);assert.match(sent[0].html,/Read &lt;script&gt;bad\(\)&lt;\/script&gt; &amp; its attachment/);assert.ok(!sent[0].html.includes('<script>'));assert.match(sent[0].text,/Read this notice/);assert.match(sent[0].text,/#notices\/notice-1/);
  await assert.rejects(mailer.sendEmail({...message,actionUrl:'https://external.example/notice'}),error=>error.code==='EMAIL_INVALID_MESSAGE');assert.equal(sent.length,1);
});
