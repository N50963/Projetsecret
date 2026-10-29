-- Une seule politique de lecture sur product_ingredients (l'ancienne politique « for all » doublait la lecture).
drop policy product_ingredients_write on public.product_ingredients;
create policy product_ingredients_insert on public.product_ingredients for insert to authenticated
  with check (private.is_member(household_id));
create policy product_ingredients_update on public.product_ingredients for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy product_ingredients_delete on public.product_ingredients for delete to authenticated
  using (private.is_member(household_id));
