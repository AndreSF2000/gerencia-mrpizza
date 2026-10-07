-- Execute no SQL Editor do Supabase para permitir texto livre nas células da escala.
-- Também garante a auditoria updated_by; pode ser executado mais do que uma vez.

alter table public.schedule_entries
  add column if not exists custom_shift varchar(50);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'schedule_entries_custom_shift_check'
      and conrelid = 'public.schedule_entries'::regclass
  ) then
    alter table public.schedule_entries
      add constraint schedule_entries_custom_shift_check
      check (custom_shift is null or (btrim(custom_shift) <> '' and shift = 'unset'));
  end if;
end $$;

alter table public.schedule_entries
  add column if not exists updated_by uuid references auth.users(id) on delete set null;

create or replace function public.set_schedule_entry_audit()
returns trigger
language plpgsql
as $$
begin
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists schedule_entries_audit on public.schedule_entries;
create trigger schedule_entries_audit
before insert or update on public.schedule_entries
for each row execute procedure public.set_schedule_entry_audit();

comment on column public.schedule_entries.custom_shift is
  'Texto livre da escala, até 50 caracteres; quando preenchido, shift deve ser unset.';

comment on column public.schedule_entries.updated_by is
  'ID do utilizador autenticado que fez a última alteração; NULL em registos históricos sem autor conhecido.';
