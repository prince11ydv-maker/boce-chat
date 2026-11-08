import {randomUUID,randomBytes} from 'node:crypto';
import {openDatabase,migrationTables} from '../db-adapter.js';

// This probe exercises runtime SQL permissions and dialects, then deliberately
// rolls everything back. It never edits existing rows or writes uploaded files.
let db;
const rollback=Object.assign(new Error('Verification rollback'),{verificationRollback:true});
try{
 db=await openDatabase();
 const before={};for(const table of [...migrationTables,'sessions','auth_failures'])before[table]=(await db.get(`SELECT COUNT(*) count FROM ${table}`)).count;
 try{await db.transaction(async()=>{
   const semester=(await db.get('SELECT id FROM semesters ORDER BY id')).id,user=randomUUID(),subject=randomUUID(),note=randomUUID(),thread=randomUUID(),stamp=new Date().toISOString(),token=randomBytes(32).toString('hex');
   await db.run('INSERT INTO users (id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',user,'Temporary verification',`${user}@example.invalid`,'0'.repeat(32)+':'+'0'.repeat(128),'pending',stamp,semester);
   await db.run('INSERT INTO subjects VALUES(?,?,?,?,?,?)',subject,semester,'Temporary verification','','','sage');
   await db.run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)',note,subject,'Verification note','Text only',null,null,null,0,user,stamp);
   await db.run('INSERT INTO notices VALUES(?,?,?,?,?,?,?,?)',randomUUID(),semester,'Verification notice','Text','General',0,user,stamp);
   await db.run('INSERT INTO threads VALUES(?,?,?,?,?,?)',thread,semester,'Verification thread','Question',user,stamp);
   await db.run('INSERT INTO replies VALUES(?,?,?,?,?)',randomUUID(),thread,'Reply',user,stamp);
   await db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)',randomUUID(),semester,'Verification event','','2026-12-01T10:00','Class','',user);
   await db.run('INSERT INTO sessions VALUES(?,?,?)',token,user,Date.now()+60000);
   await db.run('DELETE FROM sessions WHERE userId=? AND token NOT IN (SELECT token FROM sessions WHERE userId=? ORDER BY expires DESC LIMIT 9)',user,user);
   await db.run('INSERT INTO auth_failures VALUES(?,?,?)',token,1,Date.now()+60000);
   await db.run('UPDATE auth_failures SET attempts=attempts+1 WHERE identity=?',token);
   if((await db.get('SELECT attempts FROM auth_failures WHERE identity=?',token)).attempts!==2)throw new Error('Failure counter query did not work.');
   await db.all('SELECT n.*,u.name author FROM notices n LEFT JOIN users u ON u.id=n.authorId WHERE n.semester=? ORDER BY n.pinned DESC,n.created DESC',semester);
   await db.all('SELECT t.*,u.name author,(SELECT COUNT(*) FROM replies r WHERE r.threadId=t.id) replyCount FROM threads t LEFT JOIN users u ON u.id=t.authorId WHERE t.semester=? ORDER BY t.created DESC',semester);
   if((await db.get('SELECT SUM(LENGTH(CAST(content AS BLOB))) bytes FROM notes')).bytes<1)throw new Error('Text storage query did not work.');
   await db.run('DELETE FROM subjects WHERE id=?',subject);if(await db.get('SELECT id FROM notes WHERE id=?',note))throw new Error('Subject cascade failed.');
   await db.run('DELETE FROM threads WHERE id=?',thread);if((await db.get('SELECT COUNT(*) count FROM replies WHERE threadId=?',thread)).count)throw new Error('Discussion cascade failed.');
   throw rollback;
 });}catch(error){if(!error.verificationRollback)throw error;}
 for(const [table,count] of Object.entries(before))if((await db.get(`SELECT COUNT(*) count FROM ${table}`)).count!==count)throw new Error('Rollback verification failed.');
 console.log(JSON.stringify({ok:true,provider:db.provider,runtimeWritesVerified:true,rollbackVerified:true}));
}catch(error){const number=error.number||error.originalError?.number||error.originalError?.info?.number;console.error(JSON.stringify({ok:false,code:number||error.code||'DATABASE_CHECK_FAILED'}));process.exitCode=1;}
finally{if(db)await db.close().catch(()=>{});}
