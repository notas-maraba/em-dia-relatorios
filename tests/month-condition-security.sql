-- Synthetic, transaction-only checks. No real card or credential is changed.
begin;
create function pg_temp.month_expect_error(p_query text,p_code text) returns void
language plpgsql security invoker set search_path='' as $$
declare v_failed boolean:=false;
begin
  begin execute p_query;
  exception when others then if sqlstate<>p_code then raise; end if;v_failed:=true;end;
  assert v_failed,'Expected SQLSTATE '||p_code;
end;
$$;
do $$ begin execute format('grant usage on schema %I to authenticated',pg_my_temp_schema()::regnamespace::text);end; $$;
grant execute on function pg_temp.month_expect_error(text,text) to authenticated;
do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_pub uuid:=gen_random_uuid();v_other uuid:=gen_random_uuid();
  v_a uuid:=gen_random_uuid();v_b uuid:=gen_random_uuid();v_actor uuid;v_group uuid;v_person text;v_i integer;
  v_month text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM');
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_next text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 month','YYYY-MM');
  v_day text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_state jsonb;v_people jsonb;v_before jsonb;v_after jsonb;v_card jsonb;v_result jsonb;v_hours jsonb;v_snapshot jsonb;
  v_revision bigint;v_report_version bigint;v_timer jsonb;v_launch uuid;v_timer_id uuid;v_post_id uuid;
  v_op uuid:=gen_random_uuid();v_payload jsonb;v_ack jsonb;v_before_revision bigint;
