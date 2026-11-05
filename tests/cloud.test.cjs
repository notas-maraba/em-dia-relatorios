'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const Cloud = require('../assets/cloud.js');

const user = {id: '00000000-0000-0000-0000-000000000001', email: 'responsavel@example.test'};
const group = {id: "10000000-0000-4000-8000-000000000001", name: "Grupo fictício", created_at: null};
const state = {app: 'em-dia-relatorios', people: [{id: 'p1', name: 'Pessoa fictícia'}], reports: {}};

function mock(options = {}) {
  const calls = [];
  let authCallback;
  const client = {
    auth: {
      async getSession() { calls.push('getSession'); return {data: {session: options.noSession ? null : {user: {...user, id: 'untrusted'}, access_token: 'test-only'}}, error: options.sessionError || null}; },
      async getUser() { calls.push('getUser'); return {data: {user}, error: options.authError || null}; },
      async signInWithOtp(value) { calls.push(['otp', value]); return {error: options.loginError || null}; },
      async signInWithPassword(value) { calls.push(['password', value]); if (options.passwordThrow) throw options.passwordThrow; return {error: options.passwordError || null}; },
      async signOut() { calls.push('signOut'); return {error: options.logoutError || null}; },
      onAuthStateChange(callback) { authCallback = callback; return {data: {subscription: {unsubscribe() { calls.push('unsubscribe'); }}}}; }
    },
    from(table) {
      const query = {table};
      return {
        select(columns) { query.columns = columns; return this; },
        eq(column, value) { query.filter = [column, value]; return this; },
        async order(column) { calls.push({...query, order: column}); return {data: options.groupsRows || [group], error: options.groupsError || null}; },
        async maybeSingle() {
          calls.push(query);
          if (table === 'em_dia_groups') return {data: options.forbiddenGroup ? null : group, error: null};
          if (table === 'em_dia_members') return {data: options.notMember ? null : {user_id: user.id, is_admin: options.isAdmin === true}, error: options.memberError || null};
          if (table === 'em_dia_group_members') return {data: options.membershipRow === undefined ? {user_id: user.id, group_id: group.id} : options.membershipRow, error: options.membershipError || null};
          return {data: options.row === undefined ? {group_id: group.id, state, revision: 3, updated_at: '2026-11-04T15:00:00Z'} : options.row, error: options.readError || null};
        }
      };
    },
    functions: {
      async invoke(name, optionsIn) {
        calls.push(['invoke', name, optionsIn.body]);
        if (options.invokeThrow) throw options.invokeThrow;
        return options.invokeResult || {data: {ok: true, userId: user.id, group}, error: null};
      }
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      if (name === 'get_em_dia_access_profile') {
        const role = options.role || (options.isAdmin ? 'admin' : 'superintendent');
        const membership = options.membershipRow === undefined ? {user_id: user.id, group_id: group.id} : options.membershipRow;
        return {data: options.profileRow === undefined ? {user_id: membership?.user_id || user.id, role,
          is_admin: role === 'admin', group_id: membership?.group_id || null, publisher_id: role === 'publisher' ? 'p1' : null} : options.profileRow,
          error: options.notMember ? {code: '42501'} : options.profileError || options.memberError || options.membershipError || null};
      }
      if (options.rpcResults?.[name]) return options.rpcResults[name];
      if (options.rpcThrow) throw options.rpcThrow;
      if (name === 'create_em_dia_group') return {data: options.rpcRows === undefined ? group : options.rpcRows, error: options.rpcError || null};
      return {data: options.rpcRows === undefined ? [{group_id: args.p_group_id, state: args.p_state, revision: args.p_expected_revision + 1, updated_at: '2026-11-04T15:01:00Z'}] : options.rpcRows, error: options.rpcError || null};
    }
  };
  return {client, calls, emit: (event, session) => authCallback(event, session)};
}

test('sem sessão, a leitura não consulta tabelas', async () => {
  const m = mock({noSession: true}), api = Cloud.create({client: m.client});
  assert.equal(await api.session(), null);
  await assert.rejects(api.read(group.id), Cloud.AuthRequiredError);
  assert(m.calls.every(value => typeof value === 'string'));
});

test('sessão usa usuário verificado em vez do usuário do armazenamento local', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  assert.deepEqual((await api.session()).user, user);
  assert.deepEqual(m.calls, ['getSession', 'getUser']);
});

