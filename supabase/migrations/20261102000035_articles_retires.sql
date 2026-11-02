-- Liste de courses assouplie : le foyer peut retirer un article (il ne compte plus « à acheter ») ; la fiche recette le
-- signale discrètement et propose de le remettre. L'article n'est pas effacé : removed_at garde la trace du retrait.
alter table public.shopping_list_items add column if not exists removed_at timestamptz;

-- Un article retiré n'est plus actif (ni à acheter, ni compté) ; removed_at est exposé en fin de vue.
create or replace view public.shopping_list_status with (security_invoker = true) as
  select s.id, s.household_id, s.slot_id, s.ingredient_id, s.label, s.quantity, s.unit, s.created_at, s.checked_at,
         (select min(p.purchased_at) from public.purchased_ingredients p
          where p.household_id = s.household_id and p.ingredient_id = s.ingredient_id and p.purchased_at >= s.created_at) as bought_at,
         s.recipe_id, m.meal_date,
         s.removed_at is null and case
           when s.slot_id is not null then m.status = 'accepted' and m.meal_date >= (now() at time zone 'Europe/Paris')::date
           else s.recipe_id is not null
         end as active,
         s.removed_at
  from public.shopping_list_items s
  left join public.meal_slots m on m.id = s.slot_id;

-- État des ingrédients d'une recette pour la fiche (remplace recipe_shopping_status, gardée pour les versions 0.21 de
-- l'application) : removed = un article de cette recette (ou de son menu à venir) a été retiré de la liste et n'y est
-- plus ; removed_items = ces articles, pour les remettre.
create or replace function public.recipe_shopping_state(p_household uuid, p_recipe_id uuid, p_servings integer default null)
returns table (ingredient_id uuid, slug text, label text, quantity numeric, unit text, bought_recently boolean, on_list boolean,
               removed boolean, removed_items uuid[])
language sql stable security invoker set search_path = ''
as $$
  with v as (
    select rv.id, rv.servings from public.recipes r join public.recipe_versions rv on rv.id = r.current_version_id where r.id = p_recipe_id
  ),
  ing as (
    select i.id, i.slug, ri.label, ri.position,
           case when ri.base_quantity is null then null
                else greatest(1, round(ri.base_quantity * coalesce(p_servings, v.servings)::numeric / v.servings)) end as quantity,
           case when ri.base_quantity is null then null else ri.base_unit end as unit,
           exists (select 1 from public.purchased_ingredients p
                   where p.household_id = p_household and p.ingredient_id = i.id and p.purchased_at > now() - interval '7 days') as bought_recently,
           exists (select 1 from public.shopping_list_status s
                   where s.household_id = p_household and s.ingredient_id = i.id and s.active and s.checked_at is null and s.bought_at is null
                     and s.created_at > now() - interval '21 days') as on_list,
           array(select s.id from public.shopping_list_items s left join public.meal_slots m on m.id = s.slot_id
                 where s.household_id = p_household and s.ingredient_id = i.id and s.removed_at is not null
                   and s.created_at > now() - interval '21 days'
                   and (s.recipe_id = p_recipe_id
                        or (m.recipe_id = p_recipe_id and m.status = 'accepted' and m.meal_date >= (now() at time zone 'Europe/Paris')::date))) as removed_items
    from v
    join public.recipe_ingredients ri on ri.version_id = v.id
    join public.ingredients i on i.id = ri.ingredient_id
    where not ri.optional and not i.is_pantry_staple
  )
  select id, slug, label, quantity, unit, bought_recently, on_list, not on_list and cardinality(removed_items) > 0, removed_items
  from ing order by position;
$$;
revoke all on function public.recipe_shopping_state(uuid, uuid, integer) from public, anon;
grant execute on function public.recipe_shopping_state(uuid, uuid, integer) to authenticated;
