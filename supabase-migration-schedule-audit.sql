-- Execute uma vez no SQL Editor do Supabase para atualizar uma instalação existente.
-- Registos anteriores ficam com updated_by = NULL; o autor histórico não é inferido.

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

comment on column public.schedule_entries.updated_by is
  'ID do utilizador autenticado que fez a última alteração; NULL em registos históricos sem autor conhecido.';
