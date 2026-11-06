-- Management permission and a trusted own publisher-card binding are independent.
-- Preserve all twelve private datasets; no real account is linked by this migration.
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
create temporary table em_dia_personal_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_personal_preservation
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

-- A manager role and the account's own publisher card are independent.
-- No existing role, card link or stored activity is assigned by this migration.
create function em_dia_private.has_personal_card() returns boolean
language sql stable security invoker set search_path='' as $$
  select em_dia_private.current_user_id() is not null
    and em_dia_private.access_role() in ('admin','superintendent','publisher')
    and exists(select 1 from em_dia_private.publisher_links l where l.user_id=em_dia_private.current_user_id()
      and (em_dia_private.access_role()<>'publisher' or exists(select 1 from public.em_dia_group_members gm
        where gm.user_id=l.user_id and gm.group_id=l.group_id)));
$$;
revoke execute on function em_dia_private.has_personal_card() from public,anon,authenticated,service_role;
grant execute on function em_dia_private.has_personal_card() to em_dia_workflow;
create or replace function em_dia_private.get_access_profile() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id(); v_role text; v_group uuid; v_person text; v_personal_group uuid;
begin
  select m.access_role into v_role from public.em_dia_members m where m.user_id=v_user;
  if v_user is null or v_role is null then raise exception using errcode='42501',message='Account not authorized.'; end if;
  select gm.group_id into v_group from public.em_dia_group_members gm where gm.user_id=v_user;
  select l.person_id,l.group_id into v_person,v_personal_group from em_dia_private.publisher_links l where l.user_id=v_user;
  if v_role='publisher' and (v_person is null or v_personal_group is distinct from v_group) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  return jsonb_build_object('user_id',v_user,'role',v_role,'is_admin',v_role='admin','group_id',v_group,'publisher_id',v_person,'personal_group_id',v_personal_group);
end;
$$;

create or replace function em_dia_private.read_own_card() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_link em_dia_private.publisher_links;
  v_row public.em_dia_states; v_person jsonb; v_reports jsonb; v_revisions jsonb; v_group text; v_state jsonb;
begin
  if v_user is null or not em_dia_private.has_personal_card() then
    raise exception using errcode='42501',message='Publisher access required.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or (em_dia_private.access_role()='publisher' and not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id)) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select * into v_row from public.em_dia_states s where s.group_id=v_link.group_id;
  select p into v_person from jsonb_array_elements(v_row.state->'people') p where p->>'id'=v_link.person_id;
  if v_person is null then raise exception using errcode='42501',message='Publisher card not available.'; end if;
  select g.name into v_group from public.em_dia_groups g where g.id=v_link.group_id;
  select coalesce(jsonb_object_agg(e.key,jsonb_build_object(v_link.person_id,
    em_dia_private.clean_report(e.value->v_link.person_id))),'{}'::jsonb) into v_reports
  from jsonb_each(v_row.state->'reports') e where e.value ? v_link.person_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'month',r.month,'status',r.status,'version',r.version,
    'proposed_report',r.proposed_report,'submitted_at',r.submitted_at,'reviewed_at',r.reviewed_at) order by r.month desc),'[]'::jsonb)
    into v_revisions from em_dia_private.report_revisions r where r.user_id=v_user and r.group_id=v_link.group_id and r.person_id=v_link.person_id;
  -- Explicit construction prevents unknown legacy JSON properties leaking data.
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',v_row.revision,
    'updatedAt',v_row.updated_at,'lastBackupAt',null,
    'settings',jsonb_build_object('congregation',coalesce(v_row.state#>>'{settings,congregation}',''),'group',v_group,'reminder',''),
    'people',jsonb_build_array(em_dia_private.clean_person(v_person)),'reports',v_reports,'reminders','{}'::jsonb,
    'activeMonth',v_row.state->'activeMonth','sourceNote','');
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id,'group_name',v_group,
    'state',v_state,'revision',v_row.revision,'updated_at',v_row.updated_at,'revisions',v_revisions);
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
  if v_report->'received'='true'::jsonb then v_kind:=v_report->>'kind';
  else
    select r->>'kind' into v_kind from jsonb_array_elements(v_person->'roles') r
      where r->>'start'<=p_month and (r->>'end' is null or r->>'end'>=p_month) order by r->>'start' desc limit 1;
    v_kind:=coalesce(v_kind,'publisher');
  end if;
  if v_kind not in ('publisher','regular','auxiliary') or v_kind is null then
    raise exception using errcode='22023',message='The month condition is invalid.';
  end if;
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id,'month',p_month,
    'kind',v_kind,'closed',p_month<left(v_today,7),'today',v_today);
