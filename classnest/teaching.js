import {createHash,randomUUID} from 'node:crypto';

const DAY=86400000,NEPAL=345*60000,REMINDER=3*60000;
const approved=new Set(['admin','member','teacher']);
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
const assert=(condition,message,status=400)=>{if(!condition)throw failure(message,status);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const dayAt=timestamp=>new Date(timestamp+NEPAL).toISOString().slice(0,10);
const minuteText=value=>String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
const weekday=date=>new Date(date+'T00:00:00Z').getUTCDay()||7;
const startOf=date=>Date.parse(date+'T00:00:00+05:45');
const clean=(value,label,max,{empty=false}={})=>{assert(typeof value==='string',label+' must be text.');const result=value.trim();assert((empty||result.length>0)&&result.length<=max,label+' must contain '+(empty?'at most ':'1 to ')+max+' characters.');return result;};
const object=(value,keys)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key)),'Send the expected teaching fields.');
const minute=(value,label)=>{assert(typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value),label+' must use 24-hour HH:MM.');return Number(value.slice(0,2))*60+Number(value.slice(3));};
const expectedRevision=(value,current)=>assert(Number.isInteger(value)&&value>=0&&value<=2147483646&&value===(current?.revision||0),'This timetable changed. Reload the published version before saving.',409);
const publicDaily=row=>row?{semester:row.semester,date:row.class_date,title:row.title,rows:JSON.parse(row.rows_json),revision:row.revision,updated:row.updated}:null;
const publicSlot=row=>({id:row.id,semester:row.semester,teacherId:row.teacher_id,teacherName:row.teacher_name,subjectId:row.subject_id,subjectName:row.subject_name,weekday:row.weekday,start:minuteText(row.start_minute),end:minuteText(row.end_minute),room:row.room,revision:row.revision});
const publicOccurrence=row=>({id:row.id,semester:row.semester,date:row.class_date,teacherId:row.teacher_id,teacherName:row.teacher_name,subjectId:row.subject_id,subjectName:row.subject_name,start:minuteText(row.start_minute),end:minuteText(row.end_minute),startsAt:row.starts_at,endsAt:row.ends_at,room:row.room,response:row.response,eta:row.eta,reason:row.reason,revision:row.revision});
const occurrenceSelect='SELECT c.*,u.name teacher_name,s.name subject_name FROM class_occurrences c JOIN users u ON u.id=c.teacher_id JOIN subjects s ON s.id=c.subject_id';
const slotSelect='SELECT t.*,u.name teacher_name,s.name subject_name FROM teacher_slots t JOIN users u ON u.id=t.teacher_id JOIN subjects s ON s.id=t.subject_id';
const occurrenceKey=({sourceType,sourceId,sourceRevision,date})=>sourceType+':'+sourceId+':'+sourceRevision+':'+date;

/** Durable Nepal-time class occurrences and account notifications. onNotify may
 * enqueue encrypted email inside this transaction; it must not send network mail. */
