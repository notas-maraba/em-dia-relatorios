/* Em dia — cliente Supabase validado. O wrapper offline mantém a cópia privada do aparelho. */
(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EmDiaCloud = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const DEFAULT_REDIRECT = 'https://notas-maraba.github.io/em-dia-relatorios/';
  const ROLES = ['admin', 'superintendent', 'publisher'];
  const MAX_DIARY_MINUTES = 744 * 60;
  const MAX_NOTE_LENGTH = 1000;

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

  function privateDiaryError(error, writing = false) {
    const mapped = mappedError(error, writing);
    // SDK transport exceptions may retain a request or response containing a
    // private note. Keep only static messages and a closed set of safe codes.
    if (mapped instanceof AuthRequiredError) return new AuthRequiredError();
    if (mapped instanceof AccessDeniedError) return new AccessDeniedError();
    if (mapped instanceof ConflictError) return new ConflictError();
    const code = ['invalid_response', '22023'].includes(mapped.code) ? mapped.code : 'network_error';
    const message = code === 'invalid_response'
      ? 'A nuvem retornou dados inválidos. Recarregue seu cartão.'
      : writing ? 'Não foi possível confirmar o salvamento na nuvem. Recarregue os dados antes de tentar novamente.'
        : 'Não foi possível acessar a nuvem. Confira sua conexão e tente novamente.';
    return new CloudError(message, code);
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

  function checkedLaunchId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new CloudError('Escolha um lançamento válido antes de continuar.', 'invalid_launch');
    }
    return value.toLowerCase();
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
      if (row.group_id !== personalGroup(current) || row.person_id !== current.publisherId || row.month !== month ||
          !['publisher', 'regular', 'auxiliary'].includes(row.kind) || !stateObject(row.entries) ||
          typeof row.closed !== 'boolean' || !Number.isSafeInteger(row.total_minutes) || row.total_minutes < 0 ||
          row.total_minutes > MAX_DIARY_MINUTES || !(row.updated_at === null || typeof row.updated_at === 'string')) throw new Error('Invalid diary');
      const today = checkedDate(row.today), entries = Object.entries(row.entries), version = responseVersion(row.version);
      if (month > today.slice(0, 7) || row.closed !== (month < today.slice(0, 7)) || entries.length > 31 ||
          version === 0 && entries.length || entries.some(([date, minutes]) => checkedDate(date).slice(0, 7) !== month || date > today ||
            !Number.isSafeInteger(minutes) || minutes < 0 || minutes > MAX_DIARY_MINUTES) ||
          entries.reduce((total, [, minutes]) => total + minutes, 0) !== row.total_minutes) throw new Error('Invalid diary');
      return {groupId: row.group_id, personId: row.person_id, month, kind: row.kind,
        entries: Object.fromEntries(entries), version, totalMinutes: row.total_minutes, closed: row.closed,
        today, updatedAt: row.updated_at};
    } catch (_) { throw new CloudError('A nuvem retornou um diário inválido. Recarregue seu cartão.', 'invalid_response'); }
  }

  function ownHourLaunchesResult(row, current, month) {
    const diary = ownHoursResult(row, current, month);
    try {
      if (!Array.isArray(row.launches) || row.launches.length > 1000 || new TextEncoder().encode(JSON.stringify(row.launches)).length > 262144) {
        throw new Error('Invalid launches');
      }
      const ids = new Set(), daily = Object.create(null);
      const launches = row.launches.map(item => {
        if (!stateObject(item)) throw new Error('Invalid launch');
        const id = checkedLaunchId(item.id), date = checkedDate(item.date), minutes = item.minutes,
          note = Object.hasOwn(item, 'note') ? item.note : '';
        if (ids.has(id) || date.slice(0, 7) !== month || date > diary.today ||
            !Number.isSafeInteger(minutes) || minutes < 0 || minutes > MAX_DIARY_MINUTES ||
            typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) throw new Error('Invalid launch');
        ids.add(id);
        daily[date] = (daily[date] || 0) + minutes;
        if (daily[date] > MAX_DIARY_MINUTES) throw new Error('Invalid recorded sum');
        return {id, date, minutes, note};
      });
      const dates = Object.keys(daily);
      if (dates.length !== Object.keys(diary.entries).length ||
          dates.some(date => !Object.hasOwn(diary.entries, date) || diary.entries[date] !== daily[date])) {
        throw new Error('Invalid daily aggregate');
      }
      return {...diary, launches};
    } catch (_) { throw new CloudError('A nuvem retornou lançamentos inválidos. Recarregue seu diário.', 'invalid_response'); }
  }

  function responseInstant(value) {
    if (typeof value !== 'string' || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value) ||
        checkedDate(value.slice(0, 10)) !== value.slice(0, 10) || !Number.isSafeInteger(Date.parse(value))) throw new Error('Invalid clock');
    return Date.parse(value);
  }

  function ownTimerResult(row, current) {
    try {
      if (row.group_id !== personalGroup(current) || row.person_id !== current.publisherId ||
          !['idle', 'running', 'paused', 'stopped'].includes(row.status) ||
          !Number.isSafeInteger(row.accumulated_ms) || row.accumulated_ms < 0 ||
          !Number.isSafeInteger(row.elapsed_ms) || row.elapsed_ms < 0) throw new Error('Invalid timer');
      const serverMs = responseInstant(row.server_now), version = responseVersion(row.version);
      if (row.status === 'idle') {
        if (row.timer_id !== null || row.start_date !== null || row.started_at !== null || row.anchor_at !== null ||
            row.stopped_at !== null || row.accumulated_ms !== 0 || row.elapsed_ms !== 0) throw new Error('Invalid idle timer');
      } else {
        checkedLaunchId(row.timer_id); checkedDate(row.start_date);
        const startedMs = responseInstant(row.started_at);
        if (startedMs > serverMs || version === 0) throw new Error('Invalid start');
        if (row.status === 'running') {
          const anchorMs = responseInstant(row.anchor_at);
          if (row.stopped_at !== null || anchorMs < startedMs || anchorMs > serverMs || row.elapsed_ms < row.accumulated_ms ||
              Math.abs(row.elapsed_ms - row.accumulated_ms - (serverMs - anchorMs)) > 1) throw new Error('Invalid running clock');
        } else {
          if (row.anchor_at !== null || row.elapsed_ms !== row.accumulated_ms) throw new Error('Invalid fixed clock');
          if (row.status === 'paused' ? row.stopped_at !== null :
            responseInstant(row.stopped_at) < startedMs || responseInstant(row.stopped_at) > serverMs) throw new Error('Invalid stop');
        }
      }
      return {groupId: row.group_id, personId: row.person_id, timerId: row.timer_id === null ? null : checkedLaunchId(row.timer_id),
        status: row.status, version, startDate: row.start_date, startedAt: row.started_at, anchorAt: row.anchor_at,
        stoppedAt: row.stopped_at, accumulatedMs: row.accumulated_ms, elapsedMs: row.elapsed_ms, serverNow: row.server_now};
    } catch (_) { throw new CloudError('A nuvem retornou um cronômetro inválido. Recarregue seu cartão.', 'invalid_response'); }
  }

  function checkedServiceYear(value) {
    if (!Number.isInteger(value) || value < 1900 || value > 2198) throw new CloudError('Escolha um ano de serviço válido.', 'invalid_service_year');
    return value;
  }

  function serviceMonths(year) {
    return Array.from({length: 12}, (_, i) => i < 4 ? year + '-' + String(i + 9).padStart(2, '0') : (year + 1) + '-' + String(i - 3).padStart(2, '0'));
  }

  function ownAnnualResult(row, current, serviceYear) {
    try {
      const today = checkedDate(row.today), now = today.slice(0, 7), currentYear = Number(now.slice(0, 4)) - (Number(now.slice(5, 7)) < 9 ? 1 : 0),
        nullable = (value, max) => value === null || Number.isSafeInteger(value) && value >= 0 && value <= max;
      if (row.group_id !== personalGroup(current) || row.person_id !== current.publisherId || row.service_year !== serviceYear || serviceYear > currentYear ||
          !Number.isSafeInteger(row.target_minutes) || row.target_minutes < 1 || row.target_minutes > MAX_DIARY_MINUTES * 12 ||
          !Array.isArray(row.months) || row.months.length !== 12 || !(row.updated_at === null || typeof row.updated_at === 'string')) throw new Error('Invalid annual goal');
      if (row.updated_at !== null) responseInstant(row.updated_at);
      const version = responseVersion(row.version), expected = serviceMonths(serviceYear), months = Array.from(row.months).map((item, i) => {
        if (!stateObject(item) || item.month !== expected[i] || !['regular', 'auxiliary', 'publisher'].includes(item.kind) ||
            !['approved', 'diary', 'retroactive', 'missing', 'future', 'not_regular'].includes(item.source) ||
            !nullable(item.minutes, MAX_DIARY_MINUTES) || !nullable(item.studies, 9999) ||
            !nullable(item.retro_minutes, MAX_DIARY_MINUTES) || !nullable(item.retro_studies, 9999) ||
            (item.retro_minutes === null) !== (item.retro_studies === null) || typeof item.can_edit_retro !== 'boolean' ||
            (item.source === 'future') !== (item.month > now) ||
            item.can_edit_retro !== (item.month < now && ['missing', 'retroactive'].includes(item.source)) ||
            (['approved', 'diary', 'retroactive', 'missing'].includes(item.source) && item.kind !== 'regular') ||
            (['future', 'missing', 'not_regular'].includes(item.source) && (item.minutes !== null || item.studies !== null)) ||
            (item.source === 'diary' && (item.minutes === null || item.studies !== null)) ||
            (item.source === 'retroactive' && (item.minutes === null || item.studies === null || item.minutes !== item.retro_minutes || item.studies !== item.retro_studies))) throw new Error('Invalid annual month');
        return {month: item.month, kind: item.kind, source: item.source, minutes: item.minutes, studies: item.studies,
          retroMinutes: item.retro_minutes, retroStudies: item.retro_studies, canEditRetro: item.can_edit_retro};
      });
      return {groupId: row.group_id, personId: row.person_id, serviceYear, today, targetMinutes: row.target_minutes,
        version, updatedAt: row.updated_at, months};
    } catch (_) { throw new CloudError('A nuvem retornou um acompanhamento anual inválido. Recarregue seu cartão.', 'invalid_response'); }
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

  const personalGroup = current => current.personalGroupId ?? (current.role === 'publisher' ? current.defaultGroupId : null);
  const hasPersonalCard = current => !!current.publisherId && !!personalGroup(current);

  function ownCardResult(row, current) {
    const own = rowResult(row, personalGroup(current));
    if (row.person_id !== current.publisherId || typeof row.group_name !== 'string' || !row.group_name.trim() ||
        !Array.isArray(own.state.people) || own.state.people.length !== 1 || own.state.people[0]?.id !== current.publisherId ||
        own.state.people[0].notes !== '' || !stateObject(own.state.reports) || !stateObject(own.state.reminders) || Object.keys(own.state.reminders).length ||
        Object.values(own.state.reports).some(entries => !stateObject(entries) || Object.keys(entries).some(id => id !== current.publisherId) || Object.values(entries).some(report => report.notes !== '')) ||
        !Array.isArray(row.revisions)) throw new CloudError('A nuvem retornou um cartão inválido.', 'invalid_response');
    return {...own, groupId: row.group_id, personId: row.person_id,
      group: {id: row.group_id, name: row.group_name, createdAt: null}, revisions: row.revisions.map(ownRevision)};
  }

  function revisionListResult(row) {
    if (!stateObject(row) || !Array.isArray(row.revisions) || !Number.isSafeInteger(Number(row.total)) || Number(row.total) < row.revisions.length) throw new CloudError('A lista de alterações está inválida.', 'invalid_response');
    return {total: Number(row.total), revisions: row.revisions.map(item => {
      if (!stateObject(item) || typeof item.person_name !== 'string') throw new CloudError('A lista de alterações está inválida.', 'invalid_response');
      return {id: checkedGroupId(item.id), version: checkedVersion(Number(item.version), 1), personId: checkedPersonId(item.person_id),
        personName: item.person_name, month: checkedMonth(item.month), approvedReport: item.approved_report === null ? null : activityResult(item.approved_report),
        proposedReport: activityResult(item.proposed_report), submittedAt: item.submitted_at || null};
    })};
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
      const personalGroupId = row.personal_group_id == null ? (row.role === 'publisher' ? defaultGroupId : null) : checkedGroupId(row.personal_group_id);
      if ((publisherId === null) !== (personalGroupId === null) || row.role === 'publisher' && (!publisherId || personalGroupId !== defaultGroupId)) throw new AccessDeniedError();
      return {userId: current.user.id, role: row.role, isAdmin: row.role === 'admin', defaultGroupId, publisherId, personalGroupId};
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
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('read_em_dia_own_card');
        if (result.error) throw result.error;
        return ownCardResult(objectResult(result.data), current);
      } catch (error) { throw mappedError(error); }
    }

    async function submitOwnReport({month, report, expectedVersion} = {}) {
      const selectedMonth = checkedMonth(month), input = activityInput(report), version = checkedVersion(expectedVersion);
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('submit_em_dia_own_report', {p_month: selectedMonth, p_report: input, p_expected_version: version});
        if (result.error) throw result.error;
        const row = objectResult(result.data);
        if (!['accepted', 'pending'].includes(row.status) || row.group_id !== personalGroup(current) || row.person_id !== current.publisherId || row.month !== selectedMonth || typeof row.unchanged !== 'boolean') {
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
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('read_em_dia_own_hour_launches', {p_month: selectedMonth});
        if (result.error) throw result.error;
        return ownHourLaunchesResult(objectResult(result.data), current, selectedMonth);
      } catch (error) { throw privateDiaryError(error); }
    }

    async function saveOwnHours({date, minutes, expectedVersion} = {}) {
      const selectedDate = checkedDate(date), version = checkedVersion(expectedVersion);
      if (!(minutes === null || Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= MAX_DIARY_MINUTES)) {
        throw new CloudError('Informe um total de 0 a 744 horas para esta data.', 'invalid_minutes');
      }
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
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

    async function saveOwnHoursLaunch({id, date, minutes, note = null, expectedVersion} = {}) {
      const launchId = checkedLaunchId(id), selectedDate = checkedDate(date), version = checkedVersion(expectedVersion);
      if (!(minutes === null || Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= MAX_DIARY_MINUTES)) {
        throw new CloudError('Informe de 0 a 744 horas para este lançamento.', 'invalid_minutes');
      }
      if (!(note === null || typeof note === 'string' && note.length <= MAX_NOTE_LENGTH)) {
        throw new CloudError('Informe uma observação com até 1000 caracteres ou deixe em branco.', 'invalid_note');
      }
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('save_em_dia_own_hour_launch_note', {
          p_id: launchId, p_date: selectedDate, p_minutes: minutes, p_note: note, p_expected_version: version
        });
        if (result.error) throw result.error;
        const row = objectResult(result.data), saved = ownHourLaunchesResult(row, current, selectedDate.slice(0, 7));
        const launch = saved.launches.find(item => item.id === launchId);
        if (!['regular', 'auxiliary'].includes(saved.kind) || typeof row.unchanged !== 'boolean' || selectedDate > saved.today ||
            (minutes === null ? !!launch : !launch || launch.date !== selectedDate || launch.minutes !== minutes || note !== null && launch.note !== note) ||
            (row.unchanged ? saved.version < version : saved.version !== version + 1)) {
          throw new CloudError('Não foi possível confirmar o lançamento. Recarregue o diário antes de tentar novamente.', 'invalid_response');
        }
        return {...saved, unchanged: row.unchanged};
      } catch (error) { throw privateDiaryError(error, true); }
    }

    async function submitOwnHours({month, participated, studies, expectedHoursVersion, expectedReportVersion} = {}) {
      const selectedMonth = checkedMonth(month), hoursVersion = checkedVersion(expectedHoursVersion, 1), reportVersion = checkedVersion(expectedReportVersion);
      if (!(participated === null || typeof participated === 'boolean') ||
          !(studies === null || Number.isSafeInteger(studies) && studies >= 0 && studies <= 9999)) {
        throw new CloudError('Confira a participação e os estudos informados.', 'invalid_report');
      }
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('submit_em_dia_own_hours', {p_month: selectedMonth, p_participated: participated,
          p_studies: studies, p_expected_hours_version: hoursVersion, p_expected_report_version: reportVersion});
        if (result.error) throw result.error;
        const row = objectResult(result.data), savedVersion = responseVersion(row.version), savedHoursVersion = responseVersion(row.hours_version, 1);
        if (!['accepted', 'pending'].includes(row.status) || row.group_id !== personalGroup(current) || row.person_id !== current.publisherId ||
            row.month !== selectedMonth || typeof row.unchanged !== 'boolean' || savedHoursVersion !== hoursVersion ||
            !Number.isSafeInteger(row.total_minutes) || row.total_minutes < 0 || row.total_minutes > MAX_DIARY_MINUTES ||
            (savedVersion === 0 && !(row.status === 'accepted' && row.unchanged)) ||
            (!row.unchanged && savedVersion !== reportVersion + 1)) {
          throw new CloudError('Não foi possível confirmar o envio do mês. Recarregue seu cartão antes de tentar novamente.', 'invalid_response');
        }
        return {status: row.status, version: savedVersion, groupId: row.group_id, personId: row.person_id, month: row.month,
          revision: responseVersion(row.revision, 1), unchanged: row.unchanged, hoursVersion: savedHoursVersion, totalMinutes: row.total_minutes};
      } catch (error) { throw mappedError(error, true); }
    }

    async function readOwnTimer() {
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('read_em_dia_own_timer');
        if (result.error) throw result.error;
        return ownTimerResult(objectResult(result.data), current);
      } catch (error) { throw privateDiaryError(error); }
    }

    async function readOwnAnnual(serviceYear) {
      const year = checkedServiceYear(serviceYear);
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('read_em_dia_own_annual', {p_service_year: year});
        if (result.error) throw result.error;
        return ownAnnualResult(objectResult(result.data), current, year);
      } catch (error) { throw privateDiaryError(error); }
    }

    async function saveOwnAnnualGoal({serviceYear, targetMinutes, expectedVersion} = {}) {
      const year = checkedServiceYear(serviceYear), version = checkedVersion(expectedVersion);
      if (!Number.isSafeInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > MAX_DIARY_MINUTES * 12) throw new CloudError('Informe uma meta anual válida.', 'invalid_target');
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('save_em_dia_own_annual_goal', {p_service_year: year, p_target_minutes: targetMinutes, p_expected_version: version});
        if (result.error) throw result.error;
        const row = objectResult(result.data), saved = ownAnnualResult(row, current, year);
        if (typeof row.unchanged !== 'boolean' || saved.targetMinutes !== targetMinutes ||
            (row.unchanged ? saved.version < version : saved.version !== version + 1)) throw new CloudError('Não foi possível confirmar a meta anual.', 'invalid_response');
        return {...saved, unchanged: row.unchanged};
      } catch (error) { throw privateDiaryError(error, true); }
    }

    async function saveOwnAnnualRetro({serviceYear, month, minutes, studies, expectedVersion} = {}) {
      const year = checkedServiceYear(serviceYear), selectedMonth = checkedMonth(month), version = checkedVersion(expectedVersion);
      if (!serviceMonths(year).includes(selectedMonth)) throw new CloudError('Escolha um mês deste ano de serviço.', 'invalid_month');
      if (!(minutes === null && studies === null || Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= MAX_DIARY_MINUTES &&
          Number.isSafeInteger(studies) && studies >= 0 && studies <= 9999)) throw new CloudError('Informe as horas e os estudos completos do mês anterior.', 'invalid_retro');
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('save_em_dia_own_annual_retro', {p_service_year: year, p_month: selectedMonth,
          p_minutes: minutes, p_studies: studies, p_expected_version: version});
        if (result.error) throw result.error;
        const row = objectResult(result.data), saved = ownAnnualResult(row, current, year), selected = saved.months.find(item => item.month === selectedMonth);
        if (typeof row.unchanged !== 'boolean' || !selected.canEditRetro || selected.retroMinutes !== minutes || selected.retroStudies !== studies ||
            (row.unchanged ? saved.version < version : saved.version !== version + 1)) throw new CloudError('Não foi possível confirmar o mês anterior.', 'invalid_response');
        return {...saved, unchanged: row.unchanged};
      } catch (error) { throw privateDiaryError(error, true); }
    }

    async function changeOwnTimer({action, timerId, expectedVersion} = {}) {
      const statuses = {start: 'running', pause: 'paused', resume: 'running', stop: 'stopped', discard: 'idle'};
      if (typeof action !== 'string' || !Object.hasOwn(statuses, action)) throw new CloudError('Escolha uma ação válida para o cronômetro.', 'invalid_timer_action');
      const id = checkedLaunchId(timerId), version = checkedVersion(expectedVersion);
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('change_em_dia_own_timer', {p_action: action, p_timer_id: id, p_expected_version: version});
        if (result.error) throw result.error;
        const row = objectResult(result.data), saved = ownTimerResult(row, current);
        if (typeof row.unchanged !== 'boolean' || saved.status !== statuses[action] ||
            (action === 'discard' ? saved.timerId !== null : saved.timerId !== id) ||
            (row.unchanged ? saved.version < version : saved.version !== version + 1)) {
          throw new CloudError('Não foi possível confirmar o cronômetro. Recarregue seu cartão.', 'invalid_response');
        }
        return {...saved, unchanged: row.unchanged};
      } catch (error) { throw privateDiaryError(error, true); }
    }

    async function postOwnTimer({timerId, expectedTimerVersion, launchId, date, minutes, note = '', expectedHoursVersion} = {}) {
      const id = checkedLaunchId(timerId), itemId = checkedLaunchId(launchId), selectedDate = checkedDate(date),
        timerVersion = checkedVersion(expectedTimerVersion, 1), hoursVersion = checkedVersion(expectedHoursVersion), launchNote = note === null ? '' : note;
      if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > MAX_DIARY_MINUTES) throw new CloudError('Informe de 0 a 744 horas para este lançamento.', 'invalid_minutes');
      if (typeof launchNote !== 'string' || launchNote.length > MAX_NOTE_LENGTH) throw new CloudError('Informe uma observação com até 1000 caracteres ou deixe em branco.', 'invalid_note');
      try {
        const current = await profile();
        if (!hasPersonalCard(current)) throw new AccessDeniedError();
        const result = await client.rpc('post_em_dia_own_timer', {p_timer_id: id, p_expected_timer_version: timerVersion,
          p_launch_id: itemId, p_date: selectedDate, p_minutes: minutes, p_note: launchNote, p_expected_hours_version: hoursVersion});
        if (result.error) throw result.error;
        const row = objectResult(result.data), timer = ownTimerResult(row.timer, current),
          diary = ownHourLaunchesResult(row.diary, current, selectedDate.slice(0, 7)), receipt = row.receipt,
          launch = diary.launches.find(item => item.id === itemId);
        let postedMs;
        try { postedMs = responseInstant(receipt?.posted_at); }
        catch (_) { throw new CloudError('A nuvem retornou um recibo de cronômetro inválido.', 'invalid_response'); }
        if (typeof row.unchanged !== 'boolean' || typeof row.launch_id !== 'string' || row.launch_id.toLowerCase() !== itemId || !stateObject(receipt) ||
            typeof receipt.timer_id !== 'string' || receipt.timer_id.toLowerCase() !== id ||
            typeof receipt.launch_id !== 'string' || receipt.launch_id.toLowerCase() !== itemId || receipt.date !== selectedDate ||
            receipt.minutes !== minutes || receipt.note !== launchNote || postedMs > responseInstant(timer.serverNow) ||
            (row.unchanged ? timer.version <= timerVersion || diary.version <= hoursVersion :
              timer.status !== 'idle' || timer.version !== timerVersion + 1 || diary.version !== hoursVersion + 1 ||
              !launch || launch.date !== selectedDate || launch.minutes !== minutes || launch.note !== launchNote)) {
          throw new CloudError('Não foi possível confirmar o lançamento do cronômetro. Recarregue seu cartão.', 'invalid_response');
        }
        return {timer, diary, launchId: itemId, unchanged: row.unchanged, receipt: {timerId: id, launchId: itemId,
          date: selectedDate, minutes, note: launchNote, postedAt: receipt.posted_at}};
      } catch (error) { throw privateDiaryError(error, true); }
    }

    async function listRevisions(groupId) {
      const id = checkedGroupId(groupId);
      try {
        await allowedGroup(id);
        const result = await client.rpc('list_em_dia_report_revisions', {p_group_id: id});
        if (result.error) throw result.error;
        return revisionListResult(objectResult(result.data));
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

    function personalBindingResult(row) {
      if (!stateObject(row) || (row.group_id == null) !== (row.person_id == null)) throw new CloudError('Vínculo pessoal inválido.', 'invalid_response');
      return {userId:checkedGroupId(row.user_id),groupId:row.group_id==null?null:checkedGroupId(row.group_id),personId:row.person_id==null?null:checkedPersonId(row.person_id)};
    }
    async function listPersonalBindings() {
      try { const current=await profile();if(!current.isAdmin)throw new AccessDeniedError();
        const result=await client.rpc('list_em_dia_personal_bindings');if(result.error)throw result.error;
        if(!Array.isArray(result.data)||result.data.length>5000)throw new CloudError('Lista de vínculos inválida.','invalid_response');
        const rows=result.data.map(personalBindingResult);if(rows.some(x=>!x.groupId)||new Set(rows.map(x=>x.userId)).size!==rows.length)throw new CloudError('Lista de vínculos inválida.','invalid_response');return rows;
      } catch(error){throw mappedError(error);}
    }
    async function bindPersonalCard({userId,groupId,personId,expectedGroupId,expectedPersonId}={}) {
      if((groupId===null)!==(personId===null)||(expectedGroupId===null)!==(expectedPersonId===null))throw new CloudError('Confira o vínculo pessoal.','invalid_input');
      const actor=checkedGroupId(userId),group=groupId===null?null:checkedGroupId(groupId),person=personId===null?null:checkedPersonId(personId),expectedGroup=expectedGroupId===null?null:checkedGroupId(expectedGroupId),expectedPerson=expectedPersonId===null?null:checkedPersonId(expectedPersonId);
      try {const current=await profile();if(!current.isAdmin)throw new AccessDeniedError();
        const result=await client.rpc('bind_em_dia_personal_card',{p_user_id:actor,p_group_id:group,p_person_id:person,p_expected_group_id:expectedGroup,p_expected_person_id:expectedPerson,p_expected_actor_id:current.userId});if(result.error)throw result.error;
        const row=personalBindingResult(objectResult(result.data));if(row.userId!==actor||row.groupId!==group||row.personId!==person)throw new CloudError('Não foi possível confirmar o vínculo pessoal.','invalid_response');return row;
      } catch(error){throw mappedError(error,true);}
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

    async function logout({local = false} = {}) {
      try {
        const result = await client.auth.signOut(local ? {scope: 'local'} : undefined);
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

    async function applyOfflineOperation({operationId, kind, payload} = {}) {
      const id = checkedLaunchId(operationId), kinds = ['group_save','diary_launch','report_manual','report_diary','annual_goal','annual_retro','timer_change','timer_post'];
      if (!kinds.includes(kind) || !stateObject(payload) || typeof payload.userId !== 'string') throw new CloudError('A operação offline é inválida.', 'invalid_operation');
      const input = copy(payload);
      try {
        const current = await profile();
        if (current.userId !== input.userId || (kind === 'group_save' ? !['admin','superintendent'].includes(current.role) :
          !hasPersonalCard(current) || input.groupId !== personalGroup(current) || input.personId !== current.publisherId)) throw new AccessDeniedError();
        const result = await client.rpc('apply_em_dia_offline_operation', {p_operation_id: id, p_kind: kind, p_payload: input});
        if (result.error) throw result.error;
        const row = objectResult(result.data), raw = row.confirmation;
        if (row.operation_id !== id || row.kind !== kind || typeof row.replayed !== 'boolean' || !stateObject(raw)) throw new CloudError('Confirmação offline inválida.', 'invalid_response');
        const confirmation = {};
        for (const [wire, key] of [['revision','revision'],['version','version'],['hours_version','hoursVersion'],['timer_version','timerVersion']]) {
          if (Object.hasOwn(raw, wire)) confirmation[key] = responseVersion(raw[wire], wire === 'revision' ? 1 : 0);
        }
        if (Object.hasOwn(raw, 'status')) {
          if (!['accepted','pending'].includes(raw.status)) throw new CloudError('Confirmação offline inválida.', 'invalid_response');
          confirmation.status = raw.status;
        }
        const required = {group_save:['revision'],diary_launch:['version'],report_manual:['version','revision','status'],report_diary:['version','revision','hoursVersion','status'],annual_goal:['version'],annual_retro:['version'],timer_change:['timerVersion'],timer_post:['timerVersion','hoursVersion']}[kind];
        if (required.some(key => !Object.hasOwn(confirmation, key))) throw new CloudError('Confirmação offline incompleta.', 'invalid_response');
        return {operationId: id, kind, replayed: row.replayed, confirmation};
      } catch (error) { throw privateDiaryError(error, true); }
    }

    async function offlineSnapshot() {
      try {
        const current = await profile(), result = await client.rpc('read_em_dia_offline_snapshot');
        if (result.error) throw result.error;
        const row = objectResult(result.data), p = row.profile;
        if (!stateObject(p) || p.user_id !== current.userId || p.role !== current.role || p.group_id !== current.defaultGroupId ||
          (p.publisher_id ?? null) !== current.publisherId || (p.personal_group_id ?? (p.role === 'publisher' ? p.group_id : null)) !== personalGroup(current) || !Array.isArray(row.groups) || !Array.isArray(row.states) ||
          !Array.isArray(row.diaries) || !Array.isArray(row.annuals) || !Array.isArray(row.revisions)) throw new CloudError('Cópia offline inválida.', 'invalid_response');
        const groups = row.groups.map(groupResult), ids = new Set(groups.map(group => group.id));
        if (ids.size !== groups.length || groups.length > 5000 || row.diaries.length > 5000 || row.annuals.length > 300) throw new CloudError('Cópia offline inválida.', 'invalid_response');
        const publisher = current.role === 'publisher', personal = hasPersonalCard(current);
        if (publisher ? row.states.length || row.revisions.length || groups.some(group => group.id !== current.defaultGroupId) :
          !personal && (row.own_card != null || row.diaries.length || row.annuals.length || row.timer != null)) throw new CloudError('Cópia fora do perfil.', 'invalid_response');
        if (!current.isAdmin && groups.some(group => group.id !== current.defaultGroupId)) throw new AccessDeniedError();
        const states = row.states.map(item => { if (!ids.has(item.group_id)) throw new AccessDeniedError(); return {groupId:item.group_id,bundle:item.state===null?null:rowResult(item,item.group_id)}; });
        if (new Set(states.map(item => item.groupId)).size !== states.length) throw new CloudError('Cópia duplicada.', 'invalid_response');
        // This RPC is a complete authorized snapshot, so a listed group with no
        // state row is a known empty group. Cache misses outside it stay errors.
        if (!publisher) for (const group of groups) if (!states.some(item=>item.groupId===group.id)) states.push({groupId:group.id,bundle:null});
        const diaries = row.diaries.map(item => ({...ownHourLaunchesResult(item,current,checkedMonth(item.month)),canUse:item.can_use !== false}));
        const annuals = row.annuals.map(item => ownAnnualResult(item,current,checkedServiceYear(item.service_year)));
        if (new Set(diaries.map(item=>item.month)).size!==diaries.length || new Set(annuals.map(item=>item.serviceYear)).size!==annuals.length) throw new CloudError('Cópia duplicada.', 'invalid_response');
        const revisions = row.revisions.map(item => {if (!ids.has(item.group_id)) throw new AccessDeniedError();return {groupId:item.group_id,items:revisionListResult(item.items)};});
        if (new Set(revisions.map(item=>item.groupId)).size!==revisions.length) throw new CloudError('Cópia duplicada.', 'invalid_response');
        return {profile:{...current},groups,states,diaries,annuals,revisions,
          ...(personal?{ownCard:ownCardResult(objectResult(row.own_card),current),timer:ownTimerResult(objectResult(row.timer),current)}:{})};
      } catch (error) { throw privateDiaryError(error); }
    }

    return Object.freeze({profile, groups, read, save, createGroup, readOwnCard, submitOwnReport, readOwnHours, saveOwnHours, saveOwnHoursLaunch, submitOwnHours, readOwnAnnual, saveOwnAnnualGoal, saveOwnAnnualRetro, readOwnTimer, changeOwnTimer, postOwnTimer, listRevisions, reviewRevision, applyOfflineOperation, offlineSnapshot,
      transferGroups, transferPublisher, publisherAccounts, listUsers, createUser, assignUser, createPublisherUser, listPersonalBindings, bindPersonalCard,
      login, loginPassword, logout, session, subscribeAuth});
  }

  return Object.freeze({create, CloudError, AuthRequiredError, AccessDeniedError, ConflictError});
});
