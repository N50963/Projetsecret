-- Fonction serveur Mistral : journal des appels (limite d'usage du quota gratuit) et réglages (agent d'illustration).
-- Tables réservées au serveur : RLS activée sans politique, aucun accès pour les comptes de l'application.
create table public.ai_calls (
  id bigint generated always as identity primary key,
  household_id uuid references public.households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  model text,
  ok boolean not null,
  detail text,
  created_at timestamptz not null default now()
);
create index ai_calls_household_idx on public.ai_calls (household_id, created_at desc);
create index ai_calls_user_idx on public.ai_calls (user_id);

create table public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.ai_calls enable row level security;
alter table public.app_settings enable row level security;
revoke all on public.ai_calls, public.app_settings from anon, authenticated;
