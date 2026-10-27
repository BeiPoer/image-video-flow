const form=document.querySelector('#loginForm'),button=document.querySelector('#loginButton'),error=document.querySelector('#loginError');
function destination(){
  const next=new URLSearchParams(location.search).get('next')||'/';
  try{const url=new URL(next,location.origin);if(url.origin===location.origin&&url.pathname==='/'&&!next.includes('\\'))return url.pathname+url.search+(url.hash||location.hash);}catch{}
  return '/';
}
form.addEventListener('submit',async event=>{
  event.preventDefault();if(button.disabled)return;button.disabled=true;error.hidden=true;
  try{
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:form.elements.password.value})});
    const payload=await response.json();if(!response.ok)throw Error(payload.error||'登录失败');
    form.reset();location.replace(destination());
  }catch(err){error.textContent=err.message||'登录失败，请稍后重试';error.hidden=false;button.disabled=false;}
});
fetch('/api/auth/status').then(response=>response.json()).then(status=>{if(status.authenticated)location.replace(destination());}).catch(()=>{});
