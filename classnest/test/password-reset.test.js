import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../db-adapter.js';
import {createPasswordResetService,PasswordResetError,PASSWORD_RESET_MESSAGE,PASSWORD_RESET_TTL_MS,PASSWORD_RESET_COOLDOWN_MS} from '../password-reset.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>'s2:'+'1'.repeat(32)+':'+sha(value).repeat(2);
const original=encoded('Original secure password');
async function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-reset-')),db=await openDatabase({provider:'sqlite',dataDir:dir});
  db.sqlite.exec('CREATE TABLE IF NOT EXISTS password_resets(token TEXT PRIMARY KEY,userId TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,passwordStamp TEXT NOT NULL,expires BIGINT NOT NULL); CREATE INDEX IF NOT EXISTS resets_expiry_test ON password_resets(expires);');
  await db.run('INSERT INTO users (id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)','owner-reset','Owner','owner@example.com',original,'admin','2026-11-06T00:00:00.000Z',3);
  let at=1793923200000,hashCalls=0;const deliveries=[],waits=[];
  const options={db,hashPassword:async value=>{hashCalls++;return encoded(value);},queueDelivery:context=>{deliveries.push(context);},now:()=>at,monotonicNow:()=>0,sleep:async ms=>{waits.push(ms);}};
  return {db,dir,deliveries,waits,options,service:createPasswordResetService(options),advance:ms=>{at+=ms;},now:()=>at,hashCalls:()=>hashCalls,async close(){await db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('reset request hides account existence and stores only a token digest with bounded expiry',async()=>{
  const f=await fixture();try{
    const known=await f.service.request(' OWNER@EXAMPLE.COM '),missing=await f.service.request('missing@example.com'),malformed=await f.service.request(null);
    assert.deepEqual(known,{message:PASSWORD_RESET_MESSAGE});assert.deepEqual(missing,known);assert.deepEqual(malformed,known);assert.deepEqual(f.waits,[500,500,500]);assert.equal(f.deliveries.length,1);
    const context=f.deliveries[0],row=await f.db.get('SELECT * FROM password_resets');assert.match(context.token,/^[a-f0-9]{64}$/);assert.equal(row.token,sha(context.token));assert.equal(row.passwordStamp,sha(original));assert.equal(Number(row.expires),f.now()+PASSWORD_RESET_TTL_MS);assert.ok(!JSON.stringify(row).includes(context.token));assert.ok(!JSON.stringify(known).includes(context.token));assert.ok(Object.isFrozen(context));
    assert.equal((await f.db.get('SELECT password FROM users WHERE id=?','owner-reset')).password,original);
  }finally{await f.close();}
});

test('per-user cooldown suppresses concurrent requests and rotates exactly one pending link after five minutes',async()=>{
  const f=await fixture();try{
    const second=createPasswordResetService(f.options);
    const results=await Promise.all([f.service.request('owner@example.com'),second.request('owner@example.com')]);assert.deepEqual(results[0],results[1]);assert.equal(f.deliveries.length,1);
    const old=f.deliveries[0].token;f.advance(PASSWORD_RESET_COOLDOWN_MS-1);await f.service.request('owner@example.com');assert.equal(f.deliveries.length,1);
    f.advance(1);await f.service.request('owner@example.com');assert.equal(f.deliveries.length,2);assert.notEqual(f.deliveries[1].token,old);assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,1);
    await assert.rejects(f.service.consume(old,'A different valid password'),error=>error instanceof PasswordResetError&&error.code==='INVALID_RESET_LINK');assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,1);
  }finally{await f.close();}
});

test('single-use reset atomically changes the password and revokes sessions, reset links, and login lockout',async()=>{
  const f=await fixture();try{
    await f.db.run('INSERT INTO sessions VALUES(?,?,?)','before-session','owner-reset',f.now()+60000);await f.db.run('INSERT INTO auth_failures VALUES(?,?,?)',sha('owner@example.com'),10,f.now()+60000);
    await f.service.request('owner@example.com');const token=f.deliveries[0].token,second=createPasswordResetService(f.options),next='  New password preserves spaces  ';
    const results=await Promise.allSettled([f.service.consume(token,next),second.consume(token,'Other secure new password')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(f.hashCalls(),1);
    assert.equal((await f.db.get('SELECT password FROM users WHERE id=?','owner-reset')).password,encoded(next));assert.equal((await f.db.get('SELECT COUNT(*) count FROM sessions')).count,0);assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,0);assert.equal((await f.db.get('SELECT COUNT(*) count FROM auth_failures')).count,0);
    await assert.rejects(f.service.consume(token,next),error=>error instanceof PasswordResetError&&error.code==='INVALID_RESET_LINK');
  }finally{await f.close();}
});

test('expired or password-stale links cannot change credentials and are cleaned up',async()=>{
  const f=await fixture();try{
    await f.service.request('owner@example.com');let token=f.deliveries[0].token;f.advance(PASSWORD_RESET_TTL_MS);
    await assert.rejects(f.service.consume(token,'A secure replacement password'),error=>error instanceof PasswordResetError);assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,0);assert.equal(f.hashCalls(),0);
    await f.service.request('owner@example.com');token=f.deliveries.at(-1).token;const changed=encoded('Password changed elsewhere');await f.db.run('UPDATE users SET password=? WHERE id=?',changed,'owner-reset');
    await assert.rejects(f.service.consume(token,'A secure replacement password'),error=>error instanceof PasswordResetError);assert.equal((await f.db.get('SELECT password FROM users WHERE id=?','owner-reset')).password,changed);assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,0);assert.equal(f.hashCalls(),0);
  }finally{await f.close();}
});

