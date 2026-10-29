"""Tests du référentiel d'ingrédients et de la lecture des contenances (exemples tirés des tickets)."""

import re

import pytest

from services.catalog import referential as R
from services.catalog.quantity import parse_quantity


@pytest.mark.parametrize("text, expected", [
    ("Pomme de terre 1,5kg", (1500.0, "g")),
    ("Pomme de terre 2.5 kg", (2500.0, "g")),
    ("Vittel 6x1,5l", (9000.0, "ml")),
    ("Maïs doux 3x140 g", (420.0, "g")),
    ("Oasis sorbet 12x50ml", (600.0, "ml")),
    ("Steaks x 2 charolais 300 g", (300.0, "g")),
    ("Oeufs plein air x12", (12.0, "piece")),
    ("Herta LBP 4+2T", (6.0, "piece")),
    ("FM Jambon Sup 4T", (4.0, "piece")),
    ("Fleury Michon surimi 28 bâtonnets", (28.0, "piece")),
    ("Tortilla wraps 6x25", (6.0, "piece")),
    ("4 pavés de saumon", (4.0, "piece")),
    ("Nems Porc *4", (4.0, "piece")),
    ("Avocat 3 fruits", (3.0, "piece")),
    ("400 g e", (400.0, "g")),
    ("1 l", (1000.0, "ml")),
    ("Bier Abbaye 6,2%", None),
    ("Crème fraîche 30%", None),
    ("Concombre", None),
])
def test_parse_quantity(text, expected):
    assert parse_quantity(text) == expected


@pytest.mark.parametrize("name, role, slugs", [
    ("Filets de poulet jaune", "ingredient", ["poulet_filet"]),
    ("Haricots beurre très fins", "ingredient", ["haricot_beurre"]),
    ("Huile d'olive vierge extra", "ingredient", ["huile_olive"]),
    ("Olives Kalamata", "ingredient", ["olive"]),
    ("Petits pois/carottes", "ingredient", ["petit_pois", "carotte"]),
    ("Yaourt nature bio", "ingredient", ["yaourt_nature"]),
    ("Yaourt vanille", "dessert", []),
    ("Pizza jambon fromage", "prepared_meal", []),
    ("Pâte à pizza", "ingredient", ["pate_pizza"]),
    ("Orange à Jus 2 kg", "ingredient", ["orange"]),
    ("Coca Cola sans sucres", "beverage", []),
    ("Pain de mie grandes tranches", "bread", []),
    ("Signal complet", "non_food", []),
])
def test_classify(name, role, slugs):
    assert R.classify(name)[:2] == (role, slugs)


def test_patterns_are_portable_to_postgres():
    for pattern, _, _ in R.RULES:
        re.compile(pattern)
        assert "\\b" not in pattern and "\\d" not in pattern and "(?" not in pattern
