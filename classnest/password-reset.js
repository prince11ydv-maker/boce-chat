import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

export const PASSWORD_RESET_MESSAGE='If an account matches that email, a password reset link will be sent shortly.';
export const PASSWORD_RESET_TTL_MS=30*60*1000;
export const PASSWORD_RESET_COOLDOWN_MS=5*60*1000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const invalidLink='This password reset link is invalid or expired. Request a new link.';
class DeliveryQueueError extends Error{constructor(cause){super('Password reset email could not be queued.');this.cause=cause;}}

export class PasswordResetError extends Error{
  constructor(message=invalidLink,code='INVALID_RESET_LINK'){super(message);this.name='PasswordResetError';this.status=400;this.code=code;}
}

/**
 * The database must serialize transaction() writers across processes (the main
 * adapter uses a PostgreSQL advisory transaction lock / SQL Server app lock).
 * queueDelivery receives the only raw token copy INSIDE the transaction and
 * MUST durably insert an encrypted outbox message using this same db instance.
 * It must not perform network delivery. A queue failure rolls back token and
 * outbox writes together; onDeliveryError is private telemetry after rollback.
 * onConsumed receives private {userId,email} inside the successful reset
 * transaction, for account verification or other transactional bookkeeping.
 * Never return either callback's context to an API caller. Return values are public.
 * Time/sleep injection is for isolated tests; production keeps the defaults.
 */
export function createPasswordResetService({db,hashPassword,queueDelivery,onConsumed=()=>{},onDeliveryError=()=>{},now=Date.now,minimumRequestMs=500,monotonicNow=()=>performance.now(),sleep=delay}={}){
  if(!db||!['get','run','transaction'].every(key=>typeof db[key]==='function')||typeof hashPassword!=='function'||typeof queueDelivery!=='function'||typeof onConsumed!=='function'||typeof onDeliveryError!=='function')throw new TypeError('Password reset requires a database, password hasher, and private callbacks.');
  if(!Number.isFinite(minimumRequestMs)||minimumRequestMs<0||minimumRequestMs>5000)throw new TypeError('Invalid reset request timing policy.');
  const timestamp=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid reset clock.');return value;};
  const cleanup=expires=>db.run('DELETE FROM password_resets WHERE expires<=?',expires);
  const sameStamp=(stored,current)=>typeof stored==='string'&&/^[a-f0-9]{64}$/.test(stored)&&timingSafeEqual(Buffer.from(stored,'hex'),Buffer.from(digest(current),'hex'));

  async function request(email){
    const started=monotonicNow(),rawToken=randomBytes(32).toString('hex');
    const normalized=typeof email==='string'&&email.length<=200?email.trim().toLowerCase():'';
    try{
      try{await db.transaction(async()=>{
        const at=timestamp();await cleanup(at);
        const user=await db.get('SELECT id,name,email,password FROM users WHERE email=?',normalized);
        // Run the same pending-token lookup for missing accounts; never expose
        // account existence, cooldown state, user IDs, or tokens in the result.
        const pending=await db.get('SELECT token,passwordStamp,expires FROM password_resets WHERE userId=?',user?.id??null);
        if(!user)return;
        if(pending&&Number(pending.expires)-PASSWORD_RESET_TTL_MS>at-PASSWORD_RESET_COOLDOWN_MS)return;
        await db.run('DELETE FROM password_resets WHERE userId=?',user.id);
        const expires=at+PASSWORD_RESET_TTL_MS;
        await db.run('INSERT INTO password_resets (token,userId,passwordStamp,expires) VALUES(?,?,?,?)',digest(rawToken),user.id,digest(user.password),expires);
        try{await queueDelivery(Object.freeze({userId:user.id,name:user.name,email:user.email,token:rawToken,expires}));}catch(error){throw new DeliveryQueueError(error);}
      });}catch(error){if(!(error instanceof DeliveryQueueError))throw error;try{await onDeliveryError(error.cause);}catch{}}
      return {message:PASSWORD_RESET_MESSAGE};
    }finally{
      // A response floor hides ordinary lookup/write/queue timing differences.
      // Outbox draining/network delivery belongs outside this service.
      const remaining=minimumRequestMs-(monotonicNow()-started);
      if(remaining>0)await sleep(remaining);
    }
  }

  async function consume(token,newPassword){
    const validForm=typeof token==='string'&&/^[a-f0-9]{64}$/.test(token);
    if(!validForm)throw new PasswordResetError();
    if(typeof newPassword!=='string'||newPassword.length>200||newPassword.trim().length<12)throw new PasswordResetError('Use a password with at least 12 non-padding characters (maximum 200 characters).','INVALID_PASSWORD');
    const tokenDigest=digest(token);
    const changed=await db.transaction(async()=>{
      const at=timestamp();await cleanup(at);
      const reset=await db.get('SELECT token,userId,passwordStamp,expires FROM password_resets WHERE token=?',tokenDigest);
      if(!validForm||!reset||Number(reset.expires)<=at)return false;
      const user=await db.get('SELECT id,email,password FROM users WHERE id=?',reset.userId);
      if(!user||!sameStamp(reset.passwordStamp,user.password)){
        await db.run('DELETE FROM password_resets WHERE token=?',tokenDigest);
        return false;
      }
      const password=await hashPassword(newPassword);
      if(typeof password!=='string'||!password||password===newPassword)throw new Error('Password hasher did not return an encoded password.');
      // The conditional update is additional protection if an alternative
      // caller writes passwords without the adapter's shared transaction lock.
      const result=await db.run('UPDATE users SET password=? WHERE id=? AND password=?',password,user.id,user.password);
      if(result.changes!==1)throw new PasswordResetError();
      await db.run('DELETE FROM sessions WHERE userId=?',user.id);
      await db.run('DELETE FROM password_resets WHERE userId=?',user.id);
      await db.run('DELETE FROM auth_failures WHERE identity=?',digest(user.email.trim().toLowerCase()));
      await onConsumed(Object.freeze({userId:user.id,email:user.email}));
      return true;
    });
    if(!changed)throw new PasswordResetError();
    return {message:'Your password has been reset. Sign in with your new password.'};
  }

  return Object.freeze({request,consume});
}
