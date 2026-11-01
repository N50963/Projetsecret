-- Référentiel pour les plats du quotidien (migration suivante) :
--  * nouvel ingrédient « Cordon bleu » : les cordons bleus achetés se cuisinent (« Cordon bleu et haricots verts »)
--    au lieu d'être classés en plat tout prêt ;
--  * « Plateau raclette » rattaché au fromage à raclette (règle « raclette »), reblochon et fromage à tartiflette au
--    fromage à croûte.
-- Écart avec la base seulement (un ingrédient, une règle insérée en priorité 29, deux motifs modifiés) ; le résultat est
-- identique à la sortie de services/catalog/sql.py (vérifié par empreinte après application).
insert into public.ingredients (slug, name, category, default_unit, is_pantry_staple, allergens, spiciness)
values ('cordon_bleu', 'Cordon bleu', 'volaille', 'piece', false, array['gluten', 'lait']::text[], 0)
on conflict (slug) do update set name = excluded.name, category = excluded.category, default_unit = excluded.default_unit,
  is_pantry_staple = excluded.is_pantry_staple, allergens = excluded.allergens, spiciness = excluded.spiciness;
update public.ingredients set name = 'Fromage à croûte (brie, reblochon...)' where slug = 'fromage_croute';

-- Décalage en deux temps pour ne pas heurter l'unicité des priorités.
update private.ingredient_rules set priority = priority + 10000 where priority >= 29;
update private.ingredient_rules set priority = priority - 9999 where priority >= 10000;
insert into private.ingredient_rules (priority, pattern, role, ingredient_slugs)
values (29, ' (cordons? bleus?)s? ', 'ingredient', array['cordon_bleu']::text[]);
update private.ingredient_rules set pattern = ' (nems?|gyo[sz]as?|sushis?|tielles|banh bao|raviolis vapeur|yakitori|parmentier|pastilla|samboussek|borek|boeuf bourguignon|blanquette|axoa|osso bucco|buddha|wraps poulet|maxi hot dog|aubergines au parm|pates en pot|lustucru banz|nouilles instantanees|soupe nouilles|ramen|yum yum|calamar a la romaine|carpaccio de poulpes|cake mozza|plateau fromages|kit a cuisiner|kit pour potee|assortiment libanais|beignets de crevettes|chips de crevettes|feuilles de vignes|piperade|tomates pelees arrabbiata|epinards a la creme|chinois a la creme)s? ' where priority = 30;
update private.ingredient_rules set pattern = ' (reblochon|fromage a tartiflette|brie|chaource|saint felicien|saint marcellin|caprice des anges|petit brie|petits fromages)s? ' where priority = 127;

-- Produits déjà achetés concernés par ces règles (sauf ceux corrigés par le foyer).
select private.apply_rules_to_product(p.id)
from public.products p
where p.role_source is distinct from 'user'
  and private.norm_label(p.display_name) ~ ' (cordons? bleus?|plateau raclette|reblochon|fromage a tartiflette) ';
