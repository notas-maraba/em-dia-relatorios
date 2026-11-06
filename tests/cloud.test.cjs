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
  assert.deepEqual(await api.profile(), {userId: user.id, role: 'admin', isAdmin: true, defaultGroupId: group.id, publisherId: null, personalGroupId: null});
  assert.deepEqual(m.calls, ['getSession', 'getUser', ['rpc', 'get_em_dia_access_profile', undefined]]);
});

test('grupo padrão consulta apenas o vínculo do usuário verificado, inclusive para administradores', async () => {
  for (const isAdmin of [false, true]) {
    const m = mock({isAdmin}), api = Cloud.create({client: m.client});
    assert.deepEqual(await api.profile(), {userId: user.id, role: isAdmin ? 'admin' : 'superintendent', isAdmin, defaultGroupId: group.id, publisherId: null, personalGroupId: null});
    assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[1] === 'get_em_dia_access_profile'), ['rpc', 'get_em_dia_access_profile', undefined]);
    assert(!m.calls.some(call => call.table === 'em_dia_states'));
  }
});

test('conta sem vínculo recebe padrão nulo sem escolher outro grupo', async () => {
  const m = mock({membershipRow: null}), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.profile(), {userId: user.id, role: 'superintendent', isAdmin: false, defaultGroupId: null, publisherId: null, personalGroupId: null});
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
  assert.deepEqual(await api.profile(), {userId: user.id, role: 'publisher', isAdmin: false, defaultGroupId: group.id, publisherId: 'p1', personalGroupId: group.id});
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

test('envio próprio leva versão esperada e campos de atividade e condição esperada, sem escolher identidade', async () => {
  const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_report: {data: {status: 'accepted', version: 1, group_id: group.id, person_id: 'p1', month: '2026-10', revision: 5, unchanged: false}, error: null}}});
  const api = Cloud.create({client: m.client}), report = activity(), sending = api.submitOwnReport({month: '2026-10', report, expectedVersion: 0});
  report.studies = 999;
  assert.equal((await sending).status, 'accepted');
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'submit_em_dia_own_report', {p_month: '2026-10', p_report: activity(), p_expected_version: 0}]]);
  const untouched = mock({role: 'publisher'}), safe = Cloud.create({client: untouched.client});
  for (const changed of [{...activity(), kind: 'admin'}, {...activity(), personId: 'p2'}, {...activity(), received: true}, {...activity(), hours: -1}]) {
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

const launchId = n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
const hoursRow = (changes = {}) => {
  const row = {group_id: group.id, person_id: 'p1', month: '2026-10', kind: 'regular',
    entries: {'2026-10-01': 90, '2026-10-02': 0}, version: 2, total_minutes: 90, closed: true,
    today: '2026-11-05', updated_at: null, ...changes};
  return {...row, launches: Object.hasOwn(changes, 'launches') ? changes.launches :
    Object.entries(row.entries || {}).map(([date, minutes], index) => ({id: launchId(index + 1), date, minutes}))};
};
const hoursSubmitRow = (changes = {}) => ({status: 'accepted', version: 1, group_id: group.id, person_id: 'p1',
  month: '2026-10', revision: 5, unchanged: false, hours_version: 2, total_minutes: 90, ...changes});

test('diário próprio usa somente RPC e descarta metadados extras sem compartilhar referências', async () => {
  const diary = hoursRow({private_note: 'Do not return', user_id: 'Do not return'});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: diary, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnHours('2026-10');
  assert.deepEqual(result, {groupId: group.id, personId: 'p1', month: '2026-10', kind: 'regular',
    entries: {'2026-10-01': 90, '2026-10-02': 0}, version: 2, totalMinutes: 90, closed: true, today: '2026-11-05', updatedAt: null,
    launches: [{id: launchId(1), date: '2026-10-01', minutes: 90, note: ''}, {id: launchId(2), date: '2026-10-02', minutes: 0, note: ''}]});
  result.entries['2026-10-01'] = 500;
  assert.equal(diary.entries['2026-10-01'], 90);
  assert(!JSON.stringify(result).includes('Do not return'));
  assert(!m.calls.some(call => call.table));
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'read_em_dia_own_hour_launches', {p_month: '2026-10'}]]);
});

test('diário vazio preserva versão zero e tipo sem pioneiro não cria lançamentos', async () => {
  const diary = hoursRow({kind: 'publisher', entries: {}, version: 0, total_minutes: 0});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: diary, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnHours('2026-10');
  assert.equal(result.kind, 'publisher'); assert.equal(result.version, 0); assert.deepEqual(result.entries, {});
  assert.equal(operationCalls(m.calls).length, 1);
});

test('somente publicador verificado chama o diário mesmo com metadados de perfil forjados', async () => {
  for (const role of ['admin', 'superintendent']) {
    const m = mock({role}), api = Cloud.create({client: m.client});
    await assert.rejects(api.readOwnHours('2026-10'), Cloud.AccessDeniedError);
    await assert.rejects(api.saveOwnHours({date: '2026-10-01', minutes: 90, expectedVersion: 0}), Cloud.AccessDeniedError);
    await assert.rejects(api.submitOwnHours({month: '2026-10', participated: true, studies: 0, expectedHoursVersion: 2, expectedReportVersion: 0}), Cloud.AccessDeniedError);
    assert.equal(operationCalls(m.calls).length, 0);
    assert(!m.calls.some(call => call.table));
  }
  const m = mock({noSession: true});
  await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), Cloud.AuthRequiredError);
  assert.equal(operationCalls(m.calls).length, 0);
});

test('diário rejeita identidade ou mês de outra consulta antes de devolver dados', async () => {
  for (const changes of [{group_id: otherGroupId}, {person_id: 'p2'}, {month: '2026-09'}, {kind: 'admin'}]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: hoursRow(changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
});

test('datas impossíveis, fora do mês ou futuras e valores de minutos inválidos não entram no diário lido', async () => {
  const cases = [
    {entries: {'2026-10-32': 90}}, {entries: {'2026-09-30': 90}}, {entries: {'2026-10-01': 44641}},
    {entries: {'2026-10-01': -1}}, {entries: {'2026-10-01': 1.5}}, {entries: {'2026-10-01': '90'}},
    {entries: {'2026-10-01': null}}, {entries: []}, {entries: {'2026-10-01': 90}, total_minutes: 91},
    {month: '2026-11', entries: {'2026-11-06': 90}, closed: false},
    {month: '2026-02', entries: {'2026-02-29': 90}}
  ];
  for (const changes of cases) {
    const month = changes.month || '2026-10';
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: hoursRow(changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours(month), error => error.code === 'invalid_response');
  }
});

test('diário valida soma, versão e fechamento usando a data de referência devolvida pelo servidor', async () => {
  for (const changes of [{version: null}, {version: false}, {version: -1}, {version: Number.MAX_SAFE_INTEGER},
    {version: 0}, {version: '2e0'}, {total_minutes: null}, {total_minutes: '90'}, {closed: false},
    {today: '2026-11-31'}, {today: '2026-09-30'}, {updated_at: {private: true}}]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: hoursRow(changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
  const row = hoursRow({month: '2024-02', entries: {'2024-02-29': 1440}, version: '3', total_minutes: 1440});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: row, error: null}}});
  assert.equal((await Cloud.create({client: m.client}).readOwnHours('2024-02')).version, 3);
});

test('salvar dia leva só data, minutos e versão esperada sem identidade ou total calculado pelo cliente', async () => {
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hours: {data: hoursRow({version: 3, unchanged: false}), error: null}}});
  const result = await Cloud.create({client: m.client}).saveOwnHours({date: '2026-10-01', minutes: 90, expectedVersion: 2,
    groupId: otherGroupId, personId: 'p2', kind: 'publisher', totalMinutes: 999});
  assert.equal(result.version, 3); assert.equal(result.totalMinutes, 90); assert.equal(result.unchanged, false);
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'save_em_dia_own_hours', {p_date: '2026-10-01', p_minutes: 90, p_expected_version: 2}]]);
  assert(!m.calls.some(call => call.table));
});

test('zero é lançamento explícito e null remove somente o dia solicitado', async () => {
  const zero = mock({role: 'publisher', rpcResults: {save_em_dia_own_hours: {data: hoursRow({version: 3, unchanged: false}), error: null}}});
  const saved = await Cloud.create({client: zero.client}).saveOwnHours({date: '2026-10-02', minutes: 0, expectedVersion: 2});
  assert.equal(saved.entries['2026-10-02'], 0);
  const removing = mock({role: 'publisher', rpcResults: {save_em_dia_own_hours: {data: hoursRow({entries: {'2026-10-01': 90}, version: 3, unchanged: false}), error: null}}});
  const removed = await Cloud.create({client: removing.client}).saveOwnHours({date: '2026-10-02', minutes: null, expectedVersion: 2});
  assert(!Object.hasOwn(removed.entries, '2026-10-02')); assert.equal(removed.entries['2026-10-01'], 90);
  assert.equal(operationCalls(removing.calls)[0][2].p_minutes, null);
});

test('validação de data real, minutos inteiros e versão ocorre antes de chamar o SDK', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  for (const date of ['2026-02-29', '2026-04-31', '2026-10-00', '2026-10-32', '2026-1-01', '2200-01-01', null]) {
    await assert.rejects(api.saveOwnHours({date, minutes: 0, expectedVersion: 0}), error => error.code === 'invalid_date');
  }
  for (const minutes of [-1, 44641, 0.5, NaN, Infinity, '60', undefined, true]) {
    await assert.rejects(api.saveOwnHours({date: '2026-10-01', minutes, expectedVersion: 0}), error => error.code === 'invalid_minutes');
  }
  for (const version of [-1, '0', Number.MAX_SAFE_INTEGER, 1.5, null]) {
    await assert.rejects(api.saveOwnHours({date: '2026-10-01', minutes: 0, expectedVersion: version}), error => error.code === 'invalid_revision');
  }
  await assert.rejects(api.readOwnHours('2026-13'), error => error.code === 'invalid_month');
  assert.equal(m.calls.length, 0);
});

