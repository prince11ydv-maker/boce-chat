import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../db-adapter.js';
import {createTeachingService} from '../teaching.js';

async function fixture({onNotify}={}){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-teaching-test-')),db=await openDatabase({provider:'sqlite',dataDir:dir});
  db.sqlite.exec(readFileSync(new URL('../schema/teaching-sqlite.sql',import.meta.url),'utf8'));
  let at=Date.parse('2026-11-09T09:00:00+05:45');
  for(const [id,role,semester] of [['a','admin',3],['t','teacher',3],['t2','teacher',4],['m3','member',3],['m4','member',4],['p','pending',3]])await db.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',id,'Person '+id,id+'@example.test','unused',role,new Date(at).toISOString(),semester);
  for(const [id,semester] of [['s3',3],['s4',4]])await db.run('INSERT INTO subjects(id,semester,name,code,description,color) VALUES(?,?,?,?,?,?)',id,semester,'Subject '+id,'','','sage');
  const calls=[],service=createTeachingService({db,now:()=>at,onNotify:async n=>{calls.push(n);if(onNotify)await onNotify(n);}});
  return {db,service,calls,clock:value=>at=Date.parse(value),get at(){return at;},async close(){await db.close();assert.ok(path.basename(dir).startsWith('classnest-teaching-test-'));assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});}};
}
const slot=(changes={})=>({semester:3,teacherId:'t',subjectId:'s3',weekday:1,start:'09:10',end:'10:00',room:'Room A',revision:0,...changes});
const daily=(changes={})=>({semester:3,date:'2026-11-09',title:'Today’s classes',rows:[{teacherId:'t',subjectId:'s3',start:'10:00',end:'11:00',room:'Lab'}],revision:0,...changes});
const rejected=(fn,status)=>assert.rejects(fn,error=>error.status===status);

test('teaching assignments require fresh administrator access and approved teachers with valid semester subjects',async()=>{
  const f=await fixture();try{
    await rejected(()=>f.service.saveSlot({id:'m3',role:'admin'},slot()),403);
    await rejected(()=>f.service.saveSlot({id:'a'},slot({subjectId:'s4'})),400);
    await f.db.run("UPDATE users SET role='pending' WHERE id='t2'");
    await rejected(()=>f.service.saveSlot({id:'a'},slot({teacherId:'t2'})),400);
    const first=await f.service.saveSlot({id:'a'},slot());assert.equal(first.revision,1);assert.equal(first.teacherName,'Person t');
    await rejected(()=>f.service.saveSlot({id:'a'},slot({start:'09:30',end:'10:30'})),400);
    await rejected(()=>f.service.saveSlot({id:'a'},slot({revision:0,start:'10:10',end:'11:00'}),first.id),409);
    const changed=await f.service.saveSlot({id:'a'},slot({revision:1,start:'10:10',end:'11:00'}),first.id);assert.equal(changed.revision,2);
    const view=await f.service.workspace({id:'t'},3);assert.equal(view.slots.length,1);assert.deepEqual(view.teachers,[{id:'t',name:'Person t'}]);assert.equal(JSON.stringify(view).includes('@example'),false);
    await rejected(()=>f.service.deleteSlot({id:'a'},first.id,1),409);await f.service.deleteSlot({id:'a'},first.id,2);
    assert.equal((await f.service.workspace({id:'a'},3)).slots.length,0);
  }finally{await f.close();}
});

