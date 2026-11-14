//! Lecture des documents Word (.docx, .docm, .dotx) vers le modèle à flux.

use super::drawingml::{self as dml, emu, ColorCtx, Fill, LineDef};
use super::theme::Theme;
use super::twips;
use crate::color::{highlight_color, Color};
use crate::display::{DashStyle, Item, Paint, Rect};
use crate::flow::*;
use crate::package::{parse_xml, NodeExt, Package, Rel};
use crate::text::*;
use roxmltree::Node;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tiny_skia::Transform;

type B<T> = Option<Option<T>>;

#[derive(Clone, Default, Debug)]
pub(crate) struct RPr {
    font: Option<String>,
    font_theme: Option<String>,
    size: Option<f32>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<u8>,
    strike: Option<bool>,
    dstrike: Option<bool>,
    color: B<Color>,
    highlight: B<Color>,
    shading: B<Color>,
    vert: Option<VertAlign>,
    caps: Option<bool>,
    small_caps: Option<bool>,
    spacing: Option<f32>,
    scale: Option<f32>,
    hidden: Option<bool>,
    position: Option<f32>,
    style: Option<String>,
}

macro_rules! merge_fields {
    ($dst:expr, $src:expr, $($f:ident),*) => {
        $( if $src.$f.is_some() { $dst.$f = $src.$f.clone(); } )*
    };
}

impl RPr {
    fn merge(&mut self, o: &RPr) {
        merge_fields!(self, o, size, bold, italic, underline, strike, dstrike, color, highlight, shading, vert, caps, small_caps, spacing, scale, hidden, position, style);
        if o.font.is_some() || o.font_theme.is_some() {
            self.font = o.font.clone();
            self.font_theme = o.font_theme.clone();
        }
    }
}

#[derive(Clone, Default, Debug)]
pub(crate) struct PPr {
    style: Option<String>,
    jc: Option<Align>,
    ind_left: Option<f32>,
    ind_right: Option<f32>,
    ind_first: Option<f32>,
    before: Option<f32>,
    after: Option<f32>,
    before_auto: Option<bool>,
    after_auto: Option<bool>,
    line: Option<LineSpacing>,
    keep_next: Option<bool>,
    keep_lines: Option<bool>,
    page_break_before: Option<bool>,
    widow: Option<bool>,
    shading: B<Color>,
    borders: [B<BorderLine>; 4],
    tabs: Vec<(f32, Option<TabKind>, Option<char>)>,
    num_id: Option<String>,
    ilvl: Option<u8>,
    contextual: Option<bool>,
    mark: Option<RPr>,
}

impl PPr {
    fn merge(&mut self, o: &PPr) {
        merge_fields!(self, o, style, jc, ind_left, ind_right, ind_first, before, after, before_auto, after_auto, line, keep_next, keep_lines, page_break_before, widow, shading, num_id, ilvl, contextual);
        for i in 0..4 {
            if o.borders[i].is_some() {
                self.borders[i] = o.borders[i].clone();
            }
        }
        for t in &o.tabs {
            self.tabs.retain(|x| (x.0 - t.0).abs() > 0.5);
            self.tabs.push(*t);
        }
        if let Some(m) = &o.mark {
            let mut base = self.mark.clone().unwrap_or_default();
            base.merge(m);
            self.mark = Some(base);
        }
    }
}

fn on_off(n: Node) -> bool {
    !matches!(n.attr("val"), Some("0") | Some("false") | Some("off") | Some("none"))
}

fn attr_f32(n: Node, a: &str) -> Option<f32> {
    n.attr(a).and_then(|v| v.trim().parse::<f32>().ok())
}

pub(crate) struct Ctx<'p> {
    pkg: &'p Package,
    theme: Theme,
    styles: Styles,
    numbering: Numbering,
    default_tab: f32,
    counters: HashMap<String, [i32; 9]>,
    started: HashMap<String, [bool; 9]>,
    overrides_applied: HashSet<String>,
    fields: Vec<FieldState>,
    footnotes: HashMap<String, Node<'p, 'p>>,
    footnote_order: Vec<(u32, String)>,
    current_note: Option<u32>,
    notes_seen: u32,
    parts: HashMap<String, &'p roxmltree::Document<'p>>,
}

struct FieldState {
    instr: String,
    result: bool,
    kind: Option<Field>,
}

#[derive(Clone)]
struct Part {
    rels: HashMap<String, Rel>,
}

// ----------------------------------------------------------------------------------
// Styles
// ----------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct CondFmt {
    rpr: RPr,
    ppr: PPr,
    shading: B<Color>,
    borders: [B<BorderLine>; 6],
}

#[derive(Clone, Default)]
struct TblStyle {
    borders: [B<BorderLine>; 6], // haut, gauche, bas, droite, intH, intV
    margins: [Option<f32>; 4],   // haut, droite, bas, gauche
    shading: B<Color>,
    rpr: RPr,
    ppr: PPr,
    conds: HashMap<String, CondFmt>,
}

impl TblStyle {
    fn merge(&mut self, o: &TblStyle) {
        for i in 0..6 {
            if o.borders[i].is_some() {
                self.borders[i] = o.borders[i].clone();
            }
        }
        for i in 0..4 {
            if o.margins[i].is_some() {
                self.margins[i] = o.margins[i];
            }
        }
        if o.shading.is_some() {
            self.shading = o.shading;
        }
        self.rpr.merge(&o.rpr);
        self.ppr.merge(&o.ppr);
        for (k, v) in &o.conds {
            self.conds.insert(k.clone(), v.clone());
        }
    }
}

#[derive(Clone, Default)]
struct Style {
    #[allow(dead_code)]
    kind: String,
    based_on: Option<String>,
    ppr: PPr,
    rpr: RPr,
    tbl: TblStyle,
}

#[derive(Default)]
struct Styles {
    map: HashMap<String, Style>,
    doc_rpr: RPr,
    doc_ppr: PPr,
    default_para: Option<String>,
    default_table: Option<String>,
    default_char: Option<String>,
}

impl Styles {
    fn chain(&self, id: &str) -> Vec<&Style> {
        let mut v = Vec::new();
        let mut cur = Some(id.to_string());
        let mut guard = 0;
        while let Some(c) = cur {
            guard += 1;
            if guard > 20 {
                break;
            }
            match self.map.get(&c) {
                Some(s) => {
                    v.push(s);
                    cur = s.based_on.clone();
                }
                None => break,
            }
        }
        v.reverse();
        v
    }
    fn para(&self, id: &str) -> (PPr, RPr) {
        let mut p = PPr::default();
        let mut r = RPr::default();
        for s in self.chain(id) {
            p.merge(&s.ppr);
            r.merge(&s.rpr);
        }
        (p, r)
    }
    fn char_style(&self, id: &str) -> RPr {
        let mut r = RPr::default();
        for s in self.chain(id) {
            r.merge(&s.rpr);
        }
        r
    }
    fn table(&self, id: &str) -> TblStyle {
        let mut t = TblStyle::default();
        for s in self.chain(id) {
            t.merge(&s.tbl);
            t.rpr.merge(&s.rpr);
            t.ppr.merge(&s.ppr);
        }
        t
    }
}

// ----------------------------------------------------------------------------------
// Numérotation
// ----------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Lvl {
    start: i32,
    fmt: String,
    text: String,
    ppr: PPr,
    rpr: RPr,
    suff: String,
    is_lgl: bool,
    #[allow(dead_code)]
    jc: Option<Align>,
}

#[derive(Default)]
struct Numbering {
    abstracts: HashMap<String, Vec<Option<Lvl>>>,
    abstract_links: HashMap<String, String>, // numStyleLink -> style
    nums: HashMap<String, (String, HashMap<u8, (Option<i32>, Option<Lvl>)>)>,
}

// ----------------------------------------------------------------------------------
// Analyse des propriétés
// ----------------------------------------------------------------------------------

impl<'p> Ctx<'p> {
    fn color_attr(&self, n: Node) -> B<Color> {
        if let Some(tc) = n.attr("themeColor") {
            if let Some(mut c) = self.theme.color(tc) {
                if let Some(s) = n.attr("themeShade").and_then(|v| u8::from_str_radix(v, 16).ok()) {
                    let (h, sat, l) = c.to_hsl();
                    c = Color::from_hsl(h, sat, l * s as f32 / 255.0, 255);
                }
                if let Some(t) = n.attr("themeTint").and_then(|v| u8::from_str_radix(v, 16).ok()) {
                    let (h, sat, l) = c.to_hsl();
                    let f = t as f32 / 255.0;
                    c = Color::from_hsl(h, sat, l * f + (1.0 - f), 255);
                }
                return Some(Some(c));
            }
        }
        match n.attr("val") {
            Some("auto") | None => Some(None),
            Some(v) => Some(Color::from_hex(v)),
        }
    }

    fn shading(&self, n: Node) -> B<Color> {
        let fill = n.attr("fill").filter(|f| *f != "auto").and_then(Color::from_hex);
        let fill = match n.attr("themeFill") {
            Some(tf) => self.theme.color(tf).map(|c| {
                let mut c = c;
                if let Some(s) = n.attr("themeFillShade").and_then(|v| u8::from_str_radix(v, 16).ok()) {
                    let (h, sat, l) = c.to_hsl();
                    c = Color::from_hsl(h, sat, l * s as f32 / 255.0, 255);
                }
                if let Some(t) = n.attr("themeFillTint").and_then(|v| u8::from_str_radix(v, 16).ok()) {
                    let (h, sat, l) = c.to_hsl();
                    let f = t as f32 / 255.0;
                    c = Color::from_hsl(h, sat, l * f + (1.0 - f), 255);
                }
                c
            }),
            None => fill,
        };
        let val = n.attr("val").unwrap_or("clear");
        let color = n.attr("color").filter(|c| *c != "auto").and_then(Color::from_hex).unwrap_or(Color::BLACK);
        let pct = |p: f32| -> Option<Color> { Some(color.mix(fill.unwrap_or(Color::WHITE), 1.0 - p)) };
        let res = match val {
            "solid" => Some(color),
            "nil" | "none" => None,
            "clear" => fill,
            v if v.starts_with("pct") => v[3..].parse::<f32>().ok().and_then(|p| pct(p / 100.0)).or(fill),
            _ => fill,
        };
        Some(res)
    }

