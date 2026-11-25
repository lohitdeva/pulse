create table public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  constraint push_subscriptions_user_endpoint_key unique (user_id, endpoint)
);

alter table public.settings enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on table public.settings, public.push_subscriptions from public, anon;
grant select, insert, update, delete on table public.settings, public.push_subscriptions to authenticated;

create policy "Users can read their own settings"
  on public.settings for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own settings"
  on public.settings for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own settings"
  on public.settings for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own settings"
  on public.settings for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own push subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own push subscriptions"
  on public.push_subscriptions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own push subscriptions"
  on public.push_subscriptions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own push subscriptions"
  on public.push_subscriptions for delete
  to authenticated
  using ((select auth.uid()) = user_id);
