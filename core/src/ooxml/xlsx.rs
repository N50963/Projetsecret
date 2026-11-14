//! Lecture des classeurs Excel (.xlsx, .xlsm, .xltx).

use super::theme::Theme;
use crate::color::{excel_indexed, Color};
use crate::display::{DashStyle, Rect};
use crate::numfmt;
use crate::package::{parse_xml, NodeExt, Package};
use crate::formula::{self, Values, V};
use crate::sheet::*;
use crate::text::{BorderLine, TextStyle, VertAlign};
use roxmltree::Node;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) struct XStyles {
    pub cell_styles: Arc<Vec<CellStyle>>,
    pub num_fmts: Vec<String>,
    pub mdw: f32,
    pub default_font: TextStyle,
}

pub(crate) fn excel_color(n: Node, theme: &Theme, palette: &[Color]) -> Option<Color> {
    if n.attr("auto") == Some("1") || n.attr("auto") == Some("true") {
        return None;
    }
    let base = if let Some(rgb) = n.attr("rgb") {
        let c = Color::from_hex(rgb)?;
        Some(Color::rgb(c.r, c.g, c.b))
    } else if let Some(t) = n.attr("theme").and_then(|v| v.parse::<usize>().ok()) {
        let key = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].get(t)?;
        theme.color(key)
    } else if let Some(i) = n.attr("indexed").and_then(|v| v.parse::<usize>().ok()) {
        if i == 64 {
            return None;
        }
        palette.get(i).copied().or_else(|| excel_indexed(i))
    } else {
        None
    }?;
    let tint = n.attr("tint").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
    Some(base.office_tint(tint))
}

fn font_from(n: Node, theme: &Theme, palette: &[Color], base: Option<&TextStyle>) -> TextStyle {
    let mut st = base.cloned().unwrap_or_else(|| TextStyle { font: Arc::from("Calibri"), size: 11.0, ..Default::default() });
    for c in n.children().filter(|c| c.is_element()) {
        let on = !matches!(c.attr("val"), Some("0") | Some("false"));
        match c.local() {
            "b" => st.bold = on,
            "i" => st.italic = on,
            "u" => {
                let v = c.attr("val").unwrap_or("single");
                st.underline = v != "none" && !v.starts_with("double");
                st.double_underline = v.starts_with("double");
            }
            "strike" => st.strike = on,
            "sz" => {
                if let Some(v) = c.attr("val").and_then(|v| v.parse().ok()) {
                    st.size = v;
                }
            }
            "name" | "rFont" => {
                if let Some(v) = c.attr("val") {
                    st.font = Arc::from(v);
                }
            }
            "scheme" => {
                if let Some(v) = c.attr("val") {
                    if v == "minor" {
                        st.font = Arc::from(theme.minor_font.as_str());
                    } else if v == "major" {
                        st.font = Arc::from(theme.major_font.as_str());
                    }
                }
            }
            "color" => st.color = excel_color(c, theme, palette).unwrap_or(Color::BLACK),
            "vertAlign" => {
                st.vert = match c.attr("val") {
                    Some("superscript") => VertAlign::Super,
                    Some("subscript") => VertAlign::Sub,
                    _ => VertAlign::Baseline,
                }
            }
            _ => {}
        }
    }
    st
}

fn border_line(n: Option<Node>, theme: &Theme, palette: &[Color]) -> Option<BorderLine> {
    let n = n?;
    let style = n.attr("style")?;
    let color = n.child("color").and_then(|c| excel_color(c, theme, palette)).unwrap_or(Color::BLACK);
    let (width, dash, double) = match style {
        "none" => return None,
        "hair" => (0.5, DashStyle::Solid, false),
        "thin" => (0.75, DashStyle::Solid, false),
        "medium" => (1.5, DashStyle::Solid, false),
        "thick" => (2.25, DashStyle::Solid, false),
        "double" => (0.75, DashStyle::Solid, true),
        "dotted" => (0.75, DashStyle::Dot, false),
        "dashed" => (0.75, DashStyle::Dash, false),
        "mediumDashed" => (1.5, DashStyle::Dash, false),
        "dashDot" | "dashDotDot" => (0.75, DashStyle::DashDot, false),
        "mediumDashDot" | "mediumDashDotDot" | "slantDashDot" => (1.5, DashStyle::DashDot, false),
        _ => (0.75, DashStyle::Solid, false),
    };
    Some(BorderLine { width, color, double, dash, space: 0.0 })
}

