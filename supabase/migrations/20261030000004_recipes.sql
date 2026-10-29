-- Base de recettes : identité, versions (jamais écrasées), ingrédients reliés au référentiel, avis du foyer.
-- Les recettes du jeu initial sont communes (household_id nul) ; un foyer les adapte en créant une variante.

alter table public.ingredients add column allergens text[] not null default '{}';

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references public.households(id) on delete cascade,
  slug text not null,
  source text not null check (source in ('seed', 'manual', 'import_text', 'import_url', 'import_photo', 'mistral')),
  source_ref text,
  parent_recipe_id uuid references public.recipes(id) on delete set null,
  current_version_id uuid,
  is_archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint recipes_slug_unique unique nulls not distinct (household_id, slug)
);
create index recipes_household_idx on public.recipes (household_id);
create index recipes_parent_idx on public.recipes (parent_recipe_id);
create index recipes_created_by_idx on public.recipes (created_by);

create table public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  version_no integer not null,
  name text not null check (char_length(name) between 2 and 120),
  description text,
  servings integer not null check (servings between 1 and 20),
  prep_min integer not null check (prep_min >= 0),
  cook_min integer not null check (cook_min >= 0),
  rest_min integer not null default 0 check (rest_min >= 0),
  total_min integer generated always as (prep_min + cook_min + rest_min) stored,
  difficulty smallint not null default 1 check (difficulty between 1 and 3),
  meal_types text[] not null check (meal_types <@ array['diner', 'dejeuner'] and cardinality(meal_types) > 0),
  main_protein text not null check (main_protein in ('volaille', 'boeuf', 'porc', 'poisson', 'fruits_de_mer', 'oeuf', 'legumineuse', 'vegetarien')),
  cuisine text,
  seasons text[] not null check (seasons <@ array['printemps', 'ete', 'automne', 'hiver'] and cardinality(seasons) > 0),
  tags text[] not null default '{}',
  allergens text[] not null default '{}',
  steps text[] not null check (cardinality(steps) > 0),
  change_note text,
  status text not null default 'validated' check (status in ('validated', 'draft')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (recipe_id, version_no)
);
create index recipe_versions_created_by_idx on public.recipe_versions (created_by);
alter table public.recipes add constraint recipes_current_version_fk
  foreign key (current_version_id) references public.recipe_versions(id) on delete set null;
create index recipes_current_version_idx on public.recipes (current_version_id);

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  version_id uuid not null references public.recipe_versions(id) on delete cascade,
  position integer not null,
  ingredient_id uuid references public.ingredients(id),
  label text not null,
  quantity numeric check (quantity > 0),
  unit text check (unit in ('g', 'ml', 'piece', 'cs', 'cc', 'pincee')),
  base_quantity numeric check (base_quantity > 0),
  base_unit text check (base_unit in ('g', 'ml', 'piece')),
  optional boolean not null default false,
  scale_mode text not null default 'linear' check (scale_mode in ('linear', 'sublinear', 'fixed')),
  unique (version_id, position)
);
create index recipe_ingredients_recipe_idx on public.recipe_ingredients (recipe_id);
create index recipe_ingredients_ingredient_idx on public.recipe_ingredients (ingredient_id);

create table public.recipe_ratings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  version_id uuid references public.recipe_versions(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  rating text not null check (rating in ('like', 'neutral', 'dislike')),
  comment text check (char_length(comment) <= 1000),
  rated_at timestamptz not null default now()
);
create index recipe_ratings_household_recipe_idx on public.recipe_ratings (household_id, recipe_id);
create index recipe_ratings_recipe_idx on public.recipe_ratings (recipe_id);
create index recipe_ratings_user_idx on public.recipe_ratings (user_id);
create index recipe_ratings_version_idx on public.recipe_ratings (version_id);

-- Accès : recettes communes lisibles par tous les utilisateurs connectés, recettes d'un foyer par ses membres.
create or replace function private.can_read_recipe(p_recipe_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.recipes r where r.id = p_recipe_id
                 and (r.household_id is null or private.is_member(r.household_id)));
