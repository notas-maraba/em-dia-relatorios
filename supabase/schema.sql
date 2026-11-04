-- Em dia: private state per approved account, with atomic versioned writes.
-- Apply once to the dedicated project. This file contains no account IDs or data.
-- Provision auth users and the allowlist separately through a trusted admin path.

create role em_dia_writer nologin nosuperuser nocreatedb nocreaterole
  noinherit noreplication nobypassrls;
grant em_dia_writer to postgres;

create schema em_dia_private;
revoke all on schema em_dia_private from public, anon, authenticated, service_role;
grant usage on schema em_dia_private to authenticated, em_dia_writer;
-- This schema must stay outside the Data API's exposed schemas.

create table public.em_dia_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.em_dia_states (
  owner_id uuid primary key default auth.uid()
    references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  constraint em_dia_state_shape check (coalesce(
    jsonb_typeof(state) = 'object'
    and state ->> 'app' = 'em-dia-relatorios'
    and state -> 'version' = '1'::jsonb
    and jsonb_typeof(state -> 'people') = 'array'
    and jsonb_typeof(state -> 'reports') = 'object'
    and jsonb_typeof(state -> 'reminders') = 'object'
    and jsonb_typeof(state -> 'settings') = 'object', false)),
  constraint em_dia_state_size check (octet_length(state::text) <= 12582912)
);

alter table public.em_dia_members enable row level security;
alter table public.em_dia_members force row level security;
alter table public.em_dia_states enable row level security;
alter table public.em_dia_states force row level security;

-- The owner of the write function is NOT a table owner and cannot bypass RLS.
revoke all on public.em_dia_members, public.em_dia_states
  from public, anon, authenticated, service_role, em_dia_writer;
grant usage on schema public to em_dia_writer;
grant select on public.em_dia_members to authenticated, em_dia_writer;
grant select on public.em_dia_states to authenticated, em_dia_writer;
grant insert, update on public.em_dia_states to em_dia_writer;

create policy em_dia_members_read_self on public.em_dia_members
  for select to authenticated, em_dia_writer
  using (user_id = (select auth.uid()));

create policy em_dia_states_read_self on public.em_dia_states
  for select to authenticated, em_dia_writer
  using (
    owner_id = (select auth.uid())
    and exists (select 1 from public.em_dia_members m
      where m.user_id = (select auth.uid()))
  );

create policy em_dia_states_insert_self on public.em_dia_states
  for insert to em_dia_writer
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.em_dia_members m
      where m.user_id = (select auth.uid()))
  );

create policy em_dia_states_update_self on public.em_dia_states
  for update to em_dia_writer
  using (
    owner_id = (select auth.uid())
    and exists (select 1 from public.em_dia_members m
      where m.user_id = (select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.em_dia_members m
      where m.user_id = (select auth.uid()))
  );

-- A limited private definer is needed to enforce a single write API without
-- granting table writes to browser sessions. Its NOLOGIN/NOBYPASSRLS owner has
-- only the privileges above; ownership and membership checks apply twice.
create function em_dia_private.save_state(
  p_state jsonb,
  p_expected_revision bigint
) returns public.em_dia_states
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Equivalent to auth.uid(), whose managed schema cannot grant USAGE to a
  -- custom NOLOGIN role. Claims are set by PostgREST from its verified JWT.
  -- RLS still uses auth.uid() and independently enforces the same identity.
  v_user uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
  v_row public.em_dia_states;
begin
  if v_user is null or not exists (
    select 1 from public.em_dia_members m where m.user_id = v_user
  ) then
    raise exception using errcode = '42501', message = 'Account not authorized.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0
    or p_expected_revision >= 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invalid expected revision.';
  end if;
  if p_state is null
    or jsonb_typeof(p_state) is distinct from 'object'
    or p_state ->> 'app' is distinct from 'em-dia-relatorios'
    or p_state -> 'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_state -> 'people') is distinct from 'array'
    or jsonb_typeof(p_state -> 'reports') is distinct from 'object'
    or jsonb_typeof(p_state -> 'reminders') is distinct from 'object'
    or jsonb_typeof(p_state -> 'settings') is distinct from 'object'
    or octet_length(p_state::text) > 12582912 then
    raise exception using errcode = '22023', message = 'Invalid Em dia state.';
  end if;

  if p_expected_revision = 0 then
    insert into public.em_dia_states (owner_id, state, revision, updated_at)
    values (v_user, p_state, 1, statement_timestamp())
    on conflict (owner_id) do nothing
    returning * into v_row;
  else
    update public.em_dia_states s
    set state = p_state,
        revision = s.revision + 1,
        updated_at = statement_timestamp()
    where s.owner_id = v_user and s.revision = p_expected_revision
    returning s.* into v_row;
  end if;

  if not found then
    raise exception using errcode = '40001', message = 'Cloud revision conflict.';
  end if;
  return v_row;
end;
$$;

-- The new owner needs CREATE only for the ownership transfer itself.
grant create on schema em_dia_private to em_dia_writer;
alter function em_dia_private.save_state(jsonb, bigint) owner to em_dia_writer;
revoke create on schema em_dia_private from em_dia_writer;
revoke execute on function em_dia_private.save_state(jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function em_dia_private.save_state(jsonb, bigint) to authenticated;

create function public.save_em_dia_state(
  p_state jsonb,
  p_expected_revision bigint
) returns public.em_dia_states
language sql
security invoker
set search_path = ''
as $$
  select em_dia_private.save_state(p_state, p_expected_revision);
$$;
revoke execute on function public.save_em_dia_state(jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.save_em_dia_state(jsonb, bigint) to authenticated;

-- No DELETE, INSERT or UPDATE privileges are granted to browser roles.
-- No owner identity, password, secret key, backup or report belongs in this file.
