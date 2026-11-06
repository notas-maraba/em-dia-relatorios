-- Own-account profile fixtures: synthetic 1px JPEG only, all writes rolled back.
begin;
create temporary table account_profile_fixture(marker boolean) on commit drop;
create function pg_temp.profile_error(q text,c text) returns void language plpgsql set search_path='' as $$
declare failed boolean:=false;
begin
  begin execute q;exception when others then if sqlstate<>c then raise;end if;failed:=true;end;
  assert failed,'Expected '||c;
end;
$$;
do $$begin execute format('grant usage on schema %s to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant execute on function pg_temp.profile_error(text,text) to authenticated,anon;
do $$
declare
  a uuid:=gen_random_uuid();m uuid:=gen_random_uuid();u uuid:=gen_random_uuid();o uuid:=gen_random_uuid();x uuid:=gen_random_uuid();
  g uuid:=gen_random_uuid();mon text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM');
  photo text:='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==';p jsonb;s jsonb;v jsonb;first_updated text;
begin
  assert not has_table_privilege('authenticated','em_dia_private.account_profiles','SELECT');
  assert not has_table_privilege('service_role','em_dia_private.account_profiles','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.account_profiles','INSERT');
  assert not has_table_privilege('authenticated','em_dia_private.account_profiles','UPDATE');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid='em_dia_private.account_profiles'::regclass);
  assert not has_function_privilege('anon','public.read_em_dia_own_account_profile(uuid)','EXECUTE');
  assert not has_function_privilege('service_role','public.save_em_dia_own_account_profile(text,text,bigint,uuid)','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.valid_account_avatar(text)','EXECUTE');
  assert (select not prosecdef and proconfig=array['search_path=""']::text[] from pg_proc where oid='public.read_em_dia_own_account_profile(uuid)'::regprocedure);
  assert (select not prosecdef from pg_proc where oid='public.save_em_dia_own_account_profile(text,text,bigint,uuid)'::regprocedure);
  assert (select prosecdef and proowner='em_dia_workflow'::regrole from pg_proc where oid='em_dia_private.save_own_account_profile(text,text,bigint,uuid)'::regprocedure);
  assert to_regprocedure('public.read_em_dia_own_account_profile()') is null;
  assert to_regprocedure('public.save_em_dia_own_account_profile(text,text,bigint)') is null;
  insert into auth.users(id,email,role,aud,created_at,updated_at)
    select n,'account-profile-fixture-'||n||'@example.invalid','authenticated','authenticated',now(),now() from unnest(array[a,m,u,o,x]) n;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(a,true,'admin'),(m,false,'superintendent'),(u,false,'publisher'),(o,false,'publisher');
  insert into public.em_dia_groups(id,name,created_by) values(g,'Account profile fixture '||g,a);
  insert into public.em_dia_group_members(group_id,user_id) values(g,a),(g,m),(g,u),(g,o);
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(u,g,'profile_main'),(o,g,'profile_other');
  p:=jsonb_build_object('id','profile_main','name','Account profile fixture','startMonth',mon,'endMonth',null,'notes','','roles','[]'::jsonb);
  s:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Fixture','group','Fixture','reminder',''),'people',
    jsonb_build_array(p,jsonb_set(p,'{id}','"profile_other"')),'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',mon,'sourceNote','');
  insert into public.em_dia_states(group_id,owner_id,state,revision) values(g,null,s,1);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',x,'role','authenticated','user_metadata',jsonb_build_object('role','admin'))::text,true);
  perform set_config('request.jwt.claim.sub',x::text,true);set local role authenticated;
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',x),'42501');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''No'',null,0,%L)',x),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
  v:=public.read_em_dia_own_account_profile(a);
  assert v=jsonb_build_object('user_id',a,'display_name','','avatar_data',null,'version',0,'updated_at',null);
  perform pg_temp.profile_error('select * from em_dia_private.account_profiles','42501');
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',u),'42501');
  perform pg_temp.profile_error('select public.read_em_dia_own_account_profile(null)','42501');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''Spoof'',null,0,%L)',u),'42501');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(%L,null,0,%L)',repeat('X',81),a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(%L,null,0,%L)',E'Line\nbreak',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(null,null,0,%L)',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',null,-1,%L)',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',null,null,%L)',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)','https://example.invalid/photo.jpg',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)','data:image/svg+xml;base64,PHN2Zy8+',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)','data:image/png;base64,iVBORw0KGgo=',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)','data:image/jpeg;base64,not a jpeg',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)','data:image/jpeg;base64,AAAAAA==',a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)',left(photo,length(photo)-4),a),'22023');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''N'',%L,0,%L)','data:image/jpeg;base64,'||repeat('A',140000),a),'22023');
  v:=public.save_em_dia_own_account_profile('  Admin fixture  ',photo,0,a);
  assert v->>'display_name'='Admin fixture' and v->>'avatar_data'=photo and v->>'user_id'=a::text and v->'version'='1'::jsonb;
  first_updated:=v->>'updated_at';
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''Admin fixture'',%L,0,%L)',photo,a),'40001');
  v:=public.save_em_dia_own_account_profile('Admin fixture',photo,1,a);assert v->'version'='1'::jsonb and v->>'updated_at'=first_updated;
  v:=public.save_em_dia_own_account_profile('Admin fixture',null,1,a);assert v->'version'='2'::jsonb and v->'avatar_data'='null'::jsonb;
  v:=public.save_em_dia_own_account_profile('',null,2,a);assert v->'version'='3'::jsonb and v->>'display_name'='';
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',m::text,true);set local role authenticated;
  v:=public.save_em_dia_own_account_profile('',null,0,m);assert v->'version'='0'::jsonb;
  v:=public.save_em_dia_own_account_profile('Supervisor fixture',photo,0,m);assert v->'version'='1'::jsonb;
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',a),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  v:=public.save_em_dia_own_account_profile('Publisher fixture',photo,0,u);assert v->'version'='1'::jsonb;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',o,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',o::text,true);set local role authenticated;
  v:=public.read_em_dia_own_account_profile(o);assert v->>'display_name'='' and v->'version'='0'::jsonb and v->'avatar_data'='null'::jsonb;
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',u),'42501');
  reset role;
  -- The account keeps its identity when its publisher link changes.
  delete from em_dia_private.publisher_links where user_id=o;
  update em_dia_private.publisher_links set person_id='profile_other' where user_id=u;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',u::text,true);set local role authenticated;
  v:=public.read_em_dia_own_account_profile(u);assert v->>'display_name'='Publisher fixture' and v->>'avatar_data'=photo;
  reset role;
  delete from public.em_dia_members where user_id=u;
  set local role authenticated;
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',u),'42501');
  perform pg_temp.profile_error(format('select public.save_em_dia_own_account_profile(''Revoked'',null,1,%L)',u),'42501');
  reset role;
  perform set_config('request.jwt.claims','{}',true);perform set_config('request.jwt.claim.sub','',true);set local role authenticated;
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',a),'42501');
  reset role;set local role anon;
  perform pg_temp.profile_error(format('select public.read_em_dia_own_account_profile(%L)',a),'42501');
  reset role;
end;
$$;
rollback;
select 'Own account profile, private photo, permissions, CAS and validation passed.' as result,
  (select count(*) from auth.users where email like 'account-profile-fixture-%@example.invalid') as fixture_users,
  (select count(*) from em_dia_private.account_profiles p join auth.users u on u.id=p.user_id where u.email like 'account-profile-fixture-%@example.invalid') as fixture_profiles;
