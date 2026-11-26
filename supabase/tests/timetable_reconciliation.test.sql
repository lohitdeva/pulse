begin;

select plan(52);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'timetable-a@example.test', '', now()),
  ('00000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'timetable-b@example.test', '', now())
on conflict (id) do nothing;

select ok(
  has_function_privilege('service_role', 'public.reconcile_timetable_snapshot(uuid,jsonb,jsonb)', 'EXECUTE'),
  'service_role can call the reconciliation RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.reconcile_timetable_snapshot(uuid,jsonb,jsonb)', 'EXECUTE'),
  'authenticated cannot call the reconciliation RPC'
);
select ok(
  not has_function_privilege('anon', 'public.reconcile_timetable_snapshot(uuid,jsonb,jsonb)', 'EXECUTE'),
  'anon cannot call the reconciliation RPC'
);

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":1,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T04:00:00Z","endsAt":"2026-09-28T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'baseline',
  'true',
  'first sync establishes a quiet baseline'
);
reset role;

select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000001'), 0, 'baseline queues no historical alerts');
select is((select count(*)::integer from public.classes where user_id = '00000000-0000-4000-8000-000000000001' and source_present), 4, 'baseline stores classes, an exam, and an event');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":1,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T04:00:00Z","endsAt":"2026-09-28T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'idempotent',
  'true',
  'repeating the current payload is an idempotent retry'
);
reset role;
select is((select count(*)::integer from public.timetable_snapshots where user_id = '00000000-0000-4000-8000-000000000001'), 1, 'idempotent retry does not add a snapshot');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":2,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T08:30:00Z","endsAt":"2026-09-28T10:00:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'moved',
  '1',
  'a class time change is counted as a move without merging duplicate sessions on other dates'
);
reset role;
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000001' and change_type = 'moved'), 1, 'a moved class queues one alert');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
update public.classes
set manual_state = 'cancelled'
where user_id = '00000000-0000-4000-8000-000000000001'
  and source_date = '2026-09-28';
reset role;

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":3,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T08:30:00Z","endsAt":"2026-09-28T10:00:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'unchanged',
  '4',
  'unchanged source values are still reconciled after a manual override'
);
reset role;
select is((select manual_state from public.classes where user_id = '00000000-0000-4000-8000-000000000001' and source_date = '2026-09-28'), 'cancelled', 'an unchanged source preserves a manual cancellation');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":4,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T09:00:00Z","endsAt":"2026-09-28T10:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'moved',
  '1',
  'a changed source cell wins over a manual cancellation'
);
reset role;
select is((select manual_state from public.classes where user_id = '00000000-0000-4000-8000-000000000001' and source_date = '2026-09-28'), 'none', 'source changes clear stale manual overrides');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":5,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T09:00:00Z","endsAt":"2026-09-28T10:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'removed',
  '1',
  'an item omitted from the sheet is marked removed'
);
reset role;
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000001' and change_type = 'removed'), 1, 'a removed item queues one alert');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":6,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T09:00:00Z","endsAt":"2026-09-28T10:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )->>'restored',
  '1',
  'a previously removed item listed again is restored'
);
reset role;
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000001' and change_type = 'restored'), 1, 'a restored item queues one alert');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":7,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T09:00:00Z","endsAt":"2026-09-28T10:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null},
      {"date":"2026-10-08","startsAt":"2026-10-08T04:00:00Z","endsAt":"2026-10-08T05:30:00Z","kind":"class","title":"EC-I-1","course":"EC-I","session":1,"professor":null,"room":null}
    ]'::jsonb
  )->>'added',
  '1',
  'one post-baseline class is counted as added'
);
reset role;
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000001' and change_type = 'added'), 1, 'one added class queues exactly one alert');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":7,"values":[["Date","Day","Sections"]],"merges":[]}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T09:00:00Z","endsAt":"2026-09-28T10:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null},
      {"date":"2026-10-08","startsAt":"2026-10-08T04:00:00Z","endsAt":"2026-10-08T05:30:00Z","kind":"class","title":"EC-I-1","course":"EC-I","session":1,"professor":null,"room":null}
    ]'::jsonb
  )->>'idempotent',
  'true',
  'retrying the addition is idempotent'
);
reset role;
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000001' and change_type = 'added'), 1, 'retrying the addition queues no extra alert');

set local role service_role;
select is(
  public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000002',
    '{"owner":"second"}'::jsonb,
    '[{"date":"2026-10-08","startsAt":"2026-10-08T04:00:00Z","endsAt":"2026-10-08T05:30:00Z","kind":"event","title":"Second user only","course":null,"session":null,"professor":null,"room":null}]'::jsonb
  )->>'baseline',
  'true',
  'a different owner gets an independent baseline'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*)::integer from public.classes), 5, 'class RLS exposes only the signed-in owner rows');
