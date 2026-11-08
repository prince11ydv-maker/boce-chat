import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,sqlServerQuery,postgresQuery,migrationTables} from '../db-adapter.js';
import {importRows,validateMigration} from '../scripts/migrate-data.mjs';

test('SQL Server compiler binds values, handles reserved names, nested LIMIT and text bytes',()=>{
 const compiled=sqlServerQuery("SELECT '?' literal FROM auth_failures WHERE identity=? AND reset>? AND 'it''s ?'='it''s ?'");
 assert.equal(compiled.parameterCount,2);assert.equal(compiled.query,"SELECT '?' literal FROM auth_failures WHERE [identity]=@p0 AND [reset]>@p1 AND 'it''s ?'='it''s ?'");
 assert.equal(sqlServerQuery('DELETE FROM sessions WHERE userId=? AND token NOT IN (SELECT token FROM sessions WHERE userId=? ORDER BY expires DESC LIMIT 9)').query,'DELETE FROM sessions WHERE userId=@p0 AND token NOT IN (SELECT TOP (9) token FROM sessions WHERE userId=@p1 ORDER BY expires DESC)');
 assert.equal(sqlServerQuery('SELECT SUM(LENGTH(CAST(content AS BLOB))) bytes FROM notes').query,'SELECT SUM(DATALENGTH(content)) bytes FROM notes');
 assert.equal(sqlServerQuery('SELECT [identity],[reset] FROM auth_failures').query,'SELECT [identity],[reset] FROM auth_failures');
});

test('database writes serialize, rollback atomically, and nested transactions share context',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-adapter-')),db=await openDatabase({dataDir:dir});
 try{
  const order=[];
  await Promise.all([db.transaction(async()=>{order.push(1);await new Promise(r=>setTimeout(r,20));await db.run('INSERT INTO subjects VALUES(?,?,?,?,?,?)','subject-a',3,'First','','','sage');order.push(2);}),db.transaction(async()=>{order.push(3);assert.ok(await db.get('SELECT id FROM subjects WHERE id=?','subject-a'));})]);
  assert.deepEqual(order,[1,2,3]);
  await assert.rejects(db.transaction(async()=>{await db.run('UPDATE subjects SET name=? WHERE id=?','Should rollback','subject-a');await db.transaction(async()=>{throw new Error('Fail atomically');});}),/Fail atomically/);
  assert.equal((await db.get('SELECT name FROM subjects WHERE id=?','subject-a')).name,'First');
 }finally{await db.close();rmSync(dir,{recursive:true,force:true});}
});

test('portable migration preserves IDs/hashes, omits sessions, and refuses occupied targets',async()=>{
 const sourceDir=mkdtempSync(path.join(tmpdir(),'classnest-source-')),targetDir=mkdtempSync(path.join(tmpdir(),'classnest-target-'));
 const source=await openDatabase({dataDir:sourceDir}),target=await openDatabase({dataDir:targetDir,initialize:false});
 try{
  target.sqlite.exec(readFileSync(new URL('../schema/sqlite.sql',import.meta.url),'utf8'));
  await source.run('INSERT INTO users (id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)','owner-123','Owner','owner@example.com','legacy-salt:legacy-hash','admin','2026-11-05T00:00:00.000Z',3);
  await source.run('INSERT INTO subjects VALUES(?,?,?,?,?,?)','subject-123',3,'Calculus II','MTH210','Notes','sage');
  await source.run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)','note-123','subject-123','Original note','Content',null,null,null,0,'owner-123','2026-11-05T00:00:00.000Z');
  await source.run('INSERT INTO sessions VALUES(?,?,?)','old-session','owner-123',Date.now()+100000);
  const payload=await source.exportRows();assert.deepEqual(Object.keys(payload.tables),migrationTables);assert.ok(!payload.tables.sessions);
  await importRows(target,payload);
  assert.equal((await target.get('SELECT password,semester FROM users WHERE id=?','owner-123')).password,'legacy-salt:legacy-hash');assert.equal((await target.get('SELECT semester FROM users WHERE id=?','owner-123')).semester,3);assert.equal((await target.get('SELECT title FROM notes WHERE id=?','note-123')).title,'Original note');assert.equal((await target.get('SELECT COUNT(*) count FROM sessions')).count,0);
  await assert.rejects(importRows(target,payload),/not empty/);
  assert.equal((await target.get('SELECT COUNT(*) count FROM notes')).count,1);
  const bad=structuredClone(payload);bad.tables.notes[0].filename='../../secrets.pdf';assert.throws(()=>validateMigration(bad),/attachment/);
  const extra=structuredClone(payload);extra.tables.sessions=[];assert.throws(()=>validateMigration(extra),/Unexpected/);
 }finally{await source.close();await target.close();rmSync(sourceDir,{recursive:true,force:true});rmSync(targetDir,{recursive:true,force:true});}
});

