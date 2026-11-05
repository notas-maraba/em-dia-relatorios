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
const testToday=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
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
  let currentSession={user:{id:'owner'}}, authCallback, saveCalls=0,confirmResult=true,launchCounter=0;
  const defaultGroups=[{id:'group_a',name:'Grupo de Teste A',createdAt:null},{id:'group_b',name:'Grupo de Teste B',createdAt:null}];
  const cloud={session:async()=>currentSession,profile:async()=>({userId:currentSession?.user.id,isAdmin:true,role:'admin',defaultGroupId:'group_a'}),
    groups:async()=>defaultGroups,listRevisions:async()=>({revisions:[],total:0}),publisherAccounts:async()=>[],transferGroups:async()=>defaultGroups,createPublisherUser:async()=>({userId:'publisher_user'}),transferPublisher:async()=>({}),readOwnHours:async month=>hoursBundle(month),
    createGroup:async name=>({id:'group_c',name}),listUsers:async()=>({users:[]}),createUser:async()=>({ok:true}),assignUser:async()=>({ok:true}),read:async()=>({state:fixture(),revision:7,updatedAt:null}),
    save:async state=>({state,revision:8,updatedAt:null}),login:async()=>({sent:true}),loginPassword:async()=>({signedIn:true}),
    logout:async()=>{},subscribeAuth(fn){authCallback=fn;return()=>{};},...overrides};
  const originalSave=cloud.save;cloud.save=(...args)=>{saveCalls++;return originalSave(...args);};
  const window={EmDiaCore:options.core||C,EMDIA_CLOUD_CONFIG:{url:'https://example.invalid',publishableKey:'test-public-key'},
    supabase:{createClient:()=>({})},EmDiaCloud:{...errors,create:()=>cloud},
    crypto:{randomUUID:()=>freshLaunchId(++launchCounter)},scrollTo(){},addEventListener(name,fn){winEvents.set(name,fn);}};
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
  const h=harness({profile:async()=>({userId:'owner',isAdmin:false,role:'superintendent',defaultGroupId:'group_a'}),
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
  assert.deepEqual(assigned,{userId:'responsible_user',role:'superintendent',newGroupName:'Grupo fictício C'});
  assert.equal(h.element('#modal').open,false);assert.doesNotMatch(h.element('#modal').innerHTML,/user-password/);
});
test('an account without an assigned group does not choose one arbitrarily or create a group',async()=>{
  let reads=0,creates=0;
  const h=harness({profile:async()=>({userId:'owner',isAdmin:false,role:'superintendent',defaultGroupId:null}),
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
  const h=harness({profile:async()=>({userId:'owner',isAdmin:false,role:'superintendent',defaultGroupId:initial}),
    read:id=>{reads.push(id);return id==='group_a'?Promise.resolve({state:groupFixture('a'),revision:1}):next.promise;}});await flush();
  initial='group_b';h.focus();await flush();
  assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');
  assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa fictícia A|Grupo de Teste A|group-selector/);
  next.resolve({state:groupFixture('b'),revision:2});await flush();
  assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_b');assert.deepEqual(reads,['group_a','group_b']);
});

test('revoked administration closes the administrative view before the next groups response',async()=>{
  let admin=true,calls=0;const groups=deferred();
  const h=harness({profile:async()=>({userId:'owner',isAdmin:admin,role:admin?'admin':'superintendent',defaultGroupId:admin?'group_a':'group_b'}),
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
  let reads=0;const h=harness({profile:async()=>({userId:'owner',isAdmin:false,role:'superintendent',defaultGroupId:'group_missing'}),
    read:async()=>{reads++;return null;}});await flush();
  assert.equal(reads,0);assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getSelectedGroup(),null);
  assert.match(h.element('#app').innerHTML,/Grupo ainda não definido/);
  assert.doesNotMatch(h.element('#app').innerHTML,/Grupo de Teste A|Grupo de Teste B/);
});

test('an admin without a startup group can explicitly browse without silently assigning one',async()=>{
  const reads=[];let assignments=0;
  const h=harness({profile:async()=>({userId:'owner',isAdmin:true,role:'admin',defaultGroupId:null}),
    read:async id=>{reads.push(id);return{state:fixture(),revision:1};},assignUser:async()=>{assignments++;}});await flush();
  assert.deepEqual(reads,[]);assert.match(h.element('#app').innerHTML,/Defina seu grupo inicial/);
  await h.change('group-selector','group_b');await flush();
  assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getProfile().defaultGroupId,null);
  assert.equal(assignments,0);assert.deepEqual(reads,['group_b']);
});

test('an admin can change their startup assignment without changing the group being browsed',async()=>{
  let initial='group_a';const h=harness({profile:async()=>({userId:'owner',isAdmin:true,role:'admin',defaultGroupId:initial}),
    listUsers:async()=>({users:[{id:'owner',email:'admin@example.invalid',isAdmin:true,role:'admin',groupId:initial}]}),
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
function publisherProfile(personId='p_fixture',groupId='group_a') {
  return {userId:'owner',isAdmin:false,role:'publisher',defaultGroupId:groupId,publisherId:personId};
}
function ownBundle({state=fixture(),revisions=[],personId='p_fixture',groupId='group_a'}={}) {
  state=C.clone(state);state.settings.reminder='';
  return {groupId,personId,group:{id:groupId,name:'Grupo privado fictício',createdAt:null},state,revision:7,updatedAt:null,revisions};
}
function launchIdForDate(date){return '10000000-0000-4000-8000-'+date.replaceAll('-','').padStart(12,'0');}
function freshLaunchId(index){return '20000000-0000-4000-8000-'+String(index).padStart(12,'0');}
function hoursBundle(month,entries={},changes={}) {
  return {groupId:'group_a',personId:'p_fixture',month,kind:'regular',entries:{...entries},version:Object.keys(entries).length?1:0,
    totalMinutes:Object.values(entries).reduce((total,value)=>total+value,0),closed:month<testToday().slice(0,7),today:testToday(),updatedAt:null,
    launches:Object.entries(entries).map(([date,minutes])=>({id:launchIdForDate(date),date,minutes})),...changes};
}
function launchBundle(month,launches,changes={}){const entries={};for(const launch of launches)entries[launch.date]=(entries[launch.date]||0)+launch.minutes;return hoursBundle(month,entries,{launches:C.clone(launches),...changes});}
function pioneerFixture(kind='regular') {
  const data=fixture();data.activeMonth=C.addMonth(C.currentMonth(),-1);data.people[0].startMonth=C.addMonth(data.activeMonth,-1);
  data.people[0].roles=[{kind,start:data.people[0].startMonth,end:null}];return data;
}
const activity=(changes={})=>({kind:'publisher',participated:true,hours:null,studies:1,...changes});
const report=(changes={})=>({received:true,...activity(),notes:'',receivedDate:null,updatedAt:null,...changes});
const pendingRevision=()=>({id:'revision_fixture',version:2,personId:'p_fixture',personName:'Pessoa de Teste',month:C.emptyState().activeMonth,approvedReport:activity(),proposedReport:activity({studies:3}),submittedAt:null});

test('publisher boot loads only the own-card boundary and exposes two private tabs',async()=>{
  let groupReads=0,stateReads=0,users=0,revisions=0;const data=fixture();data.settings.reminder='Lembrete interno fictício';
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),groups:async()=>{groupReads++;return[];},read:async()=>{stateReads++;},listUsers:async()=>{users++;},listRevisions:async()=>{revisions++;}});await flush();
  assert.equal(h.window.EmDiaApp.getUI().tab,'my-card');assert.match(h.element('#app').innerHTML,/Meu acompanhamento|MEU CARTÃO/);
  assert.match(h.element('#mobile-nav').innerHTML,/Meu cartão|Meus relatórios/);assert.doesNotMatch(h.element('#mobile-nav').innerHTML,/Publicadores|Usuários|Dados|Revisões/);
  assert.equal(groupReads,0);assert.equal(stateReads,0);assert.equal(users,0);assert.equal(revisions,0);
  assert.equal(h.window.EmDiaApp.getState().settings.reminder,'');assert.equal(h.window.EmDiaApp.getGroups().length,1);
  assert.doesNotMatch(h.element('#app').innerHTML,/group-selector|Lembrete interno fictício|Editar|Novo publicador/);
});

test('publisher boundary rejects extra people, foreign reports and internal notes before rendering',async()=>{
  for(const contaminate of [s=>s.people.push({...s.people[0],id:'p_foreign',name:'Pessoa restrita'}),s=>{s.reports[s.activeMonth]={p_foreign:report()};},s=>{s.people[0].notes='Nota restrita';},s=>{s.reports[s.activeMonth]={p_fixture:report({notes:'Nota restrita'})};},s=>{s.reminders[s.activeMonth]={p_fixture:{at:new Date().toISOString(),count:1}};}]) {
    const s=fixture();contaminate(s);const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:s})});await flush();
    assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa restrita|Pessoa de Teste|Nota restrita|Baixar cópia/);
  }
});

