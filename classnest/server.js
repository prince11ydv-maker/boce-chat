import express from 'express';
import helmet from 'helmet';
import {requestLimiter} from './rate-limiter.js';
import multer from 'multer';
import {openDatabase} from './db-adapter.js';
import {openStorage} from './storage-adapter.js';
import {createMailer} from './mailer.js';
import {createEmailOutbox} from './email-outbox.js';
import {createPasswordResetService} from './password-reset.js';
import {createEmailPreferences} from './email-preferences.js';
import {routineKinds,validateRoutineContent,emptyRoutineContent,publicRoutine} from './routine-data.js';
import {createTeachingService} from './teaching.js';
import {createTeacherDashboard} from './teacher-dashboard.js';
import {createNoticeAttachments,noticeAttachmentTypes,publicNoticeAttachment} from './notice-attachments.js';
import {verifyNoticeFile} from './notice-file-validation.js';
import {createPushService} from './push-notifications.js';
import {waitUntil} from '@vercel/functions';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomBytes, randomUUID, scrypt, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdirSync, existsSync, unlinkSync, readdirSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const cloudStorage=process.env.STORAGE_PROVIDER==='supabase';
if(process.env.VERCEL&&!cloudStorage)throw new Error('Vercel requires STORAGE_PROVIDER=supabase.');
if(!cloudStorage)mkdirSync(path.join(dataDir, 'uploads'), {
  recursive: true
});
const uploadSizes = new Map(cloudStorage?[]:readdirSync(path.join(dataDir, 'uploads'), {
  withFileTypes: true
}).filter(entry => entry.isFile()).map(entry => [entry.name, statSync(path.join(dataDir, 'uploads', entry.name)).size]));
let uploadBytesOnDisk = [...uploadSizes.values()].reduce((sum, size) => sum + size, 0);
const db = await openDatabase({
  dataDir
});
if(cloudStorage&&db.provider!=='postgres')throw new Error('Supabase uploads require DB_PROVIDER=postgres.');
const storage=cloudStorage?await openStorage():null;
const app = express();
app.disable('x-powered-by');
if (process.env.WEBSITE_SITE_NAME||process.env.VERCEL) app.set('trust proxy', 1);
const production = process.env.NODE_ENV === 'production';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
if (publicOrigin && production && !publicOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS in production.');
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', process.env.WEBSITE_HOSTNAME,process.env.VERCEL_URL,process.env.VERCEL_PROJECT_PRODUCTION_URL, publicOrigin ? new URL(publicOrigin).hostname : null, ...(process.env.ALLOWED_HOSTS || '').split(',')].filter(Boolean).map(s => s.trim().toLowerCase()));
app.use((req, res, next) => {
  const raw = req.get('host') || '';
  let host;
  try {
    if ((/[\s\\/@?#]/).test(raw)) throw new Error();
    host = new URL('http://' + raw).hostname.toLowerCase();
  } catch {
    return res.status(400).json({
      error: 'Invalid host.'
    });
  }
  if (!allowedHosts.has(host)) return res.status(421).json({
    error: 'This hostname is not configured for the workspace.'
  });
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'worker-src': ["'self'"],
      'connect-src': ["'self'",...(cloudStorage?[new URL(process.env.SUPABASE_URL).origin]:[])],
      'object-src': ["'none'"],
      'frame-src': ["'none'"],
      'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null
    }
  }
}));
const hash = value => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);
const newHashOptions = {
  N: 32768,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024
};
const passwordHash = async p => {
  const salt = randomBytes(16).toString('hex');
  return 's2:' + salt + ':' + (await derive(p, salt, 64, newHashOptions)).toString('hex');
};
const mailer=createMailer(),emailOutbox=createEmailOutbox({db,mailer});
const emailPreferences=createEmailPreferences({db,origin:publicOrigin,enqueue:({userId,name,email,token,expires})=>emailOutbox.enqueue({userId,kind:'email-verification',expires,message:{template:'email-verification',to:email,name,verificationUrl:publicOrigin+'/#verify-email/'+token,expiresMinutes:1440}})});
const teaching=createTeachingService({db,onNotify:async n=>{
  await push.enqueue(n);
  if(!emailOutbox.enabled)return;
  const recipient=await emailPreferences.teachingRecipient(n.userId,n.type,n.semester);
  if(recipient){const destination=new URL(n.url,publicOrigin);destination.searchParams.set('semester',String(n.semester));const dailyDate=/^daily:\d+:(\d{4}-\d{2}-\d{2}):/.exec(n.reference);if(dailyDate)destination.searchParams.set('date',dailyDate[1]);await emailOutbox.enqueue({userId:n.userId,kind:'class-notification',expires:n.expiresAt,message:{template:'class-notification',notificationId:n.id,type:n.type,semester:n.semester,title:n.title,body:n.body,actionUrl:destination.href,unsubscribeUrl:publicOrigin+'/#unsubscribe/'+recipient.id+'/'+emailOutbox.unsubscribeToken(recipient)}});}
}});
const push=createPushService({db,notificationForDelivery:(userId,id)=>teaching.notificationForDelivery(userId,id)});
const teacherDashboard=createTeacherDashboard({db,teaching});
const noticeFiles=createNoticeAttachments({db});
const passwordResets=createPasswordResetService({db,hashPassword:passwordHash,queueDelivery:({userId,name,email,token,expires})=>emailOutbox.enqueue({userId,kind:'password-reset',expires,message:{template:'password-reset',to:email,name,resetUrl:publicOrigin+'/#reset-password/'+token,expiresMinutes:30}}),onConsumed:({userId})=>emailPreferences.markVerified(userId),onDeliveryError:()=>console.error('Email recovery queue is unavailable.')});
let emailDrainPromise;
function scheduleEmailDelivery(){
  if(!emailOutbox.enabled&&!push.enabled)return;
  emailDrainPromise??=Promise.allSettled([emailOutbox.drain(),push.drain()]).then(results=>{if(results.some(result=>result.status==='rejected'))console.error('Notification queue processing failed.');}).finally(()=>{emailDrainPromise=null;});
  if(process.env.VERCEL){try{waitUntil(emailDrainPromise);}catch{console.error('Email delivery will retry through its scheduled worker.');}}
}
async function queueClassEmails(req,kind,selected,title,body,actionUrl){
  if(!emailOutbox.enabled)return;
  const recipients=await emailPreferences.notificationRecipients(kind,selected);
  for(const user of recipients){const queued=await emailOutbox.enqueue({userId:user.id,kind:'notification',message:{template:'notification',notificationType:kind,semester:selected,subject:('Classnest · '+title).slice(0,150),title,body:body.slice(0,1800),actionUrl:publicOrigin+actionUrl,unsubscribeUrl:publicOrigin+'/#unsubscribe/'+user.id+'/'+emailOutbox.unsubscribeToken(user)}});if(!queued)break;}
  req.afterCommit.push(()=>{scheduleEmailDelivery();});
}
async function announceSharedNote(req,{id,subject,title}){
  await teaching.notifyNote({id,subjectId:subject,title,semester:(await get('SELECT semester FROM subjects WHERE id=?',subject)).semester,authorId:req.user.id});
  req.afterCommit.push(scheduleEmailDelivery);
}
const passwordMatches = async (p, stored) => {
  const parts = stored?.split(':') || [], modern = parts[0] === 's2', salt = parts[modern ? 1 : 0], digest = parts[modern ? 2 : 1];
  const valid = (/^[a-f0-9]{32}$/).test(salt || '') && (/^[a-f0-9]{128}$/).test(digest || '');
  const safeSalt = valid ? salt : ('0').repeat(32), expected = Buffer.from(valid ? digest : ('0').repeat(128), 'hex');
  const [current, legacy] = await Promise.all([derive(p, safeSalt, 64, newHashOptions), derive(p.trim(), safeSalt, 64)]);
  return timingSafeEqual(expected, modern ? current : legacy) && valid;
};
const publicUser = u => u ? {
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  accountType: u.role==='admin'?'admin':u.role==='teacher'?'teacher':u.accounttype||'student',
  semester: u.semester ?? null
} : null;
const all = (sql, ...params) => db.all(sql, ...params);
const get = (sql, ...params) => db.get(sql, ...params);
const run = (sql, ...params) => db.run(sql, ...params);
const now = () => new Date().toISOString();
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const text = (v, label, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(400, `${label} is required (maximum ${max} characters).`);
  return v.trim();
};
const optional = (v, max = 200) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max) fail(400, 'Text is too long.');
  return v.trim();
};
const password = (v, label = 'Password') => {
  if (typeof v !== 'string' || !v.length || v.length > 200) fail(400, `${label} is required (maximum 200 characters).`);
  return v;
};
const checkPassword = p => {
  if (p.trim().length < 12) fail(400, 'Use a password with at least 12 non-padding characters.');
  return p;
};
async function recordCapacity(table, limit, content = '', replacedContent = '') {
  if ((await get(`SELECT COUNT(*) count FROM ${table}`)).count >= limit) fail(429, 'This workspace has reached its content limit. Ask the administrator to remove unused content.');
  const bytes = (await get("SELECT COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM notes),0)+COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM notices),0)+COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM threads),0)+COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM replies),0) bytes")).bytes;
  const encoding=db.provider==='azure-sql'?'utf16le':'utf8',addedBytes=Math.max(0,Buffer.byteLength(content,encoding)-Buffer.byteLength(replacedContent,encoding));
  if (bytes + addedBytes > 64 * 1024 * 1024) fail(413, 'The workspace text storage limit has been reached. Remove unused content first.');
}
const semester = async v => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^[1-9]\d*$/.test(v))) fail(400, 'Choose a valid semester.');
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id < 1 || !await get('SELECT id FROM semesters WHERE id=?', id)) fail(400, 'Choose a valid semester.');
  return id;
};
const semesterLocked = user => Boolean(user && !['admin','teacher'].includes(user.role));
const approvedReader = user => Boolean(user&&['admin','member','teacher'].includes(user.role));
function requireClassReader(req){
  if(!req.user)fail(401,'Please sign in to view your class.');
  if(!approvedReader(req.user))fail(403,'Your account needs administrator approval before viewing class content.');
}
async function currentReader(req) {
  if(req.sessionToken){
    const current=await get('SELECT u.* FROM users u JOIN sessions s ON s.userId=u.id WHERE s.token=? AND s.expires>?',req.sessionToken,Date.now());
    if(!current&&req.user)fail(401,'Please sign in again.');
    req.user=current;
  }
  return req.user;
}
async function readerSemesters(req) {
  requireClassReader(req);
  if(req.user.role==='admin')return all('SELECT * FROM semesters ORDER BY id');
  if(req.user.role==='teacher')return (await teacherDashboard.scope(req.user)).semesters;
  return all('SELECT * FROM semesters WHERE id=?',req.user.semester);
}
async function checkSemesterAccess(req,selected) {
  if(!req.user)fail(401,'Please sign in to view your class.');
  if(semesterLocked(req.user)&&req.user.semester!==selected)fail(403,'Your account is limited to your assigned semester.');
  requireClassReader(req);
  if(req.user.role==='teacher'&&!(await readerSemesters(req)).some(row=>row.id===selected))fail(403,'Choose one of your selected or assigned teaching semesters.');
}
async function browseSemester(req,value) {
  await currentReader(req);
  const options=await readerSemesters(req),preferred=req.user.role==='admin'?(await get('SELECT semester FROM settings WHERE id=1')).semester:req.user.semester;
  const selected=await semester(value===undefined?(options.some(row=>row.id===preferred)?preferred:options[0]?.id):value);
  await checkSemesterAccess(req,selected);
  return selected;
}
async function noteForReader(req,id) {
  return db.transaction(async()=>{
    await currentReader(req);
    requireClassReader(req);
    const note=await get('SELECT n.*,s.semester FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.id=?',id);
    if(note)await checkSemesterAccess(req,note.semester);
    return note;
  });
}
async function noticeFileForReader(req,id) {
  return db.transaction(async()=>{
    await currentReader(req);
    requireClassReader(req);
    const notice=await get('SELECT semester FROM notices WHERE id=?',id);
    if(notice)await checkSemesterAccess(req,notice.semester);
    return notice?noticeFiles.get(id):null;
  });
}
app.use('/api', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('classnest_session='))?.slice(18);
  req.sessionToken=raw?hash(raw):null;
  if (raw&&req.path!=='/health') {
    const session = await get('SELECT * FROM sessions WHERE token=? AND expires>?', hash(raw), Date.now());
    if (session) req.user = await get('SELECT * FROM users WHERE id=?', session.userId);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['x-classnest-request'] !== '1') return res.status(403).json({
      error: 'Request verification failed.'
    });
    const origin = req.headers.origin;
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({
      error: 'Cross-site request blocked.'
    });
    if (origin) {
      try {
        const expected = publicOrigin || `${production ? 'https' : req.protocol}://${req.get('host')}`;
        if (new URL(origin).origin !== expected) return res.status(403).json({
          error: 'Cross-site request blocked.'
        });
      } catch {
        return res.status(403).json({
          error: 'Invalid origin.'
        });
      }
    }
  }
  next();
});
const signed = (req, res, next) => {req.requiredRole='signed';return req.user ? next() : res.status(401).json({
  error: 'Please sign in first.'
});};
const member = (req, res, next) => {req.requiredRole='member';return ['admin', 'member','teacher'].includes(req.user?.role) ? next() : res.status(403).json({
  error: 'An approved member account is required.'
});};
const admin = (req, res, next) => {req.requiredRole='admin';return req.user?.role === 'admin' ? next() : res.status(403).json({
  error: 'Administrator access is required.'
});};
const noticePublisher = (req, res, next) => {req.requiredRole='member';return ['admin','teacher'].includes(req.user?.role) ? next() : res.status(403).json({
  error: 'An approved teacher or administrator account is required to publish announcements.'
});};
const atomic=handler=>async(req,res,next)=>{
  const originalJson=res.json;let payload,sent=false,handlerFinished=false;req.afterCommit=[];
  res.json=value=>{payload=value;sent=true;return res;};
  try{
    await db.transaction(async()=>{
      if(req.requiredRole){const current=req.sessionToken?await get('SELECT u.* FROM users u JOIN sessions s ON s.userId=u.id WHERE s.token=? AND s.expires>?',req.sessionToken,Date.now()):null;
        if(!current)fail(401,'Please sign in again.');
        if(req.requiredRole==='admin'&&current.role!=='admin'||req.requiredRole==='member'&&!['member','admin','teacher'].includes(current.role))fail(403,'Posting access was revoked.');
        req.user=current;
      }
      await handler(req,res,error=>{if(error)throw error;});
      handlerFinished=true;
    });
    res.json=originalJson;
    for(const action of req.afterCommit){try{await action();}catch{console.error('Deferred attachment cleanup failed.');}}
    if(sent)res.json(payload);
  }catch(error){if(handlerFinished&&req.file)req.uploadCommitUncertain=true;res.json=originalJson;res.removeHeader('Set-Cookie');next(error);}
};
const authLimiter = requestLimiter(db,'auth',{
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many attempts. Try again in 15 minutes.'
  }
});
app.use('/api', requestLimiter(db,'api',{
  windowMs: 60000,
  limit: 250,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a minute.'
  }
}));
app.use(express.json({
  limit: '200kb'
}));
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.method === 'DELETE' && !req.get('content-type')) return next();
    if (req.method === 'POST' && ['/notes','/notices'].includes(req.path) && req.is('multipart/form-data')) return next();
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({
      error: 'Send a JSON object with this request.'
    });
  }
  next();
});
let activeAuthWork = 0;
const authWork = handler => async (req, res, next) => {
  if (activeAuthWork >= 4) return res.status(503).json({
    error: 'Sign-in is busy. Please try again shortly.'
  });
  activeAuthWork++;
  try {
    await handler(req, res, next);
  } catch (e) {
    next(e);
  } finally {
    activeAuthWork--;
  }
};
const writeLimiter = requestLimiter(db,'write',{
  windowMs: 15 * 60 * 1000,
  limit: req => req.user.role === 'admin' ? 180 : 60,
  keyGenerator: req => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'You have shared a lot recently. Please wait before posting again.'
  }
});
app.use('/api', (req, res, next) => req.user && ['POST', 'PATCH'].includes(req.method) && !['/login', '/logout', '/password'].includes(req.path) ? writeLimiter(req, res, next) : next());
const setSession = async (req, res, u) => {
  const token = randomBytes(32).toString('hex');
  await run('DELETE FROM sessions WHERE expires<?', Date.now());
  const old = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('classnest_session='))?.slice(18);
  if (old) await run('DELETE FROM sessions WHERE token=?', hash(old));
  await run('DELETE FROM sessions WHERE userId=? AND token NOT IN (SELECT token FROM sessions WHERE userId=? ORDER BY expires DESC LIMIT 9)', u.id, u.id);
  await run('INSERT INTO sessions VALUES(?,?,?)', hash(token), u.id, Date.now() + 7 * 86400000);
  res.cookie('classnest_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || production,
    maxAge: 7 * 86400000,
    path: '/'
  });
};
const discussionMember = user => ['admin', 'member','teacher'].includes(user?.role);
async function currentDiscussionMember(req) {
  const user = req.sessionToken ? await get('SELECT u.* FROM users u JOIN sessions s ON s.userId=u.id WHERE s.token=? AND s.expires>?', req.sessionToken, Date.now()) : null;
  if (!discussionMember(user)) fail(403, 'An approved member account is required.');
  req.user = user;
  return user;
}
function canDiscuss(user, selected) {
  return discussionMember(user) && (user.role === 'admin' || Number.isSafeInteger(user.semester) && user.semester === selected);
}
async function discussionThread(req, id) {
  const thread = await get('SELECT * FROM threads WHERE id=?', id);
  if (!thread || !canDiscuss(req.user, thread.semester)) fail(404, 'Discussion not found.');
  return thread;
}
async function visibleDiscussions(req, selected) {
  // Membership reads share the assignment/revocation lock with writes. Class
  // library access and private thread access are checked separately; no thread bytes are fetched
  // before the current session, role, and recorded semester are checked.
  if (!req.sessionToken) return [];
  return db.transaction(async () => {
    const user = await get('SELECT u.* FROM users u JOIN sessions s ON s.userId=u.id WHERE s.token=? AND s.expires>?', req.sessionToken, Date.now());
    if (!canDiscuss(user, selected)) return [];
    return all('SELECT t.*,u.name author,(SELECT COUNT(*) FROM replies r WHERE r.threadId=t.id) replyCount FROM threads t LEFT JOIN users u ON u.id=t.authorId WHERE t.semester=? ORDER BY t.created DESC', selected);
  });
}
async function sendJson(res,value){
  if(!process.env.VERCEL)return res.json(value);
  // Streaming avoids Vercel's buffered response cap for large libraries/backups.
  const bytes=Buffer.from(JSON.stringify(value));
  res.type('json');res.flushHeaders();
  async function* chunks(){for(let at=0;at<bytes.length;at+=65536)yield bytes.subarray(at,at+65536);}
  await pipeline(Readable.from(chunks()),res);
}
async function routinesFor(selected){
  const result={class:null,exam:null};
  for(const row of await all('SELECT * FROM routines WHERE semester=?',selected)){
    if(!routineKinds.has(row.kind))continue;
    try{result[row.kind]=publicRoutine(row);}catch{fail(503,'A routine is temporarily unavailable. Please try again later.');}
  }
  return result;
}
async function noticesFor(selected){const files=new Map((await noticeFiles.list(selected)).map(file=>[file.notice_id,publicNoticeAttachment(file)]));return (await all('SELECT n.*,u.name author FROM notices n LEFT JOIN users u ON u.id=n.authorId WHERE n.semester=? ORDER BY n.pinned DESC,n.created DESC',selected)).map(notice=>({...notice,attachment:files.get(notice.id)||null}));}
app.get('/api/state', async (req, res) => {
  const payload=await db.transaction(async()=>{
  await currentReader(req);
  const settings=await get('SELECT * FROM settings'),needsSetup=!await get("SELECT id FROM users WHERE role='admin'");
  if(!req.user)return {settings,semesters:await all('SELECT id,name FROM semesters ORDER BY id'),selectedSemester:settings.semester,semesterLocked:false,user:null,requiresLogin:true,requiresApproval:false,directUploads:false,emailAvailable:emailOutbox.enabled,emailDelivery:null,needsSetup,subjects:[],notes:[],notices:[],threads:[],routines:{class:null,exam:null},teaching:null,events:[]};
  if(!approvedReader(req.user)){
    const selected=await semester(req.query.semester??req.user.semester);if(selected!==req.user.semester)fail(403,'Your account is limited to your assigned semester.');
    return {settings,semesters:await all('SELECT id,name FROM semesters WHERE id=?',selected),teacherSemesterOptions:req.user.role==='pending'&&req.user.accounttype==='teacher'?await all('SELECT id,name FROM semesters ORDER BY id'):[],selectedSemester:selected,semesterLocked:true,user:publicUser(req.user),requiresLogin:false,requiresApproval:true,directUploads:false,emailAvailable:emailOutbox.enabled,emailDelivery:null,needsSetup,subjects:[],notes:[],notices:[],threads:[],routines:{class:null,exam:null},teaching:null,events:[]};
  }
  const selected = await browseSemester(req,req.query.semester);
  return {
    settings,
    semesters: await readerSemesters(req),
    teacherSemesterOptions:req.user.role==='teacher'?await all('SELECT id,name FROM semesters ORDER BY id'):[],
    selectedSemester:selected,
    semesterLocked:semesterLocked(req.user),
    requiresLogin:false,
    requiresApproval:false,
    user: publicUser(req.user),
    directUploads:cloudStorage,
    emailAvailable:emailOutbox.enabled,
    emailDelivery:req.user?.role==='admin'&&emailOutbox.enabled?await emailOutbox.status():null,
    needsSetup,
    subjects: await all('SELECT s.*, (SELECT COUNT(*) FROM notes n WHERE n.subjectId=s.id) noteCount FROM subjects s WHERE semester=? ORDER BY name', selected),
    notes: await all('SELECT n.id,n.subjectId,n.title,n.content,n.originalName,n.mime,n.size,n.authorId,n.created,u.name author,s.name subjectName FROM notes n JOIN subjects s ON s.id=n.subjectId JOIN users u ON u.id=n.authorId WHERE s.semester=? ORDER BY n.created DESC', selected),
    notices: await noticesFor(selected),
    threads: await visibleDiscussions(req, selected),
    routines: await routinesFor(selected),
    teaching: await teaching.state(null,selected),
    events: await all('SELECT * FROM events WHERE semester=? ORDER BY date', selected)
  };
  });
  await sendJson(res,payload);
});
function routineRequest(req,reset=false){
  if(!routineKinds.has(req.params.kind))fail(400,'Choose a class or exam routine.');
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(key=>!(reset?['semester','revision']:['semester','title','columns','rows','revision']).includes(key)))fail(400,'Send the routine details as a JSON object.');
  if(!Number.isInteger(req.body.revision)||req.body.revision<0||req.body.revision>=2147483647)fail(400,'A valid routine revision is required. Reload the routine and try again.');
  return reset?emptyRoutineContent(req.params.kind):validateRoutineContent({title:req.body.title,columns:req.body.columns,rows:req.body.rows});
}
async function saveRoutine(req,res,reset=false){
  const content=routineRequest(req,reset),selected=await semester(reset?(req.body.semester??req.query.semester):req.body.semester),kind=req.params.kind;
  if(reset&&req.body.semester!==undefined&&req.query.semester!==undefined&&selected!==await semester(req.query.semester))fail(400,'Choose one routine semester.');
  const current=await get('SELECT revision FROM routines WHERE semester=? AND kind=?',selected,kind);
  if(req.body.revision!==(current?.revision||0))fail(409,'This routine changed in another tab. Reload it before saving your edits.');
  const revision=(current?.revision||0)+1,updated=now(),encoded=JSON.stringify(content);
  if(current){const saved=await run('UPDATE routines SET content=?,revision=?,updated=? WHERE semester=? AND kind=? AND revision=?',encoded,revision,updated,selected,kind,current.revision);if(saved.changes!==1)fail(409,'This routine changed. Reload it before saving your edits.');}
  else await run('INSERT INTO routines (semester,kind,content,revision,updated) VALUES(?,?,?,?,?)',selected,kind,encoded,revision,updated);
  res.json({kind,...content,revision,updated});
}
app.put('/api/routines/:kind',admin,atomic((req,res)=>saveRoutine(req,res)));
app.delete('/api/routines/:kind',admin,atomic((req,res)=>saveRoutine(req,res,true)));
app.get('/api/teaching/state',async(req,res)=>res.json(await db.transaction(async()=>teaching.state(null,await browseSemester(req,req.query.semester),req.query.date))));
app.get('/api/teaching/workspace',member,atomic(async(req,res)=>res.json(await teaching.workspace(req.user,await browseSemester(req,req.query.semester),req.query.date))));
app.post('/api/teaching/slots',admin,atomic(async(req,res)=>{res.status(201).json(await teaching.saveSlot(req.user,req.body));req.afterCommit.push(scheduleEmailDelivery);}));
app.put('/api/teaching/slots/:id',admin,atomic(async(req,res)=>{res.json(await teaching.saveSlot(req.user,req.body,req.params.id));req.afterCommit.push(scheduleEmailDelivery);}));
app.delete('/api/teaching/slots/:id',admin,atomic(async(req,res)=>res.json(await teaching.deleteSlot(req.user,req.params.id,req.body.revision))));
app.put('/api/daily-routines',admin,atomic(async(req,res)=>{res.json(await teaching.publishDaily(req.user,req.body));req.afterCommit.push(scheduleEmailDelivery);}));
app.post('/api/teaching/sessions/:id/respond',member,atomic(async(req,res)=>{res.json(await teaching.respond(req.user,req.params.id,req.body));req.afterCommit.push(scheduleEmailDelivery);}));
app.get('/api/notifications',member,atomic(async(req,res)=>res.json(await teaching.notifications(req.user))));
app.get('/api/push/config',member,atomic(async(req,res)=>res.json(push.status())));
app.get('/api/push/devices',member,atomic(async(req,res)=>res.json(await push.list(req.user.id,req.sessionToken))));
app.post('/api/push/devices',member,atomic(async(req,res)=>res.status(201).json(await push.subscribe(req.user.id,req.sessionToken,req.body))));
app.delete('/api/push/devices/:id',member,atomic(async(req,res)=>res.json(await push.remove(req.user.id,req.sessionToken,req.params.id))));
app.patch('/api/notifications/read-all',member,atomic(async(req,res)=>res.json(await teaching.markRead(req.user,'all'))));
app.patch('/api/notifications/:id/read',member,atomic(async(req,res)=>res.json(await teaching.markRead(req.user,req.params.id))));
app.get('/api/teacher/dashboard',member,atomic(async(req,res)=>{if(Object.keys(req.query).some(key=>key!=='semester'))fail(400,'Choose a dashboard semester.');const options={};if(req.query.semester!==undefined)options.semester=await semester(req.query.semester);res.json(await teacherDashboard.get(req.user,options));}));
app.put('/api/teacher/semesters',signed,atomic(async(req,res)=>{if(Object.keys(req.body).length!==1||!Object.hasOwn(req.body,'semesters'))fail(400,'Choose your teaching semesters.');res.json(await teacherDashboard.updateSemesters(req.user,req.body.semesters));}));
function credentials(body) {
  const name = text(body.name, 'Name', 80), email = text(body.email, 'Email', 200).toLowerCase(), secret = checkPassword(password(body.password));
  if (!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(email)) fail(400, 'Enter a valid email address.');
  return {
    name,
    email,
    password: secret
  };
}
app.post('/api/setup', authLimiter, authWork(atomic(async (req, res) => {
  if (await get("SELECT id FROM users WHERE role='admin'")) fail(409, 'The administrator account is already set up.');
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !process.env.WEBSITE_SITE_NAME && process.env.NODE_ENV !== 'production';
  if (!local && (!process.env.SETUP_TOKEN || hash(String(req.body.token || '')) !== hash(process.env.SETUP_TOKEN))) fail(403, 'Enter the setup token configured by your site owner.');
  const {name, email, password} = credentials(req.body), id = randomUUID();
  const selected = await semester(req.body.semester ?? (await get('SELECT semester FROM settings WHERE id=1')).semester);
  const stored = await passwordHash(password);
  if (await get("SELECT id FROM users WHERE role='admin'")) fail(409, 'The administrator account is already set up.');
  await run('INSERT INTO users (id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)', id, name, email, stored, 'admin', now(), selected);
  const u = await get('SELECT * FROM users WHERE id=?', id);
  await setSession(req, res, u);
  res.status(201).json(publicUser(u));
})));
app.post('/api/register', authLimiter, authWork(atomic(async (req, res) => {
  if (!await get("SELECT id FROM users WHERE role='admin'")) fail(409, 'The owner must set up the site first.');
  const accounttype=req.body.accountType??'student';if(!['student','teacher'].includes(accounttype))fail(400,'Choose a student or teacher account.');
  const {name, email, password} = credentials(req.body), selected = await semester(req.body.semester??(accounttype==='teacher'?req.body.semesters?.[0]:undefined)), stored = await passwordHash(password);
  if (!await get('SELECT id FROM users WHERE email=?', email)) {
    await recordCapacity('users', 2000);
    const id=randomUUID();await run('INSERT INTO users (id,name,email,password,role,created,semester,accounttype) VALUES(?,?,?,?,?,?,?,?)', id, name, email, stored, 'pending', now(), selected,accounttype);
    if(accounttype==='teacher')await teacherDashboard.updateSemesters({id},req.body.semesters??[selected]);
  }
  res.status(202).json({
    message: 'If registration is available, your account is ready for administrator review. Sign in with your details.'
  });
})));
app.post('/api/login', authLimiter, authWork(atomic(async (req, res) => {
  const portal=req.body.accountType;if(portal!==undefined&&!['student','teacher','admin'].includes(portal))fail(400,'Choose a valid sign-in portal.');
  const email = text(req.body.email, 'Email', 200).toLowerCase(), secret = password(req.body.password), identity = hash(email);
  await run('DELETE FROM auth_failures WHERE reset<?', Date.now());
  const failures = await get('SELECT attempts FROM auth_failures WHERE identity=?', identity);
  if (failures?.attempts >= 10) fail(429, 'Too many sign-in attempts for these details. Try again in 15 minutes.');
  if (!failures && (await get('SELECT COUNT(*) count FROM auth_failures')).count >= 5000) fail(429, 'Sign-in is temporarily limited. Please try again in 15 minutes.');
  const u = await get('SELECT * FROM users WHERE email=?', email), matches = await passwordMatches(secret, u?.password);
  if (!u || !matches || portal&&portal!==publicUser(u).accountType) {
    if ((await get('SELECT COUNT(*) count FROM auth_failures')).count < 5000 || failures) failures ? await run('UPDATE auth_failures SET attempts=attempts+1 WHERE identity=?', identity) : await run('INSERT INTO auth_failures VALUES(?,?,?)', identity, 1, Date.now() + 15 * 60000);
    res.status(401).json({
      error: 'Email or password is incorrect.'
    });
    return;
  }
  if ((await get('SELECT password FROM users WHERE id=?', u.id))?.password !== u.password) fail(401, 'Email or password is incorrect.');
  if (!u.password.startsWith('s2:')) {
    const upgraded = await passwordHash(secret.trim());
    if (!(await run('UPDATE users SET password=? WHERE id=? AND password=?', upgraded, u.id, u.password)).changes) fail(401, 'Email or password is incorrect.');
  }
  await run('DELETE FROM auth_failures WHERE identity=?', identity);
  await setSession(req, res, u);
  res.json(publicUser(u));
})));
app.post('/api/logout', atomic(async (req, res) => {
  const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('classnest_session='))?.slice(18);
  if (token) await run('DELETE FROM sessions WHERE token=?', hash(token));
  res.clearCookie('classnest_session', {
    path: '/'
  });
  res.json({
    ok: true
  });
}));
const resetIpLimiter=requestLimiter(db,'password-recovery-ip',{windowMs:15*60000,limit:5,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many recovery requests. Please try again later.'}});
const resetAddressLimiter=requestLimiter(db,'password-recovery-address',{windowMs:3600000,limit:3,keyGenerator:req=>hash(typeof req.body.email==='string'?req.body.email.trim().toLowerCase():''),standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many recovery requests for these details. Please try again later.'}});
app.post('/api/forgot-password',resetIpLimiter,resetAddressLimiter,async(req,res)=>{
  if(!emailOutbox.enabled)fail(503,'Email recovery is not available yet.');
  const email=text(req.body.email,'Email',200).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid email address.');
  const result=await passwordResets.request(email);scheduleEmailDelivery();res.status(202).json(result);
});
app.post('/api/reset-password',authLimiter,authWork(atomic(async(req,res)=>{
  const result=await passwordResets.consume(req.body.token,checkPassword(password(req.body.password)));
  res.clearCookie('classnest_session',{path:'/',httpOnly:true,sameSite:'lax',secure:production});res.json(result);
})));
app.get('/api/email/preferences',signed,async(req,res)=>res.json({...await emailPreferences.get(req.user.id),available:emailOutbox.enabled}));
app.patch('/api/email/preferences',signed,atomic(async(req,res)=>res.json(await emailPreferences.save(req.user.id,req.body))));
app.post('/api/email/verification',signed,authLimiter,async(req,res)=>{
  if(!emailOutbox.enabled)fail(503,'Email delivery is not available yet.');
  const result=await emailPreferences.requestVerification(req.user.id);scheduleEmailDelivery();res.status(202).json(result);
});
app.post('/api/email/verify',authLimiter,atomic(async(req,res)=>res.json(await emailPreferences.verify(req.body.token))));
app.post('/api/email/unsubscribe',authLimiter,atomic(async(req,res)=>{
  const user=await get('SELECT id,email FROM users WHERE id=?',text(req.body.userId,'Account',100));
  if(!emailOutbox.validUnsubscribe(user,req.body.token))fail(400,'This unsubscribe link is invalid. You can also change email preferences after signing in.');
  await run('UPDATE email_preferences SET notes=0,notices=0,events=0,teacherreminders=0,updated=? WHERE userId=?',Date.now(),user.id);
  res.json({message:'Class notification emails are turned off. You can enable them again in your account.'});
}));
app.post('/api/internal/email-delivery',async(req,res)=>{
  const secret=process.env.EMAIL_CRON_SECRET,provided=req.get('authorization');
  if(!secret||typeof provided!=='string'||!timingSafeEqual(Buffer.from(hash(provided),'hex'),Buffer.from(hash('Bearer '+secret),'hex')))fail(401,'Access denied.');
  if(storage)await db.transaction(cleanExpiredUploads);
  const reminders=await teaching.processDue(),[emailDelivery,pushDelivery]=await Promise.all([emailOutbox.drain({limit:30}),push.drain({limit:200})]);res.json({...emailDelivery,reminders,push:pushDelivery});
});
app.post('/api/password', signed, authLimiter, authWork(atomic(async (req, res) => {
  const old = password(req.body.current, 'Current password'), next = checkPassword(password(req.body.password, 'New password'));
  if (!await passwordMatches(old, req.user.password)) fail(403, 'Current password is incorrect.');
  const stored = await passwordHash(next);
  if ((await get('SELECT password FROM users WHERE id=?', req.user.id))?.password !== req.user.password) fail(409, 'Your account changed. Sign in again before changing the password.');
  await run('UPDATE users SET password=? WHERE id=?', stored, req.user.id);
  await run('DELETE FROM sessions WHERE userId=?', req.user.id);
  await run('DELETE FROM password_resets WHERE userId=?',req.user.id);
  await setSession(req, res, req.user);
  res.json({
    ok: true
  });
})));
app.get('/api/users', admin, async (req, res) => {const profiles=await all('SELECT user_id,semester FROM teacher_semesters ORDER BY semester'),choices=new Map();for(const row of profiles){if(!choices.has(row.user_id))choices.set(row.user_id,[]);choices.get(row.user_id).push(row.semester);}res.json((await all('SELECT id,name,email,role,created,semester,accounttype FROM users ORDER BY created DESC')).map(u=>({...u,accountType:publicUser(u).accountType,teachingSemesters:choices.get(u.id)||[]})));});
app.patch('/api/users/:id', admin, atomic(async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!u) fail(404, 'Member not found.');
  const hasRole = Object.hasOwn(req.body, 'role'), hasSemester = Object.hasOwn(req.body, 'semester');
  if ((!hasRole && !hasSemester) || Object.keys(req.body).some(key => !['role', 'semester'].includes(key))) fail(400, 'Choose a member role or semester.');
  if (hasRole && u.role === 'admin') fail(400, 'Administrator roles cannot be changed here.');
  if (hasRole && !['member','teacher', 'pending', 'blocked'].includes(req.body.role)) fail(400, 'Invalid member role.');
  const selected = hasSemester ? await semester(req.body.semester) : u.semester;
  const nextRole=hasRole?req.body.role:u.role,accounttype=nextRole==='teacher'?'teacher':nextRole==='member'?'student':u.accounttype||'student';
  await run('UPDATE users SET role=?,semester=?,accounttype=? WHERE id=?',nextRole,selected,accounttype,u.id);
  res.json({
    ok: true
  });
}));
app.patch('/api/settings', admin, atomic(async (req, res) => {
  await run('UPDATE settings SET name=?,institution=?,semester=? WHERE id=1', text(req.body.name, 'Site name', 60), text(req.body.institution, 'Institution', 150), await semester(req.body.semester));
  res.json({
    ok: true
  });
}));
app.post('/api/semesters', admin, atomic(async (req, res) => {
  const id = Number(req.body.id);
  if (!Number.isInteger(id) || id < 1 || id > 30) fail(400, 'Semester number must be between 1 and 30.');
  if (await get('SELECT id FROM semesters WHERE id=?', id)) fail(409, 'This semester already exists.');
  await run('INSERT INTO semesters VALUES(?,?)', id, text(req.body.name, 'Semester name', 60));
  res.status(201).json({
    id
  });
}));
app.post('/api/subjects', admin, atomic(async (req, res) => {
  await recordCapacity('subjects', 300);
  const id = randomUUID();
  await run('INSERT INTO subjects VALUES(?,?,?,?,?,?)', id, await semester(req.body.semester), text(req.body.name, 'Subject name', 100), optional(req.body.code, 30), optional(req.body.description, 300), ['sage', 'blue', 'peach', 'lavender'].includes(req.body.color) ? req.body.color : 'sage');
  res.status(201).json({
    id
  });
}));
app.patch('/api/subjects/:id', admin, atomic(async (req, res) => {
  if (!await get('SELECT id FROM subjects WHERE id=?', req.params.id)) fail(404, 'Subject not found.');
  await run('UPDATE subjects SET name=?,code=?,description=? WHERE id=?', text(req.body.name, 'Subject name', 100), optional(req.body.code, 30), optional(req.body.description, 300), req.params.id);
  res.json({
    ok: true
  });
}));
app.delete('/api/subjects/:id', admin, atomic(async (req, res) => {
  const files = await all('SELECT filename FROM notes WHERE subjectId=?', req.params.id);
  await run('DELETE FROM subjects WHERE id=?', req.params.id);
  req.afterCommit.push(async()=>{for (const f of files) await removeFile(f.filename);});
  res.json({
    ok: true
  });
}));
function attachmentPath(name) {
  if (!name || name !== path.basename(name) || !(/^[-a-f0-9]{36}\.(pdf|txt|md|docx|pptx|xlsx|png|jpg|jpeg|webp|gif|bmp|avif|heic|heif|tif|tiff)$/).test(name)) fail(404, 'Attachment not found.');
  return path.join(dataDir, 'uploads', name);
}
async function removeFile(name) {
  if (!name) return;
  if(await get('SELECT id FROM notes WHERE filename=?',name)||await get('SELECT notice_id FROM notice_attachments WHERE filename=?',name))return;
  if(storage)return storage.delete(name);
  const file = attachmentPath(name);
  if (existsSync(file)) unlinkSync(file);
  if (uploadSizes.has(name)) {
    uploadBytesOnDisk -= uploadSizes.get(name);
    uploadSizes.delete(name);
  }
}
const allowed = new Set(['.pdf', '.txt', '.md', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.webp']);
const maxUpload = 20 * 1024 * 1024, maxUploadStorage = 700 * 1024 * 1024;
async function cleanExpiredUploads(){
  const notices=await all('SELECT ticket_id,filename FROM notice_uploads WHERE expires<? ORDER BY expires LIMIT 8',Date.now());
  for(const ticket of notices){await storage.deleteStaged(ticket.filename);if(!await get('SELECT id FROM notes WHERE filename=?',ticket.filename)&&!await get('SELECT notice_id FROM notice_attachments WHERE filename=?',ticket.filename))await storage.delete(ticket.filename);await run('DELETE FROM upload_tickets WHERE id=?',ticket.ticket_id);await run('DELETE FROM notice_uploads WHERE ticket_id=?',ticket.ticket_id);}
  const expired=await all('SELECT * FROM upload_tickets WHERE expires<? ORDER BY expires LIMIT 8',Date.now());
  for(const ticket of expired){
    await storage.deleteStaged(ticket.filename);
    if(!await get('SELECT id FROM notes WHERE filename=?',ticket.filename)&&!await get('SELECT notice_id FROM notice_attachments WHERE filename=?',ticket.filename))await storage.delete(ticket.filename);
    await run('DELETE FROM upload_tickets WHERE id=?',ticket.id);
  }
}
async function cloudCapacity(){
  const used=(await get('SELECT COALESCE((SELECT SUM(size) FROM notes),0)+COALESCE((SELECT SUM(size) FROM notice_attachments),0) total')).total;
  const reservations=(await get('SELECT COUNT(*) count FROM upload_tickets')).count;
  return used+reservations*maxUpload;
}
app.post('/api/uploads',member,atomic(async(req,res)=>{
  if(!storage)fail(409,'Direct uploads are not enabled here.');
  await cleanExpiredUploads();
  const name=originalName({originalname:text(req.body.name,'Attachment filename',200)});
  const purpose=req.body.purpose??'note';if(!['note','notice'].includes(purpose))fail(400,'Choose a valid attachment purpose.');if(purpose==='notice'&&!['admin','teacher'].includes(req.user.role))fail(403,'Only approved teachers and administrators can attach files to announcements.');
  const ext=path.extname(name).toLowerCase(),size=Number(req.body.size);
  if(purpose==='notice'?!Object.hasOwn(noticeAttachmentTypes,ext.slice(1)):!allowed.has(ext))fail(400,'Use a supported attachment type.');
  if(!Number.isSafeInteger(size)||size<1||size>maxUpload)fail(400,'Files must be between 1 byte and 20 MB.');
  if(await get("SELECT id FROM upload_tickets WHERE userId=? AND status='pending'",req.user.id)||(await get("SELECT COUNT(*) count FROM upload_tickets WHERE status='pending'")).count>=3)fail(429,'An upload is already in progress. Please try again shortly.');
  if(await cloudCapacity()+maxUpload>maxUploadStorage)fail(413,'Attachment storage is full or reserved by recent uploads. Try later or remove unused files.');
  const id=randomUUID(),filename=id+ext;
  const expires=Date.now()+2*3600000+15*60000;
  await run('INSERT INTO upload_tickets VALUES(?,?,?,?,?,?,?,?,?)',id,req.user.id,filename,name,purpose==='notice'?noticeAttachmentTypes[ext.slice(1)]:mimeTypes[ext],size,Date.now(),expires,'pending');
  if(purpose==='notice')await run('INSERT INTO notice_uploads(ticket_id,filename,expires) VALUES(?,?,?)',id,filename,expires);
  const signed=await storage.createSignedUpload(filename);
  res.status(201).json({id,...signed});
}));
app.delete('/api/uploads/:id',member,atomic(async(req,res)=>{
  if(!storage)fail(404,'Upload not found.');
  const ticket=await get('SELECT * FROM upload_tickets WHERE id=? AND userId=?',req.params.id,req.user.id);
  if(!ticket)fail(404,'Upload not found.');
  if(ticket.status==='pending'){
    await run("UPDATE upload_tickets SET status='rejected' WHERE id=?",ticket.id);
    req.afterCommit.push(async()=>{await storage.deleteStaged(ticket.filename);if(!await get('SELECT id FROM notes WHERE filename=?',ticket.filename)&&!await get('SELECT notice_id FROM notice_attachments WHERE filename=?',ticket.filename))await storage.delete(ticket.filename);});
  }
  res.json({ok:true});
}));
async function saveCloudNote(req,res,{subject,title,content}){
  let ticket,mime=null,bytes;
  if(req.body.uploadId){
    ticket=await get("SELECT * FROM upload_tickets WHERE id=? AND userId=? AND status='pending' AND expires>?",text(req.body.uploadId,'Upload',100),req.user.id,Date.now());
    if(!ticket)fail(409,'This upload is unavailable. Select the file again.');
    if(await get('SELECT ticket_id FROM notice_uploads WHERE ticket_id=?',ticket.id))fail(409,'Use this upload in its notice, or select a new note attachment.');
    // The signed URL only addresses staged/. Moving first makes validation immutable.
    bytes=await storage.sealUpload(ticket.filename);
    if(bytes.length!==ticket.size)fail(400,'The uploaded file size changed. Select the file again.');
    mime=await verifyAttachment({filename:ticket.filename,buffer:bytes});
    if(await cloudCapacity()+bytes.length>maxUploadStorage)fail(413,'The attachment storage limit has been reached.');
  }
  if(!ticket&&!content)fail(400,'Write a note or attach a file.');
  await recordCapacity('notes',5000,content);
  const id=randomUUID();
  await run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)',id,subject,title,content,ticket?.filename||null,ticket?.originalName||null,mime,bytes?.length||0,req.user.id,now());
  if(ticket)await run("UPDATE upload_tickets SET status='complete' WHERE id=?",ticket.id);
  await announceSharedNote(req,{id,subject,title});
  res.status(201).json({id});
}
let reservedUploads = 0;
const activeUploadUsers = new Set();
async function uploadReservation(req, res, next) {
  const amount = Math.min(maxUpload, Number(req.get('content-length')) || maxUpload), used = Math.max(uploadBytesOnDisk, (await get('SELECT COALESCE((SELECT SUM(size) FROM notes),0)+COALESCE((SELECT SUM(size) FROM notice_attachments),0) total')).total);
  if (activeUploadUsers.has(req.user.id) || activeUploadUsers.size >= 3) return res.status(429).json({
    error: 'An upload is already in progress. Please try again shortly.'
  });
  if (used + reservedUploads + amount > maxUploadStorage) return res.status(413).json({
    error: 'The upload storage limit has been reached. Remove unused files first.'
  });
  reservedUploads += amount;
  activeUploadUsers.add(req.user.id);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reservedUploads -= amount;
    activeUploadUsers.delete(req.user.id);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}
function originalName(file) {
  const name = file.originalname.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!name || name.length > 200 || name.includes(':')) fail(400, 'Use a simple attachment filename of 200 characters or fewer.');
  return name;
}
const mimeTypes = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
async function verifyAttachment(file) {
  const data = file.buffer||await readFile(file.path), ext = path.extname(file.filename);
  let valid = false;
  if (ext === '.pdf') valid = data.subarray(0, 5).toString() === '%PDF-';
  if (ext === '.png') valid = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.jpg' || ext === '.jpeg') valid = data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (ext === '.webp') valid = data.length > 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (ext === '.txt' || ext === '.md') {
    try {
      const decoded = new TextDecoder('utf-8', {
        fatal: true
      }).decode(data);
      valid = data.length > 0 && !(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/).test(decoded);
    } catch {
      valid = false;
    }
  }
  if (['.docx', '.pptx', '.xlsx'].includes(ext)) {
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
    if (end >= 0 && end + 22 + data.readUInt16LE(end + 20) === data.length && data.readUInt16LE(end + 4) === 0 && data.readUInt16LE(end + 6) === 0) {
      const count = data.readUInt16LE(end + 10), directorySize = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
      let pos = start, total = 0;
      const names = new Set();
      valid = count > 0 && count <= 2000 && start + directorySize === end && data.readUInt16LE(end + 8) === count && data.readUInt32LE(0) === 0x04034b50;
      for (let i = 0; valid && i < count; i++) {
        if (pos + 46 > end || data.readUInt32LE(pos) !== 0x02014b50) {
          valid = false;
          break;
        }
        const flags = data.readUInt16LE(pos + 8), compression = data.readUInt16LE(pos + 10), compressed = data.readUInt32LE(pos + 20), expanded = data.readUInt32LE(pos + 24), length = data.readUInt16LE(pos + 28), extra = data.readUInt16LE(pos + 30), comment = data.readUInt16LE(pos + 32), local = data.readUInt32LE(pos + 42);
        if (pos + 46 + length + extra + comment > end || local + 30 > start || data.readUInt32LE(local) !== 0x04034b50) {
          valid = false;
          break;
        }
        const name = data.subarray(pos + 46, pos + 46 + length).toString('utf8'), localLength = data.readUInt16LE(local + 26), localExtra = data.readUInt16LE(local + 28), dataStart = local + 30 + localLength + localExtra;
        total += expanded;
        if (flags & 0x41 || ![0, 8].includes(compression) || total > 100 * 1024 * 1024 || data.readUInt16LE(pos + 34) !== 0 || name.includes('..') || name.includes('\\') || name.startsWith('/') || (/vbaproject|vbadata/i).test(name) || names.has(name) || dataStart + compressed > start || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== compression || data.subarray(local + 30, local + 30 + localLength).toString('utf8') !== name || !(flags & 8) && (data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== expanded)) valid = false;
        names.add(name);
        pos += 46 + length + extra + comment;
      }
      const expected = ({
        '.docx': 'word/document.xml',
        '.pptx': 'ppt/presentation.xml',
        '.xlsx': 'xl/workbook.xml'
      })[ext];
      valid = valid && pos === end && names.has('[Content_Types].xml') && names.has(expected);
    }
  }
  if (!valid) fail(400, 'The attachment contents do not match a supported file type. Use a genuine PDF, Office document, image, or UTF-8 text file.');
  return mimeTypes[ext];
}
const upload = cloudStorage?null:multer({
  storage: multer.diskStorage({
    destination: path.join(dataDir, 'uploads'),
    filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).toLowerCase())
  }),
  limits: {
    fileSize: maxUpload,
    files: 1,
    fields: 4,
    parts: 5,
    fieldSize: 160000,
    fieldNameSize: 50
  },
  fileFilter: (req, file, cb) => {
    try {
      originalName(file);
      if (!allowed.has(path.extname(file.originalname).toLowerCase())) fail(400, 'Use PDF, text, Office documents, or an image.');
      cb(null, true);
    } catch (e) {
      cb(e);
    }
  }
});
const noticeUpload=cloudStorage?null:multer({storage:multer.diskStorage({destination:path.join(dataDir,'uploads'),filename:(req,file,cb)=>cb(null,randomUUID()+path.extname(file.originalname).toLowerCase())}),limits:{fileSize:maxUpload,files:1,fields:5,parts:6,fieldSize:10000,fieldNameSize:50},fileFilter:(req,file,cb)=>{try{originalName(file);if(!Object.hasOwn(noticeAttachmentTypes,path.extname(file.originalname).slice(1).toLowerCase()))fail(400,'Use a PDF or supported photo for a notice.');cb(null,true);}catch(error){cb(error);}}});
app.post('/api/notes', member,(req,res,next)=>{
  if(cloudStorage){if(req.is('multipart/form-data'))return res.status(400).json({error:'Upload the attachment first, then submit the note.'});return next();}
  return uploadReservation(req,res,()=>upload.single('file')(req,res,next));
},atomic(async (req, res, next) => {
  try {
    if (req.file) {
      uploadSizes.set(req.file.filename, req.file.size);
      uploadBytesOnDisk += req.file.size;
    }
    const subject = text(req.body.subjectId, 'Subject', 100);
    const selectedSubject=await get('SELECT id,semester FROM subjects WHERE id=?', subject);
    if (!selectedSubject) fail(404, 'Subject not found.');
    await checkSemesterAccess(req,selectedSubject.semester);
    const title = text(req.body.title, 'Note title', 150), content = optional(req.body.content, 150000);
    if(cloudStorage)return await saveCloudNote(req,res,{subject,title,content});
    if (!req.file && !content) fail(400, 'Write a note or attach a file.');
    const mime = req.file ? await verifyAttachment(req.file) : null;
    if (!['admin', 'member','teacher'].includes((await get('SELECT role FROM users WHERE id=?', req.user.id))?.role)) fail(403, 'Posting access was revoked.');
    if (!await get('SELECT id FROM subjects WHERE id=?', subject)) fail(404, 'Subject not found.');
    const total = Math.max(uploadBytesOnDisk, (await get('SELECT COALESCE((SELECT SUM(size) FROM notes),0)+COALESCE((SELECT SUM(size) FROM notice_attachments),0) total')).total + (req.file?.size || 0));
    if (total > maxUploadStorage) fail(413, 'The upload storage limit has been reached. Remove unused files first.');
    await recordCapacity('notes', 5000, content);
    const id = randomUUID();
    await run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)', id, subject, title, content, req.file?.filename || null, req.file ? originalName(req.file) : null, mime, req.file?.size || 0, req.user.id, now());
    await announceSharedNote(req,{id,subject,title});
    res.status(201).json({
      id
    });
  } catch (e) {
    await removeFile(req.file?.filename);
    next(e);
  }
}));
app.get('/api/my-notes',member,atomic(async(req,res)=>{
  const scope=(await readerSemesters(req)).map(row=>row.id);
  res.json(await all('SELECT n.id,n.subjectId,n.title,n.content,n.originalName,n.mime,n.size,n.authorId,n.created,s.name subjectName,s.semester FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.authorId=? AND s.semester IN('+scope.map(()=>'?').join(',')+') ORDER BY n.created DESC',req.user.id,...scope));
}));
app.put('/api/notes/:id',member,atomic(async(req,res)=>{
  if(Object.keys(req.body).some(key=>!['title','content','subjectId'].includes(key)))fail(400,'Send the note title, content and subject.');
  const note=await get('SELECT n.*,s.semester FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.id=?',req.params.id);
  if(!note)fail(404,'Note not found.');
  await checkSemesterAccess(req,note.semester);
  if(req.user.role!=='admin'&&note.authorId!==req.user.id)fail(403,'You can only edit your own notes.');
  const subject=text(req.body.subjectId,'Subject',100),title=text(req.body.title,'Note title',150),content=optional(req.body.content,150000);
  const selectedSubject=await get('SELECT id,semester FROM subjects WHERE id=?',subject);if(!selectedSubject)fail(404,'Subject not found.');
  await checkSemesterAccess(req,selectedSubject.semester);
  if(!note.filename&&!content)fail(400,'Write a note or keep an existing attachment.');
  // Reuse the workspace text bound without counting this existing note twice.
  const increase=Math.max(0,Buffer.byteLength(content,db.provider==='azure-sql'?'utf16le':'utf8')-Buffer.byteLength(note.content,db.provider==='azure-sql'?'utf16le':'utf8'));
  if(increase){const used=(await get("SELECT COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM notes),0)+COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM notices),0)+COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM threads),0)+COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM replies),0) bytes")).bytes;if(used+increase>64*1024*1024)fail(413,'The workspace text storage limit has been reached.');}
  await run('UPDATE notes SET subjectId=?,title=?,content=? WHERE id=?',subject,title,content,note.id);
  res.json({ok:true,id:note.id});
}));
app.get('/api/notes/:id/preview', async (req,res) => {
  const note=await noteForReader(req,req.params.id);
  if(!note?.filename)fail(404,'Attachment not found.');
  const previewTypes={'application/pdf':'application/pdf','image/png':'image/png','image/jpeg':'image/jpeg','image/webp':'image/webp','text/plain':'text/plain; charset=utf-8','text/markdown':'text/plain; charset=utf-8'};
  const contentType=previewTypes[note.mime];
  if(!contentType)fail(415,'This file type cannot be previewed here. Download the attachment to open it.');
  if(!Number.isSafeInteger(note.size)||note.size<1||note.size>maxUpload)fail(413,'This attachment is too large to preview.');
  let bytes;
  if(storage)bytes=await storage.read(note.filename);
  else{
    const target=attachmentPath(note.filename);
    let details;try{details=statSync(target);}catch{fail(404,'Attachment not found.');}
    if(!details.isFile()||details.size!==note.size||details.size>maxUpload)fail(409,'The attachment changed. Please try again later.');
    bytes=await readFile(target);
  }
  if(bytes.length!==note.size||bytes.length>maxUpload)fail(409,'The attachment changed. Please try again later.');
  const verifiedType=await verifyAttachment({filename:note.filename,buffer:bytes});
  if(verifiedType!==note.mime)fail(415,'This attachment cannot be previewed safely. Download it instead.');
  res.set({'Content-Type':contentType,'Content-Length':String(bytes.length),'Content-Disposition':'inline','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; frame-ancestors 'none'"});
  res.flushHeaders();
  async function* chunks(){for(let offset=0;offset<bytes.length;offset+=65536)yield bytes.subarray(offset,offset+65536);}
  await pipeline(Readable.from(chunks()),res);
});
app.get('/api/notes/:id/download', async (req, res, next) => {
  const note = await noteForReader(req,req.params.id);
  if (!note?.filename) fail(404, 'Attachment not found.');
  if(storage)return res.redirect(302,await storage.signedDownload(note.filename,note.originalName));
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/octet-stream',
    'Content-Security-Policy': "sandbox; default-src 'none'"
  });
  res.download(attachmentPath(note.filename), note.originalName, err => {
    if (err && !res.headersSent) next(err);
  });
});
app.delete('/api/notes/:id', member, atomic(async (req, res) => {
  const n = await get('SELECT n.*,s.semester FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.id=?', req.params.id);
  if (!n) fail(404, 'Note not found.');
  await checkSemesterAccess(req,n.semester);
  if (req.user.role !== 'admin' && n.authorId !== req.user.id) fail(403, 'You can only delete your own notes.');
  await run('DELETE FROM notes WHERE id=?', n.id);
  req.afterCommit.push(()=>removeFile(n.filename));
  res.json({
    ok: true
  });
}));
app.post('/api/notices',noticePublisher,(req,res,next)=>{
  if(cloudStorage){if(req.is('multipart/form-data'))return res.status(400).json({error:'Upload the attachment first, then submit the notice.'});return next();}
  if(!req.is('multipart/form-data'))return next();
  return uploadReservation(req,res,()=>noticeUpload.single('file')(req,res,next));
},atomic(async (req, res) => {
  if(Object.keys(req.body).some(key=>!['semester','title','category','content','pinned','uploadId'].includes(key)))fail(400,'Send the notice details and its attachment.');
  const id=randomUUID(),category=text(req.body.category,'Category',30),content=optional(req.body.content,10000),title=text(req.body.title,'Title',150),selected=await semester(req.body.semester);
  if(!['admin','teacher'].includes(req.user.role))fail(403,'Announcement publishing access was revoked.');
  await checkSemesterAccess(req,selected);
  if (!['General', 'Exam', 'Deadline', 'Event'].includes(category)) fail(400, 'Invalid category.');
  if(req.is('multipart/form-data')&&['true','false'].includes(req.body.pinned))req.body.pinned=req.body.pinned==='true';
  if (req.body.pinned !== undefined && typeof req.body.pinned !== 'boolean') fail(400, 'Pinned must be true or false.');
  let attachment;
  if(storage&&req.body.uploadId){
    const ticket=await get("SELECT * FROM upload_tickets WHERE id=? AND userId=? AND status='pending' AND expires>?",text(req.body.uploadId,'Upload',100),req.user.id,Date.now());
    if(!ticket||!await get('SELECT ticket_id FROM notice_uploads WHERE ticket_id=? AND filename=?',ticket.id,ticket.filename))fail(409,'This notice upload is unavailable. Select the file again.');
    const bytes=await storage.sealUpload(ticket.filename);if(bytes.length!==ticket.size)fail(400,'The uploaded file size changed. Select it again.');
    const checked=verifyNoticeFile({filename:ticket.filename,buffer:bytes});if(await cloudCapacity()+bytes.length>maxUploadStorage)fail(413,'The shared attachment storage limit has been reached.');
    attachment={filename:ticket.filename,original_name:ticket.originalName,mime:checked.mime,size:bytes.length};
    // Older deployments clean core tickets using note references only. Hold the
    // completed ticket until the notice-aware worker reaches its real expiry.
    await run("UPDATE upload_tickets SET status='complete',expires=? WHERE id=?",Number.MAX_SAFE_INTEGER,ticket.id);
  }else if(req.file){
    uploadSizes.set(req.file.filename,req.file.size);uploadBytesOnDisk+=req.file.size;
    const bytes=await readFile(req.file.path),checked=verifyNoticeFile({filename:req.file.filename,buffer:bytes});
    const used=(await get('SELECT COALESCE((SELECT SUM(size) FROM notes),0)+COALESCE((SELECT SUM(size) FROM notice_attachments),0) total')).total;
    if(Math.max(uploadBytesOnDisk,used+bytes.length)>maxUploadStorage)fail(413,'The shared attachment storage limit has been reached.');
    attachment={filename:req.file.filename,original_name:originalName(req.file),mime:checked.mime,size:bytes.length};
  }else if(req.body.uploadId)fail(400,'This attachment upload is unavailable. Select the file again.');
  if(!content&&!attachment)fail(400,'Write a notice or attach a PDF or photo.');
  await recordCapacity('notices', 1000, content);
  await run('INSERT INTO notices (id,semester,title,content,category,pinned,authorId,created) VALUES(?,?,?,?,?,?,?,?)',id,selected,title,content,category,req.body.pinned?1:0,req.user.id,now());
  if(attachment)await noticeFiles.attach(id,attachment);
  const {notified}=await teaching.notifyNotice({id,semester:selected,title,authorId:req.user.id});req.afterCommit.push(scheduleEmailDelivery);
  res.status(201).json({
    id,notified
  });
}));
app.get('/api/notices/:id/preview',async(req,res)=>{
  const file=await noticeFileForReader(req,req.params.id);if(!file)fail(404,'Notice attachment not found.');
  if(!['application/pdf','image/png','image/jpeg','image/webp','image/gif','image/bmp','image/avif'].includes(file.mime))fail(415,'Download this photo to open it in a compatible photo app.');
  let bytes;if(storage)bytes=await storage.read(file.filename);else{const target=attachmentPath(file.filename);let details;try{details=statSync(target);}catch{fail(404,'Attachment not found.');}if(!details.isFile()||details.size!==file.size||details.size>maxUpload)fail(409,'The attachment changed.');bytes=await readFile(target);}
  if(bytes.length!==file.size)fail(409,'The attachment changed.');
  const checked=verifyNoticeFile({filename:file.filename,buffer:bytes});if(checked.mime!==file.mime)fail(415,'This attachment cannot be previewed.');
  if(checked.width*checked.height>16000000||checked.width>12000||checked.height>12000)fail(415,'This photo is too large for an in-app preview. Download the original to view it.');
  res.set({'Content-Type':file.mime,'Content-Length':String(bytes.length),'Content-Disposition':'inline','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; frame-ancestors 'none'"});res.flushHeaders();
  async function* chunks(){for(let offset=0;offset<bytes.length;offset+=65536)yield bytes.subarray(offset,offset+65536);}await pipeline(Readable.from(chunks()),res);
});
app.get('/api/notices/:id/download',async(req,res,next)=>{
  const file=await noticeFileForReader(req,req.params.id);if(!file)fail(404,'Notice attachment not found.');
  if(storage)return res.redirect(302,await storage.signedDownload(file.filename,file.original_name));
  res.set({'X-Content-Type-Options':'nosniff','Content-Type':'application/octet-stream','Content-Security-Policy':"sandbox; default-src 'none'"});res.download(attachmentPath(file.filename),file.original_name,error=>{if(error&&!res.headersSent)next(error);});
});
async function noticeForWriter(req,id){
  if(!['admin','teacher'].includes(req.user.role))fail(403,'Announcement publishing access was revoked.');
  const notice=await get('SELECT * FROM notices WHERE id=?',id);
  if(!notice)fail(404,'Announcement not found.');
  await checkSemesterAccess(req,notice.semester);
  if(req.user.role!=='admin'&&notice.authorId!==req.user.id)fail(403,'You can only edit or delete your own announcements.');
  return notice;
}
app.patch('/api/notices/:id', noticePublisher, atomic(async (req, res) => {
  const notice=await noticeForWriter(req,req.params.id),keys=Object.keys(req.body);
  if(!keys.length||keys.some(key=>!['title','content','category','pinned'].includes(key)))fail(400,'Edit the announcement title, message, category, or pin.');
  const title=req.body.title===undefined?notice.title:text(req.body.title,'Title',150),content=req.body.content===undefined?notice.content:optional(req.body.content,10000),category=req.body.category===undefined?notice.category:text(req.body.category,'Category',30);
  if(!['General','Exam','Deadline','Event'].includes(category))fail(400,'Invalid category.');
  if(req.body.pinned!==undefined&&typeof req.body.pinned!=='boolean')fail(400,'Pinned must be true or false.');
  if(!content&&!await noticeFiles.get(notice.id))fail(400,'Write an announcement or retain its PDF or photo.');
  await recordCapacity('notices',1001,content,notice.content);
  await run('UPDATE notices SET title=?,content=?,category=?,pinned=? WHERE id=?',title,content,category,req.body.pinned===undefined?notice.pinned:Number(req.body.pinned),notice.id);
  res.json({
    ok: true
  });
}));
app.delete('/api/notices/:id', noticePublisher, atomic(async (req, res) => {
  await noticeForWriter(req,req.params.id);
  const attachment=await noticeFiles.get(req.params.id);
  await run('DELETE FROM notices WHERE id=?', req.params.id);
  if(attachment)req.afterCommit.push(()=>removeFile(attachment.filename));
  res.json({
    ok: true
  });
}));
app.post('/api/threads', member, atomic(async (req, res) => {
  const selected = await semester(req.body.semester);
  if (!canDiscuss(req.user, selected)) fail(403, 'You can only join discussions for your assigned semester.');
  const id = randomUUID(), content = text(req.body.content, 'Question', 10000);
  await recordCapacity('threads', 2000, content);
  await run('INSERT INTO threads VALUES(?,?,?,?,?,?)', id, selected, text(req.body.title, 'Title', 150), content, req.user.id, now());
  res.status(201).json({
    id
  });
}));
app.get('/api/threads/:id/replies', member, async (req, res) => {
  const replies = await db.transaction(async () => {
    await currentDiscussionMember(req);
    await discussionThread(req, req.params.id);
    return all('SELECT r.*,u.name author FROM replies r LEFT JOIN users u ON u.id=r.authorId WHERE threadId=? ORDER BY r.created', req.params.id);
  });
  return sendJson(res, replies);
});
app.post('/api/threads/:id/replies', member, atomic(async (req, res) => {
  await discussionThread(req, req.params.id);
  const content = text(req.body.content, 'Reply', 10000);
  await recordCapacity('replies', 10000, content);
  await run('INSERT INTO replies VALUES(?,?,?,?,?)', randomUUID(), req.params.id, content, req.user.id, now());
  res.status(201).json({
    ok: true
  });
}));
app.delete('/api/threads/:id', member, atomic(async (req, res) => {
  const t = await discussionThread(req, req.params.id);
  if (req.user.role !== 'admin' && t.authorId !== req.user.id) fail(403, 'You can only delete your own discussions.');
  await run('DELETE FROM threads WHERE id=?', t.id);
  res.json({
    ok: true
  });
}));
app.post('/api/events', admin, atomic(async (req, res) => {
  const id = randomUUID(), date = text(req.body.date, 'Date', 30), kind = text(req.body.kind, 'Type', 30);
  if (!(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).test(date) || Number.isNaN(Date.parse(date + 'Z')) || new Date(date + 'Z').toISOString().slice(0, 16) !== date) fail(400, 'Choose a valid date and time.');
  if (!['Class', 'Assignment', 'Exam', 'Event'].includes(kind)) fail(400, 'Invalid event type.');
  await recordCapacity('events', 2000);
  await run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', id, await semester(req.body.semester), text(req.body.title, 'Title', 150), optional(req.body.description, 2000), date, kind, optional(req.body.location, 150), req.user.id);
  await queueClassEmails(req,'events',Number(req.body.semester),text(req.body.title,'Title',150),kind+' · '+date.replace('T',' ')+' (Nepal time)\n'+optional(req.body.location,150)+'\n\n'+optional(req.body.description,2000),'/#schedule');
  res.status(201).json({
    id
  });
}));
app.delete('/api/events/:id', admin, atomic(async (req, res) => {
  await run('DELETE FROM events WHERE id=?', req.params.id);
  res.json({
    ok: true
  });
}));
const backupLimiter = requestLimiter(db,'backup',{
  windowMs: 15 * 60000,
  limit: 5,
  keyGenerator: req => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Please wait before requesting another database backup.'
  }
});
app.get('/api/backup', admin, backupLimiter, async (req, res, next) => {
  if(db.provider!=='sqlite'){res.attachment('classnest-backup.json');return sendJson(res,await db.exportRows());}
  const snapshot = path.join(dataDir, `backup-${randomUUID()}.sqlite`);
  await db.backup(snapshot);
  res.download(snapshot, 'classnest-backup.sqlite', err => {
    if (existsSync(snapshot)) unlinkSync(snapshot);
    if (err && !res.headersSent) next(err);
  });
});
app.get('/api/ready', async (req,res)=>{await get('SELECT 1 healthy');res.json({ok:true});});
app.get('/api/health', (req, res) => res.json({
  ok: true
}));
app.use('/api', (req, res) => res.status(404).json({
  error: 'This API route does not exist.'
}));
app.use((req,res,next)=>{
  if(req.path==='/service-worker.js')res.set({'Cache-Control':'no-cache','Service-Worker-Allowed':'/','Content-Type':'application/javascript; charset=utf-8'});
  if(req.path==='/manifest.webmanifest')res.set({'Cache-Control':'no-cache','Content-Type':'application/manifest+json; charset=utf-8'});
  next();
});
app.use(express.static(path.join(root, 'public'), {
  index: 'index.html'
}));
app.use(async(err, req, res, next) => {
  if (req.file&&!req.uploadCommitUncertain) await removeFile(req.file.filename).catch(()=>{});
  if (res.headersSent) return next(err);
  const multipart = err instanceof multer.MulterError;
  const sqlNumbers=[err.number,err.originalError?.number,err.originalError?.info?.number];
  const unavailable=db.provider==='azure-sql'&&(sqlNumbers.some(n=>[40613,40501,10928,10929,49918,49919,49920,42108,42109].includes(n))||['ETIMEOUT','ESOCKET','ECONNCLOSED','ENOTOPEN'].includes(err.code));
  const status = unavailable?503:multipart ? 400 : Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  let message = status < 500 ? err.message : 'Something went wrong. Please try again.';
  if (err.type === 'entity.parse.failed') message = 'Invalid JSON request.';
  if (err.type === 'entity.too.large') message = 'The request is too large.';
  if (multipart) message = err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 20 MB or smaller.' : 'The upload has too many or invalid fields. Use one attachment per note.';
  if(unavailable){message='The workspace database is waking up or temporarily unavailable. Please try again shortly.';res.set('Retry-After','15');}
  res.status(status).json({
    error: message
  });
  if (status >= 500) console.error('Request failed:', err.code || err.name);
});
const port = Number(process.env.PORT || 3000);
if(!process.env.VERCEL)app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Classnest is running at http://localhost:${port}`));
if(!process.env.VERCEL&&process.env.NODE_ENV!=='test')setInterval(()=>teaching.processDue().then(scheduleEmailDelivery).catch(()=>console.error('Class reminder processing failed.')),60000).unref();
export default app;
