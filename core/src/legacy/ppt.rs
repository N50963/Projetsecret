//! Présentations PowerPoint 97-2003 (.ppt, .pps — format binaire MS-PPT).

use super::read_stream;
use crate::color::Color;
use crate::display::{Item, Page, Paint, Rect, StrokeStyle};
use crate::flow::{self, Block};
use crate::ooxml::drawingml as dml;
use crate::text::*;
use std::collections::HashMap;
use std::sync::Arc;
use tiny_skia::Transform;

fn u16le(b: &[u8], o: usize) -> u16 {
    b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]])).unwrap_or(0)
}
fn i16le(b: &[u8], o: usize) -> i16 {
    u16le(b, o) as i16
}
fn u32le(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])).unwrap_or(0)
}
fn i32le(b: &[u8], o: usize) -> i32 {
    u32le(b, o) as i32
}

#[derive(Clone, Copy)]
struct Rh {
    ver: u16,
    inst: u16,
    ty: u16,
    len: usize,
}

fn rh(b: &[u8], o: usize) -> Option<Rh> {
    if o + 8 > b.len() {
        return None;
    }
    let vi = u16le(b, o);
    Some(Rh { ver: vi & 0xF, inst: vi >> 4, ty: u16le(b, o + 2), len: u32le(b, o + 4) as usize })
}

/// Enfants d'un conteneur : (en-tête, début des données).
fn children(b: &[u8], start: usize, len: usize) -> Vec<(Rh, usize)> {
    let mut out = Vec::new();
    let mut o = start;
    let end = (start + len).min(b.len());
    while o + 8 <= end {
        let Some(h) = rh(b, o) else { break };
        out.push((h, o + 8));
        o += 8 + h.len;
    }
    out
}

fn find(b: &[u8], start: usize, len: usize, ty: u16) -> Option<(Rh, usize)> {
    children(b, start, len).into_iter().find(|(h, _)| h.ty == ty)
}

/// Unités maîtres PowerPoint (576 ppp) -> points.
const MU: f32 = 72.0 / 576.0;
const EMU: f32 = 1.0 / 12700.0;

#[derive(Clone, Default)]
struct Cf {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    font: Option<u16>,
    size: Option<f32>,
    color: Option<Color>,
    position: Option<i16>,
}

#[derive(Clone, Default)]
struct Pf {
    bullet: Option<bool>,
    bullet_char: Option<char>,
    bullet_size: Option<f32>,
    bullet_color: Option<Color>,
    bullet_font: Option<u16>,
    align: Option<u16>,
    line: Option<i16>,
    before: Option<i16>,
    after: Option<i16>,
    left: Option<i16>,
    indent: Option<i16>,
}

struct Ctx<'a> {
    stream: &'a [u8],
    fonts: Vec<String>,
    blips: Vec<Option<Arc<crate::display::RasterImage>>>,
    scheme: [Color; 8],
    master_styles: HashMap<u16, Vec<(Pf, Cf)>>,
    /// Textes de la diapositive courante issus de SlideListWithText.
    outline: Vec<(Vec<u16>, u16, Option<&'a [u8]>)>,
}

impl<'a> Ctx<'a> {
    fn color(&self, v: u32) -> Option<Color> {
        let flags = (v >> 24) as u8;
        if flags & 0x08 != 0 {
            return self.scheme.get((v & 0xFF) as usize).copied();
        }
        if flags & 0x01 != 0 || flags & 0x02 != 0 {
            return None;
        }
        Some(Color::rgb(v as u8, (v >> 8) as u8, (v >> 16) as u8))
    }

    fn color_index(&self, b: &[u8], o: usize) -> Option<Color> {
        // ColorIndexStruct : r, g, b, index (0xFE = RVB, < 8 = couleur du schéma)
        let idx = *b.get(o + 3)?;
        if idx == 0xFE {
            Some(Color::rgb(b[o], b[o + 1], b[o + 2]))
        } else if idx < 8 {
            self.scheme.get(idx as usize).copied()
        } else {
            None
        }
    }

    fn read_pf(&self, b: &[u8], o: &mut usize) -> Pf {
        let m = u32le(b, *o);
        *o += 4;
        let mut pf = Pf::default();
        if m & 0xF != 0 {
            let f = u16le(b, *o);
            *o += 2;
            if m & 1 != 0 {
                pf.bullet = Some(f & 1 != 0);
            }
        }
        if m & 0x80 != 0 {
            pf.bullet_char = char::from_u32(u16le(b, *o) as u32);
            *o += 2;
        }
        if m & 0x10 != 0 {
            pf.bullet_font = Some(u16le(b, *o));
            *o += 2;
        }
        if m & 0x40 != 0 {
            let v = i16le(b, *o);
            pf.bullet_size = Some(if v > 0 { v as f32 / 100.0 } else { 1.0 });
            *o += 2;
        }
        if m & 0x20 != 0 {
            pf.bullet_color = self.color_index(b, *o);
            *o += 4;
        }
        if m & 0x800 != 0 {
            pf.align = Some(u16le(b, *o));
            *o += 2;
        }
        if m & 0x1000 != 0 {
            pf.line = Some(i16le(b, *o));
            *o += 2;
        }
        if m & 0x2000 != 0 {
            pf.before = Some(i16le(b, *o));
            *o += 2;
        }
        if m & 0x4000 != 0 {
            pf.after = Some(i16le(b, *o));
            *o += 2;
        }
        if m & 0x100 != 0 {
            pf.left = Some(i16le(b, *o));
            *o += 2;
        }
        if m & 0x400 != 0 {
            pf.indent = Some(i16le(b, *o));
            *o += 2;
        }
        if m & 0x8000 != 0 {
            *o += 2; // defaultTabSize
        }
        if m & 0x100000 != 0 {
            let n = u16le(b, *o) as usize;
            *o += 2 + n * 4; // tabStops
        }
        if m & 0x10000 != 0 {
            *o += 2; // fontAlign
        }
        if m & 0xE0000 != 0 {
            *o += 2; // wrapFlags
        }
        if m & 0x200000 != 0 {
            *o += 2; // textDirection
        }
        pf
    }

