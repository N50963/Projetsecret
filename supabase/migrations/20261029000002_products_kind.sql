-- Distingue les produits alimentaires des autres (les menus ignorent les non alimentaires).
alter table public.products
  add column kind text not null default 'food' check (kind in ('food', 'non_food'));
create index products_kind_idx on public.products (household_id, kind);
revoke update on public.products from authenticated;
grant update (display_name, name_status, kind, updated_at) on public.products to authenticated;
