-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Create the savefiles table
create table if not exists public.savefiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Lagringsfil',
  data        text not null,  -- JSON string of full PersistedState
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2. Index for fast user lookups sorted by date
create index if not exists savefiles_user_updated
  on public.savefiles (user_id, updated_at desc);

-- 3. Enable Row Level Security
alter table public.savefiles enable row level security;

-- 4. Users can only see, insert, update, delete their own rows
create policy "Users can read own savefiles"
  on public.savefiles for select
  using (auth.uid() = user_id);

create policy "Users can insert own savefiles"
  on public.savefiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update own savefiles"
  on public.savefiles for update
  using (auth.uid() = user_id);

create policy "Users can delete own savefiles"
  on public.savefiles for delete
  using (auth.uid() = user_id);

-- 5. Auto-update the updated_at timestamp on changes
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger savefiles_set_updated_at
  before update on public.savefiles
  for each row execute function public.set_updated_at();
