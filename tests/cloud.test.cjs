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
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc'));
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
});

test('base inexistente retorna null sem criar base automaticamente', async () => {
  const m = mock({row: null}), api = Cloud.create({client: m.client});
  assert.equal(await api.read(group.id), null);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc'));
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
  const rpc = m.calls.find(call => Array.isArray(call) && call[0] === 'rpc');
  assert.equal(rpc[1], 'save_em_dia_group_state');
  assert.equal(rpc[2].p_expected_revision, 3);
});

test('conflito de revisão falha uma vez sem repetir nem fazer upsert', async () => {
  const m = mock({rpcError: {code: 'PT409', message: 'version mismatch'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 3, group.id), Cloud.ConflictError);
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'rpc').length, 1);
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
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'rpc').length, 1);
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

test('perfil administrativo vem somente da tabela privada autorizada', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.profile(), {userId: user.id, isAdmin: true});
  assert.equal(m.calls.find(call => call.table === 'em_dia_members').columns, 'user_id,is_admin');
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
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc'));
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
  const call = m.calls.find(call => Array.isArray(call) && call[0] === 'rpc');
  assert.equal(call[1], 'save_em_dia_group_state');
  assert.equal(call[2].p_group_id, group.id);
});

test('criação de grupo não usa gravação direta em tabela nem repete RPC em falha', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  assert.deepEqual(await api.createGroup(' Grupo fictício '), {id: group.id, name: group.name, createdAt: null});
  assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[0] === 'rpc'), ['rpc', 'create_em_dia_group', {p_name: 'Grupo fictício'}]);
  const failed = mock({rpcThrow: Error('lost response')});
  await assert.rejects(Cloud.create({client: failed.client}).createGroup('Outro'), Cloud.CloudError);
  assert.equal(failed.calls.filter(call => Array.isArray(call) && call[0] === 'rpc').length, 1);
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
  assert.deepEqual(m.calls.find(call => Array.isArray(call) && call[0] === 'invoke'), ['invoke', 'em-dia-users', {action: 'create', email: 'novo@example.test', password: 'Senha fictícia longa', groupId: group.id}]);
});

test('admin valida seleção exclusiva e senha antes da chamada de criação', async () => {
  const m = mock({isAdmin: true}), api = Cloud.create({client: m.client});
  await assert.rejects(api.createUser({email: 'novo@example.test', password: 'curta', groupId: group.id}), error => error.code === 'invalid_password');
  await assert.rejects(api.assignUser({userId: user.id, groupId: group.id, newGroupName: 'Outro'}), error => error.code === 'invalid_input');
  assert.equal(m.calls.length, 0);
});

test('listagem administrativa descarta campos extras da resposta', async () => {
  const m = mock({isAdmin: true, invokeResult: {data: {ok: true, users: [{id: user.id, email: user.email, isAdmin: true, groupId: group.id, groupName: group.name, password: 'never-return'}]}, error: null}});
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
