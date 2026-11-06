-- Authorized bootstrap fixtures: whole groups only for managers, own data for publishers.
begin;
create temporary table offline_snapshot_fixture(marker boolean) on commit drop;
create function pg_temp.snapshot_error(q text,c text) returns void language plpgsql set search_path='' as $$
declare failed boolean:=false;begin begin execute q;exception when others then if sqlstate<>c then raise;end if;failed:=true;end;assert failed,'Expected '||c;end;$$;
do $$begin execute format('grant usage on schema %s to authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant execute on function pg_temp.snapshot_error(text,text) to authenticated;
do $$
declare
  a uuid:=gen_random_uuid();m uuid:=gen_random_uuid();u uuid:=gen_random_uuid();o uuid:=gen_random_uuid();x uuid:=gen_random_uuid();
  g uuid:=gen_random_uuid();h uuid:=gen_random_uuid();today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  mon text:=left(today,7);prior text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  oldmonth text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '2 months','YYYY-MM');
  s jsonb;hidden jsonb;p jsonb;v jsonb;b jsonb;before_rows jsonb;
begin
  assert not has_function_privilege('anon','public.read_em_dia_offline_snapshot()','EXECUTE');
  assert not has_function_privilege('service_role','public.read_em_dia_offline_snapshot()','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.offline_uuid(jsonb)','EXECUTE');
  assert (select not prosecdef from pg_proc where oid='public.read_em_dia_offline_snapshot()'::regprocedure);
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select n,'offline-snapshot-fixture-'||n||'@example.invalid','authenticated','authenticated',now(),now() from unnest(array[a,m,u,o,x]) n;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(a,true,'admin'),(m,false,'superintendent'),(u,false,'publisher'),(o,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values(g,'Offline snapshot A '||g,a),(h,'PRIVATE_HIDDEN_GROUP '||h,a);
  insert into public.em_dia_group_members(group_id,user_id) values(g,a),(g,m),(g,u),(h,o);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(u,g,'snapshot_main'),(o,h,'snapshot_other');
  p:=jsonb_build_object('id','snapshot_main','name','Snapshot fixture','startMonth',prior,'endMonth',null,'notes','PRIVATE_CARD_INTERNAL',
    'roles',jsonb_build_array(jsonb_build_object('kind','regular','start',prior,'end',null)));
  s:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Snapshot fixture','group','Snapshot fixture','reminder',''),
    'people',jsonb_build_array(p),'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',mon,'sourceNote','PRIVATE_SOURCE_INTERNAL');
  hidden:=jsonb_set(s,'{people}',jsonb_build_array(jsonb_set(jsonb_set(p,'{id}','"snapshot_other"'),'{name}','"PRIVATE_HIDDEN_PERSON"')));
  insert into public.em_dia_states(group_id,owner_id,state,revision) values(g,null,s,1),(h,null,hidden,1);
  insert into em_dia_private.daily_hours(group_id,person_id,month,entries,launches,version) values
    (g,'snapshot_main',oldmonth,jsonb_build_object(oldmonth||'-01',30),jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date',oldmonth||'-01','minutes',30,'note','OWN_OLD_NOTE')),2),
    (g,'snapshot_main',mon,jsonb_build_object(mon||'-01',60),jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date',mon||'-01','minutes',60,'note','OWN_CURRENT_NOTE')),3),
    (h,'snapshot_other',mon,jsonb_build_object(mon||'-01',90),jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'date',mon||'-01','minutes',90,'note','PRIVATE_OTHER_DIARY')),4);
  insert into em_dia_private.annual_progress(group_id,person_id,service_year,target_minutes,version) values(g,'snapshot_main',2023,33000,2),(h,'snapshot_other',2023,44000,2);
  insert into em_dia_private.report_revisions(group_id,person_id,user_id,month,status,version,proposed_report) values
    (g,'snapshot_main',u,mon,'pending',1,'{"received":true,"kind":"regular","participated":true,"hours":1,"studies":1}'),
    (h,'snapshot_other',o,mon,'pending',1,'{"received":true,"kind":"regular","participated":true,"hours":99,"studies":9}');
  select jsonb_agg(z order by z::text) into before_rows from (
    select to_jsonb(q) z from public.em_dia_states q where group_id in(g,h)
    union all select to_jsonb(q) from em_dia_private.daily_hours q where group_id in(g,h)
    union all select to_jsonb(q) from em_dia_private.annual_progress q where group_id in(g,h)
    union all select to_jsonb(q) from em_dia_private.report_revisions q where group_id in(g,h)) all_rows;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',x,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',x::text,true);set local role authenticated;
  perform pg_temp.snapshot_error('select public.read_em_dia_offline_snapshot()','42501');reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  v:=public.read_em_dia_offline_snapshot();
  assert v#>>'{profile,user_id}'=u::text and v#>>'{profile,role}'='publisher';
  assert v->'states'='[]'::jsonb and v->'revisions'='[]'::jsonb and jsonb_array_length(v->'groups')=1;
  assert v#>>'{own_card,person_id}'='snapshot_main' and v#>>'{own_card,state,people,0,notes}'='';
  assert not(v::text like '%PRIVATE_HIDDEN_%') and not(v::text like '%PRIVATE_OTHER_DIARY%') and not(v::text like '%PRIVATE_CARD_INTERNAL%');
  assert exists(select 1 from jsonb_array_elements(v->'diaries') d where d->>'month'=oldmonth and d->'can_use'='false'::jsonb and d#>>'{launches,0,note}'='OWN_OLD_NOTE');
  assert exists(select 1 from jsonb_array_elements(v->'diaries') d where d->>'month'=prior and d->'entries'='{}'::jsonb and d->'can_use'='true'::jsonb);
  assert exists(select 1 from jsonb_array_elements(v->'diaries') d where d->>'month'=mon and d#>>'{launches,0,note}'='OWN_CURRENT_NOTE');
  assert not exists(select 1 from jsonb_array_elements(v->'diaries') d where d->>'person_id'<>'snapshot_main' or d->>'group_id'<>g::text);
  assert exists(select 1 from jsonb_array_elements(v->'annuals') y where y->>'service_year'='2023' and y->>'target_minutes'='33000');
  assert v#>>'{timer,status}'='idle';
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  v:=public.read_em_dia_offline_snapshot();
  assert jsonb_array_length(v->'groups')=1 and jsonb_array_length(v->'states')=1 and v#>>'{states,0,group_id}'=g::text;
  assert v->'diaries'='[]'::jsonb and v->'annuals'='[]'::jsonb and not(v ? 'own_card') and not(v ? 'timer');
  assert v#>'{revisions,0,items,total}'='1'::jsonb and not(v::text like '%PRIVATE_HIDDEN_%') and not(v::text like '%OWN_CURRENT_NOTE%');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
  v:=public.read_em_dia_offline_snapshot();
  assert exists(select 1 from jsonb_array_elements(v->'groups') q where q->>'id'=g::text)
    and exists(select 1 from jsonb_array_elements(v->'groups') q where q->>'id'=h::text);
  assert exists(select 1 from jsonb_array_elements(v->'states') q where q->>'group_id'=g::text)
    and exists(select 1 from jsonb_array_elements(v->'states') q where q->>'group_id'=h::text);
  assert v->'diaries'='[]'::jsonb and v->'annuals'='[]'::jsonb;
  reset role;
  select jsonb_agg(z order by z::text) into b from (
    select to_jsonb(q) z from public.em_dia_states q where group_id in(g,h)
    union all select to_jsonb(q) from em_dia_private.daily_hours q where group_id in(g,h)
    union all select to_jsonb(q) from em_dia_private.annual_progress q where group_id in(g,h)
    union all select to_jsonb(q) from em_dia_private.report_revisions q where group_id in(g,h)) all_rows;
  assert b=before_rows;
  assert not exists(select 1 from em_dia_private.offline_receipts q where q.group_id in(g,h));
end;$$;
rollback;
select 'Offline snapshots isolate roles/cards, preserve historical diaries and perform no writes.' as result,
  (select count(*) from auth.users where email like 'offline-snapshot-fixture-%@example.invalid') as fixture_users,
  (select count(*) from em_dia_private.offline_receipts t join auth.users u on u.id=t.actor_id where u.email like 'offline-snapshot-fixture-%@example.invalid') as fixture_receipts;
