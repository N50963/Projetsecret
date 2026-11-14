//! Présentations OpenDocument (.odp, .otp).

use super::*;
use crate::display::{DashStyle, Item, Page, Paint, Rect, StrokeStyle};
use crate::flow::{self, Block, Table, TableCell, TableRow};
use crate::ooxml::drawingml as dml;
use crate::package::Package;
use tiny_skia::{PathBuilder, Transform};

struct Ctx<'p> {
    pkg: &'p Package,
    styles: Styles,
    page_no: u32,
    default_text: TextStyle,
}

/// Correspondance des formes ODF vers les géométries prédéfinies DrawingML.
fn geom_name(t: &str) -> &str {
    if let Some(o) = t.strip_prefix("ooxml-") {
        return o;
    }
    match t {
        "rectangle" | "frame" | "flowchart-process" => "rect",
        "round-rectangle" | "flowchart-alternate-process" => "roundRect",
        "ellipse" | "circle" | "flowchart-connector" => "ellipse",
        "isosceles-triangle" => "triangle",
        "right-triangle" => "rtTriangle",
        "diamond" | "flowchart-decision" => "diamond",
        "parallelogram" | "flowchart-data" => "parallelogram",
        "trapezoid" | "flowchart-manual-operation" => "trapezoid",
        "hexagon" | "flowchart-preparation" => "hexagon",
        "octagon" => "octagon",
        "pentagon" => "pentagon",
        "right-arrow" => "rightArrow",
        "left-arrow" => "leftArrow",
        "up-arrow" => "upArrow",
        "down-arrow" => "downArrow",
        "left-right-arrow" => "leftRightArrow",
        "up-down-arrow" => "upDownArrow",
        "star4" => "star4",
        "star5" => "star5",
        "star6" => "star6",
        "star8" => "star8",
        "star12" => "star12",
        "star24" => "star24",
        "chevron" => "chevron",
        "pentagon-right" => "homePlate",
        "cross" => "plus",
        "can" | "flowchart-magnetic-disk" => "can",
        "cube" => "cube",
        "heart" => "heart",
        "sun" => "sun",
        "moon" => "moon",
        "lightning" => "lightningBolt",
        "smiley" => "smileyFace",
        "ring" => "donut",
        "flowchart-terminator" => "flowChartTerminator",
        "flowchart-document" => "flowChartDocument",
        "flowchart-multidocument" => "flowChartMultidocument",
        "flowchart-predefined-process" => "flowChartPredefinedProcess",
        "flowchart-manual-input" => "flowChartManualInput",
        "flowchart-off-page-connector" => "flowChartOffpageConnector",
        "flowchart-delay" => "flowChartDelay",
        "flowchart-merge" => "flowChartMerge",
        "flowchart-extract" => "flowChartExtract",
        "flowchart-sort" => "flowChartSort",
        "flowchart-or" => "flowChartOr",
        "flowchart-card" => "flowChartPunchedCard",
        "rectangular-callout" => "wedgeRectCallout",
        "round-rectangular-callout" => "wedgeRoundRectCallout",
        "round-callout" => "wedgeEllipseCallout",
        "cloud-callout" | "cloud" => "cloud",
        "left-bracket" => "leftBracket",
        "right-bracket" => "rightBracket",
        "left-brace" => "leftBrace",
        "right-brace" => "rightBrace",
        "quad-bevel" => "bevel",
        "paper" => "foldedCorner",
        "block-arc" => "blockArc",
        _ => "rect",
    }
}

fn parse_transform(s: &str) -> Transform {
    // « rotate (0.5) translate (2cm 3cm) »
    let mut t = Transform::identity();
    let mut rest = s;
    while let Some(i) = rest.find('(') {
        let name = rest[..i].trim();
        let Some(j) = rest[i..].find(')') else { break };
        let args: Vec<f32> = rest[i + 1..i + j].split(|c: char| c == ' ' || c == ',').filter(|x| !x.is_empty()).map(|x| crate::package::parse_length(x).unwrap_or(0.0)).collect();
        let step = match name {
            "rotate" => Transform::from_rotate(-args.first().copied().unwrap_or(0.0).to_degrees()),
            "translate" => Transform::from_translate(args.first().copied().unwrap_or(0.0), args.get(1).copied().unwrap_or(0.0)),
            "scale" => Transform::from_scale(args.first().copied().unwrap_or(1.0), args.get(1).copied().or(args.first().copied()).unwrap_or(1.0)),
            "skewX" => Transform::from_row(1.0, 0.0, args.first().copied().unwrap_or(0.0).tan(), 1.0, 0.0, 0.0),
            _ => Transform::identity(),
        };
        // les transformations ODF s'appliquent de gauche à droite
        t = t.post_concat(step);
        rest = &rest[i + j + 1..];
    }
    t
}