test('publisher cannot invoke group administration, backups, imports or manager writes',async()=>{
  let accounts=0,transfers=0,fileReads=0;const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle(),publisherAccounts:async()=>{accounts++;return[];},transferGroups:async()=>{transfers++;return[];}});await flush();
  for(const [a,id] of [['tab','people'],['tab','data'],['tab','users'],['tab','reviews'],['person-new'],['person-edit','p_fixture'],['roles','p_fixture'],['quick-receive','p_fixture'],['publisher-access','p_fixture'],['publisher-transfer','p_fixture'],['backup'],['recovery-copy'],['reset'],['import'],['demo']])h.click(a,id);
  await h.submit('settings-form',{congregation:'forjado',reminder:'forjado'});
  await h.element('#import-file').change({target:{files:[{size:1,text:async()=>{fileReads++;return'{}';}}],value:'fake.json'}});await flush();
  assert.equal(h.window.EmDiaApp.getUI().tab,'my-card');assert.equal(h.saveCalls(),0);assert.equal(accounts,0);assert.equal(transfers,0);assert.equal(fileReads,0);assert.equal(h.downloads.length,0);assert.equal(h.element('#modal').open,false);
});

test('publisher first submission sends activity only and waits for confirmation before updating its card',async()=>{
  let data=fixture(),calls=0,payload;const pending=deferred();const month=data.activeMonth;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),submitOwnReport:value=>{payload=C.clone(value);calls++;return pending.promise;}});await flush();
  h.click('own-report');assert.doesNotMatch(h.element('#modal').innerHTML,/Observação interna|report-kind|received|Data de recebimento/);
  const submit=h.submit('modal-form',{participated:'yes',hours:'999',studies:'2',notes:'forjado',kind:'regular',received:'on'});
  assert.equal(calls,1);assert.equal(h.window.EmDiaApp.getCloudStatus().saving,true);assert.equal(C.getReport(h.window.EmDiaApp.getState(),'p_fixture',month),null);
  assert.deepEqual(payload,{month,report:{participated:true,hours:null,studies:2},expectedVersion:0});
  data.reports[month]={p_fixture:report({studies:2})};pending.resolve({status:'accepted',version:1});await submit;await flush();
  assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.studies,2);assert.equal(h.saveCalls(),0);assert.equal(h.element('#modal').open,false);
});

test('publisher pending resubmission preserves the approved report and uses the current proposal version',async()=>{
  const data=fixture(),month=data.activeMonth;data.reports[month]={p_fixture:report({studies:1})};let payload;
  const revisions=[{id:'r_own',month,status:'pending',version:4,report:activity({studies:5}),submittedAt:null,reviewedAt:null}];
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data,revisions}),submitOwnReport:async value=>{payload=C.clone(value);return{status:'pending',version:5};}});await flush();
  assert.match(h.element('#app').innerHTML,/aguarda decisão|Alteração em análise/);h.click('own-report');assert.match(h.element('#modal').innerHTML,/value="5"/);
  await h.submit('modal-form',{participated:'no',studies:'0'});await flush();
  assert.equal(payload.expectedVersion,4);assert.deepEqual(payload.report,{participated:false,hours:null,studies:0});assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.studies,1);
});

test('publisher conflict preserves form values, blocks retries and never offers a group backup',async()=>{
  let submits=0;const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle(),submitOwnReport:async()=>{submits++;throw new errors.ConflictError();}});await flush();
  h.click('own-report');h.input();await h.submit('modal-form',{participated:'yes',studies:'4'});await flush();
  assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);assert.match(h.element('#form-error').textContent,/Preserve os dados digitados/);assert.doesNotMatch(h.element('#app').innerHTML,/backup|Baixar cópia/);
  await h.submit('modal-form',{participated:'yes',studies:'4'});assert.equal(submits,1);assert.equal(h.saveCalls(),0);
});

test('publisher validation preserves unknown participation with zero pioneer hours',async()=>{
  const data=fixture(),month=C.addMonth(data.activeMonth,-1);data.people[0].startMonth=month;data.people[0].roles=[{kind:'regular',start:month,end:null}];let payload;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),submitOwnReport:async p=>{payload=C.clone(p);return{status:'accepted',version:1};}});await flush();
  await h.change('active-month',month);await flush();
  h.click('own-report');await h.submit('modal-form',{participated:'unknown',hours:'0',studies:''});await flush();assert.deepEqual(payload.report,{participated:null,hours:0,studies:null});
  h.click('own-report');payload=null;await h.submit('modal-form',{participated:'yes',hours:'12,345',studies:0});assert.equal(payload,null);assert.match(h.element('#form-error').textContent,/duas casas decimais/);
});

test('publisher monthly navigation stays local, cancels drafts and rejects future months',async()=>{
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle()});await flush();const before=h.window.EmDiaApp.getUI().month;
  h.click('own-report');h.input();h.confirm(false);h.click('prev-month');await flush();assert.equal(h.window.EmDiaApp.getUI().month,before);assert.equal(h.element('#modal').open,true);
  h.confirm(true);h.click('prev-month');await flush();assert.equal(h.window.EmDiaApp.getUI().month,C.addMonth(before,-1));assert.equal(h.element('#modal').open,false);assert.equal(h.saveCalls(),0);
  await h.change('active-month',C.addMonth(C.currentMonth(),1));assert.equal(h.window.EmDiaApp.getUI().month,C.addMonth(before,-1));
});

test('publisher annual consultation is fixed to own person and never offers a consolidated selector',async()=>{
  const data=fixture();data.activeMonth='2024-10';data.people[0].startMonth='2024-01';data.reports['2024-01']={p_fixture:report({participated:false})};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data})});await flush();h.click('person-annual','p_fixture');await flush();
  assert.equal(h.window.EmDiaApp.reportSpec().rows.length,12);assert.match(h.window.EmDiaApp.reportSpec().title,/Pessoa de Teste/);assert.doesNotMatch(h.element('#app').innerHTML,/Todos — consolidado|id="report-person"|id="report-scope"/);
  await h.change('report-person','all');await h.change('report-scope','pending');assert.equal(h.window.EmDiaApp.getUI().person,'p_fixture');assert.equal(h.window.EmDiaApp.getUI().reportScope,'all');
  h.click('person-annual','p_foreign');await flush();assert.match(h.window.EmDiaApp.reportSpec().title,/Pessoa de Teste/);assert.equal(h.saveCalls(),0);
});

