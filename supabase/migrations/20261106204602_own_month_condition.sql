-- Own monthly condition: preserve every existing private dataset.
lock table public.em_dia_states,
  public.em_dia_members,
  public.em_dia_groups,
  public.em_dia_group_members,
  em_dia_private.publisher_links,
  em_dia_private.report_revisions,
  em_dia_private.daily_hours,
  em_dia_private.legacy_group_links,
  em_dia_private.service_timers,
  em_dia_private.annual_progress,
  em_dia_private.offline_receipts,em_dia_private.account_profiles in share mode nowait;
create temporary table em_dia_condition_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_condition_preservation
select 'states' row_type,to_jsonb(s) row_data from public.em_dia_states s
union all select 'members' row_type,to_jsonb(m) row_data from public.em_dia_members m
union all select 'groups' row_type,to_jsonb(g) row_data from public.em_dia_groups g
union all select 'memberships' row_type,to_jsonb(gm) row_data from public.em_dia_group_members gm
union all select 'links' row_type,to_jsonb(l) row_data from em_dia_private.publisher_links l
union all select 'revisions' row_type,to_jsonb(r) row_data from em_dia_private.report_revisions r
union all select 'diaries' row_type,to_jsonb(d) row_data from em_dia_private.daily_hours d
union all select 'legacy' row_type,to_jsonb(ll) row_data from em_dia_private.legacy_group_links ll
union all select 'timers' row_type,to_jsonb(t) row_data from em_dia_private.service_timers t
union all select 'annual' row_type,to_jsonb(a) row_data from em_dia_private.annual_progress a
union all select 'receipts' row_type,to_jsonb(o) row_data from em_dia_private.offline_receipts o
union all select 'profiles',to_jsonb(a) from em_dia_private.account_profiles a;