test('Nepal weekly occurrences remind three minutes before class once, expire at start, and never expose private account data',async()=>{
  const f=await fixture();try{
    await f.service.saveSlot({id:'a'},slot());
    const publicState=await f.service.state(null,3);assert.equal(publicState.date,'2026-11-09');assert.equal(publicState.sessions.length,1);
    const session=publicState.sessions[0];assert.equal(session.startsAt,Date.parse('2026-11-09T09:10:00+05:45'));assert.equal(session.teacherName,'Person t');assert.equal(publicState.source,'weekly');assert.equal(JSON.stringify(publicState).includes('@example'),false);assert.equal(publicState.teachers,undefined);
    assert.equal((await f.service.processDue()).reminded,0);f.clock('2026-11-09T09:06:59+05:45');assert.equal((await f.service.processDue()).reminded,0);
    f.clock('2026-11-09T09:07:00+05:45');const runs=await Promise.all([f.service.processDue(),f.service.processDue()]);assert.equal(runs.reduce((sum,r)=>sum+r.reminded,0),1);
    assert.equal(f.calls.filter(n=>n.type==='teacher-reminder').length,1);const inbox=await f.service.notifications({id:'t'});assert.equal(inbox.unread,1);assert.equal(inbox.items[0].url,'#teaching');assert.equal(inbox.items[0].reference,session.id);
    assert.equal((await f.service.notifications({id:'m3'})).items.length,0);
    f.clock('2026-11-09T09:10:00+05:45');assert.equal((await f.service.processDue()).reminded,0);assert.equal((await f.service.notifications({id:'t'})).items.length,0);
  }finally{await f.close();}
});

test('daily publication overrides weekly classes and notifies only approved accounts in the affected semester',async()=>{
  const f=await fixture();try{
    await f.service.saveSlot({id:'a'},slot());const old=(await f.service.state(null,3)).sessions[0];
    await rejected(()=>f.service.publishDaily({id:'t'},daily()),403);
    const result=await f.service.publishDaily({id:'a'},daily());assert.equal(result.revision,1);assert.equal(result.rows.length,1);
    const state=await f.service.state(null,3);assert.equal(state.source,'daily');assert.equal(state.sessions[0].start,'10:00');assert.notEqual(state.sessions[0].id,old.id);assert.equal((await f.db.get('SELECT active FROM class_occurrences WHERE id=?',old.id)).active,0);
    assert.equal((await f.service.notifications({id:'m3'})).unread,1);assert.equal((await f.service.notifications({id:'m4'})).unread,0);await rejected(()=>f.service.notifications({id:'p'}),403);
    await rejected(()=>f.service.publishDaily({id:'a'},daily()),409);assert.equal((await f.service.notifications({id:'m3'})).unread,1);
    await rejected(()=>f.service.publishDaily({id:'a'},daily({revision:1,rows:[...daily().rows,{teacherId:'t',subjectId:'s3',start:'10:30',end:'11:30',room:''}]})),400);
    await f.service.publishDaily({id:'a'},daily({revision:1,rows:[]}));const empty=await f.service.state(null,3);assert.equal(empty.source,'daily');assert.equal(empty.sessions.length,0);assert.equal(empty.dailyRoutine.revision,2);
    await f.service.processDue();assert.equal((await f.service.state(null,3)).sessions.length,0);assert.equal(f.calls.filter(n=>n.type==='daily-routine'&&n.userId==='m3').length,2);
  }finally{await f.close();}
});

test('teacher attendance validates owner, ETA or absence reason, stale revision, revocation and response window',async()=>{
  const f=await fixture();try{
    await f.service.saveSlot({id:'a'},slot());const session=(await f.service.state(null,3)).sessions[0];
    await rejected(()=>f.service.respond({id:'t2'},session.id,{response:'coming',eta:'1-5',revision:1}),403);
    await rejected(()=>f.service.respond({id:'m3',role:'teacher'},session.id,{response:'coming',eta:'1-5',revision:1}),403);
    await rejected(()=>f.service.respond({id:'t'},session.id,{response:'coming',eta:'2-10',revision:1}),400);
    await rejected(()=>f.service.respond({id:'t'},session.id,{response:'absent',reason:' ',revision:1}),400);
    const coming=await f.service.respond({id:'t'},session.id,{response:'coming',eta:'5-10',revision:1});assert.equal(coming.revision,2);assert.equal(coming.response,'coming');assert.equal(coming.eta,'5-10');
    assert.equal((await f.service.notifications({id:'m3'})).unread,1);assert.equal((await f.service.notifications({id:'m4'})).unread,0);
    await rejected(()=>f.service.respond({id:'t'},session.id,{response:'absent',reason:'Unavailable',revision:1}),409);
    const absent=await f.service.respond({id:'t'},session.id,{response:'absent',reason:'Unavailable today',revision:2});assert.equal(absent.revision,3);assert.equal(absent.eta,'');
    assert.equal((await f.service.state(null,3)).sessions[0].reason,'');assert.equal((await f.service.state({id:'a'},3)).sessions[0].reason,'');assert.equal((await f.service.workspace({id:'t'},3)).upcoming[0].reason,'Unavailable today');
    await f.service.respond({id:'t'},session.id,{response:'absent',reason:'Unavailable today',revision:3});assert.equal(f.calls.filter(n=>n.type==='class-status'&&n.userId==='m3').length,2);
    await f.db.run("UPDATE users SET role='blocked' WHERE id='t'");await rejected(()=>f.service.respond({id:'t',role:'teacher'},session.id,{response:'coming',eta:'10+',revision:3}),403);assert.equal((await f.service.state(null,3)).sessions.length,0);
    await f.db.run("UPDATE users SET role='teacher' WHERE id='t'");f.clock('2026-11-09T10:01:00+05:45');await rejected(()=>f.service.respond({id:'t'},session.id,{response:'coming',eta:'10+',revision:3}),400);
  }finally{await f.close();}
});