test('legacy semester upgrade preserves accounts, sessions, and class history; old exports gain the workspace semester',async()=>{
 const sourceDir=mkdtempSync(path.join(tmpdir(),'classnest-legacy-semester-')),targetDir=mkdtempSync(path.join(tmpdir(),'classnest-legacy-export-'));
 const old=new DatabaseSync(path.join(sourceDir,'classnest.sqlite'));
 old.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY,name TEXT,institution TEXT,semester INTEGER NOT NULL); CREATE TABLE semesters(id INTEGER PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,password TEXT,role TEXT,created TEXT); CREATE TABLE sessions(token TEXT PRIMARY KEY,userId TEXT REFERENCES users(id),expires BIGINT); CREATE TABLE threads(id TEXT PRIMARY KEY,semester INTEGER,title TEXT,content TEXT,authorId TEXT,created TEXT);');
 old.prepare('INSERT INTO settings VALUES(?,?,?,?)').run(1,'Existing class','Engineering',4);old.prepare('INSERT INTO semesters VALUES(?,?)').run(4,'Semester 4');
 old.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('legacy-owner','Existing owner','legacy@example.com','unchanged-private-password-hash','admin','2026-11-05T00:00:00.000Z');
 old.prepare('INSERT INTO sessions VALUES(?,?,?)').run('unchanged-session-digest','legacy-owner',Date.now()+600000);
 old.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('old-thread',4,'Existing class conversation','Keep the original history','legacy-owner','2026-11-05T00:00:00.000Z');old.close();
 let source,target;
 try{
  source=await openDatabase({provider:'sqlite',dataDir:sourceDir});
  const user=await source.get('SELECT * FROM users WHERE id=?','legacy-owner');assert.equal(user.semester,4);assert.equal(user.password,'unchanged-private-password-hash');assert.equal(user.role,'admin');
  assert.equal((await source.get('SELECT token FROM sessions WHERE userId=?','legacy-owner')).token,'unchanged-session-digest');assert.equal((await source.get('SELECT content FROM threads WHERE id=?','old-thread')).content,'Keep the original history');
  await source.close();source=await openDatabase({provider:'sqlite',dataDir:sourceDir});assert.equal((await source.get('SELECT semester FROM users WHERE id=?','legacy-owner')).semester,4,'Upgrade is repeatable without changing assignment');
  const legacyPayload=await source.exportRows();for(const row of legacyPayload.tables.users)delete row.semester;validateMigration(legacyPayload);
  target=await openDatabase({provider:'sqlite',dataDir:targetDir,initialize:false});target.sqlite.exec(readFileSync(new URL('../schema/sqlite.sql',import.meta.url),'utf8'));await importRows(target,legacyPayload);
  const imported=await target.get('SELECT password,semester FROM users WHERE id=?','legacy-owner');assert.equal(imported.password,'unchanged-private-password-hash');assert.equal(imported.semester,4);assert.equal((await target.get('SELECT count(*) count FROM sessions')).count,0);assert.equal((await target.get('SELECT content FROM threads WHERE id=?','old-thread')).content,'Keep the original history');
 }finally{if(source)await source.close();if(target)await target.close();rmSync(sourceDir,{recursive:true,force:true});rmSync(targetDir,{recursive:true,force:true});}
});

test('App Service never silently creates a network-share SQLite database',async()=>{
 const previous=process.env.WEBSITE_SITE_NAME;process.env.WEBSITE_SITE_NAME='classnest-test';
 try{await assert.rejects(openDatabase({provider:'sqlite'}),/requires DB_PROVIDER=azure-sql/);}finally{if(previous===undefined)delete process.env.WEBSITE_SITE_NAME;else process.env.WEBSITE_SITE_NAME=previous;}
});

test('Postgres binds values and retains camelCase API keys without changing quoted text',()=>{
 const compiled=postgresQuery("SELECT n.subjectId,n.originalName,u.name subjectName,'userId ? it''s' literal FROM notes n JOIN users u ON u.id=n.authorId WHERE n.subjectId=? AND n.size>? LIMIT 10");
 assert.equal(compiled.parameterCount,2);
 assert.equal(compiled.query,"SELECT n.\"subjectId\",n.\"originalName\",u.name \"subjectName\",'userId ? it''s' literal FROM notes n JOIN users u ON u.id=n.\"authorId\" WHERE n.\"subjectId\"=$1 AND n.size>$2 LIMIT 10");
 assert.equal(postgresQuery('SELECT "userId",SUM(LENGTH(CAST(content AS BLOB))) bytes FROM notes').query,'SELECT "userId",SUM(octet_length(content)) bytes FROM notes');
});

test('Vercel refuses ephemeral SQLite instead of losing workspace data',async()=>{
 const previous=process.env.VERCEL;process.env.VERCEL='1';
 try{await assert.rejects(openDatabase({provider:'sqlite'}),/Vercel requires DB_PROVIDER=postgres/);}finally{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;}
});
