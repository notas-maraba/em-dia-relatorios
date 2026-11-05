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
test('Meta rejeita totais e contagens incoerentes ou fora da capacidade do calendário',()=>{
  for(const patch of [{totalMinutes:-1},{totalMinutes:NaN},{totalMinutes:Infinity},{totalMinutes:1.5},
    {totalMinutes:'320'},{entryCount:0},{entryCount:-1},{entryCount:1.2},{entryCount:31},
    {totalMinutes:1441,entryCount:1},{month:'2032-02',today:'2032-02-29',entryCount:30}]){
    assert.throws(()=>C.regularMonthlyGoal({...goalInput,...patch}),/meta mensal/);
  }
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
