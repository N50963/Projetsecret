-- Illustrations créées à l'avance : toutes les 15 minutes, la fonction mistral (action illustrate_missing) crée
-- quelques images de recettes qui n'en ont pas encore, jusqu'au refus de Mistral (quota gratuit), puis attend la fin de
-- la pause. Chaque plat a ainsi son image avant d'être proposé.
-- Plan gratuit : 96 appels de fonction par jour (limite 500 000 par mois) ; un appel en pause répond aussitôt.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Jeton partagé entre la tâche et la fonction (app_settings n'est lisible que par le rôle de service).
insert into public.app_settings (key, value)
values ('cron_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

select cron.schedule(
  'illustrations-manquantes',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://avhqhvedgppuieellruz.supabase.co/functions/v1/mistral',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select value from public.app_settings where key = 'cron_token')),
    body := '{"action": "illustrate_missing"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
