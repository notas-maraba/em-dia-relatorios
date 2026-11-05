/* User administration boundary. Credentials and auth results are never logged. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ['admin', 'superintendent', 'publisher'];
const MAX_BYTES = 8192;
const ALLOWED_ORIGIN = 'https://notas-maraba.github.io';
const CORS_HEADERS = 'authorization,apikey,content-type,x-client-info,x-supabase-api-version,x-supabase-client-platform,x-supabase-client-platform-version,x-supabase-client-runtime,x-supabase-client-runtime-version';

class RequestError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function groupRow(value) {
  const rows = Array.isArray(value) ? value : [value];
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || !UUID.test(row.id) || typeof row.name !== 'string') throw new RequestError('operation_unconfirmed', 503);
  return {id: row.id, name: row.name, created_at: row.created_at || null};
}

function objectRow(value) {
  const rows = Array.isArray(value) ? value : [value];
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new RequestError('operation_unconfirmed', 503);
  return row;
}

function personId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new RequestError('invalid_input');
  return value;
}

function selection(body) {
  if ((body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== 'string') ||
      (body.newGroupName !== undefined && body.newGroupName !== null && typeof body.newGroupName !== 'string')) throw new RequestError('invalid_input');
  const hasId = typeof body.groupId === 'string' && body.groupId !== '';
  const hasName = typeof body.newGroupName === 'string' && body.newGroupName.trim() !== '';
  if (hasId === hasName || (hasId && !UUID.test(body.groupId))) throw new RequestError('invalid_input');
  if (hasName && (body.newGroupName.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(body.newGroupName))) throw new RequestError('invalid_input');
  return {groupId: hasId ? body.groupId : null, newGroupName: hasName ? body.newGroupName.trim() : null};
}

async function input(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RequestError('invalid_input');
  const size = Number(request.headers.get('content-length'));
  if (size > MAX_BYTES) throw new RequestError('invalid_input', 413);
  const reader = request.body?.getReader();
  let length = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new RequestError('invalid_input', 413); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new RequestError('invalid_input'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('invalid_input');
  const allowed = {
    list: ['action'],
    create: ['action', 'email', 'password', 'groupId', 'newGroupName', 'role'],
    assign: ['action', 'userId', 'groupId', 'newGroupName', 'role'],
    create_publisher: ['action', 'email', 'password', 'groupId', 'personId']
  };
  const fields = typeof body.action === 'string' && Object.hasOwn(allowed, body.action) ? allowed[body.action] : null;
  if (!Array.isArray(fields) || Object.keys(body).some(key => !fields.includes(key))) throw new RequestError('invalid_input');
  return body;
}

function databaseError(error) {
  if (error?.code === '42501') return new RequestError('access_denied', 403);
  if (['40001', 'PT409', '23505'].includes(error?.code)) return new RequestError('operation_conflict', 409);
  if (['22023', '23503', '23514'].includes(error?.code)) return new RequestError('invalid_input');
  return new RequestError('operation_unconfirmed', 503);
}

export function createHandler({getClients, allowedOrigin = ALLOWED_ORIGIN}) {
  return async function handle(request) {
    const origin = request.headers.get('origin');
    const cors = origin === allowedOrigin ? {'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin'} : {};
    const respond = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
    if (origin && origin !== allowedOrigin) return respond({ok: false, code: 'origin_denied'}, 403);
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: {...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': CORS_HEADERS, 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store'}});
    if (request.method !== 'POST') return respond({ok: false, code: 'method_not_allowed'}, 405);
    const authorization = request.headers.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 8192) return respond({ok: false, code: 'auth_required'}, 401);
    try {
      const {userClient, adminClient} = getClients(authorization);
      const verification = await userClient.auth.getUser(authorization.slice(7));
      if (verification.error || !verification.data?.user?.id) throw new RequestError('auth_required', 401);
      const userId = verification.data.user.id;
      const membership = await userClient.rpc('get_em_dia_access_profile');
      if (membership.error) throw databaseError(membership.error);
      const actor = objectRow(membership.data);
      if (actor.user_id !== userId || !['admin', 'superintendent'].includes(actor.role) || actor.is_admin !== (actor.role === 'admin')) throw new RequestError('access_denied', 403);
      const body = await input(request);
      if (actor.role !== 'admin' && body.action !== 'create_publisher') throw new RequestError('access_denied', 403);
      if (body.action === 'list') {
        const users = [];
        const perPage = 200;
        for (let page = 1; page <= 10; page++) {
          const result = await adminClient.auth.admin.listUsers({page, perPage});
          if (result.error || !Array.isArray(result.data?.users)) throw new RequestError('operation_unconfirmed', 503);
          users.push(...result.data.users);
          if (result.data.users.length < perPage) break;
          if (page === 10) throw new RequestError('users_limit', 413);
        }
        const [links, groups, members] = await Promise.all([
          userClient.from('em_dia_group_members').select('group_id,user_id'),
          userClient.from('em_dia_groups').select('id,name'),
          adminClient.from('em_dia_members').select('user_id,is_admin,access_role')
        ]);
        if (links.error || groups.error || members.error || !Array.isArray(links.data) || !Array.isArray(groups.data) || !Array.isArray(members.data)) throw new RequestError('operation_unconfirmed', 503);
        // PostgREST's default row cap must never turn a partial list into an apparently complete one.
        if ([links.data, groups.data, members.data].some(rows => rows.length >= 1000)) throw new RequestError('users_limit', 413);
        const names = new Map(groups.data.map(group => [group.id, group.name]));
        const linked = new Map(links.data.map(link => [link.user_id, link.group_id]));
        const approved = new Map();
        for (const member of members.data) {
          if (!UUID.test(member.user_id || '') || !ROLES.includes(member.access_role) || member.is_admin !== (member.access_role === 'admin')) throw new RequestError('operation_unconfirmed', 503);
          approved.set(member.user_id, member.access_role);
        }
        const bound = new Map();
        const bindingLists = await Promise.all(groups.data.map(group => userClient.rpc('list_em_dia_publisher_accounts', {p_group_id: group.id})));
        for (const bindingList of bindingLists) {
          if (bindingList.error || !Array.isArray(bindingList.data) || bindingList.data.length >= 1000) throw new RequestError('operation_unconfirmed', 503);
          for (const binding of bindingList.data) {
            if (!UUID.test(binding.user_id || '') || bound.has(binding.user_id)) throw new RequestError('operation_unconfirmed', 503);
            bound.set(binding.user_id, personId(binding.person_id));
          }
        }
        return respond({ok: true, users: users.map(user => ({id: user.id, email: user.email || '', role: approved.get(user.id) || null,
          isAdmin: approved.get(user.id) === 'admin', groupId: linked.get(user.id) || null,
          groupName: names.get(linked.get(user.id)) || null, publisherId: bound.get(user.id) || null}))});
      }
      const creatingPublisher = body.action === 'create_publisher';
      const target = creatingPublisher ? {groupId: UUID.test(body.groupId || '') ? body.groupId : null, newGroupName: null} : selection(body);
      let publisher = null;
      if (creatingPublisher) {
        if (!target.groupId) throw new RequestError('invalid_input');
        publisher = personId(body.personId);
      }
      let role = null;
      if (!creatingPublisher && body.role !== undefined && body.role !== null) {
        if (!['admin', 'superintendent'].includes(body.role)) throw new RequestError('invalid_input');
        role = body.role;
      }
      if (!creatingPublisher && body.action === 'create' && role === null) role = 'superintendent';
      if (!creatingPublisher && target.groupId) {
        const selected = await userClient.from('em_dia_groups').select('id').eq('id', target.groupId).maybeSingle();
        if (selected.error || selected.data?.id !== target.groupId) throw new RequestError('invalid_group');
      }
      let targetUserId = body.userId;
      const creating = body.action === 'create' || creatingPublisher;
      if (creating) {
        if (typeof body.email !== 'string' || body.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw new RequestError('invalid_input');
        if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new RequestError('invalid_password');
        if (creatingPublisher) {
          const preflight = await userClient.rpc('preflight_em_dia_publisher_account', {p_group_id: target.groupId, p_person_id: publisher});
          if (preflight.error) throw databaseError(preflight.error);
          const selected = objectRow(preflight.data);
          if (selected.group_id !== target.groupId || selected.person_id !== publisher || typeof selected.name !== 'string') throw new RequestError('invalid_group');
        }
        let created;
        try {
          created = await adminClient.auth.admin.createUser({email: body.email.trim().toLowerCase(), password: body.password, email_confirm: true});
        } catch (_) { throw new RequestError('account_exists_needs_assignment', 503); }
        finally { delete body.password; }
        if (created.error) {
          if (['email_exists', 'user_already_exists'].includes(created.error.code)) throw new RequestError('account_exists', 409);
          if (created.error.status === 429) throw new RequestError('rate_limited', 429);
          throw new RequestError('operation_unconfirmed', 503);
        }
        targetUserId = created.data?.user?.id;
        if (!UUID.test(targetUserId || '')) throw new RequestError('account_exists_needs_assignment', 503);
      } else if (!UUID.test(targetUserId || '')) throw new RequestError('invalid_input');
      let provision;
      try {
        provision = creatingPublisher
          ? await userClient.rpc('provision_em_dia_publisher_account', {p_user_id: targetUserId, p_group_id: target.groupId, p_person_id: publisher})
          : await userClient.rpc('provision_em_dia_access', {p_user_id: targetUserId, p_role: role, p_group_id: target.groupId, p_new_group_name: target.newGroupName});
      } catch (_) {
        throw new RequestError(creating ? 'account_exists_needs_assignment' : 'operation_unconfirmed', 503);
      }
      if (provision.error) {
        if (creating) throw new RequestError('account_exists_needs_assignment', 409);
        throw databaseError(provision.error);
      }
      let group;
      try {
        group = groupRow(provision.data);
        if (target.groupId && group.id !== target.groupId) throw new Error('Unexpected group');
      } catch (_) { throw new RequestError(creating ? 'account_exists_needs_assignment' : 'operation_unconfirmed', 503); }
      return respond({ok: true, userId: targetUserId, group, ...(creatingPublisher ? {personId: publisher} : {})});
    } catch (error) {
      // Only a closed set of static error codes crosses the server boundary.
      if (error instanceof RequestError) return respond({ok: false, code: error.code}, error.status);
      return respond({ok: false, code: 'operation_unconfirmed'}, 503);
    }
  };
}
