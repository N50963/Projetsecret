//! Présentations PowerPoint (.pptx, .ppsx, .potx) et moteur de formes DrawingML
//! partagé (dessins Excel, SmartArt).

use super::drawingml::{self as dml, emu, ColorCtx, Fill, LineDef};
use super::theme::Theme;
use crate::color::Color;
use crate::display::{Item, Page, Paint, RasterImage, Rect};
use crate::flow::{self, Block, Table, TableCell, TableRow};
use crate::fonts::map_symbol_char;
use crate::package::{parse_xml, NodeExt, Package, Rel};
use crate::text::*;
use roxmltree::{Document, Node};
use std::collections::HashMap;
use std::sync::Arc;
use tiny_skia::Transform;

// ---------------------------------------------------------------------------------
// Propriétés de texte
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Spacing {
    Pct(f32),
    Pts(f32),
}

#[derive(Clone, Debug)]
enum Bullet {
    None,
    Char(char),
    AutoNum(String, i32),
}

#[derive(Clone, Default, Debug)]
struct RunProps {
    size: Option<f32>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strike: Option<bool>,
    color: Option<Color>,
    font: Option<String>,
    baseline: Option<f32>,
    caps: Option<bool>,
    spc: Option<f32>,
    highlight: Option<Color>,
}

impl RunProps {
    fn merge(&mut self, o: &RunProps) {
        macro_rules! m {
            ($($f:ident),*) => { $( if o.$f.is_some() { self.$f = o.$f.clone(); } )* };
        }
        m!(size, bold, italic, underline, strike, color, font, baseline, caps, spc, highlight);
    }
}

#[derive(Clone, Default, Debug)]
struct LvlProps {
    mar_l: Option<f32>,
    indent: Option<f32>,
    algn: Option<Align>,
    spc_bef: Option<Spacing>,
    spc_aft: Option<Spacing>,
    ln_spc: Option<Spacing>,
    bullet: Option<Bullet>,
    bu_font: Option<String>,
    bu_color: Option<Color>,
    bu_size: Option<f32>,
    run: RunProps,
}

impl LvlProps {
    fn merge(&mut self, o: &LvlProps) {
        macro_rules! m {
            ($($f:ident),*) => { $( if o.$f.is_some() { self.$f = o.$f.clone(); } )* };
        }
        m!(mar_l, indent, algn, spc_bef, spc_aft, ln_spc, bullet, bu_font, bu_color, bu_size);
        self.run.merge(&o.run);
    }
}

type ListStyle = Vec<LvlProps>;

fn empty_list() -> ListStyle {
    vec![LvlProps::default(); 9]
}

fn merge_list(dst: &mut ListStyle, src: &ListStyle) {
    for i in 0..9 {
        dst[i].merge(&src[i]);
    }
}

#[derive(Clone, Default, Debug)]
struct BodyProps {
    ins: [Option<f32>; 4], // gauche, haut, droite, bas
    anchor: Option<String>,
    anchor_ctr: Option<bool>,
    wrap: Option<bool>,
    font_scale: Option<f32>,
    ln_reduction: Option<f32>,
    vert: Option<String>,
    rot: Option<f32>,
}

impl BodyProps {
    fn merge(&mut self, o: &BodyProps) {
        for i in 0..4 {
            if o.ins[i].is_some() {
                self.ins[i] = o.ins[i];
            }
        }
        macro_rules! m {
            ($($f:ident),*) => { $( if o.$f.is_some() { self.$f = o.$f.clone(); } )* };
        }
        m!(anchor, anchor_ctr, wrap, font_scale, ln_reduction, vert, rot);
    }
}

fn parse_body_pr(n: Node) -> BodyProps {
    let mut b = BodyProps::default();
    for (i, a) in ["lIns", "tIns", "rIns", "bIns"].iter().enumerate() {
        b.ins[i] = emu(n.attr(a));
    }
    b.anchor = n.attr("anchor").map(String::from);
    b.anchor_ctr = n.attr("anchorCtr").map(|v| v == "1" || v == "true");
    b.wrap = n.attr("wrap").map(|v| v != "none");
    b.vert = n.attr("vert").map(String::from);
    b.rot = n.attr("rot").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 60000.0);
    if let Some(na) = n.child("normAutofit") {
        b.font_scale = Some(na.attr("fontScale").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100000.0).unwrap_or(1.0));
        b.ln_reduction = Some(na.attr("lnSpcReduction").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100000.0).unwrap_or(0.0));
    } else if n.child("noAutofit").is_some() || n.child("spAutoFit").is_some() {
        b.font_scale = Some(1.0);
        b.ln_reduction = Some(0.0);
    }
    b
}

fn parse_spacing(n: Option<Node>) -> Option<Spacing> {
    let n = n?;
    if let Some(p) = n.child("spcPct") {
        return p.attr("val").and_then(|v| v.trim_end_matches('%').parse::<f32>().ok()).map(|v| Spacing::Pct(if v > 1000.0 { v / 100000.0 } else { v / 100.0 }));
    }
    if let Some(p) = n.child("spcPts") {
        return p.attr("val").and_then(|v| v.parse::<f32>().ok()).map(|v| Spacing::Pts(v / 100.0));
    }
    None
}

fn parse_rpr(n: Node, cc: &ColorCtx) -> RunProps {
    let mut r = RunProps {
        size: n.attr("sz").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100.0),
        bold: n.attr("b").map(|v| v == "1" || v == "true"),
        italic: n.attr("i").map(|v| v == "1" || v == "true"),
        underline: n.attr("u").map(|v| v != "none"),
        strike: n.attr("strike").map(|v| v != "noStrike"),
        baseline: n.attr("baseline").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100000.0),
        caps: n.attr("cap").map(|v| v == "all"),
        spc: n.attr("spc").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100.0),
        ..Default::default()
    };
    for c in n.children().filter(|c| c.is_element()) {
        match c.local() {
            "solidFill" => r.color = dml::child_color(c, cc),
            "gradFill" => {
                if let Some(Fill::Gradient { stops, .. }) = dml::parse_fill_el(c, cc) {
                    r.color = stops.first().map(|s| s.1);
                }
            }
            "noFill" => r.color = Some(Color::TRANSPARENT),
            "latin" => {
                if let Some(t) = c.attr("typeface") {
                    let t = t.to_string();
                    r.font = Some(cc.theme.font(&t).map(String::from).unwrap_or(t));
                }
            }
            "highlight" => r.highlight = dml::child_color(c, cc),
            _ => {}
        }
    }
    r
}

fn parse_lvl(n: Node, cc: &ColorCtx) -> LvlProps {
    let mut l = LvlProps {
        mar_l: emu(n.attr("marL")),
        indent: emu(n.attr("indent")),
        algn: n.attr("algn").map(|v| match v {
            "ctr" => Align::Center,
            "r" => Align::Right,
            "just" | "dist" | "justLow" | "thaiDist" => Align::Justify,
            _ => Align::Left,
        }),
        ..Default::default()
    };
    l.spc_bef = parse_spacing(n.child("spcBef"));
    l.spc_aft = parse_spacing(n.child("spcAft"));
    l.ln_spc = parse_spacing(n.child("lnSpc"));
    for c in n.children().filter(|c| c.is_element()) {
        match c.local() {
            "buNone" => l.bullet = Some(Bullet::None),
            "buChar" => l.bullet = Some(Bullet::Char(c.attr("char").and_then(|s| s.chars().next()).unwrap_or('•'))),
            "buAutoNum" => l.bullet = Some(Bullet::AutoNum(c.attr("type").unwrap_or("arabicPeriod").to_string(), c.attr("startAt").and_then(|v| v.parse().ok()).unwrap_or(1))),
            "buBlip" => l.bullet = Some(Bullet::Char('■')),
            "buFont" => l.bu_font = c.attr("typeface").map(String::from),
            "buClr" => l.bu_color = dml::child_color(c, cc),
            "buSzPct" => l.bu_size = c.attr("val").and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100000.0),
            "defRPr" => l.run = parse_rpr(c, cc),
            _ => {}
        }
    }
    l
}