test('changing a publisher binding clears its old card before the replacement read finishes',async()=>{
  let person='p_fixture';const second=deferred();const h=harness({profile:async()=>publisherProfile(person),readOwnCard:()=>person==='p_fixture'?Promise.resolve(ownBundle()):second.promise});await flush();
  person='p_next';h.focus();await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste/);
  const data=fixture();data.people[0].id='p_next';data.people[0].name='Novo Cartão Fictício';second.resolve(ownBundle({state:data,personId:'p_next'}));await flush();assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_next');
});

test('a publisher own-card response and pending submission cannot reopen data after sign-out',async()=>{
  const send=deferred();const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle(),submitOwnReport:()=>send.promise});await flush();h.click('own-report');const submitted=h.submit('modal-form',{participated:'yes',studies:'1'});
  h.auth('SIGNED_OUT',null);send.resolve({status:'accepted',version:1});await submitted;await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.element('#modal').innerHTML,'');assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste/);
});

test('manager review ignores the current proposal with CAS and retains the approved data',async()=>{
  const data=fixture(),month=data.activeMonth;data.reports[month]={p_fixture:report({studies:1})};let decisions=[],pending=true;
  const h=harness({read:async()=>({state:data,revision:7}),listRevisions:async()=>({revisions:pending?[pendingRevision()]:[],total:pending?1:0}),reviewRevision:async payload=>{decisions.push(C.clone(payload));pending=false;return{status:'ignored',version:3};}});await flush();
  assert.match(h.element('#mobile-nav').innerHTML,/Revisões \(1\)/);h.click('tab','reviews');await flush();h.click('revision-review','revision_fixture');assert.match(h.element('#modal').innerHTML,/Relatório aprovado|Alteração enviada|Ignorar alteração/);
  await h.submit('modal-form',{},'ignore');await flush();assert.deepEqual(decisions,[{revisionId:'revision_fixture',expectedVersion:2,decision:'ignore'}]);assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.studies,1);assert.match(h.element('#app').innerHTML,/Nenhuma alteração pendente/);assert.equal(h.saveCalls(),0);
});

test('manager acceptance reloads approved data and treats a missing approved report as unknown',async()=>{
  let approved=false,payload;const h=harness({listRevisions:async()=>({revisions:approved?[]:[{...pendingRevision(),approvedReport:null}],total:approved?0:1}),reviewRevision:async value=>{payload=C.clone(value);approved=true;return{status:'accepted',version:3};}});await flush();
  h.click('tab','reviews');await flush();h.click('revision-review','revision_fixture');assert.match(h.element('#modal').innerHTML,/Sem relatório aprovado neste mês/);await h.submit('modal-form');await flush();assert.equal(payload.decision,'accept');assert.match(h.element('#app').innerHTML,/Nenhuma alteração pendente/);
});

test('manager review conflict discards the stale decision and refreshes the proposal version',async()=>{
  let version=2,calls=0;const h=harness({listRevisions:async()=>({revisions:[{...pendingRevision(),version}],total:1}),reviewRevision:async()=>{calls++;version=7;throw new errors.ConflictError();}});await flush();h.click('revision-review','revision_fixture');await h.submit('modal-form');await flush();
  assert.equal(calls,1);assert.equal(h.element('#modal').open,false);h.click('revision-review','revision_fixture');assert.equal(h.element('#modal').open,true);assert.equal(h.saveCalls(),0);
});

test('late manager revision lists cannot display another group\'s proposal after a switch',async()=>{
  const pending=deferred();const h=harness({listRevisions:id=>id==='group_a'?pending.promise:Promise.resolve({revisions:[],total:0})});await flush();h.click('group-open','group_b');await flush();pending.resolve({revisions:[{...pendingRevision(),personName:'Cartão do grupo anterior'}],total:1});await flush();h.click('tab','reviews');await flush();assert.doesNotMatch(h.element('#app').innerHTML,/Cartão do grupo anterior/);assert.doesNotMatch(h.element('#mobile-nav').innerHTML,/Revisões \(1\)/);
});

test('superintendent creates a publisher login only from an existing card and clears its password',async()=>{
  let payload;const h=harness({profile:async()=>({userId:'owner',role:'superintendent',isAdmin:false,defaultGroupId:'group_a'}),createPublisherUser:async value=>{payload={...value};return{userId:'new_publisher'};}});await flush();
  h.click('person-edit','p_fixture');assert.match(h.element('#modal').innerHTML,/Acesso do publicador|Transferir cartão/);h.click('publisher-access','p_fixture');await flush();h.element('#publisher-password').value='Segredo-ficticio-123';
  await h.submit('modal-form',{email:'publicador@example.invalid',password:'Segredo-ficticio-123'});await flush();assert.deepEqual(payload,{email:'publicador@example.invalid',password:'Segredo-ficticio-123',groupId:'group_a',personId:'p_fixture'});assert.equal(h.element('#publisher-password').value,'');assert.equal(h.element('#modal').open,false);assert.equal(h.saveCalls(),0);
});

test('existing publisher accounts are shown without creating duplicates or exposing user identifiers',async()=>{
  let creates=0;const h=harness({publisherAccounts:async()=>[{personId:'p_fixture',userId:'internal_user_id'}],createPublisherUser:async()=>{creates++;}});await flush();h.click('publisher-access','p_fixture');await flush();assert.match(h.element('#modal').innerHTML,/Já existe um acesso/);assert.doesNotMatch(h.element('#modal').innerHTML,/publisher-password|internal_user_id/);await h.submit('modal-form',{email:'test@example.invalid',password:'Segredo-ficticio-123'});assert.equal(creates,0);
});

test('an account lookup cannot open a previous group card after sign-out',async()=>{
  const pending=deferred();const h=harness({publisherAccounts:()=>pending.promise});await flush();h.click('publisher-access','p_fixture');await flush();h.auth('SIGNED_OUT',null);pending.resolve([]);await flush();assert.equal(h.element('#modal').open,false);assert.equal(h.element('#modal').innerHTML,'');
});

test('card transfer requires an explicit destination and acknowledgement then reloads only source group',async()=>{
  let moved=false,payload;const reads=[];const h=harness({read:async id=>{reads.push(id);return{state:moved?C.emptyState():fixture(),revision:7};},transferPublisher:async value=>{payload=C.clone(value);moved=true;return{fromRevision:8,toRevision:3};}});await flush();h.click('publisher-transfer','p_fixture');await flush();assert.match(h.element('#modal').innerHTML,/histórico|Escolha o grupo/);
  await h.submit('modal-form',{toGroupId:'group_b'});assert.equal(payload,undefined);await h.submit('modal-form',{toGroupId:'group_a',agree:'on'});assert.equal(payload,undefined);
  await h.submit('modal-form',{toGroupId:'group_b',agree:'on'});await flush();assert.deepEqual(payload,{fromGroupId:'group_a',toGroupId:'group_b',personId:'p_fixture',expectedRevision:7});assert.deepEqual(reads,['group_a','group_a']);assert.equal(h.window.EmDiaApp.getState().people.length,0);assert.equal(h.saveCalls(),0);
});

