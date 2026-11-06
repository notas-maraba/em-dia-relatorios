-- Durable offline receipts and authorized snapshots; existing data stay intact.
-- Receipts contain hashes and version metadata, never a group snapshot or note.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,
  em_dia_private.report_revisions,em_dia_private.daily_hours,
  em_dia_private.legacy_group_links,em_dia_private.service_timers,
  em_dia_private.annual_progress in share mode nowait;
create temporary table em_dia_offline_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_offline_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'members',to_jsonb(m) from public.em_dia_members m
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t
union all select 'annual',to_jsonb(a) from em_dia_private.annual_progress a;

create table em_dia_private.offline_receipts (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  kind text not null,
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  person_id text,
  payload_hash bytea not null check(octet_length(payload_hash)=32),
  confirmation jsonb not null check(jsonb_typeof(confirmation)='object' and octet_length(confirmation::text)<=2048),
  effective_at timestamptz,
  timer_version bigint,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id,operation_id)
);
create index em_dia_offline_timer_order on em_dia_private.offline_receipts(group_id,person_id,timer_version)
  where effective_at is not null;
alter table em_dia_private.offline_receipts enable row level security;
alter table em_dia_private.offline_receipts force row level security;
revoke all on em_dia_private.offline_receipts from public,anon,authenticated,service_role,em_dia_writer,em_dia_workflow;
grant select,insert on em_dia_private.offline_receipts to em_dia_workflow;
create policy em_dia_offline_receipt_select on em_dia_private.offline_receipts for select to em_dia_workflow using(true);
create policy em_dia_offline_receipt_insert on em_dia_private.offline_receipts for insert to em_dia_workflow with check(true);

