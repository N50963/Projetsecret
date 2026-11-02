"""
Vignettes des ingrédients sur fond blanc, embarquées dans l'application (assets/ingredients/<slug>.webp, 160 px, WebP qualité 80).

Usage (Python avec rembg et Pillow ; modèle isnet-general-use téléchargé au premier lancement) :
    python scripts/ingredients-fond-blanc.py <dossier des vignettes en ligne> assets/ingredients
puis : node scripts/photos-embarquees.mjs

- Sujet détouré (rembg), recadré et centré sur un carré blanc.
- Photo telle quelle, carrée et non recadrée en rond, posée au centre d'un fond blanc, quand il n'y a pas de sujet à
  détourer (graines, poudres, herbes séchées : la photo remplit le cadre) ou quand le détourage est raté (liste
  TELLE_QUELLE, établie à l'œil sur une planche de contrôle).
"""
import sys
from pathlib import Path

from PIL import Image, ImageFilter
from rembg import new_session, remove

TELLE_QUELLE = set("""anchois beurre bouillon canard_aiguillette canard_magret_fume charcuterie_tranchee chou_blanc citron comte
epinard falafel gnocchi jambon_cuit levure_chimique moutarde nouilles pain pates_fraiches persil poisson_blanc porc_hache
porc_tranche poivre saucisson vinaigre""".split())
SIZE, MARGIN, PHOTO = 160, 0.08, 136


def telle_quelle(im: Image.Image) -> Image.Image:
    """Photo carrée inchangée, centrée sur un fond blanc (marge de 12 px)."""
    canvas = Image.new("RGB", (SIZE, SIZE), "white")
    canvas.paste(im.resize((PHOTO, PHOTO), Image.LANCZOS), ((SIZE - PHOTO) // 2, (SIZE - PHOTO) // 2))
    return canvas


def detoure(im: Image.Image, session) -> Image.Image | None:
    big = im.resize((im.width * 3, im.height * 3), Image.LANCZOS)  # le modèle travaille mieux sur une image plus grande
    cut = remove(big, session=session, post_process_mask=True)
    alpha = cut.getchannel("A")
    solid = alpha.point(lambda v: 255 if v > 40 else 0)
    box = solid.getbbox()
    if not box or solid.histogram()[255] / (alpha.width * alpha.height) < 0.04:
        return None  # rien à détourer : la photo remplit le cadre
    cut = cut.crop(box)
    side = int(max(cut.size) * (1 + 2 * MARGIN))
    canvas = Image.new("RGB", (side, side), "white")
    canvas.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2), cut.getchannel("A").filter(ImageFilter.GaussianBlur(0.6)))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    session = new_session("isnet-general-use")
    for p in sorted(src.glob("*.jpg")):
        im = Image.open(p).convert("RGB")
        out = None if p.stem in TELLE_QUELLE else detoure(im, session)
        (out or telle_quelle(im)).save(dst / f"{p.stem}.webp", "WEBP", quality=80, method=6)
        print(p.stem, "détouré" if out else "telle quelle")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
