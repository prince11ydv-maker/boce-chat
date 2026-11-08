import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../db-adapter.js';

let db;
try{
  db=await openDatabase({provider:'azure-sql',initialize:false});
  await db.get('SELECT 1 healthy');
  if(process.argv.includes('--probe')){console.log(JSON.stringify({ok:true}));}
  else{
    let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>8192)throw new Error('Invalid bootstrap input.');}
    const {appUser,appPassword}=JSON.parse(raw);
    if(typeof appUser!=='string'||!/^classnest_[a-zA-Z0-9_]{1,50}$/.test(appUser)||typeof appPassword!=='string'||appPassword.length<32||appPassword.length>120||/[\u0000-\u001f]/.test(appPassword))throw new Error('Invalid bootstrap input.');
    const schema=await readFile(new URL('../schema/azure-sql.sql',import.meta.url),'utf8');
    await db.transaction(async()=>{
      await db.run(schema);
      await db.run("DECLARE @user sysname=?; DECLARE @password nvarchar(128)=?; DECLARE @statement nvarchar(max); IF DATABASE_PRINCIPAL_ID(@user) IS NULL SET @statement=N'CREATE USER '+QUOTENAME(@user)+N' WITH PASSWORD='+QUOTENAME(@password,CHAR(39)); ELSE SET @statement=N'ALTER USER '+QUOTENAME(@user)+N' WITH PASSWORD='+QUOTENAME(@password,CHAR(39)); EXEC sys.sp_executesql @statement; IF NOT EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=DATABASE_PRINCIPAL_ID(@user) AND role_principal_id=DATABASE_PRINCIPAL_ID(N'db_datareader')) BEGIN SET @statement=N'ALTER ROLE db_datareader ADD MEMBER '+QUOTENAME(@user); EXEC sys.sp_executesql @statement; END; IF NOT EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=DATABASE_PRINCIPAL_ID(@user) AND role_principal_id=DATABASE_PRINCIPAL_ID(N'db_datawriter')) BEGIN SET @statement=N'ALTER ROLE db_datawriter ADD MEMBER '+QUOTENAME(@user); EXEC sys.sp_executesql @statement; END;",appUser,appPassword);
      if(process.argv.includes('--seed')){if((await db.get('SELECT COUNT(*) count FROM settings')).count)throw new Error('Cannot seed a nonempty workspace.');await db.run('INSERT INTO settings VALUES(?,?,?,?)',1,'Classnest','Pokhara University · School of Engineering',3);for(let i=1;i<=8;i++)await db.run('INSERT INTO semesters VALUES(?,?)',i,`Semester ${i}`);}
    });
    console.log(JSON.stringify({ok:true,schemaReady:true,runtimeUserReady:true}));
  }
}catch(error){
  const candidates=[],seen=new Set();const collect=(value,depth=0)=>{if(!value||typeof value!=='object'||seen.has(value)||depth>6)return;seen.add(value);candidates.push(value);for(const key of ['originalError','cause','info','innerError'])collect(value[key],depth+1);for(const key of ['errors','precedingErrors'])if(Array.isArray(value[key]))value[key].forEach(item=>collect(item,depth+1));};collect(error);
  const number=candidates.map(e=>e?.number).find(Number.isInteger);
  const message=candidates.map(e=>e?.message||'').join(' '),candidate=message.match(/Client with IP address ['"]([0-9.]+)['"]/i)?.[1];
  const clientIp=candidate&&candidate.split('.').length===4&&candidate.split('.').every(v=>/^\d{1,3}$/.test(v)&&Number(v)<=255)?candidate:undefined;
  // Tedious sometimes reports Azure's firewall denial as ELOGIN without its
  // numeric SQL error. Classify only the explicit source-IP denial message.
  const code=number||(clientIp&&/not allowed to access the server/i.test(message)?40615:candidates.map(e=>e?.code).find(v=>typeof v==='string')||'BOOTSTRAP_FAILED');
  console.log(JSON.stringify({ok:false,code,...(clientIp?{clientIp}:{})}));process.exitCode=1;
}finally{if(db)await db.close().catch(()=>{});}