test('hasher failure rolls back consumption, invalid inputs retain the link, and queue failure rolls back atomically',async()=>{
  const f=await fixture();try{
    f.db.sqlite.exec('CREATE TABLE outbox_reset_test(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');
    let queueErrorCount=0;const failingQueue=createPasswordResetService({...f.options,queueDelivery:async()=>{await f.db.run('INSERT INTO outbox_reset_test VALUES(?,?)','outbox-test','encrypted-only-test-payload');throw new Error('Queue unavailable');},onDeliveryError:()=>{queueErrorCount++;}});
    assert.deepEqual(await failingQueue.request('owner@example.com'),{message:PASSWORD_RESET_MESSAGE});assert.equal(queueErrorCount,1);assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,0);assert.equal((await f.db.get('SELECT COUNT(*) count FROM outbox_reset_test')).count,0);
    await f.service.request('owner@example.com');const token=f.deliveries.at(-1).token;
    await assert.rejects(f.service.consume(token,'too short'),error=>error instanceof PasswordResetError&&error.code==='INVALID_PASSWORD');await assert.rejects(f.service.consume({},'A valid replacement password'),error=>error instanceof PasswordResetError&&error.code==='INVALID_RESET_LINK');
    const broken=createPasswordResetService({...f.options,hashPassword:async()=>{throw new Error('Hasher failed');}});await assert.rejects(broken.consume(token,'A valid replacement password'),/Hasher failed/);
    assert.equal((await f.db.get('SELECT password FROM users WHERE id=?','owner-reset')).password,original);assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,1);
    await f.service.consume(token,'A valid replacement password');assert.equal((await f.db.get('SELECT COUNT(*) count FROM password_resets')).count,0);
  }finally{await f.close();}
});

test('onConsumed runs privately in the reset transaction and its failure rolls back password, sessions, and token consumption',async()=>{
  const f=await fixture();try{
    f.db.sqlite.exec('CREATE TABLE verification_reset_test(userId TEXT PRIMARY KEY,verified INTEGER NOT NULL);');
    await f.db.run('INSERT INTO sessions VALUES(?,?,?)','retained-session','owner-reset',f.now()+60000);
    await f.db.run('INSERT INTO auth_failures VALUES(?,?,?)',sha('owner@example.com'),10,f.now()+60000);
    await f.service.request('owner@example.com');const token=f.deliveries[0].token,contexts=[];
    const broken=createPasswordResetService({...f.options,onConsumed:async context=>{contexts.push(context);await f.db.run('INSERT INTO verification_reset_test VALUES(?,?)',context.userId,1);throw new Error('Verification update failed');}});
    await assert.rejects(broken.consume(token,'A verified secure new password'),/Verification update failed/);
    assert.deepEqual(contexts,[{userId:'owner-reset',email:'owner@example.com'}]);assert.ok(Object.isFrozen(contexts[0]));
    assert.equal((await f.db.get('SELECT password FROM users WHERE id=?','owner-reset')).password,original);
    for(const table of ['sessions','password_resets','auth_failures'])assert.equal((await f.db.get(`SELECT COUNT(*) count FROM ${table}`)).count,1);
    assert.equal((await f.db.get('SELECT COUNT(*) count FROM verification_reset_test')).count,0);
    const successful=createPasswordResetService({...f.options,onConsumed:async context=>{await f.db.run('INSERT INTO verification_reset_test VALUES(?,?)',context.userId,1);}});
    const result=await successful.consume(token,'A verified secure new password');assert.deepEqual(Object.keys(result),['message']);assert.equal((await f.db.get('SELECT verified FROM verification_reset_test')).verified,1);
  }finally{await f.close();}
});
