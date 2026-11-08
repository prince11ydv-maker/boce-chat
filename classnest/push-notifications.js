import * as webPush from 'web-push';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv,createECDH,createPrivateKey,sign} from 'node:crypto';

const approved=new Set(['admin','member','teacher']),DAY=86400000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const publicDevice=row=>({id:row.id,kind:row.kind,label:row.label,created:row.created,updated:row.updated});
const deliveryError=(code,{retryable=true,removeDevice=false}={})=>Object.assign(new Error('Phone notification delivery is unavailable.'),{code,retryable,removeDevice});

export function validateWebSubscription(value){
  if(!fields(value,['endpoint','keys','expirationTime'])||!fields(value.keys,['p256dh','auth'])||typeof value.endpoint!=='string'||value.endpoint.length>4096)fail('Choose a valid browser push subscription.');
  let url;try{url=new URL(value.endpoint);}catch{fail('Choose a valid browser push subscription.');}
  const host=url.hostname;
  const provider=host==='fcm.googleapis.com'&&/^\/(fcm\/send|wp)\/[A-Za-z0-9_:\-]+$/.test(url.pathname)
    ||host==='updates.push.services.mozilla.com'&&/^\/wpush\/v[12]\/[A-Za-z0-9_:\-]+$/.test(url.pathname)
    ||host==='web.push.apple.com'&&/^\/[A-Za-z0-9_\/-]+$/.test(url.pathname)
    ||/^[a-z0-9-]+\.notify\.windows\.com$/.test(host)&&url.pathname==='/w/';
  if(!provider||url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.search&& !host.endsWith('.notify.windows.com'))fail('This browser push service is not supported.');
  for(const [name,length]of[['p256dh',65],['auth',16]]){
    const key=value.keys[name];if(typeof key!=='string'||!/^[-_A-Za-z0-9]+$/.test(key)||Buffer.from(key,'base64url').length!==length||Buffer.from(key,'base64url').toString('base64url')!==key)fail('The browser push keys are invalid.');
  }
  if(Buffer.from(value.keys.p256dh,'base64url')[0]!==4)fail('The browser push keys are invalid.');
  try{createECDH('prime256v1').setPublicKey(Buffer.from(value.keys.p256dh,'base64url'));}catch{fail('The browser push keys are invalid.');}
  return {endpoint:url.href,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
}
function androidToken(value){if(typeof value!=='string'||value.length<80||value.length>4096||!/^[-_A-Za-z0-9:]+$/.test(value))fail('Choose a valid Android push token.');return value;}
function configuration(env){
  const publicKey=env.PUSH_VAPID_PUBLIC_KEY||'',privateKey=env.PUSH_VAPID_PRIVATE_KEY||'',subject=env.PUSH_VAPID_SUBJECT||'mailto:prince11ydv@gmail.com';
  let vapid=null,account=null;
  if(publicKey||privateKey){
    try{const ec=createECDH('prime256v1');ec.setPrivateKey(Buffer.from(privateKey,'base64url'));if(ec.getPublicKey().toString('base64url')!==publicKey||!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject))throw Error();vapid={publicKey,privateKey,subject};}catch{throw Error('Configure a matching Web Push VAPID key pair and contact address.');}
  }
  if(env.FIREBASE_SERVICE_ACCOUNT_JSON){
    try{account=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);if(!/^[a-z][a-z0-9-]{4,62}$/.test(account.project_id)||!/^[-_.a-zA-Z0-9]+@[-a-z0-9]+\.iam\.gserviceaccount\.com$/.test(account.client_email)||account.token_uri&&account.token_uri!=='https://oauth2.googleapis.com/token')throw Error();const key=createPrivateKey(account.private_key);if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)throw Error();account={projectId:account.project_id,email:account.client_email,key};}catch{throw Error('Configure a valid Firebase service account for Android notifications.');}
  }
  const enabled=Boolean(vapid||account),encryptionKey=env.PUSH_ENCRYPTION_KEY||env.EMAIL_ENCRYPTION_KEY;
  if(enabled&&!/^[a-f0-9]{64}$/.test(encryptionKey||''))throw Error('PUSH_ENCRYPTION_KEY must contain 32 random bytes as hexadecimal.');
  let origin=null;if(enabled){try{origin=new URL(env.PUBLIC_ORIGIN).origin;if(!origin.startsWith('https://'))throw Error();}catch{throw Error('Configure the canonical HTTPS PUBLIC_ORIGIN for phone notifications.');}}
  return {enabled,vapid,account,key:enabled?Buffer.from(encryptionKey,'hex'):null,origin};
}

