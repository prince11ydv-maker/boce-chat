import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createECDH,randomBytes,generateKeyPairSync,createPublicKey,verify} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {openDatabase} from '../db-adapter.js';
import {createTeachingService} from '../teaching.js';
import {createPushService,validateWebSubscription} from '../push-notifications.js';

const rejected=(fn,status)=>assert.rejects(fn,error=>error.status===status);
function subscription(suffix='a'){const ec=createECDH('prime256v1');ec.generateKeys();return {endpoint:'https://fcm.googleapis.com/fcm/send/test_'+suffix,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};}
const nativeToken=suffix=>'test-native-'+suffix+'a'.repeat(120);
async function fixture({sendWeb=async()=>{},sendAndroid,fetcher,native=false}={}){
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-push-')),db=await openDatabase({provider:'sqlite',dataDir:dir});let at=Date.parse('2026-11-09T09:00:00+05:45');
  for(const [id,role,semester]of[['a','admin',3],['t','teacher',3],['m3','member',3],['m4','member',4],['p','pending',3]]){await db.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)',id,'Person '+id,id+'@example.test','unused',role,new Date(at).toISOString(),semester);await db.run('INSERT INTO sessions VALUES(?,?,?)','session-'+id,id,at+7*86400000);}
  for(const semester of[3,4])await db.run('INSERT INTO subjects(id,semester,name,code,description,color) VALUES(?,?,?,?,?,?)','s'+semester,semester,'Subject '+semester,'','','sage');
  const keys=generateVAPIDKeys(),env={PUBLIC_ORIGIN:'https://pusoe.vercel.app',PUSH_VAPID_PUBLIC_KEY:keys.publicKey,PUSH_VAPID_PRIVATE_KEY:keys.privateKey,PUSH_ENCRYPTION_KEY:'f'.repeat(64)};
  let privateKey;if(native){privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;env.FIREBASE_SERVICE_ACCOUNT_JSON=JSON.stringify({project_id:'classnest-test',client_email:'push@classnest-test.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})});}
  let push;const teaching=createTeachingService({db,now:()=>at,onNotify:n=>push.enqueue(n)}),options={db,notificationForDelivery:(userId,id)=>teaching.notificationForDelivery(userId,id),env,now:()=>at,sendWeb,sendAndroid,...(fetcher?{fetcher}:{})};push=createPushService(options);
  return {dir,db,push,teaching,env,options,privateKey,get at(){return at;},clock:value=>at=typeof value==='string'?Date.parse(value):value,async note(id='n3',semester=3){await db.run('INSERT INTO notes(id,subjectId,title,content,authorId,created) VALUES(?,?,?,?,?,?)',id,'s'+semester,'Private note '+id,'Private lesson contents','a',new Date(at).toISOString());await teaching.notifyNote({id,semester,title:'ignored',authorId:'a'});return db.get("SELECT * FROM app_notifications WHERE user_id=? AND type='note' AND reference=?",'m'+semester,id);},async close(){await db.close();assert.equal(path.dirname(dir),tmpdir());assert.ok(path.basename(dir).startsWith('classnest-push-'));rmSync(dir,{recursive:true,force:true});}};
}

test('browser push endpoints reject SSRF, redirects, userinfo, ports and malformed or off-curve keys',()=>{
  const good=subscription();assert.deepEqual(validateWebSubscription({...good,expirationTime:null}),good);
  for(const endpoint of['http://fcm.googleapis.com/fcm/send/test','https://127.0.0.1/fcm/send/test','https://fcm.googleapis.com.evil.test/fcm/send/test','https://user:pass@fcm.googleapis.com/fcm/send/test','https://fcm.googleapis.com:8443/fcm/send/test','https://fcm.googleapis.com/fcm/send/test#fragment','https://fcm.googleapis.com/fcm/send/test?redirect=https://127.0.0.1','https://web.push.apple.com/../','https://updates.push.services.mozilla.com/wpush/v2/%2e%2e'])assert.throws(()=>validateWebSubscription({...good,endpoint}),error=>error.status===400);
  for(const endpoint of['https://updates.push.services.mozilla.com/wpush/v2/known_token','https://web.push.apple.com/Qknown-token','https://wns2-region.notify.windows.com/w/?token=known'])assert.equal(validateWebSubscription({...good,endpoint}).endpoint,endpoint);
  assert.throws(()=>validateWebSubscription({...good,keys:{...good.keys,auth:'a'}}),error=>error.status===400);assert.throws(()=>validateWebSubscription({...good,keys:{...good.keys,p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')}}),error=>error.status===400);
});

test('device credentials are encrypted, current-session bound, hidden from responses and cannot be silently rebound',async()=>{
  const f=await fixture();try{
    const sub=subscription(),device=await f.push.subscribe('m3','session-m3',{kind:'web',subscription:sub,label:'My phone'});assert.equal(device.kind,'web');assert.equal(device.label,'My phone');assert.equal(device.payload,undefined);
    const stored=await f.db.get('SELECT * FROM push_devices WHERE id=?',device.id);assert.ok(!stored.payload.includes('https://'));assert.ok(!stored.payload.includes(sub.keys.auth));assert.ok(!JSON.stringify(await f.push.list('m3','session-m3')).includes(sub.endpoint));
    assert.equal((await f.push.subscribe('m3','session-m3',{kind:'web',subscription:sub,label:'Updated phone'})).id,device.id);
    await rejected(()=>f.push.subscribe('m4','session-m4',{kind:'web',subscription:sub}),409);await rejected(()=>f.push.subscribe('p','session-p',{kind:'web',subscription:subscription()}),403);await rejected(()=>f.push.subscribe('m3','wrong-session',{kind:'web',subscription:sub}),401);
    await f.push.remove('m4','session-m4',device.id);assert.ok(await f.db.get('SELECT id FROM push_devices WHERE id=?',device.id));
    await f.db.run('DELETE FROM sessions WHERE token=?','session-m3');assert.equal(await f.db.get('SELECT id FROM push_devices WHERE id=?',device.id),undefined);assert.ok((await f.push.subscribe('m4','session-m4',{kind:'web',subscription:sub})).id);
    for(let i=0;i<4;i++)await f.push.subscribe('m4','session-m4',{kind:'web',subscription:subscription('extra'+i)});await rejected(()=>f.push.subscribe('m4','session-m4',{kind:'web',subscription:subscription('overlimit')}),429);
  }finally{await f.close();}
});

test('notification queueing rolls back with publication, deduplicates and parallel drainers deliver one ID-only web payload',async()=>{
  const sent=[],f=await fixture({sendWeb:async(sub,payload,options)=>{sent.push({sub,payload:JSON.parse(payload),options});}});try{
    await f.push.subscribe('m3','session-m3',{kind:'web',subscription:subscription()});
    await assert.rejects(()=>f.db.transaction(async()=>{await f.note('rollback');throw Error('Stop publication');}),/Stop publication/);assert.equal((await f.db.get('SELECT COUNT(*) count FROM push_queue')).count,0);
    const note=await f.note();assert.equal((await f.push.enqueue({userId:'m3',id:note.id})).queued,0);const second=createPushService(f.options);await Promise.all([f.push.drain(),second.drain()]);assert.equal(sent.length,1);assert.deepEqual(sent[0].payload,{notificationId:note.id});assert.ok(!JSON.stringify(sent).includes('Private lesson contents'));assert.ok(sent[0].options.TTL>0);assert.equal((await f.db.get('SELECT state FROM push_queue')).state,'sent');assert.equal((await f.push.enqueue({userId:'m3',id:note.id})).queued,0);
  }finally{await f.close();}
});

test('fresh delivery suppresses moved, blocked, logged-out accounts and deleted note sources',async()=>{
  const sent=[],f=await fixture({sendWeb:async()=>sent.push(true)});try{
    await f.push.subscribe('m3','session-m3',{kind:'web',subscription:subscription()});await f.note('moved');await f.db.run("UPDATE users SET semester=4 WHERE id='m3'");assert.equal((await f.push.drain()).accepted,0);
    await f.db.run("UPDATE users SET semester=3 WHERE id='m3'");await f.note('blocked');await f.db.run("UPDATE users SET role='blocked' WHERE id='m3'");assert.equal((await f.push.drain()).accepted,0);
    await f.db.run("UPDATE users SET role='member' WHERE id='m3'");await f.note('deleted');await f.db.run("DELETE FROM notes WHERE id='deleted'");assert.equal((await f.push.drain()).accepted,0);
    await f.note('logout');await f.db.run("DELETE FROM sessions WHERE token='session-m3'");assert.equal((await f.push.drain()).accepted,0);assert.equal(sent.length,0);assert.equal((await f.db.get('SELECT COUNT(*) count FROM push_queue')).count,0);
  }finally{await f.close();}
});

test('push retries are bounded and sanitized; expired provider registrations are removed',async()=>{
  let attempts=0,mode='retry';const f=await fixture({sendWeb:async()=>{attempts++;throw Object.assign(Error('secret endpoint https://private.example/token'),{statusCode:mode==='gone'?410:503});}});try{
    await f.push.subscribe('m3','session-m3',{kind:'web',subscription:subscription()});await f.note();
    for(let i=0;i<5;i++){await f.push.drain();f.clock(f.at+300001);}assert.equal(attempts,5);const row=await f.db.get('SELECT * FROM push_queue');assert.equal(row.state,'failed');assert.equal(row.last_code,'PUSH_DELIVERY_FAILED');assert.ok(!JSON.stringify(row).includes('secret endpoint'));
    mode='gone';await f.note('expired-registration');await f.push.drain();assert.equal((await f.db.get('SELECT COUNT(*) count FROM push_devices')).count,0);assert.equal((await f.db.get('SELECT COUNT(*) count FROM push_queue')).count,0);
  }finally{await f.close();}
});

test('Android FCM uses signed OAuth on fixed Google endpoints with generic lock-screen text and no private body',async()=>{
  const calls=[];let f;f=await fixture({native:true,fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('oauth2')?{access_token:'test-access-token',expires_in:3600}:{name:'projects/classnest-test/messages/accepted'}),{status:200});}});try{
    await f.push.subscribe('m3','session-m3',{kind:'android',token:nativeToken('one')});const note=await f.note();assert.equal((await f.push.drain()).accepted,1);assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');assert.equal(calls[1].url,'https://fcm.googleapis.com/v1/projects/classnest-test/messages:send');assert.equal(calls[1].options.redirect,'error');
    const jwt=new URLSearchParams(calls[0].options.body).get('assertion'),parts=jwt.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(claims.scope,'https://www.googleapis.com/auth/firebase.messaging');assert.equal(claims.aud,'https://oauth2.googleapis.com/token');assert.ok(verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey(f.privateKey),Buffer.from(parts[2],'base64url')));
    const message=JSON.parse(calls[1].options.body).message;assert.equal(message.data.notificationId,note.id);assert.equal(message.android.priority,'high');assert.equal(message.notification,undefined);assert.equal(message.android.notification,undefined);assert.deepEqual(Object.keys(message.data).sort(),['notificationId','url']);assert.ok(!JSON.stringify(message).includes('Private note'));assert.ok(!JSON.stringify(message).includes('Private lesson contents'));
  }finally{await f.close();}
});

test('logout during the OAuth request cancels the pending FCM send and device expiration permits a fresh binding',async()=>{
  let f,calls=0;f=await fixture({native:true,fetcher:async url=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');await f.db.run("DELETE FROM sessions WHERE token='session-m3'");return new Response(JSON.stringify({access_token:'test-access-token',expires_in:3600}),{status:200});}});try{
    const token=nativeToken('two');await f.push.subscribe('m3','session-m3',{kind:'android',token});await f.note();assert.equal((await f.push.drain()).accepted,0);assert.equal(calls,1);
    await f.db.run('UPDATE sessions SET expires=? WHERE token=?',f.at-1,'session-m4');await rejected(()=>f.push.subscribe('m4','session-m4',{kind:'android',token}),401);
  }finally{await f.close();}
});

test('portable backups omit session-bound push credentials and queue leases',async()=>{
  const f=await fixture();try{await f.push.subscribe('m3','session-m3',{kind:'web',subscription:subscription()});await f.note();const backup=await f.db.exportRows();assert.equal(Object.hasOwn(backup.tables,'push_devices'),false);assert.equal(Object.hasOwn(backup.tables,'push_queue'),false);assert.equal(Object.hasOwn(backup.tables,'sessions'),false);assert.ok(!JSON.stringify(backup).includes('session-m3'));}finally{await f.close();}
});

test('cancelled class reminders are suppressed before push while the current attendance update remains deliverable',async()=>{
  const sent=[],f=await fixture({sendWeb:async(_,payload)=>sent.push(JSON.parse(payload))});try{
    await f.push.subscribe('m3','session-m3',{kind:'web',subscription:subscription()});await f.teaching.saveSlot({id:'a'},{semester:3,teacherId:'t',subjectId:'s3',weekday:1,start:'09:10',end:'10:00',room:'Room A',revision:0});f.clock('2026-11-09T09:07:00+05:45');await f.teaching.processDue();
    const reminder=await f.db.get("SELECT id FROM app_notifications WHERE user_id='m3' AND type='class-reminder'");assert.ok(reminder);const occurrence=(await f.teaching.workspace({id:'t'},3)).upcoming[0];await f.teaching.respond({id:'t'},occurrence.id,{response:'absent',reason:'Private teacher explanation',eta:'',revision:occurrence.revision});
    assert.equal(await f.teaching.notificationForDelivery('m3',reminder.id),null);assert.equal((await f.push.drain()).accepted,1);assert.ok(!sent.some(row=>row.notificationId===reminder.id));assert.ok(!JSON.stringify(sent).includes('Private teacher explanation'));assert.equal((await f.teaching.notifications({id:'m3'})).items.some(row=>row.type==='class-reminder'),false);
  }finally{await f.close();}
});

test('HTTP device registration requires approved current login and CSRF verification, exposes only public configuration, and logout removes the binding',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'classnest-push-')),listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));const keys=generateVAPIDKeys();
  const child=spawn(process.execPath,['server.js'],{cwd:path.dirname(path.dirname(fileURLToPath(import.meta.url))),env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',EMAIL_ENABLED:'false',VERCEL:'',WEBSITE_SITE_NAME:'',PUBLIC_ORIGIN:'https://pusoe.vercel.app',ALLOWED_HOSTS:'',PUSH_VAPID_PUBLIC_KEY:keys.publicKey,PUSH_VAPID_PRIVATE_KEY:keys.privateKey,PUSH_ENCRYPTION_KEY:'f'.repeat(64),FIREBASE_SERVICE_ACCOUNT_JSON:''},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',data=>errors+=data);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Push HTTP server did not start')),10000);child.stdout.on('data',data=>{if(String(data).includes('running')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});});
  async function request(route,method='GET',body,cookie,extra={}){const response=await fetch('http://127.0.0.1:'+port+'/api'+route,{method,headers:{'X-Classnest-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  try{
    const admin=await request('/setup','POST',{name:'Owner',email:'push-owner@example.test',password:'Push owner test password'});assert.equal(admin.status,201);
    const account={name:'Student',email:'push-student@example.test',password:'Push student test password',semester:3};assert.equal((await request('/register','POST',account)).status,202);const login=await request('/login','POST',account);assert.equal(login.status,200);
    assert.equal((await request('/push/config')).status,403);assert.equal((await request('/push/config','GET',undefined,login.cookie)).status,403);assert.equal((await request('/users/'+login.body.id,'PATCH',{role:'member'},admin.cookie)).status,200);
    const config=await request('/push/config','GET',undefined,login.cookie);assert.deepEqual(config.body,{enabled:true,webPushEnabled:true,nativePushEnabled:false,vapidPublicKey:keys.publicKey});assert.ok(!JSON.stringify(config.body).includes(keys.privateKey));
    const payload={kind:'web',subscription:subscription(),label:'HTTP browser'};assert.equal((await request('/push/devices','POST',payload,login.cookie,{'X-Classnest-Request':'0'})).status,403);assert.equal((await request('/push/devices','POST',payload,login.cookie,{Origin:'https://attacker.example'})).status,403);
    const created=await request('/push/devices','POST',payload,login.cookie);assert.equal(created.status,201);const own=await request('/push/devices','GET',undefined,login.cookie);assert.equal(own.body.devices[0].id,created.body.id);assert.ok(!JSON.stringify(own.body).includes(payload.subscription.endpoint));assert.equal((await request('/push/devices','GET',undefined,admin.cookie)).body.devices.length,0);
    await request('/push/devices/'+created.body.id,'DELETE',undefined,admin.cookie);assert.equal((await request('/push/devices','GET',undefined,login.cookie)).body.devices.length,1);
    assert.equal((await request('/logout','POST',{},login.cookie)).status,200);const fresh=await request('/login','POST',account);assert.equal((await request('/push/devices','GET',undefined,fresh.cookie)).body.devices.length,0);assert.equal((await request('/push/devices','POST',payload,fresh.cookie)).status,201);
  }finally{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;assert.equal(path.dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});}
});
