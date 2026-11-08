import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
export const migrationTables=['settings','semesters','users','subjects','notes','notices','threads','replies','events','routines','teacher_slots','daily_routines','class_occurrences','teacher_semesters','notice_attachments'];
export function postgresQuery(query){
  const identifiers=new Set(['userId','subjectId','authorId','threadId','originalName','noteCount','replyCount','subjectName','passwordStamp','nextAttempt','leaseUntil','lastCode']);
  query=query.replace(/LENGTH\(CAST\(content AS BLOB\)\)/g,'octet_length(content)');
  let index=0;
  const compiled=query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\b[A-Za-z_][A-Za-z0-9_]*\b|\?/g,token=>token==='?'?'$'+(++index):identifiers.has(token)?'"'+token+'"':token);
  return {query:compiled,parameterCount:index};
}
export function sqlServerQuery(query){
  // Only fixed application SQL reaches this translator; values remain parameters.
  query=query.replace(/LENGTH\(CAST\(content AS BLOB\)\)/g,'DATALENGTH(content)').replace(/(?<!\[)\bidentity\b(?!\])/g,'[identity]').replace(/(?<!\[)\breset\b(?!\])/g,'[reset]');
  query=query.replace(/SELECT token FROM sessions WHERE userId=\? ORDER BY expires DESC LIMIT (\d+)/g,'SELECT TOP ($1) token FROM sessions WHERE userId=? ORDER BY expires DESC');
  if(/ LIMIT \d+\s*$/.test(query)){const count=query.match(/ LIMIT (\d+)\s*$/)[1];query=query.replace(/ LIMIT \d+\s*$/,'').replace(/^SELECT /,`SELECT TOP (${count}) `);}
  let index=0,quoted=false,result='';
  for(let i=0;i<query.length;i++){const c=query[i];if(c==="'"){if(quoted&&query[i+1]==="'"){result+="''";i++;continue;}quoted=!quoted;}result+=c==='?'&&!quoted?'@p'+index++:c;}
  return {query:result,parameterCount:index};
}

