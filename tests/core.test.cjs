'use strict';
const assert=require('node:assert/strict'),C=require('../assets/core.js'),PDF=require('../assets/pdf.js');
let count=0;const test=(name,fn)=>{fn();count++;console.log('OK',name);};
const person=(id='p1')=>({id,name:'Pessoa de teste',startMonth:'2026-09',endMonth:null,notes:'',roles:[]});
const setup=()=>{const s=C.emptyState();s.activeMonth='2026-09';s.people.push(person());return s;};
const record=(kind='publisher')=>({received:true,kind,participated:true,hours:kind==='publisher'?null:10,studies:0,notes:'',receivedDate:null,updatedAt:null});
test('Estado vazio válido',()=>assert.equal(C.validate(C.emptyState()),true));
test('Meses válidos',()=>assert(C.validMonth('2026-09')&&!C.validMonth('2026-13')&&!C.validMonth('2026-00')));
test('Virada de ano',()=>assert.equal(C.addMonth('2026-12',1),'2027-01'));
test('Mês anterior',()=>assert.equal(C.addMonth('2026-01',-1),'2025-12'));
test('Normaliza busca acentuada',()=>assert.equal(C.norm('  José  da Silva '),'jose da silva'));
test('Decimal com vírgula',()=>assert.equal(C.num('15,5'),15.5));
test('Vazio não é zero',()=>assert.equal(C.num(''),null));
test('Zero explícito é zero',()=>assert.equal(C.num('0'),0));
const goalInput={kind:'regular',month:'2032-04',today:'2032-04-08',totalMinutes:320,entryCount:3};
test('Meta configurada registra 50 horas mensais e 600 anuais sem alterar a versão dos dados',()=>{
  assert.equal(C.regularMonthlyGoal(goalInput).targetMinutes,3000);
  assert.equal(C.REGULAR_PIONEER_TARGETS.annualHours,C.REGULAR_PIONEER_TARGETS.monthlyHours*12);
  assert.equal(C.REGULAR_PIONEER_TARGETS.annualHours,600);
  assert(Object.isFrozen(C.REGULAR_PIONEER_TARGETS));assert.equal(C.VERSION,1);
});
test('Limites do diário são independentes da meta e têm configuração imutável',()=>{
  assert.deepEqual(C.DIARY_LIMITS,{maxMinutes:44640,maxNoteLength:1000});
  assert(Object.isFrozen(C.DIARY_LIMITS));
});
test('Cronômetro usa tempo recebido mais intervalo local somente enquanto está rodando',()=>{
  const timer={status:'running',elapsedMs:90000,receivedAt:1000};
  assert.equal(C.timerElapsedMs(timer,62000),151000);assert.equal(C.timerElapsedMs(timer,500),90000);
  assert.deepEqual(timer,{status:'running',elapsedMs:90000,receivedAt:1000});
  for(const status of ['paused','stopped'])assert.equal(C.timerElapsedMs({...timer,status},62000),90000);
  assert.equal(C.timerElapsedMs({...timer,status:'idle',elapsedMs:0},62000),0);
});
test('Cronômetro continua após intervalo longo sem limitar duração à meta ou ao lançamento',()=>{
  assert.equal(C.timerElapsedMs({status:'running',elapsedMs:4000000000,receivedAt:1000},864001000),4864000000);
});
test('Cronômetro rejeita estados, tempos fracionados, negativos e overflow',()=>{
  const timer={status:'running',elapsedMs:90000,receivedAt:1000};
  for(const patch of [{status:'unknown'},{status:'idle'},{elapsedMs:-1},{elapsedMs:1.5},{elapsedMs:'1'},
    {receivedAt:-1},{receivedAt:NaN},{elapsedMs:Number.MAX_SAFE_INTEGER}])assert.throws(()=>C.timerElapsedMs({...timer,...patch},2000),/cronômetro/);
  for(const now of [undefined,-1,Infinity,1.5,'2000'])assert.throws(()=>C.timerElapsedMs(timer,now),/cronômetro/);
});
test('Meta mensal soma em minutos, informa falta exata e arredonda ritmo para cima',()=>{
  const g=C.regularMonthlyGoal(goalInput);
  assert.equal(g.recordedMinutes,320);assert.equal(g.remainingMinutes,2680);
  assert.equal(g.percentage,10.7);assert.equal(g.barPercentage,10.7);
  assert.equal(g.daysRemaining,23);assert.equal(g.dailyMinutesNeeded,117);assert.equal(g.status,'in_progress');
});
test('Meta conta hoje como dia disponível e o último dia não divide por zero',()=>{
  const g=C.regularMonthlyGoal({...goalInput,today:'2032-04-30',totalMinutes:2999});
  assert.equal(g.daysRemaining,1);assert.equal(g.dailyMinutesNeeded,1);assert.equal(g.remainingMinutes,1);
  assert.equal(g.percentage,99.9);assert.equal(g.barPercentage,99.9);assert.equal(g.status,'in_progress');
});
test('Meta em fevereiro respeita ano bissexto e último dia válido',()=>{
  const g=C.regularMonthlyGoal({...goalInput,month:'2032-02',today:'2032-02-28',totalMinutes:0,entryCount:1});
  assert.equal(g.daysRemaining,2);assert.equal(g.dailyMinutesNeeded,1500);
  assert.equal(C.regularMonthlyGoal({...goalInput,month:'2032-02',today:'2032-02-29'}).daysRemaining,1);
});
test('Mês encerrado mostra falta registrada e não exige ritmo diário impossível',()=>{
  const g=C.regularMonthlyGoal({...goalInput,today:'2032-05-01'});
  assert.equal(g.closed,true);assert.equal(g.status,'closed_short');assert.equal(g.daysRemaining,0);
  assert.equal(g.remainingMinutes,2680);assert.equal(g.dailyMinutesNeeded,null);
});
test('Mês encerrado sem diário mantém progresso desconhecido em vez de inventar falta',()=>{
  const g=C.regularMonthlyGoal({...goalInput,today:'2032-05-01',totalMinutes:0,entryCount:0});
  assert.equal(g.status,'no_entries');assert.equal(g.targetMinutes,3000);assert.equal(g.recordedMinutes,0);
  for(const key of ['remainingMinutes','percentage','barPercentage','dailyMinutesNeeded'])assert.equal(g[key],null);
});
test('Zero explícito em mês encerrado é distinto de ausência de lançamentos',()=>{
  const g=C.regularMonthlyGoal({...goalInput,today:'2032-05-01',totalMinutes:0,entryCount:1});
  assert.equal(g.status,'closed_short');assert.equal(g.remainingMinutes,3000);assert.equal(g.percentage,0);
});
test('Mês corrente vazio permite planejar sem tratar lançamento ausente como entregue',()=>{
  const g=C.regularMonthlyGoal({...goalInput,totalMinutes:0,entryCount:0,today:'2032-04-01'});
  assert.equal(g.status,'in_progress');assert.equal(g.recordedMinutes,0);assert.equal(g.daysRemaining,30);
  assert.equal(g.dailyMinutesNeeded,100);
});
test('Meta atingida zera a falta e o ritmo necessário',()=>{
  const g=C.regularMonthlyGoal({...goalInput,totalMinutes:3000});
  assert.equal(g.status,'achieved');assert.equal(g.remainingMinutes,0);assert.equal(g.excessMinutes,0);
  assert.equal(g.dailyMinutesNeeded,0);assert.equal(g.percentage,100);assert.equal(g.barPercentage,100);
});
test('Horas excedentes são preservadas e a barra limita em cem por cento',()=>{
  const g=C.regularMonthlyGoal({...goalInput,totalMinutes:3135});
  assert.equal(g.status,'achieved');assert.equal(g.recordedMinutes,3135);assert.equal(g.excessMinutes,135);
  assert.equal(g.percentage,104.5);assert.equal(g.barPercentage,100);assert.equal(g.remainingMinutes,0);
});
test('Meta é exclusiva de pioneiro regular, sem atribuir 50 horas ao auxiliar',()=>{
  for(const kind of ['auxiliary','publisher',undefined])assert.equal(C.regularMonthlyGoal({...goalInput,kind}),null);
});
test('Meta rejeita calendários inválidos, anos fora do suporte e meses futuros',()=>{
  for(const patch of [{today:'2031-02-29'},{today:'1900-02-29'},{today:'2032-04-31'},
    {today:'2032-4-08'},{today:'2200-01-01'},{month:'1899-12'},{month:'2032-13'},
    {month:'2032-05'},{month:null},{today:null}])assert.throws(()=>C.regularMonthlyGoal({...goalInput,...patch}),/meta mensal/);
  assert.equal(C.regularMonthlyGoal({...goalInput,month:'2000-02',today:'2000-02-29'}).daysRemaining,1);
});
test('Meta aceita horas acumuladas em um dia acima de 24 horas e preserva excedente mensal',()=>{
  const g=C.regularMonthlyGoal({...goalInput,totalMinutes:3300,entryCount:1});
  assert.equal(g.recordedMinutes,3300);assert.equal(g.excessMinutes,300);assert.equal(g.status,'achieved');
  assert.equal(g.percentage,110);assert.equal(g.barPercentage,100);
  assert.equal(C.regularMonthlyGoal({...goalInput,month:'2032-02',today:'2032-02-29',totalMinutes:44640,entryCount:1}).recordedMinutes,44640);
});
test('Meta rejeita totais incoerentes, acima de 744 horas e contagens fora do calendário',()=>{
  for(const patch of [{totalMinutes:-1},{totalMinutes:NaN},{totalMinutes:Infinity},{totalMinutes:1.5},
    {totalMinutes:'320'},{entryCount:0},{entryCount:-1},{entryCount:1.2},{entryCount:31},
    {totalMinutes:44641,entryCount:1},{month:'2032-02',today:'2032-02-29',entryCount:30}]){
    assert.throws(()=>C.regularMonthlyGoal({...goalInput,...patch}),/meta mensal/);
  }
});

