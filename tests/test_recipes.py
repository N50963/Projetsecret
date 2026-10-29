"""Contrôles du jeu initial de recettes."""

import json

from services.recipes import seed
from services.recipes.model import SEASONS


def test_all_recipes_are_valid():
    assert seed.check_all() == {}


def test_size_matches_dinner_target():
    # Cible : un dîner par jour + quelques déjeuners, 2-3 propositions par repas, pas de répétition sous 21 jours.
    d = seed.distribution()
    assert d["total"] >= 70
    for season in SEASONS:
        assert d["saisons"][season] >= 40, season
    assert d["rapides_30_min"] >= 25
    assert d["dejeuner_possible"] >= 20
    assert all(n >= 4 for n in d["proteines"].values())


def test_exported_seed_is_up_to_date():
    exported = json.loads(seed.SEED_PATH.read_text(encoding="utf-8"))
    assert exported == [r.to_dict() for r in seed.RECIPES]


def test_vegetarian_tag_is_derived_from_ingredients():
    by_slug = {r.slug: r for r in seed.RECIPES}
    assert "vegetarien" in by_slug["dahl-lentilles-corail"].derived_tags()
    assert "vegetarien" not in by_slug["spaghetti-bolognaise"].derived_tags()
    assert "pescetarien" in by_slug["saumon-creme-epinards"].derived_tags()
    assert "gluten" in by_slug["spaghetti-bolognaise"].allergens()
