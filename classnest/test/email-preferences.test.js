import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../db-adapter.js';
import {createEmailPreferences,EmailPreferencesError,EMAIL_VERIFICATION_MESSAGE,EMAIL_VERIFICATION_TTL_MS,EMAIL_VERIFICATION_COOLDOWN_MS} from '../email-preferences.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const off=semester=>({semester,notes:false,notices:false,events:false,verified:false});
async function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-email-preferences-')),db=await openDatabase({provider:'sqlite',dataDir:dir});
  db.sqlite.exec('CREATE TABLE IF NOT EXISTS email_preferences(userId TEXT PRIMARY KEY REFERENCES users(id),semester INTEGER NOT NULL REFERENCES semesters(id),notes INTEGER NOT NULL,notices INTEGER NOT NULL,events INTEGER NOT NULL,verified INTEGER NOT NULL,updated BIGINT NOT NULL); CREATE TABLE IF NOT EXISTS email_verifications(token TEXT PRIMARY KEY,userId TEXT NOT NULL UNIQUE REFERENCES users(id),expires BIGINT NOT NULL); CREATE INDEX IF NOT EXISTS verification_expiry_test ON email_verifications(expires);');
  async function addUser(id,role='member'){await db.run('INSERT INTO users (id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',id,`Student ${id}`,`${id}@example.com`,'existing-password-hash',role,'2026-11-06T00:00:00.000Z',3);}
  await addUser('owner-mail','admin');let at=1793923200000;const deliveries=[],waits=[];
  const options={db,enqueue:context=>{deliveries.push(context);},origin:'https://classnest.example',now:()=>at,monotonicNow:()=>0,sleep:async ms=>{waits.push(ms);}};
  return {db,dir,addUser,deliveries,waits,options,service:createEmailPreferences(options),advance:ms=>{at+=ms;},now:()=>at,async close(){await db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('preferences default to opt-out/current semester and saves strictly preserve verification',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.service.get('owner-mail'),off(3));
    await f.db.run('UPDATE settings SET semester=? WHERE id=1',4);assert.deepEqual(await f.service.get('owner-mail'),off(4));
    const chosen={semester:3,notes:true,notices:false,events:true};assert.deepEqual(await f.service.save('owner-mail',chosen),{...chosen,verified:false});
    for(const bad of [{...chosen,verified:true},{...chosen,notes:1},{...chosen,notices:'true'},{...chosen,semester:'3'},{...chosen,semester:999},{semester:3,notes:true,notices:false},null])await assert.rejects(f.service.save('owner-mail',bad),error=>error instanceof EmailPreferencesError&&error.status===400);
    assert.deepEqual(await f.service.get('owner-mail'),{...chosen,verified:false});
    await f.service.markVerified('owner-mail');const changed={semester:4,notes:false,notices:true,events:false};assert.deepEqual(await f.service.save('owner-mail',changed),{...changed,verified:true});
    const disabled=createEmailPreferences({db:f.db});assert.deepEqual(await disabled.get('owner-mail'),{...changed,verified:true});await assert.rejects(disabled.requestVerification('owner-mail'),error=>error.status===503&&error.code==='EMAIL_UNAVAILABLE');
    assert.throws(()=>createEmailPreferences({...f.options,origin:'http://untrusted.example'}),/HTTPS/);
  }finally{await f.close();}
});

test('verification tokens are private, hashed, bounded, throttled, single-use, and do not approve members',async()=>{
  const f=await fixture();try{
    await f.addUser('pending-mail','pending');const chosen={semester:3,notes:true,notices:false,events:true};await f.service.save('pending-mail',chosen);
    const second=createEmailPreferences(f.options),results=await Promise.all([f.service.requestVerification('pending-mail'),second.requestVerification('pending-mail')]);assert.deepEqual(results[0],{message:EMAIL_VERIFICATION_MESSAGE});assert.deepEqual(results[1],results[0]);assert.equal(f.deliveries.length,1);assert.deepEqual(f.waits,[250,250]);
    const old=f.deliveries[0].token,row=await f.db.get('SELECT * FROM email_verifications');assert.match(old,/^[a-f0-9]{64}$/);assert.equal(row.token,sha(old));assert.equal(Number(row.expires),f.now()+EMAIL_VERIFICATION_TTL_MS);assert.ok(!JSON.stringify(row).includes(old));assert.ok(!JSON.stringify(results).includes(old));assert.ok(Object.isFrozen(f.deliveries[0]));
    f.advance(EMAIL_VERIFICATION_COOLDOWN_MS-1);await f.service.requestVerification('pending-mail');assert.equal(f.deliveries.length,1);f.advance(1);await f.service.requestVerification('pending-mail');assert.equal(f.deliveries.length,2);assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications')).count,1);
    await assert.rejects(f.service.verify(old),error=>error.status===400&&error.code==='INVALID_VERIFICATION_LINK');
    const token=f.deliveries[1].token,verified=await Promise.allSettled([f.service.verify(token),second.verify(token)]);assert.equal(verified.filter(result=>result.status==='fulfilled').length,1);assert.equal(verified.filter(result=>result.status==='rejected').length,1);
    assert.deepEqual(await f.service.get('pending-mail'),{...chosen,verified:true});assert.equal((await f.db.get('SELECT role FROM users WHERE id=?','pending-mail')).role,'pending');assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications')).count,0);
    const alreadyVerified=await f.service.requestVerification('pending-mail');assert.deepEqual(alreadyVerified,{message:EMAIL_VERIFICATION_MESSAGE});assert.equal(f.deliveries.length,2);
  }finally{await f.close();}
});