test('erro de autenticação interrompe antes de consultar dados', async () => {
  const m = mock({authError: {status: 401, message: 'invalid'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(group.id), Cloud.AuthRequiredError);
  assert.equal(m.calls.length, 2);
});

test('conta não autorizada não lê nem escreve a base', async () => {
  const m = mock({notMember: true}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(group.id), Cloud.AccessDeniedError);
  await assert.rejects(api.save(state, 0, group.id), Cloud.AccessDeniedError);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile'));
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
});

test('base inexistente retorna null sem criar base automaticamente', async () => {
  const m = mock({row: null}), api = Cloud.create({client: m.client});
  assert.equal(await api.read(group.id), null);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile'));
});

test('leitura filtra proprietário verificado e entrega cópia isolada', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  const loaded = await api.read(group.id);
  assert.equal(loaded.revision, 3);
  assert.equal(loaded.updatedAt, '2026-11-04T15:00:00Z');
  loaded.state.people[0].name = 'Alterado';
  assert.equal(state.people[0].name, 'Pessoa fictícia');
  assert.deepEqual(m.calls.find(call => call.table === 'em_dia_states').filter, ['group_id', group.id]);
});

test('resposta de leitura inválida é bloqueada', async () => {
  const m = mock({row: {state: null, revision: 2}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(group.id), error => error.code === 'invalid_response');
});

test('salvamento usa RPC com revisão esperada, preservando snapshot', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  const data = JSON.parse(JSON.stringify(state));
  const saving = api.save(data, 3, group.id);
  data.people[0].name = 'Alteração posterior';
  const saved = await saving;
  assert.equal(saved.revision, 4);
  assert.equal(saved.state.people[0].name, 'Pessoa fictícia');
  const rpc = m.calls.find(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile');
  assert.equal(rpc[1], 'save_em_dia_group_state');
  assert.equal(rpc[2].p_expected_revision, 3);
});

test('conflito de revisão falha uma vez sem repetir nem fazer upsert', async () => {
  const m = mock({rpcError: {code: 'PT409', message: 'version mismatch'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 3, group.id), Cloud.ConflictError);
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile').length, 1);
});

test('resposta ambígua ao salvar não permite anunciar sucesso', async () => {
  const m = mock({rpcRows: []}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 0, group.id), error => error.code === 'invalid_response');
});

test('salvamento com revisão inesperada falha', async () => {
  const m = mock({rpcRows: [{group_id: group.id, state, revision: 7}]}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 0, group.id), error => error.code === 'invalid_response');
});

test('falha de rede ao salvar não repete a gravação', async () => {
  const m = mock({rpcThrow: new Error('network unavailable')}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 3, group.id), error => error.code === 'network_error' && /confirmar/.test(error.message));
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile').length, 1);
});

test('base ou revisão inválida falha antes de chamar o SDK', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(null, 0, group.id), error => error.code === 'invalid_state');
  await assert.rejects(api.save(state, -1, group.id), error => error.code === 'invalid_revision');
  await assert.rejects(api.save(state, '1', group.id), error => error.code === 'invalid_revision');
  assert.equal(m.calls.length, 0);
});

test('login não cria usuários e fixa o retorno no site definitivo', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.login('  RESPONSAVEL@example.test  '), {sent: true});
  assert.deepEqual(m.calls[0], ['otp', {email: 'responsavel@example.test', options: {shouldCreateUser: false, emailRedirectTo: 'https://notas-maraba.github.io/em-dia-relatorios/'}}]);
});

