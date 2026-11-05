-- Private daily hour drafts. No identities, activity data or credentials are seeded.
-- NOWAIT avoids waiting behind an active report edit while holding other locks.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,em_dia_private.report_revisions
  in share mode nowait;
create temporary table em_dia_daily_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_daily_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'members',to_jsonb(m) from public.em_dia_members m
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r;

create function em_dia_private.valid_daily_entries(p_month text,p_entries jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_entry record; v_day date; v_value numeric;
begin
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'
    or p_entries is null or jsonb_typeof(p_entries)<>'object' or octet_length(p_entries::text)>4096 then return false; end if;
  if (select count(*) from jsonb_object_keys(p_entries))>31 then return false; end if;
  for v_entry in select key,value from jsonb_each(p_entries) loop
    if v_entry.key !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-[0-3][0-9]$'
      or left(v_entry.key,7)<>p_month or jsonb_typeof(v_entry.value)<>'number' then return false; end if;
    v_day:=v_entry.key::date;
    if to_char(v_day,'YYYY-MM-DD')<>v_entry.key then return false; end if;
    v_value:=(v_entry.value#>>'{}')::numeric;
    if v_value<0 or v_value>1440 or trunc(v_value)<>v_value then return false; end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create table em_dia_private.daily_hours (
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  person_id text not null check(person_id ~ '^[a-zA-Z0-9_-]{1,100}$' and person_id not in ('__proto__','constructor','prototype')),
  month text not null,
  entries jsonb not null default '{}'::jsonb,
  version bigint not null check(version between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key(group_id,person_id,month),
  constraint em_dia_daily_entries_check check(em_dia_private.valid_daily_entries(month,entries))
);
alter table em_dia_private.daily_hours enable row level security;
alter table em_dia_private.daily_hours force row level security;
revoke all on em_dia_private.daily_hours from public,anon,authenticated,service_role,em_dia_writer,em_dia_workflow;
grant select,insert,update on em_dia_private.daily_hours to em_dia_workflow;
create policy em_dia_daily_workflow on em_dia_private.daily_hours for all to em_dia_workflow
  using(true) with check(true);

-- This unexposed helper derives all identity and month permissions from the
-- verified account binding. Its result never contains the group JSON state.
create function em_dia_private.own_hours_context(p_month text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;
  v_state jsonb;v_person jsonb;v_report jsonb;v_kind text;
  v_today text:=to_char(statement_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD');
begin
  if v_user is null or em_dia_private.access_role() is distinct from 'publisher' then
    raise exception using errcode='42501',message='Publisher access required.';
  end if;
  if p_month is null or p_month !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$' or p_month>left(v_today,7) then
    raise exception using errcode='22023',message='Invalid diary month.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select s.state into v_state from public.em_dia_states s where s.group_id=v_link.group_id;
  select p into v_person from jsonb_array_elements(v_state->'people') p where p->>'id'=v_link.person_id;
  if v_person is null then raise exception using errcode='42501',message='Publisher card not available.'; end if;
  v_report:=v_state#>array['reports',p_month,v_link.person_id];
  if v_report is null and (p_month<(v_person->>'startMonth') or (v_person->>'endMonth' is not null and p_month>(v_person->>'endMonth'))) then
    raise exception using errcode='22023',message='The publisher is not tracked in that month.';
  end if;
  if v_report->'received'='true'::jsonb then v_kind:=v_report->>'kind';
  else
    select r->>'kind' into v_kind from jsonb_array_elements(v_person->'roles') r
      where r->>'start'<=p_month and (r->>'end' is null or r->>'end'>=p_month) order by r->>'start' desc limit 1;
    v_kind:=coalesce(v_kind,'publisher');
  end if;
  if v_kind not in ('publisher','regular','auxiliary') or v_kind is null then
    raise exception using errcode='22023',message='The month condition is invalid.';
  end if;
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id,'month',p_month,
    'kind',v_kind,'closed',p_month<left(v_today,7),'today',v_today);
end;
$$;

create function em_dia_private.hours_bundle(p_context jsonb,p_entries jsonb,p_version bigint,p_updated_at timestamptz) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('group_id',p_context->'group_id','person_id',p_context->'person_id',
    'month',p_context->'month','kind',p_context->'kind','closed',p_context->'closed','today',p_context->'today',
    'entries',p_entries,'version',p_version,'updated_at',p_updated_at,
    'total_minutes',coalesce((select sum((e.value#>>'{}')::integer) from jsonb_each(p_entries) e),0));
$$;

create function em_dia_private.read_own_hours(p_month text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_context jsonb;v_row em_dia_private.daily_hours;
begin
  v_context:=em_dia_private.own_hours_context(p_month);
  select * into v_row from em_dia_private.daily_hours d
    where d.group_id=(v_context->>'group_id')::uuid and d.person_id=v_context->>'person_id' and d.month=p_month;
  return em_dia_private.hours_bundle(v_context,coalesce(v_row.entries,'{}'::jsonb),coalesce(v_row.version,0),v_row.updated_at);
end;
$$;

create function em_dia_private.save_own_hours(p_date text,p_minutes integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_day date;v_month text;v_row em_dia_private.daily_hours;v_found boolean;v_entries jsonb;v_next jsonb;v_version bigint;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_date is null or p_date !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-[0-3][0-9]$'
    or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991
    or (p_minutes is not null and (p_minutes<0 or p_minutes>1440)) then
    raise exception using errcode='22023',message='Invalid diary date, minutes or version.';
  end if;
  begin v_day:=p_date::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='22023',message='Invalid calendar date.';
  end;
  if to_char(v_day,'YYYY-MM-DD')<>p_date then raise exception using errcode='22023',message='Invalid calendar date.'; end if;
  v_month:=left(p_date,7);
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found then raise exception using errcode='42501',message='Publisher access is not linked.'; end if;
  -- Daily drafts serialize with card transfer/role edits, but never update state.
  perform 1 from public.em_dia_states s where s.group_id=v_link.group_id for update;
  v_context:=em_dia_private.own_hours_context(v_month);
  if (v_context->>'kind') not in ('regular','auxiliary') or p_date>(v_context->>'today') then
    raise exception using errcode='22023',message='Daily hours require a pioneer month and a non-future date.';
  end if;
  select * into v_row from em_dia_private.daily_hours d
    where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=v_month for update;
  v_found:=found;v_entries:=coalesce(v_row.entries,'{}'::jsonb);v_version:=coalesce(v_row.version,0);
  v_next:=case when p_minutes is null then v_entries-p_date else v_entries||jsonb_build_object(p_date,p_minutes) end;
  if p_expected_version>v_version then raise exception using errcode='40001',message='The diary version is invalid. Reload before saving.'; end if;
  if v_next=v_entries then
    return em_dia_private.hours_bundle(v_context,v_entries,v_version,v_row.updated_at)||jsonb_build_object('unchanged',true);
  end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='The diary changed. Reload before saving.'; end if;
  if v_found then
    update em_dia_private.daily_hours d set entries=v_next,version=d.version+1,updated_at=statement_timestamp()
      where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=v_month returning d.* into v_row;
  else
    insert into em_dia_private.daily_hours(group_id,person_id,month,entries,version,updated_at)
      values(v_link.group_id,v_link.person_id,v_month,v_next,1,statement_timestamp()) returning * into v_row;
  end if;
  return em_dia_private.hours_bundle(v_context,v_row.entries,v_row.version,v_row.updated_at)||jsonb_build_object('unchanged',false);
end;
$$;

create function em_dia_private.submit_own_hours(p_month text,p_participated boolean,p_studies integer,
  p_expected_hours_version bigint,p_expected_report_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_context jsonb;
  v_row em_dia_private.daily_hours;v_minutes integer;v_result jsonb;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  if em_dia_private.access_role() is distinct from 'publisher' then raise exception using errcode='42501',message='Publisher access required.'; end if;
  if p_expected_hours_version is null or p_expected_hours_version<0 or p_expected_hours_version>=9007199254740991
    or p_expected_report_version is null or p_expected_report_version<0 or p_expected_report_version>=9007199254740991
    or (p_studies is not null and (p_studies<0 or p_studies>9999)) then
    raise exception using errcode='22023',message='Invalid diary or report values.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found then raise exception using errcode='42501',message='Publisher access is not linked.'; end if;
  perform 1 from public.em_dia_states s where s.group_id=v_link.group_id for update;
  v_context:=em_dia_private.own_hours_context(p_month);
  if (v_context->>'kind') not in ('regular','auxiliary') or v_context->'closed'<>'true'::jsonb then
    raise exception using errcode='22023',message='Pioneer reports can be sent only after the month closes.';
  end if;
  select * into v_row from em_dia_private.daily_hours d
    where d.group_id=v_link.group_id and d.person_id=v_link.person_id and d.month=p_month for update;
  if not found or v_row.entries='{}'::jsonb then
    raise exception using errcode='22023',message='Record at least one day, including zero when applicable, before sending the diary.';
  end if;
  if v_row.version<>p_expected_hours_version then raise exception using errcode='40001',message='The diary changed. Reload before sending.'; end if;
  select sum((e.value#>>'{}')::integer) into v_minutes from jsonb_each(v_row.entries) e;
  v_result:=em_dia_private.submit_own_report(p_month,jsonb_build_object('participated',case when v_minutes>0 then true else p_participated end,
    'hours',round(v_minutes::numeric/60,2),'studies',p_studies),p_expected_report_version);
  return v_result||jsonb_build_object('hours_version',v_row.version,'total_minutes',v_minutes);
end;
$$;


create or replace function em_dia_private.assert_state_links(p_group_id uuid,p_state jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  if em_dia_private.current_user_id() is null or not em_dia_private.can_access_group(p_group_id) then
    raise exception using errcode='42501',message='Group not authorized.';
  end if;
  if exists(select 1 from em_dia_private.publisher_links l where l.group_id=p_group_id and
    not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=l.person_id))
    or exists(select 1 from em_dia_private.report_revisions r where r.group_id=p_group_id and r.status='pending' and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=r.person_id))
    or exists(select 1 from em_dia_private.daily_hours d where d.group_id=p_group_id and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=d.person_id)) then
    raise exception using errcode='22023',message='A linked publisher, pending review or daily diary cannot be removed. Transfer the card or resolve its access first.';
  end if;
end;
$$;

create or replace function em_dia_private.submit_own_report(p_month text,p_report jsonb,p_expected_version bigint) returns jsonb
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
  if p_expected_version>v_current_version then raise exception using errcode='40001',message='The report version is invalid. Reload before sending.'; end if;
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
  -- Identical accepted/pending retries above remain safe. New pioneer reports
  -- wait for the calendar month to close, including the legacy manual endpoint.
  if v_kind in ('regular','auxiliary') and p_month>=left(v_date,7) then
    raise exception using errcode='22023',message='Pioneer reports can be sent only after the month closes.';
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

create or replace function em_dia_private.transfer_publisher(p_from_group_id uuid,p_to_group_id uuid,p_person_id text,p_expected_from_revision bigint) returns jsonb
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
    or exists(select 1 from em_dia_private.daily_hours d where d.group_id=p_to_group_id and d.person_id=p_person_id)
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
  update em_dia_private.daily_hours d set group_id=p_to_group_id where d.group_id=p_from_group_id and d.person_id=p_person_id;
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

-- Private helpers have no API grant. Only the three named operations can be
-- reached through public invoker wrappers, and they recheck account ownership.
grant create on schema em_dia_private to em_dia_workflow;
do $$
declare v_function record;
begin
  for v_function in select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='em_dia_private' and p.proname=any(array[
      'valid_daily_entries','own_hours_context','hours_bundle','read_own_hours','save_own_hours','submit_own_hours']) loop
    execute format('alter function %I.%I(%s) owner to em_dia_workflow',v_function.nspname,v_function.proname,v_function.args);
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role,em_dia_writer',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;
revoke create on schema em_dia_private from em_dia_workflow;
grant execute on function em_dia_private.read_own_hours(text),
  em_dia_private.save_own_hours(text,integer,bigint),
  em_dia_private.submit_own_hours(text,boolean,integer,bigint,bigint) to authenticated;

create function public.read_em_dia_own_hours(p_month text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select em_dia_private.read_own_hours(p_month);
$$;
create function public.save_em_dia_own_hours(p_date text,p_minutes integer,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.save_own_hours(p_date,p_minutes,p_expected_version);
$$;
create function public.submit_em_dia_own_hours(p_month text,p_participated boolean,p_studies integer,
  p_expected_hours_version bigint,p_expected_report_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.submit_own_hours(p_month,p_participated,p_studies,p_expected_hours_version,p_expected_report_version);
$$;
revoke execute on function public.read_em_dia_own_hours(text),public.save_em_dia_own_hours(text,integer,bigint),
  public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_em_dia_own_hours(text),public.save_em_dia_own_hours(text,integer,bigint),
  public.submit_em_dia_own_hours(text,boolean,integer,bigint,bigint) to authenticated;

-- The feature adds an empty diary store; current cards, access and received
-- reports are byte-for-byte unchanged inside this transaction.
do $$
begin
  if exists(
    (select row_type,row_data from pg_temp.em_dia_daily_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s
        union all select 'members',to_jsonb(m) from public.em_dia_members m
        union all select 'groups',to_jsonb(g) from public.em_dia_groups g
        union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
        union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
        union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r))
    union all
    ((select 'states',to_jsonb(s) from public.em_dia_states s
        union all select 'members',to_jsonb(m) from public.em_dia_members m
        union all select 'groups',to_jsonb(g) from public.em_dia_groups g
        union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
        union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
        union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r) except
      select row_type,row_data from pg_temp.em_dia_daily_preservation)
  ) then raise exception 'The diary migration changed existing data or access.'; end if;
  if exists(select 1 from em_dia_private.daily_hours) then raise exception 'A diary migration must not seed personal data.'; end if;
end;
$$;