fn parse_list_style(n: Option<Node>, cc: &ColorCtx) -> ListStyle {
    let mut ls = empty_list();
    let Some(n) = n else { return ls };
    for c in n.children().filter(|c| c.is_element()) {
        let name = c.local();
        if name == "defPPr" {
            let d = parse_lvl(c, cc);
            for l in ls.iter_mut() {
                l.merge(&d);
            }
            continue;
        }
        if let Some(num) = name.strip_prefix("lvl").and_then(|s| s.strip_suffix("pPr")).and_then(|s| s.parse::<usize>().ok()) {
            if (1..=9).contains(&num) {
                let p = parse_lvl(c, cc);
                ls[num - 1].merge(&p);
            }
        }
    }
    ls
}

fn autonum(scheme: &str, n: i32) -> String {
    let (body, wrap) = if let Some(b) = scheme.strip_suffix("ParenBoth") {
        (b, ("(", ")"))
    } else if let Some(b) = scheme.strip_suffix("ParenR") {
        (b, ("", ")"))
    } else if let Some(b) = scheme.strip_suffix("Period") {
        (b, ("", "."))
    } else if let Some(b) = scheme.strip_suffix("Plain") {
        (b, ("", ""))
    } else {
        (scheme, ("", "."))
    };
    let num = match body {
        "alphaLc" => super::docx::letters(n),
        "alphaUc" => super::docx::letters(n).to_uppercase(),
        "romanLc" => super::docx::roman(n),
        "romanUc" => super::docx::roman(n).to_uppercase(),
        _ => n.to_string(),
    };
    format!("{}{}{}", wrap.0, num, wrap.1)
}

// ---------------------------------------------------------------------------------
// Contexte de rendu
// ---------------------------------------------------------------------------------

/// Informations héritées d'un espace réservé (disposition / masque).
#[derive(Clone, Default)]
struct Inherit<'a> {
    nodes: Vec<Node<'a, 'a>>, // du plus général (masque) au plus précis (disposition)
}

pub(crate) struct DrawCtx<'a> {
    pkg: &'a Package,
    theme: &'a Theme,
    clr_map: Option<HashMap<String, String>>,
    rels: HashMap<String, Rel>,
    /// Styles de texte de base : titre, corps, autre.
    title_style: ListStyle,
    body_style: ListStyle,
    other_style: ListStyle,
    slide_number: u32,
    table_styles: Option<&'a Document<'a>>,
}

impl<'a> DrawCtx<'a> {
    fn cc(&self) -> ColorCtx<'_> {
        ColorCtx { theme: self.theme, clr_map: self.clr_map.as_ref(), ph_color: None }
    }

    fn image(&self, rid: &str) -> Option<Arc<RasterImage>> {
        let rel = self.rels.get(rid)?;
        if rel.external {
            return None;
        }
        self.pkg.image(&rel.target)
    }

    fn theme_fill(&self, idx: usize, ph: Option<Color>) -> Option<Fill> {
        let list = if idx >= 1001 { &self.theme.bg_fill_styles } else { &self.theme.fill_styles };
        let i = if idx >= 1001 { idx - 1001 } else { idx.checked_sub(1)? };
        let xml = list.get(i)?;
        let wrapped = format!("<r xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">{xml}</r>");
        let doc = parse_xml(&wrapped)?;
        let cc = ColorCtx { theme: self.theme, clr_map: self.clr_map.as_ref(), ph_color: ph };
        let el = doc.root_element().children().find(|c| c.is_element())?;
        dml::parse_fill_el(el, &cc)
    }

    fn theme_line(&self, idx: usize, ph: Option<Color>) -> LineDef {
        let mut l = LineDef { color: ph, ..Default::default() };
        if let Some(xml) = idx.checked_sub(1).and_then(|i| self.theme.line_styles.get(i)) {
            let wrapped = format!("<r xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">{xml}</r>");
            if let Some(doc) = parse_xml(&wrapped) {
                if let Some(el) = doc.root_element().children().find(|c| c.is_element()) {
                    let cc = ColorCtx { theme: self.theme, clr_map: self.clr_map.as_ref(), ph_color: ph };
                    dml::merge_line(&mut l, el, &cc);
                }
            }
        }
        l
    }
}

fn ph_info(sp: Node) -> Option<(String, Option<String>)> {
    let nv = sp.children().find(|c| c.is_element() && c.local().starts_with("nv"))?;
    let ph = nv.child("nvPr")?.child("ph")?;
    Some((ph.attr("type").unwrap_or("body").to_string(), ph.attr("idx").map(String::from)))
}

/// Cherche l'espace réservé correspondant dans un arbre de formes.
fn find_ph<'a>(tree: Node<'a, 'a>, ty: &str, idx: Option<&str>) -> Option<Node<'a, 'a>> {
    let shapes: Vec<Node> = tree.descendants().filter(|n| n.is_element() && matches!(n.local(), "sp" | "pic" | "graphicFrame")).collect();
    fn norm(t: &str) -> &str {
        match t {
            "ctrTitle" => "title",
            "subTitle" | "obj" => "body",
            o => o,
        }
    }
    if let Some(i) = idx {
        for s in &shapes {
            if let Some((t2, Some(i2))) = ph_info(*s) {
                if i2 == i && (norm(&t2) == norm(ty) || ty == "body" || t2 == "body" || ty == "obj") {
                    return Some(*s);
                }
            }
        }
        for s in &shapes {
            if let Some((_, Some(i2))) = ph_info(*s) {
                if i2 == i {
                    return Some(*s);
                }
            }
        }
    }
    for s in &shapes {
        if let Some((t2, _)) = ph_info(*s) {
            if t2 == ty {
                return Some(*s);
            }
        }
    }
    for s in &shapes {
        if let Some((t2, _)) = ph_info(*s) {
            if norm(&t2) == norm(ty) {
                return Some(*s);
            }
        }
    }
    None
}

fn xfrm_rect(sppr: Option<Node>) -> Option<(Rect, f32, bool, bool)> {
    let x = sppr?.child("xfrm")?;
    let off = x.child("off");
    let ext = x.child("ext");
    let r = Rect::new(emu(off.and_then(|o| o.attr("x"))).unwrap_or(0.0), emu(off.and_then(|o| o.attr("y"))).unwrap_or(0.0), emu(ext.and_then(|e| e.attr("cx"))).unwrap_or(0.0), emu(ext.and_then(|e| e.attr("cy"))).unwrap_or(0.0));
    let rot = x.attr("rot").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) / 60000.0;
    Some((r, rot, x.attr("flipH") == Some("1"), x.attr("flipV") == Some("1")))
}

fn sppr_of<'a, 'i>(n: Node<'a, 'i>) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && matches!(c.local(), "spPr" | "grpSpPr"))
}

// ---------------------------------------------------------------------------------
// Rendu des formes
// ---------------------------------------------------------------------------------

impl<'a> DrawCtx<'a> {
    pub(crate) fn render_tree(&self, tree: Node<'a, 'a>, inherit_tree: &[Node<'a, 'a>], skip_placeholders: bool) -> Vec<Item> {
        let mut items = Vec::new();
        for c in tree.children().filter(|c| c.is_element()) {
            items.extend(self.render_node(c, inherit_tree, skip_placeholders));
        }
        items
    }

