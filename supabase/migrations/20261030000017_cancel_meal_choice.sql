-- Annulation d'un menu choisi (accueil) : le repas redevient à prévoir, sans recette.
-- La recette n'est pas marquée comme refusée (elle pourra être reproposée) et les articles de la liste de courses
-- ajoutés pour ce repas, non cochés, sont retirés.

create or replace function public.cancel_meal_choice(p_slot_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not exists (select 1 from public.meal_slots where id = p_slot_id) then
    raise exception 'repas introuvable';
  end if;
  update public.meal_proposals set decision = null, decided_at = null
  where slot_id = p_slot_id and decision = 'accepted';
  delete from public.shopping_list_items where slot_id = p_slot_id and checked_at is null;
  update public.meal_slots set status = 'open', recipe_id = null, version_id = null, accepted_at = null
  where id = p_slot_id;
end;
$$;
revoke all on function public.cancel_meal_choice(uuid) from public, anon;
grant execute on function public.cancel_meal_choice(uuid) to authenticated;
