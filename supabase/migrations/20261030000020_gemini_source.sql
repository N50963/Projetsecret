-- Images des plats créées par Gemini (« Nano Banana ») quand le secret GEMINI_API_KEY est présent ; Mistral en secours.
-- Les images Pollinations (essai abandonné) restent acceptées le temps d'être remplacées.
alter table public.recipe_images drop constraint recipe_images_source_check;
alter table public.recipe_images add constraint recipe_images_source_check check (source in ('gemini', 'mistral', 'pollinations', 'photo'));
