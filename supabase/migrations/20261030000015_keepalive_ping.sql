-- Plan gratuit Supabase : un projet sans activité pendant 7 jours est mis en pause.
-- Point de contrôle minimal, appelé chaque jour par .github/workflows/supabase-activite.yml : aucune donnée exposée.
create or replace function public.ping()
returns text
language sql stable security invoker set search_path = ''
as $$ select 'ok'::text $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