    fn border(&self, n: Node) -> B<BorderLine> {
        let val = n.attr("val").unwrap_or("single");
        if matches!(val, "nil" | "none") {
            return Some(None);
        }
        let sz = attr_f32(n, "sz").unwrap_or(4.0) / 8.0;
        let color = match self.color_attr(n) {
            Some(Some(c)) => c,
            _ => Color::BLACK,
        };
        let dash = match val {
            "dotted" => DashStyle::Dot,
            "dashed" | "dashSmallGap" => DashStyle::Dash,
            "dotDash" | "dotDotDash" => DashStyle::DashDot,
            _ => DashStyle::Solid,
        };
        let double = matches!(val, "double" | "triple" | "thinThickSmallGap" | "thickThinSmallGap" | "thinThickMediumGap" | "thickThinMediumGap" | "thinThickLargeGap" | "thickThinLargeGap");
        let width = match val {
            "thick" => sz.max(1.5),
            _ => sz.max(0.25),
        };
        Some(Some(BorderLine { width, color, double, dash, space: attr_f32(n, "space").unwrap_or(0.0) }))
    }

    fn parse_rpr(&self, n: Node) -> RPr {
        let mut r = RPr::default();
        for c in n.children().filter(|c| c.is_element()) {
            match c.local() {
                "rStyle" => r.style = c.attr("val").map(String::from),
                "rFonts" => {
                    let theme = c.attr("asciiTheme").or_else(|| c.attr("hAnsiTheme"));
                    let explicit = c.attr("ascii").or_else(|| c.attr("hAnsi")).or_else(|| c.attr("cs")).or_else(|| c.attr("eastAsia"));
                    if theme.is_some() || explicit.is_some() {
                        r.font_theme = theme.map(String::from);
                        r.font = explicit.map(String::from);
                    }
                }
                "sz" => r.size = attr_f32(c, "val").map(|v| v / 2.0),
                "b" => r.bold = Some(on_off(c)),
                "i" => r.italic = Some(on_off(c)),
                "u" => {
                    r.underline = Some(match c.attr("val").unwrap_or("single") {
                        "none" | "0" => 0,
                        "double" => 2,
                        _ => 1,
                    })
                }
                "strike" => r.strike = Some(on_off(c)),
                "dstrike" => r.dstrike = Some(on_off(c)),
                "color" => r.color = self.color_attr(c),
                "highlight" => r.highlight = Some(c.attr("val").and_then(highlight_color)),
                "shd" => r.shading = self.shading(c),
                "vertAlign" => {
                    r.vert = Some(match c.attr("val") {
                        Some("superscript") => VertAlign::Super,
                        Some("subscript") => VertAlign::Sub,
                        _ => VertAlign::Baseline,
                    })
                }
                "caps" => r.caps = Some(on_off(c)),
                "smallCaps" => r.small_caps = Some(on_off(c)),
                "spacing" => r.spacing = twips(c.attr("val")),
                "w" => r.scale = attr_f32(c, "val").map(|v| v / 100.0),
                "vanish" | "specVanish" => r.hidden = Some(on_off(c)),
                "webHidden" => {}
                "position" => r.position = attr_f32(c, "val").map(|v| v / 2.0),
                _ => {}
            }
        }
        r
    }

    fn parse_ppr(&self, n: Node) -> PPr {
        let mut p = PPr::default();
        for c in n.children().filter(|c| c.is_element()) {
            match c.local() {
                "pStyle" => p.style = c.attr("val").map(String::from),
                "jc" => {
                    p.jc = Some(match c.attr("val").unwrap_or("left") {
                        "center" => Align::Center,
                        "right" | "end" => Align::Right,
                        "both" | "distribute" | "thaiDistribute" | "lowKashida" | "mediumKashida" | "highKashida" => Align::Justify,
                        _ => Align::Left,
                    })
                }
                "ind" => {
                    if let Some(v) = twips(c.attr("left").or_else(|| c.attr("start"))) {
                        p.ind_left = Some(v);
                    }
                    if let Some(v) = twips(c.attr("right").or_else(|| c.attr("end"))) {
                        p.ind_right = Some(v);
                    }
                    if let Some(v) = twips(c.attr("hanging")) {
                        p.ind_first = Some(-v);
                    } else if let Some(v) = twips(c.attr("firstLine")) {
                        p.ind_first = Some(v);
                    }
                }
                "spacing" => {
                    if let Some(v) = twips(c.attr("before")) {
                        p.before = Some(v);
                    }
                    if let Some(v) = twips(c.attr("after")) {
                        p.after = Some(v);
                    }
                    if let Some(v) = c.attr("beforeAutospacing") {
                        p.before_auto = Some(v == "1" || v == "true");
                    }
                    if let Some(v) = c.attr("afterAutospacing") {
                        p.after_auto = Some(v == "1" || v == "true");
                    }
                    if let Some(l) = attr_f32(c, "line") {
                        p.line = Some(match c.attr("lineRule").unwrap_or("auto") {
                            "exact" => LineSpacing::Exact(l / 20.0),
                            "atLeast" => LineSpacing::AtLeast(l / 20.0),
                            _ => LineSpacing::Multiple(l / 240.0),
                        });
                    }
                }
                "keepNext" => p.keep_next = Some(on_off(c)),
                "keepLines" => p.keep_lines = Some(on_off(c)),
                "pageBreakBefore" => p.page_break_before = Some(on_off(c)),
                "widowControl" => p.widow = Some(on_off(c)),
                "contextualSpacing" => p.contextual = Some(on_off(c)),
                "shd" => p.shading = self.shading(c),
                "pBdr" => {
                    for b in c.children().filter(|b| b.is_element()) {
                        let idx = match b.local() {
                            "top" => 0,
                            "right" | "end" => 1,
                            "bottom" => 2,
                            "left" | "start" => 3,
                            _ => continue,
                        };
                        p.borders[idx] = self.border(b);
                    }
                }
                "tabs" => {
                    for t in c.children_named("tab") {
                        let pos = twips(t.attr("pos")).unwrap_or(0.0);
                        let kind = match t.attr("val").unwrap_or("left") {
                            "clear" => None,
                            "center" => Some(TabKind::Center),
                            "right" | "end" => Some(TabKind::Right),
                            "decimal" => Some(TabKind::Decimal),
                            "bar" => None,
                            _ => Some(TabKind::Left),
                        };
                        let leader = match t.attr("leader") {
                            Some("dot") => Some('.'),
                            Some("hyphen") => Some('-'),
                            Some("underscore") | Some("heavy") => Some('_'),
                            Some("middleDot") => Some('·'),
                            _ => None,
                        };
                        p.tabs.push((pos, kind, leader));
                    }
                }
                "numPr" => {
                    if let Some(id) = c.child("numId").and_then(|x| x.attr("val")) {
                        p.num_id = Some(id.to_string());
                    }
                    if let Some(l) = c.child("ilvl").and_then(|x| x.attr("val")).and_then(|v| v.parse().ok()) {
                        p.ilvl = Some(l);
                    }
                }
                "rPr" => p.mark = Some(self.parse_rpr(c)),
                _ => {}
            }
        }
        p
    }

    fn load_styles(&mut self, xml: &str) {
        let Some(doc) = parse_xml(xml) else { return };
        let root = doc.root_element();
        if let Some(dd) = root.child("docDefaults") {
            if let Some(r) = dd.path(&["rPrDefault", "rPr"]) {
                self.styles.doc_rpr = self.parse_rpr(r);
            }
            if let Some(p) = dd.path(&["pPrDefault", "pPr"]) {
                self.styles.doc_ppr = self.parse_ppr(p);
            }
        }
        for s in root.children_named("style") {
            let id = s.attr("styleId").unwrap_or("").to_string();
            let kind = s.attr("type").unwrap_or("paragraph").to_string();
            let is_default = matches!(s.attr("default"), Some("1") | Some("true"));
            let mut st = Style { kind: kind.clone(), based_on: s.child("basedOn").and_then(|b| b.attr("val")).map(String::from), ..Default::default() };
            if let Some(p) = s.child("pPr") {
                st.ppr = self.parse_ppr(p);
            }
            if let Some(r) = s.child("rPr") {
                st.rpr = self.parse_rpr(r);
            }
            if kind == "table" {
                st.tbl = self.parse_tbl_style(s);
            }
            if is_default {
                match kind.as_str() {
                    "paragraph" => self.styles.default_para = Some(id.clone()),
                    "table" => self.styles.default_table = Some(id.clone()),
                    "character" => self.styles.default_char = Some(id.clone()),
                    _ => {}
                }
            }
            self.styles.map.insert(id, st);
        }
    }

    fn parse_tbl_borders(&self, n: Node) -> [B<BorderLine>; 6] {
        let mut b: [B<BorderLine>; 6] = Default::default();
        for c in n.children().filter(|c| c.is_element()) {
            let i = match c.local() {
                "top" => 0,
                "left" | "start" => 1,
                "bottom" => 2,
                "right" | "end" => 3,
                "insideH" => 4,
                "insideV" => 5,
                _ => continue,
            };
            b[i] = self.border(c);
        }
        b
    }

    fn parse_margins(&self, n: Node) -> [Option<f32>; 4] {
        let mut m = [None; 4];
        for c in n.children().filter(|c| c.is_element()) {
            let i = match c.local() {
                "top" => 0,
                "right" | "end" => 1,
                "bottom" => 2,
                "left" | "start" => 3,
                _ => continue,
            };
            if c.attr("type") == Some("pct") {
                continue;
            }
            m[i] = twips(c.attr("w"));
        }
        m
    }

