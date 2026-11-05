-- Persistent timer checks use fictional fixtures and server-clock anchors.
-- No browser timers, sleeps, real accounts or production records are mutated.
begin;
create temporary table em_dia_timer_fixture_scope(marker boolean) on commit drop;
create function pg_temp.expect_timer_error(p_query text,p_code text) returns void
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
grant execute on function pg_temp.expect_timer_error(text,text) to authenticated;

do $$
declare
  v_admin uuid:=gen_random_uuid();v_super uuid:=gen_random_uuid();v_other_super uuid:=gen_random_uuid();
  v_publisher uuid:=gen_random_uuid();v_other_publisher uuid:=gen_random_uuid();v_ordinary uuid:=gen_random_uuid();
  v_outsider uuid:=gen_random_uuid();v_replacement uuid:=gen_random_uuid();
  v_group uuid:=gen_random_uuid();v_other_group uuid:=gen_random_uuid();
  v_timer_a uuid:=gen_random_uuid();v_timer_b uuid:=gen_random_uuid();v_timer_c uuid:=gen_random_uuid();
  v_launch uuid:=gen_random_uuid();v_independent uuid:=gen_random_uuid();
  v_today text:=to_char(clock_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_month text:=left(v_today,7);
  v_prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_person jsonb;v_other_person jsonb;v_ordinary_person jsonb;v_guard_person jsonb;v_state jsonb;v_empty jsonb;v_large_launches jsonb;
  v_result jsonb;v_read jsonb;v_snapshot jsonb;v_timer_snapshot jsonb;v_state_snapshot jsonb;v_without_guard jsonb;
  v_elapsed bigint;v_version bigint;v_diary_version bigint;v_stopped_version bigint;v_post_hours_version bigint;v_revision bigint;
begin
  assert not has_table_privilege('authenticated','em_dia_private.service_timers','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.service_timers','UPDATE');
  assert not has_table_privilege('anon','em_dia_private.service_timers','SELECT');
  assert not has_table_privilege('service_role','em_dia_private.service_timers','SELECT');
  assert not has_table_privilege('em_dia_writer','em_dia_private.service_timers','SELECT');
  assert not has_table_privilege('em_dia_workflow','em_dia_private.service_timers','DELETE');
  assert not has_function_privilege('anon','public.read_em_dia_own_timer()','EXECUTE');
  assert not has_function_privilege('service_role','public.change_em_dia_own_timer(text,uuid,bigint)','EXECUTE');
  assert not has_function_privilege('service_role','public.post_em_dia_own_timer(uuid,bigint,uuid,text,integer,text,bigint)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.own_timer_context()','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.timer_bundle(jsonb,em_dia_private.service_timers,timestamptz)','EXECUTE');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.service_timers'::regclass);
  assert (select not rolcanlogin and not rolbypassrls from pg_roles where rolname='em_dia_workflow');
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' and proconfig=array['search_path=""'] from pg_proc
    where oid='em_dia_private.post_own_timer(uuid,bigint,uuid,text,integer,text,bigint)'::regprocedure);
  assert (select not prosecdef and proconfig=array['search_path=""'] from pg_proc
    where oid='public.post_em_dia_own_timer(uuid,bigint,uuid,text,integer,text,bigint)'::regprocedure);
  -- Optional-note projection must not turn a valid stored payload into an
  -- unreadable response: 176 noted and 824 legacy items fit the raw bound,
  -- but their complete four-field representation exceeds 256 KiB.
  select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'date','2024-02-01','minutes',0)
    ||case when n<=176 then jsonb_build_object('note',repeat('x',1000)) else '{}'::jsonb end)
    into v_large_launches from generate_series(1,1000) n;
  assert octet_length(v_large_launches::text)<=262144;
  assert not em_dia_private.valid_hour_launches('2024-02','{"2024-02-01":0}'::jsonb,v_large_launches);

  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select u,'timer-fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_other_super,v_publisher,v_other_publisher,v_ordinary,v_outsider,v_replacement]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_other_super,false,'superintendent'),
    (v_publisher,false,'publisher'),(v_other_publisher,false,'publisher'),(v_ordinary,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_group,'Timer fixture A '||v_group,v_admin),(v_other_group,'Timer fixture B '||v_other_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values
    (v_group,v_admin),(v_group,v_super),(v_other_group,v_other_super),
    (v_group,v_publisher),(v_group,v_other_publisher),(v_group,v_ordinary);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values
    (v_publisher,v_group,'timer_main'),(v_other_publisher,v_group,'timer_other'),(v_ordinary,v_group,'timer_ordinary');
  v_person:=jsonb_build_object('id','timer_main','name','Timer fixture main','startMonth','2024-01','endMonth',null,
    'notes','PRIVATE_CARD','roles',jsonb_build_array(jsonb_build_object('kind','regular','start','2024-01','end',null)));
  v_other_person:=jsonb_set(jsonb_set(v_person,'{id}','"timer_other"'::jsonb),'{name}','"Timer fixture other"'::jsonb);
  v_guard_person:=jsonb_set(jsonb_set(v_person,'{id}','"timer_guard"'::jsonb),'{name}','"Timer fixture guard"'::jsonb);
  v_ordinary_person:=jsonb_build_object('id','timer_ordinary','name','Timer fixture ordinary','startMonth','2024-01','endMonth',null,
    'notes','','roles','[]'::jsonb);
  v_empty:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Timer fixture','group','Timer fixture','reminder',''),
    'people','[]'::jsonb,'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_month,'sourceNote','');
  v_state:=jsonb_set(v_empty,'{people}',jsonb_build_array(v_person,v_other_person,v_ordinary_person,v_guard_person));
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values
    (v_group,null,v_state,1,now()),(v_other_group,null,v_empty,1,now());
  select to_jsonb(s) into v_state_snapshot from public.em_dia_states s where group_id=v_group;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated',
    'user_metadata',jsonb_build_object('role','publisher','is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  perform pg_temp.expect_timer_error('select public.read_em_dia_own_timer()','42501');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,0)',v_timer_a),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_timer_error('select * from em_dia_private.service_timers','42501');
  perform pg_temp.expect_timer_error('select public.read_em_dia_own_timer()','42501');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,0)',v_timer_a),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ordinary,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_ordinary::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_timer()->>'status'='idle';
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,0)',v_timer_a),'22023');
  reset role;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_timer();
  assert v_result->>'status'='idle' and v_result->'timer_id'='null'::jsonb and v_result->'start_date'='null'::jsonb;
  assert (v_result->>'version')::bigint=0 and (v_result->>'elapsed_ms')::bigint=0;
  assert not(v_result ? 'receipt') and not(v_result::text like '%PRIVATE_%');
  perform pg_temp.expect_timer_error('select public.change_em_dia_own_timer(''start'',null,0)','22023');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''unsupported'',%L,0)',v_timer_a),'22023');
  v_result:=public.change_em_dia_own_timer('start',v_timer_a,0);
  v_version:=(v_result->>'version')::bigint;
  assert v_result->>'status'='running' and v_result->>'timer_id'=v_timer_a::text and v_version=1;
  assert v_result->>'start_date'=v_today and v_result->'stopped_at'='null'::jsonb;
  v_result:=public.change_em_dia_own_timer('start',v_timer_a,0);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=1;
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,0)',v_timer_b),'40001');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,1)',v_timer_b),'22023');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''discard'',%L,1)',v_timer_a),'22023');
  reset role;
  -- Simulate days away from the closed application without waiting or ticks.
  -- Timers are not capped at 24h or 744h; the diary enforces its monthly bound.
  update em_dia_private.service_timers set started_at=clock_timestamp()-interval '800 hours',
    anchor_at=clock_timestamp()-interval '800 hours',accumulated_ms=1234
    where group_id=v_group and person_id='timer_main';
  select to_jsonb(t) into v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='timer_main';
  set local role authenticated;
  v_read:=public.read_em_dia_own_timer();
  assert (v_read->>'elapsed_ms')::bigint>=2880001234 and v_read->>'status'='running';
  assert (v_read->>'anchor_at')::timestamptz<=(v_read->>'server_now')::timestamptz;
  reset role;
  assert (select to_jsonb(t)=v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='timer_main');
  -- A different session sees only its own idle timer; returning does not reset.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_publisher::text,true);
  set local role authenticated;
  assert public.read_em_dia_own_timer()->>'status'='idle';
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''stop'',%L,1)',v_timer_a),'40001');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.change_em_dia_own_timer('pause',v_timer_a,1);
  v_elapsed:=(v_result->>'elapsed_ms')::bigint;
  assert v_result->>'status'='paused' and v_result->'anchor_at'='null'::jsonb and v_elapsed>=2880001234;
  assert (v_result->>'accumulated_ms')::bigint=v_elapsed and (v_result->>'version')::bigint=2;
  v_result:=public.change_em_dia_own_timer('pause',v_timer_a,1);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'elapsed_ms')::bigint=v_elapsed;
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''stop'',%L,1)',v_timer_a),'40001');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,0)',v_timer_a),'40001');
  assert (public.read_em_dia_own_timer()->>'elapsed_ms')::bigint=v_elapsed;
  v_result:=public.change_em_dia_own_timer('resume',v_timer_a,2);
  assert v_result->>'status'='running' and (v_result->>'accumulated_ms')::bigint=v_elapsed and (v_result->>'version')::bigint=3;
  reset role;
  -- Ending the pioneer/tracking period does not hide or strand an active timer.
  update public.em_dia_states set state=jsonb_set(jsonb_set(state,'{people,0,endMonth}',to_jsonb(v_prior)),
    '{people,0,roles,0,end}',to_jsonb(v_prior)) where group_id=v_group;
  update em_dia_private.service_timers set anchor_at=clock_timestamp()-interval '10 minutes'
    where group_id=v_group and person_id='timer_main';
  set local role authenticated;
  assert public.read_em_dia_own_timer()->>'status'='running';
  v_result:=public.change_em_dia_own_timer('stop',v_timer_a,3);
  v_stopped_version:=(v_result->>'version')::bigint;
  assert v_result->>'status'='stopped' and v_stopped_version=4 and (v_result->>'elapsed_ms')::bigint>=v_elapsed+600000;
  v_result:=public.change_em_dia_own_timer('stop',v_timer_a,3);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=v_stopped_version;
  reset role;
  update public.em_dia_states set state=v_state where group_id=v_group;
  select to_jsonb(t) into v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='timer_main';
  assert (select to_jsonb(s)=v_state_snapshot from public.em_dia_states s where group_id=v_group);
  assert not exists(select 1 from em_dia_private.daily_hours where group_id=v_group);
  assert not exists(select 1 from em_dia_private.report_revisions where group_id=v_group);
  set local role authenticated;
  -- Invalid final edits or stale diary versions cannot clear the stopped timer.
  perform pg_temp.expect_timer_error(format('select public.post_em_dia_own_timer(%L,4,%L,%L,44641,''too much'',0)',v_timer_a,v_launch,v_today),'22023');
  perform pg_temp.expect_timer_error(format('select public.post_em_dia_own_timer(%L,4,%L,%L,30,%L,0)',v_timer_a,v_launch,v_today,repeat('x',1001)),'22023');
  v_result:=public.save_em_dia_own_hour_launch_note(v_independent,v_today,60,'PRIVATE_INDEPENDENT',0);
  v_post_hours_version:=(v_result->>'version')::bigint;
  perform pg_temp.expect_timer_error(format('select public.post_em_dia_own_timer(%L,4,%L,%L,60,''PRIVATE_INDEPENDENT'',1)',v_timer_a,v_independent,v_today),'22023');
  perform pg_temp.expect_timer_error(format('select public.post_em_dia_own_timer(%L,4,%L,%L,1800,''PRIVATE_TIMER_NOTE'',0)',v_timer_a,v_launch,v_today),'40001');
  reset role;
  assert (select to_jsonb(t)=v_timer_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='timer_main');
  set local role authenticated;
  v_result:=public.post_em_dia_own_timer(v_timer_a,v_stopped_version,v_launch,v_today,1800,'PRIVATE_TIMER_NOTE',v_post_hours_version);
  assert v_result->'unchanged'='false'::jsonb and v_result#>>'{timer,status}'='idle';
  assert v_result#>'{timer,timer_id}'='null'::jsonb and (v_result#>>'{timer,version}')::bigint=5;
  assert (v_result#>>'{diary,version}')::bigint=2 and (v_result#>>'{diary,total_minutes}')::integer=1860;
  assert v_result#>>'{receipt,timer_id}'=v_timer_a::text and v_result#>>'{receipt,launch_id}'=v_launch::text;
  assert v_result#>>'{receipt,note}'='PRIVATE_TIMER_NOTE' and v_result#>>'{diary,launches,1,note}'='PRIVATE_TIMER_NOTE';
  assert (v_result#>>'{receipt,posted_at}')::timestamptz<=(v_result#>>'{timer,server_now}')::timestamptz;
  v_read:=public.read_em_dia_own_timer();
  assert not(v_read ? 'receipt') and not(v_read::text like '%PRIVATE_%') and (v_read->>'elapsed_ms')::bigint=0;
  v_result:=public.post_em_dia_own_timer(v_timer_a,4,v_launch,v_today,1800,'PRIVATE_TIMER_NOTE',1);
  assert v_result->'unchanged'='true'::jsonb and (v_result#>>'{diary,version}')::bigint=2;
  perform pg_temp.expect_timer_error(format('select public.post_em_dia_own_timer(%L,4,%L,%L,1801,''PRIVATE_TIMER_NOTE'',1)',v_timer_a,v_launch,v_today),'22023');
  perform pg_temp.expect_timer_error(format('select public.post_em_dia_own_timer(%L,4,%L,%L,1800,''PRIVATE_TIMER_NOTE'',1)',v_timer_a,v_independent,v_today),'22023');
  -- Removing the posted item and starting another timer cannot make a retry
  -- insert it twice or reset the new active timer.
  v_result:=public.save_em_dia_own_hour_launch_note(v_launch,v_today,null,null,2);
  v_diary_version:=(v_result->>'version')::bigint;
  v_result:=public.change_em_dia_own_timer('start',v_timer_b,5);
  assert (v_result->>'version')::bigint=6;
  v_result:=public.post_em_dia_own_timer(v_timer_a,4,v_launch,v_today,1800,'PRIVATE_TIMER_NOTE',1);
  assert v_result->'unchanged'='true'::jsonb and v_result#>>'{timer,status}'='running';
  assert v_result#>>'{timer,timer_id}'=v_timer_b::text and (v_result#>>'{timer,version}')::bigint=6;
  assert (v_result#>>'{diary,version}')::bigint=v_diary_version and jsonb_array_length(v_result#>'{diary,launches}')=1;
  assert not exists(select 1 from jsonb_array_elements(v_result#>'{diary,launches}') e where e->>'id'=v_launch::text);
  v_result:=public.change_em_dia_own_timer('stop',v_timer_b,6);
  v_result:=public.change_em_dia_own_timer('discard',v_timer_b,7);
  assert v_result->>'status'='idle' and (v_result->>'version')::bigint=8;
  v_result:=public.change_em_dia_own_timer('discard',v_timer_b,7);
  assert v_result->'unchanged'='true'::jsonb and (v_result->>'version')::bigint=8;
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''start'',%L,8)',v_timer_b),'22023');
  v_result:=public.change_em_dia_own_timer('start',v_timer_c,8);
  assert (v_result->>'version')::bigint=9;
  reset role;
  assert (select to_jsonb(s)=v_state_snapshot from public.em_dia_states s where group_id=v_group);
  assert not exists(select 1 from em_dia_private.report_revisions where group_id=v_group);

  -- Active/stopped orphan guards also cover cards with no linked account or diary.
  insert into em_dia_private.service_timers(group_id,person_id,version,status,timer_id,start_date,started_at,anchor_at)
    values(v_group,'timer_guard',1,'running',gen_random_uuid(),v_today::date,clock_timestamp(),clock_timestamp());
  v_without_guard:=jsonb_set(v_state,'{people}',jsonb_build_array(v_person,v_other_person,v_ordinary_person));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_timer_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,1)',v_group,v_without_guard),'22023');
  reset role;
  update em_dia_private.service_timers set status='stopped',anchor_at=null,stopped_at=clock_timestamp()
    where group_id=v_group and person_id='timer_guard';
  set local role authenticated;
  perform pg_temp.expect_timer_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,1)',v_group,v_without_guard),'22023');
  reset role;
  update em_dia_private.service_timers set status='idle',timer_id=null,start_date=null,started_at=null,stopped_at=null
    where group_id=v_group and person_id='timer_guard';
  set local role authenticated;
  perform public.save_em_dia_group_state(v_group,v_without_guard,1);
  reset role;

  -- Transfers reject timer-only destination collisions and preserve all
  -- timing anchors, receipts and versions on success.
  insert into em_dia_private.service_timers(group_id,person_id,version,status)
    values(v_other_group,'timer_main',1,'idle');
  select revision into v_revision from public.em_dia_states where group_id=v_group;
  select to_jsonb(t)-'group_id' into v_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='timer_main';
  set local role authenticated;
  perform pg_temp.expect_timer_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_other_group,'timer_main',v_revision),'22023');
  reset role;
  assert (select to_jsonb(t)-'group_id'=v_snapshot from em_dia_private.service_timers t where group_id=v_group and person_id='timer_main');
  delete from em_dia_private.service_timers where group_id=v_other_group and person_id='timer_main';
  set local role authenticated;
  perform public.transfer_em_dia_publisher(v_group,v_other_group,'timer_main',v_revision);
  reset role;
  assert not exists(select 1 from em_dia_private.service_timers where group_id=v_group and person_id='timer_main');
  assert (select to_jsonb(t)-'group_id'=v_snapshot from em_dia_private.service_timers t where group_id=v_other_group and person_id='timer_main');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_timer();
  assert v_result->>'group_id'=v_other_group::text and v_result->>'timer_id'=v_timer_c::text and (v_result->>'version')::bigint=9;
  reset role;
  -- Reassignment keeps the timer with its card and revokes the former login.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  perform public.provision_em_dia_access(v_publisher,'superintendent',v_other_group,null);
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_super::text,true);
  set local role authenticated;
  perform public.provision_em_dia_publisher_account(v_replacement,v_other_group,'timer_main');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  perform pg_temp.expect_timer_error('select public.read_em_dia_own_timer()','42501');
  perform pg_temp.expect_timer_error(format('select public.change_em_dia_own_timer(''stop'',%L,9)',v_timer_c),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_replacement,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_replacement::text,true);
  set local role authenticated;
  v_result:=public.read_em_dia_own_timer();
  assert v_result->>'timer_id'=v_timer_c::text and v_result->>'status'='running';
  v_result:=public.post_em_dia_own_timer(v_timer_a,4,v_launch,v_today,1800,'PRIVATE_TIMER_NOTE',1);
  assert v_result->'unchanged'='true'::jsonb and v_result#>>'{timer,timer_id}'=v_timer_c::text;
  assert v_result#>>'{receipt,note}'='PRIVATE_TIMER_NOTE' and (v_result#>>'{diary,version}')::bigint=v_diary_version;
  reset role;
end;
$$;
rollback;
select 'Persistent clock, lifecycle, CAS, retries, atomic posting, privacy, guards and transfer passed; all fixtures rolled back.' as result;
