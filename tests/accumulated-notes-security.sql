-- Run as postgres after the accumulated-hours/optional-notes migration.
-- All accounts, groups and diaries are disposable fixtures inside this rollback.
begin;
create temporary table em_dia_note_fixture_scope(marker boolean) on commit drop;
create function pg_temp.expect_note_error(p_query text,p_code text) returns void
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
grant execute on function pg_temp.expect_note_error(text,text) to authenticated;

do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_other_super uuid:=gen_random_uuid();
  v_publisher uuid:=gen_random_uuid();v_other_publisher uuid:=gen_random_uuid();v_outsider uuid:=gen_random_uuid();
  v_aux uuid:=gen_random_uuid();v_ordinary uuid:=gen_random_uuid();v_replacement uuid:=gen_random_uuid();
  v_group uuid:=gen_random_uuid();v_other_group uuid:=gen_random_uuid();
  v_a uuid:=gen_random_uuid();v_b uuid:=gen_random_uuid();v_c uuid:=gen_random_uuid();v_d uuid:=gen_random_uuid();
  v_seed_a uuid:=gen_random_uuid();v_seed_b uuid:=gen_random_uuid();v_zero uuid:=gen_random_uuid();
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_open text:=left(v_today,7);
  v_month text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '2 months','YYYY-MM');
  v_older text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '3 months','YYYY-MM');
  v_future text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 day','YYYY-MM-DD');
  v_note text:=E'<script>alert("fixture")</script>\nPRIVATE_DIARY_NOTE';
  v_person jsonb;v_other_person jsonb;v_aux_person jsonb;v_ordinary_person jsonb;v_state jsonb;v_empty jsonb;
  v_result jsonb;v_legacy jsonb;v_snapshot jsonb;v_before public.em_dia_states;v_before_revision jsonb;
  v_seed_row jsonb;v_version bigint:=0;v_prior_version bigint;v_revision bigint;v_workflow uuid;v_work_version bigint;
