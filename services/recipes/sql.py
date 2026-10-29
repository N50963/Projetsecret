"""Génère le SQL qui charge le jeu initial de recettes communes (household_id nul) depuis data/recipes/seed.json.

Usage : python -m services.recipes.sql > supabase/migrations/<horodatage>_recipes_seed.sql
Idempotent : une recette commune déjà présente (même slug) n'est pas rechargée.
"""

import json

from services.recipes.seed import SEED_PATH


def recipes_seed_sql():
    recipes = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    payload = json.dumps(recipes, ensure_ascii=False).replace("$seed$", "")
    return f"""-- Généré par services/recipes/sql.py à partir de data/recipes/seed.json : ne pas modifier à la main.
do $do$
declare
  r jsonb;
  rid uuid;
begin
  for r in select * from jsonb_array_elements($seed${payload}$seed$::jsonb) loop
    if not exists (select 1 from public.recipes where household_id is null and slug = r->>'slug') then
      insert into public.recipes (household_id, slug, source, created_by) values (null, r->>'slug', 'seed', null) returning id into rid;
      perform private.insert_recipe_version(rid, r, 'Jeu initial');
      update public.recipe_versions set created_by = null where recipe_id = rid;
    end if;
  end loop;
end
$do$;
"""


if __name__ == "__main__":
    print(recipes_seed_sql(), end="")
