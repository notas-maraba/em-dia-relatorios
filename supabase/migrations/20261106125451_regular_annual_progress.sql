-- Personal annual progress: no backfill and no existing report/diary changes.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,
  em_dia_private.report_revisions,em_dia_private.daily_hours,
  em_dia_private.legacy_group_links,em_dia_private.service_timers in share mode nowait;
create temporary table em_dia_annual_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_annual_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'members',to_jsonb(m) from public.em_dia_members m
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t;

create function em_dia_private.valid_annual_retro(p_service_year integer,p_retro jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_month record;v_minutes numeric;v_studies numeric;
begin
  if p_service_year is null or p_service_year<1900 or p_service_year>2198 or p_retro is null
    or jsonb_typeof(p_retro)<>'object' or (select count(*) from jsonb_object_keys(p_retro))>12 then return false; end if;
  for v_month in select key,value from jsonb_each(p_retro) loop
    if v_month.key !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
      or v_month.key<p_service_year::text||'-09' or v_month.key>(p_service_year+1)::text||'-08'
      or jsonb_typeof(v_month.value)<>'object' or not(v_month.value ?& array['minutes','studies'])
      or exists(select 1 from jsonb_object_keys(v_month.value) k where k not in ('minutes','studies'))
      or jsonb_typeof(v_month.value->'minutes')<>'number' or jsonb_typeof(v_month.value->'studies')<>'number' then return false; end if;
    v_minutes:=(v_month.value->>'minutes')::numeric;v_studies:=(v_month.value->>'studies')::numeric;
    if v_minutes<0 or v_minutes>44640 or trunc(v_minutes)<>v_minutes
      or v_studies<0 or v_studies>9999 or trunc(v_studies)<>v_studies then return false; end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create table em_dia_private.annual_progress (
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  person_id text not null check(person_id ~ '^[a-zA-Z0-9_-]{1,100}$' and person_id not in ('__proto__','constructor','prototype')),
  service_year integer not null check(service_year between 1900 and 2198),
  target_minutes integer not null default 36000 check(target_minutes between 1 and 535680),
  retro_months jsonb not null default '{}'::jsonb,
  version bigint not null check(version between 1 and 9007199254740991),
  updated_at timestamptz not null default statement_timestamp(),
  primary key(group_id,person_id,service_year),
  constraint em_dia_annual_retro_valid check(em_dia_private.valid_annual_retro(service_year,retro_months))
);
alter table em_dia_private.annual_progress enable row level security;
alter table em_dia_private.annual_progress force row level security;
revoke all on em_dia_private.annual_progress from public,anon,authenticated,service_role,em_dia_writer,em_dia_workflow;
grant select,insert,update on em_dia_private.annual_progress to em_dia_workflow;
create policy em_dia_annual_workflow_select on em_dia_private.annual_progress for select to em_dia_workflow using(true);
create policy em_dia_annual_workflow_insert on em_dia_private.annual_progress for insert to em_dia_workflow with check(true);
create policy em_dia_annual_workflow_update on em_dia_private.annual_progress for update to em_dia_workflow using(true) with check(true);

-- The binding comes from the verified account. Previous regular periods keep
-- history readable after the publisher's condition or tracking period ends.
create function em_dia_private.own_annual_context(p_service_year integer) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_binding jsonb;v_state jsonb;v_person jsonb;v_reports jsonb;
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_current_year integer;
begin
  v_binding:=em_dia_private.own_timer_context();
  v_current_year:=left(v_today,4)::integer-case when substring(v_today,6,2)<'09' then 1 else 0 end;
  if p_service_year is null or p_service_year<1900 or p_service_year>2198 or p_service_year>v_current_year then
    raise exception using errcode='22023',message='Choose an available service year.';
  end if;
  select s.state into v_state from public.em_dia_states s where s.group_id=(v_binding->>'group_id')::uuid;
  select p into v_person from jsonb_array_elements(v_state->'people') p where p->>'id'=v_binding->>'person_id';
  if not exists(select 1 from jsonb_array_elements(v_person->'roles') r where r->>'kind'='regular') then
    raise exception using errcode='42501',message='Annual progress is available only for a card with a regular pioneer period.';
  end if;
  select coalesce(jsonb_object_agg(e.key,jsonb_build_object('received',e.value#>array[v_binding->>'person_id','received'],
    'kind',e.value#>array[v_binding->>'person_id','kind'],'hours',e.value#>array[v_binding->>'person_id','hours'],
    'studies',e.value#>array[v_binding->>'person_id','studies'])),'{}'::jsonb) into v_reports
    from jsonb_each(v_state->'reports') e
    where e.key>=p_service_year::text||'-09' and e.key<=(p_service_year+1)::text||'-08'
      and e.value ? (v_binding->>'person_id');
  return v_binding||jsonb_build_object('service_year',p_service_year,'today',v_today,
    'start_month',v_person->'startMonth','end_month',v_person->'endMonth','roles',v_person->'roles','reports',v_reports);
end;
$$;

create function em_dia_private.annual_bundle(p_context jsonb,p_row em_dia_private.annual_progress) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_rows jsonb:='[]'::jsonb;v_month text;v_report jsonb;v_retro jsonb;v_entries jsonb;
  v_kind text;v_source text;v_minutes integer;v_studies integer;v_received boolean;v_diary boolean;
  v_prestart boolean;v_tracked boolean;v_can_edit boolean;v_offset integer;
begin
  for v_offset in 0..11 loop
    v_month:=to_char(make_date((p_context->>'service_year')::integer,9,1)+v_offset*interval '1 month','YYYY-MM');
    v_report:=p_context#>array['reports',v_month];
    v_received:=coalesce(v_report->'received'='true'::jsonb,false);
    select r->>'kind' into v_kind from jsonb_array_elements(p_context->'roles') r
      where r->>'start'<=v_month and (r->>'end' is null or r->>'end'>=v_month) order by r->>'start' desc limit 1;
    v_kind:=coalesce(v_kind,'publisher');
    v_prestart:=v_month<(p_context->>'start_month');
    v_tracked:=not v_prestart and (p_context->>'end_month' is null or v_month<=p_context->>'end_month');
    if v_received then v_kind:=v_report->>'kind';
    elsif v_prestart then v_kind:='regular'; end if;
    if v_kind is null or v_kind not in ('regular','auxiliary','publisher') then
      raise exception using errcode='22023',message='The month condition is invalid.';
    end if;
    select d.entries into v_entries from em_dia_private.daily_hours d
      where d.group_id=(p_context->>'group_id')::uuid and d.person_id=p_context->>'person_id' and d.month=v_month;
    v_diary:=coalesce(v_entries<>'{}'::jsonb,false);
    v_retro:=coalesce((p_row).retro_months,'{}'::jsonb)->v_month;
    v_can_edit:=v_month<left(p_context->>'today',7) and not v_received and not v_diary
      and (v_prestart or (v_tracked and v_kind='regular'));
    v_minutes:=null;v_studies:=null;
    if v_month>left(p_context->>'today',7) then v_source:='future';
    elsif v_received and v_kind='regular' then
      v_source:='approved';v_minutes:=round((v_report->>'hours')::numeric*60)::integer;v_studies:=(v_report->>'studies')::integer;
    elsif v_received or (not v_prestart and (not v_tracked or v_kind<>'regular')) then v_source:='not_regular';
    elsif v_diary then
      v_source:='diary';select coalesce(sum((e.value#>>'{}')::integer),0) into v_minutes from jsonb_each(v_entries) e;
    elsif v_retro is not null then
      v_source:='retroactive';v_minutes:=(v_retro->>'minutes')::integer;v_studies:=(v_retro->>'studies')::integer;
    else v_source:='missing'; end if;
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object('month',v_month,'kind',v_kind,'source',v_source,
      'minutes',v_minutes,'studies',v_studies,'retro_minutes',v_retro->'minutes','retro_studies',v_retro->'studies',
      'can_edit_retro',v_can_edit));
  end loop;
  return jsonb_build_object('group_id',p_context->'group_id','person_id',p_context->'person_id',
    'service_year',p_context->'service_year','today',p_context->'today','target_minutes',coalesce((p_row).target_minutes,36000),
    'version',coalesce((p_row).version,0),'updated_at',(p_row).updated_at,'months',v_rows);
end;
$$;

create function em_dia_private.read_own_annual(p_service_year integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_context jsonb;v_row em_dia_private.annual_progress;
begin
  v_context:=em_dia_private.own_annual_context(p_service_year);
  select * into v_row from em_dia_private.annual_progress a where a.group_id=(v_context->>'group_id')::uuid
    and a.person_id=v_context->>'person_id' and a.service_year=p_service_year;
  return em_dia_private.annual_bundle(v_context,v_row);
end;
$$;

create function em_dia_private.save_own_annual_goal(p_service_year integer,p_target_minutes integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id();v_binding jsonb;v_context jsonb;v_row em_dia_private.annual_progress;v_exists boolean;v_version bigint;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_binding:=em_dia_private.own_timer_context();
  if p_target_minutes is null or p_target_minutes<1 or p_target_minutes>535680
    or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid annual goal or version.';
  end if;
  perform 1 from public.em_dia_states s where s.group_id=(v_binding->>'group_id')::uuid for update;
  v_context:=em_dia_private.own_annual_context(p_service_year);
  select * into v_row from em_dia_private.annual_progress a where a.group_id=(v_context->>'group_id')::uuid
    and a.person_id=v_context->>'person_id' and a.service_year=p_service_year for update;
  v_exists:=found;v_version:=coalesce(v_row.version,0);
  if p_expected_version>v_version then raise exception using errcode='40001',message='The annual version is invalid. Reload before saving.'; end if;
  if coalesce(v_row.target_minutes,36000)=p_target_minutes then
    return em_dia_private.annual_bundle(v_context,v_row)||jsonb_build_object('unchanged',true);
  end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='Annual progress changed. Reload before saving.'; end if;
  if v_exists then
    update em_dia_private.annual_progress a set target_minutes=p_target_minutes,version=a.version+1,updated_at=statement_timestamp()
      where a.group_id=(v_context->>'group_id')::uuid and a.person_id=v_context->>'person_id' and a.service_year=p_service_year returning * into v_row;
  else
    insert into em_dia_private.annual_progress(group_id,person_id,service_year,target_minutes,version)
      values((v_context->>'group_id')::uuid,v_context->>'person_id',p_service_year,p_target_minutes,1) returning * into v_row;
  end if;
  return em_dia_private.annual_bundle(v_context,v_row)||jsonb_build_object('unchanged',false);
end;
$$;

create function em_dia_private.save_own_annual_retro(p_service_year integer,p_month text,p_minutes integer,p_studies integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_binding jsonb;v_context jsonb;v_row em_dia_private.annual_progress;
  v_exists boolean;v_version bigint;v_result jsonb;v_month jsonb;v_next jsonb;v_value jsonb;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_binding:=em_dia_private.own_timer_context();
  if p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991
    or p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or (p_minutes is null)<>(p_studies is null)
    or (p_minutes is not null and (p_minutes<0 or p_minutes>44640 or p_studies<0 or p_studies>9999)) then
    raise exception using errcode='22023',message='Provide both historical hours and studies, or remove both.';
  end if;
  perform 1 from public.em_dia_states s where s.group_id=(v_binding->>'group_id')::uuid for update;
  v_context:=em_dia_private.own_annual_context(p_service_year);
  if p_month<p_service_year::text||'-09' or p_month>(p_service_year+1)::text||'-08' then
    raise exception using errcode='22023',message='Choose a month within this service year.';
  end if;
  select * into v_row from em_dia_private.annual_progress a where a.group_id=(v_context->>'group_id')::uuid
    and a.person_id=v_context->>'person_id' and a.service_year=p_service_year for update;
  v_exists:=found;v_version:=coalesce(v_row.version,0);
  if p_expected_version>v_version then raise exception using errcode='40001',message='The annual version is invalid. Reload before saving.'; end if;
  v_result:=em_dia_private.annual_bundle(v_context,v_row);
  select m into v_month from jsonb_array_elements(v_result->'months') m where m->>'month'=p_month;
  if v_month->'can_edit_retro' is distinct from 'true'::jsonb then
    raise exception using errcode='22023',message='Historical totals require a closed eligible month without a received report or diary.';
  end if;
  v_value:=case when p_minutes is null then null else jsonb_build_object('minutes',p_minutes,'studies',p_studies) end;
  if (p_minutes is null and not(coalesce(v_row.retro_months,'{}'::jsonb) ? p_month))
    or (p_minutes is not null and v_row.retro_months->p_month=v_value) then
    return v_result||jsonb_build_object('unchanged',true);
  end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='Annual progress changed. Reload before saving.'; end if;
  v_next:=coalesce(v_row.retro_months,'{}'::jsonb)-p_month;
  if p_minutes is not null then v_next:=v_next||jsonb_build_object(p_month,v_value); end if;
  if v_exists then
    update em_dia_private.annual_progress a set retro_months=v_next,version=a.version+1,updated_at=statement_timestamp()
      where a.group_id=(v_context->>'group_id')::uuid and a.person_id=v_context->>'person_id' and a.service_year=p_service_year returning * into v_row;
  else
    insert into em_dia_private.annual_progress(group_id,person_id,service_year,retro_months,version)
      values((v_context->>'group_id')::uuid,v_context->>'person_id',p_service_year,v_next,1) returning * into v_row;
  end if;
  return em_dia_private.annual_bundle(v_context,v_row)||jsonb_build_object('unchanged',false);
end;
$$;

-- Personal history and goals must remain attached to their card on imports.
create or replace function em_dia_private.assert_state_links(p_group_id uuid,p_state jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group not authorized.';
  end if;
  if exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_group_id and
    not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=l.person_id))
    or exists(select 1 from em_dia_private.report_revisions r where r.group_id=p_group_id and r.status='pending' and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=r.person_id))
    or exists(select 1 from em_dia_private.daily_hours d where d.group_id=p_group_id and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=d.person_id))
    or exists(select 1 from em_dia_private.service_timers t where t.group_id=p_group_id and t.status<>'idle' and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=t.person_id))
    or exists(select 1 from em_dia_private.annual_progress a where a.group_id=p_group_id and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=a.person_id)) then
    raise exception using errcode='22023',message='A linked publisher, review, diary, active timer or personal annual history cannot be removed. Transfer the card or resolve it first.';
  end if;
end;
$$;

-- Transfers carry the personal annual data, retaining the existing timer move.
create or replace function em_dia_private.transfer_publisher(p_from_group_id uuid,p_to_group_id uuid,p_person_id text,p_expected_from_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_linked_user uuid; v_after_link uuid; v_group uuid;
  v_source public.em_dia_states; v_dest public.em_dia_states; v_dest_new boolean:=false; v_person jsonb; v_name text;
  v_source_json jsonb; v_dest_json jsonb; v_reports jsonb; v_reminders jsonb; v_moved jsonb; v_now timestamptz:=statement_timestamp();
begin
  if v_user is null then raise exception using errcode='42501',message='Group management required.'; end if;
  if p_from_group_id is null or p_to_group_id is null or p_from_group_id=p_to_group_id or p_person_id is null
    or p_expected_from_revision is null or p_expected_from_revision<1 then
    raise exception using errcode='22023',message='Choose a different destination group.';
  end if;
  select l.user_id into v_linked_user from em_dia_private.publisher_links l where l.group_id=p_from_group_id and l.person_id=p_person_id;
  perform em_dia_private.lock_accounts(array[v_user,v_linked_user]);
  if not em_dia_private.can_access_group(p_from_group_id) then raise exception using errcode='42501',message='Source group management required.'; end if;
  select g.name into v_name from public.em_dia_groups g where g.id=p_to_group_id;
  if not found then raise exception using errcode='22023',message='Destination group not available.'; end if;
  -- Non-key group locks serialize empty targets but allow concurrent FK KEY
  -- SHARE checks from another card's first submission or account creation.
  for v_group in select id from public.em_dia_groups where id in (p_from_group_id,p_to_group_id) order by id for no key update loop
    perform 1 from public.em_dia_states s where s.group_id=v_group for update;
  end loop;
  select * into v_source from public.em_dia_states s where s.group_id=p_from_group_id;
  if not found or v_source.revision<>p_expected_from_revision then raise exception using errcode='40001',message='Source group changed. Reload before transferring.'; end if;
  select l.user_id into v_after_link from em_dia_private.publisher_links l where l.group_id=p_from_group_id and l.person_id=p_person_id;
  if v_after_link is distinct from v_linked_user then raise exception using errcode='40001',message='Publisher access changed. Reload before transferring.'; end if;
  select p into v_person from jsonb_array_elements(v_source.state->'people') p where p->>'id'=p_person_id;
  if v_person is null then raise exception using errcode='22023',message='Publisher card not available.'; end if;
  select * into v_dest from public.em_dia_states s where s.group_id=p_to_group_id;
  if not found then
    v_dest_new:=true;v_dest.group_id:=p_to_group_id;v_dest.revision:=0;
    v_dest.state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',0,'updatedAt',v_now,'lastBackupAt',null,
        'settings',jsonb_build_object('congregation','','group',v_name,'reminder',''),'people','[]'::jsonb,
        'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_source.state->'activeMonth','sourceNote','');
  end if;
  if exists(select 1 from jsonb_array_elements(v_dest.state->'people') p where p->>'id'=p_person_id)
    or exists(select 1 from em_dia_private.daily_hours d where d.group_id=p_to_group_id and d.person_id=p_person_id)
    or exists(select 1 from em_dia_private.service_timers t where t.group_id=p_to_group_id and t.person_id=p_person_id)
    or exists(select 1 from em_dia_private.annual_progress a where a.group_id=p_to_group_id and a.person_id=p_person_id)
    or exists(select 1 from em_dia_private.report_revisions r where r.group_id=p_to_group_id and r.person_id=p_person_id)
    or exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_to_group_id and l.person_id=p_person_id)
    or exists(select 1 from jsonb_each(v_dest.state->'reports') e where e.value ? p_person_id)
    or exists(select 1 from jsonb_each(v_dest.state->'reminders') e where e.value ? p_person_id) then
    raise exception using errcode='22023',message='The destination already contains this publisher identifier. No cards were merged.';
  end if;
  v_source_json:=v_source.state; v_dest_json:=v_dest.state;
  v_source_json:=jsonb_set(v_source_json,'{people}',coalesce((select jsonb_agg(p) from jsonb_array_elements(v_source_json->'people') p where p->>'id'<>p_person_id),'[]'::jsonb));
  v_dest_json:=jsonb_set(v_dest_json,'{people}',(v_dest_json->'people')||jsonb_build_array(v_person));
  select coalesce(jsonb_object_agg(e.key,e.value-p_person_id),'{}'::jsonb) into v_reports from jsonb_each(v_source_json->'reports') e;
  select coalesce(jsonb_object_agg(e.key,e.value->p_person_id),'{}'::jsonb) into v_moved from jsonb_each(v_source_json->'reports') e where e.value ? p_person_id;
  v_source_json:=jsonb_set(v_source_json,'{reports}',v_reports);
  for v_name in select key from jsonb_each(v_moved) loop
    v_dest_json:=jsonb_set(v_dest_json,'{reports}',(v_dest_json->'reports')||jsonb_build_object(v_name,
      coalesce(v_dest_json#>array['reports',v_name],'{}'::jsonb)||jsonb_build_object(p_person_id,v_moved->v_name)));
  end loop;
  select coalesce(jsonb_object_agg(e.key,e.value-p_person_id),'{}'::jsonb) into v_reminders from jsonb_each(v_source_json->'reminders') e;
  select coalesce(jsonb_object_agg(e.key,e.value->p_person_id),'{}'::jsonb) into v_moved from jsonb_each(v_source_json->'reminders') e where e.value ? p_person_id;
  v_source_json:=jsonb_set(v_source_json,'{reminders}',v_reminders);
  for v_name in select key from jsonb_each(v_moved) loop
    v_dest_json:=jsonb_set(v_dest_json,'{reminders}',(v_dest_json->'reminders')||jsonb_build_object(v_name,
      coalesce(v_dest_json#>array['reminders',v_name],'{}'::jsonb)||jsonb_build_object(p_person_id,v_moved->v_name)));
  end loop;
  update em_dia_private.publisher_links l set group_id=p_to_group_id where l.group_id=p_from_group_id and l.person_id=p_person_id;
  if v_linked_user is not null then update public.em_dia_group_members gm set group_id=p_to_group_id where gm.user_id=v_linked_user; end if;
  update em_dia_private.service_timers t set group_id=p_to_group_id where t.group_id=p_from_group_id and t.person_id=p_person_id;
  update em_dia_private.annual_progress a set group_id=p_to_group_id where a.group_id=p_from_group_id and a.person_id=p_person_id;
  update em_dia_private.daily_hours d set group_id=p_to_group_id where d.group_id=p_from_group_id and d.person_id=p_person_id;
  update em_dia_private.report_revisions r set group_id=p_to_group_id where r.group_id=p_from_group_id and r.person_id=p_person_id;
  v_source_json:=v_source_json||jsonb_build_object('revision',v_source.revision+1,'updatedAt',v_now);
  v_dest_json:=v_dest_json||jsonb_build_object('revision',v_dest.revision+1,'updatedAt',v_now);
  update public.em_dia_states s set state=v_source_json,revision=s.revision+1,updated_at=v_now where s.group_id=p_from_group_id returning s.* into v_source;
  if v_dest_new then
    insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values(p_to_group_id,null,v_dest_json,1,v_now)
      on conflict(group_id) do nothing returning * into v_dest;
    if not found then raise exception using errcode='40001',message='Destination group changed. Reload before transferring.'; end if;
  else
    update public.em_dia_states s set state=v_dest_json,revision=s.revision+1,updated_at=v_now where s.group_id=p_to_group_id returning s.* into v_dest;
  end if;
  return jsonb_build_object('from_group_id',p_from_group_id,'to_group_id',p_to_group_id,'person_id',p_person_id,
    'from_revision',v_source.revision,'to_revision',v_dest.revision);
end;
$$;

grant create on schema em_dia_private to em_dia_workflow;
do $$
declare v_function record;
begin
  for v_function in select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='em_dia_private' and p.proname=any(array[
      'valid_annual_retro','own_annual_context','annual_bundle','read_own_annual','save_own_annual_goal','save_own_annual_retro']) loop
    execute format('alter function %I.%I(%s) owner to em_dia_workflow',v_function.nspname,v_function.proname,v_function.args);
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role,em_dia_writer',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;
revoke create on schema em_dia_private from em_dia_workflow;
grant execute on function em_dia_private.read_own_annual(integer),em_dia_private.save_own_annual_goal(integer,integer,bigint),
  em_dia_private.save_own_annual_retro(integer,text,integer,integer,bigint) to authenticated;

create function public.read_em_dia_own_annual(p_service_year integer) returns jsonb
language sql stable security invoker set search_path='' as $$ select em_dia_private.read_own_annual(p_service_year); $$;
create function public.save_em_dia_own_annual_goal(p_service_year integer,p_target_minutes integer,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.save_own_annual_goal(p_service_year,p_target_minutes,p_expected_version);
$$;
create function public.save_em_dia_own_annual_retro(p_service_year integer,p_month text,p_minutes integer,p_studies integer,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.save_own_annual_retro(p_service_year,p_month,p_minutes,p_studies,p_expected_version);
$$;
revoke execute on function public.read_em_dia_own_annual(integer),public.save_em_dia_own_annual_goal(integer,integer,bigint),
  public.save_em_dia_own_annual_retro(integer,text,integer,integer,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_em_dia_own_annual(integer),public.save_em_dia_own_annual_goal(integer,integer,bigint),
  public.save_em_dia_own_annual_retro(integer,text,integer,integer,bigint) to authenticated;

do $$
begin
  if exists(select 1 from em_dia_private.annual_progress) then raise exception 'Personal annual progress must start empty.'; end if;
  if exists(
    (select row_type,row_data from pg_temp.em_dia_annual_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
       union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t))
    union all
    ((select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll
       union all select 'timers',to_jsonb(t) from em_dia_private.service_timers t) except
      select row_type,row_data from pg_temp.em_dia_annual_preservation)
  ) then raise exception 'The annual-progress migration changed existing records.'; end if;
end;
$$;