export function createTeachingService({db,now=Date.now,onNotify=async()=>{}}={}){
  assert(db&&['all','get','run','transaction'].every(name=>typeof db[name]==='function'),'Teaching requires a database.');
  const clock=()=>{const at=now();assert(Number.isSafeInteger(at)&&at>=0,'Invalid teaching clock.',500);return at;};
  async function actor(value,roles=approved){
    const id=typeof value==='string'?value:value?.id;
    assert(typeof id==='string'&&id.length<=100,'Sign in to continue.',401);
    const account=await db.get('SELECT id,name,role,semester FROM users WHERE id=?',id);
    assert(account&&roles.has(account.role),'Your account does not have access to this action.',403);return account;
  }
  async function semesterValue(value){assert(Number.isSafeInteger(value)&&value>0&&await db.get('SELECT id FROM semesters WHERE id=?',value),'Choose an existing semester.');return value;}
  function dateValue(value,{publishing=false}={}){
    assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(startOf(value))&&dayAt(startOf(value))===value,'Choose a valid date.');
    const today=startOf(dayAt(clock())),date=startOf(value);
    assert(date>=today-(publishing?0:7)*DAY&&date<=today+30*DAY,publishing?'Publish a date from today through the next 30 days.':'Choose a date within the past week or next 30 days.');return value;
  }
  async function teachingRow(value,semester){
    object(value,['teacherId','subjectId','start','end','room']);
    const teacherId=clean(value.teacherId,'Teacher',100),subjectId=clean(value.subjectId,'Subject',100);
    const teacher=await db.get("SELECT id,name FROM users WHERE id=? AND role='teacher'",teacherId);
    assert(teacher,'Choose an approved teacher.');
    const subject=await db.get('SELECT id,name,semester FROM subjects WHERE id=?',subjectId);
    assert(subject&&subject.semester===semester,'Choose a subject in this semester.');
    const start=minute(value.start,'Start time'),end=minute(value.end,'End time');assert(end>start,'The end time must follow the start time on the same day.');
    return {teacherId,subjectId,start:minuteText(start),end:minuteText(end),room:clean(value.room??'','Room',120,{empty:true}),teacherName:teacher.name,subjectName:subject.name,startMinute:start,endMinute:end};
  }
  async function prune(at){
    await db.run('DELETE FROM app_notifications WHERE expires_at<=?',at);
    await db.run('DELETE FROM class_occurrences WHERE ends_at<?',at-35*DAY);
    await db.run('DELETE FROM daily_routines WHERE class_date<?',dayAt(at-35*DAY));
    await db.run('DELETE FROM teacher_slots WHERE active=0 AND updated<?',at-35*DAY);
    const count=await db.get('SELECT COUNT(*) count FROM app_notifications');
    if(count.count>18000){const rows=await db.all('SELECT id FROM app_notifications ORDER BY created LIMIT 4000');for(let index=0;index<rows.length;index+=100){const batch=rows.slice(index,index+100).map(row=>row.id);await db.run('DELETE FROM app_notifications WHERE id IN('+batch.map(()=>'?').join(',')+')',...batch);}}
  }
  async function recipients(semester){
    return db.all("SELECT u.id FROM users u WHERE u.role='admin' OR u.role='member' AND u.semester=? OR u.role='teacher' AND (u.semester=? OR EXISTS(SELECT 1 FROM teacher_slots t WHERE t.teacher_id=u.id AND t.semester=? AND t.active=1) OR EXISTS(SELECT 1 FROM class_occurrences c WHERE c.teacher_id=u.id AND c.semester=? AND c.active=1 AND c.ends_at>?)) ORDER BY u.id LIMIT 2000",semester,semester,semester,semester,clock());
  }
  async function readableSemesters(account,at){
    if(account.role==='admin')return null;
    const semesters=new Set([account.semester]);
    if(account.role==='teacher'){
      for(const row of await db.all('SELECT DISTINCT semester FROM teacher_slots WHERE teacher_id=? AND active=1',account.id))semesters.add(row.semester);
      for(const row of await db.all('SELECT DISTINCT semester FROM class_occurrences WHERE teacher_id=? AND active=1 AND ends_at>?',account.id,at))semesters.add(row.semester);
    }
    return semesters;
  }
  async function notification(userId,message){
    const at=clock(),id=digest(userId+'\0'+message.type+'\0'+message.reference);
    if(await db.get('SELECT id FROM app_notifications WHERE id=?',id))return false;
    const count=await db.get('SELECT COUNT(*) count FROM app_notifications WHERE user_id=?',userId);
    if(count.count>=100){const oldest=await db.get('SELECT id FROM app_notifications WHERE user_id=? ORDER BY created LIMIT 1',userId);if(oldest)await db.run('DELETE FROM app_notifications WHERE id=?',oldest.id);}
    const noticeUrl=message.type==='notice'&&typeof message.reference==='string'&&message.url==='#notices/'+encodeURIComponent(message.reference)?message.url:null;
    const n={id,userId,...message,title:clean(message.title,'Notification title',160),body:clean(message.body,'Notification text',600),url:message.url==='#teaching'?'#teaching':noticeUrl||'#home'};
    await db.run('INSERT INTO app_notifications(id,user_id,type,semester,title,body,url,reference,expires_at,created,read_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,userId,n.type,n.semester,n.title,n.body,n.url,n.reference,n.expiresAt,at,null);
    await onNotify(Object.freeze(n));return true;
  }
  async function announce(message,{exclude}={}){let sent=0;for(const user of await recipients(message.semester)){if(user.id!==exclude)sent+=Number(await notification(user.id,message));}return sent;}
  async function insertOccurrence({sourceType,sourceId,sourceRevision,semester,date,row},at,{knownNew=false}={}){
    const sourceKey=occurrenceKey({sourceType,sourceId,sourceRevision,date}),id=digest(sourceKey);
    if(!knownNew&&await db.get('SELECT id FROM class_occurrences WHERE id=?',id))return id;
    const starts=startOf(date)+row.startMinute*60000,ends=startOf(date)+row.endMinute*60000;
    await db.run('INSERT INTO class_occurrences(id,source_key,source_type,source_id,source_revision,semester,class_date,teacher_id,subject_id,start_minute,end_minute,starts_at,ends_at,room,active,response,eta,reason,revision,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,sourceKey,sourceType,sourceId,sourceRevision,semester,date,row.teacherId,row.subjectId,row.startMinute,row.endMinute,starts,ends,row.room,1,'pending','','',1,at);return id;
  }
  async function materialize(semester,date,at,{latest=Infinity}={}){
    if(await db.get('SELECT revision FROM daily_routines WHERE semester=? AND class_date=?',semester,date))return;
    const slots=await db.all(slotSelect+" WHERE t.semester=? AND t.weekday=? AND t.active=1 AND u.role='teacher' AND s.semester=t.semester ORDER BY t.id",semester,weekday(date));
    const existing=new Set((await db.all('SELECT source_key FROM class_occurrences WHERE semester=? AND class_date=?',semester,date)).map(row=>row.source_key));
    for(const slot of slots){if(startOf(date)+slot.start_minute*60000>latest)continue;const key=occurrenceKey({sourceType:'weekly',sourceId:slot.id,sourceRevision:slot.revision,date});if(existing.has(key))continue;await insertOccurrence({sourceType:'weekly',sourceId:slot.id,sourceRevision:slot.revision,semester,date,row:{teacherId:slot.teacher_id,subjectId:slot.subject_id,startMinute:slot.start_minute,endMinute:slot.end_minute,room:slot.room}},at,{knownNew:true});existing.add(key);}
  }
  async function sessions(semester,date){return (await db.all(occurrenceSelect+" WHERE c.semester=? AND c.class_date=? AND c.active=1 AND u.role='teacher' ORDER BY c.starts_at,c.id",semester,date)).map(publicOccurrence);}
  async function state(user,semester,date){return db.transaction(async()=>{
    await semesterValue(semester);date=dateValue(date??dayAt(clock()));const at=clock();await materialize(semester,date,at);
    const daily=await db.get('SELECT * FROM daily_routines WHERE semester=? AND class_date=?',semester,date),classes=await sessions(semester,date);
    // Absence explanations belong to the class's authenticated notifications and
    // teacher/admin workspace. The public timetable never discloses them.
    return {semester,date,today:dayAt(at),source:daily?'daily':classes.length?'weekly':'none',dailyRoutine:publicDaily(daily),sessions:classes.map(row=>({...row,reason:''})),reminderMinutes:3};
  });}
  async function workspace(user,semester,date){return db.transaction(async()=>{
    const account=await actor(user,new Set(['admin','teacher']));await semesterValue(semester);date=dateValue(date??dayAt(clock()));
    const at=clock();for(let i=0;i<3;i++)await materialize(semester,dayAt(at+i*DAY),at,{latest:at+48*3600000});
    const slots=await db.all(slotSelect+" WHERE t.semester=? AND t.active=1 AND u.role='teacher'"+(account.role==='teacher'?' AND t.teacher_id=?':'')+' ORDER BY t.weekday,t.start_minute,t.id',semester,...(account.role==='teacher'?[account.id]:[]));
    const upcoming=await db.all(occurrenceSelect+" WHERE c.semester=? AND c.active=1 AND c.ends_at>? AND c.starts_at<=? AND u.role='teacher'"+(account.role==='teacher'?' AND c.teacher_id=?':'')+' ORDER BY c.starts_at,c.id LIMIT 100',semester,at,at+48*3600000,...(account.role==='teacher'?[account.id]:[]));
    return {semester,date,reminderMinutes:3,teachers:account.role==='admin'?await db.all("SELECT id,name FROM users WHERE role='teacher' ORDER BY name,id LIMIT 1000"):[{id:account.id,name:account.name}],subjects:await db.all('SELECT id,name FROM subjects WHERE semester=? ORDER BY name,id',semester),slots:slots.map(publicSlot),upcoming:upcoming.map(publicOccurrence),dailyRoutine:publicDaily(await db.get('SELECT * FROM daily_routines WHERE semester=? AND class_date=?',semester,date))};
  });}
  async function saveSlot(user,payload,id){return db.transaction(async()=>{
    await actor(user,new Set(['admin']));object(payload,['semester','teacherId','subjectId','weekday','start','end','room','revision']);const semester=await semesterValue(payload.semester);
    assert(Number.isInteger(payload.weekday)&&payload.weekday>=1&&payload.weekday<=7,'Choose a weekday from Monday through Sunday.');
    const current=id?await db.get('SELECT * FROM teacher_slots WHERE id=? AND active=1',clean(id,'Assignment',100)):null;assert(!id||current,'Teacher assignment not found.',404);expectedRevision(payload.revision,current);
    const row=await teachingRow({teacherId:payload.teacherId,subjectId:payload.subjectId,start:payload.start,end:payload.end,room:payload.room},semester);
    const overlapping=await db.all('SELECT id,start_minute,end_minute FROM teacher_slots WHERE teacher_id=? AND weekday=? AND active=1',row.teacherId,payload.weekday);
    assert(!overlapping.some(slot=>slot.id!==id&&slot.start_minute<row.endMinute&&slot.end_minute>row.startMinute),'This teacher already has an overlapping weekly class.');
    const dailyClashes=(await db.all("SELECT class_date,start_minute,end_minute FROM class_occurrences WHERE teacher_id=? AND semester<>? AND source_type='daily' AND active=1 AND ends_at>?",row.teacherId,semester,clock())).filter(value=>weekday(value.class_date)===payload.weekday&&value.start_minute<row.endMinute&&value.end_minute>row.startMinute);
    if(dailyClashes.length){const overridden=new Set((await db.all('SELECT class_date FROM daily_routines WHERE semester=? AND class_date>=?',semester,dayAt(clock()))).map(value=>value.class_date));assert(dailyClashes.every(value=>overridden.has(value.class_date)),'This weekly assignment conflicts with a published daily class in another semester.');}
    if(!current){assert((await db.get('SELECT COUNT(*) count FROM teacher_slots WHERE semester=? AND active=1',semester)).count<100,'This semester has reached 100 weekly assignments.');assert((await db.get('SELECT COUNT(*) count FROM teacher_slots WHERE active=1')).count<1000,'The workspace has reached 1000 active weekly assignments.');}
    const at=clock(),revision=(current?.revision||0)+1;id=current?.id||randomUUID();
    if(current){await db.run('UPDATE teacher_slots SET semester=?,teacher_id=?,subject_id=?,weekday=?,start_minute=?,end_minute=?,room=?,revision=?,updated=? WHERE id=? AND revision=?',semester,row.teacherId,row.subjectId,payload.weekday,row.startMinute,row.endMinute,row.room,revision,at,id,current.revision);await db.run("UPDATE class_occurrences SET active=0 WHERE source_type='weekly' AND source_id=? AND class_date>=?",id,dayAt(at));}
    else await db.run('INSERT INTO teacher_slots(id,semester,teacher_id,subject_id,weekday,start_minute,end_minute,room,revision,active,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,semester,row.teacherId,row.subjectId,payload.weekday,row.startMinute,row.endMinute,row.room,revision,1,at);
    return publicSlot({...await db.get('SELECT * FROM teacher_slots WHERE id=?',id),teacher_name:row.teacherName,subject_name:row.subjectName});
  });}
  async function deleteSlot(user,id,revision){return db.transaction(async()=>{
    await actor(user,new Set(['admin']));const current=await db.get('SELECT * FROM teacher_slots WHERE id=? AND active=1',clean(id,'Assignment',100));assert(current,'Teacher assignment not found.',404);expectedRevision(revision,current);
    await db.run('UPDATE teacher_slots SET active=0,revision=revision+1,updated=? WHERE id=?',clock(),id);await db.run("UPDATE class_occurrences SET active=0 WHERE source_type='weekly' AND source_id=? AND class_date>=?",id,dayAt(clock()));return {ok:true};
  });}
  async function publishDaily(user,payload){return db.transaction(async()=>{
    await actor(user,new Set(['admin']));object(payload,['semester','date','title','rows','revision']);const semester=await semesterValue(payload.semester),date=dateValue(payload.date,{publishing:true}),title=clean(payload.title,'Daily timetable title',80);
    assert(Array.isArray(payload.rows)&&payload.rows.length<=40,'A daily timetable can contain up to 40 classes.');
    const current=await db.get('SELECT * FROM daily_routines WHERE semester=? AND class_date=?',semester,date);expectedRevision(payload.revision,current);
    const rows=[];for(const value of payload.rows)rows.push(await teachingRow(value,semester));
    for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++)assert(rows[i].teacherId!==rows[j].teacherId||rows[i].startMinute>=rows[j].endMinute||rows[i].endMinute<=rows[j].startMinute,'A teacher has overlapping classes in this daily timetable.');
    const at=clock(),otherSemesters=new Set();
    for(const teacherId of new Set(rows.map(row=>row.teacherId)))for(const scope of await db.all('SELECT DISTINCT semester FROM teacher_slots WHERE teacher_id=? AND active=1 AND semester<>?',teacherId,semester))otherSemesters.add(scope.semester);
    for(const scope of otherSemesters)await materialize(scope,date,at);
    for(const row of rows){const other=await db.all('SELECT start_minute,end_minute FROM class_occurrences WHERE teacher_id=? AND semester<>? AND class_date=? AND active=1',row.teacherId,semester,date);assert(!other.some(value=>value.start_minute<row.endMinute&&value.end_minute>row.startMinute),'This teacher has an overlapping class in another semester on this date.');}
    const revision=(current?.revision||0)+1,published=rows.map(({teacherId,subjectId,start,end,room})=>({teacherId,subjectId,start,end,room}));
    if(current)await db.run('UPDATE daily_routines SET title=?,rows_json=?,revision=?,updated=? WHERE semester=? AND class_date=? AND revision=?',title,JSON.stringify(published),revision,at,semester,date,current.revision);
    else await db.run('INSERT INTO daily_routines(semester,class_date,title,rows_json,revision,updated) VALUES(?,?,?,?,?,?)',semester,date,title,JSON.stringify(published),revision,at);
    await db.run('UPDATE class_occurrences SET active=0 WHERE semester=? AND class_date=? AND active=1',semester,date);
    for(let i=0;i<rows.length;i++)await insertOccurrence({sourceType:'daily',sourceId:semester+':'+date+':'+i,sourceRevision:revision,semester,date,row:rows[i]},at);
    await prune(at);await announce({type:'daily-routine',semester,title:'Daily timetable published',body:title+' · '+date+' · '+rows.length+' '+(rows.length===1?'class':'classes')+'. Open Classnest to view the updated day.',url:'#home',reference:'daily:'+semester+':'+date+':'+revision,expiresAt:startOf(date)+2*DAY});
    return publicDaily(await db.get('SELECT * FROM daily_routines WHERE semester=? AND class_date=?',semester,date));
  });}
  async function respond(user,id,payload){return db.transaction(async()=>{
    const account=await actor(user,new Set(['teacher']));object(payload,['response','eta','reason','revision']);id=clean(id,'Class',100);
    const row=await db.get(occurrenceSelect+' WHERE c.id=? AND c.active=1',id);assert(row&&row.teacher_id===account.id,'This class is not assigned to your teacher account.',403);expectedRevision(payload.revision,row);
    const at=clock();assert(row.ends_at>at&&row.starts_at<=at+DAY,'Respond only to an upcoming class within the next 24 hours.');
    assert(['coming','absent'].includes(payload.response),'Choose Yes, coming or No, absent.');
    let eta='',reason='';if(payload.response==='coming'){assert(['1-5','5-10','10+'].includes(payload.eta),'Choose an arrival estimate.');assert(!payload.reason,'A coming response does not need an absence reason.');eta=payload.eta;}
    else{reason=clean(payload.reason,'Absence reason',300);assert(!payload.eta,'An absence response does not need an arrival estimate.');}
    if(row.response===payload.response&&row.eta===eta&&row.reason===reason)return publicOccurrence(row);
    await db.run('UPDATE class_occurrences SET response=?,eta=?,reason=?,revision=revision+1,updated=? WHERE id=? AND revision=?',payload.response,eta,reason,at,id,row.revision);
    const reference=id+':'+(row.revision+1);await prune(at);await announce({type:'class-status',semester:row.semester,title:row.teacher_name+' updated class attendance',body:row.subject_name+' · '+row.class_date+' '+minuteText(row.start_minute)+' · '+(payload.response==='coming'?'Coming in '+eta.replace('-','–')+' minutes.':'Not coming: '+reason),url:'#home',reference,expiresAt:row.ends_at+DAY},{exclude:account.id});
    return publicOccurrence({...row,response:payload.response,eta,reason,revision:row.revision+1,updated:at});
  });}
  async function notifications(user){return db.transaction(async()=>{
    const account=await actor(user),at=clock(),scope=await readableSemesters(account,at),rows=[];
    for(const row of await db.all('SELECT * FROM app_notifications WHERE user_id=? AND expires_at>? ORDER BY created DESC,id DESC LIMIT 100',account.id,at)){
      if(scope&&!scope.has(row.semester))continue;
      if(['teacher-reminder','class-reminder'].includes(row.type)&&!await notificationForDelivery(account.id,row.id))continue;
      rows.push(row);
    }
    return {items:rows.map(row=>({id:row.id,type:row.type,semester:row.semester,title:row.title,body:row.body,url:row.url,reference:row.reference,created:row.created,read:row.read_at!==null})),unread:rows.filter(row=>row.read_at===null).length};
  });}
  async function markRead(user,id){return db.transaction(async()=>{
    const account=await actor(user),at=clock(),scope=await readableSemesters(account,at);
    if(id==='all'){const rows=await db.all('SELECT id,semester FROM app_notifications WHERE user_id=? AND read_at IS NULL AND expires_at>?',account.id,at);for(const row of rows)if(!scope||scope.has(row.semester))await db.run('UPDATE app_notifications SET read_at=? WHERE id=? AND user_id=?',at,row.id,account.id);}
    else{const row=await db.get('SELECT id,semester FROM app_notifications WHERE id=? AND user_id=? AND expires_at>?',clean(id,'Notification',100),account.id,at);assert(row&&(!scope||scope.has(row.semester)),'Notification not found.',404);await db.run('UPDATE app_notifications SET read_at=? WHERE id=? AND user_id=?',at,row.id,account.id);}return {ok:true};
  });}
  async function notifyNote(payload){return db.transaction(async()=>{
    object(payload,['id','subjectId','title','semester','authorId']);const semester=await semesterValue(payload.semester),id=clean(payload.id,'Note',100);
    const note=await db.get('SELECT n.id,n.title,n.authorId,s.semester,u.name FROM notes n JOIN subjects s ON s.id=n.subjectId JOIN users u ON u.id=n.authorId WHERE n.id=?',id);
    assert(note&&note.semester===semester,'Published note not found.',404);await prune(clock());
    return {notified:await announce({type:'note',semester,title:clean(note.title,'Note title',160),body:clean(note.title,'Note title',160)+' · Shared by '+note.name+'. Open your subject library to view it.',url:'#home',reference:id,expiresAt:clock()+14*DAY},{exclude:note.authorId})};
  });}
  async function notifyNotice(payload){return db.transaction(async()=>{
    object(payload,['id','semester','title','authorId']);const semester=await semesterValue(payload.semester),id=clean(payload.id,'Notice',100);
    const notice=await db.get('SELECT n.id,n.title,n.content,n.semester,n.authorId,u.name FROM notices n LEFT JOIN users u ON u.id=n.authorId WHERE n.id=?',id);
    assert(notice&&notice.semester===semester,'Published notice not found.',404);
    const title=clean(notice.title,'Notice title',150),excerpt=(notice.content||'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180);
    const body=title+' · Posted by '+(notice.name||'your administrator')+'.'+(excerpt?' '+excerpt:'')+' Open the notice board to view the full notice and any attachment.';
    await prune(clock());
    return {notified:await announce({type:'notice',semester,title,body,url:'#notices/'+encodeURIComponent(id),reference:id,expiresAt:clock()+14*DAY},{exclude:notice.authorId})};
  });}
  // A background delivery must use current membership and current source data,
  // not the account role or timetable snapshot saved when it was enqueued.
  async function notificationForDelivery(userId,id){return db.transaction(async()=>{
    const at=clock(),account=await db.get('SELECT id,name,role,semester FROM users WHERE id=?',userId);
    if(!account||!approved.has(account.role))return null;
    const row=await db.get('SELECT * FROM app_notifications WHERE id=? AND user_id=? AND expires_at>?',id,userId,at);
    if(!row)return null;
    const scope=await readableSemesters(account,at);if(scope&&!scope.has(row.semester))return null;
    if(row.type==='note'){
      if(!await db.get('SELECT n.id FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.id=? AND s.semester=?',row.reference,row.semester))return null;
    }else if(row.type==='notice'){
      if(!await db.get('SELECT id FROM notices WHERE id=? AND semester=?',row.reference,row.semester))return null;
    }else if(row.type==='daily-routine'){
      const match=/^daily:(\d+):(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(row.reference||'');
      if(!match||Number(match[1])!==row.semester||!await db.get('SELECT semester FROM daily_routines WHERE semester=? AND class_date=? AND revision=?',row.semester,match[2],Number(match[3])))return null;
    }else if(row.type==='teacher-reminder'||row.type==='class-reminder'){
      const occurrence=await db.get('SELECT * FROM class_occurrences WHERE id=?',row.reference);
      if(!occurrence||occurrence.semester!==row.semester||Number(occurrence.active)!==1||occurrence.starts_at<=at||occurrence.starts_at>at+REMINDER||!await db.get("SELECT id FROM users WHERE id=? AND role='teacher'",occurrence.teacher_id))return null;
      if(row.type==='teacher-reminder'&&(account.role!=='teacher'||occurrence.teacher_id!==account.id||occurrence.response!=='pending'))return null;
      if(row.type==='class-reminder'&&(account.role!=='member'||account.semester!==row.semester||occurrence.response==='absent'))return null;
    }else if(row.type==='class-status'){
      const split=row.reference?.lastIndexOf(':');if(!split||split<0)return null;
      const occurrence=await db.get("SELECT c.active,c.revision,c.semester FROM class_occurrences c JOIN users u ON u.id=c.teacher_id WHERE c.id=? AND u.role='teacher'",row.reference.slice(0,split));
      if(!occurrence||Number(occurrence.active)!==1||occurrence.semester!==row.semester||occurrence.revision!==Number(row.reference.slice(split+1)))return null;
    }else return null;
    return row;
  });}
  async function processDue(){return db.transaction(async()=>{
    const at=clock();await prune(at);const dates=[dayAt(at),dayAt(at+DAY),dayAt(at+2*DAY)];
    // Batch reads avoid a database round trip for every existing weekly class
    // on every minute tick. The write transaction prevents duplicate inserts.
    const slots=await db.all(slotSelect+" WHERE t.active=1 AND u.role='teacher' AND s.semester=t.semester ORDER BY t.id LIMIT 1000");
    const overrides=new Set((await db.all('SELECT semester,class_date FROM daily_routines WHERE class_date IN(?,?,?)',...dates)).map(row=>row.semester+':'+row.class_date));
    const existing=new Set((await db.all("SELECT source_key FROM class_occurrences WHERE source_type='weekly' AND class_date IN(?,?,?)",...dates)).map(row=>row.source_key));
    for(const date of dates)for(const slot of slots){if(slot.weekday!==weekday(date)||overrides.has(slot.semester+':'+date)||startOf(date)+slot.start_minute*60000>at+48*3600000)continue;const key=occurrenceKey({sourceType:'weekly',sourceId:slot.id,sourceRevision:slot.revision,date});if(existing.has(key))continue;await insertOccurrence({sourceType:'weekly',sourceId:slot.id,sourceRevision:slot.revision,semester:slot.semester,date,row:{teacherId:slot.teacher_id,subjectId:slot.subject_id,startMinute:slot.start_minute,endMinute:slot.end_minute,room:slot.room}},at,{knownNew:true});existing.add(key);}
    const due=await db.all(occurrenceSelect+" WHERE c.active=1 AND c.response='pending' AND c.starts_at>? AND c.starts_at<=? AND u.role='teacher' AND NOT EXISTS(SELECT 1 FROM app_notifications n WHERE n.user_id=c.teacher_id AND n.type='teacher-reminder' AND n.reference=c.id) ORDER BY c.starts_at,c.id LIMIT 200",at,at+REMINDER);let reminded=0;
    for(const row of due)reminded+=Number(await notification(row.teacher_id,{type:'teacher-reminder',semester:row.semester,title:'Your class starts soon',body:row.subject_name+' · '+row.class_date+' '+minuteText(row.start_minute)+(row.room?' · '+row.room:'')+'. Open your teacher panel and confirm whether you are coming.',url:'#teaching',reference:row.id,expiresAt:row.starts_at}));
    // Student reminders use their current membership, never a browser selector.
    // They remain independent of the teacher's response prompt and deduplicate
    // per occurrence/account across repeated or concurrent worker ticks.
    // Bound account/occurrence pairs, rather than 200 classes multiplied by
    // 2,000 students. The anti-join lets later ticks progress past sent pairs.
    const studentDue=await db.all("SELECT c.*,u.name teacher_name,s.name subject_name,m.id reminder_user_id FROM class_occurrences c JOIN users u ON u.id=c.teacher_id JOIN subjects s ON s.id=c.subject_id JOIN users m ON m.semester=c.semester AND m.role='member' WHERE c.active=1 AND c.response<>'absent' AND c.starts_at>? AND c.starts_at<=? AND u.role='teacher' AND NOT EXISTS(SELECT 1 FROM app_notifications n WHERE n.user_id=m.id AND n.type='class-reminder' AND n.reference=c.id) ORDER BY c.starts_at,c.id,m.id LIMIT 200",at,at+REMINDER);
    let studentReminded=0;
    for(const row of studentDue){
      studentReminded+=Number(await notification(row.reminder_user_id,{type:'class-reminder',semester:row.semester,title:'Your class starts soon',body:row.subject_name+' · '+row.class_date+' '+minuteText(row.start_minute)+(row.room?' · '+row.room:'')+'. Open your daily timetable for the latest class update.',url:'#home',reference:row.id,expiresAt:row.starts_at}));
    }
    return {reminded,studentReminded,checked:due.length};
  });}
  return Object.freeze({state,workspace,saveSlot,deleteSlot,publishDaily,respond,notifications,markRead,notifyNote,notifyNotice,notificationForDelivery,processDue});
}
