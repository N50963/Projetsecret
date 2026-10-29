"""Jeu initial de recettes : assemblage, contrôles et export JSON (data/recipes/seed.json).

Usage : python -m services.recipes.seed   (réécrit data/recipes/seed.json et affiche la répartition)
"""

import collections
import json
from pathlib import Path

from services.recipes import seed_poissons_oeufs, seed_vegetarien, seed_viandes
from services.recipes.model import validate

RECIPES = seed_viandes.RECIPES + seed_poissons_oeufs.RECIPES + seed_vegetarien.RECIPES
SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "recipes" / "seed.json"


def check_all():
    errors = {r.slug: validate(r) for r in RECIPES}
    errors = {k: v for k, v in errors.items() if v}
    slugs = [r.slug for r in RECIPES]
    duplicates = [s for s, n in collections.Counter(slugs).items() if n > 1]
    if duplicates:
        errors["_doublons"] = duplicates
    return errors


def distribution():
    d = {"total": len(RECIPES)}
    d["proteines"] = dict(collections.Counter(r.protein for r in RECIPES))
    d["saisons"] = {s: sum(s in r.seasons for r in RECIPES) for s in ("printemps", "ete", "automne", "hiver")}
    d["dejeuner_possible"] = sum("dejeuner" in r.meals for r in RECIPES)
    d["rapides_30_min"] = sum(r.prep_min + r.cook_min <= 30 for r in RECIPES)
    d["vegetariennes"] = sum("vegetarien" in r.derived_tags() for r in RECIPES)
    return d


def export():
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEED_PATH.write_text(json.dumps([r.to_dict() for r in RECIPES], ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    problems = check_all()
    if problems:
        raise SystemExit(f"Recettes invalides : {problems}")
    export()
    print(json.dumps(distribution(), ensure_ascii=False, indent=1))
