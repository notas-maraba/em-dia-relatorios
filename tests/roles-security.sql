-- Run as postgres after the RBAC migration. No email or password is generated.
-- All accounts, states, permissions and role changes below are rolled back.
begin;

-- Initialize this connection's temporary namespace before creating a helper.
create temporary table em_dia_roles_fixture_scope(marker boolean) on commit drop;

create function pg_temp.expect_error(p_query text,p_code text) returns void
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
do $$ begin
  execute format('grant usage on schema %I to authenticated',pg_my_temp_schema()::regnamespace::text);
end; $$;
grant execute on function pg_temp.expect_error(text,text) to authenticated;

do $$
declare
  v_admin uuid:=gen_random_uuid(); v_super uuid:=gen_random_uuid(); v_other_super uuid:=gen_random_uuid();
  v_publisher uuid:=gen_random_uuid(); v_new_user uuid:=gen_random_uuid(); v_outsider uuid:=gen_random_uuid();
  v_replacement uuid:=gen_random_uuid();
  v_group uuid:=gen_random_uuid(); v_other_group uuid:=gen_random_uuid(); v_empty_group uuid:=gen_random_uuid();
  -- Pioneer monthly submissions use completed months in the daily-hours release.
  v_month text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '1 month','YYYY-MM');
  v_previous text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')-interval '2 months','YYYY-MM');
  v_future text:=to_char((statement_timestamp() at time zone 'America/Sao_Paulo')+interval '1 month','YYYY-MM');
  v_state jsonb; v_person jsonb; v_other_person jsonb; v_result jsonb; v_pending jsonb; v_card jsonb;
  v_saved public.em_dia_states; v_row public.em_dia_groups; v_before public.em_dia_states;
  v_revision_id uuid; v_revision bigint; v_before_revision bigint; v_count bigint;
  v_report jsonb:='{"participated":true,"hours":12.5,"studies":2}'::jsonb;
  v_changed jsonb:='{"participated":true,"hours":15,"studies":3}'::jsonb;
  v_unknown jsonb:='{"participated":null,"hours":null,"studies":null}'::jsonb;
