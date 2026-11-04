# Logo MenuBily (visuel fourni par le foyer : marmite, nom et slogan) : fond crème rendu transparent (bords adoucis),
# marges retirées, réduit à 300 px de haut pour l'application (en-tête de l'accueil, écran de connexion).
# Usage (depuis app/) :
#   python3 scripts/logo-menubily.py assets/logo-menubily-source.png /tmp/logo.png assets/logo-menubily.webp 300
import sys
import numpy as np
from PIL import Image

src, out_png, out_webp, height = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
im = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
bg = np.array([253.5, 249.0, 239.2], dtype=np.float32)
d = np.sqrt(((im - bg) ** 2).sum(axis=2))
T0, T1 = 14.0, 70.0
a = np.clip((d - T0) / (T1 - T0), 0.0, 1.0)
# Couleur sans le fond mêlé aux bords : (pixel - (1 - a) * fond) / a.
safe = np.maximum(a, 1e-3)[..., None]
rgb = np.clip((im - (1 - a[..., None]) * bg) / safe, 0, 255)
rgb = np.where(a[..., None] > 0, rgb, 0)
rgba = np.dstack([rgb, a * 255]).astype(np.uint8)
ys, xs = np.where(a > 0.02)
pad = 6
y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad + 1, rgba.shape[0])
x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad + 1, rgba.shape[1])
img = Image.fromarray(rgba[y0:y1, x0:x1], "RGBA")
print("recadré :", img.size, "ratio", round(img.size[0] / img.size[1], 3))
w = round(img.size[0] * height / img.size[1])
small = img.resize((w, height), Image.LANCZOS)
small.save(out_png, optimize=True)
small.save(out_webp, quality=92, method=6)
print("final :", small.size)