class Database {
  context=new AsyncLocalStorage();
  queue=Promise.resolve();
  constructor(provider){this.provider=provider;}
  async transaction(fn){if(this.context.getStore())return fn();let release;const previous=this.queue;this.queue=new Promise(r=>release=r);await previous;let transaction;try{
    if(this.provider==='sqlite'){this.sqlite.exec('BEGIN IMMEDIATE');transaction=this.sqlite;}
    else if(this.provider==='postgres'){transaction=await this.pg.connect();await transaction.query('BEGIN');await transaction.query("SET LOCAL lock_timeout = '15s'");await transaction.query('SELECT pg_advisory_xact_lock(73481397)');}
    else{const pool=await this.pool();transaction=new this.sql.Transaction(pool);await transaction.begin(this.sql.ISOLATION_LEVEL.SERIALIZABLE);const lock=await new this.sql.Request(transaction).query("DECLARE @result int; EXEC @result=sys.sp_getapplock @Resource=N'classnest-write',@LockMode=N'Exclusive',@LockOwner=N'Transaction',@LockTimeout=15000; SELECT @result result;");if(lock.recordset[0].result<0)throw new Error('Database write is busy.');}
    const value=await this.context.run(transaction,fn);
    if(this.provider==='sqlite')this.sqlite.exec('COMMIT');else if(this.provider==='postgres')await transaction.query('COMMIT');else await transaction.commit();return value;
  }catch(error){if(transaction){try{if(this.provider==='sqlite')this.sqlite.exec('ROLLBACK');else if(this.provider==='postgres')await transaction.query('ROLLBACK');else await transaction.rollback();}catch{}}throw error;}finally{if(this.provider==='postgres'&&transaction)transaction.release();release();}}
  async execute(query,params=[]){if(this.provider==='sqlite'){const statement=this.sqlite.prepare(query);return {all:()=>statement.all(...params),get:()=>statement.get(...params),run:()=>statement.run(...params)};}
    if(this.provider==='postgres'){
      const compiled=postgresQuery(query);if(compiled.parameterCount!==params.length)throw new Error('Invalid SQL parameter count.');
      const result=await(this.context.getStore()||this.pg).query(compiled.query,params.map(v=>typeof v==='boolean'?Number(v):v));
      return {all:()=>result.rows,get:()=>result.rows[0],run:()=>({changes:result.rowCount})};
    }
    const compiled=sqlServerQuery(query);if(compiled.parameterCount!==params.length)throw new Error('Invalid SQL parameter count.');const request=new this.sql.Request(this.context.getStore()||await this.pool());request.timeout=30000;
    params.forEach((value,index)=>{let type;if(typeof value==='number')type=Number.isInteger(value)&&Math.abs(value)<=2147483647?this.sql.Int:this.sql.BigInt;else if(typeof value==='boolean')type=this.sql.Bit;else if(Buffer.isBuffer(value))type=this.sql.VarBinary(this.sql.MAX);else type=this.sql.NVarChar(typeof value==='string'&&value.length<=4000?Math.max(1,value.length):this.sql.MAX);request.input('p'+index,type,value??null);});
    const result=await request.query(compiled.query);return {all:()=>result.recordset||[],get:()=>result.recordset?.[0],run:()=>({changes:result.rowsAffected.reduce((sum,n)=>sum+n,0)})};
  }
  async all(query,...params){return(await this.execute(query,params)).all();}
  async get(query,...params){return(await this.execute(query,params)).get();}
  async run(query,...params){return(await this.execute(query,params)).run();}
  async pool(){if(this.connectionPromise)return this.connectionPromise;
    this.connectionPromise=(async()=>{const authentication=this.config.user?{type:'default',options:{userName:this.config.user,password:this.config.password}}:{type:'azure-active-directory-default',options:process.env.AZURE_CLIENT_ID?{clientId:process.env.AZURE_CLIENT_ID}:{}};
      const pool=new this.sql.ConnectionPool({server:this.config.server,database:this.config.database,authentication,options:{encrypt:true,trustServerCertificate:false,enableArithAbort:true,maxRetriesOnTransientErrors:10,connectionRetryInterval:5000},pool:{max:4,min:0,idleTimeoutMillis:30000},connectionTimeout:90000,requestTimeout:30000});pool.on('error',()=>{});await pool.connect();return pool;
    })();try{return await this.connectionPromise;}catch(error){this.connectionPromise=null;throw error;}
  }
  async close(){if(this.provider==='sqlite')this.sqlite.close();else if(this.provider==='postgres')await this.pg.end();else if(this.connectionPromise){const pool=await this.connectionPromise;this.connectionPromise=null;await pool.close();}}
  async backup(target){if(this.provider!=='sqlite')throw Object.assign(new Error('Cloud database backups are managed by Azure SQL. Export a portable workspace backup instead.'),{status:409});this.sqlite.exec(`VACUUM INTO '${target.replace(/'/g,"''")}'`);}
  async exportRows(){return this.transaction(async()=>{const output={format:'classnest-portable-v1',exportedAt:new Date().toISOString(),tables:{}};for(const table of migrationTables)output.tables[table]=await this.all(`SELECT * FROM ${table}`);return output;});}
}

