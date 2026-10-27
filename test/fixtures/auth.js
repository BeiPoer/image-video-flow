export const testPassword='workflow-test-password';
export async function loginFetch(base,password=testPassword) {
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
  if(!response.ok)throw Error('Test login failed: '+response.status);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  return (url,options={})=>{
    const headers=new Headers(options.headers);
    if(new URL(url,base).origin===new URL(base).origin)headers.set('cookie',cookie);
    return fetch(url,{...options,headers});
  };
}