test('erro de login não revela existência da conta', async () => {
  const m = mock({loginError: {status: 400, message: 'user does not exist'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.login('nobody@example.test'), error => error.code === 'login_failed' && !error.message.includes('exist'));
});

test('limite de emails permite mensagem clara sem expor endereço', async () => {
  const m = mock({loginError: {status: 429}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.login('nobody@example.test'), error => error.code === 'login_rate_limit');
});

test('logout informa falha de rede em vez de anunciar saída', async () => {
  const m = mock({logoutError: {message: 'network unavailable'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.logout(), Cloud.CloudError);
});

test('callback auth é adiado para fora da trava do SDK e pode ser cancelado', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  const events = [];
  const unsubscribe = api.subscribeAuth((event, next) => events.push([event, next]));
  m.emit('SIGNED_IN', {user});
  assert.equal(events.length, 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  m.emit('SIGNED_OUT', null);
  unsubscribe();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert(m.calls.includes('unsubscribe'));
});

test('retornos inseguros são recusados antes de login', () => {
  const m = mock();
  assert.throws(() => Cloud.create({client: m.client, redirectTo: 'http://example.test/'}), error => error.code === 'invalid_redirect');
});

test('login com senha valida sessão sem retornar ou salvar a senha', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  const password = 'Senha apenas de teste!';
  const result = await api.loginPassword(' RESPONSAVEL@example.test ', password);
  assert.deepEqual(result, {signedIn: true});
  assert.deepEqual(m.calls[0], ['password', {email: 'responsavel@example.test', password}]);
  assert(m.calls.includes('getUser'));
  assert(!JSON.stringify(result).includes(password));
});

test('falha de login com senha não ecoa detalhes ou credenciais do SDK', async () => {
  const m = mock({passwordError: {status: 400, message: 'responsavel@example.test Senha apenas de teste!'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.loginPassword('responsavel@example.test', 'Senha apenas de teste!'), error => {
    assert.equal(error.code, 'login_failed');
    assert(!JSON.stringify(error).includes('Senha apenas de teste!'));
    assert(!error.message.includes('responsavel@example.test'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('exceção de transporte no login não retém credenciais na causa', async () => {
  const m = mock({passwordThrow: new Error('Senha apenas de teste!')}), api = Cloud.create({client: m.client});
  await assert.rejects(api.loginPassword('responsavel@example.test', 'Senha apenas de teste!'), error => error.code === 'login_failed' && error.cause === undefined && !error.message.includes('Senha apenas de teste!'));
});

test('login com senha vazio falha antes da chamada ao SDK', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await assert.rejects(api.loginPassword('responsavel@example.test', ''), error => error.code === 'invalid_credentials');
  assert.equal(m.calls.length, 0);
});

test('perfil administrativo vem somente da RPC privada autorizada', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.profile(), {userId: user.id, role: 'admin', isAdmin: true, defaultGroupId: group.id, publisherId: null});
  assert.deepEqual(m.calls, ['getSession', 'getUser', ['rpc', 'get_em_dia_access_profile', undefined]]);
});

test('grupo padrão consulta apenas o vínculo do usuário verificado, inclusive para administradores', async () => {
  for (const isAdmin of [false, true]) {
    const m = mock({isAdmin}), api = Cloud.create({client: m.client});
    assert.deepEqual(await api.profile(), {userId: user.id, role: isAdmin ? 'admin' : 'superintendent', isAdmin, defaultGroupId: group.id, publisherId: null});
    assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[1] === 'get_em_dia_access_profile'), ['rpc', 'get_em_dia_access_profile', undefined]);
    assert(!m.calls.some(call => call.table === 'em_dia_states'));
  }
});

test('conta sem vínculo recebe padrão nulo sem escolher outro grupo', async () => {
  const m = mock({membershipRow: null}), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.profile(), {userId: user.id, role: 'superintendent', isAdmin: false, defaultGroupId: null, publisherId: null});
  assert(!m.calls.some(call => call.table === 'em_dia_groups' || call.table === 'em_dia_states'));
});

test('vínculo de outra conta é recusado antes de ler os grupos', async () => {
  const m = mock({membershipRow: {user_id: '00000000-0000-0000-0000-000000000002', group_id: group.id}});
  await assert.rejects(Cloud.create({client: m.client}).groups(), Cloud.AccessDeniedError);
  assert(!m.calls.some(call => call.table === 'em_dia_groups' || call.table === 'em_dia_states'));
});

test('identificador inválido no vínculo não chega à leitura de registros', async () => {
  const m = mock({membershipRow: {user_id: user.id, group_id: 'invalid-group'}});
  await assert.rejects(Cloud.create({client: m.client}).read(group.id), error => error.code === 'invalid_group');
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
});

test('falha ao consultar vínculo não é tratada como ausência de grupo', async () => {
  for (const [membershipError, expected] of [[{code: '42501'}, 'access_denied'], [{code: 'network_unavailable'}, 'network_unavailable']]) {
    const m = mock({membershipError}), api = Cloud.create({client: m.client});
    await assert.rejects(api.groups(), error => error.code === expected);
    assert(!m.calls.some(call => call.table === 'em_dia_groups' || call.table === 'em_dia_states'));
  }
});

test('lista de grupos é consultada após validar conta e retorna cópias públicas de metadados', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.groups(), [{id: group.id, name: group.name, createdAt: null}]);
  assert.equal(m.calls.find(call => call.table === 'em_dia_groups').order, 'name');
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
});

test('grupo proibido não vira base vazia nem permite tentar uma gravação', async () => {
  const m = mock({forbiddenGroup: true}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(group.id), Cloud.AccessDeniedError);
  await assert.rejects(api.save(state, 0, group.id), Cloud.AccessDeniedError);
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile'));
});

test('seleção de grupo é obrigatória e resultado de outro grupo é recusado', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(), error => error.code === 'invalid_group');
  await assert.rejects(api.save(state, 0, 'not-a-uuid'), error => error.code === 'invalid_group');
  assert.equal(m.calls.length, 0);
  const wrong = mock({row: {group_id: user.id, state, revision: 1}});
  await assert.rejects(Cloud.create({client: wrong.client}).read(group.id), error => error.code === 'invalid_response');
});

test('RPC de gravação carrega o grupo selecionado explicitamente', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await api.save(state, 0, group.id);
  const call = m.calls.find(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile');
  assert.equal(call[1], 'save_em_dia_group_state');
  assert.equal(call[2].p_group_id, group.id);
});

test('criação de grupo não usa gravação direta em tabela nem repete RPC em falha', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.createGroup(' Grupo fictício '), {id: group.id, name: group.name, createdAt: null});
  assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[1] === 'create_em_dia_group'), ['rpc', 'create_em_dia_group', {p_name: 'Grupo fictício'}]);
  const failed = mock({isAdmin: true, rpcThrow: Error('lost response')});
  await assert.rejects(Cloud.create({client: failed.client}).createGroup('Outro'), Cloud.CloudError);
  assert.equal(failed.calls.filter(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile').length, 1);
});

