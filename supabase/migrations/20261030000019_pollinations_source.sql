-- Images de secours : quand Mistral refuse (quota gratuit), la fonction mistral crée l'image avec Pollinations.ai
-- (gratuit, sans clé). La source est gardée pour pouvoir remplacer ces images par celles de Mistral plus tard.
alter table public.recipe_images drop constraint recipe_images_source_check;
alter table public.recipe_images add constraint recipe_images_source_check check (source in ('mistral', 'pollinations', 'photo'));
