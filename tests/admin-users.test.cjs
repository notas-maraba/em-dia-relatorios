'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const handlerModule = import('../supabase/functions/em-dia-users/handler.mjs');
const owner = '00000000-0000-4000-8000-000000000001';
const targetUser = '00000000-0000-4000-8000-000000000002';
const group = {id: '10000000-0000-4000-8000-000000000001', name: 'Grupo de teste', created_at: null};
const origin = 'https://notas-maraba.github.io';
const password = 'Senha fictícia somente teste!';
const person = 'person_fixture';
const provisionCalls = calls => calls.filter(c => c[0] === 'rpc' && c[1].startsWith('provision_'));

async function fixture(options = {}) {
  const {createHandler} = await handlerModule;
  const calls = [];
  function query(table, admin = false) {
    const value = {table, admin};
    return {
      select(columns) { value.columns = columns; return this; },
      eq(column, key) { value.filter = [column, key]; return this; },
      async maybeSingle() {
        calls.push(value);
        return {data: options.missingGroup ? null : group, error: null};
      },
      then(resolve, reject) {
        calls.push(value);
        const data = table === 'em_dia_groups' ? (options.groups || [group]) : table === 'em_dia_group_members' ? (options.links || [{user_id: targetUser, group_id: group.id}]) : (options.members || [{user_id: owner, is_admin: true, access_role: 'admin'}, {user_id: targetUser, is_admin: false, access_role: 'superintendent'}]);
        return Promise.resolve({data, error: options.listDataError || null}).then(resolve, reject);
      }
    };
  }
  const userClient = {
    auth: {async getUser(token) {calls.push(['verify', token]); return {data: {user: options.noUser ? null : {id: owner, user_metadata: {is_admin: true}}}, error: options.authError || null};}},
    from(table) {return query(table);},
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      if (name === 'get_em_dia_access_profile') return {data: options.profile || {user_id: owner, role: options.role || (options.notAdmin ? 'superintendent' : 'admin'), is_admin: options.role ? options.role === 'admin' : !options.notAdmin, group_id: group.id, publisher_id: options.role === 'publisher' ? person : null}, error: options.profileError || (options.missingMember ? {code: '42501'} : null)};
      if (name === 'list_em_dia_publisher_accounts') return {data: options.bindings || [], error: options.bindingsError || null};
      if (name === 'preflight_em_dia_publisher_account') {
        if (options.preflightThrow) throw options.preflightThrow;
        return {data: options.preflight || {person_id: person, name: 'Pessoa de teste', group_id: group.id}, error: options.preflightError || null};
      }
      if (options.rpcThrow) throw options.rpcThrow;
      return {data: options.rpcData === undefined ? [group] : options.rpcData, error: options.rpcError || null};
    }
  };
  const adminClient = {
    from(table) {return query(table, true);},
    auth: {admin: {
      async createUser(args) {calls.push(['createUser', args]); if (options.createThrow) throw options.createThrow; return {data: {user: {id: targetUser}}, error: options.createError || null};},
      async listUsers(args) {calls.push(['listUsers', args]); return {data: {users: options.pages?.[args.page - 1] || options.users || [{id: owner, email: 'admin@example.test', encrypted_password: 'must-not-return'}, {id: targetUser, email: 'responsavel@example.test', user_metadata: {private: 'must-not-return'}}]}, error: options.listError || null};},
      async deleteUser(id) {calls.push(['deleteUser', id]); throw Error('Deletion is forbidden in this workflow');}
    }}
  };
  const handle = createHandler({getClients(authorization) {calls.push(['clients', authorization]); if (options.configError) throw Error('SECRET-must-not-return'); return {userClient, adminClient};}});
  function request(body = {action: 'list'}, settings = {}) {
    return new Request('https://example.test/functions/v1/em-dia-users', {method: settings.method || 'POST', headers: {
      Origin: settings.origin === undefined ? origin : settings.origin,
      'Content-Type': settings.contentType || 'application/json',
      ...(settings.auth === false ? {} : {Authorization: 'Bearer test.jwt.token'})
    }, ...((settings.method || 'POST') === 'POST' ? {body: settings.raw === undefined ? JSON.stringify(body) : settings.raw} : {})});
  }
  async function run(body, settings) {const response = await handle(request(body, settings)); return {response, body: response.status === 204 ? null : await response.json()};}
  return {calls, run};
}

