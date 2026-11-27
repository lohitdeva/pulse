-- T3.6: table grants for service_role used by the Edge Functions.
--
-- The hosted Supabase project has NO default privileges for service_role on
-- tables created in public (a local `supabase start` does), so PostgREST calls
-- made with the service-role key fail with "permission denied for table ...".
-- service_role bypasses RLS but still needs plain GRANTs. Least privilege, per
-- an audit of supabase/functions/*:
--   dispatch-reminders  : select item_logs, meal_logs, water_logs, settings,
--                         tasks, push_subscriptions; delete push_subscriptions
--   notification-action : select/insert/update item_logs (upsert from reminder actions)
-- Already granted elsewhere (not repeated): classes, timetable_snapshots,
-- timetable_change_alerts, reminders, notification_log, missed_items,
-- notification_action_capabilities, and EXECUTE on the three RPCs.
-- Grants only: no schema, RLS or revoke changes. Idempotent.

grant select on table
  public.item_logs,
  public.meal_logs,
  public.water_logs,
  public.settings,
  public.tasks,
  public.push_subscriptions
  to service_role;

grant delete on table public.push_subscriptions to service_role;

-- item_logs upsert (INSERT ... ON CONFLICT DO UPDATE) from notification-action.
grant insert, update on table public.item_logs to service_role;
