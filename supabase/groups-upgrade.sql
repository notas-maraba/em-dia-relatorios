-- Em dia: upgrade the existing single source of state to isolated groups.
-- Apply once, as postgres, in one transaction after taking a private backup.
-- No account IDs, e-mails, passwords or publisher records belong in this file.

alter table public.em_dia_members add column is_admin boolean not null default false;

create table public.em_dia_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 80 and name !~ '[[:cntrl:]]'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index em_dia_groups_name_key on public.em_dia_groups(lower(name));

create table public.em_dia_group_members (
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  user_id uuid not null references public.em_dia_members(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id),
  constraint em_dia_group_members_one_group_per_user unique(user_id)
);

-- A stable, private route for already-open clients from the previous version.
-- An account reassignment must never redirect an old form's JSON to a new group.
create table em_dia_private.legacy_group_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_id uuid not null references public.em_dia_groups(id) on delete cascade
);

-- Keep the original state rows in place. Only their grouping metadata changes.
-- The temporary mapping prevents user identities from being baked into source.
do $$ begin
  if exists (
    select 1 from public.em_dia_states s left join public.em_dia_members m on m.user_id=s.owner_id
    where m.user_id is null
  ) then
    raise exception 'A legacy state has no approved owner; reconcile authorization before upgrading.';
  end if;
end $$;

create temporary table em_dia_group_upgrade_map on commit drop as
select s.owner_id, gen_random_uuid() as group_id,
  case when count(*) over()=1 then 'Grupo inicial'
       else 'Grupo inicial ' || row_number() over(order by s.owner_id)::text end as group_name
from public.em_dia_states s;

insert into public.em_dia_groups(id,name,created_by)
select group_id,group_name,owner_id from em_dia_group_upgrade_map;
insert into public.em_dia_group_members(group_id,user_id)
select group_id,owner_id from em_dia_group_upgrade_map;
insert into em_dia_private.legacy_group_links(user_id,group_id)
select owner_id,group_id from em_dia_group_upgrade_map;
update public.em_dia_members m set is_admin=true
from em_dia_group_upgrade_map x where x.owner_id=m.user_id;

alter table public.em_dia_states add column group_id uuid;
update public.em_dia_states s set group_id=x.group_id
from em_dia_group_upgrade_map x where x.owner_id=s.owner_id;
alter table public.em_dia_states alter column group_id set not null;
alter table public.em_dia_states drop constraint em_dia_states_pkey;
alter table public.em_dia_states add primary key(group_id);
alter table public.em_dia_states add constraint em_dia_states_group_id_fkey
  foreign key(group_id) references public.em_dia_groups(id) on delete cascade;
alter table public.em_dia_states alter column owner_id drop not null;
alter table public.em_dia_states drop constraint em_dia_states_owner_id_fkey;
alter table public.em_dia_states add constraint em_dia_states_owner_id_fkey
  foreign key(owner_id) references auth.users(id) on delete set null;

-- Canonical identity comes from the server-verified PostgREST JWT context.
-- auth is a managed schema: its USAGE cannot be delegated to our NOLOGIN role.
create function em_dia_private.current_user_id() returns uuid
language sql stable security invoker set search_path=''
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),
    (nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')
  )::uuid;
$$;

create function em_dia_private.is_authorized() returns boolean
language sql stable security invoker set search_path=''
as $$
  select exists(select 1 from public.em_dia_members m
    where m.user_id=(select em_dia_private.current_user_id()));
$$;

create function em_dia_private.is_admin() returns boolean
language sql stable security invoker set search_path=''
as $$
  select exists(select 1 from public.em_dia_members m
    where m.user_id=(select em_dia_private.current_user_id()) and m.is_admin);
$$;

create function em_dia_private.can_access_group(p_group_id uuid) returns boolean
language sql stable security invoker set search_path=''
as $$
  select (select em_dia_private.is_admin()) or exists(
    select 1 from public.em_dia_group_members gm
    where gm.group_id=p_group_id and gm.user_id=(select em_dia_private.current_user_id())
  );
$$;

revoke execute on function em_dia_private.current_user_id(),
  em_dia_private.is_authorized(),em_dia_private.is_admin(),em_dia_private.can_access_group(uuid)
  from public,anon,authenticated,service_role;
grant execute on function em_dia_private.current_user_id(),
  em_dia_private.is_authorized(),em_dia_private.is_admin(),em_dia_private.can_access_group(uuid)
  to authenticated,em_dia_writer;

alter table public.em_dia_groups enable row level security;
alter table public.em_dia_groups force row level security;
alter table public.em_dia_group_members enable row level security;
alter table public.em_dia_group_members force row level security;
alter table em_dia_private.legacy_group_links enable row level security;
alter table em_dia_private.legacy_group_links force row level security;

revoke all on public.em_dia_groups,public.em_dia_group_members
  from public,anon,authenticated,service_role,em_dia_writer;
