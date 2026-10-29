-- Journal des synchronisations Lidl Plus lancées depuis les téléphones du foyer.
-- Aucune donnée d'authentification n'y est enregistrée : seulement le statut, les compteurs et un message d'erreur.
create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  source text not null default 'lidl_plus_fr',
  status text not null check (status in ('running', 'success', 'partial', 'reauth_required', 'error')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  new_receipts integer not null default 0,
  failed_receipts integer not null default 0,
  error_code text,
  error_message text check (char_length(error_message) <= 500)
);
create index sync_runs_household_idx on public.sync_runs (household_id, started_at desc);
create index sync_runs_user_idx on public.sync_runs (user_id);

alter table public.sync_runs enable row level security;
create policy sync_runs_select on public.sync_runs for select to authenticated
  using (private.is_member(household_id));
create policy sync_runs_insert on public.sync_runs for insert to authenticated
  with check (private.is_member(household_id) and user_id = (select auth.uid()));
create policy sync_runs_update on public.sync_runs for update to authenticated
  using (user_id = (select auth.uid())) with check (private.is_member(household_id) and user_id = (select auth.uid()));
revoke all on public.sync_runs from anon;
grant select, insert on public.sync_runs to authenticated;
grant update (status, finished_at, new_receipts, failed_receipts, error_code, error_message) on public.sync_runs to authenticated;

-- Dernière synchronisation du foyer, pour l'écran d'accueil.
create view public.last_sync with (security_invoker = true) as
select distinct on (household_id) household_id, status, started_at, finished_at, new_receipts, failed_receipts, error_code, error_message
from public.sync_runs
order by household_id, started_at desc;
revoke all on public.last_sync from anon;