/** Credentials stay encrypted and bound to one existing login session. Queueing
 * is transaction-only; transports run after commit and recheck current access. */
export function createPushService({db,notificationForDelivery,env=process.env,now=Date.now,fetcher=fetch,sendWeb,sendAndroid}={}){
  if(!db||typeof notificationForDelivery!=='function')throw new TypeError('Push requires the database and current notification authorization.');
  const config=configuration(env),aad=row=>Buffer.from('classnest-push-v1\0'+row.id+'\0'+row.user_id+'\0'+row.session_token+'\0'+row.kind);
  const available=kind=>kind==='web'?Boolean(config.vapid):kind==='android'?Boolean(config.account):false;
  function status(){return {enabled:config.enabled,webPushEnabled:Boolean(config.vapid),nativePushEnabled:Boolean(config.account),vapidPublicKey:config.vapid?.publicKey||null};}
  function encrypt(row,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',config.key,iv);cipher.setAAD(aad(row));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');}
  function decrypt(row){const bytes=Buffer.from(row.payload,'base64'),decipher=createDecipheriv('aes-256-gcm',config.key,bytes.subarray(0,12));decipher.setAAD(aad(row));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));}
  async function actor(userId,sessionToken){
    const row=typeof sessionToken==='string'?await db.get('SELECT u.id,u.role,u.semester FROM users u JOIN sessions s ON s.userId=u.id WHERE u.id=? AND s.token=? AND s.expires>?',userId,sessionToken,now()):null;
    if(!row)fail('Please sign in again.',401);if(!approved.has(row.role))fail('An approved account is required for phone notifications.',403);return row;
  }
  async function prune(){const at=now();await db.run('DELETE FROM push_queue WHERE expires_at<=?',at);await db.run('DELETE FROM push_devices WHERE NOT EXISTS(SELECT 1 FROM sessions s WHERE s.token=push_devices.session_token AND s.userId=push_devices.user_id AND s.expires>?)',at);}
  async function list(userId,sessionToken){return db.transaction(async()=>{await actor(userId,sessionToken);if(!config.enabled)return {...status(),devices:[]};await prune();return {...status(),devices:(await db.all('SELECT id,kind,label,created,updated FROM push_devices WHERE user_id=? AND session_token=? ORDER BY created',userId,sessionToken)).map(publicDevice)};});}
  async function subscribe(userId,sessionToken,payload){return db.transaction(async()=>{
    await actor(userId,sessionToken);if(!fields(payload,['kind','subscription','token','label'])||!['web','android'].includes(payload.kind))fail('Choose a supported phone notification device.');
    if(!available(payload.kind))fail('Phone notifications are still being configured for this device.',503);
    if(payload.kind==='web'&&Object.hasOwn(payload,'token')||payload.kind==='android'&&Object.hasOwn(payload,'subscription'))fail('Send one notification device type.');
    const details=payload.kind==='web'?validateWebSubscription(payload.subscription):{token:androidToken(payload.token)},label=payload.label??(payload.kind==='web'?'Browser':'Android app');
    if(typeof label!=='string'||label.trim().length<1||label.length>60||/[\u0000-\u001f\u007f]/.test(label))fail('Use a device name of 1–60 characters.');
    await prune();const endpointHash=digest(payload.kind+'\0'+(details.endpoint||details.token)),existing=await db.get('SELECT * FROM push_devices WHERE endpoint_hash=?',endpointHash),at=now();
    if(existing&&(existing.user_id!==userId||existing.session_token!==sessionToken))fail('This device is connected to another login. Turn off its notifications or sign out of that login first.',409);
    if(existing){await db.run('UPDATE push_devices SET payload=?,label=?,updated=? WHERE id=?',encrypt(existing,details),label.trim(),at,existing.id);return publicDevice({...existing,label:label.trim(),updated:at});}
    if((await db.get('SELECT COUNT(*) count FROM push_devices WHERE user_id=?',userId)).count>=5)fail('This account already has five connected devices.',429);
    if((await db.get('SELECT COUNT(*) count FROM push_devices')).count>=5000)fail('The workspace notification device limit has been reached.',429);
    const row={id:randomUUID(),user_id:userId,session_token:sessionToken,kind:payload.kind,label:label.trim(),created:at,updated:at};
    await db.run('INSERT INTO push_devices(id,user_id,session_token,kind,endpoint_hash,payload,label,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',row.id,userId,sessionToken,row.kind,endpointHash,encrypt(row,details),row.label,at,at);return publicDevice(row);
  });}
  async function remove(userId,sessionToken,id){return db.transaction(async()=>{await actor(userId,sessionToken);if(typeof id!=='string'||id.length>100)fail('Choose a connected device.');if(config.enabled)await db.run('DELETE FROM push_devices WHERE id=? AND user_id=? AND session_token=?',id,userId,sessionToken);return {ok:true};});}
  async function enqueue(notification){
    if(!config.enabled)return {queued:0};return db.transaction(async()=>{
      const current=await notificationForDelivery(notification.userId,notification.id);if(!current)return {queued:0};await prune();
      let count=(await db.get('SELECT COUNT(*) count FROM push_queue')).count,queued=0;
      for(const device of await db.all('SELECT d.* FROM push_devices d JOIN sessions s ON s.token=d.session_token AND s.userId=d.user_id WHERE d.user_id=? AND s.expires>? ORDER BY d.created LIMIT 5',notification.userId,now())){
        if(!available(device.kind)||count>=10000)continue;const id=digest(current.id+'\0'+device.id);if(await db.get('SELECT id FROM push_queue WHERE id=?',id))continue;
        await db.run("INSERT INTO push_queue(id,device_id,notification_id,state,attempts,next_attempt,lease,lease_until,expires_at,created,last_code) VALUES(?,?,?,'pending',0,?,NULL,NULL,?,?,NULL)",id,device.id,current.id,now(),current.expires_at,now());queued++;count++;
      }return {queued};
    });
  }
  async function current(row){
    const device=await db.get('SELECT * FROM push_devices WHERE id=?',row.device_id);if(!device||!available(device.kind))return null;
    const session=await db.get('SELECT token FROM sessions WHERE token=? AND userId=? AND expires>?',device.session_token,device.user_id,now());if(!session)return null;
    const notification=await notificationForDelivery(device.user_id,row.notification_id);if(!notification)return null;
    let details;try{details=decrypt(device);if(device.kind==='web')details=validateWebSubscription(details);else details={token:androidToken(details.token)};}catch{return null;}
    return {device,notification,details};
  }
  async function claim(){return db.transaction(async()=>{
    await prune();const at=now(),row=await db.get("SELECT * FROM push_queue WHERE state IN('pending','sending') AND next_attempt<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY expires_at,created,id LIMIT 1",at,at);if(!row)return null;
    const value=await current(row);if(!value){await db.run('DELETE FROM push_queue WHERE id=?',row.id);return {skip:true};}
    if(row.attempts>=5){await db.run("UPDATE push_queue SET state='failed',lease=NULL,lease_until=NULL,last_code='PUSH_ATTEMPTS_EXHAUSTED' WHERE id=?",row.id);return {skip:true};}
    const lease=randomUUID();await db.run("UPDATE push_queue SET state='sending',attempts=attempts+1,lease=?,lease_until=? WHERE id=?",lease,at+120000,row.id);return {row:{...row,lease,attempts:row.attempts+1},...value};
  });}
  function message(notification){
    const body=notification.type==='teacher-reminder'?'Your class starts in 3 minutes. Open Classnest to respond.':notification.type==='class-reminder'?'A class starts in 3 minutes. Open Classnest to view your routine.':'You have a new class update. Open Classnest to view it.';
    return {title:'Classnest',body,notificationId:notification.id,url:config.origin+'/?semester='+notification.semester+'#notifications',tag:'classnest-'+notification.id};
  }
  let oauth=null,oauthPending=null;
  async function jsonResponse(response){const text=await response.text();if(text.length>65536)throw deliveryError('PUSH_PROVIDER_RESPONSE');try{return JSON.parse(text);}catch{throw deliveryError('PUSH_PROVIDER_RESPONSE');}}
  async function accessToken(){
    if(oauth?.expires>now()+60000)return oauth.token;if(oauthPending)return oauthPending;oauthPending=(async()=>{const at=Math.floor(now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:config.account.email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:at,exp:at+3600})).toString('base64url'),unsigned=header+'.'+payload,assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),config.account.key).toString('base64url');
    const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});const data=await jsonResponse(response);
    if(!response.ok||typeof data.access_token!=='string'||data.access_token.length>8192||!Number.isFinite(data.expires_in)||data.expires_in<60)throw deliveryError('PUSH_AUTH_FAILED');oauth={token:data.access_token,expires:now()+Math.min(data.expires_in,3600)*1000};return oauth.token;})().finally(()=>{oauthPending=null;});return oauthPending;
  }
  async function send(value,token){
    const payload=message(value.notification),ttl=Math.min(DAY/1000,Math.max(1,Math.floor((value.notification.expires_at-now())/1000)));
    if(value.device.kind==='web'){
      try{await (sendWeb||webPush.sendNotification)(value.details,JSON.stringify({notificationId:payload.notificationId}),{TTL:ttl,urgency:'high',timeout:8000,vapidDetails:config.vapid});}
      catch(error){const status=Number(error.statusCode);throw deliveryError(status===404||status===410?'PUSH_DEVICE_GONE':status===429?'PUSH_RATE_LIMITED':'PUSH_DELIVERY_FAILED',{removeDevice:status===404||status===410,retryable:!status||status===408||status===429||status>=500});}return;
    }
    if(sendAndroid){await sendAndroid(value.details.token,payload,{ttl});return;}
    // Data-only delivery lets the native app recheck local opt-in before showing
    // a generic notification, including after an offline notification opt-out.
    const response=await fetcher('https://fcm.googleapis.com/v1/projects/'+config.account.projectId+'/messages:send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({message:{token:value.details.token,data:{notificationId:payload.notificationId,url:payload.url},android:{priority:'high',ttl:ttl+'s'}}})});
    const data=await jsonResponse(response);if(!response.ok){const gone=data.error?.details?.some(detail=>detail.errorCode==='UNREGISTERED');if(response.status===401)oauth=null;throw deliveryError(gone?'PUSH_DEVICE_GONE':response.status===429?'PUSH_RATE_LIMITED':'PUSH_DELIVERY_FAILED',{removeDevice:gone,retryable:!gone&&(response.status===401||response.status===408||response.status===429||response.status>=500)});}
  }
  let draining=null;
  async function drain({limit=100}={}){
    if(!config.enabled)return {accepted:0,disabled:true};if(draining)return draining;
    draining=(async()=>{let accepted=0,checked=0,reserved=0;const started=Date.now(),bound=Math.min(200,Math.max(1,limit));async function worker(){while(reserved<bound&&Date.now()-started<30000){reserved++;const item=await claim();if(!item)return;checked++;if(item.skip)continue;const {row}=item;
      try{
        const token=item.device.kind==='android'&&!sendAndroid?await accessToken():null;
        // OAuth is a network operation. Recheck the device/session/source after
        // it completes so logout or reassignment during that wait suppresses send.
        const fresh=await db.transaction(async()=>{const owned=await db.get("SELECT * FROM push_queue WHERE id=? AND lease=? AND state='sending'",row.id,row.lease);return owned?current(owned):null;});
        if(!fresh){await db.transaction(()=>db.run('DELETE FROM push_queue WHERE id=? AND lease=?',row.id,row.lease));continue;}
        await send(fresh,token);await db.transaction(()=>db.run("UPDATE push_queue SET state='sent',lease=NULL,lease_until=NULL,last_code=NULL WHERE id=? AND lease=?",row.id,row.lease));accepted++;
      }catch(error){await db.transaction(async()=>{
        if(error.removeDevice){await db.run('DELETE FROM push_devices WHERE id=?',row.device_id);return;}
        const retry=error.retryable!==false&&row.attempts<5,code=/^PUSH_[A-Z_]{2,40}$/.test(error.code||'')?error.code:'PUSH_DELIVERY_FAILED';
        await db.run('UPDATE push_queue SET state=?,next_attempt=?,lease=NULL,lease_until=NULL,last_code=? WHERE id=? AND lease=?',retry?'pending':'failed',now()+Math.min(300000,15000*2**(row.attempts-1)),code,row.id,row.lease);
      });}
    }}await Promise.all([worker(),worker(),worker(),worker()]);return {accepted,checked};})().finally(()=>{draining=null;});return draining;
  }
  return Object.freeze({enabled:config.enabled,status,list,subscribe,remove,enqueue,drain});
}