end;
$$;

create or replace function em_dia_private.save_own_hours(p_date text,p_minutes integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_day date;v_month text;v_row em_dia_private.daily_hours;v_version bigint;v_count bigint;v_id uuid;v_result jsonb;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if not em_dia_private.has_personal_card() then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_date is null or p_date !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991
    or (p_minutes is not null and (p_minutes<0 or p_minutes>44640)) then
    raise exception using errcode='22023',message='Invalid diary date, accumulated hours or version.';
  end if;
  begin v_day:=p_date::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='22023',message='Invalid calendar date.';
  end;
  if to_char(v_day,'YYYY-MM-DD')<>p_date then raise exception using errcode='22023',message='Invalid calendar date.'; end if;
  v_month:=left(p_date,7);
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found then raise exception using errcode='42501',message='Publisher access is not linked.'; end if;
  perform 1 from public.em_dia_states s where s.group_id=v_link.group_id for update;
  v_context:=em_dia_private.own_hours_context(v_month);
  if (v_context->>'kind') not in ('regular','auxiliary') or p_date>(v_context->>'today') then
    raise exception using errcode='22023',message='Accumulated hours require a pioneer month and a non-future date.';
  end if;
  select * into v_row from em_dia_private.daily_hours d
    where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=v_month for update;
  v_version:=coalesce(v_row.version,0);
  if p_expected_version>v_version then raise exception using errcode='40001',message='The diary version is invalid. Reload before saving.'; end if;
  if (p_minutes is null and not(coalesce(v_row.entries,'{}'::jsonb) ? p_date))
    or (p_minutes is not null and v_row.entries->p_date=to_jsonb(p_minutes)) then
    return em_dia_private.hours_bundle(v_context,coalesce(v_row.entries,'{}'::jsonb),v_version,v_row.updated_at)
      ||jsonb_build_object('unchanged',true);
  end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='The diary changed. Reload before saving.'; end if;
  select count(*),min(e->>'id')::uuid into v_count,v_id
    from jsonb_array_elements(coalesce(v_row.launches,'[]'::jsonb)) e where e->>'date'=p_date;
  if v_count>1 then
    raise exception using errcode='22023',message='Update the app to edit or remove the separate launches in this date.';
  end if;
  v_id:=coalesce(v_id,gen_random_uuid());
  v_result:=em_dia_private.save_own_hour_launch_note(v_id,p_date,p_minutes,null,p_expected_version);
  return v_result-'launches';
end;
$$;

create or replace function em_dia_private.save_own_hour_launch_note(p_id uuid,p_date text,p_minutes integer,p_note text,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_day date;v_month text;v_row em_dia_private.daily_hours;v_row_found boolean;v_item jsonb;v_item_found boolean;
  v_launches jsonb;v_next jsonb;v_entries jsonb;v_version bigint;v_note text;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if not em_dia_private.has_personal_card() then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_id is null or p_date is null or p_date !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991
    or (p_minutes is not null and (p_minutes<0 or p_minutes>44640 or (p_note is not null and char_length(p_note)>1000))) then
    raise exception using errcode='22023',message='Invalid launch, date, accumulated hours, note or version.';
  end if;
  begin v_day:=p_date::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='22023',message='Invalid calendar date.';
  end;
  if to_char(v_day,'YYYY-MM-DD')<>p_date then raise exception using errcode='22023',message='Invalid calendar date.'; end if;
  v_month:=left(p_date,7);
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found then raise exception using errcode='42501',message='Publisher access is not linked.'; end if;
  -- Preserve the shared lock order: account, group state, monthly diary.
  perform 1 from public.em_dia_states s where s.group_id=v_link.group_id for update;
  v_context:=em_dia_private.own_hours_context(v_month);
  if (v_context->>'kind') not in ('regular','auxiliary') or p_date>(v_context->>'today') then
    raise exception using errcode='22023',message='Accumulated hours require a pioneer month and a non-future date.';
  end if;
  select * into v_row from em_dia_private.daily_hours d
    where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=v_month for update;
  v_row_found:=found;v_launches:=coalesce(v_row.launches,'[]'::jsonb);v_version:=coalesce(v_row.version,0);
  if p_expected_version>v_version then raise exception using errcode='40001',message='The diary version is invalid. Reload before saving.'; end if;
  select e into v_item from jsonb_array_elements(v_launches) e where e->>'id'=p_id::text;
  v_item_found:=found;
  if v_item_found and v_item->>'date'<>p_date then
    raise exception using errcode='22023',message='A saved launch keeps its original date.';
  end if;
  -- NULL is used by older clients to preserve a note they cannot edit.
  v_note:=coalesce(p_note,v_item->>'note','');
  if v_item_found and p_minutes is not null and (v_item->>'minutes')::integer=p_minutes
    and coalesce(v_item->>'note','')=v_note then
    return em_dia_private.hour_launches_bundle(v_context,v_row.entries,v_launches,v_version,v_row.updated_at)
      ||jsonb_build_object('unchanged',true);
  end if;
  if not v_item_found and p_minutes is null then
    if p_expected_version<v_version then
      return em_dia_private.hour_launches_bundle(v_context,v_row.entries,v_launches,v_version,v_row.updated_at)
        ||jsonb_build_object('unchanged',true);
    end if;
    raise exception using errcode='22023',message='The launch is not available. Reload before removing it.';
  end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='The diary changed. Reload before saving.'; end if;
  if v_item_found then
    select coalesce(jsonb_agg(case when e.value->>'id'=p_id::text then
      jsonb_build_object('id',p_id,'date',p_date,'minutes',p_minutes,'note',v_note) else e.value end order by e.ordinality),'[]'::jsonb)
      into v_next from jsonb_array_elements(v_launches) with ordinality e(value,ordinality)
      where p_minutes is not null or e.value->>'id'<>p_id::text;
  else
    v_next:=v_launches||jsonb_build_array(jsonb_build_object('id',p_id,'date',p_date,'minutes',p_minutes,'note',v_note));
  end if;
  v_entries:=em_dia_private.launches_entries(v_next);
  if not em_dia_private.valid_hour_launches(v_month,v_entries,v_next) then
    raise exception using errcode='22023',message='Check the launches and notes. The diary total cannot exceed 744 hours in one month.';
  end if;
  if v_row_found then
    update em_dia_private.daily_hours d set entries=v_entries,launches=v_next,version=d.version+1,updated_at=statement_timestamp()
      where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=v_month returning * into v_row;
  else
    insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version,updated_at)
      values(v_link.group_id,v_link.person_id,v_month,v_entries,v_next,1,statement_timestamp()) returning * into v_row;
  end if;
  return em_dia_private.hour_launches_bundle(v_context,v_row.entries,v_row.launches,v_row.version,v_row.updated_at)
    ||jsonb_build_object('unchanged',false);
end;
$$;

create or replace function em_dia_private.submit_own_hours(p_month text,p_participated boolean,p_studies integer,
  p_expected_hours_version bigint,p_expected_report_version bigint) returns jsonb
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
    'hours',round(v_minutes::numeric/60,2),'studies',p_studies),p_expected_report_version);
  return v_result||jsonb_build_object('hours_version',v_row.version,'total_minutes',v_minutes);
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
  if v_existing->'received'='true'::jsonb then v_kind:=v_existing->>'kind';
  else
    select r->>'kind' into v_kind from jsonb_array_elements(v_person->'roles') r
    where r->>'start'<=p_month and (r->>'end' is null or r->>'end'>=p_month) order by r->>'start' desc limit 1;
    v_kind:=coalesce(v_kind,'publisher');
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

