/* UI lifecycle checks with an isolated DOM and cloud boundary; no real records. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const C = require('../assets/core.js');
const PDF = require('../assets/pdf.js');
const errors = require('../assets/cloud.js');
const appCode = fs.readFileSync(require.resolve('../assets/app.js'), 'utf8');
const PROFILE_AVATAR='data:image/jpeg;base64,/9j/2Q==',PROFILE_AVATAR_B='data:image/jpeg;base64,/9j/Af/Z';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const flush = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
const testToday=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function fixture() {
  const state = C.emptyState();
  state.people.push({id:'p_fixture',name:'Pessoa de Teste',startMonth:state.activeMonth,endMonth:null,notes:'',roles:[]});
  return state;
}
function harness(overrides={},options={}) {
  const elements = new Map(), docEvents = new Map(), winEvents = new Map(), downloads = [],notifications=[],intervals=new Map(),submittedForms=[];let intervalId=0,clock=options.now??Date.now(),offlineAdapter=null,accountAdapter=null;
  function element(selector='') {
    if (elements.has(selector)) return elements.get(selector);
    const classes=new Set(),passwordIds=['#account-current-password','#account-new-password','#account-confirm-password'];
    const el={innerHTML:'',textContent:'',style:{},dataset:{},disabled:false,open:false,hidden:false,isConnected:true,value:'',id:selector.startsWith('#')?selector.slice(1):'',type:passwordIds.includes(selector)?'password':'',
      classList:{toggle(name,value){if(value)classes.add(name);else classes.delete(name);},contains(name){return classes.has(name);}},
      append(child){if(selector==='#toasts')notifications.push(child.textContent);},remove(){},focus(){},select(){},click(){},scrollIntoView(){},checkValidity(){return true;},
      showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,fn){this[name]=fn;}};
    elements.set(selector,el); return el;
  }
  const document={querySelector:element,querySelectorAll:selector=>selector.startsWith('#modal input[type="password"]')?[...elements.entries()].filter(([key,value])=>key.startsWith('#account-')&&(value.type==='password'||key==='#account-password-nonce')&&element('#modal').innerHTML.includes('id="'+value.id+'"')).map(([,value])=>value):[],activeElement:element('active'),visibilityState:'visible',
    body:{style:{},append(){},classList:{toggle(){}}},createElement:()=>element('new-'+elements.size),
    addEventListener(name,fn){docEvents.set(name,fn);}};
  let currentSession={user:{id:'owner'}}, authCallback, saveCalls=0,confirmResult=true,launchCounter=0;
  const defaultGroups=[{id:'group_a',name:'Grupo de Teste A',createdAt:null},{id:'group_b',name:'Grupo de Teste B',createdAt:null}];
  const cloud={session:async()=>currentSession,profile:async()=>({userId:currentSession?.user.id,isAdmin:true,role:'admin',defaultGroupId:'group_a'}),
    groups:async()=>defaultGroups,listRevisions:async()=>({revisions:[],total:0}),publisherAccounts:async()=>[],transferGroups:async()=>defaultGroups,createPublisherUser:async()=>({userId:'publisher_user'}),transferPublisher:async()=>({}),readOwnHours:async month=>hoursBundle(month),
    createGroup:async name=>({id:'group_c',name}),listUsers:async()=>({users:[]}),createUser:async()=>({ok:true}),assignUser:async()=>({ok:true}),read:async()=>({state:fixture(),revision:7,updatedAt:null}),
    save:async state=>({state,revision:8,updatedAt:null}),login:async()=>({sent:true}),loginPassword:async()=>({signedIn:true}),
    readOwnTimer:async()=>timerBundle(),readOwnAnnual:async year=>annualBundle(year),logout:async()=>{},subscribeAuth(fn){authCallback=fn;return()=>{};},...overrides};
  const originalSave=cloud.save;cloud.save=(...args)=>{saveCalls++;return originalSave(...args);};
  const window={EmDiaCore:options.core||C,EMDIA_CLOUD_CONFIG:{url:'https://example.invalid',publishableKey:'test-public-key'},
    supabase:{createClient:()=>({})},EmDiaCloud:{...errors,create:()=>cloud},
    crypto:{randomUUID:()=>freshLaunchId(++launchCounter)},scrollTo(){},addEventListener(name,fn){winEvents.set(name,fn);}};
  if(options.offlineFactory)window.EmDiaOffline={create(args){offlineAdapter=options.offlineFactory(args);return offlineAdapter;}};
  if(options.accountFactory)window.EmDiaAccount={create(args){accountAdapter=options.accountFactory(args);return accountAdapter;},prepareAvatar:options.prepareAvatar||(async()=>PROFILE_AVATAR)};
  if(options.theme)window.EmDiaTheme=options.theme;
  window.EmDiaAccess={create(args){const api=options.accessFactory?options.accessFactory(args):{storage:{},identity:()=>{try{return JSON.parse(options.storage?.getItem('em-dia-auth-v1')||'null')?.user?.id||null;}catch(_){return null;}},preferences:()=>({rememberEmail:false,email:'',stayConnected:false}),prepareLogin(){},rememberSuccessfulEmail(){},forgetRememberedEmail(){},attachClient(){},observeAuthEvent:()=>false,recoveryState:()=>null};window.testAccess=api;return api;}};
  window.indexedDB=options.indexedDB;
  const TestURL=class extends URL {static createObjectURL(blob){downloads.push(blob);return 'blob:fixture';}static revokeObjectURL(){}};
  const ClockDate=class extends Date {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
  const context={window,document,console,URL:TestURL,Blob,Date:options.now===undefined?Date:ClockDate,Number,String,Object,Array,Error,Promise,
    navigator:options.online===undefined?{}:{onLine:options.online},confirm:()=>confirmResult,setTimeout:()=>1,
    setInterval(fn){intervals.set(++intervalId,fn);return intervalId;},clearInterval(id){intervals.delete(id);},
    FormData:class {constructor(form){this.values=new Map(Object.entries(form.fields||{}));submittedForms.push(this);}get(k){return this.values.get(k)||null;}has(k){return this.values.has(k);}delete(k){this.values.delete(k);}},
    localStorage:options.storage||new Proxy({}, {get(){throw Error('Application attempted to access local records');}})};
  vm.runInNewContext(appCode,context,{filename:'assets/app.js'});
  function click(action,id='') {docEvents.get('click')({target:{closest:()=>({dataset:{action,id}})},preventDefault(){}});}
  function submit(id,fields={},value='') {return docEvents.get('submit')({target:{id,fields},submitter:{value},preventDefault(){}});}
  function change(id,value){const target=element('#'+id);target.id=id;target.value=value;return docEvents.get('change')({target});}
  function fileChange(file){const target=element('#account-photo');target.id='account-photo';target.files=file?[file]:[];target.value=file?'selected-photo':'';return docEvents.get('change')({target});}
  function input(form='#modal-form') {docEvents.get('input')({target:{id:'person-name',closest:s=>s===form}});}
  return {window,cloud,elements,element,click,submit,input,change,fileChange,downloads,notifications,submittedForms,navigator:context.navigator,offline:()=>offlineAdapter,account:()=>accountAdapter,confirm(value){confirmResult=value;},saveCalls:()=>saveCalls,
    auth(event,session){currentSession=session;authCallback(event,session);},
    focus(){winEvents.get('focus')();},visibility(value='visible'){document.visibilityState=value;docEvents.get('visibilitychange')?.();},
    advance(ms){clock+=ms;for(const tick of intervals.values())tick();},intervalCount:()=>intervals.size,
    network(online){context.navigator.onLine=online;winEvents.get(online?'online':'offline')?.();},
    unload(){const event={preventDefault(){this.prevented=true;}};winEvents.get('beforeunload')?.(event);return event;}};
}

function offlineBoundary(args,options={}){
  const listeners=new Set(),calls={ready:0,sync:0,exports:0,discard:0,logout:0},status={online:args.online(),pending:0,syncing:false,conflicts:[],blocked:false,error:null,available:true,lastSyncedAt:null,...options.status};
  const get=()=>({...C.clone(status),online:args.online()}),emit=patch=>{Object.assign(status,patch);for(const listener of listeners)listener(get());};
  const adapter={...args.cloud,ready:async()=>{calls.ready++;if(options.ready)await options.ready;},getSyncStatus:get,subscribeSync(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async sync(){calls.sync++;emit({syncing:true});try{if(options.sync)await options.sync({status,emit,calls});}finally{emit({syncing:false});}},hasPending:async()=>status.pending>0,
    async exportPending(){calls.exports++;return options.copy||{type:'private-pending-fixture',operations:[{kind:'group',text:'Alteração privada fictícia'}]};},
    async discardPending(){calls.discard++;emit({pending:0,conflicts:[],blocked:false,error:null});return get();},
    async logoutSafe(){if(status.pending){const error=Error('Pending');error.code='pending_changes';throw error;}calls.logout++;await args.cloud.logout();},...options.methods};
  adapter.test={args,status,calls,emit};return adapter;
}
function testWebCrypto(t){const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');if(!globalThis.crypto?.randomUUID){Object.defineProperty(globalThis,'crypto',{value:require('node:crypto').webcrypto,configurable:true});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;});}}
function accountFixture(userId='owner',fields={}){return{userId,displayName:'Pessoa do Perfil',avatarData:PROFILE_AVATAR,version:2,updatedAt:null,...fields};}
function accountBoundary(args,overrides={}){
  let data=accountFixture();const calls={getCached:[],load:[],save:[],changePassword:[],requestPasswordNonce:[],clearMemory:[],forget:[]};
  const defaults={getCached:async()=>C.clone(data),load:async()=>C.clone(data),save:async input=>{data={userId:input.expectedUserId,displayName:input.displayName,avatarData:input.avatarData,version:input.expectedVersion+1,updatedAt:null};return C.clone(data);},changePassword:async()=>({changed:true}),requestPasswordNonce:async()=>({sent:true}),clearMemory(){},forget:async()=>{}};
  const api={};for(const key of Object.keys(defaults)){api[key]=(...values)=>{calls[key].push(values.map(value=>value&&typeof value==='object'?C.clone(value):value));return(overrides[key]||defaults[key])(...values);};}
  api.test={args,calls,setProfile(value){data=C.clone(value);}};return api;
}
function themeMock(){let current='light';const listeners=new Set(),api={current:()=>current,toggle(){current=current==='light'?'dark':'light';for(const fn of listeners)fn(current);return current;},subscribe(fn){listeners.add(fn);fn(current);return()=>listeners.delete(fn);}};return api;}
function publisherProfile(personId='p_fixture',groupId='group_a') {
  return {userId:'owner',isAdmin:false,role:'publisher',defaultGroupId:groupId,publisherId:personId};
}
function ownBundle({state=fixture(),revisions=[],personId='p_fixture',groupId='group_a'}={}) {
  state=C.clone(state);state.settings.reminder='';
  return {groupId,personId,group:{id:groupId,name:'Grupo privado fictício',createdAt:null},state,revision:7,updatedAt:null,revisions};
}
function launchIdForDate(date){return '10000000-0000-4000-8000-'+date.replaceAll('-','').padStart(12,'0');}
function freshLaunchId(index){return '20000000-0000-4000-8000-'+String(index).padStart(12,'0');}
function timerBundle(changes={}){return {groupId:'group_a',personId:'p_fixture',timerId:null,status:'idle',version:0,startDate:null,startedAt:null,anchorAt:null,stoppedAt:null,accumulatedMs:0,elapsedMs:0,serverNow:new Date().toISOString(),...changes};}
function activeTimer(status='running',changes={}){return timerBundle({timerId:freshLaunchId(501),status,version:1,startDate:testToday(),startedAt:new Date().toISOString(),anchorAt:status==='running'?new Date().toISOString():null,stoppedAt:status==='stopped'?new Date().toISOString():null,elapsedMs:65000,accumulatedMs:status==='running'?0:65000,...changes});}
function annualBundle(serviceYear=C.serviceYearForMonth(testToday().slice(0,7)),changes={}){const current=testToday().slice(0,7);return {groupId:'group_a',personId:'p_fixture',serviceYear,today:testToday(),targetMinutes:36000,version:0,updatedAt:null,months:C.periodMonths(serviceYear,'service').map(month=>({month,kind:'regular',source:month>current?'future':'missing',minutes:null,studies:null,retroMinutes:null,retroStudies:null,canEditRetro:month<current})),...changes};}
function annualRows(year,overrides={},changes={}){const bundle=annualBundle(year,changes);bundle.months=bundle.months.map(row=>({...row,...overrides[row.month]}));return bundle;}
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

function managerProfile(role='admin',binding=true){return {userId:'owner',role,isAdmin:role==='admin',defaultGroupId:'group_a',publisherId:binding?'p_fixture':null,personalGroupId:binding?'group_b':null};}
function managerFixture(){const s=fixture();s.people=[{...s.people[0],id:'p_management',name:'Pessoa da administração'}];return s;}
function managerHarness(role='admin',overrides={},options={}){
  const data=overrides.personalState||pioneerFixture();const cloudOverrides={...overrides};delete cloudOverrides.personalState;
  return harness({profile:async()=>managerProfile(role),read:async groupId=>({state:groupId==='group_b'?data:managerFixture(),revision:7}),readOwnCard:async()=>ownBundle({state:data,groupId:'group_b'}),readOwnHours:async month=>hoursBundle(month,{}, {groupId:'group_b'}),readOwnTimer:async()=>timerBundle({groupId:'group_b'}),readOwnAnnual:async year=>annualBundle(year,{groupId:'group_b'}),...cloudOverrides},options);
}
for(const role of ['admin','superintendent']){
  test(role+' starts in administration and opens its explicitly linked private card',async()=>{
    const h=managerHarness(role);await flush();assert.equal(h.window.EmDiaApp.getUI().personalMode,false);assert.match(h.element('#app').innerHTML,/Pessoa da administração/);assert.match(h.element('#app').innerHTML,/data-action="personal-open"/);
    h.click('personal-open');await flush();assert.equal(h.window.EmDiaApp.getUI().personalMode,true);assert.equal(h.window.EmDiaApp.getProfile().role,role);assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getState().people.length,1);assert.match(h.element('#app').innerHTML,/Pessoa de Teste|Diário de horas|Cronômetro/);assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa da administração|group-selector/);
    assert.match(h.element('#mobile-nav').innerHTML,/Meu cartão|Enviar|Meus relatórios/);assert.doesNotMatch(h.element('#mobile-nav').innerHTML,/Usuários|Checklist|Publicadores|Revisões/);
    h.click('management-open');await flush();assert.equal(h.window.EmDiaApp.getUI().personalMode,false);assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');assert.match(h.element('#app').innerHTML,/Pessoa da administração/);assert.doesNotMatch(h.element('#app').innerHTML,/Cronômetro/);
  });
  test(role+' self-service rejects management actions and sends through revision workflow',async()=>{
    let payload;const data=fixture();data.reports[data.activeMonth]={p_fixture:report({studies:1})};
    const revisions=[{id:'revision_personal',month:data.activeMonth,status:'pending',version:4,report:activity({studies:2})}];
    const h=managerHarness(role,{personalState:data,readOwnCard:async()=>ownBundle({state:data,groupId:'group_b',revisions}),submitOwnReport:async p=>{payload=C.clone(p);return {status:'pending',version:5};}});await flush();h.click('personal-open');await flush();
    h.click('person-new');h.click('quick-receive','p_fixture');h.click('backup');h.click('tab','data');await flush();assert.equal(h.saveCalls(),0);assert.equal(h.downloads.length,0);assert.equal(h.window.EmDiaApp.getUI().tab,'my-card');
    h.click('own-report');await h.submit('modal-form',{participated:'yes',studies:'3'});await flush();assert.equal(payload.expectedVersion,4);assert.equal(payload.report.studies,3);assert.equal(h.window.EmDiaApp.getState().reports[data.activeMonth].p_fixture.studies,1);assert.match(h.element('#app').innerHTML,/aguarda decisão|Alteração em análise/);assert.equal(h.saveCalls(),0);
  });
  test(role+' without personal link receives guidance and can return to administration',async()=>{
    let reads=0;const h=managerHarness(role,{profile:async()=>managerProfile(role,false),readOwnCard:async()=>{reads++;}});await flush();h.click('personal-open');await flush();assert.equal(reads,0);assert.equal(h.window.EmDiaApp.getState(),null);assert.match(h.element('#app').innerHTML,/Cartão ainda não vinculado|Cartão pessoal/);h.click('management-open');await flush();assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_a');assert.equal(h.window.EmDiaApp.getProfile().role,role);
  });
}
test('admin consulting another group returns to that management group after personal use',async()=>{
  const h=managerHarness();await flush();h.click('group-open','group_b');await flush();assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');h.click('personal-open');await flush();h.click('management-open');await flush();assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.window.EmDiaApp.getUI().personalMode,false);
});
test('canceling a mode switch preserves a dirty personal draft and current card',async()=>{
  const h=managerHarness();await flush();h.click('personal-open');await flush();h.click('own-hours-edit');h.input();h.confirm(false);h.click('management-open');await flush();assert.equal(h.window.EmDiaApp.getUI().personalMode,true);assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getSelectedGroup().id,'group_b');assert.equal(h.saveCalls(),0);
});
test('personal annual and individual reports remain bound to own card for managers',async()=>{
  const h=managerHarness();await flush();h.click('personal-open');await flush();h.click('annual-open');await flush();assert.equal(h.window.EmDiaApp.getUI().tab,'annual-progress');assert.match(h.element('#app').innerHTML,/600|Progresso anual/);h.click('annual-back');await flush();h.click('person-annual','p_fixture');await flush();assert.equal(h.window.EmDiaApp.getUI().tab,'reports');assert.equal(h.window.EmDiaApp.getUI().person,'p_fixture');assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa da administração|report-person/);assert.equal(h.saveCalls(),0);
});
test('sign out during a manager personal card request cannot reveal the late response',async()=>{
  const pending=deferred();const h=managerHarness('admin',{readOwnCard:()=>pending.promise});await flush();h.click('personal-open');await flush();h.auth('SIGNED_OUT',null);pending.resolve(ownBundle({groupId:'group_b'}));await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getProfile(),null);assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste|Pessoa da administração/);
});
test('manager personal portal accepts only its separate trusted personal group',async()=>{
  const h=managerHarness('admin',{readOwnCard:async()=>ownBundle({groupId:'group_a'})});await flush();h.click('personal-open');await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);assert.doesNotMatch(h.element('#app').innerHTML,/Pessoa de Teste/);
});
test('admin binds a manager card only after explicitly choosing a person with prior binding CAS',async()=>{
  let payload;const users=[{id:'other_manager',email:'gestor@example.invalid',role:'superintendent',groupId:'group_a'}],old={userId:'other_manager',groupId:'group_a',personId:'p_management'};
  const h=managerHarness('admin',{listUsers:async()=>({users}),listPersonalBindings:async()=>[old],bindPersonalCard:async p=>{payload=C.clone(p);return {userId:p.userId,groupId:p.groupId,personId:p.personId};}});await flush();h.click('tab','users');await flush();assert.match(h.element('#app').innerHTML,/Cartão pessoal/);h.click('personal-binding','other_manager');await flush();assert.match(h.element('#modal').innerHTML,/Grupo do cartão pessoal|Cartão desta pessoa/);
  await h.change('personal-binding-group','group_b');await flush();await h.submit('modal-form',{groupId:'group_b',personId:''});assert.equal(payload,undefined);await h.submit('modal-form',{groupId:'group_b',personId:'p_fixture'});await flush();assert.deepEqual(payload,{userId:'other_manager',groupId:'group_b',personId:'p_fixture',expectedGroupId:'group_a',expectedPersonId:'p_management'});assert.equal(h.saveCalls(),0);
});
test('personal binding removal is explicit and preserves card state',async()=>{
  let payload;const users=[{id:'other_manager',email:'gestor@example.invalid',role:'admin',groupId:'group_a'}];const h=managerHarness('admin',{listUsers:async()=>({users}),listPersonalBindings:async()=>[{userId:'other_manager',groupId:'group_b',personId:'p_fixture'}],bindPersonalCard:async p=>{payload=C.clone(p);return {};}});await flush();h.click('tab','users');await flush();h.click('personal-binding','other_manager');await flush();h.confirm(false);h.click('personal-binding-remove');await flush();assert.equal(payload,undefined);h.confirm(true);h.click('personal-binding-remove');await flush();assert.deepEqual(payload,{userId:'other_manager',groupId:null,personId:null,expectedGroupId:'group_b',expectedPersonId:'p_fixture'});assert.equal(h.saveCalls(),0);
});
test('late candidate reads cannot reopen a closed personal binding dialog',async()=>{
  const candidates=deferred();const users=[{id:'other_manager',email:'gestor@example.invalid',role:'admin',groupId:'group_b'}];const h=managerHarness('admin',{listUsers:async()=>({users}),listPersonalBindings:async()=>[],bindPersonalCard:async()=>{},read:groupId=>groupId==='group_b'?candidates.promise:Promise.resolve({state:managerFixture(),revision:7})});await flush();h.click('tab','users');await flush();h.click('personal-binding','other_manager');await flush();h.click('modal-close');candidates.resolve({state:pioneerFixture(),revision:7});await flush();assert.equal(h.element('#modal').open,false);assert.doesNotMatch(h.element('#personal-binding-person').innerHTML,/Pessoa de Teste/);
});
test('publisher retains its personal portal and cannot enter management mode',async()=>{
  const h=harness({profile:async()=>publisherProfile(),readOwnCard:async()=>ownBundle()});await flush();h.click('management-open');await flush();assert.equal(h.window.EmDiaApp.getUI().personalMode,true);assert.equal(h.window.EmDiaApp.getProfile().role,'publisher');assert.doesNotMatch(h.element('#app').innerHTML,/data-action="management-open"|group-selector/);assert.equal(h.saveCalls(),0);
});

