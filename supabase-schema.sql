-- Mr Pizza - schema para Supabase
-- Execute este ficheiro no SQL Editor do Supabase.
-- A aplicaÃ§Ã£o deverÃ¡ usar Supabase Auth com uma Ãºnica conta de gerente.
-- Os funcionÃ¡rios abaixo sÃ£o registos da equipa e nÃ£o precisam de login.

create extension if not exists pgcrypto;

do $$
begin
  create type public.member_status as enum ('active', 'inactive');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.shift_type as enum ('morning', 'evening', 'off', 'unset');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.schedule_source as enum ('automatic', 'manual', 'ai');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.ai_action_status as enum ('pending', 'completed', 'undone', 'cancelled');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Mr Pizza',
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  role text not null default 'Novo membro',
  initials text not null default '',
  color text not null default 'avatar-red',
  status member_status not null default 'active',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.schedule_months (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  month_start date not null,
  generated boolean not null default false,
  cleared boolean not null default false,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, month_start),
  check (extract(day from month_start) = 1)
);

create table if not exists public.schedule_entries (
  id uuid primary key default gen_random_uuid(),
  schedule_month_id uuid not null references public.schedule_months(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  shift shift_type not null default 'unset',
  source schedule_source not null default 'automatic',
  is_overtime boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_month_id, employee_id, work_date)
);

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  monthly_days_off integer not null default 7 check (monthly_days_off >= 0),
  weekday_day_start time not null default '11:00',
  weekday_day_end time not null default '18:00',
  weekday_night_start time not null default '18:00',
  weekday_night_end time not null default '00:00',
  weekend_day_start time not null default '11:00',
  weekend_day_end time not null default '19:00',
  weekend_night_start time not null default '19:00',
  weekend_night_end time not null default '02:00',
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_action_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  status ai_action_status not null default 'pending',
  prompt text,
  structured_command jsonb not null default '{}'::jsonb,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  undone_at timestamptz
);

create index if not exists employees_workspace_idx on public.employees (workspace_id, status, sort_order);
create index if not exists schedule_months_workspace_idx on public.schedule_months (workspace_id, month_start);
create index if not exists schedule_entries_month_date_idx on public.schedule_entries (schedule_month_id, work_date);
create index if not exists schedule_entries_employee_idx on public.schedule_entries (employee_id, work_date);
create index if not exists ai_action_log_workspace_idx on public.ai_action_log (workspace_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspaces_updated_at on public.workspaces;
create trigger workspaces_updated_at
before update on public.workspaces
for each row execute procedure public.set_updated_at();

drop trigger if exists employees_updated_at on public.employees;
create trigger employees_updated_at
before update on public.employees
for each row execute procedure public.set_updated_at();

drop trigger if exists schedule_months_updated_at on public.schedule_months;
create trigger schedule_months_updated_at
before update on public.schedule_months
for each row execute procedure public.set_updated_at();

drop trigger if exists schedule_entries_updated_at on public.schedule_entries;
create trigger schedule_entries_updated_at
before update on public.schedule_entries
for each row execute procedure public.set_updated_at();

drop trigger if exists workspace_settings_updated_at on public.workspace_settings;
create trigger workspace_settings_updated_at
before update on public.workspace_settings
for each row execute procedure public.set_updated_at();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = target_workspace
      and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_owner(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspaces
    where id = target_workspace
      and owner_id = auth.uid()
  );
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.employees enable row level security;
alter table public.schedule_months enable row level security;
alter table public.schedule_entries enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.ai_action_log enable row level security;

drop policy if exists "workspace members can view workspaces" on public.workspaces;
create policy "workspace members can view workspaces"
on public.workspaces for select
using (public.is_workspace_member(id) or owner_id = auth.uid());

drop policy if exists "users can create their workspaces" on public.workspaces;
create policy "users can create their workspaces"
on public.workspaces for insert
with check (owner_id = auth.uid());

drop policy if exists "workspace admins can update workspaces" on public.workspaces;
create policy "workspace admins can update workspaces"
on public.workspaces for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "members can view workspace membership" on public.workspace_members;
create policy "members can view workspace membership"
on public.workspace_members for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace owners can manage membership" on public.workspace_members;
create policy "workspace owners can manage membership"
on public.workspace_members for all
using (
  exists (
    select 1 from public.workspaces
    where id = workspace_id and owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where id = workspace_id and owner_id = auth.uid()
  )
);

drop policy if exists "members can manage employees" on public.employees;
create policy "members can manage employees"
on public.employees for all
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

drop policy if exists "members can manage schedule months" on public.schedule_months;
create policy "members can manage schedule months"
on public.schedule_months for all
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

drop policy if exists "members can manage schedule entries" on public.schedule_entries;
create policy "members can manage schedule entries"
on public.schedule_entries for all
using (
  exists (
    select 1
    from public.schedule_months sm
    where sm.id = schedule_month_id
      and public.is_workspace_owner(sm.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.schedule_months sm
    where sm.id = schedule_month_id
      and public.is_workspace_owner(sm.workspace_id)
  )
);

drop policy if exists "members can manage workspace settings" on public.workspace_settings;
create policy "members can manage workspace settings"
on public.workspace_settings for all
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

drop policy if exists "members can manage ai action history" on public.ai_action_log;
create policy "members can manage ai action history"
on public.ai_action_log for all
using (public.is_workspace_owner(workspace_id) and user_id = auth.uid())
with check (public.is_workspace_owner(workspace_id) and user_id = auth.uid());

create or replace function public.create_workspace(workspace_name text default 'Mr Pizza')
returns uuid
language plpgsql
security invoker
as $$
declare
  new_workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Nenhum gerente autenticado. Crie a conta em Authentication > Users e use o comando de criação por email no SQL Editor, ou execute esta função a partir do site depois do login.';
  end if;

  insert into public.workspaces (name, owner_id)
  values (coalesce(nullif(trim(workspace_name), ''), 'Mr Pizza'), auth.uid())
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, is_admin)
  values (new_workspace_id, auth.uid(), true);

  insert into public.workspace_settings (workspace_id)
  values (new_workspace_id);

  return new_workspace_id;
end;
$$;

comment on table public.employees is 'FuncionÃ¡rios ativos e inativos da equipa Mr Pizza.';
comment on table public.schedule_months is 'Um registo por mÃªs e espaÃ§o de trabalho.';
comment on table public.schedule_entries is 'Uma cÃ©lula da escala por funcionÃ¡rio e dia.';
comment on table public.ai_action_log is 'HistÃ³rico estruturado para confirmaÃ§Ã£o e desfazer aÃ§Ãµes da IA.';
