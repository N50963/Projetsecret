-- Photos des plats affichées tout de suite.
-- Les images créées par Mistral (recipe-images) sont servies par lien public stable : le téléphone les télécharge une
-- seule fois, en avance, et les garde en cache ; le CDN de Supabase les sert aussi plus vite (sortie réseau « en cache »).
-- Ce sont des images de plats génériques, sans donnée personnelle. Les photos prises par le foyer vont dans un seau
-- privé (household-photos), lisible seulement par les membres du foyer, avec des liens temporaires.

update storage.buckets set public = true where id = 'recipe-images';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('household-photos', 'household-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Dossier <household_id>/ : réservé aux membres du foyer.
create policy household_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'household-photos' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
create policy household_photos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'household-photos' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
create policy household_photos_change on storage.objects for update to authenticated
  using (bucket_id = 'household-photos' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
create policy household_photos_remove on storage.objects for delete to authenticated
  using (bucket_id = 'household-photos' and exists (
    select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.household_id::text = (storage.foldername(name))[1]));