fn svg_path(d: &str, vb: [f32; 4], w: f32, h: f32) -> Option<tiny_skia::Path> {
    let sx = if vb[2] > 0.0 { w / vb[2] } else { 1.0 };
    let sy = if vb[3] > 0.0 { h / vb[3] } else { 1.0 };
    let mut pb = PathBuilder::new();
    let mut nums: Vec<f32> = Vec::new();
    let mut cmd = 'M';
    let mut cur = (0.0f32, 0.0f32);
    let mut start = (0.0f32, 0.0f32);
    let tokens = tokenize_path(d);
    let flush = |cmd: char, nums: &mut Vec<f32>, pb: &mut PathBuilder, cur: &mut (f32, f32), start: &mut (f32, f32)| {
        let tx = |x: f32| (x - vb[0]) * sx;
        let ty = |y: f32| (y - vb[1]) * sy;
        let rel = cmd.is_lowercase();
        let mut i = 0;
        let up = cmd.to_ascii_uppercase();
        let need = match up {
            'M' | 'L' | 'T' => 2,
            'H' | 'V' => 1,
            'C' => 6,
            'S' | 'Q' => 4,
            'A' => 7,
            _ => 0,
        };
        if need == 0 {
            if up == 'Z' {
                pb.close();
                *cur = *start;
            }
            nums.clear();
            return;
        }
        let mut first = true;
        while i + need <= nums.len() {
            let a = &nums[i..i + need];
            let (ox, oy) = if rel { *cur } else { (0.0, 0.0) };
            match up {
                'M' => {
                    let p = (a[0] + ox, a[1] + oy);
                    if first {
                        pb.move_to(tx(p.0), ty(p.1));
                        *start = p;
                    } else {
                        pb.line_to(tx(p.0), ty(p.1));
                    }
                    *cur = p;
                }
                'L' | 'T' => {
                    let p = (a[0] + ox, a[1] + oy);
                    pb.line_to(tx(p.0), ty(p.1));
                    *cur = p;
                }
                'H' => {
                    let p = (a[0] + if rel { cur.0 } else { 0.0 }, cur.1);
                    pb.line_to(tx(p.0), ty(p.1));
                    *cur = p;
                }
                'V' => {
                    let p = (cur.0, a[0] + if rel { cur.1 } else { 0.0 });
                    pb.line_to(tx(p.0), ty(p.1));
                    *cur = p;
                }
                'C' => {
                    let p = (a[4] + ox, a[5] + oy);
                    pb.cubic_to(tx(a[0] + ox), ty(a[1] + oy), tx(a[2] + ox), ty(a[3] + oy), tx(p.0), ty(p.1));
                    *cur = p;
                }
                'S' | 'Q' => {
                    let p = (a[2] + ox, a[3] + oy);
                    pb.quad_to(tx(a[0] + ox), ty(a[1] + oy), tx(p.0), ty(p.1));
                    *cur = p;
                }
                'A' => {
                    let p = (a[5] + ox, a[6] + oy);
                    pb.line_to(tx(p.0), ty(p.1));
                    *cur = p;
                }
                _ => {}
            }
            first = false;
            i += need;
        }
        nums.clear();
    };
    for tok in tokens {
        match tok {
            Tok::Cmd(c) => {
                flush(cmd, &mut nums, &mut pb, &mut cur, &mut start);
                cmd = c;
                if c.eq_ignore_ascii_case(&'z') {
                    flush(cmd, &mut nums, &mut pb, &mut cur, &mut start);
                }
            }
            Tok::Num(v) => nums.push(v),
        }
    }
    flush(cmd, &mut nums, &mut pb, &mut cur, &mut start);
    pb.finish()
}

enum Tok {
    Cmd(char),
    Num(f32),
}