    fn parse_tbl_style(&self, s: Node) -> TblStyle {
        let mut t = TblStyle::default();
        if let Some(tp) = s.child("tblPr") {
            if let Some(b) = tp.child("tblBorders") {
                t.borders = self.parse_tbl_borders(b);
            }
            if let Some(m) = tp.child("tblCellMar") {
                t.margins = self.parse_margins(m);
            }
        }
        if let Some(shd) = s.child("tcPr").and_then(|tc| tc.child("shd")) {
            t.shading = self.shading(shd);
        }
        for c in s.children_named("tblStylePr") {
            let ty = c.attr("type").unwrap_or("").to_string();
            let mut cf = CondFmt::default();
            if let Some(r) = c.child("rPr") {
                cf.rpr = self.parse_rpr(r);
            }
            if let Some(p) = c.child("pPr") {
                cf.ppr = self.parse_ppr(p);
            }
            if let Some(tc) = c.child("tcPr") {
                if let Some(shd) = tc.child("shd") {
                    cf.shading = self.shading(shd);
                }
                if let Some(b) = tc.child("tcBorders") {
                    cf.borders = self.parse_tbl_borders(b);
                }
            }
            if let Some(b) = c.child("tblPr").and_then(|tp| tp.child("tblBorders")) {
                let bb = self.parse_tbl_borders(b);
                for i in 0..6 {
                    if bb[i].is_some() && cf.borders[i].is_none() {
                        cf.borders[i] = bb[i].clone();
                    }
                }
            }
            t.conds.insert(ty, cf);
        }
        t
    }

    fn load_numbering(&mut self, xml: &str) {
        let Some(doc) = parse_xml(xml) else { return };
        let root = doc.root_element();
        for a in root.children_named("abstractNum") {
            let id = a.attr("abstractNumId").unwrap_or("").to_string();
            let mut lvls: Vec<Option<Lvl>> = vec![None; 9];
            for l in a.children_named("lvl") {
                let i: usize = l.attr("ilvl").and_then(|v| v.parse().ok()).unwrap_or(0);
                if i < 9 {
                    lvls[i] = Some(self.parse_lvl(l));
                }
            }
            if let Some(link) = a.child("numStyleLink").and_then(|x| x.attr("val")) {
                self.numbering.abstract_links.insert(id.clone(), link.to_string());
            }
            self.numbering.abstracts.insert(id, lvls);
        }
        for n in root.children_named("num") {
            let id = n.attr("numId").unwrap_or("").to_string();
            let aid = n.child("abstractNumId").and_then(|x| x.attr("val")).unwrap_or("").to_string();
            let mut ov = HashMap::new();
            for o in n.children_named("lvlOverride") {
                let i: u8 = o.attr("ilvl").and_then(|v| v.parse().ok()).unwrap_or(0);
                let start = o.child("startOverride").and_then(|s| s.attr("val")).and_then(|v| v.parse().ok());
                let lvl = o.child("lvl").map(|l| self.parse_lvl(l));
                ov.insert(i, (start, lvl));
            }
            self.numbering.nums.insert(id, (aid, ov));
        }
    }

    fn parse_lvl(&self, l: Node) -> Lvl {
        Lvl {
            start: l.child("start").and_then(|s| s.attr("val")).and_then(|v| v.parse().ok()).unwrap_or(1),
            fmt: l.child("numFmt").and_then(|s| s.attr("val")).unwrap_or("decimal").to_string(),
            text: l.child("lvlText").and_then(|s| s.attr("val")).unwrap_or("").to_string(),
            ppr: l.child("pPr").map(|p| self.parse_ppr(p)).unwrap_or_default(),
            rpr: l.child("rPr").map(|r| self.parse_rpr(r)).unwrap_or_default(),
            suff: l.child("suff").and_then(|s| s.attr("val")).unwrap_or("tab").to_string(),
            is_lgl: l.child("isLgl").map(on_off).unwrap_or(false),
            jc: l.child("lvlJc").and_then(|j| j.attr("val")).map(|v| match v {
                "center" => Align::Center,
                "right" | "end" => Align::Right,
                _ => Align::Left,
            }),
        }
    }

    /// Niveau de liste effectif (avec surcharges) pour numId / ilvl.
    fn level(&self, num_id: &str, ilvl: u8) -> Option<(String, Lvl, Option<i32>)> {
        let (aid, ov) = self.numbering.nums.get(num_id)?;
        let mut aid = aid.clone();
        // liens de style de numérotation
        if let Some(style) = self.numbering.abstract_links.get(&aid) {
            let (p, _) = self.styles.para(style);
            if let Some(nid) = p.num_id {
                if let Some((a2, _)) = self.numbering.nums.get(&nid) {
                    aid = a2.clone();
                }
            }
        }
        let base = self.numbering.abstracts.get(&aid).and_then(|l| l.get(ilvl as usize).cloned().flatten());
        let (start_ov, lvl_ov) = ov.get(&ilvl).cloned().unwrap_or((None, None));
        let lvl = lvl_ov.or(base)?;
        Some((aid, lvl, start_ov))
    }

    fn next_label(&mut self, num_id: &str, ilvl: u8) -> Option<(String, Lvl)> {
        let ilvl = ilvl.min(8);
        let (aid, lvl, _) = self.level(num_id, ilvl)?;
        // surcharges de départ appliquées une seule fois par instance de liste
        if !self.overrides_applied.contains(num_id) {
            self.overrides_applied.insert(num_id.to_string());
            if let Some((_, ov)) = self.numbering.nums.get(num_id) {
                if !ov.is_empty() {
                    let mut c = self.counters.get(&aid).copied().unwrap_or([0; 9]);
                    let mut s = self.started.get(&aid).copied().unwrap_or([false; 9]);
                    for (l, (st, _)) in ov {
                        if let Some(st) = st {
                            c[*l as usize] = st - 1;
                            s[*l as usize] = true;
                        }
                    }
                    self.counters.insert(aid.clone(), c);
                    self.started.insert(aid.clone(), s);
                }
            }
        }
        let starts: Vec<i32> = (0..9).map(|i| self.level(num_id, i as u8).map(|l| l.1.start).unwrap_or(1)).collect();
        let counters = self.counters.entry(aid.clone()).or_insert([0; 9]);
        let started = self.started.entry(aid.clone()).or_insert([false; 9]);
        let i = ilvl as usize;
        if !started[i] {
            counters[i] = starts[i];
            started[i] = true;
        } else {
            counters[i] += 1;
        }
        for j in i + 1..9 {
            started[j] = false;
        }
        let snapshot = *counters;
        let started_snapshot = *started;
        let mut out = String::new();
        let mut chars = lvl.text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '%' {
                if let Some(d) = chars.peek().and_then(|c| c.to_digit(10)) {
                    chars.next();
                    let li = (d as usize).saturating_sub(1).min(8);
                    let val = if started_snapshot[li] || li == i { snapshot[li] } else { starts[li] };
                    let fmt = if li == i { lvl.fmt.clone() } else { self.level(num_id, li as u8).map(|l| l.1.fmt).unwrap_or_else(|| "decimal".into()) };
                    let fmt = if lvl.is_lgl { "decimal".to_string() } else { fmt };
                    out.push_str(&format_number(val, &fmt));
                    continue;
                }
            }
            out.push(ch);
        }
        if lvl.fmt == "none" && !lvl.text.contains('%') && lvl.text.is_empty() {
            out.clear();
        }
        Some((out, lvl))
    }

    fn text_style(&self, r: &RPr) -> TextStyle {
        let font = r
            .font_theme
            .as_deref()
            .and_then(|t| self.theme.font(t).map(String::from))
            .or_else(|| r.font.clone())
            .unwrap_or_else(|| "Times New Roman".into());
        let color = match r.color {
            Some(Some(c)) => c,
            _ => Color::BLACK,
        };
        let highlight = match r.highlight {
            Some(Some(c)) => Some(c),
            _ => match r.shading {
                Some(Some(c)) => Some(c),
                _ => None,
            },
        };
        TextStyle {
            font: Arc::from(font.as_str()),
            size: r.size.unwrap_or(10.0),
            bold: r.bold.unwrap_or(false),
            italic: r.italic.unwrap_or(false),
            underline: r.underline.map(|u| u == 1).unwrap_or(false),
            double_underline: r.underline.map(|u| u == 2).unwrap_or(false),
            strike: r.strike.unwrap_or(false) || r.dstrike.unwrap_or(false),
            color,
            highlight,
            vert: r.vert.unwrap_or_default(),
            caps: r.caps.unwrap_or(false),
            small_caps: r.small_caps.unwrap_or(false),
            spacing: r.spacing.unwrap_or(0.0),
            scale_x: r.scale.unwrap_or(1.0),
            hidden: r.hidden.unwrap_or(false),
            baseline_shift: r.position.unwrap_or(0.0),
        }
    }
}

pub fn format_number(n: i32, fmt: &str) -> String {
    match fmt {
        "upperRoman" => roman(n).to_uppercase(),
        "lowerRoman" => roman(n),
        "upperLetter" => letters(n).to_uppercase(),
        "lowerLetter" => letters(n),
        "decimalZero" => format!("{n:02}"),
        "bullet" | "none" => String::new(),
        "ordinal" => format!("{n}e"),
        "cardinalText" | "ordinalText" => n.to_string(),
        _ => n.to_string(),
    }
}

pub fn roman(mut n: i32) -> String {
    if n <= 0 {
        return n.to_string();
    }
    let table = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];
    let mut s = String::new();
    for (v, r) in table {
        while n >= v {
            s.push_str(r);
            n -= v;
        }
    }
    s
}

pub fn letters(n: i32) -> String {
    if n <= 0 {
        return n.to_string();
    }
    let n = n - 1;
    let ch = (b'a' + (n % 26) as u8) as char;
    std::iter::repeat_n(ch, (n / 26 + 1) as usize).collect()
}

// ----------------------------------------------------------------------------------
// Corps du document
// ----------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct TableCtx {
    rpr: RPr,
    ppr: PPr,
}

#[derive(Default)]
struct ParaAcc {
    segments: Vec<Vec<Inline>>,
    breaks: Vec<Block>,
    floats: Vec<Floating>,
    block_objects: Vec<Block>,
}

impl ParaAcc {
    fn cur(&mut self) -> &mut Vec<Inline> {
        if self.segments.is_empty() {
            self.segments.push(Vec::new());
        }
        self.segments.last_mut().unwrap()
    }
    fn push_text(&mut self, t: &str, st: &Arc<TextStyle>) {
        let cur = self.cur();
        if let Some(Inline::Text(prev, pst)) = cur.last_mut() {
            if Arc::ptr_eq(pst, st) {
                prev.push_str(t);
                return;
            }
        }
        cur.push(Inline::Text(t.to_string(), st.clone()));
    }
}

