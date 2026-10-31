-- Fiche recette MenuMalin : favoris du foyer (cœur dans la bande verte) et « Ajouter à ma liste ».

create table public.recipe_favorites (
  household_id uuid not null references public.households(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (household_id, recipe_id)
);
create index recipe_favorites_recipe_idx on public.recipe_favorites (recipe_id);
alter table public.recipe_favorites enable row level security;
create policy recipe_favorites_select on public.recipe_favorites for select to authenticated using (private.is_member(household_id));
create policy recipe_favorites_insert on public.recipe_favorites for insert to authenticated
  with check (private.is_member(household_id) and private.can_read_recipe(recipe_id));
create policy recipe_favorites_delete on public.recipe_favorites for delete to authenticated using (private.is_member(household_id));
revoke all on public.recipe_favorites from anon;
grant select, insert, delete on public.recipe_favorites to authenticated;

-- Ingrédients d'une recette à acheter : ni de placard, ni achetés ces 7 derniers jours ; quantités en g, ml ou pièces pour
-- le nombre de personnes ; on_list : déjà sur la liste de courses (non coché, non acheté).
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
                 where s.household_id = p_household and s.ingredient_id = i.id and s.checked_at is null and s.bought_at is null
                   and s.created_at > now() - interval '21 days')
  from v
  join public.recipe_ingredients ri on ri.version_id = v.id
  join public.ingredients i on i.id = ri.ingredient_id
  where not ri.optional and not i.is_pantry_staple
    and not exists (select 1 from public.purchased_ingredients p
                    where p.household_id = p_household and p.ingredient_id = i.id and p.purchased_at > now() - interval '7 days')
  order by ri.position;
$$;
revoke all on function public.recipe_shopping_needs(uuid, uuid, integer) from public, anon;
grant execute on function public.recipe_shopping_needs(uuid, uuid, integer) to authenticated;

-- Ajoute à la liste de courses les ingrédients à acheter qui n'y sont pas encore ; renvoie le nombre d'articles ajoutés.
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
  insert into public.shopping_list_items (household_id, ingredient_id, label, quantity, unit)
  select p_household, n.ingredient_id, n.label, n.quantity, n.unit
  from public.recipe_shopping_needs(p_household, p_recipe_id, p_servings) n
  where not n.on_list;
  get diagnostics added = row_count;
  return added;
end;
$$;
revoke all on function public.add_recipe_to_shopping_list(uuid, uuid, integer) from public, anon;
grant execute on function public.add_recipe_to_shopping_list(uuid, uuid, integer) to authenticated;
