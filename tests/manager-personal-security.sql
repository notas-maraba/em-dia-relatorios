-- Transactional manager/publisher dual-role security checks. All fixture rows roll back.
begin;
create temporary table em_dia_personal_fixture_scope(marker boolean) on commit drop;
create function pg_temp.personal_expect_error(p_query text,p_code text) returns void
language plpgsql security invoker set search_path='' as $$
declare v_failed boolean:=false;
begin
  begin execute p_query;
  exception when others then if sqlstate<>p_code then raise; end if;v_failed:=true;end;
  assert v_failed,'Expected SQLSTATE '||p_code||' was not raised';
end;
$$;
do $$ begin execute format('grant usage on schema %I to authenticated',pg_my_temp_schema()::regnamespace::text);end; $$;
grant execute on function pg_temp.personal_expect_error(text,text) to authenticated;
do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_pub uuid:=gen_random_uuid();v_no_card uuid:=gen_random_uuid();
  v_a uuid:=gen_random_uuid();v_b uuid:=gen_random_uuid();v_c uuid:=gen_random_uuid();
  v_month text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM');
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_state jsonb;v_person jsonb;v_profile jsonb;v_card jsonb;v_result jsonb;v_snap jsonb;v_timer jsonb;
  v_year integer;v_revision bigint;v_launch uuid:=gen_random_uuid();v_timer_id uuid:=gen_random_uuid();v_operation uuid:=gen_random_uuid();
