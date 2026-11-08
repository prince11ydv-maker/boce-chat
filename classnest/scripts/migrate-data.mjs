import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase,migrationTables} from '../db-adapter.js';
import {validateRoutineRecord} from '../routine-data.js';
import {noticeAttachmentColumns,validateNoticeAttachmentMetadata} from '../notice-attachments.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const columns={settings:['id','name','institution','semester'],semesters:['id','name'],users:['id','name','email','password','role','created','semester','accounttype'],subjects:['id','semester','name','code','description','color'],notes:['id','subjectId','title','content','filename','originalName','mime','size','authorId','created'],notices:['id','semester','title','content','category','pinned','authorId','created'],threads:['id','semester','title','content','authorId','created'],replies:['id','threadId','content','authorId','created'],events:['id','semester','title','description','date','kind','location','authorId'],routines:['semester','kind','content','revision','updated'],teacher_slots:['id','semester','teacher_id','subject_id','weekday','start_minute','end_minute','room','revision','active','updated'],daily_routines:['semester','class_date','title','rows_json','revision','updated'],class_occurrences:['id','source_key','source_type','source_id','source_revision','semester','class_date','teacher_id','subject_id','start_minute','end_minute','starts_at','ends_at','room','active','response','eta','reason','revision','updated']};
columns.teacher_semesters=['user_id','semester','updated'];
columns.notice_attachments=noticeAttachmentColumns;
const optionalTables=new Set(['routines','teacher_slots','daily_routines','class_occurrences','teacher_semesters','notice_attachments']);
export function validateMigration(payload){
 if(!payload||payload.format!=='classnest-portable-v1'||!payload.tables||typeof payload.tables!=='object'||Array.isArray(payload.tables))throw new Error('Invalid migration format.');
 const tableNames=Object.keys(payload.tables),legacyTables=migrationTables.filter(table=>!optionalTables.has(table));
 if(tableNames.some(table=>!migrationTables.includes(table))||legacyTables.some(table=>!Object.hasOwn(payload.tables,table)))throw new Error('Unexpected migration tables.');
 let total=0;
 for(const table of migrationTables){const rows=optionalTables.has(table)&&!Object.hasOwn(payload.tables,table)?[]:payload.tables[table];if(!Array.isArray(rows)||rows.length>15000)throw new Error('Invalid migration row count.');total+=rows.length;for(const row of rows){const expected=table==='users'?columns.users.filter(key=>!['semester','accounttype'].includes(key)||Object.hasOwn(row||{},key)):columns[table];if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==expected.length||Object.keys(row).some(key=>!expected.includes(key)))throw new Error('Invalid migration columns.');for(const value of Object.values(row))if(value!==null&&!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('Invalid migration value.');}}
 if(total>30000||payload.tables.settings.length!==1||payload.tables.settings[0].id!==1||payload.tables.users.filter(user=>user.role==='admin').length>1)throw new Error('Invalid workspace settings or owner count.');
 for(const note of payload.tables.notes)if(note.filename&&!/^[-a-f0-9]{36}\.(pdf|txt|md|docx|pptx|xlsx|png|jpg|jpeg|webp)$/.test(note.filename))throw new Error('Invalid attachment reference.');
 const semesters=new Set(payload.tables.semesters.map(row=>row.id));
 const legacySemester=semesters.has(payload.tables.settings[0].semester)?payload.tables.settings[0].semester:Math.min(...semesters);
 const users=payload.tables.users.map(row=>{
   const semester=row.semester??legacySemester;
   if(!Number.isSafeInteger(semester)||!semesters.has(semester))throw new Error('Invalid member semester.');
   const accounttype=row.accounttype??(row.role==='teacher'?'teacher':'student');if(!['student','teacher'].includes(accounttype)||!['admin','member','teacher','pending','blocked'].includes(row.role))throw new Error('Invalid account type.');
   return {...row,semester,accounttype};
 });
 const routines=(payload.tables.routines||[]).map(row=>{const checked=validateRoutineRecord(row);if(!semesters.has(checked.semester))throw new Error('Invalid routine semester.');return checked;});
 if(new Set(routines.map(row=>row.semester+':'+row.kind)).size!==routines.length)throw new Error('Duplicate routine.');
 const teaching=Object.fromEntries(['teacher_slots','daily_routines','class_occurrences'].map(table=>[table,payload.tables[table]||[]]));
 if(teaching.teacher_slots.filter(row=>row.active===1).length>1000)throw new Error('Too many active teaching assignments.');
 const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 const userIds=new Set(users.map(u=>u.id)),subjectIds=new Map(payload.tables.subjects.map(s=>[s.id,s.semester]));
 for(const row of [...teaching.teacher_slots,...teaching.class_occurrences]){if(!semesters.has(row.semester)||!userIds.has(row.teacher_id)||subjectIds.get(row.subject_id)!==row.semester||!Number.isInteger(row.start_minute)||!Number.isInteger(row.end_minute)||row.start_minute<0||row.end_minute>1439||row.end_minute<=row.start_minute||typeof row.room!=='string'||row.room.length>120||!Number.isInteger(row.revision)||row.revision<1||![0,1].includes(row.active)||!Number.isSafeInteger(row.updated))throw new Error('Invalid teaching assignment.');}
 for(const row of teaching.teacher_slots)if(!Number.isInteger(row.weekday)||row.weekday<1||row.weekday>7)throw new Error('Invalid teaching weekday.');
 for(const row of teaching.daily_routines){if(!semesters.has(row.semester)||!validDate(row.class_date)||typeof row.title!=='string'||!row.title.trim()||row.title.length>80||!Number.isSafeInteger(row.updated)||!Number.isInteger(row.revision)||row.revision<1)throw new Error('Invalid daily routine.');let rows;try{rows=JSON.parse(row.rows_json);}catch{throw new Error('Invalid daily routine rows.');}if(!Array.isArray(rows)||rows.length>40)throw new Error('Invalid daily routine rows.');for(const item of rows)if(!item||Object.keys(item).sort().join(',')!=='end,room,start,subjectId,teacherId'||!userIds.has(item.teacherId)||subjectIds.get(item.subjectId)!==row.semester||!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.end)||item.end<=item.start||typeof item.room!=='string'||item.room.length>120)throw new Error('Invalid daily routine row.');}
 for(const row of teaching.class_occurrences)if(!validDate(row.class_date)||!['daily','weekly'].includes(row.source_type)||!['pending','coming','absent'].includes(row.response)||!['','1-5','5-10','10+'].includes(row.eta)||typeof row.reason!=='string'||row.reason.length>300||row.starts_at!==Date.parse(row.class_date+'T00:00:00+05:45')+row.start_minute*60000||row.ends_at!==Date.parse(row.class_date+'T00:00:00+05:45')+row.end_minute*60000)throw new Error('Invalid class occurrence.');
 const teacherSemesters=payload.tables.teacher_semesters||[];
 for(const row of teacherSemesters)if(!userIds.has(row.user_id)||!semesters.has(row.semester)||!Number.isSafeInteger(row.updated)||row.updated<0)throw new Error('Invalid teacher semester preference.');
 if(new Set(teacherSemesters.map(row=>row.user_id+':'+row.semester)).size!==teacherSemesters.length)throw new Error('Duplicate teacher semester preference.');
 const noticeAttachments=(payload.tables.notice_attachments||[]).map(validateNoticeAttachmentMetadata),noticeIds=new Set(payload.tables.notices.map(row=>row.id)),noticeParents=new Set(),filenames=new Set(payload.tables.notes.map(row=>row.filename).filter(Boolean));
 for(const row of noticeAttachments){if(!noticeIds.has(row.notice_id)||noticeParents.has(row.notice_id)||filenames.has(row.filename))throw new Error('Invalid or duplicate notice attachment reference.');noticeParents.add(row.notice_id);filenames.add(row.filename);}
 return {...payload,tables:{...payload.tables,users,routines,...teaching,teacher_semesters:teacherSemesters,notice_attachments:noticeAttachments}};
}
function privatePath(filename){if(!filename)throw new Error('A private migration file is required.');const work=path.resolve(process.env.CLASSNEST_WORK_DIR||path.join(root,'..','..','work')),resolved=path.resolve(filename),relative=path.relative(work,resolved);if(relative.startsWith('..')||path.isAbsolute(relative)||relative==='')throw new Error('Migration files must stay inside the private work directory.');return resolved;}
export async function importRows(db,payload){payload=validateMigration(payload);await db.transaction(async()=>{if(db.provider==='sqlite'){db.sqlite.exec(readFileSync(path.join(root,'schema','teaching-sqlite.sql'),'utf8'));db.sqlite.exec(readFileSync(path.join(root,'schema','teacher-semesters-sqlite.sql'),'utf8'));db.sqlite.exec(readFileSync(path.join(root,'schema','notice-attachments-sqlite.sql'),'utf8'));if(!db.sqlite.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='accounttype'))db.sqlite.exec("ALTER TABLE users ADD COLUMN accounttype TEXT NOT NULL DEFAULT 'student'");}for(const table of [...migrationTables,'sessions','auth_failures',...(db.provider==='postgres'?['upload_tickets','rate_limits']:[])])if((await db.get(`SELECT COUNT(*) count FROM ${table}`)).count)throw new Error('The target database is not empty; migration stopped without replacing data.');for(const table of migrationTables){for(const row of payload.tables[table])await db.run(`INSERT INTO ${table} (${columns[table].join(',')}) VALUES(${columns[table].map(()=>'?').join(',')})`,...columns[table].map(key=>row[key]));}});}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let db;
 try{
  const mode=process.argv[2],filename=privatePath(process.argv[3]);
  if(mode==='export'){
   const at=process.argv.indexOf('--source-data-dir'),dataDir=path.resolve(at>=0?process.argv[at+1]:process.env.DATA_DIR||path.join(root,'data'));
   const sqlite=new DatabaseSync(path.join(dataDir,'classnest.sqlite'),{readOnly:true});let payload;
   try{sqlite.exec('BEGIN');payload={format:'classnest-portable-v1',exportedAt:new Date().toISOString(),tables:{}};for(const table of migrationTables)payload.tables[table]=optionalTables.has(table)&&!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?[]:sqlite.prepare(`SELECT * FROM ${table}`).all();sqlite.exec('COMMIT');}finally{sqlite.close();}
   payload=validateMigration(payload);payload.files=[];
   for(const note of payload.tables.notes){if(!note.filename)continue;const bytes=await readFile(path.join(dataDir,'uploads',note.filename));if(bytes.length!==note.size)throw new Error('An attachment is missing or its size does not match.');payload.files.push({name:note.filename,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
   await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(payload),{encoding:'utf8',mode:0o600,flag:'wx'});
   console.log(JSON.stringify({ok:true,tables:migrationTables.map(table=>({table,rows:payload.tables[table].length})),files:payload.files.length}));
  }else if(mode==='import'){
   if((await stat(filename)).size>128*1024*1024)throw new Error('Migration file is too large.');const payload=validateMigration(JSON.parse(await readFile(filename,'utf8')));db=await openDatabase({provider:process.env.DB_PROVIDER||'azure-sql',dataDir:process.env.DATA_DIR,initialize:false});await importRows(db,payload);console.log(JSON.stringify({ok:true,imported:true,tables:migrationTables.map(table=>({table,rows:payload.tables[table].length}))}));
  }else throw new Error('Use export or import with a private file path.');
 }catch(error){console.error(JSON.stringify({ok:false,error:error.message?.startsWith('The target database is not empty')?'TARGET_NOT_EMPTY':'MIGRATION_FAILED'}));process.exitCode=1;}
 finally{if(db)await db.close().catch(()=>{});}
}
