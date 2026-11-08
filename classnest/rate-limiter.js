import rateLimit,{ipKeyGenerator} from 'express-rate-limit';
import {createHash} from 'node:crypto';
export function requestLimiter(db,scope,options){
  if(db.provider!=='postgres')return rateLimit(options);
  return async(req,res,next)=>{
    try{
      const key=options.keyGenerator?options.keyGenerator(req):ipKeyGenerator(req.ip||req.socket.remoteAddress);
      const identity=createHash('sha256').update(scope+':'+key).digest('hex');
      const limit=typeof options.limit==='function'?options.limit(req):options.limit;
      const result=await db.transaction(async()=>{
        await db.run('DELETE FROM rate_limits WHERE reset<?',Date.now());
        const row=await db.get('SELECT attempts,reset FROM rate_limits WHERE identity=?',identity);
        if(row){await db.run('UPDATE rate_limits SET attempts=attempts+1 WHERE identity=?',identity);return {attempts:row.attempts+1,reset:row.reset};}
        if((await db.get('SELECT COUNT(*) count FROM rate_limits')).count>=10000)return {attempts:limit+1,reset:Date.now()+60000};
        const reset=Date.now()+options.windowMs;await db.run('INSERT INTO rate_limits VALUES(?,?,?)',identity,1,reset);return {attempts:1,reset};
      });
      if(result.attempts>limit){res.set('Retry-After',String(Math.max(1,Math.ceil((result.reset-Date.now())/1000))));return res.status(429).json(options.message);}
      next();
    }catch(error){next(error);}
  };
}
