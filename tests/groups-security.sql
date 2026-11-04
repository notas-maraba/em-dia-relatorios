-- Run as postgres after groups-upgrade.sql and private initial group naming.
-- The only Auth fixtures are transaction-local users with no passwords.
-- Every fixture and state write is rolled back; no real account is deleted.
begin;

do $$
declare
  v_admin uuid;
  v_legacy uuid;
  v_a uuid:=gen_random_uuid();
  v_b uuid:=gen_random_uuid();
  v_c uuid:=gen_random_uuid();
  v_outsider uuid:=gen_random_uuid();
  v_ga public.em_dia_groups;
  v_gb public.em_dia_groups;
  v_group public.em_dia_groups;
  v_state jsonb:='{"app":"em-dia-relatorios","version":1,"revision":0,"updatedAt":null,"lastBackupAt":null,"settings":{"congregation":"","group":"","reminder":""},"people":[],"reports":{},"reminders":{},"activeMonth":"2026-09","sourceNote":"isolated security fixture"}'::jsonb;
  v_result public.em_dia_states;
  v_original public.em_dia_states;
  v_b_before public.em_dia_states;
  v_count bigint;
  v_rows bigint;
  v_denied boolean;
begin
  select l.user_id,l.group_id into v_admin,v_legacy
  from em_dia_private.legacy_group_links l join public.em_dia_members m on m.user_id=l.user_id
  where m.is_admin order by m.created_at limit 1;
  if v_admin is null then raise exception 'An approved legacy administrator is required.'; end if;
  select * into strict v_original from public.em_dia_states where group_id=v_legacy;

  assert not has_table_privilege('anon','public.em_dia_groups','SELECT');
  assert not has_table_privilege('anon','public.em_dia_group_members','SELECT');
  assert not has_table_privilege('anon','public.em_dia_states','SELECT');
  assert not has_table_privilege('authenticated','public.em_dia_groups','INSERT');
  assert not has_table_privilege('authenticated','public.em_dia_group_members','INSERT');
  assert not has_table_privilege('authenticated','public.em_dia_group_members','UPDATE');
  assert not has_table_privilege('authenticated','public.em_dia_states','INSERT');
  assert not has_table_privilege('authenticated','public.em_dia_states','UPDATE');
  assert not has_table_privilege('authenticated','public.em_dia_states','DELETE');
  assert not has_table_privilege('authenticated','public.em_dia_members','UPDATE');
  assert not has_table_privilege('authenticated','em_dia_private.legacy_group_links','SELECT');
  assert not has_table_privilege('service_role','public.em_dia_states','SELECT');
  assert has_table_privilege('service_role','public.em_dia_members','SELECT');
  assert not has_column_privilege('em_dia_writer','public.em_dia_members','is_admin','INSERT');
  assert not has_column_privilege('em_dia_writer','public.em_dia_members','is_admin','UPDATE');
  assert not pg_has_role('authenticated','em_dia_writer','MEMBER');
  assert not has_function_privilege('anon','public.save_em_dia_group_state(uuid,jsonb,bigint)','EXECUTE');
  assert not has_function_privilege('anon','public.create_em_dia_group(text)','EXECUTE');
  assert not has_function_privilege('anon','public.provision_em_dia_group_member(uuid,uuid,text)','EXECUTE');
  assert (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
    where oid in ('public.em_dia_groups'::regclass,'public.em_dia_group_members'::regclass,
      'public.em_dia_states'::regclass,'public.em_dia_members'::regclass,
      'em_dia_private.legacy_group_links'::regclass));
  assert (select not rolcanlogin and not rolbypassrls and not rolsuper from pg_roles where rolname='em_dia_writer');
  assert not (select prosecdef from pg_proc where oid='public.save_em_dia_group_state(uuid,jsonb,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_writer'
    from pg_proc where oid='em_dia_private.save_group_state(uuid,jsonb,bigint)'::regprocedure);

  -- These users exist only until the transaction rollback. No email is sent.
  insert into auth.users(id,email,role,aud,created_at,updated_at)
  select u,'fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
  from unnest(array[v_a,v_b,v_c]) u;
  insert into public.em_dia_members(user_id) values(v_a);

  -- A pre-approved, unassigned user may create their first group.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_a::text,true);
  set local role authenticated;
  select * into v_ga from public.create_em_dia_group('Fixture A '||left(v_a::text,8));
  assert v_ga.id is not null and v_ga.created_by=v_a;
  assert (select count(*)=1 from public.em_dia_groups);
  assert (select count(*)=1 from public.em_dia_group_members where user_id=v_a and group_id=v_ga.id);
  select * into v_result from public.save_em_dia_group_state(v_ga.id,v_state,0);
  assert v_result.group_id=v_ga.id and v_result.revision=1;
  assert v_result.state#>>'{settings,group}'=v_ga.name;
  reset role;

  -- Administrator provisions another Auth user with a new group atomically.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  select * into v_gb from public.provision_em_dia_group_member(v_b,null,'Fixture B '||left(v_b::text,8));
  assert (select count(*)>=3 from public.em_dia_groups);
  assert (select count(*)=1 from public.em_dia_group_members where user_id=v_b and group_id=v_gb.id);
  select * into v_b_before from public.save_em_dia_group_state(v_gb.id,v_state||'{"sourceNote":"fixture B"}'::jsonb,0);
  -- Multiple managers may administer one group, but each manager has one group.
  select * into v_group from public.provision_em_dia_group_member(v_c,v_ga.id,null);
  assert v_group.id=v_ga.id;
  assert (select count(*)=2 from public.em_dia_group_members where group_id=v_ga.id);
  -- The writer only SELECTs its own allowlist row: repeated provisioning of
  -- another existing account must not need broader member SELECT privileges.
  assert (select count(*)=1 from public.em_dia_members);
  select * into v_group from public.provision_em_dia_group_member(v_b,v_gb.id,null);
  assert v_group.id=v_gb.id;
  assert (select count(*)=1 from public.em_dia_group_members where user_id=v_b and group_id=v_gb.id);
  reset role;
  assert (select not is_admin from public.em_dia_members where user_id=v_b);
  assert (select not is_admin from public.em_dia_members where user_id=v_c);

  -- Manager A has no visibility into group B or the original group's records.
  -- User-editable JWT metadata cannot elevate an account to administrator.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated',
    'user_metadata',jsonb_build_object('is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_a::text,true);
  set local role authenticated;
  assert not em_dia_private.is_admin();
  assert (select count(*)=1 from public.em_dia_members);
  assert (select count(*)=1 from public.em_dia_groups);
  assert (select count(*)=1 from public.em_dia_states);
  assert (select count(*)=0 from public.em_dia_states where group_id in (v_gb.id,v_legacy));
  assert (select count(*)=0 from public.em_dia_group_members where user_id=v_b);
  v_denied:=false;
  begin perform public.save_em_dia_group_state(v_gb.id,v_state,1);
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'A manager wrote another group';
  v_denied:=false;
  begin perform public.provision_em_dia_group_member(v_a,v_gb.id,null);
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'A manager assigned their own account to another group';
  v_denied:=false;
  begin perform public.create_em_dia_group('Unauthorized second group '||left(v_a::text,8));
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'A manager created a second group';
  v_denied:=false;
  begin update public.em_dia_members set is_admin=true where user_id=v_a;
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'A manager promoted themselves';
  v_denied:=false;
  begin insert into public.em_dia_group_members(group_id,user_id) values(v_gb.id,v_a);
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'Direct membership insertion succeeded';
  v_denied:=false;
  begin update public.em_dia_states set state=v_state where group_id=v_ga.id;
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'Direct state update bypassed compare-and-swap';
  v_denied:=false;
  begin perform public.save_em_dia_state(v_state,1);
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'A new account used an unmapped legacy write';
  select * into v_result from public.save_em_dia_group_state(v_ga.id,v_state,1);
  assert v_result.revision=2;
  v_denied:=false;
  begin perform public.save_em_dia_group_state(v_ga.id,v_state||'{"sourceNote":"stale"}'::jsonb,1);
  exception when serialization_failure then v_denied:=true; end;
  assert v_denied,'Stale group revision overwrote current state';
  assert (select revision=2 and state->>'sourceNote'='isolated security fixture'
    from public.em_dia_states where group_id=v_ga.id);
  reset role;

  -- An authenticated UUID outside the allowlist sees no group and cannot create.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  assert (select count(*)=0 from public.em_dia_members);
  assert (select count(*)=0 from public.em_dia_groups);
  assert (select count(*)=0 from public.em_dia_group_members);
  assert (select count(*)=0 from public.em_dia_states);
  v_denied:=false;
  begin perform public.create_em_dia_group('Unauthorized group');
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'An unapproved account created a group';
  reset role;

  -- Anonymous users cannot query group metadata, publisher state, or any RPC.
  perform set_config('request.jwt.claims','{}',true);
  perform set_config('request.jwt.claim.sub','',true);
  set local role anon;
  v_denied:=false;
  begin perform 1 from public.em_dia_groups;
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'Anonymous group query succeeded';
  v_denied:=false;
  begin perform 1 from public.em_dia_states;
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'Anonymous state query succeeded';
  v_denied:=false;
  begin perform public.create_em_dia_group('Anonymous group');
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'Anonymous RPC succeeded';
  reset role;

  -- Reassignment preserves both groups' state, and affects the next RLS check.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  select * into v_group from public.provision_em_dia_group_member(v_c,v_gb.id,null);
  assert v_group.id=v_gb.id;
  assert (select count(*)=1 from public.em_dia_group_members where user_id=v_c);
  assert (select state=v_b_before.state and revision=v_b_before.revision
    from public.em_dia_states where group_id=v_gb.id);
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_c,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_c::text,true);
  set local role authenticated;
  assert (select count(*)=0 from public.em_dia_states where group_id=v_ga.id);
  assert (select count(*)=1 from public.em_dia_states where group_id=v_gb.id);
  reset role;

  -- The restricted writer role itself still cannot read another group's state.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_a::text,true);
  set local role em_dia_writer;
  update public.em_dia_states set revision=revision+1 where group_id=v_gb.id;
  get diagnostics v_rows=row_count;
  assert v_rows=0,'The writer role bypassed group RLS';
  reset role;

  -- Reassigning a legacy user's membership cannot redirect an already-open old
  -- form into the new group, even when the revisions happen to be identical.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  update public.em_dia_states set revision=v_original.revision where group_id=v_gb.id;
  select * into strict v_b_before from public.em_dia_states where group_id=v_gb.id;
  set local role authenticated;
  select * into v_group from public.provision_em_dia_group_member(v_admin,v_gb.id,null);
  select * into v_result from public.save_em_dia_state(v_original.state,v_original.revision);
  assert v_result.group_id=v_legacy;
  assert v_result.revision=v_original.revision+1;
  assert v_result.state->'people'=v_original.state->'people';
  assert v_result.state->'reports'=v_original.state->'reports';
  assert (select state=v_b_before.state and revision=v_b_before.revision
    from public.em_dia_states where group_id=v_gb.id),'Legacy JSON was redirected into the newly assigned group';
  reset role;
end;
$$;

rollback;
select 'groups_security_passed; all fixture users and writes rolled back' as result;