test('usuário comum não chama endpoint administrativo nem com perfil local falsificado', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await assert.rejects(api.listUsers(), Cloud.AccessDeniedError);
  await assert.rejects(api.createUser({email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id}), Cloud.AccessDeniedError);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'invoke'));
});

test('admin pode criar usuário e vincular grupo sem devolver a senha', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  const result = await api.createUser({email: ' NOVO@example.test ', password: 'Senha fictícia longa', groupId: group.id});
  assert.equal(result.userId, user.id);
  assert(!JSON.stringify(result).includes('Senha fictícia longa'));
  assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[0] === 'invoke'), ['invoke', 'em-dia-users', {action: 'create', email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id, role: 'superintendent'}]);
});

test('admin valida seleção exclusiva e senha antes da chamada de criação', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  await assert.rejects(api.createUser({email: 'novo@example.test', password: 'curta', groupId: group.id}), error => error.code === 'invalid_password');
  await assert.rejects(api.assignUser({userId: user.id, groupId: group.id, newGroupName: 'Outro'}), error => error.code === 'invalid_input');
  assert.equal(m.calls.length, 0);
});

test('listagem administrativa descarta campos extras da resposta', async () => {
  const m = mock({isAdmin: true, invokeResult: {data: {ok: true, users: [{id: user.id, email: user.email, role: 'admin', isAdmin: true, groupId: group.id, groupName: group.name, password: 'never-return'}]}, error: null}});
  const result = await Cloud.create({client: m.client}).listUsers();
  assert.equal(result.users.length, 1);
  assert(!JSON.stringify(result).includes('never-return'));
});

test('falha parcial de provisionamento pede vínculo sem repetir nem expor senha', async () => {
  const m = mock({isAdmin: true, invokeResult: {data: null, error: {context: {async json() {return {code: 'account_exists_needs_assignment', password: 'never-return'};}}}}});
  const api = Cloud.create({client: m.client});
  await assert.rejects(api.createUser({email: 'novo@example.test', password: 'Senha fictícia longa', newGroupName: 'Grupo novo'}), error => error.code === 'account_exists_needs_assignment' && !error.cause && !JSON.stringify(error).includes('never-return'));
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'invoke').length, 1);
});

test('erro bruto do endpoint nunca retém corpo de senha na causa', async () => {
  const m = mock({isAdmin: true, invokeThrow: Error('Senha fictícia longa')});
  await assert.rejects(Cloud.create({client: m.client}).createUser({email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id}), error => error.code === 'admin_unavailable' && !error.cause && !error.message.includes('Senha fictícia longa'));
});

