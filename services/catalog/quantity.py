"""Lecture de la contenance d'un produit à partir d'un texte (nom du ticket ou champ « quantity » d'Open Food Facts).

Renvoie une quantité dans une unité de base : grammes (g), millilitres (ml) ou pièces (piece).
Le poids ou le volume l'emporte sur un nombre de pièces (« Steaks x 2 charolais 300 g » -> 300 g).
Aucune conversion entre masse et volume n'est faite (pas de densité supposée).
"""

import re
import unicodedata

_NUM = r"(\d+(?:[.,]\d+)?)"
_UNITS = {"kg": ("g", 1000), "g": ("g", 1), "gr": ("g", 1), "grammes": ("g", 1), "l": ("ml", 1000), "litre": ("ml", 1000),
          "litres": ("ml", 1000), "cl": ("ml", 10), "ml": ("ml", 1)}
_UNIT_RX = r"(kg|grammes|gr|g|litres|litre|l|cl|ml)"
_MULTI = re.compile(r"(\d+)\s*x\s*" + _NUM + r"\s*" + _UNIT_RX + r"(?![a-z])")
_SIMPLE = re.compile(_NUM + r"\s*" + _UNIT_RX + r"(?![a-z])")
_PIECE_WORDS = r"(tranches|tranche|t|pots|pot|oeufs|rouleaux|portions|fruits|pieces|pcs|batonnets|tetes|fruit)"
_PIECES_SUM = re.compile(r"(\d+)\s*\+\s*(\d+)\s*t(?![a-z])")
_PIECES_WORD = re.compile(r"(?<![\d,.])(\d+)\s*" + _PIECE_WORDS + r"(?![a-z])")
_PIECES_X = re.compile(r"(?:^|\s)[x*]\s*(\d+)(?![\d,.])")
_PIECES_NXM = re.compile(r"(?<![\d,.])(\d+)\s*x\s*\d+(?:\s*cm)?(?![\d,.a-z])")
_PIECES_LEAD = re.compile(r"^(\d+)\s+[a-z]")


def _clean(text):
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    t = t.replace(" ", " ")
    return re.sub(r"\s+", " ", t).strip()


def _num(s):
    return float(s.replace(",", "."))


def parse_quantity(text):
    """(valeur, unité) ou None. Unité : 'g', 'ml' ou 'piece'."""
    t = _clean(text)
    if not t:
        return None
    m = _MULTI.search(t)
    if m:
        unit, factor = _UNITS[m.group(3)]
        return round(int(m.group(1)) * _num(m.group(2)) * factor, 1), unit
    m = _SIMPLE.search(t)
    if m:
        unit, factor = _UNITS[m.group(2)]
        value = round(_num(m.group(1)) * factor, 1)
        if value > 0:
            return value, unit
    m = _PIECES_SUM.search(t)
    if m:
        return float(int(m.group(1)) + int(m.group(2))), "piece"
    for rx in (_PIECES_WORD, _PIECES_X, _PIECES_NXM, _PIECES_LEAD):
        m = rx.search(t)
        if m and 0 < int(m.group(1)) <= 100:
            return float(int(m.group(1))), "piece"
    return None
