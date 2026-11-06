-- Allow current-month pioneer submissions; future months remain prohibited.
-- No existing row, access grant, ownership, timer or annual value is changed.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,
  em_dia_private.report_revisions,em_dia_private.daily_hours,
  em_dia_private.legacy_group_links,em_dia_private.service_timers,
  em_dia_private.annual_progress in share mode nowait;
create temporary table em_dia_current_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_current_preservation
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
create temporary table em_dia_current_routines on commit drop as
select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig from pg_proc p
where p.oid in ('em_dia_private.submit_own_hours(text,boolean,integer,bigint,bigint)'::regprocedure,
  'em_dia_private.submit_own_report(text,jsonb,bigint)'::regprocedure);

create or replace function em_dia_private.submit_own_hours(p_month text,p_participated boolean,p_studies integer,
  p_expected_hours_version bigint,p_expected_report_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_row em_dia_private.daily_hours;v_minutes integer;v_result jsonb;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
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
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or p_month>left(v_date,7) or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid report month or version.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id) then
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

do $$
begin
  if exists(select 1 from pg_temp.em_dia_current_routines old join pg_proc p on p.oid=old.oid
    where (old.proowner,old.proacl,old.prosecdef,old.proconfig) is distinct from (p.proowner,p.proacl,p.prosecdef,p.proconfig)) then
    raise exception 'Submission routine ownership, access or security settings changed.';
  end if;
  if exists(
    (select row_type,row_data from pg_temp.em_dia_current_preservation except
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
      select row_type,row_data from pg_temp.em_dia_current_preservation)
  ) then raise exception 'The current-month submission migration changed existing records.'; end if;
end;
$$;
