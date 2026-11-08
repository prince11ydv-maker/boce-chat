import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHash,createHmac,timingSafeEqual} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const kinds=new Set(['password-reset','email-verification','notification','class-notification']);
const notificationKind=kind=>kind==='notification'||kind==='class-notification';
const classTypes=new Set(['note','notice','daily-routine','teacher-reminder','class-status']);
const failureCode=error=>/^[A-Z_]{3,50}$/.test(error?.code||'')?error.code:'EMAIL_DELIVERY_FAILED';
export function createEmailOutbox({db,mailer,key=process.env.EMAIL_ENCRYPTION_KEY,now=Date.now,dailyLimit=280,notificationLimit=180}={}){
  const enabled=mailer.enabled;
  if(enabled&&!/^[a-f0-9]{64}$/.test(key||''))throw new Error('EMAIL_ENCRYPTION_KEY must be a random 32-byte hexadecimal secret.');
  const secret=key&&/^[a-f0-9]{64}$/.test(key)?Buffer.from(key,'hex'):null;
  const aad=row=>Buffer.from(row.id+'\0'+row.userId+'\0'+row.kind);
  function encrypt(row,message){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(aad(row));const body=Buffer.concat([cipher.update(JSON.stringify(message),'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64');}
  function decrypt(row){const bytes=Buffer.from(row.payload,'base64'),decipher=createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));decipher.setAAD(aad(row));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));}
  async function enqueue({userId,kind,message,expires=now()+3*86400000}){
    if(!enabled)throw Object.assign(new Error('Email delivery is not enabled.'),{code:'EMAIL_DISABLED'});
    if(!kinds.has(kind)||typeof userId!=='string'||!message||JSON.stringify(message).length>40000)throw new Error('Invalid queued email.');
    return db.transaction(async()=>{
      await db.run('DELETE FROM email_outbox WHERE expires<=?',now());
      const total=(await db.get('SELECT COUNT(*) count FROM email_outbox')).count;
      if(notificationKind(kind)&&(total>=800||(await db.get("SELECT COUNT(*) count FROM email_outbox WHERE kind IN ('notification','class-notification')")).count>=800))return null;
      if(total>=1000)throw Object.assign(new Error('Email queue is full.'),{code:'EMAIL_QUEUE_FULL'});
      if(kind==='class-notification'&&(!classTypes.has(message.type)||typeof message.notificationId!=='string'||!message.notificationId||message.notificationId.length>128||!Number.isInteger(message.semester)))throw new Error('Invalid class notification.');
      const row={id:kind==='class-notification'?'class-'+hash(userId+'\0'+message.notificationId):randomUUID(),userId,kind};
      if(kind==='class-notification'&&await db.get('SELECT id FROM email_outbox WHERE id=?',row.id))return row.id;
      await db.run('INSERT INTO email_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',row.id,userId,kind,encrypt(row,message),0,now(),now(),expires,null,null,'pending',null);
      return row.id;
    });
  }
  function unsubscribeToken(user){if(!secret)throw new Error('Email signing is unavailable.');return createHmac('sha256',secret).update('classnest-unsubscribe-v1\0'+user.id+'\0'+user.email.toLowerCase()).digest('hex');}
  function validUnsubscribe(user,token){if(!secret||!user||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return false;return timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(unsubscribeToken(user),'hex'));}
  async function currentMessage(row){
    const user=await db.get('SELECT * FROM users WHERE id=?',row.userId);if(!user)return null;
    const message=decrypt(row);
    if(row.kind==='password-reset'){
      const token=message.resetUrl?.split('/').at(-1),reset=token?await db.get('SELECT passwordStamp,expires FROM password_resets WHERE token=? AND userId=?',hash(token),user.id):null;
      if(!reset||reset.expires<=now()||reset.passwordStamp!==hash(user.password))return null;
    }else if(row.kind==='email-verification'){
      const token=message.verificationUrl?.split('/').at(-1);if(!token||!await db.get('SELECT token FROM email_verifications WHERE token=? AND userId=? AND expires>?',hash(token),user.id,now()))return null;
    }else if(row.kind==='class-notification'){
      if(!classTypes.has(message.type)||!Number.isInteger(message.semester)||!['member','teacher','admin'].includes(user.role))return null;
      const preference=await db.get('SELECT * FROM email_preferences WHERE userId=?',user.id);
      const notification=await db.get('SELECT * FROM app_notifications WHERE id=? AND user_id=?',message.notificationId,user.id);
      if(!notification||notification.type!==message.type||notification.semester!==message.semester||notification.expires_at<=now()||!preference?.verified)return null;
      if(message.type==='teacher-reminder'){
        if(user.role!=='teacher'||Number(preference.teacherreminders)!==1)return null;
        const occurrence=await db.get('SELECT * FROM class_occurrences WHERE id=?',notification.reference);
        if(!occurrence||occurrence.teacher_id!==user.id||occurrence.semester!==message.semester||Number(occurrence.active)!==1||occurrence.response!=='pending'||occurrence.starts_at<=now()||occurrence.starts_at>now()+3*60000)return null;
      }else{
        const column=message.type==='note'?'notes':message.type==='notice'?'notices':'events';
        if(Number(preference[column])!==1||preference.semester!==message.semester)return null;
        if(user.role==='member'&&Number.isInteger(user.semester)&&user.semester!==message.semester)return null;
        if(user.role==='teacher'&&user.semester!==message.semester&&!await db.get('SELECT id FROM teacher_slots WHERE teacher_id=? AND semester=? AND active=1 LIMIT 1',user.id,message.semester)&&!await db.get('SELECT id FROM class_occurrences WHERE teacher_id=? AND semester=? AND active=1 AND ends_at>? LIMIT 1',user.id,message.semester,now()))return null;
        if(message.type==='note'){
          const note=await db.get('SELECT n.id FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.id=? AND s.semester=?',notification.reference,message.semester);
          if(!note)return null;
        }else if(message.type==='notice'){
          if(!await db.get('SELECT id FROM notices WHERE id=? AND semester=?',notification.reference,message.semester))return null;
        }else if(message.type==='daily-routine'){
          const match=/^daily:(\d+):(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(notification.reference||'');
          if(!match||Number(match[1])!==message.semester||!await db.get('SELECT semester FROM daily_routines WHERE semester=? AND class_date=? AND revision=?',message.semester,match[2],Number(match[3])))return null;
        }else{
          const split=notification.reference?.lastIndexOf(':');if(!split||split<0)return null;
          const occurrence=await db.get('SELECT active,revision,semester FROM class_occurrences WHERE id=?',notification.reference.slice(0,split));
          if(!occurrence||Number(occurrence.active)!==1||occurrence.semester!==message.semester||occurrence.revision!==Number(notification.reference.slice(split+1)))return null;
        }
      }
    }else{
      const preference=await db.get('SELECT * FROM email_preferences WHERE userId=?',user.id);
      if(!['member','teacher','admin'].includes(user.role)||!preference?.verified||!['notes','notices','events'].includes(message.notificationType)||!preference[message.notificationType]||preference.semester!==message.semester||user.role==='member'&&Number.isInteger(user.semester)&&user.semester!==message.semester)return null;
    }
    return {...message,id:row.id,to:user.email,name:user.name};
  }
  async function claim(){return db.transaction(async()=>{
    const at=now();await db.run('DELETE FROM email_outbox WHERE expires<=?',at);
    const row=await db.get("SELECT * FROM email_outbox WHERE state<>'failed' AND nextAttempt<=? AND (leaseUntil IS NULL OR leaseUntil<?) ORDER BY CASE WHEN kind IN ('notification','class-notification') THEN 1 ELSE 0 END,created LIMIT 1",at,at);
    if(!row)return null;
    let message;try{message=await currentMessage(row);}catch{await db.run("UPDATE email_outbox SET state='failed',payload='',lastCode='EMAIL_PAYLOAD_INVALID' WHERE id=?",row.id);return {skip:true};}
    if(!message){await db.run('DELETE FROM email_outbox WHERE id=?',row.id);return {skip:true};}
    const day=new Date(at).toISOString().slice(0,10),budget=await db.get('SELECT total,notifications FROM email_budget WHERE day=?',day);
    if((budget?.total||0)>=dailyLimit||notificationKind(row.kind)&&(budget?.notifications||0)>=notificationLimit){await db.run('UPDATE email_outbox SET nextAttempt=? WHERE id=?',Date.parse(day+'T00:00:00Z')+86400000,row.id);return {skip:true};}
    if(budget)await db.run('UPDATE email_budget SET total=total+1,notifications=notifications+? WHERE day=?',Number(notificationKind(row.kind)),day);
    else await db.run('INSERT INTO email_budget VALUES(?,?,?)',day,1,Number(notificationKind(row.kind)));
    await db.run('DELETE FROM email_budget WHERE day<?',new Date(at-32*86400000).toISOString().slice(0,10));
    const lease=randomUUID();await db.run("UPDATE email_outbox SET state='sending',lease=?,leaseUntil=?,attempts=attempts+1 WHERE id=?",lease,at+120000,row.id);
    return {row:{...row,attempts:row.attempts+1,lease},message};
  });}
  async function drain({limit=20}={}){
    if(!enabled)return {accepted:0,disabled:true};let attempts=0,accepted=0;const started=Date.now();
    async function worker(){while(attempts<Math.min(30,limit)&&Date.now()-started<35000){attempts++;const claimed=await claim();if(!claimed)return;if(claimed.skip)continue;const {row,message}=claimed;
      try{await mailer.sendEmail(message);await db.transaction(()=>db.run('DELETE FROM email_outbox WHERE id=? AND lease=?',row.id,row.lease));accepted++;}
      catch(error){const retry=error.retryable!==false&&row.attempts<5,code=failureCode(error);await db.transaction(async()=>{
        if(retry)await db.run("UPDATE email_outbox SET state='pending',lease=NULL,leaseUntil=NULL,nextAttempt=?,lastCode=? WHERE id=? AND lease=?",now()+Math.min(3600000,60000*2**row.attempts),code,row.id,row.lease);
        else await db.run("UPDATE email_outbox SET state='failed',payload='',lease=NULL,leaseUntil=NULL,lastCode=? WHERE id=? AND lease=?",code,row.id,row.lease);
      });}
    }}
    await Promise.all([worker(),worker(),worker()]);return {accepted,checked:attempts};
  }
  async function status(){const counts=await db.all('SELECT state,COUNT(*) count FROM email_outbox GROUP BY state'),day=new Date(now()).toISOString().slice(0,10),budget=await db.get('SELECT total,notifications FROM email_budget WHERE day=?',day);return {enabled,pending:counts.filter(r=>r.state!=='failed').reduce((s,r)=>s+r.count,0),failed:counts.find(r=>r.state==='failed')?.count||0,attemptsToday:budget?.total||0,dailyLimit,notificationLimit};}
  return Object.freeze({enabled,enqueue,drain,status,unsubscribeToken,validUnsubscribe});
}
