/* Login preference UI with synthetic accounts and no external requests. */
const test=require('node:test');
const assert=require('node:assert/strict');
const {harness,flush,deferred}=require('./app.test.cjs');
function accessMock(overrides={}){
  const calls={prepare:[],remember:[],forget:0};
  const api={storage:{},identity:()=>null,preferences:()=>({rememberEmail:false,email:'',stayConnected:false}),prepareLogin(input){calls.prepare.push(input);},rememberSuccessfulEmail(...args){calls.remember.push(args);},forgetRememberedEmail(){calls.forget++;},...overrides};
  return{api,calls};
}
function setup(overrides={},cloudOverrides={}){
  const a=accessMock(overrides);let session=null,loginCalls=0,privateReads=0;
  const h=harness({session:async()=>session,read:async()=>{privateReads++;return{state:require('./app.test.cjs').fixture(),revision:7};},
    loginPassword:async()=>{loginCalls++;session={user:{id:'owner'}};return{signedIn:true};},...cloudOverrides},{accessFactory:()=>a.api});
  return{...h,a,loginCalls:()=>loginCalls,privateReads:()=>privateReads,setSession(value){session=value;}};
}
test('login offers independent optional choices and replaces the email-link control while keeping reload',async()=>{
  const h=setup();await flush();const html=h.element('#app').innerHTML;
  assert.match(html,/Lembrar meu e-mail/);assert.match(html,/Permanecer conectado/);assert.match(html,/Tentar carregar novamente/);
  assert.doesNotMatch(html,/Receber link de acesso|Esqueci minha senha/);assert.equal(h.privateReads(),0);
});
test('remembered email is escaped in the input without pre-filling a password',async()=>{
  const h=setup({preferences:()=>({email:'sample+&@example.invalid',rememberEmail:true,stayConnected:true})});await flush();
  assert.match(h.element('#app').innerHTML,/value="sample\+&amp;@example.invalid"/);assert.match(h.element('#app').innerHTML,/id="login-stay"[^>]*checked/);
  assert.doesNotMatch(h.element('#app').innerHTML,/id="login-password"[^>]*value=/);
});
test('only a successful login remembers the submitted email and applies its chosen session mode first',async()=>{
  const pending=deferred(),events=[];const h=setup({prepareLogin:x=>events.push(['prepare',x]),rememberSuccessfulEmail:(...x)=>events.push(['remember',...x])},{loginPassword:async()=>{events.push(['login']);await pending.promise;}});await flush();
  const p=h.submit('login-form',{email:'person@example.invalid',password:'fictitious-password',rememberEmail:'on',stayConnected:'on'});
  assert.equal(events.length,2);assert.equal(events[0][0],'prepare');assert.equal(events[0][1].stayConnected,true);assert.equal(h.element('#login-password').value,'');
  pending.resolve();await p;assert.equal(events[2][0],'remember');assert.deepEqual(events[2].slice(1),['person@example.invalid',true]);
  assert.ok(h.submittedForms.every(f=>!f.has('password')));
});
test('failed login retains the email draft but never remembers it',async()=>{
  const h=setup({}, {loginPassword:async()=>{throw Error('Fixture refusal');}});await flush();await h.submit('login-form',{email:'person@example.invalid',password:'fictitious-password',rememberEmail:'on'});
  assert.equal(h.a.calls.remember.length,0);assert.match(h.element('#app').innerHTML,/value="person@example.invalid"/);assert.match(h.element('#app').innerHTML,/Não foi possível entrar/);
});
test('storage refusal stops authentication rather than falling back to persistent login',async()=>{
  const h=setup({prepareLogin(){const e=Error('Armazenamento indisponível');e.code='storage_unavailable';throw e;}});await flush();await h.submit('login-form',{email:'person@example.invalid',password:'fictitious-password'});
  assert.equal(h.loginCalls(),0);assert.equal(h.a.calls.remember.length,0);assert.match(h.element('#app').innerHTML,/Armazenamento indisponível/);
});
test('forgetting the email preference immediately removes only the remembered email',async()=>{
  const h=setup();await flush();h.element('#login-remember').checked=false;await h.change('login-remember','');assert.equal(h.a.calls.forget,1);assert.equal(h.a.calls.prepare.length,0);
});
test('an email preference write failure after valid login is not reported as bad credentials',async()=>{
  const h=setup({rememberSuccessfulEmail(){throw Error('Quota');}});await flush();await h.submit('login-form',{email:'person@example.invalid',password:'fictitious-password'});
  assert.ok(h.window.EmDiaApp.getState());assert.ok(h.notifications.some(x=>/Você entrou, mas/.test(x)));assert.doesNotMatch(h.element('#app').innerHTML,/Não foi possível entrar/);
});

test('email and choices stay in memory through an ordinary reload without persisting them',async()=>{
  const h=setup();await flush();h.element('#login-email').value='draft@example.invalid';h.element('#login-remember').checked=true;h.element('#login-stay').checked=true;await h.change('login-email','draft@example.invalid');h.click('cloud-reload');await flush();
  assert.match(h.element('#app').innerHTML,/value="draft@example.invalid"/);assert.match(h.element('#app').innerHTML,/id="login-remember"[^>]*checked/);assert.match(h.element('#app').innerHTML,/id="login-stay"[^>]*checked/);assert.equal(h.a.calls.remember.length,0);
});
test('clearing a remembered email leaves the login field blank through reload',async()=>{
  const h=setup({preferences:()=>({email:'remembered@example.invalid',rememberEmail:true,stayConnected:false})});await flush();h.element('#login-email').value='';await h.change('login-email','');h.click('cloud-reload');await flush();assert.match(h.element('#app').innerHTML,/id="login-email"[^>]*value=""/);
});
