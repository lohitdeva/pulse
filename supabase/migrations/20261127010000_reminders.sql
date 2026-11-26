-- T3.2a: reminder state, send history, missed log, and the every-minute dispatcher job.
--
-- reminders mirrors ReminderState in shared/reminders.ts (resolved, snoozedUntil,
-- sentCount, lastSentAt) plus the item fields the dispatcher needs. The engine is
-- stateless: the dispatcher persists resolution = 'missed' so an item is reported once.
--
-- Writes: only service_role inserts. The signed-in user may update only the resolution /
-- snooze / reason columns (column-level grants), never sent_count or last_sent_at.
--
-- Privacy: notification_log stores no notification text. It is pruned after 30 days.

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  item_key text not null check (length(btrim(item_key)) > 0),
  level text not null check (level in ('must', 'nudge', 'pace', 'none')),
  kind text not null
    check (kind in ('meal', 'gym', 'bedtime', 'class', 'deadline', 'nudge', 'water', 'other')),
  title text not null,
  fire_at timestamptz not null,
  window_end timestamptz,
  sent_count integer not null default 0 check (sent_count >= 0),
  last_sent_at timestamptz,
  snoozed_until timestamptz,
  resolution text
    check (resolution in ('done', 'skipped', 'medical', 'going_to_sleep', 'missed')),
  resolution_reason text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reminders_user_day_item_key unique (user_id, day_key, item_key)
);

create index reminders_user_day_idx on public.reminders (user_id, day_key);

create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_key text not null,
  day_key date not null,
  kind text not null,
  sent_at timestamptz not null default now(),
  status text not null check (status in ('sent', 'failed', 'gone')),
  push_subscription_id uuid references public.push_subscriptions (id) on delete set null,
  error_code text
);

create index notification_log_user_sent_idx on public.notification_log (user_id, sent_at desc);
create index notification_log_sent_idx on public.notification_log (sent_at);

create table public.missed_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  item_key text not null,
  title text not null,
  missed_at timestamptz not null default now(),
  reason text,
  reason_at timestamptz,
  constraint missed_items_user_day_item_key unique (user_id, day_key, item_key)
);

alter table public.reminders enable row level security;
alter table public.notification_log enable row level security;
alter table public.missed_items enable row level security;

revoke all on table public.reminders, public.notification_log, public.missed_items
  from public, anon, authenticated;
grant select on table public.reminders, public.notification_log, public.missed_items
  to authenticated;
grant update (resolution, resolution_reason, resolved_at, snoozed_until)
  on table public.reminders to authenticated;
grant update (reason, reason_at) on table public.missed_items to authenticated;
grant all on table public.reminders, public.notification_log, public.missed_items
  to service_role;

create policy "Users can read their own reminders"
  on public.reminders for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can resolve their own reminders"
  on public.reminders for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can read their own notification log"
  on public.notification_log for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own missed items"
  on public.missed_items for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can give a reason for their own missed items"
  on public.missed_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Dispatcher scheduling: pg_cron + pg_net, authenticated by a vault secret that this
-- migration generates itself (no manual setup). The Edge Function (T3.2b) verifies the
-- bearer token with public.check_dispatch_secret, using a service-role client.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Random shared secret, created once. Never printed, never in git.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'dispatch_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'dispatch_cron_secret',
      'Bearer secret the pg_cron dispatcher sends to dispatch-reminders'
    );
  end if;

  -- The project's public URL (not a secret).
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret(
      'https://yxzptibbpghnjzwhhhpi.supabase.co',
      'project_url',
      'Public base URL of this Supabase project'
    );
  end if;
end
$$;

create or replace function public.check_dispatch_secret(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select s.decrypted_secret = candidate
      from vault.decrypted_secrets s
      where s.name = 'dispatch_cron_secret'
      limit 1
    ),
    false
  );
$$;

revoke all on function public.check_dispatch_secret(text) from public, anon, authenticated;
grant execute on function public.check_dispatch_secret(text) to service_role;

-- Re-runnable: drop any previous copy of each job before scheduling it.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dispatch-reminders') then
    perform cron.unschedule('dispatch-reminders');
  end if;
  if exists (select 1 from cron.job where jobname = 'prune-notification-log') then
    perform cron.unschedule('prune-notification-log');
  end if;
end
$$;

-- Until the dispatch-reminders function is deployed (T3.2b) this call 404s harmlessly.
select cron.schedule(
  'dispatch-reminders',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/dispatch-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $job$
);

-- Daily at 21:17 UTC (02:47 IST): keep the send history to 30 days.
select cron.schedule(
  'prune-notification-log',
  '17 21 * * *',
  $job$ delete from public.notification_log where sent_at < now() - interval '30 days'; $job$
);
