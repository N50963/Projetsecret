-- Déplacer un menu choisi (glisser-déposer dans le ruban de la semaine) : sur un repas libre, le menu change de jour ou
-- de repas (ses articles de courses le suivent) ; sur un repas déjà prévu, les deux menus s'échangent. Chaque repas garde
-- son temps disponible et son nombre de personnes.
create or replace function public.move_meal_choice(p_slot_id uuid, p_date date, p_meal_type text)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  s public.meal_slots;
  t public.meal_slots;
begin
  select * into s from public.meal_slots where id = p_slot_id;
  if s.id is null then raise exception 'repas introuvable'; end if;
  if s.status <> 'accepted' then raise exception 'seul un menu choisi peut être déplacé'; end if;
  if p_meal_type not in ('dejeuner', 'diner') then raise exception 'repas inconnu : %', p_meal_type; end if;
  if s.meal_date = p_date and s.meal_type = p_meal_type then return; end if;

  select * into t from public.meal_slots
  where household_id = s.household_id and meal_date = p_date and meal_type = p_meal_type;

  if t.id is null then
    update public.meal_slots set meal_date = p_date, meal_type = p_meal_type where id = s.id;
    return;
  end if;

  update public.meal_slots set status = t.status, recipe_id = t.recipe_id, version_id = t.version_id, accepted_at = t.accepted_at
  where id = s.id;
  update public.meal_slots set status = s.status, recipe_id = s.recipe_id, version_id = s.version_id, accepted_at = s.accepted_at
  where id = t.id;
  update public.shopping_list_items set slot_id = case when slot_id = s.id then t.id else s.id end
  where slot_id in (s.id, t.id);
end;
$$;
revoke all on function public.move_meal_choice(uuid, date, text) from public, anon;
grant execute on function public.move_meal_choice(uuid, date, text) to authenticated;
