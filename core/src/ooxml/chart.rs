//! Graphiques DrawingML (Excel, PowerPoint, Word) dessinés à partir des valeurs en cache.

use super::drawingml::{self as dml, ColorCtx, Fill, LineDef};
use super::theme::Theme;
use crate::color::Color;
use crate::display::{Item, Paint, Rect, StrokeStyle};
use crate::numfmt;
use crate::package::{parse_xml, NodeExt, Package};
use crate::text::{layout_paragraph, Align, Inline, LayoutCtx, ParaProps, Paragraph, TextStyle};
use roxmltree::Node;
use std::sync::Arc;
use tiny_skia::{PathBuilder, Transform};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ChartKind {
    Bar,
    Column,
    Line,
    Area,
    Pie,
    Doughnut,
    Scatter,
    Radar,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Grouping {
    Clustered,
    Stacked,
    Percent,
}

#[derive(Clone, Debug)]
pub struct Series {
    pub name: String,
    pub values: Vec<Option<f64>>,
    pub xvalues: Vec<Option<f64>>,
    pub color: Option<Color>,
    pub line: Option<LineDef>,
    pub point_colors: Vec<(usize, Color)>,
    pub kind: ChartKind,
    pub grouping: Grouping,
    pub smooth: bool,
    pub markers: bool,
}

#[derive(Clone, Debug)]
pub struct Chart {
    pub title: Option<String>,
    pub categories: Vec<String>,
    pub series: Vec<Series>,
    pub legend: Option<String>,
    pub val_fmt: String,
    pub show_values: bool,
    pub show_percent: bool,
    pub gap_width: f32,
    pub overlap: f32,
    pub hole: f32,
    pub bg: Option<Color>,
    pub border: Option<Color>,
    pub val_min: Option<f64>,
    pub val_max: Option<f64>,
    pub gridlines: bool,
    pub text_color: Color,
    pub first_slice_angle: f32,
    pub font_size: f32,
    pub title_size: Option<f32>,
}

fn cache_strings(n: Option<Node>) -> Vec<String> {
    let Some(n) = n else { return Vec::new() };
    let Some(cache) = n.descendants().find(|d| matches!(d.local(), "strCache" | "numCache")) else {
        // littéraux
        if let Some(lit) = n.descendants().find(|d| matches!(d.local(), "strLit" | "numLit")) {
            return pts(lit).into_iter().map(|(_, v)| v).collect();
        }
        return Vec::new();
    };
    let count = cache.child("ptCount").and_then(|c| c.attr("val")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let p = pts(cache);
    let len = count.max(p.iter().map(|x| x.0 + 1).max().unwrap_or(0));
    let mut out = vec![String::new(); len];
    let fmt = cache.child("formatCode").and_then(|f| f.text()).unwrap_or("General");
    for (i, v) in p {
        if i < len {
            out[i] = if cache.local() == "numCache" { v.parse::<f64>().map(|x| numfmt::format_value(x, fmt, false).0).unwrap_or(v) } else { v };
        }
    }
    // catégories multiniveaux : on prend le premier niveau
    if out.is_empty() {
        if let Some(lvl) = n.descendants().find(|d| d.local() == "lvl") {
            return pts(lvl).into_iter().map(|(_, v)| v).collect();
        }
    }
    out
}

fn pts(n: Node) -> Vec<(usize, String)> {
    n.children_named("pt").map(|p| (p.attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0), p.child("v").and_then(|v| v.text()).unwrap_or("").to_string())).collect()
}

fn cache_numbers(n: Option<Node>) -> Vec<Option<f64>> {
    let Some(n) = n else { return Vec::new() };
    let Some(cache) = n.descendants().find(|d| matches!(d.local(), "numCache" | "numLit")) else { return Vec::new() };
    let count = cache.child("ptCount").and_then(|c| c.attr("val")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let p = pts(cache);
    let len = count.max(p.iter().map(|x| x.0 + 1).max().unwrap_or(0));
    let mut out = vec![None; len];
    for (i, v) in p {
        if i < len {
            out[i] = v.trim().parse::<f64>().ok();
        }
    }
    out
}

fn rich_text(n: Node) -> String {
    let mut s = String::new();
    for p in n.descendants().filter(|d| d.local() == "p") {
        if !s.is_empty() {
            s.push(' ');
        }
        for t in p.descendants().filter(|d| d.local() == "t") {
            s.push_str(t.text().unwrap_or(""));
        }
    }
    s
}

pub fn parse_chart(xml: &str, theme: &Theme) -> Option<Chart> {
    let doc = parse_xml(xml)?;
    let root = doc.root_element();
    let chart = root.child("chart")?;
    let cc = ColorCtx::new(theme);
    let plot = chart.child("plotArea")?;
    let mut c = Chart {
        title: None,
        categories: Vec::new(),
        series: Vec::new(),
        legend: chart.child("legend").map(|l| l.child("legendPos").and_then(|p| p.attr("val")).unwrap_or("r").to_string()),
        val_fmt: "General".into(),
        show_values: false,
        show_percent: false,
        gap_width: 1.5,
        overlap: 0.0,
        hole: 0.5,
        bg: Some(Color::WHITE),
        border: None,
        val_min: None,
        val_max: None,
        gridlines: false,
        text_color: Color::rgb(89, 89, 89),
        first_slice_angle: 0.0,
        font_size: 10.0,
        title_size: None,
    };
    // taille du texte par défaut du graphique
    if let Some(sz) = root.child("txPr").and_then(|t| t.descendants().find(|d| d.local() == "defRPr")).and_then(|d| d.attr("sz")).and_then(|v| v.parse::<f32>().ok()) {
        c.font_size = sz / 100.0;
    }
    if let Some(sz) = chart.child("title").and_then(|t| t.descendants().find(|d| matches!(d.local(), "defRPr" | "rPr") && d.attr("sz").is_some())).and_then(|d| d.attr("sz")).and_then(|v| v.parse::<f32>().ok()) {
        c.title_size = Some(sz / 100.0);
    }
    if let Some(t) = chart.child("title") {
        let txt = t.child("tx").map(rich_text).unwrap_or_default();
        c.title = Some(txt);
    }
    let auto_deleted = chart.child("autoTitleDeleted").and_then(|a| a.attr("val")).map(|v| v == "1" || v == "true").unwrap_or(false);
    if let Some(sp) = root.child("spPr") {
        match dml::parse_fill(sp, &cc) {
            Some(Fill::Solid(col)) => c.bg = Some(col),
            Some(Fill::None) => c.bg = None,
            _ => {}
        }
        if let Some(ln) = sp.child("ln") {
            let mut l = LineDef::default();
            dml::merge_line(&mut l, ln, &cc);
            c.border = l.color;
        }
    }
    let mut idx = 0usize;
    for group in plot.children().filter(|g| g.is_element()) {
        let name = group.local();
        let kind = match name {
            "barChart" | "bar3DChart" => {
                if group.child("barDir").and_then(|b| b.attr("val")) == Some("bar") {
                    ChartKind::Bar
                } else {
                    ChartKind::Column
                }
            }
            "lineChart" | "line3DChart" | "stockChart" => ChartKind::Line,
            "areaChart" | "area3DChart" => ChartKind::Area,
            "pieChart" | "pie3DChart" | "ofPieChart" => ChartKind::Pie,
            "doughnutChart" => ChartKind::Doughnut,
            "scatterChart" | "bubbleChart" => ChartKind::Scatter,
            "radarChart" => ChartKind::Radar,
            "valAx" => {
                if group.child("majorGridlines").is_some() {
                    c.gridlines = true;
                }
                if let Some(f) = group.child("numFmt").and_then(|f| f.attr("formatCode")) {
                    c.val_fmt = f.to_string();
                }
                if let Some(s) = group.child("scaling") {
                    c.val_min = s.child("min").and_then(|m| m.attr("val")).and_then(|v| v.parse().ok());
                    c.val_max = s.child("max").and_then(|m| m.attr("val")).and_then(|v| v.parse().ok());
                }
                continue;
            }
            _ => continue,
        };
        let grouping = match group.child("grouping").and_then(|g| g.attr("val")) {
            Some("stacked") => Grouping::Stacked,
            Some("percentStacked") => Grouping::Percent,
            _ => Grouping::Clustered,
        };
        if let Some(g) = group.child("gapWidth").and_then(|g| g.attr("val")).and_then(|v| v.parse::<f32>().ok()) {
            c.gap_width = g / 100.0;
        }
        if let Some(o) = group.child("overlap").and_then(|g| g.attr("val")).and_then(|v| v.parse::<f32>().ok()) {
            c.overlap = o / 100.0;
        }
        if let Some(h) = group.child("holeSize").and_then(|g| g.attr("val")).and_then(|v| v.parse::<f32>().ok()) {
            c.hole = h / 100.0;
        }
        if let Some(a) = group.child("firstSliceAng").and_then(|g| g.attr("val")).and_then(|v| v.parse::<f32>().ok()) {
            c.first_slice_angle = a;
        }
        if let Some(dl) = group.child("dLbls") {
            c.show_values |= dl.child("showVal").and_then(|v| v.attr("val")).map(|v| v == "1").unwrap_or(false);
            c.show_percent |= dl.child("showPercent").and_then(|v| v.attr("val")).map(|v| v == "1").unwrap_or(false);
        }
        let markers_default = name == "lineChart" && group.child("marker").and_then(|m| m.attr("val")).map(|v| v == "1").unwrap_or(true);
        for ser in group.children_named("ser") {
            let sname = ser.child("tx").map(|t| {
                let s = cache_strings(Some(t));
                if s.is_empty() {
                    t.child("v").and_then(|v| v.text()).unwrap_or("").to_string()
                } else {
                    s.join(" ")
                }
            });
            let cats = cache_strings(ser.child("cat").or_else(|| ser.child("xVal")));
            if c.categories.len() < cats.len() {
                c.categories = cats;
            }
            let values = cache_numbers(ser.child("val").or_else(|| ser.child("yVal")));
            let xvalues = cache_numbers(ser.child("xVal"));
            let mut color = None;
            let mut line = None;
            if let Some(sp) = ser.child("spPr") {
                match dml::parse_fill(sp, &cc) {
                    Some(Fill::Solid(col)) => color = Some(col),
                    Some(Fill::Gradient { stops, .. }) => color = stops.first().map(|s| s.1),
                    _ => {}
                }
                if let Some(ln) = sp.child("ln") {
                    let mut l = LineDef { width: 2.25, ..Default::default() };
                    dml::merge_line(&mut l, ln, &cc);
                    line = Some(l);
                }
            }
            let mut point_colors = Vec::new();
            for dpt in ser.children_named("dPt") {
                let i = dpt.child("idx").and_then(|x| x.attr("val")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                if let Some(Fill::Solid(col)) = dpt.child("spPr").and_then(|s| dml::parse_fill(s, &cc)) {
                    point_colors.push((i, col));
                }
            }
            if let Some(dl) = ser.child("dLbls") {
                c.show_values |= dl.child("showVal").and_then(|v| v.attr("val")).map(|v| v == "1").unwrap_or(false);
                c.show_percent |= dl.child("showPercent").and_then(|v| v.attr("val")).map(|v| v == "1").unwrap_or(false);
            }
            let markers = match ser.child("marker").and_then(|m| m.child("symbol")).and_then(|s| s.attr("val")) {
                Some("none") => false,
                Some(_) => true,
                None => markers_default,
            };
            let smooth = ser.child("smooth").and_then(|s| s.attr("val")).map(|v| v == "1").unwrap_or(false);
            c.series.push(Series { name: sname.unwrap_or_else(|| format!("Série {}", idx + 1)), values, xvalues, color, line, point_colors, kind, grouping, smooth, markers });
            idx += 1;
        }
    }
    if c.series.is_empty() {
        return None;
    }
    if c.title.as_deref() == Some("") {
        // titre automatique : nom de la série unique
        c.title = if c.series.len() == 1 && !auto_deleted { Some(c.series[0].name.clone()) } else { None };
    }
    if c.categories.is_empty() {
        let n = c.series.iter().map(|s| s.values.len()).max().unwrap_or(0);
        c.categories = (1..=n).map(|i| i.to_string()).collect();
    }
    Some(c)
}

pub fn series_color(theme: &Theme, i: usize) -> Color {
    let base = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
    let c = theme.color(base[i % 6]).unwrap_or(Color::rgb(68, 114, 196));
    match i / 6 {
        0 => c,
        1 => c.lum_mod_off(0.6, 0.0),
        2 => c.lum_mod_off(0.6, 0.4),
        _ => c.lum_mod_off(0.8, 0.0),
    }
}

fn text_item(s: &str, size: f32, color: Color, x: f32, y: f32, align: Align, bold: bool) -> (Item, f32, f32) {
    let st = Arc::new(TextStyle { font: Arc::from("Calibri"), size, color, bold, ..Default::default() });
    let p = Paragraph { props: ParaProps { align: Align::Left, widow_control: false, ..Default::default() }, inlines: vec![Inline::Text(s.to_string(), st.clone())], mark: st };
    let l = layout_paragraph(&p, 10000.0, &LayoutCtx::default());
    let w = l.content_width;
    let dx = match align {
        Align::Center => -w / 2.0,
        Align::Right => -w,
        _ => 0.0,
    };
    (Item::group(Transform::from_translate(x + dx, y), None, l.items), w, l.height)
}

fn nice_step(range: f64, target: usize) -> f64 {
    let raw = range / target.max(1) as f64;
    if raw <= 0.0 || !raw.is_finite() {
        return 1.0;
    }
    let mag = 10f64.powf(raw.log10().floor());
    let r = raw / mag;
    let nice = if r <= 1.0 {
        1.0
    } else if r <= 2.0 {
        2.0
    } else if r <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * mag
}

pub fn draw_chart(c: &Chart, rect: Rect, theme: &Theme) -> Vec<Item> {
    let mut items = Vec::new();
    let w = rect.w;
    let h = rect.h;
    let fs = c.font_size.clamp(4.0, 40.0);
    if let Some(bg) = c.bg {
        items.push(Item::FillRect { rect: Rect::new(0.0, 0.0, w, h), color: bg });
    }
    if let Some(b) = c.border {
        if let Some(p) = crate::display::rect_path(Rect::new(0.0, 0.0, w, h)) {
            items.push(Item::Path { path: Arc::new(p), fill: None, stroke: Some(StrokeStyle::new(b, 0.75)) });
        }
    }
    let mut top = 6.0;
    if let Some(t) = &c.title {
        if !t.is_empty() {
            let (it, _, th) = text_item(t, c.title_size.unwrap_or(fs * 1.4), c.text_color, w / 2.0, top, Align::Center, false);
            items.push(it);
            top += th + 4.0;
        }
    }
    let pie = c.series.iter().all(|s| matches!(s.kind, ChartKind::Pie | ChartKind::Doughnut));
    // légende
    let mut right = w - 8.0;
    let mut bottom = h - 6.0;
    let legend_entries: Vec<(String, Color)> = if pie {
        let s = &c.series[0];
        c.categories.iter().enumerate().map(|(i, cat)| (cat.clone(), s.point_colors.iter().find(|p| p.0 == i).map(|p| p.1).unwrap_or_else(|| series_color(theme, i)))).collect()
    } else {
        c.series.iter().enumerate().map(|(i, s)| (s.name.clone(), s.color.or(s.line.as_ref().and_then(|l| l.color)).unwrap_or_else(|| series_color(theme, i)))).collect()
    };
    if let Some(pos) = &c.legend {
        let sw = fs * 0.8;
        if pos == "r" || pos == "l" {
            let maxw = legend_entries.iter().map(|(n, _)| text_item(n, fs, c.text_color, 0.0, 0.0, Align::Left, false).1).fold(0.0, f32::max);
            let lw = maxw + sw + 10.0;
            let total_h = legend_entries.len() as f32 * fs * 1.5;
            let mut y = top + ((bottom - top) - total_h) / 2.0;
            let x = if pos == "r" { w - lw - 4.0 } else { 6.0 };
            for (n, col) in &legend_entries {
                items.push(Item::FillRect { rect: Rect::new(x, y + fs * 0.25, sw, sw), color: *col });
                let (it, _, _) = text_item(n, fs, c.text_color, x + sw + 4.0, y - fs * 0.05, Align::Left, false);
                items.push(it);
                y += fs * 1.5;
            }
            if pos == "r" {
                right = x - 8.0;
            }
        } else {
            let widths: Vec<f32> = legend_entries.iter().map(|(n, _)| text_item(n, fs, c.text_color, 0.0, 0.0, Align::Left, false).1 + sw + 14.0).collect();
            let total: f32 = widths.iter().sum();
            let mut x = (w - total) / 2.0;
            let y = if pos == "t" { top } else { h - fs * 1.8 };
            for ((n, col), lw) in legend_entries.iter().zip(widths) {
                items.push(Item::FillRect { rect: Rect::new(x, y + fs * 0.25, sw, sw), color: *col });
                let (it, _, _) = text_item(n, fs, c.text_color, x + sw + 4.0, y - fs * 0.05, Align::Left, false);
                items.push(it);
                x += lw;
            }
            if pos == "t" {
                top += fs * 1.8;
            } else {
                bottom = h - fs * 2.2;
            }
        }
    }
    let area = Rect::new(8.0, top + 4.0, (right - 8.0).max(10.0), (bottom - top - 4.0).max(10.0));
    if pie {
        draw_pie(c, area, theme, fs, &mut items);
        return items;
    }
    // échelle des valeurs
    let ncat = c.categories.len().max(c.series.iter().map(|s| s.values.len()).max().unwrap_or(0)).max(1);
    let stacked = c.series.iter().any(|s| s.grouping != Grouping::Clustered && matches!(s.kind, ChartKind::Bar | ChartKind::Column | ChartKind::Area | ChartKind::Line));
    let percent = c.series.iter().any(|s| s.grouping == Grouping::Percent);
    let mut vmin: f64 = 0.0;
    let mut vmax: f64 = 0.0;
    if stacked {
        for i in 0..ncat {
            let (mut pos, mut neg) = (0.0, 0.0);
            for s in &c.series {
                let v = s.values.get(i).copied().flatten().unwrap_or(0.0);
                if v >= 0.0 {
                    pos += v
                } else {
                    neg += v
                }
            }
            vmax = vmax.max(pos);
            vmin = vmin.min(neg);
        }
        if percent {
            vmax = 1.0;
            vmin = 0.0;
        }
    } else {
        let all: Vec<f64> = c.series.iter().flat_map(|s| s.values.iter().flatten().copied()).collect();
        vmax = all.iter().cloned().fold(f64::MIN, f64::max).max(0.0);
        vmin = all.iter().cloned().fold(f64::MAX, f64::min).min(0.0);
        if all.is_empty() {
            vmax = 1.0;
        }
    }
    let scatter = c.series.iter().any(|s| s.kind == ChartKind::Scatter);
    // comme Excel : 5 % de marge puis graduation « ronde » (1, 2 ou 5 × 10^n)
    if !percent {
        let span = vmax - vmin;
        if vmax > 0.0 {
            vmax += 0.05 * span;
        }
        if vmin < 0.0 {
            vmin -= 0.05 * span;
        }
    }
    let step = nice_step(vmax - vmin, 8);
    let mut lo = (vmin / step).floor() * step;
    let mut hi = (vmax / step).ceil() * step;
    if hi <= lo {
        hi = lo + step;
    }
    if (hi - vmax).abs() < 1e-12 && !percent && vmax > 0.0 && hi == vmax {
        // Excel laisse une graduation au-dessus du maximum s'il tombe pile
    }
    if let Some(m) = c.val_min {
        lo = m;
    }
    if let Some(m) = c.val_max {
        hi = m;
    }
    let horizontal = c.series.iter().all(|s| s.kind == ChartKind::Bar);
    let fmt = if percent { "0%".to_string() } else { c.val_fmt.clone() };
    // libellés de l'axe des valeurs
    let mut ticks = Vec::new();
    let mut v = lo;
    let mut guard = 0;
    while v <= hi + step * 1e-6 && guard < 50 {
        ticks.push(v);
        v += step;
        guard += 1;
    }
    let labels: Vec<String> = ticks.iter().map(|t| numfmt::format_value(*t, &fmt, false).0).collect();
    let label_w = labels.iter().map(|l| text_item(l, fs, c.text_color, 0.0, 0.0, Align::Left, false).1).fold(0.0, f32::max);
    let cat_h = fs * 1.6;
    let axis_color = Color::rgb(191, 191, 191);
    let grid_color = Color::rgb(217, 217, 217);
    let plot = if horizontal {
        let cat_w = c.categories.iter().map(|l| text_item(l, fs, c.text_color, 0.0, 0.0, Align::Left, false).1).fold(0.0, f32::max).min(area.w * 0.3);
        Rect::new(area.x + cat_w + 6.0, area.y, area.w - cat_w - 6.0, area.h - cat_h)
    } else {
        Rect::new(area.x + label_w + 6.0, area.y + fs * 0.5, area.w - label_w - 6.0, area.h - cat_h - fs * 0.5)
    };
    let to_px = |val: f64| -> f32 {
        let t = ((val - lo) / (hi - lo)) as f32;
        if horizontal {
            plot.x + t * plot.w
        } else {
            plot.bottom() - t * plot.h
        }
    };
    // quadrillage et graduations
    for (t, l) in ticks.iter().zip(labels.iter()) {
        let p = to_px(*t);
        if horizontal {
            items.push(Item::Line { x1: p, y1: plot.y, x2: p, y2: plot.bottom(), stroke: StrokeStyle::new(grid_color, 0.75) });
            let (it, _, _) = text_item(l, fs, c.text_color, p, plot.bottom() + 2.0, Align::Center, false);
            items.push(it);
        } else {
            if c.gridlines || true {
                items.push(Item::Line { x1: plot.x, y1: p, x2: plot.right(), y2: p, stroke: StrokeStyle::new(grid_color, 0.75) });
            }
            let (it, _, th) = text_item(l, fs, c.text_color, plot.x - 4.0, p, Align::Right, false);
            items.push(Item::group(Transform::from_translate(0.0, -th / 2.0), None, vec![it]));
        }
    }
    // axe des catégories
    let zero = to_px(0.0f64.clamp(lo, hi));
    if horizontal {
        items.push(Item::Line { x1: zero, y1: plot.y, x2: zero, y2: plot.bottom(), stroke: StrokeStyle::new(axis_color, 0.75) });
    } else {
        items.push(Item::Line { x1: plot.x, y1: zero, x2: plot.right(), y2: zero, stroke: StrokeStyle::new(axis_color, 0.75) });
    }
    let band = if horizontal { plot.h / ncat as f32 } else { plot.w / ncat as f32 };
    let every = ((fs * 4.0) / band).ceil().max(1.0) as usize;
    if !scatter {
        for (i, cat) in c.categories.iter().enumerate() {
            if horizontal {
                let y = plot.bottom() - (i as f32 + 0.5) * band;
                let (it, _, th) = text_item(cat, fs, c.text_color, plot.x - 4.0, y, Align::Right, false);
                items.push(Item::group(Transform::from_translate(0.0, -th / 2.0), None, vec![it]));
            } else if i % every == 0 {
                let x = plot.x + (i as f32 + 0.5) * band;
                let (it, _, _) = text_item(cat, fs, c.text_color, x, plot.bottom() + 2.0, Align::Center, false);
                items.push(it);
            }
        }
    }
    // séries en barres
    let bar_series: Vec<(usize, &Series)> = c.series.iter().enumerate().filter(|(_, s)| matches!(s.kind, ChartKind::Bar | ChartKind::Column)).collect();
    if !bar_series.is_empty() {
        let n = bar_series.len() as f32;
        let gap = c.gap_width;
        let bar_stacked = bar_series.iter().any(|(_, s)| s.grouping != Grouping::Clustered);
        let per = if bar_stacked { 1.0 } else { n - (n - 1.0) * c.overlap.max(0.0) };
        let bw = band / (per + gap);
        for i in 0..ncat {
            let mut pos_acc = 0.0f64;
            let mut neg_acc = 0.0f64;
            let total: f64 = if percent { bar_series.iter().map(|(_, s)| s.values.get(i).copied().flatten().unwrap_or(0.0).abs()).sum::<f64>().max(1e-12) } else { 1.0 };
            for (k, (si, s)) in bar_series.iter().enumerate() {
                let Some(val) = s.values.get(i).copied().flatten() else { continue };
                let val = val / total;
                let col = s.point_colors.iter().find(|p| p.0 == i).map(|p| p.1).or(s.color).unwrap_or_else(|| series_color(theme, *si));
                let (a, b) = if bar_stacked {
                    if val >= 0.0 {
                        let r = (pos_acc, pos_acc + val);
                        pos_acc += val;
                        r
                    } else {
                        let r = (neg_acc + val, neg_acc);
                        neg_acc += val;
                        r
                    }
                } else {
                    (0.0f64.min(val), 0.0f64.max(val))
                };
                let offset = if bar_stacked { 0.0 } else { k as f32 * bw * (1.0 - c.overlap.max(0.0)) };
                let start = band * i as f32 + bw * gap / 2.0 + offset;
                let r = if horizontal {
                    let y = plot.bottom() - start - bw;
                    let x1 = to_px(a.clamp(lo, hi));
                    let x2 = to_px(b.clamp(lo, hi));
                    Rect::new(x1, y, x2 - x1, bw)
                } else {
                    let x = plot.x + start;
                    let y1 = to_px(b.clamp(lo, hi));
                    let y2 = to_px(a.clamp(lo, hi));
                    Rect::new(x, y1, bw, y2 - y1)
                };
                items.push(Item::FillRect { rect: r, color: col });
                if c.show_values {
                    let txt = numfmt::format_value(val, &c.val_fmt, false).0;
                    let (it, _, th) = if horizontal { text_item(&txt, fs * 0.9, c.text_color, r.right() + 2.0, r.y + r.h / 2.0, Align::Left, false) } else { text_item(&txt, fs * 0.9, c.text_color, r.x + r.w / 2.0, r.y - fs * 1.3, Align::Center, false) };
                    items.push(Item::group(Transform::from_translate(0.0, if horizontal { -th / 2.0 } else { 0.0 }), None, vec![it]));
                }
            }
        }
    }
    // aires, courbes, nuages de points
    let mut stack_base = vec![0.0f64; ncat];
    for (si, s) in c.series.iter().enumerate() {
        if !matches!(s.kind, ChartKind::Line | ChartKind::Area | ChartKind::Scatter | ChartKind::Radar) {
            continue;
        }
        let col = s.line.as_ref().and_then(|l| l.color).or(s.color).unwrap_or_else(|| series_color(theme, si));
        let lw = s.line.as_ref().map(|l| l.width).unwrap_or(2.25);
        let xs: Vec<f64> = s.xvalues.iter().map(|x| x.unwrap_or(0.0)).collect();
        let (xmin, xmax) = if s.kind == ChartKind::Scatter && !xs.is_empty() { (xs.iter().cloned().fold(f64::MAX, f64::min), xs.iter().cloned().fold(f64::MIN, f64::max)) } else { (0.0, 1.0) };
        let mut pts: Vec<(f32, f32)> = Vec::new();
        for i in 0..s.values.len().min(if s.kind == ChartKind::Scatter { usize::MAX } else { ncat }) {
            let Some(mut v) = s.values[i] else { continue };
            if stacked && s.kind != ChartKind::Scatter {
                v += stack_base[i.min(ncat - 1)];
                stack_base[i.min(ncat - 1)] = v;
            }
            let x = if s.kind == ChartKind::Scatter && xmax > xmin { plot.x + ((xs.get(i).copied().unwrap_or(0.0) - xmin) / (xmax - xmin)) as f32 * plot.w } else { plot.x + (i as f32 + 0.5) * band };
            pts.push((x, to_px(v.clamp(lo, hi))));
        }
        if pts.is_empty() {
            continue;
        }
        if s.kind == ChartKind::Area {
            let mut pb = PathBuilder::new();
            pb.move_to(pts[0].0, zero);
            for p in &pts {
                pb.line_to(p.0, p.1);
            }
            pb.line_to(pts[pts.len() - 1].0, zero);
            pb.close();
            if let Some(p) = pb.finish() {
                items.push(Item::Path { path: Arc::new(p), fill: Some(Paint::Solid(s.color.unwrap_or(col))), stroke: None });
            }
            continue;
        }
        let draw_line = !(s.kind == ChartKind::Scatter && s.line.as_ref().map(|l| l.color.is_none()).unwrap_or(false));
        if draw_line && pts.len() > 1 {
            let mut pb = PathBuilder::new();
            pb.move_to(pts[0].0, pts[0].1);
            for i in 1..pts.len() {
                if s.smooth {
                    let p0 = pts[i - 1];
                    let p1 = pts[i];
                    let mx = (p0.0 + p1.0) / 2.0;
                    pb.cubic_to(mx, p0.1, mx, p1.1, p1.0, p1.1);
                } else {
                    pb.line_to(pts[i].0, pts[i].1);
                }
            }
            if let Some(p) = pb.finish() {
                items.push(Item::Path { path: Arc::new(p), fill: None, stroke: Some(StrokeStyle::new(col, lw)) });
            }
        }
        if s.markers || s.kind == ChartKind::Scatter {
            let r = (lw * 1.6).max(2.5);
            for p in &pts {
                let mut pb = PathBuilder::new();
                if let Some(rr) = tiny_skia::Rect::from_xywh(p.0 - r, p.1 - r, 2.0 * r, 2.0 * r) {
                    pb.push_oval(rr);
                }
                if let Some(path) = pb.finish() {
                    items.push(Item::Path { path: Arc::new(path), fill: Some(Paint::Solid(col)), stroke: None });
                }
            }
        }
        if c.show_values {
            for (i, p) in pts.iter().enumerate() {
                if let Some(v) = s.values.get(i).copied().flatten() {
                    let txt = numfmt::format_value(v, &c.val_fmt, false).0;
                    let (it, _, _) = text_item(&txt, fs * 0.9, c.text_color, p.0, p.1 - fs * 1.5, Align::Center, false);
                    items.push(it);
                }
            }
        }
    }
    items
}

fn draw_pie(c: &Chart, area: Rect, theme: &Theme, fs: f32, items: &mut Vec<Item>) {
    let s = &c.series[0];
    let total: f64 = s.values.iter().flatten().filter(|v| **v > 0.0).sum();
    if total <= 0.0 {
        return;
    }
    let r = (area.w.min(area.h) / 2.0 - 4.0).max(5.0);
    let cx = area.x + area.w / 2.0;
    let cy = area.y + area.h / 2.0;
    let mut ang = (c.first_slice_angle - 90.0).to_radians();
    let doughnut = s.kind == ChartKind::Doughnut;
    for (i, v) in s.values.iter().enumerate() {
        let Some(v) = v else { continue };
        if *v <= 0.0 {
            continue;
        }
        let sweep = (*v / total) as f32 * std::f32::consts::TAU;
        let col = s.point_colors.iter().find(|p| p.0 == i).map(|p| p.1).unwrap_or_else(|| series_color(theme, i));
        let mut pb = PathBuilder::new();
        let segs = ((sweep / 0.2).ceil() as usize).max(2);
        if doughnut {
            let ri = r * c.hole;
            pb.move_to(cx + r * ang.cos(), cy + r * ang.sin());
            for k in 1..=segs {
                let a = ang + sweep * k as f32 / segs as f32;
                pb.line_to(cx + r * a.cos(), cy + r * a.sin());
            }
            for k in (0..=segs).rev() {
                let a = ang + sweep * k as f32 / segs as f32;
                pb.line_to(cx + ri * a.cos(), cy + ri * a.sin());
            }
        } else {
            pb.move_to(cx, cy);
            for k in 0..=segs {
                let a = ang + sweep * k as f32 / segs as f32;
                pb.line_to(cx + r * a.cos(), cy + r * a.sin());
            }
        }
        pb.close();
        if let Some(p) = pb.finish() {
            items.push(Item::Path { path: Arc::new(p), fill: Some(Paint::Solid(col)), stroke: Some(StrokeStyle::new(Color::WHITE, 1.0)) });
        }
        if c.show_values || c.show_percent {
            let mid = ang + sweep / 2.0;
            let lr = if doughnut { r * (1.0 + c.hole) / 2.0 } else { r * 0.65 };
            let txt = if c.show_percent { format!("{:.0} %", *v / total * 100.0) } else { numfmt::format_value(*v, &c.val_fmt, false).0 };
            let (it, _, th) = text_item(&txt, fs, if col.luminance() < 0.5 { Color::WHITE } else { Color::BLACK }, cx + lr * mid.cos(), cy + lr * mid.sin(), Align::Center, false);
            items.push(Item::group(Transform::from_translate(0.0, -th / 2.0), None, vec![it]));
        }
        ang += sweep;
    }
}

pub fn render_chart(pkg: &Package, path: &str, rect: Rect, theme: &Theme) -> Vec<Item> {
    // le graphique peut avoir son propre thème (couleurs)
    let theme_override = pkg.rels(path).values().find(|r| r.kind == "themeOverride").map(|r| Theme::load(pkg, &r.target));
    let theme = theme_override.as_ref().unwrap_or(theme);
    let Some(xml) = pkg.read_string(path) else { return vec![Item::Placeholder { rect, label: "graphique".into() }] };
    match parse_chart(&xml, theme) {
        Some(c) => {
            let items = draw_chart(&c, rect, theme);
            vec![Item::group(Transform::from_translate(rect.x, rect.y), Some(Rect::new(0.0, 0.0, rect.w, rect.h)), items)]
        }
        None => vec![Item::Placeholder { rect, label: "graphique".into() }],
    }
}
