-- Photos des ingrédients (lignes « Ingrédients » des fiches) : images sous licence libre de Wikimedia Commons (image
-- principale de l'article Wikipédia), réduites en vignettes carrées de 160 px. Auteur et licence gardés pour les crédits.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ingredient-images', 'ingredient-images', true, 200000, array['image/jpeg'])
on conflict (id) do nothing;

create table public.ingredient_images (
  ingredient_id uuid primary key references public.ingredients(id) on delete cascade,
  storage_path text not null,
  source_url text not null,
  author text,
  license text not null,
  license_url text,
  created_at timestamptz not null default now()
);
alter table public.ingredient_images enable row level security;
create policy ingredient_images_select on public.ingredient_images for select to authenticated using (true);
revoke all on public.ingredient_images from anon;
grant select on public.ingredient_images to authenticated;

-- Vignettes par identifiant d'ingrédient (slug), avec leur crédit.
create view public.ingredient_pictures with (security_invoker = true) as
select i.slug, i.name, p.storage_path, p.source_url, p.author, p.license, p.license_url, p.created_at
from public.ingredient_images p join public.ingredients i on i.id = p.ingredient_id;
grant select on public.ingredient_pictures to authenticated;
