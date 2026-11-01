-- Module de correction des produits Lidl : à l'import des tickets, les nouveaux produits sont à vérifier (ce que MenuMalin
-- a compris : rôle et ingrédients) ; le foyer corrige ce qui est mal compris ou inconnu. Une correction vaut pour tous les
-- achats du produit, passés et futurs, et prime sur les règles de classement.

alter table public.products add column reviewed_at timestamptz;
-- Produits déjà connus : considérés comme vérifiés (ils restent corrigeables par la recherche de l'écran).
update public.products set reviewed_at = now();
grant update (reviewed_at) on public.products to authenticated;

-- Nouveaux produits à vérifier, avec ce que MenuMalin en a compris. « unknown » : rôle ou ingrédient non trouvé.
create view public.products_to_review with (security_invoker = true) as
select p.id, p.household_id, p.label_raw, p.display_name, p.name_status, p.role, p.first_seen, p.last_seen, p.times_bought,
       coalesce(array_agg(i.slug order by i.slug) filter (where i.slug is not null), '{}') as ingredient_slugs,
       coalesce(array_agg(i.name order by i.slug) filter (where i.name is not null), '{}') as ingredient_names,
       (p.role is null or (p.role = 'ingredient' and count(i.id) = 0)) as unknown
from public.products p
left join public.product_ingredients pi on pi.product_id = p.id
left join public.ingredients i on i.id = pi.ingredient_id
where p.reviewed_at is null and p.kind = 'food'
group by p.id;
revoke all on public.products_to_review from anon;

-- Correction d'un produit par le foyer : nom lisible, rôle, ingrédients contenus.
create or replace function public.correct_product(p_product uuid, p_display_name text, p_role text, p_ingredients text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pr record;
  n integer;
begin
  select id, household_id, lidl_art_id, label_raw into pr from public.products where id = p_product;
  if pr.id is null or not private.is_member(pr.household_id) then
    raise exception 'Produit introuvable.';
  end if;
  if p_role is null or p_role not in ('ingredient', 'prepared_meal', 'dessert', 'snack', 'breakfast', 'beverage', 'bread', 'non_food') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  select count(*) into n from public.ingredients where slug = any (coalesce(p_ingredients, '{}'));
  if p_role = 'ingredient' and n = 0 then
    raise exception 'Choisissez au moins un ingrédient.';
  end if;
  update public.products set
    display_name = coalesce(left(nullif(btrim(p_display_name), ''), 120), display_name),
    name_status = 'confirmed', role = p_role, role_source = 'user', reviewed_at = now(), updated_at = now(),
    kind = case when p_role = 'non_food' then 'non_food' else 'food' end
  where id = pr.id;
  delete from public.product_ingredients where product_id = pr.id;
  if p_role = 'ingredient' then
    insert into public.product_ingredients (product_id, ingredient_id, household_id, share, source)
    select pr.id, i.id, pr.household_id, round(1.0 / n, 4), 'user' from public.ingredients i where i.slug = any (p_ingredients);
  end if;
  -- Non alimentaire : ignoré par les prochains tickets.
  if p_role = 'non_food' then
    insert into public.excluded_products (household_id, lidl_art_id, label_raw, reason)
    values (pr.household_id, pr.lidl_art_id, pr.label_raw, 'user') on conflict do nothing;
  end if;
end;
$$;
revoke all on function public.correct_product(uuid, text, text, text[]) from public, anon;
grant execute on function public.correct_product(uuid, text, text, text[]) to authenticated;

-- Produits bien compris : validés tels quels.
create or replace function public.confirm_products(p_products uuid[])
returns integer
language sql security definer set search_path = ''
as $$
  with done as (
    update public.products set reviewed_at = now()
    where id = any (p_products) and reviewed_at is null and private.is_member(household_id)
    returning 1
  )
  select count(*)::int from done;
$$;
revoke all on function public.confirm_products(uuid[]) from public, anon;
grant execute on function public.confirm_products(uuid[]) to authenticated;
