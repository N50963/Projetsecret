-- Achats de fruits et légumes faits ailleurs que chez Lidl (marché, primeur, autre magasin), saisis dans l'application
-- (Profil › Tickets et achats › Fruits et légumes d'un autre magasin). Ils comptent exactement comme les achats des
-- tickets : la vue purchased_ingredients les ajoute, donc le stock des propositions de menus, la liste de courses cochée
-- toute seule, la recherche de menu par ingrédient et les idées de la réflexion approfondie les prennent en compte.
create table public.extra_purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id),
  quantity numeric not null check (quantity > 0 and quantity < 100000),
  unit text not null check (unit in ('g', 'piece')),
  purchased_at timestamptz not null default now(),
  store text check (char_length(store) <= 60),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
comment on table public.extra_purchases is 'Fruits et légumes achetés hors Lidl, saisis à la main : comptent comme les achats des tickets.';
create index extra_purchases_household_date_idx on public.extra_purchases (household_id, purchased_at desc);
create index extra_purchases_ingredient_idx on public.extra_purchases (ingredient_id);
alter table public.extra_purchases enable row level security;
create policy extra_purchases_select on public.extra_purchases for select to authenticated using (private.is_member(household_id));
create policy extra_purchases_insert on public.extra_purchases for insert to authenticated with check (private.is_member(household_id));
create policy extra_purchases_update on public.extra_purchases for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy extra_purchases_delete on public.extra_purchases for delete to authenticated using (private.is_member(household_id));
grant select, insert, update, delete on public.extra_purchases to authenticated;

-- Même vue qu'avant (mêmes colonnes), complétée par les achats saisis à la main.
create or replace view public.purchased_ingredients with (security_invoker = true) as
select ri.id as receipt_item_id, ri.household_id, r.purchased_at, p.id as product_id, p.display_name as product_name,
       i.id as ingredient_id, i.slug as ingredient_slug, i.name as ingredient_name, i.category,
       case when ri.weight_g is not null then 'g' else p.pack_unit end as unit,
       case when ri.weight_g is not null then round(ri.weight_g::numeric * pi.share, 1)
            when p.pack_quantity is not null then round(coalesce(ri.quantity, 1)::numeric * p.pack_quantity * pi.share, 1)
            else null::numeric
       end as quantity,
       case when ri.weight_g is not null then 'ticket_weight' else p.quantity_source end as quantity_source,
       case when ri.weight_g is not null then 1::numeric else p.quantity_confidence end as quantity_confidence
from public.receipt_items ri
join public.receipts r on r.id = ri.receipt_id
join public.products p on p.id = ri.product_id
join public.product_ingredients pi on pi.product_id = p.id
join public.ingredients i on i.id = pi.ingredient_id
where p.role in ('ingredient', 'bread')
union all
select e.id, e.household_id, e.purchased_at, null::uuid, coalesce(nullif(btrim(e.store), ''), 'Autre magasin') || ' · ' || i.name,
       i.id, i.slug, i.name, i.category, e.unit, e.quantity::numeric, 'manual'::text, 1::numeric
from public.extra_purchases e
join public.ingredients i on i.id = e.ingredient_id;
revoke all on public.purchased_ingredients from anon;
