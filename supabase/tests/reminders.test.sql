begin;

select plan(30);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'reminders-a@example.test', '', now()),
  ('00000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'reminders-b@example.test', '', now())
on conflict (id) do nothing;

select ok((select relrowsecurity from pg_class where oid = 'public.reminders'::regclass), 'RLS is on for reminders');
select ok((select relrowsecurity from pg_class where oid = 'public.notification_log'::regclass), 'RLS is on for notification_log');
select ok((select relrowsecurity from pg_class where oid = 'public.missed_items'::regclass), 'RLS is on for missed_items');

-- service_role writes rows for two users.
set local role service_role;
insert into public.reminders (user_id, day_key, item_key, level, kind, title, fire_at, window_end)
values
  ('00000000-0000-4000-8000-0000000000a1', '2026-11-27', 'meal:lunch', 'must', 'meal', 'Lunch', '2026-11-27T06:30:00Z', '2026-11-27T08:30:00Z'),
  ('00000000-0000-4000-8000-0000000000a2', '2026-11-27', 'meal:lunch', 'must', 'meal', 'Lunch', '2026-11-27T06:30:00Z', '2026-11-27T08:30:00Z');
insert into public.notification_log (user_id, item_key, day_key, kind, status)
values
  ('00000000-0000-4000-8000-0000000000a1', 'meal:lunch', '2026-11-27', 'meal', 'sent'),
  ('00000000-0000-4000-8000-0000000000a2', 'meal:lunch', '2026-11-27', 'meal', 'sent');
insert into public.missed_items (user_id, day_key, item_key, title)
values
  ('00000000-0000-4000-8000-0000000000a1', '2026-11-26', 'gym', 'Gym'),
  ('00000000-0000-4000-8000-0000000000a2', '2026-11-26', 'gym', 'Gym');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

select is((select count(*)::integer from public.reminders), 1, 'owner reads exactly their own reminders');
select is((select count(*)::integer from public.reminders where user_id = '00000000-0000-4000-8000-0000000000a2'), 0, 'owner cannot read another user''s reminders');
select is((select count(*)::integer from public.notification_log), 1, 'owner reads exactly their own notification log');
select is((select count(*)::integer from public.notification_log where user_id = '00000000-0000-4000-8000-0000000000a2'), 0, 'owner cannot read another user''s notification log');
select is((select count(*)::integer from public.missed_items), 1, 'owner reads exactly their own missed items');
select is((select count(*)::integer from public.missed_items where user_id = '00000000-0000-4000-8000-0000000000a2'), 0, 'owner cannot read another user''s missed items');

select throws_ok(
  $$insert into public.reminders (user_id, day_key, item_key, level, kind, title, fire_at)
    values ('00000000-0000-4000-8000-0000000000a1', '2026-11-27', 'x', 'must', 'meal', 'X', now())$$,
  '42501', null, 'authenticated cannot insert reminders'
);
select throws_ok(
  $$insert into public.notification_log (user_id, item_key, day_key, kind, status)
    values ('00000000-0000-4000-8000-0000000000a1', 'x', '2026-11-27', 'meal', 'sent')$$,
  '42501', null, 'authenticated cannot insert notification_log'
);
select throws_ok(
  $$insert into public.missed_items (user_id, day_key, item_key, title)
    values ('00000000-0000-4000-8000-0000000000a1', '2026-11-27', 'x', 'X')$$,
  '42501', null, 'authenticated cannot insert missed_items'
);

select lives_ok(
  $$update public.reminders set resolution = 'done', resolved_at = now() where item_key = 'meal:lunch'$$,
  'owner can resolve a reminder'
);
select throws_ok(
  $$update public.reminders set sent_count = 99 where item_key = 'meal:lunch'$$,
  '42501', null, 'owner cannot change sent_count'
);
select is(
  (with u as (
    update public.reminders set resolution = 'skipped'
    where user_id = '00000000-0000-4000-8000-0000000000a2' returning 1
  ) select count(*)::integer from u),
  0, 'owner cannot resolve another user''s reminder'
);
select lives_ok(
  $$update public.missed_items set reason = 'Overslept', reason_at = now() where item_key = 'gym'$$,
  'owner can give a reason for a missed item'
);
select throws_ok(
  $$update public.notification_log set status = 'failed'$$,
  '42501', null, 'authenticated cannot edit notification_log'
);
select throws_ok(
  $$delete from public.reminders$$,
  '42501', null, 'authenticated cannot delete reminders'
);
select throws_ok(
  $$select * from vault.decrypted_secrets$$,
  '42501', null, 'authenticated cannot read vault secrets'
);
reset role;

select ok(
  has_function_privilege('service_role', 'public.check_dispatch_secret(text)', 'EXECUTE'),
  'service_role can call check_dispatch_secret'
);
select ok(
  not has_function_privilege('authenticated', 'public.check_dispatch_secret(text)', 'EXECUTE'),
  'authenticated cannot call check_dispatch_secret'
);
select ok(
  not has_function_privilege('anon', 'public.check_dispatch_secret(text)', 'EXECUTE'),
  'anon cannot call check_dispatch_secret'
);

select ok(
  (select count(*) = 1 from vault.secrets where name = 'dispatch_cron_secret'),
  'the dispatch secret was generated in the vault'
);
select ok(
  (select count(*) = 1 from vault.secrets where name = 'project_url'),
  'the project URL is stored in the vault'
);

set local role service_role;
select is(public.check_dispatch_secret('not-the-secret'), false, 'a wrong secret is rejected');
reset role;
select is(
  public.check_dispatch_secret((select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')),
  true, 'the vault secret is accepted'
);

select is((select count(*)::integer from cron.job where jobname = 'dispatch-reminders'), 1, 'dispatch-reminders is scheduled');
select is((select schedule from cron.job where jobname = 'dispatch-reminders'), '* * * * *', 'dispatch-reminders runs every minute');
select ok(
  (select command like '%/functions/v1/dispatch-reminders%' and command like '%vault.decrypted_secrets%' from cron.job where jobname = 'dispatch-reminders'),
  'the job calls the function and reads the secret from the vault'
);
select is((select count(*)::integer from cron.job where jobname = 'prune-notification-log'), 1, 'the notification_log prune job is scheduled');

select * from finish();
rollback;