export async function openDatabase({provider=process.env.DB_PROVIDER||'sqlite',dataDir=path.join(root,'data'),initialize=true}={}){
  if(process.env.WEBSITE_SITE_NAME&&provider!=='azure-sql')throw new Error('App Service requires DB_PROVIDER=azure-sql. SQLite on a network share is not supported.');
  if(process.env.VERCEL&&provider!=='postgres')throw new Error('Vercel requires DB_PROVIDER=postgres and durable object storage.');
  if(!['sqlite','azure-sql','postgres'].includes(provider))throw new Error('Unsupported database provider.');
  const db=new Database(provider);
  if(provider==='sqlite'){mkdirSync(dataDir,{recursive:true});db.sqlite=new DatabaseSync(path.join(dataDir,'classnest.sqlite'));db.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');if(initialize)db.sqlite.exec(readFileSync(path.join(root,'schema','sqlite.sql'),'utf8'));}
  else if(provider==='postgres'){
    let url;try{url=new URL(process.env.DATABASE_URL);}catch{throw new Error('DATABASE_URL is required.');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.username||!url.password||!url.hostname.endsWith('.supabase.co')&&!url.hostname.endsWith('.supabase.com'))throw new Error('Use a Supabase PostgreSQL connection URL.');
    for(const key of [...url.searchParams.keys()])if(/^ssl|^options$/i.test(key))url.searchParams.delete(key);
    const {default:pg}=await import('pg');
    // Counts and millisecond timestamps stay numbers, matching the local adapter.
    pg.types.setTypeParser(20,v=>{const n=Number(v);if(!Number.isSafeInteger(n))throw new Error('Database integer exceeds safe range.');return n;});
    db.pg=new pg.Pool({connectionString:url.href,max:1,min:0,idleTimeoutMillis:10000,connectionTimeoutMillis:15000,statement_timeout:30000,ssl:{rejectUnauthorized:true,...(process.env.PG_CA_CERT?{ca:process.env.PG_CA_CERT}:{})}});
    db.pg.on('error',()=>{});
    await db.get('SELECT 1 healthy');
    if(initialize&&!await db.get('SELECT id FROM settings WHERE id=1'))throw new Error('Initialize and import the PostgreSQL workspace before starting the app.');
  }
  else{const server=process.env.SQL_SERVER,database=process.env.SQL_DATABASE,user=process.env.SQL_USER,password=process.env.SQL_PASSWORD;if(!server||!database||!/^[-a-zA-Z0-9.]+\.database\.windows\.net$/.test(server)||!/^[-a-zA-Z0-9_]{1,128}$/.test(database))throw new Error('Valid SQL_SERVER and SQL_DATABASE settings are required.');if(Boolean(user)!==Boolean(password))throw new Error('SQL_USER and SQL_PASSWORD must both be configured, or both omitted for Microsoft Entra authentication.');
    db.config={server,database,user,password};db.sql=(await import('mssql')).default;
    await db.pool();if(initialize&&!await db.get('SELECT id FROM settings WHERE id=1'))throw new Error('Initialize the Azure SQL schema and workspace data before starting the app.');
  }
  if(initialize&&provider==='sqlite'){
    db.sqlite.exec(readFileSync(path.join(root,'schema','email-sqlite.sql'),'utf8'));
    await db.transaction(async()=>{
      if(!db.sqlite.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='semester'))db.sqlite.exec('ALTER TABLE users ADD COLUMN semester INTEGER REFERENCES semesters(id)');
      if(!db.sqlite.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='accounttype'))db.sqlite.exec("ALTER TABLE users ADD COLUMN accounttype TEXT NOT NULL DEFAULT 'student' CHECK(accounttype IN ('student','teacher'))");
      if(!db.sqlite.prepare('PRAGMA table_info(email_preferences)').all().some(column=>column.name==='teacherreminders'))db.sqlite.exec('ALTER TABLE email_preferences ADD COLUMN teacherreminders INTEGER NOT NULL DEFAULT 0 CHECK(teacherreminders IN (0,1))');
      if(!await db.get('SELECT id FROM settings WHERE id=1'))await db.run('INSERT INTO settings VALUES(?,?,?,?)',1,'Classnest','Pokhara University · School of Engineering',3);
      for(let i=1;i<=8;i++)if(!await db.get('SELECT id FROM semesters WHERE id=?',i))await db.run('INSERT INTO semesters VALUES(?,?)',i,`Semester ${i}`);
      await db.run('UPDATE users SET semester=COALESCE((SELECT s.id FROM settings w JOIN semesters s ON s.id=w.semester WHERE w.id=1),(SELECT MIN(id) FROM semesters)) WHERE semester IS NULL');
      db.sqlite.exec('CREATE INDEX IF NOT EXISTS users_semester ON users(semester)');
    });
    db.sqlite.exec(readFileSync(path.join(root,'schema','teaching-sqlite.sql'),'utf8'));
    db.sqlite.exec(readFileSync(path.join(root,'schema','teacher-semesters-sqlite.sql'),'utf8'));
    db.sqlite.exec(readFileSync(path.join(root,'schema','notice-attachments-sqlite.sql'),'utf8'));
    db.sqlite.exec(readFileSync(path.join(root,'schema','push-sqlite.sql'),'utf8'));
  }
  return db;
}
