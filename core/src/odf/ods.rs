//! Classeurs OpenDocument (.ods) et graphiques ODF incorporés.

use super::*;
use crate::display::{Item, Rect};
use crate::ooxml::chart::{draw_chart, Chart, ChartKind, Grouping, Series};
use crate::ooxml::theme::Theme;
use crate::package::Package;
use crate::sheet::*;
use tiny_skia::Transform;

fn cell_style(styles: &Styles, name: Option<&str>, base_font: &TextStyle) -> CellStyle {
    let s = styles.get("table-cell", name);
    let font = styles.apply_text(base_font, &s.text);
    let all = s.cell.get("border").and_then(|b| parse_border(b));
    let side = |k: &str| match s.cell.get(k) {
        Some(b) => parse_border(b),
        None => all.clone(),
    };
    CellStyle {
        font: Arc::new(font),
        fill: color(&s.cell, "background-color"),
        borders: [side("border-top"), side("border-right"), side("border-bottom"), side("border-left")],
        halign: match s.para.get("text-align").map(|v| v.as_str()) {
            Some("center") => HAlign::Center,
            Some("end") | Some("right") => HAlign::Right,
            Some("start") | Some("left") => HAlign::Left,
            Some("justify") => HAlign::Justify,
            _ => HAlign::General,
        },
        valign: match s.cell.get("vertical-align").map(|v| v.as_str()) {
            Some("top") => VAlign::Top,
            Some("middle") => VAlign::Center,
            _ => VAlign::Bottom,
        },
        wrap: s.cell.get("wrap-option").map(|v| v == "wrap").unwrap_or(false),
        indent: len(&s.para, "margin-left").unwrap_or(0.0),
        rotation: 0,
        shrink: s.cell.get("shrink-to-fit").map(|v| v == "true").unwrap_or(false),
    }
}

fn cell_text(c: Node) -> String {
    let mut lines = Vec::new();
    for p in c.children().filter(|x| x.is_element() && x.local() == "p") {
        let mut s = String::new();
        let mut last = false;
        fn walk(n: Node, s: &mut String, last: &mut bool) {
            for ch in n.children() {
                if ch.is_text() {
                    s.push_str(&collapse_ws(ch.text().unwrap_or(""), last));
                } else if ch.is_element() {
                    match ch.local() {
                        "s" => {
                            let k: usize = ch.attr("c").and_then(|v| v.parse().ok()).unwrap_or(1);
                            s.push_str(&" ".repeat(k));
                        }
                        "tab" => s.push('\t'),
                        "line-break" => s.push('\n'),
                        "annotation" => {}
                        _ => walk(ch, s, last),
                    }
                }
            }
        }
        walk(p, &mut s, &mut last);
        lines.push(s);
    }
    lines.join("\n")
}