create function em_dia_private.valid_month_conditions(p_value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_value is null then return true; end if;
  if jsonb_typeof(p_value)<>'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(p_value))>3600 then return false; end if;
  return not exists(select 1 from jsonb_each(p_value) e where e.key !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or jsonb_typeof(e.value)<>'string' or e.value#>>'{}' not in ('publisher','regular','auxiliary'));
end;
$$;
create function em_dia_private.valid_person_month_conditions(p_person jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_choice record;v_kind text;
begin
  if not em_dia_private.valid_month_conditions(p_person->'monthConditions') then return false; end if;
  if not(p_person ? 'monthConditions') then return true; end if;
  if jsonb_typeof(p_person->'roles') is distinct from 'array' then return false; end if;
  for v_choice in select e.key,e.value#>>'{}' kind from jsonb_each(p_person->'monthConditions') e loop
    select r->>'kind' into v_kind from jsonb_array_elements(p_person->'roles') r
      where r->>'start'<=v_choice.key and (r->>'end' is null or r->>'end'>=v_choice.key) order by r->>'start' desc limit 1;
    if coalesce(v_kind,'publisher')<>v_choice.kind then return false; end if;
  end loop;
  return true;
end;
$$;
create function em_dia_private.own_month_kind(p_person jsonb,p_report jsonb,p_month text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare v_kind text;
begin
  if not em_dia_private.valid_person_month_conditions(p_person) then
    raise exception using errcode='22023',message='Invalid monthly conditions.';
  end if;
  v_kind:=p_person#>>array['monthConditions',p_month];
  if v_kind is null then
    if p_report->'received'='true'::jsonb then v_kind:=p_report->>'kind';
    else
      select r->>'kind' into v_kind from jsonb_array_elements(p_person->'roles') r
        where r->>'start'<=p_month and (r->>'end' is null or r->>'end'>=p_month) order by r->>'start' desc limit 1;
      v_kind:=coalesce(v_kind,'publisher');
    end if;
  end if;
  if v_kind is null or v_kind not in ('publisher','regular','auxiliary') then
    raise exception using errcode='22023',message='Invalid monthly condition.';
  end if;
  return v_kind;
end;
$$;
create function em_dia_private.person_with_month_condition(p_person jsonb,p_month text,p_kind text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare v_roles jsonb:='[]';v_result jsonb:='[]';v_role jsonb;v_last jsonb;v_count integer;v_previous text;v_next text;
begin
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$' or p_kind is null
    or p_kind not in ('publisher','regular','auxiliary') or not em_dia_private.valid_month_conditions(p_person->'monthConditions') then
    raise exception using errcode='22023',message='Invalid monthly condition.';
  end if;
  v_previous:=to_char((p_month||'-01')::date-interval '1 month','YYYY-MM');
  v_next:=to_char((p_month||'-01')::date+interval '1 month','YYYY-MM');
  for v_role in select r from jsonb_array_elements(p_person->'roles') r loop
    if v_role->>'start'>p_month or v_role->>'end'<p_month then v_roles:=v_roles||jsonb_build_array(v_role);
    else
      if v_role->>'start'<p_month then v_roles:=v_roles||jsonb_build_array(v_role||jsonb_build_object('end',v_previous)); end if;
      if (v_role->>'end' is null or v_role->>'end'>p_month) and v_next<='2199-12' then
        v_roles:=v_roles||jsonb_build_array(v_role||jsonb_build_object('start',v_next));
      end if;
    end if;
  end loop;
  if p_kind<>'publisher' then v_roles:=v_roles||jsonb_build_array(jsonb_build_object('kind',p_kind,'start',p_month,'end',p_month)); end if;
  for v_role in select r from jsonb_array_elements(v_roles) r order by r->>'start' loop
    v_count:=jsonb_array_length(v_result);v_last:=v_result->(v_count-1);
    if v_count>0 and v_last->>'kind'=v_role->>'kind' and v_last->>'end' is not null
      and to_char((v_last->>'end'||'-01')::date+interval '1 month','YYYY-MM')=v_role->>'start' then
      v_result:=jsonb_set(v_result,array[(v_count-1)::text],v_last||jsonb_build_object('end',v_role->'end'));
    else v_result:=v_result||jsonb_build_array(v_role); end if;
  end loop;
  if jsonb_array_length(v_result)>200 then raise exception using errcode='22023',message='Too many pioneer periods.'; end if;
  return p_person||jsonb_build_object('roles',v_result,'monthConditions',coalesce(p_person->'monthConditions','{}'::jsonb)||jsonb_build_object(p_month,p_kind));
end;
$$;
create or replace function em_dia_private.clean_person(p_person jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',p_person->'id','name',p_person->'name','startMonth',p_person->'startMonth',
    'endMonth',p_person->'endMonth','notes','', 'roles',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',r->'kind','start',r->'start','end',r->'end')) from jsonb_array_elements(p_person->'roles') r),'[]'::jsonb))
    ||case when p_person ? 'monthConditions' and em_dia_private.valid_month_conditions(p_person->'monthConditions')
      then jsonb_build_object('monthConditions',p_person->'monthConditions') else '{}'::jsonb end;
$$;
create function em_dia_private.save_own_condition(p_month text,p_kind text,p_expected_revision bigint,
  p_expected_actor_id uuid,p_expected_group_id uuid,p_expected_person_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=em_dia_private.current_user_id();v_context jsonb;v_state public.em_dia_states;
  v_person jsonb;v_person_next jsonb;v_people jsonb;v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_now timestamptz:=statement_timestamp();v_index integer;
begin
  if v_actor is null or p_expected_actor_id is null or v_actor<>p_expected_actor_id then
    raise exception using errcode='42501',message='Current personal card access required.';
  end if;
  perform em_dia_private.lock_accounts(array[v_actor]);v_context:=em_dia_private.own_timer_context();
  if p_expected_group_id is null or p_expected_person_id is null or (v_context->>'group_id')::uuid<>p_expected_group_id
    or v_context->>'person_id'<>p_expected_person_id then raise exception using errcode='42501',message='Personal card binding changed.'; end if;
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$' or p_month>left(v_today,7)
    or p_kind is null or p_kind not in ('publisher','regular','auxiliary') or p_expected_revision is null
    or p_expected_revision<1 or p_expected_revision>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid monthly condition or revision.';
  end if;
  select * into v_state from public.em_dia_states s where s.group_id=p_expected_group_id for update;
  if not found then raise exception using errcode='42501',message='Personal card unavailable.'; end if;
  if v_state.revision<>p_expected_revision then raise exception using errcode='40001',message='Group changed. Reload before choosing the monthly condition.'; end if;
  select (e.ordinality-1)::integer,e.value into v_index,v_person from jsonb_array_elements(v_state.state->'people') with ordinality e
    where e.value->>'id'=p_expected_person_id;
  if v_person is null then raise exception using errcode='42501',message='Personal card unavailable.'; end if;
  if (p_month<v_person->>'startMonth' or (v_person->>'endMonth' is not null and p_month>v_person->>'endMonth'))
    and not coalesce(v_state.state#>array['reports',p_month],'{}'::jsonb) ? p_expected_person_id then
    raise exception using errcode='22023',message='This month is not tracked.';
  end if;
  v_person_next:=em_dia_private.person_with_month_condition(v_person,p_month,p_kind);
  if v_person_next=v_person then return jsonb_build_object('group_id',p_expected_group_id,'person_id',p_expected_person_id,
    'month',p_month,'kind',p_kind,'revision',v_state.revision,'unchanged',true); end if;
  v_people:=jsonb_set(v_state.state->'people',array[v_index::text],v_person_next);
  update public.em_dia_states s set state=s.state||jsonb_build_object('people',v_people,'revision',s.revision+1,'updatedAt',v_now),
    revision=s.revision+1,updated_at=v_now where s.group_id=p_expected_group_id returning s.* into v_state;
  return jsonb_build_object('group_id',p_expected_group_id,'person_id',p_expected_person_id,'month',p_month,
    'kind',p_kind,'revision',v_state.revision,'unchanged',false);
end;
$$;

create or replace function em_dia_private.own_hours_context(p_month text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;
  v_state jsonb;v_person jsonb;v_report jsonb;v_kind text;
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
begin
  if v_user is null or not em_dia_private.has_personal_card() then
    raise exception using errcode='42501',message='Publisher access required.';
  end if;
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$' or p_month>left(v_today,7) then
    raise exception using errcode='22023',message='Invalid diary month.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or (em_dia_private.access_role()='publisher' and not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id)) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select s.state into v_state from public.em_dia_states s where s.group_id=v_link.group_id;
  select p into v_person from jsonb_array_elements(v_state->'people') p where p->>'id'=v_link.person_id;
  if v_person is null then raise exception using errcode='42501',message='Publisher card not available.'; end if;
  v_report:=v_state#>array['reports',p_month,v_link.person_id];
  if v_report is null and (p_month<(v_person->>'startMonth') or (v_person->>'endMonth' is not null and p_month>(v_person->>'endMonth'))) then
    raise exception using errcode='22023',message='The publisher is not tracked in that month.';
  end if;
  v_kind:=em_dia_private.own_month_kind(v_person,v_report,p_month);
  if v_kind not in ('publisher','regular','auxiliary') or v_kind is null then
    raise exception using errcode='22023',message='The month condition is invalid.';
  end if;
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id,'month',p_month,
    'kind',v_kind,'closed',p_month<left(v_today,7),'today',v_today);
end;
$$;
create or replace function em_dia_private.submit_own_report(p_month text,p_report jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_link em_dia_private.publisher_links;
  v_state public.em_dia_states; v_person jsonb; v_existing jsonb; v_kind text; v_proposed jsonb;
  v_work em_dia_private.report_revisions; v_found boolean; v_current_version bigint; v_status text;
  v_now timestamptz:=statement_timestamp(); v_date text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_values jsonb; v_next jsonb; v_first boolean;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if not em_dia_private.has_personal_card() then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or p_month>left(v_date,7) or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid report month or version.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or (em_dia_private.access_role()='publisher' and not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id)) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select * into v_state from public.em_dia_states s where s.group_id=v_link.group_id for update;
  select p into v_person from jsonb_array_elements(v_state.state->'people') p where p->>'id'=v_link.person_id;
  if v_person is null then raise exception using errcode='42501',message='Publisher card not available.'; end if;
  v_existing:=v_state.state#>array['reports',p_month,v_link.person_id];
  if v_existing is null and (p_month<(v_person->>'startMonth') or (v_person->>'endMonth' is not null and p_month>(v_person->>'endMonth'))) then
    raise exception using errcode='22023',message='The publisher is not tracked in that month.';
  end if;
  v_kind:=em_dia_private.own_month_kind(v_person,v_existing,p_month);
  if p_report ? 'kind' then
    if jsonb_typeof(p_report->'kind') is distinct from 'string' or p_report->>'kind'<>v_kind then
      raise exception using errcode='40001',message='The monthly condition changed. Reload before sending.';
    end if;
    p_report:=p_report-'kind';
  elsif coalesce(v_person->'monthConditions','{}'::jsonb) ? p_month then
    raise exception using errcode='40001',message='Confirm the monthly condition before sending.';
  end if;
  v_proposed:=em_dia_private.report_values(v_kind,p_report);
  select * into v_work from em_dia_private.report_revisions r
    where r.group_id=v_link.group_id and r.person_id=v_link.person_id and r.month=p_month for update;
  v_found:=found; v_current_version:=case when v_found then v_work.version else 0 end;
  if p_expected_version>v_current_version then raise exception using errcode='40001',message='The report version is invalid. Reload before sending.'; end if;
  -- A response lost by the network is safe to retry, even with its old version.
  if v_found and v_work.status in ('accepted','pending') and v_work.proposed_report=v_proposed
    and ((v_work.status='accepted' and em_dia_private.activity(v_existing)=v_proposed)
      or (v_work.status='pending' and v_work.base_activity is not distinct from em_dia_private.activity(v_existing))) then
    return jsonb_build_object('status',v_work.status,'version',v_work.version,'group_id',v_link.group_id,'person_id',v_link.person_id,
      'month',p_month,'revision',v_state.revision,'unchanged',true);
  end if;
  if not v_found and em_dia_private.activity(v_existing)=v_proposed then
    return jsonb_build_object('status','accepted','version',0,'group_id',v_link.group_id,'person_id',v_link.person_id,
      'month',p_month,'revision',v_state.revision,'unchanged',true);
  end if;
  if p_expected_version<>v_current_version then raise exception using errcode='40001',message='Report submission changed. Reload before sending again.'; end if;
  v_first:=not v_found and coalesce(v_existing->'received','false'::jsonb)<>'true'::jsonb;
  v_status:=case when v_first then 'accepted' else 'pending' end;
  if v_first then
    v_values:=v_proposed||jsonb_build_object('notes',coalesce(v_existing->>'notes',''),'receivedDate',v_date,'updatedAt',v_now);
    v_next:=jsonb_set(v_state.state,'{reports}',coalesce(v_state.state->'reports','{}'::jsonb)||
      jsonb_build_object(p_month,coalesce(v_state.state#>array['reports',p_month],'{}'::jsonb)||jsonb_build_object(v_link.person_id,v_values)),true);
    v_next:=v_next||jsonb_build_object('revision',v_state.revision+1,'updatedAt',v_now);
    update public.em_dia_states s set state=v_next,revision=s.revision+1,updated_at=v_now where s.group_id=v_link.group_id returning s.* into v_state;
  end if;
  if v_found then
    update em_dia_private.report_revisions r set status=v_status,version=r.version+1,
      base_activity=em_dia_private.activity(v_existing),proposed_report=v_proposed,submitted_at=v_now,
      reviewed_at=null,reviewed_by=null,reviewed_version=null where r.id=v_work.id returning r.* into v_work;
  else
    insert into em_dia_private.report_revisions(group_id,person_id,user_id,month,status,version,base_activity,proposed_report,submitted_at)
    values(v_link.group_id,v_link.person_id,v_user,p_month,v_status,1,em_dia_private.activity(v_existing),v_proposed,v_now)
    returning * into v_work;
  end if;
  return jsonb_build_object('status',v_work.status,'version',v_work.version,'group_id',v_link.group_id,'person_id',v_link.person_id,
    'month',p_month,'revision',v_state.revision,'unchanged',false);
end;
$$;
create or replace function em_dia_private.read_offline_snapshot() returns jsonb
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
  elsif v_role<>'publisher' then raise exception using errcode='42501',message='Current authorized access required.'; end if;
  if v_profile->>'publisher_id' is not null then
    v_binding:=em_dia_private.own_timer_context();v_card:=em_dia_private.read_own_card();v_person:=v_card#>'{state,people,0}';
    if v_role='publisher' then
      select jsonb_build_array(jsonb_build_object('id',g.id,'name',g.name,'created_at',g.created_at)) into v_groups
        from public.em_dia_groups g where g.id=(v_binding->>'group_id')::uuid;
    end if;
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
        if not found then v_row.entries:='{}'::jsonb;v_row.launches:='[]'::jsonb;v_row.version:=0;v_row.updated_at:=null; end if;
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
  elsif v_role='publisher' then raise exception using errcode='42501',message='Personal card required.'; end if;
  if octet_length(v_result::text)>67108864 then raise exception using errcode='22023',message='The authorized offline snapshot exceeds 64 MiB.'; end if;
  return v_result;
end;
$$;
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
  if p_operation_id is null or p_kind is null or p_kind not in ('group_save','month_condition','diary_launch','report_manual','report_diary','annual_goal','annual_retro','timer_change','timer_post')
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
      when 'month_condition' then array['month','conditionKind','expectedRevision']
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
  if p_kind in ('report_manual','report_diary','timer_post') then v_allowed:=v_allowed||array['conditionKind']; end if;
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
  elsif p_kind='timer_post' then
    v_version:=em_dia_private.offline_integer(p_payload->'expectedTimerVersion',1,9007199254740990);
    select t.version into v_actual from em_dia_private.service_timers t where t.group_id=v_group and t.person_id=v_person for update;
    if v_version<>coalesce(v_actual,0) then raise exception using errcode='40001',message='The timer changed outside this offline queue.'; end if;
    v_version:=em_dia_private.offline_integer(p_payload->'expectedHoursVersion',0,9007199254740990);
    select d.version into v_actual from em_dia_private.daily_hours d where d.group_id=v_group and d.person_id=v_person
      and d.month=left(p_payload->>'date',7) for update;
    if v_version<>coalesce(v_actual,0) then raise exception using errcode='40001',message='The diary changed outside this offline queue.'; end if;
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
    when 'month_condition' then
      v_result:=em_dia_private.save_own_condition(p_payload->>'month',p_payload->>'conditionKind',
        em_dia_private.offline_integer(p_payload->'expectedRevision',1,9007199254740990),v_actor,v_group,v_person);
      v_confirmation:=jsonb_build_object('revision',v_result->'revision');
    when 'diary_launch' then
      v_result:=em_dia_private.save_own_hour_launch_note(em_dia_private.offline_uuid(p_payload->'id'),p_payload->>'date',
        em_dia_private.offline_integer(p_payload->'minutes',0,44640,true)::integer,v_note,
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version');
    when 'report_manual' then
      v_result:=em_dia_private.submit_own_report(p_payload->>'month',(p_payload->'report')||case when p_payload ? 'conditionKind' then jsonb_build_object('kind',p_payload->'conditionKind') else '{}'::jsonb end,
        em_dia_private.offline_integer(p_payload->'expectedVersion',0,9007199254740990));
      v_confirmation:=jsonb_build_object('version',v_result->'version','revision',v_result->'revision','status',v_result->'status');
    when 'report_diary' then
      if jsonb_typeof(p_payload->'participated') not in ('boolean','null') then raise exception using errcode='22023',message='Invalid participation value.'; end if;
      v_result:=em_dia_private.submit_own_hours(p_payload->>'month',(p_payload->>'participated')::boolean,
        em_dia_private.offline_integer(p_payload->'studies',0,9999,true)::integer,
        em_dia_private.offline_integer(p_payload->'expectedHoursVersion',0,9007199254740990),
        em_dia_private.offline_integer(p_payload->'expectedReportVersion',0,9007199254740990),p_payload->>'conditionKind');
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
        em_dia_private.offline_integer(p_payload->'expectedHoursVersion',0,9007199254740990),p_payload->>'conditionKind');
      v_timer_version:=(v_result#>>'{timer,version}')::bigint;
      v_confirmation:=jsonb_build_object('timer_version',v_result#>'{timer,version}','hours_version',v_result#>'{diary,version}');
  end case;
  insert into em_dia_private.offline_receipts(actor_id,operation_id,kind,group_id,person_id,payload_hash,confirmation,effective_at,timer_version)
    values(v_actor,p_operation_id,p_kind,v_group,v_person,v_hash,v_confirmation,v_effective,v_timer_version);
  return jsonb_build_object('operation_id',p_operation_id,'kind',p_kind,'replayed',false,'confirmation',v_confirmation);
end;
$$;


create function em_dia_private.assert_own_month_kind(p_month text,p_expected_kind text) returns void
language plpgsql security invoker set search_path='' as $$
declare v_binding jsonb;v_person jsonb;v_context jsonb;
begin
  v_binding:=em_dia_private.own_timer_context();
  perform 1 from public.em_dia_states s where s.group_id=(v_binding->>'group_id')::uuid for update;
  v_context:=em_dia_private.own_hours_context(p_month);
  select p into v_person from public.em_dia_states s cross join lateral jsonb_array_elements(s.state->'people') p
    where s.group_id=(v_binding->>'group_id')::uuid and p->>'id'=v_binding->>'person_id';
  if (p_expected_kind is null and coalesce(v_person->'monthConditions','{}'::jsonb) ? p_month)
    or (p_expected_kind is not null and (p_expected_kind not in ('publisher','regular','auxiliary') or p_expected_kind<>v_context->>'kind')) then
    raise exception using errcode='40001',message='The monthly condition changed. Reload before sending or posting hours.';
  end if;
end;
$$;

create or replace function em_dia_private.submit_own_hours(p_month text,p_participated boolean,p_studies integer,
  p_expected_hours_version bigint,p_expected_report_version bigint,p_expected_kind text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_row em_dia_private.daily_hours;v_minutes integer;v_result jsonb;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if not em_dia_private.has_personal_card() then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_expected_hours_version is null or p_expected_hours_version<0 or p_expected_hours_version>=9007199254740991
    or p_expected_report_version is null or p_expected_report_version<0 or p_expected_report_version>=9007199254740991
    or (p_studies is not null and (p_studies<0 or p_studies>9999)) then
    raise exception using errcode='22023',message='Invalid diary or report values.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found then raise exception using errcode='42501',message='Publisher access is not linked.'; end if;
  perform 1 from public.em_dia_states s where s.group_id=v_link.group_id for update;
  v_context:=em_dia_private.own_hours_context(p_month);
  perform em_dia_private.assert_own_month_kind(p_month,p_expected_kind);
  if (v_context->>'kind') not in ('regular','auxiliary') then
    raise exception using errcode='22023',message='Diary submissions require a pioneer month.';
  end if;
  select * into v_row from em_dia_private.daily_hours d
    where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=p_month for update;
  if not found or v_row.entries='{}'::jsonb then
    raise exception using errcode='22023',message='Record at least one day, including zero when applicable, before sending the diary.';
  end if;
  if v_row.version<>p_expected_hours_version then raise exception using errcode='40001',message='The diary changed. Reload before sending.'; end if;
  select sum((e.value#>>'{}')::integer) into v_minutes from jsonb_each(v_row.entries) e;
  v_result:=em_dia_private.submit_own_report(p_month,jsonb_build_object('participated',case when v_minutes>0 then true else p_participated end,
    'hours',round(v_minutes::numeric/60,2),'studies',p_studies,'kind',v_context->>'kind'),p_expected_report_version);
  return v_result||jsonb_build_object('hours_version',v_row.version,'total_minutes',v_minutes);
end;
$$;
create or replace function em_dia_private.post_own_timer(p_timer_id uuid,p_expected_timer_version bigint,p_launch_id uuid,
  p_date text,p_minutes integer,p_note text,p_expected_hours_version bigint,p_expected_kind text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_context jsonb;v_row em_dia_private.service_timers;
  v_diary_row em_dia_private.daily_hours;v_diary jsonb;v_receipt jsonb;v_now timestamptz;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_context:=em_dia_private.own_timer_context();
  if p_timer_id is null or p_launch_id is null or p_expected_timer_version is null or p_expected_timer_version<0
    or p_expected_timer_version>=9007199254740991 or p_expected_hours_version is null or p_expected_hours_version<0
    or p_expected_hours_version>=9007199254740991 or p_date is null or p_minutes is null then
    raise exception using errcode='22023',message='Invalid timer posting values.';
  end if;
  perform 1 from public.em_dia_states s where s.group_id=(v_context->>'group_id')::uuid for update;
  select * into v_row from em_dia_private.service_timers t
    where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' for update;
  if not found then raise exception using errcode='40001',message='The timer is not available. Reload before posting.'; end if;
  v_now:=clock_timestamp();
  -- A committed receipt wins over a later timer or edited/removed diary item.
  -- Exact retries never insert again or clear a subsequent active session.
  if v_row.last_posted_receipt->>'timer_id'=p_timer_id::text then
    v_receipt:=v_row.last_posted_receipt;
    if v_receipt->>'launch_id'<>p_launch_id::text or v_receipt->>'date'<>p_date
      or (v_receipt->>'minutes')::integer<>p_minutes or v_receipt->>'note'<>coalesce(p_note,'')
      or v_row.last_posted_expected_timer_version<>p_expected_timer_version
      or v_row.last_posted_expected_hours_version<>p_expected_hours_version then
      raise exception using errcode='22023',message='This timer was already posted with different values.';
    end if;
    v_diary:=em_dia_private.read_own_hour_launches(left(p_date,7));
    return jsonb_build_object('timer',em_dia_private.timer_bundle(v_context,v_row,v_now),'diary',v_diary,
      'launch_id',p_launch_id,'receipt',v_receipt,'unchanged',true);
  end if;
  if v_row.version<>p_expected_timer_version or v_row.timer_id is distinct from p_timer_id then
    raise exception using errcode='40001',message='The timer changed. Reload before posting.';
  end if;
  if v_row.status<>'stopped' then raise exception using errcode='22023',message='Stop the timer before posting its hours.'; end if;
  -- Only a new stable UUID may be used: a pre-existing independent launch must
  -- not be relabelled as the result of this timer.
  select * into v_diary_row from em_dia_private.daily_hours d
    where d.group_id=(v_context->>'group_id')::uuid and d.person_id=v_context->>'person_id' and d.month=left(p_date,7) for update;
  if exists(select 1 from jsonb_array_elements(coalesce(v_diary_row.launches,'[]'::jsonb)) e where e->>'id'=p_launch_id::text) then
    raise exception using errcode='22023',message='Choose a new identifier for this timer launch.';
  end if;
  perform em_dia_private.assert_own_month_kind(left(p_date,7),p_expected_kind);
  v_diary:=em_dia_private.save_own_hour_launch_note(p_launch_id,p_date,p_minutes,p_note,p_expected_hours_version);
  v_receipt:=jsonb_build_object('timer_id',p_timer_id,'launch_id',p_launch_id,'date',p_date,
    'minutes',p_minutes,'note',coalesce(p_note,''),'posted_at',v_now);
  update em_dia_private.service_timers t set status='idle',timer_id=null,start_date=null,started_at=null,anchor_at=null,
    stopped_at=null,accumulated_ms=0,version=t.version+1,last_action='post',last_timer_id=p_timer_id,
    last_expected_version=p_expected_timer_version,last_posted_receipt=v_receipt,
    last_posted_expected_timer_version=p_expected_timer_version,last_posted_expected_hours_version=p_expected_hours_version,updated_at=v_now
    where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' returning * into v_row;
  return jsonb_build_object('timer',em_dia_private.timer_bundle(v_context,v_row,v_now),'diary',v_diary,
    'launch_id',p_launch_id,'receipt',v_receipt,'unchanged',false);
end;
$$;

create or replace function em_dia_private.submit_own_hours(p_month text,p_participated boolean,p_studies integer,p_expected_hours_version bigint,p_expected_report_version bigint) returns jsonb
language sql security definer set search_path='' as $$ select em_dia_private.submit_own_hours(p_month,p_participated,p_studies,p_expected_hours_version,p_expected_report_version,null); $$;
create or replace function em_dia_private.post_own_timer(p_timer_id uuid,p_expected_timer_version bigint,p_launch_id uuid,p_date text,p_minutes integer,p_note text,p_expected_hours_version bigint) returns jsonb
language sql security definer set search_path='' as $$ select em_dia_private.post_own_timer(p_timer_id,p_expected_timer_version,p_launch_id,p_date,p_minutes,p_note,p_expected_hours_version,null); $$;
create function public.submit_em_dia_own_hours(p_month text,p_participated boolean,p_studies integer,p_expected_hours_version bigint,p_expected_report_version bigint,p_expected_kind text) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.submit_own_hours(p_month,p_participated,p_studies,p_expected_hours_version,p_expected_report_version,p_expected_kind); $$;
create function public.post_em_dia_own_timer(p_timer_id uuid,p_expected_timer_version bigint,p_launch_id uuid,p_date text,p_minutes integer,p_note text,p_expected_hours_version bigint,p_expected_kind text) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.post_own_timer(p_timer_id,p_expected_timer_version,p_launch_id,p_date,p_minutes,p_note,p_expected_hours_version,p_expected_kind); $$;

create or replace function em_dia_private.assert_state_links(p_group_id uuid,p_state jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group not authorized.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_state->'people') p where not em_dia_private.valid_person_month_conditions(p)) then
    raise exception using errcode='22023',message='The monthly condition and pioneer periods disagree. Reload before saving.';
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
grant create on schema em_dia_private to em_dia_workflow;
alter function em_dia_private.valid_month_conditions(jsonb) owner to em_dia_workflow;
alter function em_dia_private.valid_person_month_conditions(jsonb) owner to em_dia_workflow;
alter function em_dia_private.own_month_kind(jsonb,jsonb,text) owner to em_dia_workflow;
alter function em_dia_private.person_with_month_condition(jsonb,text,text) owner to em_dia_workflow;
alter function em_dia_private.save_own_condition(text,text,bigint,uuid,uuid,text) owner to em_dia_workflow;
alter function em_dia_private.assert_own_month_kind(text,text) owner to em_dia_workflow;
alter function em_dia_private.submit_own_hours(text,boolean,integer,bigint,bigint,text) owner to em_dia_workflow;
alter function em_dia_private.post_own_timer(uuid,bigint,uuid,text,integer,text,bigint,text) owner to em_dia_workflow;
revoke create on schema em_dia_private from em_dia_workflow;
revoke execute on function em_dia_private.assert_own_month_kind(text,text),em_dia_private.submit_own_hours(text,boolean,integer,bigint,bigint,text),em_dia_private.post_own_timer(uuid,bigint,uuid,text,integer,text,bigint,text),public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint,text),public.post_em_dia_own_timer(uuid,bigint,uuid,text,integer,text,bigint,text) from public,anon,authenticated,service_role,em_dia_writer;
grant execute on function em_dia_private.submit_own_hours(text,boolean,integer,bigint,bigint,text),em_dia_private.post_own_timer(uuid,bigint,uuid,text,integer,text,bigint,text),public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint,text),public.post_em_dia_own_timer(uuid,bigint,uuid,text,integer,text,bigint,text) to authenticated;
revoke execute on function em_dia_private.valid_month_conditions(jsonb),em_dia_private.valid_person_month_conditions(jsonb),em_dia_private.own_month_kind(jsonb,jsonb,text),
  em_dia_private.person_with_month_condition(jsonb,text,text),em_dia_private.save_own_condition(text,text,bigint,uuid,uuid,text) from public,anon,authenticated,service_role,em_dia_writer;
grant execute on function em_dia_private.save_own_condition(text,text,bigint,uuid,uuid,text) to authenticated;
create function public.save_em_dia_own_condition(p_month text,p_kind text,p_expected_revision bigint,p_expected_actor_id uuid,p_expected_group_id uuid,p_expected_person_id text) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.save_own_condition(p_month,p_kind,p_expected_revision,p_expected_actor_id,p_expected_group_id,p_expected_person_id); $$;
revoke execute on function public.save_em_dia_own_condition(text,text,bigint,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.save_em_dia_own_condition(text,text,bigint,uuid,uuid,text) to authenticated;

do $$
begin
  if exists(
    with current_rows as (
select 'states' row_type,to_jsonb(s) row_data from public.em_dia_states s
union all select 'members' row_type,to_jsonb(m) row_data from public.em_dia_members m
union all select 'groups' row_type,to_jsonb(g) row_data from public.em_dia_groups g
union all select 'memberships' row_type,to_jsonb(gm) row_data from public.em_dia_group_members gm
union all select 'links' row_type,to_jsonb(l) row_data from em_dia_private.publisher_links l
union all select 'revisions' row_type,to_jsonb(r) row_data from em_dia_private.report_revisions r
union all select 'diaries' row_type,to_jsonb(d) row_data from em_dia_private.daily_hours d
union all select 'legacy' row_type,to_jsonb(ll) row_data from em_dia_private.legacy_group_links ll
union all select 'timers' row_type,to_jsonb(t) row_data from em_dia_private.service_timers t
union all select 'annual' row_type,to_jsonb(a) row_data from em_dia_private.annual_progress a
union all select 'receipts' row_type,to_jsonb(o) row_data from em_dia_private.offline_receipts o
union all select 'profiles',to_jsonb(a) from em_dia_private.account_profiles a
    )
    select 1 from (
      (select row_type,row_data from pg_temp.em_dia_condition_preservation except all select row_type,row_data from current_rows)
      union all
      (select row_type,row_data from current_rows except all select row_type,row_data from pg_temp.em_dia_condition_preservation)
    ) differences
  ) then raise exception 'The monthly condition migration changed existing records.'; end if;
end;
$$;
