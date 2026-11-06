-- New operation UUIDs require exact CAS even when native endpoints allow noops.
begin;
create temporary table offline_strict_fixture(marker boolean) on commit drop;
create function pg_temp.strict_error(q text,c text) returns void language plpgsql set search_path='' as $$
declare failed boolean:=false;begin begin execute q;exception when others then if sqlstate<>c then raise;end if;failed:=true;end;assert failed,'Expected '||c;end;$$;
do $$begin execute format('grant usage on schema %s to authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant execute on function pg_temp.strict_error(text,text) to authenticated;
do $$
declare
  u uuid:=gen_random_uuid();m uuid:=gen_random_uuid();g uuid:=gen_random_uuid();launch uuid:=gen_random_uuid();
  d uuid:=gen_random_uuid();goal uuid:=gen_random_uuid();retro uuid:=gen_random_uuid();manual uuid:=gen_random_uuid();send uuid:=gen_random_uuid();
  timer1 uuid:=gen_random_uuid();timer2 uuid:=gen_random_uuid();postop uuid:=gen_random_uuid();timebase timestamptz:=clock_timestamp();
  today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');mon text:=left(today,7);
  prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  year integer;ryear integer;p jsonb;s jsonb;b jsonb;v jsonb;dbody jsonb;gbody jsonb;rbody jsonb;mbody jsonb;sendbody jsonb;rid uuid;
begin
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select n,'offline-strict-fixture-'||n||'@example.invalid','authenticated','authenticated',now(),now() from unnest(array[u,m]) n;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(u,false,'publisher'),(m,false,'superintendent');
  insert into public.em_dia_groups(id,name,created_by) values(g,'Offline strict fixture '||g,m);
  insert into public.em_dia_group_members(group_id,user_id) values(g,u),(g,m);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(u,g,'strict_main');
  s:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Strict fixture','group','Strict fixture','reminder',''),
    'people',jsonb_build_array(jsonb_build_object('id','strict_main','name','Strict fixture','startMonth',prior,'endMonth',null,
      'notes','','roles',jsonb_build_array(jsonb_build_object('kind','regular','start',prior,'end',null)))),
    'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',mon,'sourceNote','');
  insert into public.em_dia_states(group_id,owner_id,state,revision) values(g,null,s,1);
  p:=jsonb_build_object('userId',u,'groupId',g,'personId','strict_main');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  dbody:=p||jsonb_build_object('id',launch,'date',today,'minutes',90,'note','','expectedVersion',0);
  perform public.apply_em_dia_offline_operation(d,'diary_launch',dbody);
  perform public.save_em_dia_own_hour_launch_note(gen_random_uuid(),today,30,'',1);
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''diary_launch'',%L::jsonb)',gen_random_uuid(),dbody||'{"expectedVersion":1}'),'40001');
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''diary_launch'',%L::jsonb)',gen_random_uuid(),dbody),'40001');
  v:=public.apply_em_dia_offline_operation(d,'diary_launch',dbody);assert v->'replayed'='true'::jsonb and v#>'{confirmation,version}'='1'::jsonb;
  year:=left(mon,4)::integer-case when right(mon,2)<'09' then 1 else 0 end;
  ryear:=left(prior,4)::integer-case when right(prior,2)<'09' then 1 else 0 end;
  -- Keep goal and retro in the same service year even around September 1.
  gbody:=p||jsonb_build_object('serviceYear',ryear,'targetMinutes',35000,'expectedVersion',0);
  perform public.apply_em_dia_offline_operation(goal,'annual_goal',gbody);
  rbody:=p||jsonb_build_object('serviceYear',ryear,'month',prior,'minutes',60,'studies',1,'expectedVersion',1);
  perform public.apply_em_dia_offline_operation(retro,'annual_retro',rbody);
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''annual_goal'',%L::jsonb)',gen_random_uuid(),gbody||'{"expectedVersion":1}'),'40001');
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''annual_goal'',%L::jsonb)',gen_random_uuid(),gbody),'40001');
  v:=public.apply_em_dia_offline_operation(goal,'annual_goal',gbody);assert v#>'{confirmation,version}'='1'::jsonb and v->'replayed'='true'::jsonb;
  perform public.save_em_dia_own_annual_goal(ryear,34000,2);
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''annual_retro'',%L::jsonb)',gen_random_uuid(),rbody||'{"expectedVersion":2}'),'40001');
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''annual_retro'',%L::jsonb)',gen_random_uuid(),rbody),'40001');
  v:=public.apply_em_dia_offline_operation(retro,'annual_retro',rbody);assert v#>'{confirmation,version}'='2'::jsonb and v->'replayed'='true'::jsonb;
  mbody:=p||jsonb_build_object('month',mon,'report',jsonb_build_object('participated',true,'hours',2,'studies',1),'expectedVersion',0);
  perform public.apply_em_dia_offline_operation(manual,'report_manual',mbody);
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''report_manual'',%L::jsonb)',gen_random_uuid(),mbody),'40001');
  v:=public.submit_em_dia_own_report(mon,'{"participated":true,"hours":3,"studies":1}',1);
  v:=public.read_em_dia_own_card();rid:=(v#>>'{revisions,0,id}')::uuid;reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  perform public.review_em_dia_report_revision(rid,2,'accept');reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  b:=p||jsonb_build_object('month',mon,'report',jsonb_build_object('participated',true,'hours',3,'studies',1),'expectedVersion',2);
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''report_manual'',%L::jsonb)',gen_random_uuid(),b),'40001');
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''report_manual'',%L::jsonb)',gen_random_uuid(),b||'{"expectedVersion":1}'),'40001');
  v:=public.apply_em_dia_offline_operation(manual,'report_manual',mbody);assert v#>'{confirmation,version}'='1'::jsonb and v->'replayed'='true'::jsonb;
  sendbody:=p||jsonb_build_object('month',mon,'participated',true,'studies',1,'expectedHoursVersion',2,'expectedReportVersion',3);
  v:=public.apply_em_dia_offline_operation(send,'report_diary',sendbody);assert v#>'{confirmation,version}'='4'::jsonb;reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  perform public.review_em_dia_report_revision(rid,4,'accept');reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  b:=sendbody||'{"expectedReportVersion":4}'::jsonb;
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''report_diary'',%L::jsonb)',gen_random_uuid(),b),'40001');
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''report_diary'',%L::jsonb)',gen_random_uuid(),sendbody),'40001');
  perform public.save_em_dia_own_hour_launch_note(gen_random_uuid(),today,30,'',2);
  v:=public.apply_em_dia_offline_operation(send,'report_diary',sendbody);
  assert v->'replayed'='true'::jsonb and v#>'{confirmation,hours_version}'='2'::jsonb and v#>'{confirmation,version}'='4'::jsonb;
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''report_diary'',%L::jsonb)',gen_random_uuid(),sendbody||'{"expectedReportVersion":5}'),'40001');
  b:=p||jsonb_build_object('action','start','timerId',timer1,'expectedVersion',0,'at',timebase-interval '4 hours','elapsedMs',0);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  b:=p||jsonb_build_object('action','stop','timerId',timer1,'expectedVersion',1,'at',timebase-interval '3 hours','elapsedMs',3600000);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  b:=p||jsonb_build_object('timerId',timer1,'expectedTimerVersion',2,'launchId',gen_random_uuid(),'date',today,'minutes',60,'note','','expectedHoursVersion',3);
  perform public.apply_em_dia_offline_operation(postop,'timer_post',b);
  v:=p||jsonb_build_object('action','start','timerId',timer2,'expectedVersion',3,'at',timebase-interval '2 hours','elapsedMs',0);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',v);
  -- A new operation cannot borrow the old legacy post receipt to inherit the
  -- later timer/diary versions; only its original durable operation may replay.
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''timer_post'',%L::jsonb)',gen_random_uuid(),b),'40001');
  perform pg_temp.strict_error(format('select public.apply_em_dia_offline_operation(%L,''timer_post'',%L::jsonb)',gen_random_uuid(),b||'{"expectedTimerVersion":4}'),'40001');
  v:=public.apply_em_dia_offline_operation(postop,'timer_post',b);
  assert v->'replayed'='true'::jsonb and v#>'{confirmation,timer_version}'='3'::jsonb and v#>'{confirmation,hours_version}'='4'::jsonb;
  assert public.read_em_dia_own_timer()->>'timer_id'=timer2::text;
  reset role;
  assert (select version=4 from em_dia_private.daily_hours where group_id=g and person_id='strict_main' and month=mon);
  assert (select status='accepted' and version=5 from em_dia_private.report_revisions where id=rid);
end;$$;
rollback;
select 'Strict new-operation CAS rejects external noops while durable receipt replay survives.' as result,
  (select count(*) from auth.users where email like 'offline-strict-fixture-%@example.invalid') as fixture_users,
  (select count(*) from em_dia_private.offline_receipts t join auth.users u on u.id=t.actor_id where u.email like 'offline-strict-fixture-%@example.invalid') as fixture_receipts;
