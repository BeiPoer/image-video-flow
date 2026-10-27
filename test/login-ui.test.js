import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('login returns only to this application and submits passwords through JSON, not URLs',async()=>{
  const script=await readFile(new URL('../public/login.js',import.meta.url),'utf8');
  const nodes=new Map(),calls=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,hidden:true,handlers:{},elements:{password:{value:'test-password'}},reset(){this.elements.password.value='';},addEventListener(type,fn){this.handlers[type]=fn;}});return nodes.get(id);};
  let correct=false,target;
  const location={origin:'https://flow.example',search:'',hash:'',replace(value){target=value;}};
  const ctx=vm.createContext({document:{querySelector:id=>node(id)},location,URL,URLSearchParams,fetch:async(path,options)=>{
    calls.push({path,options});return {ok:correct,json:async()=>path==='/api/auth/status'?{authenticated:false}:correct?{ok:true}:{error:'访问密码不正确'}};
  }});
  vm.runInContext(script,ctx);
  for(const next of ['https://evil.example','//evil.example','/\\evil.example','/login','javascript:alert(1)']){
    location.search='?next='+encodeURIComponent(next);assert.equal(vm.runInContext('destination()',ctx),'/');
  }
  location.search='?next='+encodeURIComponent('/#/project/p1');assert.equal(vm.runInContext('destination()',ctx),'/#/project/p1');
  await node('#loginForm').handlers.submit({preventDefault(){}});assert.equal(node('#loginError').textContent,'访问密码不正确');assert.equal(node('#loginButton').disabled,false);
  correct=true;await node('#loginForm').handlers.submit({preventDefault(){}});assert.equal(target,'/#/project/p1');assert.equal(node('#loginForm').elements.password.value,'');
  const login=calls.find(call=>call.path==='/api/auth/login');assert.equal(JSON.parse(login.options.body).password,'test-password');assert.equal(login.options.method,'POST');assert.ok(calls.every(call=>!call.path.includes('test-password')));
});
