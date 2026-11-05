/* Em dia — cliente Supabase. Apenas a sessão de login é persistida pelo SDK. */
(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EmDiaCloud = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const DEFAULT_REDIRECT = 'https://notas-maraba.github.io/em-dia-relatorios/';
  const ROLES = ['admin', 'superintendent', 'publisher'];

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

  function checkedPersonId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) {
      throw new CloudError('Escolha um publicador válido antes de continuar.', 'invalid_person');
    }
    return value;
  }

  function checkedMonth(value) {
    if (typeof value !== 'string' || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)) {
      throw new CloudError('Escolha um mês válido.', 'invalid_month');
    }
    return value;
  }

  function checkedDate(value) {
    if (typeof value !== 'string' || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) ||
        new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8)))).toISOString().slice(0, 10) !== value) {
      throw new CloudError('Escolha uma data válida para o lançamento.', 'invalid_date');
    }
    return value;
  }

  function monthMinutes(month) {
    return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate() * 1440;
  }

  function responseVersion(value, minimum = 0) {
    if (!(typeof value === 'number' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) {
      throw new CloudError('A nuvem retornou uma versão inválida.', 'invalid_response');
    }
    try { return checkedVersion(Number(value), minimum); }
    catch (_) { throw new CloudError('A nuvem retornou uma versão inválida.', 'invalid_response'); }
  }

  function ownHoursResult(row, current, month) {
    try {
      if (row.group_id !== current.defaultGroupId || row.person_id !== current.publisherId || row.month !== month ||
          !['publisher', 'regular', 'auxiliary'].includes(row.kind) || !stateObject(row.entries) ||
          typeof row.closed !== 'boolean' || !Number.isSafeInteger(row.total_minutes) || row.total_minutes < 0 ||
          row.total_minutes > monthMinutes(month) || !(row.updated_at === null || typeof row.updated_at === 'string')) throw new Error('Invalid diary');
      const today = checkedDate(row.today), entries = Object.entries(row.entries), version = responseVersion(row.version);
      if (month > today.slice(0, 7) || row.closed !== (month < today.slice(0, 7)) || entries.length > 31 ||
          version === 0 && entries.length || entries.some(([date, minutes]) => checkedDate(date).slice(0, 7) !== month || date > today ||
            !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1440) ||
          entries.reduce((total, [, minutes]) => total + minutes, 0) !== row.total_minutes) throw new Error('Invalid diary');
      return {groupId: row.group_id, personId: row.person_id, month, kind: row.kind,
        entries: Object.fromEntries(entries), version, totalMinutes: row.total_minutes, closed: row.closed,
        today, updatedAt: row.updated_at};
    } catch (_) { throw new CloudError('A nuvem retornou um diário inválido. Recarregue seu cartão.', 'invalid_response'); }
  }

  function checkedVersion(value, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
      throw new CloudError('Recarregue os dados antes de continuar.', 'invalid_revision');
    }
    return value;
  }

  function objectResult(value) {
    const rows = Array.isArray(value) ? value : [value];
    if (rows.length !== 1 || !stateObject(rows[0])) throw new CloudError('A nuvem retornou uma resposta inválida.', 'invalid_response');
    return rows[0];
  }

  function activityInput(value) {
    if (!stateObject(value) || Object.keys(value).some(key => !['participated', 'hours', 'studies'].includes(key)) ||
        !['participated', 'hours', 'studies'].every(key => Object.hasOwn(value, key)) ||
        !(value.participated === null || typeof value.participated === 'boolean') ||
        !(value.hours === null || typeof value.hours === 'number' && Number.isFinite(value.hours) && value.hours >= 0 && value.hours <= 744 && Math.abs(value.hours * 100 - Math.round(value.hours * 100)) < 1e-7) ||
        !(value.studies === null || Number.isSafeInteger(value.studies) && value.studies >= 0 && value.studies <= 9999)) {
      throw new CloudError('Confira a participação, as horas e os estudos informados.', 'invalid_report');
    }
    return {participated: value.participated, hours: value.hours, studies: value.studies};
  }

  function activityResult(value) {
    if (!stateObject(value) || !['publisher', 'regular', 'auxiliary'].includes(value.kind)) throw new CloudError('A nuvem retornou um relatório inválido.', 'invalid_response');
    const input = activityInput({participated: value.participated, hours: value.hours, studies: value.studies});
    return {...input, kind: value.kind, received: value.received === true};
  }

  function ownRevision(value) {
    if (!stateObject(value) || !['accepted', 'pending', 'ignored'].includes(value.status)) throw new CloudError('A nuvem retornou uma solicitação inválida.', 'invalid_response');
    return {id: checkedGroupId(value.id), month: checkedMonth(value.month), status: value.status,
      version: checkedVersion(Number(value.version), 1), report: activityResult(value.proposed_report),
      submittedAt: value.submitted_at || null, reviewedAt: value.reviewed_at || null};
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
      const result = await client.rpc('get_em_dia_access_profile');
      if (result.error) throw result.error;
      const row = objectResult(result.data);
      if (row.user_id !== current.user.id || !ROLES.includes(row.role) ||
          (row.is_admin !== undefined && row.is_admin !== (row.role === 'admin'))) throw new AccessDeniedError();
      const defaultGroupId = row.group_id === null ? null : checkedGroupId(row.group_id);
      const publisherId = row.publisher_id === null || row.publisher_id === undefined ? null : checkedPersonId(row.publisher_id);
      if ((row.role === 'publisher') !== (publisherId !== null) || row.role === 'publisher' && !defaultGroupId) throw new AccessDeniedError();
      return {userId: current.user.id, role: row.role, isAdmin: row.role === 'admin', defaultGroupId, publisherId};
      } catch (error) { throw mappedError(error); }
    }

    async function requireManager() {
      const current = await profile();
      if (!['admin', 'superintendent'].includes(current.role)) throw new AccessDeniedError();
      return current;
    }

    async function allowedGroup(groupId) {
      checkedGroupId(groupId);
      await requireManager();
      const result = await client.from('em_dia_groups').select('id,name,created_at')
        .eq('id', groupId).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data || result.data.id !== groupId) throw new AccessDeniedError();
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
        const current = await profile();
        if (!current.isAdmin) throw new AccessDeniedError();
        const result = await client.rpc('create_em_dia_group', {p_name: value});
        if (result.error) throw result.error;
        const rows = Array.isArray(result.data) ? result.data : [result.data];
        if (rows.length !== 1) throw new CloudError('Não foi possível confirmar a criação do grupo. Recarregue antes de tentar de novo.', 'invalid_response');
        return groupResult(rows[0]);
      } catch (error) { throw mappedError(error, true); }
    }

    async function readOwnCard() {
      try {
        const current = await profile();
        if (current.role !== 'publisher') throw new AccessDeniedError();
        const result = await client.rpc('read_em_dia_own_card');
        if (result.error) throw result.error;
        const row = objectResult(result.data), own = rowResult(row, current.defaultGroupId);
        if (row.person_id !== current.publisherId || typeof row.group_name !== 'string' || !row.group_name.trim() ||
            !Array.isArray(own.state.people) || own.state.people.length !== 1 || own.state.people[0]?.id !== current.publisherId ||
            own.state.people[0].notes !== '' || !stateObject(own.state.reports) || !stateObject(own.state.reminders) || Object.keys(own.state.reminders).length ||
            Object.values(own.state.reports).some(entries => !stateObject(entries) || Object.keys(entries).some(id => id !== current.publisherId) || Object.values(entries).some(report => report.notes !== '')) ||
            !Array.isArray(row.revisions)) throw new CloudError('A nuvem retornou um cartão inválido.', 'invalid_response');
        return {...own, groupId: row.group_id, personId: row.person_id,
          group: {id: row.group_id, name: row.group_name, createdAt: null}, revisions: row.revisions.map(ownRevision)};
      } catch (error) { throw mappedError(error); }
    }

    async function submitOwnReport({month, report, expectedVersion} = {}) {
      const selectedMonth = checkedMonth(month), input = activityInput(report), version = checkedVersion(expectedVersion);
      try {
        const current = await profile();
        if (current.role !== 'publisher') throw new AccessDeniedError();
        const result = await client.rpc('submit_em_dia_own_report', {p_month: selectedMonth, p_report: input, p_expected_version: version});
        if (result.error) throw result.error;
        const row = objectResult(result.data);
        if (!['accepted', 'pending'].includes(row.status) || row.group_id !== current.defaultGroupId || row.person_id !== current.publisherId || row.month !== selectedMonth || typeof row.unchanged !== 'boolean') {
          throw new CloudError('Não foi possível confirmar o envio. Recarregue seu cartão antes de tentar novamente.', 'invalid_response');
        }
        const savedVersion = checkedVersion(Number(row.version));
        if (savedVersion === 0 && !(row.status === 'accepted' && row.unchanged)) throw new CloudError('Não foi possível confirmar a versão do envio.', 'invalid_response');
        return {status: row.status, version: savedVersion, groupId: row.group_id, personId: row.person_id,
          month: row.month, revision: checkedVersion(Number(row.revision), 1), unchanged: row.unchanged};
      } catch (error) { throw mappedError(error, true); }
    }

    async function readOwnHours(month) {
      const selectedMonth = checkedMonth(month);
      try {
        const current = await profile();
        if (current.role !== 'publisher') throw new AccessDeniedError();
        const result = await client.rpc('read_em_dia_own_hours', {p_month: selectedMonth});
        if (result.error) throw result.error;
        return ownHoursResult(objectResult(result.data), current, selectedMonth);
      } catch (error) { throw mappedError(error); }
    }

    async function saveOwnHours({date, minutes, expectedVersion} = {}) {
      const selectedDate = checkedDate(date), version = checkedVersion(expectedVersion);
      if (!(minutes === null || Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 1440)) {
        throw new CloudError('Informe um total de 0 a 24 horas para este dia.', 'invalid_minutes');
      }
      try {
        const current = await profile();
        if (current.role !== 'publisher') throw new AccessDeniedError();
        const result = await client.rpc('save_em_dia_own_hours', {p_date: selectedDate, p_minutes: minutes, p_expected_version: version});
        if (result.error) throw result.error;
        const row = objectResult(result.data), saved = ownHoursResult(row, current, selectedDate.slice(0, 7));
        if (!['regular', 'auxiliary'].includes(saved.kind) || typeof row.unchanged !== 'boolean' ||
            (minutes === null ? Object.hasOwn(saved.entries, selectedDate) : saved.entries[selectedDate] !== minutes) ||
            (row.unchanged ? saved.version < version : saved.version !== version + 1)) {
          throw new CloudError('Não foi possível confirmar o lançamento. Recarregue o diário antes de tentar novamente.', 'invalid_response');
        }
        return {...saved, unchanged: row.unchanged};
      } catch (error) { throw mappedError(error, true); }
    }

    async function submitOwnHours({month, participated, studies, expectedHoursVersion, expectedReportVersion} = {}) {
      const selectedMonth = checkedMonth(month), hoursVersion = checkedVersion(expectedHoursVersion, 1), reportVersion = checkedVersion(expectedReportVersion);
      if (!(participated === null || typeof participated === 'boolean') ||
          !(studies === null || Number.isSafeInteger(studies) && studies >= 0 && studies <= 9999)) {
        throw new CloudError('Confira a participação e os estudos informados.', 'invalid_report');
      }
      try {
        const current = await profile();
        if (current.role !== 'publisher') throw new AccessDeniedError();
        const result = await client.rpc('submit_em_dia_own_hours', {p_month: selectedMonth, p_participated: participated,
          p_studies: studies, p_expected_hours_version: hoursVersion, p_expected_report_version: reportVersion});
        if (result.error) throw result.error;
        const row = objectResult(result.data), savedVersion = responseVersion(row.version), savedHoursVersion = responseVersion(row.hours_version, 1);
        if (!['accepted', 'pending'].includes(row.status) || row.group_id !== current.defaultGroupId || row.person_id !== current.publisherId ||
            row.month !== selectedMonth || typeof row.unchanged !== 'boolean' || savedHoursVersion !== hoursVersion ||
            !Number.isSafeInteger(row.total_minutes) || row.total_minutes < 0 || row.total_minutes > monthMinutes(selectedMonth) ||
            (savedVersion === 0 && !(row.status === 'accepted' && row.unchanged)) ||
            (!row.unchanged && savedVersion !== reportVersion + 1)) {
          throw new CloudError('Não foi possível confirmar o envio do mês. Recarregue seu cartão antes de tentar novamente.', 'invalid_response');
        }
        return {status: row.status, version: savedVersion, groupId: row.group_id, personId: row.person_id, month: row.month,
          revision: responseVersion(row.revision, 1), unchanged: row.unchanged, hoursVersion: savedHoursVersion, totalMinutes: row.total_minutes};
      } catch (error) { throw mappedError(error, true); }
    }

    async function listRevisions(groupId) {
      const id = checkedGroupId(groupId);
      try {
        await allowedGroup(id);
        const result = await client.rpc('list_em_dia_report_revisions', {p_group_id: id});
        if (result.error) throw result.error;
        const row = objectResult(result.data);
        if (!Array.isArray(row.revisions) || !Number.isSafeInteger(Number(row.total)) || Number(row.total) < row.revisions.length) throw new CloudError('A lista de alterações está inválida.', 'invalid_response');
        return {total: Number(row.total), revisions: row.revisions.map(item => {
          if (!stateObject(item) || typeof item.person_name !== 'string') throw new CloudError('A lista de alterações está inválida.', 'invalid_response');
          return {id: checkedGroupId(item.id), version: checkedVersion(Number(item.version), 1), personId: checkedPersonId(item.person_id),
            personName: item.person_name, month: checkedMonth(item.month), approvedReport: item.approved_report === null ? null : activityResult(item.approved_report),
            proposedReport: activityResult(item.proposed_report), submittedAt: item.submitted_at || null};
        })};
      } catch (error) { throw mappedError(error); }
    }

    async function reviewRevision({revisionId, expectedVersion, decision} = {}) {
      const id = checkedGroupId(revisionId), version = checkedVersion(expectedVersion, 1);
      if (!['accept', 'ignore'].includes(decision)) throw new CloudError('Escolha aceitar ou ignorar a alteração.', 'invalid_decision');
      try {
        const current = await requireManager();
        const result = await client.rpc('review_em_dia_report_revision', {p_revision_id: id, p_expected_version: version, p_decision: decision});
        if (result.error) throw result.error;
        const row = objectResult(result.data);
        if (!['accepted', 'ignored'].includes(row.status) || row.status !== (decision === 'accept' ? 'accepted' : 'ignored') || typeof row.unchanged !== 'boolean' ||
            !current.isAdmin && row.group_id !== current.defaultGroupId) throw new CloudError('Não foi possível confirmar a decisão. Atualize a lista.', 'invalid_response');
        return {status: row.status, version: checkedVersion(Number(row.version), 1), groupId: checkedGroupId(row.group_id),
          revision: checkedVersion(Number(row.revision), 1), unchanged: row.unchanged};
      } catch (error) { throw mappedError(error, true); }
    }

    async function transferGroups() {
      try {
        await requireManager();
        const result = await client.rpc('list_em_dia_transfer_groups');
        if (result.error) throw result.error;
        if (!Array.isArray(result.data)) throw new CloudError('Não foi possível carregar os grupos de destino.', 'invalid_response');
        return result.data.map(groupResult);
      } catch (error) { throw mappedError(error); }
    }

    async function transferPublisher({fromGroupId, toGroupId, personId, expectedRevision} = {}) {
      const from = checkedGroupId(fromGroupId), to = checkedGroupId(toGroupId), person = checkedPersonId(personId), revision = checkedVersion(expectedRevision, 1);
      if (from === to) throw new CloudError('Escolha outro grupo de destino.', 'invalid_group');
      try {
        await allowedGroup(from);
        const result = await client.rpc('transfer_em_dia_publisher', {p_from_group_id: from, p_to_group_id: to, p_person_id: person, p_expected_from_revision: revision});
        if (result.error) throw result.error;
        const row = objectResult(result.data);
        if (row.from_group_id !== from || row.to_group_id !== to || row.person_id !== person) throw new CloudError('Não foi possível confirmar a transferência. Recarregue os grupos.', 'invalid_response');
        return {fromGroupId: from, toGroupId: to, personId: person, fromRevision: checkedVersion(Number(row.from_revision), 1), toRevision: checkedVersion(Number(row.to_revision), 1)};
      } catch (error) { throw mappedError(error, true); }
    }

    async function publisherAccounts(groupId) {
      const id = checkedGroupId(groupId);
      try {
        await allowedGroup(id);
        const result = await client.rpc('list_em_dia_publisher_accounts', {p_group_id: id});
        if (result.error) throw result.error;
        if (!Array.isArray(result.data)) throw new CloudError('Não foi possível consultar os acessos dos publicadores.', 'invalid_response');
        return result.data.map(item => ({personId: checkedPersonId(item.person_id), userId: checkedGroupId(item.user_id)}));
      } catch (error) { throw mappedError(error); }
    }

    const adminMessages = {
      account_exists: 'Este e-mail já tem uma conta. A administração precisa conferir o vínculo antes de tentar novamente.',
      account_exists_needs_assignment: 'A conta pode ter sido criada, mas o vínculo não foi confirmado. A administração precisa conferir o acesso antes de repetir o cadastro.',
      invalid_input: 'Confira os dados do usuário e o vínculo escolhido.',
      invalid_password: 'Use uma senha com pelo menos 12 caracteres.',
      invalid_group: 'O grupo escolhido não está disponível. Atualize a lista de grupos.',
      rate_limited: 'Aguarde um pouco antes de tentar novamente.',
      users_limit: 'A lista de usuários excede o limite de consulta. Contate o administrador do projeto.',
      operation_conflict: 'Os dados mudaram durante a operação. Atualize a lista antes de tentar novamente.'
    };

    async function adminRequest(body) {
      const current = await profile();
      const allowed = body.action === 'create_publisher' ? ['admin', 'superintendent'] : ['admin'];
      if (!allowed.includes(current.role)) throw new AccessDeniedError();
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
      return {users: result.users.map(user => {
        if (!stateObject(user) || user.role !== null && !ROLES.includes(user.role)) throw new CloudError('A administração retornou um perfil inválido.', 'invalid_response');
        return {id: checkedGroupId(user.id), email: String(user.email || ''), role: user.role, isAdmin: user.role === 'admin',
          groupId: user.groupId ? checkedGroupId(user.groupId) : null, groupName: user.groupName ? String(user.groupName) : null,
          publisherId: user.publisherId ? checkedPersonId(user.publisherId) : null};
      })};
    }

    function targetGroup({groupId, newGroupName}) {
      if ((groupId !== undefined && groupId !== null && typeof groupId !== 'string') ||
          (newGroupName !== undefined && newGroupName !== null && typeof newGroupName !== 'string')) throw new CloudError(adminMessages.invalid_input, 'invalid_input');
      const name = String(newGroupName || '').trim();
      if ((!!groupId) === (!!name) || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new CloudError(adminMessages.invalid_input, 'invalid_input');
      return groupId ? {groupId: checkedGroupId(groupId)} : {newGroupName: name};
    }

    function managerRole(role, optional = false) {
      if (optional && (role === undefined || role === null)) return {};
      if (!['admin', 'superintendent'].includes(role)) throw new CloudError('Escolha Administrador ou Superintendente. O acesso de publicador é criado no cartão.', 'invalid_role');
      return {role};
    }

    async function createUser({email, password, groupId, newGroupName, role = 'superintendent'} = {}) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new CloudError('Informe um e-mail válido.', 'invalid_email');
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new CloudError(adminMessages.invalid_password, 'invalid_password');
      const result = await adminRequest({action: 'create', email: normalized, password, ...targetGroup({groupId, newGroupName}), ...managerRole(role)});
      return {userId: checkedGroupId(result.userId), group: groupResult(result.group)};
    }

    async function assignUser({userId, groupId, newGroupName, role} = {}) {
      const result = await adminRequest({action: 'assign', userId: checkedGroupId(userId), ...targetGroup({groupId, newGroupName}), ...managerRole(role, true)});
      return {userId: checkedGroupId(result.userId), group: groupResult(result.group)};
    }

    async function createPublisherUser({email, password, groupId, personId} = {}) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new CloudError('Informe um e-mail válido.', 'invalid_email');
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new CloudError(adminMessages.invalid_password, 'invalid_password');
      const id = checkedGroupId(groupId), person = checkedPersonId(personId);
      const result = await adminRequest({action: 'create_publisher', email: normalized, password, groupId: id, personId: person});
      if (result.personId !== person || result.group?.id !== id) throw new CloudError('Não foi possível confirmar o vínculo do publicador.', 'invalid_response');
      return {userId: checkedGroupId(result.userId), group: groupResult(result.group), personId: person};
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

    return Object.freeze({profile, groups, read, save, createGroup, readOwnCard, submitOwnReport, readOwnHours, saveOwnHours, submitOwnHours, listRevisions, reviewRevision,
      transferGroups, transferPublisher, publisherAccounts, listUsers, createUser, assignUser, createPublisherUser,
      login, loginPassword, logout, session, subscribeAuth});
  }

  return Object.freeze({create, CloudError, AuthRequiredError, AccessDeniedError, ConflictError});
});