    fn read_cf(&self, b: &[u8], o: &mut usize) -> Cf {
        let m = u32le(b, *o);
        *o += 4;
        let mut cf = Cf::default();
        if m & 0xFFFF != 0 {
            let st = u16le(b, *o);
            *o += 2;
            if m & 1 != 0 {
                cf.bold = Some(st & 1 != 0);
            }
            if m & 2 != 0 {
                cf.italic = Some(st & 2 != 0);
            }
            if m & 4 != 0 {
                cf.underline = Some(st & 4 != 0);
            }
        }
        if m & 0x10000 != 0 {
            cf.font = Some(u16le(b, *o));
            *o += 2;
        }
        if m & 0x200000 != 0 {
            *o += 2;
        }
        if m & 0x400000 != 0 {
            *o += 2;
        }
        if m & 0x800000 != 0 {
            *o += 2;
        }
        if m & 0x20000 != 0 {
            cf.size = Some(u16le(b, *o) as f32);
            *o += 2;
        }
        if m & 0x40000 != 0 {
            cf.color = self.color_index(b, *o);
            *o += 4;
        }
        if m & 0x80000 != 0 {
            cf.position = Some(i16le(b, *o));
            *o += 2;
        }
        if m & 0x100000 != 0 {
            *o += 4; // pp10runid
        }
        if m & 0x1000000 != 0 {
            *o += 2; // newEAFontRef
        }
        if m & 0x2000000 != 0 {
            *o += 2; // csFontRef
        }
        if m & 0x4000000 != 0 {
            *o += 4; // pp11ext
        }
        cf
    }

    /// Texte d'une zone : (texte UTF-16, type, StyleTextPropAtom).
    fn text_records(&self, start: usize, len: usize) -> Option<(Vec<u16>, u16, Option<&'a [u8]>)> {
        let mut text: Option<Vec<u16>> = None;
        let mut ty = 4;
        let mut style = None;
        for (h, o) in children(self.stream, start, len) {
            match h.ty {
                0x0F9F => ty = u32le(self.stream, o) as u16,
                0x0FA0 => text = Some((0..h.len / 2).map(|k| u16le(self.stream, o + k * 2)).collect()),
                0x0FA8 => text = Some(self.stream[o..(o + h.len).min(self.stream.len())].iter().map(|&c| encoding_rs::WINDOWS_1252.decode(&[c]).0.encode_utf16().next().unwrap_or(0x20)).collect()),
                0x0FA1 => style = Some(&self.stream[o..(o + h.len).min(self.stream.len())]),
                _ => {}
            }
        }
        text.map(|t| (t, ty, style))
    }

