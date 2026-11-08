const DAY=86400000,NEPAL=345*60000,MAX_SEMESTERS=30,MAX_NOTES=200,MAX_UPCOMING=300,CONTENT_BYTES=2*1024*1024;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const dateAt=at=>new Date(at+NEPAL).toISOString().slice(0,10);
const equalIds=(left,right)=>left.length===right.length&&left.every((value,index)=>value===right[index]);

/** Selected semesters scope the class library. They never authorize private
 * discussions, absence explanations, notifications, or timetable assignments. */
export function createTeacherDashboard({db,teaching,now=Date.now}={}){
  if(!db||!['all','get','run','transaction'].every(name=>typeof db[name]==='function')||typeof teaching?.workspace!=='function')throw new TypeError('Teacher dashboard requires a database and teaching service.');
  const clock=()=>{const at=now();if(!Number.isSafeInteger(at)||at<0)fail('Invalid dashboard clock.',500);return at;};
  async function account(user,{preferences=false}={}){
    const id=typeof user==='string'?user:user?.id;if(typeof id!=='string'||!id||id.length>100)fail('Sign in to continue.',401);
    const row=await db.get('SELECT id,name,role,semester,accounttype FROM users WHERE id=?',id);
    if(!row||row.role!=='teacher'&&!(preferences&&row.role==='pending'&&row.accounttype==='teacher'))fail(preferences?'Teacher semester preferences are unavailable for this account.':'An approved teacher account is required.',403);
    return row;
  }
  async function semesterIds(values){
    if(!Array.isArray(values)||values.length<1||values.length>MAX_SEMESTERS||values.some(value=>!Number.isSafeInteger(value)||value<1)||new Set(values).size!==values.length)fail('Choose between 1 and 30 different existing semesters.');
    const ids=[...values].sort((a,b)=>a-b),valid=new Set((await db.all('SELECT id FROM semesters')).map(row=>row.id));
    if(ids.some(value=>!valid.has(value)))fail('Choose existing semesters.');return ids;
  }
  async function updateSemesters(user,values){return db.transaction(async()=>{
    const teacher=await account(user,{preferences:true}),ids=await semesterIds(values),previous=(await db.all('SELECT semester FROM teacher_semesters WHERE user_id=? ORDER BY semester',teacher.id)).map(row=>row.semester);
    if(!equalIds(ids,previous)){
      await db.run('DELETE FROM teacher_semesters WHERE user_id=?',teacher.id);
      const at=clock();for(const id of ids)await db.run('INSERT INTO teacher_semesters(user_id,semester,updated) VALUES(?,?,?)',teacher.id,id,at);
    }
    return {selectedSemesters:ids};
  });}
  async function scope(user){return db.transaction(async()=>{
    const teacher=await account(user),at=clock(),allSemesters=await db.all('SELECT id,name FROM semesters ORDER BY id'),valid=new Set(allSemesters.map(row=>row.id));
    let selectedSemesters=(await db.all('SELECT semester FROM teacher_semesters WHERE user_id=? ORDER BY semester',teacher.id)).map(row=>row.semester).filter(id=>valid.has(id));
    if(!selectedSemesters.length){const fallback=valid.has(teacher.semester)?teacher.semester:allSemesters[0]?.id;if(!fallback)fail('The workspace needs a semester before the dashboard can open.',409);selectedSemesters=[fallback];}
    const assigned=new Set((await db.all('SELECT DISTINCT semester FROM teacher_slots WHERE teacher_id=? AND active=1',teacher.id)).map(row=>row.semester));
    for(const row of await db.all('SELECT DISTINCT semester FROM class_occurrences WHERE teacher_id=? AND active=1 AND ends_at>?',teacher.id,at))assigned.add(row.semester);
    const assignedSemesters=[...assigned].filter(id=>valid.has(id)).sort((a,b)=>a-b),scope=new Set([...selectedSemesters,...assignedSemesters]);
    const semesters=allSemesters.filter(row=>scope.has(row.id)).map(row=>({...row,selected:selectedSemesters.includes(row.id),assigned:assigned.has(row.id)}));
    return {teacher,selectedSemesters,assignedSemesters,semesters};
  });}
  async function get(user,options={}){return db.transaction(async()=>{
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='semester'))fail('Choose a dashboard semester.');
    const {teacher,selectedSemesters,assignedSemesters,semesters}=await scope(user),at=clock(),today=dateAt(at),selectedSemester=options.semester??null;
    if(selectedSemester!==null&&(!Number.isSafeInteger(selectedSemester)||!semesters.some(row=>row.id===selectedSemester)))fail('Choose one of your selected or assigned dashboard semesters.');
    const classes=[],weekly=[];
    for(const semester of semesters){
      const workspace=await teaching.workspace({id:teacher.id},semester.id,today);
      // Defense in depth: keep ownership explicit even if a future workspace
      // response adds semester-wide data for another type of caller.
      for(const row of workspace.upcoming||[])if(row.teacherId===teacher.id&&row.endsAt>at&&row.startsAt<=at+2*DAY)classes.push(row);
      for(const row of workspace.slots||[])if(row.teacherId===teacher.id)weekly.push(row);
    }
    const upcoming=[...new Map(classes.map(row=>[row.id,row])).values()].filter(row=>selectedSemester===null||row.semester===selectedSemester).sort((a,b)=>a.startsAt-b.startsAt||a.id.localeCompare(b.id));
    const slots=[...new Map(weekly.map(row=>[row.id,row])).values()].filter(row=>selectedSemester===null||row.semester===selectedSemester).sort((a,b)=>a.weekday-b.weekday||a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
    const noteScope=selectedSemester===null?semesters.map(row=>row.id):[selectedSemester],noteFilter=' AND s.semester IN('+noteScope.map(()=>'?').join(',')+')';
    const noteCount=await db.get('SELECT COUNT(*) count FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.authorId=?'+noteFilter,teacher.id,...noteScope);
    const rawNotes=await db.all('SELECT n.id,n.subjectId,n.title,n.originalName,n.mime,n.size,n.created,s.name subjectName,s.semester FROM notes n JOIN subjects s ON s.id=n.subjectId WHERE n.authorId=?'+noteFilter+' ORDER BY n.created DESC,n.id DESC LIMIT 200',teacher.id,...noteScope);
    const notes=rawNotes.map(row=>({...row,author:teacher.name,contentIncluded:false}));
    let remaining=CONTENT_BYTES;
    if(selectedSemester!==null){
      const ids=notes.filter(note=>note.semester===selectedSemester).map(note=>note.id);
      if(ids.length){
        const content=new Map((await db.all('SELECT id,content FROM notes WHERE authorId=? AND id IN('+ids.map(()=>'?').join(',')+')',teacher.id,...ids)).map(row=>[row.id,row.content]));
        for(const note of notes){if(!content.has(note.id))continue;const value=content.get(note.id),bytes=Buffer.byteLength(JSON.stringify(value),'utf8');if(bytes<=remaining){note.content=value;note.contentIncluded=true;remaining-=bytes;}}
      }
    }
    const countScope=selectedSemester===null?semesters.map(row=>row.id):[selectedSemester];
    const todayCount=await db.get('SELECT COUNT(*) count FROM class_occurrences WHERE teacher_id=? AND active=1 AND class_date=? AND semester IN('+countScope.map(()=>'?').join(',')+')',teacher.id,today,...countScope);
    return {teacher:{id:teacher.id,name:teacher.name,semester:teacher.semester},today,selectedSemesters,assignedSemesters,semesters,selectedSemester,upcoming:upcoming.slice(0,MAX_UPCOMING),upcomingTruncated:upcoming.length>MAX_UPCOMING,slots,counts:{today:todayCount.count,pending:upcoming.filter(row=>row.response==='pending').length,notes:noteCount.count,semesters:semesters.length},notes,notesTruncated:noteCount.count>MAX_NOTES};
  });}
  return Object.freeze({get,updateSemesters,scope});
}
