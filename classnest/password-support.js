import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

export const PASSWORD_SUPPORT_MESSAGE='Your request has been received. If the account can be recovered, the administrator will verify your identity before helping you.';
export const TEMPORARY_PASSWORD_TTL_MS=24*3600000;
const REQUEST_TTL=7*86400000,COOLDOWN=30*60000,VERIFICATION_TTL=30*60000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
export const passwordChangeRequired=stored=>typeof stored==='string'&&stored.startsWith('temporary:');
export function passwordAuthenticationHash(stored,at=Date.now()){
  if(!passwordChangeRequired(stored))return {encoded:stored,temporary:false,expired:false};
  const match=/^temporary:([1-9]\d{11,14}):(s2:[a-f0-9]{32}:[a-f0-9]{128})$/.exec(stored);
  return {encoded:match?.[2]||null,temporary:true,expired:!match||Number(match[1])<=at};
}
function strongPassword(value,label){if(typeof value!=='string'||value.length>200||value.trim().length<12)fail(label+' must contain at least 12 non-padding characters (maximum 200).');return value;}

/** A public request never proves identity. A current administrator must verify
 * the requester independently, record the check and reauthenticate twice. */
export function createPasswordSupport({db,hashPassword,passwordMatches,now=Date.now,minimumRequestMs=500,monotonicNow=()=>performance.now(),sleep=delay}={}){
  if(!db||typeof hashPassword!=='function'||typeof passwordMatches!=='function')throw new TypeError('Password support requires the database and password functions.');
  if(!Number.isFinite(minimumRequestMs)||minimumRequestMs<0||minimumRequestMs>5000)throw new TypeError('Invalid support timing policy.');
  const cleanup=()=>db.run('DELETE FROM password_support_requests WHERE expires<=?',now());
  async function currentAdmin(userId,sessionToken){
    const admin=typeof sessionToken==='string'?await db.get('SELECT u.* FROM users u JOIN sessions s ON s.userId=u.id WHERE u.id=? AND s.token=? AND s.expires>?',userId,sessionToken,now()):null;
    if(!admin)fail('Please sign in again.',401);if(admin.role!=='admin')fail('Administrator access is required.',403);if(passwordChangeRequired(admin.password))fail('Change your temporary password before continuing.',428);return admin;
  }
  async function reauthenticate(userId,sessionToken,currentPassword){
    if(typeof currentPassword!=='string'||!currentPassword||currentPassword.length>200)fail('Enter your current administrator password.');
    const result=await db.transaction(async()=>{
      const admin=await currentAdmin(userId,sessionToken),identity=digest('password-support-admin\0'+admin.id),at=now();await db.run('DELETE FROM auth_failures WHERE reset<?',at);
      const failure=await db.get('SELECT attempts FROM auth_failures WHERE identity=?',identity);if(failure?.attempts>=5)return {error:'Too many administrator verification attempts. Try again in 15 minutes.',status:429};
      if(!await passwordMatches(currentPassword,admin.password)){
        if(failure)await db.run('UPDATE auth_failures SET attempts=attempts+1 WHERE identity=?',identity);else await db.run('INSERT INTO auth_failures VALUES(?,?,?)',identity,1,at+15*60000);
        return {error:'Current administrator password is incorrect.',status:403};
      }
      await db.run('DELETE FROM auth_failures WHERE identity=?',identity);return {userId:admin.id,sessionToken,stamp:digest(admin.password)};
    });if(result.error)fail(result.error,result.status);return result;
  }
  async function verifiedAdmin(context){const admin=await currentAdmin(context.userId,context.sessionToken);if(digest(admin.password)!==context.stamp)fail('Your administrator account changed. Sign in again.',401);return admin;}
  async function request(payload){
    if(!fields(payload,['email','message'])||typeof payload.email!=='string'||payload.email.length>200||!/^\S+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim())||payload.email.trim().split('@').length!==2)fail('Enter a valid account email address.');
    const email=payload.email.trim().toLowerCase(),message=payload.message??'';if(typeof message!=='string'||message.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message))fail('Use a support message of at most 500 characters.');
    const started=monotonicNow();try{
      await db.transaction(async()=>{
        await cleanup();const at=now(),identity=digest(email),user=await db.get('SELECT id FROM users WHERE email=?',email),recent=await db.get("SELECT id FROM password_support_requests WHERE identity_hash=? AND (created>? OR status IN('pending','verified')) LIMIT 1",identity,at-COOLDOWN);
        const total=await db.get('SELECT COUNT(*) count FROM password_support_requests'),pending=await db.get("SELECT COUNT(*) count FROM password_support_requests WHERE status IN('pending','verified')");
        if(recent||total.count>=500||pending.count>=100)return;
        await db.run("INSERT INTO password_support_requests(id,user_id,email,identity_hash,message,status,created,expires,verified_by,verified_at,verification_note,password_stamp,resolved_at) VALUES(?,?,?,?,?,'pending',?,?,NULL,NULL,NULL,NULL,NULL)",randomUUID(),user?.id||null,email,identity,message.trim(),at,at+REQUEST_TTL);
      });return {message:PASSWORD_SUPPORT_MESSAGE};
    }finally{const remaining=minimumRequestMs-(monotonicNow()-started);if(remaining>0)await sleep(remaining);}
  }
  async function list(userId,sessionToken){return db.transaction(async()=>{
    await currentAdmin(userId,sessionToken);await cleanup();const rows=await db.all("SELECT r.*,u.name user_name,u.role user_role,u.semester FROM password_support_requests r LEFT JOIN users u ON u.id=r.user_id ORDER BY CASE WHEN r.status IN('pending','verified') THEN 0 ELSE 1 END,r.created DESC,r.id DESC LIMIT 100");
    return {requests:rows.map(row=>({id:row.id,email:row.email,message:row.message,status:row.status,userId:row.user_id,userName:row.user_name??null,userRole:row.user_role??null,semester:row.semester??null,created:row.created,expires:row.expires,verifiedBy:row.verified_by,verifiedAt:row.verified_at,verificationNote:row.verification_note,resolvedAt:row.resolved_at}))};
  });}
  async function openRequest(id){if(typeof id!=='string'||id.length>100)fail('Choose a password support request.');await cleanup();const row=await db.get('SELECT * FROM password_support_requests WHERE id=?',id);if(!row||!['pending','verified'].includes(row.status))fail('This support request is unavailable or already closed.',409);return row;}
  async function verifyRequest(userId,sessionToken,id,payload){
    if(!fields(payload,['currentPassword','verificationNote'])||typeof payload.verificationNote!=='string'||payload.verificationNote.trim().length<20||payload.verificationNote.length>1000)fail('Record how you independently verified the requester (20–1,000 characters).');
    const context=await reauthenticate(userId,sessionToken,payload.currentPassword);return db.transaction(async()=>{
      const admin=await verifiedAdmin(context),row=await openRequest(id),target=row.user_id?await db.get('SELECT * FROM users WHERE id=? AND email=?',row.user_id,row.email):null;
      if(!target)fail('This request does not match an existing account. Reject it instead.');if(target.id===admin.id)fail('Use your account password settings to change your own password.');
      await db.run("UPDATE password_support_requests SET status='verified',verified_by=?,verified_at=?,verification_note=?,password_stamp=? WHERE id=?",admin.id,now(),payload.verificationNote.trim(),digest(target.password),row.id);return {ok:true,status:'verified'};
    });
  }
  async function resolve(userId,sessionToken,id,payload){
    if(!fields(payload,['currentPassword','temporaryPassword','confirmTemporaryPassword']))fail('Send the administrator password and confirmed temporary password.');
    const temporary=strongPassword(payload.temporaryPassword,'Temporary password');if(temporary!==payload.confirmTemporaryPassword)fail('Temporary passwords do not match.');
    const context=await reauthenticate(userId,sessionToken,payload.currentPassword);return db.transaction(async()=>{
      const admin=await verifiedAdmin(context),row=await openRequest(id);if(row.status!=='verified'||row.verified_by!==admin.id||row.verified_at<=now()-VERIFICATION_TTL)fail('Independently verify this request again before resetting its password.',409);
      const target=row.user_id?await db.get('SELECT * FROM users WHERE id=? AND email=?',row.user_id,row.email):null;if(!target||digest(target.password)!==row.password_stamp)fail('The account password changed. Verify the requester again.',409);if(target.id===admin.id)fail('Use your account password settings to change your own password.');
      const currentEncoded=passwordAuthenticationHash(target.password,now()).encoded||target.password;
      if(await passwordMatches(temporary,currentEncoded))fail('Choose a temporary password different from the current password.');const encoded=await hashPassword(temporary);if(!/^s2:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded))throw Error('The password encoder returned an invalid password.');
      const marked='temporary:'+(now()+TEMPORARY_PASSWORD_TTL_MS)+':'+encoded,changed=await db.run('UPDATE users SET password=? WHERE id=? AND password=?',marked,target.id,target.password);if(changed.changes!==1)fail('The account password changed. Verify the requester again.',409);
      await db.run('DELETE FROM sessions WHERE userId=?',target.id);await db.run('DELETE FROM password_resets WHERE userId=?',target.id);await db.run('DELETE FROM email_verifications WHERE userId=?',target.id);await db.run('DELETE FROM auth_failures WHERE identity=?',digest(target.email.toLowerCase()));
      await db.run("UPDATE password_support_requests SET status='resolved',resolved_at=?,password_stamp=NULL WHERE id=?",now(),row.id);
      // Other open requests for this account cannot later overwrite this reset.
      await db.run("UPDATE password_support_requests SET status='rejected',resolved_at=?,password_stamp=NULL WHERE user_id=? AND id<>? AND status IN('pending','verified')",now(),target.id,row.id);
      return {ok:true,status:'resolved',message:'Temporary password saved. Share it privately; the user must change it after signing in.'};
    });
  }
  async function reject(userId,sessionToken,id,payload){
    if(!fields(payload,['currentPassword']))fail('Enter the current administrator password.');const context=await reauthenticate(userId,sessionToken,payload.currentPassword);return db.transaction(async()=>{await verifiedAdmin(context);const row=await openRequest(id);await db.run("UPDATE password_support_requests SET status='rejected',resolved_at=?,password_stamp=NULL WHERE id=?",now(),row.id);return {ok:true,status:'rejected'};});
  }
  return Object.freeze({request,list,verifyRequest,resolve,reject});
}