create or replace function em_dia_private.own_timer_context() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_state jsonb;
begin
  if v_user is null or not em_dia_private.has_personal_card() then
    raise exception using errcode='42501',message='Publisher access required.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or (em_dia_private.access_role()='publisher' and not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id)) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select s.state into v_state from public.em_dia_states s where s.group_id=v_link.group_id;
  if not exists(select 1 from jsonb_array_elements(v_state->'people') p where p->>'id'=v_link.person_id) then
    raise exception using errcode='42501',message='Publisher card not available.';
  end if;
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id);
end;
$$;

create or replace function em_dia_private.provision_access(p_user_id uuid,p_role text default null,p_group_id uuid default null,p_new_group_name text default null)
returns public.em_dia_groups language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_old_role text; v_role text;
  v_group public.em_dia_groups; v_link em_dia_private.publisher_links; v_name text:=nullif(btrim(p_new_group_name),'');
begin
  if v_user is null or p_user_id is null then raise exception using errcode='42501',message='Administrator access required.'; end if;
  -- Serializes simultaneous attempts to remove the last administrator.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('em-dia-access-role-administration',0));
  perform em_dia_private.lock_accounts(array[v_user,p_user_id]);
  if not em_dia_private.is_admin() then raise exception using errcode='42501',message='Administrator access required.'; end if;
  if ((p_group_id is null)=(v_name is null)) or (p_role is not null and p_role not in ('admin','superintendent')) then
    raise exception using errcode='22023',message='Choose a manager profile and a group.';
  end if;
  select m.access_role into v_old_role from public.em_dia_members m where m.user_id=p_user_id;
  v_role:=coalesce(p_role,v_old_role,'superintendent');
  if v_role='publisher' then
    select * into v_link from em_dia_private.publisher_links l where l.user_id=p_user_id;
    if v_link.group_id=p_group_id and v_name is null then
      select * into strict v_group from public.em_dia_groups g where g.id=p_group_id;
      return v_group;
    end if;
    raise exception using errcode='22023',message='Transfer the publisher card to change its group.';
  end if;
  if v_old_role='admin' and v_role<>'admin' and not exists(
    select 1 from public.em_dia_members m where m.is_admin and m.user_id<>p_user_id) then
    raise exception using errcode='22023',message='The last administrator cannot be removed.';
  end if;
  if p_group_id is not null then
    select * into v_group from public.em_dia_groups g where g.id=p_group_id;
    if not found then raise exception using errcode='22023',message='Group not available.'; end if;
  else
    if char_length(v_name)>80 or v_name~'[[:cntrl:]]' then raise exception using errcode='22023',message='Invalid group name.'; end if;
    insert into public.em_dia_groups(name,created_by) values(v_name,v_user) returning * into v_group;
  end if;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(p_user_id,v_role='admin',v_role)
    on conflict(user_id) do update set is_admin=excluded.is_admin,access_role=excluded.access_role;
  -- Promotion or changing management group preserves the independent personal card.
  insert into public.em_dia_group_members(group_id,user_id) values(v_group.id,p_user_id)
    on conflict(user_id) do update set group_id=excluded.group_id;
  return v_group;
