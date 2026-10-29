-- Nombre de personnes du foyer : nombre de portions par défaut pour la planification et l'adaptation des recettes.
alter table public.households
  add column default_servings smallint not null default 4 check (default_servings between 1 and 20);

-- Modification réservée aux membres du foyer.
create policy households_update on public.households for update to authenticated
  using (private.is_member(id)) with check (private.is_member(id));
grant update (name, default_servings) on public.households to authenticated;