$$;
revoke all on function private.can_read_recipe(uuid) from public, anon;
grant execute on function private.can_read_recipe(uuid) to authenticated;

alter table public.recipes enable row level security;
alter table public.recipe_versions enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_ratings enable row level security;
create policy recipes_select on public.recipes for select to authenticated
  using (household_id is null or private.is_member(household_id));
create policy recipe_versions_select on public.recipe_versions for select to authenticated
  using (private.can_read_recipe(recipe_id));
create policy recipe_ingredients_select on public.recipe_ingredients for select to authenticated
  using (private.can_read_recipe(recipe_id));
create policy recipe_ratings_select on public.recipe_ratings for select to authenticated
  using (private.is_member(household_id));
create policy recipe_ratings_insert on public.recipe_ratings for insert to authenticated
  with check (private.is_member(household_id) and user_id = (select auth.uid()) and private.can_read_recipe(recipe_id));
create policy recipe_ratings_update on public.recipe_ratings for update to authenticated
  using (user_id = (select auth.uid())) with check (private.is_member(household_id) and user_id = (select auth.uid()));
create policy recipe_ratings_delete on public.recipe_ratings for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.recipes, public.recipe_versions, public.recipe_ingredients, public.recipe_ratings from anon;
-- Recettes et versions ne s'écrivent que par les fonctions ci-dessous (versionnement garanti).
revoke insert, update, delete on public.recipes, public.recipe_versions, public.recipe_ingredients from authenticated;
grant select on public.recipes, public.recipe_versions, public.recipe_ingredients to authenticated;
grant select, insert, delete on public.recipe_ratings to authenticated;
grant update (rating, comment, rated_at) on public.recipe_ratings to authenticated;