test('request without user JWT fails before reading credentials or administrative clients', async () => {
  const f = await fixture(); const r = await f.run({action: 'list'}, {auth: false});
  assert.equal(r.response.status, 401); assert.equal(r.body.code, 'auth_required'); assert.equal(f.calls.length, 0);
});

test('unexpected web origins are rejected before authentication or admin operations', async () => {
  const f = await fixture(); const r = await f.run({action: 'list'}, {origin: 'https://untrusted.example'});
  assert.equal(r.response.status, 403); assert.equal(f.calls.length, 0); assert.equal(r.response.headers.get('access-control-allow-origin'), null);
});

test('CORS preflight is restricted and does not access private data', async () => {
  const f = await fixture(); const r = await f.run(undefined, {method: 'OPTIONS', auth: false});
  assert.equal(r.response.status, 204); assert.equal(r.response.headers.get('access-control-allow-origin'), origin); assert.equal(f.calls.length, 0);
});

test('GET cannot list users or mutate accounts', async () => {
  const f = await fixture(); const r = await f.run(undefined, {method: 'GET'});
  assert.equal(r.response.status, 405); assert.equal(f.calls.length, 0);
});

test('invalid server-verified user cannot reach Auth admin APIs', async () => {
  const f = await fixture({authError: {status: 401, message: 'must-not-return'}}); const r = await f.run();
  assert.equal(r.response.status, 401); assert(!f.calls.some(c => c[0] === 'listUsers')); assert(!JSON.stringify(r.body).includes('must-not-return'));
});

test('user-editable admin metadata is ignored when protected membership is not admin', async () => {
  const f = await fixture({notAdmin: true}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.response.status, 403); assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'listUsers')); assert.equal(provisionCalls(f.calls).length, 0);
});

test('missing membership fails closed even with a valid Auth user', async () => {
  const f = await fixture({missingMember: true}); const r = await f.run();
  assert.equal(r.response.status, 403); assert(!f.calls.some(c => c[0] === 'listUsers'));
});

test('user listing exposes only selected identity and group fields', async () => {
  const f = await fixture(); const r = await f.run();
  assert.equal(r.response.status, 200); assert.equal(r.body.users.length, 2);
  assert.deepEqual(r.body.users[1], {id: targetUser, email: 'responsavel@example.test', role: 'superintendent', isAdmin: false, groupId: group.id, groupName: group.name, publisherId: null});
  assert.equal(r.body.users[0].isAdmin, true); assert(!JSON.stringify(r.body).includes('must-not-return'));
  assert(f.calls.some(c => c.table === 'em_dia_members' && c.admin));
});

test('create validates password and group before creating an account', async () => {
  const f = await fixture(); const r = await f.run({action: 'create', email: 'novo@example.test', password: 'curta', groupId: group.id});
  assert.equal(r.response.status, 400); assert.equal(r.body.code, 'invalid_password'); assert(!f.calls.some(c => c[0] === 'createUser'));
  const missing = await fixture({missingGroup: true}); const denied = await missing.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(denied.body.code, 'invalid_group'); assert(!missing.calls.some(c => c[0] === 'createUser'));
});

test('request cannot set authorization metadata or choose both group modes', async () => {
  const f = await fixture(); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id, is_admin: true});
  assert.equal(r.body.code, 'invalid_input');
  const both = await f.run({action: 'assign', userId: targetUser, groupId: group.id, newGroupName: 'Outro'});
  assert.equal(both.body.code, 'invalid_input'); assert(!f.calls.some(c => c[0] === 'createUser')); assert.equal(provisionCalls(f.calls).length, 0);
});