test('notification ownership, note deduplication, teacher assignment scope and transactional enqueue failures',async()=>{
  const f=await fixture();try{
    const assignment=await f.service.saveSlot({id:'a'},slot({teacherId:'t2'}));
    await f.db.run('INSERT INTO notes(id,subjectId,title,content,authorId,created) VALUES(?,?,?,?,?,?)','n','s3','Lecture note','Text','a',new Date(f.at).toISOString());
    const note={id:'n',subjectId:'s3',title:'Lecture note',semester:3,authorId:'a'};await f.service.notifyNote(note);await f.service.notifyNote(note);
    const inbox=await f.service.notifications({id:'m3'});assert.equal(inbox.items.length,1);assert.equal((await f.service.notifications({id:'t2'})).items.length,1);assert.equal((await f.service.notifications({id:'m4'})).items.length,0);
    await f.db.run('UPDATE users SET semester=? WHERE id=?',4,'m3');assert.equal((await f.service.notifications({id:'m3'})).items.length,0);await rejected(()=>f.service.markRead({id:'m3'},inbox.items[0].id),404);await f.service.markRead({id:'m3'},'all');assert.equal((await f.db.get('SELECT read_at FROM app_notifications WHERE id=?',inbox.items[0].id)).read_at,null);
    await f.db.run('UPDATE users SET semester=? WHERE id=?',3,'m3');assert.equal((await f.service.notifications({id:'m3'})).unread,1);
    const teacherItem=(await f.service.notifications({id:'t2'})).items[0];await f.service.deleteSlot({id:'a'},assignment.id,1);assert.equal((await f.service.notifications({id:'t2'})).items.length,0);await rejected(()=>f.service.markRead({id:'t2'},teacherItem.id),404);assert.ok(await f.db.get('SELECT id FROM app_notifications WHERE id=?',teacherItem.id));
    await rejected(()=>f.service.markRead({id:'m4'},inbox.items[0].id),404);assert.equal((await f.service.notifications({id:'m3'})).unread,1);
    await f.service.markRead({id:'m3'},inbox.items[0].id);assert.equal((await f.service.notifications({id:'m3'})).unread,0);
    const fail=createTeachingService({db:f.db,now:()=>f.at,onNotify:async()=>{throw Error('Queue unavailable');}});
    await assert.rejects(()=>fail.publishDaily({id:'a'},daily()),/Queue unavailable/);assert.equal(await f.db.get('SELECT * FROM daily_routines WHERE semester=? AND class_date=?',3,'2026-11-09'),undefined);
  }finally{await f.close();}
});