pub fn load(pkg: &Package) -> Result<Workbook, String> {
    let od = OdfDoc::read(pkg)?;
    let (content, styles_doc) = parse_pair(&od.content, &od.styles_xml)?;
    let mut styles = Styles::new();
    if let Some(sd) = &styles_doc {
        styles.load(sd);
    }
    styles.load(&content);
    let sheet_body = body(&content, "spreadsheet").ok_or("classeur introuvable")?;
    let base_font = TextStyle { font: Arc::from("Liberation Sans"), size: 10.0, ..Default::default() };
    let base_font = styles.defaults.get("table-cell").map(|d| styles.apply_text(&base_font, &d.text)).unwrap_or(base_font);
    let mut style_list: Vec<CellStyle> = vec![cell_style(&styles, Some("Default"), &base_font)];
    let mut style_index: HashMap<String, u32> = HashMap::new();
    let mut idx_of = |name: Option<&str>, styles: &Styles, list: &mut Vec<CellStyle>| -> u32 {
        let Some(n) = name else { return 0 };
        if let Some(i) = style_index.get(n) {
            return *i;
        }
        list.push(cell_style(styles, Some(n), &base_font));
        let i = (list.len() - 1) as u32;
        style_index.insert(n.to_string(), i);
        i
    };
    let mut sheets_raw = Vec::new();
    // première passe : styles et contenu
    for t in sheet_body.children_named("table") {
        let name = t.attr("name").unwrap_or("Feuille").to_string();
        let ts = styles.get("table", t.attr("style-name"));
        let hidden = ts.table.get("display").map(|v| v == "false").unwrap_or(false);
        let mut cols: Vec<(u32, u32, f32, bool)> = Vec::new();
        let mut col_default_style: Vec<Option<String>> = Vec::new();
        let mut ci = 0u32;
        let mut rows_nodes = Vec::new();
        fn collect<'a, 'i>(n: Node<'a, 'i>, cols: &mut Vec<Node<'a, 'i>>, rows: &mut Vec<Node<'a, 'i>>) {
            for c in n.children().filter(|c| c.is_element()) {
                match c.local() {
                    "table-column" => cols.push(c),
                    "table-row" => rows.push(c),
                    "table-header-rows" | "table-rows" | "table-row-group" | "table-columns" | "table-header-columns" | "table-column-group" => collect(c, cols, rows),
                    _ => {}
                }
            }
        }
        let mut col_nodes = Vec::new();
        collect(t, &mut col_nodes, &mut rows_nodes);
        for c in col_nodes {
            let rep: u32 = c.attr("number-columns-repeated").and_then(|v| v.parse().ok()).unwrap_or(1);
            let cs = styles.get("table-column", c.attr("style-name"));
            let w = len(&cs.column, "column-width").unwrap_or(64.0);
            let hidden = matches!(c.attr("visibility"), Some("collapse") | Some("filter"));
            let rep_c = rep.min(16384 - ci.min(16384));
            if rep_c > 0 {
                cols.push((ci, ci + rep_c - 1, w, hidden));
            }
            for _ in 0..rep.min(1024) {
                col_default_style.push(c.attr("default-cell-style-name").map(String::from));
            }
            ci = ci.saturating_add(rep);
        }
        sheets_raw.push((name, hidden, cols, col_default_style, rows_nodes, t));
    }
    let mut sheets = Vec::new();
    for (name, hidden, cols, col_default_style, rows_nodes, tnode) in sheets_raw {
        let mut cells: Vec<(u32, Cell)> = Vec::new();
        let mut merges = Vec::new();
        let mut row_heights = Vec::new();
        let mut r = 0u32;
        for row in rows_nodes {
            let rep: u32 = row.attr("number-rows-repeated").and_then(|v| v.parse().ok()).unwrap_or(1);
            let rs = styles.get("table-row", row.attr("style-name"));
            let hidden_row = matches!(row.attr("visibility"), Some("collapse") | Some("filter"));
            let h = len(&rs.row, "row-height");
            let optimal = rs.row.get("use-optimal-row-height").map(|v| v == "true").unwrap_or(false);
            let has_content = row.children().any(|c| c.is_element() && (c.attr("value-type").is_some() || c.children().any(|x| x.is_element() && x.local() == "p") || c.attr("number-columns-spanned").is_some()));
            let row_style = row.attr("default-cell-style-name");
            let rep_eff = if has_content { rep.min(500) } else { rep };
            if r > 1_048_576 {
                break;
            }
            for k in 0..rep_eff.min(if has_content { 500 } else { 1 }) {
                let rr = r + k;
                if let Some(h) = h {
                    if !optimal || hidden_row {
                        row_heights.push((rr, h, hidden_row));
                    }
                } else if hidden_row {
                    row_heights.push((rr, 0.0, true));
                }
                if !has_content {
                    continue;
                }
                let mut c = 0u32;
                for cell in row.children().filter(|x| x.is_element()) {
                    let covered = cell.local() == "covered-table-cell";
                    if cell.local() != "table-cell" && !covered {
                        continue;
                    }
                    let crep: u32 = cell.attr("number-columns-repeated").and_then(|v| v.parse().ok()).unwrap_or(1);
                    let style_name = cell.attr("style-name").or(row_style).map(String::from).or_else(|| col_default_style.get(c as usize).cloned().flatten());
                    let vtype = cell.attr("value-type");
                    let text = if covered { String::new() } else { cell_text(cell) };
                    let empty = text.is_empty() && vtype.is_none();
                    let sidx = idx_of(style_name.as_deref(), &styles, &mut style_list);
                    let styled = sidx != 0 && style_list.get(sidx as usize).map(|s| s.fill.is_some() || s.borders.iter().any(|b| b.is_some())).unwrap_or(false);
                    let span_c: u32 = cell.attr("number-columns-spanned").and_then(|v| v.parse().ok()).unwrap_or(1);
                    let span_r: u32 = cell.attr("number-rows-spanned").and_then(|v| v.parse().ok()).unwrap_or(1);
                    let reps = if empty && !styled { 1 } else { crep.min(256) };
                    for j in 0..reps {
                        let col = c + j;
                        if col >= 16384 {
                            break;
                        }
                        if (span_c > 1 || span_r > 1) && !covered {
                            merges.push(Merge { r1: rr, c1: col, r2: rr + span_r - 1, c2: col + span_c - 1 });
                        }
                        if empty && !styled {
                            continue;
                        }
                        let kind = match vtype {
                            Some("float") | Some("percentage") | Some("currency") | Some("date") | Some("time") => CellKind::Number,
                            Some("boolean") => CellKind::Bool,
                            Some(_) => CellKind::Text,
                            None => {
                                if text.is_empty() {
                                    CellKind::Empty
                                } else {
                                    CellKind::Text
                                }
                            }
                        };
                        // couleur des nombres négatifs (style de nombre avec carte « rouge »)
                        cells.push((rr, Cell { col, text: text.clone(), kind, style: sidx, color: None, rich: None }));
                    }
                    c = c.saturating_add(crep);
                }
            }
            r = r.saturating_add(rep);
        }
        let mut b = SheetBuilder::new(&name, Arc::new(Vec::new()));
        b.default_col_width = 64.0;
        b.default_row_height = (crate::text::single_line_height(&base_font) + 2.0).round().max(12.8);
        b.col_widths = cols;
        b.row_heights = row_heights;
        b.cells = cells;
        b.merges = merges;
        b.hidden = hidden;
        // images et graphiques ancrés
        let mut drawings = Vec::new();
        for f in tnode.descendants().filter(|d| d.is_element() && d.local() == "frame") {
            let x = f.attr("x").and_then(parse_length);
            let y = f.attr("y").and_then(parse_length);
            let w = f.attr("width").and_then(parse_length).unwrap_or(100.0);
            let h = f.attr("height").and_then(parse_length).unwrap_or(100.0);
            let (Some(x), Some(y)) = (x, y) else { continue };
            // les coordonnées sont relatives à la cellule d'ancrage
            let (ax, ay) = match f.parent().filter(|p| p.local() == "table-cell") {
                Some(_) => (f64::NAN, f64::NAN),
                None => (0.0, 0.0),
            };
            let mut items = Vec::new();
            if let Some(obj) = f.child("object") {
                let href = obj.attr("href").unwrap_or("").trim_start_matches("./").to_string();
                items = render_odf_chart(pkg, &href, Rect::new(0.0, 0.0, w, h));
            } else if let Some(img) = f.child("image").and_then(|i| i.attr("href")).and_then(|h| pkg.image(h)) {
                items.push(Item::Image { rect: Rect::new(0.0, 0.0, w, h), image: img, crop: [0.0; 4], alpha: 1.0 });
            }
            if items.is_empty() {
                continue;
            }
            drawings.push((x, y, w, h, items, ax.is_nan()));
        }
        let mut sheet_b = b;
        sheet_b.styles = Arc::new(style_list.clone());
        let mut sheet = sheet_b.build();
        for (x, y, w, h, items, _in_cell) in drawings {
            // ODF utilise des coordonnées absolues dans la feuille (svg:x/svg:y depuis l'origine)
            sheet.drawings.push(Drawing { rect: Rect::new(x, y, w, h), items });
        }
        sheets.push(sheet);
    }
    // toutes les feuilles partagent la liste finale des styles
    let all = Arc::new(style_list);
    for s in sheets.iter_mut() {
        s.styles = all.clone();
    }
    if sheets.is_empty() {
        return Err("Aucune feuille dans le classeur.".into());
    }
    Ok(Workbook { sheets })
}

