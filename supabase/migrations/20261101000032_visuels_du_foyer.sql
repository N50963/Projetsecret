-- Visuels de plats fournis par le foyer : nouvelle origine « foyer » pour l'image commune d'un plat (remplace la photo de
-- Commons, sans crédit à afficher ; la vue dish_photo_credits ne liste que les photos de Commons). Une image « foyer »
-- compte comme illustration : la tâche planifiée ne la remplace pas.
alter table public.recipe_images drop constraint recipe_images_source_check;
alter table public.recipe_images add constraint recipe_images_source_check
  check (source in ('gemini', 'mistral', 'pollinations', 'photo', 'commons', 'foyer'));