test('administrator user settings show three roles and require explicit promotion of a publisher',async()=>{
  let assigned;const h=harness({listUsers:async()=>({users:[{id:'a',email:'admin@example.invalid',role:'admin',groupId:'group_a'},{id:'s',email:'gestor@example.invalid',role:'superintendent',groupId:'group_a'},{id:'p',email:'publicador@example.invalid',role:'publisher',groupId:'group_a'}]}),assignUser:async value=>{assigned=C.clone(value);return{ok:true};}});await flush();h.click('tab','users');await flush();assert.match(h.element('#app').innerHTML,/Administrador|Superintendente|Publicador/);h.click('user-assign','p');assert.match(h.element('#modal').innerHTML,/Transferir cartão|Escolha o novo perfil/);
  await h.submit('modal-form',{groupMode:'existing',groupId:'group_b',role:'publisher'});assert.equal(assigned,undefined);await h.submit('modal-form',{groupMode:'existing',groupId:'group_b'});assert.equal(assigned,undefined);await h.submit('modal-form',{groupMode:'existing',groupId:'group_a',role:'superintendent'});await flush();assert.deepEqual(assigned,{userId:'p',role:'superintendent',groupId:'group_a'});
});

test('self demotion closes the administrator list and group picker before the new profile loads',async()=>{
  let role='admin';const profileRead=deferred();let calls=0;const h=harness({profile:()=>++calls===1?Promise.resolve({userId:'owner',role,isAdmin:true,defaultGroupId:'group_a'}):profileRead.promise,listUsers:async()=>({users:[{id:'owner',email:'admin@example.invalid',role:'admin',groupId:'group_a'}]}),assignUser:async()=>{role='superintendent';return{group:{id:'group_a'}};}});await flush();h.click('tab','users');await flush();h.click('user-assign','owner');const submit=h.submit('modal-form',{groupMode:'existing',groupId:'group_a',role:'superintendent'});await flush();
  assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getGroups().length,0);assert.doesNotMatch(h.element('#app').innerHTML,/admin@example.invalid|group-selector/);profileRead.resolve({userId:'owner',role,isAdmin:false,defaultGroupId:'group_a'});await submit;await flush();assert.equal(h.window.EmDiaApp.getUI().tab,'checklist');assert.doesNotMatch(h.element('#mobile-nav').innerHTML,/Usuários/);
});

test('publisher own-card responses arriving after sign-out remain private',async()=>{
  const card=deferred();const h=harness({profile:async()=>publisherProfile(),readOwnCard:()=>card.promise});await flush();h.auth('SIGNED_OUT',null);card.resolve(ownBundle());await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getSelectedGroup(),null);assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste/);
});

test('publisher without a card binding waits for assignment without reading any group state',async()=>{
  let ownReads=0,groups=0;const h=harness({profile:async()=>publisherProfile(null),readOwnCard:async()=>{ownReads++;},groups:async()=>{groups++;return[];}});await flush();assert.equal(ownReads,0);assert.equal(groups,0);assert.equal(h.window.EmDiaApp.getState(),null);assert.match(h.element('#app').innerHTML,/vincular seu acesso ao seu cartão/);
});

test('an unchanged legacy publisher submission with version zero is accepted without a manager save',async()=>{
  const data=fixture(),month=data.activeMonth;data.reports[month]={p_fixture:report()};let payload;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),submitOwnReport:async value=>{payload=C.clone(value);return{status:'accepted',version:0,unchanged:true};}});await flush();h.click('own-report');await h.submit('modal-form',{participated:'yes',studies:1});await flush();assert.equal(payload.expectedVersion,0);assert.equal(h.element('#modal').open,false);assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.studies,1);assert.equal(h.saveCalls(),0);
});

test('publisher access failure erases the password and never retries automatically',async()=>{
  let creates=0;const h=harness({createPublisherUser:async()=>{creates++;throw new errors.CloudError('Falha fictícia');}});await flush();h.click('publisher-access','p_fixture');await flush();h.element('#publisher-password').value='Segredo-ficticio-123';await h.submit('modal-form',{email:'publicador@example.invalid',password:'Segredo-ficticio-123'});await flush();assert.equal(creates,1);assert.equal(h.element('#publisher-password').value,'');assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getCloudStatus().adminBusy,false);assert.doesNotMatch(h.element('#modal').innerHTML,/Segredo-ficticio-123/);
});

test('provisioning a publisher login reloads the group revision before later manager writes',async()=>{
  let revision=7;const writes=[];const h=harness({read:async()=>({state:fixture(),revision}),createPublisherUser:async()=>{revision=8;return{userId:'publisher_user'};},save:async(state,expected)=>{writes.push(expected);return{state,revision:9};}});await flush();h.click('publisher-access','p_fixture');await flush();await h.submit('modal-form',{email:'publicador@example.invalid',password:'Segredo-ficticio-123'});await flush();assert.equal(h.window.EmDiaApp.getCloudStatus().revision,8);h.click('quick-receive','p_fixture');await flush();assert.deepEqual(writes,[8]);
});

test('opening help can preserve unsent own activities when discard is cancelled',async()=>{
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle()});await flush();h.click('own-report');h.input();h.confirm(false);h.click('help');await flush();assert.match(h.element('#modal').innerHTML,/Enviar atividades/);assert.doesNotMatch(h.element('#modal').innerHTML,/Como usar meu cartão/);
});

test('a continuing pioneer opens the current diary while preserving the group reference month',async()=>{
  const data=pioneerFixture(),reference=data.activeMonth,reads=[];
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async month=>{reads.push(month);return hoursBundle(month);}});await flush();
  assert.equal(h.window.EmDiaApp.getUI().month,testToday().slice(0,7));assert.equal(h.window.EmDiaApp.getState().activeMonth,reference);
  assert.match(h.element('#app').innerHTML,/Diário de horas|0h00|0 dias lançados/);assert.deepEqual(reads,[testToday().slice(0,7)]);
  await h.change('active-month',reference);await flush();h.focus();await flush();assert.equal(h.window.EmDiaApp.getUI().month,reference);assert.equal(h.saveCalls(),0);
});

test('the diary follows auxiliary periods and ordinary publishers never request it',async()=>{
  const data=pioneerFixture('auxiliary'),month=data.activeMonth;data.people[0].roles[0].end=month;let reads=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>{reads++;return hoursBundle(requested,{}, {kind:'auxiliary'});}});await flush();
  assert.equal(h.window.EmDiaApp.getUI().month,month);assert.match(h.element('#app').innerHTML,/Diário de horas/);
  await h.change('active-month',testToday().slice(0,7));await flush();assert.equal(reads,1);assert.doesNotMatch(h.element('#app').innerHTML,/Diário de horas/);
  h.click('own-hours-edit');await flush();assert.equal(h.element('#modal').open,false);
  let ordinaryReads=0;const ordinary=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle(),readOwnHours:async()=>{ordinaryReads++;}});await flush();assert.equal(ordinaryReads,0);
});

test('received pioneer history controls diary eligibility even after the roster period ended',async()=>{
  const data=fixture(),month=C.addMonth(data.activeMonth,-1);data.activeMonth=month;data.people[0].startMonth=month;data.reports[month]={p_fixture:report({kind:'auxiliary',hours:15})};let reads=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>{reads++;return hoursBundle(requested,{}, {kind:'auxiliary'});}});await flush();
  assert.equal(reads,1);assert.match(h.element('#app').innerHTML,/Diário de horas/);assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,15);
});