test('oversized and malformed JSON requests fail without administrative mutations', async () => {
  const f = await fixture(); const tooLarge = await f.run(undefined, {raw: JSON.stringify({action: 'create', password: 'x'.repeat(9000)})});
  assert.equal(tooLarge.response.status, 413);
  const malformed = await f.run(undefined, {raw: '{not-json'}); assert.equal(malformed.response.status, 400);
  assert(!f.calls.some(c => c[0] === 'createUser')); assert.equal(provisionCalls(f.calls).length, 0);
});

test('unexpected action and group types are rejected without administrative mutations', async () => {
  const f = await fixture();
  for (const action of ['__proto__', 'constructor', 'toString', null, {}]) {
    const r = await f.run({action}); assert.equal(r.response.status, 400); assert.equal(r.body.code, 'invalid_input');
  }
  for (const target of [{groupId: 0, newGroupName: 'Grupo'}, {groupId: group.id, newGroupName: {}}, {groupId: [], newGroupName: 'Grupo'}]) {
    const r = await f.run({action: 'assign', userId: targetUser, ...target}); assert.equal(r.response.status, 400); assert.equal(r.body.code, 'invalid_input');
  }
  assert(!f.calls.some(c => c[0] === 'createUser')); assert.equal(provisionCalls(f.calls).length, 0);
});

test('successful creation uses trusted Auth and atomic group provisioning without returning credentials', async () => {
  const f = await fixture(); const r = await f.run({action: 'create', email: ' NOVO@example.test ', password, groupId: group.id});
  assert.equal(r.response.status, 200); assert.deepEqual(r.body, {ok: true, userId: targetUser, group});
  assert.deepEqual(f.calls.find(c => c[0] === 'createUser')[1], {email: 'novo@example.test', password, email_confirm: true});
  assert.deepEqual(provisionCalls(f.calls)[0], ['rpc', 'provision_em_dia_access', {p_user_id: targetUser, p_role: 'superintendent', p_group_id: group.id, p_new_group_name: null}]);
  assert(!JSON.stringify(r.body).includes(password));
});

test('a new group is created only inside the provisioning transaction', async () => {
  const f = await fixture(); const r = await f.run({action: 'create', email: 'novo@example.test', password, newGroupName: ' Grupo novo '});
  assert.equal(r.response.status, 200);
  assert.deepEqual(provisionCalls(f.calls)[0][2], {p_user_id: targetUser, p_role: 'superintendent', p_group_id: null, p_new_group_name: 'Grupo novo'});
  assert.equal(provisionCalls(f.calls).length, 1);
});

test('existing email is never reset or recreated automatically', async () => {
  const f = await fixture({createError: {code: 'email_exists', message: 'must-not-return'}}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.response.status, 409); assert.equal(r.body.code, 'account_exists'); assert.equal(f.calls.filter(c => c[0] === 'createUser').length, 1);
  assert.equal(provisionCalls(f.calls).length, 0); assert(!f.calls.some(c => c[0] === 'deleteUser')); assert(!JSON.stringify(r.body).includes('must-not-return'));
});

test('unknown Auth outcome is not retried and account is not deleted', async () => {
  const f = await fixture({createThrow: Error('response lost ' + password)}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.body.code, 'account_exists_needs_assignment'); assert.equal(f.calls.filter(c => c[0] === 'createUser').length, 1);
  assert(!f.calls.some(c => c[0] === 'deleteUser')); assert(!JSON.stringify(r.body).includes(password));
});

test('failed provisioning preserves account for explicit reassignment instead of deletion', async () => {
  const f = await fixture({rpcThrow: Error('lost ' + password)}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.body.code, 'account_exists_needs_assignment'); assert(!f.calls.some(c => c[0] === 'deleteUser'));
  assert.equal(provisionCalls(f.calls).length, 1); assert(!JSON.stringify(r.body).includes(password));
});

test('assigning an existing account changes only membership and never its password', async () => {
  const f = await fixture(); const r = await f.run({action: 'assign', userId: targetUser, groupId: group.id});
  assert.equal(r.response.status, 200); assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'deleteUser'));
  assert.equal(provisionCalls(f.calls).length, 1);
  assert.deepEqual(provisionCalls(f.calls)[0][2], {p_user_id: targetUser, p_role: null, p_group_id: group.id, p_new_group_name: null});
});

