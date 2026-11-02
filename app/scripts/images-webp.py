"""
Convertit en WebP les images embarquées dans l'application (≈ 30 % plus légères que les JPEG, même qualité visible) :
photos des plats (640 px, qualité 75), miniatures (240 px, qualité 75), vignettes des ingrédients (160 px, qualité 80).
Les JPEG convertis sont supprimés ; relancer ensuite node scripts/photos-embarquees.mjs.

Usage : python scripts/images-webp.py   (depuis le dossier app)
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "assets"
QUALITY = {"plats": 75, "plats-mini": 75, "ingredients": 80}

for folder, quality in QUALITY.items():
    before = after = 0
    for jpg in sorted((ROOT / folder).glob("*.jpg")):
        webp = jpg.with_suffix(".webp")
        Image.open(jpg).convert("RGB").save(webp, "WEBP", quality=quality, method=6)
        before += jpg.stat().st_size
        after += webp.stat().st_size
        jpg.unlink()
    if before:
        print(f"{folder} : {before / 1048576:.2f} Mo -> {after / 1048576:.2f} Mo")