impl<'p> Ctx<'p> {
    fn field_hidden(&self) -> bool {
        self.fields.iter().any(|f| !f.result || f.kind.is_some())
    }

    fn parse_blocks(&mut self, parent: Node<'p, 'p>, part: &Part, tctx: Option<&TableCtx>, out: &mut Vec<Block>) {
        for c in parent.children().filter(|c| c.is_element()) {
            match c.local() {
                "p" => self.parse_paragraph(c, part, tctx, out),
                "tbl" => {
                    let t = self.parse_table(c, part);
                    out.push(Block::Table(t));
                }
                "sdt" => {
                    if let Some(sc) = c.child("sdtContent") {
                        self.parse_blocks(sc, part, tctx, out);
                    }
                }
                "customXml" | "ins" | "moveTo" | "smartTag" => self.parse_blocks(c, part, tctx, out),
                "AlternateContent" => {
                    if let Some(ch) = c.child("Choice").or_else(|| c.child("Fallback")) {
                        self.parse_blocks(ch, part, tctx, out);
                    }
                }
                _ => {}
            }
        }
    }

    fn parse_paragraph(&mut self, p: Node<'p, 'p>, part: &Part, tctx: Option<&TableCtx>, out: &mut Vec<Block>) {
        let direct = p.child("pPr").map(|n| self.parse_ppr(n)).unwrap_or_default();
        let style_id = direct.style.clone().or_else(|| self.styles.default_para.clone());
        let mut ppr = self.styles.doc_ppr.clone();
        let mut base_rpr = self.styles.doc_rpr.clone();
        let is_default_style = style_id == self.styles.default_para;
        let (sp, sr) = style_id.as_deref().map(|s| self.styles.para(s)).unwrap_or_default();
        if let Some(t) = tctx {
            if is_default_style {
                ppr.merge(&sp);
                base_rpr.merge(&sr);
                ppr.merge(&t.ppr);
                base_rpr.merge(&t.rpr);
            } else {
                ppr.merge(&t.ppr);
                base_rpr.merge(&t.rpr);
                ppr.merge(&sp);
                base_rpr.merge(&sr);
            }
        } else {
            ppr.merge(&sp);
            base_rpr.merge(&sr);
        }
        // numérotation
        let num_id = direct.num_id.clone().or_else(|| ppr.num_id.clone());
        let ilvl = direct.ilvl.or(ppr.ilvl).unwrap_or(0);
        let mut label: Option<(String, Lvl)> = None;
        if let Some(nid) = num_id.as_deref() {
            if nid != "0" {
                label = self.next_label(nid, ilvl);
            }
        }
        if let Some((_, lvl)) = &label {
            ppr.merge(&lvl.ppr);
        }
        ppr.merge(&direct);

        // marque de paragraphe
        let mut mark_rpr = base_rpr.clone();
        if let Some(m) = &direct.mark {
            mark_rpr.merge(m);
        }
        let mark_style = Arc::new(self.text_style(&mark_rpr));

        let mut acc = ParaAcc::default();
        if let Some((text, lvl)) = &label {
            if !text.is_empty() {
                let mut lr = mark_rpr.clone();
                lr.underline = None;
                lr.merge(&lvl.rpr);
                let ls = Arc::new(self.text_style(&lr));
                acc.push_text(text, &ls);
                match lvl.suff.as_str() {
                    "space" => acc.push_text(" ", &ls),
                    "nothing" => {}
                    _ => acc.cur().push(Inline::Tab(ls.clone())),
                }
            }
        }
        self.walk_inlines(p, part, &base_rpr, &mut acc);

        let props = self.para_props(&ppr, style_id.clone());
        let nseg = acc.segments.len().max(1);
        let mut segments = std::mem::take(&mut acc.segments);
        if segments.is_empty() {
            segments.push(Vec::new());
        }
        let mut breaks = std::mem::take(&mut acc.breaks).into_iter();
        for f in acc.floats.drain(..) {
            out.push(Block::Float(f));
        }
        for (i, seg) in segments.into_iter().enumerate() {
            let mut pp = props.clone();
            if i > 0 {
                pp.page_break_before = false;
                pp.space_before = 0.0;
            }
            if i + 1 < nseg {
                pp.space_after = 0.0;
            }
            let only_break = i > 0 && seg.is_empty() && i + 1 == nseg;
            if !only_break {
                out.push(Block::Para(Paragraph { props: pp, inlines: seg, mark: mark_style.clone() }));
            }
            if let Some(b) = breaks.next() {
                out.push(b);
            }
        }
        out.append(&mut acc.block_objects);
    }

