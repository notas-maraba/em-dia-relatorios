-- New offline operations require exact resource versions; existing receipts
-- are acknowledged before CAS. All eleven existing data sets stay intact.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,
  em_dia_private.report_revisions,em_dia_private.daily_hours,
  em_dia_private.legacy_group_links,em_dia_private.service_timers,
  em_dia_private.annual_progress,em_dia_private.offline_receipts in share mode nowait;
create temporary table em_dia_offline_strict_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_offline_strict_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'members',to_jsonb(m) from public.em_dia_members m
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t
union all select 'annual',to_jsonb(a) from em_dia_private.annual_progress a
union all select 'receipts',to_jsonb(r) from em_dia_private.offline_receipts r;

create temporary table em_dia_strict_routine on commit drop as
select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig from pg_proc p
where p.oid='em_dia_private.apply_offline_operation(uuid,text,jsonb)'::regprocedure;
create or replace function em_dia_private.apply_offline_operation(p_operation_id uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=em_dia_private.current_user_id();v_group uuid;v_person text;v_role text;v_binding jsonb;
  v_required text[];v_allowed text[];v_hash bytea;v_saved em_dia_private.offline_receipts;
  v_result jsonb;v_confirmation jsonb;v_state public.em_dia_states;v_effective timestamptz;v_timer_version bigint;
  v_note text;v_version bigint;v_id uuid;v_at text;v_timer em_dia_private.service_timers;v_actual bigint;v_year integer;
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
  -- Receipts above acknowledge already committed intent. A new operation must
  -- match the actual resource version even if a native endpoint could return
  -- a value-based noop, so dependencies never inherit unknown remote edits.
  if p_kind='diary_launch' then
    v_version:=em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990);
    select d.version into v_actual from em_dia_private.daily_hours d where d.group_id=v_group and d.person_id=v_person
      and d.month=left(p_payload->>'date',7) for update;
    if v_version<>coalesce(v_actual,0) then raise exception using errcode='40001',message='The diary changed outside this offline queue.'; end if;
  elsif p_kind in ('report_manual','report_diary') then
    if p_kind='report_diary' then
      v_version:=em_dia_private.offline_integer(p_payload->'expectedHoursVersion',0,9007199254740990);
      select d.version into v_actual from em_dia_private.daily_hours d where d.group_id=v_group and d.person_id=v_person
        and d.month=p_payload->>'month' for update;
      if v_version<>coalesce(v_actual,0) then raise exception using errcode='40001',message='The diary changed outside this offline queue.'; end if;
    end if;
    v_version:=em_dia_private.offline_integer(case when p_kind='report_manual' then p_payload->'expectedVersion' else p_payload->'expectedReportVersion' end,0,9007199254740990);
    select r.version into v_actual from em_dia_private.report_revisions r where r.group_id=v_group and r.person_id=v_person
      and r.month=p_payload->>'month' for update;
    if v_version<>coalesce(v_actual,0) then raise exception using errcode='40001',message='The report changed outside this offline queue.'; end if;
  elsif p_kind in ('annual_goal','annual_retro') then
    v_year:=em_dia_private.offline_integer(p_payload->'serviceYear',1900,2198)::integer;
    v_version:=em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990);
    select a.version into v_actual from em_dia_private.annual_progress a where a.group_id=v_group and a.person_id=v_person
      and a.service_year=v_year for update;
    if v_version<>coalesce(v_actual,0) then raise exception using errcode='40001',message='Annual progress changed outside this offline queue.'; end if;
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
do $$
begin
  if exists(select 1 from pg_temp.em_dia_strict_routine old join pg_proc p on p.oid=old.oid
    where (old.proowner,old.proacl,old.prosecdef,old.proconfig) is distinct from (p.proowner,p.proacl,p.prosecdef,p.proconfig)) then
    raise exception 'The offline gateway authorization settings changed.';
  end if;
  if exists(
    (select row_type,row_data from pg_temp.em_dia_offline_strict_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
       union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t
       union all select 'annual',to_jsonb(a) from em_dia_private.annual_progress a
       union all select 'receipts',to_jsonb(r) from em_dia_private.offline_receipts r))
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
       union all select 'annual',to_jsonb(a) from em_dia_private.annual_progress a
       union all select 'receipts',to_jsonb(r) from em_dia_private.offline_receipts r) except
      select row_type,row_data from pg_temp.em_dia_offline_strict_preservation)
  ) then raise exception 'The strict offline CAS migration changed existing records.'; end if;
end;
$$;

