//! Documents à flux (traitement de texte) : blocs, tableaux, sections et pagination.

use crate::color::Color;
use crate::display::{Item, Page, Rect, StrokeStyle};
use crate::text::{layout_paragraph, Align, BorderLine, LayoutCtx, Paragraph};
use tiny_skia::Transform;

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum VAlign {
    #[default]
    Top,
    Center,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum VMerge {
    #[default]
    None,
    Restart,
    Continue,
}

#[derive(Clone, Default)]
pub struct TableCell {
    pub span: usize,
    pub vmerge: VMerge,
    /// Fusion verticale explicite (ODF, PPTX) ; calculée pour DOCX.
    pub rowspan: usize,
    pub blocks: Vec<Block>,
    pub fill: Option<Color>,
    /// Bordures : haut, droite, bas, gauche.
    pub borders: [Option<BorderLine>; 4],
    pub margins: Option<[f32; 4]>,
    pub valign: VAlign,
    pub covered: bool,
    pub col: usize,
}

#[derive(Clone, Default)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
    pub height: f32,
    pub exact: bool,
    pub header: bool,
    pub cant_split: bool,
    pub grid_before: usize,
}

#[derive(Clone, Default)]
pub struct Table {
    pub col_widths: Vec<f32>,
    pub rows: Vec<TableRow>,
    pub indent: f32,
    pub align: Align,
    /// Marges de cellule par défaut : haut, droite, bas, gauche.
    pub cell_margins: [f32; 4],
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum RelH {
    Page,
    #[default]
    Margin,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum RelV {
    Page,
    Margin,
    #[default]
    Paragraph,
}

/// Objet flottant positionné (image ancrée, zone de texte, forme).
#[derive(Clone, Default)]
pub struct Floating {
    pub width: f32,
    pub height: f32,
    pub items: Vec<Item>,
    pub rel_h: RelH,
    pub x: f32,
    pub align_h: Option<Align>,
    pub rel_v: RelV,
    pub y: f32,
    pub align_v: Option<VAlign>,
    pub behind: bool,
}

#[derive(Clone)]
pub enum Block {
    Para(Paragraph),
    Table(Table),
    PageBreak,
    ColumnBreak,
    Float(Floating),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageSetup {
    pub width: f32,
    pub height: f32,
    pub margin_top: f32,
    pub margin_bottom: f32,
    pub margin_left: f32,
    pub margin_right: f32,
    pub header_dist: f32,
    pub footer_dist: f32,
    pub columns: usize,
    pub col_gap: f32,
}

impl Default for PageSetup {
    fn default() -> Self {
        // A4 avec marges de 2,5 cm
        PageSetup {
            width: 595.3,
            height: 841.9,
            margin_top: 70.85,
            margin_bottom: 70.85,
            margin_left: 70.85,
            margin_right: 70.85,
            header_dist: 35.4,
            footer_dist: 35.4,
            columns: 1,
            col_gap: 36.0,
        }
    }
}

#[derive(Clone, Default)]
pub struct HeaderFooter {
    pub default: Option<Vec<Block>>,
    pub first: Option<Vec<Block>>,
    pub even: Option<Vec<Block>>,
}

#[derive(Clone, Default)]
pub struct Section {
    pub setup: PageSetup,
    pub blocks: Vec<Block>,
    pub header: HeaderFooter,
    pub footer: HeaderFooter,
    pub title_page: bool,
    /// Section continue (pas de saut de page avant elle).
    pub continuous: bool,
    pub page_number_start: Option<u32>,
}

#[derive(Clone, Default)]
pub struct FlowDoc {
    pub sections: Vec<Section>,
    pub background: Option<Color>,
    pub even_and_odd_headers: bool,
}

/// Bloc mis en forme (coordonnées relatives à son coin supérieur gauche).
#[derive(Clone, Default)]
pub struct Fragment {
    pub height: f32,
    pub items: Vec<Item>,
    /// Positions où une coupure de page est permise.
    pub cuts: Vec<f32>,
    pub keep_next: bool,
    pub page_break_before: bool,
    pub text: String,
    /// Objets flottants ancrés dans ce bloc (décalage vertical de l'ancre).
    pub floats: Vec<(f32, Floating)>,
}

fn para_fragment(p: &Paragraph, width: f32, ctx: &LayoutCtx) -> Fragment {
    let l = layout_paragraph(p, width, ctx);
    let mut cuts = Vec::new();
    let n = l.lines.len();
    if !p.props.keep_lines {
        for k in 1..n {
            if p.props.widow_control && (k < 2 || n - k < 2) {
                continue;
            }
            cuts.push(l.lines[k].top);
        }
    }
    Fragment { height: l.height, items: l.items, cuts, keep_next: p.props.keep_next, page_break_before: p.props.page_break_before, text: l.text, floats: Vec::new() }
}

/// Applique l'espacement contextuel (paragraphes consécutifs de même style).
fn contextual(blocks: &[Block]) -> Vec<Block> {
    let mut out: Vec<Block> = blocks.to_vec();
    for i in 1..out.len() {
        let (a, b) = out.split_at_mut(i);
        if let (Block::Para(prev), Block::Para(cur)) = (&mut a[i - 1], &mut b[0]) {
            if prev.props.style_id.is_some() && prev.props.style_id == cur.props.style_id {
                if cur.props.contextual_spacing {
                    cur.props.space_before = 0.0;
                }
                if prev.props.contextual_spacing {
                    prev.props.space_after = 0.0;
                }
            }
            // Comme Word : l'écart entre deux paragraphes est le maximum des espacements.
            if !cur.props.pp_line_mode {
                cur.props.space_before = (cur.props.space_before - prev.props.space_after).max(0.0);
            }
        }
    }
    out
}

/// Empile des blocs sans pagination (cellules, en-têtes, zones de texte).
pub fn stack_blocks(blocks: &[Block], width: f32, ctx: &LayoutCtx) -> Fragment {
    let blocks = contextual(blocks);
    let mut out = Fragment::default();
    let mut y = 0.0;
    for b in &blocks {
        let f = match b {
            Block::Para(p) => para_fragment(p, width, ctx),
            Block::Table(t) => table_fragment(t, width, ctx),
            Block::Float(fl) => {
                out.floats.push((y, fl.clone()));
                continue;
            }
            _ => continue,
        };
        for c in &f.cuts {
            out.cuts.push(y + c);
        }
        for (fy, fl) in f.floats {
            out.floats.push((y + fy, fl));
        }
        if !f.items.is_empty() {
            out.items.push(Item::group(Transform::from_translate(0.0, y), None, f.items));
        }
        if !out.text.is_empty() && !f.text.is_empty() {
            out.text.push('\n');
        }
        out.text.push_str(&f.text);
        y += f.height;
        out.cuts.push(y);
    }
    out.cuts.retain(|c| *c < y - 0.01);
    out.height = y;
    out
}

/// Calcule colonnes et fusions verticales.
pub fn normalize_table(t: &mut Table) {
    let ncols = t.col_widths.len();
    for row in &mut t.rows {
        let mut col = row.grid_before;
        for c in &mut row.cells {
            c.span = c.span.max(1);
            c.col = col;
            col += c.span;
        }
    }
    // largeur des colonnes manquantes
    let maxcol = t.rows.iter().map(|r| r.cells.last().map(|c| c.col + c.span).unwrap_or(0)).max().unwrap_or(0);
    if maxcol > ncols {
        let avg = if ncols > 0 { t.col_widths.iter().sum::<f32>() / ncols as f32 } else { 72.0 };
        t.col_widths.resize(maxcol, avg);
    }
    // fusions verticales de type Word
    let nrows = t.rows.len();
    for r in 0..nrows {
        for ci in 0..t.rows[r].cells.len() {
            let (col, vm) = (t.rows[r].cells[ci].col, t.rows[r].cells[ci].vmerge);
            match vm {
                VMerge::Restart => {
                    let mut span = 1;
                    for r2 in r + 1..nrows {
                        if let Some(c2) = t.rows[r2].cells.iter_mut().find(|c| c.col == col) {
                            if c2.vmerge == VMerge::Continue {
                                c2.covered = true;
                                span += 1;
                                continue;
                            }
                        }
                        break;
                    }
                    t.rows[r].cells[ci].rowspan = span;
                }
                VMerge::Continue => {
                    // continuation orpheline : traitée comme cellule couverte vide
                    t.rows[r].cells[ci].covered = true;
                }
                VMerge::None => {
                    let rs = t.rows[r].cells[ci].rowspan.max(1);
                    t.rows[r].cells[ci].rowspan = rs;
                }
            }
        }
    }
}

fn draw_border(items: &mut Vec<Item>, b: &Option<BorderLine>, x1: f32, y1: f32, x2: f32, y2: f32) {
    if let Some(bl) = b {
        if bl.width <= 0.0 || bl.color.is_transparent() {
            return;
        }
        let stroke = StrokeStyle { color: bl.color, width: bl.width, dash: bl.dash };
        if bl.double {
            let off = bl.width.max(0.75);
            let (dx, dy) = if (y1 - y2).abs() < 0.01 { (0.0, off) } else { (off, 0.0) };
            items.push(Item::Line { x1: x1 - dx, y1: y1 - dy, x2: x2 - dx, y2: y2 - dy, stroke: stroke.clone() });
            items.push(Item::Line { x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy, stroke });
        } else {
            items.push(Item::Line { x1, y1, x2, y2, stroke });
        }
    }
}

pub fn table_fragment(t: &Table, avail_width: f32, ctx: &LayoutCtx) -> Fragment {
    let mut t = t.clone();
    normalize_table(&mut t);
    let ncols = t.col_widths.len();
    let mut xs = vec![0.0f32; ncols + 1];
    for i in 0..ncols {
        xs[i + 1] = xs[i] + t.col_widths[i].max(0.0);
    }
    let total_w = xs[ncols];
    let x_off = match t.align {
        Align::Center => ((avail_width - total_w) / 2.0).max(0.0),
        Align::Right => (avail_width - total_w).max(0.0),
        _ => t.indent,
    };
    let nrows = t.rows.len();
    // mise en forme du contenu des cellules
    struct CellLay {
        r: usize,
        frag: Fragment,
        margins: [f32; 4],
    }
    let mut lays: Vec<Vec<Option<CellLay>>> = Vec::with_capacity(nrows);
    let mut heights = vec![0.0f32; nrows];
    for (r, row) in t.rows.iter().enumerate() {
        let mut v = Vec::new();
        for c in &row.cells {
            if c.covered {
                v.push(None);
                continue;
            }
            let m = c.margins.unwrap_or(t.cell_margins);
            let x1 = xs[c.col.min(ncols)];
            let x2 = xs[(c.col + c.span).min(ncols)];
            let w = (x2 - x1 - m[1] - m[3]).max(1.0);
            let frag = stack_blocks(&c.blocks, w, ctx);
            let h = frag.height + m[0] + m[2];
            if c.rowspan <= 1 {
                heights[r] = heights[r].max(h);
            }
            v.push(Some(CellLay { r, frag, margins: m }));
        }
        lays.push(v);
    }
    for (r, row) in t.rows.iter().enumerate() {
        if row.exact && row.height > 0.0 {
            heights[r] = row.height;
        } else {
            heights[r] = heights[r].max(row.height);
        }
        if heights[r] <= 0.0 {
            heights[r] = 1.0;
        }
    }
    // cellules fusionnées verticalement
    for r in 0..nrows {
        for (ci, c) in t.rows[r].cells.iter().enumerate() {
            if c.covered || c.rowspan <= 1 {
                continue;
            }
            if let Some(l) = &lays[r][ci] {
                let need = l.frag.height + l.margins[0] + l.margins[2];
                let end = (r + c.rowspan).min(nrows);
                let have: f32 = heights[r..end].iter().sum();
                if need > have {
                    heights[end - 1] += need - have;
                }
            }
        }
    }
    let mut ys = vec![0.0f32; nrows + 1];
    for r in 0..nrows {
        ys[r + 1] = ys[r] + heights[r];
    }
    let mut fills = Vec::new();
    let mut content = Vec::new();
    let mut borders = Vec::new();
    let mut cuts = Vec::new();
    let mut text = String::new();
    let mut floats = Vec::new();
    for r in 0..nrows {
        let row = &t.rows[r];
        let mut row_line_intervals: Vec<(f32, f32)> = Vec::new();
        for (ci, c) in row.cells.iter().enumerate() {
            let Some(l) = &lays[r][ci] else { continue };
            let x1 = x_off + xs[c.col.min(ncols)];
            let x2 = x_off + xs[(c.col + c.span).min(ncols)];
            let y1 = ys[l.r];
            let y2 = ys[(l.r + c.rowspan.max(1)).min(nrows)];
            if let Some(f) = c.fill {
                fills.push(Item::FillRect { rect: Rect::new(x1, y1, x2 - x1, y2 - y1), color: f });
            }
            let m = l.margins;
            let inner_h = y2 - y1 - m[0] - m[2];
            let dy = match c.valign {
                VAlign::Top => 0.0,
                VAlign::Center => ((inner_h - l.frag.height) / 2.0).max(0.0),
                VAlign::Bottom => (inner_h - l.frag.height).max(0.0),
            };
            let cy = y1 + m[0] + dy;
            if !l.frag.items.is_empty() {
                let clip = if row.exact { Some(Rect::new(x1, y1, x2 - x1, y2 - y1)) } else { None };
                let inner = Item::group(Transform::from_translate(x1 + m[3], cy), None, l.frag.items.clone());
                match clip {
                    Some(cr) => content.push(Item::group(Transform::identity(), Some(cr), vec![inner])),
                    None => content.push(inner),
                }
            }
            for (fy, fl) in &l.frag.floats {
                floats.push((cy + fy, fl.clone()));
            }
            // intervalles insécables (lignes de texte)
            let mut prev = 0.0;
            let mut cut_list = l.frag.cuts.clone();
            cut_list.push(l.frag.height);
            for cy2 in cut_list {
                row_line_intervals.push((cy + prev + 0.01, cy + cy2 - 0.01));
                prev = cy2;
            }
            draw_border(&mut borders, &c.borders[0], x1, y1, x2, y1);
            draw_border(&mut borders, &c.borders[2], x1, y2, x2, y2);
            draw_border(&mut borders, &c.borders[3], x1, y1, x1, y2);
            draw_border(&mut borders, &c.borders[1], x2, y1, x2, y2);
            if !l.frag.text.is_empty() {
                text.push_str(&l.frag.text);
                text.push('\t');
            }
        }
        text.push('\n');
        // coupures dans la ligne du tableau
        if !row.cant_split && !row.exact {
            let mut candidates: Vec<f32> = row_line_intervals.iter().map(|iv| iv.1 + 0.01).collect();
            candidates.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for cand in candidates {
                if cand <= ys[r] + 1.0 || cand >= ys[r + 1] - 1.0 {
                    continue;
                }
                if row_line_intervals.iter().all(|iv| cand <= iv.0 || cand >= iv.1) {
                    cuts.push(cand);
                }
            }
        }
        if r + 1 < nrows {
            cuts.push(ys[r + 1]);
        }
    }
    let mut items = fills;
    items.extend(content);
    items.extend(borders);
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    cuts.dedup_by(|a, b| (*a - *b).abs() < 0.01);
    Fragment { height: ys[nrows], items, cuts, keep_next: false, page_break_before: false, text, floats }
}

// ---------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------

struct PageBuilder {
    pages: Vec<(PageSetup, Vec<Item>, Vec<Item>, String, usize)>, // setup, corps, flottants, texte, section
}

struct Cursor {
    setup: PageSetup,
    section: usize,
    body_top: f32,
    body_bottom: f32,
    col: usize,
    y: f32,
    items: Vec<Item>,
    floats: Vec<Item>,
    text: String,
    empty: bool,
}

impl Cursor {
    fn col_x(&self) -> f32 {
        let s = &self.setup;
        let cols = s.columns.max(1);
        let total = s.width - s.margin_left - s.margin_right;
        let cw = (total - s.col_gap * (cols as f32 - 1.0)) / cols as f32;
        s.margin_left + self.col as f32 * (cw + s.col_gap)
    }
    fn col_width(&self) -> f32 {
        let s = &self.setup;
        let cols = s.columns.max(1);
        let total = s.width - s.margin_left - s.margin_right;
        ((total - s.col_gap * (cols as f32 - 1.0)) / cols as f32).max(10.0)
    }
}

fn hf_height(blocks: &Option<Vec<Block>>, width: f32) -> f32 {
    match blocks {
        Some(b) => stack_blocks(b, width, &LayoutCtx { page_number: 1, page_count: 1 }).height,
        None => 0.0,
    }
}

fn body_area(sec: &Section, setup: &PageSetup) -> (f32, f32) {
    let w = setup.width - setup.margin_left - setup.margin_right;
    let hh = hf_height(&sec.header.default, w).max(hf_height(&sec.header.first, w));
    let fh = hf_height(&sec.footer.default, w).max(hf_height(&sec.footer.first, w));
    let top = setup.margin_top.max(setup.header_dist + hh);
    let bottom = (setup.height - setup.margin_bottom.max(setup.footer_dist + fh)).max(top + 36.0);
    (top, bottom)
}

impl PageBuilder {
    fn finish_page(&mut self, cur: &mut Cursor) {
        let items = std::mem::take(&mut cur.items);
        let floats = std::mem::take(&mut cur.floats);
        let text = std::mem::take(&mut cur.text);
        self.pages.push((cur.setup.clone(), items, floats, text, cur.section));
        cur.col = 0;
        cur.y = cur.body_top;
        cur.empty = true;
    }

    fn next_column_or_page(&mut self, cur: &mut Cursor) {
        if cur.col + 1 < cur.setup.columns.max(1) {
            cur.col += 1;
            cur.y = cur.body_top;
            cur.empty = true;
        } else {
            self.finish_page(cur);
        }
    }
}

fn place_float(cur: &mut Cursor, anchor_y: f32, fl: &Floating) {
    let s = &cur.setup;
    let (ref_x, ref_w) = match fl.rel_h {
        RelH::Page => (0.0, s.width),
        RelH::Margin => (s.margin_left, s.width - s.margin_left - s.margin_right),
        RelH::Column => (cur.col_x(), cur.col_width()),
    };
    let x = match fl.align_h {
        Some(Align::Center) => ref_x + (ref_w - fl.width) / 2.0,
        Some(Align::Right) => ref_x + ref_w - fl.width,
        Some(_) => ref_x,
        None => ref_x + fl.x,
    };
    let (ref_y, ref_h) = match fl.rel_v {
        RelV::Page => (0.0, s.height),
        RelV::Margin => (s.margin_top, s.height - s.margin_top - s.margin_bottom),
        RelV::Paragraph => (anchor_y, 0.0),
    };
    let y = match fl.align_v {
        Some(VAlign::Center) => ref_y + (ref_h - fl.height) / 2.0,
        Some(VAlign::Bottom) => ref_y + ref_h - fl.height,
        Some(VAlign::Top) => ref_y,
        None => ref_y + fl.y,
    };
    let g = Item::group(Transform::from_translate(x, y), None, fl.items.clone());
    if fl.behind {
        cur.items.insert(0, g);
    } else {
        cur.floats.push(g);
    }
}

fn emit_slice(cur: &mut Cursor, f: &Fragment, from: f32, to: f32) {
    let x = cur.col_x();
    let dy = cur.y - from;
    let full = from <= 0.0 && to >= f.height - 0.01;
    if full {
        if !f.items.is_empty() {
            cur.items.push(Item::group(Transform::from_translate(x, dy), None, f.items.clone()));
        }
    } else {
        // n'emporter que les éléments visibles dans la tranche
        let slice = Rect::new(-1.0e5, from, 2.0e5, to - from);
        let visible: Vec<Item> = f.items.iter().filter(|it| it.bounds().intersects(&slice)).cloned().collect();
        if !visible.is_empty() {
            let clip = Rect::new(-1.0e4, from - 0.5, 2.0e4, to - from + 1.0);
            cur.items.push(Item::group(Transform::from_translate(x, dy), Some(clip), visible));
        }
    }
    for (fy, fl) in &f.floats {
        if *fy >= from - 0.01 && (*fy < to || full) {
            let ay = cur.y + (fy - from);
            place_float(cur, ay, fl);
        }
    }
    cur.y += to - from;
    cur.empty = false;
}

fn place_fragment(pb: &mut PageBuilder, cur: &mut Cursor, f: &Fragment, lookahead: f32) {
    if f.page_break_before && !cur.empty {
        pb.finish_page(cur);
    }
    let mut offset = 0.0f32;
    let mut guard = 0;
    // garder avec le suivant
    if f.keep_next && !cur.empty {
        let need = f.height + lookahead;
        let avail = cur.body_bottom - cur.y;
        let page_h = cur.body_bottom - cur.body_top;
        if need > avail + 0.01 && need <= page_h {
            pb.next_column_or_page(cur);
        }
    }
    while offset < f.height - 0.01 {
        guard += 1;
        if guard > 10000 {
            break;
        }
        let avail = cur.body_bottom - cur.y;
        let remaining = f.height - offset;
        if remaining <= avail + 0.01 {
            emit_slice(cur, f, offset, f.height);
            break;
        }
        // recherche de la meilleure coupure
        let limit = offset + avail;
        let cut = f.cuts.iter().copied().filter(|c| *c > offset + 0.01 && *c <= limit + 0.01).fold(None, |acc: Option<f32>, c| Some(acc.map_or(c, |a| a.max(c))));
        match cut {
            Some(c) => {
                emit_slice(cur, f, offset, c);
                offset = c;
                pb.next_column_or_page(cur);
            }
            None if cur.empty => {
                // bloc insécable plus haut que la page : on force
                let c = (offset + avail.max(20.0)).min(f.height);
                emit_slice(cur, f, offset, c);
                offset = c;
                if offset < f.height - 0.01 {
                    pb.next_column_or_page(cur);
                }
            }
            None => pb.next_column_or_page(cur),
        }
    }
    if f.items.is_empty() && f.height <= 0.01 {
        for (_, fl) in &f.floats {
            let ay = cur.y;
            place_float(cur, ay, fl);
        }
    }
    if !f.text.is_empty() {
        cur.text.push_str(&f.text);
        cur.text.push('\n');
    }
}

fn first_unit_height(f: &Fragment) -> f32 {
    f.cuts.first().copied().unwrap_or(f.height)
}

/// Pagine un document à flux en pages prêtes à dessiner.
pub fn paginate(doc: &FlowDoc) -> Vec<Page> {
    let mut pb = PageBuilder { pages: Vec::new() };
    let mut cur: Option<Cursor> = None;
    let ctx = LayoutCtx { page_number: 1, page_count: 1 };
    for (si, sec) in doc.sections.iter().enumerate() {
        let setup = sec.setup.clone();
        let (top, bottom) = body_area(sec, &setup);
        match cur.as_mut() {
            None => {
                cur = Some(Cursor { setup: setup.clone(), section: si, body_top: top, body_bottom: bottom, col: 0, y: top, items: Vec::new(), floats: Vec::new(), text: String::new(), empty: true });
            }
            Some(c) => {
                let same_size = (c.setup.width - setup.width).abs() < 1.0 && (c.setup.height - setup.height).abs() < 1.0;
                if sec.continuous && same_size {
                    // continue sur la même page (nouvelle disposition des colonnes)
                    let y = if c.col > 0 { c.body_bottom.min(c.y.max(c.body_top)) } else { c.y };
                    c.setup.columns = setup.columns;
                    c.setup.col_gap = setup.col_gap;
                    c.setup.margin_left = setup.margin_left;
                    c.setup.margin_right = setup.margin_right;
                    c.col = 0;
                    c.y = y;
                    c.section = si;
                    if c.y >= c.body_bottom - 1.0 {
                        pb.finish_page(c);
                    }
                    c.body_top = c.body_top.max(0.0);
                } else {
                    if !c.empty || !c.items.is_empty() {
                        pb.finish_page(c);
                    }
                    c.setup = setup.clone();
                    c.section = si;
                    c.body_top = top;
                    c.body_bottom = bottom;
                    c.y = top;
                    c.col = 0;
                    c.empty = true;
                }
            }
        }
        let c = cur.as_mut().unwrap();
        // Les sections continues partagent la page : on garde la zone utile courante.
        let blocks = contextual(&sec.blocks);
        // Fragments mis en forme à la demande
        let width_for = |c: &Cursor| c.col_width();
        let mut i = 0;
        while i < blocks.len() {
            let width = width_for(c);
            match &blocks[i] {
                Block::PageBreak => {
                    pb.finish_page(c);
                }
                Block::ColumnBreak => {
                    pb.next_column_or_page(c);
                }
                Block::Float(fl) => {
                    let ay = c.y;
                    place_float(c, ay, fl);
                }
                Block::Para(p) => {
                    let f = para_fragment(p, width, &ctx);
                    let look = if p.props.keep_next {
                        // hauteur de la première unité du bloc suivant (chaînes de titres)
                        let mut h = 0.0;
                        let mut j = i + 1;
                        while j < blocks.len() {
                            match &blocks[j] {
                                Block::Para(p2) => {
                                    let f2 = para_fragment(p2, width, &ctx);
                                    if p2.props.keep_next {
                                        h += f2.height;
                                        j += 1;
                                        continue;
                                    }
                                    h += first_unit_height(&f2);
                                }
                                Block::Table(t2) => {
                                    let f2 = table_fragment(t2, width, &ctx);
                                    h += first_unit_height(&f2);
                                }
                                _ => {}
                            }
                            break;
                        }
                        h
                    } else {
                        0.0
                    };
                    place_fragment(&mut pb, c, &f, look);
                }
                Block::Table(t) => {
                    let f = table_fragment(t, width, &ctx);
                    place_fragment(&mut pb, c, &f, 0.0);
                }
            }
            i += 1;
        }
    }
    if let Some(c) = cur.as_mut() {
        if !c.items.is_empty() || !c.floats.is_empty() || pb.pages.is_empty() {
            pb.finish_page(c);
        }
    }

    // En-têtes et pieds de page (numéros de page connus maintenant)
    let total = pb.pages.len() as u32;
    let mut out = Vec::with_capacity(pb.pages.len());
    let mut page_in_section = 0u32;
    let mut last_section = usize::MAX;
    let mut number = 0u32;
    for (setup, body, floats, text, si) in pb.pages {
        let sec = &doc.sections[si];
        if si != last_section {
            page_in_section = 0;
            last_section = si;
            if let Some(start) = sec.page_number_start {
                number = start.saturating_sub(1);
            }
        }
        page_in_section += 1;
        number += 1;
        let ctx = LayoutCtx { page_number: number, page_count: total };
        let w = setup.width - setup.margin_left - setup.margin_right;
        let first = sec.title_page && page_in_section == 1;
        let even = doc.even_and_odd_headers && number % 2 == 0;
        let pick = |hf: &HeaderFooter| -> Option<Vec<Block>> {
            if first {
                return hf.first.clone();
            }
            if even {
                if let Some(e) = &hf.even {
                    return Some(e.clone());
                }
            }
            hf.default.clone()
        };
        let mut items: Vec<Item> = Vec::new();
        let mut hf_floats: Vec<Item> = Vec::new();
        let mut hf_cursor = Cursor { setup: setup.clone(), section: si, body_top: 0.0, body_bottom: setup.height, col: 0, y: 0.0, items: Vec::new(), floats: Vec::new(), text: String::new(), empty: true };
        if let Some(h) = pick(&sec.header) {
            let f = stack_blocks(&h, w, &ctx);
            items.push(Item::group(Transform::from_translate(setup.margin_left, setup.header_dist), None, f.items));
            for (fy, fl) in &f.floats {
                place_float(&mut hf_cursor, setup.header_dist + fy, fl);
            }
        }
        if let Some(ft) = pick(&sec.footer) {
            let f = stack_blocks(&ft, w, &ctx);
            let y = setup.height - setup.footer_dist - f.height;
            items.push(Item::group(Transform::from_translate(setup.margin_left, y), None, f.items));
            for (fy, fl) in &f.floats {
                place_float(&mut hf_cursor, y + fy, fl);
            }
        }
        hf_floats.extend(hf_cursor.items);
        hf_floats.extend(hf_cursor.floats);
        let mut all = Vec::new();
        // les objets des en-têtes (filigranes, logos) passent derrière le corps
        all.extend(hf_floats);
        all.extend(items);
        all.extend(body);
        all.extend(floats);
        out.push(Page { width: setup.width, height: setup.height, background: doc.background, items: all, text });
    }
    out
}
