-- Suite 1: annual rules, cycle, source priority, goals and historical-total CAS.
-- Fictional fixtures only. Run as postgres after the annual-progress migration.
-- Every account, card, goal and historical value is rolled back.
begin;
create temporary table em_dia_annual_fixture_scope(marker boolean) on commit drop;
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
  v_admin uuid:=gen_random_uuid();v_publisher uuid:=gen_random_uuid();v_group uuid:=gen_random_uuid();
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_current_year integer;v_future text;v_result jsonb;v_context jsonb;v_person jsonb;v_empty jsonb;v_state jsonb;
  v_state_snapshot jsonb;v_diary_snapshot jsonb;v_revision_snapshot jsonb;
  v_row em_dia_private.annual_progress;v_version bigint;
begin
  assert em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":0,"studies":0},"2025-08":{"minutes":44640,"studies":9999}}');
  assert em_dia_private.valid_annual_retro(2198,'{"2199-08":{"minutes":0,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2199,'{}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-08":{"minutes":0,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2025-09":{"minutes":0,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-13":{"minutes":0,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":null,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":0.5,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":44641,"studies":0}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":0,"studies":10000}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":0,"studies":0,"note":"rejected"}}');
  assert not em_dia_private.valid_annual_retro(2024,'{"2024-09":{"minutes":0}}');

  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'annual-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_publisher]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_publisher,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values(v_group,'Annual rules fixture '||v_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values(v_group,v_admin),(v_group,v_publisher);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(v_publisher,v_group,'annual_main');
  v_person:=jsonb_build_object('id','annual_main','name','Annual fixture main','startMonth','2024-11','endMonth','2025-07',
    'notes','PRIVATE_CARD_NOTE','roles',jsonb_build_array(
      jsonb_build_object('kind','regular','start','2024-11','end','2025-04'),
      jsonb_build_object('kind','auxiliary','start','2025-05','end','2025-06'),
      jsonb_build_object('kind','regular','start','2025-07','end',null)));
  v_empty:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Annual fixture','group','Annual fixture','reminder',''),
    'people','[]'::jsonb,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',left(v_today,7),'sourceNote','');
  v_state:=jsonb_set(v_empty,'{people}',jsonb_build_array(v_person));
  v_state:=jsonb_set(v_state,'{reports}',jsonb_build_object(
    '2024-11',jsonb_build_object('annual_main',jsonb_build_object('received',true,'kind','regular','participated',true,'hours',null,'studies',4,'notes','PRIVATE_REPORT','receivedDate','2024-12-01','updatedAt',now())),
    '2024-12',jsonb_build_object('annual_main',jsonb_build_object('received',true,'kind','regular','participated',true,'hours',1.23,'studies',3,'notes','','receivedDate','2025-01-01','updatedAt',now())),
    '2025-04',jsonb_build_object('annual_main',jsonb_build_object('received',true,'kind','auxiliary','participated',true,'hours',30,'studies',1,'notes','','receivedDate','2025-05-01','updatedAt',now())),
    '2025-06',jsonb_build_object('annual_main',jsonb_build_object('received',true,'kind','regular','participated',true,'hours',50,'studies',2,'notes','','receivedDate','2025-07-01','updatedAt',now()))));
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_group,null,v_state,1,now());
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version) values
    (v_group,'annual_main','2024-12','{"2024-12-01":999}',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date','2024-12-01','minutes',999,'note','PRIVATE_DIARY_NOTE')),2),
    (v_group,'annual_main','2025-01','{"2025-01-01":0}',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date','2025-01-01','minutes',0)),3);
  insert into em_dia_private.annual_progress(group_id,person_id,service_year,target_minutes,retro_months,version) values
    (v_group,'annual_main',2024,36000,'{"2024-12":{"minutes":500,"studies":5},"2025-01":{"minutes":30,"studies":2},"2025-02":{"minutes":0,"studies":0},"2025-04":{"minutes":400,"studies":4},"2025-05":{"minutes":600,"studies":6}}',5);
  insert into em_dia_private.report_revisions(group_id,person_id,user_id,month,status,version,base_activity,proposed_report)
    values(v_group,'annual_main',v_publisher,'2025-03','pending',1,null,
      '{"received":true,"kind":"regular","participated":true,"hours":100,"studies":9}');
  select to_jsonb(s) into v_state_snapshot from public.em_dia_states s where group_id=v_group;
  select jsonb_agg(to_jsonb(d) order by month) into v_diary_snapshot from em_dia_private.daily_hours d where group_id=v_group;
  select jsonb_agg(to_jsonb(r) order by month) into v_revision_snapshot from em_dia_private.report_revisions r where group_id=v_group;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_annual(2024);
  assert v_result->>'person_id'='annual_main' and v_result->>'group_id'=v_group::text;
  assert (v_result->>'target_minutes')::integer=36000 and (v_result->>'version')::bigint=5;
  assert jsonb_array_length(v_result->'months')=12 and v_result#>>'{months,0,month}'='2024-09' and v_result#>>'{months,11,month}'='2025-08';
  assert v_result#>>'{months,0,kind}'='regular' and v_result#>>'{months,0,source}'='missing';
  assert v_result#>'{months,0,minutes}'='null'::jsonb and v_result#>'{months,0,can_edit_retro}'='true'::jsonb;
  assert v_result#>>'{months,2,source}'='approved' and v_result#>'{months,2,minutes}'='null'::jsonb and v_result#>'{months,2,studies}'='4'::jsonb;
  assert v_result#>>'{months,3,source}'='approved' and v_result#>'{months,3,minutes}'='74'::jsonb and v_result#>'{months,3,studies}'='3'::jsonb;
  assert v_result#>'{months,3,retro_minutes}'='500'::jsonb and v_result#>'{months,3,can_edit_retro}'='false'::jsonb;
  assert v_result#>>'{months,4,source}'='diary' and v_result#>'{months,4,minutes}'='0'::jsonb and v_result#>'{months,4,studies}'='null'::jsonb;
  assert v_result#>'{months,4,retro_minutes}'='30'::jsonb and v_result#>'{months,4,can_edit_retro}'='false'::jsonb;
  assert v_result#>>'{months,5,source}'='retroactive' and v_result#>'{months,5,minutes}'='0'::jsonb and v_result#>'{months,5,studies}'='0'::jsonb;
  assert v_result#>>'{months,6,source}'='missing' and v_result#>'{months,6,minutes}'='null'::jsonb;
  assert v_result#>>'{months,7,source}'='not_regular' and v_result#>>'{months,7,kind}'='auxiliary';
  assert v_result#>'{months,7,retro_minutes}'='400'::jsonb and v_result#>'{months,7,minutes}'='null'::jsonb;
  assert v_result#>>'{months,8,source}'='not_regular' and v_result#>'{months,8,retro_minutes}'='600'::jsonb;
  assert v_result#>>'{months,9,source}'='approved' and v_result#>'{months,9,minutes}'='3000'::jsonb;
  assert v_result#>>'{months,10,source}'='missing' and v_result#>'{months,10,can_edit_retro}'='true'::jsonb;
  assert v_result#>>'{months,11,source}'='not_regular' and v_result#>>'{months,11,kind}'='regular';
  assert (select sum((m->>'minutes')::integer)=3074 from jsonb_array_elements(v_result->'months') m);
  assert not(v_result::text like '%PRIVATE_%') and not(v_result ? 'state');
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(null)','22023');
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(1899)','22023');
  perform pg_temp.expect_annual_error('select public.read_em_dia_own_annual(2199)','22023');
  v_current_year:=left(v_today,4)::integer-case when substring(v_today,6,2)<'09' then 1 else 0 end;
  perform pg_temp.expect_annual_error(format('select public.read_em_dia_own_annual(%s)',v_current_year+1),'22023');
  v_result:=public.read_em_dia_own_annual(v_current_year);
  if substring(v_today,6,2)<>'08' then assert v_result#>>'{months,11,source}'='future'; end if;
  v_future:=(v_current_year+1)::text||'-08';
  perform pg_temp.expect_annual_error(format('select public.save_em_dia_own_annual_retro(%s,%L,60,1,0)',v_current_year,v_future),'22023');
  -- The default goal does not create a row or imply any historical totals.
  v_result:=public.save_em_dia_own_annual_goal(2023,36000,0);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=0;
  v_result:=public.save_em_dia_own_annual_goal(2023,535680,0);
  assert (v_result->>'target_minutes')::integer=535680 and (v_result->>'version')::bigint=1;
  v_result:=public.save_em_dia_own_annual_goal(2023,1,1);
  assert (v_result->>'target_minutes')::integer=1;
  v_result:=public.save_em_dia_own_annual_goal(2023,36000,2);
  assert (v_result->>'target_minutes')::integer=36000;
  v_result:=public.save_em_dia_own_annual_goal(2024,25200,5);v_version:=(v_result->>'version')::bigint;
  assert v_version=6 and (v_result->>'target_minutes')::integer=25200;
  v_result:=public.save_em_dia_own_annual_goal(2024,25200,5);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=v_version;
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_goal(2024,24000,5)','40001');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_goal(2024,25200,7)','40001');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_goal(2024,0,6)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_goal(2024,535681,6)','22023');
  -- Pre-start historical totals remain personal and never extend tracking.
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-09',1800,2,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_version=7 and v_result#>>'{months,0,source}'='retroactive' and v_result#>'{months,0,minutes}'='1800'::jsonb;
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-09',1800,2,6);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=v_version;
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-09'',1801,2,6)','40001');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-09'',1800,2,8)','40001');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2025-09'',60,1,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-09-01'',60,1,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-10'',null,0,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-10'',0,null,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-10'',44641,0,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-12'',60,1,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2024-12'',null,null,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2025-01'',60,1,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2025-05'',60,1,7)','22023');
  perform pg_temp.expect_annual_error('select public.save_em_dia_own_annual_retro(2024,''2025-08'',60,1,7)','22023');
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-10',0,0,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_result#>>'{months,1,source}'='retroactive' and v_result#>'{months,1,minutes}'='0'::jsonb;
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-10',null,null,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_result#>>'{months,1,source}'='missing' and v_result#>'{months,1,minutes}'='null'::jsonb;
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-10',null,null,v_version-1);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=v_version;
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-10',44640,9999,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_result#>'{months,1,minutes}'='44640'::jsonb and v_result#>'{months,1,studies}'='9999'::jsonb;
  v_result:=public.save_em_dia_own_annual_retro(2024,'2024-10',null,null,v_version);v_version:=(v_result->>'version')::bigint;
  -- A pending submission is not an approved source and does not block a
  -- separate personal historical total.
  v_result:=public.save_em_dia_own_annual_retro(2024,'2025-03',120,1,v_version);v_version:=(v_result->>'version')::bigint;
  assert v_result#>>'{months,6,source}'='retroactive' and v_result#>'{months,6,minutes}'='120'::jsonb;
  v_result:=public.read_em_dia_own_card();
  assert not(v_result ? 'annual_progress') and not(v_result::text like '%retro_months%');
  assert v_result#>array['state','reports','2024-09','annual_main'] is null;
  assert v_result#>>'{state,people,0,startMonth}'='2024-11';
  reset role;
  assert (select to_jsonb(s)=v_state_snapshot from public.em_dia_states s where group_id=v_group);
  assert (select jsonb_agg(to_jsonb(d) order by month)=v_diary_snapshot from em_dia_private.daily_hours d where group_id=v_group);
  assert (select jsonb_agg(to_jsonb(r) order by month)=v_revision_snapshot from em_dia_private.report_revisions r where group_id=v_group);
  -- Explicit boundary contexts verify the September-to-August view and that
  -- September 1 opens a new cycle, without changing the real server clock.
  v_context:=em_dia_private.own_annual_context(2024);
  select * into v_row from em_dia_private.annual_progress where group_id=v_group and person_id='annual_main' and service_year=2024;
  v_result:=em_dia_private.annual_bundle(v_context||'{"today":"2025-08-31"}'::jsonb,v_row);
  assert v_result#>>'{months,0,month}'='2024-09' and v_result#>>'{months,11,month}'='2025-08';
  assert not exists(select 1 from jsonb_array_elements(v_result->'months') m where m->>'source'='future');
  v_result:=em_dia_private.annual_bundle(v_context||'{"service_year":2025,"today":"2025-09-01"}'::jsonb,null);
  assert v_result#>>'{months,0,month}'='2025-09' and v_result#>>'{months,11,month}'='2026-08';
  assert v_result#>'{months,0,can_edit_retro}'='false'::jsonb and v_result#>>'{months,1,source}'='future';

end;
$$;
rollback;
select 'Annual rules, cycle, source priority, goals, historical totals and CAS passed; all fixtures rolled back.' as result;