const revisionId = '20000000-0000-4000-8000-000000000001';
const otherGroupId = '10000000-0000-4000-8000-000000000002';
const activity = () => ({participated: true, hours: null, studies: 1});
const proposed = () => ({...activity(), kind: 'publisher', received: true, notes: ''});
const ownCard = () => ({group_id: group.id, person_id: 'p1', group_name: group.name, revision: 4, updated_at: null,
  state: {app: 'em-dia-relatorios', version: 1, revision: 4, updatedAt: null, lastBackupAt: null, activeMonth: '2026-10', sourceNote: '',
    settings: {congregation: 'Exemplo fictício', group: group.name, reminder: ''},
    people: [{id: 'p1', name: 'Pessoa fictícia', startMonth: '2026-09', endMonth: null, roles: [], notes: ''}],
    reports: {'2026-10': {p1: proposed()}}, reminders: {}},
  revisions: [{id: revisionId, month: '2026-10', status: 'pending', version: 2, proposed_report: proposed(), submitted_at: null, reviewed_at: null}]});
const operationCalls = calls => calls.filter(call => Array.isArray(call) && call[0] === 'rpc' && call[1] !== 'get_em_dia_access_profile');

test('perfil aceita somente papéis protegidos coerentes e vínculo de publicador completo', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.profile(), {userId: user.id, role: 'publisher', isAdmin: false, defaultGroupId: group.id, publisherId: 'p1'});
  for (const profileRow of [
    {user_id: user.id, role: 'admin', is_admin: false, group_id: group.id, publisher_id: null},
    {user_id: user.id, role: 'publisher', is_admin: false, group_id: group.id, publisher_id: null},
    {user_id: user.id, role: 'publisher', is_admin: false, group_id: null, publisher_id: 'p1'},
    {user_id: user.id, role: 'unknown', is_admin: false, group_id: group.id, publisher_id: null}
  ]) await assert.rejects(Cloud.create({client: mock({profileRow}).client}).profile(), Cloud.AccessDeniedError);
});

test('publicador não consulta estados de grupo nem chama recursos de gestão', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  for (const call of [() => api.read(group.id), () => api.save(state, 0, group.id), () => api.createGroup('Outro'),
    () => api.listUsers(), () => api.listRevisions(group.id), () => api.transferGroups(), () => api.publisherAccounts(group.id),
    () => api.reviewRevision({revisionId, expectedVersion: 1, decision: 'accept'}),
    () => api.transferPublisher({fromGroupId: group.id, toGroupId: otherGroupId, personId: 'p1', expectedRevision: 4}),
    () => api.createPublisherUser({email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id, personId: 'p1'})]) {
    await assert.rejects(call(), Cloud.AccessDeniedError);
  }
  assert.equal(operationCalls(m.calls).length, 0);
  assert(!m.calls.some(call => call.table || Array.isArray(call) && call[0] === 'invoke'));
});

test('superintendente não cria grupos nem administra papéis globais', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await assert.rejects(api.createGroup('Outro'), Cloud.AccessDeniedError);
  await assert.rejects(api.assignUser({userId: user.id, groupId: group.id, role: 'admin'}), Cloud.AccessDeniedError);
  assert.equal(operationCalls(m.calls).length, 0);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'invoke'));
});

test('cartão próprio usa somente RPC sanitizada e retorna cópia isolada com solicitações', async () => {
  const card = ownCard(), m = mock({role: 'publisher', rpcResults: {read_em_dia_own_card: {data: card, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnCard();
  assert.equal(result.personId, 'p1'); assert.equal(result.group.id, group.id); assert.equal(result.state.people.length, 1);
  assert.equal(result.revisions[0].status, 'pending'); assert.equal(result.revisions[0].version, 2);
  result.state.people[0].name = 'Outra cópia'; assert.equal(card.state.people[0].name, 'Pessoa fictícia');
  assert(!m.calls.some(call => call.table));
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'read_em_dia_own_card', undefined]]);
});

test('cartão próprio rejeita outra pessoa, grupo, relatório ou notas internas', async () => {
  const badCards = [];
  let value = ownCard(); value.state.people.push({...value.state.people[0], id: 'p2'}); badCards.push(value);
  value = ownCard(); value.person_id = 'p2'; badCards.push(value);
  value = ownCard(); value.group_id = otherGroupId; badCards.push(value);
  value = ownCard(); value.state.reports['2026-10'].p2 = proposed(); badCards.push(value);
  value = ownCard(); value.state.people[0].notes = 'Nota interna fictícia'; badCards.push(value);
  value = ownCard(); value.state.reports['2026-10'].p1.notes = 'Nota interna fictícia'; badCards.push(value);
  for (const card of badCards) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_card: {data: card, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnCard(), error => error.code === 'invalid_response');
  }
});

