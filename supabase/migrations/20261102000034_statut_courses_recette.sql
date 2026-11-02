-- Fiche recette : état de chaque ingrédient (hors facultatifs et produits de placard) pour la liste de courses —
-- acheté ces 7 derniers jours, déjà sur la liste. L'application compare en plus avec le stock estimé des propositions
-- (conservation propre à chaque produit) : ce qui y est encore est « normalement disponible », et le foyer peut quand même
-- le mettre sur la liste (« Je n'en ai plus ») s'il l'a consommé en dehors des menus prévus.
create or replace function public.recipe_shopping_status(p_household uuid, p_recipe_id uuid, p_servings integer default null)
returns table (ingredient_id uuid, slug text, label text, quantity numeric, unit text, bought_recently boolean, on_list boolean)
language sql stable security invoker set search_path = ''
as $$
  with v as (
    select rv.id, rv.servings from public.recipes r join public.recipe_versions rv on rv.id = r.current_version_id where r.id = p_recipe_id
  )
  select i.id, i.slug, ri.label,
         case when ri.base_quantity is null then null
              else greatest(1, round(ri.base_quantity * coalesce(p_servings, v.servings)::numeric / v.servings)) end,
         case when ri.base_quantity is null then null else ri.base_unit end,
         exists (select 1 from public.purchased_ingredients p
                 where p.household_id = p_household and p.ingredient_id = i.id and p.purchased_at > now() - interval '7 days'),
         exists (select 1 from public.shopping_list_status s
                 where s.household_id = p_household and s.ingredient_id = i.id and s.active and s.checked_at is null and s.bought_at is null
                   and s.created_at > now() - interval '21 days')
  from v
  join public.recipe_ingredients ri on ri.version_id = v.id
  join public.ingredients i on i.id = ri.ingredient_id
  where not ri.optional and not i.is_pantry_staple
  order by ri.position;
$$;
revoke all on function public.recipe_shopping_status(uuid, uuid, integer) from public, anon;
grant execute on function public.recipe_shopping_status(uuid, uuid, integer) to authenticated;
