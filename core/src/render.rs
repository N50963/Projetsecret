//! Rasterisation logicielle d'une liste d'affichage (tiny-skia).
//! Le même moteur sert à l'application et aux tests : le rendu est identique partout.

use crate::color::Color;
use crate::display::{DashStyle, GlyphRun, Item, Page, Paint, RasterImage, Rect, StrokeStyle};
use crate::fonts::{self, FontId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use tiny_skia::{
    FillRule, FilterQuality, GradientStop, LineCap, LinearGradient, Mask, Path, PathBuilder, Pattern, Pixmap,
    Point, RadialGradient, SpreadMode, Stroke, StrokeDash, Transform,
};

struct OutlineBuilder(PathBuilder);

impl ttf_parser::OutlineBuilder for OutlineBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

thread_local! {
    static GLYPHS: RefCell<HashMap<(FontId, u16), Option<Arc<Path>>>> = RefCell::new(HashMap::new());
}

fn glyph_path(font: FontId, gid: u16) -> Option<Arc<Path>> {
    GLYPHS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() > 20000 {
            cache.clear();
        }
        cache
            .entry((font, gid))
            .or_insert_with(|| {
                let face = fonts::db().face(font)?;
                let mut b = OutlineBuilder(PathBuilder::new());
                face.outline_glyph(ttf_parser::GlyphId(gid), &mut b)?;
                b.0.finish().map(Arc::new)
            })
            .clone()
    })
}

/// Contexte de rendu : surface cible et rectangle visible en pixels.
pub struct Canvas<'a> {
    pub pixmap: &'a mut Pixmap,
    device: Rect,
}

