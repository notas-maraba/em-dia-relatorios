-- Three access profiles, private publisher cards and versioned report review.
-- Existing JSON states remain in place. This migration contains no identities.

lock table public.em_dia_states,public.em_dia_groups,public.em_dia_group_members in share mode;
create temporary table em_dia_roles_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_roles_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm;

create role em_dia_workflow nologin nosuperuser nocreatedb nocreaterole
  noinherit noreplication nobypassrls;
grant em_dia_workflow to postgres;
grant usage on schema public,em_dia_private to em_dia_workflow;

alter table public.em_dia_members add column access_role text not null default 'superintendent';
update public.em_dia_members set access_role='admin' where is_admin;
alter table public.em_dia_members add constraint em_dia_members_access_role_check
  check(access_role in ('admin','superintendent','publisher') and is_admin=(access_role='admin'));

-- Trusted older administration scripts can still change is_admin. Browser roles
-- have no direct INSERT/UPDATE grant, and the two authorization fields stay equal.
create function em_dia_private.sync_access_role() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.is_admin then new.access_role:='admin';
    elsif new.access_role='admin' then new.is_admin:=true; end if;
  elsif new.access_role is distinct from old.access_role then
    new.is_admin:=(new.access_role='admin');
  elsif new.is_admin is distinct from old.is_admin then
    new.access_role:=case when new.is_admin then 'admin' else 'superintendent' end;
  end if;
  return new;
end;
$$;
revoke execute on function em_dia_private.sync_access_role() from public,anon,authenticated,service_role;
create trigger em_dia_members_sync_access_role before insert or update on public.em_dia_members
for each row execute function em_dia_private.sync_access_role();

create table em_dia_private.publisher_links (
  user_id uuid primary key references public.em_dia_members(user_id) on delete cascade,
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  person_id text not null check(person_id ~ '^[a-zA-Z0-9_-]{1,100}$' and person_id not in ('__proto__','constructor','prototype')),
  created_at timestamptz not null default now(),
  unique(group_id,person_id)
);
create table em_dia_private.report_revisions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  person_id text not null,
  user_id uuid not null references public.em_dia_members(user_id) on delete cascade,
  month text not null check(month ~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'),
  status text not null check(status in ('accepted','pending','ignored')),
  version bigint not null check(version between 1 and 9007199254740991),
  base_activity jsonb,
  proposed_report jsonb not null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.em_dia_members(user_id) on delete set null,
  reviewed_version bigint,
  unique(group_id,person_id,month)
);
create index em_dia_revisions_group_status on em_dia_private.report_revisions(group_id,status,submitted_at);
create index em_dia_revisions_user_month on em_dia_private.report_revisions(user_id,month);
create index em_dia_revisions_reviewer on em_dia_private.report_revisions(reviewed_by) where reviewed_by is not null;
alter table em_dia_private.publisher_links enable row level security;
alter table em_dia_private.publisher_links force row level security;
alter table em_dia_private.report_revisions enable row level security;
alter table em_dia_private.report_revisions force row level security;
revoke all on em_dia_private.publisher_links,em_dia_private.report_revisions
  from public,anon,authenticated,service_role,em_dia_writer,em_dia_workflow;
grant select,insert,update,delete on em_dia_private.publisher_links to em_dia_workflow;
grant select,insert,update on em_dia_private.report_revisions to em_dia_workflow;
grant select on public.em_dia_members,public.em_dia_group_members,public.em_dia_groups,public.em_dia_states to em_dia_workflow;
grant insert(user_id,is_admin,access_role),update(is_admin,access_role) on public.em_dia_members to em_dia_workflow;
grant insert,update on public.em_dia_group_members to em_dia_workflow;
grant insert on public.em_dia_groups to em_dia_workflow;
-- SELECT FOR UPDATE also needs UPDATE privilege; no routine changes group IDs.
grant update(id) on public.em_dia_groups to em_dia_workflow;
grant insert,update on public.em_dia_states to em_dia_workflow;

-- This role cannot be assumed by an API caller. Its narrowly owned private
-- procedures perform identity, role and scope checks before touching these rows.
create policy em_dia_members_workflow on public.em_dia_members for all to em_dia_workflow using(true) with check(true);
create policy em_dia_group_members_workflow on public.em_dia_group_members for all to em_dia_workflow using(true) with check(true);
create policy em_dia_groups_workflow on public.em_dia_groups for all to em_dia_workflow using(true) with check(true);
create policy em_dia_states_workflow on public.em_dia_states for all to em_dia_workflow using(true) with check(true);
create policy em_dia_publisher_links_workflow on em_dia_private.publisher_links for all to em_dia_workflow using(true) with check(true);
create policy em_dia_revisions_workflow on em_dia_private.report_revisions for all to em_dia_workflow using(true) with check(true);

create function em_dia_private.access_role() returns text
language sql stable security invoker set search_path='' as $$
  select m.access_role from public.em_dia_members m
  where m.user_id=(select em_dia_private.current_user_id());
