-- Les produits fumés achetés chez Lidl sont des tranches prêtes à manger (pas un poisson entier à cuire) : le nom de
-- l'ingrédient le dit, pour l'application et pour Mistral.
update public.ingredients set name = 'Truite fumée (tranches)' where slug = 'truite_fumee';
update public.ingredients set name = 'Thon fumé (tranches)' where slug = 'thon_fume';

-- Libellé de la recette de départ qui l'utilise (affichage seulement, même version).
update public.recipe_ingredients ri set label = 'truite fumée (tranches)'
from public.ingredients i
where i.id = ri.ingredient_id and i.slug = 'truite_fumee' and ri.label = 'truite fumée';
