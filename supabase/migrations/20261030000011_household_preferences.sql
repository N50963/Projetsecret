-- Préférences alimentaires du foyer, utilisées pour filtrer et adapter les propositions de repas.
create table public.household_preferences (
  household_id uuid primary key references public.households(id) on delete cascade,
  adults smallint not null default 2 check (adults between 0 and 20),
  teens smallint not null default 0 check (teens between 0 and 20),
  children smallint not null default 0 check (children between 0 and 20),
  -- Allergènes à exclure strictement (codes de la liste UE du référentiel : gluten, lait, fruits_a_coque...).
  excluded_allergens text[] not null default '{}',
  -- Groupes d'aliments à ne jamais proposer, au-delà des allergènes.
  excluded_food_groups text[] not null default '{}'
    check (excluded_food_groups <@ array['abats', 'coquillages', 'crustaces', 'porc', 'boeuf', 'agneau', 'poisson', 'champignons']::text[]),
  -- Ingrédients du référentiel (slugs) que quelqu'un n'aime pas.
  disliked_ingredients text[] not null default '{}',
  -- aucun : rien d'épicé (curry, piment) ; doux : épices douces seulement ; tout : pas de limite.
  spice_level text not null default 'tout' check (spice_level in ('aucun', 'doux', 'tout')),
  meatless_dinners_min smallint not null default 0 check (meatless_dinners_min between 0 and 7),
  meatless_dinners_max smallint not null default 7 check (meatless_dinners_max between 0 and 7),
  shopping_interval_days smallint not null default 7 check (shopping_interval_days between 1 and 31),
  -- Faux : les tickets Lidl couvrent presque tous les achats d'ingrédients.
  shops_outside_lidl boolean not null default false,
  -- Faux : viande et poisson frais sont mangés dans la semaine, pas congelés.
  freezes_fresh_meat_fish boolean not null default false,
  -- Date à laquelle le foyer a confirmé la liste des produits de base toujours présents (ingredients.is_pantry_staple).
  pantry_confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (meatless_dinners_min <= meatless_dinners_max)
);

alter table public.household_preferences enable row level security;
create policy household_preferences_select on public.household_preferences for select to authenticated
  using (private.is_member(household_id));
create policy household_preferences_insert on public.household_preferences for insert to authenticated
  with check (private.is_member(household_id));
create policy household_preferences_update on public.household_preferences for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
revoke all on public.household_preferences from anon;
grant select, insert, update on public.household_preferences to authenticated;