$$;
create or replace function em_dia_private.can_access_group(p_group_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select (select em_dia_private.is_admin()) or
    ((select em_dia_private.access_role())='superintendent' and exists(
      select 1 from public.em_dia_group_members gm
      where gm.group_id=p_group_id and gm.user_id=(select em_dia_private.current_user_id())));
$$;
create function em_dia_private.can_view_group(p_group_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select (select em_dia_private.is_admin()) or exists(
    select 1 from public.em_dia_group_members gm
    where gm.group_id=p_group_id and gm.user_id=(select em_dia_private.current_user_id()));
$$;
revoke execute on function em_dia_private.access_role(),em_dia_private.can_view_group(uuid)
  from public,anon,authenticated,service_role;
grant execute on function em_dia_private.access_role(),em_dia_private.can_view_group(uuid) to authenticated,em_dia_writer,em_dia_workflow;
grant execute on function em_dia_private.current_user_id(),em_dia_private.is_authorized(),em_dia_private.is_admin(),em_dia_private.can_access_group(uuid) to em_dia_workflow;
drop policy em_dia_groups_read on public.em_dia_groups;
create policy em_dia_groups_read on public.em_dia_groups for select to authenticated,em_dia_writer
  using(em_dia_private.can_view_group(id));

create function em_dia_private.lock_accounts(p_users uuid[]) returns void
language plpgsql security invoker set search_path='' as $$
declare v_user uuid;
begin
  for v_user in select distinct u from unnest(p_users) u where u is not null order by u loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,0));
  end loop;
end;
$$;
create function em_dia_private.activity(p_report jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select case when p_report is null or jsonb_typeof(p_report)<>'object' then null else
    jsonb_build_object('received',coalesce(p_report->'received'='true'::jsonb,false),
      'kind',p_report->'kind','participated',p_report->'participated',
      'hours',p_report->'hours','studies',p_report->'studies') end;
$$;
create function em_dia_private.report_values(p_kind text,p_values jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare v_hours numeric; v_studies numeric;
begin
  if p_kind is null or p_kind not in ('publisher','regular','auxiliary') or p_values is null or jsonb_typeof(p_values)<>'object'
    or exists(select 1 from jsonb_object_keys(p_values) k where k not in ('participated','hours','studies'))
    or not (p_values ?& array['participated','hours','studies'])
    or jsonb_typeof(p_values->'participated') not in ('boolean','null')
    or jsonb_typeof(p_values->'hours') not in ('number','null')
    or jsonb_typeof(p_values->'studies') not in ('number','null') then
    raise exception using errcode='22023',message='Invalid report values.';
  end if;
  if p_values->'hours'<>'null'::jsonb then v_hours:=(p_values->>'hours')::numeric; end if;
  if p_values->'studies'<>'null'::jsonb then v_studies:=(p_values->>'studies')::numeric; end if;
  if (v_studies is not null and (v_studies<0 or v_studies>9999 or trunc(v_studies)<>v_studies))
    or (p_kind='publisher' and v_hours is not null)
    or (v_hours is not null and (v_hours<0 or v_hours>744 or round(v_hours,2)<>v_hours)) then
    raise exception using errcode='22023',message='Complete the report with valid values.';
  end if;
  return jsonb_build_object('received',true,'kind',p_kind,'participated',p_values->'participated','hours',v_hours,'studies',v_studies);
end;
$$;
create function em_dia_private.clean_person(p_person jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',p_person->'id','name',p_person->'name','startMonth',p_person->'startMonth',
    'endMonth',p_person->'endMonth','notes','', 'roles',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',r->'kind','start',r->'start','end',r->'end')) from jsonb_array_elements(p_person->'roles') r),'[]'::jsonb));
$$;
create function em_dia_private.clean_report(p_report jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('received',p_report->'received','kind',p_report->'kind',
    'participated',p_report->'participated','hours',p_report->'hours','studies',p_report->'studies',
    'notes','','receivedDate',p_report->'receivedDate','updatedAt',p_report->'updatedAt');
$$;
create function em_dia_private.assert_state_links(p_group_id uuid,p_state jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group not authorized.';
  end if;
  if exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_group_id and
    not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=l.person_id))
    or exists(select 1 from em_dia_private.report_revisions r where r.group_id=p_group_id and r.status='pending' and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=r.person_id)) then
    raise exception using errcode='22023',message='A linked publisher or pending review cannot be removed. Transfer the card or resolve its access first.';
  end if;
end;
$$;

create function em_dia_private.get_access_profile() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id(); v_role text; v_group uuid; v_person text;
begin
  select m.access_role into v_role from public.em_dia_members m where m.user_id=v_user;
  if v_user is null or v_role is null then raise exception using errcode='42501',message='Account not authorized.'; end if;
  select gm.group_id into v_group from public.em_dia_group_members gm where gm.user_id=v_user;
  if v_role='publisher' then
    select l.person_id into v_person from em_dia_private.publisher_links l where l.user_id=v_user and l.group_id=v_group;
    if v_person is null then raise exception using errcode='42501',message='Publisher access is not linked.'; end if;
  end if;
  return jsonb_build_object('user_id',v_user,'role',v_role,'is_admin',v_role='admin','group_id',v_group,'publisher_id',v_person);
end;
$$;

create function em_dia_private.read_own_card() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_link em_dia_private.publisher_links;
  v_row public.em_dia_states; v_person jsonb; v_reports jsonb; v_revisions jsonb; v_group text; v_state jsonb;
begin
  if v_user is null or em_dia_private.access_role() is distinct from 'publisher' then
    raise exception using errcode='42501',message='Publisher access required.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select * into v_row from public.em_dia_states s where s.group_id=v_link.group_id;
  select p into v_person from jsonb_array_elements(v_row.state->'people') p where p->>'id'=v_link.person_id;
  if v_person is null then raise exception using errcode='42501',message='Publisher card not available.'; end if;
  select g.name into v_group from public.em_dia_groups g where g.id=v_link.group_id;
  select coalesce(jsonb_object_agg(e.key,jsonb_build_object(v_link.person_id,
    em_dia_private.clean_report(e.value->v_link.person_id))),'{}'::jsonb) into v_reports
  from jsonb_each(v_row.state->'reports') e where e.value ? v_link.person_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'month',r.month,'status',r.status,'version',r.version,
    'proposed_report',r.proposed_report,'submitted_at',r.submitted_at,'reviewed_at',r.reviewed_at) order by r.month desc),'[]'::jsonb)
    into v_revisions from em_dia_private.report_revisions r where r.user_id=v_user and r.group_id=v_link.group_id and r.person_id=v_link.person_id;
  -- Explicit construction prevents unknown legacy JSON properties leaking data.
  v_state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',v_row.revision,
    'updatedAt',v_row.updated_at,'lastBackupAt',null,
    'settings',jsonb_build_object('congregation',coalesce(v_row.state#>>'{settings,congregation}',''),'group',v_group,'reminder',''),
    'people',jsonb_build_array(em_dia_private.clean_person(v_person)),'reports',v_reports,'reminders','{}'::jsonb,
    'activeMonth',v_row.state->'activeMonth','sourceNote','');
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id,'group_name',v_group,
    'state',v_state,'revision',v_row.revision,'updated_at',v_row.updated_at,'revisions',v_revisions);
