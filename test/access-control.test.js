import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createAccessControl,SESSION_SECONDS} from '../access-control.js';

async function temp(t){const dir=await mkdtemp(join(tmpdir(),'ai-flow-auth-'));t.after(async()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+(process.platform==='win32'?'\\':'/')+'ai-flow-auth-'));await rm(dir,{recursive:true,force:true});});return dir;}
function req(cookie='',headers={}){return{headers:{host:'localhost',cookie,...headers},socket:{remoteAddress:'127.0.0.1'}};}
async function authCall(auth,path,password,cookie='',headers={}){
  const request=Readable.from([JSON.stringify({password})]);Object.assign(request,req(cookie,{'content-type':'application/json',...headers}),{method:'POST'});
  const result={};const response={writeHead(status,values){result.status=status;result.headers=values;},end(text){result.body=JSON.parse(text);}};
  await auth.handle(request,response,path);return result;
}
test('30-day login survives restarts, expires at its original deadline, and never stores raw tokens or passwords',async t=>{
  const dir=await temp(t),env={APP_ACCESS_PASSWORD:'test-access-secret'};let now=Date.now();const clock=()=>now;
  await assert.rejects(createAccessControl(dir,{}),/APP_ACCESS_PASSWORD/);
  let auth=await createAccessControl(dir,env,clock);
  assert.equal((await authCall(auth,'/api/auth/login','wrong')).status,401);
  const login=await authCall(auth,'/api/auth/login',env.APP_ACCESS_PASSWORD);
  assert.equal(login.status,200);const cookie=login.headers['set-cookie'].split(';')[0],token=cookie.split('=')[1];
  assert.match(login.headers['set-cookie'],/HttpOnly; SameSite=Lax; Max-Age=2592000;/);
  assert.equal(login.body.expiresAt,now+SESSION_SECONDS*1000);assert.ok(auth.session(req(cookie)));
  const stored=await readFile(join(dir,'access-sessions.json'),'utf8');assert.ok(!stored.includes(token));assert.ok(!stored.includes(env.APP_ACCESS_PASSWORD));
  auth=await createAccessControl(dir,env,clock);assert.equal(auth.session(req(cookie)).expiresAt,login.body.expiresAt);
  now+=29*24*3600*1000;assert.ok(auth.session(req(cookie)));
  now=login.body.expiresAt;assert.equal(auth.session(req(cookie)),null);
  const second=await authCall(auth,'/api/auth/login',env.APP_ACCESS_PASSWORD),secondCookie=second.headers['set-cookie'].split(';')[0];
  assert.equal(auth.session(req(secondCookie.replace(/.$/,secondCookie.endsWith('a')?'b':'a'))),null);
  assert.equal((await authCall(auth,'/api/auth/logout','',secondCookie,{origin:'https://evil.example'})).status,403);assert.ok(auth.session(req(secondCookie)));
  const logout=await authCall(auth,'/api/auth/logout','',secondCookie);assert.match(logout.headers['set-cookie'],/Max-Age=0/);
  auth=await createAccessControl(dir,env,clock);assert.equal(auth.session(req(secondCookie)),null);
  const third=await authCall(auth,'/api/auth/login',env.APP_ACCESS_PASSWORD),thirdCookie=third.headers['set-cookie'].split(';')[0];
  auth=await createAccessControl(dir,{APP_ACCESS_PASSWORD:'changed-password'},clock);assert.equal(auth.session(req(thirdCookie)),null);
  assert.equal((await authCall(auth,'/api/auth/login',env.APP_ACCESS_PASSWORD)).status,401);
});
test('login throttles incorrect attempts and secure deployment sets Secure cookies',async t=>{
  const dir=await temp(t);let now=Date.now();const auth=await createAccessControl(dir,{APP_ACCESS_PASSWORD:'correct-password',APP_COOKIE_SECURE:'true'},()=>now);
  for(let i=0;i<10;i++)assert.equal((await authCall(auth,'/api/auth/login','incorrect')).status,401);
  assert.equal((await authCall(auth,'/api/auth/login','correct-password')).status,429);
  now+=15*60*1000;
  const login=await authCall(auth,'/api/auth/login','correct-password');assert.equal(login.status,200);assert.match(login.headers['set-cookie'],/; Secure$/);
});
test('server protects pages, API and downloads, preserves the cookie through process restart and revokes it on logout', {timeout:15000},async t=>{
  const dir=await temp(t);let child,base;
  async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
  t.after(stop);
  async function start(password='integration-password'){
    child=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,APP_ACCESS_PASSWORD:password,APP_COOKIE_SECURE:'false',AI_FLOW_PORT:'0',AI_FLOW_DATA_DIR:dir,COS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
    base=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('auth server startup timeout')),5000);
      child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});
      child.once('error',err=>{clearTimeout(timer);reject(err);});child.once('exit',()=>{clearTimeout(timer);reject(Error('auth server exited'));});
    });
  }
  await start();
  const home=await fetch(base+'/',{redirect:'manual'});assert.equal(home.status,303);assert.match(home.headers.get('location'),/^\/login/);
  assert.match(await (await fetch(base+'/login')).text(),/访问密码/);
  for(const path of ['/app.js','/styles.css','/api/bootstrap','/api/settings','/api/results/result-a/download','/api/export'])assert.equal((await fetch(base+path)).status,401,path);
  assert.equal((await fetch(base+'/api/video-results/task-a.mp4')).status,404);
  for(const method of ['POST','PUT','DELETE'])assert.equal((await fetch(base+'/api/media/asset-test',{method})).status,401);
  assert.equal((await fetch(base+'/api/kyy-assets/asset-test')).status,403,'unsigned provider assets must remain rejected');
  const postLogin=password=>fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
  const wrong=await postLogin('bad');assert.equal(wrong.status,401);assert.equal(wrong.headers.get('set-cookie'),null);
  const login=await postLogin('integration-password');assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0],expires=(await login.json()).expiresAt;
  const authed=(path,options={})=>fetch(base+path,{...options,headers:{cookie,...options.headers}});
  assert.equal((await authed('/api/bootstrap')).status,200);assert.match(await (await authed('/')).text(),/homePage/);
  const values=await (await authed('/api/settings')).json();assert.ok(!JSON.stringify(values).includes('integration-password'));
  const forbidden=await authed('/api/projects',{method:'POST',headers:{'content-type':'application/json',origin:'https://other.example'},body:'{"name":"denied"}'});assert.equal(forbidden.status,403);
  for(const path of ['/.env','/data/access.key','/data/access-sessions.json','/access-control.js','/%2e%2e%2f.env'])assert.equal((await authed(path)).status,404,path);
  await stop();await start();
  assert.equal((await authed('/api/bootstrap')).status,200,'restarting must not require a fresh login');
  assert.equal((await (await authed('/api/auth/status')).json()).expiresAt,expires,'restart must not extend or shorten the original deadline');
  const logout=await authed('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);
  assert.equal((await authed('/api/bootstrap')).status,401);
  await stop();await start();assert.equal((await authed('/api/bootstrap')).status,401,'logout must persist across restart');
});