test('saving a day waits for cloud confirmation and never changes the received monthly hours',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday(),pending=deferred();let payload,calls=0;
  data.reports[month]={p_fixture:report({kind:'regular',hours:55,studies:4})};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),saveOwnHoursLaunch:value=>{payload=C.clone(value);calls++;return pending.promise;}});await flush();
  assert.match(h.element('#app').innerHTML,/0h00/);h.click('own-hours-edit');h.input();const saving=h.submit('modal-form',{date,dayHours:'1',dayMinutes:'30'});
  assert.deepEqual(payload,{id:freshLaunchId(1),date,minutes:90,expectedVersion:0});assert.equal(calls,1);assert.match(h.element('#app').innerHTML,/0h00/);assert.equal(h.element('#modal').open,true);
  pending.resolve(launchBundle(month,[{id:payload.id,date,minutes:90}]));await saving;await flush();assert.match(h.element('#app').innerHTML,/1h30|1 dia lançado/);
  assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,55);assert.equal(h.window.EmDiaApp.getCloudStatus().revision,7);assert.equal(h.saveCalls(),0);assert.equal(h.element('#modal').open,false);
});

test('day validation keeps blanks unknown, accepts explicit zero, and rejects invalid dates or durations',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7);let calls=0,payload;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),saveOwnHoursLaunch:async value=>{calls++;payload=C.clone(value);return launchBundle(month,[{id:value.id,date:value.date,minutes:value.minutes}]);}});await flush();h.click('own-hours-edit');
  for(const fields of [{date:testToday(),dayHours:'',dayMinutes:''},{date:month+'-32',dayHours:'1'},{date:C.addMonth(month,1)+'-01',dayHours:'1'},{date:testToday(),dayHours:'24',dayMinutes:'1'},{date:testToday(),dayHours:'1.5'},{date:testToday(),dayHours:'-1'},{date:testToday(),dayHours:'1',dayMinutes:'60'}]){await h.submit('modal-form',fields);assert.equal(calls,0);}
  await h.submit('modal-form',{date:testToday(),dayHours:'',dayMinutes:'0'});await flush();assert.equal(calls,1);assert.equal(payload.minutes,0);assert.match(h.element('#app').innerHTML,/0h00|1 dia lançado/);
});

test('a new launch on a saved date adds a second session without replacing the first',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday(),first={id:launchIdForDate(date),date,minutes:90};let calls=0,payload;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>launchBundle(month,[first],{version:3}),
    saveOwnHoursLaunch:async value=>{calls++;payload=C.clone(value);return launchBundle(month,[first,{id:value.id,date:value.date,minutes:value.minutes}],{version:4});}});await flush();h.click('own-hours-edit');h.confirm(false);
  await h.submit('modal-form',{date,dayHours:'2'});await flush();assert.equal(calls,1);assert.equal(h.element('#modal').open,false);
  assert.notEqual(payload.id,first.id);assert.equal(payload.expectedVersion,3);assert.match(h.element('#app').innerHTML,/3h30/);
  assert.match(h.element('#app').innerHTML,/2 lançamentos em 1 dia/);assert.match(h.element('#app').innerHTML,/Ver lançamentos \(2\)/);
  assert.match(h.element('#app').innerHTML,/Total do dia: 3h30/);assert.ok(h.element('#app').innerHTML.includes('data-id="'+first.id+'"'));
  assert.equal(h.saveCalls(),0);
});

test('editing and removing one day use the diary version without changing approved records',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,date=month+'-01',other=month+'-02',payloads=[];let entries={[date]:60,[other]:30},version=4;
  data.reports[month]={p_fixture:report({kind:'regular',hours:55})};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?entries:{},{version:requested===month?version:0}),saveOwnHoursLaunch:async value=>{payloads.push(C.clone(value));if(value.minutes===null)delete entries[value.date];else entries[value.date]=value.minutes;return hoursBundle(month,entries,{version:++version});}});await flush();await h.change('active-month',month);await flush();
  h.click('own-hours-edit',launchIdForDate(date));assert.match(h.element('#modal').innerHTML,/value="1"|readonly/);await h.submit('modal-form',{date:other,dayHours:'2',dayMinutes:'15'});await flush();
  assert.deepEqual(payloads[0],{id:launchIdForDate(date),date,minutes:135,expectedVersion:4});h.click('own-hours-edit',launchIdForDate(date));await h.submit('modal-form',{},'remove');await flush();assert.deepEqual(payloads[1],{id:launchIdForDate(date),date,minutes:null,expectedVersion:5});
  assert.match(h.element('#app').innerHTML,/0h30|1 dia lançado/);assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,55);assert.equal(h.saveCalls(),0);
});

test('current pioneer months keep drafts available but refuse both final submission paths',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7);let submits=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>hoursBundle(month,{[testToday()]:60}),submitOwnHours:async()=>{submits++;},submitOwnReport:async()=>{submits++;}});await flush();
  assert.match(h.element('#app').innerHTML,/data-action="own-hours-submit" disabled/);h.click('own-hours-submit');await flush();assert.equal(h.element('#modal').open,false);
  h.click('own-report');await flush();assert.equal(h.element('#modal').open,false);assert.equal(submits,0);h.click('own-hours-edit');assert.equal(h.element('#modal').open,true);
});

test('an empty closed diary cannot turn an unknown monthly total into zero',async()=>{
  const data=pioneerFixture(),month=data.activeMonth;let submits=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),submitOwnHours:async()=>{submits++;}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-submit');await flush();
  assert.equal(h.element('#modal').open,false);assert.equal(submits,0);assert.match(h.element('#app').innerHTML,/data-action="own-hours-submit" disabled/);
});

test('closed diary submission sends versions and monthly studies without accepting a client total',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,entries={[month+'-01']:90,[month+'-02']:45};let payload;
  data.reports[month]={p_fixture:report({kind:'regular',hours:55,studies:4})};const revisions=[{id:'own_pending',month,status:'pending',version:4,report:activity({kind:'regular',hours:60,studies:6})}];
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data,revisions}),readOwnHours:async requested=>hoursBundle(requested,requested===month?entries:{},{version:requested===month?7:0}),submitOwnHours:async value=>{payload=C.clone(value);return{status:'pending',version:5,hoursVersion:7,totalMinutes:135};}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-submit');
  assert.match(h.element('#modal').innerHTML,/2h15|2,25|Participação: Sim/);assert.doesNotMatch(h.element('#modal').innerHTML,/name="hours"|name="participated"/);
  await h.submit('modal-form',{participated:'no',studies:'7',hours:'999',totalMinutes:'99999',kind:'publisher'});await flush();
  assert.deepEqual(payload,{month,participated:true,studies:7,expectedHoursVersion:7,expectedReportVersion:4});assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,55);assert.match(h.element('#app').innerHTML,/2h15/);assert.equal(h.saveCalls(),0);
});

test('a first diary submission does not mark the monthly card received before confirmation',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,pending=deferred();let calls=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?{[month+'-01']:60}:{}),submitOwnHours:()=>{calls++;return pending.promise;}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-submit');const submitted=h.submit('modal-form',{studies:'2'});
  assert.equal(C.getReport(h.window.EmDiaApp.getState(),'p_fixture',month),null);assert.equal(calls,1);data.reports[month]={p_fixture:report({kind:'regular',hours:1,studies:2})};pending.resolve({status:'accepted',version:1,hoursVersion:1,totalMinutes:60});await submitted;await flush();
  assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,1);assert.equal(h.element('#modal').open,false);
});