test('repetição idêntica de lançamento aceita a versão já salva sem enviar duas gravações', async () => {
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hours: {data: hoursRow({version: 3, unchanged: true}), error: null}}});
  const result = await Cloud.create({client: m.client}).saveOwnHours({date: '2026-10-01', minutes: 90, expectedVersion: 2});
  assert.equal(result.version, 3); assert(result.unchanged); assert.equal(operationCalls(m.calls).length, 1);
  const empty = mock({role: 'publisher', rpcResults: {save_em_dia_own_hours: {data: hoursRow({entries: {}, version: 0, total_minutes: 0, unchanged: true}), error: null}}});
  assert.equal((await Cloud.create({client: empty.client}).saveOwnHours({date: '2026-10-01', minutes: null, expectedVersion: 0})).version, 0);
});

test('confirmação diária incoerente ou sem alteração solicitada falha em vez de anunciar sucesso', async () => {
  for (const changes of [{unchanged: undefined}, {version: 4}, {kind: 'publisher'},
    {entries: {'2026-10-01': 80}, total_minutes: 80}, {version: 1, unchanged: true}]) {
    const data = hoursRow({version: 3, unchanged: false, ...changes});
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hours: {data, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnHours({date: '2026-10-01', minutes: 90, expectedVersion: 2}), error => error.code === 'invalid_response');
  }
});

test('falha de rede, conflito e rejeição de dia futuro nunca repetem gravação automaticamente', async () => {
  for (const options of [{rpcThrow: Error('lost response')}, {rpcResults: {save_em_dia_own_hours: {data: null, error: {code: '40001'}}}},
    {rpcResults: {save_em_dia_own_hours: {data: null, error: {code: '22023'}}}}]) {
    const m = mock({role: 'publisher', ...options});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnHours({date: '2026-11-06', minutes: 90, expectedVersion: 2}), Cloud.CloudError);
    assert.equal(operationCalls(m.calls).length, 1); assert(!m.calls.some(call => call.table));
  }
});

test('envio do diário usa as duas versões e somente participação e estudos sem receber horas do cliente', async () => {
  const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_hours: {data: hoursSubmitRow({private_note: 'Do not return'}), error: null}}});
  const result = await Cloud.create({client: m.client}).submitOwnHours({month: '2026-10', participated: true, studies: 0,
    expectedHoursVersion: 2, expectedReportVersion: 0, hours: 99, totalMinutes: 999, groupId: otherGroupId, personId: 'p2',
    note: 'Private diary fixture', launches: [{note: 'Private diary fixture'}]});
  assert.deepEqual(result, {status: 'accepted', version: 1, groupId: group.id, personId: 'p1', month: '2026-10', revision: 5,
    unchanged: false, hoursVersion: 2, totalMinutes: 90});
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'submit_em_dia_own_hours', {p_month: '2026-10', p_participated: true,
    p_studies: 0, p_expected_hours_version: 2, p_expected_report_version: 0, p_expected_kind:null}]]);
  assert(!JSON.stringify(result).includes('Do not return')); assert(!m.calls.some(call => call.table));
});

test('reenvio calculado permanece pendente e preserva participação e estudos desconhecidos', async () => {
  const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_hours: {data: hoursSubmitRow({status: 'pending', version: 4, unchanged: false}), error: null}}});
  const result = await Cloud.create({client: m.client}).submitOwnHours({month: '2026-10', participated: null, studies: null,
    expectedHoursVersion: 2, expectedReportVersion: 3});
  assert.equal(result.status, 'pending'); assert.equal(result.version, 4);
  assert.equal(operationCalls(m.calls)[0][2].p_participated, null); assert.equal(operationCalls(m.calls)[0][2].p_studies, null);
});

test('envio calculado idêntico ao legado pode confirmar versão zero sem forjar um novo recebido', async () => {
  const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_hours: {data: hoursSubmitRow({version: 0, unchanged: true}), error: null}}});
  const result = await Cloud.create({client: m.client}).submitOwnHours({month: '2026-10', participated: true, studies: 2,
    expectedHoursVersion: 2, expectedReportVersion: 0});
  assert.equal(result.version, 0); assert(result.unchanged);
});

test('envio do diário rejeita participação, estudos e versões inválidas antes da rede', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  const args = {month: '2026-10', participated: true, studies: 1, expectedHoursVersion: 2, expectedReportVersion: 0};
  for (const changes of [{participated: 'true'}, {participated: undefined}, {studies: -1}, {studies: 0.5}, {studies: 10000}, {studies: '1'}]) {
    await assert.rejects(api.submitOwnHours({...args, ...changes}), error => error.code === 'invalid_report');
  }
  for (const changes of [{expectedHoursVersion: 0}, {expectedHoursVersion: '2'}, {expectedReportVersion: null}, {expectedReportVersion: Number.MAX_SAFE_INTEGER}]) {
    await assert.rejects(api.submitOwnHours({...args, ...changes}), error => error.code === 'invalid_revision');
  }
  assert.equal(m.calls.length, 0);
});

test('confirmação de envio não pode trocar escopo, mês, soma ou versão de diário consultada', async () => {
  for (const changes of [{group_id: otherGroupId}, {person_id: 'p2'}, {month: '2026-09'}, {hours_version: 3}, {hours_version: 0},
    {version: null}, {version: 3}, {version: 0}, {version: 0, status: 'pending', unchanged: true},
    {total_minutes: 44641}, {total_minutes: -1}, {total_minutes: '90'}, {status: 'ignored'}, {revision: null}]) {
    const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_hours: {data: hoursSubmitRow(changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).submitOwnHours({month: '2026-10', participated: true, studies: 1,
      expectedHoursVersion: 2, expectedReportVersion: 0}), error => error.code === 'invalid_response');
  }
});

test('envio recusado pelo servidor ou conflito de diário/relatório não faz repetição nem grava grupo', async () => {
  for (const error of [{code: '22023'}, {code: '40001'}, {status: 401}]) {
    const m = mock({role: 'publisher', rpcResults: {submit_em_dia_own_hours: {data: null, error}}});
    await assert.rejects(Cloud.create({client: m.client}).submitOwnHours({month: '2026-11', participated: true, studies: 0,
      expectedHoursVersion: 2, expectedReportVersion: 0}), Cloud.CloudError);
    assert.equal(operationCalls(m.calls).length, 1); assert(!m.calls.some(call => call.table));
  }
});

function launchesRow(launches, changes = {}) {
  const entries = {};
  for (const item of launches) entries[item.date] = (entries[item.date] || 0) + item.minutes;
  return hoursRow({entries, total_minutes: Object.values(entries).reduce((sum, minutes) => sum + minutes, 0), launches, ...changes});
}

test('vários lançamentos no mesmo dia preservam itens separados e agregado diário exato', async () => {
  const raw = launchesRow([
    {id: launchId(1), date: '2026-10-03', minutes: 35, private_note: 'private fixture'},
    {id: launchId(2), date: '2026-10-03', minutes: 65},
    {id: launchId(3), date: '2026-10-04', minutes: 0}
  ], {version: 3});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: raw, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnHours('2026-10');
  assert.deepEqual(result.entries, {'2026-10-03': 100, '2026-10-04': 0});
  assert.equal(result.totalMinutes, 100); assert.equal(result.launches.length, 3);
  assert.deepEqual(result.launches[0], {id: launchId(1), date: '2026-10-03', minutes: 35, note: ''});
  result.launches[0].minutes = 99;
  assert.equal(raw.launches[0].minutes, 35);
  assert(!JSON.stringify(result).includes('private fixture'));
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'read_em_dia_own_hour_launches', {p_month: '2026-10'}]]);
  assert(!m.calls.some(call => call.table));
});

test('leitura nova exige a lista de lançamentos e recusa IDs duplicados inclusive em outra grafia', async () => {
  const upper = '20000000-0000-4000-8000-00000000000A';
  for (const launches of [undefined, null, {}, [null], [{id: 'not-an-id', date: '2026-10-01', minutes: 90}],
    [{id: launchId(1), date: '2026-10-01', minutes: 90}, {id: launchId(1), date: '2026-10-02', minutes: 0}],
    [{id: upper, date: '2026-10-01', minutes: 90}, {id: upper.toLowerCase(), date: '2026-10-02', minutes: 0}]]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: hoursRow({launches}), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
});

test('agregado do dia deve corresponder a todos os lançamentos sem perder dias de zero explícito', async () => {
  const launches = [{id: launchId(1), date: '2026-10-01', minutes: 90}, {id: launchId(2), date: '2026-10-02', minutes: 0}];
  for (const changes of [
    {entries: {'2026-10-01': 89, '2026-10-02': 0}, total_minutes: 89},
    {entries: {'2026-10-01': 90}},
    {entries: {'2026-10-01': 90, '2026-10-02': 0, '2026-10-03': 0}}
  ]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: launchesRow(launches, changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
});

test('cada lançamento precisa ter data real do mês, não futura e minutos inteiros válidos', async () => {
  for (const changes of [{date: '2026-02-29'}, {date: '2026-09-30'}, {date: '2026-10-32'},
    {minutes: 0.5}, {minutes: -1}, {minutes: 44641}, {minutes: '90'}, {minutes: null}]) {
    const raw = hoursRow({launches: [{id: launchId(1), date: '2026-10-01', minutes: 90, ...changes},
      {id: launchId(2), date: '2026-10-02', minutes: 0}]});
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: raw, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
  const raw = launchesRow([{id: launchId(1), date: '2026-11-06', minutes: 30}], {month: '2026-11', closed: false});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: raw, error: null}}});
  await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-11'), error => error.code === 'invalid_response');
});

test('limite mensal de 744 horas preserva horas acumuladas acima de 24 no dia e de 50 no mês', async () => {
  const invalid = launchesRow([{id: launchId(1), date: '2026-10-01', minutes: 30000}, {id: launchId(2), date: '2026-10-02', minutes: 15000}]);
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: invalid, error: null}}});
  await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  const launches = [
    {id: launchId(1), date: '2026-10-01', minutes: 1800},
    {id: launchId(2), date: '2026-10-01', minutes: 1500}
  ];
  const valid = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow(launches, {version: 3, unchanged: false}), error: null}}});
  const saved = await Cloud.create({client: valid.client}).saveOwnHoursLaunch({id: launchId(2), date: '2026-10-01', minutes: 1500, expectedVersion: 2});
  assert.equal(saved.totalMinutes, 3300); assert.equal(saved.entries['2026-10-01'], 3300); assert.equal(saved.launches.length, 2);
});

