-- Avis sur 5 étoiles (plus un commentaire facultatif). L'avis « aimé / bof / pas aimé » reste calculé à partir des étoiles
-- (4-5 : aimé, 3 : bof, 1-2 : pas aimé) : le planificateur et Mistral continuent de s'en servir sans changement.
alter table public.recipe_ratings add column stars smallint check (stars between 1 and 5);

create or replace function private.rating_from_stars()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.stars is not null then
    new.rating := case when new.stars >= 4 then 'like' when new.stars = 3 then 'neutral' else 'dislike' end;
  end if;
  return new;
end;
$$;
revoke all on function private.rating_from_stars() from public, anon, authenticated;

create trigger recipe_ratings_from_stars before insert or update of stars, rating on public.recipe_ratings
  for each row execute function private.rating_from_stars();

grant update (stars, version_id) on public.recipe_ratings to authenticated;
