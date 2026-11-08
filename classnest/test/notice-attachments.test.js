import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../db-adapter.js';
import {createNoticeAttachments,validateNoticeAttachmentMetadata,publicNoticeAttachment,noticeAttachmentTypes,noticeAttachmentColumns,maxNoticeAttachmentBytes} from '../notice-attachments.js';

const metadata=(changes={})=>({notice_id:'n3',filename:randomUUID()+'.pdf',original_name:'Exam notice.pdf',mime:'application/pdf',size:100,...changes});
const rejected=(fn,status)=>assert.rejects(fn,error=>error.status===status);
async function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-notice-attachments-')),db=await openDatabase({provider:'sqlite',dataDir:dir});
  db.sqlite.exec(readFileSync(new URL('../schema/notice-attachments-sqlite.sql',import.meta.url),'utf8'));
  await db.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)','a','Administrator','admin@example.test','unused','admin',new Date().toISOString(),3);
  for(const [id,semester] of [['n3',3],['n3b',3],['n4',4]])await db.run('INSERT INTO notices VALUES(?,?,?,?,?,?,?,?)',id,semester,'Notice '+id,'Text','General',0,'a',new Date().toISOString());
  return {db,attachments:createNoticeAttachments({db}),async close(){await db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('classnest-notice-attachments-'));rmSync(dir,{recursive:true,force:true});}};
}

test('notice attachment metadata accepts only supported PDF/photo names, MIME pairs, generated references and bounded sizes',()=>{
  for(const [extension,mime] of Object.entries(noticeAttachmentTypes)){
    const record=metadata({filename:randomUUID()+'.'+extension,original_name:'Photo.'+extension.toUpperCase(),mime,size:maxNoticeAttachmentBytes});
    assert.deepEqual(validateNoticeAttachmentMetadata(record),record);
    const visible=publicNoticeAttachment(record);assert.equal(visible.kind,extension==='pdf'?'pdf':'image');assert.equal(visible.originalName,record.original_name);assert.equal(visible.filename,undefined);assert.equal(visible.notice_id,undefined);
  }
  assert.equal(Object.isFrozen(noticeAttachmentColumns),true);assert.equal(Object.isFrozen(noticeAttachmentTypes),true);
  const bad=[{size:0},{size:-1},{size:1.5},{size:maxNoticeAttachmentBytes+1},{size:'100'},{filename:'../notice.pdf'},{filename:'notes/'+randomUUID()+'.pdf'},{filename:randomUUID()+'.svg'},{filename:'a'.repeat(36)+'.pdf'},{original_name:'../notice.pdf'},{original_name:'C:\\notice.pdf'},{original_name:'notice.pdf\r\nX-Test: value'},{original_name:'notice\u0000.pdf'},{original_name:'x'.repeat(201)+'.pdf'},{original_name:'notice.html'},{mime:'text/html'},{mime:'application/pdf; charset=utf-8'},{notice_id:''},{notice_id:'x'.repeat(101)}];
  for(const changes of bad)assert.throws(()=>validateNoticeAttachmentMetadata(metadata(changes)),error=>error.status===400);
  assert.throws(()=>validateNoticeAttachmentMetadata({...metadata(),extra:'not permitted'}),error=>error.status===400);
  assert.throws(()=>validateNoticeAttachmentMetadata(null),error=>error.status===400);
});

test('notice attachments preserve old notice inserts, list only the requested semester, and keep public metadata free of storage paths',async()=>{
  const f=await fixture();try{
    const record=metadata();await f.attachments.attach('n3',record);
    const other=metadata({notice_id:'n4',filename:randomUUID()+'.png',original_name:'Class photo.png',mime:'image/png'});await f.attachments.attach('n4',other);
    assert.deepEqual(await f.attachments.get('n3'),record);assert.deepEqual(await f.attachments.list(3),[record]);assert.deepEqual(await f.attachments.list(4),[other]);assert.equal(await f.attachments.get('missing'),null);
    assert.deepEqual(publicNoticeAttachment(record),{originalName:'Exam notice.pdf',mime:'application/pdf',size:100,kind:'pdf'});assert.equal((await f.db.get('SELECT COUNT(*) count FROM notices')).count,3);
  }finally{await f.close();}
});

test('notice attachment ownership references, uniqueness and foreign keys prevent orphan or duplicate file records',async()=>{
  const f=await fixture();try{
    const record=metadata();await f.attachments.attach('n3',record);
    await rejected(()=>f.attachments.attach('n3',metadata()),409);
    await rejected(()=>f.attachments.attach('n3b',{...record,notice_id:'n3b'}),409);
    await rejected(()=>f.attachments.attach('missing',{...record,notice_id:'missing',filename:randomUUID()+'.pdf'}),404);
    await rejected(()=>f.attachments.attach('n3b',record),400);
    await assert.rejects(()=>f.db.run('INSERT INTO notice_attachments(notice_id,filename,original_name,mime,size) VALUES(?,?,?,?,?)','orphan',randomUUID()+'.pdf','Notice.pdf','application/pdf',1),/FOREIGN KEY/);
    await f.db.run('DELETE FROM notices WHERE id=?','n3');assert.equal(await f.attachments.get('n3'),null);assert.equal((await f.db.get('SELECT COUNT(*) count FROM notice_attachments')).count,0);
  }finally{await f.close();}
});

test('attachment metadata changes roll back with notice transactions and removal returns the file reference for after-commit cleanup',async()=>{
  const f=await fixture();try{
    const record=metadata();await assert.rejects(()=>f.db.transaction(async()=>{await f.attachments.attach('n3',record);throw Error('Publication failed');}),/Publication failed/);assert.equal(await f.attachments.get('n3'),null);
    const {notice_id,...upload}=record;assert.deepEqual(await f.attachments.attach('n3',upload),record);
    const removed=await f.attachments.removeRecord('n3');assert.deepEqual(removed,record);assert.equal(await f.attachments.get('n3'),null);assert.ok(await f.db.get('SELECT id FROM notices WHERE id=?','n3'));assert.equal(await f.attachments.removeRecord('n3'),null);
  }finally{await f.close();}
});

test('canonical attachment rows round-trip through JSON backups without exposing internal-only fields publicly',()=>{
  const row=metadata({filename:randomUUID()+'.heic',original_name:'Camera image.HEIC',mime:'image/heic',size:20971520});
  const restored=validateNoticeAttachmentMetadata(JSON.parse(JSON.stringify(row)));assert.deepEqual(restored,row);assert.deepEqual(Object.keys(restored),noticeAttachmentColumns);
  const visible=publicNoticeAttachment(restored);assert.equal(JSON.stringify(visible).includes(restored.filename),false);
  for(const corrupted of [{...row,size:20971521},{...row,mime:'image/svg+xml'},{...row,filename:row.filename+'/../other.pdf'}])assert.throws(()=>validateNoticeAttachmentMetadata(corrupted),error=>error.status===400);
});