test('lista de lançamentos tem tamanho limitado e não aceita payload desproporcional', async () => {
  const tooMany = Array.from({length: 1001}, (_, index) => ({id: launchId(index + 1), date: '2026-10-01', minutes: 0}));
  const oversized = [{id: launchId(1), date: '2026-10-01', minutes: 0, private_note: 'x'.repeat(262144)}];
  for (const launches of [tooMany, oversized]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: launchesRow(launches), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
});

test('salvar um novo item no mesmo dia envia só UUID, data, minutos, observação e versão mensal', async () => {
  const launches = [{id: launchId(1), date: '2026-10-01', minutes: 40}, {id: launchId(2), date: '2026-10-01', minutes: 35}];
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow(launches, {version: 2, unchanged: false}), error: null}}});
  const saved = await Cloud.create({client: m.client}).saveOwnHoursLaunch({id: launchId(2), date: '2026-10-01', minutes: 35, expectedVersion: 1,
    groupId: otherGroupId, personId: 'p2', entries: {'2026-10-01': 999}, totalMinutes: 999, kind: 'publisher'});
  assert.equal(saved.entries['2026-10-01'], 75); assert.equal(saved.launches.length, 2);
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'save_em_dia_own_hour_launch_note', {p_id: launchId(2), p_date: '2026-10-01', p_minutes: 35, p_note: null, p_expected_version: 1}]]);
  assert(!m.calls.some(call => call.table));
});

test('edição e remoção confirmam o item individual sem exigir remover os demais do mesmo dia', async () => {
  const edited = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([
    {id: launchId(1), date: '2026-10-01', minutes: 40}, {id: launchId(2), date: '2026-10-01', minutes: 20}
  ], {version: 3, unchanged: false}), error: null}}});
  const changed = await Cloud.create({client: edited.client}).saveOwnHoursLaunch({id: launchId(2), date: '2026-10-01', minutes: 20, expectedVersion: 2});
  assert.equal(changed.totalMinutes, 60); assert.equal(changed.launches[0].minutes, 40);
  const removed = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([
    {id: launchId(1), date: '2026-10-01', minutes: 40}
  ], {version: 4, unchanged: false}), error: null}}});
  const result = await Cloud.create({client: removed.client}).saveOwnHoursLaunch({id: launchId(2), date: '2026-10-01', minutes: null, expectedVersion: 3});
  assert.equal(result.totalMinutes, 40); assert.equal(result.launches.length, 1); assert.equal(result.entries['2026-10-01'], 40);
});

test('zero permanece lançamento individual explícito e uma remoção pode esvaziar o diário', async () => {
  const zero = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([
    {id: launchId(1), date: '2026-10-01', minutes: 0}
  ], {version: 1, unchanged: false}), error: null}}});
  const saved = await Cloud.create({client: zero.client}).saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: 0, expectedVersion: 0});
  assert.equal(saved.entries['2026-10-01'], 0); assert.equal(saved.launches.length, 1);
  const removal = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([], {version: 2, unchanged: false}), error: null}}});
  const removed = await Cloud.create({client: removal.client}).saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: null, expectedVersion: 1});
  assert.deepEqual(removed.entries, {}); assert.deepEqual(removed.launches, []); assert.equal(removed.version, 2);
});

test('UUID estável confirma retry idêntico sem duplicar lançamento nem repetir chamada', async () => {
  const row = launchesRow([{id: launchId(1), date: '2026-10-01', minutes: 45}], {version: 1, unchanged: true});
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: row, error: null}}});
  const saved = await Cloud.create({client: m.client}).saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: 45, expectedVersion: 0});
  assert(saved.unchanged); assert.equal(saved.launches.length, 1); assert.equal(operationCalls(m.calls).length, 1);
  const empty = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([], {version: 2, unchanged: true}), error: null}}});
  assert((await Cloud.create({client: empty.client}).saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: null, expectedVersion: 1})).unchanged);
});

test('confirmação nova não pode esconder o item pedido nem mudar sua data, valor ou versão', async () => {
  const requested = {id: launchId(1), date: '2026-10-01', minutes: 45};
  for (const changes of [
    {launches: [{...requested, id: launchId(2)}]}, {launches: [{...requested, date: '2026-10-02'}]},
    {launches: [{...requested, minutes: 44}]}, {version: 4}, {version: 1, unchanged: true}, {unchanged: undefined},
    {group_id: otherGroupId}, {person_id: 'p2'}, {kind: 'publisher'}
  ]) {
    const {launches = [requested], ...metadata} = changes;
    const row = launchesRow(launches, {version: 3, unchanged: false, ...metadata});
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: row, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnHoursLaunch({...requested, expectedVersion: 2}), error => error.code === 'invalid_response');
  }
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([requested], {version: 3, unchanged: false}), error: null}}});
  await assert.rejects(Cloud.create({client: m.client}).saveOwnHoursLaunch({...requested, minutes: null, expectedVersion: 2}), error => error.code === 'invalid_response');
});

test('UUID, calendário, minutos e versão do item são validados antes da rede', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  const args = {id: launchId(1), date: '2026-10-01', minutes: 30, expectedVersion: 0};
  for (const id of ['', null, 'invalid', '__proto__', 1]) await assert.rejects(api.saveOwnHoursLaunch({...args, id}), error => error.code === 'invalid_launch');
  for (const date of ['2026-02-29', '2026-04-31', null]) await assert.rejects(api.saveOwnHoursLaunch({...args, date}), error => error.code === 'invalid_date');
  for (const minutes of [-1, 44641, 1.5, '30', NaN, undefined]) await assert.rejects(api.saveOwnHoursLaunch({...args, minutes}), error => error.code === 'invalid_minutes');
  for (const expectedVersion of [-1, null, '0', Number.MAX_SAFE_INTEGER]) await assert.rejects(api.saveOwnHoursLaunch({...args, expectedVersion}), error => error.code === 'invalid_revision');
  assert.equal(m.calls.length, 0);
});

test('somente a conta de publicador verificada pode salvar um lançamento individual', async () => {
  for (const options of [{role: 'admin'}, {role: 'superintendent'}, {noSession: true}]) {
    const m = mock(options);
    await assert.rejects(Cloud.create({client: m.client}).saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: 30, expectedVersion: 0}), Cloud.CloudError);
    assert.equal(operationCalls(m.calls).length, 0); assert(!m.calls.some(call => call.table));
  }
});

test('falhas de transporte, escopo ou CAS não repetem o lançamento nem exibem detalhes do servidor', async () => {
  for (const options of [{rpcThrow: Error('PRIVATE_FIXTURE_DETAILS')}, ...['40001', '42501', '22023'].map(code =>
    ({rpcResults: {save_em_dia_own_hour_launch_note: {data: null, error: {code, message: 'PRIVATE_FIXTURE_DETAILS'}}}}))]) {
    const m = mock({role: 'publisher', ...options});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: 30, expectedVersion: 0}),
      error => error instanceof Cloud.CloudError && !error.message.includes('PRIVATE_FIXTURE_DETAILS'));
    assert.equal(operationCalls(m.calls).length, 1); assert(!m.calls.some(call => call.table));
  }
});

test('UUIDs de resposta e entrada são normalizados antes de confirmar o mesmo item', async () => {
  const id = '20000000-0000-4000-8000-00000000000A';
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([
    {id, date: '2026-10-01', minutes: 25}
  ], {version: 1, unchanged: false}), error: null}}});
  const saved = await Cloud.create({client: m.client}).saveOwnHoursLaunch({id, date: '2026-10-01', minutes: 25, expectedVersion: 0});
  assert.equal(saved.launches[0].id, id.toLowerCase()); assert.equal(operationCalls(m.calls)[0][2].p_id, id.toLowerCase());
});

test('diário próprio preserva observação opcional exata, descarta campos extras e não compartilha objetos', async () => {
  const note = '  Observação de fixture\ncom <texto> e acentuação  ';
  const raw = launchesRow([{id: launchId(1), date: '2026-10-01', minutes: 1800, note, internal: 'Discard fixture'}]);
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: raw, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnHours('2026-10');
  assert.deepEqual(result.launches[0], {id: launchId(1), date: '2026-10-01', minutes: 1800, note});
  result.launches[0].note = 'changed fixture';
  assert.equal(raw.launches[0].note, note);
  assert(!JSON.stringify(result).includes('Discard fixture'));
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'read_em_dia_own_hour_launches', {p_month: '2026-10'}]]);
});

test('leitura aceita observações vazias e de 1000 caracteres mas rejeita tipos ou tamanhos inválidos', async () => {
  for (const note of ['', 'x'.repeat(1000)]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: launchesRow([
      {id: launchId(1), date: '2026-10-01', minutes: 0, note}
    ]), error: null}}});
    assert.equal((await Cloud.create({client: m.client}).readOwnHours('2026-10')).launches[0].note, note);
  }
  for (const note of [null, 1, false, {}, [], 'x'.repeat(1001)]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: launchesRow([
      {id: launchId(1), date: '2026-10-01', minutes: 0, note}
    ]), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
  }
});

test('limite de payload considera bytes UTF-8 das observações antes de aceitar a lista', async () => {
  const launches = Array.from({length: 100}, (_, index) => ({id: launchId(index + 1), date: '2026-10-01', minutes: 0, note: '界'.repeat(1000)}));
  assert(JSON.stringify(launches).length < 262144);
  assert(Buffer.byteLength(JSON.stringify(launches), 'utf8') > 262144);
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_hour_launches: {data: launchesRow(launches), error: null}}});
  await assert.rejects(Cloud.create({client: m.client}).readOwnHours('2026-10'), error => error.code === 'invalid_response');
});

