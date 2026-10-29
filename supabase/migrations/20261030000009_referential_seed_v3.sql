-- Référentiel v3 : magret de canard fumé (tranches) distinct du magret cru, pour ne pas proposer une recette de magret
-- poêlé avec des tranches fumées. Écart avec la v2 seulement (un ingrédient, une règle insérée avant celle du magret) ;
-- le résultat est identique à la sortie de services/catalog/sql.py (vérifié après application).
insert into public.ingredients (slug, name, category, default_unit, is_pantry_staple, allergens)
values ('canard_magret_fume', 'Magret de canard fumé (tranches)', 'charcuterie', 'g', false, '{}'::text[])
on conflict (slug) do update set name = excluded.name, category = excluded.category, default_unit = excluded.default_unit,
  is_pantry_staple = excluded.is_pantry_staple, allergens = excluded.allergens;

-- Décalage en deux temps pour ne pas heurter l'unicité des priorités.
update private.ingredient_rules set priority = priority + 10000 where priority >= 74;
update private.ingredient_rules set priority = priority - 9999 where priority >= 10000;
insert into private.ingredient_rules (priority, pattern, role, ingredient_slugs)
values (74, ' magrets? (de )?(canard )?fumes? ', 'ingredient', array['canard_magret_fume']::text[]);