grant select on public.em_dia_groups,public.em_dia_group_members to authenticated,em_dia_writer;
grant insert on public.em_dia_groups to em_dia_writer;
grant insert,update on public.em_dia_group_members to em_dia_writer;
revoke all on em_dia_private.legacy_group_links from public,anon,authenticated,service_role,em_dia_writer;
grant select on em_dia_private.legacy_group_links to em_dia_writer;
create policy em_dia_legacy_link_read_self on em_dia_private.legacy_group_links
  for select to em_dia_writer using(user_id=(select em_dia_private.current_user_id()));
-- The server may list authorization flags after separately verifying an admin.
-- This grant does not expose publisher states to a service-role endpoint.
grant select on public.em_dia_members to service_role;
grant insert(user_id) on public.em_dia_members to em_dia_writer;

-- Members still SELECT only themselves. The helper reads that one row, so it
-- cannot recurse through a policy that tries to read all members again.
create policy em_dia_members_admin_insert on public.em_dia_members
  for insert to em_dia_writer with check((select em_dia_private.is_admin()));

create policy em_dia_group_members_read on public.em_dia_group_members
  for select to authenticated,em_dia_writer
  using(user_id=(select em_dia_private.current_user_id()) or (select em_dia_private.is_admin()));
create policy em_dia_group_members_insert on public.em_dia_group_members
  for insert to em_dia_writer
  with check(user_id=(select em_dia_private.current_user_id()) or (select em_dia_private.is_admin()));
create policy em_dia_group_members_update on public.em_dia_group_members
  for update to em_dia_writer
  using((select em_dia_private.is_admin())) with check((select em_dia_private.is_admin()));

create policy em_dia_groups_read on public.em_dia_groups
  for select to authenticated,em_dia_writer using(em_dia_private.can_access_group(id));
create policy em_dia_groups_insert on public.em_dia_groups
  for insert to em_dia_writer
  with check(created_by=(select em_dia_private.current_user_id()) and (select em_dia_private.is_authorized()));

drop policy em_dia_states_read_self on public.em_dia_states;
drop policy em_dia_states_insert_self on public.em_dia_states;
drop policy em_dia_states_update_self on public.em_dia_states;
create policy em_dia_states_read_group on public.em_dia_states
  for select to authenticated,em_dia_writer using(em_dia_private.can_access_group(group_id));
create policy em_dia_states_insert_group on public.em_dia_states
  for insert to em_dia_writer with check(em_dia_private.can_access_group(group_id));
create policy em_dia_states_update_group on public.em_dia_states
  for update to em_dia_writer using(em_dia_private.can_access_group(group_id))
  with check(em_dia_private.can_access_group(group_id));

create function em_dia_private.save_group_state(p_group_id uuid,p_state jsonb,p_expected_revision bigint)
returns public.em_dia_states language plpgsql security definer set search_path=''
as $$
declare
  v_user uuid:=em_dia_private.current_user_id();
  v_name text;
  v_state jsonb;
  v_row public.em_dia_states;
begin
  if v_user is null or not em_dia_private.is_authorized() then
    raise exception using errcode='42501',message='Account not authorized.';
  end if;
  -- A membership reassignment and a save by that user cannot pass each other.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,0));
  if p_group_id is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group not authorized.';
  end if;
  select g.name into v_name from public.em_dia_groups g where g.id=p_group_id;
  if not found then raise exception using errcode='42501',message='Group not authorized.'; end if;
  if p_expected_revision is null or p_expected_revision<0 or p_expected_revision>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid expected revision.';
  end if;
  if p_state is null or jsonb_typeof(p_state) is distinct from 'object'
    or p_state->>'app' is distinct from 'em-dia-relatorios'
    or p_state->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_state->'people') is distinct from 'array'
    or jsonb_typeof(p_state->'reports') is distinct from 'object'
    or jsonb_typeof(p_state->'reminders') is distinct from 'object'
    or jsonb_typeof(p_state->'settings') is distinct from 'object'
    or octet_length(p_state::text)>12582912 then
    raise exception using errcode='22023',message='Invalid Em dia state.';
  end if;
  v_state:=jsonb_set(p_state,'{settings,group}',to_jsonb(v_name),true);
  if p_expected_revision=0 then
    insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at)
    values(p_group_id,v_user,v_state,1,statement_timestamp())
    on conflict(group_id) do nothing returning * into v_row;
  else
    update public.em_dia_states s set state=v_state,revision=s.revision+1,updated_at=statement_timestamp()
    where s.group_id=p_group_id and s.revision=p_expected_revision returning s.* into v_row;
  end if;
  if not found then raise exception using errcode='40001',message='Cloud revision conflict.'; end if;
  return v_row;
end;
$$;

create function em_dia_private.create_group(p_name text)
returns public.em_dia_groups language plpgsql security definer set search_path=''
as $$
declare
  v_user uuid:=em_dia_private.current_user_id();
  v_name text:=btrim(p_name);
  v_admin boolean;
  v_id uuid:=gen_random_uuid();
  v_row public.em_dia_groups;
