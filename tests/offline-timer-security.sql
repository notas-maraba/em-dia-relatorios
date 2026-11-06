-- Offline timer clock and durable replay fixtures, all rolled back.
begin;
create temporary table offline_timer_fixture(marker boolean) on commit drop;
create function pg_temp.timer_offline_error(q text,c text) returns void language plpgsql set search_path='' as $$
declare failed boolean:=false;begin begin execute q;exception when others then if sqlstate<>c then raise;end if;failed:=true;end;assert failed,'Expected '||c;end;$$;
do $$begin execute format('grant usage on schema %s to authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant execute on function pg_temp.timer_offline_error(text,text) to authenticated;
do $$
declare
  u uuid:=gen_random_uuid();g uuid:=gen_random_uuid();t uuid:=gen_random_uuid();t2 uuid:=gen_random_uuid();t3 uuid:=gen_random_uuid();
  startop uuid:=gen_random_uuid();postop uuid:=gen_random_uuid();l uuid:=gen_random_uuid();
  base timestamptz:=clock_timestamp();started timestamptz:=base-interval '2 days';paused timestamptz:=base-interval '1 day';
  resumed timestamptz:=base-interval '12 hours';stopped timestamptz:=base-interval '10 hours';
  today text:=to_char(base at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  first_month text:=to_char((base at time zone 'America/Sao_Paulo')-interval '2 months','YYYY-MM');
  p jsonb;b jsonb;startbody jsonb;postbody jsonb;v jsonb;timer jsonb;s jsonb;
begin
  insert into auth.users(id,email,role,aud,created_at,updated_at) values(u,'offline-timer-fixture-'||u||'@example.invalid','authenticated','authenticated',now(),now());
  insert into public.em_dia_members(user_id,is_admin,access_role) values(u,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values(g,'Offline timer fixture '||g,u);
  insert into public.em_dia_group_members(group_id,user_id) values(g,u);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(u,g,'offline_timer');
  s:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Offline timer','group','Offline timer','reminder',''),
    'people',jsonb_build_array(jsonb_build_object('id','offline_timer','name','Offline timer fixture','startMonth',first_month,'endMonth',null,
      'notes','','roles',jsonb_build_array(jsonb_build_object('kind','regular','start',first_month,'end',null)))),
    'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',left(today,7),'sourceNote','');
  insert into public.em_dia_states(group_id,owner_id,state,revision) values(g,null,s,1);
  p:=jsonb_build_object('userId',u,'groupId',g,'personId','offline_timer');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  startbody:=p||jsonb_build_object('action','start','timerId',t,'expectedVersion',0,'at',started,'elapsedMs',0);
  v:=public.apply_em_dia_offline_operation(startop,'timer_change',startbody);assert v#>'{confirmation,timer_version}'='1'::jsonb;
  timer:=public.read_em_dia_own_timer();assert timer->>'status'='running' and (timer->>'elapsed_ms')::bigint>=172800000;
  b:=p||jsonb_build_object('action','pause','timerId',t,'expectedVersion',1,'at',paused,'elapsedMs',7200000);
  v:=public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  timer:=public.read_em_dia_own_timer();assert timer->>'status'='paused' and (timer->>'elapsed_ms')::bigint=7200000;
  -- Replaying an earlier start must not replace the later paused state.
  v:=public.apply_em_dia_offline_operation(startop,'timer_change',startbody);
  assert v->'replayed'='true'::jsonb and v#>'{confirmation,timer_version}'='1'::jsonb;
  assert public.read_em_dia_own_timer()->>'status'='paused';
  b:=p||jsonb_build_object('action','resume','timerId',t,'expectedVersion',2,'at',resumed,'elapsedMs',7200001);
  perform pg_temp.timer_offline_error(format('select public.apply_em_dia_offline_operation(%L,''timer_change'',%L::jsonb)',gen_random_uuid(),b),'22023');
  b:=b||'{"elapsedMs":7200000}'::jsonb;
  v:=public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  timer:=public.read_em_dia_own_timer();assert timer->>'status'='running' and (timer->>'accumulated_ms')::bigint=7200000;
  b:=p||jsonb_build_object('action','stop','timerId',t,'expectedVersion',3,'at',stopped,'elapsedMs',10800000);
  v:=public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  timer:=public.read_em_dia_own_timer();assert timer->>'status'='stopped' and (timer->>'elapsed_ms')::bigint=10800000;
  assert (timer->>'stopped_at')::timestamptz=stopped;
  -- A stale device and out-of-order event cannot consume a new timer version.
  perform pg_temp.timer_offline_error(format('select public.apply_em_dia_offline_operation(%L,''timer_change'',%L::jsonb)',gen_random_uuid(),
    b||'{"expectedVersion":2}'::jsonb),'40001');
  postop:=gen_random_uuid();
  postbody:=p||jsonb_build_object('timerId',t,'expectedTimerVersion',4,'launchId',l,'date',today,'minutes',180,
    'note','PRIVATE_OFFLINE_TIMER_NOTE','expectedHoursVersion',0);
  v:=public.apply_em_dia_offline_operation(postop,'timer_post',postbody);
  assert v#>'{confirmation,timer_version}'='5'::jsonb and v#>'{confirmation,hours_version}'='1'::jsonb;
  assert public.read_em_dia_own_timer()->>'status'='idle';
  -- A second post overwrites the old legacy receipt, but cannot erase the
  -- durable operation receipt for the first post.
  b:=p||jsonb_build_object('action','start','timerId',t2,'expectedVersion',5,'at',base-interval '8 hours','elapsedMs',0);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  b:=p||jsonb_build_object('action','stop','timerId',t2,'expectedVersion',6,'at',base-interval '6 hours','elapsedMs',3600000);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  b:=p||jsonb_build_object('timerId',t2,'expectedTimerVersion',7,'launchId',gen_random_uuid(),'date',today,'minutes',60,
    'note','','expectedHoursVersion',1);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_post',b);
  b:=p||jsonb_build_object('action','start','timerId',t3,'expectedVersion',8,'at',base-interval '4 hours','elapsedMs',0);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  v:=public.apply_em_dia_offline_operation(postop,'timer_post',postbody);
  assert v->'replayed'='true'::jsonb and v#>'{confirmation,timer_version}'='5'::jsonb;
  timer:=public.read_em_dia_own_timer();assert timer->>'timer_id'=t3::text and timer->>'status'='running' and (timer->>'version')::bigint=9;
  assert (public.read_em_dia_own_hour_launches(left(today,7))->>'version')::bigint=2;
  assert jsonb_array_length(public.read_em_dia_own_hour_launches(left(today,7))->'launches')=2;
  b:=p||jsonb_build_object('action','stop','timerId',t3,'expectedVersion',9,'at',base-interval '2 hours','elapsedMs',1800000);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  b:=p||jsonb_build_object('action','discard','timerId',t3,'expectedVersion',10,'at',base-interval '1 hour','elapsedMs',0);
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  b:=p||jsonb_build_object('action','start','timerId',gen_random_uuid(),'expectedVersion',11,'at',base+interval '6 minutes','elapsedMs',0);
  perform pg_temp.timer_offline_error(format('select public.apply_em_dia_offline_operation(%L,''timer_change'',%L::jsonb)',gen_random_uuid(),b),'22023');
  b:=b||jsonb_build_object('at',base+interval '2 minutes');
  perform public.apply_em_dia_offline_operation(gen_random_uuid(),'timer_change',b);
  timer:=public.read_em_dia_own_timer();assert (timer->>'anchor_at')::timestamptz<=(timer->>'server_now')::timestamptz;
  b:=b||jsonb_build_object('action','pause','expectedVersion',12,'at',base-interval '3 hours','elapsedMs',1);
  perform pg_temp.timer_offline_error(format('select public.apply_em_dia_offline_operation(%L,''timer_change'',%L::jsonb)',gen_random_uuid(),b),'22023');
  reset role;
  assert (select state=s and revision=1 from public.em_dia_states where group_id=g);
  assert not exists(select 1 from em_dia_private.offline_receipts q where q.group_id=g and to_jsonb(q)::text like '%PRIVATE_%');
end;$$;
rollback;
select 'Offline elapsed time, chronological CAS, clamping, atomic posts and durable timer replays passed.' as result,
  (select count(*) from auth.users where email like 'offline-timer-fixture-%@example.invalid') as fixture_users,
  (select count(*) from em_dia_private.offline_receipts t join auth.users u on u.id=t.actor_id where u.email like 'offline-timer-fixture-%@example.invalid') as fixture_receipts;
