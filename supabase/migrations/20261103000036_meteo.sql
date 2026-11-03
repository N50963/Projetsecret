-- Météo de Rochefort-du-Gard pour le choix des menus. Chaque heure, Supabase lit la prévision d'Open-Meteo (gratuit, sans
-- compte ni clé ; modèles de Météo-France pour la France) et la garde par jour. Les téléphones lisent cette table : une
-- seule lecture d'Open-Meteo par heure pour tout le foyer, depuis l'adresse de Supabase (le quota d'Open-Meteo est compté
-- par adresse) ; ils n'interrogent Open-Meteo eux-mêmes qu'en secours.

create table public.weather_days (
  place text not null,
  day date not null,
  t_min real not null,
  t_max real not null,
  rain_mm real not null default 0,
  code smallint not null,
  fetched_at timestamptz not null default now(),
  primary key (place, day)
);
comment on table public.weather_days is 'Prévision par jour (Open-Meteo) : températures minimale et maximale (°C), pluie (mm), code temps de l''OMM.';

alter table public.weather_days enable row level security;
-- Données publiques (prévision d'une commune) : lisibles par les comptes connectés, écrites seulement par la tâche planifiée.
create policy "Prévisions lisibles par les comptes" on public.weather_days for select to authenticated using (true);
revoke insert, update, delete, truncate on public.weather_days from anon, authenticated;

-- Requêtes envoyées par pg_net (la réponse arrive après coup dans net._http_response).
create table private.weather_requests (
  id bigint primary key,
  place text not null,
  requested_at timestamptz not null default now(),
  stored boolean not null default false
);

create or replace function private.request_weather() returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  rid bigint;
begin
  rid := net.http_get(
    url := 'https://api.open-meteo.com/v1/forecast?latitude=43.976&longitude=4.691'
      || '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FParis&forecast_days=16',
    timeout_milliseconds := 15000
  );
  insert into private.weather_requests (id, place) values (rid, 'rochefort-du-gard');
  delete from private.weather_requests where requested_at < now() - interval '2 days';
  return rid;
end
$$;

-- Enregistre les réponses reçues (une réponse illisible est écartée sans bloquer les suivantes).
create or replace function private.store_weather() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  d jsonb;
  n integer := 0;
  rows_done integer;
begin
  for r in
    select q.id, q.place, x.content
    from private.weather_requests q
    join net._http_response x on x.id = q.id
    where not q.stored and x.status_code = 200
    order by q.id
  loop
    begin
      d := r.content::jsonb -> 'daily';
      insert into public.weather_days (place, day, t_min, t_max, rain_mm, code, fetched_at)
      select r.place, (d -> 'time' ->> i)::date, (d -> 'temperature_2m_min' ->> i)::real, (d -> 'temperature_2m_max' ->> i)::real,
        coalesce((d -> 'precipitation_sum' ->> i)::real, 0), coalesce((d -> 'weather_code' ->> i)::smallint, 3), now()
      from generate_series(0, jsonb_array_length(d -> 'time') - 1) as i
      where d -> 'temperature_2m_max' ->> i is not null and d -> 'temperature_2m_min' ->> i is not null
      on conflict (place, day) do update set
        t_min = excluded.t_min, t_max = excluded.t_max, rain_mm = excluded.rain_mm, code = excluded.code, fetched_at = excluded.fetched_at;
      get diagnostics rows_done = row_count;
      n := n + rows_done;
    exception when others then
      -- Réponse inattendue : ignorée, la prochaine lecture la remplacera.
      null;
    end;
    update private.weather_requests set stored = true where id = r.id;
  end loop;
  delete from public.weather_days where day < current_date - 7;
  return n;
end
$$;

revoke all on function private.request_weather() from public, anon, authenticated;
revoke all on function private.store_weather() from public, anon, authenticated;

-- Toutes les heures : demande à hh:12, enregistrement à hh:14 (24 appels par jour à Open-Meteo).
select cron.schedule('meteo-demande', '12 * * * *', $$ select private.request_weather(); $$);
select cron.schedule('meteo-enregistrement', '14 * * * *', $$ select private.store_weather(); $$);
