begin;

select plan(14);

select ok(has_table_privilege('service_role', 'public.item_logs', 'select'), 'service_role can select item_logs');
select ok(has_table_privilege('service_role', 'public.item_logs', 'insert'), 'service_role can insert item_logs');
select ok(has_table_privilege('service_role', 'public.item_logs', 'update'), 'service_role can update item_logs');
select ok(has_table_privilege('service_role', 'public.meal_logs', 'select'), 'service_role can select meal_logs');
select ok(has_table_privilege('service_role', 'public.water_logs', 'select'), 'service_role can select water_logs');
select ok(has_table_privilege('service_role', 'public.settings', 'select'), 'service_role can select settings');
select ok(has_table_privilege('service_role', 'public.tasks', 'select'), 'service_role can select tasks');
select ok(has_table_privilege('service_role', 'public.push_subscriptions', 'select'), 'service_role can select push_subscriptions');
select ok(has_table_privilege('service_role', 'public.push_subscriptions', 'delete'), 'service_role can delete push_subscriptions');
select ok(has_table_privilege('service_role', 'public.classes', 'select'), 'service_role can select classes');
select ok(has_table_privilege('service_role', 'public.reminders', 'update'), 'service_role can update reminders');
select ok(has_table_privilege('service_role', 'public.timetable_change_alerts', 'update'), 'service_role can update timetable_change_alerts');
select ok(has_table_privilege('service_role', 'public.notification_action_capabilities', 'insert'), 'service_role can insert notification_action_capabilities');
select ok(not has_table_privilege('anon', 'public.item_logs', 'select'), 'anon still has no access to item_logs');

select * from finish();
rollback;