    fn paragraphs(&self, text: &[u16], ty: u16, style: Option<&[u8]>) -> Vec<Paragraph> {
        // découpage en paragraphes et application des styles
        let n = text.len() + 1;
        let mut pf_runs: Vec<(usize, u16, Pf)> = Vec::new();
        let mut cf_runs: Vec<(usize, Cf)> = Vec::new();
        if let Some(st) = style {
            let mut o = 0;
            let mut total = 0;
            while total < n && o + 6 <= st.len() {
                let count = u32le(st, o) as usize;
                let level = u16le(st, o + 4);
                o += 6;
                let pf = self.read_pf(st, &mut o);
                pf_runs.push((count, level, pf));
                total += count.max(1);
            }
            total = 0;
            while total < n && o + 4 <= st.len() {
                let count = u32le(st, o) as usize;
                o += 4;
                let cf = self.read_cf(st, &mut o);
                cf_runs.push((count, cf));
                total += count.max(1);
            }
        }
        let master = self.master_styles.get(&match ty {
            6 => 0,
            5 | 7 | 8 => 1,
            t => t,
        });
        let default_size = match ty {
            0 | 6 => 44.0,
            1 | 5 | 7 | 8 => 32.0,
            _ => 18.0,
        };
        let pf_at = |pos: usize| -> (u16, Pf) {
            let mut acc = 0;
            for (c, l, p) in &pf_runs {
                acc += c;
                if pos < acc {
                    return (*l, p.clone());
                }
            }
            pf_runs.last().map(|x| (x.1, x.2.clone())).unwrap_or_default()
        };
        let cf_at = |pos: usize| -> Cf {
            let mut acc = 0;
            for (c, cf) in &cf_runs {
                acc += c;
                if pos < acc {
                    return cf.clone();
                }
            }
            cf_runs.last().map(|x| x.1.clone()).unwrap_or_default()
        };
        let mut out = Vec::new();
        let mut start = 0;
        let mut counter = 0;
        for (i, &u) in text.iter().chain(std::iter::once(&0x0D)).enumerate() {
            if u != 0x0D {
                continue;
            }
            let (level, mut pf) = pf_at(start);
            let lvl_style = master.and_then(|m| m.get(level as usize).or(m.first())).cloned().unwrap_or_default();
            let mut merged_pf = lvl_style.0.clone();
            macro_rules! m {
                ($($f:ident),*) => { $( if pf.$f.is_some() { merged_pf.$f = pf.$f.clone(); } )* };
            }
            m!(bullet, bullet_char, bullet_size, bullet_color, bullet_font, align, line, before, after, left, indent);
            pf = merged_pf;
            let mut inlines = Vec::new();
            let mut first_style: Option<Arc<TextStyle>> = None;
            let mut k = start;
            while k < i {
                let cf = cf_at(k);
                let mut c2 = lvl_style.1.clone();
                macro_rules! mc {
                    ($($f:ident),*) => { $( if cf.$f.is_some() { c2.$f = cf.$f; } )* };
                }
                mc!(bold, italic, underline, font, size, color, position);
                // fin du segment de même style
                let mut acc = 0;
                let mut run_end = i;
                for (c, _) in &cf_runs {
                    acc += c;
                    if k < acc {
                        run_end = acc.min(i);
                        break;
                    }
                }
                let run_end = run_end.max(k + 1);
                let st = Arc::new(TextStyle {
                    font: Arc::from(c2.font.and_then(|f| self.fonts.get(f as usize)).cloned().unwrap_or_else(|| "Arial".into()).as_str()),
                    size: c2.size.unwrap_or(default_size),
                    bold: c2.bold.unwrap_or(false),
                    italic: c2.italic.unwrap_or(false),
                    underline: c2.underline.unwrap_or(false),
                    color: c2.color.unwrap_or(self.scheme[1]),
                    vert: match c2.position {
                        Some(p) if p > 0 => VertAlign::Super,
                        Some(p) if p < 0 => VertAlign::Sub,
                        _ => VertAlign::Baseline,
                    },
                    ..Default::default()
                });
                if first_style.is_none() {
                    first_style = Some(st.clone());
                }
                let seg: Vec<u16> = text[k..run_end.min(text.len())].to_vec();
                let s = String::from_utf16_lossy(&seg);
                for (j, part) in s.split('\u{b}').enumerate() {
                    if j > 0 {
                        inlines.push(Inline::LineBreak(st.clone()));
                    }
                    for (t, tp) in part.split('\t').enumerate() {
                        if t > 0 {
                            inlines.push(Inline::Tab(st.clone()));
                        }
                        if !tp.is_empty() {
                            inlines.push(Inline::Text(tp.to_string(), st.clone()));
                        }
                    }
                }
                k = run_end;
            }
            let mark = first_style.unwrap_or_else(|| Arc::new(TextStyle { font: Arc::from("Arial"), size: default_size, color: self.scheme[1], ..Default::default() }));
            let has_text = inlines.iter().any(|x| matches!(x, Inline::Text(t, _) if !t.trim().is_empty()));
            let left = pf.left.unwrap_or(0) as f32 * MU;
            let indent = pf.indent.unwrap_or(0) as f32 * MU;
            if pf.bullet.unwrap_or(false) && has_text {
                counter += 1;
                let ch = pf.bullet_char.unwrap_or('•');
                let bfont = pf.bullet_font.and_then(|f| self.fonts.get(f as usize)).cloned().unwrap_or_default();
                let ch = crate::fonts::map_symbol_char(&bfont, ch);
                let mut bst = (*mark).clone();
                bst.font = Arc::from("DejaVu Sans");
                bst.size *= pf.bullet_size.unwrap_or(1.0);
                if let Some(c) = pf.bullet_color {
                    bst.color = c;
                }
                bst.bold = false;
                bst.underline = false;
                let bst = Arc::new(bst);
                let mut v = vec![Inline::Text(ch.to_string(), bst.clone()), Inline::Tab(bst)];
                v.extend(inlines);
                inlines = v;
            }
            let _ = counter;
            let spacing = |v: Option<i16>, size: f32| -> f32 {
                match v {
                    Some(x) if x < 0 => -x as f32 * MU,
                    Some(x) => x as f32 / 100.0 * size * 1.2,
                    None => 0.0,
                }
            };
            let props = ParaProps {
                align: match pf.align.unwrap_or(0) {
                    1 => Align::Center,
                    2 => Align::Right,
                    3 => Align::Justify,
                    _ => Align::Left,
                },
                // le retrait du texte est « left », celui de la puce est « indent »
                ind_left: left.max(indent),
                ind_first: indent - left.max(indent),
                space_before: if out.is_empty() { 0.0 } else { spacing(pf.before, mark.size) },
                space_after: spacing(pf.after, mark.size),
                line: match pf.line {
                    Some(x) if x < 0 => LineSpacing::Exact(-x as f32 * MU),
                    Some(x) if x > 0 => LineSpacing::Multiple(x as f32 / 100.0),
                    _ => LineSpacing::Multiple(1.0),
                },
                widow_control: false,
                pp_line_mode: true,
                ..Default::default()
            };
            out.push(Paragraph { props, inlines, mark });
            start = i + 1;
        }
        out
    }

