import {createHash,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

export const EMAIL_VERIFICATION_TTL_MS=24*60*60*1000;
export const EMAIL_VERIFICATION_COOLDOWN_MS=5*60*1000;
export const EMAIL_VERIFICATION_MESSAGE='If email verification is needed, a verification link will be sent shortly.';
const digest=value=>createHash('sha256').update(value).digest('hex');
const invalidLink='This email verification link is invalid or expired. Request a new link.';
const preferenceKeys=['semester','notes','notices','events','teacherReminders'];
const kinds=Object.freeze({note:'notes',notes:'notes',notice:'notices',notices:'notices',event:'events',events:'events'});

export class EmailPreferencesError extends Error{
  constructor(message,status=400,code='INVALID_EMAIL_PREFERENCES'){super(message);this.name='EmailPreferencesError';this.status=status;this.code=code;}
}
class VerificationQueueError extends Error{constructor(cause){super('Verification email could not be queued.');this.cause=cause;}}

/**
 * enqueue runs inside db.transaction and must only insert an encrypted outbox
 * message through the same database instance. It must not deliver network mail.
 * Its private token context must never be returned by an API endpoint.
 * The main adapter supplies cross-process write serialization. Callers must
 * authenticate userId themselves; this service never approves membership.
 */
export function createEmailPreferences({db,enqueue,origin,now=Date.now,onDeliveryError=()=>{},minimumRequestMs=250,monotonicNow=()=>performance.now(),sleep=delay}={}){
  if(!db||!['get','all','run','transaction'].every(key=>typeof db[key]==='function'))throw new TypeError('Email preferences require a database.');
  let trustedOrigin=null;
  if(origin!==undefined&&origin!==null&&origin!==''){
    let url;try{url=new URL(origin);}catch{throw new TypeError('Use a valid verification origin.');}
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new TypeError('Verification links require a trusted HTTPS origin.');
    trustedOrigin=url.origin;
  }
  if(!Number.isFinite(minimumRequestMs)||minimumRequestMs<0||minimumRequestMs>5000)throw new TypeError('Invalid verification timing policy.');
  const time=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid email preferences clock.');return value;};
  const userIdValue=value=>{if(typeof value!=='string'||!value||value.length>100)throw new EmailPreferencesError('A valid account is required.',404,'ACCOUNT_NOT_FOUND');return value;};
  const user=async id=>{const row=await db.get('SELECT * FROM users WHERE id=?',userIdValue(id));if(!row)throw new EmailPreferencesError('Account not found.',404,'ACCOUNT_NOT_FOUND');return row;};
  const semesterValue=async value=>{if(!Number.isSafeInteger(value)||value<1||!await db.get('SELECT id FROM semesters WHERE id=?',value))throw new EmailPreferencesError('Choose an existing semester.');return value;};
  const currentSemester=async()=>{const settings=await db.get('SELECT semester FROM settings WHERE id=1');if(!settings)throw new EmailPreferencesError('Workspace settings are unavailable.',503,'WORKSPACE_UNAVAILABLE');return Number(settings.semester);};
  const publicPreferences=(row,semester,withTeacher=false)=>({semester:Number(row?.semester??semester),notes:Number(row?.notes)===1,notices:Number(row?.notices)===1,events:Number(row?.events)===1,verified:Number(row?.verified)===1,...(withTeacher?{teacherReminders:Number(row?.teacherreminders)===1}:{})});
  const pendingCleanup=at=>db.run('DELETE FROM email_verifications WHERE expires<=?',at);

  async function get(userId){
    const account=await user(userId);
    const row=await db.get('SELECT * FROM email_preferences WHERE userId=?',userId);
    return publicPreferences(row,row?row.semester:await currentSemester(),account.role==='teacher');
  }
  async function save(userId,preferences){
    if(!preferences||typeof preferences!=='object'||Array.isArray(preferences)||Object.keys(preferences).some(key=>!preferenceKeys.includes(key))||!['notes','notices','events'].every(key=>typeof preferences[key]==='boolean')||preferences.teacherReminders!==undefined&&typeof preferences.teacherReminders!=='boolean')throw new EmailPreferencesError('Choose a semester and true or false for each notification preference.');
    return db.transaction(async()=>{
      const account=await user(userId);const semester=await semesterValue(preferences.semester),row=await db.get('SELECT * FROM email_preferences WHERE userId=?',userId),at=time();
      if(preferences.teacherReminders===true&&account.role!=='teacher')throw new EmailPreferencesError('Class reminder email is available to approved teachers.');
      if(row)await db.run('UPDATE email_preferences SET semester=?,notes=?,notices=?,events=?,updated=? WHERE userId=?',semester,Number(preferences.notes),Number(preferences.notices),Number(preferences.events),at,userId);
      else await db.run('INSERT INTO email_preferences (userId,semester,notes,notices,events,verified,updated) VALUES(?,?,?,?,?,?,?)',userId,semester,Number(preferences.notes),Number(preferences.notices),Number(preferences.events),0,at);
      if(preferences.teacherReminders!==undefined)await db.run('UPDATE email_preferences SET teacherreminders=? WHERE userId=?',Number(preferences.teacherReminders),userId);
      return {semester,notes:preferences.notes,notices:preferences.notices,events:preferences.events,verified:Number(row?.verified)===1,...(account.role==='teacher'||preferences.teacherReminders!==undefined?{teacherReminders:preferences.teacherReminders??Number(row?.teacherreminders)===1}:{})};
    });
  }
  async function requestVerification(userId){
    if(typeof enqueue!=='function'||!trustedOrigin)throw new EmailPreferencesError('Email verification is temporarily unavailable.',503,'EMAIL_UNAVAILABLE');
    const started=monotonicNow(),token=randomBytes(32).toString('hex');
    try{
      try{await db.transaction(async()=>{
        const account=await user(userId),at=time();await pendingCleanup(at);
        const preferences=await db.get('SELECT verified FROM email_preferences WHERE userId=?',account.id);
        const pending=await db.get('SELECT expires FROM email_verifications WHERE userId=?',account.id);
        if(Number(preferences?.verified)===1||pending&&Number(pending.expires)-EMAIL_VERIFICATION_TTL_MS>at-EMAIL_VERIFICATION_COOLDOWN_MS)return;
        const expires=at+EMAIL_VERIFICATION_TTL_MS;
        await db.run('DELETE FROM email_verifications WHERE userId=?',account.id);
        await db.run('INSERT INTO email_verifications (token,userId,expires) VALUES(?,?,?)',digest(token),account.id,expires);
        try{await enqueue(Object.freeze({userId:account.id,email:account.email,name:account.name,token,expires}));}catch(error){throw new VerificationQueueError(error);}
      });}catch(error){if(!(error instanceof VerificationQueueError))throw error;try{await onDeliveryError(error.cause);}catch{}}
      return {message:EMAIL_VERIFICATION_MESSAGE};
    }finally{const remaining=minimumRequestMs-(monotonicNow()-started);if(remaining>0)await sleep(remaining);}
  }
  async function markVerified(userId){
    return db.transaction(async()=>{
      const account=await user(userId);const row=await db.get('SELECT * FROM email_preferences WHERE userId=?',userId),at=time(),semester=Number(row?.semester??await currentSemester());
      if(row)await db.run('UPDATE email_preferences SET verified=?,updated=? WHERE userId=?',1,at,userId);
      else await db.run('INSERT INTO email_preferences (userId,semester,notes,notices,events,verified,updated) VALUES(?,?,?,?,?,?,?)',userId,semester,0,0,0,1,at);
      await db.run('DELETE FROM email_verifications WHERE userId=?',userId);
      return publicPreferences({...row,semester,verified:1},semester,account.role==='teacher');
    });
  }
  async function verify(token){
    if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token))throw new EmailPreferencesError(invalidLink,400,'INVALID_VERIFICATION_LINK');
    const verified=await db.transaction(async()=>{
      const at=time();await pendingCleanup(at);const pending=await db.get('SELECT userId,expires FROM email_verifications WHERE token=?',digest(token));
      if(!pending||Number(pending.expires)<=at||!await db.get('SELECT id FROM users WHERE id=?',pending.userId))return false;
      await markVerified(pending.userId);return true;
    });
    if(!verified)throw new EmailPreferencesError(invalidLink,400,'INVALID_VERIFICATION_LINK');
    return {message:'Your email is verified. Choose which class notifications you want to receive.'};
  }
  async function notificationRecipients(kind,semester){
    if(typeof kind!=='string'||!Object.hasOwn(kinds,kind))throw new EmailPreferencesError('Choose a valid notification type.');const column=kinds[kind];await semesterValue(semester);
    const recipients=await db.all(`SELECT u.* FROM users u JOIN email_preferences p ON p.userId=u.id WHERE p.verified=1 AND p.${column}=1 AND p.semester=? AND u.role IN ('member','teacher','admin') ORDER BY u.id`,semester);
    return recipients.filter(account=>account.role!=='member'||!Number.isInteger(account.semester)||account.semester===semester).map(({id,name,email})=>({id,name,email}));
  }
  async function teachingRecipient(userId,type,semester){
    if(!['note','notice','daily-routine','teacher-reminder','class-reminder','class-status'].includes(type))throw new EmailPreferencesError('Choose a valid class notification type.');
    await semesterValue(semester);
    const account=await user(userId),preference=await db.get('SELECT * FROM email_preferences WHERE userId=?',userId);
    if(!['member','teacher','admin'].includes(account.role)||Number(preference?.verified)!==1)return null;
    if(type==='teacher-reminder')return account.role==='teacher'&&Number(preference.teacherreminders)===1?{id:account.id,name:account.name,email:account.email,role:account.role}:null;
    if(type==='class-reminder'&&account.role!=='member')return null;
    const column=type==='note'?'notes':type==='notice'?'notices':'events';
    if(Number(preference[column])!==1||Number(preference.semester)!==semester)return null;
    if(account.role==='member'&&Number.isInteger(account.semester)&&account.semester!==semester)return null;
    if(account.role==='teacher'&&account.semester!==semester&&!await db.get('SELECT id FROM teacher_slots WHERE teacher_id=? AND semester=? AND active=1 LIMIT 1',account.id,semester)&&!await db.get('SELECT id FROM class_occurrences WHERE teacher_id=? AND semester=? AND active=1 AND ends_at>? LIMIT 1',account.id,semester,time()))return null;
    return {id:account.id,name:account.name,email:account.email,role:account.role};
  }
  return Object.freeze({get,save,requestVerification,verify,markVerified,notificationRecipients,teachingRecipient});
}
