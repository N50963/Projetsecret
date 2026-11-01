-- Liste de courses : n'afficher « à acheter » que ce qui sert un menu choisi à venir (ou une recette ajoutée depuis sa
-- fiche). Avant, un article restait à acheter après l'annulation ou la suppression de son repas (lien vidé), et après la
-- date du repas.

-- Articles ajoutés depuis une fiche (« Ajouter à ma liste ») : rattachés à leur recette.
alter table public.shopping_list_items add column recipe_id uuid references public.recipes(id) on delete cascade;
create index shopping_list_items_recipe_idx on public.shopping_list_items (recipe_id);

-- Repas supprimé : ses articles partent avec lui (au lieu de rester sans repas).
alter table public.shopping_list_items drop constraint shopping_list_items_slot_id_fkey;
alter table public.shopping_list_items add constraint shopping_list_items_slot_id_fkey
  foreign key (slot_id) references public.meal_slots(id) on delete cascade;

-- Articles orphelins (ni repas, ni recette) jamais cochés : plus rien ne les justifie.
delete from public.shopping_list_items where slot_id is null and checked_at is null;

-- active : l'article sert un menu choisi dont la date n'est pas passée, ou une recette ajoutée depuis sa fiche.
create or replace view public.shopping_list_status with (security_invoker = true) as
select s.id, s.household_id, s.slot_id, s.ingredient_id, s.label, s.quantity, s.unit, s.created_at, s.checked_at,
       (select min(p.purchased_at) from public.purchased_ingredients p
        where p.household_id = s.household_id and p.ingredient_id = s.ingredient_id and p.purchased_at >= s.created_at) as bought_at,
       s.recipe_id, m.meal_date,
       case when s.slot_id is not null then m.status = 'accepted' and m.meal_date >= (now() at time zone 'Europe/Paris')::date
            else s.recipe_id is not null end as active
from public.shopping_list_items s
left join public.meal_slots m on m.id = s.slot_id;

-- « Déjà sur la liste » : seulement les articles encore utiles.
create or replace function public.recipe_shopping_needs(p_household uuid, p_recipe_id uuid, p_servings integer default null)
returns table (ingredient_id uuid, slug text, label text, quantity numeric, unit text, on_list boolean)
language sql stable security invoker set search_path = ''
as $$
  with v as (
    select rv.id, rv.servings from public.recipes r join public.recipe_versions rv on rv.id = r.current_version_id where r.id = p_recipe_id
  )
  select i.id, i.slug, ri.label,
         case when ri.base_quantity is null then null
              else greatest(1, round(ri.base_quantity * coalesce(p_servings, v.servings)::numeric / v.servings)) end,
         case when ri.base_quantity is null then null else ri.base_unit end,
         exists (select 1 from public.shopping_list_status s
                 where s.household_id = p_household and s.ingredient_id = i.id and s.active and s.checked_at is null and s.bought_at is null
                   and s.created_at > now() - interval '21 days')
  from v
  join public.recipe_ingredients ri on ri.version_id = v.id
  join public.ingredients i on i.id = ri.ingredient_id
  where not ri.optional and not i.is_pantry_staple
    and not exists (select 1 from public.purchased_ingredients p
                    where p.household_id = p_household and p.ingredient_id = i.id and p.purchased_at > now() - interval '7 days')
  order by ri.position;
$$;

-- « Ajouter à ma liste » : les articles gardent le lien vers leur recette.
create or replace function public.add_recipe_to_shopping_list(p_household uuid, p_recipe_id uuid, p_servings integer default null)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  added integer;
begin
  if not private.is_member(p_household) then
    raise exception 'Foyer inaccessible' using errcode = '42501';
  end if;
  insert into public.shopping_list_items (household_id, ingredient_id, label, quantity, unit, recipe_id)
  select p_household, n.ingredient_id, n.label, n.quantity, n.unit, p_recipe_id
  from public.recipe_shopping_needs(p_household, p_recipe_id, p_servings) n
  where not n.on_list;
  get diagnostics added = row_count;
  return added;
end;
$$;