create function em_dia_private.offline_integer(p_value jsonb,p_min bigint,p_max bigint,p_nullable boolean default false) returns bigint
language plpgsql immutable security invoker set search_path='' as $$
declare v_value numeric;
begin
  if p_nullable and p_value='null'::jsonb then return null; end if;
  if p_value is null or jsonb_typeof(p_value)<>'number' then raise exception using errcode='22023',message='Invalid offline integer.'; end if;
  v_value:=(p_value#>>'{}')::numeric;
  if trunc(v_value)<>v_value or v_value<p_min or v_value>p_max then raise exception using errcode='22023',message='Invalid offline integer range.'; end if;
  return v_value::bigint;
end;
$$;
create function em_dia_private.offline_uuid(p_value jsonb) returns uuid
language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_value is null or jsonb_typeof(p_value)<>'string' or p_value#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='Invalid offline identifier.';
  end if;
  return (p_value#>>'{}')::uuid;
end;
$$;

-- Client event time and elapsed duration are independent of reconnect time.
-- This helper is reachable only through the authenticated receipt gateway.
create function em_dia_private.change_own_timer_offline(p_action text,p_timer_id uuid,p_expected_version bigint,p_at text,p_elapsed bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_context jsonb;v_hours jsonb;v_row em_dia_private.service_timers;v_exists boolean;v_version bigint;
  v_now timestamptz;v_at timestamptz;v_effective timestamptz;v_last timestamptz;v_date text;
begin
  v_context:=em_dia_private.own_timer_context();
  perform 1 from public.em_dia_states s where s.group_id=(v_context->>'group_id')::uuid for update;
  select * into v_row from em_dia_private.service_timers t where t.group_id=(v_context->>'group_id')::uuid
    and t.person_id=v_context->>'person_id' for update;
  v_exists:=found;v_version:=coalesce(v_row.version,0);v_now:=clock_timestamp();
  if p_action is null or p_action not in ('start','pause','resume','stop','discard') or p_timer_id is null
    or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991
    or p_elapsed is null or p_elapsed<0 or p_elapsed>9007199254740991 or p_at is null
    or p_at !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-][0-2][0-9]:[0-5][0-9])$' then
    raise exception using errcode='22023',message='Invalid offline timer event.';
  end if;
  begin v_at:=p_at::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception using errcode='22023',message='Invalid offline timer timestamp.'; end;
  if not isfinite(v_at) or v_at>v_now+interval '5 minutes' then raise exception using errcode='22023',message='The timer timestamp is in the future.'; end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='The timer changed. Resolve the offline conflict.'; end if;
  select max(r.effective_at) into v_last from em_dia_private.offline_receipts r
    where r.group_id=(v_context->>'group_id')::uuid and r.person_id=v_context->>'person_id' and r.timer_version=v_version;
  v_last:=greatest(v_last,v_row.started_at,v_row.anchor_at,v_row.stopped_at);
  v_effective:=least(v_at,v_now);
  if v_at<v_last or v_effective<v_last then raise exception using errcode='22023',message='Timer events must remain chronological.'; end if;
  if p_action='start' then
    if coalesce(v_row.status,'idle')<>'idle' or p_elapsed<>0 or p_timer_id=v_row.last_timer_id
      or p_timer_id::text=v_row.last_posted_receipt->>'timer_id' then
      raise exception using errcode='22023',message='Finish the previous timer and choose a new identifier.';
    end if;
    v_date:=to_char(v_effective at time zone 'America/Sao_Paulo','YYYY-MM-DD');
    v_hours:=em_dia_private.own_hours_context(left(v_date,7));
    if v_hours->>'kind' not in ('regular','auxiliary') then raise exception using errcode='22023',message='The timer requires a pioneer period.'; end if;
    v_row.status:='running';v_row.timer_id:=p_timer_id;v_row.start_date:=v_date::date;
    v_row.started_at:=v_effective;v_row.anchor_at:=v_effective;v_row.stopped_at:=null;v_row.accumulated_ms:=0;
  else
    if v_row.timer_id is distinct from p_timer_id then raise exception using errcode='40001',message='The timer cycle changed. Resolve the offline conflict.'; end if;
    if p_action='pause' and v_row.status='running' and p_elapsed>=v_row.accumulated_ms then
      v_row.status:='paused';v_row.accumulated_ms:=p_elapsed;v_row.anchor_at:=null;
    elsif p_action='resume' and v_row.status='paused' and p_elapsed=v_row.accumulated_ms then
      v_row.status:='running';v_row.anchor_at:=v_effective;
    elsif p_action='stop' and v_row.status in ('running','paused') and p_elapsed>=v_row.accumulated_ms
      and (v_row.status='running' or p_elapsed=v_row.accumulated_ms) then
      v_row.status:='stopped';v_row.accumulated_ms:=p_elapsed;v_row.anchor_at:=null;v_row.stopped_at:=v_effective;
    elsif p_action='discard' and v_row.status='stopped' and p_elapsed=0 then
      v_row.status:='idle';v_row.timer_id:=null;v_row.start_date:=null;v_row.started_at:=null;v_row.anchor_at:=null;v_row.stopped_at:=null;v_row.accumulated_ms:=0;
    else raise exception using errcode='22023',message='Invalid offline timer transition or duration.'; end if;
  end if;
  if v_exists then
    update em_dia_private.service_timers t set version=t.version+1,status=v_row.status,timer_id=v_row.timer_id,start_date=v_row.start_date,
      started_at=v_row.started_at,anchor_at=v_row.anchor_at,stopped_at=v_row.stopped_at,accumulated_ms=v_row.accumulated_ms,
      last_action='offline_'||p_action,last_timer_id=p_timer_id,last_expected_version=p_expected_version,updated_at=v_now
      where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' returning * into v_row;
  else
    insert into em_dia_private.service_timers(group_id,person_id,version,status,timer_id,start_date,started_at,anchor_at,stopped_at,
      accumulated_ms,last_action,last_timer_id,last_expected_version,updated_at)
      values((v_context->>'group_id')::uuid,v_context->>'person_id',1,v_row.status,v_row.timer_id,v_row.start_date,v_row.started_at,
        v_row.anchor_at,v_row.stopped_at,v_row.accumulated_ms,'offline_'||p_action,p_timer_id,p_expected_version,v_now) returning * into v_row;
  end if;
  return em_dia_private.timer_bundle(v_context,v_row,v_now)||jsonb_build_object('_effective_at',v_effective);
end;
$$;

create function em_dia_private.apply_offline_operation(p_operation_id uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=em_dia_private.current_user_id();v_group uuid;v_person text;v_role text;v_binding jsonb;
  v_required text[];v_allowed text[];v_hash bytea;v_saved em_dia_private.offline_receipts;
  v_result jsonb;v_confirmation jsonb;v_state public.em_dia_states;v_effective timestamptz;v_timer_version bigint;
  v_note text;v_version bigint;v_id uuid;v_at text;v_timer em_dia_private.service_timers;
begin
  if v_actor is null then raise exception using errcode='42501',message='Authenticated access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_actor]);
  if p_operation_id is null or p_kind is null or p_kind not in ('group_save','diary_launch','report_manual','report_diary','annual_goal','annual_retro','timer_change','timer_post')
    or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>12600000 then
    raise exception using errcode='22023',message='Invalid offline operation.';
  end if;
  if em_dia_private.offline_uuid(p_payload->'userId')<>v_actor then
    raise exception using errcode='42501',message='The queued operation belongs to another account.';
  end if;
  v_group:=em_dia_private.offline_uuid(p_payload->'groupId');
  v_role:=em_dia_private.access_role();
  if p_kind='group_save' then
    if v_role not in ('admin','superintendent') or v_role is null or not em_dia_private.can_access_group(v_group)
      or not exists(select 1 from public.em_dia_groups g where g.id=v_group)
      or p_payload->'personId' is distinct from 'null'::jsonb then
      raise exception using errcode='42501',message='Current group management access required.';
    end if;
    v_required:=array['state','expectedRevision'];
  else
    v_binding:=em_dia_private.own_timer_context();v_person:=p_payload->>'personId';
    if v_group<>(v_binding->>'group_id')::uuid or jsonb_typeof(p_payload->'personId') is distinct from 'string'
      or v_person is distinct from v_binding->>'person_id' then
      raise exception using errcode='42501',message='The publisher binding changed. Resolve the offline queue.';
    end if;
    v_required:=case p_kind
      when 'diary_launch' then array['id','date','minutes','expectedVersion']
      when 'report_manual' then array['month','report','expectedVersion']
      when 'report_diary' then array['month','participated','studies','expectedHoursVersion','expectedReportVersion']
      when 'annual_goal' then array['serviceYear','targetMinutes','expectedVersion']
      when 'annual_retro' then array['serviceYear','month','minutes','studies','expectedVersion']
      when 'timer_change' then array['action','timerId','expectedVersion','at','elapsedMs']
      when 'timer_post' then array['timerId','expectedTimerVersion','launchId','date','minutes','expectedHoursVersion'] end;
  end if;
  v_required:=v_required||array['userId','groupId','personId'];v_allowed:=v_required;
  if p_kind in ('diary_launch','timer_post') then v_allowed:=v_allowed||array['note']; end if;
  if not(p_payload ?& v_required) or exists(select 1 from jsonb_object_keys(p_payload) k where not(k=any(v_allowed))) then
    raise exception using errcode='22023',message='Unexpected or missing offline operation fields.';
  end if;
  -- The account lock prevents reassignment while checking scope. The group
  -- lock serializes its state-dependent routines and receipt acknowledgement.
  perform 1 from public.em_dia_states s where s.group_id=v_group for update;
  if p_kind in ('annual_goal','annual_retro') and not exists(
    select 1 from public.em_dia_states s cross join lateral jsonb_array_elements(s.state->'people') p
    cross join lateral jsonb_array_elements(p->'roles') r where s.group_id=v_group and p->>'id'=v_person and r->>'kind'='regular') then
    raise exception using errcode='42501',message='Current access to regular pioneer history required.';
  end if;
  v_hash:=sha256(convert_to(jsonb_build_object('kind',p_kind,'payload',p_payload)::text,'UTF8'));
  select * into v_saved from em_dia_private.offline_receipts r where r.actor_id=v_actor and r.operation_id=p_operation_id;
  if found then
    if v_saved.kind<>p_kind or v_saved.group_id<>v_group or v_saved.person_id is distinct from v_person or v_saved.payload_hash<>v_hash then
      raise exception using errcode='22023',message='An offline identifier cannot be reused with different data.';
    end if;
    return jsonb_build_object('operation_id',p_operation_id,'kind',p_kind,'replayed',true,'confirmation',v_saved.confirmation);
  end if;
  if p_payload ? 'note' and jsonb_typeof(p_payload->'note') not in ('string','null') then
    raise exception using errcode='22023',message='An observation must be text or null.';
  end if;
  v_note:=p_payload->>'note';
  case p_kind
    when 'group_save' then
      v_version:=em_dia_private.offline_integer(p_payload->'expectedRevision',0,9007199254740990);
      v_state:=em_dia_private.save_group_state(v_group,p_payload->'state',v_version);
      v_confirmation:=jsonb_build_object('revision',v_state.revision);
    when 'diary_launch' then
      v_result:=em_dia_private.save_own_hour_launch_note(em_dia_private.offline_uuid(p_payload->'id'),p_payload->>'date',
        em_dia_private.offline_integer(p_payload->'minutes',0,44640,true)::integer,v_note,
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version');
    when 'report_manual' then
      v_result:=em_dia_private.submit_own_report(p_payload->>'month',p_payload->'report',
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version','revision',v_result->'revision','status',v_result->'status');
    when 'report_diary' then
      if jsonb_typeof(p_payload->'participated') not in ('boolean','null') then raise exception using errcode='22023',message='Invalid participation value.'; end if;
      v_result:=em_dia_private.submit_own_hours(p_payload->>'month',(p_payload->>'participated')::boolean,
        em_dia_private.offline_integer(p_payload->'studies',0,9999,true)::integer,
        em_dia_private.offline_integer(p_payload->'expectedHoursVersion',0,9007199254740990),
        em_dia_private.offline_integer(p_payload->'expectedReportVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version','revision',v_result->'revision','status',v_result->'status','hours_version',v_result->'hours_version');
    when 'annual_goal' then
      v_result:=em_dia_private.save_own_annual_goal(em_dia_private.offline_integer(p_payload->'serviceYear',1900,2198)::integer,
        em_dia_private.offline_integer(p_payload->'targetMinutes',1,535680)::integer,
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version');
    when 'annual_retro' then
      v_result:=em_dia_private.save_own_annual_retro(em_dia_private.offline_integer(p_payload->'serviceYear',1900,2198)::integer,
        p_payload->>'month',em_dia_private.offline_integer(p_payload->'minutes',0,44640,true)::integer,
        em_dia_private.offline_integer(p_payload->'studies',0,9999,true)::integer,
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version');
    when 'timer_change' then
      if jsonb_typeof(p_payload->'at')<>'string' or jsonb_typeof(p_payload->'action')<>'string' then raise exception using errcode='22023',message='Invalid timer event text.'; end if;
      v_result:=em_dia_private.change_own_timer_offline(p_payload->>'action',em_dia_private.offline_uuid(p_payload->'timerId'),
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990),p_payload->>'at',
        em_dia_private.offline_integer(p_payload->'elapsedMs',0,9007199254740991));
      v_effective:=(v_result->>'_effective_at')::timestamptz;v_timer_version:=(v_result->>'version')::bigint;
      v_confirmation:=jsonb_build_object('timer_version',v_result->'version');
    when 'timer_post' then
      select * into v_timer from em_dia_private.service_timers t where t.group_id=v_group and t.person_id=v_person for update;
      v_effective:=v_timer.stopped_at;
      v_result:=em_dia_private.post_own_timer(em_dia_private.offline_uuid(p_payload->'timerId'),
        em_dia_private.offline_integer(p_payload->'expectedTimerVersion',1,9007199254740990),
        em_dia_private.offline_uuid(p_payload->'launchId'),p_payload->>'date',
        em_dia_private.offline_integer(p_payload->'minutes',0,44640)::integer,coalesce(v_note,''),
        em_dia_private.offline_integer(p_payload->'expectedHoursVersion',0,9007199254740990));
      v_timer_version:=(v_result#>>'{timer,version}')::bigint;
      v_confirmation:=jsonb_build_object('timer_version',v_result#>'{timer,version}','hours_version',v_result#>'{diary,version}');
  end case;
  insert into em_dia_private.offline_receipts(actor_id,operation_id,kind,group_id,person_id,payload_hash,confirmation,effective_at,timer_version)
    values(v_actor,p_operation_id,p_kind,v_group,v_person,v_hash,v_confirmation,v_effective,v_timer_version);
  return jsonb_build_object('operation_id',p_operation_id,'kind',p_kind,'replayed',false,'confirmation',v_confirmation);
end;
$$;

create function em_dia_private.read_offline_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_profile jsonb;v_binding jsonb;v_role text;v_groups jsonb:='[]';v_states jsonb:='[]';v_revisions jsonb:='[]';
  v_diaries jsonb:='[]';v_annuals jsonb:='[]';v_card jsonb;v_person jsonb;v_result jsonb;v_bundle jsonb;v_context jsonb;
  v_group record;v_month text;v_year integer;v_years integer[]:='{}';v_months text[]:='{}';v_row em_dia_private.daily_hours;
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');v_current_year integer;v_bytes bigint;
begin
  v_profile:=em_dia_private.get_access_profile();v_role:=v_profile->>'role';
  if v_role in ('admin','superintendent') then
    select coalesce(sum(octet_length(s.state::text)),0) into v_bytes from public.em_dia_states s
      where em_dia_private.can_access_group(s.group_id);
    if v_bytes>67108864 then raise exception using errcode='22023',message='The authorized offline snapshot exceeds 64 MiB.'; end if;
    for v_group in select g.id,g.name,g.created_at from public.em_dia_groups g
      where em_dia_private.can_access_group(g.id) order by g.created_at,g.id loop
      v_groups:=v_groups||jsonb_build_array(jsonb_build_object('id',v_group.id,'name',v_group.name,'created_at',v_group.created_at));
      select jsonb_build_object('group_id',s.group_id,'state',s.state,'revision',s.revision,'updated_at',s.updated_at) into v_bundle
        from public.em_dia_states s where s.group_id=v_group.id;
      if found then v_states:=v_states||jsonb_build_array(v_bundle); end if;
      v_revisions:=v_revisions||jsonb_build_array(jsonb_build_object('group_id',v_group.id,'items',em_dia_private.list_report_revisions(v_group.id)));
    end loop;
    v_result:=jsonb_build_object('profile',v_profile,'groups',v_groups,'states',v_states,'diaries',v_diaries,
      'annuals',v_annuals,'revisions',v_revisions);
  elsif v_role='publisher' then
    v_binding:=em_dia_private.own_timer_context();v_card:=em_dia_private.read_own_card();v_person:=v_card#>'{state,people,0}';
    select jsonb_build_array(jsonb_build_object('id',g.id,'name',g.name,'created_at',g.created_at)) into v_groups
      from public.em_dia_groups g where g.id=(v_binding->>'group_id')::uuid;
    select coalesce(sum(octet_length(d.launches::text)+octet_length(d.entries::text)),0) into v_bytes
      from em_dia_private.daily_hours d where d.group_id=(v_binding->>'group_id')::uuid and d.person_id=v_binding->>'person_id';
    if v_bytes>67108864 then raise exception using errcode='22023',message='The private offline diary exceeds 64 MiB.'; end if;
    if v_person->>'startMonth' !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$' then
      raise exception using errcode='22023',message='Invalid publisher tracking period.';
    end if;
    select coalesce(array_agg(m order by m),'{}'::text[]) into v_months from (
      select d.month m from em_dia_private.daily_hours d where d.group_id=(v_binding->>'group_id')::uuid
        and d.person_id=v_binding->>'person_id' and d.month<=left(v_today,7)
      union select to_char(month_date,'YYYY-MM') from generate_series((v_person->>'startMonth'||'-01')::date,
        (least(coalesce(v_person->>'endMonth',left(v_today,7)),left(v_today,7))||'-01')::date,interval '1 month') month_date
      union select e.key from jsonb_each(v_card#>'{state,reports}') e where e.key<=left(v_today,7)
        and e.key ~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$') months;
    if cardinality(v_months)>3600 then raise exception using errcode='22023',message='Too many private offline months.'; end if;
    foreach v_month in array v_months loop
      begin
        v_bundle:=em_dia_private.read_own_hour_launches(v_month)||jsonb_build_object('can_use',true);
      exception when sqlstate '22023' then
        select * into v_row from em_dia_private.daily_hours d where d.group_id=(v_binding->>'group_id')::uuid
          and d.person_id=v_binding->>'person_id' and d.month=v_month;
        if not found then continue; end if;
        -- Preserve a stored, now-ineligible diary for private review without
        -- making it an editable month or fabricating a new empty diary.
        v_context:=v_binding||jsonb_build_object('month',v_month,'kind','publisher','closed',v_month<left(v_today,7),'today',v_today);
        v_bundle:=em_dia_private.hour_launches_bundle(v_context,v_row.entries,v_row.launches,v_row.version,v_row.updated_at)
          ||jsonb_build_object('can_use',false);
      end;
      v_diaries:=v_diaries||jsonb_build_array(v_bundle);
    end loop;
    if exists(select 1 from jsonb_array_elements(v_person->'roles') r where r->>'kind'='regular') then
      v_current_year:=left(v_today,4)::integer-case when substring(v_today,6,2)<'09' then 1 else 0 end;
      select coalesce(array_agg(distinct y order by y),'{}'::integer[]) into v_years from (
        select a.service_year y from em_dia_private.annual_progress a where a.group_id=(v_binding->>'group_id')::uuid and a.person_id=v_binding->>'person_id'
        union select v_current_year
        union select left(m,4)::integer-case when substring(m,6,2)<'09' then 1 else 0 end from unnest(v_months) m) years
        where y between 1900 and least(v_current_year,2198);
      foreach v_year in array v_years loop
        v_annuals:=v_annuals||jsonb_build_array(em_dia_private.read_own_annual(v_year));
      end loop;
    end if;
    v_result:=jsonb_build_object('profile',v_profile,'groups',v_groups,'states',v_states,'own_card',v_card,
      'diaries',v_diaries,'annuals',v_annuals,'timer',em_dia_private.read_own_timer(),'revisions',v_revisions);
  else raise exception using errcode='42501',message='Current authorized access required.'; end if;
  if octet_length(v_result::text)>67108864 then raise exception using errcode='22023',message='The authorized offline snapshot exceeds 64 MiB.'; end if;
  return v_result;
end;
$$;

grant create on schema em_dia_private to em_dia_workflow;
do $$
declare v_function record;
begin
  for v_function in select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='em_dia_private'
    and p.proname=any(array['offline_integer','offline_uuid','change_own_timer_offline','apply_offline_operation','read_offline_snapshot']) loop
    execute format('alter function %I.%I(%s) owner to em_dia_workflow',v_function.nspname,v_function.proname,v_function.args);
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role,em_dia_writer',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;
revoke create on schema em_dia_private from em_dia_workflow;
-- The gateway delegates to the existing restricted writer, not table grants.
grant execute on function em_dia_private.save_group_state(uuid,jsonb,bigint) to em_dia_workflow;
grant execute on function em_dia_private.apply_offline_operation(uuid,text,jsonb),em_dia_private.read_offline_snapshot() to authenticated;
create function public.apply_em_dia_offline_operation(p_operation_id uuid,p_kind text,p_payload jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.apply_offline_operation(p_operation_id,p_kind,p_payload); $$;
create function public.read_em_dia_offline_snapshot() returns jsonb
language sql stable security invoker set search_path='' as $$ select em_dia_private.read_offline_snapshot(); $$;
revoke execute on function public.apply_em_dia_offline_operation(uuid,text,jsonb),public.read_em_dia_offline_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.apply_em_dia_offline_operation(uuid,text,jsonb),public.read_em_dia_offline_snapshot() to authenticated;

do $$
begin
  if exists(select 1 from em_dia_private.offline_receipts) then raise exception 'Offline receipts must start empty.'; end if;
  if exists(
    (select row_type,row_data from pg_temp.em_dia_offline_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
       union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t
       union all select 'annual',to_jsonb(a) from em_dia_private.annual_progress a))
    union all
    ((select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
       union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t
       union all select 'annual',to_jsonb(a) from em_dia_private.annual_progress a) except
      select row_type,row_data from pg_temp.em_dia_offline_preservation)
  ) then raise exception 'The offline migration changed existing records.'; end if;
end;
$$;

