create table public.notification_action_capabilities (
  notification_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  capability_hash text not null
    check (capability_hash ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null,
  action text check (action in ('done', 'snooze')),
  snoozed_until timestamptz,
  acted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notification_action_snooze_fields_check check (
    (action = 'snooze' and snoozed_until is not null and acted_at is not null)
    or (action = 'done' and snoozed_until is null and acted_at is not null)
    or (action is null and snoozed_until is null and acted_at is null)
  )
);

create index notification_action_capabilities_expiry_idx
  on public.notification_action_capabilities (expires_at);

alter table public.notification_action_capabilities enable row level security;
revoke all on table public.notification_action_capabilities
  from public, anon, authenticated;
grant select, insert, update, delete on table public.notification_action_capabilities
  to service_role;

comment on table public.notification_action_capabilities is
  'One-time notification action capability hashes; raw capabilities are sent only in encrypted push payloads.';

create function public.apply_notification_action(
  p_notification_id uuid,
  p_capability_hash text,
  p_action text
)
returns table (
  action text,
  snoozed_until timestamptz,
  idempotent boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_capability public.notification_action_capabilities%rowtype;
begin
  if p_action not in ('done', 'snooze') then
    raise exception 'Invalid notification action' using errcode = '22023';
  end if;

  select capability.*
    into v_capability
    from public.notification_action_capabilities as capability
    where capability.notification_id = p_notification_id
      and capability.capability_hash = p_capability_hash
      and capability.expires_at > now()
    for update;

  if not found then
    return;
  end if;

  if v_capability.action is null then
    update public.notification_action_capabilities as capability
      set action = p_action,
          snoozed_until = case
            when p_action = 'snooze' then now() + interval '10 minutes'
            else null
          end,
          acted_at = now()
      where capability.notification_id = p_notification_id
      returning capability.* into v_capability;

    return query select v_capability.action, v_capability.snoozed_until, false;
    return;
  end if;

  return query
    select v_capability.action,
      v_capability.snoozed_until,
      v_capability.action = p_action;
end;
$$;

revoke all on function public.apply_notification_action(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_notification_action(uuid, text, text)
  to service_role;
