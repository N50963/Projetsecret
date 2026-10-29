-- Normalisation des achats : référentiel d'ingrédients, rôle et contenance des produits, ingrédients achetés.
-- Les règles de classement sont copiées depuis services/catalog/referential.py (migration de données suivante).

-- Référentiel commun d'ingrédients culinaires (lecture seule pour l'application).
create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text not null,
  default_unit text not null check (default_unit in ('g', 'ml', 'piece')),
  is_pantry_staple boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.ingredients enable row level security;
create policy ingredients_select on public.ingredients for select to authenticated using (true);
revoke all on public.ingredients from anon;

-- Règles de classement : la première règle (priorité la plus basse) dont le motif correspond l'emporte.
create table private.ingredient_rules (
  priority integer primary key,
  pattern text not null,
  role text not null,
  ingredient_slugs text[] not null default '{}'
);

-- Même normalisation que referential.normalize() en Python.
create or replace function private.norm_label(p text)
returns text
language sql immutable set search_path = ''
as $$
  select ' ' || btrim(regexp_replace(
    translate(lower(replace(replace(replace(replace(coalesce(p, ''), 'œ', 'oe'), 'Œ', 'oe'), 'æ', 'ae'), 'Æ', 'ae')),
              'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
    '[^a-z0-9]+', ' ', 'g')) || ' ';
$$;

create or replace function private.classify_product(p_name text)
returns table (role text, ingredient_slugs text[])
language sql stable set search_path = ''
as $$
  select r.role, r.ingredient_slugs from private.ingredient_rules r
  where private.norm_label(p_name) ~ r.pattern
  order by r.priority limit 1;
$$;

-- Rôle et contenance des produits.
alter table public.products
  add column role text check (role in ('ingredient', 'prepared_meal', 'dessert', 'snack', 'breakfast', 'beverage', 'bread', 'non_food')),
  add column role_source text check (role_source in ('rules', 'user')),
  add column pack_quantity numeric check (pack_quantity > 0),
  add column pack_unit text check (pack_unit in ('g', 'ml', 'piece')),
  add column quantity_source text check (quantity_source in ('label', 'ticket_weight', 'unit_sale', 'openfoodfacts', 'user')),
  add column quantity_confidence numeric check (quantity_confidence between 0 and 1),
  add column pack_formats text[] not null default '{}',
  add column off_code text,
  add column off_name text;
create index products_role_idx on public.products (household_id, role);

-- Ingrédients contenus dans un produit (plusieurs pour « Petits pois carottes », avec leur part).
create table public.product_ingredients (
  product_id uuid not null references public.products(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id),
  household_id uuid not null references public.households(id) on delete cascade,
  share numeric not null default 1 check (share > 0 and share <= 1),
  source text not null default 'rules' check (source in ('rules', 'user')),
  primary key (product_id, ingredient_id)
);
create index product_ingredients_ingredient_idx on public.product_ingredients (ingredient_id);
create index product_ingredients_household_idx on public.product_ingredients (household_id);
alter table public.product_ingredients enable row level security;
create policy product_ingredients_select on public.product_ingredients for select to authenticated
  using (private.is_member(household_id));
create policy product_ingredients_write on public.product_ingredients for all to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
revoke all on public.product_ingredients from anon;

-- Corrections possibles depuis l'application.
revoke update on public.products from authenticated;
grant update (display_name, name_status, kind, role, role_source, pack_quantity, pack_unit, quantity_source,
              quantity_confidence, updated_at) on public.products to authenticated;

-- Applique les règles à un produit (sauf s'il a été corrigé par l'utilisateur).
create or replace function private.apply_rules_to_product(p_product_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  pr record;
  c record;
  n integer;
begin
  select id, household_id, display_name, role_source into pr from public.products where id = p_product_id;
  if pr.id is null or pr.role_source = 'user' then return null; end if;
  select * into c from private.classify_product(pr.display_name);
  update public.products set role = c.role, role_source = case when c.role is null then null else 'rules' end,
    kind = case when c.role = 'non_food' then 'non_food' else kind end, updated_at = now()
  where id = pr.id;
  delete from public.product_ingredients where product_id = pr.id and source = 'rules';
  n := coalesce(array_length(c.ingredient_slugs, 1), 0);
  if n > 0 then
    insert into public.product_ingredients (product_id, ingredient_id, household_id, share, source)
    select pr.id, i.id, pr.household_id, round(1.0 / n, 4), 'rules'
    from public.ingredients i where i.slug = any (c.ingredient_slugs)
    on conflict (product_id, ingredient_id) do nothing;
  end if;
  return c.role;
end;
$$;
revoke all on function private.apply_rules_to_product(uuid) from public, anon, authenticated;

-- Import d'un ticket : classe les nouveaux produits, retient la contenance lue sur le ticket,
-- et écarte automatiquement les produits non alimentaires (liste d'exclusion).
create or replace function private.upsert_receipt_core(hid uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  rid uuid;
  it jsonb;
  pid uuid;
  is_new boolean;
  prole text;
  net integer;
  sav integer;
  nf integer := 0;
begin
  select coalesce(sum((i->>'line_total_cents')::int + (i->>'discount_cents')::int), 0),
         coalesce(-sum((i->>'discount_cents')::int), 0)
    into net, sav
    from jsonb_array_elements(p->'items') i;

  insert into public.receipts as r (household_id, external_id, purchased_at, store_id, store_name, store_locality,
    store_postal_code, total_cents, items_net_cents, reconciled, savings_cents, articles_count, parser_version)
  values (hid, p->>'external_id', (p->>'purchased_at')::timestamptz, p#>>'{store,id}', p#>>'{store,name}',
    p#>>'{store,locality}', p#>>'{store,postal_code}', (p->>'total_cents')::int, net,
    net = (p->>'total_cents')::int, sav, nullif(p->>'articles_count', '')::int, (p->>'parser_version')::int)
  on conflict (household_id, source, external_id) do update set
    purchased_at = excluded.purchased_at, store_id = excluded.store_id, store_name = excluded.store_name,
    store_locality = excluded.store_locality, store_postal_code = excluded.store_postal_code,
    total_cents = excluded.total_cents, items_net_cents = excluded.items_net_cents,
    reconciled = excluded.reconciled, savings_cents = excluded.savings_cents,
    articles_count = excluded.articles_count, parser_version = excluded.parser_version, fetched_at = now()
  returning r.id into rid;

  if p ? 'detail' then
    insert into public.receipt_raw (receipt_id, household_id, detail) values (rid, hid, p->'detail')
    on conflict (receipt_id) do update set detail = excluded.detail;
  end if;

  delete from public.receipt_items where receipt_id = rid;
  for it in select * from jsonb_array_elements(p->'items') loop
    if exists (select 1 from public.excluded_products e
               where e.household_id = hid and e.lidl_art_id = it->>'art_id' and e.label_raw = it->>'label_raw') then
      nf := nf + (it->>'line_total_cents')::int + (it->>'discount_cents')::int;
      continue;
    end if;
    pid := null;
    insert into public.products (household_id, lidl_art_id, label_raw, display_name, name_status, is_weighed)
    values (hid, it->>'art_id', it->>'label_raw', it->>'label_raw',
            case when char_length(it->>'label_raw') >= 20 then 'to_confirm' else 'ok' end,
            (it->>'weight_g') is not null)
    on conflict (household_id, lidl_art_id, label_raw) do nothing
    returning id into pid;
    is_new := pid is not null;
    if is_new then
      prole := private.apply_rules_to_product(pid);
      if prole = 'non_food' then
        insert into public.excluded_products (household_id, lidl_art_id, label_raw)
        values (hid, it->>'art_id', it->>'label_raw') on conflict do nothing;
        delete from public.products where id = pid;
        nf := nf + (it->>'line_total_cents')::int + (it->>'discount_cents')::int;
        continue;
      end if;
      if (it->>'weight_g') is not null then
        update public.products set pack_unit = 'g', quantity_source = 'ticket_weight', quantity_confidence = 1 where id = pid;
      elsif nullif(it->>'pack_quantity', '') is not null then
        update public.products set pack_quantity = (it->>'pack_quantity')::numeric, pack_unit = it->>'pack_unit',
          quantity_source = 'label', quantity_confidence = 1 where id = pid;
      end if;
    else
      select id into pid from public.products
      where household_id = hid and lidl_art_id = it->>'art_id' and label_raw = it->>'label_raw';
      update public.products set is_weighed = true where id = pid and not is_weighed and (it->>'weight_g') is not null;
    end if;
    insert into public.receipt_items (receipt_id, household_id, line_no, product_id, label_raw, quantity, weight_g,
      unit_price_cents, line_total_cents, discount_cents, tax_code, discount_labels)
    values (rid, hid, (it->>'line_no')::int, pid, it->>'label_raw', nullif(it->>'quantity', '')::int,
      nullif(it->>'weight_g', '')::int, nullif(it->>'unit_price_cents', '')::int, (it->>'line_total_cents')::int,
      (it->>'discount_cents')::int, it->>'tax',
      coalesce(array(select jsonb_array_elements_text(it->'discount_labels')), '{}'));
  end loop;
  update public.receipts set non_food_cents = nf where id = rid;

  update public.products pr set first_seen = a.f, last_seen = a.l, times_bought = a.n, updated_at = now()
  from (
    select ri.product_id, min(r.purchased_at)::date f, max(r.purchased_at)::date l, count(*)::int n
    from public.receipt_items ri join public.receipts r on r.id = ri.receipt_id
    where ri.product_id in (select product_id from public.receipt_items where receipt_id = rid)
    group by ri.product_id
  ) a where a.product_id = pr.id;

  return rid;
end;
$$;
revoke all on function private.upsert_receipt_core(uuid, jsonb) from public, anon, authenticated;

-- Ingrédients achetés, ligne par ligne, avec la quantité en unité de base et sa provenance.
-- quantity est nulle quand la contenance du produit est inconnue.
create view public.purchased_ingredients with (security_invoker = true) as
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
where p.role = 'ingredient';

-- Synthèse des ingrédients achetés sur une période (base des stocks et des menus).
create or replace function public.ingredient_purchases(p_household uuid, p_days integer default 14)
returns table (ingredient_id uuid, ingredient_slug text, ingredient_name text, category text, unit text,
               total_quantity numeric, lines bigint, lines_without_quantity bigint, min_confidence numeric,
               last_purchased_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  select ingredient_id, ingredient_slug, ingredient_name, category, unit,
         sum(quantity), count(*), count(*) filter (where quantity is null), min(quantity_confidence), max(purchased_at)
  from public.purchased_ingredients
  where household_id = p_household and purchased_at >= now() - make_interval(days => p_days)
  group by ingredient_id, ingredient_slug, ingredient_name, category, unit
  order by max(purchased_at) desc, ingredient_name;
$$;
grant execute on function public.ingredient_purchases(uuid, integer) to authenticated;
revoke execute on function public.ingredient_purchases(uuid, integer) from anon, public;
revoke all on public.purchased_ingredients from anon;
