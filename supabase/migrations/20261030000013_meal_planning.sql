-- Planification des repas : semaine, repas à pourvoir, propositions présentées (swipe), liste de courses, illustrations.

-- Une planification couvre les repas choisis entre deux dates (en général la semaine qui suit les courses).
create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (household_id, start_date),
  check (end_date >= start_date and end_date - start_date <= 13)
);
create index meal_plans_created_by_idx on public.meal_plans (created_by);

-- Un repas pour lequel un menu est demandé, avec le temps total disponible (préparation + cuisson).
create table public.meal_slots (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.meal_plans(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  meal_date date not null,
  meal_type text not null check (meal_type in ('diner', 'dejeuner')),
  max_total_min integer check (max_total_min between 5 and 300),
  servings smallint not null default 4 check (servings between 1 and 20),
  status text not null default 'open' check (status in ('open', 'accepted', 'skipped')),
  recipe_id uuid references public.recipes(id) on delete set null,
  version_id uuid references public.recipe_versions(id) on delete set null,
  accepted_at timestamptz,
  unique (household_id, meal_date, meal_type),
  check (status <> 'accepted' or recipe_id is not null)
);
create index meal_slots_plan_idx on public.meal_slots (plan_id);
create index meal_slots_recipe_idx on public.meal_slots (recipe_id);
create index meal_slots_version_idx on public.meal_slots (version_id);

-- Propositions montrées pour un repas : tour 1 avec les achats, tour 2 avec 1 à 3 ingrédients à acheter.
-- Les refus servent à ne pas reproposer la même recette et à repérer ce que le foyer écarte souvent.
create table public.meal_proposals (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.meal_slots(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  round smallint not null check (round in (1, 2)),
  rank smallint not null check (rank >= 0),
  score numeric,
  missing text[] not null default '{}',
  decision text check (decision in ('accepted', 'rejected')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (slot_id, recipe_id)
);
create index meal_proposals_household_idx on public.meal_proposals (household_id);
create index meal_proposals_recipe_idx on public.meal_proposals (recipe_id);

-- Liste de courses : ingrédients manquants des repas acceptés, ou ajoutés à la main.
create table public.shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  slot_id uuid references public.meal_slots(id) on delete set null,
  ingredient_id uuid references public.ingredients(id),
  label text not null check (char_length(label) between 1 and 200),
  quantity numeric check (quantity > 0),
  unit text check (unit in ('g', 'ml', 'piece')),
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index shopping_list_items_household_idx on public.shopping_list_items (household_id, created_at desc);
create index shopping_list_items_slot_idx on public.shopping_list_items (slot_id);
create index shopping_list_items_ingredient_idx on public.shopping_list_items (ingredient_id);

-- Liste comparée aux tickets : un article est acheté si son ingrédient figure sur un ticket postérieur à son ajout.
create view public.shopping_list_status with (security_invoker = true) as
select s.id, s.household_id, s.slot_id, s.ingredient_id, s.label, s.quantity, s.unit, s.created_at, s.checked_at,
       (select min(p.purchased_at) from public.purchased_ingredients p
        where p.household_id = s.household_id and p.ingredient_id = s.ingredient_id and p.purchased_at >= s.created_at) as bought_at
from public.shopping_list_items s;

-- Illustration d'une recette : commune (household_id nul, créée côté serveur) ou propre au foyer (photo, image générée).
create table public.recipe_images (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade,
  storage_path text not null,
  source text not null check (source in ('mistral', 'photo')),
  created_at timestamptz not null default now(),
  constraint recipe_images_unique unique nulls not distinct (recipe_id, household_id)
);
create index recipe_images_household_idx on public.recipe_images (household_id);

alter table public.meal_plans enable row level security;
alter table public.meal_slots enable row level security;
alter table public.meal_proposals enable row level security;
alter table public.shopping_list_items enable row level security;
alter table public.recipe_images enable row level security;

create policy meal_plans_select on public.meal_plans for select to authenticated using (private.is_member(household_id));
create policy meal_plans_insert on public.meal_plans for insert to authenticated with check (private.is_member(household_id));
create policy meal_plans_update on public.meal_plans for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy meal_plans_delete on public.meal_plans for delete to authenticated using (private.is_member(household_id));

create policy meal_slots_select on public.meal_slots for select to authenticated using (private.is_member(household_id));
create policy meal_slots_insert on public.meal_slots for insert to authenticated with check (private.is_member(household_id));
create policy meal_slots_update on public.meal_slots for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy meal_slots_delete on public.meal_slots for delete to authenticated using (private.is_member(household_id));

create policy meal_proposals_select on public.meal_proposals for select to authenticated using (private.is_member(household_id));
create policy meal_proposals_insert on public.meal_proposals for insert to authenticated with check (private.is_member(household_id));
create policy meal_proposals_update on public.meal_proposals for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy meal_proposals_delete on public.meal_proposals for delete to authenticated using (private.is_member(household_id));

create policy shopping_list_items_select on public.shopping_list_items for select to authenticated using (private.is_member(household_id));
create policy shopping_list_items_insert on public.shopping_list_items for insert to authenticated with check (private.is_member(household_id));
create policy shopping_list_items_update on public.shopping_list_items for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy shopping_list_items_delete on public.shopping_list_items for delete to authenticated using (private.is_member(household_id));

-- Les illustrations communes sont lisibles par tous les comptes ; seules celles du foyer sont modifiables.
create policy recipe_images_select on public.recipe_images for select to authenticated
  using (household_id is null or private.is_member(household_id));
create policy recipe_images_insert on public.recipe_images for insert to authenticated with check (private.is_member(household_id));
create policy recipe_images_update on public.recipe_images for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy recipe_images_delete on public.recipe_images for delete to authenticated using (private.is_member(household_id));

revoke all on public.meal_plans, public.meal_slots, public.meal_proposals, public.shopping_list_items, public.recipe_images,
  public.shopping_list_status from anon;
grant select, insert, update, delete on public.meal_plans, public.meal_slots, public.meal_proposals, public.shopping_list_items,
  public.recipe_images to authenticated;
grant select on public.shopping_list_status to authenticated;

-- Accepter une proposition (swipe à droite) : le repas reçoit la recette, ses ingrédients manquants vont sur la liste de courses.
-- p_missing : [{"slug": "...", "label": "...", "quantity": 200, "unit": "g"}]. Droits de l'appelant (RLS).
create or replace function public.accept_meal_proposal(p_slot_id uuid, p_recipe_id uuid, p_missing jsonb default '[]')
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  s record;
  vid uuid;
begin
  select id, household_id into s from public.meal_slots where id = p_slot_id;
  if s.id is null then raise exception 'repas introuvable'; end if;
  select current_version_id into vid from public.recipes where id = p_recipe_id and not is_archived;
  if vid is null then raise exception 'recette introuvable'; end if;

  update public.meal_proposals set decision = 'rejected', decided_at = now()
  where slot_id = p_slot_id and decision = 'accepted' and recipe_id <> p_recipe_id;
  insert into public.meal_proposals (slot_id, household_id, recipe_id, round, rank, decision, decided_at)
  values (p_slot_id, s.household_id, p_recipe_id, 1, 0, 'accepted', now())
  on conflict (slot_id, recipe_id) do update set decision = 'accepted', decided_at = now();

  -- Un changement d'avis remplace les articles non cochés de l'ancien choix.
  delete from public.shopping_list_items where slot_id = p_slot_id and checked_at is null;
  update public.meal_slots set status = 'accepted', recipe_id = p_recipe_id, version_id = vid, accepted_at = now()
  where id = p_slot_id;
  insert into public.shopping_list_items (household_id, slot_id, ingredient_id, label, quantity, unit)
  select s.household_id, p_slot_id, i.id, coalesce(nullif(m->>'label', ''), i.name, m->>'slug'),
         nullif(m->>'quantity', '')::numeric, nullif(m->>'unit', '')
  from jsonb_array_elements(coalesce(p_missing, '[]'::jsonb)) m
  left join public.ingredients i on i.slug = m->>'slug';
  return vid;
end;
$$;
revoke all on function public.accept_meal_proposal(uuid, uuid, jsonb) from public, anon;
grant execute on function public.accept_meal_proposal(uuid, uuid, jsonb) to authenticated;

-- Stockage des illustrations : common/<recipe_id>.png (serveur) ou <household_id>/<recipe_id>.<ext> (foyer).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-images', 'recipe-images', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy recipe_images_read on storage.objects for select to authenticated
  using (bucket_id = 'recipe-images' and ((storage.foldername(name))[1] = 'common' or exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1])));
create policy recipe_images_write on storage.objects for insert to authenticated
  with check (bucket_id = 'recipe-images' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
create policy recipe_images_change on storage.objects for update to authenticated
  using (bucket_id = 'recipe-images' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
create policy recipe_images_remove on storage.objects for delete to authenticated
  using (bucket_id = 'recipe-images' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
