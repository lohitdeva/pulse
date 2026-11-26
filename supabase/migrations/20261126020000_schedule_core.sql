create table public.day_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (key in ('weekday', 'weekend')),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint day_templates_user_key_key unique (user_id, key)
);

create table public.template_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  template_id uuid not null references public.day_templates (id) on delete cascade,
  sort_order int not null,
  start_hhmm text,
  end_hhmm text,
  block_type text not null check (
    block_type in ('anchor', 'habit', 'habit_checklist', 'habit_nudge', 'must_do', 'check_in', 'buffer', 'fixed')
  ),
  title text not null,
  note text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint template_blocks_template_sort_key unique (template_id, sort_order)
);

create index template_blocks_template_id_idx on public.template_blocks (template_id);

create table public.days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_key date not null,
  template_id uuid references public.day_templates (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint days_user_day_key_key unique (user_id, day_key)
);

create table public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_id uuid not null references public.days (id) on delete cascade,
  source text not null check (source in ('template', 'class', 'task', 'manual')),
  template_block_id uuid references public.template_blocks (id) on delete set null,
  start_at timestamptz,
  end_at timestamptz,
  block_type text,
  title text not null,
  status text not null default 'pending',
  sort_order int not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index schedule_items_day_id_idx on public.schedule_items (day_id);

alter table public.day_templates enable row level security;
alter table public.template_blocks enable row level security;
alter table public.days enable row level security;
alter table public.schedule_items enable row level security;

revoke all on table public.day_templates, public.template_blocks, public.days, public.schedule_items from public, anon;
grant select, insert, update, delete on table public.day_templates, public.template_blocks, public.days, public.schedule_items to authenticated;

create policy "Users can read their own day templates"
  on public.day_templates for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own day templates"
  on public.day_templates for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own day templates"
  on public.day_templates for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own day templates"
  on public.day_templates for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own template blocks"
  on public.template_blocks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own template blocks"
  on public.template_blocks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own template blocks"
  on public.template_blocks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own template blocks"
  on public.template_blocks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own days"
  on public.days for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own days"
  on public.days for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own days"
  on public.days for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own days"
  on public.days for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own schedule items"
  on public.schedule_items for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own schedule items"
  on public.schedule_items for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own schedule items"
  on public.schedule_items for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own schedule items"
  on public.schedule_items for delete
  to authenticated
  using ((select auth.uid()) = user_id);
