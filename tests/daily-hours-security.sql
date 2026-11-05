-- Run as postgres after the daily-hours migration. Every fixture rolls back.
-- No real account, card, report or binding is edited by these checks.
begin;
create temporary table em_dia_daily_fixture_scope(marker boolean) on commit drop;
create function pg_temp.expect_daily_error(p_query text,p_code text) returns void
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
grant execute on function pg_temp.expect_daily_error(text,text) to authenticated;

do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_other_super uuid:=gen_random_uuid();
  v_publisher uuid:=gen_random_uuid();v_aux uuid:=gen_random_uuid();v_ordinary uuid:=gen_random_uuid();
  v_replacement uuid:=gen_random_uuid();v_outsider uuid:=gen_random_uuid();
  v_group uuid:=gen_random_uuid();v_other_group uuid:=gen_random_uuid();v_empty_group uuid:=gen_random_uuid();
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_open text:=left(v_today,7);
  v_month text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '2 months','YYYY-MM');
  v_future text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 month','YYYY-MM');
  v_future_day text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 day','YYYY-MM-DD');
  v_person jsonb;v_aux_person jsonb;v_other_person jsonb;v_state jsonb;v_empty jsonb;
  v_result jsonb;v_before public.em_dia_states;v_workflow_id uuid;v_revision bigint;v_copy public.em_dia_states;
