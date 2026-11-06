-- Keep the full private diary while marking non-pioneer months inactive.
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
create temporary table em_dia_inactive_snapshot_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_inactive_snapshot_preservation
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
        v_bundle:=em_dia_private.read_own_hour_launches(v_month);
        v_bundle:=v_bundle||jsonb_build_object('can_use',(v_bundle->>'kind') in ('regular','auxiliary'));
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
      (select row_type,row_data from pg_temp.em_dia_inactive_snapshot_preservation except all select row_type,row_data from current_rows)
      union all
      (select row_type,row_data from current_rows except all select row_type,row_data from pg_temp.em_dia_inactive_snapshot_preservation)
    ) differences
  ) then raise exception 'The inactive diary snapshot migration changed existing records.'; end if;
end;
$$;