test('server errors never reveal runtime secrets or request details', async () => {
  const f = await fixture({configError: true}); const r = await f.run();
  assert.equal(r.response.status, 503); assert.deepEqual(r.body, {ok: false, code: 'operation_unconfirmed'});
  assert(!JSON.stringify(r.body).includes('SECRET'));
});

test('pagination is bounded and incomplete lists are not presented as complete', async () => {
  const f = await fixture({users: Array.from({length: 200}, () => ({id: targetUser, email: 'fixture@example.test'}))}); const r = await f.run();
  assert.equal(r.response.status, 413); assert.equal(r.body.code, 'users_limit'); assert.equal(f.calls.filter(c => c[0] === 'listUsers').length, 10);
});

test('superintendent creates a publisher account only after checking its real card and group', async () => {
  const f = await fixture({role: 'superintendent'});
  const r = await f.run({action: 'create_publisher', email: ' PESSOA@example.test ', password, groupId: group.id, personId: person});
  assert.equal(r.response.status, 200);
  assert.deepEqual(r.body, {ok: true, userId: targetUser, group, personId: person});
  const preflightIndex = f.calls.findIndex(c => c[1] === 'preflight_em_dia_publisher_account');
  const createIndex = f.calls.findIndex(c => c[0] === 'createUser');
  const provisionIndex = f.calls.findIndex(c => c[1] === 'provision_em_dia_publisher_account');
  assert(preflightIndex >= 0 && preflightIndex < createIndex && createIndex < provisionIndex);
  assert.deepEqual(f.calls[preflightIndex], ['rpc', 'preflight_em_dia_publisher_account', {p_group_id: group.id, p_person_id: person}]);
  assert.deepEqual(f.calls[createIndex][1], {email: 'pessoa@example.test', password, email_confirm: true});
  assert.deepEqual(f.calls[provisionIndex], ['rpc', 'provision_em_dia_publisher_account', {p_user_id: targetUser, p_group_id: group.id, p_person_id: person}]);
  assert(!f.calls.some(c => c[0] === 'listUsers' || c.table));
  assert(!JSON.stringify(r.body).includes(password));
});

test('superintendents cannot list global users, assign accounts, or create manager roles', async () => {
  for (const body of [
    {action: 'list'},
    {action: 'assign', userId: targetUser, groupId: group.id, role: 'superintendent'},
    {action: 'create', email: 'novo@example.test', password, groupId: group.id, role: 'admin'},
    {action: 'create', email: 'novo@example.test', password, groupId: group.id, role: 'superintendent'}
  ]) {
    const f = await fixture({role: 'superintendent'}); const r = await f.run(body);
    assert.equal(r.response.status, 403);
    assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'listUsers' || c.table));
    assert.deepEqual(f.calls.filter(c => c[0] === 'rpc').map(c => c[1]), ['get_em_dia_access_profile']);
  }
});

test('publisher role cannot use any administrative action even with editable admin metadata', async () => {
  for (const action of ['list', 'create', 'assign', 'create_publisher']) {
    const f = await fixture({role: 'publisher'}); const r = await f.run({action, email: 'novo@example.test', password, groupId: group.id, personId: person});
    assert.equal(r.response.status, 403);
    assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'listUsers' || c.table));
    assert.equal(provisionCalls(f.calls).length, 0);
  }
});

test('publisher account creation cannot inject roles, Auth metadata, or a new group', async () => {
  for (const extra of [{role: 'admin'}, {role: 'publisher'}, {is_admin: true}, {user_metadata: {is_admin: true}}, {newGroupName: 'Grupo novo'}]) {
    const f = await fixture({role: 'superintendent'});
    const r = await f.run({action: 'create_publisher', email: 'novo@example.test', password, groupId: group.id, personId: person, ...extra});
    assert.equal(r.response.status, 400); assert.equal(r.body.code, 'invalid_input');
    assert(!f.calls.some(c => c[0] === 'createUser' || c[1] === 'preflight_em_dia_publisher_account'));
  }
});

