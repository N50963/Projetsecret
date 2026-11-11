-- Nouvel ingrédient « Blette » (légume, en grammes) : proposé dans « Fruits et légumes d'un autre magasin » et reconnu
-- sur les tickets (blettes, bettes, poirée), juste après la règle des épinards comme dans services/catalog/referential.py.
insert into public.ingredients (slug, name, category, default_unit, is_pantry_staple, allergens, spiciness)
values ('blette', 'Blette', 'legume', 'g', false, '{}'::text[], 0)
on conflict (slug) do update set name = excluded.name, category = excluded.category, default_unit = excluded.default_unit,
  is_pantry_staple = excluded.is_pantry_staple, allergens = excluded.allergens, spiciness = excluded.spiciness;

-- Décalage en deux temps pour ne pas heurter l'unicité des priorités.
do $$
declare
  after_spinach int := (select priority from private.ingredient_rules where pattern = ' epinards? ') + 1;
begin
  if exists (select 1 from private.ingredient_rules where 'blette' = any(ingredient_slugs)) then
    return;
  end if;
  update private.ingredient_rules set priority = priority + 10000 where priority >= after_spinach;
  update private.ingredient_rules set priority = priority - 9999 where priority >= 10000;
  insert into private.ingredient_rules (priority, pattern, role, ingredient_slugs)
  values (after_spinach, ' (blettes?|bettes?|poirees?)s? ', 'ingredient', array['blette']::text[]);
end $$;

-- Produits déjà achetés concernés (sauf ceux corrigés par le foyer).
select private.apply_rules_to_product(p.id)
from public.products p
where p.role_source is distinct from 'user'
  and private.norm_label(p.display_name) ~ ' (blettes?|bettes?|poirees?) ';
