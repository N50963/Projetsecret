-- Recettes supprimées par le foyer (fiche de la recette, ou appui long dans l'onglet Recettes).
-- La recette est masquée pour le foyer plutôt qu'effacée : une recette commune est partagée par tous les foyers, et les
-- menus déjà prévus avec elle restent lisibles (nom, fiche, liste de courses). Le foyer ne la voit plus dans l'onglet
-- Recettes ni dans les propositions ; il peut la remettre depuis sa fiche.
create table public.hidden_recipes (
  household_id uuid not null references public.households(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (household_id, recipe_id)
);
comment on table public.hidden_recipes is 'Recettes supprimées par le foyer : absentes de l''onglet Recettes et des propositions.';
create index hidden_recipes_recipe_idx on public.hidden_recipes (recipe_id);
alter table public.hidden_recipes enable row level security;
create policy hidden_recipes_select on public.hidden_recipes for select to authenticated using (private.is_member(household_id));
create policy hidden_recipes_insert on public.hidden_recipes for insert to authenticated
  with check (private.is_member(household_id) and private.can_read_recipe(recipe_id));
create policy hidden_recipes_delete on public.hidden_recipes for delete to authenticated using (private.is_member(household_id));
grant select, insert, delete on public.hidden_recipes to authenticated;