begin
  -- Static grants and ownership are part of the security contract, not just UI.
  assert not has_table_privilege('anon','public.em_dia_states','SELECT');
  assert not has_table_privilege('authenticated','public.em_dia_states','UPDATE');
  assert not has_table_privilege('authenticated','public.em_dia_members','INSERT');
  assert not has_table_privilege('authenticated','public.em_dia_members','UPDATE');
  assert not has_table_privilege('authenticated','em_dia_private.publisher_links','SELECT');
  assert not has_table_privilege('authenticated','em_dia_private.report_revisions','SELECT');
  assert not has_table_privilege('service_role','public.em_dia_states','SELECT');
  assert not has_table_privilege('service_role','em_dia_private.publisher_links','SELECT');
  assert not pg_has_role('authenticated','em_dia_workflow','MEMBER');
  assert not pg_has_role('authenticated','em_dia_writer','MEMBER');
  assert (select not rolcanlogin and not rolbypassrls and not rolsuper from pg_roles where rolname='em_dia_workflow');
  assert (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in
    ('em_dia_private.publisher_links'::regclass,'em_dia_private.report_revisions'::regclass));
  assert not has_function_privilege('anon','public.read_em_dia_own_card()','EXECUTE');
  assert not has_function_privilege('anon','public.get_em_dia_access_profile()','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.lock_accounts(uuid[])','EXECUTE');
  assert not has_function_privilege('authenticated','em_dia_private.assert_state_links(uuid,jsonb)','EXECUTE');
  assert not has_column_privilege('em_dia_writer','public.em_dia_members','is_admin','UPDATE');
  assert not has_column_privilege('em_dia_writer','public.em_dia_members','access_role','UPDATE');
  assert (select not prosecdef from pg_proc where oid='public.submit_em_dia_own_report(text,jsonb,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_workflow' from pg_proc
    where oid='em_dia_private.submit_own_report(text,jsonb,bigint)'::regprocedure);
  assert (select prosecdef and pg_get_userbyid(proowner)='em_dia_writer' from pg_proc
    where oid='em_dia_private.save_group_state(uuid,jsonb,bigint)'::regprocedure);

  insert into auth.users(id,email,role,aud,created_at,updated_at)
  select u,'fixture-'||u::text||'@example.invalid','authenticated','authenticated',now(),now()
    from unnest(array[v_admin,v_super,v_other_super,v_publisher,v_new_user,v_outsider,v_replacement]) u;
  insert into public.em_dia_members(user_id,is_admin,access_role) values
    (v_admin,true,'admin'),(v_super,false,'superintendent'),(v_other_super,false,'superintendent');
  insert into public.em_dia_groups(id,name,created_by) values
    (v_group,'Fixture A '||v_group,v_admin),(v_other_group,'Fixture B '||v_other_group,v_admin),
    (v_empty_group,'Fixture empty '||v_empty_group,v_admin);
  insert into public.em_dia_group_members(group_id,user_id) values
    (v_group,v_admin),(v_group,v_super),(v_other_group,v_other_super);
  v_person:=jsonb_build_object('id','fixture_main','name','Fixture Publisher A','startMonth',v_previous,
    'endMonth',null,'notes','PRIVATE_PERSON_NOTE','unknown','PRIVATE_UNKNOWN_PERSON',
    'roles',jsonb_build_array(jsonb_build_object('kind','regular','start',v_previous,'end',null,'unknown','PRIVATE_ROLE')));
  v_other_person:=jsonb_build_object('id','fixture_other','name','PRIVATE_OTHER_PERSON','startMonth',v_previous,
    'endMonth',null,'notes','PRIVATE_OTHER_NOTE','roles','[]'::jsonb);
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',1,'updatedAt',now(),'lastBackupAt',null,
    'settings',jsonb_build_object('congregation','Fixture congregation','group','Fixture A','reminder','PRIVATE_REMINDER','unknown','PRIVATE_SETTINGS'),
    'people',jsonb_build_array(v_person,v_other_person),
    'reports',jsonb_build_object(v_previous,jsonb_build_object('fixture_main',jsonb_build_object(
      'received',true,'kind','regular','participated',true,'hours',12.5,'studies',2,'notes','PRIVATE_REPORT_NOTE',
      'receivedDate',v_previous||'-01','updatedAt',now(),'unknown','PRIVATE_REPORT_UNKNOWN'),
      'fixture_other',jsonb_build_object('received',true,'kind','publisher','notes','PRIVATE_OTHER_REPORT'))),
    'reminders',jsonb_build_object(v_month,jsonb_build_object('fixture_main','PRIVATE_PERSON_REMINDER','fixture_other','PRIVATE_OTHER_REMINDER')),
    'activeMonth',v_month,'sourceNote','PRIVATE_SOURCE','unknown','PRIVATE_STATE_UNKNOWN');
  insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at)
    values(v_group,null,v_state,1,now()),
      (v_other_group,null,v_state||jsonb_build_object('people','[]'::jsonb,'reports','{}'::jsonb,'reminders','{}'::jsonb),1,now());

  -- A manager may see destination names, but neither the other group's state nor
  -- global account data. User metadata is deliberately forged and ignored.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated',
    'user_metadata',jsonb_build_object('is_admin',true,'access_role','admin'))::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  assert public.get_em_dia_access_profile()->>'role'='superintendent';
  assert (select count(*)=1 from public.em_dia_states);
  assert (select count(*)=1 from public.em_dia_groups);
  assert jsonb_array_length(public.list_em_dia_transfer_groups())>=3;
  perform pg_temp.expect_error(format('select public.create_em_dia_group(%L)','Unauthorized group'),'42501');
  perform pg_temp.expect_error(format('select public.list_em_dia_publisher_accounts(%L)',v_other_group),'42501');
  perform pg_temp.expect_error(format('select public.list_em_dia_report_revisions(%L)',v_other_group),'42501');
  perform pg_temp.expect_error(format('select public.provision_em_dia_access(%L,%L,%L,null)',v_new_user,'admin',v_group),'42501');
  perform pg_temp.expect_error(format('select public.preflight_em_dia_publisher_account(%L,%L)',v_other_group,'fixture_main'),'42501');
  v_result:=public.preflight_em_dia_publisher_account(v_group,'fixture_main');
  assert v_result->>'name'='Fixture Publisher A';
  perform pg_temp.expect_error(format('select public.provision_em_dia_publisher_account(%L,%L,%L)',v_admin,v_group,'fixture_other'),'42501');
  select * into v_row from public.provision_em_dia_publisher_account(v_publisher,v_group,'fixture_main');
  assert v_row.id=v_group;
  assert jsonb_array_length(public.list_em_dia_publisher_accounts(v_group))=1;
  perform pg_temp.expect_error(format('select public.preflight_em_dia_publisher_account(%L,%L)',v_group,'fixture_main'),'22023');
  -- Provisioning retries do not increase revisions or create a second binding.
  select revision into v_revision from public.em_dia_states where group_id=v_group;
  perform public.provision_em_dia_publisher_account(v_publisher,v_group,'fixture_main');
  assert (select revision=v_revision from public.em_dia_states where group_id=v_group);
  select * into v_saved from public.em_dia_states where group_id=v_group;
  perform pg_temp.expect_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,%s)',v_group,
    (v_saved.state||'{"people":[]}'::jsonb)::text,v_saved.revision),'22023');
  perform pg_temp.expect_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,1)',v_group,v_saved.state::text),'40001');
  reset role;

  -- Publisher metadata is scoped; raw group state and manager RPCs are denied.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated',
    'user_metadata',jsonb_build_object('is_admin',true))::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.get_em_dia_access_profile();
  assert v_result->>'role'='publisher' and v_result->>'publisher_id'='fixture_main';
  assert (select count(*)=0 from public.em_dia_states);
  assert (select count(*)=1 from public.em_dia_groups);
  assert (select count(*)=1 from public.em_dia_group_members);
  v_card:=public.read_em_dia_own_card();
  assert jsonb_array_length(v_card#>'{state,people}')=1;
  assert v_card#>>'{state,people,0,id}'='fixture_main';
  assert v_card::text not like '%PRIVATE_%','Publisher received an internal or unrelated field';
  assert v_card#>>'{state,people,0,notes}'='';
  assert v_card#>'{state,reminders}'='{}'::jsonb;
  assert not ((v_card#>array['state','reports',v_previous]) ? 'fixture_other');
  perform pg_temp.expect_error('select * from em_dia_private.publisher_links','42501');
  perform pg_temp.expect_error('select * from em_dia_private.report_revisions','42501');
  perform pg_temp.expect_error('select public.list_em_dia_transfer_groups()','42501');
  perform pg_temp.expect_error(format('select public.list_em_dia_report_revisions(%L)',v_group),'42501');
  perform pg_temp.expect_error(format('select public.save_em_dia_group_state(%L,%L::jsonb,2)',v_group,v_state::text),'42501');
  perform pg_temp.expect_error(format('select public.provision_em_dia_publisher_account(%L,%L,%L)',v_new_user,v_group,'fixture_other'),'42501');
  perform pg_temp.expect_error(format('select public.create_em_dia_group(%L)','Publisher group'),'42501');
  perform pg_temp.expect_error(format('select public.provision_em_dia_access(%L,%L,%L,null)',v_publisher,'admin',v_group),'42501');
  perform pg_temp.expect_error(format('select public.review_em_dia_report_revision(%L,1,%L)',gen_random_uuid(),'accept'),'42501');
  perform pg_temp.expect_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,2)',v_group,v_other_group,'fixture_main'),'42501');
  -- Historical identical report requires no workflow row or state change.
  v_result:=public.submit_em_dia_own_report(v_previous,v_report,0);
  assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=0 and (v_result->>'unchanged')::boolean;
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_future,v_report::text),'22023');
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)','1900-01',v_report::text),'22023');
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_month,
    (v_report||'{"notes":"untrusted"}'::jsonb)::text),'22023');
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_month,
    (v_report||'{"kind":"auxiliary"}'::jsonb)::text),'22023');
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_month,
    (v_report||'{"studies":1.5}'::jsonb)::text),'22023');
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_month,
    (v_report||'{"hours":744.01}'::jsonb)::text),'22023');
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,0)',v_month,
    (v_report||'{"hours":1.001}'::jsonb)::text),'22023');
  -- Unknown data stays null and may be completed in a reviewed resubmission.
  v_result:=public.submit_em_dia_own_report(v_month,v_unknown,0);
  assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=1;
  v_result:=public.submit_em_dia_own_report(v_month,v_unknown,0);
  assert (v_result->>'unchanged')::boolean and (v_result->>'version')::bigint=1;
  v_card:=public.read_em_dia_own_card();
  assert v_card#>array['state','reports',v_month,'fixture_main','participated']='null'::jsonb;
  assert v_card#>array['state','reports',v_month,'fixture_main','hours']='null'::jsonb;
  assert v_card#>>array['state','reports',v_month,'fixture_main','kind']='regular';
  v_result:=public.submit_em_dia_own_report(v_month,v_report,1);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=2;
  v_result:=public.submit_em_dia_own_report(v_month,v_report,1);
  assert (v_result->>'unchanged')::boolean and (v_result->>'version')::bigint=2;
  perform pg_temp.expect_error(format('select public.submit_em_dia_own_report(%L,%L::jsonb,1)',v_month,v_changed::text),'40001');
  v_card:=public.read_em_dia_own_card();
  assert v_card#>array['state','reports',v_month,'fixture_main','hours']='null'::jsonb;
  assert v_card::text not like '%PRIVATE_%';
  assert not (v_card->'revisions'->0 ? 'base_activity');
  assert not (v_card->'revisions'->0 ? 'user_id');
  reset role;

  -- Accept updates the approved activity and preserves manager-only notes.
  update public.em_dia_states set state=jsonb_set(state,array['reports',v_month,'fixture_main','notes'],'"PRIVATE_NEW_NOTE"'::jsonb)
    where group_id=v_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  v_pending:=public.list_em_dia_report_revisions(v_group);
  assert (v_pending->>'total')::bigint=1;
  assert v_pending::text not like '%PRIVATE_%';
  v_revision_id:=(v_pending#>>'{revisions,0,id}')::uuid;
  perform pg_temp.expect_error(format('select public.review_em_dia_report_revision(%L,1,%L)',v_revision_id,'accept'),'40001');
  v_result:=public.review_em_dia_report_revision(v_revision_id,2,'accept');
  assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=3;
  v_result:=public.review_em_dia_report_revision(v_revision_id,2,'accept');
  assert (v_result->>'unchanged')::boolean and (v_result->>'version')::bigint=3;
  assert (select state#>>array['reports',v_month,'fixture_main','notes']='PRIVATE_NEW_NOTE' from public.em_dia_states where group_id=v_group);
  assert (select state#>array['reports',v_month,'fixture_main','hours']='12.5'::jsonb from public.em_dia_states where group_id=v_group);
  reset role;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.submit_em_dia_own_report(v_month,v_changed,3);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=4;
  reset role;
  -- A manual edit conflicts with acceptance, but ignoring remains safe.
  update public.em_dia_states set state=jsonb_set(state,array['reports',v_month,'fixture_main','hours'],'13'::jsonb),
    revision=revision+1 where group_id=v_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_error(format('select public.review_em_dia_report_revision(%L,4,%L)',v_revision_id,'accept'),'40001');
  v_result:=public.review_em_dia_report_revision(v_revision_id,4,'ignore');
  assert v_result->>'status'='ignored' and (v_result->>'version')::bigint=5;
  v_result:=public.review_em_dia_report_revision(v_revision_id,4,'ignore');
  assert (v_result->>'unchanged')::boolean;
  assert (select state#>array['reports',v_month,'fixture_main','hours']='13'::jsonb from public.em_dia_states where group_id=v_group);
  reset role;
  -- Deleting only a report does not orphan the card. The next request has a
  -- null approved snapshot and must still wait for managerial approval.
  update public.em_dia_states set state=jsonb_set(state,'{reports}',(state->'reports')||
    jsonb_build_object(v_month,(state#>array['reports',v_month])-'fixture_main')),revision=revision+1 where group_id=v_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  v_result:=public.submit_em_dia_own_report(v_month,v_changed,5);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=6;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  v_pending:=public.list_em_dia_report_revisions(v_group);
  assert v_pending#>'{revisions,0,approved_report}'='null'::jsonb;
  select * into v_before from public.em_dia_states where group_id=v_group;
  perform pg_temp.expect_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_group,'fixture_main',v_before.revision),'22023');
  perform pg_temp.expect_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_other_group,'fixture_main',v_before.revision-1),'40001');
  reset role;
  -- Collision is transactional: source, target, links and proposals stay put.
  update public.em_dia_states set state=jsonb_set(state,'{people}',jsonb_build_array(v_person)) where group_id=v_other_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_error(format('select public.transfer_em_dia_publisher(%L,%L,%L,%s)',v_group,v_other_group,'fixture_main',v_before.revision),'22023');
  assert (select revision=v_before.revision from public.em_dia_states where group_id=v_group);
  reset role;
  update public.em_dia_states set state=jsonb_set(state,'{people}','[]'::jsonb) where group_id=v_other_group;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  v_result:=public.transfer_em_dia_publisher(v_group,v_other_group,'fixture_main',v_before.revision);
  assert (v_result->>'from_revision')::bigint=v_before.revision+1;
  assert (select not exists(select 1 from jsonb_array_elements(state->'people') p where p->>'id'='fixture_main') from public.em_dia_states where group_id=v_group);
  assert jsonb_array_length(public.list_em_dia_publisher_accounts(v_group))=0;
  assert (public.list_em_dia_report_revisions(v_group)->>'total')::bigint=0;
  perform pg_temp.expect_error(format('select public.review_em_dia_report_revision(%L,6,%L)',v_revision_id,'accept'),'42501');
  reset role;
  assert (select group_id=v_other_group from em_dia_private.publisher_links where user_id=v_publisher);
  assert (select group_id=v_other_group from public.em_dia_group_members where user_id=v_publisher);
  assert (select group_id=v_other_group and version=6 and status='pending' from em_dia_private.report_revisions where id=v_revision_id);
  assert (select state#>>array['reports',v_previous,'fixture_main','notes']='PRIVATE_REPORT_NOTE' from public.em_dia_states where group_id=v_other_group);
  assert (select state#>>array['reminders',v_month,'fixture_main']='PRIVATE_PERSON_REMINDER' from public.em_dia_states where group_id=v_other_group);

  -- The transferred account immediately uses the destination; former manager
  -- cannot steal it back through a login provisioning endpoint.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_publisher,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_publisher::text,true);
  set local role authenticated;
  assert public.get_em_dia_access_profile()->>'group_id'=v_other_group::text;
  assert (public.read_em_dia_own_card()->>'group_id')=v_other_group::text;
  assert (select count(*)=0 from public.em_dia_states);
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_super::text,true);
  set local role authenticated;
  perform pg_temp.expect_error(format('select public.provision_em_dia_publisher_account(%L,%L,%L)',v_publisher,v_group,'fixture_other'),'42501');
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other_super,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_other_super::text,true);
  set local role authenticated;
  assert (public.list_em_dia_report_revisions(v_other_group)->>'total')::bigint=1;
  v_result:=public.review_em_dia_report_revision(v_revision_id,6,'accept');
  assert v_result->>'status'='accepted' and (v_result->>'version')::bigint=7;
  assert (select state#>array['reports',v_month,'fixture_main','hours']='15'::jsonb from public.em_dia_states where group_id=v_other_group);
  -- Transfer to a group without state creates one with no Auth owner cascade.
  select revision into v_revision from public.em_dia_states where group_id=v_other_group;
  perform public.transfer_em_dia_publisher(v_other_group,v_empty_group,'fixture_main',v_revision);
  reset role;
  assert (select owner_id is null and revision=1 from public.em_dia_states where group_id=v_empty_group);
  assert (select group_id=v_empty_group from em_dia_private.publisher_links where user_id=v_publisher);

  -- Admin explicitly promotes a publisher without deleting card/history.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  set local role authenticated;
  assert (select count(*)>=3 from public.em_dia_states);
  perform pg_temp.expect_error(format('select public.provision_em_dia_access(%L,null,%L,null)',v_publisher,v_group),'22023');
  perform public.provision_em_dia_access(v_publisher,'superintendent',v_empty_group,null);
  select * into v_row from public.provision_em_dia_access(v_new_user,'superintendent',v_group,null);
  assert v_row.id=v_group;
  reset role;
  assert exists(select 1 from em_dia_private.publisher_links where user_id=v_publisher and group_id=v_empty_group and person_id='fixture_main');
  assert (select access_role='superintendent' and not is_admin from public.em_dia_members where user_id=v_publisher);
  assert (select exists(select 1 from jsonb_array_elements(state->'people') p where p->>'id'='fixture_main') from public.em_dia_states where group_id=v_empty_group);
  set local role authenticated;
  -- Changing the management role now retains the personal card. Replacing its login requires explicit unlink.
  perform public.bind_em_dia_personal_card(v_publisher,null,null,v_empty_group,'fixture_main',v_admin);
  perform public.provision_em_dia_publisher_account(v_replacement,v_empty_group,'fixture_main');
  reset role;
  assert (select user_id=v_replacement and version=7 from em_dia_private.report_revisions where id=v_revision_id);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_replacement,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_replacement::text,true);
  set local role authenticated;
  v_card:=public.read_em_dia_own_card();
  assert v_card#>>'{revisions,0,version}'='7';
  v_result:=public.submit_em_dia_own_report(v_month,v_report,7);
  assert v_result->>'status'='pending' and (v_result->>'version')::bigint=8;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  -- Only fixture identities are changed. The last-admin rejection must be
  -- exercised in an isolated empty database; here we verify a fixture admin
  -- can be demoted while another administrator remains, without changing it.
  if exists(select 1 from public.em_dia_members where is_admin and user_id<>v_admin) then
    set local role authenticated;
    perform public.provision_em_dia_access(v_admin,'superintendent',v_group,null);
    reset role;
    assert (select not is_admin and access_role='superintendent' from public.em_dia_members where user_id=v_admin);
    assert exists(select 1 from public.em_dia_members where is_admin);
  end if;

  -- An Auth account with no allowlist row gets neither role nor destination list.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated',
    'user_metadata',jsonb_build_object('is_admin',true,'role','admin'))::text,true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  set local role authenticated;
  assert (select count(*)=0 from public.em_dia_states);
  assert (select count(*)=0 from public.em_dia_groups);
  perform pg_temp.expect_error('select public.get_em_dia_access_profile()','42501');
  perform pg_temp.expect_error('select public.read_em_dia_own_card()','42501');
  perform pg_temp.expect_error('select public.list_em_dia_transfer_groups()','42501');
  reset role;
end;
$$;

rollback;
select 'RBAC, publisher privacy, report review and transfer fixtures passed; all changes rolled back.' as result;