const annualFixture=(changes={})=>{
  const serviceYear=changes.serviceYear??2026,today=changes.today??'2026-11-06';
  return {serviceYear,today,targetMinutes:36000,months:C.periodMonths(serviceYear,'service').map(month=>({month,kind:'regular',
    source:month>today.slice(0,7)?'future':'missing',minutes:null,studies:null,retroMinutes:null,retroStudies:null,
    canEditRetro:month<today.slice(0,7)})),...changes};
};
test('Ano de serviço começa em setembro e atravessa agosto do ano seguinte',()=>{
  assert.equal(C.serviceYearForMonth('2026-09'),2026);assert.equal(C.serviceYearForMonth('2027-08'),2026);
  assert.equal(C.serviceYearForMonth('2026-01'),2025);assert.equal(C.serviceYearForMonth('1900-01'),1899);
  for(const month of ['2026-00','2026-13','2026-9',null,2026])assert.throws(()=>C.serviceYearForMonth(month),/Mês inválido/);
});
test('Anual usa uma única fonte por mês e soma somente regulares sem duplicar retroativos',()=>{
  const bundle=annualFixture();
  bundle.months[0]={...bundle.months[0],source:'approved',minutes:3000,studies:2,retroMinutes:2500,retroStudies:3,canEditRetro:false};
  bundle.months[1]={...bundle.months[1],source:'diary',minutes:3300,retroMinutes:3000,retroStudies:4,canEditRetro:false};
  const snapshot=C.clone(bundle),p=C.regularAnnualProgress(bundle);
  assert.equal(p.recordedMinutes,6300);assert.equal(p.remainingMinutes,29700);assert.equal(p.percentage,17.5);
  assert.equal(p.knownMonths,2);assert.equal(p.unknownMonths,1);assert.equal(p.studies,2);
  assert.equal(p.knownStudyMonths,1);assert.equal(p.unknownStudyMonths,2);
  assert.equal(p.monthsRemaining,10);assert.equal(p.monthlyMinutesNeeded,2970);assert.equal(p.closed,false);
  assert.deepEqual(bundle,snapshot);
});
test('Anual preserva zero explícito, desconhecidos e exclui condições fora de regular inclusive após fim do cartão',()=>{
  const bundle=annualFixture();
  bundle.months[0]={...bundle.months[0],source:'retroactive',minutes:0,studies:0,retroMinutes:0,retroStudies:0};
  bundle.months[1]={...bundle.months[1],source:'approved',minutes:null,studies:3,canEditRetro:false};
  bundle.months[2]={...bundle.months[2],source:'not_regular'};
  bundle.months[3].kind='auxiliary';
  const p=C.regularAnnualProgress(bundle);
  assert.equal(p.recordedMinutes,0);assert.equal(p.knownMonths,1);assert.equal(p.unknownMonths,1);
  assert.equal(p.studies,3);assert.equal(p.knownStudyMonths,2);assert.equal(p.unknownStudyMonths,0);
});
test('Anual usa meta ajustada, preserva excesso e fecha sem exigir ritmo futuro',()=>{
  const bundle=annualFixture({targetMinutes:3000});bundle.months[0]={...bundle.months[0],source:'approved',minutes:3600,studies:0,canEditRetro:false};
  const p=C.regularAnnualProgress(bundle);assert.equal(p.excessMinutes,600);assert.equal(p.remainingMinutes,0);
  assert.equal(p.percentage,120);assert.equal(p.barPercentage,100);assert.equal(p.monthlyMinutesNeeded,0);assert.equal(p.status,'achieved');
  const closed=annualFixture({serviceYear:2025});assert.equal(C.regularAnnualProgress(closed).unknownMonths,12);
  assert.equal(C.regularAnnualProgress(closed).status,'no_entries');assert.equal(C.regularAnnualProgress(closed).monthlyMinutesNeeded,null);
  closed.months[0]={...closed.months[0],source:'approved',minutes:1,studies:0,canEditRetro:false};
  assert.equal(C.regularAnnualProgress(closed).status,'closed_short');assert.equal(C.regularAnnualProgress(closed).monthsRemaining,0);
});
test('Anual inclui mês corrente no ritmo e não antecipa a meta por arredondamento',()=>{
  const bundle=annualFixture({today:'2027-08-31'});bundle.months[0]={...bundle.months[0],source:'approved',minutes:35999,studies:0,canEditRetro:false};
  const p=C.regularAnnualProgress(bundle);assert.equal(p.monthsRemaining,1);assert.equal(p.monthlyMinutesNeeded,1);assert.equal(p.percentage,99.9);
  const max=annualFixture({targetMinutes:535680});max.months[0]={...max.months[0],source:'approved',minutes:44640,studies:9999,canEditRetro:false};
  assert.equal(C.regularAnnualProgress(max).targetMinutes,535680);
});
test('Anual rejeita meses duplicados, futuros falsos, tipos e fontes incoerentes sem inventar valores',()=>{
  const base=annualFixture();
  for(const changes of [{serviceYear:2027},{serviceYear:'2026'},{serviceYear:1899},{targetMinutes:0},{targetMinutes:535681},
    {targetMinutes:1.5},{today:'2026-02-30'},{months:base.months.slice(1)},{months:Array(12)}])assert.throws(()=>C.regularAnnualProgress({...base,...changes}),/meta anual/);
  for(const changes of [{month:'2026-10'},{kind:'admin'},{source:'diary'},{source:'missing',minutes:0},
    {source:'approved',kind:'publisher',canEditRetro:false},{source:'future',canEditRetro:false},
    {retroMinutes:0},{studies:10000},{minutes:44641},{canEditRetro:false}]){
    const bundle=annualFixture();bundle.months[0]={...bundle.months[0],...changes};assert.throws(()=>C.regularAnnualProgress(bundle),/meta anual/);
  }
});
test('Texto de pioneiros usa horas e minutos completos e somente atividade escolhida',()=>{
  const input={name:'  Pessoa fictícia  ',month:'2026-11',kind:'regular',participated:null,minutes:1815,studies:2,notes:'PRIVATE_FIXTURE',retroMinutes:1};
  assert.equal(C.publisherReportText(input),'Prezado irmão, segue o meu relatório do mês de "Novembro de 2026"\n- Nome: Pessoa fictícia\n- Horas: 30:15h\n- Estudos: 2');
  assert.match(C.publisherReportText({...input,kind:'auxiliary',minutes:0,studies:0}),/- Horas: 00:00h\n- Estudos: 0$/);
  assert.doesNotMatch(C.publisherReportText(input),/PRIVATE_FIXTURE|retro/);
});
test('Texto do publicador comum usa participação e estudos sem campo de horas',()=>{
  const input={name:'Pessoa fictícia',month:'2026-11',kind:'publisher',participated:true,minutes:null,studies:3};
  assert.equal(C.publisherReportText(input),'Prezado irmão, segue o meu relatório do mês de "Novembro de 2026"\n- Nome: Pessoa fictícia\n- Participou no ministério?\nSim\n- Tem estudos bíblicos?\nSim, 3');
  assert.match(C.publisherReportText({...input,participated:false,studies:0}),/\?\nNão\n- Tem estudos bíblicos\?\nNão$/);
});
test('Texto não compartilha dados incompletos, campos inválidos nem nomes com quebras de linha',()=>{
  const input={name:'Pessoa fictícia',month:'2026-11',kind:'regular',participated:null,minutes:60,studies:0};
  for(const changes of [{name:''},{name:'x'.repeat(161)},{name:'Fixture\nforged'}, {month:'2026-13'},{kind:'admin'},
    {minutes:null},{minutes:44641},{minutes:1.5},{studies:null},{studies:-1},{studies:1.5},{participated:'true'},
    {kind:'publisher',minutes:null},{kind:'publisher',participated:true,minutes:0}])assert.throws(()=>C.publisherReportText({...input,...changes}),/completos/);
});
test('Sem relatório é pendente',()=>assert.equal(C.status(null),'pending'));
test('Recebimento incompleto',()=>assert.equal(C.status({...record(),participated:null,studies:null}),'review'));
test('Não participou é relatório completo',()=>assert.equal(C.status({...record(),participated:false}),'complete'));
test('Horas positivas indicam participação',()=>assert.equal(C.participation({...record('regular'),participated:null}),true));
test('Zero horas não infere ausência de participação',()=>assert.equal(C.participation({...record('regular'),hours:0,participated:null}),null));
test('Pioneiro pode informar zero horas',()=>assert.equal(C.status({...record('regular'),hours:0,participated:null}),'complete'));
test('Auxiliar temporário só no período',()=>{let p=person();p.roles=[{start:'2026-09',end:'2026-09',kind:'auxiliary'}];assert.equal(C.roleAt(p,'2026-09'),'auxiliary');assert.equal(C.roleAt(p,'2026-10'),'publisher');});
test('Pioneiro fixo vale nos meses seguintes',()=>{let p=person();p.roles=[{start:'2026-09',end:null,kind:'regular'}];assert.equal(C.roleAt(p,'2027-01'),'regular');assert.equal(C.roleAt(p,'2026-08'),'publisher');});
test('Períodos sobrepostos são bloqueados',()=>{let s=setup();s.people[0].roles=[{start:'2026-09',end:null,kind:'regular'},{start:'2026-10',end:'2026-10',kind:'auxiliary'}];assert.throws(()=>C.validate(s),/sobrepõem/);});
test('Períodos adjacentes permitidos',()=>{let s=setup();s.people[0].roles=[{start:'2026-09',end:'2026-09',kind:'auxiliary'},{start:'2026-10',end:null,kind:'regular'}];assert(C.validate(s));});
test('Relatório antigo preserva condição',()=>{let s=setup();s.reports['2026-09']={p1:record('auxiliary')};s.people[0].roles=[{start:'2026-09',end:null,kind:'regular'}];assert.equal(C.kindAt(s,s.people[0],'2026-09'),'auxiliary');});
test('Mês anterior ao acompanhamento não gera pendência',()=>assert.equal(C.summary(setup(),'2026-08').pending,0));
test('Fim de acompanhamento preserva passado',()=>{let s=setup();s.people[0].endMonth='2026-09';assert.equal(C.summary(s,'2026-10').total,0);assert.equal(C.summary(s,'2026-09').total,1);});
test('Registro fora do acompanhamento é preservado',()=>{let s=setup();s.people[0].endMonth='2026-09';s.reports['2026-10']={p1:record()};assert.equal(C.summary(s,'2026-10').received,1);});
test('Rascunhos não entram nas somas',()=>{let s=setup();s.reports['2026-09']={p1:{...record('regular'),received:false,hours:55,studies:3}};assert.equal(C.summary(s,'2026-09').hours,0);assert.equal(C.summary(s,'2026-09').studies,0);});
test('Somas de horas e estudos',()=>{let s=setup();s.reports['2026-09']={p1:{...record('regular'),hours:55,studies:3}};const a=C.summary(s,'2026-09');assert.equal(a.hours,55);assert.equal(a.studies,3);});
test('Campos desconhecidos sinalizados',()=>{let s=setup();s.reports['2026-09']={p1:{...record('regular'),hours:null,studies:null}};const a=C.summary(s,'2026-09');assert.equal(a.unknownHours,1);assert.equal(a.unknownStudies,1);assert.equal(a.review,1);});
test('Anual janeiro-dezembro',()=>{let m=C.periodMonths(2026);assert.equal(m.length,12);assert.equal(m[0],'2026-01');assert.equal(m[11],'2026-12');});
test('Anual setembro-agosto',()=>{let m=C.periodMonths(2026,'service');assert.equal(m.length,12);assert.equal(m[11],'2027-08');});
test('Anual diferencia meses futuros e em andamento',()=>{let s=setup(),a=C.annualDetail(s,s.people[0],C.periodMonths(2026),'2026-11');assert.equal(a[7].label,'Sem acompanhamento');assert.equal(a[8].label,'Pendente');assert.equal(a[10].label,'Em andamento');assert.equal(a[11].label,'Mês futuro');});
test('Somente meses encerrados contam como pendentes anuais',()=>{let s=setup(),a=C.annualSummary(s,s.people[0],C.periodMonths(2026),'2026-11');assert.equal(a.pending,2);});
test('Anual não faz duplicação de relatórios',()=>{let s=setup();s.reports['2026-09']={p1:{...record(),studies:1}};s.reports['2026-10']={p1:{...record(),studies:1}};let a=C.annualSummary(s,s.people[0],C.periodMonths(2026),'2026-11');assert.equal(a.received,2);assert.equal(a.studies,2);});
test('Backup faz ida e volta',()=>{let s=setup();assert.deepEqual(C.parseBackup(JSON.stringify(s)),s);});
test('Backup inválido não aceito',()=>assert.throws(()=>C.parseBackup('{')));
test('Versão de backup incompatível rejeitada',()=>assert.throws(()=>C.validate({...setup(),version:9})));
test('Chaves de prototype pollution rejeitadas',()=>assert.throws(()=>C.parseBackup('{"__proto__":{}}')));
test('IDs duplicados rejeitados',()=>{let s=setup();s.people.push(person());assert.throws(()=>C.validate(s));});
test('Relatório órfão rejeitado',()=>{let s=setup();s.reports['2026-09']={p2:record()};assert.throws(()=>C.validate(s));});
test('Horas negativas rejeitadas',()=>{let s=setup();s.reports['2026-09']={p1:{...record('regular'),hours:-1}};assert.throws(()=>C.validate(s));});
test('Estudos fracionados rejeitados',()=>{let s=setup();s.reports['2026-09']={p1:{...record(),studies:1.5}};assert.throws(()=>C.validate(s));});
test('NaN rejeitado',()=>{let s=setup();s.reports['2026-09']={p1:{...record('regular'),hours:NaN}};assert.throws(()=>C.validate(s));});
test('Publicador não recebe horas indevidas',()=>{let s=setup();s.reports['2026-09']={p1:{...record(),hours:10}};assert.throws(()=>C.validate(s));});
test('Texto diferencia pendência de não participação',()=>{let s=setup();assert(C.monthlyText(s,'2026-09','all').includes('Situação: Pendente'));});
test('Texto não inclui observação interna',()=>{let s=setup();s.reports['2026-09']={p1:{...record(),notes:'NOTA_PRIVADA'}};assert(!C.monthlyText(s,'2026-09').includes('NOTA_PRIVADA'));});
test('Lembrete substitui campos',()=>{let s=setup();const t=C.reminderText(s,s.people[0],'2026-09');assert(t.includes('Pessoa de teste')&&t.includes('Setembro de 2026')&&!t.includes('{nome}'));});
test('PDF contém cabeçalho válido',()=>{const p=PDF.build({title:'Relatórios de Setembro',headers:['Nome','Estudos'],rows:[['José da Silva',1]]});assert.equal(Buffer.from(p.bytes).subarray(0,8).toString(),'%PDF-1.4');assert.equal(p.pages,1);});
test('PDF pagina tabelas extensas',()=>{const p=PDF.build({title:'Relatórios',headers:['Nome','Horas','Estudos'],rows:Array.from({length:300},(_,i)=>['Pessoa de teste '+i,15,1])});assert(p.pages>5);});
test('PDF aceita acentos portugueses',()=>assert(PDF.build({title:'Ação, frequência e participação',headers:['Nome'],rows:[['João, Mário, Patrícia, ç, à, ê']]}).bytes.length>0));
test('PDF rejeita símbolos não suportados com mensagem clara',()=>assert.throws(()=>PDF.build({title:'Teste',headers:['Nome'],rows:[['😀']]}),/caractere/));
console.log('\n'+count+' testes concluídos.');
