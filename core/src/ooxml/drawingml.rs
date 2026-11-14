//! DrawingML : couleurs, remplissages, contours et géométries prédéfinies
//! (partagé par PowerPoint, Word et Excel).

use super::theme::Theme;
use crate::color::{named_color, Color};
use crate::display::{DashStyle, Item, Paint, RasterImage, Rect, StrokeStyle};
use crate::package::NodeExt;
use roxmltree::Node;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::sync::Arc;
use tiny_skia::{Path, PathBuilder, Transform};

pub const EMU_PER_PT: f32 = 12700.0;

pub fn emu(v: Option<&str>) -> Option<f32> {
    v.and_then(|s| s.trim().parse::<f64>().ok()).map(|x| (x / EMU_PER_PT as f64) as f32)
}

pub struct ColorCtx<'a> {
    pub theme: &'a Theme,
    pub clr_map: Option<&'a HashMap<String, String>>,
    /// Couleur de substitution « phClr » (références de style).
    pub ph_color: Option<Color>,
}

impl<'a> ColorCtx<'a> {
    pub fn new(theme: &'a Theme) -> ColorCtx<'a> {
        ColorCtx { theme, clr_map: None, ph_color: None }
    }
    pub fn with_ph(&self, c: Option<Color>) -> ColorCtx<'a> {
        ColorCtx { theme: self.theme, clr_map: self.clr_map, ph_color: c }
    }
    pub fn scheme(&self, name: &str) -> Option<Color> {
        if name == "phClr" {
            return self.ph_color;
        }
        let mapped = match self.clr_map.and_then(|m| m.get(name)) {
            Some(v) => v.as_str(),
            None => match name {
                "bg1" => "lt1",
                "tx1" => "dk1",
                "bg2" => "lt2",
                "tx2" => "dk2",
                n => n,
            },
        };
        self.theme.color(mapped)
    }
}

/// Analyse un élément de couleur DrawingML et applique ses modificateurs.
pub fn parse_color_el(n: Node, ctx: &ColorCtx) -> Option<Color> {
    let base = match n.local() {
        "srgbClr" => n.attr("val").and_then(Color::from_hex),
        "schemeClr" => ctx.scheme(n.attr("val")?),
        "sysClr" => n.attr("lastClr").and_then(Color::from_hex).or_else(|| match n.attr("val") {
            Some("windowText") | Some("btnText") | Some("menuText") => Some(Color::BLACK),
            _ => Some(Color::WHITE),
        }),
        "prstClr" => n.attr("val").and_then(named_color),
        "scrgbClr" => {
            let f = |a: &str| n.attr(a).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) / 100000.0;
            let c = |v: f32| (v.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0) as u8;
            Some(Color::rgb(c(f("r")), c(f("g")), c(f("b"))))
        }
        "hslClr" => {
            let f = |a: &str| n.attr(a).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
            Some(Color::from_hsl(f("hue") / 21600000.0, f("sat") / 100000.0, f("lum") / 100000.0, 255))
        }
        _ => None,
    }?;
    Some(apply_mods(base, n))
}

pub fn apply_mods(mut c: Color, n: Node) -> Color {
    let mut lum_mod = 1.0;
    let mut lum_off = 0.0;
    let mut has_lum = false;
    for m in n.children().filter(|m| m.is_element()) {
        let v = m.attr("val").and_then(|v| v.parse::<f32>().ok()).unwrap_or(100000.0) / 100000.0;
        match m.local() {
            "lumMod" => {
                lum_mod = v;
                has_lum = true;
            }
            "lumOff" => {
                lum_off = v;
                has_lum = true;
            }
            "tint" => c = c.tint(v),
            "shade" => c = c.shade(v),
            "satMod" => c = c.sat_mod(v),
            "alpha" => c.a = (v.clamp(0.0, 1.0) * 255.0).round() as u8,
            "alphaMod" => c.a = ((c.a as f32) * v).clamp(0.0, 255.0) as u8,
            "inv" => c = Color::rgba(255 - c.r, 255 - c.g, 255 - c.b, c.a),
            "gray" => {
                let l = (c.luminance() * 255.0) as u8;
                c = Color::rgba(l, l, l, c.a);
            }
            "comp" => {
                let (h, s, l) = c.to_hsl();
                c = Color::from_hsl((h + 0.5) % 1.0, s, l, c.a);
            }
            _ => {}
        }
    }
    if has_lum {
        c = c.lum_mod_off(lum_mod, lum_off);
    }
    c
}

/// Première couleur trouvée parmi les enfants d'un élément (ex. a:solidFill).
pub fn child_color(n: Node, ctx: &ColorCtx) -> Option<Color> {
    n.children().filter(|c| c.is_element()).find_map(|c| parse_color_el(c, ctx))
}

#[derive(Clone, Debug)]
pub enum Fill {
    None,
    Solid(Color),
    Gradient { stops: Vec<(f32, Color)>, angle: f32, radial: bool },
    Image { rel: String, alpha: f32, crop: [f32; 4] },
    Group,
}

/// Cherche le remplissage parmi les enfants d'un élément (spPr, bgPr, tcPr...).
pub fn parse_fill(parent: Node, ctx: &ColorCtx) -> Option<Fill> {
    for c in parent.children().filter(|c| c.is_element()) {
        if let Some(f) = parse_fill_el(c, ctx) {
            return Some(f);
        }
    }
    None
}