    fn shape_props(&self, o: usize, len: usize, count: usize) -> HashMap<u16, (u32, Vec<u8>)> {
        let mut props = HashMap::new();
        let b = self.stream;
        let n = count.min(len / 6);
        let mut complex = o + n * 6;
        for k in 0..n {
            let id = u16le(b, o + k * 6);
            let v = u32le(b, o + k * 6 + 2);
            let pid = id & 0x3FFF;
            if id & 0x8000 != 0 {
                let data = b.get(complex..(complex + v as usize).min(b.len())).unwrap_or(&[]).to_vec();
                complex += v as usize;
                props.insert(pid, (v, data));
            } else {
                props.insert(pid, (v, Vec::new()));
            }
        }
        props
    }

    /// Dessine un conteneur de formes OfficeArt.
    fn shapes(&self, start: usize, len: usize, skip_placeholders: bool, group: Option<(Rect, Rect)>, bg: &mut Option<Color>, text_out: &mut String) -> Vec<Item> {
        let mut items = Vec::new();
        let mut group_tr: Option<(Rect, Rect)> = group;
        for (h, o) in children(self.stream, start, len) {
            match h.ty {
                0xF003 => {
                    // groupe : le premier enfant décrit le repère du groupe
                    let kids = children(self.stream, o, h.len);
                    let mut grect = None;
                    let mut anchor = None;
                    if let Some((h0, o0)) = kids.first() {
                        if h0.ty == 0xF004 {
                            for (hh, oo) in children(self.stream, *o0, h0.len) {
                                match hh.ty {
                                    0xF009 => grect = Some(Rect::new(i32le(self.stream, oo) as f32, i32le(self.stream, oo + 4) as f32, (i32le(self.stream, oo + 8) - i32le(self.stream, oo)) as f32, (i32le(self.stream, oo + 12) - i32le(self.stream, oo + 4)) as f32)),
                                    0xF010 => anchor = Some(self.anchor(oo, hh.len)),
                                    0xF00F => anchor = Some(self.child_anchor(oo, &group_tr)),
                                    _ => {}
                                }
                            }
                        }
                    }
                    let sub = match (grect, anchor) {
                        (Some(g), Some(a)) => Some((g, a)),
                        _ => group_tr,
                    };
                    items.extend(self.shapes(o, h.len, skip_placeholders, sub, bg, text_out));
                }
                0xF004 => {
                    items.extend(self.shape(o, h.len, h, skip_placeholders, &mut group_tr, bg, text_out));
                }
                _ => {}
            }
        }
        items
    }

    fn anchor(&self, o: usize, len: usize) -> Rect {
        let b = self.stream;
        if len >= 16 {
            let (t, l, r, bo) = (i32le(b, o), i32le(b, o + 4), i32le(b, o + 8), i32le(b, o + 12));
            Rect::new(l as f32 * MU, t as f32 * MU, (r - l) as f32 * MU, (bo - t) as f32 * MU)
        } else {
            let (t, l, r, bo) = (i16le(b, o), i16le(b, o + 2), i16le(b, o + 4), i16le(b, o + 6));
            Rect::new(l as f32 * MU, t as f32 * MU, (r - l) as f32 * MU, (bo - t) as f32 * MU)
        }
    }

