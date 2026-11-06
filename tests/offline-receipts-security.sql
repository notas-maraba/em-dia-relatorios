-- Independent receipt/CAS fixtures; no real data are changed.
begin;
create temporary table offline_receipt_fixture(marker boolean) on commit drop;
create function pg_temp.offline_error(q text,c text) returns void language plpgsql set search_path='' as $$
declare failed boolean:=false;
begin begin execute q; exception when others then if sqlstate<>c then raise; end if;failed:=true;end;assert failed,'Expected '||c;end;$$;
do $$begin execute format('grant usage on schema %s to authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant execute on function pg_temp.offline_error(text,text) to authenticated;
do $$
declare
  a uuid:=gen_random_uuid();m uuid:=gen_random_uuid();u uuid:=gen_random_uuid();o uuid:=gen_random_uuid();x uuid:=gen_random_uuid();
  g uuid:=gen_random_uuid();h uuid:=gen_random_uuid();op uuid:=gen_random_uuid();d uuid:=gen_random_uuid();r uuid:=gen_random_uuid();
  manual uuid:=gen_random_uuid();goal uuid:=gen_random_uuid();retro uuid:=gen_random_uuid();launch uuid:=gen_random_uuid();
  today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');mon text:=left(today,7);
  prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  year integer;ryear integer;s jsonb;p jsonb;b jsonb;v jsonb;z jsonb;receipt jsonb;rv bigint;rid uuid;
begin
  assert not has_table_privilege('authenticated','em_dia_private.offline_receipts','SELECT');
  assert not has_table_privilege('service_role','em_dia_private.offline_receipts','SELECT');
  assert not has_function_privilege('anon','public.apply_em_dia_offline_operation(uuid,text,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.change_own_timer_offline(text,uuid,bigint,text,bigint)','EXECUTE');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.offline_receipts'::regclass);
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select n,'offline-receipt-fixture-'||n||'@example.invalid','authenticated','authenticated',now(),now() from unnest(array[a,m,u,o,x]) n;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(a,true,'admin'),(m,false,'superintendent'),(u,false,'publisher'),(o,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values(g,'Offline receipt A '||g,a),(h,'Offline receipt B '||h,a);
  insert into public.em_dia_group_members(group_id,user_id) values(g,a),(g,m),(g,u),(g,o);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(u,g,'receipt_main'),(o,g,'receipt_other');
  p:=jsonb_build_object('id','receipt_main','name','Receipt fixture','startMonth',prior,'endMonth',null,'notes','PRIVATE_CARD',
    'roles',jsonb_build_array(jsonb_build_object('kind','regular','start',prior,'end',null)));
  s:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Offline fixture','group','Offline fixture','reminder',''),
    'people',jsonb_build_array(p,jsonb_set(p,'{id}','"receipt_other"')),'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',mon,'sourceNote','');
  insert into public.em_dia_states(group_id,owner_id,state,revision) values(g,null,s,1),(h,null,jsonb_set(s,'{people}','[]'),1);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',x,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',x::text,true);set local role authenticated;
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''group_save'',%L::jsonb)',op,
    jsonb_build_object('userId',x,'groupId',g,'personId',null,'state',s,'expectedRevision',1)),'42501');reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  b:=jsonb_build_object('userId',m,'groupId',g,'personId',null,'state',s,'expectedRevision',1);
  v:=public.apply_em_dia_offline_operation(op,'group_save',b);
  assert v->'replayed'='false'::jsonb and v#>'{confirmation,revision}'='2'::jsonb and not(v::text like '%people%');
  perform public.save_em_dia_group_state(g,jsonb_set(s,'{sourceNote}','"EXTERNAL_WRITE"'),2);
  v:=public.apply_em_dia_offline_operation(op,'group_save',b);
  assert v->'replayed'='true'::jsonb and v#>'{confirmation,revision}'='2'::jsonb;
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''group_save'',%L::jsonb)',op,
    b||'{"expectedRevision":3}'::jsonb),'22023');
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''group_save'',%L::jsonb)',gen_random_uuid(),b),'40001');
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''group_save'',%L::jsonb)',gen_random_uuid(),
    b||jsonb_build_object('groupId',h)),'42501');
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''group_save'',%L::jsonb)',op,
    b||jsonb_build_object('userId',u)),'42501');reset role;
  assert (select revision=3 and state->>'sourceNote'='EXTERNAL_WRITE' from public.em_dia_states where group_id=g);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  p:=jsonb_build_object('userId',u,'groupId',g,'personId','receipt_main');
  b:=p||jsonb_build_object('id',launch,'date',today,'minutes',90,'note','PRIVATE_DIARY_NOTE','expectedVersion',0);
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''diary_launch'',%L::jsonb)',d,
    b||'{"personId":"receipt_other"}'::jsonb),'42501');
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''diary_launch'',%L::jsonb)',d,
    b||jsonb_build_object('userId',m)),'42501');
  v:=public.apply_em_dia_offline_operation(d,'diary_launch',b);assert v#>'{confirmation,version}'='1'::jsonb;
  z:=p||jsonb_build_object('month',mon,'participated',null,'studies',2,'expectedHoursVersion',1,'expectedReportVersion',0);
  v:=public.apply_em_dia_offline_operation(r,'report_diary',z);assert v#>>'{confirmation,status}'='accepted';
  perform public.save_em_dia_own_hour_launch_note(gen_random_uuid(),today,30,'PRIVATE_LATER_NOTE',1);
  v:=public.apply_em_dia_offline_operation(r,'report_diary',z);
  assert v->'replayed'='true'::jsonb and v#>'{confirmation,hours_version}'='1'::jsonb;
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''report_diary'',%L::jsonb)',gen_random_uuid(),z),'40001');
  assert public.read_em_dia_own_card()#>array['state','reports',mon,'receipt_main','hours']='1.5'::jsonb;
  z:=p||jsonb_build_object('month',mon,'report',jsonb_build_object('participated',true,'hours',2,'studies',2),'expectedVersion',1);
  v:=public.apply_em_dia_offline_operation(manual,'report_manual',z);assert v#>>'{confirmation,status}'='pending';
  v:=public.read_em_dia_own_card();rid:=(v#>>'{revisions,0,id}')::uuid;reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  perform public.review_em_dia_report_revision(rid,2,'accept');reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  v:=public.apply_em_dia_offline_operation(manual,'report_manual',z);
  assert v->'replayed'='true'::jsonb and v#>>'{confirmation,status}'='pending' and v#>'{confirmation,version}'='2'::jsonb;
  year:=left(mon,4)::integer-case when right(mon,2)<'09' then 1 else 0 end;
  ryear:=left(prior,4)::integer-case when right(prior,2)<'09' then 1 else 0 end;
  b:=p||jsonb_build_object('serviceYear',year,'targetMinutes',35000,'expectedVersion',0);
  v:=public.apply_em_dia_offline_operation(goal,'annual_goal',b);
  perform public.save_em_dia_own_annual_goal(year,34000,1);
  v:=public.apply_em_dia_offline_operation(goal,'annual_goal',b);assert v->'replayed'='true'::jsonb and v#>'{confirmation,version}'='1'::jsonb;
  v:=public.read_em_dia_own_annual(ryear);rv:=(v->>'version')::bigint;
  b:=p||jsonb_build_object('serviceYear',ryear,'month',prior,'minutes',60,'studies',1,'expectedVersion',rv);
  v:=public.apply_em_dia_offline_operation(retro,'annual_retro',b);receipt:=v;
  perform public.submit_em_dia_own_report(prior,'{"participated":true,"hours":1,"studies":1}',0);
  v:=public.apply_em_dia_offline_operation(retro,'annual_retro',b);
  assert v->'replayed'='true'::jsonb and v->'confirmation'=receipt->'confirmation';
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''annual_retro'',%L::jsonb)',gen_random_uuid(),b),'40001');
  reset role;
  assert (select status='accepted' and version=3 from em_dia_private.report_revisions where id=rid);
  assert not exists(select 1 from em_dia_private.offline_receipts t where t.group_id=g and to_jsonb(t)::text like '%PRIVATE_%');
  -- Current binding, not a cached identity, controls even receipt replay.
  delete from em_dia_private.publisher_links where user_id=o;
  update em_dia_private.publisher_links set person_id='receipt_other' where user_id=u;
  set local role authenticated;
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''annual_retro'',%L::jsonb)',retro,b),'42501');reset role;
  -- Revocation is checked before acknowledging an older manager receipt.
  update public.em_dia_members set access_role='publisher' where user_id=m;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  perform pg_temp.offline_error(format('select public.apply_em_dia_offline_operation(%L,''group_save'',%L::jsonb)',op,
    jsonb_build_object('userId',m,'groupId',g,'personId',null,'state',s,'expectedRevision',1)),'42501');reset role;
end;$$;
rollback;
select 'Offline receipts, lost acknowledgements, CAS, binding and privacy passed.' as result,
  (select count(*) from auth.users where email like 'offline-receipt-fixture-%@example.invalid') as fixture_users,
  (select count(*) from em_dia_private.offline_receipts t join auth.users u on u.id=t.actor_id where u.email like 'offline-receipt-fixture-%@example.invalid') as fixture_receipts;
