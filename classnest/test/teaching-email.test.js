import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../db-adapter.js';
import {createEmailPreferences} from '../email-preferences.js';
import {createEmailOutbox} from '../email-outbox.js';
import {createMailer} from '../mailer.js';

const origin='https://classnest.example.com',key='cd'.repeat(32);
async function fixture(options={}){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-teaching-email-'));
  const db=await openDatabase({provider:'sqlite',dataDir:dir});
  db.sqlite.exec(readFileSync(new URL('../schema/teaching-sqlite.sql',import.meta.url),'utf8'));
  if(!db.sqlite.prepare('PRAGMA table_info(email_preferences)').all().some(column=>column.name==='teacherreminders'))db.sqlite.exec('ALTER TABLE email_preferences ADD COLUMN teacherreminders INTEGER NOT NULL DEFAULT 0');
  let at=Date.parse('2026-11-09T03:42:00.000Z');
  const calls=[],mailer={enabled:true,async sendEmail(message){calls.push(message);return {accepted:true};}};
  const outbox=createEmailOutbox({db,mailer,key,now:()=>at,...options});
  const preferences=createEmailPreferences({db,now:()=>at});
  for(const [id,role,semester] of [['teacher','teacher',3],['student','member',3],['owner','admin',3]])await db.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',id,id+' <profile>',id+'@example.com','private-existing-hash',role,new Date(at).toISOString(),semester);
  await db.run('INSERT INTO subjects(id,semester,name,code,description,color) VALUES(?,?,?,?,?,?)','math',3,'Mathematics','MTH','','sage');
  async function optIn(id,extra={}){await preferences.save(id,{semester:3,notes:true,notices:false,events:true,...extra});await preferences.markVerified(id);}
  async function occurrence(id=randomUUID(),extra={}){
    const row={id,source_key:id,source_type:'daily',source_id:'3:2026-11-09',source_revision:1,semester:3,class_date:'2026-11-09',teacher_id:'teacher',subject_id:'math',start_minute:570,end_minute:630,starts_at:at+3*60000,ends_at:at+63*60000,room:'Room 1',active:1,response:'pending',eta:'',reason:'',revision:1,updated:at,...extra};
    await db.run('INSERT INTO class_occurrences('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map(()=>'?').join(',')+')',...Object.values(row));return row;
  }
  async function notification(userId,type,reference,extra={}){
    const n={id:randomUUID(),user_id:userId,type,semester:3,title:'Your class <update>',body:'A class update & reminder.',url:'/#home',reference,expires_at:at+60000,created:at,read_at:null,...extra};
    await db.run('INSERT INTO app_notifications('+Object.keys(n).join(',')+') VALUES('+Object.keys(n).map(()=>'?').join(',')+')',...Object.values(n));return n;
  }
  const enqueue=n=>outbox.enqueue({userId:n.user_id,kind:'class-notification',expires:n.expires_at,message:{template:'class-notification',notificationId:n.id,type:n.type,semester:n.semester,title:n.title,body:n.body,actionUrl:origin+n.url,unsubscribeUrl:origin+'/#unsubscribe/'+n.user_id+'/opaque-token'}});
  return {db,preferences,outbox,calls,optIn,occurrence,notification,enqueue,now:()=>at,advance:ms=>{at+=ms;},async close(){await db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('teacher reminder consent starts off and requires verified approved teacher; student mail remains in their semester',async()=>{
  const f=await fixture();try{
    assert.equal((await f.preferences.get('teacher')).teacherReminders,false);
    await f.preferences.markVerified('teacher');assert.equal(await f.preferences.teachingRecipient('teacher','teacher-reminder',3),null);
    await f.optIn('teacher',{teacherReminders:true});assert.equal((await f.preferences.teachingRecipient('teacher','teacher-reminder',3)).id,'teacher');
    await assert.rejects(f.preferences.save('student',{semester:3,notes:true,notices:false,events:true,teacherReminders:true}),/approved teachers/);
    await f.optIn('student',{semester:4});assert.equal(await f.preferences.teachingRecipient('student','daily-routine',4),null);assert.deepEqual(await f.preferences.notificationRecipients('notes',4),[]);
    await f.db.run("UPDATE users SET role='blocked' WHERE id='teacher'");assert.equal(await f.preferences.teachingRecipient('teacher','teacher-reminder',3),null);
  }finally{await f.close();}
});

test('queued teacher reminders recheck response, assignment, opt-out, role, timing and notification expiry before SMTP',async()=>{
  const changes=[
    (f,o,n)=>f.db.run("UPDATE class_occurrences SET response='coming',eta='1-5',revision=revision+1 WHERE id=?",o.id),
    (f,o,n)=>f.db.run("UPDATE class_occurrences SET response='absent',reason='Unavailable',revision=revision+1 WHERE id=?",o.id),
    (f,o,n)=>f.db.run('UPDATE class_occurrences SET active=0 WHERE id=?',o.id),
    (f,o,n)=>f.db.run("UPDATE class_occurrences SET teacher_id='owner' WHERE id=?",o.id),
    f=>f.db.run("UPDATE email_preferences SET teacherreminders=0 WHERE userId='teacher'"),
    f=>f.db.run("UPDATE email_preferences SET verified=0 WHERE userId='teacher'"),
    f=>f.db.run("UPDATE users SET role='blocked' WHERE id='teacher'"),
    (f,o)=>f.db.run('UPDATE class_occurrences SET starts_at=? WHERE id=?',f.now(),o.id),
    (f,o)=>f.db.run('UPDATE class_occurrences SET starts_at=? WHERE id=?',f.now()+4*60000,o.id),
    (f,o,n)=>f.db.run('UPDATE app_notifications SET expires_at=? WHERE id=?',f.now(),n.id)
  ];
  for(const change of changes){const f=await fixture();try{
    await f.optIn('teacher',{teacherReminders:true});const o=await f.occurrence(),n=await f.notification('teacher','teacher-reminder',o.id);await f.enqueue(n);await change(f,o,n);await f.outbox.drain();
    assert.equal(f.calls.length,0);assert.equal((await f.outbox.status()).attemptsToday,0);assert.equal((await f.outbox.status()).pending,0);
  }finally{await f.close();}}
});

test('class mail is encrypted, deduplicated by notification, delivered once to current teacher and counted against notification allowance',async()=>{
  const f=await fixture();try{
    await f.optIn('teacher',{teacherReminders:true});const o=await f.occurrence(),n=await f.notification('teacher','teacher-reminder',o.id);
    const first=await f.enqueue(n),second=await f.enqueue(n);assert.equal(first,second);assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_outbox')).count,1);
    const stored=await f.db.get('SELECT payload FROM email_outbox');assert.ok(!stored.payload.includes(n.title));assert.ok(!stored.payload.includes(n.body));
    assert.equal((await f.outbox.drain()).accepted,1);assert.equal(f.calls[0].to,'teacher@example.com');assert.equal(f.calls[0].template,'class-notification');assert.equal((await f.db.get('SELECT notifications FROM email_budget')).notifications,1);
  }finally{await f.close();}
});

test('note and daily emails suppress moved students, deleted notes and superseded daily publications',async()=>{
  const f=await fixture();try{
    await f.optIn('student');
    await f.db.run('INSERT INTO notes(id,subjectId,title,content,authorId,created) VALUES(?,?,?,?,?,?)','note-1','math','Teacher notes','Notes','teacher',new Date(f.now()).toISOString());
    let n=await f.notification('student','note','note-1');await f.enqueue(n);await f.db.run("UPDATE users SET semester=4 WHERE id='student'");await f.outbox.drain();assert.equal(f.calls.length,0);
    await f.db.run("UPDATE users SET semester=3 WHERE id='student'");n=await f.notification('student','note','note-1');await f.enqueue(n);await f.db.run("DELETE FROM notes WHERE id='note-1'");await f.outbox.drain();assert.equal(f.calls.length,0);
    await f.db.run('INSERT INTO daily_routines(semester,class_date,title,rows_json,revision,updated) VALUES(?,?,?,?,?,?)',3,'2026-11-09','Daily routine','[]',2,f.now());
    n=await f.notification('student','daily-routine','daily:3:2026-11-09:1');await f.enqueue(n);await f.outbox.drain();assert.equal(f.calls.length,0);
    n=await f.notification('student','daily-routine','daily:3:2026-11-09:2');await f.enqueue(n);assert.equal((await f.outbox.drain()).accepted,1);assert.equal(f.calls[0].to,'student@example.com');
  }finally{await f.close();}
});

test('teacher reply emails require the current active response revision',async()=>{
  const f=await fixture();try{
    await f.optIn('student');const o=await f.occurrence(undefined,{response:'absent',reason:'Unavailable',revision:2});
    let n=await f.notification('student','class-status',o.id+':1');await f.enqueue(n);await f.outbox.drain();assert.equal(f.calls.length,0);
    n=await f.notification('student','class-status',o.id+':2');await f.enqueue(n);assert.equal((await f.outbox.drain()).accepted,1);
    n=await f.notification('student','class-status',o.id+':2');await f.enqueue(n);await f.db.run('UPDATE class_occurrences SET active=0 WHERE id=?',o.id);await f.outbox.drain();assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('class email template escapes teacher data and sends only same-origin response links',async()=>{
  const calls=[];const mailer=createMailer({env:{EMAIL_ENABLED:'true',MAIL_HOST:'smtp-relay.brevo.com',MAIL_PORT:'587',MAIL_USER:'local-test',MAIL_PASSWORD:'private-test-password',MAIL_FROM:'owner@example.com',MAIL_FROM_NAME:'Classnest',PUBLIC_ORIGIN:origin},transportFactory:()=>({async sendMail(message){calls.push(message);return {accepted:[message.to.address]};}})});
  const message={id:'class-test-message',to:'teacher@example.com',name:'Teacher <img>',template:'class-notification',type:'teacher-reminder',title:'Mathematics in 3 minutes',body:'Room <script>bad()</script> & class',actionUrl:origin+'/#teaching',unsubscribeUrl:origin+'/#unsubscribe/user/token'};
  await mailer.sendEmail(message);assert.match(calls[0].html,/Room &lt;script&gt;bad\(\)&lt;\/script&gt; &amp; class/);assert.ok(!calls[0].html.includes('<script>'));assert.match(calls[0].text,/Respond to your class reminder/);
  await assert.rejects(mailer.sendEmail({...message,actionUrl:'https://external.example/steal'}),error=>error.code==='EMAIL_INVALID_MESSAGE');assert.equal(calls.length,1);
});
