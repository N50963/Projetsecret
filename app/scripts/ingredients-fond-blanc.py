"""
Vignettes des ingrédients sur fond blanc, embarquées dans l'application (assets/ingredients/<slug>.jpg, 160 px).

Usage (Python avec rembg et Pillow ; modèle isnet-general-use téléchargé au premier lancement) :
    python scripts/ingredients-fond-blanc.py <dossier des vignettes en ligne> assets/ingredients
puis : node scripts/photos-embarquees.mjs

- Sujet détouré (rembg), recadré et centré sur un carré blanc.
- Pastille ronde sur fond blanc quand il n'y a pas de sujet à détourer (graines, poudres, herbes séchées : la photo
  remplit le cadre) ou quand le détourage est raté (liste PASTILLE, établie à l'œil sur une planche de contrôle).
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from rembg import new_session, remove

PASTILLE = set("""anchois beurre bouillon canard_aiguillette canard_magret_fume charcuterie_tranchee chou_blanc citron comte
epinard falafel gnocchi jambon_cuit levure_chimique moutarde nouilles pain pates_fraiches persil poisson_blanc porc_hache
porc_tranche poivre saucisson vinaigre""".split())
SIZE, MARGIN, SS = 160, 0.08, 4


def pastille(im: Image.Image) -> Image.Image:
    dia = int(SIZE * 0.9)
    photo = im.resize((dia * SS, dia * SS), Image.LANCZOS)
    mask = Image.new("L", (dia * SS, dia * SS), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, dia * SS - 1, dia * SS - 1), fill=255)
    big = Image.new("RGB", (SIZE * SS, SIZE * SS), "white")
    off = (SIZE * SS - dia * SS) // 2
    big.paste(photo, (off, off), mask)
    return big.resize((SIZE, SIZE), Image.LANCZOS)


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
        out = None if p.stem in PASTILLE else detoure(im, session)
        (out or pastille(im)).save(dst / p.name, "JPEG", quality=82, optimize=True)
        print(p.stem, "détouré" if out else "pastille")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