    fn render_node(&self, c: Node<'a, 'a>, inherit_tree: &[Node<'a, 'a>], skip_ph: bool) -> Vec<Item> {
        match c.local() {
            "sp" | "cxnSp" | "pic" | "graphicFrame" => {
                let ph = ph_info(c);
                if skip_ph && ph.is_some() {
                    return Vec::new();
                }
                let mut inh = Inherit::default();
                if let Some((ty, idx)) = &ph {
                    for t in inherit_tree {
                        if let Some(n) = find_ph(*t, ty, idx.as_deref()) {
                            inh.nodes.push(n);
                        }
                    }
                }
                match c.local() {
                    "pic" => self.render_pic(c, &inh),
                    "graphicFrame" => self.render_frame(c, &inh),
                    _ => self.render_sp(c, &inh, ph.as_ref().map(|p| p.0.as_str())),
                }
            }
            "grpSp" => self.render_group(c, inherit_tree, skip_ph),
            "AlternateContent" => {
                let choice = c.child("Choice").filter(|ch| ch.children().any(|x| x.is_element()));
                match choice.or_else(|| c.child("Fallback")) {
                    Some(ch) => self.render_tree(ch, inherit_tree, skip_ph),
                    None => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }

    fn render_group(&self, g: Node<'a, 'a>, inherit_tree: &[Node<'a, 'a>], skip_ph: bool) -> Vec<Item> {
        let gpr = sppr_of(g);
        let x = gpr.and_then(|p| p.child("xfrm"));
        let get = |n: Option<Node>, a: &str| emu(n.and_then(|n| n.attr(a)));
        let off = x.and_then(|x| x.child("off"));
        let ext = x.and_then(|x| x.child("ext"));
        let choff = x.and_then(|x| x.child("chOff"));
        let chext = x.and_then(|x| x.child("chExt"));
        let (ox, oy) = (get(off, "x").unwrap_or(0.0), get(off, "y").unwrap_or(0.0));
        let (ow, oh) = (get(ext, "cx").unwrap_or(1.0), get(ext, "cy").unwrap_or(1.0));
        let (cx, cy) = (get(choff, "x").unwrap_or(ox), get(choff, "y").unwrap_or(oy));
        let (cw, ch) = (get(chext, "cx").unwrap_or(ow).max(0.001), get(chext, "cy").unwrap_or(oh).max(0.001));
        let rot = x.and_then(|x| x.attr("rot")).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) / 60000.0;
        let flip_h = x.and_then(|x| x.attr("flipH")) == Some("1");
        let flip_v = x.and_then(|x| x.attr("flipV")) == Some("1");
        let outer = dml::shape_transform(ox, oy, ow, oh, rot, flip_h, flip_v);
        let t = outer.pre_scale(ow / cw, oh / ch).pre_translate(-cx, -cy);
        let mut items = Vec::new();
        for c in g.children().filter(|c| c.is_element()) {
            items.extend(self.render_node(c, inherit_tree, skip_ph));
        }
        vec![Item::group(t, None, items)]
    }

    fn resolve_xfrm(&self, n: Node, inh: &Inherit) -> (Rect, f32, bool, bool) {
        if let Some(x) = xfrm_rect(sppr_of(n)) {
            return x;
        }
        for i in inh.nodes.iter().rev() {
            if let Some(x) = xfrm_rect(sppr_of(*i)) {
                return x;
            }
        }
        (Rect::new(0.0, 0.0, 0.0, 0.0), 0.0, false, false)
    }

    fn render_pic(&self, pic: Node<'a, 'a>, inh: &Inherit) -> Vec<Item> {
        let (r, rot, fh, fv) = self.resolve_xfrm(pic, inh);
        let bf = pic.child("blipFill");
        let rid = bf.and_then(|b| b.child("blip")).and_then(|b| b.attr("embed").or_else(|| b.attr("link")));
        let crop = dml::parse_src_rect(bf.and_then(|b| b.child("srcRect")));
        let local = Rect::new(0.0, 0.0, r.w, r.h);
        let mut items = Vec::new();
        let alpha = bf.and_then(|b| b.child("blip")).and_then(|b| b.children().find(|x| x.local() == "alphaModFix")).and_then(|x| x.attr("amt")).and_then(|v| v.parse::<f32>().ok()).map(|v| v / 100000.0).unwrap_or(1.0);
        match rid.and_then(|id| self.image(id)) {
            Some(img) => {
                // découpe elliptique éventuelle
                let geom = sppr_of(pic).and_then(|s| s.child("prstGeom")).and_then(|g| g.attr("prst")).unwrap_or("rect");
                if geom != "rect" {
                    if let Some(p) = dml::preset_path(geom, r.w, r.h, &HashMap::new()) {
                        items.push(Item::Path { path: Arc::new(p), fill: Some(Paint::Image { image: img, rect: local, alpha }), stroke: None });
                    }
                } else {
                    items.push(Item::Image { rect: local, image: img, crop, alpha });
                }
            }
            None => {
                if rid.is_some() {
                    items.push(Item::Placeholder { rect: local, label: "image".into() });
                }
            }
        }
        if let Some(ln) = sppr_of(pic).and_then(|s| s.child("ln")) {
            let mut l = LineDef::default();
            dml::merge_line(&mut l, ln, &self.cc());
            if let (Some(s), Some(p)) = (l.stroke(), crate::display::rect_path(local)) {
                items.push(Item::Path { path: Arc::new(p), fill: None, stroke: Some(s) });
            }
        }
        vec![Item::group(dml::shape_transform(r.x, r.y, r.w, r.h, rot, fh, fv), None, items)]
    }

    fn render_sp(&self, sp: Node<'a, 'a>, inh: &Inherit, ph_type: Option<&str>) -> Vec<Item> {
        let (r, rot, fh, fv) = self.resolve_xfrm(sp, inh);
        let cc = self.cc();
        let sppr = sppr_of(sp);
        let local = Rect::new(0.0, 0.0, r.w, r.h);
        // géométrie
        let mut geom: Option<String> = None;
        let mut adj = HashMap::new();
        let mut cust: Option<Node> = None;
        for n in std::iter::once(sppr).chain(inh.nodes.iter().rev().map(|i| sppr_of(*i))).flatten() {
            if let Some(pg) = n.child("prstGeom") {
                geom = pg.attr("prst").map(String::from);
                adj = dml::parse_adjust(pg);
                break;
            }
            if let Some(cg) = n.child("custGeom") {
                cust = Some(cg);
                break;
            }
        }
        let geom_name = geom.clone().unwrap_or_else(|| "rect".into());
        // style (références au thème)
        let style = sp.child("style").or_else(|| inh.nodes.iter().rev().find_map(|i| i.child("style")));
        let mut fill: Option<Fill> = None;
        let mut line = LineDef::default();
        let mut font_ref_color: Option<Color> = None;
        if let Some(st) = style {
            if let Some(fr) = st.child("fillRef") {
                let idx: usize = fr.attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0);
                let ph = dml::child_color(fr, &cc);
                if idx > 0 {
                    fill = self.theme_fill(idx, ph).or(ph.map(Fill::Solid));
                }
            }
            if let Some(lr) = st.child("lnRef") {
                let idx: usize = lr.attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0);
                let ph = dml::child_color(lr, &cc);
                if idx > 0 {
                    line = self.theme_line(idx, ph);
                }
            }
            if let Some(fr) = st.child("fontRef") {
                font_ref_color = dml::child_color(fr, &cc);
            }
        }
        // propriétés héritées puis directes
        for n in inh.nodes.iter().map(|i| sppr_of(*i)).chain(std::iter::once(sppr)).flatten() {
            if let Some(f) = dml::parse_fill(n, &cc) {
                fill = Some(f);
            }
            if let Some(ln) = n.child("ln") {
                dml::merge_line(&mut line, ln, &cc);
            }
        }
        let mut items = Vec::new();
        let path = match cust {
            Some(cg) => dml::custom_path(cg, r.w, r.h),
            None => dml::preset_path(&geom_name, r.w, r.h, &adj).or_else(|| dml::preset_path("rect", r.w, r.h, &adj)),
        };
        if let Some(p) = path {
            let paint = if dml::is_open_shape(&geom_name) { None } else { fill.as_ref().and_then(|f| dml::fill_to_paint(f, local, &|rid| self.image(rid))) };
            let stroke = line.stroke();
            if paint.is_some() || stroke.is_some() {
                let heads = stroke.as_ref().map(|s| dml::arrow_heads(&p, &line, s.color)).unwrap_or_default();
                items.push(Item::Path { path: Arc::new(p), fill: paint, stroke });
                items.extend(heads);
            }
        }
        // texte
        let tx = sp.child("txBody");
        if let Some(tx) = tx {
            // zone de texte spécifique (SmartArt)
            let text_rect = sp.child("txXfrm").and_then(|t| xfrm_rect(Some(t)).map(|x| x.0)).map(|tr| Rect::new(tr.x - r.x, tr.y - r.y, tr.w, tr.h)).unwrap_or_else(|| geom_text_rect(&geom_name, r.w, r.h, &adj));
            let kind = match ph_type {
                Some("title") | Some("ctrTitle") => 0,
                Some("body") | Some("subTitle") | Some("obj") | Some("dt") | Some("ftr") | Some("sldNum") | Some(_) => 1,
                None => 2,
            };
            let kind = if matches!(ph_type, Some("dt") | Some("ftr") | Some("sldNum") | Some("hdr")) { 2 } else { kind };
            items.extend(self.render_text(tx, text_rect, inh, kind, font_ref_color));
        }
        if items.is_empty() {
            return items;
        }
        vec![Item::group(dml::shape_transform(r.x, r.y, r.w, r.h, rot, fh, fv), None, items)]
    }