test('a deliberately zero diary preserves unknown participation and studies',async()=>{
  const data=pioneerFixture(),month=data.activeMonth;let payload;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?{[month+'-01']:0}:{}),submitOwnHours:async value=>{payload=C.clone(value);return{status:'accepted',version:1,hoursVersion:1,totalMinutes:0};}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-submit');
  assert.match(h.element('#modal').innerHTML,/name="participated"/);await h.submit('modal-form',{participated:'unknown',studies:''});await flush();assert.equal(payload.participated,null);assert.equal(payload.studies,null);assert.equal(payload.expectedHoursVersion,1);
});

test('a failed day save preserves the form, blocks duplicate attempts and reloads only after draft confirmation',async()=>{
  const data=pioneerFixture();let calls=0,reads=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async month=>{reads++;return hoursBundle(month);},saveOwnHoursLaunch:async()=>{calls++;throw new errors.ConflictError();}});await flush();h.click('own-hours-edit');h.input();h.element('#hours-duration').value='2';await h.submit('modal-form',{date:testToday(),dayHours:'2'});await flush();
  assert.equal(h.element('#modal').open,true);assert.equal(h.element('#hours-duration').value,'2');assert.match(h.element('#form-error').textContent,/Preserve o que digitou/);assert.equal(h.saveCalls(),0);
  await h.submit('modal-form',{date:testToday(),dayHours:'2'});assert.equal(calls,1);h.confirm(false);h.click('own-hours-refresh');await flush();assert.equal(reads,1);assert.equal(h.element('#modal').open,true);
  h.confirm(true);h.click('own-hours-refresh');await flush();assert.equal(reads,2);assert.equal(h.element('#modal').open,false);
});

test('failed monthly diary submission retains the saved diary and protects the unsent form',async()=>{
  const data=pioneerFixture(),month=data.activeMonth;let calls=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?{[month+'-01']:90}:{}),submitOwnHours:async()=>{calls++;throw new errors.ConflictError();}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-submit');h.input();await h.submit('modal-form',{studies:'2'});await flush();
  assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);assert.match(h.element('#app').innerHTML,/1h30/);assert.equal(C.getReport(h.window.EmDiaApp.getState(),'p_fixture',month),null);
  await h.submit('modal-form',{studies:'2'});assert.equal(calls,1);assert.equal(h.saveCalls(),0);
});

test('diary drafts are preserved when month, help or another day discard is cancelled',async()=>{
  const data=pioneerFixture(),h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data})});await flush();const month=h.window.EmDiaApp.getUI().month;
  h.click('own-hours-edit');h.input();h.confirm(false);h.click('prev-month');h.click('help');h.click('own-hours-edit');h.click('tab','reports');await flush();
  assert.equal(h.window.EmDiaApp.getUI().month,month);assert.equal(h.window.EmDiaApp.getUI().tab,'my-card');assert.match(h.element('#modal').innerHTML,/Novo lançamento de horas/);assert.equal(h.element('#modal').open,true);
});

test('a late diary read cannot replace the selected month or reopen data after sign-out',async()=>{
  const data=pioneerFixture(),current=testToday().slice(0,7),previous=data.activeMonth,pending=deferred();
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:month=>month===current?pending.promise:Promise.resolve(hoursBundle(month,{[month+'-01']:120}))});await flush();await h.change('active-month',previous);await flush();pending.resolve(hoursBundle(current,{[testToday()]:180}));await flush();
  assert.equal(h.window.EmDiaApp.getUI().month,previous);assert.match(h.element('#app').innerHTML,/2h00/);assert.doesNotMatch(h.element('#app').innerHTML,/3h00/);
  const waiting=deferred(),out=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:()=>waiting.promise});await flush();out.auth('SIGNED_OUT',null);waiting.resolve(hoursBundle(current,{[testToday()]:777}));await flush();assert.equal(out.window.EmDiaApp.getState(),null);assert.doesNotMatch(out.element('#app').innerHTML,/Diário de horas|12h57/);
});

test('diary responses with a foreign binding or changed pioneer condition fail before rendering entries',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday();
  for(const changes of [{groupId:'group_foreign'},{personId:'p_foreign'},{month:C.addMonth(month,-1)},{kind:'auxiliary'},{totalMinutes:1},{entries:{[month+'-32']:777},totalMinutes:777}]){
    const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>hoursBundle(month,{[date]:777},changes)});await flush();
    assert.doesNotMatch(h.element('#app').innerHTML,/12h57/);assert.match(h.element('#app').innerHTML,/Não foi possível carregar o diário/);h.click('own-hours-edit');await flush();assert.equal(h.element('#modal').open,false);
  }
});

test('a diary save response cannot restore a previous publisher binding after sign-out',async()=>{
  const data=pioneerFixture(),pending=deferred(),h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),saveOwnHoursLaunch:()=>pending.promise});await flush();h.click('own-hours-edit');const submitted=h.submit('modal-form',{date:testToday(),dayHours:'2'});
  h.auth('SIGNED_OUT',null);pending.resolve(hoursBundle(testToday().slice(0,7),{[testToday()]:120}));await submitted;await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.element('#modal').innerHTML,'');assert.doesNotMatch(h.element('#app').innerHTML,/Diário de horas|2h00/);
});

test('a replaced publisher binding clears the previous diary before its delayed response arrives',async()=>{
  const data=pioneerFixture(),pending=deferred(),month=testToday().slice(0,7);let personId='p_fixture';
  const h=harness({profile:async()=>publisherProfile(personId),readOwnCard:async()=>{const own=C.clone(data);own.people[0].id=personId;return ownBundle({state:own,personId});},readOwnHours:()=>personId==='p_fixture'?pending.promise:Promise.resolve(hoursBundle(month,{[testToday()]:30},{personId}))});await flush();
  personId='p_next';h.focus();await flush();assert.equal(h.window.EmDiaApp.getState().people[0].id,'p_next');assert.match(h.element('#app').innerHTML,/0h30/);
  pending.resolve(hoursBundle(month,{[testToday()]:120}));await flush();assert.match(h.element('#app').innerHTML,/0h30/);assert.doesNotMatch(h.element('#app').innerHTML,/2h00/);
});

test('a late final diary submission cannot reopen the card or diary after sign-out',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,pending=deferred();let reads=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>{reads++;return hoursBundle(requested,requested===month?{[month+'-01']:60}:{});},submitOwnHours:()=>pending.promise});await flush();await h.change('active-month',month);await flush();h.click('own-hours-submit');const submitted=h.submit('modal-form',{studies:'1'}),before=reads;
  h.auth('SIGNED_OUT',null);pending.resolve({status:'accepted',version:1,hoursVersion:1,totalMinutes:60});await submitted;await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(reads,before);assert.equal(h.element('#modal').innerHTML,'');assert.doesNotMatch(h.element('#app').innerHTML,/Diário de horas|Pessoa de Teste/);
});

function monthlyGoalMarkup(h){
  return h.element('#app').innerHTML.match(/<div class="hours-goal"[\s\S]*?<\/div>(?=<p class="help">Salve)/)?.[0]||'';
}

test('regular monthly progress uses only saved diary minutes and performs no writes',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday();let diaryWrites=0,reportWrites=0;
  data.reports[month]={p_fixture:report({kind:'regular',hours:62.5})};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>hoursBundle(month,{[date]:320}),saveOwnHoursLaunch:async()=>{diaryWrites++;},submitOwnHours:async()=>{reportWrites++;}});await flush();
  const goal=monthlyGoalMarkup(h);assert.match(goal,/Meta mensal/);assert.match(goal,/>50h</);assert.match(goal,/Registradas no diário/);assert.match(goal,/5h20/);assert.match(goal,/44h40/);assert.match(goal,/10,7% da meta/);
  assert.match(goal,/incluindo hoje/);assert.match(goal,/role="progressbar"/);assert.match(goal,/aria-valuenow="10.7"/);assert.doesNotMatch(goal,/62,5|600h|Meta anual/);
  assert.equal(diaryWrites,0);assert.equal(reportWrites,0);assert.equal(h.saveCalls(),0);assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,62.5);
});

