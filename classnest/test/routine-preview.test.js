import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../db-adapter.js';
import {importRows,validateMigration} from '../scripts/migrate-data.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'classnest-routine-test-'));
 const free=net.createServer();await new Promise(resolve=>free.listen(0,'127.0.0.1',resolve));const port=free.address().port;await new Promise(resolve=>free.close(resolve));
 let child;
 async function start(){child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',DB_PROVIDER:'sqlite',STORAGE_PROVIDER:'local',VERCEL:'',PUBLIC_ORIGIN:'',ALLOWED_HOSTS:'',WEBSITE_SITE_NAME:'',EMAIL_ENABLED:'false'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',data=>errors+=data);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup failed: '+errors)),15000);child.stdout.on('data',data=>{if(String(data).includes('running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+errors));});});}
 async function stop(){if(child&&!child.killed){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}}
 async function request(route,{method='GET',body,cookie='',origin}={}){const headers={'X-Classnest-Request':'1',...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})};if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';const response=await fetch(`http://127.0.0.1:${port}/api`+route,{method,headers,...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});const bytes=Buffer.from(await response.arrayBuffer());let value=bytes.toString();if(response.headers.get('content-type')?.includes('application/json'))value=JSON.parse(value);return {status:response.status,body:value,bytes,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 await start();
 return {dir,start,stop,request,async close(){await stop();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('classnest-routine-test-'));rmSync(dir,{recursive:true,force:true});}};
}
async function owner(f){const result=await f.request('/setup',{method:'POST',body:{name:'Routine Owner',email:'routine-owner@example.com',password:'A secure routine owner password'}});assert.equal(result.status,201);return result.cookie;}
const classGrid=(revision=0)=>({semester:3,title:'Weekly class routine',columns:['Day','09:00–10:00'],rows:[['Sunday','Circuit theory']],revision});

test('routines: admin-only publication, public semester views, revision conflicts, reset and persistence',async()=>{
 const f=await fixture();
 try{
  const admin=await owner(f);let result=await f.request('/state?semester=3');assert.equal(result.body.routines.class,null);assert.equal(result.body.routines.exam,null);
  result=await f.request('/routines/class',{method:'PUT',body:classGrid()});assert.equal(result.status,403);
  await f.request('/register',{method:'POST',body:{name:'Reader',email:'routine-reader@example.com',password:'A secure routine reader password',semester:3}});
  result=await f.request('/login',{method:'POST',body:{email:'routine-reader@example.com',password:'A secure routine reader password'}});const student=result.cookie,id=result.body.id;
  await f.request('/users/'+id,{method:'PATCH',cookie:admin,body:{role:'member'}});
  result=await f.request('/routines/class',{method:'PUT',cookie:student,body:classGrid()});assert.equal(result.status,403);
  result=await f.request('/routines/class',{method:'PUT',cookie:admin,origin:'https://untrusted.example',body:classGrid()});assert.equal(result.status,403);
  result=await f.request('/routines/class',{method:'PUT',cookie:admin,body:classGrid()});assert.equal(result.status,200);
  result=await f.request('/state?semester=3');assert.deepEqual(result.body.routines.class.columns,classGrid().columns);assert.deepEqual(result.body.routines.class.rows,classGrid().rows);assert.equal(result.body.routines.class.revision,1);assert.equal(result.body.routines.exam,null);
  result=await f.request('/state?semester=4');assert.equal(result.body.routines.class,null);
  result=await f.request('/routines/class',{method:'PUT',cookie:admin,body:classGrid()});assert.equal(result.status,409);
  const conflicts=await Promise.all(['First revision','Second revision'].map(title=>f.request('/routines/class',{method:'PUT',cookie:admin,body:{...classGrid(1),title}})));assert.deepEqual(conflicts.map(item=>item.status).sort(),[200,409]);
  const invalid=[{...classGrid(2),rows:[['One cell']]},{...classGrid(2),columns:Array.from({length:13},(_,i)=>'C'+i),rows:[]},{...classGrid(2),rows:Array.from({length:41},()=>['Day','Class'])},{...classGrid(2),rows:[['Sunday','x'.repeat(161)]]},{...classGrid(2),revision:undefined}];
  for(const body of invalid){result=await f.request('/routines/class',{method:'PUT',cookie:admin,body});assert.equal(result.status,400);}
  result=await f.request('/routines/other',{method:'PUT',cookie:admin,body:classGrid(2)});assert.equal(result.status,400);
  result=await f.request('/routines/class?semester=3',{method:'DELETE',cookie:admin,body:{revision:1}});assert.equal(result.status,409);
  result=await f.request('/routines/class?semester=3',{method:'DELETE',cookie:admin,body:{revision:2}});assert.equal(result.status,200);
  result=await f.request('/state?semester=3');assert.equal(result.body.routines.class.revision,3);assert.deepEqual(result.body.routines.class.rows,[]);
  result=await f.request('/routines/class',{method:'PUT',cookie:admin,body:classGrid()});assert.equal(result.status,409);
  result=await f.request('/routines/class',{method:'PUT',cookie:admin,body:classGrid(3)});assert.equal(result.status,200);
  result=await f.request('/routines/exam',{method:'PUT',cookie:admin,body:{semester:3,title:'Exam routine',columns:['Date','Time','Subject'],rows:[],revision:0}});assert.equal(result.status,200);
  result=await f.request('/state?semester=3');assert.deepEqual(result.body.routines.exam.rows,[]);assert.equal(result.body.routines.class.revision,4);
  await f.stop();await f.start();result=await f.request('/state?semester=3');assert.deepEqual(result.body.routines.class.rows,classGrid().rows);assert.deepEqual(result.body.routines.exam.rows,[]);
 }finally{await f.close();}
});

