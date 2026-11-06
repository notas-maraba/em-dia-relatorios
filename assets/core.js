/* Em dia 1.0 — regras de negócio locais. Sem dependências externas. */
(function(root){'use strict';
const APP='em-dia-relatorios',VERSION=1,MONTHS=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const KINDS={publisher:'Publicador',regular:'Pioneiro regular',auxiliary:'Pioneiro auxiliar'};
// Default targets configured for this application; the private annual goal is adjustable.
const REGULAR_PIONEER_TARGETS=Object.freeze({monthlyHours:50,annualHours:600});
const DIARY_LIMITS=Object.freeze({maxMinutes:744*60,maxNoteLength:1000});
function timerElapsedMs({status,elapsedMs,receivedAt}={},now){
  if(!['idle','running','paused','stopped'].includes(status)||!Number.isSafeInteger(elapsedMs)||elapsedMs<0||
    !Number.isSafeInteger(receivedAt)||receivedAt<0||!Number.isSafeInteger(now)||now<0||status==='idle'&&elapsedMs!==0)throw Error('O cronômetro retornou um tempo inválido.');
  const total=elapsedMs+(status==='running'?Math.max(0,now-receivedAt):0);
  if(!Number.isSafeInteger(total))throw Error('O cronômetro retornou um tempo inválido.');
  return total;
}
const clone=v=>JSON.parse(JSON.stringify(v)),uid=()=> 'p_'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2));
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
const validMonth=s=>typeof s==='string'&&/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(s);
function regularMonthlyGoal({kind,month,today,totalMinutes,entryCount}={}){
  if(kind!=='regular')return null;
  const fail=()=>{throw Error('Dados inválidos para acompanhar a meta mensal.');};
  if(!validMonth(month)||typeof today!=='string'||!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(today))fail();
  const year=Number(today.slice(0,4)),calendarMonth=Number(today.slice(5,7)),day=Number(today.slice(8));
  const checkedDay=new Date(Date.UTC(year,calendarMonth-1,day));
  if(checkedDay.toISOString().slice(0,10)!==today||month>today.slice(0,7))fail();
  const daysInMonth=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate();
  if(!Number.isSafeInteger(entryCount)||entryCount<0||entryCount>daysInMonth||
    !Number.isSafeInteger(totalMinutes)||totalMinutes<0||totalMinutes>DIARY_LIMITS.maxMinutes||(!entryCount&&totalMinutes>0))fail();
  const targetMinutes=REGULAR_PIONEER_TARGETS.monthlyHours*60,closed=month<today.slice(0,7);
  const daysRemaining=closed?0:daysInMonth-day+1;
  if(closed&&entryCount===0)return {targetMinutes,recordedMinutes:0,remainingMinutes:null,excessMinutes:0,
    percentage:null,barPercentage:null,daysRemaining:0,dailyMinutesNeeded:null,closed:true,status:'no_entries'};
  const remainingMinutes=Math.max(0,targetMinutes-totalMinutes),excessMinutes=Math.max(0,totalMinutes-targetMinutes);
  // Keep the displayed 100% milestone for a target that was actually reached.
  const roundedPercentage=Math.round(totalMinutes*1000/targetMinutes)/10;
  const percentage=remainingMinutes>0?Math.min(99.9,roundedPercentage):roundedPercentage;
  return {targetMinutes,recordedMinutes:totalMinutes,remainingMinutes,excessMinutes,percentage,
    barPercentage:Math.min(100,percentage),daysRemaining,
    dailyMinutesNeeded:remainingMinutes===0?0:closed?null:Math.ceil(remainingMinutes/daysRemaining),closed,
    status:remainingMinutes===0?'achieved':closed?'closed_short':'in_progress'};
}
function serviceYearForMonth(month){if(!validMonth(month))throw Error('Mês inválido.');return Number(month.slice(0,4))-(Number(month.slice(5,7))<9?1:0);}
function regularAnnualProgress(bundle){
  const fail=()=>{throw Error('Dados inválidos para acompanhar a meta anual.');},nullable=(v,max)=>v===null||Number.isSafeInteger(v)&&v>=0&&v<=max;
  if(!bundle||typeof bundle!=='object'||!Number.isInteger(bundle.serviceYear)||bundle.serviceYear<1900||bundle.serviceYear>2198||
    typeof bundle.today!=='string'||!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(bundle.today))fail();
  const day=new Date(bundle.today+'T12:00:00Z');if(day.toISOString().slice(0,10)!==bundle.today||bundle.serviceYear>serviceYearForMonth(bundle.today.slice(0,7))||
    !Number.isSafeInteger(bundle.targetMinutes)||bundle.targetMinutes<1||bundle.targetMinutes>DIARY_LIMITS.maxMinutes*12||!Array.isArray(bundle.months)||bundle.months.length!==12)fail();
  const months=periodMonths(bundle.serviceYear,'service'),now=bundle.today.slice(0,7),closed=bundle.serviceYear<serviceYearForMonth(now);
  let recordedMinutes=0,knownMonths=0,unknownMonths=0,studies=0,knownStudyMonths=0,unknownStudyMonths=0;
  Array.from(bundle.months).forEach((row,i)=>{
    if(!row||row.month!==months[i]||!['regular','auxiliary','publisher'].includes(row.kind)||!['approved','diary','retroactive','missing','future','not_regular'].includes(row.source)||
      !nullable(row.minutes,DIARY_LIMITS.maxMinutes)||!nullable(row.studies,9999)||!nullable(row.retroMinutes,DIARY_LIMITS.maxMinutes)||!nullable(row.retroStudies,9999)||
      (row.retroMinutes===null)!==(row.retroStudies===null)||typeof row.canEditRetro!=='boolean'||(row.source==='future')!==(row.month>now)||
      row.canEditRetro!==(row.month<now&&['missing','retroactive'].includes(row.source))||
      (['approved','diary','retroactive','missing'].includes(row.source)&&row.kind!=='regular')||
      (['future','missing','not_regular'].includes(row.source)&&(row.minutes!==null||row.studies!==null))||
      (row.source==='diary'&&(row.minutes===null||row.studies!==null))||
      (row.source==='retroactive'&&(row.minutes===null||row.studies===null||row.minutes!==row.retroMinutes||row.studies!==row.retroStudies)))fail();
    if(row.kind!=='regular'||['future','not_regular'].includes(row.source))return;
    if(row.minutes===null)unknownMonths++;else{knownMonths++;recordedMinutes+=row.minutes;}
    if(row.studies===null)unknownStudyMonths++;else{knownStudyMonths++;studies+=row.studies;}
  });
  const remainingMinutes=Math.max(0,bundle.targetMinutes-recordedMinutes),excessMinutes=Math.max(0,recordedMinutes-bundle.targetMinutes),
    rounded=Math.round(recordedMinutes*1000/bundle.targetMinutes)/10,percentage=remainingMinutes>0?Math.min(99.9,rounded):rounded,
    monthsRemaining=closed?0:months.filter(month=>month>=now).length;
  return {serviceYear:bundle.serviceYear,targetMinutes:bundle.targetMinutes,recordedMinutes,remainingMinutes,excessMinutes,percentage,
    barPercentage:Math.min(100,percentage),knownMonths,unknownMonths,studies,knownStudyMonths,unknownStudyMonths,monthsRemaining,
    monthlyMinutesNeeded:closed?null:Math.ceil(remainingMinutes/monthsRemaining),closed,
    status:remainingMinutes===0?'achieved':closed?(knownMonths?'closed_short':'no_entries'):'in_progress'};
}
function publisherReportText({name,month,kind,participated,minutes,studies}={}){
  const fail=()=>{throw Error('Preencha os dados completos do relatório antes de compartilhar.');};
  if(typeof name!=='string'||!name.trim()||name.length>160||/[\x00-\x1f\x7f]/.test(name)||!validMonth(month)||!['regular','auxiliary','publisher'].includes(kind)||
    !Number.isSafeInteger(studies)||studies<0||studies>9999||!(participated===null||typeof participated==='boolean'))fail();
  const lines=['Prezado irmão, segue o meu relatório do mês de "'+monthLabel(month)+'"','- Nome: '+name.trim()];
  if(kind==='publisher'){
    if(typeof participated!=='boolean'||minutes!==null)fail();
    lines.push('- Participou no ministério?',participated?'Sim':'Não','- Tem estudos bíblicos?',studies?'Sim, '+studies:'Não');
  }else{
    if(!Number.isSafeInteger(minutes)||minutes<0||minutes>DIARY_LIMITS.maxMinutes)fail();
    lines.push('- Horas: '+String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')+'h','- Estudos: '+studies);
  }
  return lines.join('\n');
}
function currentMonth(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
function addMonth(m,n){if(!validMonth(m))throw Error('Mês inválido.');const [y,a]=m.split('-').map(Number),d=new Date(y,a-1+n,1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
const monthLabel=m=>validMonth(m)?MONTHS[Number(m.slice(5))-1]+' de '+m.slice(0,4):'Mês não informado';
function emptyState(){return {app:APP,version:VERSION,revision:0,updatedAt:null,lastBackupAt:null,settings:{congregation:'',group:'',reminder:'Olá, {nome}! Tudo bem? Estou organizando os relatórios de {mes}. Quando puder, por favor, me envie o seu relatório. Muito obrigado pelo seu apoio!'},people:[],reports:{},reminders:{},activeMonth:addMonth(currentMonth(),-1),sourceNote:''};}
const num=v=>v===null||v===''||v===undefined?null:Number(String(v).replace(',','.'));
const number=v=>v===null||v===undefined?'Não informado':new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(v);
const inPeriod=(p,m)=>m>=p.startMonth&&(!p.endMonth||m<=p.endMonth);
function roleAt(p,m){const r=p.roles.find(r=>r.start<=m&&(!r.end||r.end>=m));return r?r.kind:'publisher';}
const getReport=(s,id,m)=>s.reports[m]?.[id]||null,kindAt=(s,p,m)=>getReport(s,p.id,m)?.kind||roleAt(p,m);
function participation(r){if(!r)return null;if(r.kind!=='publisher'&&r.hours!==null&&r.hours>0)return true;return r.participated;}
function missing(r){if(!r)return ['relatório'];const a=[];if(r.kind==='publisher'&&r.participated===null)a.push('participação');if(r.kind!=='publisher'&&r.hours===null)a.push('horas');if(r.studies===null)a.push('estudos bíblicos');return a;}
const status=r=>!r?.received?'pending':missing(r).length?'review':'complete';
const monthPeople=(s,m)=>s.people.filter(p=>inPeriod(p,m)||!!getReport(s,p.id,m)).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
function monthly(s,m,filter='all',q=''){return monthPeople(s,m).map(p=>{const r=getReport(s,p.id,m);return {p,r,kind:kindAt(s,p,m),status:status(r)};}).filter(x=>(!q||norm(x.p.name).includes(norm(q)))&&(filter==='all'||filter==='pending'&&x.status==='pending'||filter==='received'&&x.status!=='pending'||filter==='review'&&x.status==='review'||filter==='pioneers'&&x.kind!=='publisher'));}
function summary(s,m){const rows=monthly(s,m),a={total:rows.length,received:0,pending:0,review:0,complete:0,participants:0,notParticipated:0,unknownParticipation:0,studies:0,unknownStudies:0,regularHours:0,auxiliaryHours:0,unknownHours:0,regularCount:0,auxiliaryCount:0};for(const x of rows){if(x.status==='pending'){a.pending++;continue;}a.received++;a[x.status]++;const v=participation(x.r);if(v===true)a.participants++;else if(v===false)a.notParticipated++;else a.unknownParticipation++;if(x.r.studies===null)a.unknownStudies++;else a.studies+=x.r.studies;if(x.kind==='regular'){a.regularCount++;if(x.r.hours===null)a.unknownHours++;else a.regularHours+=x.r.hours;}if(x.kind==='auxiliary'){a.auxiliaryCount++;if(x.r.hours===null)a.unknownHours++;else a.auxiliaryHours+=x.r.hours;}}a.hours=Math.round((a.regularHours+a.auxiliaryHours)*100)/100;a.regularHours=Math.round(a.regularHours*100)/100;a.auxiliaryHours=Math.round(a.auxiliaryHours*100)/100;return a;}
function periodMonths(year,cycle='civil'){const start=year+(cycle==='service'?'-09':'-01');return Array.from({length:12},(_,i)=>addMonth(start,i));}
function annualDetail(s,p,months,now=currentMonth()){return months.map(m=>{const r=getReport(s,p.id,m),scope=inPeriod(p,m)||!!r;const label=!scope?'Sem acompanhamento':r?.received?(missing(r).length?'Recebido: conferir':'Recebido'):m>now?'Mês futuro':m===now?'Em andamento':'Pendente';return {month:m,r,kind:kindAt(s,p,m),scope,label,pending:scope&&!r?.received&&m<now};});}
function annualSummary(s,p,months,now=currentMonth()){const detail=annualDetail(s,p,months,now),rr=detail.filter(x=>x.r?.received);return {p,detail,received:rr.length,pending:detail.filter(x=>x.pending).length,review:rr.filter(x=>missing(x.r).length).length,monthsWithActivity:rr.filter(x=>participation(x.r)===true).length,pioneerMonths:rr.filter(x=>x.kind!=='publisher').length,hours:Math.round(rr.reduce((v,x)=>v+(x.kind!=='publisher'?(x.r.hours||0):0),0)*100)/100,studies:rr.reduce((v,x)=>v+(x.r.studies||0),0),knownStudies:rr.filter(x=>x.r.studies!==null).length,unknownHours:rr.filter(x=>x.kind!=='publisher'&&x.r.hours===null).length};}
function report(s,p,m){return clone(getReport(s,p.id,m)||{received:false,kind:roleAt(p,m),participated:null,hours:null,studies:null,notes:'',receivedDate:null,updatedAt:null});}
function validate(s){
const fail=t=>{throw Error(t);},obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),text=(v,n=500)=>typeof v==='string'&&v.length<=n,ts=v=>v===null||typeof v==='string'&&v.length<=40&&!Number.isNaN(Date.parse(v));
const safeId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
if(!obj(s)||s.app!==APP||s.version!==VERSION)fail('Arquivo incompatível. Use um backup do Em dia, versão 1.');
if(!Number.isSafeInteger(s.revision)||s.revision<0||!ts(s.updatedAt)||!ts(s.lastBackupAt))fail('Metadados inválidos.');
if(!obj(s.settings)||!text(s.settings.congregation,120)||!text(s.settings.group,120)||!text(s.settings.reminder,1500))fail('Configurações inválidas.');
if(!validMonth(s.activeMonth)||!text(s.sourceNote||'',1500))fail('Mês ou nota de origem inválidos.');
if(!Array.isArray(s.people)||s.people.length>5000||!obj(s.reports)||!obj(s.reminders))fail('Estrutura inválida.');
const ids=new Set();for(const p of s.people){if(!obj(p)||!safeId(p.id)||ids.has(p.id)||!text(p.name,160)||!p.name.trim()||!text(p.notes||'',2000)||!validMonth(p.startMonth)||!(p.endMonth===null||validMonth(p.endMonth)&&p.endMonth>=p.startMonth))fail('Há um publicador com dados inválidos.');ids.add(p.id);if(!Array.isArray(p.roles)||p.roles.length>200)fail('Períodos de pioneiro inválidos.');const roles=[...p.roles].sort((a,b)=>String(a.start).localeCompare(String(b.start)));roles.forEach((r,i)=>{if(!obj(r)||!['regular','auxiliary'].includes(r.kind)||!validMonth(r.start)||!(r.end===null||validMonth(r.end)&&r.end>=r.start))fail('Período de pioneiro inválido.');if(i&&(!roles[i-1].end||roles[i-1].end>=r.start))fail('Dois períodos de pioneiro se sobrepõem. Ajuste as datas.');});}
let count=0;for(const [m,entries] of Object.entries(s.reports)){if(!validMonth(m)||!obj(entries))fail('Mês inválido nos relatórios.');for(const [id,r] of Object.entries(entries)){if(!ids.has(id)||!obj(r)||typeof r.received!=='boolean'||!Object.keys(KINDS).includes(r.kind)||!(r.participated===null||typeof r.participated==='boolean'))fail('Relatório inválido ou sem publicador.');if(!(r.hours===null||typeof r.hours==='number'&&Number.isFinite(r.hours)&&r.hours>=0&&r.hours<=744&&Math.abs(r.hours*100-Math.round(r.hours*100))<1e-7))fail('Horas inválidas: informe de 0 a 744, com até duas casas decimais.');if(r.kind==='publisher'&&r.hours!==null)fail('Horas devem ser informadas somente para pioneiros.');if(!(r.studies===null||Number.isSafeInteger(r.studies)&&r.studies>=0&&r.studies<=9999))fail('Estudos devem ser um número inteiro entre 0 e 9999.');if(!text(r.notes||'',2000)||!ts(r.updatedAt)||!(r.receivedDate===null||typeof r.receivedDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.receivedDate)&&!Number.isNaN(Date.parse(r.receivedDate))))fail('Dados adicionais do relatório inválidos.');if(++count>100000)fail('Limite de 100.000 relatórios excedido.');}}
for(const [m,entries] of Object.entries(s.reminders)){if(!validMonth(m)||!obj(entries))fail('Lembretes inválidos.');for(const [id,v] of Object.entries(entries)){if(!ids.has(id)||!obj(v)||!ts(v.at)||!Number.isSafeInteger(v.count)||v.count<1)fail('Registro de lembrete inválido.');}}return true;
}
function parseBackup(raw){if(typeof raw!=='string'||raw.length>12*1024*1024)throw Error('Backup muito grande. Limite: 12 MB.');let s;try{s=JSON.parse(raw,(k,v)=>{if(['__proto__','prototype','constructor'].includes(k))throw Error('Chave não permitida.');return v;});}catch(e){throw Error('JSON inválido. Selecione um backup original do Em dia.');}validate(s);return s;}
function monthlyText(s,m,scope='received'){const a=summary(s,m),lines=['Relatórios de '+monthLabel(m),[s.settings.congregation,s.settings.group].filter(Boolean).join(' · '),'Resumo do mês: '+a.received+'/'+a.total+' recebidos | '+a.pending+' pendentes | '+a.review+' a conferir',''];for(const {p,r,status:st,kind} of monthly(s,m,scope)){lines.push('Nome: '+p.name,'Mês: '+monthLabel(m));if(st==='pending')lines.push('Situação: Pendente');else{if(kind==='publisher')lines.push('- Participou no ministério? '+(r.participated===null?'Não informado':r.participated?'Sim':'Não'));else lines.push('Horas: '+number(r.hours)+(r.hours!==null?'h':'')+' ('+(kind==='regular'?'Regular':'Auxiliar')+')');lines.push('Estudos bíblicos: '+number(r.studies));if(st==='review')lines.push('Conferir: falta informar '+missing(r).join(', ')+'.');}lines.push('--------------------');}lines.push('Totais dos recebidos: '+number(a.hours)+'h de pioneiros; '+a.studies+' estudos informados.');if(a.unknownStudies||a.unknownHours)lines.push('Totais parciais: há campos não informados.');return lines.join('\n');}
const reminderText=(s,p,m)=>s.settings.reminder.replaceAll('{nome}',p.name).replaceAll('{mes}',monthLabel(m));
const api={APP,VERSION,MONTHS,KINDS,REGULAR_PIONEER_TARGETS,DIARY_LIMITS,timerElapsedMs,regularMonthlyGoal,serviceYearForMonth,regularAnnualProgress,publisherReportText,clone,uid,norm,validMonth,currentMonth,addMonth,monthLabel,emptyState,num,number,inPeriod,roleAt,getReport,kindAt,participation,missing,status,monthPeople,monthly,summary,periodMonths,annualDetail,annualSummary,report,validate,parseBackup,monthlyText,reminderText};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.EmDiaCore=api;
})(typeof window!=='undefined'?window:globalThis);
