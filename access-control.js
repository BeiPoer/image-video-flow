import crypto from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';

export const SESSION_SECONDS=30*24*60*60;
const cookieName='flow_access_session';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

export async function createAccessControl(dataDir,env=process.env,clock=Date.now) {
  const password=env.APP_ACCESS_PASSWORD;
  if(typeof password!=='string'||!password.trim()||Buffer.byteLength(password)>1024)throw new Error('请在服务端 .env 配置非空 APP_ACCESS_PASSWORD（最长 1024 字节）后启动');
  if(env.APP_COOKIE_SECURE && !['true','false'].includes(env.APP_COOKIE_SECURE))throw new Error('APP_COOKIE_SECURE 必须为 true 或 false');
  await mkdir(dataDir,{recursive:true});
  const keyPath=join(dataDir,'access.key'),sessionPath=join(dataDir,'access-sessions.json');
  let stored;
  try{stored=JSON.parse(await readFile(sessionPath,'utf8'));}catch(err){if(err.code!=='ENOENT')throw new Error('登录会话文件无法读取，请管理员检查数据目录');}
  let key;
  try{key=await readFile(keyPath);}catch(err){
    if(err.code!=='ENOENT')throw err;
    if(stored)throw new Error('登录密钥 access.key 丢失，请连同会话文件恢复备份');
    key=crypto.randomBytes(32);await writeFile(keyPath,key,{flag:'wx',mode:0o600});
  }
  if(key.length!==32)throw new Error('登录密钥文件无效');
  const passwordTag=crypto.createHmac('sha256',key).update(password).digest('hex');
  let sessions={};
  if(stored?.passwordTag===passwordTag){
    if(!stored.sessions||typeof stored.sessions!=='object'||Array.isArray(stored.sessions))throw new Error('登录会话文件格式无效');
    sessions=Object.fromEntries(Object.entries(stored.sessions).filter(([hash,item])=>/^[a-f0-9]{64}$/.test(hash)&&Number.isFinite(item?.expiresAt)&&item.expiresAt>clock()));
  }
  let writes=Promise.resolve();
  function save(){
    const snapshot=JSON.stringify({passwordTag,sessions});
    const operation=writes.then(async()=>{
      const temporary=sessionPath+'.'+crypto.randomUUID()+'.tmp';
      try{await writeFile(temporary,snapshot,{mode:0o600});await rename(temporary,sessionPath);}
      finally{await rm(temporary,{force:true});}
    });
    writes=operation.catch(()=>{});return operation;
  }
  await save();
  function token(req){const value=(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1);return /^[a-f0-9]{64}$/.test(value||'')?value:null;}
  function session(req){const value=token(req);if(!value)return null;const entry=sessions[sha(value)];return entry&&entry.expiresAt>clock()?entry:null;}
  function cookie(req,value,expiresAt){
    const secure=env.APP_COOKIE_SECURE==='true'||(env.APP_COOKIE_SECURE!=='false'&&(req.socket.encrypted||req.headers['x-forwarded-proto']==='https'));
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value?SESSION_SECONDS:0}; Expires=${new Date(expiresAt).toUTCString()}${secure?'; Secure':''}`;
  }
  function sameSite(req){
    if(req.headers['sec-fetch-site']==='cross-site')return false;
    if(!req.headers.origin)return true;
    try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}
  }
  function json(res,status,value,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value));}
  async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw Error('请求过大');}return JSON.parse(raw||'{}');}
  const attempts=new Map();
  async function handle(req,res,pathname){
    if(pathname==='/api/auth/status' && req.method==='GET'){const current=session(req);json(res,200,{authenticated:Boolean(current),expiresAt:current?.expiresAt||null});return true;}
    if(!['/api/auth/login','/api/auth/logout'].includes(pathname))return false;
    if(req.method!=='POST'){json(res,405,{error:'不支持的登录操作'});return true;}
    if(!sameSite(req)||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'请从本站登录页面操作'});return true;}
    if(pathname==='/api/auth/logout'){
      const value=token(req);if(value){delete sessions[sha(value)];await save();}
      json(res,200,{ok:true},{'set-cookie':cookie(req,'',0)});return true;
    }
    const time=clock(),address=req.socket.remoteAddress||'unknown';
    for(const [ip,item]of attempts)if(item.until<=time)attempts.delete(ip);
    let attempt=attempts.get(address);
    if(attempt?.count>=10){json(res,429,{error:'密码错误次数过多，请 15 分钟后再试'},{'retry-after':Math.ceil((attempt.until-time)/1000)});return true;}
    if(!attempt){if(attempts.size>=10000){json(res,429,{error:'登录请求过多，请稍后重试'});return true;}attempt={count:0,until:time+15*60*1000};attempts.set(address,attempt);}
    attempt.count++;
    let input;try{input=await body(req);}catch{json(res,400,{error:'登录请求格式无效'});return true;}
    if(typeof input?.password!=='string'||Buffer.byteLength(input.password)>1024||!crypto.timingSafeEqual(Buffer.from(sha(input.password),'hex'),Buffer.from(sha(password),'hex'))){json(res,401,{error:'访问密码不正确'});return true;}
    attempts.delete(address);
    for(const [hash,item]of Object.entries(sessions))if(item.expiresAt<=time)delete sessions[hash];
    const old=token(req);if(old)delete sessions[sha(old)];
    // Personal app: retain at most 100 devices, evicting the oldest session first.
    const entries=Object.entries(sessions).sort((a,b)=>a[1].expiresAt-b[1].expiresAt);
    while(entries.length>=100)delete sessions[entries.shift()[0]];
    const value=crypto.randomBytes(32).toString('hex'),hash=sha(value),expiresAt=time+SESSION_SECONDS*1000;
    sessions[hash]={expiresAt};
    try{await save();}catch{delete sessions[hash];json(res,500,{error:'登录状态保存失败，请管理员检查数据目录'});return true;}
    json(res,200,{ok:true,expiresAt},{'set-cookie':cookie(req,value,expiresAt)});return true;
  }
  return {handle,session,sameSite};
}