// ---------------------------------------------------------------------------------
// Graphiques ODF (objets incorporés « Object 1/content.xml »)
// ---------------------------------------------------------------------------------

fn col_index(addr: &str) -> Option<usize> {
    // « local-table.$B$2:.$B$5 » -> 1
    let part = addr.split(':').next()?;
    let part = part.rsplit('.').next()?;
    let letters: String = part.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if letters.is_empty() {
        return None;
    }
    let mut v = 0usize;
    for ch in letters.chars() {
        v = v * 26 + (ch.to_ascii_uppercase() as u8 - b'A') as usize + 1;
    }
    Some(v - 1)
}

pub fn render_odf_chart(pkg: &Package, dir: &str, rect: Rect) -> Vec<Item> {
    let path = format!("{}/content.xml", dir.trim_end_matches('/'));
    let Some(xml) = pkg.read_string(&path) else { return Vec::new() };
    let Some(doc) = parse_xml(&xml) else { return Vec::new() };
    let mut styles = Styles::new();
    styles.load(&doc);
    let Some(chart) = doc.descendants().find(|n| n.is_element() && n.local() == "chart" && n.attr("class").is_some()) else { return Vec::new() };
    let class = chart.attr("class").unwrap_or("chart:bar");
    // table de données locale
    let mut grid: Vec<Vec<(Option<f64>, String)>> = Vec::new();
    if let Some(t) = chart.descendants().find(|n| n.local() == "table") {
        for row in t.descendants().filter(|n| n.local() == "table-row") {
            let mut v = Vec::new();
            for c in row.children().filter(|c| c.is_element() && c.local() == "table-cell") {
                let num = c.attr("value").and_then(|x| x.parse::<f64>().ok());
                v.push((num, cell_text(c)));
            }
            grid.push(v);
        }
    }
    if grid.len() < 2 {
        return Vec::new();
    }
    let plot = chart.child("plot-area");
    let ps = styles.get("chart", plot.and_then(|p| p.attr("style-name")));
    let vertical = ps.attrs.get("vertical").map(|v| v == "true").unwrap_or(false) || plot.and_then(|p| p.attr("style-name")).map(|n| styles.map.get(&("chart".to_string(), n.to_string())).is_some()).unwrap_or(false) && false;
    let chart_props = |name: Option<&str>| -> Props {
        let mut p = Props::new();
        if let Some(n) = name {
            if let Some(s) = doc.descendants().find(|d| d.local() == "style" && d.attr("name") == Some(n)) {
                if let Some(cp) = s.child("chart-properties") {
                    for a in cp.attributes() {
                        p.insert(a.name().to_string(), a.value().to_string());
                    }
                }
                if let Some(gp) = s.child("graphic-properties") {
                    for a in gp.attributes() {
                        p.insert(format!("g:{}", a.name()), a.value().to_string());
                    }
                }
            }
        }
        p
    };
    let pp = chart_props(plot.and_then(|p| p.attr("style-name")));
    let horizontal = pp.get("vertical").map(|v| v == "true").unwrap_or(vertical);
    let stacked = pp.get("stacked").map(|v| v == "true").unwrap_or(false);
    let percent = pp.get("percentage").map(|v| v == "true").unwrap_or(false);
    let grouping = if percent {
        Grouping::Percent
    } else if stacked {
        Grouping::Stacked
    } else {
        Grouping::Clustered
    };
    let kind_of = |cls: &str| match cls {
        "chart:line" => ChartKind::Line,
        "chart:area" => ChartKind::Area,
        "chart:circle" => ChartKind::Pie,
        "chart:ring" => ChartKind::Doughnut,
        "chart:scatter" | "chart:bubble" => ChartKind::Scatter,
        "chart:radar" | "chart:filled-radar" => ChartKind::Radar,
        _ => {
            if horizontal {
                ChartKind::Bar
            } else {
                ChartKind::Column
            }
        }
    };
    let categories: Vec<String> = grid.iter().skip(1).map(|r| r.first().map(|c| c.1.clone()).unwrap_or_default()).collect();
    let mut series = Vec::new();
    let theme = Theme::default();
    if let Some(plot) = plot {
        for (si, s) in plot.children_named("series").enumerate() {
            let col = s.attr("values-cell-range-address").and_then(col_index).unwrap_or(si + 1);
            let name = s.attr("label-cell-address").and_then(col_index).and_then(|c| grid[0].get(c)).map(|c| c.1.clone()).unwrap_or_else(|| grid[0].get(col).map(|c| c.1.clone()).unwrap_or_default());
            let values: Vec<Option<f64>> = grid.iter().skip(1).map(|r| r.get(col).and_then(|c| c.0)).collect();
            let sp = chart_props(s.attr("style-name"));
            let color = sp.get("g:fill-color").and_then(|c| Color::from_hex(c));
            let mut point_colors = Vec::new();
            let mut pi = 0;
            for dp in s.children_named("data-point") {
                let rep: usize = dp.attr("repeated").and_then(|v| v.parse().ok()).unwrap_or(1);
                let dps = chart_props(dp.attr("style-name"));
                if let Some(c) = dps.get("g:fill-color").and_then(|c| Color::from_hex(c)) {
                    for k in 0..rep {
                        point_colors.push((pi + k, c));
                    }
                }
                pi += rep;
            }
            let kind = kind_of(s.attr("class").unwrap_or(class));
            let line_color = sp.get("g:stroke-color").and_then(|c| Color::from_hex(c));
            let line = if matches!(kind, ChartKind::Line | ChartKind::Scatter) { Some(crate::ooxml::drawingml::LineDef { color: line_color.or(color), width: 2.0, ..Default::default() }) } else { None };
            series.push(Series { name, values, xvalues: Vec::new(), color, line, point_colors, kind, grouping, smooth: false, markers: kind == ChartKind::Line && sp.get("symbol-type").map(|v| v != "none").unwrap_or(false) });
        }
    }
    if series.is_empty() {
        return Vec::new();
    }
    let title = chart.child("title").map(|t| cell_text(t)).filter(|t| !t.is_empty());
    let legend = chart.child("legend").map(|l| match l.attr("legend-position").unwrap_or("end") {
        "bottom" => "b".to_string(),
        "top" => "t".to_string(),
        "start" => "l".to_string(),
        _ => "r".to_string(),
    });
    let c = Chart {
        title,
        categories,
        series,
        legend,
        val_fmt: "General".into(),
        show_values: false,
        show_percent: false,
        gap_width: 1.0,
        overlap: 0.0,
        hole: 0.5,
        bg: Some(Color::WHITE),
        border: None,
        val_min: None,
        val_max: None,
        gridlines: true,
        text_color: Color::rgb(60, 60, 60),
        first_slice_angle: 0.0,
        font_size: 10.0,
        title_size: Some(13.0),
    };
    let items = draw_chart(&c, rect, &theme);
    vec![Item::group(Transform::from_translate(rect.x, rect.y), Some(Rect::new(0.0, 0.0, rect.w, rect.h)), items)]
}