    fn para_props(&self, ppr: &PPr, style_id: Option<String>) -> ParaProps {
        let mut tabs: Vec<TabStop> = ppr.tabs.iter().filter_map(|(pos, kind, leader)| kind.map(|k| TabStop { pos: *pos, kind: k, leader: *leader })).collect();
        tabs.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap());
        let before = if ppr.before_auto.unwrap_or(false) { 14.0 } else { ppr.before.unwrap_or(0.0) };
        let after = if ppr.after_auto.unwrap_or(false) { 14.0 } else { ppr.after.unwrap_or(0.0) };
        ParaProps {
            align: ppr.jc.unwrap_or(Align::Left),
            ind_left: ppr.ind_left.unwrap_or(0.0),
            ind_right: ppr.ind_right.unwrap_or(0.0),
            ind_first: ppr.ind_first.unwrap_or(0.0),
            space_before: before,
            space_after: after,
            line: ppr.line.unwrap_or(LineSpacing::Multiple(1.0)),
            tabs,
            default_tab: self.default_tab,
            keep_next: ppr.keep_next.unwrap_or(false),
            keep_lines: ppr.keep_lines.unwrap_or(false),
            page_break_before: ppr.page_break_before.unwrap_or(false),
            widow_control: ppr.widow.unwrap_or(true),
            shading: ppr.shading.flatten(),
            borders: [ppr.borders[0].clone().flatten(), ppr.borders[1].clone().flatten(), ppr.borders[2].clone().flatten(), ppr.borders[3].clone().flatten()],
            contextual_spacing: ppr.contextual.unwrap_or(false),
            style_id: style_id.map(|s| Arc::from(s.as_str())),
            pp_line_mode: false,
        }
    }

    fn walk_inlines(&mut self, node: Node<'p, 'p>, part: &Part, base: &RPr, acc: &mut ParaAcc) {
        for c in node.children().filter(|c| c.is_element()) {
            match c.local() {
                "r" => self.parse_run(c, part, base, acc),
                "hyperlink" | "smartTag" | "customXml" | "ins" | "moveTo" | "dir" | "bdo" | "rubyBase" => self.walk_inlines(c, part, base, acc),
                "sdt" => {
                    if let Some(sc) = c.child("sdtContent") {
                        self.walk_inlines(sc, part, base, acc);
                    }
                }
                "fldSimple" => {
                    let instr = c.attr("instr").unwrap_or("").trim().to_uppercase();
                    let kind = field_kind(&instr);
                    if let Some(k) = kind {
                        let st = self.run_style(None, base);
                        acc.cur().push(Inline::Field(k, st));
                    } else {
                        self.walk_inlines(c, part, base, acc);
                    }
                }
                "oMathPara" | "oMath" => self.walk_math(c, base, acc),
                "AlternateContent" => {
                    if let Some(ch) = c.child("Choice").or_else(|| c.child("Fallback")) {
                        self.walk_inlines(ch, part, base, acc);
                    }
                }
                "ruby" => {
                    if let Some(rb) = c.child("rubyBase") {
                        self.walk_inlines(rb, part, base, acc);
                    }
                }
                _ => {}
            }
        }
    }

    fn walk_math(&mut self, node: Node<'p, 'p>, base: &RPr, acc: &mut ParaAcc) {
        let mut r = base.clone();
        r.font = Some("Cambria Math".into());
        r.font_theme = None;
        r.italic = Some(true);
        let st = Arc::new(self.text_style(&r));
        for t in node.descendants().filter(|d| d.is_element() && d.local() == "t") {
            if let Some(txt) = t.text() {
                acc.push_text(txt, &st);
            }
        }
    }

    fn run_style(&self, rpr_node: Option<Node>, base: &RPr) -> Arc<TextStyle> {
        let mut r = base.clone();
        r.underline = base.underline;
        if let Some(n) = rpr_node {
            let direct = self.parse_rpr(n);
            if let Some(cs) = direct.style.as_deref() {
                r.merge(&self.styles.char_style(cs));
            }
            r.merge(&direct);
        }
        Arc::new(self.text_style(&r))
    }

    fn parse_run(&mut self, r: Node<'p, 'p>, part: &Part, base: &RPr, acc: &mut ParaAcc) {
        let st = self.run_style(r.child("rPr"), base);
        for c in r.children().filter(|c| c.is_element()) {
            match c.local() {
                "t" => {
                    if self.field_hidden() {
                        continue;
                    }
                    if let Some(t) = c.text() {
                        acc.push_text(t, &st);
                    }
                }
                "tab" | "ptab" => {
                    if !self.field_hidden() {
                        acc.cur().push(Inline::Tab(st.clone()));
                    }
                }
                "br" => {
                    if self.field_hidden() {
                        continue;
                    }
                    match c.attr("type") {
                        Some("page") => {
                            acc.breaks.push(Block::PageBreak);
                            acc.segments.push(Vec::new());
                        }
                        Some("column") => {
                            acc.breaks.push(Block::ColumnBreak);
                            acc.segments.push(Vec::new());
                        }
                        _ => acc.cur().push(Inline::LineBreak(st.clone())),
                    }
                }
                "cr" => acc.cur().push(Inline::LineBreak(st.clone())),
                "noBreakHyphen" => acc.push_text("\u{2011}", &st),
                "sym" => {
                    let font = c.attr("font").unwrap_or("Symbol");
                    if let Some(code) = c.attr("char").and_then(|v| u32::from_str_radix(v, 16).ok()) {
                        let ch = char::from_u32(code).unwrap_or(' ');
                        let mapped = crate::fonts::map_symbol_char(font, ch);
                        let mut s2 = (*st).clone();
                        if font.to_lowercase().contains("symbol") || font.to_lowercase().contains("wingding") {
                            s2.font = Arc::from("DejaVu Sans");
                        }
                        acc.push_text(&mapped.to_string(), &Arc::new(s2));
                    }
                }
                "fldChar" => match c.attr("fldCharType") {
                    Some("begin") => self.fields.push(FieldState { instr: String::new(), result: false, kind: None }),
                    Some("separate") => {
                        if let Some(f) = self.fields.last_mut() {
                            f.result = true;
                            f.kind = field_kind(&f.instr.trim().to_uppercase());
                            if let Some(k) = f.kind {
                                acc.cur().push(Inline::Field(k, st.clone()));
                            }
                        }
                    }
                    Some("end") => {
                        if let Some(f) = self.fields.pop() {
                            if !f.result {
                                if let Some(k) = field_kind(&f.instr.trim().to_uppercase()) {
                                    acc.cur().push(Inline::Field(k, st.clone()));
                                }
                            }
                        }
                    }
                    _ => {}
                },
                "instrText" => {
                    if let Some(f) = self.fields.last_mut() {
                        f.instr.push_str(c.text().unwrap_or(""));
                    }
                }
                "drawing" => {
                    if !self.field_hidden() {
                        self.parse_drawing(c, part, &st, acc);
                    }
                }
                "pict" | "object" => {
                    if !self.field_hidden() {
                        self.parse_vml(c, part, &st, acc);
                    }
                }
                "footnoteReference" | "endnoteReference" => {
                    self.notes_seen += 1;
                    let n = self.notes_seen;
                    if let Some(id) = c.attr("id") {
                        let prefix = if c.local() == "endnoteReference" { "e" } else { "f" };
                        self.footnote_order.push((n, format!("{prefix}{id}")));
                    }
                    let mut s2 = (*st).clone();
                    s2.vert = VertAlign::Super;
                    acc.push_text(&n.to_string(), &Arc::new(s2));
                }
                "footnoteRef" | "endnoteRef" => {
                    if let Some(n) = self.current_note {
                        let mut s2 = (*st).clone();
                        s2.vert = VertAlign::Super;
                        acc.push_text(&n.to_string(), &Arc::new(s2));
                    }
                }
                "AlternateContent" => {
                    if let Some(ch) = c.child("Choice").or_else(|| c.child("Fallback")) {
                        // contenu de run alternatif (dessins)
                        for cc in ch.children().filter(|x| x.is_element()) {
                            match cc.local() {
                                "drawing" => self.parse_drawing(cc, part, &st, acc),
                                "pict" => self.parse_vml(cc, part, &st, acc),
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // ------------------------------------------------------------------------------
    // Dessins (DrawingML)
    // ------------------------------------------------------------------------------

    fn image_for(&self, part: &Part, rid: &str) -> Option<Arc<crate::display::RasterImage>> {
        let rel = part.rels.get(rid)?;
        if rel.external {
            return None;
        }
        self.pkg.image(&rel.target)
    }

    fn parse_drawing(&mut self, d: Node<'p, 'p>, part: &Part, st: &Arc<TextStyle>, acc: &mut ParaAcc) {
        for c in d.children().filter(|c| c.is_element()) {
            let inline = match c.local() {
                "inline" => true,
                "anchor" => false,
                _ => continue,
            };
            let ext = c.child("extent");
            let w = emu(ext.and_then(|e| e.attr("cx"))).unwrap_or(0.0);
            let h = emu(ext.and_then(|e| e.attr("cy"))).unwrap_or(0.0);
            let Some(gd) = c.path(&["graphic", "graphicData"]) else { continue };
            let items = self.graphic_items(gd, w, h, part);
            if inline {
                acc.cur().push(Inline::Object { width: w, height: h, items, style: st.clone() });
                continue;
            }
            // objet ancré
            let mut fl = Floating { width: w, height: h, items, behind: c.attr("behindDoc") == Some("1"), ..Default::default() };
            if let Some(ph) = c.child("positionH") {
                fl.rel_h = match ph.attr("relativeFrom").unwrap_or("column") {
                    "page" | "leftMargin" | "outsideMargin" | "insideMargin" | "rightMargin" => RelH::Page,
                    "margin" => RelH::Margin,
                    _ => RelH::Column,
                };
                if let Some(o) = ph.child("posOffset").and_then(|o| o.text()) {
                    fl.x = emu(Some(o)).unwrap_or(0.0);
                }
                if let Some(al) = ph.child("align").and_then(|a| a.text()) {
                    fl.align_h = Some(match al {
                        "center" => Align::Center,
                        "right" | "outside" => Align::Right,
                        _ => Align::Left,
                    });
                }
                if ph.attr("relativeFrom") == Some("rightMargin") && fl.align_h.is_none() {
                    // décalage par rapport à la marge droite : approximation page
                }
            }
            if let Some(pv) = c.child("positionV") {
                fl.rel_v = match pv.attr("relativeFrom").unwrap_or("paragraph") {
                    "page" | "topMargin" | "bottomMargin" => RelV::Page,
                    "margin" => RelV::Margin,
                    _ => RelV::Paragraph,
                };
                if let Some(o) = pv.child("posOffset").and_then(|o| o.text()) {
                    fl.y = emu(Some(o)).unwrap_or(0.0);
                }
                if let Some(al) = pv.child("align").and_then(|a| a.text()) {
                    fl.align_v = Some(match al {
                        "center" => VAlign::Center,
                        "bottom" | "outside" => VAlign::Bottom,
                        _ => VAlign::Top,
                    });
                }
            }
            if c.child("wrapTopAndBottom").is_some() && fl.rel_v == RelV::Paragraph {
                // objet en bloc : il repousse le texte
                let align = fl.align_h.unwrap_or(Align::Left);
                let ind = if fl.align_h.is_none() && fl.rel_h != RelH::Page { fl.x.max(0.0) } else { 0.0 };
                let props = ParaProps { align, ind_left: ind, space_before: fl.y.max(0.0), line: LineSpacing::Multiple(1.0), ..Default::default() };
                acc.block_objects.push(Block::Para(Paragraph { props, inlines: vec![Inline::Object { width: w, height: h, items: fl.items, style: st.clone() }], mark: st.clone() }));
            } else {
                acc.floats.push(fl);
            }
        }
    }

    fn graphic_items(&mut self, gd: Node<'p, 'p>, w: f32, h: f32, part: &Part) -> Vec<Item> {
        let mut items = Vec::new();
        for c in gd.children().filter(|c| c.is_element()) {
            match c.local() {
                "pic" => items.extend(self.picture(c, Rect::new(0.0, 0.0, w, h), part)),
                "wsp" => items.extend(self.wsp(c, Rect::new(0.0, 0.0, w, h), part)),
                "wgp" | "wpc" => items.extend(self.group(c, Rect::new(0.0, 0.0, w, h), part, true)),
                "chart" => {
                    if let Some(rid) = c.rid() {
                        if let Some(rel) = part.rels.get(rid) {
                            items.extend(super::chart::render_chart(self.pkg, &rel.target, Rect::new(0.0, 0.0, w, h), &self.theme));
                        }
                    }
                }
                "relIds" => {
                    // SmartArt : on utilise le dessin pré-calculé s'il existe
                    if let Some(dm) = c.attr("dm") {
                        items.extend(self.smartart(dm, part, w, h));
                    }
                }
                _ => {}
            }
        }
        items
    }

    fn smartart(&mut self, dm: &str, part: &Part, w: f32, h: f32) -> Vec<Item> {
        let Some(data_rel) = part.rels.get(dm) else { return Vec::new() };
        // le dessin est référencé par l'extension dataModelExt de la partie de données
        let data_xml = self.pkg.read_string(&data_rel.target).unwrap_or_default();
        let Some(doc) = parse_xml(&data_xml) else { return Vec::new() };
        let rid = doc.descendants().find(|n| n.local() == "dataModelExt").and_then(|n| n.attr("relId")).map(String::from);
        let Some(rid) = rid else { return Vec::new() };
        let Some(rel) = part.rels.get(&rid) else { return Vec::new() };
        super::pptx::render_drawing_part(self.pkg, &rel.target, &self.theme, Rect::new(0.0, 0.0, w, h))
    }

    fn picture(&self, pic: Node, r: Rect, part: &Part) -> Vec<Item> {
        let mut items = Vec::new();
        let blip_fill = pic.child("blipFill");
        let rid = blip_fill.and_then(|b| b.child("blip")).and_then(|b| b.attr("embed").or_else(|| b.attr("link")));
        let crop = dml::parse_src_rect(blip_fill.and_then(|b| b.child("srcRect")));
        match rid.and_then(|id| self.image_for(part, id)) {
            Some(img) => items.push(Item::Image { rect: r, image: img, crop, alpha: 1.0 }),
            None => items.push(Item::Placeholder { rect: r, label: "image".into() }),
        }
        if let Some(sp) = pic.child("spPr") {
            if let Some(ln) = sp.child("ln") {
                let ctx = ColorCtx::new(&self.theme);
                let mut l = LineDef::default();
                dml::merge_line(&mut l, ln, &ctx);
                if let (Some(s), Some(p)) = (l.stroke(), crate::display::rect_path(r)) {
                    items.push(Item::Path { path: Arc::new(p), fill: None, stroke: Some(s) });
                }
            }
        }
        items
    }

    fn wsp(&mut self, sp: Node<'p, 'p>, r: Rect, part: &Part) -> Vec<Item> {
        let ctx = ColorCtx::new(&self.theme);
        let mut items = Vec::new();
        let sppr = sp.child("spPr");
        // style de forme (références au thème)
        let style = sp.child("style");
        let mut fill: Option<Fill> = None;
        let mut line = LineDef::default();
        if let Some(s) = style {
            if let Some(fr) = s.child("fillRef") {
                if fr.attr("idx") != Some("0") {
                    fill = dml::child_color(fr, &ctx).map(Fill::Solid);
                }
            }
            if let Some(lr) = s.child("lnRef") {
                if lr.attr("idx") != Some("0") {
                    line.color = dml::child_color(lr, &ctx);
                    line.width = 0.75 * lr.attr("idx").and_then(|v| v.parse::<f32>().ok()).unwrap_or(1.0).max(1.0);
                }
            }
        }
        let mut geom = "rect".to_string();
        let mut adj = HashMap::new();
        let mut cust = None;
        if let Some(sppr) = sppr {
            if let Some(f) = dml::parse_fill(sppr, &ctx) {
                fill = Some(f);
            }
            if let Some(ln) = sppr.child("ln") {
                dml::merge_line(&mut line, ln, &ctx);
            }
            if let Some(pg) = sppr.child("prstGeom") {
                geom = pg.attr("prst").unwrap_or("rect").to_string();
                adj = dml::parse_adjust(pg);
            }
            cust = sppr.child("custGeom");
        }
        let path = match cust {
            Some(cg) => dml::custom_path(cg, r.w, r.h),
            None => dml::preset_path(&geom, r.w, r.h, &adj),
        }
        .and_then(|p| p.transform(Transform::from_translate(r.x, r.y)));
        if let Some(p) = path {
            let paint = if dml::is_open_shape(&geom) {
                None
            } else {
                fill.as_ref().and_then(|f| dml::fill_to_paint(f, r, &|rid| self.image_for(part, rid)))
            };
            let stroke = line.stroke();
            if paint.is_some() || stroke.is_some() {
                let heads = stroke.as_ref().map(|s| dml::arrow_heads(&p, &line, s.color)).unwrap_or_default();
                items.push(Item::Path { path: Arc::new(p), fill: paint, stroke });
                items.extend(heads);
            }
        }
        // zone de texte
        if let Some(tb) = sp.child("txbx").and_then(|t| t.child("txbxContent")) {
            let body_pr = sp.child("bodyPr");
            let ins = |a: &str, d: f32| emu(body_pr.and_then(|b| b.attr(a))).unwrap_or(d);
            let (l, t, rr, b) = (ins("lIns", 7.2), ins("tIns", 3.6), ins("rIns", 7.2), ins("bIns", 3.6));
            let mut blocks = Vec::new();
            let saved = std::mem::take(&mut self.fields);
            self.parse_blocks(tb, part, None, &mut blocks);
            self.fields = saved;
            let f = stack_blocks(&blocks, (r.w - l - rr).max(5.0), &LayoutCtx::default());
            let avail = r.h - t - b;
            let dy = match body_pr.and_then(|b| b.attr("anchor")) {
                Some("ctr") => ((avail - f.height) / 2.0).max(0.0),
                Some("b") => (avail - f.height).max(0.0),
                _ => 0.0,
            };
            items.push(Item::group(Transform::from_translate(r.x + l, r.y + t + dy), None, f.items));
        }
        // rotation
        let xfrm = sppr.and_then(|s| s.child("xfrm"));
        let rot = xfrm.and_then(|x| x.attr("rot")).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) / 60000.0;
        let flip_h = xfrm.and_then(|x| x.attr("flipH")) == Some("1");
        let flip_v = xfrm.and_then(|x| x.attr("flipV")) == Some("1");
        if rot != 0.0 || flip_h || flip_v {
            let t = dml::shape_transform(0.0, 0.0, r.w, r.h, rot, flip_h, flip_v).pre_translate(-r.x, -r.y).post_translate(r.x, r.y);
            return vec![Item::group(t, None, items)];
        }
        items
    }

    fn group(&mut self, g: Node<'p, 'p>, r: Rect, part: &Part, top: bool) -> Vec<Item> {
        // transformation enfant -> parent
        let gpr = g.child("grpSpPr");
        let xfrm = gpr.and_then(|x| x.child("xfrm"));
        let get = |n: Option<Node>, a: &str| emu(n.and_then(|n| n.attr(a)));
        let (off, ext, choff, chext) = (xfrm.and_then(|x| x.child("off")), xfrm.and_then(|x| x.child("ext")), xfrm.and_then(|x| x.child("chOff")), xfrm.and_then(|x| x.child("chExt")));
        let cw = get(chext, "cx").unwrap_or(r.w).max(0.01);
        let ch = get(chext, "cy").unwrap_or(r.h).max(0.01);
        let cx = get(choff, "x").unwrap_or(0.0);
        let cy = get(choff, "y").unwrap_or(0.0);
        let (ox, oy, ow, oh) = if top { (r.x, r.y, r.w, r.h) } else { (get(off, "x").unwrap_or(0.0), get(off, "y").unwrap_or(0.0), get(ext, "cx").unwrap_or(cw), get(ext, "cy").unwrap_or(ch)) };
        let t = Transform::from_translate(ox, oy).pre_scale(ow / cw, oh / ch).pre_translate(-cx, -cy);
        let mut items = Vec::new();
        for c in g.children().filter(|c| c.is_element()) {
            let cxfrm = c.descendants().find(|d| d.local() == "xfrm");
            let cr = Rect::new(
                get(cxfrm.and_then(|x| x.child("off")), "x").unwrap_or(0.0),
                get(cxfrm.and_then(|x| x.child("off")), "y").unwrap_or(0.0),
                get(cxfrm.and_then(|x| x.child("ext")), "cx").unwrap_or(0.0),
                get(cxfrm.and_then(|x| x.child("ext")), "cy").unwrap_or(0.0),
            );
            match c.local() {
                "wsp" => items.extend(self.wsp(c, cr, part)),
                "pic" => items.extend(self.picture(c, cr, part)),
                "grpSp" => items.extend(self.group(c, cr, part, false)),
                "graphicFrame" => {
                    if let Some(gd) = c.path(&["graphic", "graphicData"]) {
                        let inner = self.graphic_items(gd, cr.w, cr.h, part);
                        items.push(Item::group(Transform::from_translate(cr.x, cr.y), None, inner));
                    }
                }
                _ => {}
            }
        }
        vec![Item::group(t, None, items)]
    }

    // ------------------------------------------------------------------------------
    // VML (documents anciens)
    // ------------------------------------------------------------------------------

    fn parse_vml(&mut self, pict: Node<'p, 'p>, part: &Part, st: &Arc<TextStyle>, acc: &mut ParaAcc) {
        for shape in pict.children().filter(|c| c.is_element()) {
            let kind = shape.local();
            if !matches!(kind, "shape" | "rect" | "roundrect" | "oval" | "line" | "group" | "image") {
                continue;
            }
            let style = shape.attr("style").unwrap_or("");
            let css = parse_css(style);
            let len = |k: &str| css.get(k).and_then(|v| crate::package::parse_length(v));
            let w = len("width").unwrap_or(0.0);
            let h = len("height").unwrap_or(0.0);
            if css.get("visibility").map(|v| v == "hidden").unwrap_or(false) {
                continue;
            }
            // filigrane (WordArt) : ignoré
            if shape.child("textpath").is_some() {
                continue;
            }
            let mut items = Vec::new();
            let r = Rect::new(0.0, 0.0, w, h);
            let filled = shape.attr("filled").map(|v| !matches!(v, "f" | "false")).unwrap_or(kind != "shape" && kind != "line");
            let stroked = shape.attr("stroked").map(|v| !matches!(v, "f" | "false")).unwrap_or(kind != "shape");
            let fill = shape.attr("fillcolor").and_then(vml_color);
            if filled && kind != "line" {
                if let Some(f) = fill.or(if kind == "shape" { None } else { Some(Color::WHITE) }) {
                    items.push(Item::FillRect { rect: r, color: f });
                }
            }
            if let Some(img) = shape.child("imagedata").and_then(|i| i.attr("id").or_else(|| i.attr("relid"))).and_then(|id| self.image_for(part, id)) {
                items.push(Item::Image { rect: r, image: img, crop: [0.0; 4], alpha: 1.0 });
            } else if shape.child("imagedata").is_some() {
                items.push(Item::Placeholder { rect: r, label: "image".into() });
            }
            if let Some(tb) = shape.child("textbox").and_then(|t| t.child("txbxContent")) {
                let mut blocks = Vec::new();
                let saved = std::mem::take(&mut self.fields);
                self.parse_blocks(tb, part, None, &mut blocks);
                self.fields = saved;
                let f = stack_blocks(&blocks, (w - 14.4).max(5.0), &LayoutCtx::default());
                items.push(Item::group(Transform::from_translate(7.2, 3.6), None, f.items));
            }
            if stroked && kind != "shape" {
                let c = shape.attr("strokecolor").and_then(vml_color).unwrap_or(Color::BLACK);
                let sw = shape.attr("strokeweight").and_then(crate::package::parse_length).unwrap_or(0.75);
                if let Some(p) = crate::display::rect_path(r) {
                    items.push(Item::Path { path: Arc::new(p), fill: None, stroke: Some(crate::display::StrokeStyle::new(c, sw)) });
                }
            }
            if items.is_empty() {
                continue;
            }
            let absolute = css.get("position").map(|p| p == "absolute").unwrap_or(false);
            if !absolute {
                acc.cur().push(Inline::Object { width: w, height: h, items, style: st.clone() });
            } else {
                let rel_h = match css.get("mso-position-horizontal-relative").map(|s| s.as_str()) {
                    Some("page") => RelH::Page,
                    Some("margin") => RelH::Margin,
                    _ => RelH::Column,
                };
                let rel_v = match css.get("mso-position-vertical-relative").map(|s| s.as_str()) {
                    Some("page") => RelV::Page,
                    Some("margin") => RelV::Margin,
                    _ => RelV::Paragraph,
                };
                let align_h = css.get("mso-position-horizontal").and_then(|v| match v.as_str() {
                    "center" => Some(Align::Center),
                    "right" => Some(Align::Right),
                    "left" => Some(Align::Left),
                    _ => None,
                });
                let behind = css.get("z-index").and_then(|z| z.parse::<i64>().ok()).map(|z| z < 0).unwrap_or(false);
                acc.floats.push(Floating { width: w, height: h, items, rel_h, x: len("margin-left").or(len("left")).unwrap_or(0.0), align_h, rel_v, y: len("margin-top").or(len("top")).unwrap_or(0.0), align_v: None, behind });
            }
        }
    }

    // ------------------------------------------------------------------------------
    // Tableaux
    // ------------------------------------------------------------------------------

    fn parse_table(&mut self, tbl: Node<'p, 'p>, part: &Part) -> Table {
        let tpr = tbl.child("tblPr");
        let style_id = tpr.and_then(|t| t.child("tblStyle")).and_then(|s| s.attr("val")).map(String::from).or_else(|| self.styles.default_table.clone());
        let ts = style_id.as_deref().map(|s| self.styles.table(s)).unwrap_or_default();
        let mut borders = ts.borders.clone();
        let mut margins = ts.margins;
        if let Some(tp) = tpr {
            if let Some(b) = tp.child("tblBorders") {
                let bb = self.parse_tbl_borders(b);
                for i in 0..6 {
                    if bb[i].is_some() {
                        borders[i] = bb[i].clone();
                    }
                }
            }
            if let Some(m) = tp.child("tblCellMar") {
                let mm = self.parse_margins(m);
                for i in 0..4 {
                    if mm[i].is_some() {
                        margins[i] = mm[i];
                    }
                }
            }
        }
        let look = tpr.and_then(|t| t.child("tblLook"));
        let look_bit = |attr: &str, bit: u32, default: bool| -> bool {
            match look {
                None => default,
                Some(l) => match l.attr(attr) {
                    Some(v) => v == "1" || v == "true",
                    None => l.attr("val").and_then(|v| u32::from_str_radix(v, 16).ok()).map(|v| v & bit != 0).unwrap_or(default),
                },
            }
        };
        let first_row = look_bit("firstRow", 0x20, true);
        let last_row = look_bit("lastRow", 0x40, false);
        let first_col = look_bit("firstColumn", 0x80, true);
        let last_col = look_bit("lastColumn", 0x100, false);
        let no_hband = look_bit("noHBand", 0x200, false);
        let no_vband = look_bit("noVBand", 0x400, true);

        let mut t = Table {
            col_widths: tbl.child("tblGrid").map(|g| g.children_named("gridCol").map(|c| twips(c.attr("w")).unwrap_or(0.0)).collect()).unwrap_or_default(),
            indent: tpr.and_then(|t| t.child("tblInd")).and_then(|i| twips(i.attr("w"))).unwrap_or(0.0),
            align: match tpr.and_then(|t| t.child("jc")).and_then(|j| j.attr("val")) {
                Some("center") => Align::Center,
                Some("right") | Some("end") => Align::Right,
                _ => Align::Left,
            },
            cell_margins: [margins[0].unwrap_or(0.0), margins[1].unwrap_or(5.4), margins[2].unwrap_or(0.0), margins[3].unwrap_or(5.4)],
            rows: Vec::new(),
        };
        // Les marges gauches de cellule décalent le tableau dans Word.
        t.indent -= t.cell_margins[3] * 0.0;

        // lignes (éventuellement enveloppées dans des sdt)
        let mut tr_nodes = Vec::new();
        collect_named(tbl, "tr", &mut tr_nodes);
        let nrows = tr_nodes.len();
        let mut header_rows = 0usize;
        for (ri, tr) in tr_nodes.iter().enumerate() {
            let trpr = tr.child("trPr");
            let mut row = TableRow::default();
            if let Some(tp) = trpr {
                if let Some(hn) = tp.child("trHeight") {
                    row.height = twips(hn.attr("val")).unwrap_or(0.0);
                    row.exact = hn.attr("hRule") == Some("exact");
                }
                row.header = tp.child("tblHeader").map(on_off).unwrap_or(false);
                row.cant_split = tp.child("cantSplit").map(on_off).unwrap_or(false);
                row.grid_before = tp.child("gridBefore").and_then(|g| g.attr("val")).and_then(|v| v.parse().ok()).unwrap_or(0);
            }
            if row.header && ri == header_rows {
                header_rows += 1;
            }
            let mut tc_nodes = Vec::new();
            collect_named(*tr, "tc", &mut tc_nodes);
            let ncells = tc_nodes.len();
            let mut col = row.grid_before;
            let total_cols = t.col_widths.len();
            for (ci, tc) in tc_nodes.iter().enumerate() {
                let tcpr = tc.child("tcPr");
                let span: usize = tcpr.and_then(|p| p.child("gridSpan")).and_then(|g| g.attr("val")).and_then(|v| v.parse().ok()).unwrap_or(1);
                let vmerge = match tcpr.and_then(|p| p.child("vMerge")) {
                    None => VMerge::None,
                    Some(v) => match v.attr("val") {
                        Some("restart") => VMerge::Restart,
                        _ => VMerge::Continue,
                    },
                };
                // mise en forme conditionnelle
                let band_row = ri.saturating_sub(if first_row { 1.max(header_rows) } else { 0 });
                let mut conds: Vec<&str> = vec!["wholeTable"];
                if !no_vband && !(first_col && col == 0) {
                    let bc = if first_col { col.saturating_sub(1) } else { col };
                    conds.push(if bc % 2 == 0 { "band1Vert" } else { "band2Vert" });
                }
                let is_first_row = first_row && (ri == 0 || ri < header_rows);
                let is_last_row = last_row && ri + 1 == nrows;
                if !no_hband && !is_first_row && !is_last_row {
                    conds.push(if band_row % 2 == 0 { "band1Horz" } else { "band2Horz" });
                }
                if first_col && col == 0 {
                    conds.push("firstCol");
                }
                if last_col && col + span >= total_cols {
                    conds.push("lastCol");
                }
                if is_first_row {
                    conds.push("firstRow");
                }
                if is_last_row {
                    conds.push("lastRow");
                }
                if is_first_row && first_col && col == 0 {
                    conds.push("nwCell");
                }
                if is_first_row && last_col && col + span >= total_cols {
                    conds.push("neCell");
                }
                let mut tctx = TableCtx { rpr: ts.rpr.clone(), ppr: ts.ppr.clone() };
                let mut shading = ts.shading;
                let mut cb: [B<BorderLine>; 4] = [
                    if ri == 0 { borders[0].clone() } else { borders[4].clone() },
                    if ci + 1 == ncells { borders[3].clone() } else { borders[5].clone() },
                    if ri + 1 == nrows { borders[2].clone() } else { borders[4].clone() },
                    if ci == 0 { borders[1].clone() } else { borders[5].clone() },
                ];
                for cn in &conds {
                    if let Some(cf) = ts.conds.get(*cn) {
                        tctx.rpr.merge(&cf.rpr);
                        tctx.ppr.merge(&cf.ppr);
                        if cf.shading.is_some() {
                            shading = cf.shading;
                        }
                        // haut, gauche, bas, droite, intH, intV -> haut, droite, bas, gauche
                        let map = [(0usize, 0usize), (3, 1), (2, 2), (1, 3)];
                        for (dst, src) in map {
                            if cf.borders[src].is_some() {
                                cb[dst] = cf.borders[src].clone();
                            }
                        }
                        if cf.borders[4].is_some() {
                            if ri > 0 && *cn != "firstRow" {
                                cb[0] = cf.borders[4].clone();
                            }
                            if ri + 1 < nrows && *cn != "lastRow" {
                                cb[2] = cf.borders[4].clone();
                            }
                        }
                        if cf.borders[5].is_some() {
                            if ci > 0 {
                                cb[3] = cf.borders[5].clone();
                            }
                            if ci + 1 < ncells {
                                cb[1] = cf.borders[5].clone();
                            }
                        }
                    }
                }
                let mut cell = TableCell { span, vmerge, rowspan: 1, ..Default::default() };
                if let Some(p) = tcpr {
                    if let Some(shd) = p.child("shd") {
                        shading = self.shading(shd);
                    }
                    if let Some(b) = p.child("tcBorders") {
                        for e in b.children().filter(|e| e.is_element()) {
                            let i = match e.local() {
                                "top" => 0,
                                "right" | "end" => 1,
                                "bottom" => 2,
                                "left" | "start" => 3,
                                _ => continue,
                            };
                            cb[i] = self.border(e);
                        }
                    }
                    if let Some(m) = p.child("tcMar") {
                        let mm = self.parse_margins(m);
                        let mut base = t.cell_margins;
                        for i in 0..4 {
                            if let Some(v) = mm[i] {
                                base[i] = v;
                            }
                        }
                        cell.margins = Some(base);
                    }
                    cell.valign = match p.child("vAlign").and_then(|v| v.attr("val")) {
                        Some("center") => VAlign::Center,
                        Some("bottom") => VAlign::Bottom,
                        _ => VAlign::Top,
                    };
                }
                cell.fill = shading.flatten();
                cell.borders = [cb[0].clone().flatten(), cb[1].clone().flatten(), cb[2].clone().flatten(), cb[3].clone().flatten()];
                let mut blocks = Vec::new();
                self.parse_blocks(*tc, part, Some(&tctx), &mut blocks);
                cell.blocks = blocks;
                row.cells.push(cell);
                col += span;
            }
            t.rows.push(row);
        }
        // fusion verticale : les bordures basses viennent de la dernière cellule fusionnée
        if t.col_widths.is_empty() {
            let maxc = t.rows.iter().map(|r| r.cells.iter().map(|c| c.span).sum::<usize>() + r.grid_before).max().unwrap_or(1);
            t.col_widths = vec![450.0 / maxc as f32; maxc];
        }
        t
    }

    // ------------------------------------------------------------------------------
    // Sections
    // ------------------------------------------------------------------------------

    fn parse_hf(&mut self, rid: &str, part: &Part) -> Option<Vec<Block>> {
        let rel = part.rels.get(rid)?;
        let doc: &'p roxmltree::Document<'p> = *self.parts.get(&rel.target)?;
        let hp = Part { rels: self.pkg.rels(&rel.target) };
        let mut blocks = Vec::new();
        let saved = std::mem::take(&mut self.fields);
        self.parse_blocks(doc.root_element(), &hp, None, &mut blocks);
        self.fields = saved;
        Some(blocks)
    }

    fn section_from(&mut self, sp: Option<Node<'p, 'p>>, part: &Part, prev: Option<&Section>) -> Section {
        let mut s = Section::default();
        if let Some(p) = prev {
            s.header = p.header.clone();
            s.footer = p.footer.clone();
            s.setup = p.setup.clone();
        }
        let Some(sp) = sp else { return s };
        if let Some(sz) = sp.child("pgSz") {
            if let Some(w) = twips(sz.attr("w")) {
                s.setup.width = w;
            }
            if let Some(h) = twips(sz.attr("h")) {
                s.setup.height = h;
            }
        }
        if let Some(m) = sp.child("pgMar") {
            let g = |a: &str, d: f32| twips(m.attr(a)).unwrap_or(d);
            s.setup.margin_top = g("top", s.setup.margin_top).abs();
            s.setup.margin_bottom = g("bottom", s.setup.margin_bottom).abs();
            s.setup.margin_left = g("left", s.setup.margin_left) + g("gutter", 0.0);
            s.setup.margin_right = g("right", s.setup.margin_right);
            s.setup.header_dist = g("header", s.setup.header_dist);
            s.setup.footer_dist = g("footer", s.setup.footer_dist);
        }
        s.setup.columns = 1;
        if let Some(c) = sp.child("cols") {
            s.setup.columns = c.attr("num").and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
            s.setup.col_gap = twips(c.attr("space")).unwrap_or(36.0);
        }
        s.title_page = sp.child("titlePg").map(on_off).unwrap_or(false);
        s.continuous = matches!(sp.child("type").and_then(|t| t.attr("val")), Some("continuous") | Some("nextColumn"));
        s.page_number_start = sp.child("pgNumType").and_then(|p| p.attr("start")).and_then(|v| v.parse().ok());
        for r in sp.children().filter(|c| c.is_element()) {
            let is_header = match r.local() {
                "headerReference" => true,
                "footerReference" => false,
                _ => continue,
            };
            let Some(rid) = r.rid() else { continue };
            let blocks = self.parse_hf(rid, part);
            let hf = if is_header { &mut s.header } else { &mut s.footer };
            match r.attr("type").unwrap_or("default") {
                "first" => hf.first = blocks,
                "even" => hf.even = blocks,
                _ => hf.default = blocks,
            }
        }
        s
    }
}

fn collect_named<'a, 'i>(n: Node<'a, 'i>, name: &str, out: &mut Vec<Node<'a, 'i>>) {
    for c in n.children().filter(|c| c.is_element()) {
        if c.local() == name {
            out.push(c);
        } else if matches!(c.local(), "sdt" | "sdtContent" | "customXml" | "ins" | "moveTo") {
            collect_named(c, name, out);
        }
    }
}

fn field_kind(instr: &str) -> Option<Field> {
    let first = instr.split_whitespace().next().unwrap_or("");
    match first {
        "PAGE" => Some(Field::PageNumber),
        "NUMPAGES" | "SECTIONPAGES" => Some(Field::PageCount),
        _ => None,
    }
}

fn parse_css(s: &str) -> HashMap<String, String> {
    s.split(';')
        .filter_map(|kv| {
            let mut it = kv.splitn(2, ':');
            Some((it.next()?.trim().to_ascii_lowercase(), it.next()?.trim().to_string()))
        })
        .collect()
}

fn vml_color(v: &str) -> Option<Color> {
    let v = v.split_whitespace().next()?;
    Color::from_hex(v).or_else(|| crate::color::named_color(v))
}

fn main_part(pkg: &Package, fallback: &str) -> String {
    pkg.rels("").values().find(|r| r.kind == "officeDocument").map(|r| r.target.clone()).unwrap_or_else(|| fallback.to_string())
}

pub fn load(pkg: &Package) -> Result<FlowDoc, String> {
    let main = main_part(pkg, "word/document.xml");
    let rels = pkg.rels(&main);
    // Toutes les parties XML utiles sont lues et analysées une seule fois.
    let mut names: Vec<String> = vec![main.clone()];
    for r in rels.values() {
        if matches!(r.kind.as_str(), "header" | "footer" | "footnotes" | "endnotes") && !names.contains(&r.target) {
            names.push(r.target.clone());
        }
    }
    let texts: Vec<String> = names.iter().map(|n| pkg.read_string(n).unwrap_or_default()).collect();
    let docs: Vec<Option<roxmltree::Document>> = texts.iter().map(|t| if t.is_empty() { None } else { parse_xml(t) }).collect();
    let mut parts: HashMap<String, &roxmltree::Document> = HashMap::new();
    for (n, d) in names.iter().zip(docs.iter()) {
        if let Some(d) = d {
            parts.insert(n.clone(), d);
        }
    }
    load_with(pkg, &main, rels, parts)
}

fn load_with<'p>(pkg: &'p Package, main: &str, rels: HashMap<String, Rel>, parts: HashMap<String, &'p roxmltree::Document<'p>>) -> Result<FlowDoc, String> {
    let theme = rels.values().find(|r| r.kind == "theme").map(|r| Theme::load(pkg, &r.target)).unwrap_or_default();
    let mut cx = Ctx {
        pkg,
        theme,
        styles: Styles::default(),
        numbering: Numbering::default(),
        default_tab: 36.0,
        counters: HashMap::new(),
        started: HashMap::new(),
        overrides_applied: HashSet::new(),
        fields: Vec::new(),
        footnotes: HashMap::new(),
        footnote_order: Vec::new(),
        current_note: None,
        notes_seen: 0,
        parts,
    };
    if let Some(r) = rels.values().find(|r| r.kind == "styles") {
        if let Some(xml) = pkg.read_string(&r.target) {
            cx.load_styles(&xml);
        }
    }
    if let Some(r) = rels.values().find(|r| r.kind == "numbering") {
        if let Some(xml) = pkg.read_string(&r.target) {
            cx.load_numbering(&xml);
        }
    }
    let mut even_odd = false;
    let mut background = None;
    if let Some(r) = rels.values().find(|r| r.kind == "settings") {
        if let Some(xml) = pkg.read_string(&r.target) {
            if let Some(doc) = parse_xml(&xml) {
                let root = doc.root_element();
                if let Some(v) = root.child("defaultTabStop").and_then(|d| twips(d.attr("val"))) {
                    if v > 1.0 {
                        cx.default_tab = v;
                    }
                }
                even_odd = root.child("evenAndOddHeaders").map(on_off).unwrap_or(false);
            }
        }
    }
    let doc: &'p roxmltree::Document<'p> = *cx.parts.get(main).ok_or("document.xml introuvable ou invalide")?;
    let root = doc.root_element();
    if let Some(bg) = root.child("background").and_then(|b| b.attr("color")).and_then(Color::from_hex) {
        background = Some(bg);
    }
    // notes de bas de page et de fin
    let mut note_rels: HashMap<String, Part> = HashMap::new();
    for (prefix, kind) in [("f", "footnotes"), ("e", "endnotes")] {
        let Some(r) = rels.values().find(|r| r.kind == kind) else { continue };
        let Some(d) = cx.parts.get(&r.target).copied() else { continue };
        let prels = Part { rels: pkg.rels(&r.target) };
        for n in d.root_element().children().filter(|n| n.is_element()) {
            if let Some(id) = n.attr("id") {
                let key = format!("{prefix}{id}");
                note_rels.insert(key.clone(), prels.clone());
                cx.footnotes.insert(key, n);
            }
        }
    }

    let body = root.child("body").ok_or("corps du document absent")?;
    let part = Part { rels };
    let mut sections: Vec<Section> = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    let children: Vec<Node> = body.children().filter(|c| c.is_element()).collect();
    for c in children {
        match c.local() {
            "sectPr" => {}
            "p" => {
                cx.parse_paragraph(c, &part, None, &mut blocks);
                if let Some(sp) = c.child("pPr").and_then(|p| p.child("sectPr")) {
                    let mut s = cx.section_from(Some(sp), &part, sections.last());
                    s.blocks = std::mem::take(&mut blocks);
                    sections.push(s);
                }
            }
            _ => {
                let mut tmp = Vec::new();
                cx.parse_blocks_single(c, &part, &mut tmp);
                blocks.extend(tmp);
            }
        }
    }
    let last = cx.section_from(body.child("sectPr"), &part, sections.last());
    let mut last = last;
    last.blocks = blocks;
    sections.push(last);
    // Dans Word, le type de saut (continu...) d'une section décrit son propre début.
    // notes en fin de document
    if !cx.footnote_order.is_empty() {
        let order = std::mem::take(&mut cx.footnote_order);
        let mut note_blocks = Vec::new();
        let sep = Paragraph {
            props: ParaProps { space_before: 12.0, borders: [Some(BorderLine::solid(0.5, Color::rgb(120, 120, 120))), None, None, None], ind_right: 300.0, ..Default::default() },
            inlines: vec![],
            mark: Arc::new(TextStyle { size: 4.0, ..Default::default() }),
        };
        note_blocks.push(Block::Para(sep));
        for (n, key) in order {
            if let Some(node) = cx.footnotes.get(&key).copied() {
                cx.current_note = Some(n);
                let p = note_rels.get(&key).cloned().unwrap_or(Part { rels: HashMap::new() });
                cx.parse_blocks(node, &p, None, &mut note_blocks);
            }
        }
        cx.current_note = None;
        if let Some(s) = sections.last_mut() {
            s.blocks.extend(note_blocks);
        }
    }
    Ok(FlowDoc { sections, background, even_and_odd_headers: even_odd })
}

impl<'p> Ctx<'p> {
    fn parse_blocks_single(&mut self, c: Node<'p, 'p>, part: &Part, out: &mut Vec<Block>) {
        match c.local() {
            "tbl" => {
                let t = self.parse_table(c, part);
                out.push(Block::Table(t));
            }
            "sdt" | "customXml" | "ins" | "moveTo" => {
                let inner = if c.local() == "sdt" { c.child("sdtContent") } else { Some(c) };
                if let Some(sc) = inner {
                    self.parse_blocks(sc, part, None, out);
                }
            }
            _ => {}
        }
    }
}

#[allow(dead_code)]
fn unused(_: Paint) {}
