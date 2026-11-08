import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../db-adapter.js';
import {createTeachingService} from '../teaching.js';
import {createTeacherDashboard} from '../teacher-dashboard.js';

async function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-teacher-dashboard-')),db=await openDatabase({provider:'sqlite',dataDir:dir});
  db.sqlite.exec(readFileSync(new URL('../schema/teacher-semesters-sqlite.sql',import.meta.url),'utf8'));
  const at=Date.parse('2026-11-09T09:00:00+05:45'),teaching=createTeachingService({db,now:()=>at}),dashboard=createTeacherDashboard({db,teaching,now:()=>at});
  for(const [id,role,type,semester] of [['a','admin','student',3],['t','teacher','teacher',3],['t2','teacher','teacher',3],['p','pending','teacher',3],['s','member','student',3],['ps','pending','student',3]])await db.run('INSERT INTO users(id,name,email,password,role,created,semester,accounttype) VALUES(?,?,?,?,?,?,?,?)',id,'Person '+id,id+'@example.test','unused',role,new Date(at).toISOString(),semester,type);
  for(const semester of [3,4,5,6])await db.run('INSERT INTO subjects(id,semester,name,code,description,color) VALUES(?,?,?,?,?,?)','s'+semester,semester,'Subject '+semester,'','','sage');
  return {db,teaching,dashboard,at,async close(){await db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('classnest-teacher-dashboard-'));rmSync(dir,{recursive:true,force:true});}};
}
const rejected=(fn,status)=>assert.rejects(fn,error=>error.status===status);
const slot=(semester,changes={})=>({semester,teacherId:'t',subjectId:'s'+semester,weekday:1,start:'09:10',end:'10:00',room:'Room '+semester,revision:0,...changes});

test('teacher semester preferences persist while legacy accounts fall back to their primary semester',async()=>{
  const f=await fixture();try{
    const original=await f.dashboard.get({id:'t'});assert.deepEqual(original.selectedSemesters,[3]);assert.deepEqual(original.assignedSemesters,[]);assert.equal(original.selectedSemester,null);assert.equal(original.today,'2026-11-09');
    const saved=await f.dashboard.updateSemesters({id:'t'},[5,3,4]);assert.deepEqual(saved,{selectedSemesters:[3,4,5]});
    const reloaded=await createTeacherDashboard({db:f.db,teaching:f.teaching,now:()=>f.at}).get({id:'t'});assert.deepEqual(reloaded.selectedSemesters,[3,4,5]);assert.deepEqual(reloaded.semesters.map(row=>row.id),[3,4,5]);assert.ok(reloaded.semesters.every(row=>row.selected&&!row.assigned));
    assert.equal((await f.db.get('SELECT semester,role FROM users WHERE id=?','t')).semester,3);assert.equal((await f.db.get('SELECT semester,role FROM users WHERE id=?','t')).role,'teacher');
    assert.equal((await f.db.get('SELECT COUNT(*) count FROM teacher_slots')).count,0);
  }finally{await f.close();}
});

test('pending teacher choices never approve access and other account types cannot change teacher preferences',async()=>{
  const f=await fixture();try{
    await f.dashboard.updateSemesters({id:'p'},[3,4]);assert.equal((await f.db.get('SELECT role FROM users WHERE id=?','p')).role,'pending');await rejected(()=>f.dashboard.get({id:'p',role:'teacher'}),403);
    for(const id of ['s','ps','a']){await rejected(()=>f.dashboard.updateSemesters({id,role:'teacher'},[3,4]),403);await rejected(()=>f.dashboard.get({id,role:'teacher'}),403);}
    await f.db.run("UPDATE users SET role='blocked' WHERE id='t'");await rejected(()=>f.dashboard.get({id:'t',role:'teacher'}),403);await rejected(()=>f.dashboard.updateSemesters({id:'t'},[3]),403);
    await rejected(()=>f.dashboard.get(null),401);
  }finally{await f.close();}
});

test('invalid or duplicate profile semesters fail atomically',async()=>{
  const f=await fixture();try{
    await f.dashboard.updateSemesters({id:'t'},[3,4]);
    for(const invalid of [[],[3,3],[3,'4'],[3,999],Array.from({length:31},(_,i)=>i+1),null]){await rejected(()=>f.dashboard.updateSemesters({id:'t'},invalid),400);assert.deepEqual((await f.dashboard.get({id:'t'})).selectedSemesters,[3,4]);}
    await rejected(()=>f.dashboard.get({id:'t'},{semester:6}),400);await rejected(()=>f.dashboard.get({id:'t'},{semester:'3'}),400);await rejected(()=>f.dashboard.get({id:'t'},{other:true}),400);
  }finally{await f.close();}
});

