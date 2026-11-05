/* UI lifecycle checks with an isolated DOM and cloud boundary; no real records. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const C = require('../assets/core.js');
const PDF = require('../assets/pdf.js');
const errors = require('../assets/cloud.js');
const appCode = fs.readFileSync(require.resolve('../assets/app.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const flush = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
function fixture() {
  const state = C.emptyState();
  state.people.push({id:'p_fixture',name:'Pessoa de Teste',startMonth:state.activeMonth,endMonth:null,notes:'',roles:[]});
  return state;
}
function harness(overrides={},options={}) {
  const elements = new Map(), docEvents = new Map(), winEvents = new Map(), downloads = [];
  function element(selector='') {
    if (elements.has(selector)) return elements.get(selector);
    const el={innerHTML:'',textContent:'',style:{},dataset:{},disabled:false,open:false,hidden:false,isConnected:true,value:'',
      append(){},remove(){},focus(){},select(){},click(){},scrollIntoView(){},checkValidity(){return true;},
      showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,fn){this[name]=fn;}};
    elements.set(selector,el); return el;
  }
  const document={querySelector:element,querySelectorAll:()=>[],activeElement:element('active'),visibilityState:'visible',
    body:{style:{},append(){},classList:{toggle(){}}},createElement:()=>element('new-'+elements.size),
    addEventListener(name,fn){docEvents.set(name,fn);}};
  let currentSession={user:{id:'owner'}}, authCallback, saveCalls=0,confirmResult=true;
  const defaultGroups=[{id:'group_a',name:'Grupo de Teste A',createdAt:null},{id:'group_b',name:'Grupo de Teste B',createdAt:null}];
  const cloud={session:async()=>currentSession,profile:async()=>({userId:currentSession?.user.id,isAdmin:true,defaultGroupId:'group_a'}),
    groups:async()=>defaultGroups,
    createGroup:async name=>({id:'group_c',name}),listUsers:async()=>({users:[]}),createUser:async()=>({ok:true}),assignUser:async()=>({ok:true}),read:async()=>({state:fixture(),revision:7,updatedAt:null}),
    save:async state=>({state,revision:8,updatedAt:null}),login:async()=>({sent:true}),loginPassword:async()=>({signedIn:true}),
    logout:async()=>{},subscribeAuth(fn){authCallback=fn;return()=>{};},...overrides};
  const originalSave=cloud.save;cloud.save=(...args)=>{saveCalls++;return originalSave(...args);};
  const window={EmDiaCore:options.core||C,EMDIA_CLOUD_CONFIG:{url:'https://example.invalid',publishableKey:'test-public-key'},
    supabase:{createClient:()=>({})},EmDiaCloud:{...errors,create:()=>cloud},
    scrollTo(){},addEventListener(name,fn){winEvents.set(name,fn);}};
  const TestURL=class extends URL {static createObjectURL(blob){downloads.push(blob);return 'blob:fixture';}static revokeObjectURL(){}};
  const context={window,document,console,URL:TestURL,Blob,Date,Number,String,Object,Array,Error,Promise,
    navigator:{},confirm:()=>confirmResult,setTimeout:()=>1,
    FormData:class {constructor(form){this.values=new Map(Object.entries(form.fields||{}));}get(k){return this.values.get(k)||null;}has(k){return this.values.has(k);}},
    localStorage:new Proxy({}, {get(){throw Error('Application attempted to access local records');}})};
  vm.runInNewContext(appCode,context,{filename:'assets/app.js'});
  function click(action,id='') {docEvents.get('click')({target:{closest:()=>({dataset:{action,id}})},preventDefault(){}});}
  function submit(id,fields={},value='') {return docEvents.get('submit')({target:{id,fields},submitter:{value},preventDefault(){}});}
  function change(id,value){const target=element('#'+id);target.id=id;target.value=value;return docEvents.get('change')({target});}
  function input(form='#modal-form') {docEvents.get('input')({target:{id:'person-name',closest:s=>s===form}});}
  return {window,cloud,elements,element,click,submit,input,change,downloads,navigator:context.navigator,confirm(value){confirmResult=value;},saveCalls:()=>saveCalls,
    auth(event,session){currentSession=session;authCallback(event,session);},
    focus(){winEvents.get('focus')();},visibility(){docEvents.get('visibilitychange')?.();}};
}
test('records remain hidden until session verification and cloud read both finish',async()=>{
  const verification=deferred(),read=deferred();let readCalls=0;
  const h=harness({session:()=>verification.promise,read:()=>{readCalls++;return read.promise;}});
  assert.equal(h.window.EmDiaApp.getState(),null);
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste/);
  assert.equal(readCalls,0);
  verification.resolve({user:{id:'owner'}});await flush();
  assert.equal(readCalls,1);assert.equal(h.window.EmDiaApp.getState(),null);
  read.resolve({state:fixture(),revision:7});await flush();
  assert.equal(h.window.EmDiaApp.getState().people.length,1);
  assert.match(h.element('#app').innerHTML,/Pessoa de Teste/);
});
test('unsigned visitors see login and never load or mutate private records',async()=>{
  let readCalls=0;const h=harness({session:async()=>null,read:async()=>{readCalls++;}});await flush();
  assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(readCalls,0);
  h.click('quick-receive','p_fixture');await flush();assert.equal(h.saveCalls(),0);
  assert.match(h.element('#app').innerHTML,/login-form/);
  assert.equal(h.window.EmDiaApp.getCloudStatus().loading,false);
});
test('a failed save preserves old state, the open form, and a recoverable candidate',async()=>{
  const pending=deferred();const h=harness({save:()=>pending.promise});await flush();
  h.click('person-edit','p_fixture');h.input();
  const submit=h.submit('modal-form',{name:'Pessoa Alterada',start:C.emptyState().activeMonth,end:'',notes:''});
  assert.equal(h.saveCalls(),1);assert.equal(h.element('#modal').open,true);
  assert.equal(h.window.EmDiaApp.getState().people[0].name,'Pessoa de Teste');
  await h.submit('modal-form',{name:'Outro Nome',start:C.emptyState().activeMonth});assert.equal(h.saveCalls(),1);
  pending.reject(new errors.CloudError('Connection lost'));await submit;await flush();
  assert.equal(h.window.EmDiaApp.getState().people[0].name,'Pessoa de Teste');
  assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);
  assert.match(h.element('#app').innerHTML,/Baixar alteração não confirmada/);
  h.click('quick-receive','p_fixture');await flush();assert.equal(h.saveCalls(),1);
});
test('successful edits wait for the server and close the form only after confirmation',async()=>{
  const pending=deferred();let candidate;const h=harness({save:state=>{candidate=state;return pending.promise;}});await flush();
  h.click('person-edit','p_fixture');
  const submit=h.submit('modal-form',{name:'Pessoa Alterada',start:C.emptyState().activeMonth,end:'',notes:''});
  assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getState().people[0].name,'Pessoa de Teste');
  pending.resolve({state:candidate,revision:8});await submit;
  assert.equal(h.element('#modal').open,false);assert.equal(h.window.EmDiaApp.getState().people[0].name,'Pessoa Alterada');
  assert.equal(h.window.EmDiaApp.getCloudStatus().revision,8);
});
test('sign-out immediately removes private DOM and rejects late reads',async()=>{
  let pending;const h=harness({read:async()=>pending?pending.promise:{state:fixture(),revision:7}});await flush();
  h.click('person-edit','p_fixture');h.element('#toasts').innerHTML='Pessoa de Teste';
  pending=deferred();h.focus();await flush(); // open modal prevents refresh
  h.click('modal-close');h.focus();await flush();
  h.auth('SIGNED_OUT',null);assert.equal(h.window.EmDiaApp.getState(),null);
  assert.equal(h.element('#modal').innerHTML,'');assert.equal(h.element('#toasts').innerHTML,'');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste/);
  pending.resolve({state:fixture(),revision:9});await flush();assert.equal(h.window.EmDiaApp.getState(),null);
});
test('an account change during an in-flight write cannot reveal its candidate',async()=>{
  const pending=deferred();let reads=0;
  const h=harness({save:()=>pending.promise,read:async()=>++reads===1?{state:fixture(),revision:7}:null});await flush();
  h.click('quick-receive','p_fixture');await flush();assert.equal(h.saveCalls(),1);
  h.auth('SIGNED_IN',{user:{id:'different-owner'}});await flush();
  assert.equal(h.window.EmDiaApp.getState().people.length,0);
  pending.reject(new errors.CloudError('Late failed write'));await flush();
  assert.equal(h.window.EmDiaApp.getState().people.length,0);
  assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,false);
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste|alteração não confirmada/);
});
test('focus never refreshes over an unsaved settings form or failed candidate',async()=>{
  let reads=0;const h=harness({read:async()=>{reads++;return{state:fixture(),revision:7};}});await flush();
  h.input('#settings-form');h.focus();await flush();assert.equal(reads,1);
});
test('revoked authorization during save closes private records instead of offering them to a signed-out session',async()=>{
  const h=harness({save:async()=>{throw new errors.AccessDeniedError();}});await flush();
  h.click('quick-receive','p_fixture');await flush();
  assert.equal(h.window.EmDiaApp.getState(),null);
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste|Baixar alteração não confirmada/);
  assert.match(h.element('#app').innerHTML,/Entre no Em dia/);
});
test('a backup file still being read cannot reopen its modal after sign-out or an account switch',async()=>{
  const fileRead=deferred();let reads=0;
  const h=harness({read:async()=>++reads===1?{state:fixture(),revision:7}:null});await flush();
  const importRead=h.element('#import-file').change({target:{files:[{size:100,text:()=>fileRead.promise}],value:'chosen.json'}});
  h.auth('SIGNED_OUT',null);h.auth('SIGNED_IN',{user:{id:'different-owner'}});await flush();
  assert.equal(h.window.EmDiaApp.getState().people.length,0);
  const imported=fixture();imported.people[0].name='Nome privado do backup anterior';
  fileRead.resolve(JSON.stringify(imported));await importRead;await flush();
  assert.equal(h.element('#modal').open,false);assert.equal(h.element('#modal').innerHTML,'');
  assert.equal(h.window.EmDiaApp.getState().people.length,0);
  assert.doesNotMatch(h.element('#app').innerHTML,/Nome privado do backup anterior|Importar backup/);
});
test('a background read finishing after a settings edit preserves the draft and old cloud revision',async()=>{
  const read=deferred();let reads=0;
  const h=harness({read:async()=>++reads===1?{state:fixture(),revision:7}:read.promise});await flush();
  h.click('tab','data');h.focus();await flush();assert.equal(reads,2);
  const shown=h.element('#app').innerHTML;h.element('#congregation').value='Alteração ainda não salva';h.input('#settings-form');
  const remote=fixture();remote.settings.congregation='Nova versão de outro aparelho';
  read.resolve({state:remote,revision:9});await flush();
  assert.equal(h.element('#app').innerHTML,shown);
  assert.equal(h.element('#congregation').value,'Alteração ainda não salva');
  assert.equal(h.window.EmDiaApp.getState().settings.congregation,'');
  assert.equal(h.window.EmDiaApp.getCloudStatus().revision,7);
  assert.equal(h.window.EmDiaApp.getCloudStatus().loading,false);
  h.focus();await flush();assert.equal(reads,2);
});
test('a rejected clipboard operation cannot reopen private text after sign-out',async()=>{
  const clipboard=deferred(),h=harness();await flush();
  h.navigator.clipboard={writeText:()=>clipboard.promise};
  h.element('#message-text').value='Mensagem privada da sessão anterior';
  h.click('copy-message');await flush();h.auth('SIGNED_OUT',null);
  clipboard.reject(new Error('Clipboard unavailable'));await flush();
  assert.equal(h.element('#modal').open,false);assert.equal(h.element('#modal').innerHTML,'');
  assert.doesNotMatch(h.element('#app').innerHTML,/Mensagem privada da sessão anterior/);
});
test('a rejected native share cannot fall back to copying records for a different account',async()=>{
  const share=deferred();let copies=0,reads=0;
  const h=harness({read:async()=>++reads===1?{state:fixture(),revision:7}:null});await flush();
  h.navigator.share=()=>share.promise;h.navigator.clipboard={writeText:async()=>{copies++;}};
  h.element('#message-text').value='Mensagem privada da conta anterior';
  h.click('share-message');await flush();h.auth('SIGNED_IN',{user:{id:'different-owner'}});await flush();
  share.reject(new Error('Native share unavailable'));await flush();
  assert.equal(copies,0);assert.equal(h.element('#modal').innerHTML,'');
  assert.equal(h.window.EmDiaApp.getState().people.length,0);
});
test('a rejected background read preserves a settings draft started while the request was pending',async()=>{
  const read=deferred();let reads=0;
  const h=harness({read:async()=>++reads===1?{state:fixture(),revision:7}:read.promise});await flush();
  h.click('tab','data');h.focus();await flush();assert.equal(reads,2);
  const shown=h.element('#app').innerHTML;h.element('#congregation').value='Rascunho ainda não salvo';h.input('#settings-form');
  read.reject(new errors.CloudError('Network unavailable'));await flush();
  assert.equal(h.element('#app').innerHTML,shown);
  assert.equal(h.element('#congregation').value,'Rascunho ainda não salvo');
  assert.equal(h.window.EmDiaApp.getState().settings.congregation,'');
  assert.equal(h.window.EmDiaApp.getCloudStatus().revision,7);
  assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);
  assert.equal(h.window.EmDiaApp.getCloudStatus().loading,false);
});
function groupFixture(letter) {
  const value=C.emptyState();
  value.settings.group='Identificação antiga';
  value.people.push({id:'p_'+letter,name:'Pessoa fictícia '+letter.toUpperCase(),startMonth:value.activeMonth,endMonth:null,notes:'',roles:[]});
  return value;
}
test('verified access opens the assigned group directly without the groups landing page',async()=>{
  const reads=[];const h=harness({read:async id=>{reads.push(id);return{state:fixture(),revision:7};}});await flush();
  assert.deepEqual(reads,['group_a']);assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');
  assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');
  assert.match(h.element('#app').innerHTML,/Checklist do mês/);assert.doesNotMatch(h.element('#app').innerHTML,/SEUS GRUPOS|groups-grid/);
  assert.doesNotMatch(h.element('#mobile-nav').innerHTML,/>Grupos</);assert.match(h.element('#app').innerHTML,/group-selector/);
});

test('each selected group reads and saves only its own state and canonical group name',async()=>{
  const reads=[],writes=[];
  const h=harness({read:async id=>{reads.push(id);return{state:groupFixture(id==='group_a'?'a':'b'),revision:4};},
    save:async(state,revision,id)=>{writes.push({id,revision,state:C.clone(state)});return{state,revision:revision+1};}});await flush();
  h.click('group-open','group_a');await flush();
  assert.equal(h.window.EmDiaApp.getState().settings.group,'Grupo de Teste A');
  h.click('quick-receive','p_a');await flush();
  h.click('group-open','group_b');await flush();
  assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A/);
  h.click('quick-receive','p_b');await flush();
  assert.deepEqual(reads,['group_a','group_b']);assert.deepEqual(writes.map(x=>x.id),['group_a','group_b']);
  assert.equal(writes[0].state.settings.group,'Grupo de Teste A');assert.equal(writes[1].state.settings.group,'Grupo de Teste B');
  assert.equal(Object.hasOwn(writes[1].state.reports[writes[1].state.activeMonth],'p_a'),false);
});
test('a regular account sees its assigned checklist and cannot invoke group or user administration',async()=>{
  let lists=0,creates=0;const reads=[];
  const h=harness({profile:async()=>({userId:'owner',isAdmin:false,defaultGroupId:'group_a'}),
    listUsers:async()=>{lists++;return{users:[]};},createGroup:async()=>{creates++;},createUser:async()=>{creates++;},
    read:async id=>{reads.push(id);return{state:fixture(),revision:1};}});await flush();
  assert.doesNotMatch(h.element('#desktop-nav').innerHTML,/Usuários|>Grupos</);
  assert.doesNotMatch(h.element('#app').innerHTML,/Grupo de Teste B|Novo grupo|group-selector|Gerenciar grupos|Trocar grupo/);
  h.click('tab','users');h.click('tab','groups');h.click('show-groups');h.click('group-new');h.click('user-new');h.click('users-refresh');h.click('group-open','group_b');await h.change('group-selector','group_b');await flush();
  assert.equal(lists,0);assert.equal(creates,0);assert.deepEqual(reads,['group_a']);assert.equal(h.element('#modal').open,false);
  assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');
});

test('an earlier group read is ignored after selecting another group',async()=>{
  const a=deferred(),b=deferred();
  const h=harness({read:id=>id==='group_a'?a.promise:b.promise});await flush();
  h.click('group-open','group_a');await flush();h.click('group-open','group_b');await flush();
  a.resolve({state:groupFixture('a'),revision:7});await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getState(),null);
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A/);
  b.resolve({state:groupFixture('b'),revision:2});await flush();
  assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');assert.equal(h.window.EmDiaApp.getCloudStatus().revision,2);
});
test('switching groups confirms an unsaved draft and clears old records and modal before loading',async()=>{
  const b=deferred();const h=harness({read:id=>id==='group_a'?Promise.resolve({state:groupFixture('a'),revision:7}):b.promise});await flush();
  h.click('group-open','group_a');await flush();h.click('person-edit','p_a');h.input();
  h.confirm(false);h.click('group-open','group_b');await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');assert.equal(h.element('#modal').open,true);
  h.confirm(true);h.click('group-open','group_b');
  assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.element('#modal').open,false);assert.equal(h.element('#modal').innerHTML,'');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A/);
  b.resolve({state:groupFixture('b'),revision:1});await flush();assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');
});
test('a group cannot be switched while its save is awaiting confirmation',async()=>{
  const save=deferred();let candidate;
  const h=harness({read:async id=>({state:groupFixture(id==='group_a'?'a':'b'),revision:7}),save:state=>{candidate=state;return save.promise;}});await flush();
  h.click('group-open','group_a');await flush();h.click('quick-receive','p_a');h.click('group-open','group_b');await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');assert.equal(h.window.EmDiaApp.getCloudStatus().saving,true);
  save.resolve({state:candidate,revision:8});await flush();h.click('group-open','group_b');await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');
});
test('a pending backup read and clipboard fallback cannot reopen records from a previous group',async()=>{
  const file=deferred(),clipboard=deferred();
  const h=harness({read:async id=>({state:groupFixture(id==='group_a'?'a':'b'),revision:1})});await flush();
  h.click('group-open','group_a');await flush();
  const imported=h.element('#import-file').change({target:{files:[{size:100,text:()=>file.promise}],value:'fixture.json'}});
  h.navigator.clipboard={writeText:()=>clipboard.promise};h.element('#message-text').value='Texto fictício do grupo anterior';h.click('copy-message');
  h.click('group-open','group_b');await flush();file.resolve(JSON.stringify(groupFixture('a')));clipboard.reject(new Error('Clipboard unavailable'));await imported;await flush();
  assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');assert.equal(h.element('#modal').open,false);assert.equal(h.element('#modal').innerHTML,'');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A|Texto fictício do grupo anterior/);
});
test('a failed new user request clears its password and keeps the selected assignment available',async()=>{
  let submitted;const h=harness({createUser:async payload=>{submitted={...payload};throw new errors.CloudError('Falha fictícia de conexão');}});await flush();
  h.click('tab','users');await flush();h.click('user-new');
  h.element('#user-password').value='Segredo-ficticio-123';
  await h.submit('modal-form',{email:'responsavel@example.invalid',password:'Segredo-ficticio-123',groupMode:'existing',groupId:'group_b'});await flush();
  assert.equal(submitted.groupId,'group_b');assert.equal(submitted.email,'responsavel@example.invalid');
  assert.equal(h.element('#user-password').value,'');assert.equal(h.element('#modal').open,true);
  assert.doesNotMatch(h.element('#modal').innerHTML,/Segredo-ficticio-123/);assert.equal(h.window.EmDiaApp.getCloudStatus().adminBusy,false);
});
test('invalid new user values clear the typed password before reporting a validation error',async()=>{
  let creates=0;const h=harness({createUser:async()=>{creates++;}});await flush();h.click('user-new');
  h.element('#user-password').value='Curta';await h.submit('modal-form',{email:'responsavel@example.invalid',password:'Curta',groupMode:'existing',groupId:'group_a'});
  assert.equal(creates,0);assert.equal(h.element('#user-password').value,'');assert.match(h.element('#form-error').textContent,/12 caracteres/);
});
test('partial account creation refreshes the list and directs assignment without repeating account creation',async()=>{
  let creates=0,lists=0;const h=harness({createUser:async()=>{creates++;const error=new errors.CloudError('Pending assignment');error.code='account_created_needs_assignment';throw error;},
    listUsers:async()=>{lists++;return{users:[{id:'new_responsible',email:'responsavel@example.invalid',groupId:null,groupName:null}]};}});await flush();h.click('user-new');
  await h.submit('modal-form',{email:'responsavel@example.invalid',password:'Segredo-ficticio-123',groupMode:'existing',groupId:'group_a'});await flush();
  assert.equal(creates,1);assert.equal(lists,1);assert.equal(h.element('#modal').open,false);assert.equal(h.element('#user-password').value,'');
  assert.match(h.element('#app').innerHTML,/sem cadastrar a conta novamente|Alterar grupo/);
  assert.match(h.element('#app').innerHTML,/responsavel@example.invalid/);
});
test('existing user reassignment can create a new group without changing the password',async()=>{
  let assigned;const h=harness({listUsers:async()=>({users:[{id:'responsible_user',email:'responsavel@example.invalid',groupId:'group_a',groupName:'Grupo de Teste A'}]}),
    assignUser:async payload=>{assigned={...payload};return{ok:true};}});await flush();
  h.click('tab','users');await flush();h.click('user-assign','responsible_user');
  await h.submit('modal-form',{groupMode:'new',newGroupName:'Grupo fictício C'});await flush();
  assert.deepEqual(assigned,{userId:'responsible_user',newGroupName:'Grupo fictício C'});
  assert.equal(h.element('#modal').open,false);assert.doesNotMatch(h.element('#modal').innerHTML,/user-password/);
});
test('an account without an assigned group does not choose one arbitrarily or create a group',async()=>{
  let reads=0,creates=0;
  const h=harness({profile:async()=>({userId:'owner',isAdmin:false,defaultGroupId:null}),
    createGroup:async()=>{creates++;},read:async()=>{reads++;return null;}});await flush();
  assert.match(h.element('#app').innerHTML,/Grupo ainda não definido/);assert.doesNotMatch(h.element('#app').innerHTML,/Novo grupo|Grupo de Teste A|Grupo de Teste B/);
  h.click('group-new');await flush();assert.equal(reads,0);assert.equal(creates,0);assert.equal(h.element('#modal').open,false);
  assert.equal(h.window.EmDiaApp.getSelectedGroup(),null);assert.equal(h.window.EmDiaApp.getState(),null);
});

test('a user list response cannot reveal account emails after sign-out',async()=>{
  const users=deferred();const h=harness({listUsers:()=>users.promise});await flush();
  h.click('tab','users');await flush();h.auth('SIGNED_OUT',null);
  users.resolve({users:[{id:'responsible_user',email:'anterior@example.invalid',groupName:'Grupo fictício anterior'}]});await flush();
  assert.doesNotMatch(h.element('#app').innerHTML,/anterior@example.invalid|Grupo fictício anterior/);assert.equal(h.window.EmDiaApp.getProfile(),null);
});
test('revoked administration closes account and group data instead of retaining the user list',async()=>{
  const h=harness({listUsers:async()=>{throw new errors.AccessDeniedError();}});await flush();h.click('tab','users');await flush();
  assert.equal(h.window.EmDiaApp.getProfile(),null);assert.equal(h.window.EmDiaApp.getGroups().length,0);
  assert.doesNotMatch(h.element('#app').innerHTML,/Grupo de Teste A/);assert.match(h.element('#app').innerHTML,/Entre no Em dia/);
});

test('the initial read shows a loading state instead of group cards or old records',async()=>{
  const read=deferred();const h=harness({read:()=>read.promise});await flush();
  assert.match(h.element('#app').innerHTML,/Carregando os dados do seu grupo/);
  assert.doesNotMatch(h.element('#app').innerHTML,/groups-grid|Abrir grupo|Checklist do mês|Pessoa de Teste/);
  assert.equal(h.window.EmDiaApp.getState(),null);
  read.resolve({state:fixture(),revision:1});await flush();
  assert.match(h.element('#app').innerHTML,/Checklist do mês/);
});

test('admin browsing and background refresh preserve the assigned startup group for the next login',async()=>{
  const reads=[];let assignments=0;
  const h=harness({read:async id=>{reads.push(id);return{state:groupFixture(id==='group_a'?'a':'b'),revision:1};},
    assignUser:async()=>{assignments++;}});await flush();
  await h.change('group-selector','group_b');await flush();h.focus();await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');
  assert.equal(h.window.EmDiaApp.getProfile().defaultGroupId,'group_a');assert.equal(assignments,0);
  h.auth('SIGNED_OUT',null);h.auth('SIGNED_IN',{user:{id:'owner'}});await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');
  assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');assert.deepEqual(reads,['group_a','group_b','group_b','group_a']);
});

test('a cancelled group selector change restores its value and preserves the draft',async()=>{
  const reads=[];const h=harness({read:async id=>{reads.push(id);return{state:fixture(),revision:1};}});await flush();
  h.click('person-edit','p_fixture');h.input();h.confirm(false);
  await h.change('group-selector','group_b');await flush();
  assert.equal(h.element('#group-selector').value,'group_a');
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');assert.equal(h.element('#modal').open,true);
  assert.deepEqual(reads,['group_a']);
});

test('a changed regular membership clears the previous group before reading its replacement',async()=>{
  let initial='group_a';const next=deferred(),reads=[];
  const h=harness({profile:async()=>({userId:'owner',isAdmin:false,defaultGroupId:initial}),
    read:id=>{reads.push(id);return id==='group_a'?Promise.resolve({state:groupFixture('a'),revision:1}):next.promise;}});await flush();
  initial='group_b';h.focus();await flush();
  assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A|Grupo de Teste A|group-selector/);
  next.resolve({state:groupFixture('b'),revision:2});await flush();
  assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');assert.deepEqual(reads,['group_a','group_b']);
});

test('revoked administration closes the administrative view before the next groups response',async()=>{
  let admin=true,calls=0;const groups=deferred();
  const h=harness({profile:async()=>({userId:'owner',isAdmin:admin,defaultGroupId:admin?'group_a':'group_b'}),
    groups:()=>++calls===1?Promise.resolve([{id:'group_a',name:'Grupo de Teste A'},{id:'group_b',name:'Grupo de Teste B'}]):groups.promise,
    read:async id=>({state:groupFixture(id==='group_a'?'a':'b'),revision:1}),
    listUsers:async()=>({users:[{id:'another',email:'administracao@example.invalid',groupName:'Grupo de Teste A'}]})});await flush();
  h.click('tab','users');await flush();assert.match(h.element('#app').innerHTML,/administracao@example.invalid/);
  admin=false;h.click('cloud-reload');await flush();
  assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getSelectedGroup(),null);
  assert.doesNotMatch(h.element('#app').innerHTML,/administracao@example.invalid|Grupo de Teste A|group-selector/);
  assert.doesNotMatch(h.element('#mobile-nav').innerHTML,/Usuários/);
  groups.resolve([{id:'group_a',name:'Grupo de Teste A'},{id:'group_b',name:'Grupo de Teste B'}]);await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');
});

test('an unavailable assigned group never falls back to an arbitrary readable group',async()=>{
  let reads=0;const h=harness({profile:async()=>({userId:'owner',isAdmin:false,defaultGroupId:'group_missing'}),
    read:async()=>{reads++;return null;}});await flush();
  assert.equal(reads,0);assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getSelectedGroup(),null);
  assert.match(h.element('#app').innerHTML,/Grupo ainda não definido/);
  assert.doesNotMatch(h.element('#app').innerHTML,/Grupo de Teste A|Grupo de Teste B/);
});

test('an admin without a startup group can explicitly browse without silently assigning one',async()=>{
  const reads=[];let assignments=0;
  const h=harness({profile:async()=>({userId:'owner',isAdmin:true,defaultGroupId:null}),
    read:async id=>{reads.push(id);return{state:fixture(),revision:1};},assignUser:async()=>{assignments++;}});await flush();
  assert.deepEqual(reads,[]);assert.match(h.element('#app').innerHTML,/Defina seu grupo inicial/);
  await h.change('group-selector','group_b');await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getProfile().defaultGroupId,null);
  assert.equal(assignments,0);assert.deepEqual(reads,['group_b']);
});

test('an admin can change their startup assignment without changing the group being browsed',async()=>{
  let initial='group_a';const h=harness({profile:async()=>({userId:'owner',isAdmin:true,defaultGroupId:initial}),
    listUsers:async()=>({users:[{id:'owner',email:'admin@example.invalid',isAdmin:true,groupId:initial}]}),
    assignUser:async()=>{initial='group_b';return{userId:'owner',group:{id:'group_b',name:'Grupo de Teste B'}};}});await flush();
  h.click('tab','users');await flush();h.click('user-assign','owner');
  assert.match(h.element('#modal').innerHTML,/grupo que abre ao entrar/);
  await h.submit('modal-form',{groupMode:'existing',groupId:'group_b'});await flush();
  assert.equal(h.window.EmDiaApp.getProfile().defaultGroupId,'group_b');assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');
  h.auth('SIGNED_OUT',null);h.auth('SIGNED_IN',{user:{id:'owner'}});await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');
});

test('each annual shortcut selects its publisher and reference year without writing records',async()=>{
  const data=fixture();data.activeMonth='2024-10';data.people[0].startMonth='2024-01';
  data.people.push({...data.people[0],id:'p_other',name:'Outra Pessoa Fictícia'});
  data.reports['2024-01']={p_fixture:{received:true,kind:'publisher',participated:true,hours:null,studies:1,notes:'',receivedDate:null,updatedAt:null},
    p_other:{received:true,kind:'publisher',participated:true,hours:null,studies:900,notes:'',receivedDate:null,updatedAt:null}};
  const h=harness({read:async()=>({state:data,revision:7})});await flush();h.click('tab','people');await flush();
  const cards=h.element('#app').innerHTML;
  assert.match(cards,/profile-actions/);assert.match(cards,/aria-label="Ver relatório anual de Pessoa de Teste"/);
  assert.match(cards,/title="Ver relatório anual de Pessoa de Teste"/);
  assert.ok(cards.indexOf('data-action="person-annual"')<cards.indexOf('data-action="roles"'));
  assert.equal((cards.match(/data-action="person-annual"/g)||[]).length,2);
  await h.change('report-cycle','service');await h.change('report-year','2001');
  const before=JSON.stringify(h.window.EmDiaApp.getState());h.click('person-annual','p_fixture');await flush();
  const ui=h.window.EmDiaApp.getUI(),spec=h.window.EmDiaApp.reportSpec();
  assert.equal(ui.tab,'reports');assert.equal(ui.reportMode,'annual');assert.equal(ui.person,'p_fixture');
  assert.equal(ui.year,2024);assert.equal(ui.cycle,'civil');assert.equal(ui.month,'2024-10');
  assert.equal(spec.rows.length,12);assert.equal(spec.title,'Relatório anual · Pessoa de Teste');assert.equal(spec.rows[0][5],'1');
  assert.doesNotMatch(spec.summary,/900/);assert.equal(h.saveCalls(),0);
  assert.equal(JSON.stringify(h.window.EmDiaApp.getState()),before);
});

test('an individual year preserves monthly history and never treats a missing report as inactivity',async()=>{
  const data=fixture(),p=data.people[0];data.activeMonth='2026-10';p.startMonth='2026-03';
  p.roles=[{kind:'regular',start:'2026-03',end:'2026-04'},{kind:'auxiliary',start:'2026-06',end:'2026-06'}];
  const entry=(kind,participated,hours,studies,received=true)=>({received,kind,participated,hours,studies,notes:'Observação interna fictícia',receivedDate:null,updatedAt:null});
  data.reports={
    '2026-03':{p_fixture:entry('auxiliary',true,15,1)},
    '2026-04':{p_fixture:entry('regular',null,0,0)},
    '2026-05':{p_fixture:entry('publisher',false,null,0)},
    '2026-06':{p_fixture:entry('auxiliary',null,null,null)},
    '2026-07':{p_fixture:entry('publisher',false,null,0,false)},
    '2026-08':{p_fixture:entry('publisher',false,null,null)}
  };
  const core={...C,annualSummary:(state,person,months)=>C.annualSummary(state,person,months,'2026-11')};
  const h=harness({read:async()=>({state:data,revision:7})},{core});await flush();h.click('person-annual','p_fixture');await flush();
  const spec=h.window.EmDiaApp.reportSpec(),rows=JSON.parse(JSON.stringify(spec.rows));
  assert.equal(rows.length,12);assert.equal(rows[0][2],'Sem acompanhamento');
  assert.equal(rows[2][1],'P. auxiliar');assert.equal(rows[2][3],'Sim');assert.equal(rows[2][4],'15');
  assert.equal(rows[3][1],'P. regular');assert.equal(rows[3][2],'Recebido');assert.equal(rows[3][3],'Não informado');assert.equal(rows[3][4],'0');
  assert.equal(rows[4][2],'Recebido · sem participação');assert.equal(rows[4][3],'Não');
  assert.equal(rows[5][2],'Recebido: conferir');assert.equal(rows[5][4],'Não informado');assert.equal(rows[5][5],'Não informado');
  assert.equal(rows[6][2],'Pendente');assert.equal(rows[6][3],'—');
  assert.equal(rows[7][2],'Recebido: conferir · sem participação');
  assert.equal(rows[10][2],'Em andamento');assert.equal(rows[11][2],'Mês futuro');
  assert.match(spec.summary,/15\*h informadas/);assert.match(spec.summary,/1\* registros de estudos/);
  assert.match(spec.notes.join(' '),/Não entregue não significa falta de participação ou inatividade/);
  assert.match(spec.notes.join(' '),/tipo vem dos períodos cadastrados/);
  assert.doesNotMatch(JSON.stringify(spec),/Observação interna fictícia/);
  const pdf=PDF.build(spec);assert.ok(pdf.pages>=1);assert.equal(Buffer.from(pdf.bytes).subarray(0,8).toString(),'%PDF-1.4');
  assert.equal(h.saveCalls(),0);
});

test('invalid annual targets and a cancelled discard preserve the open publisher draft',async()=>{
  const h=harness();await flush();h.click('tab','people');await flush();h.click('person-edit','p_fixture');h.input();
  const before=JSON.stringify(h.window.EmDiaApp.getUI()),form=h.element('#modal').innerHTML;
  h.click('person-annual','missing_person');await flush();
  assert.equal(JSON.stringify(h.window.EmDiaApp.getUI()),before);assert.equal(h.element('#modal').innerHTML,form);assert.equal(h.element('#modal').open,true);
  h.confirm(false);h.click('person-annual','p_fixture');await flush();
  assert.equal(JSON.stringify(h.window.EmDiaApp.getUI()),before);assert.equal(h.element('#modal').open,true);assert.equal(h.element('#modal').innerHTML,form);
  h.confirm(true);h.click('person-annual','p_fixture');await flush();
  assert.equal(h.window.EmDiaApp.getUI().tab,'reports');assert.equal(h.element('#modal').open,false);assert.equal(h.saveCalls(),0);
});

test('annual consultation preserves a failed save candidate and its recovery download',async()=>{
  const h=harness({save:async()=>{throw new errors.CloudError('Falha fictícia de conexão');}});await flush();
  const before=JSON.stringify(h.window.EmDiaApp.getState()),month=h.window.EmDiaApp.getUI().month;
  h.click('quick-receive','p_fixture');await flush();assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);
  h.click('person-annual','p_fixture');await flush();
  assert.equal(h.window.EmDiaApp.getUI().tab,'reports');assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);
  assert.match(h.element('#app').innerHTML,/Baixar alteração não confirmada/);assert.equal(JSON.stringify(h.window.EmDiaApp.getState()),before);
  h.click('recovery-copy');await flush();assert.equal(h.downloads.length,1);
  const recovered=JSON.parse(await h.downloads[0].text());assert.equal(recovered.reports[month].p_fixture.received,true);
  assert.equal(h.saveCalls(),1);
});

test('annual shortcuts wait for an active group read or save to finish',async()=>{
  const read=deferred(),save=deferred();let candidate;
  const h=harness({read:()=>read.promise,save:state=>{candidate=state;return save.promise;}});await flush();
  h.click('person-annual','p_fixture');await flush();assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');assert.equal(h.window.EmDiaApp.getState(),null);
  read.resolve({state:fixture(),revision:7});await flush();h.click('quick-receive','p_fixture');await flush();
  h.click('person-annual','p_fixture');await flush();assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');
  save.resolve({state:candidate,revision:8});await flush();h.click('person-annual','p_fixture');await flush();
  assert.equal(h.window.EmDiaApp.getUI().tab,'reports');assert.equal(h.saveCalls(),1);
});

test('an annual selection is cleared by group switches and sign-out',async()=>{
  const h=harness({read:async id=>({state:groupFixture(id==='group_a'?'a':'b'),revision:1})});await flush();
  h.click('person-annual','p_a');await flush();assert.equal(h.window.EmDiaApp.getUI().person,'p_a');
  h.click('group-open','group_b');await flush();assert.equal(h.window.EmDiaApp.getUI().person,'all');
  h.click('person-annual','p_a');await flush();assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A/);
  h.click('person-annual','p_b');await flush();assert.equal(h.window.EmDiaApp.getUI().person,'p_b');
  h.auth('SIGNED_OUT',null);h.click('person-annual','p_b');await flush();
  assert.equal(h.window.EmDiaApp.getUI().person,'all');assert.equal(h.window.EmDiaApp.reportSpec(),null);
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia B/);
});

test('the annual shortcut keeps the report year within the existing supported range',async()=>{
  const data=fixture();data.activeMonth='2199-12';
  const h=harness({read:async()=>({state:data,revision:7})});await flush();h.click('person-annual','p_fixture');await flush();
  assert.equal(h.window.EmDiaApp.getUI().year,2198);assert.equal(h.window.EmDiaApp.getUI().month,'2199-12');
  assert.equal(h.window.EmDiaApp.reportSpec().rows.length,12);assert.equal(h.saveCalls(),0);
});