fn tokenize_path(d: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let b: Vec<char> = d.chars().collect();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphabetic() && c != 'e' && c != 'E' {
            out.push(Tok::Cmd(c));
            i += 1;
        } else if c.is_ascii_digit() || c == '-' || c == '.' || c == '+' {
            let st = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == '.' || b[i] == 'e' || b[i] == 'E' || ((b[i] == '-' || b[i] == '+') && (b[i - 1] == 'e' || b[i - 1] == 'E'))) {
                i += 1;
            }
            let s: String = b[st..i].iter().collect();
            if let Ok(v) = s.parse() {
                out.push(Tok::Num(v));
            }
        } else {
            i += 1;
        }
    }
    out
}

impl<'p> Ctx<'p> {
    fn graphic(&self, n: Node) -> Arc<StyleDef> {
        if let Some(s) = n.attr("style-name") {
            if n.attributes().any(|a| a.name() == "style-name" && a.namespace().map(|ns| ns.contains("presentation")).unwrap_or(false)) {
                return self.styles.get("presentation", Some(s));
            }
            let st = self.styles.get("graphic", Some(s));
            return st;
        }
        if let Some(s) = n.attributes().find(|a| a.name() == "style-name").map(|a| a.value()) {
            return self.styles.get("presentation", Some(s));
        }
        self.styles.get("graphic", None)
    }

    fn fill_paint(&self, g: &Props, rect: Rect) -> Option<Paint> {
        let fill = g.get("fill").map(|s| s.as_str()).unwrap_or("none");
        match fill {
            "solid" => {
                let c = color(g, "fill-color").unwrap_or(Color::rgb(114, 159, 207));
                let alpha = g.get("opacity").and_then(|o| o.trim_end_matches('%').parse::<f32>().ok()).map(|v| v / 100.0).unwrap_or(1.0);
                Paint::solid(c.with_alpha(alpha))
            }
            "gradient" => {
                let gname = g.get("fill-gradient-name")?;
                let gp = self.styles.gradients.get(gname)?;
                let c1 = gp.get("start-color").and_then(|c| Color::from_hex(c)).unwrap_or(Color::WHITE);
                let c2 = gp.get("end-color").and_then(|c| Color::from_hex(c)).unwrap_or(Color::BLACK);
                let angle = gp.get("angle").map(|a| a.trim_end_matches("deg").parse::<f32>().unwrap_or(0.0)).unwrap_or(0.0);
                let angle = if gp.get("angle").map(|a| a.ends_with("deg")).unwrap_or(false) { angle } else { angle / 10.0 };
                let style = gp.get("style").map(|s| s.as_str()).unwrap_or("linear");
                let stops = if style == "axial" { vec![(0.0, c2), (0.5, c1), (1.0, c2)] } else { vec![(0.0, c1), (1.0, c2)] };
                if style == "radial" || style == "ellipsoid" {
                    return Some(Paint::Radial { cx: rect.x + rect.w / 2.0, cy: rect.y + rect.h / 2.0, r: (rect.w.max(rect.h)) / 1.4, stops: vec![(0.0, c2), (1.0, c1)] });
                }
                let a = (90.0 - angle).to_radians();
                let (dx, dy) = (a.cos(), a.sin());
                let half = (rect.w * dx.abs() + rect.h * dy.abs()) / 2.0;
                let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
                Some(Paint::Linear { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half, stops })
            }
            "bitmap" => {
                let name = g.get("fill-image-name")?;
                let href = self.styles.fill_images.get(name)?;
                let img = self.pkg.image(href)?;
                Some(Paint::Image { image: img, rect, alpha: 1.0 })
            }
            "hatch" => Paint::solid(color(g, "fill-color").unwrap_or(Color::rgb(220, 220, 220))),
            _ => None,
        }
    }

    fn stroke(&self, g: &Props) -> Option<StrokeStyle> {
        let st = g.get("stroke").map(|s| s.as_str()).unwrap_or("solid");
        if st == "none" {
            return None;
        }
        let c = color(g, "stroke-color").unwrap_or(Color::rgb(52, 101, 164));
        let w = len(g, "stroke-width").unwrap_or(0.0).max(0.5);
        let alpha = g.get("stroke-opacity").and_then(|o| o.trim_end_matches('%').parse::<f32>().ok()).map(|v| v / 100.0).unwrap_or(1.0);
        Some(StrokeStyle { color: c.with_alpha(alpha), width: w, dash: if st == "dash" { DashStyle::Dash } else { DashStyle::Solid } })
    }