select is((select count(*)::integer from public.classes where user_id = '00000000-0000-4000-8000-000000000002'), 0, 'class RLS hides another owner rows');
select is((select count(*)::integer from public.timetable_snapshots), 7, 'snapshot RLS exposes only the signed-in owner rows');
select is((select count(*)::integer from public.timetable_change_alerts), 5, 'alert RLS exposes only the signed-in owner rows');
reset role;

create function public.test_fail_timetable_alert_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'forced alert failure';
end;
$$;
create trigger test_fail_timetable_alert_insert
before insert on public.timetable_change_alerts
for each row execute function public.test_fail_timetable_alert_insert();

select throws_ok(
  $$select public.reconcile_timetable_snapshot(
    '00000000-0000-4000-8000-000000000001',
    '{"version":8}'::jsonb,
    '[
      {"date":"2026-09-28","startsAt":"2026-09-28T09:00:00Z","endsAt":"2026-09-28T10:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-05","startsAt":"2026-10-05T04:00:00Z","endsAt":"2026-10-05T05:30:00Z","kind":"class","title":"OM-I-2","course":"OM-I","session":2,"professor":null,"room":null},
      {"date":"2026-10-06","startsAt":"2026-10-06T03:30:00Z","endsAt":"2026-10-06T05:00:00Z","kind":"exam","title":"FM-I Mid-term Exam","course":"FM-I","session":null,"professor":null,"room":null},
      {"date":"2026-10-07","startsAt":"2026-10-07T04:00:00Z","endsAt":"2026-10-07T05:30:00Z","kind":"event","title":"Industry Talk","course":null,"session":null,"professor":null,"room":null},
      {"date":"2026-10-09","startsAt":"2026-10-09T04:00:00Z","endsAt":"2026-10-09T05:30:00Z","kind":"event","title":"Rollback only","course":null,"session":null,"professor":null,"room":null}
    ]'::jsonb
  )$$,
  'P0001',
  'forced alert failure',
  'a failing queued alert rolls back the whole reconciliation'
);
drop trigger test_fail_timetable_alert_insert on public.timetable_change_alerts;
drop function public.test_fail_timetable_alert_insert();
select is((select count(*)::integer from public.timetable_snapshots where user_id = '00000000-0000-4000-8000-000000000001'), 7, 'rollback leaves the current snapshot and history unchanged');
select is((select count(*)::integer from public.classes where user_id = '00000000-0000-4000-8000-000000000001' and source_title = 'Rollback only'), 0, 'rollback leaves no partially inserted class');

-- T2.4b class overrides ------------------------------------------------------
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'timetable-c@example.test', '', now())
on conflict (id) do nothing;

create function public.test_tt_items(a_room text, b_start timestamptz, with_c boolean)
returns jsonb
language sql
as $$
  select jsonb_build_array(
    jsonb_build_object('date', '2026-10-05', 'startsAt', '2026-10-05T04:00:00Z', 'endsAt', '2026-10-05T05:30:00Z',
      'kind', 'class', 'title', 'OM-I-2', 'course', 'OM-I', 'session', 2, 'professor', null, 'room', a_room),
    jsonb_build_object('date', '2026-10-06',
      'startsAt', to_char(b_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endsAt', to_char((b_start + interval '90 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'kind', 'class', 'title', 'EC-I-1', 'course', 'EC-I', 'session', 1, 'professor', null, 'room', null)
  ) || case when with_c then jsonb_build_array(
    jsonb_build_object('date', '2026-10-07', 'startsAt', '2026-10-07T04:00:00Z', 'endsAt', '2026-10-07T05:30:00Z',
      'kind', 'event', 'title', 'Industry Talk', 'course', null, 'session', null, 'professor', null, 'room', null)
  ) else '[]'::jsonb end;
$$;

set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":0}'::jsonb, public.test_tt_items(null, '2026-10-06T04:00:00Z', true));
reset role;

select is((select count(*)::integer from public.classes where user_id = '00000000-0000-4000-8000-000000000003'), 3, 'override fixtures: baseline seeds three rows');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
update public.classes set manual_state = 'cancelled' where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'OM-I-2');
reset role;

set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":1}'::jsonb, public.test_tt_items(null, '2026-10-06T04:00:00Z', true));
reset role;