begin
  -- Least privilege is enforced at the database boundary, not only by the UI.
  assert not has_table_privilege('anon','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','INSERT');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','UPDATE');
  assert not has_table_privilege('service_role','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('em_dia_writer','em_dia_private.daily_hours','SELECT');
  assert not has_table_privilege('em_dia_workflow','em_dia_private.daily_hours','DELETE');
  assert not pg_has_role('authenticated','em_dia_workflow','MEMBER');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.daily_hours'::regclass);
  assert not has_function_privilege('anon','public.read_em_dia_own_hours(text)','EXECUTE');
  assert not has_function_privilege('service_role','public.read_em_dia_own_hours(text)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.own_hours_context(text)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.hours_bundle(jsonb,jsonb,bigint,timestamptz)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.valid_daily_entries(text,jsonb)','EXECUTE');
  assert (select not prosecdef from pg_proc where oid='public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' from pg_proc
    where oid='em_dia_private.save_own_hours(text,integer,bigint)'::regprocedure);
  assert em_dia_private.valid_daily_entries('2024-02','{"2024-02-29":1440}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2025-02','{"2025-02-29":1}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-02-30":1}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-03-01":1}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-02-01":0.5}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-02-01":"60"}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-02-01":null}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"2024-02-01":1441}'::jsonb);
  assert not em_dia_private.valid_daily_entries('2024-02','{"__proto__":1}'::jsonb);

  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'daily-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_other_super,v_publisher,v_aux,v_ordinary,v_replacement,v_outsider]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_other_super,false,'superintendent'),
    (v_publisher,false,'publisher'),(v_aux,false,'publisher'),(v_ordinary,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_group,'Daily fixture A '||v_group,v_admin),(v_other_group,'Daily fixture B '||v_other_group,v_admin),
    (v_empty_group,'Daily fixture empty '||v_empty_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values
    (v_group,v_admin),(v_group,v_super),(v_other_group,v_other_super),
    (v_group,v_publisher),(v_group,v_aux),(v_group,v_ordinary);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values
    (v_publisher,v_group,'daily_regular'),(v_aux,v_group,'daily_aux'),(v_ordinary,v_group,'daily_ordinary');
  v_person:=jsonb_build_object('id','daily_regular','name','Daily fixture regular','startMonth','2024-01',
    'endMonth',null,'notes','PRIVATE_CARD','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-01','end',null)));
  v_aux_person:=jsonb_build_object('id','daily_aux','name','Daily fixture auxiliary','startMonth',v_prior,
    'endMonth',null,'notes','PRIVATE_AUX','roles',jsonb_build_array(jsonb_build_object('kind','auxiliary','start',v_month,'end',v_month)));
  v_other_person:=jsonb_build_object('id','daily_ordinary','name','Daily fixture ordinary','startMonth',v_prior,
    'endMonth',null,'notes','PRIVATE_OTHER','roles','[]'::jsonb);
  v_empty:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Daily fixture','group','Daily fixture','reminder',''),
    'people','[]'::jsonb,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','');
  v_state:=jsonb_set(v_empty,'{people}',jsonb_build_array(v_person,v_aux_person,v_other_person));
  v_state:=jsonb_set(v_state,'{reports}',jsonb_build_object(v_prior,jsonb_build_object('daily_regular',jsonb_build_object(
    'received',true,'kind','regular','participated',true,'hours',55,'studies',4,'notes','PRIVATE_REPORT',
    'receivedDate',v_prior||'-01','updatedAt',now()))));
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_group,null,v_state,1,now()),(v_other_group,null,v_empty,1,now());

  -- A signed-in outsider cannot gain diary access through editable claims.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated',
    'user_metadata',jsonb_build_object('role','publisher','is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  perform pg_temp.expect_daily_error(format('select public.read_em_dia_own_hours(%L)',v_month),'42501');
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,60,0)',v_month||'-01'),'42501');
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_hours(%L,true,0,0,0)',v_month),'42501');
  reset role;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hours(v_prior);
  assert v_result->>'kind'='regular' and v_result->>'person_id'='daily_regular';
  assert (v_result->>'version')::bigint=0 and v_result->'entries'='{}'::jsonb;
  assert (v_result->>'total_minutes')::integer=0 and v_result->'closed'='true'::jsonb;
  assert v_result->>'today'=v_today and not (v_result::text like '%PRIVATE_%');
  -- Existing 55 received hours are never fabricated as a set of daily entries.
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_hours(%L,true,4,0,0)',v_prior),'22023');
  assert (public.read_em_dia_own_card()#>array['state','reports',v_prior,'daily_regular','hours'])='55'::jsonb;
  perform pg_temp.expect_daily_error('select * from em_dia_private.daily_hours','42501');
  perform pg_temp.expect_daily_error(format('select public.read_em_dia_own_hours(%L)',v_future),'22023');
  perform pg_temp.expect_daily_error('select public.read_em_dia_own_hours(''1900-01'')','22023');
  perform pg_temp.expect_daily_error('select public.save_em_dia_own_hours(''2025-02-29'',60,0)','22023');
  perform pg_temp.expect_daily_error('select public.save_em_dia_own_hours(''2024-02-30'',60,0)','22023');
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,60,0)',v_future_day),'22023');
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,-1,0)',v_month||'-01'),'22023');
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,1441,0)',v_month||'-01'),'22023');
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,60,-1)',v_month||'-01'),'22023');
  -- A real leap day and a full 24-hour boundary are valid, but remain drafts.
  v_result:=public.save_em_dia_own_hours('2024-02-29',1440,0);
  assert (v_result->>'total_minutes')::integer=1440;
  assert (v_result->>'version')::bigint=1;
  v_result:=public.save_em_dia_own_hours(v_month||'-03',null,0);
  assert (v_result->>'version')::bigint=0 and v_result->'unchanged'='true'::jsonb;
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,null,1)',v_month||'-03'),'40001');
  v_result:=public.save_em_dia_own_hours(v_month||'-01',90,0);
  assert (v_result->>'version')::bigint=1 and v_result->'unchanged'='false'::jsonb;
  v_result:=public.save_em_dia_own_hours(v_month||'-02',45,1);
  assert (v_result->>'version')::bigint=2 and (v_result->>'total_minutes')::integer=135;
  v_result:=public.save_em_dia_own_hours(v_month||'-02',45,1);
  assert (v_result->>'version')::bigint=2 and v_result->'unchanged'='true'::jsonb;
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,60,1)',v_month||'-03'),'40001');
  v_result:=public.save_em_dia_own_hours(v_month||'-02',null,2);
  assert (v_result->>'version')::bigint=3 and not (v_result->'entries' ? (v_month||'-02'));
  v_result:=public.save_em_dia_own_hours(v_month||'-02',null,2);
  assert (v_result->>'version')::bigint=3 and v_result->'unchanged'='true'::jsonb;
  v_result:=public.save_em_dia_own_hours(v_month||'-02',0,3);
  assert (v_result->>'version')::bigint=4 and v_result#>array['entries',v_month||'-02']='0'::jsonb;
  assert (v_result->>'total_minutes')::integer=90;
  assert (select count(*)=0 from public.em_dia_states);
  reset role;
  select * into v_before from public.em_dia_states where group_id=v_group;
  assert v_before.state=v_state and v_before.revision=1;
  assert not exists(select 1 from em_dia_private.report_revisions where group_id=v_group);
  set local role authenticated;
  -- The backend computes 90 minutes as 1.50 hours. A false input cannot
  -- contradict positive hours, and unknown studies remain null.
  v_result:=public.submit_em_dia_own_hours(v_month,false,null,4,0);
  assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=1;
  assert (v_result->>'hours_version')::bigint=4 and (v_result->>'total_minutes')::integer=90;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_regular','hours']='1.50'::jsonb;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_regular','participated']='true'::jsonb;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_regular','studies']='null'::jsonb;
  v_result:=public.submit_em_dia_own_hours(v_month,false,null,4,0);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=1;
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_hours(%L,true,null,4,2)',v_month),'40001');
  v_result:=public.save_em_dia_own_hours(v_month||'-02',30,4);
  assert (v_result->>'version')::bigint=5 and (v_result->>'total_minutes')::integer=120;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_regular','hours']='1.50'::jsonb;
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_hours(%L,true,2,4,1)',v_month),'40001');
  v_result:=public.submit_em_dia_own_hours(v_month,true,2,5,1);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=2;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_regular','hours']='1.50'::jsonb;
  v_result:=public.submit_em_dia_own_hours(v_month,true,2,5,1);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=2;
  -- A current-month draft can be saved; neither diary nor manual pioneer
  -- submission may close that month early.
  v_result:=public.save_em_dia_own_hours(v_today,0,0);
  assert (v_result->>'version')::bigint=1 and v_result->'closed'='false'::jsonb;
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_hours(%L,null,null,1,0)',v_open),'22023');
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_open,
    '{"participated":null,"hours":0,"studies":null}'),'22023');
  reset role;

  -- Managers can decide on submitted monthly totals, not read the private days.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_daily_error(format('select public.read_em_dia_own_hours(%L)',v_month),'42501');
  v_result:=public.list_em_dia_report_revisions(v_group);
  assert v_result#>'{revisions,0,approved_report,hours}'='1.50'::jsonb;
  assert v_result#>'{revisions,0,proposed_report,hours}'='2'::jsonb;
  assert not (v_result::text like '%entries%');
  v_workflow_id:=(v_result#>>'{revisions,0,id}')::uuid;
  v_result:=public.review_em_dia_report_revision(v_workflow_id,2,'accept');
  assert (v_result->>'version')::bigint=3;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  assert (public.read_em_dia_own_hours(v_month)->>'version')::bigint=5;
  v_result:=public.save_em_dia_own_hours(v_month||'-01',91,5);
  assert (v_result->>'version')::bigint=6 and (v_result->>'total_minutes')::integer=121;
  v_result:=public.submit_em_dia_own_hours(v_month,true,2,6,3);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=4;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform public.review_em_dia_report_revision(v_workflow_id,4,'ignore');
  reset role;
  assert (select state#>array['reports',v_month,'daily_regular','hours']='2'::jsonb from public.em_dia_states where group_id=v_group);
  assert (select version=6 and entries#>array[v_month||'-01']='91'::jsonb from em_dia_private.daily_hours
    where group_id=v_group and person_id='daily_regular' and month=v_month);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.submit_em_dia_own_hours(v_month,true,2,6,5);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=6;
  reset role;

  -- Destination diary collisions are transactional even when that destination
  -- has no matching JSON card. No history is merged or silently discarded.
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,version)
    values(v_other_group,'daily_regular',v_month,'{}'::jsonb,1);
  select * into v_before from public.em_dia_states where group_id=v_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_daily_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',
    v_group,v_other_group,'daily_regular',v_before.revision),'22023');
  reset role;
  assert (select revision=v_before.revision and state=v_before.state from public.em_dia_states where group_id=v_group);
  assert (select group_id=v_group from em_dia_private.publisher_links where user_id=v_publisher);
  delete from em_dia_private.daily_hours where group_id=v_other_group and person_id='daily_regular';
  set local role authenticated;
  perform public.transfer_em_dia_publisher(v_group,v_other_group,'daily_regular',v_before.revision);
  reset role;
  assert not exists(select 1 from em_dia_private.daily_hours where group_id=v_group and person_id='daily_regular');
  assert (select version=6 and entries#>array[v_month||'-01']='91'::jsonb from em_dia_private.daily_hours
    where group_id=v_other_group and person_id='daily_regular' and month=v_month);
  assert (select group_id=v_other_group and version=6 and status='pending' from em_dia_private.report_revisions where id=v_workflow_id);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hours(v_month);
  assert (v_result->>'group_id')::uuid=v_other_group and (v_result->>'total_minutes')::integer=121;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_super::text,true);
  set local role authenticated;
  perform public.review_em_dia_report_revision(v_workflow_id,6,'accept');
  select revision into v_revision from public.em_dia_states where group_id=v_other_group;
  perform public.transfer_em_dia_publisher(v_other_group,v_empty_group,'daily_regular',v_revision);
  reset role;
  assert (select owner_id is null from public.em_dia_states where group_id=v_empty_group);
  assert (select state#>array['reports',v_month,'daily_regular','hours']='2.02'::jsonb from public.em_dia_states where group_id=v_empty_group);
  assert (select count(*)=3 from em_dia_private.daily_hours where group_id=v_empty_group and person_id='daily_regular');

  -- Promoting the old login does not erase the diary. The card cannot then be
  -- removed via backup/import, and a replacement login inherits the same draft.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  perform pg_temp.expect_daily_error(format('select public.read_em_dia_own_hours(%L)',v_month),'42501');
  perform public.provision_em_dia_access(v_publisher,'superintendent',v_empty_group,null);
  select * into v_copy from public.em_dia_states where group_id=v_empty_group;
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,%s)',
    v_empty_group,jsonb_set(jsonb_set(v_copy.state,'{people}','[]'::jsonb),'{reports}','{}'::jsonb)::text,v_copy.revision),'22023');
  perform public.provision_em_dia_publisher_account(v_replacement,v_empty_group,'daily_regular');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_replacement,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_replacement::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_hours(v_month);
  assert (v_result->>'version')::bigint=6 and (v_result->>'total_minutes')::integer=121;
  assert v_result->>'person_id'='daily_regular';
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_daily_error(format('select public.read_em_dia_own_hours(%L)',v_month),'42501');
  reset role;

  -- An auxiliary month is eligible only in its own period. Explicit zero is a
  -- real value; removing the last day keeps the version and never submits zero.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_aux,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_aux::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_hours(v_month)->>'kind'='auxiliary';
  assert public.read_em_dia_own_hours(v_open)->>'kind'='publisher';
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,60,0)',v_today),'22023');
  v_result:=public.save_em_dia_own_hours(v_month||'-01',0,0);
  v_result:=public.submit_em_dia_own_hours(v_month,null,null,1,0);
  assert v_result->>'status'='accepted';
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_aux','hours']='0'::jsonb;
  assert public.read_em_dia_own_card()#>array['state','reports',v_month,'daily_aux','participated']='null'::jsonb;
  v_result:=public.save_em_dia_own_hours(v_month||'-01',null,1);
  assert (v_result->>'version')::bigint=2 and v_result->'entries'='{}'::jsonb;
  perform pg_temp.expect_daily_error(format('select public.submit_em_dia_own_hours(%L,null,null,2,1)',v_month),'22023');
  reset role;
  -- Current-month reporting for an ordinary publisher is unchanged.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ordinary,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_ordinary::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_hours(v_open)->>'kind'='publisher';
  perform pg_temp.expect_daily_error(format('select public.save_em_dia_own_hours(%L,60,0)',v_today),'22023');
  v_result:=public.submit_em_dia_own_report(v_open,'{"participated":true,"hours":null,"studies":0}'::jsonb,0);
  assert v_result->>'status'='accepted';
  reset role;
end;
$$;

rollback;
select 'Daily hours privacy, calendar, CAS, month close, review and transfer fixtures passed; all changes rolled back.' as result;
