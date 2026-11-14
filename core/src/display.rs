//! Liste d'affichage : primitives graphiques indépendantes du format d'origine.
//! Les coordonnées sont en points typographiques (1/72 de pouce).

use crate::color::Color;
use crate::fonts::FontId;
use std::sync::{Arc, OnceLock};
use tiny_skia::{Path, Transform};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
    pub fn intersects(&self, o: &Rect) -> bool {
        self.x < o.right() && o.x < self.right() && self.y < o.bottom() && o.y < self.bottom()
    }
    pub fn union(&self, o: &Rect) -> Rect {
        if self.w <= 0.0 && self.h <= 0.0 {
            return *o;
        }
        if o.w <= 0.0 && o.h <= 0.0 {
            return *self;
        }
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        Rect::new(x, y, self.right().max(o.right()) - x, self.bottom().max(o.bottom()) - y)
    }
    pub fn inset(&self, l: f32, t: f32, r: f32, b: f32) -> Rect {
        Rect::new(self.x + l, self.y + t, (self.w - l - r).max(0.0), (self.h - t - b).max(0.0))
    }
    pub fn transformed(&self, t: &Transform) -> Rect {
        if t.is_identity() {
            return *self;
        }
        let pts = [(self.x, self.y), (self.right(), self.y), (self.x, self.bottom()), (self.right(), self.bottom())];
        let mut minx = f32::MAX;
        let mut miny = f32::MAX;
        let mut maxx = f32::MIN;
        let mut maxy = f32::MIN;
        for (x, y) in pts {
            let nx = t.sx * x + t.kx * y + t.tx;
            let ny = t.ky * x + t.sy * y + t.ty;
            minx = minx.min(nx);
            miny = miny.min(ny);
            maxx = maxx.max(nx);
            maxy = maxy.max(ny);
        }
        Rect::new(minx, miny, maxx - minx, maxy - miny)
    }
    pub fn to_skia(&self) -> Option<tiny_skia::Rect> {
        tiny_skia::Rect::from_xywh(self.x, self.y, self.w.max(0.001), self.h.max(0.001))
    }
}

/// Image décodée (RGBA prémultiplié), avec versions réduites générées à la demande.
pub struct RasterImage {
    pub pixmap: tiny_skia::Pixmap,
    mips: OnceLock<Vec<tiny_skia::Pixmap>>,
}

impl RasterImage {
    pub fn new(pixmap: tiny_skia::Pixmap) -> RasterImage {
        RasterImage { pixmap, mips: OnceLock::new() }
    }
    pub fn width(&self) -> u32 {
        self.pixmap.width()
    }
    pub fn height(&self) -> u32 {
        self.pixmap.height()
    }
    /// Renvoie la version la plus adaptée pour un affichage à `target_w` pixels de large.
    pub fn level_for(&self, target_w: f32, target_h: f32) -> &tiny_skia::Pixmap {
        let w = self.pixmap.width() as f32;
        let h = self.pixmap.height() as f32;
        if target_w * 2.0 >= w || target_h * 2.0 >= h {
            return &self.pixmap;
        }
        let mips = self.mips.get_or_init(|| {
            let mut out = Vec::new();
            let mut cur = self.pixmap.clone();
            while cur.width() > 64 && cur.height() > 64 {
                match downscale_half(&cur) {
                    Some(next) => {
                        out.push(next.clone());
                        cur = next;
                    }
                    None => break,
                }
            }
            out
        });
        let mut best = &self.pixmap;
        for m in mips {
            if (m.width() as f32) >= target_w && (m.height() as f32) >= target_h {
                best = m;
            } else {
                break;
            }
        }
        best
    }
}

fn downscale_half(p: &tiny_skia::Pixmap) -> Option<tiny_skia::Pixmap> {
    let w = (p.width() / 2).max(1);
    let h = (p.height() / 2).max(1);
    let mut out = tiny_skia::Pixmap::new(w, h)?;
    let src = p.data();
    let sw = p.width() as usize;
    let sh = p.height() as usize;
    let dst = out.data_mut();
    for y in 0..h as usize {
        for x in 0..w as usize {
            let mut acc = [0u32; 4];
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let sy = (y * 2 + dy).min(sh - 1);
                let sx = (x * 2 + dx).min(sw - 1);
                let i = (sy * sw + sx) * 4;
                for c in 0..4 {
                    acc[c] += src[i + c] as u32;
                }
            }
            let o = (y * w as usize + x) * 4;
            for c in 0..4 {
                dst[o + c] = ((acc[c] + 2) / 4) as u8;
            }
        }
    }
    Some(out)
}

#[derive(Clone, Debug)]
pub struct GlyphRun {
    pub font: FontId,
    pub size: f32,
    pub color: Color,
    /// Origine de la ligne de base.
    pub x: f32,
    pub y: f32,
    /// (identifiant du glyphe, décalage horizontal depuis l'origine)
    pub glyphs: Vec<(u16, f32)>,
    pub synth_bold: bool,
    pub synth_italic: bool,
    /// Compression/étirement horizontal (1.0 = normal).
    pub scale_x: f32,
}

