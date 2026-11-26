create table public.item_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  item_key text not null,
  status text not null check (status in ('done', 'skipped', 'missed')),
  logged_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint item_logs_user_day_item_key unique (user_id, day_key, item_key)
);

create table public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  meal text not null check (meal in ('breakfast', 'lunch', 'snacks', 'dinner')),
  place text not null check (place in ('mess', 'outside', 'ordered_in')),
  logged_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_logs_user_day_meal_key unique (user_id, day_key, meal)
);

create table public.water_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  amount_ml int not null check (amount_ml > 0),
  is_gym boolean not null default false,
  logged_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index water_logs_user_day_idx on public.water_logs (user_id, day_key);

alter table public.item_logs enable row level security;
alter table public.meal_logs enable row level security;
alter table public.water_logs enable row level security;

revoke all on table public.item_logs, public.meal_logs, public.water_logs from public, anon;
grant select, insert, update, delete on table public.item_logs, public.meal_logs, public.water_logs to authenticated;

create policy "Users can read their own item logs"
  on public.item_logs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own item logs"
  on public.item_logs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own item logs"
  on public.item_logs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own item logs"
  on public.item_logs for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own meal logs"
  on public.meal_logs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own meal logs"
  on public.meal_logs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own meal logs"
  on public.meal_logs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own meal logs"
  on public.meal_logs for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own water logs"
  on public.water_logs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own water logs"
  on public.water_logs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own water logs"
  on public.water_logs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own water logs"
  on public.water_logs for delete
  to authenticated
  using ((select auth.uid()) = user_id);