begin
  if v_user is null or not em_dia_private.is_authorized() then
    raise exception using errcode='42501',message='Account not authorized.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,0));
  v_admin:=em_dia_private.is_admin();
  if not v_admin and exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user) then
    raise exception using errcode='42501',message='This account already has a group.';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 80 or v_name~'[[:cntrl:]]' then
    raise exception using errcode='22023',message='Invalid group name.';
  end if;
  -- No RETURNING until membership exists: an unassigned account cannot SELECT
  -- its newly created group before the following membership is inserted.
  insert into public.em_dia_groups(id,name,created_by) values(v_id,v_name,v_user);
  if not v_admin then
    insert into public.em_dia_group_members(group_id,user_id) values(v_id,v_user);
  end if;
  select * into strict v_row from public.em_dia_groups g where g.id=v_id;
  return v_row;
end;
$$;

create function em_dia_private.provision_group_member(
  p_user_id uuid,p_group_id uuid default null,p_new_group_name text default null
) returns public.em_dia_groups language plpgsql security definer set search_path=''
as $$
declare
  v_user uuid:=em_dia_private.current_user_id();
  v_group public.em_dia_groups;
  v_name text:=nullif(btrim(p_new_group_name),'');
begin
  if v_user is null or not em_dia_private.is_admin() then
    raise exception using errcode='42501',message='Administrator access required.';
  end if;
  if p_user_id is null or ((p_group_id is null)=(v_name is null)) then
    raise exception using errcode='22023',message='Choose an existing group or a new group name.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,0));
  -- FK validation checks the Auth ID; the function never needs to query the
  -- managed auth schema. Existing admin flags are deliberately not changed.
  -- DO NOTHING without an arbiter avoids an unnecessary SELECT-RLS check on
  -- another account's allowlist row. The only unique constraint is user_id.
  -- Keep SELECT-self: the writer must not gain general member-list access.
  insert into public.em_dia_members(user_id) values(p_user_id) on conflict do nothing;
  if p_group_id is not null then
    select * into v_group from public.em_dia_groups g where g.id=p_group_id;
    if not found then raise exception using errcode='22023',message='Group not found.'; end if;
  else
    if char_length(v_name)>80 or v_name~'[[:cntrl:]]' then
      raise exception using errcode='22023',message='Invalid group name.';
    end if;
    insert into public.em_dia_groups(name,created_by) values(v_name,v_user) returning * into v_group;
  end if;
  insert into public.em_dia_group_members(group_id,user_id) values(v_group.id,p_user_id)
  on conflict(user_id) do update set group_id=excluded.group_id;
  return v_group;
end;
$$;

-- Old clients continue writing the original group, with the same revision
-- checks and the same state row. There is no second legacy copy to diverge.
create or replace function em_dia_private.save_state(p_state jsonb,p_expected_revision bigint)
returns public.em_dia_states language plpgsql security definer set search_path=''
as $$
declare
  v_user uuid:=em_dia_private.current_user_id();
  v_group uuid;
begin
  select l.group_id into v_group from em_dia_private.legacy_group_links l where l.user_id=v_user;
  if v_group is null then raise exception using errcode='42501',message='Group not authorized.'; end if;
  return em_dia_private.save_group_state(v_group,p_state,p_expected_revision);
end;
$$;

grant create on schema em_dia_private to em_dia_writer;
alter function em_dia_private.save_group_state(uuid,jsonb,bigint) owner to em_dia_writer;
alter function em_dia_private.create_group(text) owner to em_dia_writer;
alter function em_dia_private.provision_group_member(uuid,uuid,text) owner to em_dia_writer;
revoke create on schema em_dia_private from em_dia_writer;

revoke execute on function em_dia_private.save_group_state(uuid,jsonb,bigint),
  em_dia_private.create_group(text),em_dia_private.provision_group_member(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function em_dia_private.save_group_state(uuid,jsonb,bigint),
  em_dia_private.create_group(text),em_dia_private.provision_group_member(uuid,uuid,text)
  to authenticated;

create function public.save_em_dia_group_state(p_group_id uuid,p_state jsonb,p_expected_revision bigint)
returns public.em_dia_states language sql security invoker set search_path=''
as $$ select em_dia_private.save_group_state(p_group_id,p_state,p_expected_revision); $$;
create function public.create_em_dia_group(p_name text)
returns public.em_dia_groups language sql security invoker set search_path=''
as $$ select em_dia_private.create_group(p_name); $$;
create function public.provision_em_dia_group_member(
  p_user_id uuid,p_group_id uuid default null,p_new_group_name text default null
) returns public.em_dia_groups language sql security invoker set search_path=''
as $$ select em_dia_private.provision_group_member(p_user_id,p_group_id,p_new_group_name); $$;
revoke execute on function public.save_em_dia_group_state(uuid,jsonb,bigint),
  public.create_em_dia_group(text),public.provision_em_dia_group_member(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.save_em_dia_group_state(uuid,jsonb,bigint),
  public.create_em_dia_group(text),public.provision_em_dia_group_member(uuid,uuid,text)
  to authenticated;

-- No browser INSERT/UPDATE/DELETE grants were added. Only the reviewed private
-- functions can exercise the limited NOLOGIN writer role. Group creation and
-- group assignment always verify the caller, and assignments never edit state.
