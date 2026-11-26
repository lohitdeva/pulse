create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  category text not null default 'Personal'
    check (category in ('Course', 'Live project', 'Placement', 'Personal')),
  linked_course text,
  priority text not null default 'P2' check (priority in ('P1', 'P2', 'P3')),
  deadline_at timestamptz,
  estimate_minutes integer not null default 30 check (estimate_minutes > 0),
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  status text not null default 'To do'
    check (status in ('To do', 'Scheduled', 'In progress', 'Done', 'Missed', 'Dropped')),
  actual_start_at timestamptz,
  actual_end_at timestamptz,
  source text not null default 'Manual' check (source in ('Manual', 'Gmail', 'Calendar')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_scheduled_block_pair check (
    (scheduled_start_at is null) = (scheduled_end_at is null)
  ),
  constraint tasks_scheduled_block_order check (
    scheduled_start_at is null or scheduled_end_at > scheduled_start_at
  ),
  constraint tasks_actual_end_requires_start check (
    actual_end_at is null or actual_start_at is not null
  ),
  constraint tasks_actual_time_order check (
    actual_end_at is null or actual_end_at >= actual_start_at
  )
);

create index tasks_user_deadline_idx
  on public.tasks (user_id, deadline_at asc nulls last, created_at asc, id asc);

create function public.set_tasks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_tasks_updated_at();

alter table public.tasks enable row level security;

revoke all on table public.tasks from public, anon;
grant select, insert, update, delete on table public.tasks to authenticated;

create policy "Users can read their own tasks"
  on public.tasks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own tasks"
  on public.tasks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own tasks"
  on public.tasks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own tasks"
  on public.tasks for delete
  to authenticated
  using ((select auth.uid()) = user_id);