test('observação explícita usa RPC próprio e pode ser a única alteração do lançamento', async () => {
  const note = '  Fixture com espaço preservado  ', item = {id: launchId(1), date: '2026-10-01', minutes: 1800, note};
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([item], {version: 3, unchanged: false}), error: null}}});
  const result = await Cloud.create({client: m.client}).saveOwnHoursLaunch({...item, expectedVersion: 2});
  assert.equal(result.launches[0].note, note); assert.equal(result.totalMinutes, 1800);
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'save_em_dia_own_hour_launch_note', {p_id: item.id, p_date: item.date,
    p_minutes: item.minutes, p_note: note, p_expected_version: 2}]]);
});

test('observação nula preserva o texto retornado e vazia confirma limpeza explícita', async () => {
  const item = {id: launchId(1), date: '2026-10-01', minutes: 30};
  for (const note of [null, '']) {
    const returned = note === null ? 'Existing fixture note' : '';
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([{...item, note: returned}], {version: 3, unchanged: false}), error: null}}});
    const saved = await Cloud.create({client: m.client}).saveOwnHoursLaunch({...item, note, expectedVersion: 2});
    assert.equal(saved.launches[0].note, returned); assert.equal(operationCalls(m.calls)[0][2].p_note, note);
  }
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([], {version: 3, unchanged: false}), error: null}}});
  assert.equal((await Cloud.create({client: m.client}).saveOwnHoursLaunch({...item, minutes: null, note: null, expectedVersion: 2})).launches.length, 0);
  assert.equal(operationCalls(m.calls)[0][2].p_note, null);
});

test('observação repetida com mesmo UUID confirma retry idêntico sem nova tentativa', async () => {
  const item = {id: launchId(1), date: '2026-10-01', minutes: 30, note: 'x'.repeat(1000)};
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([item], {version: 3, unchanged: true}), error: null}}});
  const saved = await Cloud.create({client: m.client}).saveOwnHoursLaunch({...item, expectedVersion: 2});
  assert(saved.unchanged); assert.equal(saved.launches[0].note, item.note); assert.equal(operationCalls(m.calls).length, 1);
});

test('confirmação exige observação explicitamente pedida inclusive quando ela é vazia', async () => {
  const item = {id: launchId(1), date: '2026-10-01', minutes: 30};
  for (const note of ['', 'Requested fixture note']) {
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_hour_launch_note: {data: launchesRow([{...item, note: 'Different fixture note'}], {version: 3, unchanged: false}), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnHoursLaunch({...item, note, expectedVersion: 2}), error => error.code === 'invalid_response');
  }
});

test('observação inválida é rejeitada antes do SDK sem reter seu conteúdo no erro', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  for (const note of [1, true, {}, [], 'PRIVATE_FIXTURE'.repeat(100)]) {
    await assert.rejects(api.saveOwnHoursLaunch({id: launchId(1), date: '2026-10-01', minutes: 30, note, expectedVersion: 0}),
      error => error.code === 'invalid_note' && !JSON.stringify(error).includes('PRIVATE_FIXTURE') && !error.message.includes('PRIVATE_FIXTURE') && !Object.hasOwn(error, 'cause'));
  }
  assert.equal(m.calls.length, 0);
});

test('exceções do diário não retêm observação em mensagem, código, causa ou resposta bruta', async () => {
  const marker = 'PRIVATE_DIARY_FIXTURE', error = Object.assign(new Error(marker), {code: marker, request: {note: marker}});
  for (const action of ['read', 'save']) {
    const m = mock({role: 'publisher', rpcThrow: error}), api = Cloud.create({client: m.client});
    await assert.rejects(action === 'read' ? api.readOwnHours('2026-10') : api.saveOwnHoursLaunch({id: launchId(1),
      date: '2026-10-01', minutes: 30, note: marker, expectedVersion: 0}), thrown => {
      assert(thrown instanceof Cloud.CloudError); assert.equal(thrown.code, 'network_error');
      assert(!Object.hasOwn(thrown, 'cause')); assert(!JSON.stringify(thrown).includes(marker)); assert(!thrown.message.includes(marker));
      return true;
    });
    assert.equal(operationCalls(m.calls).length, 1);
  }
});

test('744 horas acumuladas em fevereiro podem ser lidas, salvas no legado e enviadas sem notas', async () => {
  const row = hoursRow({month: '2026-02', entries: {'2026-02-01': 44640}, total_minutes: 44640, version: 3, unchanged: false});
  const m = mock({role: 'publisher', rpcResults: {
    read_em_dia_own_hour_launches: {data: row, error: null},
    save_em_dia_own_hours: {data: row, error: null},
    submit_em_dia_own_hours: {data: hoursSubmitRow({month: '2026-02', total_minutes: 44640}), error: null}
  }}), api = Cloud.create({client: m.client});
  assert.equal((await api.readOwnHours('2026-02')).totalMinutes, 44640);
  const saved = await api.saveOwnHours({date: '2026-02-01', minutes: 44640, expectedVersion: 2});
  assert.equal(saved.totalMinutes, 44640); assert(!Object.hasOwn(saved, 'launches')); assert(!Object.hasOwn(saved, 'note'));
  assert.equal((await api.submitOwnHours({month: '2026-02', participated: true, studies: 0, expectedHoursVersion: 2, expectedReportVersion: 0})).totalMinutes, 44640);
});

const timerId = launchId(90), timerLaunchId = launchId(91);
function timerRow(status = 'idle', changes = {}) {
  const active = status !== 'idle';
  return {group_id: group.id, person_id: 'p1', timer_id: active ? timerId : null, status,
    version: active ? 5 : 0, start_date: active ? '2026-11-05' : null,
    started_at: active ? '2026-11-05T12:59:00.000Z' : null,
    anchor_at: status === 'running' ? '2026-11-05T13:00:00.000Z' : null,
    stopped_at: status === 'stopped' ? '2026-11-05T13:00:15.000Z' : null,
    accumulated_ms: status === 'running' ? 60000 : active ? 90000 : 0,
    elapsed_ms: active ? 90000 : 0, server_now: '2026-11-05T13:00:30.000Z', ...changes};
}
function timerPostRow(changes = {}) {
  return {timer: timerRow('idle', {version: 6}),
    diary: launchesRow([{id: timerLaunchId, date: '2026-10-01', minutes: 1800, note: 'Timer fixture'}], {version: 3}),
    launch_id: timerLaunchId, unchanged: false,
    receipt: {timer_id: timerId, launch_id: timerLaunchId, date: '2026-10-01', minutes: 1800,
      note: 'Timer fixture', posted_at: '2026-11-05T13:00:20.000Z'}, ...changes};
}
const timerPostInput = () => ({timerId, expectedTimerVersion: 5, launchId: timerLaunchId, date: '2026-10-01',
  minutes: 1800, note: 'Timer fixture', expectedHoursVersion: 2});

test('cronômetro próprio usa somente RPC e descarta recibos e metadados extras da leitura', async () => {
  const raw = timerRow('running', {receipt: {note: 'Private discarded fixture'}, user_id: 'Discarded fixture'});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_timer: {data: raw, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnTimer();
  assert.deepEqual(result, {groupId: group.id, personId: 'p1', timerId, status: 'running', version: 5,
    startDate: '2026-11-05', startedAt: '2026-11-05T12:59:00.000Z', anchorAt: '2026-11-05T13:00:00.000Z',
    stoppedAt: null, accumulatedMs: 60000, elapsedMs: 90000, serverNow: '2026-11-05T13:00:30.000Z'});
  assert(!JSON.stringify(result).includes('fixture'));
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'read_em_dia_own_timer', undefined]]);
  assert(!m.calls.some(call => call.table));
});

test('cronômetro aceita idle sem ciclo e duração persistente maior que 744 horas', async () => {
  for (const row of [timerRow(), timerRow('idle', {version: 9}), timerRow('running', {
    started_at: '2026-09-01T12:59:00.000Z', start_date: '2026-09-01', accumulated_ms: 4000000000, elapsed_ms: 4000030000
  })]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_timer: {data: row, error: null}}});
    assert.equal((await Cloud.create({client: m.client}).readOwnTimer()).elapsedMs, row.elapsed_ms);
  }
});

test('cronômetro aceita precisão de microssegundos do Postgres e tolera truncamento de um milissegundo', async () => {
  const row = timerRow('running', {anchor_at: '2026-11-05T13:00:00.000999+00:00',
    server_now: '2026-11-05T13:00:30.000001+00:00', elapsed_ms: 89999});
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_timer: {data: row, error: null}}});
  assert.equal((await Cloud.create({client: m.client}).readOwnTimer()).elapsedMs, 89999);
});

test('cronômetro rejeita escopo alheio, relógios incoerentes e combinações inválidas de estado', async () => {
  const cases = [timerRow('running', {group_id: otherGroupId}), timerRow('running', {person_id: 'p2'}),
    timerRow('running', {timer_id: 'invalid'}), timerRow('running', {version: 0}), timerRow('running', {status: 'unknown'}),
    timerRow('idle', {elapsed_ms: 1}), timerRow('idle', {timer_id: timerId}), timerRow('idle', {started_at: '2026-11-05T13:00:00Z'}),
    timerRow('running', {elapsed_ms: -1}), timerRow('running', {elapsed_ms: '90000'}), timerRow('running', {accumulated_ms: 0.5}),
    timerRow('running', {elapsed_ms: 89990}), timerRow('running', {anchor_at: null}),
    timerRow('running', {anchor_at: '2026-11-05T13:00:31Z'}), timerRow('running', {started_at: '2026-11-05T13:00:31Z'}),
    timerRow('running', {server_now: '2026-02-30T13:00:30Z'}), timerRow('running', {server_now: 'PRIVATE_FIXTURE'}),
    timerRow('running', {stopped_at: '2026-11-05T13:00:30Z'}), timerRow('paused', {anchor_at: '2026-11-05T13:00:00Z'}),
    timerRow('paused', {elapsed_ms: 89999}), timerRow('paused', {stopped_at: '2026-11-05T13:00:15Z'}),
    timerRow('stopped', {stopped_at: null}), timerRow('stopped', {stopped_at: '2026-11-05T12:58:00Z'})];
  for (const row of cases) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_timer: {data: row, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnTimer(), error => error.code === 'invalid_response');
  }
});