end;
$$;

create function em_dia_private.submit_own_report(p_month text,p_report jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_link em_dia_private.publisher_links;
  v_state public.em_dia_states; v_person jsonb; v_existing jsonb; v_kind text; v_proposed jsonb;
  v_work em_dia_private.report_revisions; v_found boolean; v_current_version bigint; v_status text;
  v_now timestamptz:=statement_timestamp(); v_date text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  v_values jsonb; v_next jsonb; v_first boolean;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or p_month>left(v_date,7) or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid report month or version.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select * into v_state from public.em_dia_states s where s.group_id=v_link.group_id for update;
  select p into v_person from jsonb_array_elements(v_state.state->'people') p where p->>'id'=v_link.person_id;
  if v_person is null then raise exception using errcode='42501',message='Publisher card not available.'; end if;
  v_existing:=v_state.state#>array['reports',p_month,v_link.person_id];
  if v_existing is null and (p_month<(v_person->>'startMonth') or (v_person->>'endMonth' is not null and p_month>(v_person->>'endMonth'))) then
    raise exception using errcode='22023',message='The publisher is not tracked in that month.';
  end if;
  if v_existing->'received'='true'::jsonb then v_kind:=v_existing->>'kind';
  else
    select r->>'kind' into v_kind from jsonb_array_elements(v_person->'roles') r
    where r->>'start'<=p_month and (r->>'end' is null or r->>'end'>=p_month) order by r->>'start' desc limit 1;
    v_kind:=coalesce(v_kind,'publisher');
  end if;
  v_proposed:=em_dia_private.report_values(v_kind,p_report);
  select * into v_work from em_dia_private.report_revisions r
    where r.group_id=v_link.group_id and r.person_id=v_link.person_id and r.month=p_month for update;
  v_found:=found; v_current_version:=case when v_found then v_work.version else 0 end;
  -- A response lost by the network is safe to retry, even with its old version.
  if v_found and v_work.status in ('accepted','pending') and v_work.proposed_report=v_proposed
    and ((v_work.status='accepted' and em_dia_private.activity(v_existing)=v_proposed)
      or (v_work.status='pending' and v_work.base_activity is not distinct from em_dia_private.activity(v_existing))) then
    return jsonb_build_object('status',v_work.status,'version',v_work.version,'group_id',v_link.group_id,'person_id',v_link.person_id,
      'month',p_month,'revision',v_state.revision,'unchanged',true);
  end if;
  if not v_found and em_dia_private.activity(v_existing)=v_proposed then
    return jsonb_build_object('status','accepted','version',0,'group_id',v_link.group_id,'person_id',v_link.person_id,
      'month',p_month,'revision',v_state.revision,'unchanged',true);
  end if;
  if p_expected_version<>v_current_version then raise exception using errcode='40001',message='Report submission changed. Reload before sending again.'; end if;
  v_first:=not v_found and coalesce(v_existing->'received','false'::jsonb)<>'true'::jsonb;
  v_status:=case when v_first then 'accepted' else 'pending' end;
  if v_first then
    v_values:=v_proposed||jsonb_build_object('notes',coalesce(v_existing->>'notes',''),'receivedDate',v_date,'updatedAt',v_now);
    v_next:=jsonb_set(v_state.state,'{reports}',coalesce(v_state.state->'reports','{}'::jsonb)||
      jsonb_build_object(p_month,coalesce(v_state.state#>array['reports',p_month],'{}'::jsonb)||jsonb_build_object(v_link.person_id,v_values)),true);
    v_next:=v_next||jsonb_build_object('revision',v_state.revision+1,'updatedAt',v_now);
    update public.em_dia_states s set state=v_next,revision=s.revision+1,updated_at=v_now where s.group_id=v_link.group_id returning s.* into v_state;
  end if;
  if v_found then
    update em_dia_private.report_revisions r set status=v_status,version=r.version+1,
      base_activity=em_dia_private.activity(v_existing),proposed_report=v_proposed,submitted_at=v_now,
      reviewed_at=null,reviewed_by=null,reviewed_version=null where r.id=v_work.id returning r.* into v_work;
  else
    insert into em_dia_private.report_revisions(group_id,person_id,user_id,month,status,version,base_activity,proposed_report,submitted_at)
    values(v_link.group_id,v_link.person_id,v_user,p_month,v_status,1,em_dia_private.activity(v_existing),v_proposed,v_now)
    returning * into v_work;
  end if;
  return jsonb_build_object('status',v_work.status,'version',v_work.version,'group_id',v_link.group_id,'person_id',v_link.person_id,
    'month',p_month,'revision',v_state.revision,'unchanged',false);
end;
$$;

create function em_dia_private.list_report_revisions(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb; v_total bigint;
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group management required.';
  end if;
  select count(*) into v_total from em_dia_private.report_revisions r where r.group_id=p_group_id and r.status='pending';
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.version,'person_id',r.person_id,
    'person_name',(select p->>'name' from jsonb_array_elements(s.state->'people') p where p->>'id'=r.person_id),
    'month',r.month,'approved_report',em_dia_private.activity(s.state#>array['reports',r.month,r.person_id]),
    'proposed_report',r.proposed_report,'submitted_at',r.submitted_at) order by r.submitted_at),'[]'::jsonb) into v_rows
  from (select * from em_dia_private.report_revisions q where q.group_id=p_group_id and q.status='pending' order by q.submitted_at,q.id limit 500) r
  join public.em_dia_states s on s.group_id=r.group_id;
  return jsonb_build_object('revisions',v_rows,'total',v_total);
end;
$$;

create function em_dia_private.review_report_revision(p_revision_id uuid,p_expected_version bigint,p_decision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_group uuid; v_row em_dia_private.report_revisions;
  v_state public.em_dia_states; v_current jsonb; v_values jsonb; v_next jsonb; v_status text; v_now timestamptz:=statement_timestamp();
begin
  if v_user is null then raise exception using errcode='42501',message='Group management required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if p_decision not in ('accept','ignore') or p_decision is null or p_expected_version is null or p_expected_version<1 then
    raise exception using errcode='22023',message='Invalid review decision.';
  end if;
  select r.group_id into v_group from em_dia_private.report_revisions r where r.id=p_revision_id;
  if not found or not em_dia_private.can_access_group(v_group) then raise exception using errcode='42501',message='Group management required.'; end if;
  select * into v_state from public.em_dia_states s where s.group_id=v_group for update;
  select * into v_row from em_dia_private.report_revisions r where r.id=p_revision_id for update;
  if v_row.group_id<>v_group then raise exception using errcode='40001',message='The card moved. Reload before reviewing.'; end if;
  v_status:=case when p_decision='accept' then 'accepted' else 'ignored' end;
  if v_row.status=v_status and v_row.reviewed_version=p_expected_version then
    return jsonb_build_object('status',v_row.status,'version',v_row.version,'group_id',v_group,'revision',v_state.revision,'unchanged',true);
  end if;
  if v_row.status<>'pending' or v_row.version<>p_expected_version then raise exception using errcode='40001',message='The pending submission changed. Reload before reviewing.'; end if;
  if not exists(select 1 from jsonb_array_elements(v_state.state->'people') p where p->>'id'=v_row.person_id) then
    raise exception using errcode='40001',message='Publisher card changed. Reload before reviewing.';
  end if;
  v_current:=v_state.state#>array['reports',v_row.month,v_row.person_id];
  if p_decision='accept' then
    if em_dia_private.activity(v_current) is distinct from v_row.base_activity then
      raise exception using errcode='40001',message='The approved report changed. Ignore this request or ask for a new submission.';
    end if;
    v_values:=v_row.proposed_report||jsonb_build_object('notes',coalesce(v_current->>'notes',''),
      'receivedDate',coalesce(v_current->>'receivedDate',to_char(v_now at time zone 'America/Sao_Paulo','YYYY-MM-DD')),'updatedAt',v_now);
    v_next:=jsonb_set(v_state.state,'{reports}',coalesce(v_state.state->'reports','{}'::jsonb)||
      jsonb_build_object(v_row.month,coalesce(v_state.state#>array['reports',v_row.month],'{}'::jsonb)||jsonb_build_object(v_row.person_id,v_values)),true);
    v_next:=v_next||jsonb_build_object('revision',v_state.revision+1,'updatedAt',v_now);
    update public.em_dia_states s set state=v_next,revision=s.revision+1,updated_at=v_now where s.group_id=v_group returning s.* into v_state;
  end if;
  update em_dia_private.report_revisions r set status=v_status,version=r.version+1,reviewed_at=v_now,reviewed_by=v_user,
    reviewed_version=p_expected_version where r.id=v_row.id returning r.* into v_row;
  return jsonb_build_object('status',v_row.status,'version',v_row.version,'group_id',v_group,'revision',v_state.revision,'unchanged',false);
end;
$$;

create function em_dia_private.list_publisher_accounts(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group management required.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('person_id',l.person_id,'user_id',l.user_id) order by l.person_id),'[]'::jsonb)
    into v_result from em_dia_private.publisher_links l where l.group_id=p_group_id;
  return v_result;
end;
$$;
create function em_dia_private.preflight_publisher_account(p_group_id uuid,p_person_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_name text;
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group management required.';
  end if;
  if p_person_id is null or p_person_id !~ '^[a-zA-Z0-9_-]{1,100}$' or p_person_id in ('__proto__','constructor','prototype') then
    raise exception using errcode='22023',message='Invalid publisher card.';
  end if;
  select p->>'name' into v_name from public.em_dia_states s cross join lateral jsonb_array_elements(s.state->'people') p
    where s.group_id=p_group_id and p->>'id'=p_person_id;
  if v_name is null then raise exception using errcode='22023',message='Publisher card not available.'; end if;
  if exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_group_id and l.person_id=p_person_id) then
    raise exception using errcode='22023',message='Publisher card already has an account.';
  end if;
  return jsonb_build_object('person_id',p_person_id,'name',v_name,'group_id',p_group_id);
end;
$$;
create function em_dia_private.provision_publisher_account(p_user_id uuid,p_group_id uuid,p_person_id text)
returns public.em_dia_groups language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_role text; v_link em_dia_private.publisher_links;
  v_state public.em_dia_states; v_group public.em_dia_groups; v_existing_group uuid;
begin
  if v_user is null or p_user_id is null then raise exception using errcode='42501',message='Group management required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user,p_user_id]);
  if not em_dia_private.can_access_group(p_group_id) then raise exception using errcode='42501',message='Group management required.'; end if;
  if p_person_id is null or p_person_id !~ '^[a-zA-Z0-9_-]{1,100}$' or p_person_id in ('__proto__','constructor','prototype') then
    raise exception using errcode='22023',message='Invalid publisher card.';
  end if;
  select * into v_state from public.em_dia_states s where s.group_id=p_group_id for update;
  if not found or not exists(select 1 from jsonb_array_elements(v_state.state->'people') p where p->>'id'=p_person_id) then
    raise exception using errcode='22023',message='Publisher card not available.';
  end if;
  select m.access_role into v_role from public.em_dia_members m where m.user_id=p_user_id;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=p_user_id;
  if v_role is not null and v_role<>'publisher' then raise exception using errcode='42501',message='An existing manager account cannot be converted here.'; end if;
  if v_link.user_id is not null then
    if v_link.group_id=p_group_id and v_link.person_id=p_person_id then
      select * into strict v_group from public.em_dia_groups g where g.id=p_group_id;
      return v_group;
    end if;
    raise exception using errcode='42501',message='This publisher account is linked to another card.';
  end if;
  select gm.group_id into v_existing_group from public.em_dia_group_members gm where gm.user_id=p_user_id;
  if v_existing_group is not null and v_existing_group<>p_group_id then
    raise exception using errcode='42501',message='This account is assigned to another group.';
  end if;
  if exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_group_id and l.person_id=p_person_id) then
    raise exception using errcode='22023',message='Publisher card already has an account.';
  end if;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(p_user_id,false,'publisher') on conflict(user_id) do nothing;
  insert into public.em_dia_group_members(group_id,user_id) values(p_group_id,p_user_id)
    on conflict(user_id) do update set group_id=excluded.group_id;
  insert into em_dia_private.publisher_links(user_id,group_id,person_id) values(p_user_id,p_group_id,p_person_id);
  -- A manager may replace a card's login after promoting its former account.
  -- Versions and pending activity belong to the card; its current login must
  -- receive that workflow too, rather than an invisible compare-and-swap value.
  update em_dia_private.report_revisions r set user_id=p_user_id
    where r.group_id=p_group_id and r.person_id=p_person_id and r.user_id<>p_user_id;
  -- Invalidate an earlier manager snapshot taken before this new link existed.
  update public.em_dia_states s set revision=s.revision+1,updated_at=statement_timestamp(),
    state=s.state||jsonb_build_object('revision',s.revision+1,'updatedAt',statement_timestamp()) where s.group_id=p_group_id;
  select * into strict v_group from public.em_dia_groups g where g.id=p_group_id;
  return v_group;
end;
$$;

create function em_dia_private.provision_access(p_user_id uuid,p_role text default null,p_group_id uuid default null,p_new_group_name text default null)
returns public.em_dia_groups language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_old_role text; v_role text;
  v_group public.em_dia_groups; v_link em_dia_private.publisher_links; v_name text:=nullif(btrim(p_new_group_name),'');
begin
  if v_user is null or p_user_id is null then raise exception using errcode='42501',message='Administrator access required.'; end if;
  -- Serializes simultaneous attempts to remove the last administrator.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('em-dia-access-role-administration',0));
  perform em_dia_private.lock_accounts(array[v_user,p_user_id]);
  if not em_dia_private.is_admin() then raise exception using errcode='42501',message='Administrator access required.'; end if;
  if ((p_group_id is null)=(v_name is null)) or (p_role is not null and p_role not in ('admin','superintendent')) then
    raise exception using errcode='22023',message='Choose a manager profile and a group.';
  end if;
  select m.access_role into v_old_role from public.em_dia_members m where m.user_id=p_user_id;
  v_role:=coalesce(p_role,v_old_role,'superintendent');
  if v_role='publisher' then
    select * into v_link from em_dia_private.publisher_links l where l.user_id=p_user_id;
    if v_link.group_id=p_group_id and v_name is null then
      select * into strict v_group from public.em_dia_groups g where g.id=p_group_id;
      return v_group;
    end if;
    raise exception using errcode='22023',message='Transfer the publisher card to change its group.';
  end if;
  if v_old_role='admin' and v_role<>'admin' and not exists(
    select 1 from public.em_dia_members m where m.is_admin and m.user_id<>p_user_id) then
    raise exception using errcode='22023',message='The last administrator cannot be removed.';
  end if;
  if p_group_id is not null then
    select * into v_group from public.em_dia_groups g where g.id=p_group_id;
    if not found then raise exception using errcode='22023',message='Group not available.'; end if;
  else
    if char_length(v_name)>80 or v_name~'[[:cntrl:]]' then raise exception using errcode='22023',message='Invalid group name.'; end if;
    insert into public.em_dia_groups(name,created_by) values(v_name,v_user) returning * into v_group;
  end if;
  insert into public.em_dia_members(user_id,is_admin,access_role) values(p_user_id,v_role='admin',v_role)
    on conflict(user_id) do update set is_admin=excluded.is_admin,access_role=excluded.access_role;
  delete from em_dia_private.publisher_links l where l.user_id=p_user_id;
  insert into public.em_dia_group_members(group_id,user_id) values(v_group.id,p_user_id)
    on conflict(user_id) do update set group_id=excluded.group_id;
  return v_group;
end;
$$;

create function em_dia_private.list_transfer_groups() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if em_dia_private.current_user_id() is null or coalesce(em_dia_private.access_role(),'') not in ('admin','superintendent') then
    raise exception using errcode='42501',message='Group management required.';
  end if;
  if not em_dia_private.is_admin() and not exists(select 1 from public.em_dia_group_members gm where gm.user_id=em_dia_private.current_user_id()) then
    raise exception using errcode='42501',message='A group assignment is required.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) order by g.name),'[]'::jsonb) into v_result from public.em_dia_groups g;
  return v_result;
end;
$$;

create function em_dia_private.transfer_publisher(p_from_group_id uuid,p_to_group_id uuid,p_person_id text,p_expected_from_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id(); v_linked_user uuid; v_after_link uuid; v_group uuid;
  v_source public.em_dia_states; v_dest public.em_dia_states; v_dest_new boolean:=false; v_person jsonb; v_name text;
  v_source_json jsonb; v_dest_json jsonb; v_reports jsonb; v_reminders jsonb; v_moved jsonb; v_now timestamptz:=statement_timestamp();
begin
  if v_user is null then raise exception using errcode='42501',message='Group management required.'; end if;
  if p_from_group_id is null or p_to_group_id is null or p_from_group_id=p_to_group_id or p_person_id is null
    or p_expected_from_revision is null or p_expected_from_revision<1 then
    raise exception using errcode='22023',message='Choose a different destination group.';
  end if;
  select l.user_id into v_linked_user from em_dia_private.publisher_links l where l.group_id=p_from_group_id and l.person_id=p_person_id;
  perform em_dia_private.lock_accounts(array[v_user,v_linked_user]);
  if not em_dia_private.can_access_group(p_from_group_id) then raise exception using errcode='42501',message='Source group management required.'; end if;
  select g.name into v_name from public.em_dia_groups g where g.id=p_to_group_id;
  if not found then raise exception using errcode='22023',message='Destination group not available.'; end if;
  -- Non-key group locks serialize empty targets but allow concurrent FK KEY
  -- SHARE checks from another card's first submission or account creation.
  for v_group in select id from public.em_dia_groups where id in (p_from_group_id,p_to_group_id) order by id for no key update loop
    perform 1 from public.em_dia_states s where s.group_id=v_group for update;
  end loop;
  select * into v_source from public.em_dia_states s where s.group_id=p_from_group_id;
  if not found or v_source.revision<>p_expected_from_revision then raise exception using errcode='40001',message='Source group changed. Reload before transferring.'; end if;
  select l.user_id into v_after_link from em_dia_private.publisher_links l where l.group_id=p_from_group_id and l.person_id=p_person_id;
  if v_after_link is distinct from v_linked_user then raise exception using errcode='40001',message='Publisher access changed. Reload before transferring.'; end if;
  select p into v_person from jsonb_array_elements(v_source.state->'people') p where p->>'id'=p_person_id;
  if v_person is null then raise exception using errcode='22023',message='Publisher card not available.'; end if;
  select * into v_dest from public.em_dia_states s where s.group_id=p_to_group_id;
  if not found then
    v_dest_new:=true;v_dest.group_id:=p_to_group_id;v_dest.revision:=0;
    v_dest.state:=jsonb_build_object('app','em-dia-relatorios','version',1,'revision',0,'updatedAt',v_now,'lastBackupAt',null,
        'settings',jsonb_build_object('congregation','','group',v_name,'reminder',''),'people','[]'::jsonb,
        'reports','{}'::jsonb,'reminders','{}'::jsonb,'activeMonth',v_source.state->'activeMonth','sourceNote','');
  end if;
  if exists(select 1 from jsonb_array_elements(v_dest.state->'people') p where p->>'id'=p_person_id)
    or exists(select 1 from em_dia_private.report_revisions r where r.group_id=p_to_group_id and r.person_id=p_person_id)
    or exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_to_group_id and l.person_id=p_person_id)
    or exists(select 1 from jsonb_each(v_dest.state->'reports') e where e.value ? p_person_id)
    or exists(select 1 from jsonb_each(v_dest.state->'reminders') e where e.value ? p_person_id) then
    raise exception using errcode='22023',message='The destination already contains this publisher identifier. No cards were merged.';
  end if;
  v_source_json:=v_source.state; v_dest_json:=v_dest.state;
  v_source_json:=jsonb_set(v_source_json,'{people}',coalesce((select jsonb_agg(p) from jsonb_array_elements(v_source_json->'people') p where p->>'id'<>p_person_id),'[]'::jsonb));
  v_dest_json:=jsonb_set(v_dest_json,'{people}',(v_dest_json->'people')||jsonb_build_array(v_person));
  select coalesce(jsonb_object_agg(e.key,e.value-p_person_id),'{}'::jsonb) into v_reports from jsonb_each(v_source_json->'reports') e;
  select coalesce(jsonb_object_agg(e.key,e.value->p_person_id),'{}'::jsonb) into v_moved from jsonb_each(v_source_json->'reports') e where e.value ? p_person_id;
  v_source_json:=jsonb_set(v_source_json,'{reports}',v_reports);
  for v_name in select key from jsonb_each(v_moved) loop
    v_dest_json:=jsonb_set(v_dest_json,'{reports}',(v_dest_json->'reports')||jsonb_build_object(v_name,
      coalesce(v_dest_json#>array['reports',v_name],'{}'::jsonb)||jsonb_build_object(p_person_id,v_moved->v_name)));
  end loop;
  select coalesce(jsonb_object_agg(e.key,e.value-p_person_id),'{}'::jsonb) into v_reminders from jsonb_each(v_source_json->'reminders') e;
  select coalesce(jsonb_object_agg(e.key,e.value->p_person_id),'{}'::jsonb) into v_moved from jsonb_each(v_source_json->'reminders') e where e.value ? p_person_id;
  v_source_json:=jsonb_set(v_source_json,'{reminders}',v_reminders);
  for v_name in select key from jsonb_each(v_moved) loop
    v_dest_json:=jsonb_set(v_dest_json,'{reminders}',(v_dest_json->'reminders')||jsonb_build_object(v_name,
      coalesce(v_dest_json#>array['reminders',v_name],'{}'::jsonb)||jsonb_build_object(p_person_id,v_moved->v_name)));
  end loop;
  update em_dia_private.publisher_links l set group_id=p_to_group_id where l.group_id=p_from_group_id and l.person_id=p_person_id;
  if v_linked_user is not null then update public.em_dia_group_members gm set group_id=p_to_group_id where gm.user_id=v_linked_user; end if;
  update em_dia_private.report_revisions r set group_id=p_to_group_id where r.group_id=p_from_group_id and r.person_id=p_person_id;
  v_source_json:=v_source_json||jsonb_build_object('revision',v_source.revision+1,'updatedAt',v_now);
  v_dest_json:=v_dest_json||jsonb_build_object('revision',v_dest.revision+1,'updatedAt',v_now);
  update public.em_dia_states s set state=v_source_json,revision=s.revision+1,updated_at=v_now where s.group_id=p_from_group_id returning s.* into v_source;
  if v_dest_new then
    insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at) values(p_to_group_id,null,v_dest_json,1,v_now)
      on conflict(group_id) do nothing returning * into v_dest;
    if not found then raise exception using errcode='40001',message='Destination group changed. Reload before transferring.'; end if;
  else
    update public.em_dia_states s set state=v_dest_json,revision=s.revision+1,updated_at=v_now where s.group_id=p_to_group_id returning s.* into v_dest;
  end if;
  return jsonb_build_object('from_group_id',p_from_group_id,'to_group_id',p_to_group_id,'person_id',p_person_id,
    'from_revision',v_source.revision,'to_revision',v_dest.revision);
end;
$$;

-- Existing manager clients keep compare-and-swap, but now lock the current row
-- before checking links. A concurrent account creation cannot orphan its card.
create or replace function em_dia_private.save_group_state(p_group_id uuid,p_state jsonb,p_expected_revision bigint)
returns public.em_dia_states language plpgsql security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id(); v_name text; v_state jsonb; v_row public.em_dia_states;
begin
  if v_user is null then raise exception using errcode='42501',message='Account not authorized.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,0));
  if not em_dia_private.can_access_group(p_group_id) then raise exception using errcode='42501',message='Group not authorized.'; end if;
  select g.name into v_name from public.em_dia_groups g where g.id=p_group_id;
  if not found then raise exception using errcode='42501',message='Group not authorized.'; end if;
  if p_expected_revision is null or p_expected_revision<0 or p_expected_revision>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid expected revision.';
  end if;
  if p_state is null or jsonb_typeof(p_state) is distinct from 'object'
    or p_state->>'app' is distinct from 'em-dia-relatorios' or p_state->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_state->'people') is distinct from 'array' or jsonb_typeof(p_state->'reports') is distinct from 'object'
    or jsonb_typeof(p_state->'reminders') is distinct from 'object' or jsonb_typeof(p_state->'settings') is distinct from 'object'
    or octet_length(p_state::text)>12582912 then raise exception using errcode='22023',message='Invalid Em dia state.'; end if;
  select * into v_row from public.em_dia_states s where s.group_id=p_group_id for update;
  if (found and (p_expected_revision=0 or v_row.revision<>p_expected_revision)) or (not found and p_expected_revision<>0) then
    raise exception using errcode='40001',message='Cloud revision conflict.';
  end if;
  perform em_dia_private.assert_state_links(p_group_id,p_state);
  v_state:=jsonb_set(p_state,'{settings,group}',to_jsonb(v_name),true);
  if p_expected_revision=0 then
    insert into public.em_dia_states(group_id,owner_id,state,revision,updated_at)
      values(p_group_id,null,v_state,1,statement_timestamp()) on conflict(group_id) do nothing returning * into v_row;
  else
    update public.em_dia_states s set state=v_state,revision=s.revision+1,updated_at=statement_timestamp()
      where s.group_id=p_group_id and s.revision=p_expected_revision returning s.* into v_row;
  end if;
  if not found then raise exception using errcode='40001',message='Cloud revision conflict.'; end if;
  return v_row;
end;
$$;
create or replace function em_dia_private.create_group(p_name text)
returns public.em_dia_groups language plpgsql security definer set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id(); v_name text:=btrim(p_name); v_group public.em_dia_groups;
begin
  if v_user is null then raise exception using errcode='42501',message='Administrator access required.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,0));
  if not em_dia_private.is_admin() then raise exception using errcode='42501',message='Administrator access required.'; end if;
  if v_name is null or char_length(v_name) not between 1 and 80 or v_name~'[[:cntrl:]]' then
    raise exception using errcode='22023',message='Invalid group name.';
  end if;
  insert into public.em_dia_groups(name,created_by) values(v_name,v_user) returning * into v_group;
  return v_group;
end;
$$;
create or replace function em_dia_private.provision_group_member(p_user_id uuid,p_group_id uuid default null,p_new_group_name text default null)
returns public.em_dia_groups language sql security definer set search_path='' as $$
  select em_dia_private.provision_access(p_user_id,null,p_group_id,p_new_group_name);
$$;

-- Only the named workflow routines receive the new NOLOGIN owner's privileges.
grant create on schema em_dia_private to em_dia_workflow;
do $$
declare v_function record;
begin
  for v_function in select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='em_dia_private' and p.proname=any(array[
      'lock_accounts','activity','report_values','clean_person','clean_report','assert_state_links',
      'get_access_profile','read_own_card','submit_own_report','list_report_revisions','review_report_revision',
      'list_publisher_accounts','preflight_publisher_account','provision_publisher_account','provision_access',
      'list_transfer_groups','transfer_publisher']) loop
    execute format('alter function %I.%I(%s) owner to em_dia_workflow',v_function.nspname,v_function.proname,v_function.args);
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role,em_dia_writer',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;
revoke create on schema em_dia_private from em_dia_workflow;
grant execute on function em_dia_private.sync_access_role() to em_dia_writer,em_dia_workflow;
grant execute on function em_dia_private.assert_state_links(uuid,jsonb),
  em_dia_private.provision_access(uuid,text,uuid,text) to em_dia_writer;
grant execute on function em_dia_private.get_access_profile(),em_dia_private.read_own_card(),
  em_dia_private.submit_own_report(text,jsonb,bigint),em_dia_private.list_report_revisions(uuid),
  em_dia_private.review_report_revision(uuid,bigint,text),em_dia_private.list_publisher_accounts(uuid),
  em_dia_private.preflight_publisher_account(uuid,text),em_dia_private.provision_publisher_account(uuid,uuid,text),
  em_dia_private.provision_access(uuid,text,uuid,text),em_dia_private.list_transfer_groups(),
  em_dia_private.transfer_publisher(uuid,uuid,text,bigint) to authenticated;

create function public.get_em_dia_access_profile() returns jsonb language sql stable security invoker set search_path=''
  as $$ select em_dia_private.get_access_profile(); $$;
create function public.read_em_dia_own_card() returns jsonb language sql stable security invoker set search_path=''
  as $$ select em_dia_private.read_own_card(); $$;
create function public.submit_em_dia_own_report(p_month text,p_report jsonb,p_expected_version bigint) returns jsonb language sql security invoker set search_path=''
  as $$ select em_dia_private.submit_own_report(p_month,p_report,p_expected_version); $$;
create function public.list_em_dia_report_revisions(p_group_id uuid) returns jsonb language sql stable security invoker set search_path=''
  as $$ select em_dia_private.list_report_revisions(p_group_id); $$;
create function public.review_em_dia_report_revision(p_revision_id uuid,p_expected_version bigint,p_decision text) returns jsonb language sql security invoker set search_path=''
  as $$ select em_dia_private.review_report_revision(p_revision_id,p_expected_version,p_decision); $$;
create function public.list_em_dia_publisher_accounts(p_group_id uuid) returns jsonb language sql stable security invoker set search_path=''
  as $$ select em_dia_private.list_publisher_accounts(p_group_id); $$;
create function public.preflight_em_dia_publisher_account(p_group_id uuid,p_person_id text) returns jsonb language sql stable security invoker set search_path=''
  as $$ select em_dia_private.preflight_publisher_account(p_group_id,p_person_id); $$;
create function public.provision_em_dia_publisher_account(p_user_id uuid,p_group_id uuid,p_person_id text) returns public.em_dia_groups language sql security invoker set search_path=''
  as $$ select em_dia_private.provision_publisher_account(p_user_id,p_group_id,p_person_id); $$;
create function public.provision_em_dia_access(p_user_id uuid,p_role text default null,p_group_id uuid default null,p_new_group_name text default null) returns public.em_dia_groups language sql security invoker set search_path=''
  as $$ select em_dia_private.provision_access(p_user_id,p_role,p_group_id,p_new_group_name); $$;
create function public.list_em_dia_transfer_groups() returns jsonb language sql stable security invoker set search_path=''
  as $$ select em_dia_private.list_transfer_groups(); $$;
create function public.transfer_em_dia_publisher(p_from_group_id uuid,p_to_group_id uuid,p_person_id text,p_expected_from_revision bigint) returns jsonb language sql security invoker set search_path=''
  as $$ select em_dia_private.transfer_publisher(p_from_group_id,p_to_group_id,p_person_id,p_expected_from_revision); $$;

do $$
declare v_function record;
begin
  for v_function in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array[
      'get_em_dia_access_profile','read_em_dia_own_card','submit_em_dia_own_report','list_em_dia_report_revisions',
      'review_em_dia_report_revision','list_em_dia_publisher_accounts','preflight_em_dia_publisher_account',
      'provision_em_dia_publisher_account','provision_em_dia_access','list_em_dia_transfer_groups','transfer_em_dia_publisher']) loop
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role',v_function.nspname,v_function.proname,v_function.args);
    execute format('grant execute on function %I.%I(%s) to authenticated',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;

-- A publication must never substitute or re-import a user's current data.
do $$
begin
  if exists(
    (select row_type,row_data from pg_temp.em_dia_roles_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s union all select 'groups',to_jsonb(g) from public.em_dia_groups g
        union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm))
    union all
    ((select 'states',to_jsonb(s) from public.em_dia_states s union all select 'groups',to_jsonb(g) from public.em_dia_groups g
        union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm) except
      select row_type,row_data from pg_temp.em_dia_roles_preservation)
  ) then raise exception 'The role migration changed existing groups, assignments or report data.'; end if;
end;
$$;
