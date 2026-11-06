-- Run after the multiple-launch migration. Only disposable fixtures are written.
begin;
create temporary table em_dia_launch_fixture_scope(marker boolean) on commit drop;
create function pg_temp.expect_launch_error(p_query text,p_code text) returns void
language plpgsql security invoker set search_path='' as $$
declare v_failed boolean:=false;
begin
  begin execute p_query;
  exception when others then
    if sqlstate<>p_code then raise; end if;
    v_failed:=true;
  end;
  assert v_failed,'Expected SQLSTATE '||p_code||' was not raised';
end;
$$;
do $$ begin execute format('grant usage on schema %s to authenticated',pg_my_temp_schema()::regnamespace); end; $$;
grant execute on function pg_temp.expect_launch_error(text,text) to authenticated;

do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_other_super uuid:=gen_random_uuid();
  v_publisher uuid:=gen_random_uuid();v_other_publisher uuid:=gen_random_uuid();v_outsider uuid:=gen_random_uuid();v_replacement uuid:=gen_random_uuid();
  v_group uuid:=gen_random_uuid();v_other_group uuid:=gen_random_uuid();
  v_a uuid:=gen_random_uuid();v_b uuid:=gen_random_uuid();v_c uuid:=gen_random_uuid();v_d uuid:=gen_random_uuid();
  v_e uuid:=gen_random_uuid();v_f uuid:=gen_random_uuid();v_g uuid:=gen_random_uuid();v_h uuid:=gen_random_uuid();v_zero uuid:=gen_random_uuid();
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_open text:=left(v_today,7);
  v_month text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '2 months','YYYY-MM');
  v_future text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 day','YYYY-MM-DD');
  v_state jsonb;v_person jsonb;v_other_person jsonb;v_result jsonb;v_legacy jsonb;v_before public.em_dia_states;
  v_version bigint:=0;v_revision bigint;v_workflow uuid;v_work_version bigint;v_snapshot jsonb;