test('envio próprio leva versão esperada e somente campos de atividade, sem escolher identidade ou tipo', async () => {
  const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data: {status: 'accepted', version: 1, group_id: group.id, person_id: 'p1', month: '2026-10', revision: 5, unchanged: false}, error: null}}});
  const api = Cloud.create({client: m.client}), report = activity(), sending = api.submitOwnReport({month: '2026-10', report, expectedVersion: 0});
  report.studies = 999;
  assert.equal((await sending).status, 'accepted');
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'submit_em_dia_own_report', {p_month: '2026-10', p_report: activity(), p_expected_version: 0}]]);
  const untouched = mock({role: 'publisher'}), safe = Cloud.create({client: untouched.client});
  for (const changed of [{...activity(), kind: 'regular'}, {...activity(), personId: 'p2'}, {...activity(), received: true}, {...activity(), hours: -1}]) {
    await assert.rejects(safe.submitOwnReport({month: '2026-10', report: changed, expectedVersion: 0}), error => error.code === 'invalid_report');
  }
  await assert.rejects(safe.submitOwnReport({month: '2026-10', report: activity(), expectedVersion: '0'}), error => error.code === 'invalid_revision');
  assert.equal(untouched.calls.length, 0);
});

test('reenvio pendente preserva status e conflito de versão não é repetido', async () => {
  const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data: {status: 'pending', version: 3, group_id: group.id, person_id: 'p1', month: '2026-10', revision: 5, unchanged: false}, error: null}}});
  const pending = await Cloud.create({client: m.client}).submitOwnReport({month: '2026-10', report: activity(), expectedVersion: 2});
  assert.equal(pending.status, 'pending'); assert.equal(pending.version, 3);
  const conflict = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data: null, error: {code: '40001'}}}});
  await assert.rejects(Cloud.create({client: conflict.client}).submitOwnReport({month: '2026-10', report: activity(), expectedVersion: 2}), Cloud.ConflictError);
  assert.equal(operationCalls(conflict.calls).length, 1);
});

test('relatório legado idêntico aceita versão zero somente quando já aprovado e sem alteração', async () => {
  const base = {status: 'accepted', version: 0, group_id: group.id, person_id: 'p1', month: '2026-10', revision: 5, unchanged: true};
  const valid = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data: base, error: null}}});
  const result = await Cloud.create({client: valid.client}).submitOwnReport({month: '2026-10', report: activity(), expectedVersion: 0});
  assert.equal(result.version, 0); assert.equal(result.unchanged, true); assert.equal(result.status, 'accepted');
  for (const change of [{status: 'pending'}, {unchanged: false}]) {
    const invalid = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data: {...base, ...change}, error: null}}});
    await assert.rejects(Cloud.create({client: invalid.client}).submitOwnReport({month: '2026-10', report: activity(), expectedVersion: 0}), error => error.code === 'invalid_response');
  }
});

test('envio com confirmação de outra pessoa ou mês falha fechado', async () => {
  for (const change of [{person_id: 'p2'}, {group_id: otherGroupId}, {month: '2026-09'}, {status: 'ignored'}]) {
    const data = {status: 'accepted', version: 1, group_id: group.id, person_id: 'p1', month: '2026-10', revision: 5, unchanged: false, ...change};
    const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).submitOwnReport({month: '2026-10', report: activity(), expectedVersion: 0}), error => error.code === 'invalid_response');
  }
});

test('gestor consulta alterações somente do grupo pedido e descarta campos extras do relatório', async () => {
  const m = mock({rpcResults: {list_em_dia_report_revisions: {data: {total: 1, revisions: [{id: revisionId, version: 2, person_id: 'p1', person_name: 'Pessoa fictícia', month: '2026-10', approved_report: proposed(), proposed_report: {...proposed(), notes: 'Não devolver'}, submitted_at: null}]}, error: null}}});
  const result = await Cloud.create({client: m.client}).listRevisions(group.id);
  assert.equal(result.revisions[0].personName, 'Pessoa fictícia'); assert.equal(result.total, 1);
  assert(!JSON.stringify(result).includes('Não devolver'));
  assert.deepEqual(operationCalls(m.calls)[0], ['rpc', 'list_em_dia_report_revisions', {p_group_id: group.id}]);
});

