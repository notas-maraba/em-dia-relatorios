-- Private persistent service timer. Migration changes no pre-existing records.
lock table public.em_dia_states,public.em_dia_members,public.em_dia_groups,
  public.em_dia_group_members,em_dia_private.publisher_links,
  em_dia_private.report_revisions,em_dia_private.daily_hours,
  em_dia_private.legacy_group_links in share mode nowait;
create temporary table em_dia_timer_preservation(row_type text not null,row_data jsonb not null) on commit drop;
insert into em_dia_timer_preservation
select 'states',to_jsonb(s) from public.em_dia_states s
union all select 'members',to_jsonb(m) from public.em_dia_members m
union all select 'groups',to_jsonb(g) from public.em_dia_groups g
union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll;

-- Keep the newly enhanced diary response within its existing payload bound.
create or replace function em_dia_private.valid_hour_launches(p_month text,p_entries jsonb,p_launches jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_item jsonb;v_id uuid;v_ids uuid[]:='{}'::uuid[];v_day date;v_minutes numeric;
begin
  if not em_dia_private.valid_daily_entries(p_month,p_entries)
    or p_launches is null or jsonb_typeof(p_launches)<>'array'
    or jsonb_array_length(p_launches)>1000 or octet_length(p_launches::text)>262144 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_launches) loop
    if jsonb_typeof(v_item)<>'object' or not(v_item ?& array['id','date','minutes'])
      or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('id','date','minutes','note'))
      or jsonb_typeof(v_item->'id')<>'string' or jsonb_typeof(v_item->'date')<>'string'
      or jsonb_typeof(v_item->'minutes')<>'number'
      or (v_item ? 'note' and (jsonb_typeof(v_item->'note')<>'string' or char_length(v_item->>'note')>1000))
      or v_item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_item->>'date' !~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      or left(v_item->>'date',7)<>p_month then return false; end if;
    v_id:=(v_item->>'id')::uuid;
    if v_id=any(v_ids) then return false; end if;
    v_ids:=array_append(v_ids,v_id);
    v_day:=(v_item->>'date')::date;
    if to_char(v_day,'YYYY-MM-DD')<>v_item->>'date' then return false; end if;
    v_minutes:=(v_item->>'minutes')::numeric;
    if v_minutes<0 or v_minutes>44640 or trunc(v_minutes)<>v_minutes then return false; end if;
  end loop;
  -- Responses project a blank note for legacy objects. Bound that complete
  -- representation too so an accepted save remains readable by every client.
  if (select octet_length(coalesce(jsonb_agg(jsonb_build_object(
    'id',e->'id','date',e->'date','minutes',e->'minutes','note',coalesce(e->>'note',''))),'[]'::jsonb)::text)
    from jsonb_array_elements(p_launches) e)>262144 then return false; end if;
  return em_dia_private.launches_entries(p_launches)=p_entries;
exception when others then return false;
end;
$$;

create table em_dia_private.service_timers (
  group_id uuid not null references public.em_dia_groups(id) on delete cascade,
  person_id text not null check(person_id ~ '^[a-zA-Z0-9_-]{1,100}$' and person_id not in ('__proto__','constructor','prototype')),
  version bigint not null check(version between 1 and 9007199254740991),
  status text not null check(status in ('idle','running','paused','stopped')),
  timer_id uuid,
  start_date date,
  started_at timestamptz,
  anchor_at timestamptz,
  stopped_at timestamptz,
  accumulated_ms bigint not null default 0 check(accumulated_ms between 0 and 9007199254740991),
  last_action text,
  last_timer_id uuid,
  last_expected_version bigint,
  last_posted_receipt jsonb,
  last_posted_expected_timer_version bigint,
  last_posted_expected_hours_version bigint,
  updated_at timestamptz not null default statement_timestamp(),
  primary key(group_id,person_id),
  constraint em_dia_timer_state check (
    (status='idle' and timer_id is null and start_date is null and started_at is null and anchor_at is null and stopped_at is null and accumulated_ms=0)
    or (status='running' and timer_id is not null and start_date is not null and started_at is not null and anchor_at is not null and stopped_at is null)
    or (status='paused' and timer_id is not null and start_date is not null and started_at is not null and anchor_at is null and stopped_at is null)
    or (status='stopped' and timer_id is not null and start_date is not null and started_at is not null and anchor_at is null and stopped_at is not null)
  )
);
alter table em_dia_private.service_timers enable row level security;
alter table em_dia_private.service_timers force row level security;
revoke all on em_dia_private.service_timers from public,anon,authenticated,service_role,em_dia_writer,em_dia_workflow;
grant select,insert,update on em_dia_private.service_timers to em_dia_workflow;
create policy em_dia_timer_workflow_select on em_dia_private.service_timers for select to em_dia_workflow using(true);
create policy em_dia_timer_workflow_insert on em_dia_private.service_timers for insert to em_dia_workflow with check(true);
create policy em_dia_timer_workflow_update on em_dia_private.service_timers for update to em_dia_workflow using(true) with check(true);

