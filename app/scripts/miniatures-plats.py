"""
Miniatures des photos de plats embarquées (assets/plats-mini/<recette>.jpg, 240 px de large) pour les petits affichages
(liste des recettes, ruban de la semaine, liste de courses, rappels, crédits) : une vignette de 86 px décodée depuis une
photo de 640 px retardait l'affichage des listes. À lancer après toute mise à jour de assets/plats, avant
scripts/photos-embarquees.mjs.

Usage (depuis le dossier app) : python scripts/miniatures-plats.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC, DST = ROOT / "assets/plats", ROOT / "assets/plats-mini"
WIDTH = 240

DST.mkdir(exist_ok=True)
done = 0
for p in sorted(SRC.glob("*.jpg")):
    out = DST / p.name
    if out.exists() and out.stat().st_mtime >= p.stat().st_mtime:
        continue
    im = Image.open(p).convert("RGB")
    im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS).save(out, "JPEG", quality=80, optimize=True, progressive=True)
    done += 1
for stale in DST.glob("*.jpg"):
    if not (SRC / stale.name).exists():
        stale.unlink()
print(f"{done} miniatures créées, {len(list(DST.glob('*.jpg')))} au total")