    /// Paragraphes d'un a:txBody avec toute la chaîne d'héritage.
    fn build_paragraphs(&self, tx: Node<'a, 'a>, inh: &Inherit, kind: u8, font_ref_color: Option<Color>, body: &BodyProps, extra: Option<&ListStyle>) -> Vec<Paragraph> {
        let cc = self.cc();
        let mut ls = match kind {
            0 => self.title_style.clone(),
            1 => self.body_style.clone(),
            _ => self.other_style.clone(),
        };
        if let Some(e) = extra {
            merge_list(&mut ls, e);
        }
        // la couleur de police du style de forme prime sur les styles du masque
        if let Some(c) = font_ref_color {
            for l in ls.iter_mut() {
                l.run.color = Some(c);
            }
        }
        for n in &inh.nodes {
            if let Some(t) = n.child("txBody") {
                merge_list(&mut ls, &parse_list_style(t.child("lstStyle"), &cc));
            }
        }
        merge_list(&mut ls, &parse_list_style(tx.child("lstStyle"), &cc));
        let scale = body.font_scale.unwrap_or(1.0);
        let ln_red = body.ln_reduction.unwrap_or(0.0);
        let mut paras = Vec::new();
        let mut counters: [i32; 9] = [0; 9];
        let mut last_scheme: [Option<String>; 9] = Default::default();
        for (pi, p) in tx.children_named("p").enumerate() {
            let ppr = p.child("pPr");
            let lvl = ppr.and_then(|x| x.attr("lvl")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(8);
            let mut lp = ls[lvl].clone();
            if let Some(pp) = ppr {
                lp.merge(&parse_lvl(pp, &cc));
            }
            let mut base_run = lp.run.clone();
            if base_run.color.is_none() {
                base_run.color = font_ref_color;
            }
            let make_style = |rp: &RunProps| -> Arc<TextStyle> {
                let size = rp.size.unwrap_or(18.0) * scale;
                let font = rp.font.clone().unwrap_or_else(|| self.theme.minor_font.clone());
                let (vert, shift) = match rp.baseline {
                    Some(b) if b > 0.0 => (VertAlign::Super, 0.0),
                    Some(b) if b < 0.0 => (VertAlign::Sub, 0.0),
                    _ => (VertAlign::Baseline, 0.0),
                };
                Arc::new(TextStyle {
                    font: Arc::from(font.as_str()),
                    size,
                    bold: rp.bold.unwrap_or(false),
                    italic: rp.italic.unwrap_or(false),
                    underline: rp.underline.unwrap_or(false),
                    strike: rp.strike.unwrap_or(false),
                    color: rp.color.unwrap_or(Color::BLACK),
                    highlight: rp.highlight,
                    vert,
                    caps: rp.caps.unwrap_or(false),
                    spacing: rp.spc.unwrap_or(0.0),
                    baseline_shift: shift,
                    ..Default::default()
                })
            };
            let mut inlines: Vec<Inline> = Vec::new();
            let mut first_style: Option<Arc<TextStyle>> = None;
            let mut has_text = false;
            for r in p.children().filter(|c| c.is_element()) {
                match r.local() {
                    "r" | "fld" => {
                        let mut rp = base_run.clone();
                        if let Some(rpr) = r.child("rPr") {
                            rp.merge(&parse_rpr(rpr, &cc));
                        }
                        let st = make_style(&rp);
                        let mut text = r.child("t").and_then(|t| t.text()).unwrap_or("").to_string();
                        if r.local() == "fld" && r.attr("type") == Some("slidenum") {
                            text = self.slide_number.to_string();
                        }
                        if !text.is_empty() {
                            has_text = true;
                        }
                        if first_style.is_none() {
                            first_style = Some(st.clone());
                        }
                        // police de symboles
                        let text: String = if rp.font.as_deref().map(|f| f.to_lowercase().contains("wingding") || f.to_lowercase().contains("symbol")).unwrap_or(false) {
                            text.chars().map(|c| map_symbol_char(rp.font.as_deref().unwrap_or(""), c)).collect()
                        } else {
                            text
                        };
                        // tabulations et sauts verticaux dans le texte
                        for (i, part) in text.split('\t').enumerate() {
                            if i > 0 {
                                inlines.push(Inline::Tab(st.clone()));
                            }
                            if !part.is_empty() {
                                inlines.push(Inline::Text(part.replace('\u{b}', "\n"), st.clone()));
                            }
                        }
                    }
                    "br" => {
                        let mut rp = base_run.clone();
                        if let Some(rpr) = r.child("rPr") {
                            rp.merge(&parse_rpr(rpr, &cc));
                        }
                        inlines.push(Inline::LineBreak(make_style(&rp)));
                    }
                    _ => {}
                }
            }
            let mut end_rp = base_run.clone();
            if let Some(e) = p.child("endParaRPr") {
                end_rp.merge(&parse_rpr(e, &cc));
            }
            let mark = if has_text { first_style.clone().unwrap_or_else(|| make_style(&end_rp)) } else { make_style(&end_rp) };
            // puces
            let mut label: Option<(String, Arc<TextStyle>)> = None;
            match &lp.bullet {
                Some(Bullet::Char(ch)) if has_text => {
                    let font = lp.bu_font.clone().unwrap_or_else(|| mark.font.to_string());
                    let ch2 = map_symbol_char(&font, *ch);
                    let mut st = (*mark).clone();
                    if font.to_lowercase().contains("wingding") || font.to_lowercase().contains("symbol") {
                        st.font = Arc::from("DejaVu Sans");
                    } else {
                        st.font = Arc::from(font.as_str());
                    }
                    if let Some(c) = lp.bu_color {
                        st.color = c;
                    }
                    st.size *= lp.bu_size.unwrap_or(1.0);
                    st.underline = false;
                    st.bold = false;
                    st.italic = false;
                    label = Some((ch2.to_string(), Arc::new(st)));
                    counters[lvl] = 0;
                }
                Some(Bullet::AutoNum(scheme, start)) if has_text => {
                    if last_scheme[lvl].as_deref() != Some(scheme.as_str()) {
                        counters[lvl] = 0;
                    }
                    counters[lvl] += 1;
                    last_scheme[lvl] = Some(scheme.clone());
                    let n = start - 1 + counters[lvl];
                    let mut st = (*mark).clone();
                    if let Some(c) = lp.bu_color {
                        st.color = c;
                    }
                    st.size *= lp.bu_size.unwrap_or(1.0);
                    label = Some((autonum(scheme, n), Arc::new(st)));
                }
                _ => {}
            }
            for l in lvl + 1..9 {
                counters[l] = 0;
                last_scheme[l] = None;
            }
            let mar_l = lp.mar_l.unwrap_or(0.0);
            let indent = lp.indent.unwrap_or(0.0);
            if let Some((t, st)) = label {
                let mut v = vec![Inline::Text(t, st.clone())];
                if indent < 0.0 {
                    v.push(Inline::Tab(st));
                } else {
                    v.push(Inline::Text(" ".into(), st));
                }
                v.extend(inlines);
                inlines = v;
            }
            let size = mark.size;
            let spacing_pt = |s: Option<Spacing>| -> f32 {
                match s {
                    Some(Spacing::Pts(v)) => v,
                    Some(Spacing::Pct(p)) => p * size * 1.2,
                    None => 0.0,
                }
            };
            let line = match lp.ln_spc {
                Some(Spacing::Pct(p)) => LineSpacing::Multiple((p - ln_red).max(0.5)),
                Some(Spacing::Pts(v)) => LineSpacing::Exact(v * scale),
                None => LineSpacing::Multiple((1.0 - ln_red).max(0.5)),
            };
            let props = ParaProps {
                align: lp.algn.unwrap_or(Align::Left),
                ind_left: mar_l,
                ind_first: indent,
                space_before: if pi == 0 { 0.0 } else { spacing_pt(lp.spc_bef) },
                space_after: spacing_pt(lp.spc_aft),
                line,
                default_tab: 72.0,
                widow_control: false,
                pp_line_mode: true,
                ..Default::default()
            };
            paras.push(Paragraph { props, inlines, mark });
        }
        paras
    }

    fn render_text(&self, tx: Node<'a, 'a>, rect: Rect, inh: &Inherit, kind: u8, font_ref_color: Option<Color>) -> Vec<Item> {
        let mut body = BodyProps::default();
        for n in &inh.nodes {
            if let Some(b) = n.child("txBody").and_then(|t| t.child("bodyPr")) {
                body.merge(&parse_body_pr(b));
            }
        }
        if let Some(b) = tx.child("bodyPr") {
            body.merge(&parse_body_pr(b));
        }
        let paras = self.build_paragraphs(tx, inh, kind, font_ref_color, &body, None);
        if paras.iter().all(|p| p.inlines.is_empty()) {
            return Vec::new();
        }
        layout_text_box(paras, rect, &body)
    }

    // -----------------------------------------------------------------------------
    // Cadres graphiques : tableaux, graphiques, SmartArt
    // -----------------------------------------------------------------------------

    fn render_frame(&self, gf: Node<'a, 'a>, inh: &Inherit) -> Vec<Item> {
        let xf = gf.child("xfrm").map(|x| {
            let off = x.child("off");
            let ext = x.child("ext");
            Rect::new(emu(off.and_then(|o| o.attr("x"))).unwrap_or(0.0), emu(off.and_then(|o| o.attr("y"))).unwrap_or(0.0), emu(ext.and_then(|e| e.attr("cx"))).unwrap_or(0.0), emu(ext.and_then(|e| e.attr("cy"))).unwrap_or(0.0))
        });
        let r = xf.unwrap_or_else(|| self.resolve_xfrm(gf, inh).0);
        let Some(gd) = gf.path(&["graphic", "graphicData"]) else { return Vec::new() };
        let local = Rect::new(0.0, 0.0, r.w, r.h);
        let mut items = Vec::new();
        for c in gd.children().filter(|c| c.is_element()) {
            match c.local() {
                "tbl" => items.extend(self.render_table(c)),
                "chart" => {
                    if let Some(rel) = c.rid().and_then(|id| self.rels.get(id)) {
                        items.extend(super::chart::render_chart(self.pkg, &rel.target, local, self.theme));
                    }
                }
                "relIds" => {
                    // SmartArt : dessin pré-calculé
                    let data = c.attr("dm").and_then(|id| self.rels.get(id));
                    let mut drawn = false;
                    if let Some(d) = data {
                        if let Some(x) = self.pkg.read_string(&d.target) {
                            if let Some(doc) = parse_xml(&x) {
                                if let Some(rid) = doc.descendants().find(|n| n.local() == "dataModelExt").and_then(|n| n.attr("relId")) {
                                    if let Some(rel) = self.rels.get(rid) {
                                        items.extend(render_drawing_part_ctx(self, &rel.target, local));
                                        drawn = true;
                                    }
                                }
                            }
                        }
                    }
                    if !drawn {
                        if let Some(rel) = self.rels.values().find(|r| r.kind == "diagramDrawing") {
                            items.extend(render_drawing_part_ctx(self, &rel.target, local));
                        }
                    }
                }
                "oleObj" => {
                    // aperçu de l'objet OLE
                    if let Some(pic) = c.descendant("pic") {
                        let inner = self.render_pic(pic, &Inherit::default());
                        items.push(Item::group(Transform::from_translate(-r.x, -r.y), None, inner));
                    }
                }
                _ => {}
            }
        }
        if items.is_empty() {
            return items;
        }
        vec![Item::group(Transform::from_translate(r.x, r.y), None, items)]
    }

    fn render_table(&self, tbl: Node<'a, 'a>) -> Vec<Item> {
        let cc = self.cc();
        let tpr = tbl.child("tblPr");
        let flag = |a: &str| tpr.and_then(|t| t.attr(a)).map(|v| v == "1" || v == "true").unwrap_or(false);
        let (first_row, last_row, first_col, last_col, band_row, band_col) = (flag("firstRow"), flag("lastRow"), flag("firstCol"), flag("lastCol"), flag("bandRow"), flag("bandCol"));
        let style_id = tpr.and_then(|t| t.child("tableStyleId")).and_then(|s| s.text()).map(|s| s.trim().to_string());
        let style = self.table_styles.and_then(|d| d.root_element().children_named("tblStyle").find(|s| s.attr("styleId").map(|v| Some(v.to_string()) == style_id).unwrap_or(false)));
        let widths: Vec<f32> = tbl.child("tblGrid").map(|g| g.children_named("gridCol").map(|c| emu(c.attr("w")).unwrap_or(0.0)).collect()).unwrap_or_default();
        let rows: Vec<Node> = tbl.children_named("tr").collect();
        let nrows = rows.len();
        let ncols = widths.len();
        let mut t = Table { col_widths: widths, cell_margins: [3.6, 7.2, 3.6, 7.2], ..Default::default() };
        // style par défaut « Medium Style 2 - Accent 1 » si aucun style trouvé
        let accent = self.theme.color("accent1").unwrap_or(Color::rgb(68, 114, 196));
        let lt1 = self.theme.color("lt1").unwrap_or(Color::WHITE);
        let dk1 = self.theme.color("dk1").unwrap_or(Color::BLACK);
        for (ri, tr) in rows.iter().enumerate() {
            let mut row = TableRow { height: emu(tr.attr("h")).unwrap_or(0.0), ..Default::default() };
            let mut ci = 0usize;
            for tc in tr.children_named("tc") {
                let span: usize = tc.attr("gridSpan").and_then(|v| v.parse().ok()).unwrap_or(1);
                let rowspan: usize = tc.attr("rowSpan").and_then(|v| v.parse().ok()).unwrap_or(1);
                let covered = tc.attr("hMerge") == Some("1") || tc.attr("vMerge") == Some("1");
                if tc.attr("hMerge") == Some("1") {
                    // la cellule précédente couvre déjà cette colonne
                    ci += 1;
                    continue;
                }
                // zones de style applicables
                let mut parts: Vec<&str> = vec!["wholeTbl"];
                let is_first = first_row && ri == 0;
                let is_last = last_row && ri + 1 == nrows;
                if band_col && !(first_col && ci == 0) {
                    let k = if first_col { ci.saturating_sub(1) } else { ci };
                    parts.push(if k % 2 == 0 { "band1V" } else { "band2V" });
                }
                if band_row && !is_first && !is_last {
                    let k = if first_row { ri.saturating_sub(1) } else { ri };
                    parts.push(if k % 2 == 0 { "band1H" } else { "band2H" });
                }
                if first_col && ci == 0 {
                    parts.push("firstCol");
                }
                if last_col && ci + span >= ncols {
                    parts.push("lastCol");
                }
                if is_last {
                    parts.push("lastRow");
                }
                if is_first {
                    parts.push("firstRow");
                }
                let mut fill: Option<Color> = None;
                let mut bold = false;
                let mut text_color: Option<Color> = None;
                let mut borders: [Option<BorderLine>; 4] = [None, None, None, None];
                match style {
                    Some(st) => {
                        for pname in &parts {
                            let Some(pn) = st.child(pname) else { continue };
                            if let Some(ts) = pn.child("tcTxStyle") {
                                if ts.attr("b") == Some("on") {
                                    bold = true;
                                }
                                if let Some(c) = dml::child_color(ts, &cc).or_else(|| ts.child("fontRef").and_then(|f| dml::child_color(f, &cc))) {
                                    text_color = Some(c);
                                }
                            }
                            if let Some(tcs) = pn.child("tcStyle") {
                                if let Some(f) = tcs.child("fill") {
                                    match dml::parse_fill(f, &cc) {
                                        Some(Fill::Solid(c)) => fill = Some(c),
                                        Some(Fill::None) => fill = None,
                                        _ => {}
                                    }
                                }
                                if let Some(fr) = tcs.child("fillRef") {
                                    fill = dml::child_color(fr, &cc);
                                }
                                if let Some(bdr) = tcs.child("tcBdr") {
                                    let get = |name: &str| -> Option<Option<BorderLine>> {
                                        let b = bdr.child(name)?;
                                        let ln = b.child("ln")?;
                                        let mut l = LineDef { color: None, ..Default::default() };
                                        dml::merge_line(&mut l, ln, &cc);
                                        if l.color.is_none() {
                                            if let Some(lr) = b.child("lnRef") {
                                                l.color = dml::child_color(lr, &cc);
                                            }
                                        }
                                        Some(l.color.map(|c| BorderLine::solid(l.width, c)))
                                    };
                                    let set = |i: usize, v: Option<Option<BorderLine>>, borders: &mut [Option<BorderLine>; 4]| {
                                        if let Some(v) = v {
                                            borders[i] = v;
                                        }
                                    };
                                    set(0, if ri == 0 || *pname != "wholeTbl" { get("top") } else { get("insideH") }, &mut borders);
                                    set(2, if ri + 1 == nrows || *pname != "wholeTbl" { get("bottom") } else { get("insideH") }, &mut borders);
                                    set(3, if ci == 0 || *pname != "wholeTbl" { get("left") } else { get("insideV") }, &mut borders);
                                    set(1, if ci + span >= ncols || *pname != "wholeTbl" { get("right") } else { get("insideV") }, &mut borders);
                                    if *pname == "wholeTbl" {
                                        if ri > 0 {
                                            set(0, get("insideH"), &mut borders);
                                        }
                                        if ri + 1 < nrows {
                                            set(2, get("insideH"), &mut borders);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    None => {
                        fill = Some(accent.tint(0.2));
                        if band_row && !is_first && (if first_row { ri - 1 } else { ri }) % 2 == 0 {
                            fill = Some(accent.tint(0.4));
                        }
                        if is_first {
                            fill = Some(accent);
                            bold = true;
                            text_color = Some(lt1);
                        } else {
                            text_color = Some(dk1);
                        }
                        let b = Some(BorderLine::solid(1.0, lt1));
                        borders = [b.clone(), b.clone(), b.clone(), b];
                    }
                }
                // propriétés directes de la cellule
                let tcpr = tc.child("tcPr");
                let mut margins = t.cell_margins;
                let mut valign = flow::VAlign::Top;
                if let Some(p) = tcpr {
                    if let Some(v) = emu(p.attr("marL")) {
                        margins[3] = v;
                    }
                    if let Some(v) = emu(p.attr("marR")) {
                        margins[1] = v;
                    }
                    if let Some(v) = emu(p.attr("marT")) {
                        margins[0] = v;
                    }
                    if let Some(v) = emu(p.attr("marB")) {
                        margins[2] = v;
                    }
                    valign = match p.attr("anchor") {
                        Some("ctr") => flow::VAlign::Center,
                        Some("b") => flow::VAlign::Bottom,
                        _ => flow::VAlign::Top,
                    };
                    match dml::parse_fill(p, &cc) {
                        Some(Fill::Solid(c)) => fill = Some(c),
                        Some(Fill::None) => fill = None,
                        Some(Fill::Gradient { stops, .. }) => fill = stops.first().map(|s| s.1),
                        _ => {}
                    }
                    for (name, i) in [("lnT", 0usize), ("lnR", 1), ("lnB", 2), ("lnL", 3)] {
                        if let Some(ln) = p.child(name) {
                            let mut l = LineDef { color: Some(Color::BLACK), ..Default::default() };
                            dml::merge_line(&mut l, ln, &cc);
                            borders[i] = l.color.filter(|c| !c.is_transparent()).map(|c| BorderLine::solid(l.width, c));
                        }
                    }
                }
                // texte de la cellule
                let mut extra = empty_list();
                for l in extra.iter_mut() {
                    if bold {
                        l.run.bold = Some(true);
                    }
                    if let Some(c) = text_color {
                        l.run.color = Some(c);
                    }
                }
                let blocks: Vec<Block> = match tc.child("txBody") {
                    Some(tx) => {
                        let body = tx.child("bodyPr").map(parse_body_pr).unwrap_or_default();
                        self.build_paragraphs(tx, &Inherit::default(), 2, None, &body, Some(&extra)).into_iter().map(Block::Para).collect()
                    }
                    None => Vec::new(),
                };
                let cell = TableCell { span, rowspan, blocks, fill, borders, margins: Some(margins), valign, covered, ..Default::default() };
                if !(covered && tc.attr("vMerge") == Some("1") && false) {
                    row.cells.push(cell);
                }
                ci += span;
            }
            t.rows.push(row);
        }
        // normalisation : les cellules vMerge sont des cellules couvertes
        let f = flow::table_fragment(&t, t.col_widths.iter().sum(), &LayoutCtx::default());
        f.items
    }
}

/// Rectangle de texte défini par la géométrie prédéfinie.
fn geom_text_rect(geom: &str, w: f32, h: f32, adj: &HashMap<String, f32>) -> Rect {
    let ss = w.min(h);
    match geom {
        "ellipse" | "flowChartConnector" | "wedgeEllipseCallout" | "donut" | "smileyFace" => Rect::new(w * 0.1464, h * 0.1464, w * 0.7071, h * 0.7071),
        "roundRect" | "flowChartAlternateProcess" => {
            let r = ss * adj.get("adj").copied().unwrap_or(16667.0) / 100000.0 * 0.29289;
            Rect::new(r, r, w - 2.0 * r, h - 2.0 * r)
        }
        "diamond" | "flowChartDecision" => Rect::new(w / 4.0, h / 4.0, w / 2.0, h / 2.0),
        "triangle" | "flowChartExtract" => Rect::new(w * 0.25, h * 0.5, w * 0.5, h * 0.5),
        "hexagon" | "octagon" | "flowChartPreparation" => Rect::new(w * 0.15, h * 0.1, w * 0.7, h * 0.8),
        "parallelogram" | "flowChartInputOutput" => Rect::new(w * 0.15, 0.0, w * 0.7, h),
        "homePlate" | "chevron" => Rect::new(0.0, 0.0, w * 0.8, h),
        "can" | "flowChartMagneticDisk" => Rect::new(0.0, h * 0.25, w, h * 0.65),
        "star5" | "star4" | "star6" | "star7" | "star8" => Rect::new(w * 0.25, h * 0.3, w * 0.5, h * 0.45),
        "cloud" | "cloudCallout" => Rect::new(w * 0.15, h * 0.2, w * 0.7, h * 0.6),
        _ => Rect::new(0.0, 0.0, w, h),
    }
}

/// Mise en page d'une zone de texte (marges, ancrage, renvoi à la ligne, texte vertical).
fn layout_text_box(paras: Vec<Paragraph>, rect: Rect, body: &BodyProps) -> Vec<Item> {
    let ins = [body.ins[0].unwrap_or(7.2), body.ins[1].unwrap_or(3.6), body.ins[2].unwrap_or(7.2), body.ins[3].unwrap_or(3.6)];
    let vertical = matches!(body.vert.as_deref(), Some("vert") | Some("vert270") | Some("eaVert") | Some("wordArtVert"));
    let (bw, bh) = if vertical { (rect.h, rect.w) } else { (rect.w, rect.h) };
    let inner_w = (bw - ins[0] - ins[2]).max(1.0);
    let inner_h = bh - ins[1] - ins[3];
    let wrap = body.wrap.unwrap_or(true);
    let blocks: Vec<Block> = paras.into_iter().map(Block::Para).collect();
    let ctx = LayoutCtx::default();
    let (frag, dx) = if wrap {
        (flow::stack_blocks(&blocks, inner_w, &ctx), 0.0)
    } else {
        // sans renvoi : largeur naturelle, centrée selon l'alignement
        let big = 10000.0;
        let f = flow::stack_blocks(&blocks, big, &ctx);
        let align = blocks.iter().find_map(|b| if let Block::Para(p) = b { Some(p.props.align) } else { None }).unwrap_or(Align::Left);
        let dx = match align {
            Align::Center => inner_w / 2.0 - big / 2.0,
            Align::Right => inner_w - big,
            _ => 0.0,
        };
        (f, dx)
    };
    let dy = match body.anchor.as_deref() {
        Some("ctr") => (inner_h - frag.height) / 2.0,
        Some("b") => inner_h - frag.height,
        _ => 0.0,
    };
    let mut t = Transform::from_translate(rect.x + ins[0] + dx, rect.y + ins[1] + dy);
    if vertical {
        let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
        let ang = if body.vert.as_deref() == Some("vert270") { -90.0 } else { 90.0 };
        t = Transform::from_translate(cx, cy).pre_rotate(ang).pre_translate(-bw / 2.0 + ins[0] + dx, -bh / 2.0 + ins[1] + dy);
    }
    vec![Item::group(t, None, frag.items)]
}

// ---------------------------------------------------------------------------------
// Chargement d'une présentation
// ---------------------------------------------------------------------------------

fn clr_map(n: Option<Node>) -> Option<HashMap<String, String>> {
    let n = n?;
    Some(n.attributes().map(|a| (a.name().to_string(), a.value().to_string())).collect())
}

fn background(ctx: &DrawCtx, csld: Option<Node>) -> Option<Option<(Fill, Color)>> {
    let bg = csld?.child("bg")?;
    let cc = ctx.cc();
    if let Some(bp) = bg.child("bgPr") {
        return Some(dml::parse_fill(bp, &cc).map(|f| (f, Color::WHITE)));
    }
    if let Some(br) = bg.child("bgRef") {
        let idx: usize = br.attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0);
        let ph = dml::child_color(br, &cc);
        let f = ctx.theme_fill(idx, ph).or(ph.map(Fill::Solid));
        return Some(f.map(|f| (f, Color::WHITE)));
    }
    None
}

pub fn load(pkg: &Package) -> Result<Vec<Page>, String> {
    let main = pkg.rels("").values().find(|r| r.kind == "officeDocument").map(|r| r.target.clone()).unwrap_or_else(|| "ppt/presentation.xml".into());
    let prels = pkg.rels(&main);
    let pres_xml = pkg.read_string(&main).ok_or("presentation.xml introuvable")?;
    let pres = parse_xml(&pres_xml).ok_or("presentation.xml invalide")?;
    let proot = pres.root_element();
    let sz = proot.child("sldSz");
    let sw = emu(sz.and_then(|s| s.attr("cx"))).unwrap_or(720.0);
    let sh = emu(sz.and_then(|s| s.attr("cy"))).unwrap_or(540.0);
    let slide_paths: Vec<String> = proot.child("sldIdLst").map(|l| l.children_named("sldId").filter_map(|s| s.rid().and_then(|id| prels.get(id)).map(|r| r.target.clone())).collect()).unwrap_or_default();
    // toutes les parties nécessaires
    let mut names: Vec<String> = Vec::new();
    let mut slide_info = Vec::new();
    for sp in &slide_paths {
        let srels = pkg.rels(sp);
        let layout = srels.values().find(|r| r.kind == "slideLayout").map(|r| r.target.clone());
        let master = layout.as_ref().and_then(|l| pkg.rels(l).values().find(|r| r.kind == "slideMaster").map(|r| r.target.clone()));
        for n in [Some(sp.clone()), layout.clone(), master.clone()].into_iter().flatten() {
            if !names.contains(&n) {
                names.push(n);
            }
        }
        slide_info.push((sp.clone(), srels, layout, master));
    }
    let table_styles_path = prels.values().find(|r| r.kind == "tableStyles").map(|r| r.target.clone());
    let texts: Vec<String> = names.iter().map(|n| pkg.read_string(n).unwrap_or_default()).collect();
    let docs: Vec<Option<Document>> = texts.iter().map(|t| parse_xml(t)).collect();
    let get = |name: &Option<String>| -> Option<&Document> { name.as_ref().and_then(|n| names.iter().position(|x| x == n)).and_then(|i| docs[i].as_ref()) };
    let ts_text = table_styles_path.and_then(|p| pkg.read_string(&p)).unwrap_or_default();
    let ts_doc = parse_xml(&ts_text);
    let mut themes: HashMap<String, Theme> = HashMap::new();
    let cc0 = Theme::default();
    let default_ls = parse_list_style(proot.child("defaultTextStyle"), &ColorCtx::new(&cc0));

    let mut pages = Vec::new();
    for (si, (sp, srels, layout, master)) in slide_info.iter().enumerate() {
        let Some(sdoc) = get(&Some(sp.clone())) else { continue };
        let ldoc = get(layout);
        let mdoc = get(master);
        let theme_path = master.as_ref().and_then(|m| pkg.rels(m).values().find(|r| r.kind == "theme").map(|r| r.target.clone()));
        let theme = themes.entry(theme_path.clone().unwrap_or_default()).or_insert_with(|| theme_path.as_ref().map(|t| Theme::load(pkg, t)).unwrap_or_default()).clone();
        let mroot = mdoc.map(|d| d.root_element());
        let lroot = ldoc.map(|d| d.root_element());
        let sroot = sdoc.root_element();
        // correspondance des couleurs : masque, éventuellement surchargée
        let mut cmap = clr_map(mroot.and_then(|m| m.child("clrMap")));
        if let Some(ov) = sroot.child("clrMapOvr").and_then(|o| o.child("overrideClrMapping")) {
            cmap = clr_map(Some(ov));
        } else if let Some(ov) = lroot.and_then(|l| l.child("clrMapOvr")).and_then(|o| o.child("overrideClrMapping")) {
            cmap = clr_map(Some(ov));
        }
        let mk_ctx = |rels: HashMap<String, Rel>| -> DrawCtx {
            let cc = ColorCtx { theme: &theme, clr_map: cmap.as_ref(), ph_color: None };
            let txs = mroot.and_then(|m| m.child("txStyles"));
            let mut title = default_ls.clone();
            let mut body = default_ls.clone();
            let mut other = default_ls.clone();
            merge_list(&mut title, &parse_list_style(txs.and_then(|t| t.child("titleStyle")), &cc));
            merge_list(&mut body, &parse_list_style(txs.and_then(|t| t.child("bodyStyle")), &cc));
            merge_list(&mut other, &parse_list_style(txs.and_then(|t| t.child("otherStyle")), &cc));
            DrawCtx { pkg, theme: &theme, clr_map: cmap.clone(), rels, title_style: title, body_style: body, other_style: other, slide_number: si as u32 + 1, table_styles: ts_doc.as_ref() }
        };
        let sctx = mk_ctx(srels.clone());
        let lctx = mk_ctx(layout.as_ref().map(|l| pkg.rels(l)).unwrap_or_default());
        let mctx = mk_ctx(master.as_ref().map(|m| pkg.rels(m)).unwrap_or_default());
        // arrière-plan
        let s_csld = sroot.child("cSld");
        let l_csld = lroot.and_then(|l| l.child("cSld"));
        let m_csld = mroot.and_then(|m| m.child("cSld"));
        let bg = background(&sctx, s_csld).map(|b| (b, &sctx)).or_else(|| background(&lctx, l_csld).map(|b| (b, &lctx))).or_else(|| background(&mctx, m_csld).map(|b| (b, &mctx)));
        let mut items = Vec::new();
        let page_rect = Rect::new(0.0, 0.0, sw, sh);
        let mut bg_color = Some(Color::WHITE);
        if let Some((Some((fill, _)), ctx)) = bg {
            match &fill {
                Fill::Solid(c) => bg_color = Some(*c),
                _ => {
                    if let (Some(paint), Some(p)) = (dml::fill_to_paint(&fill, page_rect, &|rid| ctx.image(rid)), crate::display::rect_path(page_rect)) {
                        items.push(Item::Path { path: Arc::new(p), fill: Some(paint), stroke: None });
                    }
                }
            }
        }
        let show_master = sroot.attr("showMasterSp") != Some("0");
        let layout_show_master = lroot.and_then(|l| l.attr("showMasterSp")) != Some("0");
        let m_tree = m_csld.and_then(|c| c.child("spTree"));
        let l_tree = l_csld.and_then(|c| c.child("spTree"));
        if show_master && layout_show_master {
            if let Some(t) = m_tree {
                items.extend(mctx.render_tree(t, &[], true));
            }
        }
        if show_master {
            if let Some(t) = l_tree {
                items.extend(lctx.render_tree(t, &m_tree.into_iter().collect::<Vec<_>>(), true));
            }
        }
        let inherit: Vec<Node> = m_tree.into_iter().chain(l_tree).collect();
        let mut text = String::new();
        if let Some(t) = s_csld.and_then(|c| c.child("spTree")) {
            items.extend(sctx.render_tree(t, &inherit, false));
            for tnode in t.descendants().filter(|n| n.is_element() && n.local() == "t") {
                text.push_str(tnode.text().unwrap_or(""));
                text.push(' ');
            }
        }
        pages.push(Page { width: sw, height: sh, background: bg_color, items: vec![Item::group(Transform::identity(), Some(page_rect), items)], text });
    }
    if pages.is_empty() {
        return Err("La présentation ne contient aucune diapositive.".into());
    }
    Ok(pages)
}

// ---------------------------------------------------------------------------------
// Dessins autonomes : SmartArt (dsp) et dessins Excel (xdr)
// ---------------------------------------------------------------------------------

fn render_drawing_part_ctx(parent: &DrawCtx, path: &str, rect: Rect) -> Vec<Item> {
    let Some(xml) = parent.pkg.read_string(path) else { return Vec::new() };
    let Some(doc) = parse_xml(&xml) else { return Vec::new() };
    let ctx = DrawCtx {
        pkg: parent.pkg,
        theme: parent.theme,
        clr_map: parent.clr_map.clone(),
        rels: parent.pkg.rels(path),
        title_style: empty_list(),
        body_style: empty_list(),
        other_style: empty_list(),
        slide_number: parent.slide_number,
        table_styles: None,
    };
    let Some(tree) = doc.root_element().descendant("spTree") else { return Vec::new() };
    let items: Vec<Item> = tree.children().filter(|c| c.is_element()).flat_map(|c| ctx.render_node(c, &[], false)).collect();
    vec![Item::group(Transform::from_translate(rect.x, rect.y), None, items)]
}

/// Dessin SmartArt pré-calculé (utilisé par Word).
pub fn render_drawing_part(pkg: &Package, path: &str, theme: &Theme, rect: Rect) -> Vec<Item> {
    let ctx = DrawCtx { pkg, theme, clr_map: None, rels: HashMap::new(), title_style: empty_list(), body_style: empty_list(), other_style: empty_list(), slide_number: 1, table_styles: None };
    render_drawing_part_ctx(&ctx, path, rect)
}

/// Objets d'une feuille Excel : (rectangle dans la feuille, éléments relatifs).
pub fn sheet_drawings(pkg: &Package, path: &str, theme: &Theme, pos: &dyn Fn(u32, f32, u32, f32) -> (f32, f32), res: Option<&super::chart::Resolver>) -> Vec<(Rect, Vec<Item>)> {
    let Some(xml) = pkg.read_string(path) else { return Vec::new() };
    let Some(doc) = parse_xml(&xml) else { return Vec::new() };
    let ctx = DrawCtx { pkg, theme, clr_map: None, rels: pkg.rels(path), title_style: empty_list(), body_style: empty_list(), other_style: empty_list(), slide_number: 1, table_styles: None };
    let mut out = Vec::new();
    let marker = |n: Option<Node>| -> Option<(f32, f32)> {
        let n = n?;
        let g = |a: &str| n.child(a).and_then(|x| x.text()).and_then(|t| t.trim().parse::<f64>().ok()).unwrap_or(0.0);
        Some(pos(g("col") as u32, (g("colOff") / 12700.0) as f32, g("row") as u32, (g("rowOff") / 12700.0) as f32))
    };
    for anchor in doc.root_element().children().filter(|c| c.is_element()) {
        let (x1, y1, w, h) = match anchor.local() {
            "twoCellAnchor" => {
                let Some(a) = marker(anchor.child("from")) else { continue };
                let Some(b) = marker(anchor.child("to")) else { continue };
                (a.0, a.1, (b.0 - a.0).max(1.0), (b.1 - a.1).max(1.0))
            }
            "oneCellAnchor" => {
                let Some(a) = marker(anchor.child("from")) else { continue };
                let ext = anchor.child("ext");
                (a.0, a.1, emu(ext.and_then(|e| e.attr("cx"))).unwrap_or(100.0), emu(ext.and_then(|e| e.attr("cy"))).unwrap_or(100.0))
            }
            "absoluteAnchor" => {
                let p = anchor.child("pos");
                let ext = anchor.child("ext");
                (emu(p.and_then(|e| e.attr("x"))).unwrap_or(0.0), emu(p.and_then(|e| e.attr("y"))).unwrap_or(0.0), emu(ext.and_then(|e| e.attr("cx"))).unwrap_or(100.0), emu(ext.and_then(|e| e.attr("cy"))).unwrap_or(100.0))
            }
            _ => continue,
        };
        let rect = Rect::new(x1, y1, w, h);
        let Some(shape) = anchor.children().find(|c| c.is_element() && matches!(c.local(), "sp" | "pic" | "graphicFrame" | "grpSp" | "cxnSp" | "AlternateContent")) else { continue };
        // l'ancre définit la position : on rend la forme dans son propre repère
        let items = match shape.local() {
            "graphicFrame" => {
                let local = Rect::new(0.0, 0.0, w, h);
                let mut v = Vec::new();
                if let Some(gd) = shape.path(&["graphic", "graphicData"]) {
                    if let Some(ch) = gd.child("chart") {
                        if let Some(rel) = ch.rid().and_then(|id| ctx.rels.get(id)) {
                            v.extend(super::chart::render_chart_with(pkg, &rel.target, local, theme, res));
                        }
                    }
                }
                v
            }
            _ => {
                let inner = ctx.render_node(shape, &[], false);
                // recaler : la forme a ses propres coordonnées xfrm
                let (orig, _, _, _) = xfrm_rect(sppr_of(shape)).unwrap_or((Rect::new(0.0, 0.0, w, h), 0.0, false, false));
                let sx = if orig.w > 0.0 && shape.local() != "grpSp" { w / orig.w } else { 1.0 };
                let sy = if orig.h > 0.0 && shape.local() != "grpSp" { h / orig.h } else { 1.0 };
                vec![Item::group(Transform::from_scale(sx, sy).pre_translate(-orig.x, -orig.y), None, inner)]
            }
        };
        out.push((rect, items));
    }
    out
}