    /// Paragraphes d'une zone de texte (text:p, text:list).
    fn text_blocks(&self, n: Node, base_style: &Arc<StyleDef>, level_styles: &dyn Fn(usize) -> Option<Arc<StyleDef>>, outline: bool) -> Vec<Paragraph> {
        let mut out = Vec::new();
        let base_text = self.styles.apply_text(&self.default_text, &base_style.text);
        let base_para = self.styles.apply_para(&ParaProps { line: LineSpacing::Multiple(1.0), widow_control: false, pp_line_mode: true, ..Default::default() }, &base_style.para, &[]);
        let list_levels: Option<Vec<ListLevel>> = base_style.list_style.as_ref().and_then(|k| self.styles.lists.get(k).cloned());
        self.collect_paras(n, &base_text, &base_para, 0, None, list_levels.as_ref(), level_styles, outline, &mut out, &mut vec![0; 10]);
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_paras(&self, n: Node, base_text: &TextStyle, base_para: &ParaProps, level: usize, list: Option<&str>, inherited_levels: Option<&Vec<ListLevel>>, level_styles: &dyn Fn(usize) -> Option<Arc<StyleDef>>, outline: bool, out: &mut Vec<Paragraph>, counters: &mut Vec<i32>) {
        for c in n.children().filter(|c| c.is_element()) {
            match c.local() {
                "p" | "h" => {
                    let in_list = list.is_some();
                    // style du niveau de plan
                    let (mut bt, mut bp) = (base_text.clone(), base_para.clone());
                    if in_list && level > 0 {
                        if let Some(ls) = level_styles(level + 1) {
                            bt = self.styles.apply_text(&bt, &ls.text);
                            bp = self.styles.apply_para(&bp, &ls.para, &[]);
                        }
                    }
                    let ps = self.styles.get("paragraph", c.attr("style-name"));
                    let mut props = self.styles.apply_para(&bp, &ps.para, &[]);
                    let ts = Arc::new(self.styles.apply_text(&bt, &ps.text));
                    let mut inlines = Vec::new();
                    let mut last = true;
                    walk_text(self, c, &ts, &mut inlines, &mut last);
                    // puce / numéro
                    let has_text = inlines.iter().any(|i| matches!(i, Inline::Text(t, _) if !t.trim().is_empty()));
                    if in_list && has_text {
                        let levels = list.and_then(|l| self.styles.lists.get(l).cloned()).or_else(|| inherited_levels.cloned());
                        let lvl = levels.as_ref().and_then(|v| v.get(level.min(9)).cloned()).unwrap_or(ListLevel { bullet: Some("●".into()), margin_left: 18.0 * (level as f32 + 1.0), text_indent: -18.0, ..Default::default() });
                        let label = if let Some(b) = &lvl.bullet {
                            Some(b.clone())
                        } else if let Some(f) = lvl.num_format.as_ref().filter(|f| !f.is_empty()) {
                            counters[level.min(9)] += 1;
                            Some(format!("{}{}{}", lvl.prefix, format_num(lvl.start - 1 + counters[level.min(9)], f), lvl.suffix))
                        } else {
                            None
                        };
                        if lvl.margin_left > 0.0 || lvl.text_indent != 0.0 {
                            props.ind_left = lvl.margin_left;
                            props.ind_first = lvl.text_indent;
                        }
                        if let Some(l) = label {
                            let mut st = self.styles.apply_text(&ts, &lvl.text);
                            if let Some(pct) = lvl.text.get("font-size").and_then(|v| v.strip_suffix('%')).and_then(|v| v.parse::<f32>().ok()) {
                                st.size = ts.size * pct / 100.0;
                            }
                            st.underline = false;
                            let st = Arc::new(st);
                            let mut v = vec![Inline::Text(l, st.clone())];
                            v.push(if props.ind_first < 0.0 { Inline::Tab(st) } else { Inline::Text(" ".into(), st) });
                            v.extend(inlines);
                            inlines = v;
                        }
                    }
                    let _ = outline;
                    out.push(Paragraph { props, inlines, mark: ts });
                }
                "list" => {
                    let style = c.attr("style-name").or(list);
                    for item in c.children().filter(|x| x.is_element() && matches!(x.local(), "list-item" | "list-header")) {
                        let next = if level == 0 && list.is_none() { 0 } else { level + 1 };
                        let next = if list.is_none() { 0 } else { next };
                        self.collect_paras(item, base_text, base_para, if list.is_none() { 0 } else { next }, style.or(Some("")), inherited_levels, level_styles, outline, out, counters);
                    }
                }
                "list-item" | "list-header" => self.collect_paras(c, base_text, base_para, level, list, inherited_levels, level_styles, outline, out, counters),
                _ => {}
            }
        }
    }

    fn text_layout(&self, n: Node, rect: Rect, style: &Arc<StyleDef>, master: &str, class: Option<&str>) -> Vec<Item> {
        let g = &style.graphic;
        let master = master.to_string();
        let styles = &self.styles;
        let level_styles = move |lvl: usize| -> Option<Arc<StyleDef>> {
            let name = format!("{master}-outline{lvl}");
            styles.map.contains_key(&("presentation".to_string(), name.clone())).then(|| styles.get("presentation", Some(&name)))
        };
        let outline = class == Some("outline");
        let paras = self.text_blocks(n, style, &level_styles, outline);
        if paras.iter().all(|p| p.inlines.is_empty()) {
            return Vec::new();
        }
        let pad = len(g, "padding");
        let pl = len(g, "padding-left").or(pad).unwrap_or(7.2);
        let pr = len(g, "padding-right").or(pad).unwrap_or(7.2);
        let pt = len(g, "padding-top").or(pad).unwrap_or(3.6);
        let pb = len(g, "padding-bottom").or(pad).unwrap_or(3.6);
        let no_wrap = g.get("wrap-option").map(|v| v == "no-wrap").unwrap_or(false);
        let inner_w = if no_wrap { 10000.0 } else { (rect.w - pl - pr).max(4.0) };
        // réduction automatique du texte (fo:font-scale / shrink-to-fit)
        let mut paras = paras;
        let shrink = g.get("shrink-to-fit").map(|v| v == "true").unwrap_or(false) || g.get("fit-to-size").map(|v| v == "shrink-to-fit" || v == "autofit").unwrap_or(false);
        let blocks: Vec<Block> = paras.iter().cloned().map(Block::Para).collect();
        let mut frag = flow::stack_blocks(&blocks, inner_w, &LayoutCtx::default());
        if shrink && frag.height > rect.h - pt - pb {
            for _ in 0..8 {
                let k = ((rect.h - pt - pb) / frag.height).clamp(0.5, 0.97);
                for p in paras.iter_mut() {
                    for i in p.inlines.iter_mut() {
                        match i {
                            Inline::Text(_, s) | Inline::Tab(s) | Inline::LineBreak(s) => {
                                let mut s2 = (**s).clone();
                                s2.size *= k;
                                *s = Arc::new(s2);
                            }
                            _ => {}
                        }
                    }
                    let mut m = (*p.mark).clone();
                    m.size *= k;
                    p.mark = Arc::new(m);
                }
                let blocks: Vec<Block> = paras.iter().cloned().map(Block::Para).collect();
                frag = flow::stack_blocks(&blocks, inner_w, &LayoutCtx::default());
                if frag.height <= rect.h - pt - pb {
                    break;
                }
            }
        }
        let avail = rect.h - pt - pb;
        let dy = match g.get("textarea-vertical-align").map(|s| s.as_str()) {
            Some("middle") => (avail - frag.height) / 2.0,
            Some("bottom") => avail - frag.height,
            _ => 0.0,
        };
        vec![Item::group(Transform::from_translate(rect.x + pl, rect.y + pt + dy), None, frag.items)]
    }

    fn shapes(&self, parent: Node, master: &str, skip_placeholders: bool) -> Vec<Item> {
        let mut items = Vec::new();
        for c in parent.children().filter(|c| c.is_element()) {
            items.extend(self.shape(c, master, skip_placeholders));
        }
        items
    }

    fn shape(&self, c: Node, master: &str, skip_ph: bool) -> Vec<Item> {
        let class = c.attributes().find(|a| a.name() == "class" && a.namespace().map(|n| n.contains("presentation")).unwrap_or(false)).map(|a| a.value());
        let is_ph = c.attributes().any(|a| a.name() == "placeholder" && a.value() == "true");
        if skip_ph && (is_ph || matches!(class, Some("title") | Some("outline") | Some("subtitle") | Some("notes") | Some("date-time") | Some("footer") | Some("page-number") | Some("header") | Some("object") | Some("graphic") | Some("chart") | Some("table") | Some("handout"))) {
            return Vec::new();
        }
        if is_ph && !skip_ph {
            // espace réservé vide sur la diapositive : rien à afficher
            if !c.descendants().any(|d| d.is_element() && matches!(d.local(), "p" | "image" | "table" | "object")) {
                return Vec::new();
            }
        }
        let x = c.attr("x").and_then(crate::package::parse_length).unwrap_or(0.0);
        let y = c.attr("y").and_then(crate::package::parse_length).unwrap_or(0.0);
        let w = c.attr("width").and_then(crate::package::parse_length).unwrap_or(0.0);
        let h = c.attr("height").and_then(crate::package::parse_length).unwrap_or(0.0);
        let style = self.graphic(c);
        let g = style.graphic.clone();
        let local = Rect::new(0.0, 0.0, w, h);
        let mut items = Vec::new();
        match c.local() {
            "frame" => {
                for ch in c.children().filter(|x| x.is_element()) {
                    match ch.local() {
                        "text-box" => {
                            if let Some(p) = self.fill_paint(&g, local) {
                                if let Some(path) = crate::display::rect_path(local) {
                                    items.push(Item::Path { path: Arc::new(path), fill: Some(p), stroke: None });
                                }
                            }
                            if let (Some(s), Some(path)) = (self.stroke(&g).filter(|_| g.get("stroke").map(|s| s != "none").unwrap_or(false)), crate::display::rect_path(local)) {
                                items.push(Item::Path { path: Arc::new(path), fill: None, stroke: Some(s) });
                            }
                            items.extend(self.text_layout(ch, local, &style, master, class));
                            break;
                        }
                        "image" => {
                            match ch.attr("href").and_then(|h| self.pkg.image(h)) {
                                Some(img) => items.push(Item::Image { rect: local, image: img, crop: [0.0; 4], alpha: 1.0 }),
                                None => items.push(Item::Placeholder { rect: local, label: "image".into() }),
                            }
                            break;
                        }
                        "table" => {
                            items.extend(self.table(ch, w));
                            break;
                        }
                        "object" => {
                            let href = ch.attr("href").unwrap_or("").trim_start_matches("./").to_string();
                            let chart = crate::odf::ods::render_odf_chart(self.pkg, &href, local);
                            if !chart.is_empty() {
                                items.extend(chart);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
            "custom-shape" | "rect" | "ellipse" | "circle" => {
                let geom = match c.local() {
                    "rect" => {
                        if c.attr("corner-radius").is_some() {
                            "roundRect"
                        } else {
                            "rect"
                        }
                    }
                    "ellipse" | "circle" => "ellipse",
                    _ => c.child("enhanced-geometry").and_then(|e| e.attr("type")).map(geom_name).unwrap_or("rect"),
                };
                let eg = c.child("enhanced-geometry");
                let path = if c.local() == "custom-shape" && eg.and_then(|e| e.attr("type")).map(|t| t == "non-primitive").unwrap_or(false) {
                    let vb: Vec<f32> = eg.and_then(|e| e.attr("viewBox")).map(|v| v.split_whitespace().filter_map(|x| x.parse().ok()).collect()).unwrap_or_default();
                    let vb = if vb.len() == 4 { [vb[0], vb[1], vb[2], vb[3]] } else { [0.0, 0.0, 21600.0, 21600.0] };
                    eg.and_then(|e| e.attr("enhanced-path")).filter(|p| !p.contains('?') && !p.contains('$')).and_then(|p| svg_path(p, vb, w, h)).or_else(|| dml::preset_path("rect", w, h, &HashMap::new()))
                } else {
                    dml::preset_path(geom, w, h, &HashMap::new())
                };
                if let Some(p) = path {
                    let fill = if dml::is_open_shape(geom) { None } else { self.fill_paint(&g, local) };
                    let stroke = self.stroke(&g);
                    items.push(Item::Path { path: Arc::new(p), fill, stroke });
                }
                items.extend(self.text_layout(c, local, &style, master, class));
            }
            "line" | "connector" => {
                let l = |a: &str| c.attr(a).and_then(crate::package::parse_length).unwrap_or(0.0);
                let (x1, y1, x2, y2) = (l("x1"), l("y1"), l("x2"), l("y2"));
                if let Some(s) = self.stroke(&g) {
                    items.push(Item::Line { x1, y1, x2, y2, stroke: s.clone() });
                    if g.get("marker-end").is_some() || g.get("marker-start").is_some() {
                        let mut pb = PathBuilder::new();
                        pb.move_to(x1, y1);
                        pb.line_to(x2, y2);
                        if let Some(p) = pb.finish() {
                            let ld = dml::LineDef { color: Some(s.color), width: s.width, dash: s.dash, head: g.get("marker-start").map(|_| dml::ArrowKind::Triangle), tail: g.get("marker-end").map(|_| dml::ArrowKind::Triangle) };
                            items.extend(dml::arrow_heads(&p, &ld, s.color));
                        }
                    }
                }
                return items;
            }
            "polyline" | "polygon" | "path" => {
                let vb: Vec<f32> = c.attr("viewBox").map(|v| v.split_whitespace().filter_map(|x| x.parse().ok()).collect()).unwrap_or_default();
                let vb = if vb.len() == 4 { [vb[0], vb[1], vb[2], vb[3]] } else { [0.0, 0.0, w.max(1.0), h.max(1.0)] };
                let d = if c.local() == "path" {
                    c.attr("d").unwrap_or("").to_string()
                } else {
                    let pts = c.attr("points").unwrap_or("");
                    let mut d = String::new();
                    for (i, p) in pts.split_whitespace().enumerate() {
                        d.push_str(if i == 0 { "M" } else { "L" });
                        d.push_str(&p.replace(',', " "));
                        d.push(' ');
                    }
                    if c.local() == "polygon" {
                        d.push('Z');
                    }
                    d
                };
                if let Some(p) = svg_path(&d, vb, w, h) {
                    let fill = if c.local() == "polyline" { None } else { self.fill_paint(&g, local) };
                    items.push(Item::Path { path: Arc::new(p), fill, stroke: self.stroke(&g) });
                }
            }
            "g" => {
                return self.shapes(c, master, skip_ph);
            }
            _ => return Vec::new(),
        }
        if items.is_empty() {
            return items;
        }
        let t = match c.attr("transform") {
            Some(tr) => parse_transform(tr),
            None => Transform::from_translate(x, y),
        };
        vec![Item::group(t, None, items)]
    }

    fn table(&self, t: Node, width: f32) -> Vec<Item> {
        let mut table = Table { cell_margins: [2.0, 5.0, 2.0, 5.0], ..Default::default() };
        let mut cols = Vec::new();
        for c in t.descendants().filter(|d| d.is_element() && d.local() == "table-column") {
            let rep: usize = c.attr("number-columns-repeated").and_then(|v| v.parse().ok()).unwrap_or(1).min(64);
            let cs = self.styles.get("table-column", c.attr("style-name"));
            for _ in 0..rep {
                cols.push(len(&cs.column, "column-width"));
            }
        }
        let n = cols.len().max(1);
        table.col_widths = cols.iter().map(|w| w.unwrap_or(width / n as f32)).collect();
        for r in t.descendants().filter(|d| d.is_element() && d.local() == "table-row") {
            let rs = self.styles.get("table-row", r.attr("style-name"));
            let mut row = TableRow { height: len(&rs.row, "row-height").or(len(&rs.row, "min-row-height")).unwrap_or(0.0), ..Default::default() };
            for c in r.children().filter(|x| x.is_element() && matches!(x.local(), "table-cell" | "covered-table-cell")) {
                let cs = self.styles.get("graphic", c.attr("style-name"));
                let cs2 = self.styles.get("table-cell", c.attr("style-name"));
                let fill = color(&cs.graphic, "fill-color").filter(|_| cs.graphic.get("fill").map(|f| f == "solid").unwrap_or(false)).or_else(|| color(&cs2.cell, "background-color"));
                let base = Arc::new(StyleDef::default());
                let paras = self.text_blocks(c, &base, &|_| None, false);
                let border = cs2.cell.get("border").and_then(|b| parse_border(b)).or(Some(BorderLine::solid(0.75, Color::WHITE)));
                row.cells.push(TableCell { span: 1, rowspan: 1, blocks: paras.into_iter().map(Block::Para).collect(), fill, borders: [border.clone(), border.clone(), border.clone(), border], covered: c.local() == "covered-table-cell", ..Default::default() });
            }
            table.rows.push(row);
        }
        flow::table_fragment(&table, width, &LayoutCtx::default()).items
    }
}

fn walk_text(cx: &Ctx, n: Node, st: &Arc<TextStyle>, out: &mut Vec<Inline>, last: &mut bool) {
    for c in n.children() {
        if c.is_text() {
            let t = collapse_ws(c.text().unwrap_or(""), last);
            if !t.is_empty() {
                out.push(Inline::Text(t, st.clone()));
            }
            continue;
        }
        if !c.is_element() {
            continue;
        }
        match c.local() {
            "span" | "a" => {
                let s = match c.attr("style-name") {
                    Some(name) => Arc::new(cx.styles.apply_text(st, &cx.styles.get("text", Some(name)).text)),
                    None => st.clone(),
                };
                walk_text(cx, c, &s, out, last);
            }
            "s" => {
                let k: usize = c.attr("c").and_then(|v| v.parse().ok()).unwrap_or(1);
                out.push(Inline::Text(" ".repeat(k), st.clone()));
                *last = false;
            }
            "tab" => out.push(Inline::Tab(st.clone())),
            "line-break" => {
                out.push(Inline::LineBreak(st.clone()));
                *last = true;
            }
            "page-number" => out.push(Inline::Text(cx.page_no.to_string(), st.clone())),
            _ => walk_text(cx, c, st, out, last),
        }
    }
}

pub fn load(pkg: &Package) -> Result<Vec<Page>, String> {
    let od = OdfDoc::read(pkg)?;
    let (content, styles_doc) = parse_pair(&od.content, &od.styles_xml)?;
    let mut styles = Styles::new();
    if let Some(sd) = &styles_doc {
        styles.load(sd);
    }
    styles.load(&content);
    let pres = body(&content, "presentation").or_else(|| body(&content, "drawing")).ok_or("présentation introuvable")?;
    let base = TextStyle { font: Arc::from("Liberation Sans"), size: 18.0, ..Default::default() };
    let default_text = styles.defaults.get("graphic").map(|d| styles.apply_text(&base, &d.text)).unwrap_or(base);
    let mut cx = Ctx { pkg, styles, page_no: 1, default_text };
    let _ = &mut cx;
    let masters: HashMap<String, Node> = styles_doc.as_ref().map(|d| d.descendants().filter(|n| n.is_element() && n.local() == "master-page").map(|m| (m.attr("name").unwrap_or("").to_string(), m)).collect()).unwrap_or_default();
    let mut pages = Vec::new();
    for (i, page) in pres.children_named("page").enumerate() {
        cx.page_no = i as u32 + 1;
        let mname = page.attr("master-page-name").unwrap_or("").to_string();
        let master = masters.get(&mname).copied().or_else(|| masters.values().next().copied());
        let layout = master.and_then(|m| m.attr("page-layout-name")).map(String::from).unwrap_or_default();
        let pl = cx.styles.page_layouts.get(&layout).cloned().unwrap_or_default();
        let w = len(&pl.page, "page-width").unwrap_or(792.0);
        let h = len(&pl.page, "page-height").unwrap_or(612.0);
        let page_rect = Rect::new(0.0, 0.0, w, h);
        let mut items = Vec::new();
        // arrière-plan : diapositive puis page maîtresse
        let bg_slide = cx.styles.get("drawing-page", page.attr("style-name"));
        let bg_master = cx.styles.get("drawing-page", master.and_then(|m| m.attr("style-name")));
        let bg = if bg_slide.page.get("fill").map(|f| f != "none").unwrap_or(false) { bg_slide.page.clone() } else { bg_master.page.clone() };
        let mut background = Some(Color::WHITE);
        if let Some(p) = cx.fill_paint(&bg, page_rect) {
            match p {
                Paint::Solid(c) => background = Some(c),
                other => {
                    if let Some(path) = crate::display::rect_path(page_rect) {
                        items.push(Item::Path { path: Arc::new(path), fill: Some(other), stroke: None });
                    }
                }
            }
        }
        let show_master_shapes = bg_slide.page.get("background-objects-visible").map(|v| v != "false").unwrap_or(true);
        if let (Some(m), true) = (master, show_master_shapes) {
            items.extend(cx.shapes(m, &mname, true));
        }
        items.extend(cx.shapes(page, &mname, false));
        let mut text = String::new();
        for t in page.descendants().filter(|n| n.is_text()) {
            text.push_str(t.text().unwrap_or(""));
            text.push(' ');
        }
        pages.push(Page { width: w, height: h, background, items: vec![Item::group(Transform::identity(), Some(page_rect), items)], text });
    }
    if pages.is_empty() {
        return Err("La présentation ne contient aucune diapositive.".into());
    }
    Ok(pages)
}
