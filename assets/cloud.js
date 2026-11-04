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

  function rowResult(row) {
    const revision = Number(row?.revision);
    if (!row || !stateObject(row.state) || !Number.isSafeInteger(revision) || revision < 1) {
      throw new CloudError('A nuvem retornou uma base inválida. Nenhum dado foi substituído neste aparelho.', 'invalid_response');
    }
    return {state: copy(row.state), revision, updatedAt: row.updated_at || null};
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

    async function allowedUser() {
      const current = await session();
      if (!current) throw new AuthRequiredError();
      const result = await client.from('em_dia_members').select('user_id')
        .eq('user_id', current.user.id).maybeSingle();
      if (result.error) throw result.error;
      if (result.data?.user_id !== current.user.id) throw new AccessDeniedError();
      return current.user;
    }

    async function read() {
      try {
        const user = await allowedUser();
        const result = await client.from('em_dia_states').select('state,revision,updated_at')
          .eq('owner_id', user.id).maybeSingle();
        if (result.error) throw result.error;
        return result.data === null ? null : rowResult(result.data);
      } catch (error) { throw mappedError(error); }
    }

    async function save(state, expectedRevision) {
      if (!stateObject(state)) throw new CloudError('A base para salvar é inválida.', 'invalid_state');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new CloudError('Recarregue a base antes de salvar.', 'invalid_revision');
      }
      const snapshot = copy(state);
      try {
        await allowedUser();
        // No upsert and no write retry: the server compares the expected revision atomically.
        const result = await client.rpc('save_em_dia_state', {
          p_state: snapshot,
          p_expected_revision: expectedRevision
        });
        if (result.error) throw result.error;
        const rows = Array.isArray(result.data) ? result.data : [result.data];
        if (rows.length !== 1) throw new CloudError('Não foi possível confirmar o salvamento na nuvem.', 'invalid_response');
        const saved = rowResult(rows[0]);
        if (saved.revision !== expectedRevision + 1) {
          throw new CloudError('O salvamento retornou uma revisão inesperada. Recarregue os dados.', 'invalid_response');
        }
        return saved;
      } catch (error) { throw mappedError(error, true); }
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

    return Object.freeze({read, save, login, loginPassword, logout, session, subscribeAuth});
  }

  return Object.freeze({create, CloudError, AuthRequiredError, AccessDeniedError, ConflictError});
});
