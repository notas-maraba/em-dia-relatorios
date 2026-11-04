-- Run as postgres AFTER provisioning one approved auth user/member.
-- All mutations are rolled back. No test auth users are created.
-- JWT contexts below simulate signed-in API roles without issuing real tokens.
begin;

do $$
declare
  v_owner uuid;
  v_outsider uuid := '00000000-0000-4000-8000-000000000001';
  v_state jsonb := '{"app":"em-dia-relatorios","version":1,"revision":0,"updatedAt":null,"lastBackupAt":null,"settings":{"congregation":"","group":"","reminder":""},"people":[],"reports":{},"reminders":{},"activeMonth":"2026-09","sourceNote":"security test"}'::jsonb;
  v_revision bigint;
  v_result public.em_dia_states;
  v_denied boolean;
  v_count bigint;
begin
  select user_id into v_owner from public.em_dia_members order by created_at limit 1;
  if v_owner is null then
    raise exception 'Provision an approved account before running security.sql';
  end if;
  while exists(select 1 from public.em_dia_members where user_id = v_outsider) loop
    v_outsider := gen_random_uuid();
  end loop;

  -- Verify ACLs, RLS, forced RLS and the deliberately restricted writer role.
  assert not has_table_privilege('anon', 'public.em_dia_states', 'SELECT');
  assert not has_table_privilege('authenticated', 'public.em_dia_states', 'INSERT');
  assert not has_table_privilege('authenticated', 'public.em_dia_states', 'UPDATE');
  assert not has_table_privilege('authenticated', 'public.em_dia_states', 'DELETE');
  assert not has_table_privilege('authenticated', 'public.em_dia_members', 'INSERT');
  assert not has_function_privilege('anon', 'public.save_em_dia_state(jsonb,bigint)', 'EXECUTE');
  assert not has_schema_privilege('anon', 'em_dia_private', 'USAGE');
  assert not has_schema_privilege('authenticated', 'em_dia_private', 'CREATE');
  assert (select bool_and(relrowsecurity and relforcerowsecurity)
    from pg_class where oid in ('public.em_dia_states'::regclass, 'public.em_dia_members'::regclass));
  assert (select not rolcanlogin and not rolbypassrls and not rolsuper
    from pg_roles where rolname = 'em_dia_writer');
  assert not (select prosecdef from pg_proc
    where oid = 'public.save_em_dia_state(jsonb,bigint)'::regprocedure);
  assert (select p.prosecdef and pg_get_userbyid(p.proowner) = 'em_dia_writer'
    from pg_proc p where oid = 'em_dia_private.save_state(jsonb,bigint)'::regprocedure);

  -- Ensure there is an owner row before negative read tests, so an empty table
  -- cannot make a broken isolation policy look correct. This is rolled back.
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner,'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;
  select coalesce(max(revision),0) into v_revision from public.em_dia_states;
  select * into v_result from public.save_em_dia_state(v_state, v_revision);
  assert v_result.owner_id = v_owner and v_result.revision = v_revision + 1;
  reset role;

  -- Anonymous cannot query data or call the write RPC.
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  v_denied := false;
  begin
    perform 1 from public.em_dia_states;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'Anonymous SELECT unexpectedly succeeded';
  v_denied := false;
  begin
    perform public.save_em_dia_state(v_state, 0);
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'Anonymous RPC unexpectedly succeeded';
  reset role;

  -- A signed-in UUID outside the approved allowlist sees no membership/data,
  -- cannot read another owner's row, cannot save and cannot self-authorize.
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_outsider,'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role authenticated;
  select count(*) into v_count from public.em_dia_members;
  assert v_count = 0, 'Outsider can see another membership';
  select count(*) into v_count from public.em_dia_states where owner_id = v_owner;
  assert v_count = 0, 'Outsider can read owner data';
  v_denied := false;
  begin
    perform public.save_em_dia_state(v_state, 0);
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'Outsider RPC unexpectedly succeeded';
  v_denied := false;
  begin
    insert into public.em_dia_members(user_id) values(v_outsider);
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'Outsider could self-authorize';
  reset role;

  -- Owner can read and write through RPC; works with an existing base too.
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner,'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;
  select coalesce(max(revision),0) into v_revision from public.em_dia_states;
  select * into v_result from public.save_em_dia_state(v_state, v_revision);
  assert v_result.owner_id = v_owner;
  assert v_result.revision = v_revision + 1;
  assert v_result.state = v_state;
  select count(*) into v_count from public.em_dia_states;
  assert v_count = 1, 'Owner cannot read own state';

  -- Reusing an old revision must not modify anything or silently retry.
  v_denied := false;
  begin
    perform public.save_em_dia_state(v_state || '{"sourceNote":"stale"}'::jsonb, v_revision);
  exception when serialization_failure then v_denied := true;
  end;
  assert v_denied, 'Stale revision unexpectedly succeeded';
  assert (select revision = v_result.revision and state = v_state
    from public.em_dia_states where owner_id = v_owner);

  -- Even the owner cannot bypass compare-and-swap through REST table writes.
  v_denied := false;
  begin
    update public.em_dia_states set state = v_state where owner_id = v_owner;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'Direct UPDATE unexpectedly succeeded';
  v_denied := false;
  begin
    insert into public.em_dia_states(owner_id,state,revision) values(v_owner,v_state,1);
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'Direct INSERT unexpectedly succeeded';
  v_denied := false;
  begin
    perform public.save_em_dia_state('{}'::jsonb, v_result.revision);
  exception when invalid_parameter_value then v_denied := true;
  end;
  assert v_denied, 'Invalid state unexpectedly accepted';
  reset role;

  -- RLS also applies to the NOLOGIN function-owner role. It cannot read a
  -- different account by running table statements under the outsider context.
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_outsider,'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role em_dia_writer;
  select count(*) into v_count from public.em_dia_states where owner_id = v_owner;
  assert v_count = 0, 'Writer role bypassed owner RLS';
  reset role;
end;
$$;

rollback;
select 'security_sql_passed; all test writes rolled back' as result;