select is((select manual_state from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'OM-I-2')), 'cancelled', 'a hand cancel survives a sync where the cell is unchanged');
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'changed') + (select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'moved') + (select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'restored') + (select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'removed'), 0, 'an unchanged cell after a hand cancel queues no alert');

set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":2}'::jsonb, public.test_tt_items('R9', '2026-10-06T04:00:00Z', true));
reset role;

select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'changed' and class_id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'OM-I-2')), 1, 'a changed cell queues exactly one changed alert');
select is((select manual_state from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'OM-I-2')), 'none', 'the sheet wins over a hand cancel when the cell changes');
set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":3}'::jsonb, public.test_tt_items('R9', '2026-10-06T04:00:00Z', true));
reset role;

select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'changed' and class_id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'OM-I-2')), 1, 'syncing the same items in a new snapshot queues no further alert');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
update public.classes set manual_state = 'moved', manual_starts_at = '2026-10-06T09:00:00Z', manual_ends_at = '2026-10-06T10:30:00Z' where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'EC-I-1');
reset role;

set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":4}'::jsonb, public.test_tt_items('R9', '2026-10-06T04:00:00Z', true));
reset role;

select is((select manual_state from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'EC-I-1')), 'moved', 'a hand move survives a sync where the cell is unchanged');
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'moved'), 0, 'an unchanged cell after a hand move queues no alert');

set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":5}'::jsonb, public.test_tt_items('R9', '2026-10-06T06:00:00Z', true));
reset role;

select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'moved' and class_id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'EC-I-1')), 1, 'a sheet time change over a hand move queues exactly one moved alert');
select is((select manual_state from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'EC-I-1')), 'none', 'the sheet wins over a hand move when the time changes');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
update public.classes set manual_state = 'cancelled' where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'Industry Talk');
reset role;

set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":6}'::jsonb, public.test_tt_items('R9', '2026-10-06T06:00:00Z', false));
reset role;

select is((select source_present from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'Industry Talk')), false, 'a hand-cancelled class omitted from the sheet is marked removed');
set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":7}'::jsonb, public.test_tt_items('R9', '2026-10-06T06:00:00Z', true));
reset role;

select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'restored' and class_id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'Industry Talk')), 1, 'a re-listed class queues one restored alert');
select is((select source_present from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'Industry Talk')), true, 'a re-listed class is present again');
select is((select manual_state from public.classes where id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'Industry Talk')), 'cancelled', 'a hand cancel is kept when the sheet re-lists an unchanged cell');

select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'restored' and class_id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and source_title = 'OM-I-2')), 0, 'a class never removed gets no restored alert');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select public.add_extra_class('2026-10-08', '2026-10-08T04:00:00Z', '2026-10-08T05:00:00Z', 'Extra review', 'EC-I', 'R3');
reset role;

select is((select count(*)::integer from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and origin = 'manual'), 1, 'add_extra_class creates one manual-origin row');
set local role service_role;
select public.reconcile_timetable_snapshot('00000000-0000-4000-8000-000000000003', '{"override_sync":8}'::jsonb, public.test_tt_items('R9', '2026-10-06T06:00:00Z', true));
reset role;

select is((select count(*)::integer from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and origin = 'manual' and source_present), 1, 'a sync never removes a manual extra class');
select is((select count(*)::integer from public.timetable_change_alerts where user_id = '00000000-0000-4000-8000-000000000003' and change_type = 'removed' and class_id = (select id from public.classes where user_id = '00000000-0000-4000-8000-000000000003' and origin = 'manual')), 0, 'a manual extra class is never alerted as removed');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(
  $$update public.classes set source_title = 'Hacked' where origin = 'manual'$$,
  '42501', null, 'authenticated cannot edit source columns'
);
select throws_ok(
  $$insert into public.classes (user_id, source_key, base_key, kind, source_date, source_starts_at, source_ends_at, source_title, origin)
    values ('00000000-0000-4000-8000-000000000003', 'k', 'k', 'class', '2026-10-09', '2026-10-09T04:00:00Z', '2026-10-09T05:00:00Z', 'Direct', 'manual')$$,
  '42501', null, 'authenticated cannot insert classes directly'
);
reset role;
select ok(
  not has_function_privilege('anon', 'public.add_extra_class(date,timestamptz,timestamptz,text,text,text)', 'EXECUTE'),
  'anon cannot call add_extra_class'
);
select ok(
  has_function_privilege('authenticated', 'public.add_extra_class(date,timestamptz,timestamptz,text,text,text)', 'EXECUTE'),
  'authenticated can call add_extra_class'
);

drop function public.test_tt_items(text, timestamptz, boolean);

select * from finish();
rollback;