test('daily overrides reject cross-semester teacher clashes while honoring another semester’s published day off',async()=>{
  const f=await fixture();try{
    await f.service.saveSlot({id:'a'},slot({semester:4,subjectId:'s4'}));
    const overlap=daily({rows:[{teacherId:'t',subjectId:'s3',start:'09:30',end:'10:30',room:''}]});
    await rejected(()=>f.service.publishDaily({id:'a'},overlap),400);assert.equal(await f.db.get('SELECT revision FROM daily_routines WHERE semester=3'),undefined);
    await f.service.publishDaily({id:'a'},daily({semester:4,title:'Day off',rows:[]}));
    await f.service.publishDaily({id:'a'},overlap);assert.equal((await f.service.state(null,3)).sessions.length,1);assert.equal((await f.service.state(null,4)).sessions.length,0);
    await rejected(()=>f.service.publishDaily({id:'a'},daily({semester:4,revision:1,rows:[{teacherId:'t',subjectId:'s4',start:'10:00',end:'11:00',room:''}]})),400);
  }finally{await f.close();}
});

test('new weekly assignments respect existing daily classes in other semesters and the assigned semester’s daily override',async()=>{
  const f=await fixture();try{
    await f.service.publishDaily({id:'a'},daily({rows:[{teacherId:'t',subjectId:'s3',start:'09:30',end:'10:30',room:''}]}));
    await rejected(()=>f.service.saveSlot({id:'a'},slot({semester:4,subjectId:'s4'})),400);
    await f.service.publishDaily({id:'a'},daily({semester:4,title:'No classes today',rows:[]}));
    await f.service.saveSlot({id:'a'},slot({semester:4,subjectId:'s4'}));assert.equal((await f.service.state(null,4)).sessions.length,0);assert.equal((await f.service.state(null,3)).sessions.length,1);
  }finally{await f.close();}
});

test('bounded reminder batches progress past already notified classes without duplicate delivery',async()=>{
  const f=await fixture();try{
    await f.db.run('INSERT INTO subjects(id,semester,name,code,description,color) VALUES(?,?,?,?,?,?)','s5',5,'Subject s5','','','sage');
    for(let i=0;i<201;i++){
      const teacher='bulk-teacher-'+i,semester=i<100?3:i<200?4:5;
      await f.db.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',teacher,'Teacher '+i,teacher+'@example.test','unused','teacher',new Date(f.at).toISOString(),semester);
      await f.service.saveSlot({id:'a'},slot({semester,subjectId:'s'+semester,teacherId:teacher}));
    }
    f.clock('2026-11-09T09:07:00+05:45');assert.equal((await f.service.processDue()).reminded,200);assert.equal((await f.service.processDue()).reminded,1);assert.equal((await f.service.processDue()).reminded,0);
    const delivered=f.calls.filter(n=>n.type==='teacher-reminder');assert.equal(delivered.length,201);assert.equal(new Set(delivered.map(n=>n.userId)).size,201);
  }finally{await f.close();}
});

test('invalid dates, daily size limits and reassigned weekly occurrences fail safely',async()=>{
  const f=await fixture();try{
    await rejected(()=>f.service.publishDaily({id:'a'},daily({date:'2026-02-30'})),400);await rejected(()=>f.service.publishDaily({id:'a'},daily({date:'2026-11-08'})),400);
    await rejected(()=>f.service.publishDaily({id:'a'},daily({rows:Array.from({length:41},()=>daily().rows[0])})),400);
    const saved=await f.service.saveSlot({id:'a'},slot());const old=(await f.service.state(null,3)).sessions[0];
    await f.service.saveSlot({id:'a'},slot({teacherId:'t2',revision:1}),saved.id);const next=(await f.service.state(null,3)).sessions[0];assert.equal(next.teacherId,'t2');assert.notEqual(next.id,old.id);
    await rejected(()=>f.service.respond({id:'t'},old.id,{response:'coming',eta:'1-5',revision:1}),403);
    f.clock('2026-11-09T09:07:00+05:45');await f.service.processDue();assert.equal(f.calls.filter(n=>n.type==='teacher-reminder'&&n.userId==='t').length,0);assert.equal(f.calls.filter(n=>n.type==='teacher-reminder'&&n.userId==='t2').length,1);
  }finally{await f.close();}
});
