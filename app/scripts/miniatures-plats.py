"""
Miniatures des photos de plats embarquées (assets/plats-mini/<recette>.webp, 240 px de large, WebP qualité 75) pour les petits affichages
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
# Photos de plats en WebP (un JPEG ajouté depuis est accepté, et converti par scripts/images-webp.py).
for p in sorted([*SRC.glob("*.webp"), *SRC.glob("*.jpg")]):
    out = DST / f"{p.stem}.webp"
    if out.exists() and out.stat().st_mtime >= p.stat().st_mtime:
        continue
    im = Image.open(p).convert("RGB")
    im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS).save(out, "WEBP", quality=75, method=6)
    done += 1
for stale in DST.glob("*.webp"):
    if not any((SRC / f"{stale.stem}{ext}").exists() for ext in (".webp", ".jpg")):
        stale.unlink()
print(f"{done} miniatures créées, {len(list(DST.glob('*.webp')))} au total")