pub(crate) fn load_styles(pkg: &Package, path: Option<&str>, theme: &Theme) -> XStyles {
    let mut cell_styles = Vec::new();
    let mut num_fmts = Vec::new();
    let mut default_font = TextStyle { font: Arc::from(theme.minor_font.as_str()), size: 11.0, ..Default::default() };
    let xml = path.and_then(|p| pkg.read_string(p)).unwrap_or_default();
    let doc = parse_xml(&xml);
    if let Some(doc) = &doc {
        let root = doc.root_element();
        // palette personnalisée
        let mut palette: Vec<Color> = (0..64).filter_map(excel_indexed).collect();
        if let Some(ic) = root.child("colors").and_then(|c| c.child("indexedColors")) {
            for (i, rgb) in ic.children_named("rgbColor").enumerate() {
                if let Some(c) = rgb.attr("rgb").and_then(Color::from_hex) {
                    if i < palette.len() {
                        palette[i] = Color::rgb(c.r, c.g, c.b);
                    }
                }
            }
        }
        let mut custom_fmts: HashMap<u32, String> = HashMap::new();
        if let Some(nf) = root.child("numFmts") {
            for f in nf.children_named("numFmt") {
                if let (Some(id), Some(code)) = (f.attr("numFmtId").and_then(|v| v.parse().ok()), f.attr("formatCode")) {
                    custom_fmts.insert(id, code.to_string());
                }
            }
        }
        let fonts: Vec<TextStyle> = root.child("fonts").map(|f| f.children_named("font").map(|n| font_from(n, theme, &palette, None)).collect()).unwrap_or_default();
        if let Some(f) = fonts.first() {
            default_font = f.clone();
        }
        let fills: Vec<Option<Color>> = root
            .child("fills")
            .map(|f| {
                f.children_named("fill")
                    .map(|n| {
                        if let Some(p) = n.child("patternFill") {
                            let pt = p.attr("patternType").unwrap_or(if p.child("fgColor").is_some() { "solid" } else { "none" });
                            let fg = p.child("fgColor").and_then(|c| excel_color(c, theme, &palette));
                            let bg = p.child("bgColor").and_then(|c| excel_color(c, theme, &palette));
                            match pt {
                                "none" => None,
                                "solid" => fg.or(bg),
                                "gray125" | "gray0625" => Some(fg.unwrap_or(Color::BLACK).mix(bg.unwrap_or(Color::WHITE), 0.88)),
                                "lightGray" => Some(fg.unwrap_or(Color::BLACK).mix(bg.unwrap_or(Color::WHITE), 0.75)),
                                "mediumGray" => Some(fg.unwrap_or(Color::BLACK).mix(bg.unwrap_or(Color::WHITE), 0.5)),
                                "darkGray" => Some(fg.unwrap_or(Color::BLACK).mix(bg.unwrap_or(Color::WHITE), 0.25)),
                                _ => Some(fg.unwrap_or(Color::BLACK).mix(bg.unwrap_or(Color::WHITE), 0.5)),
                            }
                        } else if let Some(g) = n.child("gradientFill") {
                            g.children_named("stop").next().and_then(|s| s.child("color")).and_then(|c| excel_color(c, theme, &palette))
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let borders: Vec<[Option<BorderLine>; 4]> = root
            .child("borders")
            .map(|b| {
                b.children_named("border")
                    .map(|n| {
                        [
                            border_line(n.child("top"), theme, &palette),
                            border_line(n.child("right").or_else(|| n.child("end")), theme, &palette),
                            border_line(n.child("bottom"), theme, &palette),
                            border_line(n.child("left").or_else(|| n.child("start")), theme, &palette),
                        ]
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Some(xfs) = root.child("cellXfs") {
            for xf in xfs.children_named("xf") {
                let g = |a: &str| xf.attr(a).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                let font = fonts.get(g("fontId")).cloned().unwrap_or_else(|| default_font.clone());
                let mut st = CellStyle { font: Arc::new(font), fill: fills.get(g("fillId")).copied().flatten(), borders: borders.get(g("borderId")).cloned().unwrap_or_default(), ..Default::default() };
                if let Some(al) = xf.child("alignment") {
                    st.halign = match al.attr("horizontal").unwrap_or("general") {
                        "left" => HAlign::Left,
                        "center" => HAlign::Center,
                        "right" => HAlign::Right,
                        "fill" => HAlign::Fill,
                        "justify" | "distributed" => HAlign::Justify,
                        "centerContinuous" => HAlign::CenterAcross,
                        _ => HAlign::General,
                    };
                    st.valign = match al.attr("vertical").unwrap_or("bottom") {
                        "top" => VAlign::Top,
                        "center" | "justify" | "distributed" => VAlign::Center,
                        _ => VAlign::Bottom,
                    };
                    st.wrap = matches!(al.attr("wrapText"), Some("1") | Some("true"));
                    st.indent = al.attr("indent").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) * 9.0;
                    st.rotation = al.attr("textRotation").and_then(|v| v.parse().ok()).unwrap_or(0);
                    st.shrink = matches!(al.attr("shrinkToFit"), Some("1") | Some("true"));
                }
                let fid = g("numFmtId") as u32;
                let code = custom_fmts.get(&fid).cloned().or_else(|| numfmt::builtin(fid).map(String::from)).unwrap_or_else(|| "General".into());
                cell_styles.push(st);
                num_fmts.push(code);
            }
        }
    }
    if cell_styles.is_empty() {
        cell_styles.push(CellStyle { font: Arc::new(default_font.clone()), ..Default::default() });
        num_fmts.push("General".into());
    }
    // largeur du chiffre le plus large (en pixels à 96 ppp)
    let db = crate::fonts::db();
    let rf = default_font.resolved();
    let px_size = default_font.size * 96.0 / 72.0;
    let mut mdw: f32 = 0.0;
    for d in '0'..='9' {
        let (f, g) = db.glyph(rf.id, d);
        mdw = mdw.max(db.advance(f, g) * px_size);
    }
    let mdw = mdw.round().max(5.0);
    XStyles { cell_styles: Arc::new(cell_styles), num_fmts, mdw, default_font }
}

/// « AB12 » -> (ligne 11, colonne 27) en base 0.
pub fn parse_ref(r: &str) -> Option<(u32, u32)> {
    let mut col: u32 = 0;
    let mut i = 0;
    let b = r.as_bytes();
    while i < b.len() && (b[i].is_ascii_alphabetic() || b[i] == b'$') {
        if b[i] != b'$' {
            col = col * 26 + (b[i].to_ascii_uppercase() - b'A') as u32 + 1;
        }
        i += 1;
    }
    let row: u32 = r[i..].trim_start_matches('$').parse().ok()?;
    if col == 0 || row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

pub fn parse_range(r: &str) -> Option<Merge> {
    let (a, b) = r.split_once(':')?;
    let (r1, c1) = parse_ref(a)?;
    let (r2, c2) = parse_ref(b)?;
    Some(Merge { r1: r1.min(r2), c1: c1.min(c2), r2: r1.max(r2), c2: c1.max(c2) })
}

pub fn error_text(e: &str) -> String {
    if numfmt::is_english() {
        return e.to_string();
    }
    match e {
        "#VALUE!" => "#VALEUR!",
        "#NAME?" => "#NOM?",
        "#NUM!" => "#NOMBRE!",
        "#NULL!" => "#NUL!",
        "#DIV/0!" => "#DIV/0!",
        "#N/A" => "#N/A",
        "#REF!" => "#REF!",
        other => other,
    }
    .to_string()
}

pub fn bool_text(b: bool) -> String {
    match (b, numfmt::is_english()) {
        (true, true) => "TRUE".into(),
        (false, true) => "FALSE".into(),
        (true, false) => "VRAI".into(),
        (false, false) => "FAUX".into(),
    }
}

fn si_text(si: Node) -> String {
    let mut s = String::new();
    for c in si.children().filter(|c| c.is_element()) {
        match c.local() {
            "t" => s.push_str(c.text().unwrap_or("")),
            "r" => {
                if let Some(t) = c.child("t") {
                    s.push_str(t.text().unwrap_or(""));
                }
            }
            _ => {}
        }
    }
    s
}

pub fn load(pkg: &Package) -> Result<Workbook, String> {
    let main = pkg.rels("").values().find(|r| r.kind == "officeDocument").map(|r| r.target.clone()).unwrap_or_else(|| "xl/workbook.xml".into());
    let rels = pkg.rels(&main);
    let theme = rels.values().find(|r| r.kind == "theme").map(|r| Theme::load(pkg, &r.target)).unwrap_or_default();
    let styles = load_styles(pkg, rels.values().find(|r| r.kind == "styles").map(|r| r.target.as_str()), &theme);
    // chaînes partagées
    let sst_xml = rels.values().find(|r| r.kind == "sharedStrings").and_then(|r| pkg.read_string(&r.target)).unwrap_or_default();
    let sst_doc = parse_xml(&sst_xml);
    let palette: Vec<Color> = (0..64).filter_map(excel_indexed).collect();
    let mut shared: Vec<(String, Option<Vec<(String, TextStyle)>>)> = Vec::new();
    if let Some(d) = &sst_doc {
        for si in d.root_element().children_named("si") {
            let text = si_text(si);
            let has_runs = si.children_named("r").next().is_some();
            let runs = if has_runs {
                Some(
                    si.children_named("r")
                        .map(|r| {
                            let t = r.child("t").and_then(|t| t.text()).unwrap_or("").to_string();
                            let st = match r.child("rPr") {
                                Some(rp) => font_from(rp, &theme, &palette, Some(&styles.default_font)),
                                None => styles.default_font.clone(),
                            };
                            (t, st)
                        })
                        .collect(),
                )
            } else {
                None
            };
            shared.push((text, runs));
        }
    }
    let wb_xml = pkg.read_string(&main).ok_or("workbook.xml introuvable")?;
    let wb_doc = parse_xml(&wb_xml).ok_or("workbook.xml invalide")?;
    let wroot = wb_doc.root_element();
    let date1904 = wroot.child("workbookPr").and_then(|p| p.attr("date1904")).map(|v| v == "1" || v == "true").unwrap_or(false);
    let mut sheets = Vec::new();
    let mut loaded: Vec<(usize, LoadedSheet)> = Vec::new();
    if let Some(sh) = wroot.child("sheets") {
        for s in sh.children_named("sheet") {
            let name = s.attr("name").unwrap_or("Feuille").to_string();
            let hidden = matches!(s.attr("state"), Some("hidden") | Some("veryHidden"));
            let Some(rid) = s.rid() else { continue };
            let Some(rel) = rels.get(rid) else { continue };
            if rel.kind != "worksheet" {
                // feuilles graphiques : on affiche le graphique seul
                if rel.kind == "chartsheet" {
                    if let Some(sheet) = load_chartsheet(pkg, &rel.target, &name, &styles, &theme) {
                        sheets.push(sheet);
                    }
                }
                continue;
            }
            match load_sheet(pkg, &rel.target, &name, &styles, &shared, &theme, date1904) {
                Ok(mut ls) => {
                    ls.builder.hidden = hidden;
                    loaded.push((sheets.len(), ls));
                    // emplacement réservé, remplacé après la seconde passe
                    sheets.push(SheetBuilder::new(&name, styles.cell_styles.clone()).build());
                }
                Err(e) => log::warn!("feuille {name} : {e}"),
            }
        }
    }
    // seconde passe : formules sans valeur, puis graphiques
    let mut vals: Values = HashMap::new();
    for (_, ls) in &loaded {
        vals.insert(ls.builder.name.to_lowercase(), ls.values.clone());
    }
    for _ in 0..3 {
        let mut changed = false;
        for (_, ls) in &loaded {
            let sname = ls.builder.name.clone();
            for (r, c, f) in &ls.formulas {
                let v = formula::eval(f, &sname, &vals);
                let m = vals.get_mut(&sname.to_lowercase()).unwrap();
                if m.get(&(*r, *c)) != Some(&v) {
                    m.insert((*r, *c), v);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    for (idx, mut ls) in loaded {
        let sname = ls.builder.name.to_lowercase();
        if !ls.formulas.is_empty() {
            let m = &vals[&sname];
            let index: HashMap<(u32, u32), usize> = ls.builder.cells.iter().enumerate().map(|(i, (r, c))| ((*r, c.col), i)).collect();
            for (r, c, _) in &ls.formulas {
                let Some(v) = m.get(&(*r, *c)) else { continue };
                if let Some((_, cell)) = index.get(&(*r, *c)).and_then(|i| ls.builder.cells.get_mut(*i)) {
                    let fmt = styles.num_fmts.get(cell.style as usize).map(|s| s.as_str()).unwrap_or("General");
                    match v {
                        V::Num(n) => {
                            let (t, col) = numfmt::format_value(*n, fmt, date1904);
                            cell.text = t;
                            cell.color = col;
                            cell.kind = CellKind::Number;
                        }
                        V::Str(t) => {
                            cell.text = t.clone();
                            cell.kind = CellKind::Text;
                        }
                        V::Bool(b) => {
                            cell.text = bool_text(*b);
                            cell.kind = CellKind::Bool;
                        }
                        V::Err(e) => {
                            cell.text = error_text(e);
                            cell.kind = CellKind::Error;
                        }
                        _ => {}
                    }
                }
            }
        }
        let drawing = ls.drawing.take();
        let mut sheet = ls.builder.build();
        if let Some(d) = drawing {
            let sn = sheet.name.clone();
            let res = |f: &str| formula::resolve_range(&vals, f, &sn);
            let geo = &sheet;
            let pos = |col: u32, coff: f32, row: u32, roff: f32| -> (f32, f32) { (geo.col_x(col as usize) + coff, geo.row_y(row as usize) + roff) };
            let drawings = super::pptx::sheet_drawings(pkg, &d, &theme, &pos, Some(&res));
            let drawings: Vec<Drawing> = drawings.into_iter().map(|(rect, items)| Drawing { rect, items }).collect();
            sheet.add_drawings(drawings);
        }
        sheets[idx] = sheet;
    }
    if sheets.is_empty() {
        return Err("Aucune feuille lisible dans le classeur.".into());
    }
    Ok(Workbook { sheets })
}

fn load_chartsheet(pkg: &Package, path: &str, name: &str, styles: &XStyles, theme: &Theme) -> Option<Sheet> {
    let rels = pkg.rels(path);
    let drawing = rels.values().find(|r| r.kind == "drawing")?;
    let mut b = SheetBuilder::new(name, styles.cell_styles.clone());
    b.show_grid = false;
    let drels = pkg.rels(&drawing.target);
    if let Some(chart) = drels.values().find(|r| r.kind == "chart") {
        let rect = Rect::new(0.0, 0.0, 720.0, 450.0);
        b.drawings.push(Drawing { rect, items: super::chart::render_chart(pkg, &chart.target, Rect::new(0.0, 0.0, rect.w, rect.h), theme) });
    }
    Some(b.build())
}

#[allow(clippy::too_many_arguments)]
struct LoadedSheet {
    builder: SheetBuilder,
    drawing: Option<String>,
    values: HashMap<(u32, u32), V>,
    formulas: Vec<(u32, u32, String)>,
}

fn load_sheet(pkg: &Package, path: &str, name: &str, styles: &XStyles, shared: &[(String, Option<Vec<(String, TextStyle)>>)], theme: &Theme, date1904: bool) -> Result<LoadedSheet, String> {
    let mut values: HashMap<(u32, u32), V> = HashMap::new();
    let mut formulas: Vec<(u32, u32, String)> = Vec::new();
    let mut shared_formulas: HashMap<String, (u32, u32, String)> = HashMap::new();
    let xml = pkg.read_string(path).ok_or("partie introuvable")?;
    let doc = parse_xml(&xml).ok_or("XML invalide")?;
    let root = doc.root_element();
    let mut b = SheetBuilder::new(name, styles.cell_styles.clone());
    let mdw = styles.mdw;
    let width_pt = |w: f32| (w * mdw).round() * 0.75;
    let mut default_col = ((8.0 * mdw + 5.0) / 8.0).ceil() * 8.0 * 0.75;
    if let Some(f) = root.child("sheetFormatPr") {
        if let Some(h) = f.attr("defaultRowHeight").and_then(|v| v.parse::<f32>().ok()) {
            b.default_row_height = h;
        }
        if let Some(w) = f.attr("defaultColWidth").and_then(|v| v.parse::<f32>().ok()) {
            default_col = width_pt(w);
        } else if let Some(bw) = f.attr("baseColWidth").and_then(|v| v.parse::<f32>().ok()) {
            default_col = ((bw * mdw + 5.0) / 8.0).ceil() * 8.0 * 0.75;
        }
    } else {
        b.default_row_height = (crate::text::single_line_height(&styles.default_font) + 1.6).round();
    }
    b.default_col_width = default_col;
    if let Some(sv) = root.child("sheetViews").and_then(|s| s.child("sheetView")) {
        b.show_grid = !matches!(sv.attr("showGridLines"), Some("0") | Some("false"));
        if let Some(p) = sv.child("pane") {
            if matches!(p.attr("state"), Some("frozen") | Some("frozenSplit")) {
                b.frozen_cols = p.attr("xSplit").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) as u32;
                b.frozen_rows = p.attr("ySplit").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0) as u32;
            }
        }
    }
    if let Some(tc) = root.child("sheetPr").and_then(|p| p.child("tabColor")) {
        b.tab_color = excel_color(tc, theme, &[]);
    }
    if let Some(cols) = root.child("cols") {
        for c in cols.children_named("col") {
            let min: u32 = c.attr("min").and_then(|v| v.parse().ok()).unwrap_or(1);
            let max: u32 = c.attr("max").and_then(|v| v.parse().ok()).unwrap_or(min).min(16384);
            let w = c.attr("width").and_then(|v| v.parse::<f32>().ok()).map(width_pt).unwrap_or(default_col);
            let hidden = matches!(c.attr("hidden"), Some("1") | Some("true"));
            b.col_widths.push((min - 1, max - 1, w, hidden));
        }
    }
    let data = root.child("sheetData");
    if let Some(data) = data {
        let mut next_row = 0u32;
        for row in data.children_named("row") {
            let r = row.attr("r").and_then(|v| v.parse::<u32>().ok()).map(|v| v - 1).unwrap_or(next_row);
            next_row = r + 1;
            let hidden = matches!(row.attr("hidden"), Some("1") | Some("true"));
            if let Some(h) = row.attr("ht").and_then(|v| v.parse::<f32>().ok()) {
                b.row_heights.push((r, h, hidden));
            } else if hidden {
                b.row_heights.push((r, 0.0, true));
            }
            let mut next_col = 0u32;
            for c in row.children_named("c") {
                let col = c.attr("r").and_then(parse_ref).map(|x| x.1).unwrap_or(next_col);
                next_col = col + 1;
                let s: u32 = c.attr("s").and_then(|v| v.parse().ok()).unwrap_or(0);
                let fmt = styles.num_fmts.get(s as usize).map(|s| s.as_str()).unwrap_or("General");
                let t = c.attr("t").unwrap_or("n");
                let v = c.child("v").and_then(|v| v.text());
                // formule sans valeur en cache (fichiers générés par programme)
                if let Some(fnode) = c.child("f") {
                    let mut ftext = fnode.text().map(String::from);
                    if fnode.attr("t") == Some("shared") {
                        if let Some(si) = fnode.attr("si") {
                            match &ftext {
                                Some(t) if !t.is_empty() => {
                                    shared_formulas.insert(si.to_string(), (r, col, t.clone()));
                                }
                                _ => {
                                    ftext = shared_formulas.get(si).map(|(r0, c0, t)| shift_formula(t, r as i64 - *r0 as i64, col as i64 - *c0 as i64));
                                }
                            }
                        }
                    }
                    if v.is_none() {
                        if let Some(f) = ftext {
                            formulas.push((r, col, f));
                        }
                    }
                }
                let mut cell = Cell { col, style: s, ..Default::default() };
                match t {
                    "s" => {
                        if let Some(idx) = v.and_then(|v| v.trim().parse::<usize>().ok()) {
                            if let Some((text, runs)) = shared.get(idx) {
                                values.insert((r, col), V::Str(text.clone()));
                                cell.text = numfmt::format_text(text, fmt);
                                cell.kind = CellKind::Text;
                                if let Some(runs) = runs {
                                    cell.rich = Some(runs.iter().map(|(t, s)| (t.clone(), Arc::new(s.clone()))).collect());
                                }
                            }
                        }
                    }
                    "inlineStr" => {
                        if let Some(is) = c.child("is") {
                            cell.text = si_text(is);
                            values.insert((r, col), V::Str(cell.text.clone()));
                            cell.kind = CellKind::Text;
                        }
                    }
                    "str" => {
                        cell.text = v.unwrap_or("").to_string();
                        values.insert((r, col), V::Str(cell.text.clone()));
                        cell.kind = CellKind::Text;
                    }
                    "b" => {
                        let bv = v.map(|v| v.trim() == "1").unwrap_or(false);
                        values.insert((r, col), V::Bool(bv));
                        cell.text = bool_text(bv);
                        cell.kind = CellKind::Bool;
                    }
                    "e" => {
                        cell.text = error_text(v.unwrap_or("#N/A"));
                        cell.kind = CellKind::Error;
                    }
                    "d" => {
                        if let Some(serial) = v.and_then(numfmt::iso_to_serial) {
                            values.insert((r, col), V::Num(serial));
                            let code = if numfmt::is_date_format(fmt) { fmt } else { "dd/mm/yyyy" };
                            let (txt, col) = numfmt::format_value(serial, code, date1904);
                            cell.text = txt;
                            cell.color = col;
                            cell.kind = CellKind::Number;
                        }
                    }
                    _ => {
                        if let Some(num) = v.and_then(|v| v.trim().parse::<f64>().ok()) {
                            values.insert((r, col), V::Num(num));
                            let (txt, col) = numfmt::format_value(num, fmt, date1904);
                            cell.text = txt;
                            cell.color = col;
                            cell.kind = CellKind::Number;
                        }
                    }
                }
                b.cells.push((r, cell));
            }
        }
    }
    if let Some(mc) = root.child("mergeCells") {
        for m in mc.children_named("mergeCell") {
            if let Some(mg) = m.attr("ref").and_then(parse_range) {
                b.merges.push(mg);
            }
        }
    }
    let rels = pkg.rels(path);
    let drawing = root.child("drawing").and_then(|d| d.rid()).and_then(|id| rels.get(id)).map(|r| r.target.clone());
    Ok(LoadedSheet { builder: b, drawing, values, formulas })
}

/// Décale les références relatives d'une formule partagée.
fn shift_formula(f: &str, dr: i64, dc: i64) -> String {
    let mut out = String::new();
    let chars: Vec<char> = f.chars().collect();
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            in_str = !in_str;
            out.push(c);
            i += 1;
            continue;
        }
        if in_str || !(c.is_ascii_alphabetic() || c == '$') || (i > 0 && (chars[i - 1].is_ascii_alphanumeric() || chars[i - 1] == '_' || chars[i - 1] == '.')) {
            out.push(c);
            i += 1;
            continue;
        }
        // tentative de lecture d'une référence A1
        let st = i;
        let col_abs = chars[i] == '$';
        if col_abs {
            i += 1;
        }
        let cs = i;
        while i < chars.len() && chars[i].is_ascii_alphabetic() {
            i += 1;
        }
        let letters: String = chars[cs..i].iter().collect();
        let row_abs = i < chars.len() && chars[i] == '$';
        if row_abs {
            i += 1;
        }
        let rs = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        let digits: String = chars[rs..i].iter().collect();
        let next_is_paren = i < chars.len() && chars[i] == '(';
        if letters.is_empty() || letters.len() > 3 || digits.is_empty() || next_is_paren {
            out.extend(&chars[st..i]);
            continue;
        }
        let mut col = 0i64;
        for ch in letters.chars() {
            col = col * 26 + (ch.to_ascii_uppercase() as i64 - 'A' as i64 + 1);
        }
        let mut row: i64 = digits.parse().unwrap_or(1);
        if !col_abs {
            col += dc;
        }
        if !row_abs {
            row += dr;
        }
        let name = crate::sheet::Sheet::col_name((col.max(1) - 1) as usize);
        out.push_str(&format!("{}{}{}{}", if col_abs { "$" } else { "" }, name, if row_abs { "$" } else { "" }, row.max(1)));
    }
    out
}

