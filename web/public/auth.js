const $=selector=>document.querySelector(selector),base='/applyburst/api/';
let registration=false;
try{
 const response=await fetch(base+'auth/status',{credentials:'same-origin'}),status=await response.json();
 if(!response.ok)throw new Error(status.error||'Could not check this local account.');
 registration=status.registration_open;
 $('#auth-title').textContent=registration?'Create your local account.':'Welcome back.';
 $('#auth-note').textContent=registration?'First time here? Choose a username and password for this computer.':'Sign in to your private ApplyBurst workspace.';
 $('#auth-submit').textContent=registration?'Create account':'Sign in';
 $('#confirm-label').hidden=!registration;$('#confirm-password').required=registration;
 $('#password').autocomplete=registration?'new-password':'current-password';
 if(registration){$('#password').minLength=8;$('#confirm-password').minLength=8;}
 $('#auth-submit').disabled=false;
}catch(error){$('#login-error').textContent=error.message;}
$('#login-form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget,button=$('#auth-submit');button.disabled=true;$('#login-error').textContent='';
 try{
  const fields=new FormData(form),password=fields.get('password');
  if(registration&&password!==fields.get('confirm_password'))throw new Error('The passwords do not match.');
  const response=await fetch(base+(registration?'register':'login'),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:fields.get('username'),password})}),result=await response.json();
  if(!response.ok)throw new Error(result.error||'Could not sign in.');
  location.assign('/applyburst/');
 }catch(error){$('#login-error').textContent=error.message;button.disabled=false;}
});
