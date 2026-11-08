/* Classroom plans, teacher replies, and account alerts. Data is rendered as text. */
(() => {
  'use strict';
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const initialDateQuery=new URLSearchParams(location.search).get('date');
  let h, daily=null, workspace=null, alerts={items:[],unread:0}, selectedDate=validDate(initialDateQuery)?initialDateQuery:'', teacherFilter=null,showAllTeacherNotes=false,timer=null, loading=null, loadError='',workspaceError='',alertsError='';
  const weekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const q=s=>document.querySelector(s);
  const today=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Kathmandu',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return parts.year+'-'+parts.month+'-'+parts.day;};
  const e=value=>h.esc(value);
  const button=(label,action,id='',cls='button-small')=>`<button type="button" class="button ${cls}" data-teach="${action}" ${id?`data-id="${e(id)}"`:''}>${label}</button>`;
  const role=()=>h.state()?.user?.role;
  const approved=()=>['admin','member','teacher'].includes(role());
  const staff=()=>['admin','teacher'].includes(role());
  const dateLabel=value=>new Date(value+'T12:00:00+05:45').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short',timeZone:'Asia/Kathmandu'});
  const etaLabel=value=>({'1-5':'1–5 minutes','5-10':'5–10 minutes','10+':'10+ minutes'}[value]||'');
  function updateChrome(){
    const account=h.state()?.user;
    q('#teaching-nav').hidden=!account;
    q('#teaching-nav-label').textContent=role()==='teacher'?'Teacher dashboard':staff()?'Teaching & my notes':'My notes';
    const teachingLink=q('#teaching-nav'),nav=q('#nav');if(role()==='teacher'){if(nav.firstElementChild!==teachingLink)nav.prepend(teachingLink);}else if(teachingLink.nextElementSibling!==q('#admin-nav'))nav.insertBefore(teachingLink,q('#admin-nav'));
    q('.brand').setAttribute('href',role()==='teacher'?'#teaching':'#home');
    q('#notification-button').hidden=!approved();
    q('#notification-count').textContent=alerts.unread?String(Math.min(99,alerts.unread)):'';
    q('#notification-button').setAttribute('aria-label',`Notifications${alerts.unread?', '+alerts.unread+' unread':''}`);
  }
  async function load(){
    selectedDate ||= today();
    if(loading)await loading;
    const semester=h.semester();
    loading=(async()=>{
      loadError='';workspaceError='';alertsError='';
      try { daily=await h.api('/teaching/state?semester='+semester+'&date='+encodeURIComponent(selectedDate)); }
      catch(error){daily=null;loadError=error.message;}
      if(staff())try{workspace=await h.api(role()==='teacher'?'/teacher/dashboard'+(teacherFilter?'?semester='+teacherFilter:''):'/teaching/workspace?semester='+semester+'&date='+encodeURIComponent(selectedDate));}catch(error){workspace=null;workspaceError=error.message;}else{workspace=null;teacherFilter=null;}
      if(approved())try{alerts=await h.api('/notifications');}catch(error){alerts={items:[],unread:0};alertsError=error.message;}else alerts={items:[],unread:0};
      updateChrome();
      if(h.state()?.user&&!timer)timer=setInterval(()=>{if(document.visibilityState==='visible'&&!loading)h.refresh().catch(()=>{});},60000);
      if(!h.state()?.user&&timer){clearInterval(timer);timer=null;}
    })();
    try{await loading;}finally{loading=null;}
  }
  function responseLabel(session){
    if(session.response==='coming')return `<span class="class-response coming">Coming · ${e(etaLabel(session.eta))}</span>`;
    if(session.response==='absent')return `<span class="class-response absent">Not coming</span>${session.reason?`<small class="class-reason">${e(session.reason)}</small>`:''}`;
    return '<span class="class-response pending">Awaiting teacher reply</span>';
  }
  function dailyBoard(){
    const data=daily, rows=data?.sessions||[], isAdmin=role()==='admin';
    return `<section class="routine-board routine-daily" aria-labelledby="daily-routine-title"><div class="routine-heading"><div><span class="eyebrow">TODAY, TOGETHER</span><h2 id="daily-routine-title">${e(data?.dailyRoutine?.title||'Daily timetable')}</h2><p>${e(dateLabel(selectedDate||today()))} · ${e(h.semesterLabel(h.semester()))}${data?.source==='weekly'?' · From teacher assignments':''}</p></div><div class="routine-heading-actions"><label class="daily-date">View date<input id="daily-date" type="date" value="${e(selectedDate||today())}" aria-label="Daily timetable date"></label>${isAdmin?button(data?.dailyRoutine?'Edit daily timetable':'Publish daily timetable','daily-edit'):''}</div></div>${loadError?`<div class="routine-empty"><p>${e(loadError)}</p>${button('Try again','reload')}</div>`:rows.length?`<div class="routine-table-scroll" tabindex="0" role="region" aria-label="Daily timetable. Scroll sideways for every column."><table class="routine-table daily-table"><caption class="sr-only">Daily timetable for ${e(dateLabel(selectedDate))}</caption><thead><tr><th scope="col">Time · Nepal</th><th scope="col">Subject</th><th scope="col">Teacher</th><th scope="col">Room</th><th scope="col">Teacher update</th></tr></thead><tbody>${rows.map(session=>`<tr><th scope="row">${e(session.start)}–${e(session.end)}</th><td>${e(session.subjectName)}</td><td>${e(session.teacherName)}</td><td>${e(session.room)||'—'}</td><td>${responseLabel(session)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="routine-empty"><span class="routine-empty-icon">${h.icon('calendar')}</span><div><h3>${data?.dailyRoutine?'No classes scheduled for this date.':'Your daily plan will appear here.'}</h3><p>${data?.dailyRoutine?'Your administrator published a day without classes.':'The weekly class routine is below. Daily updates and teacher replies will appear here when scheduled.'}</p></div></div>`}<div class="routine-published-meta"><span>${data?.dailyRoutine?'Daily timetable published · Students in this semester receive an account alert.':'Class reminders go to assigned teachers 3 minutes before class.'}</span>${isAdmin?'<a href="#teaching">Manage teacher assignments →</a>':''}</div></section>`;
  }
  function myNotes(){
    const user=h.state().user, notes=h.state().notes.filter(note=>note.authorId===user?.id);
    return `<section class="panel"><div class="section-heading"><div><span class="eyebrow">YOUR CONTRIBUTIONS</span><h2>My notes <small>${e(h.semesterLabel(h.semester()))}</small></h2></div>${approved()?h.actionButton('＋ Share a note','add-note','button-small button-dark'):''}</div><p class="visually-muted">Choose a semester at the top to find your notes. Approved students and teachers can publish, edit, and remove their own notes. Administrators can manage all notes.</p>${notes.length?notes.map(note=>`<div class="my-note-row"><div><strong>${e(note.title)}</strong><small>${e(note.subjectName)}${note.originalName?' · '+e(note.originalName):''}</small></div><div>${h.actionButton('View','read-note','button-small',note.id)}${approved()?h.actionButton('Edit','edit-note','button-small',note.id):''}</div></div>`).join(''):'<p class="teaching-empty">You have not shared a note in this semester yet.</p>'}</section>`;
  }
  function upcomingCards(){
    const items=(workspace?.upcoming||[]).filter(session=>role()==='admin'||session.teacherId===h.state().user.id);
    return `<section class="panel"><div class="section-heading"><div><span class="eyebrow">YOUR NEXT CLASSES</span><h2>${role()==='admin'?'Upcoming teaching sessions':'Ready for your class?'}</h2></div>${button('Refresh','reload')}</div><p class="visually-muted">A reminder appears in your account 3 minutes before each assigned class. Choose whether you are coming, then give your arrival time or a reason. Replies open 24 hours before class and close when it ends. Email reminders also need a verified email and your consent in Email preferences.</p>${items.length?`<div class="teaching-session-list">${items.slice(0,30).map(session=>`<article class="teaching-session"><div><span class="eyebrow">${e(dateLabel(session.date))} · ${e(session.start)}–${e(session.end)}</span><h3>${e(session.subjectName)}</h3><p>${e(session.teacherName)}${session.room?' · '+e(session.room):''}</p>${responseLabel(session)}</div>${session.teacherId===h.state().user.id&&Number(session.endsAt)>Date.now()&&Number(session.startsAt)<=Date.now()+86400000?button(session.response==='pending'?'Are you coming?':'Update my reply','respond',session.id,'button-small button-dark'):''}</article>`).join('')}</div>`:'<div class="teaching-empty">No upcoming classes are assigned yet. Your administrator can connect your account to a subject and class time.</div>'}</section>`;
  }
  function assignmentPanel(){
    const slots=workspace?.slots||[];
    return `<section class="panel"><div class="section-heading"><div><span class="eyebrow">A CLEAR PLAN FOR EVERY CLASS</span><h2>Teacher timetable</h2></div>${role()==='admin'?button('＋ Assign a class','slot-add','','button-small button-dark'):''}</div><p class="visually-muted">${role()==='admin'?'Approve teacher accounts in Manage workspace, then assign their subjects and class times here. These assignments send the 3-minute reminders. Publish a daily timetable to replace the weekly assignments for a particular date.':'Your administrator manages these weekly assignments. A published daily timetable takes priority for that date.'}</p>${slots.length?`<div class="routine-table-scroll" tabindex="0" role="region" aria-label="Teacher weekly assignments"><table class="routine-table"><thead><tr><th>Day</th><th>Time</th><th>Subject</th><th>Teacher</th><th>Room</th>${role()==='admin'?'<th>Manage</th>':''}</tr></thead><tbody>${slots.map(slot=>`<tr><th scope="row">${e(weekdays[slot.weekday-1]||'')}</th><td>${e(slot.start)}–${e(slot.end)}</td><td>${e(slot.subjectName)}</td><td>${e(slot.teacherName)}</td><td>${e(slot.room)||'—'}</td>${role()==='admin'?`<td><div class="teaching-row-actions">${button('Edit','slot-edit',slot.id)}${button('Remove','slot-delete',slot.id,'button-small danger')}</div></td>`:''}</tr>`).join('')}</tbody></table></div>`:'<p class="teaching-empty">No teacher assignments in this semester yet.</p>'}</section>`;
  }
  function workspacePage(){
    if(!h.state().user)return h.empty('Your own place to contribute.','Sign in as a student or teacher to manage your notes.',h.actionButton('Sign in','login'));
    if(role()==='teacher')return teacherDashboard();
    const dailyTools=role()==='admin'?`<section class="panel teaching-daily-tools"><div><span class="eyebrow">PLAN ONE DAY AT A TIME</span><h2>Daily timetable</h2><p class="visually-muted">Publish the plan for a date, including teacher assignments, or leave it empty for a day without classes.</p></div><div class="teaching-row-actions"><label class="daily-date">Date<input id="daily-date" type="date" value="${e(selectedDate)}" aria-label="Daily timetable date"></label>${button(daily?.dailyRoutine?'Edit daily timetable':'Publish daily timetable','daily-edit','','button-small button-dark')}</div></section>`:'';
    return h.heading(staff()?'THE TEACHING DESK':'YOUR CLASS, YOUR WORK',staff()?'Teach. Share. Stay connected.':'A place for your ideas.',staff()?'Your class reminders, timetable, and shared notes in one place.':'Publish useful notes and keep your contributions up to date.')+(approved()?'':`<div class="alert">${role()==='pending'?'Your account is waiting for administrator approval.':'Posting access is currently disabled. Contact the administrator for help.'}</div>`)+(workspaceError?`<div class="alert">${e(workspaceError)} ${button('Try again','reload')}</div>`:'')+(staff()?`<div class="teaching-workspace">${dailyTools}${upcomingCards()}${assignmentPanel()}</div>`:'')+myNotes();
  }
  function teacherDashboard(){
    const user=h.state().user,data=workspace,scopes=data?.semesters||[],classes=data?.upcoming||[],notes=data?.notes||[],stats=data?.counts||{},next=classes.find(item=>item.endsAt>Date.now());
    const clock=`<div class="home-date-clock"><div class="nepal-clock"><span>NEPAL TIME</span><time id="nepal-clock" aria-label="Current time in Nepal"></time></div><span class="date-pill">${e(dateLabel(data?.today||today()))}</span></div>`;
    const filters=`<div class="teacher-semester-bar"><div class="teacher-semester-filters" role="group" aria-label="Filter your teaching semesters"><button type="button" class="chip ${teacherFilter===null?'active':''}" data-teach="teacher-filter" data-id="all" aria-pressed="${teacherFilter===null}">All my semesters</button>${scopes.map(sem=>`<button type="button" class="chip ${teacherFilter===sem.id?'active':''}" data-teach="teacher-filter" data-id="${sem.id}" aria-pressed="${teacherFilter===sem.id}">${e(sem.name)}${sem.assigned?' · Teaching':''}</button>`).join('')}</div>${button('Choose semesters','teacher-semesters')}</div>`;
    const nextAction=next&&next.startsAt<=Date.now()+86400000?button(next.response==='pending'?'Confirm attendance':'Update attendance','respond',next.id,'button-dark'):'';
    return h.heading('YOUR TEACHING OVERVIEW','Welcome back, '+user.name.split(' ')[0]+'.',teacherFilter?h.semesterLabel(teacherFilter)+' · Your classes, replies, and teaching materials.':'Your teaching day, across all your semesters.',clock)+filters+(workspaceError?`<div class="alert">${e(workspaceError)} ${button('Try again','reload')}</div>`:'')+
      `<div class="teacher-summary" aria-label="Your teaching overview">${[[stats.today||0,'Classes today','Across the selected semesters'],[stats.pending||0,'Replies to send','Upcoming classes awaiting your reply'],[stats.notes||0,'Your shared notes','Teaching materials you published'],[stats.semesters||scopes.length,'Teaching semesters','Your choices and assigned classes']].map(([value,label,help])=>`<div class="teacher-summary-card"><strong>${e(value)}</strong><span>${label}</span><small>${help}</small></div>`).join('')}</div>`+
      `<div class="teacher-dashboard-grid"><div class="teacher-dashboard-main"><section class="teacher-next-class"><div><span class="eyebrow">${next&&next.startsAt<=Date.now()?'CLASS IN PROGRESS':'YOUR NEXT CLASS'}</span><h2>${e(next?.subjectName||'Your next class will appear here.')}</h2><p>${next?`${e(h.semesterLabel(next.semester))} · ${e(dateLabel(next.date))} · ${e(next.start)}–${e(next.end)}${next.room?' · '+e(next.room):''}`:'Your assigned classes appear automatically. Ask your administrator to connect your teacher account to its class times.'}</p>${next?responseLabel(next):''}</div><div class="teacher-next-actions">${nextAction}${button('＋ Share notes','teacher-share','','button-dark')}</div></section>${teacherAgenda(classes,data?.today||today())}${teacherWeekly(data?.slots||[])}</div><aside class="teacher-dashboard-side"><section class="panel teacher-quick-actions"><span class="eyebrow">A FEW USEFUL SHORTCUTS</span><h2>Ready to teach.</h2>${button('＋ Share notes','teacher-share','','button-dark')}${button('Choose my semesters','teacher-semesters')}${h.actionButton('Email reminder settings','email-preferences','button-small')}<a class="button button-small" href="#notifications">Class notifications${alerts.unread?' · '+alerts.unread:''}</a><p class="visually-muted">Class reminders arrive 3 minutes before your assigned time. Your Yes/No reply keeps students informed.</p></section>${teacherNotes(notes,data?.notesTruncated)}</aside></div>`;
  }
  function teacherAgenda(items,day){
    return `<section class="panel"><div class="section-heading"><div><span class="eyebrow">KEEP YOUR DAY IN VIEW</span><h2>Your next 48 hours</h2></div>${button('Refresh','reload')}</div>${items.length?`<div class="teaching-session-list">${items.slice(0,100).map(session=>`<article class="teaching-session"><div><span class="eyebrow">${e(h.semesterLabel(session.semester))} · ${session.date===day?'TODAY':e(dateLabel(session.date))} · ${e(session.start)}–${e(session.end)}</span><h3>${e(session.subjectName)}</h3><p>${e(session.room||'Room to be confirmed')}</p>${responseLabel(session)}</div>${session.endsAt>Date.now()&&session.startsAt<=Date.now()+86400000?button(session.response==='pending'?'Are you coming?':'Update my reply','respond',session.id,'button-small button-dark'):''}</article>`).join('')}</div>`:'<div class="teaching-empty">No upcoming classes in this view. You can still prepare and share notes for your semesters.</div>'}</section>`;
  }
  function teacherWeekly(slots){
    return `<section class="panel"><div class="section-heading"><div><span class="eyebrow">YOUR WEEKLY TEACHING PLAN</span><h2>My class assignments</h2></div></div><p class="visually-muted">Your administrator manages these times. A daily timetable can update the plan for a specific date.</p>${slots.length?`<div class="routine-table-scroll" tabindex="0" role="region" aria-label="Your weekly teaching assignments"><table class="routine-table"><thead><tr><th>Day</th><th>Time</th><th>Semester</th><th>Subject</th><th>Room</th></tr></thead><tbody>${slots.map(slot=>`<tr><th scope="row">${e(weekdays[slot.weekday-1])}</th><td>${e(slot.start)}–${e(slot.end)}</td><td>${e(h.semesterLabel(slot.semester))}</td><td>${e(slot.subjectName)}</td><td>${e(slot.room)||'—'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="teaching-empty">No weekly teaching assignments in this view yet.</div>'}</section>`;
  }
  function teacherNotes(notes,truncated){
    return `<section class="panel teacher-notes"><div class="section-heading"><div><span class="eyebrow">YOUR TEACHING MATERIALS</span><h2>My shared notes</h2></div></div>${notes.length?(showAllTeacherNotes?notes:notes.slice(0,6)).map(note=>`<div class="teacher-note"><strong>${e(note.title)}</strong><small>${e(h.semesterLabel(note.semester))} · ${e(note.subjectName)}</small><div>${button('View','teacher-note-view',note.id)}${button('Edit','teacher-note-edit',note.id)}</div></div>`).join(''):'<p class="teaching-empty">Your published notes will appear here, across your teaching semesters.</p>'}${notes.length>6?button(showAllTeacherNotes?'Show recent notes':'Show all my notes','teacher-notes-toggle'):''}${truncated?'<p class="visually-muted">Showing the latest 200 notes. Use a semester filter to narrow your list.</p>':''}</section>`;
  }
  function chooseTeacherSemesters(){
    const chosen=new Set(workspace?.selectedSemesters||[h.state().user.semester]);
    h.form('Which semesters do you teach?',`<p class="visually-muted">Choose one or more semesters for your dashboard and note-sharing shortcuts. Your administrator connects your account to its class assignments.</p><fieldset class="teacher-semester-choices"><legend>Your teaching semesters</legend>${h.state().semesters.map(sem=>`<label><input type="checkbox" name="teacher-semester" value="${sem.id}" ${chosen.has(sem.id)?'checked':''}><span>${e(sem.name)}</span></label>`).join('')}</fieldset>`,async fd=>{const semesters=fd.getAll('teacher-semester').map(Number);if(!semesters.length)throw new Error('Choose at least one teaching semester.');await h.api('/teacher/semesters','PUT',{semesters});teacherFilter=null;q('#modal').close();await h.refresh();h.toast('Your teaching semesters are updated.');},'Save my semesters');
  }
  function shareTeacherNote(){
    if(teacherFilter)return h.openTeacherNote(null,teacherFilter,'share');
    const semesters=workspace?.semesters||[];
    if(!semesters.length)return h.toast('Choose a teaching semester first.');
    h.form('Share notes with a semester.',h.select('semester','Choose a semester',semesters.map(sem=>[sem.id,sem.name]),h.state().user.semester,'required'),async fd=>h.openTeacherNote(null,Number(fd.get('semester')),'share'),'Choose subject');
  }
  function notificationsPage(){
    if(!approved())return h.empty('Your class updates belong here.','Sign in with an approved student or teacher account to view notifications.',h.actionButton('Sign in','login'));
    const items=alerts.items||[];
    return h.heading('STAY IN THE LOOP','Your notifications.',`${alerts.unread||0} unread · Notes, notices, daily timetable updates, and teacher replies.`,button('Mark all read','read-all'))+(alertsError?`<div class="alert">${e(alertsError)} ${button('Try again','reload')}</div>`:`<div class="notification-list">${items.length?items.map(item=>`<article class="notification-item ${item.read?'':'unread'}"><span class="notification-dot" aria-hidden="true"></span><div><span class="eyebrow">${e(item.type.replace(/-/g,' '))} · ${e(new Date(item.created).toLocaleString('en-GB',{timeZone:'Asia/Kathmandu',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))}</span><h2>${e(item.title)}</h2><p>${e(item.body)}</p><div class="teaching-row-actions">${button('Open update','notification-open',item.id)}${item.read?'':button('Mark read','read',item.id)}</div></div></article>`).join(''):'<div class="panel teaching-empty">You’re all caught up. New class updates will appear here.</div>'}</div>`);
  }
  function fields(row,teachers,subjects,index){
    const opts=(items,value,label)=>`<option value="">${label}</option>`+items.map(item=>`<option value="${e(item.id)}" ${item.id===value?'selected':''}>${e(item.name)}</option>`).join('');
    return `<div class="daily-edit-row" data-daily-row="${index}"><div class="daily-row-number">Class ${index+1}${button('Remove','daily-remove',String(index),'button-small danger')}</div><label class="field">Subject<select data-daily-field="subjectId" required>${opts(subjects,row.subjectId,'Choose a subject')}</select></label><label class="field">Teacher<select data-daily-field="teacherId" required>${opts(teachers,row.teacherId,'Choose an approved teacher')}</select></label><label class="field">Starts · Nepal time<input type="time" data-daily-field="start" value="${e(row.start||'')}" required></label><label class="field">Ends · Nepal time<input type="time" data-daily-field="end" value="${e(row.end||'')}" required></label><label class="field">Room (optional)<input data-daily-field="room" value="${e(row.room||'')}" maxlength="120"></label></div>`;
  }
  let dailyDraft=null;
  function collectDaily(){
    if(!q('#daily-edit-form'))return;
    dailyDraft.title=q('#daily-edit-title').value;
    dailyDraft.rows=Array.from(document.querySelectorAll('[data-daily-row]')).map(row=>Object.fromEntries(Array.from(row.querySelectorAll('[data-daily-field]')).map(control=>[control.dataset.dailyField,control.value])));
  }
  function drawDaily(){
    const teachers=workspace?.teachers||[],subjects=workspace?.subjects||[];
    h.modal('Publish the daily plan.',`<form id="daily-edit-form"><p class="visually-muted"><strong>${e(dateLabel(dailyDraft.date))} · ${e(h.semesterLabel(dailyDraft.semester))}</strong><br>This plan takes priority over weekly teacher assignments for this date. Approved semester members receive an account notification. Leave it empty to publish a day without classes.</p><label class="field">Daily timetable title<input id="daily-edit-title" value="${e(dailyDraft.title)}" maxlength="80" required></label><div class="daily-edit-tools">${button('＋ Add class','daily-add')}${button('Use weekly assignments for this date','daily-prefill')}<span>${dailyDraft.rows.length}/40 classes</span></div>${!teachers.length?'<div class="alert">Approve at least one teacher account in Manage workspace before adding a class.</div>':''}${!subjects.length?'<div class="alert">Create a subject folder for this semester before adding a class.</div>':''}<div id="daily-edit-rows">${dailyDraft.rows.map((row,index)=>fields(row,teachers,subjects,index)).join('')}</div><p class="form-error" id="daily-edit-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-action="close">Cancel</button><button type="submit" class="button button-dark">Publish daily timetable ↗</button></div></form>`,'ONE DAY, ALL TOGETHER');
    q('#modal').classList.add('teaching-editor-dialog');
    q('#daily-edit-form').onsubmit=async event=>{
      event.preventDefault();collectDaily();const form=event.currentTarget;form.querySelectorAll('input,select,button').forEach(control=>control.disabled=true);
      try{await h.api('/daily-routines','PUT',dailyDraft);q('#modal').close();await h.refresh();h.toast('Daily timetable published. Class alerts are ready.');}
      catch(error){q('#daily-edit-error').textContent=error.message;form.querySelectorAll('input,select,button').forEach(control=>control.disabled=false);}
    };
  }
  function editDaily(){
    if(role()!=='admin')return;
    const current=daily?.dailyRoutine;
    dailyDraft={semester:h.semester(),date:selectedDate,title:current?.title||'Daily timetable',rows:current?.rows?.map(row=>({...row}))||[],revision:current?.revision||0};drawDaily();
  }
  function editSlot(id){
    if(role()!=='admin')return;
    const slot=workspace?.slots?.find(item=>item.id===id),teachers=workspace?.teachers||[],subjects=workspace?.subjects||[];
    if(!teachers.length)return h.toast('Approve a teacher account in Manage workspace first.');
    if(!subjects.length)return h.toast('Create a subject folder for this semester first.');
    h.form(slot?'Update the teaching assignment.':'Connect a teacher to a class.',h.select('teacherId','Teacher',teachers.map(item=>[item.id,item.name]),slot?.teacherId||teachers[0].id,'required')+h.select('subjectId','Subject',subjects.map(item=>[item.id,item.name]),slot?.subjectId||subjects[0].id,'required')+h.select('weekday','Day',weekdays.map((day,index)=>[index+1,day]),slot?.weekday||1,'required')+`<div class="teaching-time-fields">${h.input('start','Starts · Nepal time','time',slot?.start||'09:25','required')}${h.input('end','Ends · Nepal time','time',slot?.end||'10:10','required')}</div>`+h.input('room','Room (optional)','text',slot?.room||'','maxlength="120"')+'<p class="visually-muted">The assigned teacher receives a reminder 3 minutes before class. Daily timetables replace this weekly plan for the selected date.</p>',async fd=>{
      const payload={...Object.fromEntries(fd),semester:h.semester(),weekday:Number(fd.get('weekday')),revision:slot?.revision||0};await h.api('/teaching/slots'+(slot?'/'+slot.id:''),slot?'PUT':'POST',payload);q('#modal').close();await h.refresh();h.toast('Teacher timetable updated.');
    });
  }
  function respond(id){
    const session=workspace?.upcoming?.find(item=>item.id===id);
    if(!session||session.teacherId!==h.state().user?.id)return h.toast('This class is not assigned to your account.');
    h.form('Will you be joining the class?',`<p class="visually-muted"><strong>${e(session.subjectName)}</strong><br>${e(dateLabel(session.date))} · ${e(session.start)}–${e(session.end)}${session.room?' · '+e(session.room):''}</p>`+h.select('response','Are you coming?',[['','Choose your response'],['coming','Yes, I am coming'],['absent','No, I cannot come']],session.response==='pending'?'':session.response,'required')+`<div id="arrival-options">${h.select('eta','How soon will you arrive?',[['','Choose arrival time'],['1-5','1–5 minutes'],['5-10','5–10 minutes'],['10+','10+ minutes']],session.eta||'')}</div><div id="absence-options">${h.textarea('reason','Reason for not coming',session.reason||'','maxlength="300"')}</div><p class="visually-muted">Your semester sees your response and reason so students know what to expect.</p>`,async fd=>{
      await h.api('/teaching/sessions/'+id+'/respond','POST',{response:fd.get('response'),eta:fd.get('response')==='coming'?fd.get('eta'):'',reason:fd.get('response')==='absent'?fd.get('reason'):'',revision:session.revision});q('#modal').close();await h.refresh();h.toast('Your class has been updated.');
    },'Share my response');
    const toggle=()=>{const coming=q('[name="response"]').value==='coming',absent=q('[name="response"]').value==='absent';q('#arrival-options').hidden=!coming;q('#absence-options').hidden=!absent;q('[name="eta"]').required=coming;q('[name="reason"]').required=absent;};q('[name="response"]').addEventListener('change',toggle);toggle();
  }
  async function handle(action,id){
    if(action==='teacher-filter'){teacherFilter=id==='all'?null:Number(id);showAllTeacherNotes=false;await load();h.render();return;}
    if(action==='teacher-notes-toggle'){showAllTeacherNotes=!showAllTeacherNotes;h.render();return;}
    if(action==='teacher-semesters')return chooseTeacherSemesters();
    if(action==='teacher-share')return shareTeacherNote();
    if(action==='teacher-note-view'||action==='teacher-note-edit'){const note=workspace?.notes?.find(note=>note.id===id);if(note)await h.openTeacherNote(note.id,note.semester,action==='teacher-note-edit'?'edit':'view');return;}
    if(action==='reload'){await h.refresh();return;}
    if(action==='daily-edit')return editDaily();
    if(action==='slot-add'||action==='slot-edit')return editSlot(id);
    if(action==='slot-delete'){
      const slot=workspace?.slots?.find(item=>item.id===id);if(!slot)return;
      return h.confirmDelete('Remove this weekly assignment?',`${slot.subjectName} · ${weekdays[slot.weekday-1]} ${slot.start}–${slot.end}. Future reminders for this assignment will stop.`,async()=>{await h.api('/teaching/slots/'+id,'DELETE',{revision:slot.revision});q('#modal').close();await h.refresh();h.toast('Weekly assignment removed.');});
    }
    if(action==='respond')return respond(id);
    if(action==='daily-add'){collectDaily();if(dailyDraft.rows.length>=40)return h.toast('Use at most 40 classes in one day.');dailyDraft.rows.push({teacherId:'',subjectId:'',start:'',end:'',room:''});drawDaily();return;}
    if(action==='daily-remove'){collectDaily();dailyDraft.rows.splice(Number(id),1);drawDaily();return;}
    if(action==='daily-prefill'){
      collectDaily();const weekday=(new Date(dailyDraft.date+'T12:00:00+05:45').getUTCDay()+6)%7+1;
      const slots=(workspace?.slots||[]).filter(slot=>slot.weekday===weekday);
      if(!slots.length)return h.toast('No weekly assignments for this day. Your draft has been kept.');
      if(slots.length>40)return h.toast('This day has more than 40 assignments. Add the required classes individually.');
      dailyDraft.rows=slots.map(({teacherId,subjectId,start,end,room})=>({teacherId,subjectId,start,end,room}));drawDaily();return;
    }
    if(action==='read-all'){await h.api('/notifications/read-all','PATCH',{});await h.refresh();return;}
    if(action==='read'||action==='notification-open'){
      const item=alerts.items.find(item=>item.id===id);if(!item)return;
      await h.api('/notifications/'+encodeURIComponent(id)+'/read','PATCH',{});
      if(action==='notification-open'){
        if(Number.isInteger(item.semester)&&item.semester>=1&&item.semester<=30)h.setSemester(item.semester);
        const dailyReference=String(item.reference||'').match(/^daily:\d+:(\d{4}-\d{2}-\d{2}):/);
        const occurrenceId=String(item.reference||'').split(':')[0],session=[...(workspace?.upcoming||[]),...(daily?.sessions||[])].find(session=>session.id===occurrenceId);
        if(dailyReference&&validDate(dailyReference[1]))selectedDate=dailyReference[1];else if(session&&validDate(session.date))selectedDate=session.date;
      }
      await h.refresh();
      if(action==='notification-open'){const url=typeof item.url==='string'&&item.url.startsWith('#')&&!item.url.startsWith('#//')?item.url:'#home';location.hash=url;}
    }
  }
  function init(helpers){
    h=helpers;
    document.addEventListener('click',event=>{const target=event.target.closest('[data-teach]');if(!target)return;event.preventDefault();handle(target.dataset.teach,target.dataset.id).catch(error=>h.toast(error.message));});
    document.addEventListener('change',async event=>{if(event.target.id!=='daily-date')return;selectedDate=event.target.value||today();try{await load();h.render();}catch(error){h.toast(error.message);}});
    q('#notification-button').addEventListener('click',()=>{location.hash='notifications';});
    window.addEventListener('pagehide',()=>{if(timer)clearInterval(timer);timer=null;});
  }
  window.ClassnestTeachingUI=Object.freeze({init,load,dailyBoard,workspacePage,notificationsPage,shareTeacherNote});
})();