    fn child_anchor(&self, o: usize, group: &Option<(Rect, Rect)>) -> Rect {
        let b = self.stream;
        let (l, t, r, bo) = (i32le(b, o) as f32, i32le(b, o + 4) as f32, i32le(b, o + 8) as f32, i32le(b, o + 12) as f32);
        match group {
            Some((g, a)) if g.w > 0.0 && g.h > 0.0 => {
                let sx = a.w / g.w;
                let sy = a.h / g.h;
                Rect::new(a.x + (l - g.x) * sx, a.y + (t - g.y) * sy, (r - l) * sx, (bo - t) * sy)
            }
            _ => Rect::new(l * MU, t * MU, (r - l) * MU, (bo - t) * MU),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn shape(&self, o: usize, len: usize, _h: Rh, skip_ph: bool, group: &mut Option<(Rect, Rect)>, bg: &mut Option<Color>, text_out: &mut String) -> Vec<Item> {
        let b = self.stream;
        let mut shape_type = 0u16;
        let mut flags = 0u32;
        let mut props = HashMap::new();
        let mut rect: Option<Rect> = None;
        let mut text: Option<(Vec<u16>, u16, Option<&[u8]>)> = None;
        let mut placeholder = false;
        for (hh, oo) in children(b, o, len) {
            match hh.ty {
                0xF00A => {
                    shape_type = hh.inst;
                    flags = u32le(b, oo + 4);
                }
                0xF00B => props = self.shape_props(oo, hh.len, hh.inst as usize),
                0xF010 => rect = Some(self.anchor(oo, hh.len)),
                0xF00F => rect = Some(self.child_anchor(oo, group)),
                0xF011 => {
                    if find(b, oo, hh.len, 0x0BC3).is_some() {
                        placeholder = true;
                    }
                }
                0xF00D => {
                    if let Some((_, ro)) = find(b, oo, hh.len, 0x0F9E) {
                        let idx = u32le(b, ro) as usize;
                        text = self.outline.get(idx).cloned();
                    } else {
                        text = self.text_records(oo, hh.len);
                    }
                }
                _ => {}
            }
        }
        // forme d'arrière-plan
        if flags & 0x400 != 0 {
            let filled = props.get(&0x01BF).map(|v| v.0 & 0x10 != 0 || v.0 & 0x100000 == 0).unwrap_or(true);
            if filled {
                if let Some(c) = props.get(&0x0181).and_then(|v| self.color(v.0)) {
                    *bg = Some(c);
                }
            }
            return Vec::new();
        }
        if flags & 0x1 != 0 || flags & 0x4 != 0 {
            // groupe ou patriarche : déjà traité
            return Vec::new();
        }
        if skip_ph && placeholder {
            return Vec::new();
        }
        let Some(r) = rect else { return Vec::new() };
        let local = Rect::new(0.0, 0.0, r.w, r.h);
        let geom = match shape_type {
            1 | 202 | 75 => "rect",
            2 => "roundRect",
            3 => "ellipse",
            4 => "diamond",
            5 => "triangle",
            6 => "rtTriangle",
            7 => "parallelogram",
            8 => "trapezoid",
            9 => "hexagon",
            10 => "octagon",
            11 => "plus",
            12 => "star5",
            13 => "rightArrow",
            15 => "homePlate",
            16 => "cube",
            20 => "line",
            22 => "can",
            23 => "donut",
            55 => "chevron",
            56 => "pentagon",
            66 => "leftArrow",
            67 => "downArrow",
            68 => "upArrow",
            69 => "leftRightArrow",
            70 => "upDownArrow",
            32 | 33 | 34 | 38 => "straightConnector1",
            _ => "rect",
        };
        let mut items = Vec::new();
        let fill_on = props.get(&0x01BF).map(|v| if v.0 & 0x100000 != 0 { v.0 & 0x10 != 0 } else { true }).unwrap_or(shape_type != 202 && shape_type != 75 && shape_type != 20);
        let line_on = props.get(&0x01FF).map(|v| if v.0 & 0x80000 != 0 { v.0 & 0x8 != 0 } else { true }).unwrap_or(shape_type != 202 && shape_type != 75);
        let fill = if fill_on { props.get(&0x0181).map(|v| self.color(v.0)).unwrap_or(Some(self.scheme[4])) } else { None };
        let fill = fill.map(|c| {
            let a = props.get(&0x0182).map(|v| v.0 as f32 / 65536.0).unwrap_or(1.0);
            c.with_alpha(a)
        });
        let line_c = if line_on { props.get(&0x01C0).map(|v| self.color(v.0)).unwrap_or(Some(self.scheme[1])) } else { None };
        let line_w = props.get(&0x01CB).map(|v| v.0 as f32 * EMU).unwrap_or(0.75);
        // image
        if let Some(pib) = props.get(&0x0104).map(|v| v.0 as usize) {
            if let Some(img) = self.blips.get(pib.wrapping_sub(1)).cloned().flatten() {
                items.push(Item::Image { rect: local, image: img, crop: [0.0; 4], alpha: 1.0 });
            } else {
                items.push(Item::Placeholder { rect: local, label: "image".into() });
            }
        } else if let Some(p) = (if shape_type == 0 || shape_type == 4095 || props.contains_key(&0x0145) { custom_geometry(&props, r.w, r.h) } else { None }).or_else(|| dml::preset_path(geom, r.w, r.h, &HashMap::new())) {
            let paint = if dml::is_open_shape(geom) { None } else { fill.and_then(Paint::solid) };
            let stroke = line_c.map(|c| StrokeStyle::new(c, line_w.max(0.25)));
            if paint.is_some() || stroke.is_some() {
                items.push(Item::Path { path: Arc::new(p), fill: paint, stroke });
            }
        }
        if let Some((t, ty, st)) = text {
            let paras = self.paragraphs(&t, ty, st);
            text_out.push_str(&String::from_utf16_lossy(&t));
            text_out.push(' ');
            let ins_l = props.get(&0x0081).map(|v| v.0 as f32 * EMU).unwrap_or(7.2);
            let ins_t = props.get(&0x0082).map(|v| v.0 as f32 * EMU).unwrap_or(3.6);
            let ins_r = props.get(&0x0083).map(|v| v.0 as f32 * EMU).unwrap_or(7.2);
            let ins_b = props.get(&0x0084).map(|v| v.0 as f32 * EMU).unwrap_or(3.6);
            let anchor = props.get(&0x0087).map(|v| v.0).unwrap_or(0);
            let blocks: Vec<Block> = paras.into_iter().map(Block::Para).collect();
            let frag = flow::stack_blocks(&blocks, (r.w - ins_l - ins_r).max(5.0), &LayoutCtx::default());
            let avail = r.h - ins_t - ins_b;
            let dy = match anchor {
                1 | 4 | 6 | 8 => (avail - frag.height) / 2.0,
                2 | 5 | 7 | 9 => avail - frag.height,
                _ => 0.0,
            };
            items.push(Item::group(Transform::from_translate(ins_l, ins_t + dy), None, frag.items));
        }
        if items.is_empty() {
            return items;
        }
        let rot = props.get(&0x0004).map(|v| v.0 as i32 as f32 / 65536.0).unwrap_or(0.0);
        let flip_h = flags & 0x40 != 0;
        let flip_v = flags & 0x80 != 0;
        vec![Item::group(dml::shape_transform(r.x, r.y, r.w, r.h, rot, flip_h, flip_v), None, items)]
    }
}

fn segs_have_escapes(props: &HashMap<u16, (u32, Vec<u8>)>) -> bool {
    let Some(segs) = props.get(&0x0146).map(|v| &v.1) else { return false };
    let n = u16le(segs, 0) as usize;
    (0..n).any(|k| matches!(u16le(segs, 6 + k * 2) >> 13, 5 | 6))
}

/// Géométrie libre OfficeArt (pVertices / pSegmentInfo).
fn custom_geometry(props: &HashMap<u16, (u32, Vec<u8>)>, w: f32, h: f32) -> Option<tiny_skia::Path> {
    let verts = &props.get(&0x0145)?.1;
    let n = u16le(verts, 0) as usize;
    let cb = u16le(verts, 4);
    let raw: Vec<(f32, f32)> = (0..n)
        .map(|k| {
            if cb == 8 {
                (i32le(verts, 6 + k * 8) as f32, i32le(verts, 10 + k * 8) as f32)
            } else {
                (i16le(verts, 6 + k * 4) as f32, i16le(verts, 8 + k * 4) as f32)
            }
        })
        .collect();
    // sommets exprimés par des formules (0x8000000N) : non pris en charge
    if raw.iter().any(|p| p.0 < 0.0 || p.1 < 0.0 || p.0 > 1.0e6 || p.1 > 1.0e6) || segs_have_escapes(props) {
        return None;
    }
    // étendue du repère : propriétés geoRight/geoBottom, sinon déduite des sommets
    let maxx = raw.iter().map(|p| p.0).fold(1.0, f32::max);
    let maxy = raw.iter().map(|p| p.1).fold(1.0, f32::max);
    let gw = props.get(&0x0142).map(|v| v.0 as f32).filter(|v| *v > 0.0).unwrap_or(maxx).max(1.0);
    let gh = props.get(&0x0143).map(|v| v.0 as f32).filter(|v| *v > 0.0).unwrap_or(maxy).max(1.0);
    let pts: Vec<(f32, f32)> = raw.into_iter().map(|(x, y)| (x / gw * w, y / gh * h)).collect();
    if pts.is_empty() {
        return None;
    }
    let mut pb = tiny_skia::PathBuilder::new();
    let mut i = 0;
    let segs = props.get(&0x0146).map(|v| v.1.clone()).unwrap_or_default();
    let nseg = u16le(&segs, 0) as usize;
    if nseg == 0 {
        pb.move_to(pts[0].0, pts[0].1);
        for p in &pts[1..] {
            pb.line_to(p.0, p.1);
        }
        pb.close();
        return pb.finish();
    }
    for k in 0..nseg {
        let sg = u16le(&segs, 6 + k * 2);
        let ty = sg >> 13;
        let count = (sg & 0x1FFF).max(1) as usize;
        match ty {
            0 => {
                for _ in 0..count {
                    if let Some(p) = pts.get(i) {
                        pb.line_to(p.0, p.1);
                    }
                    i += 1;
                }
            }
            1 => {
                for _ in 0..count {
                    if let (Some(a), Some(b2), Some(c)) = (pts.get(i), pts.get(i + 1), pts.get(i + 2)) {
                        pb.cubic_to(a.0, a.1, b2.0, b2.1, c.0, c.1);
                    }
                    i += 3;
                }
            }
            2 => {
                if let Some(p) = pts.get(i) {
                    pb.move_to(p.0, p.1);
                }
                i += 1;
            }
            3 => pb.close(),
            4 => break,
            _ => {}
        }
    }
    pb.finish()
}

pub fn load(data: &[u8]) -> Result<Vec<Page>, String> {
    let stream = read_stream(data, "PowerPoint Document").ok_or("Flux « PowerPoint Document » introuvable")?;
    let cu = read_stream(data, "Current User").unwrap_or_default();
    let pictures = read_stream(data, "Pictures").unwrap_or_default();
    // répertoire de persistance (dernière édition prioritaire)
    let mut persist: HashMap<u32, u32> = HashMap::new();
    let mut doc_ref = 0u32;
    let mut edit = u32le(&cu, 16) as usize;
    let mut chain = Vec::new();
    let mut guard = 0;
    while edit > 0 && edit + 8 < stream.len() && guard < 100 {
        guard += 1;
        let Some(h) = rh(&stream, edit) else { break };
        if h.ty != 0x0FF5 {
            break;
        }
        let o = edit + 8;
        if doc_ref == 0 {
            doc_ref = u32le(&stream, o + 16);
        }
        chain.push(u32le(&stream, o + 12) as usize);
        edit = u32le(&stream, o + 8) as usize;
    }
    for pd in chain.iter().rev() {
        let Some(h) = rh(&stream, *pd) else { continue };
        let mut o = pd + 8;
        let end = (pd + 8 + h.len).min(stream.len());
        while o + 4 <= end {
            let v = u32le(&stream, o);
            let id = v & 0xFFFFF;
            let n = (v >> 20) as usize;
            o += 4;
            for k in 0..n {
                persist.insert(id + k as u32, u32le(&stream, o + k * 4));
            }
            o += n * 4;
        }
    }
    // repli : recherche directe du conteneur de document
    let doc_off = persist.get(&doc_ref).map(|v| *v as usize).filter(|o| rh(&stream, *o).map(|h| h.ty == 0x03E8).unwrap_or(false)).or_else(|| {
        let mut o = 0;
        while let Some(h) = rh(&stream, o) {
            if h.ty == 0x03E8 {
                return Some(o);
            }
            o += 8 + h.len;
        }
        None
    });
    let doc_off = doc_off.ok_or("Conteneur de document introuvable.")?;
    let dh = rh(&stream, doc_off).unwrap();
    let dstart = doc_off + 8;
    let mut slide_w = 720.0;
    let mut slide_h = 540.0;
    if let Some((_, o)) = find(&stream, dstart, dh.len, 0x03E9) {
        slide_w = i32le(&stream, o) as f32 * MU;
        slide_h = i32le(&stream, o + 4) as f32 * MU;
    }
    let mut cx = Ctx { stream: &stream, fonts: Vec::new(), blips: Vec::new(), scheme: [Color::WHITE, Color::BLACK, Color::rgb(128, 128, 128), Color::BLACK, Color::rgb(0, 102, 204), Color::rgb(51, 153, 102), Color::rgb(204, 0, 0), Color::rgb(153, 51, 255)], master_styles: HashMap::new(), outline: Vec::new() };
    // polices
    if let Some((eh, eo)) = find(&stream, dstart, dh.len, 0x03F2) {
        if let Some((fh, fo)) = find(&stream, eo, eh.len, 0x07D5) {
            for (h, o) in children(&stream, fo, fh.len) {
                if h.ty == 0x0FB7 {
                    let name: Vec<u16> = (0..32).map(|k| u16le(&stream, o + k * 2)).take_while(|u| *u != 0).collect();
                    cx.fonts.push(String::from_utf16_lossy(&name));
                }
            }
        }
    }
    // images (BStore)
    if let Some((gh, go)) = find(&stream, dstart, dh.len, 0x040B) {
        if let Some((dgh, dgo)) = find(&stream, go, gh.len, 0xF000) {
            if let Some((bh, bo)) = find(&stream, dgo, dgh.len, 0xF001) {
                for (h, o) in children(&stream, bo, bh.len) {
                    if h.ty != 0xF007 {
                        cx.blips.push(None);
                        continue;
                    }
                    let size = u32le(&stream, o + 20) as usize;
                    let delay = u32le(&stream, o + 28) as usize;
                    let blob: &[u8] = if h.len > 36 + 8 { &stream[o + 36..(o + h.len).min(stream.len())] } else { pictures.get(delay..(delay + size).min(pictures.len())).unwrap_or(&[]) };
                    let png = blob.windows(8).position(|x| x == b"\x89PNG\r\n\x1a\n");
                    let jpg = blob.windows(3).position(|x| x == [0xFF, 0xD8, 0xFF]);
                    let start = match (png, jpg) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                    cx.blips.push(start.and_then(|s| crate::package::decode_image(&blob[s..])));
                }
            }
        }
    }
    // diapositives (ordre de SlideListWithText)
    let mut slides: Vec<u32> = Vec::new();
    let mut outlines: Vec<Vec<(Vec<u16>, u16, Option<&[u8]>)>> = Vec::new();
    for (h, o) in children(&stream, dstart, dh.len) {
        if h.ty == 0x0FF0 && h.inst == 0 {
            for (hh, oo) in children(&stream, o, h.len) {
                match hh.ty {
                    0x03F3 => {
                        slides.push(u32le(&stream, oo));
                        outlines.push(Vec::new());
                    }
                    0x0F9F => {
                        if let Some(v) = outlines.last_mut() {
                            v.push((Vec::new(), u32le(&stream, oo) as u16, None));
                        }
                    }
                    0x0FA0 | 0x0FA8 => {
                        if let Some(g) = outlines.last_mut().and_then(|v| v.last_mut()) {
                            g.0 = if hh.ty == 0x0FA0 {
                                (0..hh.len / 2).map(|k| u16le(&stream, oo + k * 2)).collect()
                            } else {
                                stream[oo..(oo + hh.len).min(stream.len())].iter().map(|&c| encoding_rs::WINDOWS_1252.decode(&[c]).0.encode_utf16().next().unwrap_or(0x20)).collect()
                            };
                        }
                    }
                    0x0FA1 => {
                        if let Some(g) = outlines.last_mut().and_then(|v| v.last_mut()) {
                            g.2 = Some(&stream[oo..(oo + hh.len).min(stream.len())]);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let mut pages = Vec::new();
    for (si, pid) in slides.iter().enumerate() {
        let Some(&off) = persist.get(pid) else { continue };
        let off = off as usize;
        cx.outline = outlines.get(si).cloned().unwrap_or_default();
        let Some(sh) = rh(&stream, off) else { continue };
        if sh.ty != 0x03EE {
            continue;
        }
        let sstart = off + 8;
        // masque
        let atom = find(&stream, sstart, sh.len, 0x03EF);
        let master_ref = atom.map(|(_, o)| u32le(&stream, o + 12)).unwrap_or(0);
        let slide_flags = atom.map(|(_, o)| u16le(&stream, o + 20)).unwrap_or(1);
        let master = persist.get(&master_ref).map(|v| *v as usize).filter(|o| rh(&stream, *o).map(|h| h.ty == 0x03F8 || h.ty == 0x03EE).unwrap_or(false));
        // schéma de couleurs : diapositive, sinon masque
        let scheme_of = |start: usize, len: usize| -> Option<[Color; 8]> {
            let (_, o) = find(&stream, start, len, 0x07F0)?;
            let mut c = [Color::BLACK; 8];
            for (k, slot) in c.iter_mut().enumerate() {
                *slot = Color::rgb(stream[o + k * 4], stream[o + k * 4 + 1], stream[o + k * 4 + 2]);
            }
            Some(c)
        };
        if let Some(m) = master {
            let mh = rh(&stream, m).unwrap();
            if let Some(s) = scheme_of(m + 8, mh.len) {
                cx.scheme = s;
            }
            // styles de texte du masque
            cx.master_styles.clear();
            for (h, o) in children(&stream, m + 8, mh.len) {
                if h.ty == 0x0FA3 {
                    let levels = u16le(&stream, o) as usize;
                    let mut p = o + 2;
                    let mut v = Vec::new();
                    for _ in 0..levels.min(5) {
                        if h.inst >= 5 {
                            p += 2;
                        }
                        let pf = cx.read_pf(&stream, &mut p);
                        let cf = cx.read_cf(&stream, &mut p);
                        v.push((pf, cf));
                    }
                    cx.master_styles.insert(h.inst, v);
                }
            }
        }
        if let Some(s) = scheme_of(sstart, sh.len) {
            if slide_flags & 2 == 0 {
                cx.scheme = s;
            }
        }
        let mut bg: Option<Color> = None;
        let mut items = Vec::new();
        let mut text = String::new();
        // formes du masque (décor)
        if let Some(m) = master {
            if slide_flags & 1 != 0 {
                let mh = rh(&stream, m).unwrap();
                if let Some((ph, po)) = find(&stream, m + 8, mh.len, 0x040C) {
                    if let Some((dgh, dgo)) = find(&stream, po, ph.len, 0xF002) {
                        let mut dummy = String::new();
                        let mut mbg = None;
                        for (h, o) in children(&stream, dgo, dgh.len) {
                            match h.ty {
                                0xF003 => items.extend(cx.shapes(o, h.len, true, None, &mut mbg, &mut dummy)),
                                0xF004 => {
                                    let mut g = None;
                                    items.extend(cx.shape(o, h.len, h, true, &mut g, &mut mbg, &mut dummy));
                                }
                                _ => {}
                            }
                        }
                        bg = mbg;
                    }
                }
            }
        }
        if let Some((ph, po)) = find(&stream, sstart, sh.len, 0x040C) {
            if let Some((dgh, dgo)) = find(&stream, po, ph.len, 0xF002) {
                let mut sbg = None;
                for (h, o) in children(&stream, dgo, dgh.len) {
                    match h.ty {
                        0xF003 => items.extend(cx.shapes(o, h.len, false, None, &mut sbg, &mut text)),
                        0xF004 => {
                            let mut g = None;
                            items.extend(cx.shape(o, h.len, h, false, &mut g, &mut sbg, &mut text));
                        }
                        _ => {}
                    }
                }
                if sbg.is_some() && slide_flags & 4 == 0 {
                    bg = sbg;
                }
            }
        }
        let page_rect = Rect::new(0.0, 0.0, slide_w, slide_h);
        pages.push(Page { width: slide_w, height: slide_h, background: Some(bg.unwrap_or(cx.scheme[0])), items: vec![Item::group(Transform::identity(), Some(page_rect), items)], text });
        let _ = si;
        let _ = Rh { ver: 0, inst: 0, ty: 0, len: 0 }.ver;
    }
    if pages.is_empty() {
        return Err("Aucune diapositive lisible.".into());
    }
    Ok(pages)
}