test('fila preserva relatório aprovado ausente após remoção pelo gestor', async () => {
  const m = mock({rpcResults: {list_em_dia_report_revisions: {data: {total: 1, revisions: [{id: revisionId, version: 2, person_id: 'p1', person_name: 'Pessoa fictícia', month: '2026-10', approved_report: null, proposed_report: proposed(), submitted_at: null}]}, error: null}}});
  const result = await Cloud.create({client: m.client}).listRevisions(group.id);
  assert.equal(result.revisions[0].approvedReport, null); assert.equal(result.revisions[0].proposedReport.received, true);
});

test('decisão usa versão e intenção explícitas sem aceitar grupo alheio ao superintendente', async () => {
  const m = mock({rpcResults: {review_em_dia_report_revision: {data: {status: 'ignored', version: 3, group_id: group.id, revision: 5, unchanged: false}, error: null}}});
  const result = await Cloud.create({client: m.client}).reviewRevision({revisionId, expectedVersion: 2, decision: 'ignore'});
  assert.equal(result.status, 'ignored');
  assert.deepEqual(operationCalls(m.calls)[0][2], {p_revision_id: revisionId, p_expected_version: 2, p_decision: 'ignore'});
  const invalid = mock(); await assert.rejects(Cloud.create({client: invalid.client}).reviewRevision({revisionId, expectedVersion: 2, decision: 'replace'}), error => error.code === 'invalid_decision');
  assert.equal(invalid.calls.length, 0);
  const wrong = mock({rpcResults: {review_em_dia_report_revision: {data: {status: 'accepted', version: 3, group_id: otherGroupId, revision: 5, unchanged: false}, error: null}}});
  await assert.rejects(Cloud.create({client: wrong.client}).reviewRevision({revisionId, expectedVersion: 2, decision: 'accept'}), error => error.code === 'invalid_response');
});

test('transferência não lê estado do destino e leva revisão de origem', async () => {
  const m = mock({rpcResults: {
    list_em_dia_transfer_groups: {data: [{id: otherGroupId, name: 'Destino fictício'}], error: null},
    transfer_em_dia_publisher: {data: {from_group_id: group.id, to_group_id: otherGroupId, person_id: 'p1', from_revision: 5, to_revision: 2}, error: null}}});
  const api = Cloud.create({client: m.client});
  assert.equal((await api.transferGroups())[0].id, otherGroupId);
  assert.equal((await api.transferPublisher({fromGroupId: group.id, toGroupId: otherGroupId, personId: 'p1', expectedRevision: 4})).fromRevision, 5);
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
  assert.deepEqual(operationCalls(m.calls)[1][2], {p_from_group_id: group.id, p_to_group_id: otherGroupId, p_person_id: 'p1', p_expected_from_revision: 4});
});

test('vínculos de acesso descartam campos extras e criação de publicador é limitada ao cartão', async () => {
  const m = mock({rpcResults: {list_em_dia_publisher_accounts: {data: [{user_id: user.id, person_id: 'p1', password: 'Não devolver'}], error: null}},
    invokeResult: {data: {ok: true, userId: user.id, group, personId: 'p1'}, error: null}});
  const api = Cloud.create({client: m.client});
  assert.deepEqual(await api.publisherAccounts(group.id), [{personId: 'p1', userId: user.id}]);
  const result = await api.createPublisherUser({email: ' NOVO@example.test ', password: 'Senha fictícia longa', groupId: group.id, personId: 'p1'});
  assert.equal(result.personId, 'p1'); assert(!JSON.stringify(result).includes('Senha fictícia longa'));
  assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[0] === 'invoke')[2], {action: 'create_publisher', email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id, personId: 'p1'});
});

test('alteração administrativa preserva papel quando omitido e não cria publicador sem cartão', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  await api.assignUser({userId: user.id, groupId: group.id});
  assert(!Object.hasOwn(m.calls.find(call => Array.isArray(call) && call[0] === 'invoke')[2], 'role'));
  const invalid = mock({isAdmin: true});
  await assert.rejects(Cloud.create({client: invalid.client}).createUser({email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id, role: 'publisher'}), error => error.code === 'invalid_role');
  assert.equal(invalid.calls.length, 0);
});
