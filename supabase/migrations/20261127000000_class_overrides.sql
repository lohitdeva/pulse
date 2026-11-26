-- T2.4b: class overrides. Manual-origin (extra) classes, an RPC to add them,
-- and a reconcile that honours manual states (PRD section 4).
--
-- Source protection: authenticated keeps only the column-level UPDATE grant on
-- manual_state/manual_starts_at/manual_ends_at/manual_title (from the timetable
-- migration) and has NO insert grant, so it cannot edit source_*, origin or
-- snapshot ids, and cannot insert rows directly. Extra classes go through the
-- SECURITY DEFINER function add_extra_class, which stamps auth.uid().

alter table public.classes
  add column origin text not null default 'sheet'
    check (origin in ('sheet', 'manual'));

alter table public.classes
  alter column first_seen_snapshot_id drop not null,
  alter column last_seen_snapshot_id drop not null;

alter table public.classes
  add constraint classes_origin_snapshot_ids check (
    (origin = 'sheet' and first_seen_snapshot_id is not null and last_seen_snapshot_id is not null)
    or (origin = 'manual' and first_seen_snapshot_id is null and last_seen_snapshot_id is null)
  );

create function public.add_extra_class(
  p_date date,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_course text default null,
  p_room text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'not authenticated';
  end if;

  insert into public.classes (
    id, user_id, source_key, base_key, kind, source_date,
    source_starts_at, source_ends_at, source_title, source_course, source_room,
    source_present, origin
  ) values (
    v_id, v_user_id, 'manual|' || v_id::text, 'manual|' || v_id::text, 'class', p_date,
    p_starts_at, p_ends_at, pg_catalog.btrim(p_title),
    nullif(pg_catalog.btrim(p_course), ''), nullif(pg_catalog.btrim(p_room), ''),
    true, 'manual'
  );
  return v_id;
end;
$$;

revoke all on function public.add_extra_class(date, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.add_extra_class(date, timestamptz, timestamptz, text, text, text) to authenticated;

-- Reconcile: same as the timetable migration except (1) manual-origin rows are
-- never loaded into the match set, so they are never matched, removed or
-- overwritten, and (2) a class re-listed after removal keeps a manual override
-- (e.g. a hand cancel) when its sheet cell is unchanged; a changed cell wins.
create or replace function public.reconcile_timetable_snapshot(
  p_user_id uuid,
  p_raw_payload jsonb,
  p_parsed_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content_hash text;
  v_current_id uuid;
  v_current_hash text;
  v_current_is_baseline boolean;
  v_snapshot_id uuid;
  v_baseline boolean;
  v_item_count integer;
  v_added integer := 0;
  v_removed integer := 0;
  v_moved integer := 0;
  v_restored integer := 0;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_seeded integer := 0;
  v_summary jsonb;
  v_item record;
  v_old public.classes%rowtype;
  v_change_type text;
  v_source_changed boolean;
  v_timing_changed boolean;
  v_details jsonb;
  v_new_class_id uuid;
  v_keep_manual boolean;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'p_user_id is required';
  end if;
  if pg_catalog.jsonb_typeof(p_raw_payload) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'p_raw_payload must be a JSON object';
  end if;
  if pg_catalog.jsonb_typeof(p_parsed_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'p_parsed_items must be a JSON array';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_parsed_items) as entry(item)
    where pg_catalog.jsonb_typeof(entry.item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(entry.item -> 'date') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry.item -> 'startsAt') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry.item -> 'endsAt') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry.item -> 'kind') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry.item -> 'title') is distinct from 'string'
      or entry.item ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (entry.item ->> 'kind') not in ('class', 'exam', 'event')
      or pg_catalog.length(pg_catalog.btrim(entry.item ->> 'title')) = 0
      or (entry.item ->> 'startsAt') = ''
      or (entry.item ->> 'endsAt') = ''
      or ((entry.item ->> 'kind') = 'class' and (
        nullif(pg_catalog.btrim(entry.item ->> 'course'), '') is null
        or (entry.item ->> 'session') is null
        or (entry.item ->> 'session') !~ '^[0-9]+$'
      ))
  ) then
    raise exception using errcode = '22023', message = 'p_parsed_items contains an invalid timetable item';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_parsed_items) as entry(item)
    where (entry.item ->> 'startsAt')::timestamptz >= (entry.item ->> 'endsAt')::timestamptz
  ) then
    raise exception using errcode = '22023', message = 'timetable item end must be after its start';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  v_content_hash := pg_catalog.md5(
    pg_catalog.jsonb_build_object('raw_payload', p_raw_payload, 'parsed_items', p_parsed_items)::text
  );
  v_item_count := pg_catalog.jsonb_array_length(p_parsed_items);

  select snapshot.id, snapshot.content_hash, snapshot.is_baseline
  into v_current_id, v_current_hash, v_current_is_baseline
  from public.timetable_snapshots as snapshot
  where snapshot.user_id = p_user_id and snapshot.is_current
  for update;

  if v_current_id is not null and v_current_hash = v_content_hash then
    return pg_catalog.jsonb_build_object(
      'snapshot_id', v_current_id,
      'baseline', v_current_is_baseline,
      'idempotent', true,
      'added', 0,
      'removed', 0,
      'moved', 0,
      'restored', 0,
      'changed', 0,
      'unchanged', v_item_count,
      'seeded', 0,
      'total', v_item_count
    );
  end if;

  v_baseline := v_current_id is null;
  if v_current_id is not null then
    update public.timetable_snapshots
    set is_current = false, updated_at = pg_catalog.now()
    where id = v_current_id;
  end if;

  insert into public.timetable_snapshots (
    user_id, raw_payload, parsed_items, content_hash, is_baseline, is_current
  ) values (
    p_user_id, p_raw_payload, p_parsed_items, v_content_hash, v_baseline, true
  )
  returning id into v_snapshot_id;

  create temporary table if not exists timetable_reconcile_incoming (
    ordinal bigint primary key,
    occurrence bigint not null,
    base_key text not null,
    source_key text not null,
    kind text not null,
    source_date date not null,
    source_starts_at timestamptz not null,
    source_ends_at timestamptz not null,
    source_title text not null,
    source_course text,
    source_session integer,
    source_professor text,
    source_room text,
    class_id uuid
  ) on commit drop;

  create temporary table if not exists timetable_reconcile_existing (
    class_id uuid primary key,
    base_key text not null,
    source_date date not null,
    occurrence bigint not null,
    source_present boolean not null,
    matched boolean not null default false
  ) on commit drop;

  truncate table pg_temp.timetable_reconcile_incoming;
  truncate table pg_temp.timetable_reconcile_existing;

  insert into pg_temp.timetable_reconcile_incoming (
    ordinal, occurrence, base_key, source_key, kind, source_date,
    source_starts_at, source_ends_at, source_title, source_course,
    source_session, source_professor, source_room
  )
  select
    parsed.ordinal,
    pg_catalog.row_number() over (
      partition by parsed.base_key, parsed.source_date
      order by parsed.source_starts_at, parsed.source_ends_at, parsed.source_title,
        coalesce(parsed.source_professor, ''), coalesce(parsed.source_room, ''), parsed.ordinal
    ),
    parsed.base_key,
    v_snapshot_id::text || '|' || parsed.ordinal::text,
    parsed.kind,
    parsed.source_date,
    parsed.source_starts_at,
    parsed.source_ends_at,
    parsed.source_title,
    parsed.source_course,
    parsed.source_session,
    parsed.source_professor,
    parsed.source_room
  from (
    select
      entry.ordinal,
      entry.item ->> 'kind' as kind,
      (entry.item ->> 'date')::date as source_date,
      (entry.item ->> 'startsAt')::timestamptz as source_starts_at,
      (entry.item ->> 'endsAt')::timestamptz as source_ends_at,
      pg_catalog.regexp_replace(pg_catalog.btrim(entry.item ->> 'title'), '\s+', ' ', 'g') as source_title,
      nullif(pg_catalog.btrim(entry.item ->> 'course'), '') as source_course,
      nullif(entry.item ->> 'session', '')::integer as source_session,
      nullif(pg_catalog.btrim(entry.item ->> 'professor'), '') as source_professor,
      nullif(pg_catalog.btrim(entry.item ->> 'room'), '') as source_room,
      case entry.item ->> 'kind'
        when 'class' then 'class|' || pg_catalog.upper(pg_catalog.btrim(entry.item ->> 'course')) || '|' || (entry.item ->> 'session')
        when 'exam' then 'exam|' || pg_catalog.lower(pg_catalog.btrim(coalesce(entry.item ->> 'course', ''))) || '|' || pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(entry.item ->> 'title'), '\s+', ' ', 'g'))
        else 'event|' || pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(entry.item ->> 'title'), '\s+', ' ', 'g'))
      end as base_key
    from pg_catalog.jsonb_array_elements(p_parsed_items) with ordinality as entry(item, ordinal)
  ) as parsed;

  insert into pg_temp.timetable_reconcile_existing (
    class_id, base_key, source_date, occurrence, source_present
  )
  select
    existing.id,
    existing.base_key,
    existing.source_date,
    pg_catalog.row_number() over (
      partition by existing.base_key, existing.source_date
      order by existing.source_starts_at, existing.source_ends_at, existing.source_title, existing.id
    ),
    existing.source_present
  from public.classes as existing
  where existing.user_id = p_user_id
    and existing.origin = 'sheet';

  update pg_temp.timetable_reconcile_incoming as incoming
  set class_id = existing.class_id
  from pg_temp.timetable_reconcile_existing as existing
  where incoming.class_id is null
    and existing.matched = false
    and incoming.base_key = existing.base_key
    and incoming.source_date = existing.source_date
    and incoming.occurrence = existing.occurrence;

  update pg_temp.timetable_reconcile_existing as existing
  set matched = true
  where exists (
    select 1 from pg_temp.timetable_reconcile_incoming as incoming
    where incoming.class_id = existing.class_id
  );

  with incoming_unmatched as (
    select base_key, pg_catalog.count(*) as item_count, pg_catalog.min(ordinal) as ordinal
    from pg_temp.timetable_reconcile_incoming
    where class_id is null
    group by base_key
  ), existing_unmatched as (
    select base_key, pg_catalog.count(*) as item_count, pg_catalog.min(class_id::text)::uuid as class_id
    from pg_temp.timetable_reconcile_existing
    where not matched
    group by base_key
  )
  update pg_temp.timetable_reconcile_incoming as incoming
  set class_id = existing.class_id
  from incoming_unmatched as new_item, existing_unmatched as existing
  where incoming.ordinal = new_item.ordinal
    and new_item.item_count = 1
    and existing.item_count = 1
    and existing.base_key = new_item.base_key;

  update pg_temp.timetable_reconcile_existing as existing
  set matched = true
  where exists (
    select 1 from pg_temp.timetable_reconcile_incoming as incoming
    where incoming.class_id = existing.class_id
  );

  for v_item in
    select * from pg_temp.timetable_reconcile_incoming order by ordinal
  loop
    if v_item.class_id is null then
      insert into public.classes (
        user_id, source_key, base_key, kind, source_date,
        source_starts_at, source_ends_at, source_title, source_course,
        source_session, source_professor, source_room, source_present,
        first_seen_snapshot_id, last_seen_snapshot_id
      ) values (
        p_user_id, v_item.source_key, v_item.base_key, v_item.kind, v_item.source_date,
        v_item.source_starts_at, v_item.source_ends_at, v_item.source_title, v_item.source_course,
        v_item.source_session, v_item.source_professor, v_item.source_room, true,
        v_snapshot_id, v_snapshot_id
      ) returning id into v_new_class_id;

      if v_baseline then
        v_seeded := v_seeded + 1;
      else
        v_added := v_added + 1;
        v_details := pg_catalog.jsonb_build_object(
          'previous', null,
          'current', pg_catalog.jsonb_build_object(
            'date', v_item.source_date,
            'startsAt', v_item.source_starts_at,
            'endsAt', v_item.source_ends_at,
            'kind', v_item.kind,
            'title', v_item.source_title
          )
        );
        insert into public.timetable_change_alerts (user_id, snapshot_id, class_id, change_type, summary, details)
        values (
          p_user_id, v_snapshot_id, v_new_class_id, 'added',
          v_item.source_title || ' added on ' || v_item.source_date::text,
          v_details
        );
      end if;
      continue;
    end if;

    select * into v_old
    from public.classes as existing
    where existing.user_id = p_user_id and existing.id = v_item.class_id
    for update;

    v_source_changed := row(
      v_old.kind,
      v_old.source_date,
      v_old.source_starts_at,
      v_old.source_ends_at,
      v_old.source_title,
      v_old.source_course,
      v_old.source_session,
      v_old.source_professor,
      v_old.source_room
    ) is distinct from row(
      v_item.kind,
      v_item.source_date,
      v_item.source_starts_at,
      v_item.source_ends_at,
      v_item.source_title,
      v_item.source_course,
      v_item.source_session,
      v_item.source_professor,
      v_item.source_room
    );
    v_timing_changed := row(v_old.source_date, v_old.source_starts_at, v_old.source_ends_at)
      is distinct from row(v_item.source_date, v_item.source_starts_at, v_item.source_ends_at);

    if not v_old.source_present then
      -- Re-listed after removal. A manual override survives only if the sheet
      -- cell is unchanged; a changed cell wins and clears it.
      v_keep_manual := not v_source_changed and v_old.manual_state <> 'none';
      update public.classes
      set kind = v_item.kind,
          source_date = v_item.source_date,
          source_starts_at = v_item.source_starts_at,
          source_ends_at = v_item.source_ends_at,
          source_title = v_item.source_title,
          source_course = v_item.source_course,
          source_session = v_item.source_session,
          source_professor = v_item.source_professor,
          source_room = v_item.source_room,
          source_present = true,
          manual_state = case when v_keep_manual then v_old.manual_state else 'none' end,
          manual_starts_at = case when v_keep_manual then v_old.manual_starts_at else null end,
          manual_ends_at = case when v_keep_manual then v_old.manual_ends_at else null end,
          manual_title = case when v_keep_manual then v_old.manual_title else null end,
          last_seen_snapshot_id = v_snapshot_id,
          updated_at = pg_catalog.now()
      where id = v_old.id;

      v_restored := v_restored + 1;
      v_details := pg_catalog.jsonb_build_object(
        'previous', pg_catalog.jsonb_build_object(
          'date', v_old.source_date,
          'startsAt', v_old.source_starts_at,
          'endsAt', v_old.source_ends_at,
          'kind', v_old.kind,
          'title', v_old.source_title
        ),
        'current', pg_catalog.jsonb_build_object(
          'date', v_item.source_date,
          'startsAt', v_item.source_starts_at,
          'endsAt', v_item.source_ends_at,
          'kind', v_item.kind,
          'title', v_item.source_title
        )
      );
      insert into public.timetable_change_alerts (user_id, snapshot_id, class_id, change_type, summary, details)
      values (
        p_user_id, v_snapshot_id, v_old.id, 'restored',
        v_item.source_title || ' is back on at ' || pg_catalog.to_char(v_item.source_starts_at at time zone 'Asia/Kolkata', 'HH12:MI AM')
          || case when v_keep_manual and v_old.manual_state = 'cancelled' then ' (still cancelled by you)' else '' end,
        v_details
      );
    elsif v_source_changed then
      v_change_type := case when v_timing_changed then 'moved' else 'changed' end;
      update public.classes
      set kind = v_item.kind,
          source_date = v_item.source_date,
          source_starts_at = v_item.source_starts_at,
          source_ends_at = v_item.source_ends_at,
          source_title = v_item.source_title,
          source_course = v_item.source_course,
          source_session = v_item.source_session,
          source_professor = v_item.source_professor,
          source_room = v_item.source_room,
          manual_state = 'none',
          manual_starts_at = null,
          manual_ends_at = null,
          manual_title = null,
          last_seen_snapshot_id = v_snapshot_id,
          updated_at = pg_catalog.now()
      where id = v_old.id;

      if v_change_type = 'moved' then
        v_moved := v_moved + 1;
      else
        v_changed := v_changed + 1;
      end if;
      v_details := pg_catalog.jsonb_build_object(
        'previous', pg_catalog.jsonb_build_object(
          'date', v_old.source_date,
          'startsAt', v_old.source_starts_at,
          'endsAt', v_old.source_ends_at,
          'kind', v_old.kind,
          'title', v_old.source_title
        ),
        'current', pg_catalog.jsonb_build_object(
          'date', v_item.source_date,
          'startsAt', v_item.source_starts_at,
          'endsAt', v_item.source_ends_at,
          'kind', v_item.kind,
          'title', v_item.source_title
        )
      );
      insert into public.timetable_change_alerts (user_id, snapshot_id, class_id, change_type, summary, details)
      values (
        p_user_id, v_snapshot_id, v_old.id, v_change_type,
        case when v_change_type = 'moved'
          then v_item.source_title || ' moved to ' || pg_catalog.to_char(v_item.source_starts_at at time zone 'Asia/Kolkata', 'HH12:MI AM')
          else v_item.source_title || ' changed on ' || v_item.source_date::text
        end,
        v_details
      );
    else
      update public.classes
      set last_seen_snapshot_id = v_snapshot_id,
          updated_at = pg_catalog.now()
      where id = v_old.id;
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  for v_item in
    select existing.class_id, stored.*
    from pg_temp.timetable_reconcile_existing as existing
    join public.classes as stored on stored.id = existing.class_id
    where not existing.matched and stored.source_present
    order by stored.source_date, stored.source_starts_at, stored.id
  loop
    update public.classes
    set source_present = false,
        updated_at = pg_catalog.now()
    where id = v_item.id;

    v_removed := v_removed + 1;
    v_details := pg_catalog.jsonb_build_object(
      'previous', pg_catalog.jsonb_build_object(
        'date', v_item.source_date,
        'startsAt', v_item.source_starts_at,
        'endsAt', v_item.source_ends_at,
        'kind', v_item.kind,
        'title', v_item.source_title
      ),
      'current', null
    );
    insert into public.timetable_change_alerts (user_id, snapshot_id, class_id, change_type, summary, details)
    values (
      p_user_id, v_snapshot_id, v_item.id, 'removed',
      v_item.source_title || ' removed from ' || v_item.source_date::text,
      v_details
    );
  end loop;

  v_summary := pg_catalog.jsonb_build_object(
    'snapshot_id', v_snapshot_id,
    'baseline', v_baseline,
    'idempotent', false,
    'added', v_added,
    'removed', v_removed,
    'moved', v_moved,
    'restored', v_restored,
    'changed', v_changed,
    'unchanged', v_unchanged,
    'seeded', v_seeded,
    'total', v_item_count
  );

  update public.timetable_snapshots
  set summary = v_summary, updated_at = pg_catalog.now()
  where id = v_snapshot_id;

  return v_summary;
end;
$$;

revoke all on function public.reconcile_timetable_snapshot(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_timetable_snapshot(uuid, jsonb, jsonb) to service_role;