end;
$$;

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
  if v_linked_user is not null and exists(select 1 from public.em_dia_members m where m.user_id=v_linked_user and m.access_role='publisher') then update public.em_dia_group_members gm set group_id=p_to_group_id where gm.user_id=v_linked_user; end if;
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
  elsif v_role='publisher' then raise exception using errcode='42501',message='Personal card required.'; end if;
  if octet_length(v_result::text)>67108864 then raise exception using errcode='22023',message='The authorized offline snapshot exceeds 64 MiB.'; end if;
  return v_result;
end;
$$;

create function em_dia_private.list_personal_bindings() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.is_admin() then
    raise exception using errcode='42501',message='Administrator access required.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id',l.user_id,'group_id',l.group_id,'person_id',l.person_id) order by l.user_id)
    from em_dia_private.publisher_links l join public.em_dia_members m on m.user_id=l.user_id
    where m.access_role in ('admin','superintendent')),'[]'::jsonb);
end;
$$;
create function em_dia_private.bind_personal_card(p_user_id uuid,p_group_id uuid,p_person_id text,
  p_expected_group_id uuid,p_expected_person_id text,p_expected_actor_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_role text;
  v_existing uuid;v_group uuid;v_now timestamptz:=statement_timestamp();
begin
  if v_actor is null or p_user_id is null or p_expected_actor_id is null or v_actor<>p_expected_actor_id then raise exception using errcode='42501',message='Administrator access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_actor,p_user_id]);
  if not em_dia_private.is_admin() then raise exception using errcode='42501',message='Administrator access required.'; end if;
  select m.access_role into v_role from public.em_dia_members m where m.user_id=p_user_id;
  if v_role is null or v_role not in ('admin','superintendent') then
    raise exception using errcode='42501',message='An existing manager account is required.';
  end if;
  if (p_group_id is null)<>(p_person_id is null) or (p_expected_group_id is null)<>(p_expected_person_id is null)
    or p_person_id is not null and (p_person_id !~ '^[a-zA-Z0-9_-]{1,100}$' or p_person_id in ('__proto__','constructor','prototype')) then
    raise exception using errcode='22023',message='Invalid personal card selection.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=p_user_id;
  if v_link.group_id is distinct from p_expected_group_id or v_link.person_id is distinct from p_expected_person_id then
    raise exception using errcode='40001',message='The personal card binding changed. Reload before assigning.';
  end if;
  -- Serialize card existence and uniqueness with transfers and state writes.
  for v_group in select distinct g from unnest(array[v_link.group_id,p_group_id]) g where g is not null order by g loop
    perform 1 from public.em_dia_states s where s.group_id=v_group for update;
  end loop;
  if p_group_id is not null then
    if not exists(select 1 from public.em_dia_states s cross join lateral jsonb_array_elements(s.state->'people') p
      where s.group_id=p_group_id and p->>'id'=p_person_id) then
      raise exception using errcode='22023',message='Publisher card not available.';
    end if;
    select l.user_id into v_existing from em_dia_private.publisher_links l where l.group_id=p_group_id and l.person_id=p_person_id;
    if v_existing is not null and v_existing<>p_user_id then
      raise exception using errcode='22023',message='Publisher card already has an account.';
    end if;
  end if;
  if v_link.group_id is not distinct from p_group_id and v_link.person_id is not distinct from p_person_id then
    return jsonb_build_object('user_id',p_user_id,'group_id',p_group_id,'person_id',p_person_id);
  end if;
  if p_group_id is null then delete from em_dia_private.publisher_links l where l.user_id=p_user_id;
  else
    insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(p_user_id,p_group_id,p_person_id)
      on conflict(user_id) do update set group_id=excluded.group_id,person_id=excluded.person_id;
    update em_dia_private.report_revisions r set user_id=p_user_id
      where r.group_id=p_group_id and r.person_id=p_person_id and r.user_id<>p_user_id;
  end if;
  -- Keep management membership/role intact; invalidate stale manager state copies.
  update public.em_dia_states s set revision=s.revision+1,updated_at=v_now,
    state=s.state||jsonb_build_object('revision',s.revision+1,'updatedAt',v_now)
    where s.group_id in (v_link.group_id,p_group_id);
  return jsonb_build_object('user_id',p_user_id,'group_id',p_group_id,'person_id',p_person_id);
end;
$$;
grant create on schema em_dia_private to em_dia_workflow;
alter function em_dia_private.has_personal_card() owner to em_dia_workflow;
alter function em_dia_private.list_personal_bindings() owner to em_dia_workflow;
alter function em_dia_private.bind_personal_card(uuid,uuid,text,uuid,text,uuid) owner to em_dia_workflow;
revoke create on schema em_dia_private from em_dia_workflow;
revoke execute on function em_dia_private.list_personal_bindings(),em_dia_private.bind_personal_card(uuid,uuid,text,uuid,text,uuid) from public,anon,authenticated,service_role,em_dia_writer;
grant execute on function em_dia_private.list_personal_bindings(),em_dia_private.bind_personal_card(uuid,uuid,text,uuid,text,uuid) to authenticated;
create function public.list_em_dia_personal_bindings() returns jsonb
language sql stable security invoker set search_path='' as $$ select em_dia_private.list_personal_bindings(); $$;
create function public.bind_em_dia_personal_card(p_user_id uuid,p_group_id uuid,p_person_id text,p_expected_group_id uuid,p_expected_person_id text,p_expected_actor_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.bind_personal_card(p_user_id,p_group_id,p_person_id,p_expected_group_id,p_expected_person_id,p_expected_actor_id); $$;
revoke execute on function public.list_em_dia_personal_bindings(),public.bind_em_dia_personal_card(uuid,uuid,text,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_em_dia_personal_bindings(),public.bind_em_dia_personal_card(uuid,uuid,text,uuid,text,uuid) to authenticated;

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
      (select row_type,row_data from pg_temp.em_dia_personal_preservation except all select row_type,row_data from current_rows)
      union all
      (select row_type,row_data from current_rows except all select row_type,row_data from pg_temp.em_dia_personal_preservation)
    ) differences
  ) then raise exception 'The personal card migration changed existing records.'; end if;
end;
$$;
