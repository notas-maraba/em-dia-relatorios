-- Accumulated hours and optional private launch notes. No existing row changes.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,
  em_dia_private.report_revisions,em_dia_private.daily_hours,
  em_dia_private.legacy_group_links in share mode nowait;
create temporary table em_dia_note_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_note_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'members',to_jsonb(m) from public.em_dia_members m
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll;

-- Calendar dates remain valid, but a date can hold accumulated hours. The
-- existing monthly report maximum (744 hours) is the total diary bound.
create or replace function em_dia_private.valid_daily_entries(p_month text,p_entries jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_entry record;v_day date;v_value numeric;v_total numeric:=0;
begin
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or p_entries is null or jsonb_typeof(p_entries)<>'object' or octet_length(p_entries::text)>4096 then return false; end if;
  if (select count(*) from jsonb_object_keys(p_entries))>31 then return false; end if;
  for v_entry in select key,value from jsonb_each(p_entries) loop
    if v_entry.key !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-[0-3][0-9]$'
      or left(v_entry.key,7)<>p_month or jsonb_typeof(v_entry.value)<>'number' then return false; end if;
    v_day:=v_entry.key::date;
    if to_char(v_day,'YYYY-MM-DD')<>v_entry.key then return false; end if;
    v_value:=(v_entry.value#>>'{}')::numeric;
    if v_value<0 or v_value>44640 or trunc(v_value)<>v_value then return false; end if;
    v_total:=v_total+v_value;
    if v_total>44640 then return false; end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create or replace function em_dia_private.valid_hour_launches(p_month text,p_entries jsonb,p_launches jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_item jsonb;v_id uuid;v_ids uuid[]:='{}'::uuid[];v_day date;v_minutes numeric;
begin
  if not em_dia_private.valid_daily_entries(p_month,p_entries)
    or p_launches is null or jsonb_typeof(p_launches)<>'array'
    or jsonb_array_length(p_launches)>1000 or octet_length(p_launches::text)>262144 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_launches) loop
    if jsonb_typeof(v_item)<>'object' or not(v_item ?& array['id','date','minutes'])
      or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('id','date','minutes','note'))
      or jsonb_typeof(v_item->'id')<>'string' or jsonb_typeof(v_item->'date')<>'string'
      or jsonb_typeof(v_item->'minutes')<>'number'
      or (v_item ? 'note' and (jsonb_typeof(v_item->'note')<>'string' or char_length(v_item->>'note')>1000))
      or v_item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_item->>'date' !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      or left(v_item->>'date',7)<>p_month then return false; end if;
    v_id:=(v_item->>'id')::uuid;
    if v_id=any(v_ids) then return false; end if;
    v_ids:=array_append(v_ids,v_id);
    v_day:=(v_item->>'date')::date;
    if to_char(v_day,'YYYY-MM-DD')<>v_item->>'date' then return false; end if;
    v_minutes:=(v_item->>'minutes')::numeric;
    if v_minutes<0 or v_minutes>44640 or trunc(v_minutes)<>v_minutes then return false; end if;
  end loop;
  return em_dia_private.launches_entries(p_launches)=p_entries;
exception when others then return false;
end;
$$;

-- Explicit projection makes old three-field launches readable with a blank
-- note. No stored launch is rewritten to add that optional property.
create or replace function em_dia_private.hour_launches_bundle(p_context jsonb,p_entries jsonb,p_launches jsonb,
  p_version bigint,p_updated_at timestamptz) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select em_dia_private.hours_bundle(p_context,p_entries,p_version,p_updated_at)
    ||jsonb_build_object('launches',coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.value->'id','date',e.value->'date','minutes',e.value->'minutes',
      'note',coalesce(e.value->>'note','')) order by e.ordinality)
      from jsonb_array_elements(p_launches) with ordinality e(value,ordinality)),'[]'::jsonb));
$$;

create function em_dia_private.save_own_hour_launch_note(p_id uuid,p_date text,p_minutes integer,p_note text,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_day date;v_month text;v_row em_dia_private.daily_hours;v_row_found boolean;v_item jsonb;v_item_found boolean;
  v_launches jsonb;v_next jsonb;v_entries jsonb;v_version bigint;v_note text;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
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

-- Compatibility clients cannot erase an observation they do not know exists.
create or replace function em_dia_private.save_own_hour_launch(p_id uuid,p_date text,p_minutes integer,p_expected_version bigint) returns jsonb
language sql security definer set search_path='' as $$
  select em_dia_private.save_own_hour_launch_note(p_id,p_date,p_minutes,null,p_expected_version);
$$;

create or replace function em_dia_private.save_own_hours(p_date text,p_minutes integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_day date;v_month text;v_row em_dia_private.daily_hours;v_version bigint;v_count bigint;v_id uuid;v_result jsonb;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
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

grant create on schema em_dia_private to em_dia_workflow;
alter function em_dia_private.save_own_hour_launch_note(uuid,text,integer,text,bigint) owner to em_dia_workflow;
revoke create on schema em_dia_private from em_dia_workflow;
revoke execute on function em_dia_private.save_own_hour_launch_note(uuid,text,integer,text,bigint)
  from public,anon,authenticated,service_role,em_dia_writer;
grant execute on function em_dia_private.save_own_hour_launch_note(uuid,text,integer,text,bigint) to authenticated;

create function public.save_em_dia_own_hour_launch_note(p_id uuid,p_date text,p_minutes integer,p_note text,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.save_own_hour_launch_note(p_id,p_date,p_minutes,p_note,p_expected_version);
$$;
revoke execute on function public.save_em_dia_own_hour_launch_note(uuid,text,integer,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.save_em_dia_own_hour_launch_note(uuid,text,integer,text,bigint) to authenticated;

-- All eight existing data sets, including the full stored launches, must be
-- identical at commit. The feature changes routines and validation only.
do $$
begin
  if exists(
    (select row_type,row_data from pg_temp.em_dia_note_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll))
    union all
    ((select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll) except
      select row_type,row_data from pg_temp.em_dia_note_preservation)
  ) then raise exception 'The accumulated-hours migration changed existing records.'; end if;
  if exists(select 1 from em_dia_private.daily_hours d
    where not em_dia_private.valid_hour_launches(d.month,d.entries,d.launches)) then
    raise exception 'An existing diary is incompatible with accumulated hours or optional notes.';
  end if;
end;
$$;