test('ações do cronômetro levam somente intenção, UUID estável e versão CAS', async () => {
  const statuses = {start: 'running', pause: 'paused', resume: 'running', stop: 'stopped', discard: 'idle'};
  for (const [action, status] of Object.entries(statuses)) {
    const m = mock({role: 'publisher', rpcResults: {change_em_dia_own_timer: {data: timerRow(status, {version: 6, unchanged: false}), error: null}}});
    const result = await Cloud.create({client: m.client}).changeOwnTimer({action, timerId, expectedVersion: 5,
      elapsedMs: 1000000, groupId: otherGroupId, personId: 'p2', startedAt: 'ignored'});
    assert.equal(result.status, status); assert.equal(result.version, 6);
    assert.deepEqual(operationCalls(m.calls), [['rpc', 'change_em_dia_own_timer', {p_action: action, p_timer_id: timerId, p_expected_version: 5}]]);
  }
});

test('retry de ação idêntica confirma estado e versão sem repetir chamada', async () => {
  const m = mock({role: 'publisher', rpcResults: {change_em_dia_own_timer: {data: timerRow('paused', {version: 7, unchanged: true}), error: null}}});
  const saved = await Cloud.create({client: m.client}).changeOwnTimer({action: 'pause', timerId, expectedVersion: 5});
  assert(saved.unchanged); assert.equal(operationCalls(m.calls).length, 1);
});

test('ação inválida, UUID e versão falham antes de qualquer conexão do cronômetro', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  for (const action of ['', null, 'reset', 'constructor', undefined, {toString: () => 'start'}]) await assert.rejects(api.changeOwnTimer({action, timerId, expectedVersion: 0}), error => error.code === 'invalid_timer_action');
  await assert.rejects(api.changeOwnTimer({action: 'start', timerId: 'invalid', expectedVersion: 0}), error => error.code === 'invalid_launch');
  await assert.rejects(api.changeOwnTimer({action: 'start', timerId, expectedVersion: -1}), error => error.code === 'invalid_revision');
  assert.equal(m.calls.length, 0);
});

test('confirmação de ação recusa outro ciclo, outro estado e versão que não confirme CAS', async () => {
  for (const row of [timerRow('running', {version: 6, unchanged: false}), timerRow('paused', {version: 6, unchanged: false, timer_id: launchId(92)}),
    timerRow('paused', {version: 7, unchanged: false}), timerRow('paused', {version: 4, unchanged: true}), timerRow('paused', {version: 6})]) {
    const m = mock({role: 'publisher', rpcResults: {change_em_dia_own_timer: {data: row, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).changeOwnTimer({action: 'pause', timerId, expectedVersion: 5}), error => error.code === 'invalid_response');
  }
});

test('lançamento do cronômetro envia duas versões e confirma recibo, diário e encerramento atômico', async () => {
  const raw = timerPostRow({internal: 'Discarded fixture'}), m = mock({role: 'publisher', rpcResults: {post_em_dia_own_timer: {data: raw, error: null}}});
  const result = await Cloud.create({client: m.client}).postOwnTimer({...timerPostInput(), groupId: otherGroupId, personId: 'p2', elapsedMs: 1});
  assert.equal(result.timer.status, 'idle'); assert.equal(result.diary.totalMinutes, 1800); assert.equal(result.launchId, timerLaunchId);
  assert.deepEqual(result.receipt, {timerId, launchId: timerLaunchId, date: '2026-10-01', minutes: 1800,
    note: 'Timer fixture', postedAt: '2026-11-05T13:00:20.000Z'});
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'post_em_dia_own_timer', {p_timer_id: timerId, p_expected_timer_version: 5,
    p_launch_id: timerLaunchId, p_date: '2026-10-01', p_minutes: 1800, p_note: 'Timer fixture', p_expected_hours_version: 2, p_expected_kind:null}]]);
  assert(!JSON.stringify(result).includes('Discarded fixture'));
});

test('retry do post usa recibo exato sem exigir lançamento ainda presente ou apagar ciclo novo', async () => {
  for (const launches of [[], [{id: timerLaunchId, date: '2026-10-01', minutes: 1, note: 'Later edited fixture'}]]) {
    const raw = timerPostRow({unchanged: true, timer: timerRow('running', {version: 9, timer_id: launchId(92)}),
      diary: launchesRow(launches, {version: 7})});
    const m = mock({role: 'publisher', rpcResults: {post_em_dia_own_timer: {data: raw, error: null}}});
    const result = await Cloud.create({client: m.client}).postOwnTimer(timerPostInput());
    assert(result.unchanged); assert.equal(result.timer.timerId, launchId(92)); assert.equal(result.timer.status, 'running');
    assert.equal(result.diary.launches.length, launches.length); assert.equal(operationCalls(m.calls).length, 1);
  }
});

test('post normaliza nota ausente ou nula para string vazia e aceita total editado até 744 horas', async () => {
  for (const note of [undefined, null, '']) {
    const raw = timerPostRow({diary: launchesRow([{id: timerLaunchId, date: '2026-10-01', minutes: 44640, note: ''}], {version: 3}),
      receipt: {...timerPostRow().receipt, minutes: 44640, note: ''}});
    const m = mock({role: 'publisher', rpcResults: {post_em_dia_own_timer: {data: raw, error: null}}});
    assert.equal((await Cloud.create({client: m.client}).postOwnTimer({...timerPostInput(), minutes: 44640, note})).receipt.note, '');
    assert.equal(operationCalls(m.calls)[0][2].p_note, '');
  }
});

test('post rejeita insumos inválidos antes da rede', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  for (const changes of [{timerId: null}, {launchId: 'invalid'}, {date: '2026-02-29'}, {minutes: -1}, {minutes: 44641},
    {minutes: 1.5}, {minutes: null}, {note: 1}, {note: 'x'.repeat(1001)}, {expectedTimerVersion: 0}, {expectedHoursVersion: -1}]) {
    await assert.rejects(api.postOwnTimer({...timerPostInput(), ...changes}), Cloud.CloudError);
  }
  assert.equal(m.calls.length, 0);
});

test('post confirma recibo exato mesmo em replay e recusa escrita parcial ou escopo alterado', async () => {
  const base = timerPostRow();
  const cases = [{receipt: undefined}, {receipt: {...base.receipt, timer_id: launchId(92)}},
    {receipt: {...base.receipt, launch_id: launchId(92)}}, {receipt: {...base.receipt, date: '2026-10-02'}},
    {receipt: {...base.receipt, minutes: 1}}, {receipt: {...base.receipt, note: 'Different fixture'}},
    {receipt: {...base.receipt, posted_at: '2026-11-05T14:00:00Z'}}, {launch_id: launchId(92)}, {unchanged: undefined},
    {timer: timerRow('paused', {version: 6})}, {timer: timerRow('idle', {version: 7})},
    {timer: timerRow('idle', {version: 6, group_id: otherGroupId})},
    {diary: launchesRow([], {version: 3})}, {diary: {...base.diary, version: 4}}, {diary: {...base.diary, person_id: 'p2'}},
    {diary: launchesRow([{id: timerLaunchId, date: '2026-10-01', minutes: 1, note: 'Timer fixture'}], {version: 3})},
    {unchanged: true, receipt: {...base.receipt, note: 'Different fixture'}},
    {unchanged: true, timer: timerRow('idle', {version: 5})}, {unchanged: true, diary: {...base.diary, version: 2}}];
  for (const changes of cases) {
    const m = mock({role: 'publisher', rpcResults: {post_em_dia_own_timer: {data: timerPostRow(changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).postOwnTimer(timerPostInput()), error => error.code === 'invalid_response');
    assert.equal(operationCalls(m.calls).length, 1);
  }
});

test('somente publisher verificado acessa, altera e lança o cronômetro próprio', async () => {
  for (const options of [{role: 'admin'}, {role: 'superintendent'}, {noSession: true}]) {
    const m = mock(options), api = Cloud.create({client: m.client});
    await assert.rejects(api.readOwnTimer(), Cloud.CloudError);
    await assert.rejects(api.changeOwnTimer({action: 'start', timerId, expectedVersion: 0}), Cloud.CloudError);
    await assert.rejects(api.postOwnTimer(timerPostInput()), Cloud.CloudError);
    assert.equal(operationCalls(m.calls).length, 0); assert(!m.calls.some(call => call.table));
  }
});

test('cronômetro não repete chamadas após falha, CAS ou rejeição e não retém notas privadas nos erros', async () => {
  const marker = 'PRIVATE_TIMER_FIXTURE';
  for (const name of ['read_em_dia_own_timer', 'change_em_dia_own_timer', 'post_em_dia_own_timer']) {
    for (const options of [{rpcThrow: Object.assign(new Error(marker), {code: marker, request: {note: marker}})},
      ...['40001', '42501', '22023'].map(code => ({rpcResults: {[name]: {data: null, error: {code, details: marker, message: marker}}}}))]) {
      const m = mock({role: 'publisher', ...options}), api = Cloud.create({client: m.client});
      const result = name === 'read_em_dia_own_timer' ? api.readOwnTimer() : name === 'change_em_dia_own_timer'
        ? api.changeOwnTimer({action: 'stop', timerId, expectedVersion: 5}) : api.postOwnTimer({...timerPostInput(), note: marker});
      await assert.rejects(result, error => error instanceof Cloud.CloudError && !Object.hasOwn(error, 'cause') &&
        !JSON.stringify(error).includes(marker) && !error.message.includes(marker));
      assert.equal(operationCalls(m.calls).length, 1); assert(!m.calls.some(call => call.table));
    }
  }
});

function annualRow(changes = {}) {
  const serviceYear = changes.service_year ?? 2026, today = changes.today ?? '2026-11-06';
  const months = Array.from({length: 12}, (_, i) => i < 4 ? serviceYear + '-' + String(i + 9).padStart(2, '0') : (serviceYear + 1) + '-' + String(i - 3).padStart(2, '0'));
  return {group_id: group.id, person_id: 'p1', service_year: serviceYear, today, target_minutes: 36000, version: 0, updated_at: null,
    months: months.map(month => ({month, kind: 'regular', source: month > today.slice(0, 7) ? 'future' : 'missing', minutes: null, studies: null,
      retro_minutes: null, retro_studies: null, can_edit_retro: month < today.slice(0, 7)})), ...changes};
}
function annualRetroRow(minutes = 3300, studies = 2, changes = {}) {
  const row = annualRow({version: 2, unchanged: false});
  row.months[0] = {...row.months[0], source: minutes === null ? 'missing' : 'retroactive', minutes, studies, retro_minutes: minutes, retro_studies: studies};
  return {...row, ...changes};
}

test('anual próprio usa somente RPC verificada e normaliza doze meses sem retornar metadados privados extras', async () => {
  const raw = annualRow({private_note: 'PRIVATE_ANNUAL_FIXTURE', user_id: 'PRIVATE_ANNUAL_FIXTURE'});
  raw.months[0].internal_note = 'PRIVATE_ANNUAL_FIXTURE';
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_annual: {data: raw, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnAnnual(2026);
  assert.deepEqual(Object.keys(result).sort(), ['groupId', 'personId', 'serviceYear', 'today', 'targetMinutes', 'version', 'updatedAt', 'months'].sort());
  assert.equal(result.groupId, group.id); assert.equal(result.personId, 'p1'); assert.equal(result.targetMinutes, 36000);
  assert.equal(result.months.length, 12); assert.equal(result.months[0].month, '2026-09'); assert.equal(result.months[11].month, '2027-08');
  assert.deepEqual(result.months[0], {month: '2026-09', kind: 'regular', source: 'missing', minutes: null, studies: null,
    retroMinutes: null, retroStudies: null, canEditRetro: true});
  result.months[0].minutes = 500; assert.equal(raw.months[0].minutes, null);
  assert(!JSON.stringify(result).includes('PRIVATE_ANNUAL_FIXTURE'));
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'read_em_dia_own_annual', {p_service_year: 2026}]]);
  assert(!m.calls.some(call => call.table));
});

test('anual preserva zero, hora aprovada desconhecida e retro sobreposto sem criar fallback', async () => {
  const row = annualRow({version: '3', updated_at: '2026-11-06T12:00:00.123456+00:00'});
  row.months[0] = {...row.months[0], source: 'approved', minutes: null, studies: 2, retro_minutes: 3300, retro_studies: 3, can_edit_retro: false};
  row.months[1] = {...row.months[1], source: 'diary', minutes: 0, retro_minutes: 3000, retro_studies: 4, can_edit_retro: false};
  row.months[2] = {...row.months[2], source: 'not_regular'};
  row.months[3].kind = 'auxiliary';
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_annual: {data: row, error: null}}});
  const result = await Cloud.create({client: m.client}).readOwnAnnual(2026);
  assert.equal(result.version, 3); assert.equal(result.months[0].minutes, null); assert.equal(result.months[0].retroMinutes, 3300);
  assert.equal(result.months[1].minutes, 0); assert.equal(result.months[1].studies, null); assert.equal(result.months[2].source, 'not_regular');
});