test('auxiliary pioneer months keep their diary summary without the regular target',async()=>{
  const data=pioneerFixture('auxiliary'),month=testToday().slice(0,7);
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>hoursBundle(month,{[testToday()]:320},{kind:'auxiliary'})});await flush();
  assert.match(h.element('#app').innerHTML,/5h20/);assert.equal(monthlyGoalMarkup(h),'');assert.doesNotMatch(h.element('#app').innerHTML,/Meta mensal|Média necessária|% da meta/);assert.equal(h.saveCalls(),0);
});

test('loading and failed diary reads never display a fabricated zero goal and can recover',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),pending=deferred();let reads=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:()=>++reads===1?pending.promise:Promise.resolve(hoursBundle(month,{[testToday()]:320}))});await flush();
  assert.equal(monthlyGoalMarkup(h),'');assert.doesNotMatch(h.element('#app').innerHTML,/0% da meta|class="hours-goal-progress"/);assert.match(h.element('#app').innerHTML,/Carregando diário/);
  pending.reject(new errors.CloudError('Test unavailable'));await flush();assert.equal(monthlyGoalMarkup(h),'');assert.match(h.element('#app').innerHTML,/Não foi possível carregar o diário/);
  h.click('own-hours-refresh');await flush();assert.match(monthlyGoalMarkup(h),/5h20|44h40/);assert.equal(reads,2);assert.equal(h.saveCalls(),0);
});

test('a closed month without diary entries has a neutral target even when an approved total exists',async()=>{
  const data=pioneerFixture(),month=data.activeMonth;data.reports[month]={p_fixture:report({kind:'regular',hours:62.5})};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data})});await flush();await h.change('active-month',month);await flush();
  const goal=monthlyGoalMarkup(h);assert.match(goal,/Meta mensal/);assert.match(goal,/>50h</);assert.match(goal,/Sem lançamentos no diário neste mês/);
  assert.doesNotMatch(goal,/Faltam|Faltaram|0h00|progressbar|% da meta|\/dia/);assert.equal(h.window.EmDiaApp.getState().reports[month].p_fixture.hours,62.5);assert.equal(h.saveCalls(),0);
});

test('an explicitly zero closed diary shows its recorded shortfall without a future daily pace',async()=>{
  const data=pioneerFixture(),month=data.activeMonth;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?{[month+'-01']:0}:{})});await flush();await h.change('active-month',month);await flush();
  const goal=monthlyGoalMarkup(h);assert.match(goal,/Faltaram/);assert.match(goal,/50h00/);assert.match(goal,/0% da meta/);assert.match(goal,/Mês encerrado/);assert.doesNotMatch(goal,/Sem lançamentos|\/dia|incluindo hoje/);
});

test('exact target and surplus show achieved progress with a capped accessible bar',async()=>{
  for(const [total,percent,excess] of [[3000,'100',''],[3200,'106,7','3h20']]){
    const data=pioneerFixture(),month=data.activeMonth,entries={[month+'-01']:1440,[month+'-02']:1440,[month+'-03']:total-2880};
    const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?entries:{})});await flush();await h.change('active-month',month);await flush();
    const goal=monthlyGoalMarkup(h);assert.match(goal,/Meta de horas atingida/);assert.ok(goal.includes(percent+'% da meta'));assert.match(goal,/aria-valuenow="100"/);assert.match(goal,/width:100%/);assert.doesNotMatch(goal,/\/dia|incluindo hoje|width:106/);
    if(excess)assert.ok(goal.includes(excess+' além da meta.'));else assert.doesNotMatch(goal,/além da meta/);assert.equal(h.saveCalls(),0);
  }
});

test('one remaining minute is never labelled as a completed monthly target',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,entries={[month+'-01']:1440,[month+'-02']:1440,[month+'-03']:119};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>hoursBundle(requested,requested===month?entries:{})});await flush();await h.change('active-month',month);await flush();
  const goal=monthlyGoalMarkup(h);assert.match(goal,/49h59/);assert.match(goal,/0h01/);assert.match(goal,/99,9% da meta/);assert.match(goal,/aria-valuenow="99.9"/);assert.doesNotMatch(goal,/Meta de horas atingida|>100% da meta/);
});

test('the dashboard changes only after a day save is confirmed and stays out of the group state',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday(),pending=deferred();
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>hoursBundle(month,{[date]:320}),saveOwnHoursLaunch:()=>pending.promise});await flush();
  h.click('own-hours-edit',launchIdForDate(date));const submitted=h.submit('modal-form',{dayHours:'2'});assert.match(monthlyGoalMarkup(h),/5h20|44h40/);
  pending.resolve(hoursBundle(month,{[date]:120},{version:2}));await submitted;await flush();const goal=monthlyGoalMarkup(h);assert.match(goal,/2h00/);assert.match(goal,/48h00/);assert.doesNotMatch(goal,/5h20/);assert.equal(h.saveCalls(),0);assert.equal(h.window.EmDiaApp.getState().people.length,1);
});

test('a blocked stale diary stops presenting monthly progress until a successful reload',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7);let reads=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>{if(++reads===2)throw new errors.CloudError('Test unavailable');return hoursBundle(month,{[testToday()]:320});}});await flush();
  assert.match(monthlyGoalMarkup(h),/5h20/);h.click('own-hours-refresh');await flush();assert.equal(monthlyGoalMarkup(h),'');assert.match(h.element('#app').innerHTML,/Não foi possível carregar o diário/);
  h.click('own-hours-refresh');await flush();assert.match(monthlyGoalMarkup(h),/44h40/);assert.equal(h.saveCalls(),0);
});

test('launch lists group sessions by day while the monthly goal counts distinct days',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,first=month+'-01',second=month+'-02';
  const launches=[{id:freshLaunchId(21),date:first,minutes:50},{id:freshLaunchId(22),date:first,minutes:75},{id:freshLaunchId(23),date:second,minutes:60}];
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>launchBundle(requested,requested===month?launches:[])});await flush();await h.change('active-month',month);await flush();
  const html=h.element('#app').innerHTML;assert.match(html,/3 lançamentos em 2 dias/);assert.match(html,/Total do dia: 2h05/);assert.match(html,/Total do dia: 1h00/);
  assert.equal((html.match(/class="hours-day"/g)||[]).length,2);assert.equal((html.match(/class="hours-launch-order"/g)||[]).length,3);
  assert.match(monthlyGoalMarkup(h),/3h05/);assert.equal(h.saveCalls(),0);
});

test('editing one same-day session preserves every other launch and ignores a changed form date',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,date=month+'-01',other=month+'-02';let payload;
  const first={id:freshLaunchId(31),date,minutes:60},second={id:freshLaunchId(32),date,minutes:45};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>launchBundle(requested,requested===month?[first,second]:[],{version:requested===month?6:0}),
    saveOwnHoursLaunch:async value=>{payload=C.clone(value);return launchBundle(month,[{...first,minutes:value.minutes},second],{version:7});}});await flush();await h.change('active-month',month);await flush();
  h.click('own-hours-edit',first.id);assert.match(h.element('#modal').innerHTML,/Editar lançamento|readonly|Remover lançamento/);
  await h.submit('modal-form',{date:other,dayHours:'2',dayMinutes:'15'});await flush();
  assert.deepEqual(payload,{id:first.id,date,minutes:135,expectedVersion:6});assert.match(h.element('#app').innerHTML,/Total do dia: 3h00/);
  assert.ok(h.element('#app').innerHTML.includes('data-id="'+second.id+'"'));assert.match(h.element('#app').innerHTML,/0h45/);assert.equal(h.saveCalls(),0);
});

