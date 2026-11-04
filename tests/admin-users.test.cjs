'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const handlerModule = import('../supabase/functions/em-dia-users/handler.mjs');
const owner = '00000000-0000-4000-8000-000000000001';
const targetUser = '00000000-0000-4000-8000-000000000002';
const group = {id: '10000000-0000-4000-8000-000000000001', name: 'Grupo de teste', created_at: null};
const origin = 'https://notas-maraba.github.io';
const password = 'Senha fictícia somente teste!';

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
        if (table === 'em_dia_members') return {data: options.missingMember ? null : {user_id: owner, is_admin: options.notAdmin !== true}, error: options.memberError || null};
        return {data: options.missingGroup ? null : group, error: null};
      },
      then(resolve, reject) {
        calls.push(value);
        const data = table === 'em_dia_groups' ? [group] : table === 'em_dia_group_members' ? [{user_id: targetUser, group_id: group.id}] : [{user_id: owner, is_admin: true}];
        return Promise.resolve({data, error: options.listDataError || null}).then(resolve, reject);
      }
    };
  }
  const userClient = {
    auth: {async getUser(token) {calls.push(['verify', token]); return {data: {user: options.noUser ? null : {id: owner, user_metadata: {is_admin: true}}}, error: options.authError || null};}},
    from(table) {return query(table);},
    async rpc(name, args) {calls.push(['rpc', name, args]); if (options.rpcThrow) throw options.rpcThrow; return {data: options.rpcData || [group], error: options.rpcError || null};}
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
  assert.equal(r.response.status, 403); assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'listUsers' || c[0] === 'rpc'));
});

test('missing membership fails closed even with a valid Auth user', async () => {
  const f = await fixture({missingMember: true}); const r = await f.run();
  assert.equal(r.response.status, 403); assert(!f.calls.some(c => c[0] === 'listUsers'));
});

test('user listing exposes only selected identity and group fields', async () => {
  const f = await fixture(); const r = await f.run();
  assert.equal(r.response.status, 200); assert.equal(r.body.users.length, 2);
  assert.deepEqual(r.body.users[1], {id: targetUser, email: 'responsavel@example.test', isAdmin: false, groupId: group.id, groupName: group.name});
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
  assert.equal(both.body.code, 'invalid_input'); assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'rpc'));
});

test('oversized and malformed JSON requests fail without administrative mutations', async () => {
  const f = await fixture(); const tooLarge = await f.run(undefined, {raw: JSON.stringify({action: 'create', password: 'x'.repeat(9000)})});
  assert.equal(tooLarge.response.status, 413);
  const malformed = await f.run(undefined, {raw: '{not-json'}); assert.equal(malformed.response.status, 400);
  assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'rpc'));
});

test('unexpected action and group types are rejected without administrative mutations', async () => {
  const f = await fixture();
  for (const action of ['__proto__', 'constructor', 'toString', null, {}]) {
    const r = await f.run({action}); assert.equal(r.response.status, 400); assert.equal(r.body.code, 'invalid_input');
  }
  for (const target of [{groupId: 0, newGroupName: 'Grupo'}, {groupId: group.id, newGroupName: {}}, {groupId: [], newGroupName: 'Grupo'}]) {
    const r = await f.run({action: 'assign', userId: targetUser, ...target}); assert.equal(r.response.status, 400); assert.equal(r.body.code, 'invalid_input');
  }
  assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'rpc'));
});

test('successful creation uses trusted Auth and atomic group provisioning without returning credentials', async () => {
  const f = await fixture(); const r = await f.run({action: 'create', email: ' NOVO@example.test ', password, groupId: group.id});
  assert.equal(r.response.status, 200); assert.deepEqual(r.body, {ok: true, userId: targetUser, group});
  assert.deepEqual(f.calls.find(c => c[0] === 'createUser')[1], {email: 'novo@example.test', password, email_confirm: true});
  assert.deepEqual(f.calls.find(c => c[0] === 'rpc'), ['rpc', 'provision_em_dia_group_member', {p_user_id: targetUser, p_group_id: group.id, p_new_group_name: null}]);
  assert(!JSON.stringify(r.body).includes(password));
});

test('a new group is created only inside the provisioning transaction', async () => {
  const f = await fixture(); const r = await f.run({action: 'create', email: 'novo@example.test', password, newGroupName: ' Grupo novo '});
  assert.equal(r.response.status, 200);
  assert.deepEqual(f.calls.find(c => c[0] === 'rpc')[2], {p_user_id: targetUser, p_group_id: null, p_new_group_name: 'Grupo novo'});
  assert.equal(f.calls.filter(c => c[0] === 'rpc').length, 1);
});

test('existing email is never reset or recreated automatically', async () => {
  const f = await fixture({createError: {code: 'email_exists', message: 'must-not-return'}}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.response.status, 409); assert.equal(r.body.code, 'account_exists'); assert.equal(f.calls.filter(c => c[0] === 'createUser').length, 1);
  assert(!f.calls.some(c => c[0] === 'rpc' || c[0] === 'deleteUser')); assert(!JSON.stringify(r.body).includes('must-not-return'));
});

test('unknown Auth outcome is not retried and account is not deleted', async () => {
  const f = await fixture({createThrow: Error('response lost ' + password)}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.body.code, 'account_exists_needs_assignment'); assert.equal(f.calls.filter(c => c[0] === 'createUser').length, 1);
  assert(!f.calls.some(c => c[0] === 'deleteUser')); assert(!JSON.stringify(r.body).includes(password));
});

test('failed provisioning preserves account for explicit reassignment instead of deletion', async () => {
  const f = await fixture({rpcThrow: Error('lost ' + password)}); const r = await f.run({action: 'create', email: 'novo@example.test', password, groupId: group.id});
  assert.equal(r.body.code, 'account_exists_needs_assignment'); assert(!f.calls.some(c => c[0] === 'deleteUser'));
  assert.equal(f.calls.filter(c => c[0] === 'rpc').length, 1); assert(!JSON.stringify(r.body).includes(password));
});

test('assigning an existing account changes only membership and never its password', async () => {
  const f = await fixture(); const r = await f.run({action: 'assign', userId: targetUser, groupId: group.id});
  assert.equal(r.response.status, 200); assert(!f.calls.some(c => c[0] === 'createUser' || c[0] === 'deleteUser'));
  assert.equal(f.calls.filter(c => c[0] === 'rpc').length, 1);
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
