/* Em dia — cliente Supabase. Apenas a sessão de login é persistida pelo SDK. */
(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EmDiaCloud = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const DEFAULT_REDIRECT = 'https://notas-maraba.github.io/em-dia-relatorios/';

  class CloudError extends Error {
    constructor(message, code = 'cloud_error', cause) {
      super(message);
      this.name = 'CloudError';
      this.code = code;
      if (cause) this.cause = cause;
    }
  }
  class AuthRequiredError extends CloudError {
    constructor(cause) {
      super('Entre na sua conta para acessar os relatórios.', 'auth_required', cause);
      this.name = 'AuthRequiredError';
    }
  }
  class AccessDeniedError extends CloudError {
    constructor(cause) {
      super('Esta conta não tem acesso ao sistema. Use o e-mail autorizado.', 'access_denied', cause);
      this.name = 'AccessDeniedError';
    }
  }
  class ConflictError extends CloudError {
    constructor(cause) {
      super('A base foi atualizada em outro aparelho. Recarregue os dados antes de continuar.', 'conflict', cause);
      this.name = 'ConflictError';
    }
  }

  function mappedError(error, writing = false) {
    if (error instanceof CloudError) return error;
    const code = String(error?.code || '');
    if (['PT409', '40001', '23505'].includes(code) || error?.status === 409) return new ConflictError(error);
    if (code === '42501' || error?.status === 403) return new AccessDeniedError(error);
    if (error?.status === 401 || error?.name === 'AuthSessionMissingError' ||
        ['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found'].includes(code)) {
      return new AuthRequiredError(error);
    }
    return new CloudError(writing
      ? 'Não foi possível confirmar o salvamento na nuvem. Recarregue os dados antes de tentar novamente.'
      : 'Não foi possível acessar a nuvem. Confira sua conexão e tente novamente.', code || 'network_error', error);
  }

  function copy(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (error) { throw new CloudError('Os dados não puderam ser preparados para salvamento.', 'invalid_state', error); }
  }

  function stateObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function rowResult(row, groupId) {
    const revision = Number(row?.revision);
    if (!row || row.group_id !== groupId || !stateObject(row.state) || !Number.isSafeInteger(revision) || revision < 1) {
      throw new CloudError('A nuvem retornou uma base inválida. Nenhum dado foi substituído neste aparelho.', 'invalid_response');
    }
    return {state: copy(row.state), revision, updatedAt: row.updated_at || null};
  }

  function checkedGroupId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new CloudError('Escolha um grupo válido antes de continuar.', 'invalid_group');
    }
    return value;
  }

  function groupResult(row) {
    if (!row || typeof row.name !== 'string' || !row.name.trim()) {
      throw new CloudError('A nuvem retornou um grupo inválido.', 'invalid_response');
    }
    return {id: checkedGroupId(row.id), name: row.name, createdAt: row.created_at || null};
  }

  function create({client, redirectTo = DEFAULT_REDIRECT} = {}) {
    if (!client?.auth || typeof client.from !== 'function' || typeof client.rpc !== 'function') {
      throw new CloudError('A conexão com a nuvem não está configurada.', 'invalid_client');
    }
    // Redirects used here are configured by the application, never by a query parameter.
    const redirect = new URL(redirectTo);
    if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) {
      throw new CloudError('O endereço de retorno do login é inválido.', 'invalid_redirect');
    }

    async function session() {
      try {
        const result = await client.auth.getSession();
        if (result.error) throw result.error;
        if (!result.data?.session) return null;
        const verified = await client.auth.getUser();
        if (verified.error) throw verified.error;
        if (!verified.data?.user?.id) throw new AuthRequiredError();
        // getSession alone reads local storage. Only the server-verified user is returned.
        return {...result.data.session, user: verified.data.user};
      } catch (error) { throw mappedError(error); }
    }

    async function profile() {
      try {
      const current = await session();
      if (!current) throw new AuthRequiredError();
      const result = await client.from('em_dia_members').select('user_id,is_admin')
        .eq('user_id', current.user.id).maybeSingle();
      if (result.error) throw result.error;
      if (result.data?.user_id !== current.user.id) throw new AccessDeniedError();
      return {userId: current.user.id, isAdmin: result.data.is_admin === true};
      } catch (error) { throw mappedError(error); }
    }

    async function allowedGroup(groupId) {
      checkedGroupId(groupId);
      await profile();
      const result = await client.from('em_dia_groups').select('id,name,created_at')
        .eq('id', groupId).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new AccessDeniedError();
      return groupResult(result.data);
    }

    async function groups() {
      try {
        await profile();
        const result = await client.from('em_dia_groups').select('id,name,created_at').order('name');
        if (result.error) throw result.error;
        if (!Array.isArray(result.data)) throw new CloudError('Não foi possível carregar os grupos.', 'invalid_response');
        return result.data.map(groupResult);
      } catch (error) { throw mappedError(error); }
    }

    async function read(groupId) {
      try {
        await allowedGroup(groupId);
        const result = await client.from('em_dia_states').select('group_id,state,revision,updated_at')
          .eq('group_id', groupId).maybeSingle();
        if (result.error) throw result.error;
        return result.data === null ? null : rowResult(result.data, groupId);
      } catch (error) { throw mappedError(error); }
    }

    async function save(state, expectedRevision, groupId) {
      if (!stateObject(state)) throw new CloudError('A base para salvar é inválida.', 'invalid_state');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new CloudError('Recarregue a base antes de salvar.', 'invalid_revision');
      }
      const snapshot = copy(state);
      try {
        await allowedGroup(groupId);
        // No upsert and no write retry: the server compares the expected revision atomically.
        const result = await client.rpc('save_em_dia_group_state', {
          p_group_id: groupId,
          p_state: snapshot,
          p_expected_revision: expectedRevision
        });
        if (result.error) throw result.error;
        const rows = Array.isArray(result.data) ? result.data : [result.data];
        if (rows.length !== 1) throw new CloudError('Não foi possível confirmar o salvamento na nuvem.', 'invalid_response');
        const saved = rowResult(rows[0], groupId);
        if (saved.revision !== expectedRevision + 1) {
          throw new CloudError('O salvamento retornou uma revisão inesperada. Recarregue os dados.', 'invalid_response');
        }
        return saved;
      } catch (error) { throw mappedError(error, true); }
    }

    async function createGroup(name) {
      const value = String(name || '').trim();
      if (!value || value.length > 80) throw new CloudError('Informe um nome de grupo com até 80 caracteres.', 'invalid_group_name');
      try {
        await profile();
        const result = await client.rpc('create_em_dia_group', {p_name: value});
        if (result.error) throw result.error;
        const rows = Array.isArray(result.data) ? result.data : [result.data];
        if (rows.length !== 1) throw new CloudError('Não foi possível confirmar a criação do grupo. Recarregue antes de tentar de novo.', 'invalid_response');
        return groupResult(rows[0]);
      } catch (error) { throw mappedError(error, true); }
    }

    const adminMessages = {
      account_exists: 'Este e-mail já tem uma conta. Use a lista de usuários para vinculá-la a um grupo.',
      account_exists_needs_assignment: 'A conta pode ter sido criada, mas o vínculo não foi confirmado. Atualize a lista de usuários e vincule a conta antes de tentar criá-la novamente.',
      invalid_input: 'Confira os dados do usuário e escolha um grupo existente ou informe um novo grupo.',
      invalid_password: 'Use uma senha com pelo menos 12 caracteres.',
      invalid_group: 'O grupo escolhido não está disponível. Atualize a lista de grupos.',
      rate_limited: 'Aguarde um pouco antes de tentar novamente.',
      users_limit: 'A lista de usuários excede o limite de consulta. Contate o administrador do projeto.'
    };

    async function adminRequest(body) {
      const current = await profile();
      if (!current.isAdmin) throw new AccessDeniedError();
      if (!client.functions?.invoke) throw new CloudError('A administração de usuários está indisponível.', 'admin_unavailable');
      let response;
      try { response = await client.functions.invoke('em-dia-users', {body}); }
      catch (_) { throw new CloudError('Não foi possível confirmar a operação. Atualize a lista antes de repetir.', 'admin_unavailable'); }
      if (response.error) {
        let safeCode = '';
        try { safeCode = String((await response.error.context?.json())?.code || ''); } catch (_) { /* No raw server details or request bodies are retained. */ }
        if (['auth_required', 'access_denied'].includes(safeCode)) throw safeCode === 'auth_required' ? new AuthRequiredError() : new AccessDeniedError();
        throw new CloudError(adminMessages[safeCode] || 'Não foi possível confirmar a operação. Atualize a lista antes de repetir.', adminMessages[safeCode] ? safeCode : 'admin_unavailable');
      }
      if (!response.data || response.data.ok !== true) throw new CloudError('A administração retornou uma resposta inválida.', 'invalid_response');
      return response.data;
    }

    async function listUsers() {
      const result = await adminRequest({action: 'list'});
      if (!Array.isArray(result.users)) throw new CloudError('Não foi possível carregar os usuários.', 'invalid_response');
      return {users: result.users.map(user => ({id: checkedGroupId(user.id), email: String(user.email || ''),
        isAdmin: user.isAdmin === true, groupId: user.groupId ? checkedGroupId(user.groupId) : null,
        groupName: user.groupName ? String(user.groupName) : null}))};
    }

    function targetGroup({groupId, newGroupName}) {
      if ((groupId !== undefined && groupId !== null && typeof groupId !== 'string') ||
          (newGroupName !== undefined && newGroupName !== null && typeof newGroupName !== 'string')) throw new CloudError(adminMessages.invalid_input, 'invalid_input');
      const name = String(newGroupName || '').trim();
      if ((!!groupId) === (!!name) || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new CloudError(adminMessages.invalid_input, 'invalid_input');
      return groupId ? {groupId: checkedGroupId(groupId)} : {newGroupName: name};
    }

    async function createUser({email, password, groupId, newGroupName} = {}) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new CloudError('Informe um e-mail válido.', 'invalid_email');
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new CloudError(adminMessages.invalid_password, 'invalid_password');
      const result = await adminRequest({action: 'create', email: normalized, password, ...targetGroup({groupId, newGroupName})});
      return {userId: checkedGroupId(result.userId), group: groupResult(result.group)};
    }

    async function assignUser({userId, groupId, newGroupName} = {}) {
      const result = await adminRequest({action: 'assign', userId: checkedGroupId(userId), ...targetGroup({groupId, newGroupName})});
      return {userId: checkedGroupId(result.userId), group: groupResult(result.group)};
    }

    async function login(email) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw new CloudError('Informe um e-mail válido.', 'invalid_email');
      }
      try {
        const result = await client.auth.signInWithOtp({
          email: normalized,
          options: {shouldCreateUser: false, emailRedirectTo: redirect.href}
        });
        if (result.error) {
          // Never reveal whether a supplied address has a registered account.
          if (result.error.status === 429 || result.error.code === 'over_email_send_rate_limit') {
            throw new CloudError('Aguarde um pouco antes de pedir outro link de acesso.', 'login_rate_limit');
          }
          throw new CloudError('Não foi possível enviar o link. Confira o e-mail autorizado e tente novamente.', 'login_failed');
        }
        return {sent: true};
      } catch (error) { throw mappedError(error); }
    }

    async function logout() {
      try {
        const result = await client.auth.signOut();
        if (result.error) throw result.error;
      } catch (error) { throw mappedError(error); }
    }

    async function loginPassword(email, password) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || typeof password !== 'string' || !password) {
        throw new CloudError('Informe seu e-mail e sua senha para entrar.', 'invalid_credentials');
      }
      try {
        // The password only goes to Supabase Auth. It is never stored by this module or included in errors.
        const result = await client.auth.signInWithPassword({email: normalized, password});
        if (result.error) {
          if (result.error.status === 429 || result.error.code === 'over_request_rate_limit') {
            throw new CloudError('Aguarde um pouco antes de tentar entrar novamente.', 'login_rate_limit');
          }
          throw new CloudError('Não foi possível entrar. Confira o e-mail autorizado e a senha.', 'login_failed');
        }
        const verified = await session();
        if (!verified) throw new CloudError('Não foi possível confirmar o acesso. Tente entrar novamente.', 'login_failed');
        return {signedIn: true};
      } catch (error) {
        if (error instanceof CloudError) throw error;
        // An Auth transport error can contain request details. Do not retain it as a cause.
        throw new CloudError('Não foi possível entrar. Confira sua conexão e tente novamente.', 'login_failed');
      }
    }

    function subscribeAuth(callback) {
      if (typeof callback !== 'function') throw new TypeError('Uma função de retorno é necessária.');
      let active = true;
      const pending = new Set();
      const result = client.auth.onAuthStateChange((event, nextSession) => {
        // Auth callbacks execute under the SDK session lock. Defer app work so it can call getUser/read safely.
        const timer = setTimeout(() => {
          pending.delete(timer);
          if (active) callback(event, nextSession);
        }, 0);
        pending.add(timer);
      });
      return function unsubscribe() {
        active = false;
        pending.forEach(clearTimeout);
        pending.clear();
        result.data.subscription.unsubscribe();
      };
    }

    return Object.freeze({profile, groups, read, save, createGroup, listUsers, createUser, assignUser, login, loginPassword, logout, session, subscribeAuth});
  }

  return Object.freeze({create, CloudError, AuthRequiredError, AccessDeniedError, ConflictError});
});