test('dashboard aggregates only the teacher’s assigned classes across semesters and filters its counts',async()=>{
  const f=await fixture();try{
    await f.dashboard.updateSemesters({id:'t'},[3,5]);
    await f.teaching.saveSlot({id:'a'},slot(3));await f.teaching.saveSlot({id:'a'},slot(4,{start:'10:10',end:'11:00'}));await f.teaching.saveSlot({id:'a'},slot(6,{teacherId:'t2',start:'12:10',end:'13:00'}));
    const view=await f.dashboard.get({id:'t'});assert.deepEqual(view.selectedSemesters,[3,5]);assert.deepEqual(view.assignedSemesters,[3,4]);assert.deepEqual(view.semesters.map(row=>row.id),[3,4,5]);assert.equal(view.upcoming.length,2);assert.equal(view.slots.length,2);assert.ok(view.upcoming.every(row=>row.teacherId==='t'));assert.equal(view.counts.today,2);assert.equal(view.counts.pending,2);assert.equal(view.counts.semesters,3);
    const chosen=await f.dashboard.get({id:'t'},{semester:4});assert.equal(chosen.upcoming.length,1);assert.equal(chosen.upcoming[0].semester,4);assert.equal(chosen.slots.length,1);assert.equal(chosen.counts.today,1);
    assert.equal(JSON.stringify(view).includes('t2@example.test'),false);assert.equal(view.upcoming.some(row=>row.teacherId==='t2'),false);
    // Selecting an unrelated public semester must not make its private class
    // status or personal notifications readable by this teacher.
    const otherClass=(await f.teaching.workspace({id:'t2'},6)).upcoming[0];await f.teaching.respond({id:'t2'},otherClass.id,{response:'absent',reason:'Private teacher explanation',revision:otherClass.revision});
    await f.dashboard.updateSemesters({id:'t'},[3,5,6]);const unrelated=await f.dashboard.get({id:'t'},{semester:6});assert.equal(unrelated.upcoming.length,0);assert.equal(unrelated.slots.length,0);assert.equal(JSON.stringify(unrelated).includes('Private teacher explanation'),false);
    assert.equal((await f.teaching.notifications({id:'t'})).items.length,0);
  }finally{await f.close();}
});

test('an assigned daily class keeps its semester visible without changing profile choices',async()=>{
  const f=await fixture();try{
    await f.dashboard.updateSemesters({id:'t'},[3]);await f.teaching.publishDaily({id:'a'},{semester:4,date:'2026-11-09',title:'Daily',revision:0,rows:[{teacherId:'t',subjectId:'s4',start:'10:00',end:'11:00',room:''}]});
    const view=await f.dashboard.get({id:'t'});assert.deepEqual(view.selectedSemesters,[3]);assert.deepEqual(view.assignedSemesters,[4]);assert.equal(view.upcoming[0].semester,4);assert.equal(view.semesters.find(row=>row.id===4).selected,false);assert.equal(view.semesters.find(row=>row.id===4).assigned,true);
  }finally{await f.close();}
});

test('own-note metadata spans semesters while selected content is private, bounded and ownership filtered',async()=>{
  const f=await fixture();try{
    await f.dashboard.updateSemesters({id:'t'},[3,4]);
    for(const [id,semester,author,content] of [['n3',3,'t','Own three'],['n4',4,'t','Own four'],['other',3,'t2','Other teacher content']])await f.db.run('INSERT INTO notes(id,subjectId,title,content,authorId,created) VALUES(?,?,?,?,?,?)',id,'s'+semester,'Note '+id,content,author,new Date(f.at).toISOString());
    const all=await f.dashboard.get({id:'t'});assert.deepEqual(new Set(all.notes.map(row=>row.id)),new Set(['n3','n4']));assert.ok(all.notes.every(row=>!row.contentIncluded&&!Object.hasOwn(row,'content')));assert.equal(all.counts.notes,2);
    const selected=await f.dashboard.get({id:'t'},{semester:3});assert.equal(selected.notes.find(row=>row.id==='n3').content,'Own three');assert.equal(selected.notes.some(row=>row.id==='n4'),false);assert.equal(selected.counts.notes,1);
    for(let i=0;i<20;i++)await f.db.run('INSERT INTO notes(id,subjectId,title,content,authorId,created) VALUES(?,?,?,?,?,?)','large-'+i,'s3','Large '+i,'\u0000'.repeat(150000),'t',new Date(f.at+i).toISOString());
    const bounded=await f.dashboard.get({id:'t'},{semester:3});assert.ok(Buffer.byteLength(JSON.stringify(bounded),'utf8')<3*1024*1024);assert.ok(bounded.notes.some(row=>row.semester===3&&!row.contentIncluded));assert.equal(JSON.stringify(bounded).includes('Other teacher content'),false);
    for(let i=0;i<201;i++)await f.db.run('INSERT INTO notes(id,subjectId,title,content,authorId,created) VALUES(?,?,?,?,?,?)','recent-'+i,'s4','Recent '+i,'Semester four','t',new Date(f.at+1000+i).toISOString());
    assert.equal((await f.dashboard.get({id:'t'})).notesTruncated,true);
    const olderSelected=await f.dashboard.get({id:'t'},{semester:3});assert.equal(olderSelected.notes.some(row=>row.id==='n3'),true);assert.equal(olderSelected.notesTruncated,false);assert.equal(olderSelected.counts.notes,21);
  }finally{await f.close();}
});
