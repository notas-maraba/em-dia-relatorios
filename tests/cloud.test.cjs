'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const Cloud = require('../assets/cloud.js');

const user = {id: '00000000-0000-0000-0000-000000000001', email: 'responsavel@example.test'};
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
        async maybeSingle() {
          calls.push(query);
          if (table === 'em_dia_members') return {data: options.notMember ? null : {user_id: user.id}, error: options.memberError || null};
          return {data: options.row === undefined ? {state, revision: 3, updated_at: '2026-11-04T15:00:00Z'} : options.row, error: options.readError || null};
        }
      };
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      if (options.rpcThrow) throw options.rpcThrow;
      return {data: options.rpcRows === undefined ? [{state: args.p_state, revision: args.p_expected_revision + 1, updated_at: '2026-11-04T15:01:00Z'}] : options.rpcRows, error: options.rpcError || null};
    }
  };
  return {client, calls, emit: (event, session) => authCallback(event, session)};
}

test('sem sessão, a leitura não consulta tabelas', async () => {
  const m = mock({noSession: true}), api = Cloud.create({client: m.client});
  assert.equal(await api.session(), null);
  await assert.rejects(api.read(), Cloud.AuthRequiredError);
  assert(m.calls.every(value => typeof value === 'string'));
});

test('sessão usa usuário verificado em vez do usuário do armazenamento local', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  assert.deepEqual((await api.session()).user, user);
  assert.deepEqual(m.calls, ['getSession', 'getUser']);
});

test('erro de autenticação interrompe antes de consultar dados', async () => {
  const m = mock({authError: {status: 401, message: 'invalid'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(), Cloud.AuthRequiredError);
  assert.equal(m.calls.length, 2);
});

test('conta não autorizada não lê nem escreve a base', async () => {
  const m = mock({notMember: true}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(), Cloud.AccessDeniedError);
  await assert.rejects(api.save(state, 0), Cloud.AccessDeniedError);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc'));
  assert(!m.calls.some(call => call.table === 'em_dia_states'));
});

test('base inexistente retorna null sem criar base automaticamente', async () => {
  const m = mock({row: null}), api = Cloud.create({client: m.client});
  assert.equal(await api.read(), null);
  assert(!m.calls.some(call => Array.isArray(call) && call[0] === 'rpc'));
});

test('leitura filtra proprietário verificado e entrega cópia isolada', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  const loaded = await api.read();
  assert.equal(loaded.revision, 3);
  assert.equal(loaded.updatedAt, '2026-11-04T15:00:00Z');
  loaded.state.people[0].name = 'Alterado';
  assert.equal(state.people[0].name, 'Pessoa fictícia');
  assert.deepEqual(m.calls.find(call => call.table === 'em_dia_states').filter, ['owner_id', user.id]);
});

test('resposta de leitura inválida é bloqueada', async () => {
  const m = mock({row: {state: null, revision: 2}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.read(), error => error.code === 'invalid_response');
});

test('salvamento usa RPC com revisão esperada, preservando snapshot', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  const data = JSON.parse(JSON.stringify(state));
  const saving = api.save(data, 3);
  data.people[0].name = 'Alteração posterior';
  const saved = await saving;
  assert.equal(saved.revision, 4);
  assert.equal(saved.state.people[0].name, 'Pessoa fictícia');
  const rpc = m.calls.find(call => Array.isArray(call) && call[0] === 'rpc');
  assert.equal(rpc[1], 'save_em_dia_state');
  assert.equal(rpc[2].p_expected_revision, 3);
});

test('conflito de revisão falha uma vez sem repetir nem fazer upsert', async () => {
  const m = mock({rpcError: {code: 'PT409', message: 'version mismatch'}}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 3), Cloud.ConflictError);
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'rpc').length, 1);
});

test('resposta ambígua ao salvar não permite anunciar sucesso', async () => {
  const m = mock({rpcRows: []}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 0), error => error.code === 'invalid_response');
});

test('salvamento com revisão inesperada falha', async () => {
  const m = mock({rpcRows: [{state, revision: 7}]}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 0), error => error.code === 'invalid_response');
});

test('falha de rede ao salvar não repete a gravação', async () => {
  const m = mock({rpcThrow: new Error('network unavailable')}), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(state, 3), error => error.code === 'network_error' && /confirmar/.test(error.message));
  assert.equal(m.calls.filter(call => Array.isArray(call) && call[0] === 'rpc').length, 1);
});

test('base ou revisão inválida falha antes de chamar o SDK', async () => {
  const m = mock(), api = Cloud.create({client: m.client});
  await assert.rejects(api.save(null, 0), error => error.code === 'invalid_state');
  await assert.rejects(api.save(state, -1), error => error.code === 'invalid_revision');
  await assert.rejects(api.save(state, '1'), error => error.code === 'invalid_revision');
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
