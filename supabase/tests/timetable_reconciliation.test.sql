begin;

select plan(30);

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

select * from finish();
rollback;