test('anual recusa outro escopo, ano futuro, calendário inválido e limites incoerentes', async () => {
  for (const changes of [{group_id: otherGroupId}, {person_id: 'p2'}, {service_year: 2025}, {today: '2026-02-30'},
    {today: '2026-08-31'}, {target_minutes: 0}, {target_minutes: 535681}, {target_minutes: '36000'}, {target_minutes: 1.5},
    {version: -1}, {updated_at: 'PRIVATE_ANNUAL_FIXTURE'}, {months: []}, {months: Array(12)}, {months: annualRow().months.slice(1)}]) {
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_annual: {data: annualRow(changes), error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnAnnual(2026), error => error.code === 'invalid_response');
  }
});

test('anual exige ordem setembro-agosto e fonte coerente com valores, tipo, retro e mês futuro', async () => {
  for (const changes of [{month: '2026-10'}, {kind: 'admin'}, {source: 'unknown'}, {source: 'future', can_edit_retro: false},
    {source: 'diary'}, {source: 'approved', kind: 'publisher', can_edit_retro: false}, {minutes: 0}, {minutes: 44641},
    {minutes: '1'}, {studies: 10000}, {studies: 1.5}, {retro_minutes: 0}, {retro_minutes: null, retro_studies: 0},
    {can_edit_retro: false}, {can_edit_retro: 'true'}, {source: 'retroactive', minutes: 30, studies: 1, retro_minutes: 31, retro_studies: 1}]) {
    const row = annualRow(); row.months[0] = {...row.months[0], ...changes};
    const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_annual: {data: row, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).readOwnAnnual(2026), error => error.code === 'invalid_response');
  }
  const row = annualRow(); row.months[3] = {...row.months[3], source: 'missing'};
  const m = mock({role: 'publisher', rpcResults: {read_em_dia_own_annual: {data: row, error: null}}});
  await assert.rejects(Cloud.create({client: m.client}).readOwnAnnual(2026), error => error.code === 'invalid_response');
});

test('meta anual leva somente ano, minutos e CAS e confirma valor exato sem alterar relatórios', async () => {
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_goal: {data: annualRow({target_minutes: 30000, version: 1, unchanged: false}), error: null}}});
  const result = await Cloud.create({client: m.client}).saveOwnAnnualGoal({serviceYear: 2026, targetMinutes: 30000, expectedVersion: 0,
    groupId: otherGroupId, personId: 'p2', months: [], report: {hours: 1}, private_note: 'PRIVATE_ANNUAL_FIXTURE'});
  assert.equal(result.targetMinutes, 30000); assert.equal(result.version, 1); assert.equal(result.unchanged, false);
  assert.deepEqual(operationCalls(m.calls), [['rpc', 'save_em_dia_own_annual_goal', {p_service_year: 2026, p_target_minutes: 30000, p_expected_version: 0}]]);
  assert(!m.calls.some(call => call.table));
});

test('meta aceita extremos suportados e retry idêntico sem repetir operação', async () => {
  for (const targetMinutes of [1, 535680]) {
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_goal: {data: annualRow({target_minutes: targetMinutes, version: 3, unchanged: true}), error: null}}});
    const result = await Cloud.create({client: m.client}).saveOwnAnnualGoal({serviceYear: 2026, targetMinutes, expectedVersion: 2});
    assert(result.unchanged); assert.equal(result.targetMinutes, targetMinutes); assert.equal(operationCalls(m.calls).length, 1);
  }
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_goal: {data: annualRow({unchanged: true}), error: null}}});
  const result = await Cloud.create({client: m.client}).saveOwnAnnualGoal({serviceYear: 2026, targetMinutes: 36000, expectedVersion: 0});
  assert(result.unchanged); assert.equal(result.version, 0); assert.equal(result.targetMinutes, 36000);
});

test('retroativo mensal leva horas e estudos privados completos, e null duplo remove sem criar zero', async () => {
  for (const [minutes, studies] of [[3300, 2], [0, 0], [null, null]]) {
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_retro: {data: annualRetroRow(minutes, studies), error: null}}});
    const result = await Cloud.create({client: m.client}).saveOwnAnnualRetro({serviceYear: 2026, month: '2026-09', minutes, studies, expectedVersion: 1,
      groupId: otherGroupId, personId: 'p2', report: {hours: 1}});
    assert.equal(result.months[0].retroMinutes, minutes); assert.equal(result.months[0].retroStudies, studies);
    assert.deepEqual(operationCalls(m.calls), [['rpc', 'save_em_dia_own_annual_retro', {p_service_year: 2026, p_month: '2026-09',
      p_minutes: minutes, p_studies: studies, p_expected_version: 1}]]);
    assert(!m.calls.some(call => call.table));
  }
  const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_retro: {data: annualRow({unchanged: true}), error: null}}});
  assert((await Cloud.create({client: m.client}).saveOwnAnnualRetro({serviceYear: 2026, month: '2026-09', minutes: null, studies: null, expectedVersion: 0})).unchanged);
});

test('meta e retro recusam confirmação com outro valor, versão inesperada ou mês não editável', async () => {
  for (const changes of [{target_minutes: 36000}, {version: 3}, {version: 0, unchanged: true}, {unchanged: undefined}]) {
    const row = annualRow({target_minutes: 30000, version: 2, unchanged: false, ...changes});
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_goal: {data: row, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnAnnualGoal({serviceYear: 2026, targetMinutes: 30000, expectedVersion: 1}), error => error.code === 'invalid_response');
  }
  for (const changes of [{minutes: 31, retro_minutes: 31}, {studies: 2, retro_studies: 2}, {source: 'approved', can_edit_retro: false}]) {
    const row = annualRetroRow(30, 1); row.months[0] = {...row.months[0], ...changes};
    const m = mock({role: 'publisher', rpcResults: {save_em_dia_own_annual_retro: {data: row, error: null}}});
    await assert.rejects(Cloud.create({client: m.client}).saveOwnAnnualRetro({serviceYear: 2026, month: '2026-09', minutes: 30, studies: 1, expectedVersion: 1}), error => error.code === 'invalid_response');
  }
});

test('ano, meta, retroativos completos e versões são validados antes da rede', async () => {
  const m = mock({role: 'publisher'}), api = Cloud.create({client: m.client});
  for (const serviceYear of [1899, 2199, 2026.5, '2026', null, NaN]) await assert.rejects(api.readOwnAnnual(serviceYear), error => error.code === 'invalid_service_year');
  for (const targetMinutes of [0, -1, 535681, 1.5, '30000', null]) await assert.rejects(api.saveOwnAnnualGoal({serviceYear: 2026, targetMinutes, expectedVersion: 0}), error => error.code === 'invalid_target');
  for (const changes of [{month: '2026-08'}, {month: '2027-09'}, {minutes: -1}, {minutes: 44641}, {minutes: 1.5},
    {minutes: null}, {studies: null}, {studies: -1}, {studies: 10000}, {studies: 1.5}, {minutes: undefined}, {expectedVersion: -1}]) {
    await assert.rejects(api.saveOwnAnnualRetro({serviceYear: 2026, month: '2026-09', minutes: 60, studies: 1, expectedVersion: 0, ...changes}), Cloud.CloudError);
  }
  assert.equal(m.calls.length, 0);
});