test('denied, changed, or missing publisher cards never cause Auth account creation', async () => {
  for (const options of [
    {preflightError: {code: '42501', message: password}},
    {preflightError: {code: '40001', message: password}},
    {preflightError: {code: '22023', message: password}},
    {preflight: {person_id: 'other_person', name: 'Outro', group_id: group.id}},
    {preflight: {person_id: person, name: 'Outro', group_id: '10000000-0000-4000-8000-000000000099'}},
    {preflight: {person_id: person, group_id: group.id}},
    {preflightThrow: Error(password)}
  ]) {
    const f = await fixture({role: 'superintendent', ...options});
    const r = await f.run({action: 'create_publisher', email: 'novo@example.test', password, groupId: group.id, personId: person});
    assert(r.response.status >= 400); assert(!f.calls.some(c => c[0] === 'createUser'));
    assert.equal(provisionCalls(f.calls).length, 0); assert(!JSON.stringify(r.body).includes(password));
  }
});

test('publisher credentials and safe card identity are validated before preflight or Auth', async () => {
  for (const patch of [
    {password: 'curta'}, {password: 'x'.repeat(129)}, {email: 'invalido'},
    {groupId: 'invalid'}, {personId: '__proto__'}, {personId: 'constructor'}, {personId: 'x/y'}, {personId: 7}
  ]) {
    const f = await fixture({role: 'superintendent'});
    const r = await f.run({action: 'create_publisher', email: 'novo@example.test', password, groupId: group.id, personId: person, ...patch});
    assert.equal(r.response.status, 400);
    assert(!f.calls.some(c => c[0] === 'createUser' || c[1] === 'preflight_em_dia_publisher_account'));
  }
});

test('a publisher provisioning race leaves an explicit unlinked account without deletion or retry', async () => {
  for (const options of [{rpcError: {code: '40001', message: password}}, {rpcError: {code: '42501', message: password}}, {rpcThrow: Error(password)}, {rpcData: []}, {rpcData: {...group, id: '10000000-0000-4000-8000-000000000099'}}]) {
    const f = await fixture({role: 'superintendent', ...options});
    const r = await f.run({action: 'create_publisher', email: 'novo@example.test', password, groupId: group.id, personId: person});
    assert(r.response.status >= 400); assert.equal(r.body.code, 'account_exists_needs_assignment');
    assert.equal(f.calls.filter(c => c[0] === 'createUser').length, 1);
    assert.equal(provisionCalls(f.calls).length, 1);
    assert(!f.calls.some(c => c[0] === 'deleteUser' || c[0] === 'listUsers'));
    assert(!JSON.stringify(r.body).includes(password));
  }
});

test('admin can explicitly create or promote a manager with a protected role parameter', async () => {
  for (const action of ['create', 'assign']) {
    const f = await fixture();
    const r = await f.run({action, ...(action === 'create' ? {email: 'novo@example.test', password} : {userId: targetUser}), groupId: group.id, role: 'admin'});
    assert.equal(r.response.status, 200);
    assert.deepEqual(provisionCalls(f.calls)[0][2], {p_user_id: targetUser, p_role: 'admin', p_group_id: group.id, p_new_group_name: null});
  }
  for (const role of ['publisher', 'owner', {}, true]) {
    const f = await fixture(); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id, role});
    assert.equal(r.response.status, 400); assert(!f.calls.some(c => c[0] === 'createUser')); assert.equal(provisionCalls(f.calls).length, 0);
  }
});

test('database rejection of unsafe account moves and last-admin changes is surfaced without retry', async () => {
  for (const [code, status, expected] of [['42501', 403, 'access_denied'], ['40001', 409, 'operation_conflict'], ['22023', 400, 'invalid_input']]) {
    const f = await fixture({rpcError: {code, message: password}});
    const r = await f.run({action: 'assign', userId: targetUser, groupId: group.id, role: 'superintendent'});
    assert.equal(r.response.status, status); assert.equal(r.body.code, expected);
    assert.equal(provisionCalls(f.calls).length, 1); assert(!JSON.stringify(r.body).includes(password));
    assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'deleteUser'));
  }
});