impl<'a> Canvas<'a> {
    pub fn new(pixmap: &'a mut Pixmap) -> Canvas<'a> {
        let device = Rect::new(0.0, 0.0, pixmap.width() as f32, pixmap.height() as f32);
        Canvas { pixmap, device }
    }

    pub fn draw_items(&mut self, items: &[Item], ts: Transform, mask: Option<&Mask>) {
        for it in items {
            self.draw_item(it, ts, mask);
        }
    }

    fn visible(&self, r: &Rect, ts: &Transform) -> bool {
        let d = r.transformed(ts);
        d.intersects(&Rect::new(self.device.x - 2.0, self.device.y - 2.0, self.device.w + 4.0, self.device.h + 4.0))
    }

    pub fn draw_item(&mut self, item: &Item, ts: Transform, mask: Option<&Mask>) {
        let b = item.bounds();
        let d = b.transformed(&ts);
        // garde-fou : géométries dégénérées (fichiers corrompus ou inhabituels)
        if !(d.x.is_finite() && d.y.is_finite() && d.w.is_finite() && d.h.is_finite()) || d.w.abs() > 1.0e7 || d.h.abs() > 1.0e7 || !ts.is_finite() {
            return;
        }
        if !self.visible(&b, &ts) {
            return;
        }
        match item {
            Item::FillRect { rect, color } => {
                if let Some(r) = rect.to_skia() {
                    let paint = solid_paint(*color);
                    self.pixmap.fill_rect(r, &paint, ts, mask);
                }
            }
            Item::Path { path, fill, stroke } => {
                if let Some(f) = fill {
                    self.fill_path(path, f, ts, mask);
                }
                if let Some(s) = stroke {
                    self.stroke_path(path, s, ts, mask);
                }
            }
            Item::Line { x1, y1, x2, y2, stroke } => {
                let mut pb = PathBuilder::new();
                pb.move_to(*x1, *y1);
                pb.line_to(*x2, *y2);
                if let Some(p) = pb.finish() {
                    self.stroke_path(&p, stroke, ts, mask);
                }
            }
            Item::Text(run) => self.draw_text(run, ts, mask),
            Item::Image { rect, image, crop, alpha } => self.draw_image(*rect, image, *crop, *alpha, ts, mask),
            Item::Placeholder { rect, .. } => {
                if let Some(r) = rect.to_skia() {
                    self.pixmap.fill_rect(r, &solid_paint(Color::rgb(236, 238, 242)), ts, mask);
                    let p = PathBuilder::from_rect(r);
                    self.stroke_path(&p, &StrokeStyle::new(Color::rgb(190, 195, 205), 0.75), ts, mask);
                }
            }
            Item::Group { transform, clip, items, .. } => {
                let child = ts.pre_concat(*transform);
                if let Some(c) = clip {
                    let Some(cr) = c.to_skia() else { return };
                    let path = PathBuilder::from_rect(cr);
                    let new_mask = match mask {
                        Some(m) => {
                            let mut m2 = m.clone();
                            m2.intersect_path(&path, FillRule::Winding, true, child);
                            Some(m2)
                        }
                        None => {
                            let mut m2 = Mask::new(self.pixmap.width(), self.pixmap.height());
                            if let Some(m2) = m2.as_mut() {
                                m2.fill_path(&path, FillRule::Winding, true, child);
                            }
                            m2
                        }
                    };
                    self.draw_items(items, child, new_mask.as_ref().or(mask));
                } else {
                    self.draw_items(items, child, mask);
                }
            }
        }
    }

    fn fill_path(&mut self, path: &Path, fill: &Paint, ts: Transform, mask: Option<&Mask>) {
        match fill {
            Paint::Solid(c) => {
                self.pixmap.fill_path(path, &solid_paint(*c), FillRule::EvenOdd, ts, mask);
            }
            Paint::Linear { x1, y1, x2, y2, stops } => {
                if let Some(shader) = LinearGradient::new(Point::from_xy(*x1, *y1), Point::from_xy(*x2, *y2), grad_stops(stops), SpreadMode::Pad, Transform::identity()) {
                    let paint = tiny_skia::Paint { shader, anti_alias: true, ..Default::default() };
                    self.pixmap.fill_path(path, &paint, FillRule::EvenOdd, ts, mask);
                }
            }
            Paint::Radial { cx, cy, r, stops } => {
                let c = Point::from_xy(*cx, *cy);
                if let Some(shader) = RadialGradient::new(c, 0.0, c, r.max(0.1), grad_stops(stops), SpreadMode::Pad, Transform::identity()) {
                    let paint = tiny_skia::Paint { shader, anti_alias: true, ..Default::default() };
                    self.pixmap.fill_path(path, &paint, FillRule::EvenOdd, ts, mask);
                }
            }
            Paint::Image { image, rect, alpha } => {
                // Remplissage image : on découpe selon le chemin.
                let Some(m) = Mask::new(self.pixmap.width(), self.pixmap.height()) else { return };
                let mut m = m;
                m.fill_path(path, FillRule::EvenOdd, true, ts);
                if let Some(parent) = mask {
                    // intersection approximative : on combine les deux masques
                    let a = m.data_mut();
                    for (x, y) in a.iter_mut().zip(parent.data()) {
                        *x = ((*x as u16 * *y as u16) / 255) as u8;
                    }
                }
                self.draw_image(*rect, image, [0.0; 4], *alpha, ts, Some(&m));
            }
        }
    }

    fn stroke_path(&mut self, path: &Path, s: &StrokeStyle, ts: Transform, mask: Option<&Mask>) {
        if s.color.is_transparent() || s.width <= 0.0 {
            return;
        }
        // épaisseur minimale d'environ 0,6 pixel pour que les traits fins restent visibles
        let scale = (ts.sx * ts.sx + ts.ky * ts.ky).sqrt().max(1e-3);
        let w = s.width.max(0.6 / scale);
        let mut stroke = Stroke { width: w, ..Default::default() };
        let d = s.width.max(0.5);
        let pattern = match s.dash {
            DashStyle::Solid => None,
            DashStyle::Dash => Some(vec![4.0 * d, 3.0 * d]),
            DashStyle::LongDash => Some(vec![8.0 * d, 3.0 * d]),
            DashStyle::Dot => {
                stroke.line_cap = LineCap::Round;
                Some(vec![0.01, 2.0 * d])
            }
            DashStyle::DashDot => Some(vec![4.0 * d, 2.0 * d, 1.0 * d, 2.0 * d]),
        };
        if let Some(p) = pattern {
            stroke.dash = StrokeDash::new(p, 0.0);
        }
        self.pixmap.stroke_path(path, &solid_paint(s.color), &stroke, ts, mask);
    }

    fn draw_text(&mut self, run: &GlyphRun, ts: Transform, mask: Option<&Mask>) {
        if run.color.is_transparent() || run.size <= 0.0 {
            return;
        }
        let db = fonts::db();
        let upem = db.units_per_em(run.font);
        let s = run.size / upem;
        let sx = s * run.scale_x;
        let skew = if run.synth_italic { 0.21 } else { 0.0 };
        let paint = solid_paint(run.color);
        let bold_stroke = Stroke { width: upem * 0.035, ..Default::default() };
        // Taille apparente en pixels : en dessous d'un seuil, on simplifie.
        let px = run.size * (ts.sx * ts.sx + ts.ky * ts.ky).sqrt();
        for &(gid, gx) in &run.glyphs {
            let Some(path) = glyph_path(run.font, gid) else { continue };
            let gts = Transform::from_row(sx, 0.0, sx * skew, -s, run.x + gx, run.y);
            let full = ts.pre_concat(gts);
            if px < 1.2 {
                // texte microscopique (miniatures) : un simple trait gris
                let b = path.bounds();
                if let Some(r) = tiny_skia::Rect::from_ltrb(b.left(), 0.0, b.right(), b.bottom() * 0.6) {
                    let p2 = tiny_skia::Paint { shader: tiny_skia::Shader::SolidColor(run.color.with_alpha(0.5).to_skia()), anti_alias: true, ..Default::default() };
                    self.pixmap.fill_rect(r, &p2, full, mask);
                }
                continue;
            }
            self.pixmap.fill_path(&path, &paint, FillRule::Winding, full, mask);
            if run.synth_bold {
                self.pixmap.stroke_path(&path, &paint, &bold_stroke, full, mask);
            }
        }
    }

    fn draw_image(&mut self, rect: Rect, image: &Arc<RasterImage>, crop: [f32; 4], alpha: f32, ts: Transform, mask: Option<&Mask>) {
        let Some(dst) = rect.to_skia() else { return };
        let dev = rect.transformed(&ts);
        let level = image.level_for(dev.w, dev.h);
        let lw = level.width() as f32;
        let lh = level.height() as f32;
        let c = crop.map(|v| v.clamp(-10.0, 0.99));
        let sx0 = c[0] * lw;
        let sy0 = c[1] * lh;
        let sw = ((1.0 - c[0] - c[2]) * lw).max(1.0);
        let sh = ((1.0 - c[1] - c[3]) * lh).max(1.0);
        let pts = Transform::from_translate(rect.x, rect.y)
            .pre_scale(rect.w / sw, rect.h / sh)
            .pre_translate(-sx0, -sy0);
        let quality = if dev.w > lw * 1.5 { FilterQuality::Bicubic } else { FilterQuality::Bilinear };
        let shader = Pattern::new(level.as_ref(), SpreadMode::Pad, quality, alpha, pts);
        let paint = tiny_skia::Paint { shader, anti_alias: true, ..Default::default() };
        self.pixmap.fill_rect(dst, &paint, ts, mask);
    }
}

fn grad_stops(stops: &[(f32, Color)]) -> Vec<GradientStop> {
    stops.iter().map(|(p, c)| GradientStop::new(p.clamp(0.0, 1.0), c.to_skia())).collect()
}

fn solid_paint(c: Color) -> tiny_skia::Paint<'static> {
    let mut p = tiny_skia::Paint::default();
    p.set_color_rgba8(c.r, c.g, c.b, c.a);
    p.anti_alias = true;
    p
}

/// Dessine la zone d'une page commençant au point (`x0`, `y0`) avec `scale` pixels par point.
pub fn render_page_region(page: &Page, pixmap: &mut Pixmap, scale: f32, x0: f32, y0: f32) {
    let bg = page.background.unwrap_or(Color::WHITE);
    pixmap.fill(bg.to_skia());
    let ts = Transform::from_scale(scale, scale).pre_translate(-x0, -y0);
    let mut canvas = Canvas::new(pixmap);
    canvas.draw_items(&page.items, ts, None);
}

/// Rendu d'une page entière à l'échelle donnée.
pub fn render_page(page: &Page, scale: f32) -> Option<Pixmap> {
    let w = (page.width * scale).ceil().max(1.0) as u32;
    let h = (page.height * scale).ceil().max(1.0) as u32;
    let mut pm = Pixmap::new(w, h)?;
    render_page_region(page, &mut pm, scale, 0.0, 0.0);
    Some(pm)
}