test('removing one launch keeps another session on that date and can be cancelled',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,date=month+'-01';let payload,calls=0;
  const first={id:freshLaunchId(41),date,minutes:60},second={id:freshLaunchId(42),date,minutes:45};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>launchBundle(requested,requested===month?[first,second]:[],{version:requested===month?3:0}),
    saveOwnHoursLaunch:async value=>{calls++;payload=C.clone(value);return launchBundle(month,[second],{version:4});}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-edit',first.id);
  h.confirm(false);await h.submit('modal-form',{},'remove');assert.equal(calls,0);assert.equal(h.element('#modal').open,true);
  h.confirm(true);await h.submit('modal-form',{},'remove');await flush();assert.deepEqual(payload,{id:first.id,date,minutes:null,expectedVersion:3});
  assert.match(h.element('#app').innerHTML,/1 lançamento em 1 dia/);assert.match(h.element('#app').innerHTML,/Total do dia: 0h45/);assert.ok(!h.element('#app').innerHTML.includes('data-id="'+first.id+'"'));assert.equal(h.saveCalls(),0);
});

test('a saved zero session remains explicit beside another session on the same date',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday(),first={id:freshLaunchId(51),date,minutes:40};let payload;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>launchBundle(month,[first]),
    saveOwnHoursLaunch:async value=>{payload=C.clone(value);return launchBundle(month,[first,{id:value.id,date,minutes:value.minutes}],{version:2});}});await flush();h.click('own-hours-edit');
  await h.submit('modal-form',{date,dayHours:'',dayMinutes:'0'});await flush();assert.equal(payload.minutes,0);assert.match(h.element('#app').innerHTML,/2 lançamentos em 1 dia/);assert.match(h.element('#app').innerHTML,/Total do dia: 0h40/);
});

test('the sum of a day cannot exceed 24 hours but a monthly total above the target accepts another launch',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,date=month+'-03';let calls=0;
  const launches=[{id:freshLaunchId(61),date:month+'-01',minutes:1440},{id:freshLaunchId(62),date:month+'-02',minutes:1440},{id:freshLaunchId(63),date,minutes:120}];
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>launchBundle(requested,requested===month?launches:[],{version:requested===month?3:0}),
    saveOwnHoursLaunch:async value=>{calls++;return launchBundle(month,[...launches,{id:value.id,date:value.date,minutes:value.minutes}],{version:4});}});await flush();await h.change('active-month',month);await flush();
  assert.match(monthlyGoalMarkup(h),/Meta de horas atingida/);h.click('own-hours-edit');await h.submit('modal-form',{date:month+'-01',dayHours:'1'});assert.equal(calls,0);assert.match(h.element('#form-error').textContent,/mais de 24 horas/);
  await h.submit('modal-form',{date,dayHours:'3'});await flush();assert.equal(calls,1);assert.match(monthlyGoalMarkup(h),/53h00|3h00 além da meta/);assert.match(h.element('#app').innerHTML,/Total do dia: 5h00/);assert.equal(h.saveCalls(),0);
});

test('editing a launch subtracts its own minutes when checking the daily 24 hour limit',async()=>{
  const data=pioneerFixture(),month=data.activeMonth,date=month+'-01';let calls=0;
  const first={id:freshLaunchId(71),date,minutes:840},second={id:freshLaunchId(72),date,minutes:600};
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async requested=>launchBundle(requested,requested===month?[first,second]:[],{version:requested===month?2:0}),
    saveOwnHoursLaunch:async value=>{calls++;return launchBundle(month,[{...first,minutes:value.minutes},second],{version:3});}});await flush();await h.change('active-month',month);await flush();h.click('own-hours-edit',first.id);
  await h.submit('modal-form',{dayHours:'14',dayMinutes:'1'});assert.equal(calls,0);await h.submit('modal-form',{dayHours:'13',dayMinutes:'30'});await flush();assert.equal(calls,1);assert.match(h.element('#app').innerHTML,/Total do dia: 23h30/);
});

test('duplicate, foreign-date or inconsistent launch arrays fail before any entries are displayed',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday(),id=freshLaunchId(81);
  const invalid=[
    {launches:undefined},
    {launches:[{id,date,minutes:5},{id:id.toUpperCase(),date,minutes:5}]},
    {launches:[{id,date:C.addMonth(month,-1)+'-01',minutes:10}]},
    {launches:[{id:'not-a-uuid',date,minutes:10}]},
    {launches:[{id,date,minutes:11}]},
    {launches:[{id,date,minutes:-1}]},
    {launches:[{id,date,minutes:1440},{id:freshLaunchId(82),date,minutes:1}],entries:{[date]:1441},totalMinutes:1441}
  ];
  for(const changes of invalid){const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>hoursBundle(month,{[date]:10},changes)});await flush();
    assert.match(h.element('#app').innerHTML,/Não foi possível carregar o diário/);assert.doesNotMatch(h.element('#app').innerHTML,/data-id="20000000/);h.click('own-hours-edit');await flush();assert.equal(h.element('#modal').open,false);}
});

test('new launch identifiers stay fixed for a pending submit and are never reused for the next form',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday(),pending=deferred(),payloads=[];let launches=[],version=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),readOwnHours:async()=>launchBundle(month,launches,{version}),
    saveOwnHoursLaunch:value=>{payloads.push(C.clone(value));return pending.promise;}});await flush();h.click('own-hours-edit');
  const save=h.submit('modal-form',{date,dayHours:'1'});await h.submit('modal-form',{date,dayHours:'1'});assert.equal(payloads.length,1);
  launches=[{id:payloads[0].id,date,minutes:60}];version=1;pending.resolve(launchBundle(month,launches,{version}));await save;await flush();
  h.cloud.saveOwnHoursLaunch=async value=>{payloads.push(C.clone(value));launches.push({id:value.id,date,minutes:value.minutes});return launchBundle(month,launches,{version:2});};h.click('own-hours-edit');await h.submit('modal-form',{date,dayMinutes:'20'});await flush();
  assert.equal(payloads.length,2);assert.notEqual(payloads[0].id,payloads[1].id);assert.match(h.element('#app').innerHTML,/Total do dia: 1h20/);
});

test('ambiguous save confirmations retain the draft and never display an unconfirmed session',async()=>{
  const data=pioneerFixture(),month=testToday().slice(0,7),date=testToday();let calls=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),saveOwnHoursLaunch:async()=>{calls++;return launchBundle(month,[{id:freshLaunchId(99),date,minutes:60}],{version:1});}});await flush();h.click('own-hours-edit');h.input();await h.submit('modal-form',{date,dayHours:'1'});await flush();
  assert.equal(calls,1);assert.equal(h.element('#modal').open,true);assert.match(h.element('#form-error').textContent,/Não foi possível confirmar/);assert.doesNotMatch(h.element('#app').innerHTML,/data-id="20000000-0000-4000-8000-000000000099"/);assert.equal(h.saveCalls(),0);
});

test('an unavailable secure identifier generator never sends a new launch',async()=>{
  const data=pioneerFixture();let calls=0;
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle({state:data}),saveOwnHoursLaunch:async()=>{calls++;}});await flush();h.window.crypto={};h.click('own-hours-edit');await flush();assert.equal(h.element('#modal').open,false);assert.equal(calls,0);
});