test('admin listing includes protected roles and card bindings without leaking Auth metadata', async () => {
  const publisherUser = '00000000-0000-4000-8000-000000000003';
  const unlinkedUser = '00000000-0000-4000-8000-000000000004';
  const f = await fixture({
    users: [
      {id: owner, email: 'admin@example.test', user_metadata: {is_admin: false}},
      {id: targetUser, email: 'gestor@example.test', app_metadata: {secret: password}},
      {id: publisherUser, email: 'pessoa@example.test', encrypted_password: password},
      {id: unlinkedUser, email: 'pendente@example.test', user_metadata: {is_admin: true}}
    ],
    members: [{user_id: owner, is_admin: true, access_role: 'admin'}, {user_id: targetUser, is_admin: false, access_role: 'superintendent'}, {user_id: publisherUser, is_admin: false, access_role: 'publisher'}],
    links: [{user_id: targetUser, group_id: group.id}, {user_id: publisherUser, group_id: group.id}],
    bindings: [{user_id: publisherUser, person_id: person, unrelated: password}]
  });
  const r = await f.run(); assert.equal(r.response.status, 200);
  assert.deepEqual(r.body.users.map(u => [u.role, u.isAdmin, u.publisherId]), [['admin', true, null], ['superintendent', false, null], ['publisher', false, person], [null, false, null]]);
  assert.deepEqual(r.body.users[2], {id: publisherUser, email: 'pessoa@example.test', role: 'publisher', isAdmin: false, groupId: group.id, groupName: group.name, publisherId: person});
  assert(!JSON.stringify(r.body).includes(password));
  assert(f.calls.some(c => c.table === 'em_dia_members' && c.admin && c.columns === 'user_id,is_admin,access_role'));
});

test('incomplete, contradictory, or unavailable protected metadata cannot produce a partial users list', async () => {
  for (const options of [
    {listDataError: {message: password}}, {bindingsError: {code: '42501', message: password}},
    {members: [{user_id: owner, access_role: 'admin', is_admin: false}]},
    {members: [{user_id: owner, access_role: 'owner', is_admin: true}]},
    {bindings: [{user_id: targetUser, person_id: person}, {user_id: targetUser, person_id: 'other_person'}]},
    {bindings: [{user_id: 'invalid', person_id: person}]},
    {bindings: [{user_id: targetUser, person_id: '__proto__'}]}
  ]) {
    const f = await fixture(options); const r = await f.run();
    assert(r.response.status >= 400); assert.equal(r.body.users, undefined);
    assert(!JSON.stringify(r.body).includes(password));
  }
});

test('PostgREST result caps fail closed instead of omitting access links silently', async () => {
  for (const options of [
    {links: Array.from({length: 1000}, () => ({user_id: targetUser, group_id: group.id}))},
    {groups: Array.from({length: 1000}, () => group)},
    {members: Array.from({length: 1000}, () => ({user_id: owner, is_admin: true, access_role: 'admin'}))},
    {bindings: Array.from({length: 1000}, (_, i) => ({user_id: targetUser, person_id: `fixture_${i}`}))}
  ]) {
    const f = await fixture(options); const r = await f.run();
    assert(r.response.status >= 400); assert.equal(r.body.users, undefined);
  }
});

test('a mismatched or contradictory authoritative actor profile cannot use Auth admin APIs', async () => {
  for (const profile of [
    {user_id: targetUser, role: 'admin', is_admin: true},
    {user_id: owner, role: 'admin', is_admin: false},
    {user_id: owner, role: 'superintendent', is_admin: true},
    {user_id: owner, role: 'owner', is_admin: true},
    {user_id: owner, is_admin: true},
    []
  ]) {
    const f = await fixture({profile}); const r = await f.run();
    assert(r.response.status >= 400); assert(!f.calls.some(c => c[0] === 'listUsers' || c[0] === 'createUser' || c.table));
  }
});