begin
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','UPDATE');
  assert not has_table_privilege('service_role','em_dia_private.daily_hours','SELECT');
  assert not has_function_privilege('anon','public.read_em_dia_own_hour_launches(text)','EXECUTE');
  assert not has_function_privilege('service_role','public.save_em_dia_own_hour_launch(uuid,text,integer,bigint)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.valid_hour_launches(text,jsonb,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.launches_entries(jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.hour_launches_bundle(jsonb,jsonb,jsonb,bigint,timestamptz)','EXECUTE');
  assert not pg_has_role('authenticated','em_dia_workflow','MEMBER');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.daily_hours'::regclass);
  assert (select not prosecdef from pg_proc where oid='public.save_em_dia_own_hour_launch(uuid,text,integer,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' from pg_proc
    where oid='em_dia_private.save_own_hour_launch(uuid,text,integer,bigint)'::regprocedure);
  assert not exists(select 1 from em_dia_private.daily_hours d
    where not em_dia_private.valid_hour_launches(d.month,d.entries,d.launches));
  assert em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":90}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',60),
      jsonb_build_object('id',v_b,'date','2024-02-29','minutes',30)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":91}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',90)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":90}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',60),
      jsonb_build_object('id',v_a,'date','2024-02-29','minutes',30)));
  assert not em_dia_private.valid_hour_launches('2025-02','{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2025-02-29','minutes',0)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',0.5)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1,'notes','UNWANTED')));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":44641}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1440),
      jsonb_build_object('id',v_b,'date','2024-02-29','minutes',43201)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-01":0}'::jsonb,
    (select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'date','2024-02-01','minutes',0)) from generate_series(1,1001)));

  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'launch-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_other_super,v_publisher,v_other_publisher,v_outsider,v_replacement]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_other_super,false,'superintendent'),
    (v_publisher,false,'publisher'),(v_other_publisher,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_group,'Launch fixture A '||v_group,v_admin),(v_other_group,'Launch fixture B '||v_other_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values
    (v_group,v_admin),(v_group,v_super),(v_other_group,v_other_super),(v_group,v_publisher),(v_group,v_other_publisher);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values
    (v_publisher,v_group,'launch_main'),(v_other_publisher,v_group,'launch_other');
  v_person:=jsonb_build_object('id','launch_main','name','Launch fixture main','startMonth','2024-01','endMonth',null,
    'notes','PRIVATE_MAIN_NOTE','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-01','end',null)));
  v_other_person:=jsonb_build_object('id','launch_other','name','PRIVATE_OTHER_NAME','startMonth','2024-01','endMonth',null,
    'notes','PRIVATE_OTHER_NOTE','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-01','end',null)));
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Launch fixture','group','Launch fixture','reminder',''),
    'people',jsonb_build_array(v_person,v_other_person),'reports',jsonb_build_object(v_prior,jsonb_build_object(
      'launch_main',jsonb_build_object('received',true,'kind','regular','participated',true,'hours',17.5,'studies',1,
        'notes','PRIVATE_REPORT','receivedDate',v_prior||'-01','updatedAt',now()))),
    'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','PRIVATE_SOURCE');
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_group,null,v_state,1,now()),
    (v_other_group,null,jsonb_set(jsonb_set(v_state,'{people}','[]'::jsonb),'{reports}','{}'::jsonb),1,now());
  select * into v_before from public.em_dia_states where group_id=v_group;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated',
    'user_metadata',jsonb_build_object('role','publisher','is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  perform pg_temp.expect_launch_error(format('select public.read_em_dia_own_hour_launches(%L)',v_month),'42501');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,60,0)',v_a,v_month||'-01'),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_launch_error(format('select public.read_em_dia_own_hour_launches(%L)',v_month),'42501');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,60,0)',v_a,v_month||'-01'),'42501');
  reset role;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_launch_error('select * from em_dia_private.daily_hours','42501');
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->>'person_id'='launch_main' and v_result->>'group_id'=v_group::text;
  assert v_result->'launches'='[]'::jsonb and v_result->'entries'='{}'::jsonb and (v_result->>'version')::bigint=0;
  assert not(v_result::text like '%PRIVATE_%');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(null,%L,30,0)',v_month||'-01'),'22023');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,30,0)',v_a,'2025-02-29'),'22023');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,30,0)',v_a,v_future),'22023');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,44641,0)',v_a,v_month||'-01'),'22023');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,-1,0)',v_a,v_month||'-01'),'22023');

  v_result:=public.save_em_dia_own_hour_launch(v_a,v_month||'-01',80,0);v_version:=(v_result->>'version')::bigint;
  assert v_version=1 and (v_result->>'total_minutes')::integer=80 and jsonb_array_length(v_result->'launches')=1;
  v_result:=public.save_em_dia_own_hour_launch(v_a,v_month||'-01',80,0);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=1;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,80,2)',v_a,v_month||'-01'),'40001');
  v_result:=public.save_em_dia_own_hour_launch(v_b,v_month||'-01',40,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=2 and (v_result->>'total_minutes')::integer=120 and jsonb_array_length(v_result->'launches')=2;
  assert v_result#>array['entries',v_month||'-01']='120'::jsonb;
  assert (select count(*)=1 from jsonb_object_keys(v_result->'entries'));
  v_legacy:=public.read_em_dia_own_hours(v_month);
  assert not(v_legacy ? 'launches') and v_legacy->'entries'=v_result->'entries';
  v_legacy:=public.save_em_dia_own_hours(v_month||'-01',120,0);
  assert v_legacy->'unchanged'='true'::jsonb and (v_legacy->>'version')::bigint=2;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hours(%L,121,2)',v_month||'-01'),'22023');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hours(%L,null,2)',v_month||'-01'),'22023');
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,41,1)',v_b,v_month||'-01'),'40001');
  v_result:=public.save_em_dia_own_hour_launch(v_b,v_month||'-01',60,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=3 and v_result#>array['entries',v_month||'-01']='140'::jsonb;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,60,3)',v_b,v_month||'-02'),'22023');
  v_result:=public.save_em_dia_own_hour_launch(v_a,v_month||'-01',null,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=4 and jsonb_array_length(v_result->'launches')=1 and v_result#>array['entries',v_month||'-01']='60'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch(v_a,v_month||'-01',null,3);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=4;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,null,4)',v_c,v_month||'-01'),'22023');
  v_result:=public.save_em_dia_own_hours(v_month||'-01',75,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=5;
  assert public.read_em_dia_own_hour_launches(v_month)#>>'{launches,0,id}'=v_b::text;
  v_result:=public.save_em_dia_own_hours(v_month||'-01',null,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=6 and v_result->'entries'='{}'::jsonb;
  assert public.read_em_dia_own_hour_launches(v_month)->'launches'='[]'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch(v_zero,v_month||'-01',0,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=7 and v_result#>array['entries',v_month||'-01']='0'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch(v_c,v_month||'-01',30,v_version);v_version:=(v_result->>'version')::bigint;
  v_result:=public.save_em_dia_own_hour_launch(v_zero,v_month||'-01',null,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=9 and v_result#>array['entries',v_month||'-01']='30'::jsonb;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,44641,9)',v_d,v_month||'-01'),'22023');
  v_result:=public.save_em_dia_own_hour_launch(v_d,v_month||'-01',1410,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=10 and v_result#>array['entries',v_month||'-01']='1440'::jsonb;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,44641,10)',v_e,v_month||'-01'),'22023');
  v_result:=public.save_em_dia_own_hour_launch(v_e,v_month||'-02',1300,v_version);v_version:=(v_result->>'version')::bigint;
  v_result:=public.save_em_dia_own_hour_launch(v_f,v_month||'-03',410,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=12 and (v_result->>'total_minutes')::integer=3150;
  reset role;
  -- All edits so far were private drafts, including a month above 50 hours.
  assert (select to_jsonb(s)=to_jsonb(v_before) from public.em_dia_states s where s.group_id=v_group);
  set local role authenticated;
  v_result:=public.submit_em_dia_own_hours(v_month,null,2,v_version,0);
  assert v_result->>'status'='accepted' and (v_result->>'total_minutes')::integer=3150;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'launch_main','hours']='52.5'::jsonb;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'launch_main','participated']='true'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch(v_g,v_month||'-03',20,v_version);v_version:=(v_result->>'version')::bigint;
  v_result:=public.submit_em_dia_own_hours(v_month,null,2,v_version,1);
  assert v_result->>'status'='pending' and public.read_em_dia_own_card()#>array['state','reports',v_month,'launch_main','hours']='52.5'::jsonb;
  reset role;
  select id,version into v_workflow,v_work_version from em_dia_private.report_revisions
    where group_id=v_group and person_id='launch_main' and month=v_month;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform public.review_em_dia_report_revision(v_workflow,v_work_version,'accept');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'launch_main','hours']='52.83'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch(v_h,v_month||'-03',10,v_version);v_version:=(v_result->>'version')::bigint;
  v_result:=public.submit_em_dia_own_hours(v_month,true,2,v_version,3);
  assert v_result->>'status'='pending';
  reset role;
  select version into v_work_version from em_dia_private.report_revisions where id=v_workflow;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform public.review_em_dia_report_revision(v_workflow,v_work_version,'ignore');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'launch_main','hours']='52.83'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch(v_a,v_today,60,0);
  v_result:=public.save_em_dia_own_hour_launch(v_b,v_today,30,1);
  assert (v_result->>'total_minutes')::integer=90 and jsonb_array_length(v_result->'launches')=2;
  v_result:=public.submit_em_dia_own_hours(v_open,true,0,2,0);
  assert v_result->>'status'='accepted' and (v_result->>'total_minutes')::integer=90;
  v_snapshot:=public.read_em_dia_own_hour_launches(v_month);
  reset role;

  -- Knowing another card's launch ID never selects that card's diary.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_launch_error(format('select public.save_em_dia_own_hour_launch(%L,%L,null,0)',v_d,v_month||'-01'),'22023');
  v_result:=public.save_em_dia_own_hour_launch(v_d,v_month||'-01',25,0);
  assert v_result->>'person_id'='launch_other' and (v_result->>'total_minutes')::integer=25;
  reset role;
  assert (select entries#>array[v_month||'-01']='1440'::jsonb from em_dia_private.daily_hours
    where group_id=v_group and person_id='launch_main' and month=v_month);
  -- A destination collision is rejected without changing launches or versions.
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version)
    values(v_other_group,'launch_main',v_month,'{}'::jsonb,'[]'::jsonb,1);
  select revision into v_revision from public.em_dia_states where group_id=v_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_launch_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_other_group,'launch_main',v_revision),'22023');
  reset role;
  delete from em_dia_private.daily_hours where group_id=v_other_group and person_id='launch_main';
  set local role authenticated;
  perform public.transfer_em_dia_publisher(v_group,v_other_group,'launch_main',v_revision);
  reset role;
  assert not exists(select 1 from em_dia_private.daily_hours where group_id=v_group and person_id='launch_main');
  assert (select count(*)=2 from em_dia_private.daily_hours where group_id=v_other_group and person_id='launch_main');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->>'group_id'=v_other_group::text and v_result->'launches'=v_snapshot->'launches';
  assert v_result->'entries'=v_snapshot->'entries' and v_result->'version'=v_snapshot->'version';
  reset role;

  -- Replacing a login changes access, not the separate launches on its card.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  perform public.provision_em_dia_access(v_publisher,'superintendent',v_other_group,null);
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_super::text,true);
  set local role authenticated;
  perform public.provision_em_dia_publisher_account(v_replacement,v_other_group,'launch_main');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_launch_error(format('select public.read_em_dia_own_hour_launches(%L)',v_month),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_replacement,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_replacement::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->'launches'=v_snapshot->'launches' and v_result->'version'=v_snapshot->'version';
  assert not(v_result::text like '%PRIVATE_%');
  reset role;
end;
$$;
rollback;
select 'Multiple launches, private scope, totals, CAS, legacy safety, review and transfer passed; all fixtures rolled back.' as result;
