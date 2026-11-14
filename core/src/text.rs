//! Mise en page de paragraphes riches : découpage en lignes (UAX #14), tabulations
//! (gauche/centre/droite, points de suite), justification, interlignes Word/LibreOffice.

use crate::color::Color;
use crate::display::{GlyphRun, Item, Rect, StrokeStyle};
use crate::fonts::{self, FontId, ResolvedFont};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum VertAlign {
    #[default]
    Baseline,
    Super,
    Sub,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextStyle {
    pub font: Arc<str>,
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub double_underline: bool,
    pub strike: bool,
    pub color: Color,
    pub highlight: Option<Color>,
    pub vert: VertAlign,
    pub caps: bool,
    pub small_caps: bool,
    /// Espacement supplémentaire entre caractères (points).
    pub spacing: f32,
    pub scale_x: f32,
    pub hidden: bool,
    /// Décalage vertical explicite (points, positif = vers le haut).
    pub baseline_shift: f32,
}

impl Default for TextStyle {
    fn default() -> Self {
        TextStyle {
            font: Arc::from("Liberation Serif"),
            size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            double_underline: false,
            strike: false,
            color: Color::BLACK,
            highlight: None,
            vert: VertAlign::Baseline,
            caps: false,
            small_caps: false,
            spacing: 0.0,
            scale_x: 1.0,
            hidden: false,
            baseline_shift: 0.0,
        }
    }
}

impl TextStyle {
    pub fn resolved(&self) -> ResolvedFont {
        fonts::db().resolve(&self.font, self.bold, self.italic)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Field {
    PageNumber,
    PageCount,
}

#[derive(Clone)]
pub enum Inline {
    Text(String, Arc<TextStyle>),
    Tab(Arc<TextStyle>),
    LineBreak(Arc<TextStyle>),
    /// Objet en ligne (image, forme) : éléments relatifs à son coin supérieur gauche.
    Object { width: f32, height: f32, items: Vec<Item>, style: Arc<TextStyle> },
    Field(Field, Arc<TextStyle>),
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LineSpacing {
    Multiple(f32),
    Exact(f32),
    AtLeast(f32),
}

impl Default for LineSpacing {
    fn default() -> Self {
        LineSpacing::Multiple(1.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TabKind {
    Left,
    Center,
    Right,
    Decimal,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabStop {
    pub pos: f32,
    pub kind: TabKind,
    pub leader: Option<char>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BorderLine {
    pub width: f32,
    pub color: Color,
    pub double: bool,
    pub dash: crate::display::DashStyle,
    /// Espace entre la bordure et le texte.
    pub space: f32,
}

impl BorderLine {
    pub fn solid(width: f32, color: Color) -> BorderLine {
        BorderLine { width, color, double: false, dash: crate::display::DashStyle::Solid, space: 0.0 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParaProps {
    pub align: Align,
    pub ind_left: f32,
    pub ind_right: f32,
    /// Retrait de première ligne (négatif = suspendu).
    pub ind_first: f32,
    pub space_before: f32,
    pub space_after: f32,
    pub line: LineSpacing,
    pub tabs: Vec<TabStop>,
    pub default_tab: f32,
    pub keep_next: bool,
    pub keep_lines: bool,
    pub page_break_before: bool,
    pub widow_control: bool,
    pub shading: Option<Color>,
    /// Bordures : haut, droite, bas, gauche.
    pub borders: [Option<BorderLine>; 4],
    pub contextual_spacing: bool,
    pub style_id: Option<Arc<str>>,
    /// Interligne mesuré à la manière de PowerPoint (pourcentage de 1,2 × taille).
    pub pp_line_mode: bool,
}

impl Default for ParaProps {
    fn default() -> Self {
        ParaProps {
            align: Align::Left,
            ind_left: 0.0,
            ind_right: 0.0,
            ind_first: 0.0,
            space_before: 0.0,
            space_after: 0.0,
            line: LineSpacing::Multiple(1.0),
            tabs: Vec::new(),
            default_tab: 36.0,
            keep_next: false,
            keep_lines: false,
            page_break_before: false,
            widow_control: true,
            shading: None,
            borders: [None, None, None, None],
            contextual_spacing: false,
            style_id: None,
            pp_line_mode: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct Paragraph {
    pub props: ParaProps,
    pub inlines: Vec<Inline>,
    /// Style de la marque de paragraphe (hauteur des paragraphes vides).
    pub mark: Arc<TextStyle>,
}

impl Paragraph {
    pub fn plain_text(&self) -> String {
        let mut s = String::new();
        for i in &self.inlines {
            match i {
                Inline::Text(t, _) => s.push_str(t),
                Inline::Tab(_) => s.push('\t'),
                Inline::LineBreak(_) => s.push('\n'),
                _ => {}
            }
        }
        s
    }
    pub fn is_empty(&self) -> bool {
        self.inlines.iter().all(|i| matches!(i, Inline::Text(t, _) if t.is_empty()))
    }
}

#[derive(Clone, Copy, Default)]
pub struct LayoutCtx {
    pub page_number: u32,
    pub page_count: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct LineBox {
    pub top: f32,
    pub height: f32,
}

#[derive(Clone, Default)]
pub struct ParaLayout {
    pub height: f32,
    pub lines: Vec<LineBox>,
    pub items: Vec<Item>,
    pub text: String,
    /// Largeur réellement occupée par le texte (la plus longue ligne).
    pub content_width: f32,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Glyph,
    Space,
    Tab,
    Break,
    Object(usize),
    Zero,
}

#[derive(Clone, Copy)]
struct Cl {
    kind: Kind,
    style: usize,
    font: FontId,
    gid: u16,
    adv: f32,
    size: f32,
    y_shift: f32,
    synth_bold: bool,
    synth_italic: bool,
    #[allow(dead_code)]
    ch: char,
}

struct Objects<'a> {
    list: Vec<(f32, f32, &'a Vec<Item>)>,
}

fn resolve_tab(props: &ParaProps, x: f32, first_line: bool) -> TabStop {
    let mut best: Option<TabStop> = None;
    for t in &props.tabs {
        if t.pos > x + 0.01 && best.map(|b| t.pos < b.pos).unwrap_or(true) {
            best = Some(*t);
        }
    }
    // Retrait suspendu : taquet implicite au retrait gauche.
    let hanging = props.ind_first < 0.0 || !first_line;
    if hanging && props.ind_left > x + 0.01 && best.map(|b| props.ind_left < b.pos).unwrap_or(true) && first_line {
        best = Some(TabStop { pos: props.ind_left, kind: TabKind::Left, leader: None });
    }
    if let Some(b) = best {
        return b;
    }
    let dt = if props.default_tab > 1.0 { props.default_tab } else { 36.0 };
    let n = ((x + 0.01) / dt).floor() + 1.0;
    TabStop { pos: n * dt, kind: TabKind::Left, leader: None }
}

struct PendingTab {
    stop: TabStop,
    x_at_tab: f32,
    first_cluster: usize,
}

/// Simule le placement horizontal des grappes [a, b) à partir de x.
fn advance_range(cls: &[Cl], a: usize, b: usize, mut x: f32, pending: &mut Option<PendingTab>, props: &ParaProps, first_line: bool) -> f32 {
    for (i, c) in cls.iter().enumerate().take(b).skip(a) {
        match c.kind {
            Kind::Tab => {
                if let Some(p) = pending.take() {
                    x = resolve_pending(&p, x);
                }
                let stop = resolve_tab(props, x, first_line);
                match stop.kind {
                    TabKind::Left => x = stop.pos.max(x),
                    _ => {
                        *pending = Some(PendingTab { stop, x_at_tab: x, first_cluster: i + 1 });
                    }
                }
            }
            Kind::Break => {}
            _ => x += c.adv,
        }
    }
    x
}

fn resolve_pending(p: &PendingTab, x: f32) -> f32 {
    let w = x - p.x_at_tab;
    match p.stop.kind {
        TabKind::Right | TabKind::Decimal => x.max(p.stop.pos),
        TabKind::Center => p.x_at_tab.max(p.stop.pos - w / 2.0) + w,
        TabKind::Left => x,
    }
}

fn effective_end(pending: &Option<PendingTab>, x: f32) -> f32 {
    match pending {
        Some(p) => resolve_pending(p, x),
        None => x,
    }
}

pub fn layout_paragraph(para: &Paragraph, width: f32, ctx: &LayoutCtx) -> ParaLayout {
    let db = fonts::db();
    let props = &para.props;
    // 1. Grappes ------------------------------------------------------------------
    let mut styles: Vec<Arc<TextStyle>> = Vec::new();
    let mut style_res: Vec<ResolvedFont> = Vec::new();
    let mut cls: Vec<Cl> = Vec::new();
    let mut text = String::new();
    let mut objects = Objects { list: Vec::new() };
    let mut plain = String::new();

    let style_index = |s: &Arc<TextStyle>, styles: &mut Vec<Arc<TextStyle>>, res: &mut Vec<ResolvedFont>| -> usize {
        if let Some(i) = styles.iter().position(|x| Arc::ptr_eq(x, s) || **x == **s) {
            return i;
        }
        styles.push(s.clone());
        res.push(s.resolved());
        styles.len() - 1
    };

    let push_text = |t: &str, si: usize, st: &TextStyle, rf: ResolvedFont, cls: &mut Vec<Cl>, text: &mut String| {
        let (base_size, y_shift) = match st.vert {
            VertAlign::Baseline => (st.size, st.baseline_shift),
            VertAlign::Super => (st.size * 0.65, st.size * 0.33 + st.baseline_shift),
            VertAlign::Sub => (st.size * 0.65, -st.size * 0.14 + st.baseline_shift),
        };
        let emit = |ch: char, size: f32, cls: &mut Vec<Cl>, text: &mut String| {
            let (kind, ch2) = match ch {
                ' ' | '\u{3000}' => (Kind::Space, ch),
                '\u{00A0}' | '\u{202F}' => (Kind::Glyph, ch),
                '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{200E}' | '\u{200F}' | '\u{FEFF}' | '\u{2060}' => (Kind::Zero, ch),
                '\r' | '\u{0}'..='\u{8}' | '\u{B}'..='\u{1F}' => (Kind::Zero, ' '),
                _ => (Kind::Glyph, ch),
            };
            let ch2 = fonts::map_symbol_char(&st.font, ch2);
            let (font, gid, adv) = if kind == Kind::Zero {
                (rf.id, 0, 0.0)
            } else {
                let (f, g) = db.glyph(rf.id, ch2);
                let mut a = db.advance(f, g) * size * st.scale_x + st.spacing;
                if rf.synth_bold {
                    a += size * 0.02;
                }
                (f, g, a)
            };
            cls.push(Cl { kind, style: si, font, gid, adv, size, y_shift, synth_bold: rf.synth_bold, synth_italic: rf.synth_italic, ch: ch2 });
            text.push(if kind == Kind::Zero { '\u{200B}' } else { ch2 });
        };
        for ch in t.chars() {
            if st.caps {
                for u in ch.to_uppercase() {
                    emit(u, base_size, cls, text);
                }
            } else if st.small_caps && ch.is_lowercase() {
                for u in ch.to_uppercase() {
                    emit(u, base_size * 0.8, cls, text);
                }
            } else {
                emit(ch, base_size, cls, text);
            }
        }
    };

    for inl in &para.inlines {
        match inl {
            Inline::Text(t, st) => {
                if st.hidden || t.is_empty() {
                    continue;
                }
                let si = style_index(st, &mut styles, &mut style_res);
                plain.push_str(t);
                push_text(t, si, st, style_res[si], &mut cls, &mut text);
            }
            Inline::Field(f, st) => {
                let si = style_index(st, &mut styles, &mut style_res);
                let t = match f {
                    Field::PageNumber => ctx.page_number.max(1).to_string(),
                    Field::PageCount => ctx.page_count.max(1).to_string(),
                };
                plain.push_str(&t);
                push_text(&t, si, st, style_res[si], &mut cls, &mut text);
            }
            Inline::Tab(st) => {
                let si = style_index(st, &mut styles, &mut style_res);
                let rf = style_res[si];
                cls.push(Cl { kind: Kind::Tab, style: si, font: rf.id, gid: 0, adv: 0.0, size: st.size, y_shift: 0.0, synth_bold: false, synth_italic: false, ch: '\t' });
                text.push('\t');
                plain.push('\t');
            }
            Inline::LineBreak(st) => {
                let si = style_index(st, &mut styles, &mut style_res);
                let rf = style_res[si];
                cls.push(Cl { kind: Kind::Break, style: si, font: rf.id, gid: 0, adv: 0.0, size: st.size, y_shift: 0.0, synth_bold: false, synth_italic: false, ch: '\n' });
                text.push('\n');
                plain.push('\n');
            }
            Inline::Object { width, height, items, style } => {
                let si = style_index(style, &mut styles, &mut style_res);
                let rf = style_res[si];
                objects.list.push((*width, *height, items));
                cls.push(Cl { kind: Kind::Object(objects.list.len() - 1), style: si, font: rf.id, gid: 0, adv: *width, size: style.size, y_shift: 0.0, synth_bold: false, synth_italic: false, ch: '\u{FFFC}' });
                text.push('\u{FFFC}');
            }
        }
    }

    let mark_si = style_index(&para.mark, &mut styles, &mut style_res);

    // 2. Opportunités de coupure -----------------------------------------------------
    let n = cls.len();
    let mut byte_to_cl = vec![0usize; text.len() + 1];
    {
        let mut ci = 0;
        for (bi, _) in text.char_indices() {
            byte_to_cl[bi] = ci;
            ci += 1;
        }
        byte_to_cl[text.len()] = n;
    }
    let mut breaks: Vec<(usize, bool)> = Vec::new();
    for (bi, op) in unicode_linebreak::linebreaks(&text) {
        let ci = byte_to_cl[bi];
        let mandatory = matches!(op, unicode_linebreak::BreakOpportunity::Mandatory);
        if ci < n || mandatory {
            breaks.push((ci, mandatory));
        }
    }
    // Les sauts de ligne explicites sont obligatoires.
    for (i, c) in cls.iter().enumerate() {
        if c.kind == Kind::Break && !breaks.iter().any(|b| b.0 == i + 1) {
            breaks.push((i + 1, true));
        }
    }
    breaks.sort_by_key(|b| b.0);
    breaks.dedup_by(|a, b| {
        if a.0 == b.0 {
            b.1 |= a.1;
            true
        } else {
            false
        }
    });
    if breaks.last().map(|b| b.0 != n).unwrap_or(true) {
        breaks.push((n, true));
    }

    // 3. Remplissage des lignes ---------------------------------------------------------
    let right = (width - props.ind_right).max(props.ind_left + 1.0);
    let line_start_x = |first: bool| -> f32 {
        if first {
            props.ind_left + props.ind_first
        } else {
            props.ind_left
        }
    };
    let trailing_ws_start = |a: usize, b: usize| -> usize {
        let mut e = b;
        while e > a && matches!(cls[e - 1].kind, Kind::Space | Kind::Break | Kind::Zero) {
            e -= 1;
        }
        e
    };

    struct LineRange {
        start: usize,
        end: usize,
        mandatory_end: bool,
    }
    let mut ranges: Vec<LineRange> = Vec::new();
    let mut pos = 0usize;
    let mut bi = 0usize;
    while pos < n {
        let first = ranges.is_empty();
        let x0 = line_start_x(first);
        let mut cur = pos;
        let mut pending: Option<PendingTab> = None;
        let mut x = x0;
        let mut mandatory_end = false;
        while bi < breaks.len() && breaks[bi].0 <= pos {
            bi += 1;
        }
        let mut accepted_any = false;
        let mut k = bi;
        while k < breaks.len() {
            let (seg_end, mand) = breaks[k];
            let content_end = trailing_ws_start(cur, seg_end);
            let mut p2 = pending.as_ref().map(|p| PendingTab { stop: p.stop, x_at_tab: p.x_at_tab, first_cluster: p.first_cluster });
            let x_content = advance_range(&cls, cur, content_end, x, &mut p2, props, first);
            let end_eff = effective_end(&p2, x_content);
            if end_eff <= right + 0.05 || !accepted_any && x0 >= right - 0.5 {
                x = advance_range(&cls, cur, seg_end, x, &mut pending, props, first);
                cur = seg_end;
                accepted_any = true;
                k += 1;
                if mand {
                    mandatory_end = true;
                    break;
                }
            } else {
                if !accepted_any {
                    // mot plus long que la ligne : coupe au caractère
                    let mut e = cur;
                    let mut xx = x;
                    let mut p3 = None;
                    while e < content_end {
                        let nx = advance_range(&cls, e, e + 1, xx, &mut p3, props, first);
                        if nx > right + 0.05 && e > cur {
                            break;
                        }
                        xx = nx;
                        e += 1;
                    }
                    cur = e.max(cur + 1);
                }
                break;
            }
        }
        if cur == pos {
            cur = (pos + 1).min(n);
        }
        ranges.push(LineRange { start: pos, end: cur, mandatory_end });
        pos = cur;
        bi = k;
    }
    if ranges.is_empty() {
        ranges.push(LineRange { start: 0, end: 0, mandatory_end: true });
    }
    // Un saut de ligne final crée une ligne vide supplémentaire.
    if n > 0 && cls[n - 1].kind == Kind::Break {
        ranges.push(LineRange { start: n, end: n, mandatory_end: true });
    }

    // 4. Positionnement ------------------------------------------------------------------
    let mut out = ParaLayout { text: plain, ..Default::default() };
    let mut y = props.space_before;
    let mut items: Vec<Item> = Vec::new();
    let mut highlight_items: Vec<Item> = Vec::new();
    let nlines = ranges.len();

    for (li, r) in ranges.iter().enumerate() {
        let first = li == 0;
        let x0 = line_start_x(first);
        let content_end = trailing_ws_start(r.start, r.end);
        // positions
        let mut xs = vec![0.0f32; r.end - r.start];
        let mut leaders: Vec<(f32, f32, char, usize)> = Vec::new();
        let mut x = x0;
        let mut pending: Option<PendingTab> = None;
        let mut last_tab_idx: Option<usize> = None;
        for i in r.start..r.end {
            let c = cls[i];
            match c.kind {
                Kind::Tab => {
                    if let Some(p) = pending.take() {
                        let nx = resolve_pending(&p, x);
                        let shift = nx - x;
                        for j in p.first_cluster..i {
                            xs[j - r.start] += shift;
                        }
                        if let Some(l) = p.stop.leader {
                            if let Some(lt) = leaders.last_mut() {
                                lt.1 += shift;
                            } else {
                                leaders.push((p.x_at_tab, p.x_at_tab + shift, l, c.style));
                            }
                        }
                        x = nx;
                    }
                    xs[i - r.start] = x;
                    let stop = resolve_tab(props, x, first);
                    match stop.kind {
                        TabKind::Left => {
                            if let Some(l) = stop.leader {
                                leaders.push((x, stop.pos, l, c.style));
                            }
                            x = stop.pos.max(x);
                        }
                        _ => {
                            if let Some(l) = stop.leader {
                                leaders.push((x, x, l, c.style));
                            }
                            pending = Some(PendingTab { stop, x_at_tab: x, first_cluster: i + 1 });
                        }
                    }
                    last_tab_idx = Some(i);
                }
                Kind::Break => xs[i - r.start] = x,
                _ => {
                    xs[i - r.start] = x;
                    x += c.adv;
                }
            }
        }
        if let Some(p) = pending.take() {
            let x_end_content = if content_end > r.start {
                let last = content_end - 1;
                xs[last - r.start] + cls[last].adv
            } else {
                x
            };
            let nx = resolve_pending(&p, x_end_content);
            let shift = nx - x_end_content;
            for j in p.first_cluster..r.end {
                xs[j - r.start] += shift;
            }
            if p.stop.leader.is_some() {
                if let Some(lt) = leaders.last_mut() {
                    lt.1 += shift;
                }
            }
        }
        let line_end_x = if content_end > r.start {
            let last = content_end - 1;
            xs[last - r.start] + cls[last].adv
        } else {
            x0
        };
        out.content_width = out.content_width.max(line_end_x);
        // alignement
        let free = right - line_end_x;
        let is_last = li + 1 == nlines || r.mandatory_end;
        let mut shift = 0.0;
        let mut extra_per_space = 0.0;
        let just_from = last_tab_idx.map(|t| t + 1).unwrap_or(r.start);
        match props.align {
            Align::Center if free > 0.0 => shift = free / 2.0,
            Align::Right if free > 0.0 => shift = free,
            Align::Justify if !is_last && free > 0.0 => {
                let spaces = (just_from..content_end).filter(|&i| cls[i].kind == Kind::Space).count();
                if spaces > 0 {
                    extra_per_space = free / spaces as f32;
                }
            }
            _ => {}
        }
        if extra_per_space > 0.0 {
            let mut acc = 0.0;
            for i in r.start..r.end {
                xs[i - r.start] += acc;
                if i >= just_from && i < content_end && cls[i].kind == Kind::Space {
                    acc += extra_per_space;
                }
            }
        }
        // métriques verticales
        let mut asc: f32 = 0.0;
        let mut desc: f32 = 0.0;
        let mut any = false;
        let mut max_size: f32 = 0.0;
        for i in r.start..content_end.max(r.start) {
            let c = cls[i];
            if let Kind::Object(oi) = c.kind {
                asc = asc.max(objects.list[oi].1);
                any = true;
                continue;
            }
            if c.kind == Kind::Zero {
                continue;
            }
            let st = &styles[c.style];
            let m = db.metrics(style_res[c.style].id);
            let sz = st.size;
            asc = asc.max((m.ascent + m.line_gap) * sz + c.y_shift.max(0.0));
            desc = desc.max(m.descent * sz - c.y_shift.min(0.0));
            max_size = max_size.max(sz);
            any = true;
        }
        if !any {
            let si = if r.start < n { cls[r.start.min(n - 1)].style } else { mark_si };
            let st = &styles[si];
            let m = db.metrics(style_res[si].id);
            asc = (m.ascent + m.line_gap) * st.size;
            desc = m.descent * st.size;
            max_size = st.size;
        }
        let natural = asc + desc;
        let (height, baseline) = match props.line {
            LineSpacing::Multiple(m) => {
                if props.pp_line_mode {
                    let h = natural * m;
                    (h, h - desc)
                } else {
                    let h = natural * m;
                    (h, h - desc)
                }
            }
            LineSpacing::Exact(v) => (v, v - desc.min(v * 0.3)),
            LineSpacing::AtLeast(v) => {
                let h = natural.max(v);
                (h, h - desc)
            }
        };
        let _ = max_size;
        let top = y;
        let base_y = top + baseline;

        // éléments graphiques
        let mut run: Option<GlyphRun> = None;
        let mut run_style = usize::MAX;
        let flush = |run: &mut Option<GlyphRun>, items: &mut Vec<Item>| {
            if let Some(r) = run.take() {
                if !r.glyphs.is_empty() {
                    items.push(Item::Text(r));
                }
            }
        };
        let mut deco: Vec<(usize, f32, f32, f32)> = Vec::new(); // style, x1, x2, y_shift
        for i in r.start..r.end {
            let c = cls[i];
            let cx = xs[i - r.start] + shift;
            match c.kind {
                Kind::Glyph | Kind::Space => {
                    let st = &styles[c.style];
                    let y_run = base_y - c.y_shift;
                    let same = run.as_ref().map(|g| g.font == c.font && (g.size - c.size).abs() < 0.01 && g.color == st.color && (g.y - y_run).abs() < 0.01 && g.synth_bold == c.synth_bold && g.synth_italic == c.synth_italic && (g.scale_x - st.scale_x).abs() < 0.001).unwrap_or(false);
                    if !same {
                        flush(&mut run, &mut items);
                        run = Some(GlyphRun { font: c.font, size: c.size, color: st.color, x: cx, y: y_run, glyphs: Vec::new(), synth_bold: c.synth_bold, synth_italic: c.synth_italic, scale_x: st.scale_x });
                    }
                    if c.kind == Kind::Glyph {
                        if let Some(g) = run.as_mut() {
                            let gx = cx - g.x;
                            g.glyphs.push((c.gid, gx));
                        }
                    }
                    let adv = c.adv + if c.kind == Kind::Space && i >= just_from && i < content_end { extra_per_space } else { 0.0 };
                    if (st.underline || st.strike || st.double_underline || st.highlight.is_some()) && i < content_end {
                        if run_style == c.style && deco.last().map(|d| (d.2 - cx).abs() < 0.5).unwrap_or(false) {
                            if let Some(d) = deco.last_mut() {
                                d.2 = cx + adv;
                            }
                        } else {
                            deco.push((c.style, cx, cx + adv, c.y_shift));
                        }
                        run_style = c.style;
                    } else {
                        run_style = usize::MAX;
                    }
                }
                Kind::Object(oi) => {
                    flush(&mut run, &mut items);
                    let (ow, oh, oitems) = objects.list[oi];
                    let _ = ow;
                    for it in oitems.iter() {
                        let mut it = it.clone();
                        it.translate(cx, base_y - oh);
                        items.push(it);
                    }
                    run_style = usize::MAX;
                }
                _ => {
                    run_style = usize::MAX;
                }
            }
        }
        flush(&mut run, &mut items);
        // points de suite
        for (lx1, lx2, lch, si) in leaders {
            let (lx1, lx2) = (lx1 + shift, lx2 + shift);
            if lx2 - lx1 < 2.0 {
                continue;
            }
            let st = &styles[si];
            let rf = style_res[si];
            let ch = match lch {
                '.' => '.',
                '-' => '-',
                '_' => '_',
                '·' => '·',
                c => c,
            };
            let (f, g) = db.glyph(rf.id, ch);
            let adv = db.advance(f, g) * st.size;
            if adv <= 0.1 {
                continue;
            }
            let step = if ch == '.' { adv.max(st.size * 0.3) } else { adv };
            let mut gl = Vec::new();
            let mut gx = ((lx1 / step).ceil()) * step;
            while gx + adv <= lx2 - 1.0 {
                gl.push((g, gx - lx1));
                gx += step;
            }
            if !gl.is_empty() {
                items.push(Item::Text(GlyphRun { font: f, size: st.size, color: st.color, x: lx1, y: base_y, glyphs: gl, synth_bold: false, synth_italic: false, scale_x: 1.0 }));
            }
        }
        // soulignés, barrés, surlignage
        for (si, x1, x2, ys) in deco {
            let st = &styles[si];
            let m = db.metrics(style_res[si].id);
            let size = match st.vert {
                VertAlign::Baseline => st.size,
                _ => st.size * 0.65,
            };
            if let Some(h) = st.highlight {
                let a = (m.ascent) * st.size;
                let d = m.descent * st.size;
                highlight_items.push(Item::FillRect { rect: Rect::new(x1, base_y - a, x2 - x1, a + d), color: h });
            }
            let th = (m.underline_thickness * size).max(0.5);
            if st.underline || st.double_underline {
                let uy = base_y - ys - m.underline_pos * size + th / 2.0;
                items.push(Item::Line { x1, y1: uy, x2, y2: uy, stroke: StrokeStyle::new(st.color, th) });
                if st.double_underline {
                    let uy2 = uy + th * 2.0;
                    items.push(Item::Line { x1, y1: uy2, x2, y2: uy2, stroke: StrokeStyle::new(st.color, th) });
                }
            }
            if st.strike {
                let sy = base_y - ys - m.strike_pos * size + m.strike_thickness * size / 2.0;
                items.push(Item::Line { x1, y1: sy, x2, y2: sy, stroke: StrokeStyle::new(st.color, (m.strike_thickness * size).max(0.5)) });
            }
        }
        out.lines.push(LineBox { top, height });
        y += height;
    }
    let text_bottom = y;
    y += props.space_after;
    out.height = y;

    // fond et bordures du paragraphe
    let mut bg: Vec<Item> = Vec::new();
    let has_border = props.borders.iter().any(|b| b.is_some());
    if props.shading.is_some() || has_border {
        let bx1 = props.ind_left.min(props.ind_left + props.ind_first);
        let bx2 = width - props.ind_right;
        let by1 = props.space_before;
        let by2 = text_bottom;
        if let Some(c) = props.shading {
            bg.push(Item::FillRect { rect: Rect::new(bx1, by1, bx2 - bx1, by2 - by1), color: c });
        }
        let [t, rgt, b, l] = &props.borders;
        if let Some(bl) = t {
            let yy = by1 - bl.space - bl.width / 2.0;
            bg.push(Item::Line { x1: bx1, y1: yy, x2: bx2, y2: yy, stroke: StrokeStyle { color: bl.color, width: bl.width, dash: bl.dash } });
        }
        if let Some(bl) = b {
            let yy = by2 + bl.space + bl.width / 2.0;
            bg.push(Item::Line { x1: bx1, y1: yy, x2: bx2, y2: yy, stroke: StrokeStyle { color: bl.color, width: bl.width, dash: bl.dash } });
            if bl.double {
                let yy2 = yy + bl.width * 2.0;
                bg.push(Item::Line { x1: bx1, y1: yy2, x2: bx2, y2: yy2, stroke: StrokeStyle { color: bl.color, width: bl.width, dash: bl.dash } });
            }
        }
        if let Some(bl) = l {
            let xx = bx1 - bl.space - bl.width / 2.0;
            bg.push(Item::Line { x1: xx, y1: by1, x2: xx, y2: by2, stroke: StrokeStyle { color: bl.color, width: bl.width, dash: bl.dash } });
        }
        if let Some(bl) = rgt {
            let xx = bx2 + bl.space + bl.width / 2.0;
            bg.push(Item::Line { x1: xx, y1: by1, x2: xx, y2: by2, stroke: StrokeStyle { color: bl.color, width: bl.width, dash: bl.dash } });
        }
    }
    bg.extend(highlight_items);
    bg.extend(items);
    out.items = bg;
    out
}

/// Largeur naturelle (sans retour à la ligne) d'un paragraphe.
pub fn natural_width(para: &Paragraph) -> f32 {
    let l = layout_paragraph(para, 1.0e6, &LayoutCtx::default());
    l.content_width + para.props.ind_right
}

/// Hauteur de ligne « simple » pour un style.
pub fn single_line_height(st: &TextStyle) -> f32 {
    let db = fonts::db();
    let m = db.metrics(st.resolved().id);
    m.line_height() * st.size
}
