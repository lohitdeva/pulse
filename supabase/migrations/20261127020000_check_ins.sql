-- Daily check-ins (PRD section 6). One row per user, Pulse day and kind.
-- morning payload: {bedtime?, wakeTime?, mood?, energy?}; midday: {mood?};
-- night (T3.4b) reuses this table.
create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  kind text not null check (kind in ('morning', 'midday', 'night')),
  payload jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint check_ins_user_day_kind_key unique (user_id, day_key, kind)
);

alter table public.check_ins enable row level security;

revoke all on table public.check_ins from public, anon;
grant select, insert, update on table public.check_ins to authenticated;

create policy "Users can read their own check-ins"
  on public.check_ins for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own check-ins"
  on public.check_ins for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own check-ins"
  on public.check_ins for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
