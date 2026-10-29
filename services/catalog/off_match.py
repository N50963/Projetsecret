"""Rapprochement des produits du foyer avec les fiches Open Food Facts (données ODbL, © contributeurs Open Food Facts).

Un produit n'est comparé qu'aux fiches classées dans le même ingrédient par les règles du référentiel,
puis le nom le plus proche est retenu. Quand les meilleures fiches donnent des contenances différentes
(même produit vendu en plusieurs formats), le rapprochement est marqué ambigu et sa confiance baisse.
"""

import collections
import re

from rapidfuzz import fuzz

from services.catalog import referential as R
from services.catalog.quantity import parse_quantity

MIN_SCORE = 80          # similarité minimale (0-100) pour retenir une fiche
NEAR = 3                # fiches à moins de NEAR points du meilleur score : considérées équivalentes
_QTY_TOKENS = re.compile(r"\s(\d+(?:[ .,]\d+)?\s*(kg|g|gr|l|cl|ml|x)?|x\s*\d+)\s")


def _key(name):
    n = R.normalize(name)
    n = _QTY_TOKENS.sub(" ", n)
    return re.sub(r"\s+", " ", n).strip()


def index_off(off_products):
    """Classe les fiches OFF par ingrédient. Ne garde que celles qui ont un nom et une contenance lisible."""
    by_slug = collections.defaultdict(list)
    for p in off_products:
        name = (p.get("product_name_fr") or p.get("product_name") or "").strip()
        qty = parse_quantity(p.get("quantity") or "")
        if not name or not qty:
            continue
        role, slugs, _ = R.classify(name)
        if role != "ingredient" or len(slugs) != 1:
            continue
        by_slug[slugs[0]].append({"code": p["code"], "name": name, "brands": p.get("brands"), "qty": qty, "key": _key(name)})
    return by_slug


def score(a, b):
    """Similarité qui pénalise les mots en trop (« fromage blanc » contre « fromage blanc framboises »)."""
    return 0.4 * fuzz.token_set_ratio(a, b) + 0.6 * fuzz.token_sort_ratio(a, b)


def match(name, slug, by_slug):
    """Meilleure fiche OFF pour ce produit, ou None. Renvoie code, nom, contenance, score et confiance."""
    candidates = by_slug.get(slug, [])
    if not candidates:
        return None
    key = _key(name)
    scored = sorted(((score(key, c["key"]), c) for c in candidates), key=lambda x: -x[0])
    best_score, best = scored[0]
    if best_score < MIN_SCORE:
        return None
    near = [c for s, c in scored if s >= best_score - NEAR]
    quantities = collections.Counter(c["qty"] for c in near)
    qty, votes = quantities.most_common(1)[0]
    ambiguous = len(quantities) > 1
    confidence = round(best_score / 100 * (votes / len(near) if ambiguous else 1), 2)
    chosen = next(c for c in near if c["qty"] == qty)
    return {"code": chosen["code"], "name": chosen["name"], "qty": qty, "score": best_score,
            "confidence": confidence, "ambiguous": ambiguous, "formats": sorted({f"{v:g} {u}" for v, u in quantities})}
