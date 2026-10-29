-- Retire les produits non alimentaires. Le montant retiré est mémorisé sur chaque ticket
-- (receipts.non_food_cents) et les produits sont ajoutés à une liste d'exclusion, pour que
-- les prochaines synchronisations ne les recréent pas. Les tickets d'origine restent dans receipt_raw.
--
-- Cette migration reflète la première suppression (produits marqués kind = 'non_food').
-- Une seconde passe, par mots-clés sur le nom (litière, lessive, papier toilette, etc.), a été
-- appliquée directement à la base avec les mêmes étapes.

alter table public.receipts add column non_food_cents integer not null default 0;

create table public.excluded_products (
  household_id uuid not null references public.households(id) on delete cascade,
  lidl_art_id text not null,
  label_raw text not null,
  reason text not null default 'non_food',
  created_at timestamptz not null default now(),
  primary key (household_id, lidl_art_id, label_raw)
);
alter table public.excluded_products enable row level security;
create policy excluded_products_select on public.excluded_products for select to authenticated
  using (private.is_member(household_id));
revoke all on public.excluded_products from anon;

update public.receipts r set non_food_cents = r.non_food_cents + coalesce(s.cents, 0)
from (
  select ri.receipt_id, sum(ri.net_cents)::int as cents
  from public.receipt_items ri join public.products p on p.id = ri.product_id
  where p.kind = 'non_food' group by ri.receipt_id
) s where s.receipt_id = r.id;

insert into public.excluded_products (household_id, lidl_art_id, label_raw)
select household_id, lidl_art_id, label_raw from public.products where kind = 'non_food'
on conflict do nothing;

delete from public.receipt_items where product_id in (select id from public.products where kind = 'non_food');
delete from public.products where kind = 'non_food';

-- La fonction d'import saute désormais les lignes exclues et renseigne non_food_cents.
create or replace function private.upsert_receipt_core(hid uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  rid uuid;
  it jsonb;
  pid uuid;
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
    insert into public.products (household_id, lidl_art_id, label_raw, display_name, name_status, is_weighed)
    values (hid, it->>'art_id', it->>'label_raw', it->>'label_raw',
            case when char_length(it->>'label_raw') >= 20 then 'to_confirm' else 'ok' end,
            (it->>'weight_g') is not null)
    on conflict (household_id, lidl_art_id, label_raw) do update set is_weighed = public.products.is_weighed or excluded.is_weighed
    returning id into pid;
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
