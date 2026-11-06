-- Private name and avatar belong to the account, never to a group or card.
-- Public wrappers expose only the authenticated owner, without Auth metadata.
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
  em_dia_private.offline_receipts in share mode nowait;
create temporary table em_dia_profile_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_profile_preservation
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
union all select 'receipts' row_type,to_jsonb(o) row_data from em_dia_private.offline_receipts o;

create function em_dia_private.valid_account_avatar(p_avatar text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_encoded text;v_bytes bytea;v_length integer;
begin
  if p_avatar is null then return true; end if;
  if octet_length(p_avatar)>140000 or left(p_avatar,23)<>'data:image/jpeg;base64,' then return false; end if;
  v_encoded:=substring(p_avatar from 24);
  if v_encoded='' or length(v_encoded)%4<>0 or
    v_encoded !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then return false; end if;
  v_bytes:=decode(v_encoded,'base64');v_length:=octet_length(v_bytes);
  if v_length<5 or v_length>104982 or substring(v_bytes from 1 for 3)<>decode('ffd8ff','hex') or
    substring(v_bytes from v_length-1 for 2)<>decode('ffd9','hex') then return false; end if;
  -- PostgreSQL has no image decoder here. The browser re-encodes the image;
  -- this envelope check rejects remote URLs, SVG, malformed base64 and MIME tricks.
  return replace(encode(v_bytes,'base64'),E'\n','')=v_encoded;
exception when invalid_parameter_value or data_exception then return false;
end;
$$;

create table em_dia_private.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check(char_length(display_name)<=80 and display_name=btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  avatar_data text check(em_dia_private.valid_account_avatar(avatar_data)),
  version bigint not null check(version between 1 and 9007199254740990),
  updated_at timestamptz not null default clock_timestamp()
);
alter table em_dia_private.account_profiles enable row level security;
alter table em_dia_private.account_profiles force row level security;
revoke all on em_dia_private.account_profiles from public,anon,authenticated,service_role,em_dia_writer,em_dia_workflow;
grant select,insert,update on em_dia_private.account_profiles to em_dia_workflow;
create policy em_dia_account_profile_select on em_dia_private.account_profiles for select to em_dia_workflow
  using(user_id=(select em_dia_private.current_user_id()));
create policy em_dia_account_profile_insert on em_dia_private.account_profiles for insert to em_dia_workflow
  with check(user_id=(select em_dia_private.current_user_id()));
create policy em_dia_account_profile_update on em_dia_private.account_profiles for update to em_dia_workflow
  using(user_id=(select em_dia_private.current_user_id())) with check(user_id=(select em_dia_private.current_user_id()));

create function em_dia_private.read_own_account_profile(p_expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id();v_access jsonb;v_row em_dia_private.account_profiles;
begin
  if v_user is null or p_expected_user_id is distinct from v_user then
    raise exception using errcode='42501',message='Current account access required.';
  end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_access:=em_dia_private.get_access_profile();
  if v_access->>'role' not in ('admin','superintendent','publisher') or v_access->>'user_id' is distinct from v_user::text then
    raise exception using errcode='42501',message='Authorized account access required.';
  end if;
  select * into v_row from em_dia_private.account_profiles p where p.user_id=v_user;
  return jsonb_build_object('user_id',v_user,'display_name',coalesce(v_row.display_name,''),'avatar_data',v_row.avatar_data,
    'version',coalesce(v_row.version,0),'updated_at',v_row.updated_at);
end;
$$;

create function em_dia_private.save_own_account_profile(p_display_name text,p_avatar_data text,p_expected_version bigint,p_expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id();v_access jsonb;v_row em_dia_private.account_profiles;v_name text;v_version bigint;
begin
  if v_user is null or p_expected_user_id is distinct from v_user then
    raise exception using errcode='42501',message='Current account access required.';
  end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_access:=em_dia_private.get_access_profile();
  if v_access->>'role' not in ('admin','superintendent','publisher') or v_access->>'user_id' is distinct from v_user::text then
    raise exception using errcode='42501',message='Authorized account access required.';
  end if;
  if p_display_name is null or char_length(p_display_name)>80 or p_display_name ~ '[[:cntrl:]]' or
    p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740990 or
    not em_dia_private.valid_account_avatar(p_avatar_data) then
    raise exception using errcode='22023',message='Invalid account name, avatar or version.';
  end if;
  v_name:=btrim(p_display_name);
  select * into v_row from em_dia_private.account_profiles p where p.user_id=v_user for update;
  v_version:=coalesce(v_row.version,0);
  -- Exact CAS precedes equality: a noop must not inherit an external version.
  if p_expected_version<>v_version then
    raise exception using errcode='40001',message='The account profile changed. Reload before saving.';
  end if;
  if v_name=coalesce(v_row.display_name,'') and p_avatar_data is not distinct from v_row.avatar_data then
    return jsonb_build_object('user_id',v_user,'display_name',v_name,'avatar_data',p_avatar_data,
      'version',v_version,'updated_at',v_row.updated_at);
  end if;
  insert into em_dia_private.account_profiles(user_id,display_name,avatar_data,version,updated_at)
    values(v_user,v_name,p_avatar_data,v_version+1,clock_timestamp())
    on conflict(user_id) do update set display_name=excluded.display_name,avatar_data=excluded.avatar_data,
      version=excluded.version,updated_at=excluded.updated_at returning * into v_row;
  return jsonb_build_object('user_id',v_user,'display_name',v_row.display_name,'avatar_data',v_row.avatar_data,
    'version',v_row.version,'updated_at',v_row.updated_at);
end;
$$;

grant create on schema em_dia_private to em_dia_workflow;
do $$
declare v_function record;
begin
  for v_function in select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='em_dia_private'
    and p.proname=any(array['valid_account_avatar','read_own_account_profile','save_own_account_profile']) loop
    execute format('alter function %I.%I(%s) owner to em_dia_workflow',v_function.nspname,v_function.proname,v_function.args);
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role,em_dia_writer',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;
revoke create on schema em_dia_private from em_dia_workflow;
grant execute on function em_dia_private.read_own_account_profile(uuid),em_dia_private.save_own_account_profile(text,text,bigint,uuid) to authenticated;
create function public.read_em_dia_own_account_profile(p_expected_user_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.read_own_account_profile(p_expected_user_id); $$;
create function public.save_em_dia_own_account_profile(p_display_name text,p_avatar_data text,p_expected_version bigint,p_expected_user_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select em_dia_private.save_own_account_profile(p_display_name,p_avatar_data,p_expected_version,p_expected_user_id); $$;
revoke execute on function public.read_em_dia_own_account_profile(uuid),public.save_em_dia_own_account_profile(text,text,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.read_em_dia_own_account_profile(uuid),public.save_em_dia_own_account_profile(text,text,bigint,uuid) to authenticated;

do $$
begin
  if exists(select 1 from em_dia_private.account_profiles) then raise exception 'Account profiles must start empty.'; end if;
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
    )
    select 1 from (
      (select row_type,row_data from pg_temp.em_dia_profile_preservation except all select row_type,row_data from current_rows)
      union all
      (select row_type,row_data from current_rows except all select row_type,row_data from pg_temp.em_dia_profile_preservation)
    ) differences
  ) then raise exception 'The account profile migration changed existing records.'; end if;
end;
$$;
