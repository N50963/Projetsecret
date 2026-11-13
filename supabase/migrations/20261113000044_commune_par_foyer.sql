-- Commune de chaque foyer, pour la météo qui oriente les menus : un deuxième foyer (les parents, sur leurs propres
-- téléphones et leur propre compte Lidl Plus) peut habiter ailleurs qu'à Rochefort-du-Gard.
--
-- 1. Chaque foyer garde sa commune (nom et coordonnées). Le foyer existant reste à Rochefort-du-Gard, avec la même clé
--    de prévision qu'avant ('rochefort-du-gard') : sa météo déjà enregistrée sert toujours.
-- 2. La commune se choisit dans l'application (Profil › Commune pour la météo) : la fonction set_household_place
--    l'enregistre pour le foyer du compte connecté et demande aussitôt la prévision d'une nouvelle commune.
-- 3. Chaque heure, la tâche planifiée lit la prévision d'Open-Meteo pour chaque commune des foyers (une lecture par
--    commune, quel que soit le nombre de foyers qui y habitent).

alter table public.households
  add column place_key text not null default 'rochefort-du-gard',
  add column place_name text not null default 'Rochefort-du-Gard' check (char_length(place_name) between 1 and 80),
  add column latitude double precision not null default 43.976 check (latitude between -90 and 90),
  add column longitude double precision not null default 4.691 check (longitude between -180 and 180);
comment on column public.households.place_key is 'Clé de la prévision de la commune dans weather_days (latitude,longitude arrondies au centième).';
comment on column public.households.place_name is 'Commune du foyer, affichée avec la météo.';

-- Prévision d'une commune : requête envoyée par pg_net, réponse enregistrée par private.store_weather (inchangée).
create or replace function private.request_weather_at(p_place text, p_latitude double precision, p_longitude double precision)
returns bigint
language plpgsql set search_path = ''
as $$
declare
  rid bigint;
begin
  rid := net.http_get(
    url := format('https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s', round(p_latitude::numeric, 3), round(p_longitude::numeric, 3))
      || '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FParis&forecast_days=16',
    timeout_milliseconds := 15000
  );
  insert into private.weather_requests (id, place) values (rid, p_place);
  return rid;
end
$$;
revoke all on function private.request_weather_at(text, double precision, double precision) from public;

-- Tâche horaire : une lecture par commune habitée par au moins un foyer.
create or replace function private.request_weather() returns bigint
language plpgsql set search_path = ''
as $$
declare
  r record;
  n bigint := 0;
begin
  for r in
    select distinct on (place_key) place_key, latitude, longitude from public.households order by place_key, created_at
  loop
    perform private.request_weather_at(r.place_key, r.latitude, r.longitude);
    n := n + 1;
  end loop;
  delete from private.weather_requests where requested_at < now() - interval '2 days';
  -- Commune qu'aucun foyer n'habite plus : sa prévision n'est plus gardée.
  delete from public.weather_days w where not exists (select 1 from public.households h where h.place_key = w.place);
  return n;
end
$$;
revoke all on function private.request_weather() from public;

-- Commune choisie dans l'application, pour le foyer du compte connecté.
create or replace function public.set_household_place(p_household uuid, p_name text, p_latitude double precision, p_longitude double precision)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  k text;
begin
  if not private.is_member(p_household) then raise exception 'foyer inaccessible'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then raise exception 'nom de commune invalide'; end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'coordonnées de la commune invalides';
  end if;
  -- Rochefort-du-Gard garde sa clé d'origine (prévision déjà enregistrée).
  k := case when abs(p_latitude - 43.976) < 0.01 and abs(p_longitude - 4.691) < 0.01 then 'rochefort-du-gard'
    else round(p_latitude::numeric, 2)::text || ',' || round(p_longitude::numeric, 2)::text end;
  update public.households set place_key = k, place_name = btrim(p_name), latitude = p_latitude, longitude = p_longitude
  where id = p_household;
  -- Nouvelle commune : prévision demandée tout de suite (enregistrée à la prochaine passe de hh:14 ; en attendant, le
  -- téléphone lit Open-Meteo lui-même). Pas plus d'une demande par commune toutes les 10 minutes.
  if not exists (select 1 from public.weather_days where place = k and fetched_at > now() - interval '3 hours')
    and not exists (select 1 from private.weather_requests where place = k and requested_at > now() - interval '10 minutes') then
    perform private.request_weather_at(k, p_latitude, p_longitude);
  end if;
  return k;
end
$$;
revoke all on function public.set_household_place(uuid, text, double precision, double precision) from public, anon;
grant execute on function public.set_household_place(uuid, text, double precision, double precision) to authenticated;