-- Insère une version complète. Les allergènes sont recalculés à partir du référentiel (jamais repris du client).
create or replace function private.insert_recipe_version(p_recipe_id uuid, p jsonb, p_change_note text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  vid uuid;
  vno integer;
  ing jsonb;
  pos integer := 0;
  iid uuid;
begin
  select coalesce(max(version_no), 0) + 1 into vno from public.recipe_versions where recipe_id = p_recipe_id;
  insert into public.recipe_versions (recipe_id, version_no, name, description, servings, prep_min, cook_min, rest_min, difficulty,
    meal_types, main_protein, cuisine, seasons, tags, steps, change_note, status)
  values (p_recipe_id, vno, p->>'name', p->>'description', (p->>'servings')::int, (p->>'prep_min')::int, (p->>'cook_min')::int,
    coalesce((p->>'rest_min')::int, 0), coalesce((p->>'difficulty')::int, 1),
    array(select jsonb_array_elements_text(p->'meal_types')), p->>'main_protein', p->>'cuisine',
    array(select jsonb_array_elements_text(p->'seasons')), coalesce(array(select jsonb_array_elements_text(p->'tags')), '{}'),
    array(select jsonb_array_elements_text(p->'steps')), p_change_note, coalesce(p->>'status', 'validated'))
  returning id into vid;

  for ing in select * from jsonb_array_elements(p->'ingredients') loop
    pos := pos + 1;
    iid := null;
    if nullif(ing->>'slug', '') is not null then
      select id into iid from public.ingredients where slug = ing->>'slug';
      if iid is null then raise exception 'ingrédient inconnu : %', ing->>'slug'; end if;
    end if;
    insert into public.recipe_ingredients (recipe_id, version_id, position, ingredient_id, label, quantity, unit,
      base_quantity, base_unit, optional, scale_mode)
    values (p_recipe_id, vid, pos, iid, coalesce(ing->>'label', ing->>'slug'), nullif(ing->>'quantity', '')::numeric, ing->>'unit',
      nullif(ing->>'base_quantity', '')::numeric, ing->>'base_unit', coalesce((ing->>'optional')::boolean, false),
      coalesce(ing->>'scale', 'linear'));
  end loop;
  if pos = 0 then raise exception 'une recette doit avoir au moins un ingrédient'; end if;

  update public.recipe_versions v set allergens = coalesce((
    select array_agg(distinct a order by a) from public.recipe_ingredients ri
    join public.ingredients i on i.id = ri.ingredient_id, unnest(i.allergens) a
    where ri.version_id = vid and not ri.optional), '{}')
  where v.id = vid;
  update public.recipes set current_version_id = vid where id = p_recipe_id;
  return vid;
end;
$$;
revoke all on function private.insert_recipe_version(uuid, jsonb, text) from public, anon, authenticated;

-- Nouvelle recette d'un foyer (saisie, import, génération ou variante d'une recette existante).
create or replace function public.create_recipe(p_household uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  rid uuid;
  base_slug text := coalesce(nullif(p->>'slug', ''), 'recette');
  candidate text := base_slug;
  n integer := 1;
begin
  if not private.is_member(p_household) then raise exception 'accès refusé'; end if;
  if nullif(p->>'parent_recipe_id', '') is not null and not private.can_read_recipe((p->>'parent_recipe_id')::uuid) then
    raise exception 'recette d''origine inaccessible';
  end if;
  while exists (select 1 from public.recipes where household_id = p_household and slug = candidate) loop
    n := n + 1; candidate := base_slug || '-' || n;
  end loop;
  insert into public.recipes (household_id, slug, source, source_ref, parent_recipe_id)
  values (p_household, candidate, coalesce(p->>'source', 'manual'), p->>'source_ref', nullif(p->>'parent_recipe_id', '')::uuid)
  returning id into rid;
  perform private.insert_recipe_version(rid, p, coalesce(p->>'change_note', 'Version initiale'));
  return rid;
end;
$$;
revoke all on function public.create_recipe(uuid, jsonb) from public, anon;
grant execute on function public.create_recipe(uuid, jsonb) to authenticated;

-- Nouvelle version d'une recette du foyer : l'ancienne version est conservée.
create or replace function public.add_recipe_version(p_recipe_id uuid, p jsonb, p_change_note text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare hid uuid;
begin
  select household_id into hid from public.recipes where id = p_recipe_id;
  if hid is null or not private.is_member(hid) then
    raise exception 'seules les recettes du foyer peuvent recevoir une nouvelle version (créez une variante d''une recette commune)';
  end if;
  return private.insert_recipe_version(p_recipe_id, p, p_change_note);
end;
$$;
revoke all on function public.add_recipe_version(uuid, jsonb, text) from public, anon;
grant execute on function public.add_recipe_version(uuid, jsonb, text) to authenticated;

create or replace function public.set_recipe_archived(p_recipe_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare hid uuid;
begin
  select household_id into hid from public.recipes where id = p_recipe_id;
  if hid is null or not private.is_member(hid) then raise exception 'accès refusé'; end if;
  update public.recipes set is_archived = p_archived where id = p_recipe_id;
end;
$$;
revoke all on function public.set_recipe_archived(uuid, boolean) from public, anon;
grant execute on function public.set_recipe_archived(uuid, boolean) to authenticated;

-- Catalogue : chaque recette avec sa version courante.
create view public.recipe_catalog with (security_invoker = true) as
select r.id, r.household_id, r.slug, r.source, r.parent_recipe_id, v.id as version_id, v.version_no, v.name, v.description,
       v.servings, v.prep_min, v.cook_min, v.rest_min, v.total_min, v.difficulty, v.meal_types, v.main_protein, v.cuisine,
       v.seasons, v.tags, v.allergens
from public.recipes r join public.recipe_versions v on v.id = r.current_version_id
where not r.is_archived;
revoke all on public.recipe_catalog from anon;

-- Le pain compte désormais comme ingrédient des recettes (croque-monsieur, burgers, tartines).
create or replace view public.purchased_ingredients with (security_invoker = true) as
select ri.id as receipt_item_id, ri.household_id, r.purchased_at, p.id as product_id, p.display_name as product_name,
       i.id as ingredient_id, i.slug as ingredient_slug, i.name as ingredient_name, i.category,
       case when ri.weight_g is not null then 'g' else p.pack_unit end as unit,
       case when ri.weight_g is not null then round(ri.weight_g * pi.share, 1)
            when p.pack_quantity is not null then round(coalesce(ri.quantity, 1) * p.pack_quantity * pi.share, 1)
       end as quantity,
       case when ri.weight_g is not null then 'ticket_weight' else p.quantity_source end as quantity_source,
       case when ri.weight_g is not null then 1 else p.quantity_confidence end as quantity_confidence
from public.receipt_items ri
join public.receipts r on r.id = ri.receipt_id
join public.products p on p.id = ri.product_id
join public.product_ingredients pi on pi.product_id = p.id
join public.ingredients i on i.id = pi.ingredient_id
where p.role in ('ingredient', 'bread');

-- Propositions de recettes d'après les achats récents (en attendant le module de stocks) :
-- un ingrédient est considéré disponible s'il a été acheté dans les p_days derniers jours ou s'il fait partie
-- des ingrédients de base. Les allergènes exclus sont une contrainte stricte. Les avis du foyer départagent.
create or replace function public.recipe_candidates(
  p_household uuid, p_days integer default 7, p_max_missing integer default 2, p_meal_type text default 'diner',
  p_season text default null, p_max_total_min integer default null, p_excluded_allergens text[] default '{}')
returns table (recipe_id uuid, name text, total_min integer, main_protein text, required_count integer,
               available_count integer, missing_count integer, missing text[], unmapped text[], likes integer, dislikes integer)
language sql stable security invoker set search_path = ''
as $$
  with bought as (
    select distinct ingredient_id from public.purchased_ingredients
    where household_id = p_household and purchased_at >= now() - make_interval(days => p_days)
  ),
  req as (
    select c.id as recipe_id, ri.ingredient_id, ri.label,
           (ri.ingredient_id is null) as unmapped,
           (ri.ingredient_id in (select ingredient_id from bought) or coalesce(i.is_pantry_staple, false)) as available
    from public.recipe_catalog c
    join public.recipe_ingredients ri on ri.version_id = c.version_id and not ri.optional
    left join public.ingredients i on i.id = ri.ingredient_id
    where (c.household_id is null or c.household_id = p_household)
      and p_meal_type = any (c.meal_types)
      and (p_season is null or p_season = any (c.seasons))
      and (p_max_total_min is null or c.total_min <= p_max_total_min)
      and not (c.allergens && p_excluded_allergens)
  ),
  agg as (
    select recipe_id, count(*)::int as required_count, count(*) filter (where available)::int as available_count,
           count(*) filter (where not available and not unmapped)::int as missing_count,
           coalesce(array_agg(label order by label) filter (where not available and not unmapped), '{}') as missing,
           coalesce(array_agg(label order by label) filter (where unmapped), '{}') as unmapped
    from req group by recipe_id
  )
  select a.recipe_id, c.name, c.total_min, c.main_protein, a.required_count, a.available_count, a.missing_count, a.missing, a.unmapped,
         coalesce((select count(*) from public.recipe_ratings rr where rr.recipe_id = a.recipe_id and rr.household_id = p_household and rr.rating = 'like'), 0)::int,
         coalesce((select count(*) from public.recipe_ratings rr where rr.recipe_id = a.recipe_id and rr.household_id = p_household and rr.rating = 'dislike'), 0)::int
  from agg a join public.recipe_catalog c on c.id = a.recipe_id
  where a.missing_count <= p_max_missing
  order by a.missing_count, 10 desc, 11, c.total_min;
$$;
grant execute on function public.recipe_candidates(uuid, integer, integer, text, text, integer, text[]) to authenticated;
revoke execute on function public.recipe_candidates(uuid, integer, integer, text, text, integer, text[]) from anon, public;
