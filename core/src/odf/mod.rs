//! Formats OpenDocument (LibreOffice / OpenOffice) : styles communs.

pub mod odp;
pub mod ods;
pub mod odt;

use crate::color::Color;
use crate::display::DashStyle;
use crate::package::{parse_length, parse_xml, NodeExt, Package};
use crate::text::*;
use roxmltree::{Document, Node};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

pub type Props = HashMap<String, String>;

#[derive(Clone, Default, Debug)]
pub struct StyleDef {
    pub parent: Option<String>,
    pub para: Props,
    pub text: Props,
    pub cell: Props,
    pub column: Props,
    pub row: Props,
    pub table: Props,
    pub graphic: Props,
    pub page: Props,
    pub attrs: Props,
    /// Style de liste incorporé (styles de présentation).
    pub list_style: Option<String>,
    pub tab_stops: Vec<TabStop>,
}

impl StyleDef {
    fn merge(&mut self, o: &StyleDef) {
        // couleur explicite et « couleur automatique » s'excluent : le style le plus précis gagne
        if o.text.contains_key("color") && !o.text.contains_key("use-window-font-color") {
            self.text.remove("use-window-font-color");
        }
        if o.text.get("use-window-font-color").map(|v| v == "true").unwrap_or(false) && !o.text.contains_key("color") {
            self.text.remove("color");
        }
        for (dst, src) in [(&mut self.para, &o.para), (&mut self.text, &o.text), (&mut self.cell, &o.cell), (&mut self.column, &o.column), (&mut self.row, &o.row), (&mut self.table, &o.table), (&mut self.graphic, &o.graphic), (&mut self.page, &o.page), (&mut self.attrs, &o.attrs)] {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        if o.list_style.is_some() {
            self.list_style = o.list_style.clone();
        }
        if !o.tab_stops.is_empty() {
            self.tab_stops = o.tab_stops.clone();
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ListLevel {
    pub bullet: Option<String>,
    pub num_format: Option<String>,
    pub prefix: String,
    pub suffix: String,
    pub start: i32,
    pub display_levels: usize,
    pub margin_left: f32,
    pub text_indent: f32,
    pub tab_pos: Option<f32>,
    pub text: Props,
    pub image: bool,
}

pub struct Styles {
    pub map: HashMap<(String, String), StyleDef>,
    pub defaults: HashMap<String, StyleDef>,
    pub fonts: HashMap<String, String>,
    pub lists: HashMap<String, Vec<ListLevel>>,
    pub page_layouts: HashMap<String, StyleDef>,
    pub masters: Vec<(String, String)>, // (nom, mise en page)
    pub gradients: HashMap<String, Props>,
    pub fill_images: HashMap<String, String>,
    pub outline: Vec<ListLevel>,
    cache: RefCell<HashMap<(String, String), Arc<StyleDef>>>,
}

fn props_of(n: Node) -> Props {
    n.attributes().map(|a| (a.name().to_string(), a.value().to_string())).collect()
}

impl Styles {
    pub fn new() -> Styles {
        Styles { map: HashMap::new(), defaults: HashMap::new(), fonts: HashMap::new(), lists: HashMap::new(), page_layouts: HashMap::new(), masters: Vec::new(), gradients: HashMap::new(), fill_images: HashMap::new(), outline: Vec::new(), cache: RefCell::new(HashMap::new()) }
    }

    fn style_def(n: Node) -> StyleDef {
        let mut d = StyleDef { parent: n.attr("parent-style-name").map(String::from), attrs: props_of(n), ..Default::default() };
        for c in n.children().filter(|c| c.is_element()) {
            match c.local() {
                "paragraph-properties" => {
                    d.para.extend(props_of(c));
                    if let Some(ts) = c.child("tab-stops") {
                        for t in ts.children_named("tab-stop") {
                            let pos = t.attr("position").and_then(parse_length).unwrap_or(0.0);
                            let kind = match t.attr("type") {
                                Some("center") => TabKind::Center,
                                Some("right") => TabKind::Right,
                                Some("char") => TabKind::Decimal,
                                _ => TabKind::Left,
                            };
                            let leader = t.attr("leader-text").and_then(|s| s.chars().next()).filter(|c| *c != ' ').or_else(|| match t.attr("leader-style") {
                                Some("dotted") => Some('.'),
                                Some("solid") => Some('_'),
                                Some("dash") => Some('-'),
                                _ => None,
                            });
                            d.tab_stops.push(TabStop { pos, kind, leader });
                        }
                    }
                }
                "text-properties" => d.text.extend(props_of(c)),
                "table-cell-properties" => d.cell.extend(props_of(c)),
                "table-column-properties" => d.column.extend(props_of(c)),
                "table-row-properties" => d.row.extend(props_of(c)),
                "table-properties" => d.table.extend(props_of(c)),
                "graphic-properties" => {
                    d.graphic.extend(props_of(c));
                    if let Some(ls) = c.child("list-style") {
                        d.list_style = Some(format!("\u{1}{}", ls.range().start));
                    }
                }
                "drawing-page-properties" => d.page.extend(props_of(c)),
                "page-layout-properties" => d.page.extend(props_of(c)),
                "header-style" => {
                    if let Some(h) = c.child("header-footer-properties") {
                        for (k, v) in props_of(h) {
                            d.attrs.insert(format!("header-{k}"), v);
                        }
                    }
                }
                "footer-style" => {
                    if let Some(h) = c.child("header-footer-properties") {
                        for (k, v) in props_of(h) {
                            d.attrs.insert(format!("footer-{k}"), v);
                        }
                    }
                }
                _ => {}
            }
        }
        d
    }

    pub fn parse_list(n: Node) -> Vec<ListLevel> {
        let mut levels = vec![ListLevel { start: 1, display_levels: 1, ..Default::default() }; 10];
        for l in n.children().filter(|c| c.is_element()) {
            let lvl: usize = l.attr("level").and_then(|v| v.parse().ok()).unwrap_or(1);
            if lvl == 0 || lvl > 10 {
                continue;
            }
            let mut ll = ListLevel { start: 1, display_levels: 1, ..Default::default() };
            match l.local() {
                "list-level-style-bullet" => {
                    ll.bullet = Some(l.attr("bullet-char").unwrap_or("•").to_string());
                }
                "list-level-style-number" | "outline-level-style" => {
                    ll.num_format = l.attr("num-format").map(String::from);
                    ll.start = l.attr("start-value").and_then(|v| v.parse().ok()).unwrap_or(1);
                    ll.display_levels = l.attr("display-levels").and_then(|v| v.parse().ok()).unwrap_or(1);
                }
                "list-level-style-image" => ll.image = true,
                _ => continue,
            }
            ll.prefix = l.attr("num-prefix").unwrap_or("").to_string();
            ll.suffix = l.attr("num-suffix").unwrap_or("").to_string();
            if let Some(p) = l.child("list-level-properties") {
                if let Some(la) = p.child("list-level-label-alignment") {
                    ll.margin_left = la.attr("margin-left").and_then(parse_length).unwrap_or(0.0);
                    ll.text_indent = la.attr("text-indent").and_then(parse_length).unwrap_or(0.0);
                    ll.tab_pos = la.attr("list-tab-stop-position").and_then(parse_length);
                } else {
                    let sb = p.attr("space-before").and_then(parse_length).unwrap_or(0.0);
                    let mw = p.attr("min-label-width").and_then(parse_length).unwrap_or(0.0);
                    ll.margin_left = sb + mw;
                    ll.text_indent = -mw;
                }
            }
            if let Some(t) = l.child("text-properties") {
                ll.text = props_of(t);
            }
            levels[lvl - 1] = ll;
        }
        levels
    }

    /// Charge les styles d'un document XML (styles.xml ou content.xml).
    pub fn load(&mut self, doc: &Document) {
        let root = doc.root_element();
        for section in root.children().filter(|c| c.is_element()) {
            match section.local() {
                "font-face-decls" => {
                    for f in section.children_named("font-face") {
                        if let (Some(n), Some(fam)) = (f.attr("name"), f.attr("font-family")) {
                            self.fonts.insert(n.to_string(), fam.trim_matches('\'').trim_matches('"').to_string());
                        }
                    }
                }
                "styles" | "automatic-styles" => {
                    for s in section.children().filter(|c| c.is_element()) {
                        match s.local() {
                            "style" => {
                                let fam = s.attr("family").unwrap_or("paragraph").to_string();
                                let name = s.attr("name").unwrap_or("").to_string();
                                let mut def = Self::style_def(s);
                                // style de liste intégré (présentations)
                                if let Some(ls) = s.descendants().find(|d| d.local() == "list-style") {
                                    let key = format!("\u{1}{fam}:{name}");
                                    self.lists.insert(key.clone(), Self::parse_list(ls));
                                    def.list_style = Some(key);
                                }
                                self.map.insert((fam, name), def);
                            }
                            "default-style" => {
                                let fam = s.attr("family").unwrap_or("paragraph").to_string();
                                self.defaults.insert(fam, Self::style_def(s));
                            }
                            "list-style" => {
                                if let Some(n) = s.attr("name") {
                                    self.lists.insert(n.to_string(), Self::parse_list(s));
                                }
                            }
                            "outline-style" => self.outline = Self::parse_list(s),
                            "page-layout" => {
                                if let Some(n) = s.attr("name") {
                                    self.page_layouts.insert(n.to_string(), Self::style_def(s));
                                }
                            }
                            "linear-gradient" | "radial-gradient" | "gradient" => {
                                if let Some(n) = s.attr("name") {
                                    let mut p = props_of(s);
                                    p.insert("kind".into(), s.local().to_string());
                                    // gradients ODF 1.3 : premier et dernier arrêt
                                    let stops: Vec<Node> = s.descendants().filter(|d| d.local() == "gradient-stop").collect();
                                    if let (Some(a), Some(b)) = (stops.first(), stops.last()) {
                                        if let Some(c) = a.attr("color-value") {
                                            p.entry("start-color".into()).or_insert_with(|| c.to_string());
                                        }
                                        if let Some(c) = b.attr("color-value") {
                                            p.entry("end-color".into()).or_insert_with(|| c.to_string());
                                        }
                                    }
                                    self.gradients.insert(n.to_string(), p);
                                }
                            }
                            "fill-image" => {
                                if let (Some(n), Some(h)) = (s.attr("name"), s.attr("href")) {
                                    self.fill_images.insert(n.to_string(), h.to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "master-styles" => {
                    for m in section.children_named("master-page") {
                        self.masters.push((m.attr("name").unwrap_or("").to_string(), m.attr("page-layout-name").unwrap_or("").to_string()));
                    }
                }
                _ => {}
            }
        }
        self.cache.borrow_mut().clear();
    }

    /// Style effectif (style par défaut + chaîne d'héritage).
    pub fn get(&self, family: &str, name: Option<&str>) -> Arc<StyleDef> {
        let key = (family.to_string(), name.unwrap_or("").to_string());
        if let Some(v) = self.cache.borrow().get(&key) {
            return v.clone();
        }
        let mut chain = Vec::new();
        let mut cur = name.map(String::from);
        let mut guard = 0;
        while let Some(n) = cur {
            guard += 1;
            if guard > 30 {
                break;
            }
            match self.map.get(&(family.to_string(), n.clone())) {
                Some(s) => {
                    chain.push(s);
                    cur = s.parent.clone();
                }
                None => break,
            }
        }
        let mut out = self.defaults.get(family).cloned().unwrap_or_default();
        for s in chain.iter().rev() {
            out.merge(s);
        }
        if let Some(n) = name {
            if let Some(s) = self.map.get(&(family.to_string(), n.to_string())) {
                out.parent = s.parent.clone();
            }
        }
        let arc = Arc::new(out);
        self.cache.borrow_mut().insert(key, arc.clone());
        arc
    }

    pub fn font_family(&self, props: &Props) -> Option<String> {
        if let Some(n) = props.get("font-name") {
            return Some(self.fonts.get(n).cloned().unwrap_or_else(|| n.clone()));
        }
        props.get("font-family").map(|f| f.trim_matches('\'').trim_matches('"').to_string())
    }

    /// Applique des propriétés de texte ODF à un style de texte.
    pub fn apply_text(&self, base: &TextStyle, p: &Props) -> TextStyle {
        let mut st = base.clone();
        if let Some(f) = self.font_family(p) {
            st.font = Arc::from(f.as_str());
        }
        if let Some(sz) = p.get("font-size") {
            if let Some(pct) = sz.strip_suffix('%') {
                if let Ok(v) = pct.parse::<f32>() {
                    st.size *= v / 100.0;
                }
            } else if let Some(v) = parse_length(sz) {
                st.size = v;
            }
        }
        if let Some(w) = p.get("font-weight") {
            st.bold = w == "bold" || w.parse::<u32>().map(|v| v >= 600).unwrap_or(false);
        }
        if let Some(s) = p.get("font-style") {
            st.italic = s == "italic" || s == "oblique";
        }
        if p.get("use-window-font-color").map(|v| v == "true").unwrap_or(false) && !p.contains_key("color") {
            st.color = Color::BLACK;
        }
        if let Some(c) = p.get("color").and_then(|c| Color::from_hex(c)) {
            st.color = c;
        }
        if let Some(u) = p.get("text-underline-style") {
            st.underline = u != "none";
            st.double_underline = p.get("text-underline-type").map(|t| t == "double").unwrap_or(false);
        }
        if let Some(u) = p.get("text-line-through-style") {
            st.strike = u != "none";
        }
        if let Some(pos) = p.get("text-position") {
            let first = pos.split_whitespace().next().unwrap_or("0%");
            st.vert = if first == "super" || first.trim_end_matches('%').parse::<f32>().map(|v| v > 0.0).unwrap_or(false) {
                VertAlign::Super
            } else if first == "sub" || first.trim_end_matches('%').parse::<f32>().map(|v| v < 0.0).unwrap_or(false) {
                VertAlign::Sub
            } else {
                VertAlign::Baseline
            };
        }
        if let Some(bg) = p.get("background-color") {
            st.highlight = Color::from_hex(bg);
        }
        if let Some(t) = p.get("text-transform") {
            st.caps = t == "uppercase";
        }
        if let Some(v) = p.get("font-variant") {
            st.small_caps = v == "small-caps";
        }
        if let Some(ls) = p.get("letter-spacing").and_then(|v| parse_length(v)) {
            st.spacing = ls;
        }
        if p.get("display").map(|d| d == "none").unwrap_or(false) {
            st.hidden = true;
        }
        st
    }

    pub fn apply_para(&self, base: &ParaProps, p: &Props, tabs: &[TabStop]) -> ParaProps {
        let mut pp = base.clone();
        let len = |k: &str| p.get(k).and_then(|v| parse_length(v));
        if let Some(a) = p.get("text-align") {
            pp.align = match a.as_str() {
                "center" => Align::Center,
                "end" | "right" => Align::Right,
                "justify" => Align::Justify,
                _ => Align::Left,
            };
        }
        if let Some(v) = len("margin-left") {
            pp.ind_left = v;
        }
        if let Some(v) = len("margin-right") {
            pp.ind_right = v;
        }
        if let Some(v) = len("text-indent") {
            pp.ind_first = v;
        }
        if let Some(v) = len("margin-top") {
            pp.space_before = v;
        }
        if let Some(v) = len("margin-bottom") {
            pp.space_after = v;
        }
        if let Some(lh) = p.get("line-height") {
            if let Some(pct) = lh.strip_suffix('%') {
                if let Ok(v) = pct.parse::<f32>() {
                    pp.line = LineSpacing::Multiple(v / 100.0);
                }
            } else if lh != "normal" {
                if let Some(v) = parse_length(lh) {
                    pp.line = LineSpacing::Exact(v);
                }
            } else {
                pp.line = LineSpacing::Multiple(1.0);
            }
        }
        if let Some(v) = len("line-height-at-least") {
            pp.line = LineSpacing::AtLeast(v);
        }
        if let Some(bg) = p.get("background-color") {
            pp.shading = Color::from_hex(bg);
        }
        if p.get("break-before").map(|v| v == "page").unwrap_or(false) {
            pp.page_break_before = true;
        }
        if p.get("keep-with-next").map(|v| v == "always").unwrap_or(false) {
            pp.keep_next = true;
        }
        if let Some(t) = p.get("tab-stop-distance").and_then(|v| parse_length(v)) {
            if t > 1.0 {
                pp.default_tab = t;
            }
        }
        if p.get("contextual-spacing").map(|v| v == "true").unwrap_or(false) {
            pp.contextual_spacing = true;
        }
        let all = p.get("border").and_then(|b| parse_border(b));
        let side = |k: &str| p.get(k).and_then(|b| parse_border(b)).or_else(|| all.clone());
        if p.contains_key("border") || p.contains_key("border-top") || p.contains_key("border-bottom") {
            let pad_all = len("padding");
            let with_space = |b: Option<BorderLine>, k: &str| b.map(|mut b| {
                b.space = len(k).or(pad_all).unwrap_or(0.0);
                b
            });
            pp.borders = [with_space(side("border-top"), "padding-top"), with_space(side("border-right"), "padding-right"), with_space(side("border-bottom"), "padding-bottom"), with_space(side("border-left"), "padding-left")];
            // l'espace intérieur s'ajoute à la hauteur du paragraphe
            if pp.borders[2].is_some() {
                pp.space_after += len("padding-bottom").or(pad_all).unwrap_or(0.0) + pp.borders[2].as_ref().map(|b| b.width).unwrap_or(0.0);
            }
            if pp.borders[0].is_some() {
                pp.space_before += len("padding-top").or(pad_all).unwrap_or(0.0) + pp.borders[0].as_ref().map(|b| b.width).unwrap_or(0.0);
            }
        }
        if !tabs.is_empty() {
            pp.tabs = tabs.iter().map(|t| TabStop { pos: t.pos + pp.ind_left, ..*t }).collect();
        }
        pp
    }
}

impl Default for Styles {
    fn default() -> Self {
        Self::new()
    }
}

/// « 0.5pt solid #000000 » -> bordure.
pub fn parse_border(s: &str) -> Option<BorderLine> {
    if s.trim() == "none" || s.trim() == "hidden" {
        return None;
    }
    let mut width = 0.75;
    let mut color = Color::BLACK;
    let mut double = false;
    let mut dash = DashStyle::Solid;
    for part in s.split_whitespace() {
        if let Some(c) = Color::from_hex(part).filter(|_| part.starts_with('#')) {
            color = c;
        } else if let Some(w) = parse_length(part).filter(|_| part.chars().next().map(|c| c.is_ascii_digit() || c == '.').unwrap_or(false)) {
            width = w;
        } else {
            match part {
                "double" => double = true,
                "dotted" => dash = DashStyle::Dot,
                "dashed" => dash = DashStyle::Dash,
                "none" | "hidden" => return None,
                _ => {}
            }
        }
    }
    if width <= 0.0 {
        return None;
    }
    Some(BorderLine { width: width.max(0.25), color, double, dash, space: 0.0 })
}

/// Formats de numérotation ODF : « 1 », « a », « A », « i », « I ».
pub fn format_num(n: i32, fmt: &str) -> String {
    match fmt {
        "a" => crate::ooxml::docx::letters(n),
        "A" => crate::ooxml::docx::letters(n).to_uppercase(),
        "i" => crate::ooxml::docx::roman(n),
        "I" => crate::ooxml::docx::roman(n).to_uppercase(),
        "" => String::new(),
        _ => n.to_string(),
    }
}

/// Texte d'un paragraphe en tenant compte des règles d'espaces ODF.
pub fn collapse_ws(s: &str, last_was_space: &mut bool) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == ' ' || ch == '\n' || ch == '\t' || ch == '\r' {
            if !*last_was_space {
                out.push(' ');
                *last_was_space = true;
            }
        } else {
            out.push(ch);
            *last_was_space = false;
        }
    }
    out
}

/// Ouvre et analyse styles.xml et content.xml.
pub struct OdfDoc {
    pub content: String,
    pub styles_xml: String,
}

impl OdfDoc {
    pub fn read(pkg: &Package) -> Result<OdfDoc, String> {
        let content = pkg.read_string("content.xml").ok_or("content.xml introuvable")?;
        let styles_xml = pkg.read_string("styles.xml").unwrap_or_default();
        Ok(OdfDoc { content, styles_xml })
    }
}

pub fn parse_pair<'a>(a: &'a str, b: &'a str) -> Result<(Document<'a>, Option<Document<'a>>), String> {
    let c = parse_xml(a).ok_or("content.xml invalide")?;
    let s = if b.is_empty() { None } else { parse_xml(b) };
    Ok((c, s))
}

/// Couleur ODF (« #rrggbb »).
pub fn color(p: &Props, key: &str) -> Option<Color> {
    p.get(key).and_then(|c| Color::from_hex(c))
}

pub fn len(p: &Props, key: &str) -> Option<f32> {
    p.get(key).and_then(|v| parse_length(v))
}

/// Recherche du descendant « office:body » puis du conteneur de contenu.
pub fn body<'a, 'i>(doc: &'a Document<'i>, kind: &str) -> Option<Node<'a, 'i>> {
    doc.root_element().child("body")?.child(kind)
}