impl GlyphRun {
    pub fn bounds(&self) -> Rect {
        let last = self.glyphs.last().map(|g| g.1).unwrap_or(0.0);
        Rect::new(self.x - self.size * 0.2, self.y - self.size * 1.1, last + self.size * 1.4, self.size * 1.5)
    }
}

#[derive(Clone)]
pub enum Paint {
    Solid(Color),
    /// Dégradé linéaire entre deux points (coordonnées de l'élément).
    Linear { x1: f32, y1: f32, x2: f32, y2: f32, stops: Vec<(f32, Color)> },
    Radial { cx: f32, cy: f32, r: f32, stops: Vec<(f32, Color)> },
    /// Image étirée sur le rectangle donné.
    Image { image: Arc<RasterImage>, rect: Rect, alpha: f32 },
}

impl Paint {
    pub fn solid(c: Color) -> Option<Paint> {
        (!c.is_transparent()).then_some(Paint::Solid(c))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DashStyle {
    Solid,
    Dash,
    Dot,
    DashDot,
    LongDash,
}

#[derive(Clone, Debug)]
pub struct StrokeStyle {
    pub color: Color,
    pub width: f32,
    pub dash: DashStyle,
}

impl StrokeStyle {
    pub fn new(color: Color, width: f32) -> StrokeStyle {
        StrokeStyle { color, width, dash: DashStyle::Solid }
    }
}

#[derive(Clone)]
pub enum Item {
    /// Rectangle plein.
    FillRect { rect: Rect, color: Color },
    /// Chemin quelconque (formes, flèches...).
    Path { path: Arc<Path>, fill: Option<Paint>, stroke: Option<StrokeStyle> },
    Line { x1: f32, y1: f32, x2: f32, y2: f32, stroke: StrokeStyle },
    Text(GlyphRun),
    Image { rect: Rect, image: Arc<RasterImage>, crop: [f32; 4], alpha: f32 },
    /// Espace réservé (image non prise en charge, ex. EMF).
    Placeholder { rect: Rect, label: String },
    Group { transform: Transform, clip: Option<Rect>, items: Vec<Item>, bounds: Rect },
}

impl Item {
    pub fn bounds(&self) -> Rect {
        match self {
            Item::FillRect { rect, .. } => *rect,
            Item::Path { path, stroke, .. } => {
                let b = path.bounds();
                let sw = stroke.as_ref().map(|s| s.width).unwrap_or(0.0);
                Rect::new(b.x() - sw, b.y() - sw, b.width() + 2.0 * sw, b.height() + 2.0 * sw)
            }
            Item::Line { x1, y1, x2, y2, stroke } => {
                let w = stroke.width.max(1.0);
                Rect::new(x1.min(*x2) - w, y1.min(*y2) - w, (x1 - x2).abs() + 2.0 * w, (y1 - y2).abs() + 2.0 * w)
            }
            Item::Text(run) => run.bounds(),
            Item::Image { rect, .. } => *rect,
            Item::Placeholder { rect, .. } => *rect,
            Item::Group { bounds, .. } => *bounds,
        }
    }

    pub fn group(transform: Transform, clip: Option<Rect>, items: Vec<Item>) -> Item {
        let mut b = Rect::default();
        for it in &items {
            b = b.union(&it.bounds());
        }
        if let Some(c) = clip {
            b = c;
        }
        let bounds = b.transformed(&transform);
        Item::Group { transform, clip, items, bounds }
    }

    /// Translate l'élément (utilisé lors de la mise en page).
    pub fn translate(&mut self, dx: f32, dy: f32) {
        match self {
            Item::FillRect { rect, .. } | Item::Image { rect, .. } | Item::Placeholder { rect, .. } => {
                rect.x += dx;
                rect.y += dy;
            }
            Item::Path { path, fill, .. } => {
                if let Some(p) = (**path).clone().transform(Transform::from_translate(dx, dy)) {
                    *path = Arc::new(p);
                }
                match fill {
                    Some(Paint::Linear { x1, y1, x2, y2, .. }) => {
                        *x1 += dx;
                        *x2 += dx;
                        *y1 += dy;
                        *y2 += dy;
                    }
                    Some(Paint::Radial { cx, cy, .. }) => {
                        *cx += dx;
                        *cy += dy;
                    }
                    Some(Paint::Image { rect, .. }) => {
                        rect.x += dx;
                        rect.y += dy;
                    }
                    _ => {}
                }
            }
            Item::Line { x1, y1, x2, y2, .. } => {
                *x1 += dx;
                *x2 += dx;
                *y1 += dy;
                *y2 += dy;
            }
            Item::Text(run) => {
                run.x += dx;
                run.y += dy;
            }
            Item::Group { transform, bounds, .. } => {
                *transform = transform.post_translate(dx, dy);
                bounds.x += dx;
                bounds.y += dy;
            }
        }
    }
}

/// Une page (ou diapositive) prête à être dessinée.
#[derive(Clone, Default)]
pub struct Page {
    pub width: f32,
    pub height: f32,
    pub background: Option<Color>,
    pub items: Vec<Item>,
    /// Texte brut de la page (recherche).
    pub text: String,
}

pub fn rect_path(r: Rect) -> Option<Path> {
    let rr = r.to_skia()?;
    Some(tiny_skia::PathBuilder::from_rect(rr))
}
