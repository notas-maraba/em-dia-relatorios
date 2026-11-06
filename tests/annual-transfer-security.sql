-- Suite 2: annual authorization, privacy, guards, active timer and card transfer.
-- Fictional fixtures only. Run as postgres after the annual-progress migration.
-- Every account, card, goal and historical value is rolled back.
begin;
create temporary table em_dia_annual_transfer_fixture_scope(marker boolean) on commit drop;
create function pg_temp.expect_annual_error(p_query text,p_code text) returns void
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
grant execute on function pg_temp.expect_annual_error(text,text) to authenticated;

do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_other_super uuid:=gen_random_uuid();
  v_publisher uuid:=gen_random_uuid();v_other_publisher uuid:=gen_random_uuid();v_ordinary uuid:=gen_random_uuid();
  v_aux uuid:=gen_random_uuid();v_outsider uuid:=gen_random_uuid();v_replacement uuid:=gen_random_uuid();
  v_group uuid:=gen_random_uuid();v_other_group uuid:=gen_random_uuid();v_timer uuid:=gen_random_uuid();
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_current_year integer;v_future text;v_result jsonb;v_month jsonb;v_context jsonb;
  v_person jsonb;v_other_person jsonb;v_ordinary_person jsonb;v_aux_person jsonb;v_guard_person jsonb;v_empty jsonb;v_state jsonb;
  v_timer_snapshot jsonb;v_state_snapshot jsonb;v_diary_snapshot jsonb;v_revision_snapshot jsonb;v_annual_snapshot jsonb;
  v_row em_dia_private.annual_progress;v_version bigint;v_revision bigint;