pub fn parse_fill_el(c: Node, ctx: &ColorCtx) -> Option<Fill> {
    match c.local() {
        "noFill" => Some(Fill::None),
        "solidFill" => Some(child_color(c, ctx).map(Fill::Solid).unwrap_or(Fill::None)),
        "gradFill" => {
            let mut stops: Vec<(f32, Color)> = Vec::new();
            if let Some(gs) = c.child("gsLst") {
                for s in gs.children_named("gs") {
                    let pos = s.attr("pos").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) / 100000.0;
                    if let Some(col) = child_color(s, ctx) {
                        stops.push((pos, col));
                    }
                }
            }
            stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            if stops.is_empty() {
                return Some(Fill::None);
            }
            let angle = c.child("lin").and_then(|l| l.attr("ang")).and_then(|v| v.parse::<f32>().ok()).unwrap_or(5400000.0) / 60000.0;
            let radial = c.child("path").is_some();
            Some(Fill::Gradient { stops, angle, radial })
        }
        "blipFill" => {
            let blip = c.child("blip")?;
            let rel = blip.attr("embed").or_else(|| blip.attr("link"))?.to_string();
            let alpha = blip
                .children()
                .find(|x| x.local() == "alphaModFix")
                .and_then(|x| x.attr("amt"))
                .and_then(|v| v.parse::<f32>().ok())
                .map(|v| v / 100000.0)
                .unwrap_or(1.0);
            let crop = parse_src_rect(c.child("srcRect"));
            Some(Fill::Image { rel, alpha, crop })
        }
        "pattFill" => {
            let fg = c.child("fgClr").and_then(|f| child_color(f, ctx));
            let bg = c.child("bgClr").and_then(|f| child_color(f, ctx));
            match (fg, bg) {
                (Some(f), Some(b)) => Some(Fill::Solid(f.mix(b, 0.6))),
                (Some(f), None) => Some(Fill::Solid(f)),
                (None, Some(b)) => Some(Fill::Solid(b)),
                _ => Some(Fill::None),
            }
        }
        "grpFill" => Some(Fill::Group),
        _ => None,
    }
}

pub fn parse_src_rect(n: Option<Node>) -> [f32; 4] {
    let Some(n) = n else { return [0.0; 4] };
    let f = |a: &str| n.attr(a).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) / 100000.0;
    [f("l"), f("t"), f("r"), f("b")]
}