begin
  assert not has_table_privilege('authenticated','em_dia_private.publisher_links','SELECT');
  assert not has_function_privilege('anon','public.bind_em_dia_personal_card(uuid,uuid,text,uuid,text,uuid)','EXECUTE');
  assert not has_function_privilege('service_role','em_dia_private.has_personal_card()','EXECUTE');
  assert (select p.prosecdef and pg_get_userbyid(p.proowner)='em_dia_workflow' and p.proconfig=array['search_path=""']
    from pg_proc p where p.oid='em_dia_private.bind_personal_card(uuid,uuid,text,uuid,text,uuid)'::regprocedure);
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'fixture-personal-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_pub,v_no_card]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_no_card,false,'superintendent');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_a,'Fixture personal A '||v_a,v_admin),(v_b,'Fixture personal B '||v_b,v_admin),(v_c,'Fixture personal C '||v_c,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values(v_a,v_admin),(v_a,v_super),(v_a,v_no_card);
  v_person:=jsonb_build_object('id','personal_fixture','name','Fixture personal card','startMonth',v_prior,'endMonth',null,
    'notes','PRIVATE_PERSONAL_NOTE','roles',jsonb_build_array(jsonb_build_object('kind','regular','start',v_prior,'end',null)));
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Fixture congregation','group','Fixture','reminder','PRIVATE_REMINDER'),
    'people',jsonb_build_array(v_person,v_person||'{"id":"second_fixture","name":"PRIVATE_UNRELATED_PERSON"}'::jsonb),
    'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','PRIVATE_SOURCE');
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_a,null,v_state,1,now()),(v_b,null,v_state,1,now()),
    (v_c,null,v_state||'{"people":[],"reports":{},"reminders":{}}'::jsonb,1,now());
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.bind_em_dia_personal_card(v_super,v_b,'personal_fixture',null,null,v_admin);
  assert v_result->>'group_id'=v_b::text;
  perform public.bind_em_dia_personal_card(v_admin,v_a,'personal_fixture',null,null,v_admin);
  perform public.provision_em_dia_publisher_account(v_pub,v_a,'second_fixture');
  -- A valid second administrator/session cannot execute a stale actor's form.
  perform pg_temp.personal_expect_error(format('select public.bind_em_dia_personal_card(%L,null,null,%L,%L,%L)',v_super,v_b,'personal_fixture',v_super),'42501');
  assert jsonb_array_length(public.list_em_dia_personal_bindings())>=2;
  perform pg_temp.personal_expect_error(format('select public.bind_em_dia_personal_card(%L,%L,%L,null,null,%L)',v_super,v_b,'personal_fixture',v_admin),'40001');
  perform pg_temp.personal_expect_error(format('select public.bind_em_dia_personal_card(%L,%L,%L,null,null,%L)',v_no_card,v_b,'personal_fixture',v_admin),'22023');
  perform pg_temp.personal_expect_error(format('select public.bind_em_dia_personal_card(%L,%L,%L,null,null,%L)',v_pub,v_b,'second_fixture',v_admin),'42501');
  reset role;
  assert (select access_role='superintendent' from public.em_dia_members where user_id=v_super);
  assert (select group_id=v_a from public.em_dia_group_members where user_id=v_super);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated','user_metadata',jsonb_build_object('access_role','admin'))::text,true);
  set local role authenticated;
  v_profile:=public.get_em_dia_access_profile();assert v_profile->>'role'='superintendent';
  assert v_profile->>'group_id'=v_a::text and v_profile->>'personal_group_id'=v_b::text and v_profile->>'publisher_id'='personal_fixture';
  assert (select count(*)=1 from public.em_dia_states);
  assert not exists(select 1 from public.em_dia_states where group_id=v_b);
  v_card:=public.read_em_dia_own_card();assert v_card->>'group_id'=v_b::text;
  assert jsonb_array_length(v_card#>'{state,people}')=1 and v_card::text not like '%PRIVATE_%';
  perform pg_temp.personal_expect_error('select public.list_em_dia_personal_bindings()','42501');
  perform pg_temp.personal_expect_error(format('select public.bind_em_dia_personal_card(%L,null,null,%L,%L,%L)',v_super,v_b,'personal_fixture',v_super),'42501');
  v_result:=public.save_em_dia_own_hour_launch_note(v_launch,v_today,75,'PRIVATE_DIARY_NOTE',0);
  assert (v_result->>'total_minutes')::integer=75;
  v_result:=public.submit_em_dia_own_report(v_month,'{"participated":true,"hours":1.25,"studies":2}'::jsonb,0);
  assert v_result->>'status'='accepted';
  v_result:=public.submit_em_dia_own_report(v_month,'{"participated":true,"hours":2,"studies":3}'::jsonb,(v_result->>'version')::bigint);
  assert v_result->>'status'='pending';
  v_card:=public.read_em_dia_own_card();assert v_card#>>array['state','reports',v_month,'personal_fixture','hours']='1.25';
  v_timer:=public.read_em_dia_own_timer();assert v_timer->>'status'='idle';
  v_result:=public.change_em_dia_own_timer('start',v_timer_id,(v_timer->>'version')::bigint);
  assert v_result->>'status'='running';
  v_result:=public.change_em_dia_own_timer('stop',v_timer_id,(v_result->>'version')::bigint);assert v_result->>'status'='stopped';
  v_year:=left(v_today,4)::integer-case when substring(v_today,6,2)<'09' then 1 else 0 end;
  v_result:=public.read_em_dia_own_annual(v_year);assert v_result->>'group_id'=v_b::text;
  v_result:=public.save_em_dia_own_annual_goal(v_year,35999,(v_result->>'version')::bigint);assert (v_result->>'target_minutes')::integer=35999;
  v_snap:=public.read_em_dia_offline_snapshot();assert v_snap#>>'{own_card,group_id}'=v_b::text;
  assert jsonb_array_length(v_snap->'groups')=1 and v_snap#>>'{groups,0,id}'=v_a::text;
  assert jsonb_array_length(v_snap->'states')=1 and v_snap#>>'{states,0,group_id}'=v_a::text;
  assert v_snap#>>'{timer,group_id}'=v_b::text and jsonb_array_length(v_snap->'diaries')>0;
  reset role;
  perform set_config('request.jwt.claim.sub',v_no_card::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_no_card,'role','authenticated')::text,true);
  set local role authenticated;
  perform pg_temp.personal_expect_error('select public.read_em_dia_own_card()','42501');
  reset role;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  set local role authenticated;
  select revision into v_revision from public.em_dia_states where group_id=v_b;
  perform public.transfer_em_dia_publisher(v_b,v_c,'personal_fixture',v_revision);
  reset role;
  assert (select group_id=v_a from public.em_dia_group_members where user_id=v_super),'Personal card transfer changed management group';
  assert (select group_id=v_c from em_dia_private.publisher_links where user_id=v_super);
  assert exists(select 1 from em_dia_private.daily_hours where group_id=v_c and person_id='personal_fixture');
  assert exists(select 1 from em_dia_private.service_timers where group_id=v_c and person_id='personal_fixture');
  assert exists(select 1 from em_dia_private.annual_progress where group_id=v_c and person_id='personal_fixture');
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_card()->>'group_id'=v_c::text;
  perform pg_temp.personal_expect_error(format('select public.apply_em_dia_offline_operation(%L,%L,%L::jsonb)',v_operation,'annual_goal',
    jsonb_build_object('userId',v_super,'groupId',v_b,'personId','personal_fixture','serviceYear',v_year,'targetMinutes',36000,'expectedVersion',1)::text),'42501');
  reset role;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  set local role authenticated;
  perform public.bind_em_dia_personal_card(v_super,null,null,v_c,'personal_fixture',v_admin);
  reset role;
  assert not exists(select 1 from em_dia_private.publisher_links where user_id=v_super);
  assert exists(select 1 from em_dia_private.daily_hours where group_id=v_c and person_id='personal_fixture');
  assert (select group_id=v_a from public.em_dia_group_members where user_id=v_super);
end;
$$;
rollback;
select 'manager_personal_security_ok' as result;
