-- Current-month regular/auxiliary submissions, with disposable fixtures only.
-- Each endpoint receives its first report; edits retain the approval workflow.
begin;
create temporary table em_dia_current_fixture_scope(marker boolean) on commit drop;
create function pg_temp.expect_current_error(p_query text,p_code text) returns void
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
grant execute on function pg_temp.expect_current_error(text,text) to authenticated;

do $$
declare
  v_manager uuid:=gen_random_uuid();v_future_user uuid:=gen_random_uuid();v_group uuid:=gen_random_uuid();
  v_users uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_ids text[]:=array['current_regular_manual','current_aux_manual','current_regular_diary','current_aux_diary'];
  v_kinds text[]:=array['regular','auxiliary','regular','auxiliary'];
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_month text:=left(v_today,7);
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_future text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 month','YYYY-MM');
  v_people jsonb:='[]';v_person jsonb;v_state jsonb;v_result jsonb;v_card jsonb;v_values jsonb;v_snapshot jsonb;
  v_timer_snapshot jsonb;v_annual_snapshot jsonb;v_initial_minutes integer;v_initial_hours numeric;v_changed_hours numeric;
  v_launch uuid;v_extra uuid;v_revision_id uuid;v_i integer;v_service_year integer;
begin
  assert not has_function_privilege('anon','public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint)','EXECUTE');
  assert not has_function_privilege('service_role','public.submit_em_dia_own_report(text,jsonb,bigint)','EXECUTE');
  assert not has_table_privilege('authenticated','em_dia_private.daily_hours','SELECT');
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' and proconfig=array['search_path=""']
    from pg_proc where oid='em_dia_private.submit_own_hours(text,boolean,integer,bigint,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' and proconfig=array['search_path=""']
    from pg_proc where oid='em_dia_private.submit_own_report(text,jsonb,bigint)'::regprocedure);
  assert (select not prosecdef from pg_proc where oid='public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint)'::regprocedure);
  assert (select not prosecdef from pg_proc where oid='public.submit_em_dia_own_report(text,jsonb,bigint)'::regprocedure);
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'current-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(v_users||array[v_manager,v_future_user]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(v_manager,false,'superintendent');
  insert into public.em_dia_members(user_id,is_admin,access_role)
    select u,false,'publisher' from unnest(v_users||array[v_future_user]) u;
  insert into public.em_dia_groups(id,name,created_by) values(v_group,'Current fixture '||v_group,v_manager);
  insert into public.em_dia_group_members(group_id,user_id)
    select v_group,u from unnest(v_users||array[v_manager,v_future_user]) u;
  for v_i in 1..4 loop
    insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(v_users[v_i],v_group,v_ids[v_i]);
    v_person:=jsonb_build_object('id',v_ids[v_i],'name','Current fixture '||v_i,'startMonth',v_prior,'endMonth',null,
      'notes','PRIVATE_CARD_NOTE','roles',jsonb_build_array(jsonb_build_object('kind',v_kinds[v_i],'start',v_prior,'end',null)));
    v_people:=v_people||jsonb_build_array(v_person);
  end loop;
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(v_future_user,v_group,'current_before_start');
  v_people:=v_people||jsonb_build_array(jsonb_build_object('id','current_before_start','name','Current fixture future',
    'startMonth',v_future,'endMonth',null,'notes','','roles',jsonb_build_array(jsonb_build_object('kind','regular','start',v_future,'end',null))));
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Current fixture','group','Current fixture','reminder',''),
    'people',v_people,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','PRIVATE_SOURCE');
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values(v_group,null,v_state,1,now());
  insert into em_dia_private.service_timers(group_id,person_id,version,status,timer_id,start_date,started_at,anchor_at,last_posted_receipt)
    values(v_group,v_ids[3],4,'running',gen_random_uuid(),v_today::date,clock_timestamp(),clock_timestamp(),
      jsonb_build_object('timer_id',gen_random_uuid(),'launch_id',gen_random_uuid(),'date',v_today,'minutes',10,'note','PRIVATE_TIMER_RECEIPT','posted_at',now()));
  v_service_year:=left(v_today,4)::integer-case when substring(v_today,6,2)<'09' then 1 else 0 end;
  insert into em_dia_private.annual_progress(group_id,person_id,service_year,target_minutes,version)
    values(v_group,v_ids[3],v_service_year,35000,3);
  select to_jsonb(t) into v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group;
  select to_jsonb(a) into v_annual_snapshot from em_dia_private.annual_progress a where group_id=v_group;

  -- Four independent cards exercise each first-send path in the current month:
  -- regular/manual, auxiliary/manual, regular/diary and auxiliary/diary.
  for v_i in 1..4 loop
    v_launch:=gen_random_uuid();v_extra:=gen_random_uuid();
    v_initial_minutes:=case when v_i=4 then 0 else 90 end;
    v_initial_hours:=v_initial_minutes::numeric/60;
    v_changed_hours:=(v_initial_minutes+30)::numeric/60;
    v_values:=jsonb_build_object('participated',case when v_initial_minutes=0 then null else true end,
      'hours',v_initial_hours,'studies',2);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_users[v_i],'role','authenticated')::text,true);
    perform set_config('request.jwt.claim.sub',v_users[v_i]::text,true);
    set local role authenticated;
    perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_hours(%L,null,2,0,0)',v_month),'22023');
    perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_hours(%L,true,2,0,0)',v_future),'22023');
    perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_future,v_values),'22023');
    if v_i<=2 then
      v_result:=public.submit_em_dia_own_report(v_month,v_values,0);
      assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=1,'First manual current report failed';
      v_result:=public.submit_em_dia_own_report(v_month,v_values,0);
      assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=1;
    end if;
    v_result:=public.save_em_dia_own_hour_launch_note(v_launch,v_today,v_initial_minutes,'PRIVATE_DIARY_NOTE',0);
    assert v_result->'closed'='false'::jsonb and (v_result->>'version')::bigint=1;
    v_result:=public.submit_em_dia_own_hours(v_month,null,2,1,0);
    assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=1,'First diary current report failed';
    assert (v_result->>'total_minutes')::integer=v_initial_minutes;
    v_result:=public.submit_em_dia_own_hours(v_month,null,2,1,0);
    assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=1;
    v_result:=public.submit_em_dia_own_report(v_month,v_values,0);
    assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=1;
    perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,2)',v_month,v_values),'40001');
    v_card:=public.read_em_dia_own_card();
    assert v_card#>array['state','reports',v_month,v_ids[v_i],'hours']=to_jsonb(v_initial_hours);
    if v_i=4 then assert v_card#>array['state','reports',v_month,v_ids[v_i],'participated']='null'::jsonb; end if;
    assert not(v_card::text like '%PRIVATE_%') and not(v_card::text like '%launches%');
    if v_kinds[v_i]='regular' then
      v_result:=public.read_em_dia_own_annual(v_service_year);
      select m into v_person from jsonb_array_elements(v_result->'months') m where m->>'month'=v_month;
      assert v_person->>'source'='approved' and (v_person->>'minutes')::integer=v_initial_minutes;
    end if;
    v_snapshot:=v_card;
    -- Continue recording after sending: the approved report and workflow stay
    -- byte-for-byte unchanged until the publisher explicitly submits again.
    v_result:=public.save_em_dia_own_hour_launch_note(v_extra,v_today,30,'PRIVATE_NEXT_NOTE',1);
    assert (v_result->>'version')::bigint=2 and (v_result->>'total_minutes')::integer=v_initial_minutes+30;
    assert public.read_em_dia_own_card()=v_snapshot,'Draft continuation changed the approved report';
    perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_hours(%L,true,2,1,1)',v_month),'40001');
    v_result:=public.submit_em_dia_own_hours(v_month,null,2,2,1);
    assert v_result->>'status'='pending' and (v_result->>'version')::bigint=2;
    v_result:=public.submit_em_dia_own_hours(v_month,null,2,2,1);
    assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=2;
    perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,1)',v_month,
      jsonb_build_object('participated',true,'hours',v_changed_hours+1,'studies',2)),'40001');
    v_card:=public.read_em_dia_own_card();
    assert v_card#>array['state','reports',v_month,v_ids[v_i],'hours']=to_jsonb(v_initial_hours);
    if v_kinds[v_i]='regular' then
      v_result:=public.read_em_dia_own_annual(v_service_year);
      select m into v_person from jsonb_array_elements(v_result->'months') m where m->>'month'=v_month;
      assert v_person->>'source'='approved' and (v_person->>'minutes')::integer=v_initial_minutes;
    end if;
    v_revision_id:=(v_card#>>'{revisions,0,id}')::uuid;
    reset role;
    assert not exists(select 1 from em_dia_private.report_revisions r where r.group_id=v_group
      and (r.proposed_report::text like '%PRIVATE_%' or r.proposed_report ? 'launches' or r.proposed_report ? 'note'));
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager,'role','authenticated')::text,true);
    perform set_config('request.jwt.claim.sub',v_manager::text,true);
    set local role authenticated;
    v_result:=public.list_em_dia_report_revisions(v_group);
    assert not(v_result::text like '%PRIVATE_%') and not(v_result::text like '%launches%') and not(v_result::text like '%entries%');
    perform pg_temp.expect_current_error(format('select public.review_em_dia_report_revision(%L,1,''accept'')',v_revision_id),'40001');
    v_result:=public.review_em_dia_report_revision(v_revision_id,2,'accept');
    assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=3;
    v_result:=public.review_em_dia_report_revision(v_revision_id,2,'accept');
    assert v_result->'unchanged'='true'::jsonb;
    reset role;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_users[v_i],'role','authenticated')::text,true);
    perform set_config('request.jwt.claim.sub',v_users[v_i]::text,true);
    set local role authenticated;
    assert public.read_em_dia_own_card()#>array['state','reports',v_month,v_ids[v_i],'hours']=to_jsonb(v_changed_hours);
    v_snapshot:=public.read_em_dia_own_card();
    v_result:=public.save_em_dia_own_hour_launch_note(v_extra,v_today,45,null,2);
    assert (v_result->>'version')::bigint=3 and public.read_em_dia_own_card()=v_snapshot;
    v_result:=public.submit_em_dia_own_report(v_month,jsonb_build_object('participated',true,'hours',v_changed_hours+1,'studies',3),3);
    assert v_result->>'status'='pending' and (v_result->>'version')::bigint=4;
    assert public.read_em_dia_own_card()#>array['state','reports',v_month,v_ids[v_i],'hours']=to_jsonb(v_changed_hours);
    reset role;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager,'role','authenticated')::text,true);
    perform set_config('request.jwt.claim.sub',v_manager::text,true);
    set local role authenticated;
    v_result:=public.review_em_dia_report_revision(v_revision_id,4,'ignore');
    assert v_result->>'status'='ignored' and (v_result->>'version')::bigint=5;
    v_result:=public.review_em_dia_report_revision(v_revision_id,4,'ignore');
    assert v_result->'unchanged'='true'::jsonb;
    reset role;
    assert (select state#>array['reports',v_month,v_ids[v_i],'hours']=to_jsonb(v_changed_hours)
      and not(state::text like '%PRIVATE_DIARY_NOTE%') and not(state::text like '%PRIVATE_NEXT_NOTE%')
      from public.em_dia_states where group_id=v_group);
    assert (select version=3 and entries->v_today=to_jsonb(v_initial_minutes+45) from em_dia_private.daily_hours
      where group_id=v_group and person_id=v_ids[v_i] and month=v_month);
  end loop;
  -- A card whose tracking starts next month cannot use this opening to send
  -- before its own start, and no future month can be submitted by either path.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_future_user,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_future_user::text,true);
  set local role authenticated;
  perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_month,v_values),'22023');
  perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_hours(%L,null,0,0,0)',v_month),'22023');
  perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_future,v_values),'22023');
  perform pg_temp.expect_current_error(format('select public.submit_em_dia_own_hours(%L,null,0,0,0)',v_future),'22023');
  reset role;
  assert (select to_jsonb(t)=v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group);
  assert (select to_jsonb(a)=v_annual_snapshot from em_dia_private.annual_progress a where group_id=v_group);
end;
$$;
rollback;
select 'Current regular/auxiliary reports, manual/diary paths, CAS, reviews, continued drafts, future guards and privacy passed; all fixtures rolled back.' as result;