pub fn fill_to_paint(fill: &Fill, rect: Rect, image: &dyn Fn(&str) -> Option<Arc<RasterImage>>) -> Option<Paint> {
    match fill {
        Fill::None | Fill::Group => None,
        Fill::Solid(c) => Paint::solid(*c),
        Fill::Gradient { stops, angle, radial } => {
            if *radial {
                let cx = rect.x + rect.w / 2.0;
                let cy = rect.y + rect.h / 2.0;
                let r = (rect.w * rect.w + rect.h * rect.h).sqrt() / 2.0;
                Some(Paint::Radial { cx, cy, r, stops: stops.clone() })
            } else {
                let a = angle.to_radians();
                let (dx, dy) = (a.cos(), a.sin());
                let cx = rect.x + rect.w / 2.0;
                let cy = rect.y + rect.h / 2.0;
                let half = (rect.w * dx.abs() + rect.h * dy.abs()) / 2.0;
                Some(Paint::Linear { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half, stops: stops.clone() })
            }
        }
        Fill::Image { rel, alpha, crop } => {
            let img = image(rel)?;
            let _ = crop;
            Some(Paint::Image { image: img, rect, alpha: *alpha })
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ArrowKind {
    Triangle,
    Arrow,
    Stealth,
    Oval,
    Diamond,
}

#[derive(Clone, Debug)]
pub struct LineDef {
    pub color: Option<Color>,
    pub width: f32,
    pub dash: DashStyle,
    pub head: Option<ArrowKind>,
    pub tail: Option<ArrowKind>,
}

impl Default for LineDef {
    fn default() -> Self {
        LineDef { color: None, width: 0.75, dash: DashStyle::Solid, head: None, tail: None }
    }
}

/// Fusionne un élément a:ln dans une définition de ligne existante.
pub fn merge_line(base: &mut LineDef, ln: Node, ctx: &ColorCtx) {
    if let Some(w) = emu(ln.attr("w")) {
        base.width = w;
    }
    for c in ln.children().filter(|c| c.is_element()) {
        match c.local() {
            "noFill" => base.color = None,
            "solidFill" => base.color = child_color(c, ctx),
            "gradFill" => {
                if let Some(Fill::Gradient { stops, .. }) = parse_fill_el(c, ctx) {
                    base.color = stops.first().map(|s| s.1);
                }
            }
            "prstDash" => {
                base.dash = match c.attr("val").unwrap_or("solid") {
                    "dash" | "sysDash" => DashStyle::Dash,
                    "dot" | "sysDot" => DashStyle::Dot,
                    "dashDot" | "sysDashDot" | "lgDashDot" | "sysDashDotDot" | "lgDashDotDot" => DashStyle::DashDot,
                    "lgDash" => DashStyle::LongDash,
                    _ => DashStyle::Solid,
                }
            }
            "headEnd" => base.head = arrow(c.attr("type")),
            "tailEnd" => base.tail = arrow(c.attr("type")),
            _ => {}
        }
    }
}

fn arrow(t: Option<&str>) -> Option<ArrowKind> {
    match t? {
        "triangle" => Some(ArrowKind::Triangle),
        "arrow" => Some(ArrowKind::Arrow),
        "stealth" => Some(ArrowKind::Stealth),
        "oval" => Some(ArrowKind::Oval),
        "diamond" => Some(ArrowKind::Diamond),
        _ => None,
    }
}

impl LineDef {
    pub fn stroke(&self) -> Option<StrokeStyle> {
        let c = self.color?;
        if c.is_transparent() {
            return None;
        }
        Some(StrokeStyle { color: c, width: self.width.max(0.1), dash: self.dash })
    }
}

/// Valeurs d'ajustement (a:avLst/a:gd) d'une géométrie prédéfinie.
pub fn parse_adjust(prst: Node) -> HashMap<String, f32> {
    let mut m = HashMap::new();
    if let Some(av) = prst.child("avLst") {
        for gd in av.children_named("gd") {
            if let (Some(name), Some(fmla)) = (gd.attr("name"), gd.attr("fmla")) {
                if let Some(v) = fmla.strip_prefix("val ") {
                    if let Ok(v) = v.trim().parse::<f32>() {
                        m.insert(name.to_string(), v);
                    }
                }
            }
        }
    }
    m
}

fn ellipse_to(pb: &mut PathBuilder, cx: f32, cy: f32, rx: f32, ry: f32, a0: f32, a1: f32, move_first: bool) {
    // arc approximé par segments de Bézier cubiques
    let segs = (((a1 - a0).abs() / (PI / 2.0)).ceil() as usize).max(1);
    let step = (a1 - a0) / segs as f32;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let mut a = a0;
    let (mut x0, mut y0) = (cx + rx * a.cos(), cy + ry * a.sin());
    if move_first {
        pb.move_to(x0, y0);
    } else {
        pb.line_to(x0, y0);
    }
    for _ in 0..segs {
        let b = a + step;
        let (x3, y3) = (cx + rx * b.cos(), cy + ry * b.sin());
        let c1 = (x0 - k * rx * a.sin(), y0 + k * ry * a.cos());
        let c2 = (x3 + k * rx * b.sin(), y3 - k * ry * b.cos());
        pb.cubic_to(c1.0, c1.1, c2.0, c2.1, x3, y3);
        a = b;
        x0 = x3;
        y0 = y3;
    }
}

fn poly(pb: &mut PathBuilder, pts: &[(f32, f32)]) {
    if let Some((x, y)) = pts.first() {
        pb.move_to(*x, *y);
        for (x, y) in &pts[1..] {
            pb.line_to(*x, *y);
        }
        pb.close();
    }
}

fn round_rect(pb: &mut PathBuilder, x: f32, y: f32, w: f32, h: f32, r: [f32; 4]) {
    // r : haut-gauche, haut-droite, bas-droite, bas-gauche
    let k = 0.5523;
    pb.move_to(x + r[0], y);
    pb.line_to(x + w - r[1], y);
    if r[1] > 0.0 {
        pb.cubic_to(x + w - r[1] * (1.0 - k), y, x + w, y + r[1] * (1.0 - k), x + w, y + r[1]);
    }
    pb.line_to(x + w, y + h - r[2]);
    if r[2] > 0.0 {
        pb.cubic_to(x + w, y + h - r[2] * (1.0 - k), x + w - r[2] * (1.0 - k), y + h, x + w - r[2], y + h);
    }
    pb.line_to(x + r[3], y + h);
    if r[3] > 0.0 {
        pb.cubic_to(x + r[3] * (1.0 - k), y + h, x, y + h - r[3] * (1.0 - k), x, y + h - r[3]);
    }
    pb.line_to(x, y + r[0]);
    if r[0] > 0.0 {
        pb.cubic_to(x, y + r[0] * (1.0 - k), x + r[0] * (1.0 - k), y, x + r[0], y);
    }
    pb.close();
}

/// Indique si la géométrie est un trait ouvert (pas de remplissage).
pub fn is_open_shape(name: &str) -> bool {
    matches!(
        name,
        "line" | "straightConnector1" | "bentConnector2" | "bentConnector3" | "bentConnector4" | "bentConnector5" | "curvedConnector2" | "curvedConnector3" | "curvedConnector4" | "curvedConnector5" | "arc" | "leftBracket" | "rightBracket" | "leftBrace" | "rightBrace" | "bracketPair" | "bracePair"
    )
}

/// Chemin d'une géométrie prédéfinie dans le repère (0,0)-(w,h).
pub fn preset_path(name: &str, w: f32, h: f32, adj: &HashMap<String, f32>) -> Option<Path> {
    let w = w.max(0.01);
    let h = h.max(0.01);
    let ss = w.min(h);
    let a = |k: &str, d: f32| adj.get(k).copied().unwrap_or(d) / 100000.0;
    let mut pb = PathBuilder::new();
    match name {
        "rect" | "flowChartProcess" | "flowChartPredefinedProcess" | "flowChartInternalStorage" | "textBox" | "actionButtonBlank" => {
            pb.push_rect(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
            if name == "flowChartPredefinedProcess" {
                pb.move_to(w * 0.125, 0.0);
                pb.line_to(w * 0.125, h);
                pb.move_to(w * 0.875, 0.0);
                pb.line_to(w * 0.875, h);
            }
        }
        "roundRect" | "flowChartAlternateProcess" => {
            let r = ss * a("adj", if name == "roundRect" { 16667.0 } else { 16667.0 });
            round_rect(&mut pb, 0.0, 0.0, w, h, [r; 4]);
        }
        "round1Rect" => {
            let r = ss * a("adj", 16667.0);
            round_rect(&mut pb, 0.0, 0.0, w, h, [0.0, r, 0.0, 0.0]);
        }
        "round2SameRect" => {
            let r1 = ss * a("adj1", 16667.0);
            let r2 = ss * a("adj2", 0.0);
            round_rect(&mut pb, 0.0, 0.0, w, h, [r1, r1, r2, r2]);
        }
        "round2DiagRect" => {
            let r1 = ss * a("adj1", 16667.0);
            let r2 = ss * a("adj2", 0.0);
            round_rect(&mut pb, 0.0, 0.0, w, h, [r1, r2, r1, r2]);
        }
        "snip1Rect" => {
            let s = ss * a("adj", 16667.0);
            poly(&mut pb, &[(0.0, 0.0), (w - s, 0.0), (w, s), (w, h), (0.0, h)]);
        }
        "snip2SameRect" => {
            let s = ss * a("adj1", 16667.0);
            poly(&mut pb, &[(s, 0.0), (w - s, 0.0), (w, s), (w, h), (0.0, h), (0.0, s)]);
        }
        "snipRoundRect" => {
            let r = ss * a("adj1", 16667.0);
            let s = ss * a("adj2", 16667.0);
            pb.move_to(r, 0.0);
            pb.line_to(w - s, 0.0);
            pb.line_to(w, s);
            pb.line_to(w, h);
            pb.line_to(0.0, h);
            pb.line_to(0.0, r);
            pb.quad_to(0.0, 0.0, r, 0.0);
            pb.close();
        }
        "ellipse" | "flowChartConnector" | "smileyFace" | "noSmoking" | "flowChartOr" | "flowChartSummingJunction" | "cloud" | "cloudCallout" => {
            pb.push_oval(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
            if name == "flowChartOr" {
                pb.move_to(w / 2.0, 0.0);
                pb.line_to(w / 2.0, h);
                pb.move_to(0.0, h / 2.0);
                pb.line_to(w, h / 2.0);
            }
        }
        "triangle" | "flowChartExtract" | "flowChartMerge" => {
            let x = w * a("adj", 50000.0);
            if name == "flowChartMerge" {
                poly(&mut pb, &[(0.0, 0.0), (w, 0.0), (w / 2.0, h)]);
            } else {
                poly(&mut pb, &[(x, 0.0), (w, h), (0.0, h)]);
            }
        }
        "rtTriangle" => poly(&mut pb, &[(0.0, 0.0), (w, h), (0.0, h)]),
        "diamond" | "flowChartDecision" => poly(&mut pb, &[(w / 2.0, 0.0), (w, h / 2.0), (w / 2.0, h), (0.0, h / 2.0)]),
        "parallelogram" | "flowChartInputOutput" => {
            let x = if name == "parallelogram" { ss * a("adj", 25000.0) } else { w * 0.2 };
            poly(&mut pb, &[(x, 0.0), (w, 0.0), (w - x, h), (0.0, h)]);
        }
        "trapezoid" | "flowChartManualOperation" => {
            let x = if name == "trapezoid" { ss * a("adj", 25000.0) } else { w * 0.2 };
            if name == "trapezoid" {
                poly(&mut pb, &[(x, 0.0), (w - x, 0.0), (w, h), (0.0, h)]);
            } else {
                poly(&mut pb, &[(0.0, 0.0), (w, 0.0), (w - x, h), (x, h)]);
            }
        }
        "pentagon" | "homePlate" => {
            if name == "homePlate" {
                let x = w - ss * a("adj", 50000.0);
                poly(&mut pb, &[(0.0, 0.0), (x, 0.0), (w, h / 2.0), (x, h), (0.0, h)]);
            } else {
                let pts: Vec<(f32, f32)> = (0..5)
                    .map(|i| {
                        let ang = -PI / 2.0 + i as f32 * 2.0 * PI / 5.0;
                        (w / 2.0 + w / 2.0 * ang.cos(), h / 2.0 + h / 2.0 * ang.sin() * 1.05 + h * 0.025)
                    })
                    .collect();
                poly(&mut pb, &pts);
            }
        }
        "chevron" => {
            let x = ss * a("adj", 50000.0);
            poly(&mut pb, &[(0.0, 0.0), (w - x, 0.0), (w, h / 2.0), (w - x, h), (0.0, h), (x, h / 2.0)]);
        }
        "hexagon" => {
            let x = ss * a("adj", 25000.0);
            poly(&mut pb, &[(x, 0.0), (w - x, 0.0), (w, h / 2.0), (w - x, h), (x, h), (0.0, h / 2.0)]);
        }
        "octagon" => {
            let x = ss * a("adj", 29289.0);
            poly(&mut pb, &[(x, 0.0), (w - x, 0.0), (w, x), (w, h - x), (w - x, h), (x, h), (0.0, h - x), (0.0, x)]);
        }
        "decagon" | "dodecagon" | "heptagon" => {
            let n = match name {
                "decagon" => 10,
                "dodecagon" => 12,
                _ => 7,
            };
            let pts: Vec<(f32, f32)> = (0..n)
                .map(|i| {
                    let ang = -PI / 2.0 + i as f32 * 2.0 * PI / n as f32;
                    (w / 2.0 + w / 2.0 * ang.cos(), h / 2.0 + h / 2.0 * ang.sin())
                })
                .collect();
            poly(&mut pb, &pts);
        }
        "plus" | "flowChartPunchedCard" if name == "plus" => {
            let x = ss * a("adj", 25000.0);
            poly(&mut pb, &[(x, 0.0), (w - x, 0.0), (w - x, x), (w, x), (w, h - x), (w - x, h - x), (w - x, h), (x, h), (x, h - x), (0.0, h - x), (0.0, x), (x, x)]);
        }
        "star4" | "star5" | "star6" | "star7" | "star8" | "star10" | "star12" | "star16" | "star24" | "star32" | "irregularSeal1" | "irregularSeal2" => {
            let n: usize = match name {
                "star4" => 4,
                "star5" => 5,
                "star6" => 6,
                "star7" => 7,
                "star8" => 8,
                "star10" => 10,
                "star12" => 12,
                "star16" => 16,
                "star24" => 24,
                "star32" => 32,
                _ => 12,
            };
            let inner = match name {
                "star5" => a("adj", 19098.0) * 2.0,
                "star4" => a("adj", 12500.0) * 2.0,
                _ => a("adj", 37500.0) * 1.0 + 0.0,
            }
            .clamp(0.1, 0.95);
            let mut pts = Vec::new();
            for i in 0..2 * n {
                let ang = -PI / 2.0 + i as f32 * PI / n as f32;
                let r = if i % 2 == 0 { 1.0 } else { inner };
                pts.push((w / 2.0 + w / 2.0 * r * ang.cos(), h / 2.0 + h / 2.0 * r * ang.sin()));
            }
            poly(&mut pb, &pts);
        }
        "rightArrow" | "leftArrow" | "upArrow" | "downArrow" | "notchedRightArrow" | "stripedRightArrow" => {
            let sh = a("adj1", 50000.0);
            let hl = a("adj2", 50000.0);
            let (ww, hh, rot) = match name {
                "upArrow" | "downArrow" => (h, w, true),
                _ => (w, h, false),
            };
            let head = (hh.min(ww) * hl).min(ww);
            let y1 = hh * (0.5 - sh / 2.0);
            let y2 = hh * (0.5 + sh / 2.0);
            let notch = if name == "notchedRightArrow" { head * 0.5 } else { 0.0 };
            let pts = vec![(0.0, y1), (ww - head, y1), (ww - head, 0.0), (ww, hh / 2.0), (ww - head, hh), (ww - head, y2), (0.0, y2), (notch, hh / 2.0)];
            let map = |(x, y): (f32, f32)| -> (f32, f32) {
                match name {
                    "leftArrow" => (ww - x, y),
                    "upArrow" => (y, ww - x),
                    "downArrow" => (y, x),
                    _ => (x, y),
                }
            };
            let _ = rot;
            let pts: Vec<(f32, f32)> = pts.into_iter().map(map).collect();
            poly(&mut pb, &pts);
        }
        "leftRightArrow" | "upDownArrow" => {
            let sh = a("adj1", 50000.0);
            let hl = a("adj2", 50000.0);
            let vertical = name == "upDownArrow";
            let (ww, hh) = if vertical { (h, w) } else { (w, h) };
            let head = (hh.min(ww) * hl).min(ww / 2.0);
            let y1 = hh * (0.5 - sh / 2.0);
            let y2 = hh * (0.5 + sh / 2.0);
            let pts = vec![(0.0, hh / 2.0), (head, 0.0), (head, y1), (ww - head, y1), (ww - head, 0.0), (ww, hh / 2.0), (ww - head, hh), (ww - head, y2), (head, y2), (head, hh)];
            let pts: Vec<(f32, f32)> = pts.into_iter().map(|(x, y)| if vertical { (y, x) } else { (x, y) }).collect();
            poly(&mut pb, &pts);
        }
        "can" | "flowChartMagneticDisk" => {
            let ry = ss * a("adj", 25000.0) / 2.0;
            pb.move_to(0.0, ry);
            ellipse_to(&mut pb, w / 2.0, ry, w / 2.0, ry, PI, 2.0 * PI, false);
            pb.line_to(w, h - ry);
            ellipse_to(&mut pb, w / 2.0, h - ry, w / 2.0, ry, 0.0, PI, false);
            pb.close();
            ellipse_to(&mut pb, w / 2.0, ry, w / 2.0, ry, 0.0, PI, true);
        }
        "cube" => {
            let d = ss * a("adj", 25000.0);
            poly(&mut pb, &[(0.0, d), (w - d, d), (w - d, h), (0.0, h)]);
            poly(&mut pb, &[(0.0, d), (d, 0.0), (w, 0.0), (w - d, d)]);
            poly(&mut pb, &[(w - d, d), (w, 0.0), (w, h - d), (w - d, h)]);
        }
        "donut" => {
            let t = ss * a("adj", 25000.0);
            pb.push_oval(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
            if w > 2.0 * t && h > 2.0 * t {
                pb.push_oval(tiny_skia::Rect::from_xywh(t, t, w - 2.0 * t, h - 2.0 * t)?);
            }
        }
        "frame" => {
            let t = ss * a("adj1", 12500.0);
            pb.push_rect(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
            if w > 2.0 * t && h > 2.0 * t {
                pb.push_rect(tiny_skia::Rect::from_xywh(t, t, w - 2.0 * t, h - 2.0 * t)?);
            }
        }
        "flowChartTerminator" => {
            let r = h / 2.0;
            round_rect(&mut pb, 0.0, 0.0, w, h, [r.min(w / 2.0); 4]);
        }
        "flowChartDocument" | "wave" | "doubleWave" => {
            pb.move_to(0.0, 0.0);
            pb.line_to(w, 0.0);
            pb.line_to(w, h * 0.83);
            pb.cubic_to(w * 0.75, h * 0.70, w * 0.5, h * 1.05, w * 0.25, h * 0.95);
            pb.cubic_to(w * 0.12, h * 0.9, 0.0, h * 0.85, 0.0, h * 0.83);
            pb.close();
        }
        "flowChartMultidocument" => {
            pb.push_rect(tiny_skia::Rect::from_xywh(0.0, h * 0.1, w * 0.88, h * 0.8)?);
            pb.move_to(w * 0.06, h * 0.1);
            pb.line_to(w * 0.06, h * 0.05);
            pb.line_to(w * 0.94, h * 0.05);
            pb.line_to(w * 0.94, h * 0.85);
            pb.line_to(w * 0.88, h * 0.85);
        }
        "flowChartPreparation" => {
            let x = w * 0.2;
            poly(&mut pb, &[(x, 0.0), (w - x, 0.0), (w, h / 2.0), (w - x, h), (x, h), (0.0, h / 2.0)]);
        }
        "flowChartManualInput" => poly(&mut pb, &[(0.0, h * 0.2), (w, 0.0), (w, h), (0.0, h)]),
        "flowChartDelay" => {
            pb.move_to(0.0, 0.0);
            pb.line_to(w / 2.0, 0.0);
            ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, -PI / 2.0, PI / 2.0, false);
            pb.line_to(0.0, h);
            pb.close();
        }
        "flowChartOffpageConnector" => poly(&mut pb, &[(0.0, 0.0), (w, 0.0), (w, h * 0.8), (w / 2.0, h), (0.0, h * 0.8)]),
        "flowChartPunchedCard" => poly(&mut pb, &[(w * 0.2, 0.0), (w, 0.0), (w, h), (0.0, h), (0.0, h * 0.2)]),
        "flowChartSort" | "flowChartCollate" => {
            poly(&mut pb, &[(w / 2.0, 0.0), (w, h / 2.0), (w / 2.0, h), (0.0, h / 2.0)]);
            pb.move_to(0.0, h / 2.0);
            pb.line_to(w, h / 2.0);
        }
        "pie" | "blockArc" | "chord" | "arc" => {
            let a1 = adj.get("adj1").copied().unwrap_or(if name == "arc" { 16200000.0 } else { 0.0 }) / 60000.0;
            let a2 = adj.get("adj2").copied().unwrap_or(if name == "arc" { 0.0 } else { 16200000.0 }) / 60000.0;
            let s = a1.to_radians();
            let mut e = a2.to_radians();
            if e <= s {
                e += 2.0 * PI;
            }
            match name {
                "pie" => {
                    pb.move_to(w / 2.0, h / 2.0);
                    ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, s, e, false);
                    pb.close();
                }
                "chord" => {
                    ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, s, e, true);
                    pb.close();
                }
                "arc" => ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, s, e, true),
                _ => {
                    let t = ss * a("adj3", 25000.0);
                    ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, s, e, true);
                    ellipse_to(&mut pb, w / 2.0, h / 2.0, (w / 2.0 - t).max(0.0), (h / 2.0 - t).max(0.0), e, s, false);
                    pb.close();
                }
            }
        }
        "heart" => {
            pb.move_to(w / 2.0, h * 0.25);
            pb.cubic_to(w * 0.5, 0.0, 0.0, 0.0, 0.0, h * 0.3);
            pb.cubic_to(0.0, h * 0.6, w * 0.4, h * 0.75, w / 2.0, h);
            pb.cubic_to(w * 0.6, h * 0.75, w, h * 0.6, w, h * 0.3);
            pb.cubic_to(w, 0.0, w * 0.5, 0.0, w / 2.0, h * 0.25);
            pb.close();
        }
        "lightningBolt" => poly(&mut pb, &[(w * 0.39, 0.0), (w * 0.62, h * 0.35), (w * 0.53, h * 0.39), (w * 0.81, h * 0.66), (w * 0.73, h * 0.70), (w, h), (w * 0.45, h * 0.74), (w * 0.55, h * 0.70), (w * 0.17, h * 0.47), (w * 0.27, h * 0.42), (0.0, h * 0.18)]),
        "sun" => {
            pb.push_oval(tiny_skia::Rect::from_xywh(w * 0.25, h * 0.25, w * 0.5, h * 0.5)?);
            for i in 0..8 {
                let ang = i as f32 * PI / 4.0;
                let (c, s) = (ang.cos(), ang.sin());
                let p = |r: f32, da: f32| (w / 2.0 + w / 2.0 * r * (ang + da).cos(), h / 2.0 + h / 2.0 * r * (ang + da).sin());
                let _ = (c, s);
                poly(&mut pb, &[p(1.0, 0.0), p(0.62, 0.12), p(0.62, -0.12)]);
            }
        }
        "moon" => {
            pb.move_to(w, 0.0);
            pb.cubic_to(-w * 0.33, 0.0, -w * 0.33, h, w, h);
            pb.cubic_to(w * 0.2, h * 0.8, w * 0.2, h * 0.2, w, 0.0);
            pb.close();
        }
        "plaque" => {
            let r = ss * a("adj", 16667.0);
            pb.move_to(r, 0.0);
            pb.line_to(w - r, 0.0);
            pb.quad_to(w - r, r, w, r);
            pb.line_to(w, h - r);
            pb.quad_to(w - r, h - r, w - r, h);
            pb.line_to(r, h);
            pb.quad_to(r, h - r, 0.0, h - r);
            pb.line_to(0.0, r);
            pb.quad_to(r, r, r, 0.0);
            pb.close();
        }
        "corner" => {
            let t1 = ss * a("adj1", 50000.0);
            let t2 = ss * a("adj2", 50000.0);
            poly(&mut pb, &[(0.0, 0.0), (t2, 0.0), (t2, h - t1), (w, h - t1), (w, h), (0.0, h)]);
        }
        "halfFrame" => {
            let t1 = ss * a("adj1", 33333.0);
            let t2 = ss * a("adj2", 33333.0);
            poly(&mut pb, &[(0.0, 0.0), (w, 0.0), (w - t1, t1), (t2, t1), (t2, h - t2), (0.0, h)]);
        }
        "teardrop" => {
            pb.move_to(0.0, h / 2.0);
            ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, PI, 1.5 * PI, false);
            pb.line_to(w, 0.0);
            pb.line_to(w, h / 2.0);
            ellipse_to(&mut pb, w / 2.0, h / 2.0, w / 2.0, h / 2.0, 0.0, PI, false);
            pb.close();
        }
        "foldedCorner" => {
            let d = ss * a("adj", 16667.0);
            poly(&mut pb, &[(0.0, 0.0), (w, 0.0), (w, h - d), (w - d, h), (0.0, h)]);
        }
        "bevel" => {
            let d = ss * a("adj", 12500.0);
            pb.push_rect(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
            pb.push_rect(tiny_skia::Rect::from_xywh(d, d, (w - 2.0 * d).max(0.1), (h - 2.0 * d).max(0.1))?);
        }
        "wedgeRectCallout" | "wedgeRoundRectCallout" | "wedgeEllipseCallout" | "borderCallout1" | "callout1" | "accentCallout1" => {
            let tx = w / 2.0 + w * a("adj1", -20833.0);
            let ty = h / 2.0 + h * a("adj2", 62500.0);
            match name {
                "wedgeEllipseCallout" => {
                    pb.push_oval(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
                }
                "wedgeRoundRectCallout" => round_rect(&mut pb, 0.0, 0.0, w, h, [ss * 0.1667; 4]),
                _ => {
                    pb.push_rect(tiny_skia::Rect::from_xywh(0.0, 0.0, w, h)?);
                }
            }
            if name.starts_with("wedge") {
                // pointe de la bulle
                let (bx1, by1, bx2, by2) = if ty > h {
                    (w * 0.25, h * 0.98, w * 0.42, h * 0.98)
                } else if ty < 0.0 {
                    (w * 0.25, h * 0.02, w * 0.42, h * 0.02)
                } else if tx < 0.0 {
                    (w * 0.02, h * 0.6, w * 0.02, h * 0.8)
                } else {
                    (w * 0.98, h * 0.6, w * 0.98, h * 0.8)
                };
                poly(&mut pb, &[(bx1, by1), (tx, ty), (bx2, by2)]);
            }
        }
        "line" | "straightConnector1" => {
            pb.move_to(0.0, 0.0);
            pb.line_to(w, h);
        }
        "bentConnector2" => {
            pb.move_to(0.0, 0.0);
            pb.line_to(w, 0.0);
            pb.line_to(w, h);
        }
        "bentConnector3" => {
            let x = w * a("adj1", 50000.0);
            pb.move_to(0.0, 0.0);
            pb.line_to(x, 0.0);
            pb.line_to(x, h);
            pb.line_to(w, h);
        }
        "bentConnector4" | "bentConnector5" => {
            let x = w * a("adj1", 50000.0);
            let y = h * a("adj2", 50000.0);
            pb.move_to(0.0, 0.0);
            pb.line_to(x, 0.0);
            pb.line_to(x, y);
            pb.line_to(w, y);
            pb.line_to(w, h);
        }
        "curvedConnector2" | "curvedConnector3" | "curvedConnector4" | "curvedConnector5" => {
            pb.move_to(0.0, 0.0);
            pb.cubic_to(w * 0.5, 0.0, w * 0.5, h, w, h);
        }
        "leftBracket" => {
            pb.move_to(w, 0.0);
            pb.quad_to(0.0, 0.0, 0.0, h * 0.1);
            pb.line_to(0.0, h * 0.9);
            pb.quad_to(0.0, h, w, h);
        }
        "rightBracket" => {
            pb.move_to(0.0, 0.0);
            pb.quad_to(w, 0.0, w, h * 0.1);
            pb.line_to(w, h * 0.9);
            pb.quad_to(w, h, 0.0, h);
        }
        "leftBrace" => {
            pb.move_to(w, 0.0);
            pb.quad_to(w / 2.0, 0.0, w / 2.0, h * 0.1);
            pb.line_to(w / 2.0, h * 0.4);
            pb.quad_to(w / 2.0, h / 2.0, 0.0, h / 2.0);
            pb.quad_to(w / 2.0, h / 2.0, w / 2.0, h * 0.6);
            pb.line_to(w / 2.0, h * 0.9);
            pb.quad_to(w / 2.0, h, w, h);
        }
        "rightBrace" => {
            pb.move_to(0.0, 0.0);
            pb.quad_to(w / 2.0, 0.0, w / 2.0, h * 0.1);
            pb.line_to(w / 2.0, h * 0.4);
            pb.quad_to(w / 2.0, h / 2.0, w, h / 2.0);
            pb.quad_to(w / 2.0, h / 2.0, w / 2.0, h * 0.6);
            pb.line_to(w / 2.0, h * 0.9);
            pb.quad_to(w / 2.0, h, 0.0, h);
        }
        "bracketPair" | "bracePair" => {
            let d = ss * 0.12;
            pb.move_to(d, 0.0);
            pb.quad_to(0.0, 0.0, 0.0, d);
            pb.line_to(0.0, h - d);
            pb.quad_to(0.0, h, d, h);
            pb.move_to(w - d, 0.0);
            pb.quad_to(w, 0.0, w, d);
            pb.line_to(w, h - d);
            pb.quad_to(w, h, w - d, h);
        }
        "ribbon" | "ribbon2" | "ellipseRibbon" | "ellipseRibbon2" | "verticalScroll" | "horizontalScroll" => {
            pb.push_rect(tiny_skia::Rect::from_xywh(w * 0.12, 0.0, w * 0.76, h * 0.8)?);
            poly(&mut pb, &[(0.0, h * 0.2), (w * 0.12, h * 0.2), (w * 0.12, h), (0.0, h), (w * 0.05, h * 0.6)]);
            poly(&mut pb, &[(w, h * 0.2), (w * 0.88, h * 0.2), (w * 0.88, h), (w, h), (w * 0.95, h * 0.6)]);
        }
        "uturnArrow" | "circularArrow" | "curvedRightArrow" | "curvedLeftArrow" | "curvedUpArrow" | "curvedDownArrow" | "bentArrow" | "bentUpArrow" | "leftUpArrow" | "quadArrow" | "leftRightUpArrow" => {
            // approximation : flèche droite
            let y1 = h * 0.3;
            let y2 = h * 0.7;
            let head = ss * 0.5;
            poly(&mut pb, &[(0.0, y1), (w - head, y1), (w - head, 0.0), (w, h / 2.0), (w - head, h), (w - head, y2), (0.0, y2)]);
        }
        "mathPlus" | "mathMinus" | "mathMultiply" | "mathDivide" | "mathEqual" | "mathNotEqual" => {
            let t = h * 0.2;
            match name {
                "mathMinus" => poly(&mut pb, &[(0.0, h / 2.0 - t / 2.0), (w, h / 2.0 - t / 2.0), (w, h / 2.0 + t / 2.0), (0.0, h / 2.0 + t / 2.0)]),
                "mathEqual" | "mathNotEqual" => {
                    poly(&mut pb, &[(0.0, h * 0.25), (w, h * 0.25), (w, h * 0.42), (0.0, h * 0.42)]);
                    poly(&mut pb, &[(0.0, h * 0.58), (w, h * 0.58), (w, h * 0.75), (0.0, h * 0.75)]);
                }
                _ => {
                    let x = (w - t) / 2.0;
                    let y = (h - t) / 2.0;
                    poly(&mut pb, &[(x, 0.0), (x + t, 0.0), (x + t, y), (w, y), (w, y + t), (x + t, y + t), (x + t, h), (x, h), (x, y + t), (0.0, y + t), (0.0, y), (x, y)]);
                }
            }
        }
        _ => return None,
    }
    pb.finish()
}

/// Géométrie personnalisée (a:custGeom) mise à l'échelle dans (0,0)-(w,h).
pub fn custom_path(cust: Node, w: f32, h: f32) -> Option<Path> {
    let lst = cust.child("pathLst")?;
    let mut pb = PathBuilder::new();
    for path in lst.children_named("path") {
        let pw = path.attr("w").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
        let ph = path.attr("h").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
        let sx = if pw > 0.0 { w / pw } else { 1.0 / EMU_PER_PT };
        let sy = if ph > 0.0 { h / ph } else { 1.0 / EMU_PER_PT };
        let pt = |n: Node| -> (f32, f32) {
            let x = n.attr("x").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
            let y = n.attr("y").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
            (x * sx, y * sy)
        };
        let mut cur = (0.0f32, 0.0f32);
        let mut started = false;
        for cmd in path.children().filter(|c| c.is_element()) {
            let pts: Vec<(f32, f32)> = cmd.children_named("pt").map(pt).collect();
            match cmd.local() {
                "moveTo" => {
                    if let Some(p) = pts.first() {
                        pb.move_to(p.0, p.1);
                        cur = *p;
                        started = true;
                    }
                }
                "lnTo" => {
                    if let Some(p) = pts.first() {
                        if !started {
                            pb.move_to(cur.0, cur.1);
                            started = true;
                        }
                        pb.line_to(p.0, p.1);
                        cur = *p;
                    }
                }
                "cubicBezTo" if pts.len() >= 3 => {
                    if !started {
                        pb.move_to(cur.0, cur.1);
                        started = true;
                    }
                    pb.cubic_to(pts[0].0, pts[0].1, pts[1].0, pts[1].1, pts[2].0, pts[2].1);
                    cur = pts[2];
                }
                "quadBezTo" if pts.len() >= 2 => {
                    if !started {
                        pb.move_to(cur.0, cur.1);
                        started = true;
                    }
                    pb.quad_to(pts[0].0, pts[0].1, pts[1].0, pts[1].1);
                    cur = pts[1];
                }
                "arcTo" => {
                    let f = |a: &str| cmd.attr(a).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
                    let wr = f("wR") * sx;
                    let hr = f("hR") * sy;
                    let st = (f("stAng") / 60000.0).to_radians();
                    let sw = (f("swAng") / 60000.0).to_radians();
                    let cx = cur.0 - wr * st.cos();
                    let cy = cur.1 - hr * st.sin();
                    if !started {
                        pb.move_to(cur.0, cur.1);
                        started = true;
                    }
                    ellipse_to(&mut pb, cx, cy, wr, hr, st, st + sw, false);
                    cur = (cx + wr * (st + sw).cos(), cy + hr * (st + sw).sin());
                }
                "close" => {
                    pb.close();
                    started = false;
                }
                _ => {}
            }
        }
    }
    pb.finish()
}

/// Pointes de flèches aux extrémités d'un trait.
pub fn arrow_heads(path: &Path, line: &LineDef, color: Color) -> Vec<Item> {
    let mut out = Vec::new();
    let pts: Vec<(f32, f32)> = path.points().iter().map(|p| (p.x, p.y)).collect();
    if pts.len() < 2 {
        return out;
    }
    let size = (line.width * 3.0).max(4.5);
    let mut make = |kind: ArrowKind, tip: (f32, f32), from: (f32, f32)| {
        let dx = tip.0 - from.0;
        let dy = tip.1 - from.1;
        let len = (dx * dx + dy * dy).sqrt().max(0.001);
        let (ux, uy) = (dx / len, dy / len);
        let (px, py) = (-uy, ux);
        let mut pb = PathBuilder::new();
        let base = (tip.0 - ux * size, tip.1 - uy * size);
        match kind {
            ArrowKind::Oval => {
                if let Some(r) = tiny_skia::Rect::from_xywh(tip.0 - size / 2.0, tip.1 - size / 2.0, size, size) {
                    pb.push_oval(r);
                }
            }
            ArrowKind::Diamond => {
                poly(&mut pb, &[tip, (tip.0 - ux * size / 2.0 + px * size / 2.0, tip.1 - uy * size / 2.0 + py * size / 2.0), (tip.0 - ux * size, tip.1 - uy * size), (tip.0 - ux * size / 2.0 - px * size / 2.0, tip.1 - uy * size / 2.0 - py * size / 2.0)]);
            }
            ArrowKind::Stealth => {
                let mid = (tip.0 - ux * size * 0.6, tip.1 - uy * size * 0.6);
                poly(&mut pb, &[tip, (base.0 + px * size / 2.0, base.1 + py * size / 2.0), mid, (base.0 - px * size / 2.0, base.1 - py * size / 2.0)]);
            }
            _ => {
                poly(&mut pb, &[tip, (base.0 + px * size / 2.0, base.1 + py * size / 2.0), (base.0 - px * size / 2.0, base.1 - py * size / 2.0)]);
            }
        }
        if let Some(p) = pb.finish() {
            out.push(Item::Path { path: Arc::new(p), fill: Some(Paint::Solid(color)), stroke: None });
        }
    };
    if let Some(k) = line.head {
        make(k, pts[0], pts[1]);
    }
    if let Some(k) = line.tail {
        let n = pts.len();
        make(k, pts[n - 1], pts[n - 2]);
    }
    out
}

/// Transformation d'une forme : position, rotation et symétries autour de son centre.
pub fn shape_transform(x: f32, y: f32, w: f32, h: f32, rot_deg: f32, flip_h: bool, flip_v: bool) -> Transform {
    let mut t = Transform::from_translate(x + w / 2.0, y + h / 2.0);
    if rot_deg != 0.0 {
        t = t.pre_rotate(rot_deg);
    }
    t = t.pre_scale(if flip_h { -1.0 } else { 1.0 }, if flip_v { -1.0 } else { 1.0 });
    t.pre_translate(-w / 2.0, -h / 2.0)
}
