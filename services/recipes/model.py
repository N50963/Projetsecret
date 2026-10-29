"""Format des recettes du jeu initial et contrôles de cohérence.

Une recette est décrite pour un nombre de portions de référence (4 par défaut). Chaque ingrédient pointe vers
le référentiel (services/catalog/referential.py) quand c'est possible ; la quantité est exprimée de préférence
dans l'unité de référence de l'ingrédient (g, ml ou pièce) pour pouvoir la comparer aux achats.
"""

from dataclasses import dataclass, field

from services.catalog import referential as REF

UNITS = {"g", "ml", "piece", "cs", "cc", "pincee"}
SCALE_MODES = {"linear", "sublinear", "fixed"}
PROTEINS = {"volaille", "boeuf", "porc", "poisson", "fruits_de_mer", "oeuf", "legumineuse", "vegetarien"}
SEASONS = ("printemps", "ete", "automne", "hiver")
ALL_YEAR = SEASONS
MEAL_TYPES = {"diner", "dejeuner"}
_UNITS_ML = {"cs": 15, "cc": 5}
_INGREDIENTS = {i[0]: i for i in REF.INGREDIENTS}
_MEAT_FISH = {"volaille", "viande", "charcuterie", "poisson"}


@dataclass
class Ing:
    slug: str | None
    qty: float | None
    unit: str | None
    label: str | None = None
    optional: bool = False
    scale: str = "linear"

    def to_dict(self):
        ref = _INGREDIENTS.get(self.slug) if self.slug else None
        label = self.label or (ref[1].lower() if ref else None)
        base_qty, base_unit = None, None
        if ref and self.qty is not None and self.unit == ref[3]:
            base_qty, base_unit = self.qty, self.unit
        elif ref and self.qty is not None and self.unit in _UNITS_ML and ref[3] == "ml":
            base_qty, base_unit = self.qty * _UNITS_ML[self.unit], "ml"
        return {"slug": self.slug, "label": label, "quantity": self.qty, "unit": self.unit, "optional": self.optional,
                "scale": self.scale, "base_quantity": base_qty, "base_unit": base_unit}


def I(slug, qty=None, unit=None, label=None, optional=False, scale=None):
    """Ingrédient. Herbes, épices, sel et poivre s'adaptent par défaut moins vite que les portions."""
    if scale is None:
        ref = _INGREDIENTS.get(slug)
        scale = "sublinear" if ref and ref[2] == "herbe_epice" else "linear"
    return Ing(slug, qty, unit, label, optional, scale)


@dataclass
class Recipe:
    slug: str
    name: str
    description: str
    protein: str
    cuisine: str
    prep_min: int
    cook_min: int
    difficulty: int
    meals: tuple
    seasons: tuple
    ingredients: list
    steps: list
    servings: int = 4
    rest_min: int = 0
    tags: tuple = field(default_factory=tuple)

    def derived_tags(self):
        cats = {_INGREDIENTS[i.slug][2] for i in self.ingredients if i.slug in _INGREDIENTS and not i.optional}
        tags = set(self.tags)
        if not cats & _MEAT_FISH:
            tags.add("vegetarien")
        if not cats & {"volaille", "viande", "charcuterie"} and "poisson" in cats:
            tags.add("pescetarien")
        if self.prep_min + self.cook_min <= 30:
            tags.add("rapide")
        return sorted(tags)

    def allergens(self):
        out = set()
        for i in self.ingredients:
            if i.slug and not i.optional:
                out.update(REF.ALLERGENS.get(i.slug, []))
        return sorted(out)

    def to_dict(self):
        return {
            "slug": self.slug, "name": self.name, "description": self.description, "servings": self.servings,
            "prep_min": self.prep_min, "cook_min": self.cook_min, "rest_min": self.rest_min, "difficulty": self.difficulty,
            "meal_types": list(self.meals), "main_protein": self.protein, "cuisine": self.cuisine,
            "seasons": list(self.seasons), "tags": self.derived_tags(), "allergens": self.allergens(),
            "ingredients": [i.to_dict() for i in self.ingredients], "steps": list(self.steps),
        }


def validate(recipe):
    """Liste des problèmes d'une recette (vide si elle est valide)."""
    errors = []
    if recipe.protein not in PROTEINS:
        errors.append(f"protéine inconnue : {recipe.protein}")
    if not set(recipe.seasons) <= set(SEASONS) or not recipe.seasons:
        errors.append("saisons invalides")
    if not set(recipe.meals) <= MEAL_TYPES or not recipe.meals:
        errors.append("types de repas invalides")
    if not 1 <= recipe.difficulty <= 3:
        errors.append("difficulté hors de 1 à 3")
    if recipe.prep_min < 0 or recipe.cook_min < 0 or recipe.servings <= 0:
        errors.append("durées ou portions invalides")
    if len(recipe.ingredients) < 3 or len(recipe.steps) < 2:
        errors.append("trop peu d'ingrédients ou d'étapes")
    for i in recipe.ingredients:
        if i.slug is not None and i.slug not in _INGREDIENTS:
            errors.append(f"ingrédient absent du référentiel : {i.slug}")
        if i.slug is None and not i.label:
            errors.append("ingrédient libre sans libellé")
        if i.unit is not None and i.unit not in UNITS:
            errors.append(f"unité inconnue : {i.unit}")
        if i.qty is not None and i.qty <= 0:
            errors.append(f"quantité nulle ou négative : {i.label or i.slug}")
        if i.scale not in SCALE_MODES:
            errors.append(f"mode d'adaptation inconnu : {i.scale}")
    slugs = [i.slug for i in recipe.ingredients if i.slug]
    if len(slugs) != len(set(slugs)):
        errors.append("ingrédient en double")
    return errors
