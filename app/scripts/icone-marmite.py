"""
Icône de l'application : la marmite (assets/marmite-source.png, 512 px, fond transparent).

Usage : python scripts/icone-marmite.py   (depuis le dossier app)

Génère :
- android/app/src/main/res/mipmap-*/ : icône adaptative (marmite au premier plan sur fond crème #FEF3E3, monochrome pour les
  icônes à thème), icône classique (carré arrondi crème) et ronde ;
- android/app/src/main/res/drawable-*/splashscreen_logo.png : écran de démarrage ;
- assets/icon.png, android-icon-*.png, splash-icon.png, favicon.png : sources Expo équivalentes ;
- (logo affiché dans l'application : voir scripts/logo-menubily.py.)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
CREAM = (254, 243, 227, 255)
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

src = Image.open(ROOT / "assets/marmite-source.png").convert("RGBA")
pot = src.crop(src.getchannel("A").getbbox())  # marmite seule, sans marge


def placed(size: int, width_ratio: float, background=None, mask: str | None = None) -> Image.Image:
    """Marmite centrée sur un carré de `size` px, sa largeur valant `width_ratio` du carré."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if background is not None:
        shape = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(shape)
        if mask == "round":
            draw.ellipse((0, 0, size - 1, size - 1), fill=255)
        elif mask == "rounded":
            draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.22), fill=255)
        else:
            draw.rectangle((0, 0, size, size), fill=255)
        canvas.paste(Image.new("RGBA", (size, size), background), (0, 0), shape)
    w = round(size * width_ratio)
    h = round(pot.height * w / pot.width)
    small = pot.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(small, ((size - w) // 2, (size - h) // 2))
    return canvas


def monochrome(size: int, width_ratio: float) -> Image.Image:
    """Silhouette de la marmite (le système la teinte) ; la vapeur, trop légère, disparaît."""
    img = placed(size, width_ratio)
    alpha = img.getchannel("A").point(lambda v: 255 if v > 140 else 0)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.putalpha(alpha)
    return out


# Icône adaptative : canevas de 108 dp, marmite dans la zone sûre (cercle de 66 dp au centre).
FG_RATIO = 0.58
for name, d in DENSITIES.items():
    folder = RES / f"mipmap-{name}"
    adaptive = round(108 * d)
    legacy = round(48 * d)
    placed(adaptive, FG_RATIO).save(folder / "ic_launcher_foreground.webp", "WEBP", lossless=True)
    Image.new("RGB", (adaptive, adaptive), CREAM[:3]).save(folder / "ic_launcher_background.webp", "WEBP", lossless=True)
    monochrome(adaptive, FG_RATIO).save(folder / "ic_launcher_monochrome.webp", "WEBP", lossless=True)
    placed(legacy, 0.8, CREAM, "rounded").save(folder / "ic_launcher.webp", "WEBP", lossless=True)
    placed(legacy, 0.74, CREAM, "round").save(folder / "ic_launcher_round.webp", "WEBP", lossless=True)
    splash = round(200 * d)
    placed(splash, 0.74).save(RES / f"drawable-{name}" / "splashscreen_logo.png", optimize=True)

assets = ROOT / "assets"
placed(1024, 0.8, CREAM, "rounded").save(assets / "icon.png", optimize=True)
placed(1024, FG_RATIO).save(assets / "android-icon-foreground.png", optimize=True)
Image.new("RGBA", (1024, 1024), CREAM).save(assets / "android-icon-background.png", optimize=True)
monochrome(1024, FG_RATIO).save(assets / "android-icon-monochrome.png", optimize=True)
placed(1024, 0.74).save(assets / "splash-icon.png", optimize=True)
placed(48, 0.9).save(assets / "favicon.png", optimize=True)
print("icônes et écran de démarrage générés")
