//! Documents texte OpenDocument (.odt, .ott).

use super::*;
use crate::display::{Item, Rect};
use crate::flow::*;
use crate::package::Package;
use tiny_skia::Transform;

pub(crate) struct Ctx<'p> {
    pub pkg: &'p Package,
    pub styles: Styles,
    /// compteurs de listes : (style de liste, niveau) -> valeur
    counters: HashMap<String, Vec<i32>>,
    outline_counters: Vec<i32>,
    notes: Vec<Vec<Block>>,
    default_text: TextStyle,
}

struct Acc {
    inlines: Vec<Inline>,
    floats: Vec<Floating>,
    blocks_after: Vec<Block>,
    last_space: bool,
}

impl<'p> Ctx<'p> {
    pub fn new(pkg: &'p Package, styles: Styles) -> Ctx<'p> {
        let base = TextStyle { font: Arc::from("Liberation Serif"), size: 12.0, ..Default::default() };
        let def = styles.defaults.get("paragraph").map(|d| styles.apply_text(&base, &d.text)).unwrap_or(base);
        Ctx { pkg, styles, counters: HashMap::new(), outline_counters: vec![0; 10], notes: Vec::new(), default_text: def }
    }

    fn para_style(&self, name: Option<&str>) -> (ParaProps, TextStyle, Arc<StyleDef>) {
        let s = self.styles.get("paragraph", name);
        let pp = self.styles.apply_para(&ParaProps { line: LineSpacing::Multiple(1.0), widow_control: true, ..Default::default() }, &s.para, &s.tab_stops);
        let mut ts = self.styles.apply_text(&self.default_text, &s.text);
        // tailles relatives : on résout depuis le style parent
        if s.text.get("font-size").map(|v| v.ends_with('%')).unwrap_or(false) {
            let parent = self.styles.get("paragraph", s.parent.as_deref());
            let pts = self.styles.apply_text(&self.default_text, &parent.text);
            if let Some(pct) = s.text.get("font-size").and_then(|v| v.trim_end_matches('%').parse::<f32>().ok()) {
                ts.size = pts.size * pct / 100.0;
            }
        }
        (pp, ts, s)
    }

    pub fn parse_blocks(&mut self, parent: Node, out: &mut Vec<Block>, list: Option<(&str, usize)>) {
        for c in parent.children().filter(|c| c.is_element()) {
            match c.local() {
                "p" | "h" => self.parse_paragraph(c, out, list),
                _ => self.parse_single(c, out),
            }
        }
    }

    fn parse_nested_list(&mut self, list_node: Node, out: &mut Vec<Block>, parent_style: &str, level: usize) {
        let style = list_node.attr("style-name").unwrap_or(parent_style).to_string();
        // réinitialise les niveaux inférieurs
        if let Some(cnt) = self.counters.get_mut(&style) {
            for v in cnt.iter_mut().skip(level) {
                *v = 0;
            }
        }
        for item in list_node.children().filter(|x| x.is_element() && matches!(x.local(), "list-item" | "list-header")) {
            let mut first = item.local() == "list-item";
            for ic in item.children().filter(|x| x.is_element()) {
                match ic.local() {
                    "p" | "h" => {
                        self.parse_list_paragraph(ic, out, &style, level, first);
                        first = false;
                    }
                    "list" => {
                        self.parse_nested_list(ic, out, &style, level + 1);
                        first = false;
                    }
                    _ => {}
                }
            }
        }
    }

    fn parse_list_paragraph(&mut self, p: Node, out: &mut Vec<Block>, list_style: &str, level: usize, with_label: bool) {
        // style de liste : celui de la liste, ou celui du style de paragraphe
        let (_, _, sdef) = self.para_style(p.attr("style-name"));
        let ls_name = if self.styles.lists.contains_key(list_style) { list_style.to_string() } else { sdef.attrs.get("list-style-name").cloned().unwrap_or_else(|| list_style.to_string()) };
        let levels = self.styles.lists.get(&ls_name).cloned().unwrap_or_default();
        let lvl = levels.get(level.min(9)).cloned().unwrap_or_default();
        let mut label = None;
        if with_label {
            let cnt = self.counters.entry(ls_name.clone()).or_insert_with(|| vec![0; 10]);
            let li = level.min(9);
            if cnt[li] == 0 {
                cnt[li] = lvl.start;
            } else {
                cnt[li] += 1;
            }
            for v in cnt.iter_mut().skip(li + 1) {
                *v = 0;
            }
            let snapshot = cnt.clone();
            if let Some(b) = &lvl.bullet {
                label = Some(b.clone());
            } else if let Some(fmt) = &lvl.num_format {
                if !fmt.is_empty() {
                    let mut s = lvl.prefix.clone();
                    let first = (li + 1).saturating_sub(lvl.display_levels.max(1));
                    let mut parts = Vec::new();
                    for k in first..=li {
                        let f = if k == li { fmt.clone() } else { levels.get(k).and_then(|l| l.num_format.clone()).unwrap_or_else(|| "1".into()) };
                        parts.push(format_num(snapshot[k].max(1), &f));
                    }
                    s.push_str(&parts.join("."));
                    s.push_str(&lvl.suffix);
                    label = Some(s);
                }
            }
        }
        let mut blocks = Vec::new();
        self.parse_paragraph(p, &mut blocks, None);
        for b in blocks.iter_mut() {
            if let Block::Para(para) = b {
                if lvl.margin_left > 0.0 || lvl.text_indent != 0.0 {
                    para.props.ind_left = lvl.margin_left;
                    para.props.ind_first = lvl.text_indent;
                }
                if let Some(l) = &label {
                    let mut st = (*para.mark).clone();
                    st = self.styles.apply_text(&st, &lvl.text);
                    st.underline = false;
                    let st = Arc::new(st);
                    let mut v = vec![Inline::Text(l.clone(), st.clone())];
                    if para.props.ind_first < 0.0 {
                        v.push(Inline::Tab(st));
                    } else {
                        v.push(Inline::Text(" ".into(), st));
                    }
                    v.extend(std::mem::take(&mut para.inlines));
                    para.inlines = v;
                }
                break;
            }
        }
        out.extend(blocks);
    }

    fn parse_paragraph(&mut self, p: Node, out: &mut Vec<Block>, _list: Option<(&str, usize)>) {
        let (mut props, ts, sdef) = self.para_style(p.attr("style-name"));
        props.style_id = p.attr("style-name").map(Arc::from);
        let ts = Arc::new(ts);
        let mut acc = Acc { inlines: Vec::new(), floats: Vec::new(), blocks_after: Vec::new(), last_space: true };
        // numérotation des titres (style de plan)
        if p.local() == "h" {
            let lvl: usize = p.attr("outline-level").and_then(|v| v.parse().ok()).unwrap_or(1).clamp(1, 10);
            if let Some(ol) = self.styles.outline.get(lvl - 1).cloned() {
                if ol.num_format.as_deref().map(|f| !f.is_empty()).unwrap_or(false) && sdef.attrs.get("list-style-name").map(|s| s.is_empty()).unwrap_or(true) {
                    self.outline_counters[lvl - 1] += 1;
                    for v in self.outline_counters.iter_mut().skip(lvl) {
                        *v = 0;
                    }
                    let first = lvl.saturating_sub(ol.display_levels.max(1));
                    let parts: Vec<String> = (first..lvl).map(|k| format_num(self.outline_counters[k].max(1), self.styles.outline.get(k).and_then(|l| l.num_format.as_deref()).unwrap_or("1"))).collect();
                    let label = format!("{}{}{}", ol.prefix, parts.join("."), ol.suffix);
                    acc.inlines.push(Inline::Text(label, ts.clone()));
                    acc.inlines.push(Inline::Text(" ".into(), ts.clone()));
                }
            }
        }
        self.walk(p, &ts, &mut acc);
        let break_after = sdef.para.get("break-after").map(|v| v == "page").unwrap_or(false);
        for f in acc.floats {
            out.push(Block::Float(f));
        }
        // Les sauts de ligne finaux « vides » sont conservés comme dans LibreOffice.
        out.push(Block::Para(Paragraph { props, inlines: acc.inlines, mark: ts }));
        out.extend(acc.blocks_after);
        if break_after {
            out.push(Block::PageBreak);
        }
    }

    fn walk(&mut self, n: Node, st: &Arc<TextStyle>, acc: &mut Acc) {
        for c in n.children() {
            if c.is_text() {
                let t = collapse_ws(c.text().unwrap_or(""), &mut acc.last_space);
                if !t.is_empty() {
                    push_text(acc, &t, st);
                }
                continue;
            }
            if !c.is_element() {
                continue;
            }
            match c.local() {
                "span" | "a" | "ruby-base" | "meta" | "meta-field" => {
                    let s = if let Some(name) = c.attr("style-name") {
                        let def = self.styles.get("text", Some(name));
                        Arc::new(self.styles.apply_text(st, &def.text))
                    } else {
                        st.clone()
                    };
                    self.walk(c, &s, acc);
                }
                "ruby" => {
                    if let Some(rb) = c.child("ruby-base") {
                        self.walk(rb, st, acc);
                    }
                }
                "s" => {
                    let n: usize = c.attr("c").and_then(|v| v.parse().ok()).unwrap_or(1);
                    push_text(acc, &" ".repeat(n), st);
                    acc.last_space = false;
                }
                "tab" => {
                    acc.inlines.push(Inline::Tab(st.clone()));
                    acc.last_space = true;
                }
                "line-break" => {
                    acc.inlines.push(Inline::LineBreak(st.clone()));
                    acc.last_space = true;
                }
                "page-number" => acc.inlines.push(Inline::Field(Field::PageNumber, st.clone())),
                "page-count" => acc.inlines.push(Inline::Field(Field::PageCount, st.clone())),
                "note" => {
                    // note de bas de page : appel en exposant, texte en fin de document
                    let cit = c.child("note-citation").and_then(|x| x.text()).unwrap_or("*").to_string();
                    let mut s2 = (**st).clone();
                    s2.vert = VertAlign::Super;
                    push_text(acc, &cit, &Arc::new(s2.clone()));
                    if let Some(body) = c.child("note-body") {
                        let mut blocks = Vec::new();
                        self.parse_blocks(body, &mut blocks, None);
                        if let Some(Block::Para(p)) = blocks.first_mut() {
                            p.inlines.insert(0, Inline::Text(format!("{cit} "), Arc::new(TextStyle { size: p.mark.size, ..s2 })));
                        }
                        self.notes.push(blocks);
                    }
                }
                "frame" => self.parse_frame(c, st, acc),
                "soft-page-break" | "bookmark" | "bookmark-start" | "bookmark-end" | "reference-mark" | "change-start" | "change-end" | "alphabetical-index-mark" | "toc-mark" | "annotation" | "annotation-end" => {}
                "deletion" | "tracked-changes" => {}
                _ => {
                    // champs (date, auteur, renvois...) : on affiche leur texte
                    self.walk(c, st, acc);
                }
            }
        }
    }

    fn parse_frame(&mut self, f: Node, st: &Arc<TextStyle>, acc: &mut Acc) {
        let w = f.attr("width").and_then(parse_length).unwrap_or(0.0);
        let mut h = f.attr("height").or_else(|| f.attr("min-height")).and_then(parse_length).unwrap_or(0.0);
        let anchor = f.attr("anchor-type").unwrap_or("paragraph");
        let gs = self.styles.get("graphic", f.attr("style-name"));
        let mut items = Vec::new();
        for c in f.children().filter(|c| c.is_element()) {
            match c.local() {
                "image" => {
                    if !items.is_empty() {
                        break;
                    }
                    let href = c.attr("href").unwrap_or("");
                    match self.pkg.image(href) {
                        Some(img) => items.push(Item::Image { rect: Rect::new(0.0, 0.0, w, h), image: img, crop: [0.0; 4], alpha: 1.0 }),
                        None => items.push(Item::Placeholder { rect: Rect::new(0.0, 0.0, w, h), label: "image".into() }),
                    }
                }
                "text-box" => {
                    let mut blocks = Vec::new();
                    self.parse_blocks(c, &mut blocks, None);
                    let pad = len(&gs.graphic, "padding").unwrap_or(0.0);
                    let frag = stack_blocks(&blocks, (w - 2.0 * pad).max(5.0), &LayoutCtx::default());
                    if h < frag.height + 2.0 * pad {
                        h = frag.height + 2.0 * pad;
                    }
                    if let Some(bg) = color(&gs.graphic, "background-color").or_else(|| if gs.graphic.get("fill").map(|f| f == "solid").unwrap_or(false) { color(&gs.graphic, "fill-color") } else { None }) {
                        items.push(Item::FillRect { rect: Rect::new(0.0, 0.0, w, h), color: bg });
                    }
                    items.push(Item::group(Transform::from_translate(pad, pad), None, frag.items));
                }
                "object" => {
                    // objet incorporé (graphique, formule) : on cherche un graphique ODF
                    let href = c.attr("href").unwrap_or("").trim_start_matches("./").to_string();
                    let chart = crate::odf::ods::render_odf_chart(self.pkg, &href, Rect::new(0.0, 0.0, w, h));
                    if !chart.is_empty() {
                        items.extend(chart);
                    } else if let Some(img) = f.child("image").and_then(|i| i.attr("href")).and_then(|h| self.pkg.image(h)) {
                        items.push(Item::Image { rect: Rect::new(0.0, 0.0, w, h), image: img, crop: [0.0; 4], alpha: 1.0 });
                    } else {
                        items.push(Item::Placeholder { rect: Rect::new(0.0, 0.0, w, h), label: "objet".into() });
                    }
                }
                _ => {}
            }
        }
        // bordure du cadre
        if let Some(b) = gs.graphic.get("border").and_then(|b| parse_border(b)) {
            if let Some(p) = crate::display::rect_path(Rect::new(0.0, 0.0, w, h)) {
                items.push(Item::Path { path: Arc::new(p), fill: None, stroke: Some(crate::display::StrokeStyle { color: b.color, width: b.width, dash: b.dash }) });
            }
        }
        if items.is_empty() {
            return;
        }
        if anchor == "as-char" {
            acc.inlines.push(Inline::Object { width: w, height: h, items, style: st.clone() });
            acc.last_space = false;
            return;
        }
        let wrap = gs.graphic.get("wrap").map(|s| s.as_str()).unwrap_or("none");
        let x = f.attr("x").and_then(parse_length).unwrap_or(0.0);
        let y = f.attr("y").and_then(parse_length).unwrap_or(0.0);
        let hpos = gs.graphic.get("horizontal-pos").map(|s| s.as_str()).unwrap_or("from-left");
        let align_h = match hpos {
            "center" => Some(Align::Center),
            "right" | "outside" => Some(Align::Right),
            "left" | "inside" => Some(Align::Left),
            _ => None,
        };
        let rel_h = match gs.graphic.get("horizontal-rel").map(|s| s.as_str()) {
            Some("page") | Some("page-content") | Some("page-start-margin") | Some("page-end-margin") => RelH::Page,
            _ => RelH::Margin,
        };
        if anchor == "page" {
            acc.floats.push(Floating { width: w, height: h, items, rel_h: RelH::Page, x, align_h, rel_v: RelV::Page, y, align_v: None, behind: wrap == "run-through" && gs.graphic.get("run-through").map(|r| r == "background").unwrap_or(false) });
            return;
        }
        if wrap == "none" {
            // pas de texte à côté : objet en bloc
            let props = ParaProps { align: align_h.unwrap_or(Align::Left), ind_left: if align_h.is_none() { x.max(0.0) } else { 0.0 }, space_before: y.max(0.0), widow_control: false, ..Default::default() };
            acc.blocks_after.push(Block::Para(Paragraph { props, inlines: vec![Inline::Object { width: w, height: h, items, style: st.clone() }], mark: st.clone() }));
        } else {
            acc.floats.push(Floating { width: w, height: h, items, rel_h, x, align_h, rel_v: RelV::Paragraph, y, align_v: None, behind: wrap == "run-through" });
        }
    }

    fn cell_borders(p: &Props) -> [Option<BorderLine>; 4] {
        let all = p.get("border").and_then(|b| parse_border(b));
        let side = |k: &str| match p.get(k) {
            Some(b) => parse_border(b),
            None => all.clone(),
        };
        [side("border-top"), side("border-right"), side("border-bottom"), side("border-left")]
    }

    fn parse_table(&mut self, t: Node) -> Table {
        let ts = self.styles.get("table", t.attr("style-name"));
        let mut table = Table { cell_margins: [0.0, 1.4, 0.0, 1.4], ..Default::default() };
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
        let mut cols = Vec::new();
        collect(t, &mut cols, &mut rows_nodes);
        for c in &cols {
            let rep: usize = c.attr("number-columns-repeated").and_then(|v| v.parse().ok()).unwrap_or(1).min(512);
            let cs = self.styles.get("table-column", c.attr("style-name"));
            let w = len(&cs.column, "column-width").unwrap_or(72.0);
            for _ in 0..rep {
                table.col_widths.push(w);
            }
        }
        // largeur imposée du tableau : mise à l'échelle des colonnes relatives
        if let Some(tw) = len(&ts.table, "width") {
            let sum: f32 = table.col_widths.iter().sum();
            if sum > 0.0 && (sum - tw).abs() > 1.0 {
                for w in table.col_widths.iter_mut() {
                    *w *= tw / sum;
                }
            }
        }
        table.align = match ts.table.get("align").map(|s| s.as_str()) {
            Some("center") => Align::Center,
            Some("right") => Align::Right,
            _ => Align::Left,
        };
        table.indent = len(&ts.table, "margin-left").unwrap_or(0.0);
        for r in rows_nodes {
            let rs = self.styles.get("table-row", r.attr("style-name"));
            let mut row = TableRow::default();
            if let Some(h) = len(&rs.row, "row-height") {
                row.height = h;
                row.exact = true;
            }
            if let Some(h) = len(&rs.row, "min-row-height") {
                row.height = h;
                row.exact = false;
            }
            for c in r.children().filter(|c| c.is_element()) {
                let covered = c.local() == "covered-table-cell";
                if c.local() != "table-cell" && !covered {
                    continue;
                }
                let rep: usize = c.attr("number-columns-repeated").and_then(|v| v.parse().ok()).unwrap_or(1).min(64);
                for _ in 0..rep {
                    let cs = self.styles.get("table-cell", c.attr("style-name"));
                    let pad = len(&cs.cell, "padding").unwrap_or(1.4);
                    let m = [len(&cs.cell, "padding-top").unwrap_or(pad), len(&cs.cell, "padding-right").unwrap_or(pad), len(&cs.cell, "padding-bottom").unwrap_or(pad), len(&cs.cell, "padding-left").unwrap_or(pad)];
                    let mut blocks = Vec::new();
                    if !covered {
                        self.parse_blocks(c, &mut blocks, None);
                    }
                    let cell = TableCell {
                        span: c.attr("number-columns-spanned").and_then(|v| v.parse().ok()).unwrap_or(1),
                        rowspan: c.attr("number-rows-spanned").and_then(|v| v.parse().ok()).unwrap_or(1),
                        blocks,
                        fill: color(&cs.cell, "background-color"),
                        borders: Self::cell_borders(&cs.cell),
                        margins: Some(m),
                        valign: match cs.cell.get("vertical-align").map(|s| s.as_str()) {
                            Some("middle") => VAlign::Center,
                            Some("bottom") => VAlign::Bottom,
                            _ => VAlign::Top,
                        },
                        covered,
                        ..Default::default()
                    };
                    row.cells.push(cell);
                }
            }
            table.rows.push(row);
        }
        // les cellules couvertes horizontalement sont absorbées par la cellule fusionnée
        for row in table.rows.iter_mut() {
            let mut out: Vec<TableCell> = Vec::new();
            let mut skip = 0;
            for c in row.cells.drain(..) {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                skip = c.span.saturating_sub(1);
                out.push(c);
            }
            row.cells = out;
        }
        if table.col_widths.is_empty() {
            let n = table.rows.iter().map(|r| r.cells.iter().map(|c| c.span.max(1)).sum::<usize>()).max().unwrap_or(1);
            table.col_widths = vec![450.0 / n as f32; n];
        }
        table
    }

    fn header_footer(&mut self, n: Option<Node>) -> Option<Vec<Block>> {
        let n = n?;
        let mut blocks = Vec::new();
        self.parse_blocks(n, &mut blocks, None);
        Some(blocks)
    }
}

fn push_text(acc: &mut Acc, t: &str, st: &Arc<TextStyle>) {
    if let Some(Inline::Text(prev, pst)) = acc.inlines.last_mut() {
        if Arc::ptr_eq(pst, st) {
            prev.push_str(t);
            return;
        }
    }
    acc.inlines.push(Inline::Text(t.to_string(), st.clone()));
}

fn page_setup(styles: &Styles, master: Option<&str>, doc_styles: Option<&roxmltree::Document>) -> (PageSetup, Option<String>) {
    let (mname, layout) = match master {
        Some(m) => styles.masters.iter().find(|x| x.0 == m).cloned(),
        None => styles.masters.iter().find(|x| x.0 == "Standard" || x.0 == "Default").cloned().or_else(|| styles.masters.first().cloned()),
    }
    .unwrap_or_default();
    let mut s = PageSetup::default();
    if let Some(pl) = styles.page_layouts.get(&layout) {
        let p = &pl.page;
        if let Some(v) = len(p, "page-width") {
            s.width = v;
        }
        if let Some(v) = len(p, "page-height") {
            s.height = v;
        }
        s.margin_top = len(p, "margin-top").unwrap_or(56.7);
        s.margin_bottom = len(p, "margin-bottom").unwrap_or(56.7);
        s.margin_left = len(p, "margin-left").unwrap_or(56.7);
        s.margin_right = len(p, "margin-right").unwrap_or(56.7);
        // en ODF l'en-tête est dans la zone de texte : le corps commence plus bas
        let has_header = doc_styles.and_then(|d| d.descendants().find(|n| n.local() == "master-page" && n.attr("name") == Some(mname.as_str()))).and_then(|m| m.child("header")).is_some();
        let has_footer = doc_styles.and_then(|d| d.descendants().find(|n| n.local() == "master-page" && n.attr("name") == Some(mname.as_str()))).and_then(|m| m.child("footer")).is_some();
        s.header_dist = s.margin_top;
        s.footer_dist = s.margin_bottom;
        if has_header {
            // la hauteur minimale de l'en-tête inclut l'espacement (convention LibreOffice)
            let mh = pl.attrs.get("header-min-height").and_then(|v| parse_length(v)).unwrap_or(0.0);
            let sp = pl.attrs.get("header-margin-bottom").and_then(|v| parse_length(v)).unwrap_or(0.0);
            s.margin_top += mh.max(sp + 12.0);
        }
        if has_footer {
            let mh = pl.attrs.get("footer-min-height").and_then(|v| parse_length(v)).unwrap_or(0.0);
            let sp = pl.attrs.get("footer-margin-top").and_then(|v| parse_length(v)).unwrap_or(0.0);
            s.margin_bottom += mh.max(sp + 12.0);
        }
        if let Some(cols) = p.get("column-count").and_then(|v| v.parse::<usize>().ok()) {
            s.columns = cols.max(1);
        }
    }
    (s, Some(mname))
}

pub fn load(pkg: &Package) -> Result<FlowDoc, String> {
    let od = OdfDoc::read(pkg)?;
    let (content, styles_doc) = parse_pair(&od.content, &od.styles_xml)?;
    let mut styles = Styles::new();
    if let Some(sd) = &styles_doc {
        styles.load(sd);
    }
    styles.load(&content);
    // les styles automatiques de styles.xml et content.xml sont fusionnés
    if let Some(sd) = &styles_doc {
        let mut s2 = Styles::new();
        s2.load(sd);
        for (k, v) in s2.map {
            styles.map.entry(k).or_insert(v);
        }
    }
    let mut cx = Ctx::new(pkg, styles);
    let text = body(&content, "text").ok_or("corps du texte introuvable")?;
    // sections par page maîtresse
    let mut sections: Vec<Section> = Vec::new();
    let mut cur_master: Option<String> = None;
    let mut blocks: Vec<Block> = Vec::new();
    let master_of = |cx: &Ctx, n: Node| -> Option<String> {
        if !matches!(n.local(), "p" | "h" | "table") {
            return None;
        }
        let fam = if n.local() == "table" { "table" } else { "paragraph" };
        let s = cx.styles.get(fam, n.attr("style-name"));
        s.attrs.get("master-page-name").filter(|m| !m.is_empty()).cloned()
    };
    let make_section = |cx: &mut Ctx, master: Option<&str>, blocks: Vec<Block>| -> Section {
        let (setup, mname) = page_setup(&cx.styles, master, styles_doc.as_ref());
        let mnode = styles_doc.as_ref().and_then(|d| d.descendants().find(|n| n.local() == "master-page" && Some(n.attr("name").unwrap_or("").to_string()) == mname));
        let mut sec = Section { setup, blocks, ..Default::default() };
        if let Some(m) = mnode {
            sec.header.default = cx.header_footer(m.child("header"));
            sec.footer.default = cx.header_footer(m.child("footer"));
            if let Some(h) = m.child("header-first") {
                sec.header.first = cx.header_footer(Some(h));
                sec.title_page = true;
            }
            if let Some(f) = m.child("footer-first") {
                sec.footer.first = cx.header_footer(Some(f));
                sec.title_page = true;
            }
        }
        sec
    };
    for c in text.children().filter(|c| c.is_element()) {
        if let Some(m) = master_of(&cx, c) {
            if !blocks.is_empty() || cur_master.is_some() {
                let b = std::mem::take(&mut blocks);
                let sec = make_section(&mut cx, cur_master.as_deref(), b);
                sections.push(sec);
            }
            cur_master = Some(m);
        }
        let mut tmp = Vec::new();
        // on réutilise l'analyseur de blocs sur un seul enfant
        match c.local() {
            "p" | "h" => cx.parse_paragraph(c, &mut tmp, None),
            _ => {
                let wrapper = c.parent().unwrap();
                let _ = wrapper;
                cx.parse_single(c, &mut tmp);
            }
        }
        blocks.extend(tmp);
    }
    let sec = make_section(&mut cx, cur_master.as_deref(), blocks);
    sections.push(sec);
    // notes en fin de document
    if !cx.notes.is_empty() {
        let mut nb = vec![Block::Para(Paragraph {
            props: ParaProps { space_before: 12.0, borders: [Some(BorderLine::solid(0.5, Color::rgb(120, 120, 120))), None, None, None], ind_right: 300.0, ..Default::default() },
            inlines: vec![],
            mark: Arc::new(TextStyle { size: 4.0, ..Default::default() }),
        })];
        for n in cx.notes.drain(..) {
            nb.extend(n);
        }
        if let Some(s) = sections.last_mut() {
            s.blocks.extend(nb);
        }
    }
    Ok(FlowDoc { sections, background: None, even_and_odd_headers: false })
}

impl<'p> Ctx<'p> {
    fn parse_single(&mut self, c: Node, out: &mut Vec<Block>) {
        match c.local() {
            "list" => {
                let style = c.attr("style-name").unwrap_or("").to_string();
                if !(c.attr("continue-numbering") == Some("true") || c.attr("continue-list").is_some()) {
                    if let Some(cnt) = self.counters.get_mut(&style) {
                        for v in cnt.iter_mut() {
                            *v = 0;
                        }
                    }
                }
                self.parse_nested_list(c, out, &style, 0);
            }
            "table" => {
                let t = self.parse_table(c);
                out.push(Block::Table(t));
            }
            "section" | "table-of-content" | "illustration-index" | "alphabetical-index" | "bibliography" | "user-index" | "object-index" | "table-index" => {
                let inner = c.child("index-body").unwrap_or(c);
                for cc in inner.children().filter(|x| x.is_element()) {
                    match cc.local() {
                        "p" | "h" => self.parse_paragraph(cc, out, None),
                        _ => self.parse_single(cc, out),
                    }
                }
            }
            "index-title" => {
                for cc in c.children().filter(|x| x.is_element()) {
                    match cc.local() {
                        "p" | "h" => self.parse_paragraph(cc, out, None),
                        _ => self.parse_single(cc, out),
                    }
                }
            }
            "frame" => {
                let mut acc = Acc { inlines: Vec::new(), floats: Vec::new(), blocks_after: Vec::new(), last_space: false };
                let st = Arc::new(self.default_text.clone());
                self.parse_frame(c, &st, &mut acc);
                for f in acc.floats {
                    out.push(Block::Float(f));
                }
                out.extend(acc.blocks_after);
            }
            _ => {}
        }
    }
}