test('somente publicador verificado acessa anual próprio, meta e retroativos', async () => {
  for (const options of [{role: 'admin'}, {role: 'superintendent'}, {noSession: true}]) {
    const m = mock(options), api = Cloud.create({client: m.client});
    await assert.rejects(api.readOwnAnnual(2026), Cloud.CloudError);
    await assert.rejects(api.saveOwnAnnualGoal({serviceYear: 2026, targetMinutes: 36000, expectedVersion: 0}), Cloud.CloudError);
    await assert.rejects(api.saveOwnAnnualRetro({serviceYear: 2026, month: '2026-09', minutes: 60, studies: 1, expectedVersion: 0}), Cloud.CloudError);
    assert.equal(operationCalls(m.calls).length, 0); assert(!m.calls.some(call => call.table));
  }
});

test('falhas de leitura, meta e retro não repetem RPC nem retêm payload ou dados privados em erros', async () => {
  const marker = 'PRIVATE_ANNUAL_FIXTURE';
  for (const name of ['read_em_dia_own_annual', 'save_em_dia_own_annual_goal', 'save_em_dia_own_annual_retro']) {
    for (const options of [{rpcThrow: Object.assign(Error(marker), {code: marker, request: {private_note: marker}})},
      ...['40001', '42501', '22023'].map(code => ({rpcResults: {[name]: {data: null, error: {code, details: marker, message: marker}}}}))]) {
      const m = mock({role: 'publisher', ...options}), api = Cloud.create({client: m.client});
      const result = name === 'read_em_dia_own_annual' ? api.readOwnAnnual(2026) : name === 'save_em_dia_own_annual_goal'
        ? api.saveOwnAnnualGoal({serviceYear: 2026, targetMinutes: 36000, expectedVersion: 0})
        : api.saveOwnAnnualRetro({serviceYear: 2026, month: '2026-09', minutes: 60, studies: 1, expectedVersion: 0});
      await assert.rejects(result, error => error instanceof Cloud.CloudError && !Object.hasOwn(error, 'cause') &&
        !JSON.stringify(error).includes(marker) && !error.message.includes(marker));
      assert.equal(operationCalls(m.calls).length, 1); assert(!m.calls.some(call => call.table));
    }
  }
});

function offlineWire(changes={}) {
  return {profile:{user_id:user.id,role:'publisher',is_admin:false,group_id:group.id,publisher_id:'p1'},groups:[group],states:[],
    own_card:ownCard(),diaries:[hoursRow({can_use:true})],annuals:[annualRow()],timer:timerRow(),revisions:[],...changes};
}
test('bootstrap offline normaliza somente o cartão, diários, anuais e timer próprios sem credenciais',async()=>{
  const raw=offlineWire({access_token:'PRIVATE_OFFLINE_FIXTURE'});raw.profile.refresh_token='PRIVATE_OFFLINE_FIXTURE';raw.diaries[0].raw_request='PRIVATE_OFFLINE_FIXTURE';
  const m=mock({role:'publisher',rpcResults:{read_em_dia_offline_snapshot:{data:raw,error:null}}});
  const snapshot=await Cloud.create({client:m.client}).offlineSnapshot();
  assert.equal(snapshot.profile.userId,user.id);assert.equal(snapshot.ownCard.personId,'p1');assert.equal(snapshot.diaries[0].canUse,true);
  assert.equal(snapshot.annuals[0].serviceYear,2026);assert.equal(snapshot.timer.status,'idle');
  assert(!JSON.stringify(snapshot).includes('PRIVATE_OFFLINE_FIXTURE'));
  assert.deepEqual(operationCalls(m.calls),[['rpc','read_em_dia_offline_snapshot',undefined]]);assert(!m.calls.some(call=>call.table));
});
test('bootstrap gestor contém os grupos autorizados e distingue grupo vazio explícito de estado ausente',async()=>{
  const raw=offlineWire({profile:{user_id:user.id,role:'superintendent',is_admin:false,group_id:group.id,publisher_id:null},states:[{group_id:group.id,state:null,revision:0,updated_at:null}],own_card:null,diaries:[],annuals:[],timer:null,
    revisions:[{group_id:group.id,items:{revisions:[],total:0}}]});
  const m=mock({rpcResults:{read_em_dia_offline_snapshot:{data:raw,error:null}}});const result=await Cloud.create({client:m.client}).offlineSnapshot();assert.equal(result.states[0].bundle,null);
  const absent=mock({rpcResults:{read_em_dia_offline_snapshot:{data:{...raw,states:[]},error:null}}});assert.equal((await Cloud.create({client:absent.client}).offlineSnapshot()).states[0].bundle,null);
  const broken=mock({rpcResults:{read_em_dia_offline_snapshot:{data:{...raw,states:undefined},error:null}}});await assert.rejects(Cloud.create({client:broken.client}).offlineSnapshot(),e=>e.code==='invalid_response');
});
test('bootstrap recusa outro vínculo, bases de gestor no publisher, dados próprios no gestor e recursos duplicados',async()=>{
  for(const change of [{profile:{...offlineWire().profile,user_id:'untrusted'}},{profile:{...offlineWire().profile,publisher_id:'p2'}},{states:[{group_id:group.id,state}]},
    {diaries:[hoursRow({person_id:'p2'})]},{diaries:[hoursRow(),hoursRow()]},{annuals:[annualRow(),annualRow()]},{timer:timerRow('idle',{group_id:otherGroupId})},
    {revisions:[{group_id:group.id,items:{revisions:[],total:0}}]},{groups:[group,group]}]){
    const m=mock({role:'publisher',rpcResults:{read_em_dia_offline_snapshot:{data:offlineWire(change),error:null}}});await assert.rejects(Cloud.create({client:m.client}).offlineSnapshot(),Cloud.CloudError);
  }
  const m=mock({rpcResults:{read_em_dia_offline_snapshot:{data:offlineWire({profile:{user_id:user.id,role:'superintendent',group_id:group.id,publisher_id:null}}),error:null}}});await assert.rejects(Cloud.create({client:m.client}).offlineSnapshot(),Cloud.CloudError);
});
test('diário próprio arquivado é preservado no bootstrap com canUse false sem ampliar a operação antiga',async()=>{
  const m=mock({role:'publisher',rpcResults:{read_em_dia_offline_snapshot:{data:offlineWire({diaries:[hoursRow({kind:'publisher',can_use:false})]}),error:null}}});
  assert.equal((await Cloud.create({client:m.client}).offlineSnapshot()).diaries[0].canUse,false);
});
test('gateway offline leva UUID durável, kind e payload com ator esperado e sanitiza confirmação',async()=>{
  const payload={userId:user.id,groupId:group.id,personId:'p1',id:launchId(7),date:'2026-10-01',minutes:60,note:'Private note fixture',expectedVersion:0};
  const data={operation_id:launchId(1),kind:'diary_launch',replayed:true,confirmation:{version:1,private_note:'PRIVATE_OFFLINE_FIXTURE'},private_note:'PRIVATE_OFFLINE_FIXTURE'};
  const m=mock({role:'publisher',rpcResults:{apply_em_dia_offline_operation:{data,error:null}}});
  const result=await Cloud.create({client:m.client}).applyOfflineOperation({operationId:launchId(1),kind:'diary_launch',payload});
  assert.deepEqual(result,{operationId:launchId(1),kind:'diary_launch',replayed:true,confirmation:{version:1}});
  assert.deepEqual(operationCalls(m.calls),[['rpc','apply_em_dia_offline_operation',{p_operation_id:launchId(1),p_kind:'diary_launch',p_payload:payload}]]);
  assert(!JSON.stringify(result).includes('PRIVATE_OFFLINE_FIXTURE'));
});
test('gateway não aplica payload de outra conta, pessoa ou grupo mesmo com sessão válida',async()=>{
  for(const changes of [{userId:'other'},{groupId:otherGroupId},{personId:'p2'}]){
    const m=mock({role:'publisher'});await assert.rejects(Cloud.create({client:m.client}).applyOfflineOperation({operationId:launchId(1),kind:'annual_goal',payload:{userId:user.id,groupId:group.id,personId:'p1',...changes}}),Cloud.AccessDeniedError);assert.equal(operationCalls(m.calls).length,0);
  }
});
test('gateway confirma os campos de versão específicos de cada recurso e rejeita recibos incoerentes',async()=>{
  for(const [kind,confirmation] of Object.entries({group_save:{revision:2},diary_launch:{version:1},report_manual:{version:1,revision:2,status:'accepted'},report_diary:{version:2,revision:3,status:'pending',hours_version:4},annual_goal:{version:0},annual_retro:{version:1},timer_change:{timer_version:2},timer_post:{timer_version:3,hours_version:4}})){
    const role=kind==='group_save'?'superintendent':'publisher',m=mock({role,rpcResults:{apply_em_dia_offline_operation:{data:{operation_id:launchId(1),kind,replayed:false,confirmation},error:null}}});
    const result=await Cloud.create({client:m.client}).applyOfflineOperation({operationId:launchId(1),kind,payload:{userId:user.id,groupId:group.id,personId:role==='publisher'?'p1':null}});assert.equal(result.kind,kind);
  }
  for(const changes of [{operation_id:launchId(2)},{kind:'timer_post'},{replayed:null},{confirmation:{}},{confirmation:{version:'NaN'}}]){
    const m=mock({role:'publisher',rpcResults:{apply_em_dia_offline_operation:{data:{operation_id:launchId(1),kind:'diary_launch',replayed:false,confirmation:{version:1},...changes},error:null}}});
    await assert.rejects(Cloud.create({client:m.client}).applyOfflineOperation({operationId:launchId(1),kind:'diary_launch',payload:{userId:user.id,groupId:group.id,personId:'p1'}}),Cloud.CloudError);
  }
});
test('bootstrap e gateway não retêm erros brutos ou repetem uma gravação por conta própria',async()=>{
  for(const action of ['snapshot','apply']){const m=mock({role:'publisher',rpcThrow:Object.assign(Error('PRIVATE_OFFLINE_FIXTURE'),{code:'PRIVATE_OFFLINE_FIXTURE',request:{note:'PRIVATE_OFFLINE_FIXTURE'}})}),api=Cloud.create({client:m.client});
    await assert.rejects(action==='snapshot'?api.offlineSnapshot():api.applyOfflineOperation({operationId:launchId(1),kind:'annual_goal',payload:{userId:user.id,groupId:group.id,personId:'p1'}}),e=>e instanceof Cloud.CloudError&&!Object.hasOwn(e,'cause')&&!JSON.stringify(e).includes('PRIVATE_OFFLINE_FIXTURE')&&!e.message.includes('PRIVATE_OFFLINE_FIXTURE'));assert.equal(operationCalls(m.calls).length,1);
  }
});

