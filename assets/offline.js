/* Em dia: private device cache and a durable, account-bound outbox. */
(function(root,factory){'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./cloud.js'):root.EmDiaCloud);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.EmDiaOffline=api;
})(typeof globalThis==='object'?globalThis:this,function(Errors){'use strict';
const DB_NAME='em-dia-private-offline-v1',STORE='accounts',LEASE_MS=45000;
const clone=value=>JSON.parse(JSON.stringify(value)),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER-1)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
class OfflineError extends Error{constructor(message,code='offline_unavailable'){super(message);this.name='OfflineError';this.code=code;}}
const unavailable=()=>new OfflineError('Estes dados ainda não estão disponíveis neste aparelho. Conecte-se para preparar a cópia offline.');
const binding=p=>JSON.stringify([p.userId,p.role,p.defaultGroupId,p.publisherId]);
const dayAt=ms=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));return ['year','month','day'].map(key=>parts.find(p=>p.type===key).value).join('-');};
function create({cloud,core:C,indexedDB,identity,online=()=>true,now=()=>Date.now(),networkTimeoutMs=15000}={}){
  if(!cloud||!C||typeof identity!=='function')throw new OfflineError('Configuração offline indisponível.');
  let dbPromise,active=null,initializing=null,syncPromise=null,loggingOut=false,lastError=null,needsRefresh=false;
  const listeners=new Set(),authListeners=new Set(),owner=globalThis.crypto?.randomUUID?.();
  const isOnline=()=>online()!==false,stamp=()=>{const value=now();if(!integer(value))throw new OfflineError('O relógio deste aparelho é inválido.','invalid_clock');return value;};
  async function remote(run){let timeout;try{return await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Errors.CloudError('A conexão não respondeu. Confira os dados antes de repetir a ação.','network_error')),integer(networkTimeoutMs,1,120000)?networkTimeoutMs:15000);})]);}finally{clearTimeout(timeout);}}
  function id(){const value=globalThis.crypto?.randomUUID?.();if(!uuid(value))throw new OfflineError('Atualize o navegador para salvar offline com segurança.');return value.toLowerCase();}
  function db(){
    if(!indexedDB?.open)return Promise.reject(new OfflineError('Este navegador não disponibiliza armazenamento offline.','storage_unavailable'));
    if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{let request;try{request=indexedDB.open(DB_NAME,1);}catch(_){reject(new OfflineError('Não foi possível abrir o armazenamento privado.','storage_unavailable'));return;}
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'userId'});};
      request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
      request.onerror=()=>reject(new OfflineError('Não foi possível abrir o armazenamento privado.','storage_unavailable'));
      request.onblocked=()=>reject(new OfflineError('Feche outras abas para atualizar o armazenamento privado.','storage_unavailable'));
    });return dbPromise;
  }
  async function transact(userId,mutate){
    const database=await db();return new Promise((resolve,reject)=>{
      let tx,result,failure;try{try{tx=database.transaction(STORE,mutate?'readwrite':'readonly',mutate?{durability:'strict'}:undefined);}catch(_){tx=database.transaction(STORE,mutate?'readwrite':'readonly');}const store=tx.objectStore(STORE),request=store.get(userId);
        request.onsuccess=()=>{try{const row=request.result?clone(request.result):null;result=mutate?mutate(row):row;if(mutate){if(result===null)store.delete(userId);else store.put(result);}}catch(error){failure=error instanceof OfflineError||error instanceof Errors.CloudError?error:new OfflineError('Não foi possível salvar neste aparelho. Libere espaço e tente novamente.','storage_error');tx.abort();}};
        request.onerror=()=>{failure=new OfflineError('Não foi possível ler os dados privados deste aparelho.','storage_error');};
        tx.oncomplete=()=>resolve(result?clone(result):null);
        tx.onabort=tx.onerror=()=>reject(failure||new OfflineError('Não foi possível salvar neste aparelho. Libere espaço e tente novamente.','storage_error'));
      }catch(_){reject(new OfflineError('Não foi possível salvar neste aparelho.','storage_error'));}
    });
  }
  function getSyncStatus(){const pending=active?.outbox.length||0;return {online:isOnline(),available:!!active&&!active.blocked,pending,syncing:!!syncPromise,
    conflicts:(active?.outbox||[]).filter(op=>op.state==='conflict').map(op=>({operationId:op.id,kind:op.kind,code:op.errorCode||'conflict',message:'A nuvem e este aparelho têm alterações diferentes. Preserve a cópia pendente antes de decidir.'})),
    blocked:!!active?.blocked,blockedReason:active?.blocked||null,error:lastError,needsRefresh,lastSyncedAt:active?.lastSyncedAt||null,
    scope:active?{userId:active.cache.profile.userId,role:active.cache.profile.role,defaultGroupId:active.cache.profile.defaultGroupId,publisherId:active.cache.profile.publisherId}:null,bindingKey:active?.binding||null};}
  function notify(){const value=getSyncStatus();for(const listener of listeners){try{listener(clone(value));}catch(_){/* A view cannot interrupt storage or sync. */}}}
  function subscribeSync(fn){if(typeof fn!=='function')throw TypeError('Uma função é necessária.');listeners.add(fn);fn(getSyncStatus());return()=>listeners.delete(fn);}
  async function identityId(){const value=await identity();return typeof value==='string'&&value?value:null;}
  async function still(userId){return !loggingOut&&await identityId()===userId;}
  async function block(userId,code){if(!userId||await identityId()!==userId)return;const row=await transact(userId,r=>{if(r){r.blocked=code;r.generation=(r.generation||0)+1;}return r;});if(await identityId()===userId){active=row;notify();}}
  async function remoteFailure(error,userId,snapshot=false){if(!userId||await identityId()!==userId)return;
    if(error?.code==='auth_required'||snapshot&&error?.code==='access_denied'){await block(userId,error.code);return;}
    if(error?.code==='access_denied'){try{const p=await remote(()=>cloud.profile()),row=await transact(userId);if(await identityId()===userId&&row&&binding(p)!==row.binding)await block(userId,'binding_changed');}
      catch(checkError){if(['auth_required','access_denied'].includes(checkError?.code))await block(userId,checkError.code);}}
  }
  function cacheSnapshot(snapshot,userId){
    const p=snapshot?.profile;if(!p||p.userId!==userId||!['admin','superintendent','publisher'].includes(p.role)||p.isAdmin!==(p.role==='admin')||
      !Array.isArray(snapshot.groups)||!Array.isArray(snapshot.states)||!Array.isArray(snapshot.diaries)||!Array.isArray(snapshot.annuals)||!Array.isArray(snapshot.revisions))throw new OfflineError('A cópia recebida não corresponde à conta.','invalid_response');
    const cache={profile:{userId:p.userId,role:p.role,isAdmin:p.isAdmin,defaultGroupId:p.defaultGroupId,publisherId:p.publisherId},groups:snapshot.groups.map(g=>({id:g.id,name:g.name,createdAt:g.createdAt??null})),resources:{}};const set=(key,value)=>{cache.resources[key]={value:clone(value),at:stamp()};};
    const groups=new Set(cache.groups.map(g=>g.id));if(groups.size!==cache.groups.length)throw new OfflineError('Cópia duplicada.','invalid_response');
    if(p.role==='publisher'){
      const card=snapshot.ownCard;if(!card||card.groupId!==p.defaultGroupId||card.personId!==p.publisherId||card.state.people.length!==1||card.state.people[0].id!==p.publisherId||snapshot.states.length||snapshot.revisions.length)throw new OfflineError('Cópia fora do cartão.','invalid_response');
      C.validate(card.state);set('card',card);
      for(const diary of snapshot.diaries){if(diary.groupId!==p.defaultGroupId||diary.personId!==p.publisherId)throw new OfflineError('Cópia fora do cartão.','invalid_response');set('diary:'+diary.month,diary);}
      for(const annual of snapshot.annuals){if(annual.groupId!==p.defaultGroupId||annual.personId!==p.publisherId)throw new OfflineError('Cópia fora do cartão.','invalid_response');C.regularAnnualProgress(annual);set('annual:'+annual.serviceYear,annual);}
      if(!snapshot.timer||snapshot.timer.groupId!==p.defaultGroupId||snapshot.timer.personId!==p.publisherId)throw new OfflineError('Cópia fora do cartão.','invalid_response');set('timer',snapshot.timer);
    }else{
      if(snapshot.ownCard||snapshot.diaries.length||snapshot.annuals.length||snapshot.timer)throw new OfflineError('Cópia fora do perfil.','invalid_response');
      for(const item of snapshot.states){if(!groups.has(item.groupId)||p.role==='superintendent'&&item.groupId!==p.defaultGroupId)throw new OfflineError('Cópia fora do grupo.','invalid_response');if(item.bundle!==null)C.validate(item.bundle.state);set('group:'+item.groupId,item.bundle);}
      for(const item of snapshot.revisions){if(!groups.has(item.groupId))throw new OfflineError('Cópia fora do grupo.','invalid_response');set('revisions:'+item.groupId,item.items);}
    }return cache;
  }
  async function installSnapshot(snapshot,userId,expectedGeneration){const cache=cacheSnapshot(snapshot,userId);if(!await still(userId))throw new Errors.AuthRequiredError();
    const row=await transact(userId,old=>{if(old?.outbox.length){if(old.binding!==binding(cache.profile)){old.blocked='binding_changed';old.generation=(old.generation||0)+1;}return old;}if(expectedGeneration!==undefined&&(old?.generation||0)!==expectedGeneration)return old;return {userId,binding:binding(cache.profile),generation:(old?.generation||0)+1,base:clone(cache),cache,outbox:[],confirmations:{},tails:{},lock:old?.lock||null,blocked:null,lastSyncedAt:new Date(stamp()).toISOString()};});
    if(await still(userId)){active=row;lastError=null;needsRefresh=false;notify();}return row;
  }
  async function ensure(){const userId=await identityId();if(loggingOut||!userId){active=null;return null;}
    if(active?.userId!==userId)active=null;const row=await transact(userId);if(!await still(userId))return null;active=row;return row;
  }
  async function ready(){
    if(initializing)return initializing;initializing=(async()=>{let row=await ensure();const userId=await identityId();if(!userId)return null;
      if(isOnline()){try{if(row?.outbox.length){const p=await remote(()=>cloud.profile());if(!await still(userId))return null;if(p.userId!==userId||binding(p)!==row.binding){await block(userId,'binding_changed');return null;}
          if(row.blocked){row=await transact(userId,r=>{if(r&&r.binding===binding(p)){r.blocked=null;r.generation=(r.generation||0)+1;}return r;});active=row;notify();}}
        else{const generation=row?.generation||0;row=await installSnapshot(await remote(()=>cloud.offlineSnapshot()),userId,generation);}
      }catch(error){if(['auth_required','access_denied'].includes(error?.code)){await block(userId,error.code);throw error;}lastError='Não foi possível atualizar a cópia neste momento.';notify();if(!row)throw unavailable();}}
      return row?getSyncStatus():null;})();try{return await initializing;}finally{initializing=null;}
  }
  function calendar(cache,key,value){const result=clone(value),today=dayAt(stamp());if(key.startsWith('diary:')){result.today=today>result.today?today:result.today;result.closed=result.month<result.today.slice(0,7);}
    if(key.startsWith('annual:')){result.today=today>result.today?today:result.today;const p=cache.resources.card?.value.state.people[0],current=result.today.slice(0,7);
      for(const row of result.months){if(row.source==='future'&&row.month<=current){const prestart=p&&row.month<p.startMonth;row.kind=prestart?'regular':p?C.roleAt(p,row.month):row.kind;row.source=prestart||p&&C.inPeriod(p,row.month)&&row.kind==='regular'?'missing':'not_regular';row.minutes=null;row.studies=null;row.canEditRetro=row.source==='missing'&&row.month<current;}
        else if(['missing','retroactive'].includes(row.source))row.canEditRetro=row.month<current;}
    }return result;
  }
  function valueOf(cache,key){const entry=cache.resources[key];if(!entry)throw unavailable();if(key.startsWith('diary:')&&entry.value.canUse===false)throw unavailable();
    if(key==='timer'){const value=clone(entry.value),delta=Math.max(0,stamp()-entry.at);if(value.status==='running'){value.elapsedMs+=delta;if(!integer(value.elapsedMs))throw new OfflineError('Tempo inválido.','invalid_clock');value.serverNow=new Date(Date.parse(value.serverNow)+delta).toISOString();}return value;}
    return calendar(cache,key,entry.value);
  }
  async function readResource(key){let row=await ensure();if(!row&&isOnline()){await ready();row=active;}if(!row)throw unavailable();if(row.blocked)throw new Errors.AccessDeniedError();return valueOf(row.cache,key);}
  function deriveAnnual(cache,month){const key='annual:'+C.serviceYearForMonth(month),stored=cache.resources[key],card=cache.resources.card?.value,p=card?.state.people[0];if(!stored||!p)return;
    const annual=calendar(cache,key,stored.value),row=annual.months.find(item=>item.month===month);if(!row)return;const report=C.getReport(card.state,p.id,month),diary=cache.resources['diary:'+month]?.value,prestart=month<p.startMonth,kind=report?.received?report.kind:prestart?'regular':C.roleAt(p,month),current=annual.today.slice(0,7);
    row.kind=kind;row.minutes=null;row.studies=null;row.canEditRetro=false;
    if(month>current)row.source='future';else if(report?.received&&kind==='regular'){row.source='approved';row.minutes=report.hours===null?null:Math.round(report.hours*60);row.studies=report.studies;}
    else if(report?.received||!prestart&&(!C.inPeriod(p,month)||kind!=='regular'))row.source='not_regular';
    else if(diary?.launches.length){row.source='diary';row.minutes=diary.totalMinutes;}
    else{row.source=row.retroMinutes===null?'missing':'retroactive';row.minutes=row.retroMinutes;row.studies=row.retroStudies;row.canEditRetro=month<current;}
    cache.resources[key]={value:annual,at:stamp()};
  }
  function versionOf(cache,key){if(key.startsWith('report:')){const month=key.slice(7);return cache.resources.card?.value.revisions.find(r=>r.month===month)?.version||0;}const value=cache.resources[key]?.value;if(!value)return 0;return key.startsWith('group:')?value.revision:value.version;}
  function checkVersion(value,cache,key){if(!integer(value)||value!==versionOf(cache,key))throw new OfflineError('Este dado foi alterado em outra aba. Recarregue antes de continuar.','conflict');}
  function activity(report,kind){if(!report||Object.keys(report).some(k=>!['participated','hours','studies'].includes(k))||!(report.participated===null||typeof report.participated==='boolean')||
    !(report.hours===null||typeof report.hours==='number'&&Number.isFinite(report.hours)&&report.hours>=0&&report.hours<=744&&Math.abs(report.hours*100-Math.round(report.hours*100))<1e-7)||
    kind==='publisher'&&report.hours!==null||!(report.studies===null||integer(report.studies,0,9999)))throw new OfflineError('Confira os campos de atividade.','invalid_report');return clone(report);}
  function project(cache,kind,payload,operationId,confirmation=null){
    const c=cache,p=c.profile,set=(key,value)=>{c.resources[key]={value:clone(value),at:stamp()};},get=key=>valueOf(c,key),version=(key,field)=>confirmation?.[field]??versionOf(c,key)+1;
    const person=()=>c.resources.card?.value.state.people[0],effects={},deps={};let result;
    const requireVersion=(field,key)=>{if(confirmation)payload[field]=versionOf(c,key);else checkVersion(payload[field],c,key);deps[field]={resource:key,field:key.startsWith('group:')?'revision':key==='timer'?'timerVersion':key.startsWith('diary:')&&kind==='timer_post'?'hoursVersion':'version'};};
    const effect=(key,field)=>{effects[key]=field;};
    if(kind==='group_save'){
      if(p.role==='publisher'||!c.groups.some(g=>g.id===payload.groupId)||p.role==='superintendent'&&p.defaultGroupId!==payload.groupId)throw new Errors.AccessDeniedError();
      const key='group:'+payload.groupId;get(key);requireVersion('expectedRevision',key);C.validate(payload.state);const v=version(key,'revision'),state=clone(payload.state);state.revision=v;
      result={state,revision:v,updatedAt:new Date(stamp()).toISOString(),queued:true};set(key,result);effect(key,'revision');
    }else{
      if(p.role!=='publisher'||payload.groupId!==p.defaultGroupId||payload.personId!==p.publisherId)throw new Errors.AccessDeniedError();
      const today=dayAt(stamp()),current=today.slice(0,7),own=person();if(!own)throw unavailable();
      if(kind==='diary_launch'){
        if(!uuid(payload.id)||typeof payload.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)||new Date(payload.date+'T12:00:00Z').toISOString().slice(0,10)!==payload.date||payload.date>today||!(payload.minutes===null||integer(payload.minutes,0,C.DIARY_LIMITS.maxMinutes))||!(payload.note===null||typeof payload.note==='string'&&payload.note.length<=C.DIARY_LIMITS.maxNoteLength))throw new OfflineError('Confira o lançamento.','invalid_input');
        const key='diary:'+payload.date.slice(0,7),diary=get(key);if(!['regular','auxiliary'].includes(diary.kind))throw new OfflineError('Este mês não é de pioneiro.','invalid_input');requireVersion('expectedVersion',key);
        const old=diary.launches.find(x=>x.id===payload.id);if(old&&old.date!==payload.date)throw new OfflineError('A data do lançamento deve ser preservada.','invalid_input');
        diary.launches=diary.launches.filter(x=>x.id!==payload.id);if(payload.minutes!==null)diary.launches.push({id:payload.id,date:payload.date,minutes:payload.minutes,note:payload.note===null?old?.note||'':payload.note});
        diary.entries={};for(const item of diary.launches)diary.entries[item.date]=(diary.entries[item.date]||0)+item.minutes;
        diary.totalMinutes=Object.values(diary.entries).reduce((a,b)=>a+b,0);if(diary.totalMinutes>C.DIARY_LIMITS.maxMinutes||diary.launches.length>1000||new TextEncoder().encode(JSON.stringify(diary.launches)).length>262144)throw new OfflineError('O mês ultrapassa os limites do diário.','invalid_input');
        diary.version=version(key,'version');diary.updatedAt=new Date(stamp()).toISOString();result={...diary,unchanged:false,queued:true};set(key,diary);deriveAnnual(c,diary.month);effect(key,'version');
      }else if(['report_manual','report_diary'].includes(kind)){
        const month=payload.month;if(!C.validMonth(month)||month>current||!C.inPeriod(own,month)&&!C.getReport(c.resources.card.value.state,own.id,month))throw new OfflineError('Este mês não está disponível.','invalid_month');
        const key='report:'+month,diary=kind==='report_diary'?get('diary:'+month):null,ownKind=C.kindAt(c.resources.card.value.state,own,month);
        requireVersion(kind==='report_diary'?'expectedReportVersion':'expectedVersion',key);
        let report;if(diary){requireVersion('expectedHoursVersion','diary:'+month);if(!diary.launches.length||!['regular','auxiliary'].includes(diary.kind))throw new OfflineError('Registre as horas antes de enviar.','invalid_input');report=activity({participated:diary.totalMinutes>0?true:payload.participated,hours:Math.round(diary.totalMinutes/60*100)/100,studies:payload.studies},ownKind);}
        else report=activity(payload.report,ownKind);
        const v=version(key,'version'),card=get('card'),prior=card.revisions.find(x=>x.month===month);card.revisions=card.revisions.filter(x=>x.month!==month);card.revisions.push({id:prior?.id||operationId,month,status:confirmation?.status||'queued',version:v,report:{...report,kind:ownKind,received:true},submittedAt:new Date(stamp()).toISOString(),reviewedAt:null});
        if(confirmation?.status==='accepted'){card.state.reports[month]??={};card.state.reports[month][own.id]={...report,kind:ownKind,received:true,notes:'',receivedDate:today,updatedAt:new Date(stamp()).toISOString()};}if(confirmation?.revision){card.revision=confirmation.revision;card.state.revision=confirmation.revision;}set('card',card);deriveAnnual(c,month);
        result={status:'queued',version:v,groupId:p.defaultGroupId,personId:p.publisherId,month,revision:card.revision,queued:true,...(diary?{hoursVersion:diary.version,totalMinutes:diary.totalMinutes}:{})};effect(key,'version');
      }else if(['annual_goal','annual_retro'].includes(kind)){
        if(!Number.isInteger(payload.serviceYear)||payload.serviceYear<1900||payload.serviceYear>2198||payload.serviceYear>C.serviceYearForMonth(current))throw new OfflineError('Ano inválido.','invalid_input');
        const key='annual:'+payload.serviceYear,annual=get(key);requireVersion('expectedVersion',key);
        if(kind==='annual_goal'){if(!integer(payload.targetMinutes,1,C.DIARY_LIMITS.maxMinutes*12))throw new OfflineError('Meta inválida.','invalid_input');annual.targetMinutes=payload.targetMinutes;}
        else{const row=annual.months.find(x=>x.month===payload.month);if(!row?.canEditRetro||!(payload.minutes===null&&payload.studies===null||integer(payload.minutes,0,C.DIARY_LIMITS.maxMinutes)&&integer(payload.studies,0,9999)))throw new OfflineError('Histórico inválido ou indisponível.','invalid_input');row.minutes=row.retroMinutes=payload.minutes;row.studies=row.retroStudies=payload.studies;row.source=payload.minutes===null?'missing':'retroactive';}
        annual.version=version(key,'version');annual.updatedAt=new Date(stamp()).toISOString();C.regularAnnualProgress(annual);set(key,annual);result={...annual,unchanged:false,queued:true};effect(key,'version');
      }else if(kind==='timer_change'){
        const key='timer',timer=get(key);requireVersion('expectedVersion',key);if(!uuid(payload.timerId)||!['start','pause','resume','stop','discard'].includes(payload.action)||!integer(payload.elapsedMs)||!Number.isFinite(Date.parse(payload.at)))throw new OfflineError('Cronômetro inválido.','invalid_input');
        const states={start:'idle',pause:'running',resume:'paused',stop:timer.status,discard:'stopped'};if(timer.status!==states[payload.action]||payload.action==='stop'&&!['running','paused'].includes(timer.status)||payload.action!=='start'&&timer.timerId!==payload.timerId)throw new OfflineError('Atualize o cronômetro.','conflict');
        if(payload.action==='start'&&(!C.inPeriod(own,current)||!['regular','auxiliary'].includes(C.kindAt(c.resources.card.value.state,own,current))))throw new OfflineError('Inicie em um mês de pioneiro.','invalid_input');
        const next={...timer,version:version(key,'timerVersion'),serverNow:payload.at};
        if(payload.action==='start')Object.assign(next,{timerId:payload.timerId,status:'running',startDate:dayAt(Date.parse(payload.at)),startedAt:payload.at,anchorAt:payload.at,stoppedAt:null,accumulatedMs:0,elapsedMs:0});
        else if(payload.action==='discard')Object.assign(next,{timerId:null,status:'idle',startDate:null,startedAt:null,anchorAt:null,stoppedAt:null,accumulatedMs:0,elapsedMs:0});
        else if(payload.action==='resume')Object.assign(next,{status:'running',anchorAt:payload.at,elapsedMs:payload.elapsedMs,accumulatedMs:payload.elapsedMs});
        else Object.assign(next,{status:payload.action==='pause'?'paused':'stopped',anchorAt:null,elapsedMs:payload.elapsedMs,accumulatedMs:payload.elapsedMs,stoppedAt:payload.action==='stop'?payload.at:null});
        set(key,next);c.resources[key].at=Date.parse(payload.at);result={...next,unchanged:false,queued:true};effect(key,'timerVersion');
      }else if(kind==='timer_post'){
        const timer=get('timer');requireVersion('expectedTimerVersion','timer');if(timer.status!=='stopped'||timer.timerId!==payload.timerId)throw new OfflineError('Pare o cronômetro antes de lançar.','conflict');
        const key='diary:'+String(payload.date).slice(0,7);requireVersion('expectedHoursVersion',key);
        if(get(key).launches.some(item=>item.id===payload.launchId))throw new OfflineError('Identificador de lançamento já usado.','conflict');
        const diaryResult=project(c,'diary_launch',{...payload,id:payload.launchId,expectedVersion:payload.expectedHoursVersion},operationId,confirmation?{version:confirmation.hoursVersion}:null).result;
        const next={...timer,timerId:null,status:'idle',version:version('timer','timerVersion'),startDate:null,startedAt:null,anchorAt:null,stoppedAt:null,accumulatedMs:0,elapsedMs:0,serverNow:new Date(stamp()).toISOString()};set('timer',next);effect('timer','timerVersion');effect(key,'hoursVersion');
        result={timer:next,diary:diaryResult,launchId:payload.launchId,unchanged:false,queued:true,receipt:{timerId:payload.timerId,launchId:payload.launchId,date:payload.date,minutes:payload.minutes,note:payload.note,postedAt:new Date(stamp()).toISOString()}};
      }else throw new OfflineError('Operação indisponível offline.','online_required');
    }return {result,effects,deps};
  }
  async function enqueue(kind,args){
    let row=await ensure();if(!row){await ready();row=active;}if(!row)throw unavailable();if(row.blocked)throw new Errors.AccessDeniedError();const userId=row.userId,operationId=id();let output;
    const payload={...clone(args),userId,groupId:kind==='group_save'?args.groupId:row.cache.profile.defaultGroupId,personId:kind==='group_save'?null:row.cache.profile.publisherId};
    const saved=await transact(userId,current=>{if(!current||current.binding!==row.binding||current.blocked)throw new Errors.AccessDeniedError();
      const cache=clone(current.cache),projected=project(cache,kind,payload,operationId),dependencies={};
      for(const [field,dep] of Object.entries(projected.deps)){const previous=current.tails[dep.resource];if(previous)dependencies[field]={operationId:previous.operationId,field:previous.field};}
      current.cache=cache;current.generation=(current.generation||0)+1;const op={id:operationId,kind,payload,dependencies,effects:projected.effects,state:'queued',createdAt:new Date(stamp()).toISOString(),resolved:null};current.outbox.push(op);
      for(const [resource,field] of Object.entries(projected.effects))current.tails[resource]={operationId,field};output=projected.result;return current;
    });if(!await still(userId))throw new Errors.AuthRequiredError();active=saved;lastError=null;notify();if(isOnline())setTimeout(()=>{sync().catch(()=>{});},0);return clone(output);
  }
  async function sync(){
    if(syncPromise)return syncPromise;if(!isOnline())return getSyncStatus();syncPromise=(async()=>{
      let row=await ensure();if(!row)return getSyncStatus();const userId=row.userId;
      async function work(){
        let lease=await transact(userId,r=>{if(!r)return null;if(r.lock&&r.lock.until>stamp()&&r.lock.owner!==owner)return r;r.lock={owner,until:stamp()+LEASE_MS};return r;});
        if(!lease||lease.lock?.owner!==owner)return;const heartbeat=setInterval(()=>{transact(userId,r=>{if(r?.lock?.owner===owner)r.lock.until=stamp()+LEASE_MS;return r;}).catch(()=>{});},10000);
        try{
          while(isOnline()&&await still(userId)){
            row=await transact(userId);if(!row||row.lock?.owner!==owner)return;active=row;if(row.blocked||row.outbox[0]?.state==='conflict')break;
            if(!row.outbox.length){try{const snap=await remote(()=>cloud.offlineSnapshot());if(await still(userId))await installSnapshot(snap,userId,row.generation||0);}catch(error){if(['auth_required','access_denied'].includes(error?.code))await block(userId,error.code);lastError='Não foi possível atualizar os dados confirmados.';}break;}
            const p=await remote(()=>cloud.profile());if(!await still(userId))return;
            if(p.userId!==userId||binding(p)!==row.binding){await block(userId,'binding_changed');break;}
            const op=row.outbox[0];let resolved;
            active=await transact(userId,r=>{if(!r||r.lock?.owner!==owner||r.outbox[0]?.id!==op.id)return r;const item=r.outbox[0];
              if(!item.resolved){item.resolved=clone(item.payload);for(const [field,ref] of Object.entries(item.dependencies)){const confirmation=r.confirmations[ref.operationId];if(!confirmation||!integer(confirmation[ref.field]))throw new OfflineError('Dependência de sincronização indisponível.','conflict');item.resolved[field]=confirmation[ref.field];}
                if(item.kind==='group_save')item.resolved.state.revision=item.resolved.expectedRevision+1;}
              item.state='sending';resolved=clone(item.resolved);return r;
            });if(!resolved||!await still(userId))return;
            try{
              const ack=await remote(()=>cloud.applyOfflineOperation({operationId:op.id,kind:op.kind,payload:resolved}));if(!await still(userId))return;
              if(ack.operationId!==op.id||ack.kind!==op.kind||!ack.confirmation)throw new OfflineError('Confirmação inválida.','invalid_response');
              active=await transact(userId,r=>{if(!r||r.lock?.owner!==owner||r.outbox[0]?.id!==op.id)return r;
                project(r.base,op.kind,clone(resolved),op.id,ack.confirmation);r.confirmations[op.id]=clone(ack.confirmation);r.outbox.shift();
                r.cache=clone(r.base);for(const pending of r.outbox)project(r.cache,pending.kind,clone(pending.payload),pending.id,{});r.generation=(r.generation||0)+1;lastError=null;return r;
              });notify();
            }catch(error){if(!await still(userId))return;const code=error?.code||'network_error';const failed=await transact(userId,r=>{if(!r||r.lock?.owner!==owner||r.outbox[0]?.id!==op.id)return r;const item=r.outbox[0];
                if(['auth_required','access_denied'].includes(code))r.blocked=code;
                else if(['conflict','22023','invalid_input','invalid_operation'].includes(code)){item.state='conflict';item.errorCode=code;}
                else item.state='queued';return r;});if(!await still(userId))return;active=failed;lastError='A sincronização não foi confirmada. As alterações permanecem neste aparelho.';notify();break;}
          }
        }finally{clearInterval(heartbeat);await transact(userId,r=>{if(r?.lock?.owner===owner)r.lock=null;return r;});}
      }
      try{if(globalThis.navigator?.locks?.request)await globalThis.navigator.locks.request('em-dia-sync:'+userId,{ifAvailable:true},lock=>lock?work():undefined);else await work();}
      catch(error){if(['auth_required','access_denied'].includes(error?.code))await block(userId,error.code);lastError='Não foi possível sincronizar. Preserve as alterações deste aparelho.';notify();}
      return getSyncStatus();
    })();notify();try{return await syncPromise;}finally{syncPromise=null;notify();}
  }
  async function hasPending(){const row=await ensure();return !!row?.outbox.length;}
  async function exportPending(){const row=await ensure();if(!row)throw unavailable();return {app:'em-dia-offline-pending',version:1,exportedAt:new Date(stamp()).toISOString(),userId:row.userId,profile:clone(row.cache.profile),base:clone(row.base),projected:clone(row.cache),operations:clone(row.outbox)};}
  async function discardPending(){const row=await ensure();if(!row)throw unavailable();if(syncPromise)throw new OfflineError('Aguarde a sincronização terminar.','sync_busy');if(!isOnline())throw new OfflineError('Conecte-se para conferir a nuvem antes de descartar a fila.','online_required');
    const userId=row.userId;let snapshot;try{snapshot=await remote(()=>cloud.offlineSnapshot());}catch(error){await remoteFailure(error,userId,true);throw error;}const cache=cacheSnapshot(snapshot,userId);if(!await still(userId))throw new Errors.AuthRequiredError();if(binding(cache.profile)!==row.binding){await block(userId,'binding_changed');throw new Errors.AccessDeniedError();}
    const ids=row.outbox.map(op=>op.id);active=await transact(userId,r=>{if(!r||r.binding!==row.binding)throw new Errors.AccessDeniedError();if(r.lock&&r.lock.until>stamp())throw new OfflineError('Outra aba está sincronizando.','sync_busy');if(!equal(ids,r.outbox.map(op=>op.id)))throw new OfflineError('A fila mudou em outra aba. Confira novamente.','conflict');r.outbox=[];r.base=clone(cache);r.cache=cache;r.confirmations={};r.tails={};r.blocked=null;r.generation=(r.generation||0)+1;r.lastSyncedAt=new Date(stamp()).toISOString();return r;});lastError=null;notify();return getSyncStatus();}
  async function logoutSafe(){const row=await ensure(),userId=row?.userId||await identityId();if(row?.outbox.length)throw new OfflineError('Sincronize ou preserve e descarte as alterações pendentes antes de sair.','pending_changes');
    if(syncPromise)throw new OfflineError('Aguarde a sincronização terminar.','sync_busy');loggingOut=true;try{if(row)await transact(row.userId,r=>{if(r?.outbox.length||r?.lock&&r.lock.until>stamp())throw new OfflineError('Há alterações pendentes ou outra aba sincronizando.','pending_changes');return null;});if(await identityId()!==userId)throw new Errors.AuthRequiredError();
      try{await remote(()=>cloud.logout({local:true}));}catch(_){/* Verify below whether the SDK actually removed its local session. */}
      const after=await identityId();if(userId&&after===userId)throw new OfflineError('Não foi possível encerrar a sessão neste aparelho. Tente sair novamente.','logout_failed');
      if(after)throw new Errors.AuthRequiredError();active=null;notify();for(const fn of authListeners)fn('SIGNED_OUT',null);
    }finally{loggingOut=false;}}
  async function onlineOnly(method,args){if(!isOnline())throw new OfflineError('Esta ação precisa de uma conexão com a internet.','online_required');const mutating=['createGroup','createUser','assignUser','createPublisherUser','transferPublisher','reviewRevision'].includes(method);
    if(mutating&&await hasPending())throw new OfflineError('Sincronize as alterações antes desta ação.','pending_changes');const userId=await identityId();let result;
    try{result=await remote(()=>cloud[method](...args));}catch(error){await remoteFailure(error,userId,false);throw error;}
    if(mutating){if(!await still(userId))return {...result,refreshRequired:true};try{const row=await transact(userId);await installSnapshot(await remote(()=>cloud.offlineSnapshot()),userId,row?.generation||0);}
      catch(error){await remoteFailure(error,userId,true);if(await identityId()===userId){needsRefresh=true;lastError='A ação foi confirmada. Atualize a cópia deste aparelho quando a conexão voltar.';notify();}return {...result,refreshRequired:true};}}
    return result;}
  const api={ready,sync,getSyncStatus,subscribeSync,hasPending,exportPending,discardPending,logoutSafe,
    invalidateAccess:async({userId,reason}={})=>{if(!['auth_required','access_denied'].includes(reason))throw new OfflineError('Motivo de acesso inválido.','invalid_input');if(await identityId()===userId)await block(userId,reason);else await ensure();return getSyncStatus();},
    session:async()=>{let row=await ensure();if(!row&&isOnline()){await ready();row=active;}return row&&!row.blocked?{user:{id:row.userId},offline:!isOnline()}:null;},
    profile:async()=>{const row=await ensure();if(!row||row.blocked)throw new Errors.AuthRequiredError();return clone(row.cache.profile);},
    groups:async()=>{const row=await ensure();if(!row||row.blocked)throw unavailable();return clone(row.cache.groups);},
    read:groupId=>readResource('group:'+groupId),readOwnCard:()=>readResource('card'),readOwnHours:month=>readResource('diary:'+month),readOwnAnnual:year=>readResource('annual:'+year),readOwnTimer:()=>readResource('timer'),listRevisions:groupId=>readResource('revisions:'+groupId),
    save:(state,expectedRevision,groupId)=>enqueue('group_save',{state,expectedRevision,groupId}),
    saveOwnHoursLaunch:args=>enqueue('diary_launch',{id:args.id,date:args.date,minutes:args.minutes,note:args.note??null,expectedVersion:args.expectedVersion}),
    submitOwnReport:args=>enqueue('report_manual',{month:args.month,report:args.report,expectedVersion:args.expectedVersion}),
    submitOwnHours:args=>enqueue('report_diary',{month:args.month,participated:args.participated,studies:args.studies,expectedHoursVersion:args.expectedHoursVersion,expectedReportVersion:args.expectedReportVersion}),
    saveOwnAnnualGoal:args=>enqueue('annual_goal',{serviceYear:args.serviceYear,targetMinutes:args.targetMinutes,expectedVersion:args.expectedVersion}),
    saveOwnAnnualRetro:args=>enqueue('annual_retro',{serviceYear:args.serviceYear,month:args.month,minutes:args.minutes,studies:args.studies,expectedVersion:args.expectedVersion}),
    changeOwnTimer:async args=>{const timer=await readResource('timer');return enqueue('timer_change',{action:args.action,timerId:args.timerId,expectedVersion:args.expectedVersion,at:new Date(stamp()).toISOString(),elapsedMs:args.action==='discard'||args.action==='start'?0:args.action==='resume'?timer.accumulatedMs:timer.elapsedMs});},
    postOwnTimer:args=>enqueue('timer_post',{timerId:args.timerId,expectedTimerVersion:args.expectedTimerVersion,launchId:args.launchId,date:args.date,minutes:args.minutes,note:args.note??'',expectedHoursVersion:args.expectedHoursVersion}),
    logout:logoutSafe,subscribeAuth:fn=>{authListeners.add(fn);const stop=cloud.subscribeAuth?.((event,session)=>{if(event==='SIGNED_OUT'){active=null;notify();}fn(event,session);});return()=>{authListeners.delete(fn);stop?.();};}
  };
  for(const method of ['createGroup','transferGroups','transferPublisher','publisherAccounts','listUsers','createUser','assignUser','createPublisherUser'])api[method]=(...args)=>onlineOnly(method,args);
  for(const method of ['login','loginPassword'])api[method]=async(...args)=>{const result=await onlineOnly(method,args);active=null;await ready();return result;};
  api.saveOwnHours=async({date,minutes,expectedVersion}={})=>{const diary=await readResource('diary:'+String(date).slice(0,7)),items=diary.launches.filter(item=>item.date===date);
    if(items.length>1)throw new OfflineError('Edite os lançamentos individuais desta data.','invalid_input');
    if(!items.length&&minutes===null){if(expectedVersion!==diary.version)throw new OfflineError('Atualize o diário antes de continuar.','conflict');return {...diary,unchanged:true,queued:await hasPending()};}
    return enqueue('diary_launch',{id:items[0]?.id||id(),date,minutes,note:null,expectedVersion});};
  api.reviewRevision=(...args)=>onlineOnly('reviewRevision',args);
  return Object.freeze(api);
}
return Object.freeze({create,OfflineError});
});