begin
  -- Definer routines run as a tightly scoped, non-login role under forced RLS.
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','INSERT');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','UPDATE');
  assert not has_table_privilege('anon','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('service_role','em_dia_private.daily_hours','SELECT');
  assert not has_function_privilege('anon','public.save_em_dia_own_hour_launch_note(uuid,text,integer,text,bigint)','EXECUTE');
  assert not has_function_privilege('service_role','public.save_em_dia_own_hour_launch_note(uuid,text,integer,text,bigint)','EXECUTE');
  assert not has_function_privilege('em_dia_writer','em_dia_private.save_own_hour_launch_note(uuid,text,integer,text,bigint)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.valid_hour_launches(text,jsonb,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.hour_launches_bundle(jsonb,jsonb,jsonb,bigint,timestamptz)','EXECUTE');
  assert not pg_has_role('authenticated','em_dia_workflow','MEMBER');
  assert (select not rolcanlogin and not rolbypassrls from pg_roles where rolname='em_dia_workflow');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.daily_hours'::regclass);
  assert (select not prosecdef and proconfig=array['search_path=""'] from pg_proc
    where oid='public.save_em_dia_own_hour_launch_note(uuid,text,integer,text,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' and proconfig=array['search_path=""'] from pg_proc
    where oid='em_dia_private.save_own_hour_launch_note(uuid,text,integer,text,bigint)'::regprocedure);

  -- Both legacy items and optional notes validate; 24h/50h are not ceilings.
  assert em_dia_private.valid_daily_entries('2024-02','{"2024-02-29":3300}'::jsonb);
  assert em_dia_private.valid_daily_entries('2024-02','{"2024-02-29":44640}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-02-01":44640,"2024-02-02":1}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2025-02','{"2025-02-29":0}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-03-01":0}'::jsonb);
  assert em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":3300}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1800),
      jsonb_build_object('id',v_b,'date','2024-02-29','minutes',1500,'note',v_note)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1,'note',null)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1,'note',1)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1,'note',repeat('x',1001))));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":1}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',1,'note','','extra','rejected')));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-29":44641}'::jsonb,
    jsonb_build_array(jsonb_build_object('id',v_a,'date','2024-02-29','minutes',44640),
      jsonb_build_object('id',v_b,'date','2024-02-29','minutes',1)));
  assert em_dia_private.valid_hour_launches('2024-02','{"2024-02-01":0}'::jsonb,
    (select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'date','2024-02-01','minutes',0)) from generate_series(1,1000)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-01":0}'::jsonb,
    (select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'date','2024-02-01','minutes',0)) from generate_series(1,1001)));
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-01":0}'::jsonb,
    (select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'date','2024-02-01','minutes',0,'note',repeat('x',1000))) from generate_series(1,300)));

  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'note-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_other_super,v_publisher,v_other_publisher,v_aux,v_ordinary,v_outsider,v_replacement]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_other_super,false,'superintendent'),
    (v_publisher,false,'publisher'),(v_other_publisher,false,'publisher'),(v_aux,false,'publisher'),(v_ordinary,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_group,'Note fixture A '||v_group,v_admin),(v_other_group,'Note fixture B '||v_other_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values
    (v_group,v_admin),(v_group,v_super),(v_other_group,v_other_super),(v_group,v_publisher),
    (v_group,v_other_publisher),(v_group,v_aux),(v_group,v_ordinary);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values
    (v_publisher,v_group,'note_main'),(v_other_publisher,v_group,'note_other'),
    (v_aux,v_group,'note_aux'),(v_ordinary,v_group,'note_ordinary');
  v_person:=jsonb_build_object('id','note_main','name','Note fixture main','startMonth','2024-01','endMonth',null,
    'notes','PRIVATE_CARD','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-01','end',null)));
  v_other_person:=jsonb_set(jsonb_set(v_person,'{id}','"note_other"'::jsonb),'{name}','"Note fixture other"'::jsonb);
  v_aux_person:=jsonb_build_object('id','note_aux','name','Note fixture auxiliary','startMonth','2024-01','endMonth',null,
    'notes','PRIVATE_AUX','roles',jsonb_build_array(jsonb_build_object('kind','auxiliary','start',v_month,'end',v_month)));
  v_ordinary_person:=jsonb_build_object('id','note_ordinary','name','Note fixture ordinary','startMonth','2024-01','endMonth',null,
    'notes','PRIVATE_ORDINARY','roles','[]'::jsonb);
  v_empty:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Note fixture','group','Note fixture','reminder',''),
    'people','[]'::jsonb,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','');
  v_state:=jsonb_set(v_empty,'{people}',jsonb_build_array(v_person,v_other_person,v_aux_person,v_ordinary_person));
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_group,null,v_state,1,now()),(v_other_group,null,v_empty,1,now());
  select * into v_before from public.em_dia_states where group_id=v_group;
  -- Existing three-property objects remain exactly as stored when only read.
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version,updated_at) values
    (v_group,'note_main',v_prior,jsonb_build_object(v_prior||'-01',90,v_prior||'-02',30),
      jsonb_build_array(jsonb_build_object('id',v_seed_a,'date',v_prior||'-01','minutes',90),
        jsonb_build_object('id',v_seed_b,'date',v_prior||'-02','minutes',30,'note','PRIVATE_LEGACY_SINGLETON')),7,now());
  select to_jsonb(d) into v_seed_row from em_dia_private.daily_hours d
    where group_id=v_group and person_id='note_main' and month=v_prior;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated',
    'user_metadata',jsonb_build_object('role','publisher','is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  perform pg_temp.expect_note_error(format('select public.read_em_dia_own_hour_launches(%L)',v_month),'42501');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,30,null,0)',v_a,v_month||'-01'),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_note_error('select * from em_dia_private.daily_hours','42501');
  perform pg_temp.expect_note_error(format('select public.read_em_dia_own_hour_launches(%L)',v_prior),'42501');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,30,''attempt'',0)',v_seed_a,v_prior||'-01'),'42501');
  reset role;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_prior);
  assert v_result#>>'{launches,0,note}'='' and v_result#>>'{launches,1,note}'='PRIVATE_LEGACY_SINGLETON';
  assert (v_result->>'version')::bigint=7 and (v_result->>'total_minutes')::integer=120;
  reset role;
  assert (select to_jsonb(d)=v_seed_row from em_dia_private.daily_hours d
    where group_id=v_group and person_id='note_main' and month=v_prior);
  set local role authenticated;
  v_legacy:=public.save_em_dia_own_hours(v_prior||'-02',1800,7);
  assert not(v_legacy ? 'launches') and (v_legacy->>'total_minutes')::integer=1890;
  v_prior_version:=(v_legacy->>'version')::bigint;
  v_result:=public.read_em_dia_own_hour_launches(v_prior);
  assert v_result#>>'{launches,1,note}'='PRIVATE_LEGACY_SINGLETON';
  v_result:=public.save_em_dia_own_hour_launch(v_seed_b,v_prior||'-02',1801,v_prior_version);
  assert v_result#>>'{launches,1,note}'='PRIVATE_LEGACY_SINGLETON';

  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->'entries'='{}'::jsonb and v_result->'launches'='[]'::jsonb and (v_result->>'version')::bigint=0;
  perform pg_temp.expect_note_error(format('select public.submit_em_dia_own_hours(%L,null,0,0,0)',v_month),'22023');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(null,%L,30,null,0)',v_month||'-01'),'22023');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,30,null,0)',v_a,'2025-02-29'),'22023');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,30,null,0)',v_a,v_future),'22023');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,44641,null,0)',v_a,v_month||'-01'),'22023');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,-1,null,0)',v_a,v_month||'-01'),'22023');
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_month||'-01',1800,v_note,0);
  v_version:=(v_result->>'version')::bigint;
  assert v_version=1 and (v_result->>'total_minutes')::integer=1800 and v_result#>>'{launches,0,note}'=v_note;
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_month||'-01',1800,v_note,0);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=v_version;
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,1800,''changed'',0)',v_a,v_month||'-01'),'40001');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,1800,%L,2)',v_a,v_month||'-01',v_note),'40001');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,1800,%L,1)',v_a,v_month||'-02',v_note),'22023');
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_month||'-01',1800,'PRIVATE_NOTE_CHANGED',v_version);
  assert (v_result->>'version')::bigint=v_version+1 and (v_result->>'total_minutes')::integer=1800;
  v_version:=(v_result->>'version')::bigint;
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_month||'-01',1800,null,v_version);
  assert v_result->'unchanged'='true'::jsonb and v_result#>>'{launches,0,note}'='PRIVATE_NOTE_CHANGED';
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_month||'-01',1800,'',v_version);
  v_version:=(v_result->>'version')::bigint;
  assert v_result#>>'{launches,0,note}'='';
  -- A second >24h launch on the same date raises the month above 50h.
  v_result:=public.save_em_dia_own_hour_launch_note(v_b,v_month||'-01',1500,v_note,v_version);
  v_version:=(v_result->>'version')::bigint;
  assert (v_result->>'total_minutes')::integer=3300 and v_result#>array['entries',v_month||'-01']='3300'::jsonb;
  assert jsonb_array_length(v_result->'launches')=2 and (select count(*)=1 from jsonb_object_keys(v_result->'entries'));
  v_legacy:=public.read_em_dia_own_hours(v_month);
  assert not(v_legacy ? 'launches') and not(v_legacy::text like '%PRIVATE_%') and v_legacy->'entries'=v_result->'entries';
  v_legacy:=public.save_em_dia_own_hours(v_month||'-01',3300,0);
  assert v_legacy->'unchanged'='true'::jsonb and (v_legacy->>'version')::bigint=v_version;
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hours(%L,3301,%s)',v_month||'-01',v_version),'22023');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hours(%L,null,%s)',v_month||'-01',v_version),'22023');
  v_result:=public.save_em_dia_own_hour_launch_note(v_b,v_month||'-01',1500,repeat('n',1000),v_version);
  v_version:=(v_result->>'version')::bigint;
  assert char_length(v_result#>>'{launches,1,note}')=1000;
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,1500,%L,%s)',v_b,v_month||'-01',repeat('n',1001),v_version),'22023');
  v_result:=public.save_em_dia_own_hour_launch(v_b,v_month||'-01',1501,v_version);
  v_version:=(v_result->>'version')::bigint;
  assert char_length(v_result#>>'{launches,1,note}')=1000;
  v_result:=public.save_em_dia_own_hour_launch_note(v_b,v_month||'-01',1500,v_note,v_version);
  v_version:=(v_result->>'version')::bigint;
  -- Null on a new item becomes blank; explicit zero remains an entry.
  v_result:=public.save_em_dia_own_hour_launch_note(v_c,v_month||'-02',0,null,v_version);
  v_version:=(v_result->>'version')::bigint;
  assert v_result#>>'{launches,2,note}'='' and v_result#>array['entries',v_month||'-02']='0'::jsonb;
  v_result:=public.save_em_dia_own_hour_launch_note(v_c,v_month||'-02',null,repeat('ignored',1001),v_version);
  v_version:=(v_result->>'version')::bigint;
  assert jsonb_array_length(v_result->'launches')=2 and not(v_result->'entries' ? (v_month||'-02'));
  assert v_result#>>'{launches,1,note}'=v_note;
  v_result:=public.save_em_dia_own_hour_launch_note(v_c,v_month||'-02',null,null,v_version-1);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=v_version;
  -- The existing 744h monthly boundary is exact, independent of date length.
  v_result:=public.save_em_dia_own_hour_launch_note(v_d,v_older||'-01',44640,'PRIVATE_LIMIT_NOTE',0);
  assert (v_result->>'total_minutes')::integer=44640;
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,1,null,1)',v_c,v_older||'-02'),'22023');
  assert (public.read_em_dia_own_hour_launches(v_older)->>'version')::bigint=1;
  reset role;
  assert (select to_jsonb(s)=to_jsonb(v_before) from public.em_dia_states s where group_id=v_group);
  assert not exists(select 1 from em_dia_private.report_revisions where group_id=v_group);
  set local role authenticated;
  -- Notes are draft-only: only the summed minutes enter the monthly workflow.
  v_result:=public.submit_em_dia_own_hours(v_month,null,2,v_version,0);
  assert v_result->>'status'='accepted' and (v_result->>'total_minutes')::integer=3300;
  assert not(v_result::text like '%PRIVATE_%');
  v_result:=public.read_em_dia_own_card();
  assert v_result#>array['state','reports',v_month,'note_main','hours']='55'::jsonb;
  assert v_result#>array['state','reports',v_month,'note_main','participated']='true'::jsonb;
  assert not(v_result::text like '%PRIVATE_%') and not(v_result::text like '%launches%');
  reset role;
  select * into v_before from public.em_dia_states where group_id=v_group;
  select to_jsonb(r) into v_before_revision from em_dia_private.report_revisions r
    where group_id=v_group and person_id='note_main' and month=v_month;
  assert not(v_before.state::text like '%PRIVATE_DIARY_NOTE%');
  assert not(v_before_revision::text like '%PRIVATE_DIARY_NOTE%');
  set local role authenticated;
  v_result:=public.save_em_dia_own_hour_launch_note(v_b,v_month||'-01',1500,'PRIVATE_AFTER_SUBMIT',v_version);
  v_version:=(v_result->>'version')::bigint;
  reset role;
  assert (select to_jsonb(s)=to_jsonb(v_before) from public.em_dia_states s where group_id=v_group);
  assert (select to_jsonb(r)=v_before_revision from em_dia_private.report_revisions r
    where group_id=v_group and person_id='note_main' and month=v_month);
  set local role authenticated;
  v_result:=public.save_em_dia_own_hour_launch_note(v_b,v_month||'-01',1530,'PRIVATE_PENDING_NOTE',v_version);
  v_version:=(v_result->>'version')::bigint;
  v_result:=public.submit_em_dia_own_hours(v_month,null,2,v_version,1);
  assert v_result->>'status'='pending' and not(v_result::text like '%PRIVATE_%');
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'note_main','hours']='55'::jsonb;
  reset role;
  select id,version into v_workflow,v_work_version from em_dia_private.report_revisions
    where group_id=v_group and person_id='note_main' and month=v_month;
  assert not exists(select 1 from em_dia_private.report_revisions r where group_id=v_group
    and (to_jsonb(r)::text like '%PRIVATE_%' or proposed_report ? 'launches' or proposed_report ? 'note'));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  v_result:=public.list_em_dia_report_revisions(v_group);
  assert not(v_result::text like '%PRIVATE_%') and not(v_result::text like '%launches%');
  perform public.review_em_dia_report_revision(v_workflow,v_work_version,'accept');
  reset role;
  assert (select state#>array['reports',v_month,'note_main','hours']='55.5'::jsonb
    and not(state::text like '%PRIVATE_PENDING_NOTE%') from public.em_dia_states where group_id=v_group);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_today,1800,'PRIVATE_OPEN_NOTE',0);
  perform pg_temp.expect_note_error(format('select public.submit_em_dia_own_hours(%L,true,0,1,0)',v_open),'22023');
  v_snapshot:=public.read_em_dia_own_hour_launches(v_month);
  reset role;

  -- Zero does not infer a negative participation response; absent diary is unknown.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_aux,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_aux::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->'entries'='{}'::jsonb and v_result->'launches'='[]'::jsonb;
  perform pg_temp.expect_note_error(format('select public.submit_em_dia_own_hours(%L,null,0,0,0)',v_month),'22023');
  v_result:=public.save_em_dia_own_hour_launch_note(v_zero,v_month||'-01',0,'PRIVATE_ZERO_NOTE',0);
  v_result:=public.submit_em_dia_own_hours(v_month,null,0,1,0);
  assert v_result->>'status'='accepted' and (v_result->>'total_minutes')::integer=0;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'note_aux','participated']='null'::jsonb;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ordinary,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_ordinary::text,true);
  set local role authenticated;
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,30,null,0)',v_a,v_month||'-01'),'22023');
  reset role;

  -- A guessed UUID remains scoped to the caller's card, never to another diary.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->'launches'='[]'::jsonb and not(v_result::text like '%PRIVATE_%');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,null,null,0)',v_a,v_month||'-01'),'22023');
  v_result:=public.save_em_dia_own_hour_launch_note(v_a,v_month||'-01',25,'PRIVATE_OTHER_NOTE',0);
  assert v_result->>'person_id'='note_other' and (v_result->>'total_minutes')::integer=25;
  reset role;
  assert (select launches=v_snapshot->'launches' and version=(v_snapshot->>'version')::bigint
    from em_dia_private.daily_hours where group_id=v_group and person_id='note_main' and month=v_month);
  -- Transfers include notes exactly and reject destination collisions atomically.
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version)
    values(v_other_group,'note_main',v_month,'{}'::jsonb,'[]'::jsonb,1);
  select revision into v_revision from public.em_dia_states where group_id=v_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_note_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_other_group,'note_main',v_revision),'22023');
  reset role;
  assert (select launches=v_snapshot->'launches' and version=(v_snapshot->>'version')::bigint
    from em_dia_private.daily_hours where group_id=v_group and person_id='note_main' and month=v_month);
  delete from em_dia_private.daily_hours where group_id=v_other_group and person_id='note_main';
  set local role authenticated;
  perform public.transfer_em_dia_publisher(v_group,v_other_group,'note_main',v_revision);
  reset role;
  assert not exists(select 1 from em_dia_private.daily_hours where group_id=v_group and person_id='note_main');
  assert (select count(*)=4 from em_dia_private.daily_hours where group_id=v_other_group and person_id='note_main');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->>'group_id'=v_other_group::text and v_result->'launches'=v_snapshot->'launches';
  assert v_result->'entries'=v_snapshot->'entries' and v_result->'version'=v_snapshot->'version';
  reset role;
  -- Login reassignment changes permission, preserving every stored observation.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  perform public.provision_em_dia_access(v_publisher,'superintendent',v_other_group,null);
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_super::text,true);
  set local role authenticated;
  perform public.provision_em_dia_publisher_account(v_replacement,v_other_group,'note_main');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_note_error(format('select public.read_em_dia_own_hour_launches(%L)',v_month),'42501');
  perform pg_temp.expect_note_error(format('select public.save_em_dia_own_hour_launch_note(%L,%L,1530,''forbidden'',%s)',v_b,v_month||'-01',v_version),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_replacement,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_replacement::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hour_launches(v_month);
  assert v_result->'launches'=v_snapshot->'launches' and v_result->'version'=v_snapshot->'version';
  assert v_result#>>'{launches,1,note}'='PRIVATE_PENDING_NOTE';
  reset role;
end;
$$;
rollback;
select 'Accumulated hours, optional notes, legacy preservation, CAS, privacy, totals and transfer passed; all fixtures rolled back.' as result;
