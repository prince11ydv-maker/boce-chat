import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../db-adapter.js';
import {createEmailOutbox} from '../email-outbox.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const key='a3'.repeat(32);
const origin='https://classnest.example.com';
const encodedPassword='s2:'+'1'.repeat(32)+':'+'2'.repeat(128);
async function fixture(options={}){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-outbox-'));
  const db=await openDatabase({provider:'sqlite',dataDir:dir});
  let at=1793923200000;
  const user={id:'email-owner',name:'Student <name>',email:'owner@example.com',password:encodedPassword,role:'admin'};
  await db.run('INSERT INTO users (id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',user.id,user.name,user.email,user.password,user.role,'2026-11-06T00:00:00.000Z',3);
  await db.run('INSERT INTO email_preferences (userId,semester,notes,notices,events,verified,updated) VALUES(?,?,?,?,?,?,?)',user.id,3,1,1,1,1,at);
  const calls=[];
  const mailer={enabled:true,async sendEmail(message){calls.push(message);return {accepted:true};}};
  const outbox=createEmailOutbox({db,mailer,key,now:()=>at,...options});
  async function reset(token=randomBytes(32).toString('hex'),expires=at+1800000){
    await db.run('DELETE FROM password_resets WHERE userId=?',user.id);
    await db.run('INSERT INTO password_resets VALUES(?,?,?,?)',hash(token),user.id,hash((await db.get('SELECT password FROM users WHERE id=?',user.id)).password),expires);
    const message={template:'password-reset',resetUrl:origin+'/#reset-password/'+token,expiresMinutes:30};
    return {token,message,expires,id:await outbox.enqueue({userId:user.id,kind:'password-reset',message,expires})};
  }
  async function notification(extra={}){
    return outbox.enqueue({userId:user.id,kind:'notification',message:{template:'notification',notificationType:'notes',semester:3,subject:'A class update',body:'Original study notes are available.',actionUrl:origin+'/#home',...extra},expires:at+3*86400000});
  }
  return {db,dir,user,calls,mailer,outbox,reset,notification,now:()=>at,advance:ms=>{at+=ms;},async close(){await db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('outbox stores authenticated ciphertext, keeps raw recovery tokens private, and removes accepted payloads',async()=>{
  const f=await fixture();try{
    const reset=await f.reset(),copy=await f.outbox.enqueue({userId:f.user.id,kind:'password-reset',message:reset.message,expires:reset.expires});
    const rows=await f.db.all('SELECT * FROM email_outbox ORDER BY id');
    assert.equal(rows.length,2);assert.notEqual(rows[0].payload,rows[1].payload);
    const stored=JSON.stringify(rows);for(const privateValue of [reset.token,reset.message.resetUrl,f.user.email])assert.ok(!stored.includes(privateValue));
    const result=await f.outbox.drain({limit:2});assert.equal(result.accepted,2);assert.equal(f.calls.length,2);
    assert.deepEqual(new Set(f.calls.map(message=>message.id)),new Set([reset.id,copy]));
    for(const message of f.calls){assert.equal(message.to,f.user.email);assert.equal(message.resetUrl,reset.message.resetUrl);}
    assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_outbox')).count,0);
    assert.equal((await f.outbox.status()).attemptsToday,2);
  }finally{await f.close();}
});

test('concurrent drainers lease one message before SMTP and reserve its budget once',async()=>{
  const f=await fixture();try{
    await f.reset();let release,started;const gate=new Promise(resolve=>{release=resolve;}),sending=new Promise(resolve=>{started=resolve;});
    f.mailer.sendEmail=async message=>{f.calls.push(message);started();await gate;return {accepted:true};};
    const first=f.outbox.drain({limit:1});await sending;
    const row=await f.db.get('SELECT * FROM email_outbox');assert.equal(row.state,'sending');assert.equal(row.attempts,1);assert.equal(row.leaseUntil,f.now()+120000);assert.ok(row.lease);
    const second=createEmailOutbox({db:f.db,mailer:f.mailer,key,now:f.now});
    const concurrent=await second.drain({limit:1});assert.equal(concurrent.accepted,0);assert.equal(f.calls.length,1);
    release();assert.equal((await first).accepted,1);assert.equal((await f.outbox.status()).attemptsToday,1);
  }finally{await f.close();}
});

test('expired leases recover pending delivery while retaining counted ambiguous attempts',async()=>{
  const f=await fixture();try{
    const reset=await f.reset();await f.db.run("UPDATE email_outbox SET state='sending',lease=?,leaseUntil=?,attempts=1 WHERE id=?",'abandoned-worker',f.now()-1,reset.id);
    await f.db.run('INSERT INTO email_budget VALUES(?,?,?)',new Date(f.now()).toISOString().slice(0,10),1,0);
    assert.equal((await f.outbox.drain({limit:1})).accepted,1);assert.equal(f.calls.length,1);assert.equal((await f.outbox.status()).attemptsToday,2);
  }finally{await f.close();}
});

test('notification allowance preserves recovery budget and all SMTP attempts consume the daily cap',async()=>{
  const f=await fixture({dailyLimit:3,notificationLimit:1});try{
    await f.notification();assert.equal((await f.outbox.drain({limit:1})).accepted,1);
    const deferredNotice=await f.notification();await f.outbox.drain({limit:1});assert.equal(f.calls.length,1);
    const deferred=await f.db.get('SELECT nextAttempt,attempts FROM email_outbox WHERE id=?',deferredNotice);assert.equal(deferred.attempts,0);assert.equal(deferred.nextAttempt,Date.parse(new Date(f.now()).toISOString().slice(0,10)+'T00:00:00Z')+86400000);
    const retry=await f.reset();f.mailer.sendEmail=async message=>{f.calls.push(message);throw Object.assign(new Error('Private SMTP response never persisted'),{code:'EMAIL_DELIVERY_FAILED',retryable:true});};
    await f.outbox.drain({limit:1});const pending=await f.db.get('SELECT * FROM email_outbox WHERE id=?',retry.id);assert.equal(pending.state,'pending');assert.equal(pending.attempts,1);assert.equal(pending.nextAttempt,f.now()+120000);assert.ok(pending.payload);
    // A separately queued current recovery message can use the last reserved slot.
    const permanent=await f.outbox.enqueue({userId:f.user.id,kind:'password-reset',message:retry.message,expires:retry.expires});
    f.mailer.sendEmail=async message=>{f.calls.push(message);throw Object.assign(new Error('Private permanent provider detail'),{code:'EMAIL_RECIPIENT_REJECTED',retryable:false});};
    await f.outbox.drain({limit:1});const failed=await f.db.get('SELECT * FROM email_outbox WHERE id=?',permanent);assert.equal(failed.state,'failed');assert.equal(failed.payload,'');assert.equal(failed.lastCode,'EMAIL_RECIPIENT_REJECTED');assert.equal(failed.lease,null);
    const capped=await f.outbox.enqueue({userId:f.user.id,kind:'password-reset',message:retry.message,expires:retry.expires});await f.outbox.drain({limit:1});assert.equal(f.calls.length,3);assert.equal((await f.db.get('SELECT attempts FROM email_outbox WHERE id=?',capped)).attempts,0);
    const status=await f.outbox.status();assert.equal(status.attemptsToday,3);assert.equal(status.failed,1);assert.equal((await f.db.get('SELECT notifications FROM email_budget')).notifications,1);
  }finally{await f.close();}
});

test('rotated, consumed, expired, and password-stale reset messages are pruned before SMTP',async()=>{
  const f=await fixture();try{
    await f.reset();await f.db.run('UPDATE password_resets SET token=?',hash(randomBytes(32).toString('hex')));await f.outbox.drain();
    await f.reset();await f.db.run('DELETE FROM password_resets');await f.outbox.drain();
    await f.reset();await f.db.run('UPDATE users SET password=? WHERE id=?',encodedPassword+'changed',f.user.id);await f.outbox.drain();
    await f.reset();await f.db.run('UPDATE password_resets SET expires=?',f.now());await f.outbox.drain();
    assert.equal(f.calls.length,0);assert.equal((await f.outbox.status()).pending,0);assert.equal((await f.outbox.status()).attemptsToday,0);
  }finally{await f.close();}
});

test('queued notifications re-check unsubscribe, verification, posting role, and chosen semester at send time',async()=>{
  const f=await fixture();try{
    for(const change of ["UPDATE email_preferences SET notes=0","UPDATE email_preferences SET verified=0","UPDATE users SET role='blocked'","UPDATE email_preferences SET semester=4"]){
      await f.db.run('UPDATE email_preferences SET semester=3,notes=1,verified=1');await f.db.run("UPDATE users SET role='admin'");await f.notification();await f.db.run(change);await f.outbox.drain();
      assert.equal(f.calls.length,0);assert.equal((await f.outbox.status()).pending,0);
    }
    assert.equal((await f.outbox.status()).attemptsToday,0);
  }finally{await f.close();}
});

test('verification messages are bound to the current token and expiry',async()=>{
  const f=await fixture();try{
    const token=randomBytes(32).toString('hex'),expires=f.now()+86400000;
    const message={template:'email-verification',verificationUrl:origin+'/#verify-email/'+token,expiresMinutes:1440};
    await f.db.run('INSERT INTO email_verifications VALUES(?,?,?)',hash(token),f.user.id,expires);
    await f.outbox.enqueue({userId:f.user.id,kind:'email-verification',message,expires});await f.db.run('UPDATE email_verifications SET token=?',hash('rotated-token'));await f.outbox.drain();assert.equal(f.calls.length,0);
    await f.db.run('UPDATE email_verifications SET token=?,expires=?',hash(token),f.now());await f.outbox.enqueue({userId:f.user.id,kind:'email-verification',message,expires});await f.outbox.drain();assert.equal(f.calls.length,0);
    await f.db.run('UPDATE email_verifications SET expires=?',expires);await f.outbox.enqueue({userId:f.user.id,kind:'email-verification',message,expires});assert.equal((await f.outbox.drain()).accepted,1);assert.equal(f.calls[0].verificationUrl,message.verificationUrl);
  }finally{await f.close();}
});

test('tampered payloads fail closed, clear encrypted content, and never reserve SMTP budget',async()=>{
  const f=await fixture();try{
    const reset=await f.reset(),row=await f.db.get('SELECT * FROM email_outbox WHERE id=?',reset.id),bytes=Buffer.from(row.payload,'base64');bytes[bytes.length-1]^=1;
    await f.db.run('UPDATE email_outbox SET payload=? WHERE id=?',bytes.toString('base64'),reset.id);await f.outbox.drain();const failed=await f.db.get('SELECT * FROM email_outbox WHERE id=?',reset.id);
    assert.equal(failed.state,'failed');assert.equal(failed.payload,'');assert.equal(failed.lastCode,'EMAIL_PAYLOAD_INVALID');assert.equal(f.calls.length,0);assert.equal((await f.outbox.status()).attemptsToday,0);
    const other=await f.reset();await f.db.run("UPDATE email_outbox SET kind='email-verification' WHERE id=?",other.id);await f.outbox.drain();assert.equal((await f.db.get('SELECT state FROM email_outbox WHERE id=?',other.id)).state,'failed');
  }finally{await f.close();}
});

test('expired outbox content is deleted and unsubscribe tokens bind account plus current address',async()=>{
  const f=await fixture();try{
    const reset=await f.reset();await f.db.run('UPDATE email_outbox SET expires=? WHERE id=?',f.now(),reset.id);await f.outbox.drain();assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_outbox')).count,0);assert.equal(f.calls.length,0);
    const token=f.outbox.unsubscribeToken(f.user);assert.match(token,/^[a-f0-9]{64}$/);assert.equal(f.outbox.validUnsubscribe(f.user,token),true);assert.equal(f.outbox.validUnsubscribe({...f.user,email:'changed@example.com'},token),false);assert.equal(f.outbox.validUnsubscribe({...f.user,id:'another-account'},token),false);assert.equal(f.outbox.validUnsubscribe(f.user,token+'0'),false);assert.equal(f.outbox.validUnsubscribe(f.user,null),false);
    const otherKey=createEmailOutbox({db:f.db,mailer:f.mailer,key:'b4'.repeat(32),now:f.now});assert.equal(otherKey.validUnsubscribe(f.user,token),false);assert.ok(!JSON.stringify(await f.outbox.status()).includes(token));
  }finally{await f.close();}
});

test('delivery cannot be queued without enabled email and a valid independent encryption key',async()=>{
  const f=await fixture();try{
    for(const invalid of ['',undefined,'plaintext-password','ab'.repeat(31)])assert.throws(()=>createEmailOutbox({db:f.db,mailer:f.mailer,key:invalid}),/EMAIL_ENCRYPTION_KEY/);
    const disabled=createEmailOutbox({db:f.db,mailer:{enabled:false},key:undefined,now:f.now});assert.deepEqual(await disabled.drain(),{accepted:0,disabled:true});await assert.rejects(disabled.enqueue({userId:f.user.id,kind:'notification',message:{}}),error=>error.code==='EMAIL_DISABLED');
  }finally{await f.close();}
});

test('notification backlog cannot fill queue slots reserved for account recovery',async()=>{
  const f=await fixture();try{
    await f.db.transaction(async()=>{for(let index=0;index<800;index++)await f.db.run('INSERT INTO email_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?)','queued-notice-'+index,f.user.id,'notification','opaque-test-payload',0,f.now(),f.now(),f.now()+86400000,null,null,'pending',null);});
    assert.equal(await f.notification(),null);assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_outbox')).count,800);
    const reset=await f.reset();assert.ok(reset.id);
    await f.db.transaction(async()=>{for(let index=0;index<199;index++)await f.outbox.enqueue({userId:f.user.id,kind:'password-reset',message:reset.message,expires:reset.expires});});
    assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_outbox')).count,1000);
    await assert.rejects(f.outbox.enqueue({userId:f.user.id,kind:'password-reset',message:reset.message,expires:reset.expires}),error=>error.code==='EMAIL_QUEUE_FULL');
  }finally{await f.close();}
});

test('temporary provider failures stop after five counted attempts and clear private payloads',async()=>{
  const f=await fixture();try{
    const id=await f.notification();f.mailer.sendEmail=async message=>{f.calls.push(message);throw Object.assign(new Error('Private email text and SMTP detail'),{retryable:true,code:'EMAIL_DELIVERY_FAILED'});};
    for(let index=0;index<5;index++){await f.outbox.drain({limit:1});if(index<4){const row=await f.db.get('SELECT nextAttempt FROM email_outbox WHERE id=?',id);f.advance(row.nextAttempt-f.now());}}
    const row=await f.db.get('SELECT * FROM email_outbox WHERE id=?',id);assert.equal(row.state,'failed');assert.equal(row.attempts,5);assert.equal(row.payload,'');assert.equal(row.lease,null);assert.equal(row.lastCode,'EMAIL_DELIVERY_FAILED');
    assert.equal(f.calls.length,5);assert.equal((await f.outbox.status()).attemptsToday,5);await f.outbox.drain();assert.equal(f.calls.length,5);assert.ok(!JSON.stringify(row).includes('Private email'));
  }finally{await f.close();}
});
