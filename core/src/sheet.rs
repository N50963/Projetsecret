//! Classeurs : modèle commun (XLSX, ODS, XLS, CSV) et rendu de zones de feuille.

use crate::color::Color;
use crate::display::{Item, Rect, StrokeStyle};
use crate::fonts;
use crate::render::Canvas;
use crate::text::{layout_paragraph, Align, BorderLine, Inline, LayoutCtx, LineSpacing, ParaProps, Paragraph, TextStyle};
use std::sync::Arc;
use tiny_skia::{Pixmap, Transform};

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum HAlign {
    #[default]
    General,
    Left,
    Center,
    Right,
    Fill,
    Justify,
    CenterAcross,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum VAlign {
    Top,
    Center,
    #[default]
    Bottom,
}

#[derive(Clone, Debug)]
pub struct CellStyle {
    pub font: Arc<TextStyle>,
    pub fill: Option<Color>,
    /// haut, droite, bas, gauche
    pub borders: [Option<BorderLine>; 4],
    pub halign: HAlign,
    pub valign: VAlign,
    pub wrap: bool,
    pub indent: f32,
    pub rotation: i32,
    pub shrink: bool,
}

impl Default for CellStyle {
    fn default() -> Self {
        CellStyle {
            font: Arc::new(TextStyle { font: Arc::from("Calibri"), size: 11.0, ..Default::default() }),
            fill: None,
            borders: [None, None, None, None],
            halign: HAlign::General,
            valign: VAlign::Bottom,
            wrap: false,
            indent: 0.0,
            rotation: 0,
            shrink: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum CellKind {
    #[default]
    Empty,
    Text,
    Number,
    Bool,
    Error,
}

#[derive(Clone, Debug, Default)]
pub struct Cell {
    pub col: u32,
    pub text: String,
    pub kind: CellKind,
    pub style: u32,
    /// Couleur imposée par le format numérique ([Rouge]...).
    pub color: Option<Color>,
    /// Texte enrichi (plusieurs styles dans une cellule).
    pub rich: Option<Vec<(String, Arc<TextStyle>)>>,
}

#[derive(Clone, Copy, Debug)]
pub struct Merge {
    pub r1: u32,
    pub c1: u32,
    pub r2: u32,
    pub c2: u32,
}

#[derive(Clone)]
pub struct Drawing {
    pub rect: Rect,
    pub items: Vec<Item>,
}

#[derive(Clone)]
pub struct Sheet {
    pub name: String,
    pub col_widths: Vec<f32>,
    pub row_heights: Vec<f32>,
    pub rows: Vec<Vec<Cell>>,
    pub merges: Vec<Merge>,
    pub styles: Arc<Vec<CellStyle>>,
    pub show_grid: bool,
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    pub drawings: Vec<Drawing>,
    pub hidden: bool,
    pub tab_color: Option<Color>,
    col_x: Vec<f32>,
    row_y: Vec<f32>,
}

pub struct Workbook {
    pub sheets: Vec<Sheet>,
}

/// Données brutes d'une feuille avant finalisation.
pub struct SheetBuilder {
    pub name: String,
    pub default_col_width: f32,
    pub default_row_height: f32,
    pub col_widths: Vec<(u32, u32, f32, bool)>, // de, à, largeur, masquée
    pub row_heights: Vec<(u32, f32, bool)>,     // ligne, hauteur, masquée
    pub cells: Vec<(u32, Cell)>,                // (ligne, cellule)
    pub merges: Vec<Merge>,
    pub styles: Arc<Vec<CellStyle>>,
    pub show_grid: bool,
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    pub drawings: Vec<Drawing>,
    pub hidden: bool,
    pub tab_color: Option<Color>,
    pub min_rows: u32,
    pub min_cols: u32,
}

impl SheetBuilder {
    pub fn new(name: &str, styles: Arc<Vec<CellStyle>>) -> SheetBuilder {
        SheetBuilder {
            name: name.to_string(),
            default_col_width: 48.0,
            default_row_height: 15.0,
            col_widths: Vec::new(),
            row_heights: Vec::new(),
            cells: Vec::new(),
            merges: Vec::new(),
            styles,
            show_grid: true,
            frozen_rows: 0,
            frozen_cols: 0,
            drawings: Vec::new(),
            hidden: false,
            tab_color: None,
            min_rows: 40,
            min_cols: 12,
        }
    }

    pub fn build(self) -> Sheet {
        let mut max_row = 0u32;
        let mut max_col = 0u32;
        for (r, c) in &self.cells {
            let visible = !c.text.is_empty() || self.styles.get(c.style as usize).map(|s| s.fill.is_some() || s.borders.iter().any(|b| b.is_some())).unwrap_or(false);
            if visible {
                max_row = max_row.max(r + 1);
                max_col = max_col.max(c.col + 1);
            }
        }
        for m in &self.merges {
            max_row = max_row.max(m.r2 + 1);
            max_col = max_col.max(m.c2 + 1);
        }
        let nrows = (max_row + 20).max(self.min_rows).min(1_048_576);
        let mut ncols = (max_col + 3).max(self.min_cols).min(16_384);
        // les dessins peuvent dépasser la zone utilisée
        let mut col_widths = vec![self.default_col_width; ncols as usize];
        for (a, b, w, hidden) in &self.col_widths {
            for c in *a..=(*b).min(ncols.saturating_sub(1)) {
                col_widths[c as usize] = if *hidden { 0.0 } else { *w };
            }
        }
        let mut row_heights = vec![-1.0f32; nrows as usize];
        for (r, h, hidden) in &self.row_heights {
            if (*r as usize) < row_heights.len() {
                row_heights[*r as usize] = if *hidden { 0.0 } else { *h };
            }
        }
        let mut rows: Vec<Vec<Cell>> = vec![Vec::new(); nrows as usize];
        for (r, c) in self.cells {
            if (r as usize) < rows.len() && c.col < ncols {
                rows[r as usize].push(c);
            }
        }
        for row in &mut rows {
            row.sort_by_key(|c| c.col);
            row.dedup_by_key(|c| c.col);
        }
        // hauteur automatique des lignes sans hauteur explicite
        for (ri, row) in rows.iter().enumerate() {
            if row_heights[ri] >= 0.0 {
                continue;
            }
            let mut h = self.default_row_height;
            for c in row {
                if c.text.is_empty() {
                    continue;
                }
                let st = self.styles.get(c.style as usize).cloned().unwrap_or_default();
                let lh = crate::text::single_line_height(&st.font);
                if st.wrap {
                    let w = col_widths.get(c.col as usize).copied().unwrap_or(48.0) - 4.0;
                    let p = cell_paragraph(c, &st, Align::Left, true);
                    let l = layout_paragraph(&p, w.max(4.0), &LayoutCtx::default());
                    h = h.max(l.height + 3.0);
                } else {
                    h = h.max(lh + 2.0);
                }
            }
            row_heights[ri] = h;
        }
        // agrandit pour englober les dessins
        let mut sheet = Sheet {
            name: self.name,
            col_widths,
            row_heights,
            rows,
            merges: self.merges,
            styles: self.styles,
            show_grid: self.show_grid,
            frozen_rows: self.frozen_rows,
            frozen_cols: self.frozen_cols,
            drawings: self.drawings,
            hidden: self.hidden,
            tab_color: self.tab_color,
            col_x: Vec::new(),
            row_y: Vec::new(),
        };
        sheet.recompute();
        let (mut w, mut h) = (sheet.width(), sheet.height());
        let maxx = sheet.drawings.iter().map(|d| d.rect.right()).fold(0.0, f32::max);
        let maxy = sheet.drawings.iter().map(|d| d.rect.bottom()).fold(0.0, f32::max);
        while w < maxx + 20.0 && ncols < 16_384 {
            sheet.col_widths.push(self.default_col_width);
            ncols += 1;
            w += self.default_col_width;
        }
        while h < maxy + 20.0 {
            sheet.row_heights.push(self.default_row_height);
            sheet.rows.push(Vec::new());
            h += self.default_row_height;
        }
        sheet.recompute();
        sheet
    }
}

fn cell_paragraph(c: &Cell, st: &CellStyle, align: Align, wrap: bool) -> Paragraph {
    let font = match c.color {
        Some(col) => Arc::new(TextStyle { color: col, ..(*st.font).clone() }),
        None => st.font.clone(),
    };
    let inlines = match &c.rich {
        Some(runs) => runs.iter().map(|(t, s)| Inline::Text(t.clone(), s.clone())).collect(),
        None => {
            if wrap {
                let mut v = Vec::new();
                for (i, line) in c.text.split('\n').enumerate() {
                    if i > 0 {
                        v.push(Inline::LineBreak(font.clone()));
                    }
                    v.push(Inline::Text(line.to_string(), font.clone()));
                }
                v
            } else {
                vec![Inline::Text(c.text.replace('\n', " "), font.clone())]
            }
        }
    };
    Paragraph { props: ParaProps { align, line: LineSpacing::Multiple(1.0), widow_control: false, ..Default::default() }, inlines, mark: font }
}

impl Sheet {
    pub fn recompute(&mut self) {
        self.col_x = Vec::with_capacity(self.col_widths.len() + 1);
        let mut x = 0.0;
        self.col_x.push(0.0);
        for w in &self.col_widths {
            x += w;
            self.col_x.push(x);
        }
        self.row_y = Vec::with_capacity(self.row_heights.len() + 1);
        let mut y = 0.0;
        self.row_y.push(0.0);
        for h in &self.row_heights {
            y += h.max(0.0);
            self.row_y.push(y);
        }
    }

    pub fn ncols(&self) -> usize {
        self.col_widths.len()
    }
    pub fn nrows(&self) -> usize {
        self.row_heights.len()
    }
    pub fn width(&self) -> f32 {
        *self.col_x.last().unwrap_or(&0.0)
    }
    pub fn height(&self) -> f32 {
        *self.row_y.last().unwrap_or(&0.0)
    }
    pub fn col_x(&self, c: usize) -> f32 {
        self.col_x[c.min(self.col_x.len() - 1)]
    }
    pub fn row_y(&self, r: usize) -> f32 {
        self.row_y[r.min(self.row_y.len() - 1)]
    }
    /// Colonne contenant l'abscisse x.
    pub fn col_at(&self, x: f32) -> usize {
        match self.col_x.binary_search_by(|v| v.partial_cmp(&x).unwrap()) {
            Ok(i) => i.min(self.ncols().saturating_sub(1)),
            Err(i) => i.saturating_sub(1).min(self.ncols().saturating_sub(1)),
        }
    }
    pub fn row_at(&self, y: f32) -> usize {
        match self.row_y.binary_search_by(|v| v.partial_cmp(&y).unwrap()) {
            Ok(i) => i.min(self.nrows().saturating_sub(1)),
            Err(i) => i.saturating_sub(1).min(self.nrows().saturating_sub(1)),
        }
    }

    pub fn cell(&self, r: usize, c: u32) -> Option<&Cell> {
        let row = self.rows.get(r)?;
        row.binary_search_by_key(&c, |x| x.col).ok().map(|i| &row[i])
    }

    fn merge_at(&self, r: u32, c: u32) -> Option<&Merge> {
        self.merges.iter().find(|m| r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2)
    }

    fn style(&self, i: u32) -> CellStyle {
        self.styles.get(i as usize).cloned().unwrap_or_default()
    }

    /// Nom de colonne (« A », « AB »...).
    pub fn col_name(mut c: usize) -> String {
        let mut s = Vec::new();
        loop {
            s.push((b'A' + (c % 26) as u8) as char);
            if c < 26 {
                break;
            }
            c = c / 26 - 1;
        }
        s.iter().rev().collect()
    }

    /// Dessine la zone (x0, y0) de la feuille avec `scale` pixels par point.
    pub fn render_region(&self, pixmap: &mut Pixmap, scale: f32, x0: f32, y0: f32) {
        pixmap.fill(tiny_skia::Color::WHITE);
        let vw = pixmap.width() as f32 / scale;
        let vh = pixmap.height() as f32 / scale;
        let ts = Transform::from_scale(scale, scale).pre_translate(-x0, -y0);
        let items = self.region_items(Rect::new(x0, y0, vw, vh), scale);
        let mut canvas = Canvas::new(pixmap);
        canvas.draw_items(&items, ts, None);
    }

    /// Éléments graphiques couvrant une zone de la feuille.
    pub fn region_items(&self, view: Rect, scale: f32) -> Vec<Item> {
        let mut fills = Vec::new();
        let mut grid = Vec::new();
        let mut borders = Vec::new();
        let mut texts = Vec::new();
        if self.nrows() == 0 || self.ncols() == 0 {
            return Vec::new();
        }
        let r0 = self.row_at(view.y);
        let r1 = self.row_at(view.bottom());
        let c0 = self.col_at(view.x);
        let c1 = self.col_at(view.right());
        let grid_color = Color::rgb(218, 220, 224);
        let gw = 1.0 / scale.max(0.1);
        if self.show_grid {
            for c in c0..=c1 + 1 {
                let x = self.col_x(c);
                grid.push(Item::Line { x1: x, y1: self.row_y(r0), x2: x, y2: self.row_y(r1 + 1), stroke: StrokeStyle::new(grid_color, gw) });
            }
            for r in r0..=r1 + 1 {
                let y = self.row_y(r);
                grid.push(Item::Line { x1: self.col_x(c0), y1: y, x2: self.col_x(c1 + 1), y2: y, stroke: StrokeStyle::new(grid_color, gw) });
            }
        }
        // zones fusionnées visibles : fond blanc (masque le quadrillage) ou couleur
        let mut merged_drawn: Vec<usize> = Vec::new();
        for (mi, m) in self.merges.iter().enumerate() {
            if (m.r2 as usize) < r0 || (m.r1 as usize) > r1 || (m.c2 as usize) < c0 || (m.c1 as usize) > c1 {
                continue;
            }
            let rect = Rect::new(self.col_x(m.c1 as usize), self.row_y(m.r1 as usize), self.col_x(m.c2 as usize + 1) - self.col_x(m.c1 as usize), self.row_y(m.r2 as usize + 1) - self.row_y(m.r1 as usize));
            let st = self.cell(m.r1 as usize, m.c1).map(|c| self.style(c.style)).unwrap_or_default();
            fills.push(Item::FillRect { rect, color: st.fill.unwrap_or(Color::WHITE) });
            merged_drawn.push(mi);
        }
        for r in r0..=r1.min(self.nrows() - 1) {
            let ry = self.row_y(r);
            let rh = self.row_heights[r];
            if rh <= 0.0 {
                continue;
            }
            let row = &self.rows[r];
            for (ci, cell) in row.iter().enumerate() {
                let c = cell.col as usize;
                let st = self.style(cell.style);
                let merge = self.merge_at(r as u32, cell.col);
                let in_view_col = c >= c0 && c <= c1;
                // fond
                if in_view_col && merge.is_none() {
                    if let Some(f) = st.fill {
                        fills.push(Item::FillRect { rect: Rect::new(self.col_x(c), ry, self.col_widths[c], rh), color: f });
                    }
                }
                // bordures
                if in_view_col {
                    let (x1, y1, x2, y2) = match merge {
                        Some(m) => (self.col_x(m.c1 as usize), self.row_y(m.r1 as usize), self.col_x(m.c2 as usize + 1), self.row_y(m.r2 as usize + 1)),
                        None => (self.col_x(c), ry, self.col_x(c + 1), ry + rh),
                    };
                    let edge = |b: &Option<BorderLine>, items: &mut Vec<Item>, a: (f32, f32), z: (f32, f32)| {
                        if let Some(bl) = b {
                            let s = StrokeStyle { color: bl.color, width: bl.width.max(gw), dash: bl.dash };
                            if bl.double {
                                let o = bl.width.max(gw) * 1.2;
                                let (dx, dy) = if (a.1 - z.1).abs() < 0.01 { (0.0, o) } else { (o, 0.0) };
                                items.push(Item::Line { x1: a.0 - dx, y1: a.1 - dy, x2: z.0 - dx, y2: z.1 - dy, stroke: s.clone() });
                                items.push(Item::Line { x1: a.0 + dx, y1: a.1 + dy, x2: z.0 + dx, y2: z.1 + dy, stroke: s });
                            } else {
                                items.push(Item::Line { x1: a.0, y1: a.1, x2: z.0, y2: z.1, stroke: s });
                            }
                        }
                    };
                    let on_top = merge.map(|m| m.r1 as usize == r).unwrap_or(true);
                    let on_bottom = merge.map(|m| m.r2 as usize == r).unwrap_or(true);
                    let on_left = merge.map(|m| m.c1 as usize == c).unwrap_or(true);
                    let on_right = merge.map(|m| m.c2 as usize == c).unwrap_or(true);
                    let (cx1, cx2) = (self.col_x(c), self.col_x(c + 1));
                    if on_top {
                        edge(&st.borders[0], &mut borders, (cx1, y1), (cx2, y1));
                    }
                    if on_bottom {
                        edge(&st.borders[2], &mut borders, (cx1, y2), (cx2, y2));
                    }
                    if on_left {
                        edge(&st.borders[3], &mut borders, (x1, ry), (x1, ry + rh));
                    }
                    if on_right {
                        edge(&st.borders[1], &mut borders, (x2, ry), (x2, ry + rh));
                    }
                }
                // texte
                if cell.text.is_empty() && cell.rich.is_none() {
                    continue;
                }
                if let Some(m) = merge {
                    if m.r1 as usize != r || m.c1 != cell.col {
                        continue;
                    }
                }
                let (mut x1, y1, mut x2, y2) = match merge {
                    Some(m) => (self.col_x(m.c1 as usize), self.row_y(m.r1 as usize), self.col_x(m.c2 as usize + 1), self.row_y(m.r2 as usize + 1)),
                    None => (self.col_x(c), ry, self.col_x(c + 1), ry + rh),
                };
                let align = match st.halign {
                    HAlign::General => match cell.kind {
                        CellKind::Number => HAlign::Right,
                        CellKind::Bool | CellKind::Error => HAlign::Center,
                        _ => HAlign::Left,
                    },
                    a => a,
                };
                let pad = 2.0;
                let cell_w = x2 - x1;
                let mut text_cell = cell.clone();
                // débordement horizontal du texte non renvoyé à la ligne
                let mut clip = Rect::new(x1, y1, x2 - x1, y2 - y1);
                if !st.wrap && merge.is_none() {
                    let p = cell_paragraph(cell, &st, Align::Left, false);
                    let natural = crate::text::natural_width(&p) + 2.0 * pad + st.indent;
                    if natural > cell_w {
                        if cell.kind == CellKind::Number {
                            // nombre trop large : « ### »
                            let db = fonts::db();
                            let hw = db.measure(st.font.resolved(), st.font.size, "#").max(1.0);
                            let n = ((cell_w - 2.0 * pad) / hw).floor().max(1.0) as usize;
                            text_cell.text = "#".repeat(n);
                            text_cell.rich = None;
                        } else {
                            let empty = |cc: usize| -> bool { self.cell(r, cc as u32).map(|x| x.text.is_empty() && x.rich.is_none()).unwrap_or(true) && self.merge_at(r as u32, cc as u32).is_none() };
                            let extra = natural - cell_w;
                            match align {
                                HAlign::Left | HAlign::Justify | HAlign::Fill => {
                                    let mut cc = c + 1;
                                    while x2 < x1 + natural && cc < self.ncols() && empty(cc) {
                                        x2 = self.col_x(cc + 1);
                                        cc += 1;
                                    }
                                }
                                HAlign::Right => {
                                    let mut cc = c as isize - 1;
                                    while x1 > x2 - natural && cc >= 0 && empty(cc as usize) {
                                        x1 = self.col_x(cc as usize);
                                        cc -= 1;
                                    }
                                }
                                _ => {
                                    let (mut l, mut rr) = (c as isize - 1, c + 1);
                                    let mut need = extra / 2.0;
                                    while need > 0.0 && l >= 0 && rr < self.ncols() && empty(l as usize) && empty(rr) {
                                        x1 = self.col_x(l as usize);
                                        x2 = self.col_x(rr + 1);
                                        need -= self.col_widths[rr].min(self.col_widths[l as usize]);
                                        l -= 1;
                                        rr += 1;
                                    }
                                    // recentrer sur la cellule d'origine
                                    let center = self.col_x(c) + cell_w / 2.0;
                                    let half = (center - x1).min(x2 - center);
                                    x1 = center - half;
                                    x2 = center + half;
                                }
                            }
                            clip = Rect::new(x1, y1, x2 - x1, y2 - y1);
                        }
                    }
                }
                // ignorer ce qui est hors de vue
                if clip.right() < view.x || clip.x > view.right() {
                    continue;
                }
                let _ = ci;
                let palign = match align {
                    HAlign::Center | HAlign::CenterAcross => Align::Center,
                    HAlign::Right => Align::Right,
                    HAlign::Justify => Align::Justify,
                    _ => Align::Left,
                };
                let mut para = cell_paragraph(&text_cell, &st, palign, st.wrap);
                para.props.ind_left = if palign == Align::Left { st.indent } else { 0.0 };
                para.props.ind_right = if palign == Align::Right { st.indent } else { 0.0 };
                let avail_w = (x2 - x1 - 2.0 * pad).max(1.0);
                let lay_w = if st.wrap { avail_w } else { avail_w.max(crate::text::natural_width(&para) + 1.0) };
                let l = layout_paragraph(&para, lay_w, &LayoutCtx::default());
                let mut tx = x1 + pad;
                if !st.wrap {
                    // alignement manuel quand la largeur de mise en page dépasse la zone
                    let content = l.content_width;
                    tx = match palign {
                        Align::Right => x2 - pad - content,
                        Align::Center => (x1 + x2) / 2.0 - content / 2.0,
                        _ => x1 + pad,
                    };
                    para.props.align = Align::Left;
                }
                let l = if !st.wrap { layout_paragraph(&para, lay_w, &LayoutCtx::default()) } else { l };
                let ty = match st.valign {
                    VAlign::Top => y1 + 1.0,
                    VAlign::Center => y1 + ((y2 - y1) - l.height) / 2.0,
                    VAlign::Bottom => y2 - l.height - 1.0,
                };
                let inner = Item::group(Transform::from_translate(tx, ty), None, l.items);
                texts.push(Item::group(Transform::identity(), Some(clip), vec![inner]));
            }
        }
        let mut items = grid;
        items.extend(fills);
        items.extend(borders);
        items.extend(texts);
        for d in &self.drawings {
            if d.rect.intersects(&view) {
                items.push(Item::group(Transform::from_translate(d.rect.x, d.rect.y), None, d.items.clone()));
            }
        }
        let _ = merged_drawn;
        items
    }
}

/// Rend chaque feuille en PNG (outil de test).
pub fn debug_render(wb: &Workbook, out: &std::path::Path, scale: f32) {
    for (i, s) in wb.sheets.iter().enumerate() {
        let w = (s.width().min(1400.0) * scale) as u32;
        let h = (s.height().min(1000.0) * scale) as u32;
        if let Some(mut pm) = Pixmap::new(w.max(1), h.max(1)) {
            s.render_region(&mut pm, scale, 0.0, 0.0);
            let _ = pm.save_png(out.join(format!("sheet-{:02}.png", i + 1)));
            println!("  feuille {} « {} » : {}x{} cellules", i + 1, s.name, s.ncols(), s.nrows());
        }
    }
}