test('invalid/expired links fail uniformly and markVerified preserves choices or creates opt-out defaults',async()=>{
  const f=await fixture();try{
    const failures=[];for(const token of [undefined,null,{},'short','0'.repeat(64)]){try{await f.service.verify(token);assert.fail('Invalid token accepted');}catch(error){assert.equal(error.status,400);failures.push(error.message);}}assert.equal(new Set(failures).size,1);
    await f.service.requestVerification('owner-mail');const token=f.deliveries[0].token;f.advance(EMAIL_VERIFICATION_TTL_MS);await assert.rejects(f.service.verify(token),error=>error.message===failures[0]);assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications')).count,0);
    assert.deepEqual(await f.service.markVerified('owner-mail'),{...off(3),verified:true});assert.deepEqual(await f.service.get('owner-mail'),{...off(3),verified:true});
    await f.addUser('another-mail');await f.service.requestVerification('another-mail');
    await assert.rejects(f.db.transaction(async()=>{await f.service.markVerified('another-mail');throw new Error('Outer reset transaction failed');}),/Outer reset transaction failed/);
    assert.deepEqual(await f.service.get('another-mail'),off(3));assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications WHERE userId=?','another-mail')).count,1);
    await f.service.markVerified('another-mail');assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications WHERE userId=?','another-mail')).count,0);
  }finally{await f.close();}
});

test('verification outbox failures roll back token and queue writes while returning the same public response',async()=>{
  const f=await fixture();try{
    f.db.sqlite.exec('CREATE TABLE verification_outbox_test(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');let failures=0;
    const broken=createEmailPreferences({...f.options,enqueue:async()=>{await f.db.run('INSERT INTO verification_outbox_test VALUES(?,?)','queue-test','opaque-encrypted-payload');throw new Error('Outbox unavailable');},onDeliveryError:()=>{failures++;}});
    assert.deepEqual(await broken.requestVerification('owner-mail'),{message:EMAIL_VERIFICATION_MESSAGE});assert.equal(failures,1);assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications')).count,0);assert.equal((await f.db.get('SELECT COUNT(*) count FROM verification_outbox_test')).count,0);
    await f.service.requestVerification('owner-mail');assert.equal(f.deliveries.length,1);assert.equal((await f.db.get('SELECT COUNT(*) count FROM email_verifications')).count,1);
  }finally{await f.close();}
});

test('notification recipients require approval, verified email, matching semester, and the exact opt-in kind',async()=>{
  const f=await fixture();try{
    for(const [id,role] of [['member-mail','member'],['pending-mail','pending'],['blocked-mail','blocked'],['other-sem-mail','member'],['unverified-mail','member'],['optout-mail','member']])await f.addUser(id,role);
    await f.db.run('UPDATE users SET semester=? WHERE id=?',4,'other-sem-mail');
    for(const id of ['owner-mail','member-mail','pending-mail','blocked-mail','other-sem-mail','unverified-mail','optout-mail']){
      await f.service.save(id,{semester:id==='other-sem-mail'?4:3,notes:id!=='optout-mail',notices:id==='member-mail',events:false});
      if(id!=='unverified-mail')await f.service.markVerified(id);
    }
    const notes=await f.service.notificationRecipients('notes',3);assert.deepEqual(notes.map(user=>user.id),['member-mail','owner-mail']);assert.deepEqual(Object.keys(notes[0]).sort(),['email','id','name']);
    assert.deepEqual((await f.service.notificationRecipients('notice',3)).map(user=>user.id),['member-mail']);assert.deepEqual(await f.service.notificationRecipients('events',3),[]);assert.deepEqual((await f.service.notificationRecipients('note',4)).map(user=>user.id),['other-sem-mail']);
    for(const kind of ['constructor','__proto__','notes OR 1=1','payments',null])await assert.rejects(f.service.notificationRecipients(kind,3),error=>error.status===400);
    await assert.rejects(f.service.notificationRecipients('notes',999),error=>error.status===400);
  }finally{await f.close();}
});