begin
  assert not has_table_privilege('authenticated','em_dia_private.annual_progress','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.annual_progress','UPDATE');
  assert not has_table_privilege('anon','em_dia_private.annual_progress','SELECT');
  assert not has_table_privilege('service_role','em_dia_private.annual_progress','SELECT');
  assert not has_table_privilege('em_dia_writer','em_dia_private.annual_progress','SELECT');
  assert not has_table_privilege('em_dia_workflow','em_dia_private.annual_progress','DELETE');
  assert not has_function_privilege('anon','public.read_em_dia_own_annual(integer)','EXECUTE');
  assert not has_function_privilege('service_role','public.save_em_dia_own_annual_goal(integer,integer,bigint)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.own_annual_context(integer)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.valid_annual_retro(integer,jsonb)','EXECUTE');
  assert not pg_has_role('authenticated','em_dia_workflow','MEMBER');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.annual_progress'::regclass);
  assert (select not rolcanlogin and not rolbypassrls from pg_roles where rolname='em_dia_workflow');
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' and proconfig=array['search_path=""'] from pg_proc
    where oid='em_dia_private.save_own_annual_retro(integer,text,integer,integer,bigint)'::regprocedure);
  assert (select not prosecdef and proconfig=array['search_path=""'] from pg_proc
    where oid='public.save_em_dia_own_annual_retro(integer,text,integer,integer,bigint)'::regprocedure);
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'annual-transfer-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_other_super,v_publisher,v_other_publisher,v_ordinary,v_aux,v_outsider,v_replacement]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_other_super,false,'superintendent'),
    (v_publisher,false,'publisher'),(v_other_publisher,false,'publisher'),(v_ordinary,false,'publisher'),(v_aux,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_group,'Annual fixture A '||v_group,v_admin),(v_other_group,'Annual fixture B '||v_other_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values
    (v_group,v_admin),(v_group,v_super),(v_other_group,v_other_super),
    (v_group,v_publisher),(v_group,v_other_publisher),(v_group,v_ordinary),(v_group,v_aux);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values
    (v_publisher,v_group,'annual_main'),(v_other_publisher,v_group,'annual_other'),
    (v_ordinary,v_group,'annual_ordinary'),(v_aux,v_group,'annual_aux');
  v_person:=jsonb_build_object('id','annual_main','name','Annual fixture main','startMonth','2024-11','endMonth',null,
    'notes','PRIVATE_CARD_NOTE','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-11','end',null)));
  v_other_person:=jsonb_build_object('id','annual_other','name','PRIVATE_OTHER_CARD','startMonth','2024-01','endMonth',null,
    'notes','','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-01','end',null)));
  v_ordinary_person:=jsonb_build_object('id','annual_ordinary','name','Annual fixture ordinary','startMonth','2024-01','endMonth',null,
    'notes','','roles','[]'::jsonb);
  v_aux_person:=jsonb_build_object('id','annual_aux','name','Annual fixture auxiliary','startMonth','2024-01','endMonth',null,
    'notes','','roles',jsonb_build_array(jsonb_build_object('kind','auxiliary','start','2024-01','end',null)));
  v_guard_person:=jsonb_set(jsonb_set(v_other_person,'{id}','"annual_guard"'::jsonb),'{name}','"Annual fixture guard"'::jsonb);
  v_empty:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Annual fixture','group','Annual fixture','reminder',''),
    'people','[]'::jsonb,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',left(v_today,7),'sourceNote','');
  v_state:=jsonb_set(v_empty,'{people}',jsonb_build_array(v_person,v_other_person,v_ordinary_person,v_aux_person,v_guard_person));
  v_state:=jsonb_set(v_state,'{reports}','{"2024-12":{"annual_main":{"received":true,"kind":"regular","participated":true,"hours":1.23,"studies":3,"notes":"PRIVATE_REPORT","receivedDate":"2025-01-01","updatedAt":"2025-01-01T00:00:00Z"}}}'::jsonb);
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_group,null,v_state,1,now()),(v_other_group,null,v_empty,1,now());
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version) values
    (v_group,'annual_main','2024-12','{"2024-12-01":999}',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date','2024-12-01','minutes',999,'note','PRIVATE_DIARY_NOTE')),2),
    (v_group,'annual_main','2025-01','{"2025-01-01":0}',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date','2025-01-01','minutes',0)),3);
  insert into em_dia_private.annual_progress(group_id,person_id,service_year,target_minutes,retro_months,version) values
    (v_group,'annual_main',2024,36000,'{"2025-01":{"minutes":30,"studies":2}}',5),
    (v_group,'annual_main',2023,33000,'{"2023-09":{"minutes":1000,"studies":2}}',2);
  insert into em_dia_private.report_revisions(group_id,person_id,user_id,month,status,version,base_activity,proposed_report)
    values(v_group,'annual_main',v_publisher,'2025-03','pending',1,null,
      '{"received":true,"kind":"regular","participated":true,"hours":100,"studies":9}');
  insert into em_dia_private.service_timers(group_id,person_id,version,status,timer_id,start_date,started_at,anchor_at,last_posted_receipt)
    values(v_group,'annual_main',7,'running',v_timer,v_today::date,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',
      jsonb_build_object('timer_id',gen_random_uuid(),'launch_id',gen_random_uuid(),'date',v_today,'minutes',10,'note','PRIVATE_TIMER_RECEIPT','posted_at',now()));
  select to_jsonb(t) into v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='annual_main';
  select to_jsonb(s) into v_state_snapshot from public.em_dia_states s where group_id=v_group;
  select jsonb_agg(to_jsonb(d) order by month) into v_diary_snapshot from em_dia_private.daily_hours d where group_id=v_group;
  select jsonb_agg(to_jsonb(r) order by month) into v_revision_snapshot from em_dia_private.report_revisions r where group_id=v_group;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated',
    'user_metadata',jsonb_build_object('role','publisher','is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(2024)','42501');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_goal(2024,30000,0)','42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_annual_error('select * from em_dia_private.annual_progress','42501');
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(2024)','42501');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-09'',60,1,0)','42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_aux,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_aux::text,true);
  set local role authenticated;
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(2024)','42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ordinary,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_ordinary::text,true);
  set local role authenticated;
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(2024)','42501');
  reset role;

  -- Independent access-suite fixture: create personal data through the API,
  -- then verify that existing reports, drafts and an active timer did not move.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.save_em_dia_own_annual_goal(2024,25200,5);
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-09',1800,2,(v_result->>'version')::bigint);
  v_version:=(v_result->>'version')::bigint;
  reset role;
  assert (select to_jsonb(t)=v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='annual_main');
  assert (select to_jsonb(s)=v_state_snapshot from public.em_dia_states s where group_id=v_group);
  assert (select jsonb_agg(to_jsonb(d) order by month)=v_diary_snapshot from em_dia_private.daily_hours d where group_id=v_group);
  assert (select jsonb_agg(to_jsonb(r) order by month)=v_revision_snapshot from em_dia_private.report_revisions r where group_id=v_group);
  v_current_year:=left(v_today,4)::integer-case when substring(v_today,6,2)<'09' then 1 else 0 end;
  v_future:=(v_current_year+1)::text||'-08';
  -- Another publisher is scoped to a distinct card, with no IDs supplied by
  -- the caller that could select this person's annual row.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_annual(2024);
  assert v_result->>'person_id'='annual_other' and (v_result->>'version')::bigint=0;
  assert v_result#>>'{months,0,source}'='missing' and not(v_result::text like '%PRIVATE_%');
  v_result:=public.save_em_dia_own_annual_goal(2024,30000,0);
  assert v_result->>'person_id'='annual_other' and (v_result->>'version')::bigint=1;
  v_result:=public.read_em_dia_own_annual(v_current_year);
  perform pg_temp.expect_annual_error(format('select public.save_em_dia_own_annual_retro(%s,%L,60,1,%s)',
    v_current_year,left(v_today,7),(v_result->>'version')::bigint),'22023');
  if substring(v_today,6,2)<>'08' then
    perform pg_temp.expect_annual_error(format('select public.save_em_dia_own_annual_retro(%s,%L,60,1,%s)',
      v_current_year,v_future,(v_result->>'version')::bigint),'22023');
  end if;
  reset role;
  assert (select version=v_version and target_minutes=25200 from em_dia_private.annual_progress
    where group_id=v_group and person_id='annual_main' and service_year=2024);

  -- Goals/history on an unlinked card are still protected against reset.
  insert into em_dia_private.annual_progress(group_id,person_id,service_year,version) values(v_group,'annual_guard',2024,1);
  v_result:=jsonb_set(v_state,'{people}',jsonb_build_array(v_person,v_other_person,v_ordinary_person,v_aux_person));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_annual_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,1)',v_group,v_result),'22023');
  reset role;
  delete from em_dia_private.annual_progress where group_id=v_group and person_id='annual_guard';
  set local role authenticated;
  perform public.save_em_dia_group_state(v_group,v_result,1);
  reset role;
  -- Annual-only destination collisions must not merge either card's history.
  insert into em_dia_private.annual_progress(group_id,person_id,service_year,version) values(v_other_group,'annual_main',2024,1);
  select revision into v_revision from public.em_dia_states where group_id=v_group;
  select jsonb_agg(to_jsonb(a)-'group_id' order by service_year) into v_annual_snapshot from em_dia_private.annual_progress a
    where group_id=v_group and person_id='annual_main';
  set local role authenticated;
  perform pg_temp.expect_annual_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_other_group,'annual_main',v_revision),'22023');
  reset role;
  assert (select jsonb_agg(to_jsonb(a)-'group_id' order by service_year)=v_annual_snapshot from em_dia_private.annual_progress a
    where group_id=v_group and person_id='annual_main');
  assert (select to_jsonb(t)=v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='annual_main');
  delete from em_dia_private.annual_progress where group_id=v_other_group and person_id='annual_main';
  set local role authenticated;
  perform public.transfer_em_dia_publisher(v_group,v_other_group,'annual_main',v_revision);
  reset role;
  assert not exists(select 1 from em_dia_private.annual_progress where group_id=v_group and person_id='annual_main');
  assert (select jsonb_agg(to_jsonb(a)-'group_id' order by service_year)=v_annual_snapshot from em_dia_private.annual_progress a
    where group_id=v_other_group and person_id='annual_main');
  assert (select to_jsonb(t)-'group_id'=v_timer_snapshot-'group_id' from em_dia_private.service_timers t where group_id=v_other_group and person_id='annual_main');
  -- Replacing a login preserves the annual data and running timer by card.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  perform public.provision_em_dia_access(v_publisher,'superintendent',v_other_group,null);
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_super::text,true);
  set local role authenticated;
  perform public.provision_em_dia_publisher_account(v_replacement,v_other_group,'annual_main');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(2024)','42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_replacement,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_replacement::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_annual(2024);
  assert v_result->>'group_id'=v_other_group::text and (v_result->>'version')::bigint=v_version;
  assert (v_result->>'target_minutes')::integer=25200 and v_result#>'{months,0,minutes}'='1800'::jsonb;
  assert public.read_em_dia_own_timer()->>'timer_id'=v_timer::text;
  assert not(v_result::text like '%PRIVATE_%');
  reset role;
end;
$$;
rollback;
select 'Annual access, privacy, guard, active timer, transfer and login reassignment passed; all fixtures rolled back.' as result;