-- Binding checks do not depend on the current pioneer period. An existing
-- session can still be stopped/read after its role period or month ends.
create function em_dia_private.own_timer_context() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_user uuid:=em_dia_private.current_user_id();v_link em_dia_private.publisher_links;v_state jsonb;
begin
  if v_user is null or em_dia_private.access_role() is distinct from 'publisher' then
    raise exception using errcode='42501',message='Publisher access required.';
  end if;
  select * into v_link from em_dia_private.publisher_links l where l.user_id=v_user;
  if not found or not exists(select 1 from public.em_dia_group_members gm where gm.user_id=v_user and gm.group_id=v_link.group_id) then
    raise exception using errcode='42501',message='Publisher access is not linked.';
  end if;
  select s.state into v_state from public.em_dia_states s where s.group_id=v_link.group_id;
  if not exists(select 1 from jsonb_array_elements(v_state->'people') p where p->>'id'=v_link.person_id) then
    raise exception using errcode='42501',message='Publisher card not available.';
  end if;
  return jsonb_build_object('group_id',v_link.group_id,'person_id',v_link.person_id);
end;
$$;


create function em_dia_private.timer_bundle(p_context jsonb,p_row em_dia_private.service_timers,p_now timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('group_id',p_context->'group_id','person_id',p_context->'person_id',
    'timer_id',(p_row).timer_id,'status',coalesce((p_row).status,'idle'),'version',coalesce((p_row).version,0),
    'start_date',(p_row).start_date,'started_at',(p_row).started_at,'anchor_at',(p_row).anchor_at,'stopped_at',(p_row).stopped_at,
    'accumulated_ms',coalesce((p_row).accumulated_ms,0),
    'elapsed_ms',coalesce((p_row).accumulated_ms,0)+case when (p_row).status='running'
      then greatest(0,floor(extract(epoch from (p_now-(p_row).anchor_at))*1000)::bigint) else 0 end,
    'server_now',p_now);
$$;

create function em_dia_private.read_own_timer() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_context jsonb;v_row em_dia_private.service_timers;
begin
  v_context:=em_dia_private.own_timer_context();
  select * into v_row from em_dia_private.service_timers t
    where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id';
  return em_dia_private.timer_bundle(v_context,v_row,clock_timestamp());
end;
$$;

create function em_dia_private.change_own_timer(p_action text,p_timer_id uuid,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_context jsonb;v_hours_context jsonb;v_row em_dia_private.service_timers;
  v_now timestamptz;v_today text;
  v_version bigint;v_exists boolean;v_elapsed bigint;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_context:=em_dia_private.own_timer_context();
  if p_action is null or p_action not in ('start','pause','resume','stop','discard') or p_timer_id is null
    or p_expected_version is null or p_expected_version<0 or p_expected_version>=9007199254740991 then
    raise exception using errcode='22023',message='Invalid timer action, identifier or version.';
  end if;
  perform 1 from public.em_dia_states s where s.group_id=(v_context->>'group_id')::uuid for update;
  select * into v_row from em_dia_private.service_timers t
    where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' for update;
  v_exists:=found;v_version:=coalesce(v_row.version,0);
  -- A waiting request samples time after locks, never before a concurrent
  -- request's newly committed anchor.
  v_now:=clock_timestamp();v_today:=to_char(v_now at time zone 'America/Sao_Paulo','YYYY-MM-DD');
  if v_exists and v_row.last_action=p_action and v_row.last_timer_id=p_timer_id and v_row.last_expected_version=p_expected_version then
    return em_dia_private.timer_bundle(v_context,v_row,v_now)||jsonb_build_object('unchanged',true);
  end if;
  if p_expected_version<>v_version then raise exception using errcode='40001',message='The timer changed. Reload before continuing.'; end if;
  if p_action='start' then
    if coalesce(v_row.status,'idle')<>'idle' or p_timer_id=v_row.last_timer_id
      or p_timer_id::text=v_row.last_posted_receipt->>'timer_id' then
      raise exception using errcode='22023',message='Finish the current timer and choose a new timer identifier.';
    end if;
    v_hours_context:=em_dia_private.own_hours_context(left(v_today,7));
    if v_hours_context->>'kind' not in ('regular','auxiliary') then
      raise exception using errcode='22023',message='The timer requires a pioneer month.';
    end if;
    v_row.status:='running';v_row.timer_id:=p_timer_id;v_row.start_date:=v_today::date;
    v_row.started_at:=v_now;v_row.anchor_at:=v_now;v_row.stopped_at:=null;v_row.accumulated_ms:=0;
  else
    if v_row.timer_id is distinct from p_timer_id then
      raise exception using errcode='40001',message='This timer is no longer current. Reload before continuing.';
    end if;
    v_elapsed:=v_row.accumulated_ms+case when v_row.status='running'
      then greatest(0,floor(extract(epoch from (v_now-v_row.anchor_at))*1000)::bigint) else 0 end;
    if p_action='pause' and v_row.status='running' then
      v_row.status:='paused';v_row.accumulated_ms:=v_elapsed;v_row.anchor_at:=null;
    elsif p_action='resume' and v_row.status='paused' then
      v_row.status:='running';v_row.anchor_at:=v_now;
    elsif p_action='stop' and v_row.status in ('running','paused') then
      v_row.status:='stopped';v_row.accumulated_ms:=v_elapsed;v_row.anchor_at:=null;v_row.stopped_at:=v_now;
    elsif p_action='discard' and v_row.status='stopped' then
      v_row.status:='idle';v_row.timer_id:=null;v_row.start_date:=null;v_row.started_at:=null;
      v_row.anchor_at:=null;v_row.stopped_at:=null;v_row.accumulated_ms:=0;
    else
      raise exception using errcode='22023',message='This action is not available for the current timer state.';
    end if;
  end if;
  v_row.version:=v_version+1;v_row.last_action:=p_action;v_row.last_timer_id:=p_timer_id;
  v_row.last_expected_version:=p_expected_version;v_row.updated_at:=v_now;
  if v_exists then
    update em_dia_private.service_timers t set version=v_row.version,status=v_row.status,timer_id=v_row.timer_id,
      start_date=v_row.start_date,started_at=v_row.started_at,anchor_at=v_row.anchor_at,stopped_at=v_row.stopped_at,
      accumulated_ms=v_row.accumulated_ms,last_action=v_row.last_action,last_timer_id=v_row.last_timer_id,
      last_expected_version=v_row.last_expected_version,updated_at=v_now
      where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' returning * into v_row;
  else
    insert into em_dia_private.service_timers(group_id,person_id,version,status,timer_id,start_date,started_at,anchor_at,
      stopped_at,accumulated_ms,last_action,last_timer_id,last_expected_version,updated_at)
      values((v_context->>'group_id')::uuid,v_context->>'person_id',v_row.version,v_row.status,v_row.timer_id,v_row.start_date,
        v_row.started_at,v_row.anchor_at,v_row.stopped_at,v_row.accumulated_ms,p_action,p_timer_id,p_expected_version,v_now) returning * into v_row;
  end if;
  return em_dia_private.timer_bundle(v_context,v_row,v_now)||jsonb_build_object('unchanged',false);
end;
$$;

create function em_dia_private.post_own_timer(p_timer_id uuid,p_expected_timer_version bigint,p_launch_id uuid,
  p_date text,p_minutes integer,p_note text,p_expected_hours_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=em_dia_private.current_user_id();v_context jsonb;v_row em_dia_private.service_timers;
  v_diary_row em_dia_private.daily_hours;v_diary jsonb;v_receipt jsonb;v_now timestamptz;
begin
  if v_user is null then raise exception using errcode='42501',message='Publisher access required.'; end if;
  perform em_dia_private.lock_accounts(array[v_user]);
  v_context:=em_dia_private.own_timer_context();
  if p_timer_id is null or p_launch_id is null or p_expected_timer_version is null or p_expected_timer_version<0
    or p_expected_timer_version>=9007199254740991 or p_expected_hours_version is null or p_expected_hours_version<0
    or p_expected_hours_version>=9007199254740991 or p_date is null or p_minutes is null then
    raise exception using errcode='22023',message='Invalid timer posting values.';
  end if;
  perform 1 from public.em_dia_states s where s.group_id=(v_context->>'group_id')::uuid for update;
  select * into v_row from em_dia_private.service_timers t
    where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' for update;
  if not found then raise exception using errcode='40001',message='The timer is not available. Reload before posting.'; end if;
  v_now:=clock_timestamp();
  -- A committed receipt wins over a later timer or edited/removed diary item.
  -- Exact retries never insert again or clear a subsequent active session.
  if v_row.last_posted_receipt->>'timer_id'=p_timer_id::text then
    v_receipt:=v_row.last_posted_receipt;
    if v_receipt->>'launch_id'<>p_launch_id::text or v_receipt->>'date'<>p_date
      or (v_receipt->>'minutes')::integer<>p_minutes or v_receipt->>'note'<>coalesce(p_note,'')
      or v_row.last_posted_expected_timer_version<>p_expected_timer_version
      or v_row.last_posted_expected_hours_version<>p_expected_hours_version then
      raise exception using errcode='22023',message='This timer was already posted with different values.';
    end if;
    v_diary:=em_dia_private.read_own_hour_launches(left(p_date,7));
    return jsonb_build_object('timer',em_dia_private.timer_bundle(v_context,v_row,v_now),'diary',v_diary,
      'launch_id',p_launch_id,'receipt',v_receipt,'unchanged',true);
  end if;
  if v_row.version<>p_expected_timer_version or v_row.timer_id is distinct from p_timer_id then
    raise exception using errcode='40001',message='The timer changed. Reload before posting.';
  end if;
  if v_row.status<>'stopped' then raise exception using errcode='22023',message='Stop the timer before posting its hours.'; end if;
  -- Only a new stable UUID may be used: a pre-existing independent launch must
  -- not be relabelled as the result of this timer.
  select * into v_diary_row from em_dia_private.daily_hours d
    where d.group_id=(v_context->>'group_id')::uuid and d.person_id=v_context->>'person_id' and d.month=left(p_date,7) for update;
  if exists(select 1 from jsonb_array_elements(coalesce(v_diary_row.launches,'[]'::jsonb)) e where e->>'id'=p_launch_id::text) then
    raise exception using errcode='22023',message='Choose a new identifier for this timer launch.';
  end if;
  v_diary:=em_dia_private.save_own_hour_launch_note(p_launch_id,p_date,p_minutes,p_note,p_expected_hours_version);
  v_receipt:=jsonb_build_object('timer_id',p_timer_id,'launch_id',p_launch_id,'date',p_date,
    'minutes',p_minutes,'note',coalesce(p_note,''),'posted_at',v_now);
  update em_dia_private.service_timers t set status='idle',timer_id=null,start_date=null,started_at=null,anchor_at=null,
    stopped_at=null,accumulated_ms=0,version=t.version+1,last_action='post',last_timer_id=p_timer_id,
    last_expected_version=p_expected_timer_version,last_posted_receipt=v_receipt,
    last_posted_expected_timer_version=p_expected_timer_version,last_posted_expected_hours_version=p_expected_hours_version,updated_at=v_now
    where t.group_id=(v_context->>'group_id')::uuid and t.person_id=v_context->>'person_id' returning * into v_row;
  return jsonb_build_object('timer',em_dia_private.timer_bundle(v_context,v_row,v_now),'diary',v_diary,
    'launch_id',p_launch_id,'receipt',v_receipt,'unchanged',false);
end;
$$;

-- Reset/import may not silently orphan an active or stopped timer.
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
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=d.person_id))
    or exists(select 1 from em_dia_private.service_timers t where t.group_id=p_group_id and t.status<>'idle' and
      not exists(select 1 from jsonb_array_elements(p_state->'people') p where p->>'id'=t.person_id)) then
    raise exception using errcode='22023',message='A linked publisher, pending review, diary or active timer cannot be removed. Transfer the card or resolve it first.';
  end if;
end;
$$;

-- Card transfers carry the private timer and receipt without altering elapsed time.
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
    or exists(select 1 from em_dia_private.service_timers t where t.group_id=p_to_group_id and t.person_id=p_person_id)
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
  update em_dia_private.service_timers t set group_id=p_to_group_id where t.group_id=p_from_group_id and t.person_id=p_person_id;
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

grant create on schema em_dia_private to em_dia_workflow;
do $$
declare v_function record;
begin
  for v_function in select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='em_dia_private' and p.proname=any(array[
      'own_timer_context','timer_bundle','read_own_timer','change_own_timer','post_own_timer']) loop
    execute format('alter function %I.%I(%s) owner to em_dia_workflow',v_function.nspname,v_function.proname,v_function.args);
    execute format('revoke execute on function %I.%I(%s) from public,anon,authenticated,service_role,em_dia_writer',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$$;
revoke create on schema em_dia_private from em_dia_workflow;
grant execute on function em_dia_private.read_own_timer(),em_dia_private.change_own_timer(text,uuid,bigint),
  em_dia_private.post_own_timer(uuid,bigint,uuid,text,integer,text,bigint) to authenticated;

create function public.read_em_dia_own_timer() returns jsonb
language sql stable security invoker set search_path='' as $$ select em_dia_private.read_own_timer(); $$;
create function public.change_em_dia_own_timer(p_action text,p_timer_id uuid,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.change_own_timer(p_action,p_timer_id,p_expected_version);
$$;
create function public.post_em_dia_own_timer(p_timer_id uuid,p_expected_timer_version bigint,p_launch_id uuid,
  p_date text,p_minutes integer,p_note text,p_expected_hours_version bigint) returns jsonb
language sql security invoker set search_path='' as $$
  select em_dia_private.post_own_timer(p_timer_id,p_expected_timer_version,p_launch_id,p_date,p_minutes,p_note,p_expected_hours_version);
$$;
revoke execute on function public.read_em_dia_own_timer(),public.change_em_dia_own_timer(text,uuid,bigint),
  public.post_em_dia_own_timer(uuid,bigint,uuid,text,integer,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_em_dia_own_timer(),public.change_em_dia_own_timer(text,uuid,bigint),
  public.post_em_dia_own_timer(uuid,bigint,uuid,text,integer,text,bigint) to authenticated;

do $$
begin
  if exists(select 1 from em_dia_private.service_timers) then
    raise exception 'The private timer table must start empty.';
  end if;
  if exists(select 1 from em_dia_private.daily_hours d
    where not em_dia_private.valid_hour_launches(d.month,d.entries,d.launches)) then
    raise exception 'An existing diary exceeds the complete optional-note response limit.';
  end if;
  if exists(
    (select row_type,row_data from pg_temp.em_dia_timer_preservation except
      (select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll))
    union all
    ((select 'states',to_jsonb(s) from public.em_dia_states s
       union all select 'members',to_jsonb(m) from public.em_dia_members m
       union all select 'groups',to_jsonb(g) from public.em_dia_groups g
       union all select 'memberships',to_jsonb(gm) from public.em_dia_group_members gm
       union all select 'links',to_jsonb(l) from em_dia_private.publisher_links l
       union all select 'revisions',to_jsonb(r) from em_dia_private.report_revisions r
       union all select 'diaries',to_jsonb(d) from em_dia_private.daily_hours d
       union all select 'legacy',to_jsonb(ll) from em_dia_private.legacy_group_links ll) except
      select row_type,row_data from pg_temp.em_dia_timer_preservation)
  ) then raise exception 'The persistent-timer migration changed existing records.'; end if;
end;
$$;