begin
  assert not has_function_privilege('anon','public.save_em_dia_own_condition(text,text,bigint,uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.person_with_month_condition(jsonb,text,text)','EXECUTE');
  assert (select p.prosecdef and pg_get_userbyid(p.proowner)='em_dia_workflow' and p.proconfig=array['search_path=""']
    from pg_proc p where p.oid='em_dia_private.save_own_condition(text,text,bigint,uuid,uuid,text)'::regprocedure);
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'fixture-month-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_pub,v_other]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role)
    values(v_admin,true,'admin'),(v_super,false,'superintendent'),(v_pub,false,'publisher'),(v_other,false,'superintendent');
  insert into public.em_dia_groups(id,name,created_by) values(v_a,'Fixture monthly A '||v_a,v_admin),(v_b,'Fixture monthly B '||v_b,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values(v_a,v_admin),(v_a,v_super),(v_a,v_pub),(v_a,v_other);
  v_people:='[]';
  for v_person in select unnest(array['p_admin','p_super','p_pub','unrelated_fixture']) loop
    v_people:=v_people||jsonb_build_array(jsonb_build_object('id',v_person,'name','Monthly fixture '||v_person,
      'startMonth',v_prior,'endMonth',null,'notes','PRIVATE_FIXTURE_NOTE','roles',jsonb_build_array(
        jsonb_build_object('kind','regular','start',v_prior,'end',null))));
  end loop;
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Monthly fixture','group','Fixture','reminder','PRIVATE_FIXTURE_REMINDER'),
    'people',v_people,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','PRIVATE_FIXTURE_SOURCE');
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values(v_a,null,v_state,1,now()),(v_b,null,v_state,1,now());
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(v_admin,v_a,'p_admin'),(v_super,v_b,'p_super'),(v_pub,v_a,'p_pub');
  for v_i in 1..3 loop
    v_actor:=(array[v_admin,v_super,v_pub])[v_i];v_group:=case when v_i=2 then v_b else v_a end;
    v_person:=(array['p_admin','p_super','p_pub'])[v_i];
    select s.state,s.revision into v_before,v_revision from public.em_dia_states s where s.group_id=v_group;
    perform set_config('request.jwt.claim.sub',v_actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,true);
    set local role authenticated;
    v_result:=public.save_em_dia_own_condition(v_month,'auxiliary',v_revision,v_actor,v_group,v_person);
    assert (v_result->>'revision')::bigint=v_revision+1;
    v_card:=public.read_em_dia_own_card();
    assert v_card#>>array['state','people','0','monthConditions',v_month]='auxiliary';
    assert v_card::text not like '%PRIVATE_%';
    v_hours:=public.read_em_dia_own_hour_launches(v_month);assert v_hours->>'kind'='auxiliary';
    perform pg_temp.month_expect_error(format('select public.save_em_dia_own_condition(%L,%L,%L,%L,%L,%L)',v_month,'auxiliary',v_revision,v_actor,v_group,v_person),'40001');
    perform pg_temp.month_expect_error(format('select public.save_em_dia_own_condition(%L,%L,%L,%L,%L,%L)',v_month,'auxiliary',v_revision+1,v_other,v_group,v_person),'42501');
    perform pg_temp.month_expect_error(format('select public.save_em_dia_own_condition(%L,%L,%L,%L,%L,%L)',v_month,'admin',v_revision+1,v_actor,v_group,v_person),'22023');
    perform pg_temp.month_expect_error(format('select public.save_em_dia_own_condition(%L,%L,%L,%L,%L,%L)',v_next,'regular',v_revision+1,v_actor,v_group,v_person),'22023');
    v_result:=public.submit_em_dia_own_report(v_month,'{"kind":"auxiliary","participated":true,"hours":2,"studies":1}'::jsonb,0);
    assert v_result->>'status'='accepted';v_report_version:=(v_result->>'version')::bigint;v_revision:=(v_result->>'revision')::bigint;
    v_result:=public.save_em_dia_own_condition(v_month,'regular',v_revision,v_actor,v_group,v_person);
    v_revision:=(v_result->>'revision')::bigint;v_card:=public.read_em_dia_own_card();
    assert v_card#>>array['state','reports',v_month,v_person,'kind']='auxiliary';
    assert v_card#>>array['state','people','0','monthConditions',v_month]='regular';
    perform pg_temp.month_expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,%L)',v_month,'{"kind":"auxiliary","participated":true,"hours":3,"studies":1}',v_report_version),'40001');
    perform pg_temp.month_expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,%L)',v_month,'{"participated":true,"hours":3,"studies":1}',v_report_version),'40001');
    v_result:=public.submit_em_dia_own_report(v_month,'{"kind":"regular","participated":true,"hours":3,"studies":1}'::jsonb,v_report_version);
    assert v_result->>'status'='pending';v_report_version:=(v_result->>'version')::bigint;
    v_launch:=gen_random_uuid();v_hours:=public.save_em_dia_own_hour_launch_note(v_launch,v_day,90,'PRIVATE_DIARY_FIXTURE',0);
    perform pg_temp.month_expect_error(format('select public.submit_em_dia_own_hours(%L,true,1,1,%L)',v_month,v_report_version),'40001');
    perform pg_temp.month_expect_error(format('select public.submit_em_dia_own_hours(%L,true,1,1,%L,%L)',v_month,v_report_version,'auxiliary'),'40001');
    v_result:=public.submit_em_dia_own_hours(v_month,true,1,1,v_report_version,'regular');assert v_result->>'status'='pending';
    v_timer:=public.read_em_dia_own_timer();v_timer_id:=gen_random_uuid();
    v_timer:=public.change_em_dia_own_timer('start',v_timer_id,(v_timer->>'version')::bigint);
    v_timer:=public.change_em_dia_own_timer('stop',v_timer_id,(v_timer->>'version')::bigint);v_post_id:=gen_random_uuid();
    perform pg_temp.month_expect_error(format('select public.post_em_dia_own_timer(%L,%L,%L,%L,15,%L,1)',v_timer_id,v_timer->>'version',v_post_id,v_day,''),'40001');
    perform pg_temp.month_expect_error(format('select public.post_em_dia_own_timer(%L,%L,%L,%L,15,%L,1,%L)',v_timer_id,v_timer->>'version',v_post_id,v_day,'','auxiliary'),'40001');
    v_result:=public.post_em_dia_own_timer(v_timer_id,(v_timer->>'version')::bigint,v_post_id,v_day,15,'',1,'regular');
    assert (v_result#>>'{diary,total_minutes}')::integer=105;
    v_result:=public.save_em_dia_own_condition(v_month,'publisher',v_revision,v_actor,v_group,v_person);
    v_revision:=(v_result->>'revision')::bigint;
    v_result:=public.save_em_dia_own_condition(v_month,'publisher',v_revision,v_actor,v_group,v_person);
    assert v_result->'unchanged'='true'::jsonb and (v_result->>'revision')::bigint=v_revision;
    v_snapshot:=public.read_em_dia_offline_snapshot();
    assert exists(select 1 from jsonb_array_elements(v_snapshot->'diaries') d where d->>'month'=v_month and d->>'kind'='publisher' and d->'can_use'='false'::jsonb and (d->>'total_minutes')::integer=105 and (d->>'version')::bigint=2 and jsonb_array_length(d->'launches')=2 and d#>>array['entries',v_day]='105');
    v_result:=public.save_em_dia_own_condition(v_month,'auxiliary',v_revision,v_actor,v_group,v_person);v_revision:=(v_result->>'revision')::bigint;
    v_hours:=public.read_em_dia_own_hour_launches(v_month);assert (v_hours->>'total_minutes')::integer=105 and (v_hours->>'version')::bigint=2;
    v_result:=public.save_em_dia_own_condition(v_month,'publisher',v_revision,v_actor,v_group,v_person);v_revision:=(v_result->>'revision')::bigint;
    reset role;
    select s.state into v_after from public.em_dia_states s where s.group_id=v_group;
    assert (v_before-'people'-'reports'-'revision'-'updatedAt')=(v_after-'people'-'reports'-'revision'-'updatedAt');
    assert (select jsonb_agg(p order by p->>'id') from jsonb_array_elements(v_before->'people') p where p->>'id'<>v_person)
      =(select jsonb_agg(p order by p->>'id') from jsonb_array_elements(v_after->'people') p where p->>'id'<>v_person);
    assert exists(select 1 from em_dia_private.daily_hours d where d.group_id=v_group and d.person_id=v_person and d.entries<>'{}'::jsonb);
  end loop;
  -- A receipt acknowledges the original committed intent even after a later choice.
  perform set_config('request.jwt.claim.sub',v_pub::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_pub,'role','authenticated')::text,true);
  select s.revision into v_revision from public.em_dia_states s where s.group_id=v_a;
  v_payload:=jsonb_build_object('userId',v_pub,'groupId',v_a,'personId','p_pub','month',v_month,'conditionKind','auxiliary','expectedRevision',v_revision);
  set local role authenticated;
  v_ack:=public.apply_em_dia_offline_operation(v_op,'month_condition',v_payload);
  v_result:=public.save_em_dia_own_condition(v_month,'regular',(v_ack#>>'{confirmation,revision}')::bigint,v_pub,v_a,'p_pub');
  v_before_revision:=(v_result->>'revision')::bigint;
  v_result:=public.apply_em_dia_offline_operation(v_op,'month_condition',v_payload);assert v_result->'replayed'='true'::jsonb;
  assert v_result->'confirmation'=v_ack->'confirmation';
  v_card:=public.read_em_dia_own_card();assert (v_card->>'revision')::bigint=v_before_revision;
  assert v_card#>>array['state','people','0','monthConditions',v_month]='regular';
  perform pg_temp.month_expect_error(format('select public.apply_em_dia_offline_operation(%L,%L,%L::jsonb)',gen_random_uuid(),'month_condition',v_payload::text),'40001');
  reset role;
  -- A legacy manager may edit roles but may not leave a conflicting explicit choice.
  select s.state,s.revision into v_state,v_revision from public.em_dia_states s where s.group_id=v_a;
  select p into v_before from jsonb_array_elements(v_state->'people') p where p->>'id'='p_pub';
  v_after:=em_dia_private.person_with_month_condition(v_before,v_month,'auxiliary')||jsonb_build_object('monthConditions',v_before->'monthConditions');
  v_state:=jsonb_set(v_state,'{people}',(select jsonb_agg(case when p->>'id'='p_pub' then v_after else p end order by n) from jsonb_array_elements(v_state->'people') with ordinality e(p,n)));
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  set local role authenticated;
  perform pg_temp.month_expect_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,%L)',v_a,v_state::text,v_revision),'22023');
  reset role;
end;
$$;
rollback;
select 'month_condition_security_ok' as result;
