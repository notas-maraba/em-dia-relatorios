/* Explicit monthly declarations use only synthetic users and cloud boundaries. */
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../assets/core.js');
const {harness,flush,deferred,fixture,errors}=require('./app.test.cjs');
const MONTH='2026-11',DAY='2026-11-06',NOW=Date.parse(DAY+'T15:00:00Z');
function dataFixture(kind='publisher'){
  const data=fixture();data.activeMonth=MONTH;data.people[0].startMonth='2026-09';
  data.people[0].roles=kind==='publisher'?[]:[{kind,start:'2026-09',end:null}];return data;
}
function approved(kind='publisher') {return{received:true,kind,participated:true,hours:kind==='publisher'?null:20,studies:2,notes:'',receivedDate:DAY,updatedAt:null};}
async function personal(role='publisher',config={}){
  let data=C.clone(config.data||dataFixture()),revision=7;const groupId=role==='publisher'?'group_a':'group_b',calls={conditions:[],reports:[],hours:[],timers:0,annual:0};
  const profile={userId:'owner',role,isAdmin:role==='admin',defaultGroupId:'group_a',publisherId:'p_fixture',personalGroupId:groupId};
  const card=()=>({groupId,personId:'p_fixture',group:{id:groupId,name:'Grupo pessoal fictício'},state:C.clone(data),revision,revisions:C.clone(config.revisions||[])});
  const effective=month=>data.people[0].monthConditions?.[month]??(data.reports[month]?.p_fixture?.received?data.reports[month].p_fixture.kind:C.roleAt(data.people[0],month));
  const api={profile:async()=>profile,readOwnCard:async()=>card(),read:async()=>({state:fixture(),revision:7}),
    readOwnHours:async month=>{calls.hours.push(month);return{groupId,personId:'p_fixture',month,kind:effective(month),entries:{},launches:[],version:0,totalMinutes:0,closed:month<MONTH,today:DAY,updatedAt:null};},
    readOwnTimer:async()=>{calls.timers++;return{groupId,personId:'p_fixture',timerId:null,status:'idle',version:0,startDate:null,startedAt:null,anchorAt:null,stoppedAt:null,accumulatedMs:0,elapsedMs:0,serverNow:new Date(NOW).toISOString()};},
    readOwnAnnual:async year=>{calls.annual++;return{groupId,personId:'p_fixture',serviceYear:year,today:DAY,targetMinutes:36000,version:0,updatedAt:null,months:C.periodMonths(year,'service').map(month=>({month,kind:'regular',source:month>MONTH?'future':'missing',minutes:null,studies:null,retroMinutes:null,retroStudies:null,canEditRetro:month<MONTH}))};},
    saveOwnCondition:async input=>{calls.conditions.push(C.clone(input));if(C.withMonthCondition)data.people[0]=C.withMonthCondition(data.people[0],input.month,input.kind);else data.people[0].monthConditions={...data.people[0].monthConditions,[input.month]:input.kind};revision++;return{groupId,personId:'p_fixture',month:input.month,kind:input.kind,revision,unchanged:false,...(config.queued?{queued:true}:{})};},
    submitOwnReport:async input=>{calls.reports.push(C.clone(input));return{status:'pending',version:2};},...config.api};
  const h=harness(api,{now:NOW,...config.options});h.window.crypto.randomUUID=()=>'30000000-0000-4000-8000-000000000001';await flush();if(role!=='publisher'){h.click('personal-open');await flush();}await flush();
  return{...h,calls,card,effective,setData(value){data=C.clone(value);},getData:()=>C.clone(data)};
}
for(const role of ['publisher','superintendent','admin']){
  test(role+' can declare a regular month in its own card and unlock the diary without changing access role',async()=>{
    const h=await personal(role);assert.match(h.element('#app').innerHTML,/Minha condição neste mês/);assert.doesNotMatch(h.element('#app').innerHTML,/Diário de horas/);
    h.click('own-condition');await flush();assert.match(h.element('#modal').innerHTML,/Novembro de 2026|somente/);assert.match(h.element('#modal').innerHTML,/Pioneiro regular|Pioneiro auxiliar|Publicador/);
    await h.submit('modal-form',{kind:'regular'});await flush();assert.deepEqual(h.calls.conditions,[{month:MONTH,kind:'regular',expectedRevision:7}]);assert.equal(h.window.EmDiaApp.getProfile().role,role);
    assert.match(h.element('#app').innerHTML,/Diário de horas/);assert.match(h.element('#app').innerHTML,/data-action="own-hours-edit"/);assert.match(h.element('#app').innerHTML,/data-action="own-timer-start"/);assert.match(h.element('#app').innerHTML,/Progresso anual/);assert.equal(h.saveCalls(),0);
  });
}
test('auxiliary selection unlocks hours but does not show the regular annual goal',async()=>{
  const h=await personal();h.click('own-condition');await h.submit('modal-form',{kind:'auxiliary'});await flush();assert.match(h.element('#app').innerHTML,/Pioneiro auxiliar|Diário de horas/);assert.doesNotMatch(h.element('#app').innerHTML,/Progresso anual/);assert.equal(h.effective(MONTH),'auxiliary');
});
test('own marker overrides an approved old condition for tools without replacing the approved report',async()=>{
  const data=dataFixture();data.people[0].monthConditions={[MONTH]:'regular'};data.people[0].roles=[{kind:'regular',start:MONTH,end:MONTH}];data.reports[MONTH]={p_fixture:approved('publisher')};const h=await personal('publisher',{data});
  assert.match(h.element('#app').innerHTML,/Diário de horas|Condição informada no mês/);assert.match(h.element('#app').innerHTML,/relatório recebido continua como Publicador/);assert.equal(h.window.EmDiaApp.getState().reports[MONTH].p_fixture.kind,'publisher');
  h.click('own-report');await flush();assert.match(h.element('#modal').innerHTML,/Horas do mês|Pioneiro regular/);assert.match(h.element('#modal').innerHTML,/Enviar alteração/);await h.submit('modal-form',{participated:'yes',hours:'12',studies:'2'});await flush();assert.equal(h.calls.reports[0].report.hours,12);assert.equal(h.window.EmDiaApp.getState().reports[MONTH].p_fixture.kind,'publisher');
});
test('legacy received-only pioneer retains its diary until an explicit different choice is saved',async()=>{
  const data=dataFixture();data.reports[MONTH]={p_fixture:approved('regular')};const h=await personal('publisher',{data});assert.match(h.element('#app').innerHTML,/Diário de horas/);h.click('own-condition');await h.submit('modal-form',{kind:'publisher'});await flush();assert.doesNotMatch(h.element('#app').innerHTML,/Diário de horas/);assert.equal(h.window.EmDiaApp.getState().reports[MONTH].p_fixture.kind,'regular');assert.match(h.element('#app').innerHTML,/lançamentos|relatório recebido continua como Pioneiro regular/);
});
test('the declaration changes only the selected month and leaves other month markers intact',async()=>{
  const data=dataFixture();data.people[0]=C.withMonthCondition(data.people[0],'2026-10','auxiliary');const h=await personal('publisher',{data});h.click('own-condition');await h.submit('modal-form',{kind:'regular'});await flush();assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions['2026-10'],'auxiliary');assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions[MONTH],'regular');
});
test('invalid condition input never reaches the cloud and leaves the form open',async()=>{
  const h=await personal();h.click('own-condition');await h.submit('modal-form',{kind:'admin'});assert.equal(h.calls.conditions.length,0);assert.equal(h.element('#modal').open,true);assert.match(h.element('#form-error').textContent,/Escolha sua condição/);
});
test('condition save waits for confirmation and uses the captured group revision',async()=>{
  const pending=deferred(),calls=[];const h=await personal('publisher',{api:{saveOwnCondition:input=>{calls.push(input);return pending.promise;}}});h.click('own-condition');const p=h.submit('modal-form',{kind:'regular'});assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions,undefined);assert.equal(calls[0].expectedRevision,7);
  pending.resolve({groupId:'group_a',personId:'p_fixture',month:MONTH,kind:'regular',revision:8,unchanged:false});await p;await flush();assert.equal(h.element('#modal').open,false);
});
test('a conflict preserves the original condition and requires a fresh card before retrying',async()=>{
  const h=await personal('publisher',{api:{saveOwnCondition:async()=>{throw new errors.ConflictError();}}});h.click('own-condition');await h.submit('modal-form',{kind:'regular'});assert.equal(h.element('#modal').open,true);assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions,undefined);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);assert.match(h.element('#form-error').textContent,/Atualize o cartão/);
});
test('a response from a signed-out account cannot restore the old condition or tools',async()=>{
  const pending=deferred(),h=await personal('publisher',{api:{saveOwnCondition:()=>pending.promise}});h.click('own-condition');const p=h.submit('modal-form',{kind:'regular'});h.auth('SIGNED_OUT',null);pending.resolve({groupId:'group_a',personId:'p_fixture',month:MONTH,kind:'regular',revision:8,unchanged:false});await p;await flush();assert.equal(h.window.EmDiaApp.getState(),null);assert.equal(h.element('#modal').open,false);assert.doesNotMatch(h.element('#app').innerHTML,/Diário de horas|Pessoa de Teste/);
});
test('a condition response for another card is not accepted or presented as saved',async()=>{
  const h=await personal('publisher',{api:{saveOwnCondition:async()=>({groupId:'group_other',personId:'different_person',month:MONTH,kind:'regular',revision:8,unchanged:false})}});h.click('own-condition');await h.submit('modal-form',{kind:'regular'});assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions,undefined);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);assert.ok(!h.notifications.includes('Condição do mês atualizada.'));
});
test('an offline queued condition reopens projected personal tools and explains pending visibility to the manager',async()=>{
  const h=await personal('publisher',{queued:true,options:{online:false}});h.click('own-condition');await h.submit('modal-form',{kind:'auxiliary'});await flush();assert.match(h.element('#app').innerHTML,/Diário de horas/);assert.ok(h.notifications.some(x=>/responsável verá.*sincronização/.test(x)));assert.equal(h.saveCalls(),0);
});
test('canceling condition navigation preserves an unsaved hours draft',async()=>{
  const h=await personal('publisher',{data:dataFixture('regular')});h.click('own-hours-edit');h.input();h.confirm(false);const modal=h.element('#modal').innerHTML;h.click('own-condition');await flush();assert.equal(h.element('#modal').innerHTML,modal);assert.match(modal,/Novo lançamento de horas/);assert.equal(h.calls.conditions.length,0);
});
test('a month outside tracking cannot be declared and a future month cannot be opened',async()=>{
  const h=await personal();await h.change('active-month','2026-08');await flush();h.click('own-condition');await flush();assert.equal(h.element('#modal').open,false);assert.equal(h.calls.conditions.length,0);await h.change('active-month','2026-12');assert.equal(h.window.EmDiaApp.getUI().month,'2026-08');
});
test('managers see a different declared condition beside the unchanged received kind',async()=>{
  const data=dataFixture();data.people[0].roles=[{kind:'auxiliary',start:MONTH,end:MONTH}];data.people[0].monthConditions={[MONTH]:'auxiliary'};data.reports[MONTH]={p_fixture:approved('publisher')};
  for(const role of ['admin','superintendent']){const h=harness({profile:async()=>({userId:'owner',role,isAdmin:role==='admin',defaultGroupId:'group_a'}),read:async()=>({state:data,revision:7})},{now:NOW});await flush();assert.match(h.element('#app').innerHTML,/Condição informada no mês:.*Pioneiro auxiliar/);assert.equal(h.window.EmDiaApp.getState().reports[MONTH].p_fixture.kind,'publisher');h.click('tab','people');await flush();assert.match(h.element('#app').innerHTML,/Informado no cartão|Pioneiro auxiliar/);}
});
test('explicit manager period editing clears declarations only in its old or new interval',async()=>{
  const data=dataFixture('regular');data.people[0].roles=[{kind:'regular',start:'2026-11',end:'2026-11'},{kind:'auxiliary',start:'2026-09',end:'2026-09'}];data.people[0].monthConditions={'2026-09':'auxiliary','2026-10':'publisher','2026-11':'regular'};
  const h=harness({read:async()=>({state:data,revision:7})},{now:NOW});await flush();h.click('role-edit','p_fixture|0');await h.submit('modal-form',{kind:'auxiliary',start:'2026-10',end:'2026-11'});const p=h.window.EmDiaApp.getState().people[0];assert.equal(p.monthConditions['2026-09'],'auxiliary');assert.equal(p.monthConditions['2026-10'],undefined);assert.equal(p.monthConditions['2026-11'],undefined);
});
test('manager period removal releases its monthly declaration but preserves unrelated months',async()=>{
  const data=dataFixture();data.people[0].roles=[{kind:'regular',start:MONTH,end:MONTH}];data.people[0].monthConditions={'2026-10':'publisher',[MONTH]:'regular'};const h=harness({read:async()=>({state:data,revision:7})},{now:NOW});await flush();h.click('role-remove','p_fixture|0');await flush();assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions[MONTH],undefined);assert.equal(h.window.EmDiaApp.getState().people[0].monthConditions['2026-10'],'publisher');
});
test('pending personal reports explain a blocked group save while preserving its draft and old state',async()=>{
  const h=harness({save:async()=>{const error=Error('Sincronize os relatórios pessoais pendentes antes de salvar este grupo.');error.code='pending_personal_reports';throw error;}},{now:NOW});await flush();const previous=h.window.EmDiaApp.getState().people[0].name;h.click('person-edit','p_fixture');h.input();await h.submit('modal-form',{name:'Nome fictício alterado',start:'2026-09',end:'',notes:''});assert.equal(h.window.EmDiaApp.getState().people[0].name,previous);assert.equal(h.element('#modal').open,true);assert.match(h.element('#app').innerHTML,/Sincronize os relatórios pessoais/);assert.match(h.element('#form-error').textContent,/Sincronize os relatórios pessoais/);assert.equal(h.window.EmDiaApp.getCloudStatus().blocked,true);
});
test('switching to publicador preserves an active timer and keeps its pause and stop controls available',async()=>{
  const running={groupId:'group_a',personId:'p_fixture',timerId:'30000000-0000-4000-8000-000000000002',status:'running',version:1,startDate:DAY,startedAt:new Date(NOW-60000).toISOString(),anchorAt:new Date(NOW-60000).toISOString(),stoppedAt:null,accumulatedMs:0,elapsedMs:60000,serverNow:new Date(NOW).toISOString()};let mutations=0;
  const h=await personal('publisher',{data:dataFixture('regular'),api:{readOwnTimer:async()=>C.clone(running),changeOwnTimer:async()=>{mutations++;throw Error('Unexpected timer mutation');}}});h.click('own-condition');await h.submit('modal-form',{kind:'publisher'});await flush();assert.equal(mutations,0);assert.match(h.element('#app').innerHTML,/data-action="own-timer-pause"/);assert.match(h.element('#app').innerHTML,/data-action="own-timer-stop"/);assert.doesNotMatch(h.element('#app').innerHTML,/data-action="own-timer-start"/);assert.equal(running.status,'running');
});