function officeFixture(){const chunks=[],central=[];let offset=0;for(const filename of ['[Content_Types].xml','word/document.xml']){const name=Buffer.from(filename),data=Buffer.from('<xml/>'),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);chunks.push(header,name,data);const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=header.length+name.length+data.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,directory,end]);}

test('note preview: public validated PDF/image/text bytes, protected headers and honest Office fallback',async()=>{
 const f=await fixture();
 try{
  const admin=await owner(f);let result=await f.request('/subjects',{method:'POST',cookie:admin,body:{name:'Preview subject',semester:3}});assert.equal(result.status,201);const subject=result.body.id;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const files=[['note.pdf',Buffer.from('%PDF-1.4\nValidated preview fixture'),'application/pdf'],['note.png',png,'image/png'],['note.md',Buffer.from('<script>never execute this</script>\nStudy note.'),'text/plain']];let pdf;
  for(const [name,bytes,mime] of files){const form=new FormData();form.set('subjectId',subject);form.set('title',name);form.set('file',new Blob([bytes]),name);result=await f.request('/notes',{method:'POST',cookie:admin,body:form});assert.equal(result.status,201);const id=result.body.id;if(name.endsWith('.pdf'))pdf=id;
   result=await f.request('/notes/'+id+'/preview');assert.equal(result.status,200);assert.deepEqual(result.bytes,bytes);assert.ok(result.headers.get('content-type').startsWith(mime));assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.match(result.headers.get('content-security-policy'),/sandbox/);assert.equal(result.headers.get('location'),null);assert.ok(!result.headers.get('content-disposition')?.includes('attachment'));
   const download=await f.request('/notes/'+id+'/download');assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);
  }
  const form=new FormData();form.set('subjectId',subject);form.set('title','Office document');form.set('file',new Blob([officeFixture()]),'note.docx');result=await f.request('/notes',{method:'POST',cookie:admin,body:form});assert.equal(result.status,201);result=await f.request('/notes/'+result.body.id+'/preview');assert.equal(result.status,415);
  result=await f.request('/notes/missing/preview');assert.equal(result.status,404);
  const db=new DatabaseSync(path.join(f.dir,'classnest.sqlite'),{readOnly:true});let stored;try{stored=db.prepare('SELECT filename FROM notes WHERE id=?').get(pdf);}finally{db.close();}
  writeFileSync(path.join(f.dir,'uploads',stored.filename),Buffer.alloc(files[0][1].length,0x61));result=await f.request('/notes/'+pdf+'/preview');assert.equal(result.status,400);
 }finally{await f.close();}
});

test('routine backups preserve grids and reset revisions while accepting pre-routine portable exports',async()=>{
 const dirs=Array.from({length:3},()=>mkdtempSync(path.join(tmpdir(),'classnest-routine-test-'))),databases=[];
 try{
  const source=await openDatabase({dataDir:dirs[0]});databases.push(source);
  await source.run('INSERT INTO users(id,name,email,password,role,created,semester) VALUES(?,?,?,?,?,?,?)','owner-id','Owner','owner@example.com','unchanged-test-hash','admin',new Date().toISOString(),3);
  const content=JSON.stringify({title:'Class routine',columns:['Day','Period'],rows:[['Sunday','Circuit theory']]}),updated=new Date().toISOString();
  await source.run('INSERT INTO routines(semester,kind,content,revision,updated) VALUES(?,?,?,?,?)',3,'class',content,7,updated);
  await source.run('INSERT INTO routines(semester,kind,content,revision,updated) VALUES(?,?,?,?,?)',3,'exam',JSON.stringify({title:'Exam routine',columns:[],rows:[]}),4,updated);
  const payload=await source.exportRows();assert.equal(payload.tables.routines.length,2);
  for(const [index,legacy] of [[1,false],[2,true]]){
   const target=await openDatabase({dataDir:dirs[index],initialize:false});databases.push(target);target.sqlite.exec(readFileSync(new URL('../schema/sqlite.sql',import.meta.url),'utf8'));
   const imported=structuredClone(payload);if(legacy)delete imported.tables.routines;
   await importRows(target,imported);
   const restored=await target.exportRows();assert.equal(restored.tables.users[0].password,'unchanged-test-hash');assert.deepEqual(restored.tables.routines,legacy?[]:payload.tables.routines);
  }
  const invalid=structuredClone(payload);invalid.tables.routines[0].content=JSON.stringify({title:'Broken',columns:['One'],rows:[['Two','cells']]});assert.throws(()=>validateMigration(invalid),/row/i);
 }finally{for(const db of databases)await db.close();for(const dir of dirs){assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('classnest-routine-test-'));rmSync(dir,{recursive:true,force:true});}}
});
