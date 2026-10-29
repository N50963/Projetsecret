-- Schéma des achats Lidl Plus : foyers, tickets, lignes, produits, accès sécurisé par foyer (RLS).

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members (user_id);

create or replace function private.is_member(hid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hid and m.user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_member(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lidl_art_id text not null,
  label_raw text not null,
  display_name text not null,
  name_status text not null default 'ok' check (name_status in ('ok', 'auto', 'to_confirm', 'confirmed')),
  is_weighed boolean not null default false,
  first_seen date,
  last_seen date,
  times_bought integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, lidl_art_id, label_raw)
);
create index products_status_idx on public.products (household_id, name_status);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  source text not null default 'lidl_plus_fr',
  external_id text not null,
  purchased_at timestamptz not null,
  store_id text,
  store_name text,
  store_locality text,
  store_postal_code text,
  total_cents integer not null,
  items_net_cents integer not null,
  reconciled boolean not null,
  savings_cents integer not null default 0,
  articles_count integer,
  parser_version integer not null,
  fetched_at timestamptz not null default now(),
  unique (household_id, source, external_id)
);
create index receipts_household_date_idx on public.receipts (household_id, purchased_at desc);

create table public.receipt_raw (
  receipt_id uuid primary key references public.receipts(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  detail jsonb not null
);
create index receipt_raw_household_idx on public.receipt_raw (household_id);

create table public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  line_no integer not null,
  product_id uuid not null references public.products(id),
  label_raw text not null,
  quantity integer,
  weight_g integer,
  unit_price_cents integer,
  line_total_cents integer not null,
  discount_cents integer not null default 0,
  net_cents integer generated always as (line_total_cents + discount_cents) stored,
  tax_code text,
  discount_labels text[] not null default '{}',
  unique (receipt_id, line_no)
);
create index receipt_items_product_idx on public.receipt_items (product_id);
create index receipt_items_household_idx on public.receipt_items (household_id);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.products enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_raw enable row level security;
alter table public.receipt_items enable row level security;

create policy households_select on public.households for select to authenticated
  using (private.is_member(id));
create policy members_select on public.household_members for select to authenticated
  using (user_id = (select auth.uid()) or private.is_member(household_id));
create policy products_select on public.products for select to authenticated
  using (private.is_member(household_id));
create policy products_update on public.products for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy receipts_select on public.receipts for select to authenticated
  using (private.is_member(household_id));
create policy receipt_raw_select on public.receipt_raw for select to authenticated
  using (private.is_member(household_id));
create policy receipt_items_select on public.receipt_items for select to authenticated
  using (private.is_member(household_id));

-- Seul le nom affiché et son statut sont modifiables par l'application.
revoke update on public.products from authenticated;
grant update (display_name, name_status, updated_at) on public.products to authenticated;
revoke all on public.households, public.household_members, public.receipts, public.receipt_raw, public.receipt_items from anon;
revoke all on public.products from anon;

create or replace function public.join_household(p_code text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare hid uuid;
begin
  if (select auth.uid()) is null then raise exception 'authentification requise'; end if;
  select id into hid from public.households where invite_code = p_code;
  if hid is null then raise exception 'code de foyer invalide'; end if;
  insert into public.household_members (household_id, user_id, role)
  values (hid, (select auth.uid()), 'member') on conflict do nothing;
  return hid;
end;
$$;
revoke all on function public.join_household(text) from public, anon;
grant execute on function public.join_household(text) to authenticated;

-- Insertion idempotente d'un ticket (clé unique foyer + source + identifiant Lidl).
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

create or replace function public.import_receipt(p_household uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_member(p_household) then raise exception 'accès refusé'; end if;
  return private.upsert_receipt_core(p_household, p);
end;
$$;
revoke all on function public.import_receipt(uuid, jsonb) from public, anon;
grant execute on function public.import_receipt(uuid, jsonb) to authenticated;

create view public.purchase_lines with (security_invoker = true) as
select ri.id, ri.household_id, r.id as receipt_id, r.purchased_at, r.store_name,
       p.id as product_id, p.display_name as product_name, p.name_status, p.lidl_art_id,
       ri.quantity, ri.weight_g, ri.unit_price_cents, ri.line_total_cents, ri.discount_cents, ri.net_cents
from public.receipt_items ri
join public.receipts r on r.id = ri.receipt_id
join public.products p on p.id = ri.product_id;

create view public.products_to_confirm with (security_invoker = true) as
select p.id, p.household_id, p.lidl_art_id, p.label_raw, p.display_name, p.times_bought, p.first_seen, p.last_seen,
       coalesce((select sum(ri.net_cents) from public.receipt_items ri where ri.product_id = p.id), 0) as total_spent_cents
from public.products p where p.name_status = 'to_confirm'
order by p.times_bought desc;

create or replace function public.shopping_summary(p_household uuid, p_days integer default 14)
returns table (product_id uuid, product_name text, name_status text, times_bought bigint, total_quantity bigint,
               total_weight_g bigint, total_spent_cents bigint, last_bought_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  select l.product_id, l.product_name, l.name_status, count(*), sum(coalesce(l.quantity, 0)),
         sum(coalesce(l.weight_g, 0)), sum(l.net_cents), max(l.purchased_at)
  from public.purchase_lines l
  where l.household_id = p_household and l.purchased_at >= now() - make_interval(days => p_days)
  group by l.product_id, l.product_name, l.name_status
  order by max(l.purchased_at) desc, 2;
$$;
grant execute on function public.shopping_summary(uuid, integer) to authenticated;
revoke execute on function public.shopping_summary(uuid, integer) from anon, public;
revoke all on public.purchase_lines, public.products_to_confirm from anon;