const managerPersonalProfile = (role='superintendent',personal=otherGroupId) => ({user_id:user.id,role,is_admin:role==='admin',group_id:group.id,publisher_id:'p1',personal_group_id:personal});
test('manager own card keeps management role and validates independent personal group',async()=>{
  for(const role of ['admin','superintendent']){const card=ownCard();card.group_id=otherGroupId;const m=mock({profileRow:managerPersonalProfile(role),rpcResults:{read_em_dia_own_card:{data:card,error:null}}});const api=Cloud.create({client:m.client});
    const p=await api.profile();assert.equal(p.role,role);assert.equal(p.defaultGroupId,group.id);assert.equal(p.personalGroupId,otherGroupId);assert.equal((await api.readOwnCard()).groupId,otherGroupId);assert(!m.calls.some(c=>c.table));
  }
});
test('manager personal identity never accepts mismatched or incomplete own bindings',async()=>{
  for(const profileRow of [{...managerPersonalProfile(),personal_group_id:null},{...managerPersonalProfile(),publisher_id:null}])await assert.rejects(Cloud.create({client:mock({profileRow}).client}).profile(),Cloud.AccessDeniedError);
  const m=mock({profileRow:managerPersonalProfile(),rpcResults:{read_em_dia_own_card:{data:ownCard(),error:null}}});await assert.rejects(Cloud.create({client:m.client}).readOwnCard(),Cloud.CloudError);
});
test('only administrator lists personal bindings and assigns with exact expected card',async()=>{
  const row={user_id:user.id,group_id:otherGroupId,person_id:'p1'}, m=mock({isAdmin:true,rpcResults:{list_em_dia_personal_bindings:{data:[row],error:null},bind_em_dia_personal_card:{data:row,error:null}}}), api=Cloud.create({client:m.client});
  assert.deepEqual(await api.listPersonalBindings(),[{userId:user.id,groupId:otherGroupId,personId:'p1'}]);
  assert.deepEqual(await api.bindPersonalCard({userId:user.id,groupId:otherGroupId,personId:'p1',expectedGroupId:null,expectedPersonId:null}),{userId:user.id,groupId:otherGroupId,personId:'p1'});
  assert.deepEqual(operationCalls(m.calls).at(-1)[2],{p_user_id:user.id,p_group_id:otherGroupId,p_person_id:'p1',p_expected_group_id:null,p_expected_person_id:null,p_expected_actor_id:user.id});
  const denied=mock(),other=Cloud.create({client:denied.client});await assert.rejects(other.listPersonalBindings(),Cloud.AccessDeniedError);await assert.rejects(other.bindPersonalCard({userId:user.id,groupId:null,personId:null,expectedGroupId:null,expectedPersonId:null}),Cloud.AccessDeniedError);assert.equal(operationCalls(denied.calls).length,0);
});
test('personal assignment does not retry conflicts or accept ambiguous target confirmation',async()=>{
  const args={userId:user.id,groupId:otherGroupId,personId:'p1',expectedGroupId:null,expectedPersonId:null};
  for(const response of [{data:null,error:{code:'40001'}},{data:{user_id:user.id,group_id:group.id,person_id:'p1'},error:null}]){const m=mock({isAdmin:true,rpcResults:{bind_em_dia_personal_card:response}});await assert.rejects(Cloud.create({client:m.client}).bindPersonalCard(args),Cloud.CloudError);assert.equal(operationCalls(m.calls).length,1);}
});
test('manager offline snapshot includes own sanitized card independently from authorized management groups',async()=>{
  const profile=managerPersonalProfile(), card=ownCard();card.group_id=otherGroupId;
  const raw=offlineWire({profile,own_card:card,diaries:[],annuals:[],timer:{...timerRow(),group_id:otherGroupId},states:[{group_id:group.id,state:null,revision:0,updated_at:null}],revisions:[{group_id:group.id,items:{revisions:[],total:0}}]});
  const m=mock({profileRow:profile,rpcResults:{read_em_dia_offline_snapshot:{data:raw,error:null}}}),result=await Cloud.create({client:m.client}).offlineSnapshot();assert.equal(result.states[0].groupId,group.id);assert.equal(result.ownCard.groupId,otherGroupId);assert.equal(result.profile.role,'superintendent');assert.equal(result.groups.length,1);
});
test('manager personal queued mutation checks personal scope instead of currently managed group',async()=>{
  const profile=managerPersonalProfile(), id=launchId(8), rpc={data:{operation_id:id,kind:'annual_goal',replayed:false,confirmation:{version:1}},error:null};
  const m=mock({profileRow:profile,rpcResults:{apply_em_dia_offline_operation:rpc}}),api=Cloud.create({client:m.client});await api.applyOfflineOperation({operationId:id,kind:'annual_goal',payload:{userId:user.id,groupId:otherGroupId,personId:'p1'}});
  await assert.rejects(api.applyOfflineOperation({operationId:id,kind:'annual_goal',payload:{userId:user.id,groupId:group.id,personId:'p1'}}),Cloud.AccessDeniedError);assert.equal(operationCalls(m.calls).length,1);
});

function conditionRow(fields={}){return {group_id:group.id,person_id:'p1',month:'2026-11',kind:'auxiliary',revision:4,unchanged:false,...fields};}
test('own monthly condition uses only the trusted personal card, actor and exact group revision',async()=>{
  const m=mock({role:'publisher',rpcResults:{save_em_dia_own_condition:{data:conditionRow(),error:null}}}),api=Cloud.create({client:m.client});
  assert.deepEqual(await api.saveOwnCondition({month:'2026-11',kind:'auxiliary',expectedRevision:3}),{groupId:group.id,personId:'p1',month:'2026-11',kind:'auxiliary',revision:4,unchanged:false});
  assert.deepEqual(operationCalls(m.calls)[0][2],{p_month:'2026-11',p_kind:'auxiliary',p_expected_revision:3,p_expected_actor_id:user.id,p_expected_group_id:group.id,p_expected_person_id:'p1'});
});
test('a manager chooses its own condition in the personal group without changing management scope',async()=>{
  const profile=managerPersonalProfile(),m=mock({profileRow:profile,rpcResults:{save_em_dia_own_condition:{data:conditionRow({group_id:otherGroupId}),error:null}}});
  await Cloud.create({client:m.client}).saveOwnCondition({month:'2026-11',kind:'auxiliary',expectedRevision:3});const args=operationCalls(m.calls)[0][2];assert.equal(args.p_expected_group_id,otherGroupId);assert.equal(profile.group_id,group.id);
});
test('condition validation and missing personal card never dispatch a write',async()=>{
  const m=mock(),api=Cloud.create({client:m.client});await assert.rejects(api.saveOwnCondition({month:'2026-11',kind:'auxiliary',expectedRevision:3}),Cloud.AccessDeniedError);
  await assert.rejects(api.saveOwnCondition({month:'2026-13',kind:'regular',expectedRevision:3}),Cloud.CloudError);await assert.rejects(api.saveOwnCondition({month:'2026-11',kind:'admin',expectedRevision:3}),Cloud.CloudError);await assert.rejects(api.saveOwnCondition({month:'2026-11',kind:'regular',expectedRevision:0}),Cloud.CloudError);assert.equal(operationCalls(m.calls).length,0);
});
test('condition confirmation cannot silently accept stale, wrong-card or wrong-kind responses',async()=>{
  for(const row of [conditionRow({revision:5}),conditionRow({group_id:otherGroupId}),conditionRow({person_id:'p2'}),conditionRow({kind:'regular'}),conditionRow({unchanged:true})]){const m=mock({role:'publisher',rpcResults:{save_em_dia_own_condition:{data:row,error:null}}});await assert.rejects(Cloud.create({client:m.client}).saveOwnCondition({month:'2026-11',kind:'auxiliary',expectedRevision:3}),e=>e.code==='invalid_response');assert.equal(operationCalls(m.calls).length,1);}
});
test('condition conflicts are not retried, while exact noop keeps its revision',async()=>{
  const m=mock({role:'publisher',rpcResults:{save_em_dia_own_condition:{data:null,error:{code:'40001'}}}});await assert.rejects(Cloud.create({client:m.client}).saveOwnCondition({month:'2026-11',kind:'auxiliary',expectedRevision:3}),Cloud.ConflictError);assert.equal(operationCalls(m.calls).length,1);
  const noop=mock({role:'publisher',rpcResults:{save_em_dia_own_condition:{data:conditionRow({revision:3,unchanged:true}),error:null}}});assert.equal((await Cloud.create({client:noop.client}).saveOwnCondition({month:'2026-11',kind:'auxiliary',expectedRevision:3})).revision,3);
});

test('manual report carries only the captured expected condition and the server rejects stale classification',async()=>{
 const m=mock({role:'publisher',rpcResults:{submit_em_dia_own_report:{data:null,error:{code:'40001'}}}});await assert.rejects(Cloud.create({client:m.client}).submitOwnReport({month:'2026-11',report:{...activity(),kind:'auxiliary'},expectedVersion:0}),Cloud.ConflictError);assert.equal(operationCalls(m.calls)[0][2].p_report.kind,'auxiliary');assert.equal(operationCalls(m.calls).length,1);
});
