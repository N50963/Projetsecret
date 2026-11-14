//! Documents Word 97-2003 (.doc, format binaire MS-DOC).

use super::read_stream;
use crate::color::Color;
use crate::display::{Item, Rect};
use crate::flow::*;
use crate::text::*;
use std::collections::HashMap;
use std::sync::Arc;

fn u16le(b: &[u8], o: usize) -> u16 {
    b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]])).unwrap_or(0)
}
fn i16le(b: &[u8], o: usize) -> i16 {
    u16le(b, o) as i16
}
fn u32le(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])).unwrap_or(0)
}

/// Parcourt une liste de sprms : (identifiant, opérande).
fn sprms(g: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 <= g.len() {
        let sprm = u16le(g, i);
        i += 2;
        let spra = sprm >> 13;
        let len = match spra {
            0 | 1 => 1,
            2 | 4 | 5 => 2,
            3 => 4,
            7 => 3,
            _ => {
                if sprm == 0xD608 || sprm == 0xD606 {
                    // sprmTDefTable : taille sur 2 octets
                    let cb = u16le(g, i) as usize;
                    cb + 1
                } else if sprm == 0xC615 {
                    let cb = *g.get(i).unwrap_or(&0) as usize;
                    if cb == 255 {
                        // cas spécial : on ignore la suite
                        return out;
                    }
                    cb + 1
                } else {
                    *g.get(i).unwrap_or(&0) as usize + 1
                }
            }
        };
        if i + len > g.len() {
            break;
        }
        let op = &g[i..i + len];
        // pour les opérandes variables, on retire l'octet de taille
        let op = if spra == 6 && sprm != 0xD608 && sprm != 0xD606 { &op[1..] } else if sprm == 0xD608 || sprm == 0xD606 { &op[2..] } else { op };
        out.push((sprm, op));
        i += len;
    }
    out
}

const ICO: [u32; 17] = [0x000000, 0x000000, 0x0000FF, 0x00FFFF, 0x00FF00, 0xFF00FF, 0xFF0000, 0xFFFF00, 0xFFFFFF, 0x000080, 0x008080, 0x008000, 0x800080, 0x800000, 0x808000, 0x808080, 0xC0C0C0];

fn ico(i: u8) -> Option<Color> {
    if i == 0 {
        return None;
    }
    ICO.get(i as usize).map(|v| Color::rgb((v >> 16) as u8, (v >> 8) as u8, *v as u8))
}

fn colorref(op: &[u8]) -> Option<Color> {
    if op.len() < 4 || op[3] == 0xFF {
        return None;
    }
    Some(Color::rgb(op[0], op[1], op[2]))
}

#[derive(Clone, Default, Debug)]
struct Chp {
    bold: Option<bool>,
    italic: Option<bool>,
    strike: Option<bool>,
    caps: Option<bool>,
    small_caps: Option<bool>,
    hidden: Option<bool>,
    underline: Option<u8>,
    size: Option<f32>,
    color: Option<Option<Color>>,
    font: Option<u16>,
    vert: Option<VertAlign>,
    highlight: Option<Option<Color>>,
    pic: Option<u32>,
    special: Option<bool>,
    istd: Option<u16>,
    symbol: Option<(u16, u16)>,
}

fn apply_chp(c: &mut Chp, g: &[u8], base: &Chp) {
    let toggle = |v: u8, b: Option<bool>| -> bool {
        match v {
            0 => false,
            1 => true,
            0x80 => b.unwrap_or(false),
            0x81 => !b.unwrap_or(false),
            _ => v != 0,
        }
    };
    for (s, op) in sprms(g) {
        let b0 = *op.first().unwrap_or(&0);
        match s {
            0x0835 => c.bold = Some(toggle(b0, base.bold)),
            0x0836 => c.italic = Some(toggle(b0, base.italic)),
            0x0837 => c.strike = Some(toggle(b0, base.strike)),
            0x083B => c.small_caps = Some(toggle(b0, base.small_caps)),
            0x083C => c.caps = Some(toggle(b0, base.caps)),
            0x083D => c.hidden = Some(toggle(b0, base.hidden)),
            0x2A3E => c.underline = Some(b0),
            0x4A43 => c.size = Some(u16le(op, 0) as f32 / 2.0),
            0x2A42 => c.color = Some(ico(b0)),
            0x6870 => c.color = Some(colorref(op)),
            0x4A4F | 0x4A3D => c.font = Some(u16le(op, 0)),
            0x2A48 => {
                c.vert = Some(match b0 {
                    1 => VertAlign::Super,
                    2 => VertAlign::Sub,
                    _ => VertAlign::Baseline,
                })
            }
            0x2A0C => c.highlight = Some(ico(b0)),
            0x6A03 => c.pic = Some(u32le(op, 0)),
            0x0855 => c.special = Some(b0 != 0),
            0x4A30 => c.istd = Some(u16le(op, 0)),
            0x6A09 => c.symbol = Some((u16le(op, 0), u16le(op, 2))),
            _ => {}
        }
    }
}

fn merge_chp(dst: &mut Chp, src: &Chp) {
    macro_rules! m {
        ($($f:ident),*) => { $( if src.$f.is_some() { dst.$f = src.$f; } )* };
    }
    m!(bold, italic, strike, caps, small_caps, hidden, underline, size, color, font, vert, highlight, pic, special, istd, symbol);
}

#[derive(Clone, Default, Debug)]
struct Pap {
    jc: Option<u8>,
    left: Option<i16>,
    right: Option<i16>,
    first: Option<i16>,
    before: Option<u16>,
    after: Option<u16>,
    line: Option<(i16, i16)>,
    in_table: Option<bool>,
    ttp: Option<bool>,
    keep_next: Option<bool>,
    page_break: Option<bool>,
    ilfo: Option<u16>,
    ilvl: Option<u8>,
    istd: u16,
    shading: Option<Option<Color>>,
    tabs: Vec<(i16, u8)>,
    // propriétés de ligne de tableau
    cells: Option<(Vec<i16>, Vec<u16>)>,
    row_height: Option<i16>,
    cell_shading: Vec<Option<Color>>,
    borders: Option<[Option<BorderLine>; 6]>,
    cell_borders: Vec<[Option<BorderLine>; 4]>,
    contextual: Option<bool>,
    pborders: [Option<Option<BorderLine>>; 4],
}

fn brc80(b: &[u8]) -> Option<BorderLine> {
    if b.len() < 4 || (b[0] == 0 && b[1] == 0) || b[1] == 0 || b[1] == 0xFF {
        return None;
    }
    Some(BorderLine { width: (b[0] as f32 / 8.0).max(0.5), color: ico(b[2]).unwrap_or(Color::BLACK), double: b[1] == 3, dash: crate::display::DashStyle::Solid, space: (b[3] & 0x1F) as f32 })
}

fn brc(b: &[u8]) -> Option<BorderLine> {
    if b.len() < 8 || b[5] == 0 || b[5] == 0xFF {
        return None;
    }
    Some(BorderLine { width: (b[4] as f32 / 8.0).max(0.5), color: colorref(&b[0..4]).unwrap_or(Color::BLACK), double: b[5] == 3, dash: crate::display::DashStyle::Solid, space: (b[6] & 0x1F) as f32 })
}

fn shd_color(op: &[u8]) -> Option<Color> {
    // SHD : cvFore (4), cvBack (4), ipat (2)
    if op.len() >= 10 {
        let ipat = u16le(op, 8);
        let fore = colorref(&op[0..4]);
        let back = colorref(&op[4..8]);
        return match ipat {
            0 => back,
            1 => fore,
            _ => fore.map(|f| f.mix(back.unwrap_or(Color::WHITE), 0.7)).or(back),
        };
    }
    if op.len() >= 2 {
        // SHD80
        let v = u16le(op, 0);
        let fore = ico((v & 0x1F) as u8);
        let back = ico(((v >> 5) & 0x1F) as u8);
        let ipat = v >> 10;
        return match ipat {
            0 => back,
            1 => fore,
            _ => back,
        };
    }
    None
}

fn apply_pap(p: &mut Pap, g: &[u8]) {
    for (s, op) in sprms(g) {
        let b0 = *op.first().unwrap_or(&0);
        match s {
            0x2403 | 0x2461 => p.jc = Some(b0),
            0x840F | 0x845E => p.left = Some(i16le(op, 0)),
            0x840E | 0x845D => p.right = Some(i16le(op, 0)),
            0x8411 | 0x8460 => p.first = Some(i16le(op, 0)),
            0xA413 => p.before = Some(u16le(op, 0)),
            0xA414 => p.after = Some(u16le(op, 0)),
            0x6412 => p.line = Some((i16le(op, 0), i16le(op, 2))),
            0x2416 => p.in_table = Some(b0 != 0),
            0x2417 => p.ttp = Some(b0 != 0),
            0x244B => p.in_table = Some(b0 != 0),
            0x244C => p.ttp = Some(b0 != 0),
            0x6649 => {
                if u32le(op, 0) > 0 {
                    p.in_table = Some(true);
                }
            }
            0x2406 => p.keep_next = Some(b0 != 0),
            0x2407 => p.page_break = Some(b0 != 0),
            0x460B => p.ilfo = Some(u16le(op, 0)),
            0x260A => p.ilvl = Some(b0),
            0x442D | 0xC64D => p.shading = Some(shd_color(op)),
            0xC60D | 0xC615 => {
                // tabulations : suppressions puis ajouts
                let ndel = *op.first().unwrap_or(&0) as usize;
                let o = 1 + ndel * 2;
                let nadd = *op.get(o).unwrap_or(&0) as usize;
                let dels: Vec<i16> = (0..ndel).map(|k| i16le(op, 1 + k * 2)).collect();
                p.tabs.retain(|t| !dels.contains(&t.0));
                for k in 0..nadd {
                    let pos = i16le(op, o + 1 + k * 2);
                    let tbd = *op.get(o + 1 + nadd * 2 + k).unwrap_or(&0);
                    p.tabs.push((pos, tbd));
                }
            }
            0xD608 => {
                let n = *op.first().unwrap_or(&0) as usize;
                let centers: Vec<i16> = (0..=n).map(|k| i16le(op, 1 + k * 2)).collect();
                let base = 1 + (n + 1) * 2;
                let mut flags = Vec::new();
                let mut cb = Vec::new();
                for k in 0..n {
                    let tc = base + k * 20;
                    flags.push(u16le(op, tc));
                    if op.len() >= tc + 20 {
                        cb.push([brc80(&op[tc + 4..tc + 8]), brc80(&op[tc + 16..tc + 20]), brc80(&op[tc + 12..tc + 16]), brc80(&op[tc + 8..tc + 12])]);
                    }
                }
                p.cells = Some((centers, flags));
                if cb.iter().any(|c| c.iter().any(|b| b.is_some())) {
                    p.cell_borders = cb;
                }
            }
            0x9407 => p.row_height = Some(i16le(op, 0)),
            0xD612 | 0xD609 => {
                let step = if s == 0xD612 { 10 } else { 2 };
                p.cell_shading = op.chunks(step).map(shd_color).collect();
            }
            0xD613 => {
                let mut b: [Option<BorderLine>; 6] = Default::default();
                for (k, slot) in b.iter_mut().enumerate() {
                    if op.len() >= k * 8 + 8 {
                        *slot = brc(&op[k * 8..k * 8 + 8]);
                    }
                }
                p.borders = Some(b);
            }
            0xD605 => {
                let mut b: [Option<BorderLine>; 6] = Default::default();
                for (k, slot) in b.iter_mut().enumerate() {
                    if op.len() >= k * 4 + 4 {
                        *slot = brc80(&op[k * 4..k * 4 + 4]);
                    }
                }
                p.borders = Some(b);
            }
            0x4600 => p.istd = u16le(op, 0),
            0x246D => p.contextual = Some(b0 != 0),
            0x6424 => p.pborders[0] = Some(brc80(op)),
            0x6427 => p.pborders[1] = Some(brc80(op)),
            0x6426 => p.pborders[2] = Some(brc80(op)),
            0x6425 => p.pborders[3] = Some(brc80(op)),
            0xC64E => p.pborders[0] = Some(brc(op)),
            0xC651 => p.pborders[1] = Some(brc(op)),
            0xC650 => p.pborders[2] = Some(brc(op)),
            0xC64F => p.pborders[3] = Some(brc(op)),
            _ => {}
        }
    }
}

fn merge_pap(dst: &mut Pap, src: &Pap) {
    macro_rules! m {
        ($($f:ident),*) => { $( if src.$f.is_some() { dst.$f = src.$f.clone(); } )* };
    }
    m!(jc, left, right, first, before, after, line, in_table, ttp, keep_next, page_break, ilfo, ilvl, shading, cells, row_height, borders, contextual);
    for k in 0..4 {
        if src.pborders[k].is_some() {
            dst.pborders[k] = src.pborders[k].clone();
        }
    }
    if !src.tabs.is_empty() {
        dst.tabs = src.tabs.clone();
    }
    if !src.cell_shading.is_empty() {
        dst.cell_shading = src.cell_shading.clone();
    }
    if !src.cell_borders.is_empty() {
        dst.cell_borders = src.cell_borders.clone();
    }
}

struct Style {
    base: u16,
    pap: Vec<u8>,
    chp: Vec<u8>,
}

struct Lvl {
    start: i32,
    nfc: u8,
    text: Vec<u16>,
    pap: Vec<u8>,
    chp: Vec<u8>,
    follow: u8,
}

struct Doc<'a> {
    word: &'a [u8],
    data: Option<Vec<u8>>,
    text: Vec<u16>,
    fcs: Vec<u32>,
    chpx: Vec<(u32, u32, Vec<u8>)>,
    papx: Vec<(u32, u32, Vec<u8>)>,
    styles: Vec<Option<Style>>,
    fonts: Vec<String>,
    default_font: u16,
    lists: HashMap<i32, Vec<Lvl>>,
    lfo: Vec<i32>,
    counters: HashMap<i32, [i32; 9]>,
    resolved: std::cell::RefCell<HashMap<u16, (Pap, Chp)>>,
}

fn plc(b: &[u8], fc: usize, lcb: usize, cb_data: usize) -> (Vec<u32>, Vec<&[u8]>) {
    if lcb < 4 || fc + lcb > b.len() {
        return (Vec::new(), Vec::new());
    }
    let n = (lcb - 4) / (4 + cb_data);
    let cps: Vec<u32> = (0..=n).map(|i| u32le(b, fc + i * 4)).collect();
    let data: Vec<&[u8]> = (0..n).map(|i| &b[fc + (n + 1) * 4 + i * cb_data..fc + (n + 1) * 4 + (i + 1) * cb_data]).collect();
    (cps, data)
}

fn format_nfc(n: i32, nfc: u8) -> String {
    match nfc {
        1 => crate::ooxml::docx::roman(n).to_uppercase(),
        2 => crate::ooxml::docx::roman(n),
        3 => crate::ooxml::docx::letters(n).to_uppercase(),
        4 => crate::ooxml::docx::letters(n),
        22 => format!("{n:02}"),
        23 | 255 => String::new(),
        _ => n.to_string(),
    }
}

impl<'a> Doc<'a> {
    fn chp_at(&self, fc: u32) -> Option<&[u8]> {
        self.chp_index(fc).map(|i| self.chpx[i].2.as_slice())
    }
    fn chp_index(&self, fc: u32) -> Option<usize> {
        let i = self.chpx.partition_point(|r| r.1 <= fc);
        self.chpx.get(i).filter(|r| r.0 <= fc).map(|_| i)
    }
    fn pap_index(&self, fc: u32) -> Option<usize> {
        let i = self.papx.partition_point(|r| r.1 <= fc);
        self.papx.get(i).filter(|r| r.0 <= fc).map(|_| i)
    }
    fn pap_at(&self, fc: u32) -> Option<&[u8]> {
        let i = self.papx.partition_point(|r| r.1 <= fc);
        self.papx.get(i).filter(|r| r.0 <= fc).map(|r| r.2.as_slice())
    }

    fn style_chain(&self, istd: u16) -> Vec<&Style> {
        let mut v = Vec::new();
        let mut cur = istd;
        for _ in 0..20 {
            match self.styles.get(cur as usize).and_then(|s| s.as_ref()) {
                Some(s) => {
                    v.push(s);
                    if s.base == 0x0FFF || s.base == cur {
                        break;
                    }
                    cur = s.base;
                }
                None => break,
            }
        }
        v.reverse();
        v
    }

    fn style_props(&self, istd: u16) -> (Pap, Chp) {
        if let Some(v) = self.resolved.borrow().get(&istd) {
            return v.clone();
        }
        let v = self.compute_style(istd);
        self.resolved.borrow_mut().insert(istd, v.clone());
        v
    }

    fn compute_style(&self, istd: u16) -> (Pap, Chp) {
        let mut p = Pap::default();
        let mut c = Chp::default();
        for s in self.style_chain(istd) {
            apply_pap(&mut p, &s.pap);
            let base = c.clone();
            apply_chp(&mut c, &s.chp, &base);
        }
        (p, c)
    }

    fn text_style(&self, c: &Chp) -> TextStyle {
        let font = c.font.unwrap_or(self.default_font);
        let name = self.fonts.get(font as usize).cloned().unwrap_or_else(|| "Times New Roman".into());
        TextStyle {
            font: Arc::from(name.as_str()),
            size: c.size.unwrap_or(10.0),
            bold: c.bold.unwrap_or(false),
            italic: c.italic.unwrap_or(false),
            underline: matches!(c.underline, Some(u) if u != 0 && u != 3),
            double_underline: c.underline == Some(3),
            strike: c.strike.unwrap_or(false),
            color: c.color.flatten().unwrap_or(Color::BLACK),
            highlight: c.highlight.flatten(),
            vert: c.vert.unwrap_or_default(),
            caps: c.caps.unwrap_or(false),
            small_caps: c.small_caps.unwrap_or(false),
            hidden: c.hidden.unwrap_or(false),
            ..Default::default()
        }
    }

    fn picture(&self, fc: u32) -> Option<(f32, f32, Vec<Item>)> {
        let data = self.data.as_ref()?;
        let o = fc as usize;
        let lcb = u32le(data, o) as usize;
        let cbh = u16le(data, o + 4) as usize;
        if lcb < cbh || o + lcb > data.len() {
            return None;
        }
        let dxa = i16le(data, o + 0x1C) as f32;
        let dya = i16le(data, o + 0x1E) as f32;
        let mx = u16le(data, o + 0x20) as f32;
        let my = u16le(data, o + 0x22) as f32;
        let w = dxa * if mx > 0.0 { mx / 1000.0 } else { 1.0 } / 20.0;
        let h = dya * if my > 0.0 { my / 1000.0 } else { 1.0 } / 20.0;
        let body = &data[o + cbh..o + lcb];
        // recherche d'une image PNG ou JPEG dans le conteneur OfficeArt
        let png = body.windows(8).position(|x| x == b"\x89PNG\r\n\x1a\n");
        let jpg = body.windows(3).position(|x| x == [0xFF, 0xD8, 0xFF]);
        let start = match (png, jpg) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let item = match start.and_then(|s| crate::package::decode_image(&body[s..])) {
            Some(img) => Item::Image { rect: Rect::new(0.0, 0.0, w.max(1.0), h.max(1.0)), image: img, crop: [0.0; 4], alpha: 1.0 },
            None => Item::Placeholder { rect: Rect::new(0.0, 0.0, w.max(1.0), h.max(1.0)), label: "image".into() },
        };
        Some((w.max(1.0), h.max(1.0), vec![item]))
    }

    fn list_label(&mut self, ilfo: u16, ilvl: u8) -> Option<(String, Vec<u8>, Vec<u8>, u8)> {
        let lsid = *self.lfo.get(ilfo.checked_sub(1)? as usize)?;
        let levels = self.lists.get(&lsid)?;
        let li = (ilvl as usize).min(levels.len().saturating_sub(1));
        let lvl = levels.get(li)?;
        let starts: Vec<i32> = levels.iter().map(|l| l.start).collect();
        let nfcs: Vec<u8> = levels.iter().map(|l| l.nfc).collect();
        let text = lvl.text.clone();
        let (pap, chp, follow, nfc) = (lvl.pap.clone(), lvl.chp.clone(), lvl.follow, lvl.nfc);
        let cnt = self.counters.entry(lsid).or_insert([0; 9]);
        if cnt[li] == 0 {
            cnt[li] = starts[li];
        } else {
            cnt[li] += 1;
        }
        for v in cnt.iter_mut().skip(li + 1) {
            *v = 0;
        }
        let snapshot = *cnt;
        let mut s = String::new();
        for &u in &text {
            if (u as usize) < 9 {
                let k = u as usize;
                let val = if snapshot[k] == 0 { starts.get(k).copied().unwrap_or(1) } else { snapshot[k] };
                s.push_str(&format_nfc(val, *nfcs.get(k).unwrap_or(&0)));
            } else if let Some(ch) = char::from_u32(u as u32) {
                s.push(ch);
            }
        }
        let _ = nfc;
        Some((s, pap, chp, follow))
    }
}

/// Paragraphe en cours de construction.
struct PBuild {
    inlines: Vec<Inline>,
    start_fc: u32,
}

pub fn load(data: &[u8]) -> Result<FlowDoc, String> {
    let word = read_stream(data, "WordDocument").ok_or("Flux WordDocument introuvable")?;
    if u16le(&word, 0) != 0xA5EC {
        return Err("Document Word 97-2003 invalide.".into());
    }
    let flags = u16le(&word, 0x0A);
    if flags & 0x0100 != 0 {
        return Err("Ce document est protégé par un mot de passe.".into());
    }
    let table_name = if flags & 0x0200 != 0 { "1Table" } else { "0Table" };
    let table = read_stream(data, table_name).ok_or("Flux de tables introuvable")?;
    let datastream = read_stream(data, "Data");
    // FIB : rgW, rgLw, rgFcLcb
    let csw = u16le(&word, 32) as usize;
    let lw_off = 34 + csw * 2;
    let cslw = u16le(&word, lw_off) as usize;
    let lw = |i: usize| u32le(&word, lw_off + 2 + i * 4);
    let fc_off = lw_off + 2 + cslw * 4 + 2;
    let fclcb = |i: usize| (u32le(&word, fc_off + i * 8) as usize, u32le(&word, fc_off + i * 8 + 4) as usize);
    let ccp_text = lw(3);
    let ccp_ftn = lw(4);
    let ccp_hdd = lw(5);
    // table des pièces (CLX)
    let (fc_clx, lcb_clx) = fclcb(33);
    let mut pieces: Vec<(u32, u32, u32, bool)> = Vec::new(); // cp début, cp fin, fc, compressé
    let mut i = fc_clx;
    while i < fc_clx + lcb_clx && i < table.len() {
        match table[i] {
            1 => {
                let cb = u16le(&table, i + 1) as usize;
                i += 3 + cb;
            }
            2 => {
                let lcb = u32le(&table, i + 1) as usize;
                let (cps, pcds) = plc(&table, i + 5, lcb, 8);
                for (k, pcd) in pcds.iter().enumerate() {
                    let fc = u32le(pcd, 2);
                    let compressed = fc & 0x4000_0000 != 0;
                    let fc_real = if compressed { (fc & !0x4000_0000) / 2 } else { fc };
                    pieces.push((cps[k], cps[k + 1], fc_real, compressed));
                }
                break;
            }
            _ => break,
        }
    }
    if pieces.is_empty() {
        return Err("Table des pièces absente (document Word trop ancien ?)".into());
    }
    // texte complet + position (FC) de chaque caractère
    let mut text: Vec<u16> = Vec::new();
    let mut fcs: Vec<u32> = Vec::new();
    for (cp0, cp1, fc, comp) in &pieces {
        for k in 0..(cp1 - cp0) {
            if *comp {
                let pos = (fc + k) as usize;
                let b = *word.get(pos).unwrap_or(&0x20);
                let ch = encoding_rs::WINDOWS_1252.decode(&[b]).0.encode_utf16().next().unwrap_or(0x20);
                text.push(ch);
                fcs.push(fc + k);
            } else {
                let pos = (fc + 2 * k) as usize;
                text.push(u16le(&word, pos));
                fcs.push(fc + 2 * k);
            }
        }
    }
    // FKP de caractères et de paragraphes
    let mut chpx = Vec::new();
    let (fc_chp, lcb_chp) = fclcb(12);
    let (_, pns) = plc(&table, fc_chp, lcb_chp, 4);
    for pn in pns {
        let page = (u32le(pn, 0) & 0x3F_FFFF) as usize * 512;
        if page + 512 > word.len() {
            continue;
        }
        let fkp = &word[page..page + 512];
        let crun = fkp[511] as usize;
        for r in 0..crun {
            let a = u32le(fkp, r * 4);
            let b = u32le(fkp, r * 4 + 4);
            let off = fkp[(crun + 1) * 4 + r] as usize * 2;
            let g = if off > 0 && off < 511 {
                let cb = fkp[off] as usize;
                fkp[(off + 1).min(511)..(off + 1 + cb).min(511)].to_vec()
            } else {
                Vec::new()
            };
            chpx.push((a, b, g));
        }
    }
    chpx.sort_by_key(|x| x.0);
    let mut papx = Vec::new();
    let (fc_pap, lcb_pap) = fclcb(13);
    let (_, pns) = plc(&table, fc_pap, lcb_pap, 4);
    for pn in pns {
        let page = (u32le(pn, 0) & 0x3F_FFFF) as usize * 512;
        if page + 512 > word.len() {
            continue;
        }
        let fkp = &word[page..page + 512];
        let cpara = fkp[511] as usize;
        for r in 0..cpara {
            let a = u32le(fkp, r * 4);
            let b = u32le(fkp, r * 4 + 4);
            let off = fkp[(cpara + 1) * 4 + r * 13] as usize * 2;
            let g = if off > 0 && off < 511 {
                let cb = fkp[off] as usize;
                let (start, len) = if cb == 0 { (off + 2, fkp[off + 1] as usize * 2) } else { (off + 1, cb * 2 - 1) };
                fkp[start.min(512)..(start + len).min(512)].to_vec()
            } else {
                Vec::new()
            };
            papx.push((a, b, g));
        }
    }
    papx.sort_by_key(|x| x.0);
    // feuille de styles
    let (fc_st, lcb_st) = fclcb(1);
    let mut styles = Vec::new();
    let mut default_font = 0u16;
    if lcb_st > 4 && fc_st + lcb_st <= table.len() {
        let st = &table[fc_st..fc_st + lcb_st];
        let cb_stshi = u16le(st, 0) as usize;
        let cstd = u16le(st, 2) as usize;
        let cb_base = u16le(st, 4) as usize;
        default_font = u16le(st, 2 + 12);
        let mut o = 2 + cb_stshi;
        for _ in 0..cstd {
            let cb = u16le(st, o) as usize;
            o += 2;
            if cb == 0 {
                styles.push(None);
                continue;
            }
            let std = &st[o.min(st.len())..(o + cb).min(st.len())];
            o += cb;
            let stk = u16le(std, 2) & 0xF;
            let base = u16le(std, 2) >> 4;
            let cupx = u16le(std, 4) & 0xF;
            // nom : Xstz après la base
            let mut p = cb_base;
            let cch = u16le(std, p) as usize;
            p += 2 + cch * 2 + 2;
            let mut upx = Vec::new();
            for _ in 0..cupx {
                let cbu = u16le(std, p) as usize;
                upx.push(std.get(p + 2..p + 2 + cbu).unwrap_or(&[]).to_vec());
                p += 2 + cbu;
                if p % 2 == 1 {
                    p += 1;
                }
            }
            let (pap, chp) = match stk {
                1 => (upx.first().map(|u| u.get(2..).unwrap_or(&[]).to_vec()).unwrap_or_default(), upx.get(1).cloned().unwrap_or_default()),
                2 => (Vec::new(), upx.first().cloned().unwrap_or_default()),
                _ => (Vec::new(), Vec::new()),
            };
            styles.push(Some(Style { base, pap, chp }));
        }
    }
    // table des polices
    let (fc_ff, lcb_ff) = fclcb(15);
    let mut fonts = Vec::new();
    if lcb_ff > 4 && fc_ff + lcb_ff <= table.len() {
        let ff = &table[fc_ff..fc_ff + lcb_ff];
        let n = u16le(ff, 0) as usize;
        let mut o = 4;
        for _ in 0..n {
            let cb = *ff.get(o).unwrap_or(&0) as usize;
            let entry = ff.get(o + 1..o + 1 + cb).unwrap_or(&[]);
            let mut name = Vec::new();
            let mut k = 39;
            while k + 1 < entry.len() {
                let u = u16le(entry, k);
                if u == 0 {
                    break;
                }
                name.push(u);
                k += 2;
            }
            fonts.push(String::from_utf16_lossy(&name));
            o += 1 + cb;
        }
    }
    // listes
    let mut lists: HashMap<i32, Vec<Lvl>> = HashMap::new();
    let mut lfo = Vec::new();
    let (fc_lst, lcb_lst) = fclcb(73);
    if lcb_lst > 2 && fc_lst + lcb_lst <= table.len() {
        let l = &table[fc_lst..];
        let n = i16le(l, 0).max(0) as usize;
        let mut lstfs = Vec::new();
        for k in 0..n {
            let o = 2 + k * 28;
            lstfs.push((u32le(l, o) as i32, l.get(o + 26).map(|f| f & 1 != 0).unwrap_or(false)));
        }
        let mut o = 2 + n * 28;
        for (lsid, simple) in lstfs {
            let nl = if simple { 1 } else { 9 };
            let mut lvls = Vec::new();
            for _ in 0..nl {
                if o + 28 > l.len() {
                    break;
                }
                let start = u32le(l, o) as i32;
                let nfc = l[o + 4];
                let follow = l[o + 15];
                let cb_chp = l[o + 24] as usize;
                let cb_pap = l[o + 25] as usize;
                let mut p = o + 28;
                let pap = l.get(p..p + cb_pap).unwrap_or(&[]).to_vec();
                p += cb_pap;
                let chp = l.get(p..p + cb_chp).unwrap_or(&[]).to_vec();
                p += cb_chp;
                let cch = u16le(l, p) as usize;
                let text: Vec<u16> = (0..cch).map(|k| u16le(l, p + 2 + k * 2)).collect();
                p += 2 + cch * 2;
                lvls.push(Lvl { start, nfc, text, pap, chp, follow });
                o = p;
            }
            lists.insert(lsid, lvls);
        }
    }
    let (fc_lfo, lcb_lfo) = fclcb(74);
    if lcb_lfo > 4 && fc_lfo + lcb_lfo <= table.len() {
        let n = u32le(&table, fc_lfo) as usize;
        for k in 0..n.min(10000) {
            lfo.push(u32le(&table, fc_lfo + 4 + k * 16) as i32);
        }
    }
    let mut d = Doc { word: &word, data: datastream, text, fcs, chpx, papx, styles, fonts, default_font, lists, lfo, counters: HashMap::new(), resolved: std::cell::RefCell::new(HashMap::new()) };

    // sections
    let (fc_sed, lcb_sed) = fclcb(6);
    let (sed_cps, seds) = plc(&table, fc_sed, lcb_sed, 12);
    let mut setups: Vec<(u32, PageSetup, bool)> = Vec::new();
    for (k, sed) in seds.iter().enumerate() {
        let fc = u32le(sed, 2) as usize;
        let mut s = PageSetup { width: 612.0, height: 792.0, margin_top: 72.0, margin_bottom: 72.0, margin_left: 90.0, margin_right: 90.0, header_dist: 36.0, footer_dist: 36.0, columns: 1, col_gap: 36.0 };
        let mut title_page = false;
        if fc != 0xFFFF_FFFF && fc + 2 < word.len() {
            let cb = u16le(&word, fc) as usize;
            for (sp, op) in sprms(word.get(fc + 2..fc + 2 + cb).unwrap_or(&[])) {
                let v = u16le(op, 0) as f32 / 20.0;
                let vi = i16le(op, 0) as f32 / 20.0;
                match sp {
                    0xB01F => s.width = v,
                    0xB020 => s.height = v,
                    0xB021 => s.margin_left = v,
                    0xB022 => s.margin_right = v,
                    0x9023 => s.margin_top = vi.abs(),
                    0x9024 => s.margin_bottom = vi.abs(),
                    0xB017 => s.header_dist = v,
                    0xB018 => s.footer_dist = v,
                    0x500B => s.columns = u16le(op, 0) as usize + 1,
                    0x900C => s.col_gap = v,
                    0x300A => title_page = op.first().copied().unwrap_or(0) != 0,
                    _ => {}
                }
            }
        }
        setups.push((sed_cps.get(k + 1).copied().unwrap_or(ccp_text), s, title_page));
    }
    if setups.is_empty() {
        setups.push((ccp_text, PageSetup { width: 612.0, height: 792.0, margin_top: 72.0, margin_bottom: 72.0, margin_left: 90.0, margin_right: 90.0, header_dist: 36.0, footer_dist: 36.0, columns: 1, col_gap: 36.0 }, false));
    }

    // corps du document
    let main_blocks = build_blocks(&mut d, 0, ccp_text, &setups);
    let mut sections = Vec::new();
    for (k, (blocks, setup, title)) in main_blocks.into_iter().enumerate() {
        sections.push(Section { setup, blocks, title_page: title, continuous: false, ..Default::default() });
        let _ = k;
    }
    // en-têtes et pieds de page (première section)
    let (fc_hdd, lcb_hdd) = fclcb(11);
    if ccp_hdd > 0 && lcb_hdd > 0 {
        let n = lcb_hdd / 4;
        let cps: Vec<u32> = (0..n).map(|k| u32le(&table, fc_hdd + k * 4)).collect();
        let base = ccp_text + ccp_ftn;
        let story = |d: &mut Doc, idx: usize| -> Option<Vec<Block>> {
            let a = *cps.get(idx)?;
            let b = *cps.get(idx + 1)?;
            if b <= a + 1 {
                return None;
            }
            let v = build_blocks(d, base + a, base + b - 1, &[(base + b, PageSetup::default(), false)]);
            v.into_iter().next().map(|x| x.0).filter(|b| !b.is_empty())
        };
        // 6 séparateurs de notes, puis pour chaque section : en-tête pair, impair, pied pair, impair, première page (en-tête, pied)
        let header = story(&mut d, 7).or_else(|| story(&mut d, 6));
        let footer = story(&mut d, 9).or_else(|| story(&mut d, 8));
        let first_h = story(&mut d, 10);
        let first_f = story(&mut d, 11);
        for s in sections.iter_mut() {
            s.header.default = header.clone();
            s.footer.default = footer.clone();
            s.header.first = first_h.clone();
            s.footer.first = first_f.clone();
        }
    }
    let _ = d.word;
    Ok(FlowDoc { sections, background: None, even_and_odd_headers: false })
}

/// Construit les blocs (paragraphes, tableaux) d'une plage de CP, découpés par section.
fn build_blocks(d: &mut Doc, cp0: u32, cp1: u32, setups: &[(u32, PageSetup, bool)]) -> Vec<(Vec<Block>, PageSetup, bool)> {
    let mut out: Vec<(Vec<Block>, PageSetup, bool)> = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    let mut cur = PBuild { inlines: Vec::new(), start_fc: 0 };
    // état des tableaux
    let mut row_cells: Vec<Vec<Block>> = Vec::new();
    let mut cell_blocks: Vec<Block> = Vec::new();
    let mut rows: Vec<TableRow> = Vec::new();
    let mut table_widths: Vec<f32> = Vec::new();
    let mut table_borders: Option<[Option<BorderLine>; 6]> = None;
    let mut row_bounds: Vec<Vec<i16>> = Vec::new();
    let mut field_stack: Vec<(bool, String)> = Vec::new(); // (dans le résultat, instruction)
    let mut sec_idx = 0;
    let mut last_key: Option<(Option<usize>, Option<usize>)> = None;
    let mut cached: Option<(Option<Vec<u8>>, u16, Chp, Arc<TextStyle>)> = None;
    let end = cp1.min(d.text.len() as u32);
    let mut cp = cp0;
    while cp < end {
        let ch = d.text[cp as usize];
        let fc = d.fcs[cp as usize];
        if cur.inlines.is_empty() {
            cur.start_fc = fc;
        }
        // propriétés de caractère (recalculées seulement au changement de segment)
        let key = (d.chp_index(fc), d.pap_index(fc));
        if last_key != Some(key) || cached.is_none() {
            last_key = Some(key);
            let pap_g = d.pap_at(fc).map(|g| g.to_vec());
            let istd = pap_g.as_ref().map(|g| u16le(g, 0)).unwrap_or(0);
            let (_, style_chp) = d.style_props(istd);
            let mut chp = style_chp.clone();
            if let Some(g) = d.chp_at(fc) {
                let mut direct = Chp::default();
                apply_chp(&mut direct, g, &style_chp);
                if let Some(cs) = direct.istd.filter(|i| *i != 10) {
                    let (_, cchp) = d.style_props(cs);
                    merge_chp(&mut chp, &cchp);
                }
                merge_chp(&mut chp, &direct);
            }
            let st = Arc::new(d.text_style(&chp));
            cached = Some((pap_g, istd, chp, st));
        }
        let (pap_g, istd, chp, st) = cached.clone().unwrap();
        let in_instr = field_stack.iter().any(|f| !f.0);
        let page_field = field_stack.iter().any(|f| f.0 && (f.1.trim_start().starts_with("PAGE") || f.1.trim_start().starts_with("NUMPAGES")));
        let is_end = matches!(ch, 0x0D | 0x07) || (ch == 0x0C && !in_instr);
        match ch {
            0x13 => field_stack.push((false, String::new())),
            0x14 => {
                if let Some(f) = field_stack.last_mut() {
                    f.0 = true;
                    let instr = f.1.trim().to_uppercase();
                    if instr.starts_with("PAGE") && !instr.starts_with("PAGEREF") {
                        cur.inlines.push(Inline::Field(Field::PageNumber, st.clone()));
                    } else if instr.starts_with("NUMPAGES") {
                        cur.inlines.push(Inline::Field(Field::PageCount, st.clone()));
                    }
                }
            }
            0x15 => {
                if let Some((in_res, instr)) = field_stack.pop() {
                    if !in_res {
                        let instr = instr.trim().to_uppercase();
                        if instr.starts_with("PAGE") && !instr.starts_with("PAGEREF") {
                            cur.inlines.push(Inline::Field(Field::PageNumber, st.clone()));
                        } else if instr.starts_with("NUMPAGES") {
                            cur.inlines.push(Inline::Field(Field::PageCount, st.clone()));
                        }
                    }
                }
            }
            _ if in_instr => {
                if let Some(f) = field_stack.last_mut() {
                    if let Some(c) = char::from_u32(ch as u32) {
                        f.1.push(c);
                    }
                }
            }
            _ if page_field && !is_end => {}
            0x09 => cur.inlines.push(Inline::Tab(st.clone())),
            0x0B => cur.inlines.push(Inline::LineBreak(st.clone())),
            0x0E => {}
            0x1E => push_text(&mut cur.inlines, "\u{2011}", &st),
            0x1F | 0x02 | 0x05 | 0x08 => {}
            0x01 => {
                if chp.special.unwrap_or(false) {
                    if let Some(pfc) = chp.pic {
                        if let Some((w, h, items)) = d.picture(pfc) {
                            cur.inlines.push(Inline::Object { width: w, height: h, items, style: st.clone() });
                        }
                    }
                }
            }
            0x28 if chp.symbol.is_some() => {
                let (f, c) = chp.symbol.unwrap();
                let font = d.fonts.get(f as usize).cloned().unwrap_or_default();
                let mapped = crate::fonts::map_symbol_char(&font, char::from_u32(c as u32).unwrap_or(' '));
                let mut s2 = (*st).clone();
                s2.font = Arc::from("DejaVu Sans");
                push_text(&mut cur.inlines, &mapped.to_string(), &Arc::new(s2));
            }
            0x0D | 0x07 | 0x0C => {}
            _ => {
                let c = char::from_u32(ch as u32).unwrap_or('\u{FFFD}');
                if !st.hidden {
                    push_text(&mut cur.inlines, &c.to_string(), &st);
                }
            }
        }
        if is_end {
            // fin de paragraphe : propriétés de paragraphe
            let mut pap = Pap::default();
            let (spap, schp) = d.style_props(istd);
            merge_pap(&mut pap, &spap);
            if let Some(g) = &pap_g {
                let mut dp = Pap::default();
                apply_pap(&mut dp, g.get(2..).unwrap_or(&[]));
                merge_pap(&mut pap, &dp);
            }
            let mark = Arc::new(d.text_style(&chp));
            let mut inlines = std::mem::take(&mut cur.inlines);
            // numérotation
            let mut list_pap = Pap::default();
            if let (Some(ilfo), true) = (pap.ilfo, pap.ilfo.unwrap_or(0) > 0) {
                if let Some((label, lp, lc, follow)) = d.list_label(ilfo, pap.ilvl.unwrap_or(0)) {
                    apply_pap(&mut list_pap, &lp);
                    let mut lchp = schp.clone();
                    let base = lchp.clone();
                    apply_chp(&mut lchp, &lc, &base);
                    let mut lst = d.text_style(&lchp);
                    lst.underline = false;
                    let lst = Arc::new(lst);
                    let mut v = Vec::new();
                    if !label.is_empty() {
                        v.push(Inline::Text(label, lst.clone()));
                        match follow {
                            0 => v.push(Inline::Tab(lst.clone())),
                            1 => v.push(Inline::Text(" ".into(), lst.clone())),
                            _ => {}
                        }
                    }
                    v.extend(inlines);
                    inlines = v;
                }
            }
            let left = pap.left.or(list_pap.left).unwrap_or(0) as f32 / 20.0;
            let first = pap.first.or(list_pap.first).unwrap_or(0) as f32 / 20.0;
            let line = match pap.line {
                Some((v, 1)) => LineSpacing::Multiple(v as f32 / 240.0),
                Some((v, _)) if v < 0 => LineSpacing::Exact(-v as f32 / 20.0),
                Some((v, _)) if v > 0 => LineSpacing::AtLeast(v as f32 / 20.0),
                _ => LineSpacing::Multiple(1.0),
            };
            let props = ParaProps {
                align: match pap.jc.unwrap_or(0) {
                    1 => Align::Center,
                    2 => Align::Right,
                    3 | 4 | 5 => Align::Justify,
                    _ => Align::Left,
                },
                ind_left: left,
                ind_right: pap.right.unwrap_or(0) as f32 / 20.0,
                ind_first: first,
                space_before: pap.before.unwrap_or(0) as f32 / 20.0,
                space_after: pap.after.unwrap_or(0) as f32 / 20.0,
                line,
                tabs: pap
                    .tabs
                    .iter()
                    .map(|(pos, tbd)| TabStop {
                        pos: *pos as f32 / 20.0,
                        kind: match tbd & 7 {
                            1 => TabKind::Center,
                            2 => TabKind::Right,
                            3 => TabKind::Decimal,
                            _ => TabKind::Left,
                        },
                        leader: match (tbd >> 3) & 7 {
                            1 => Some('.'),
                            2 => Some('-'),
                            3 | 4 => Some('_'),
                            _ => None,
                        },
                    })
                    .collect(),
                default_tab: 36.0,
                keep_next: pap.keep_next.unwrap_or(false),
                page_break_before: pap.page_break.unwrap_or(false),
                shading: pap.shading.flatten(),
                contextual_spacing: pap.contextual.unwrap_or(false),
                borders: [pap.pborders[0].clone().flatten(), pap.pborders[1].clone().flatten(), pap.pborders[2].clone().flatten(), pap.pborders[3].clone().flatten()],
                style_id: Some(Arc::from(format!("s{istd}").as_str())),
                ..Default::default()
            };
            let para = Block::Para(Paragraph { props, inlines, mark });
            let in_table = pap.in_table.unwrap_or(false);
            if in_table {
                if pap.ttp.unwrap_or(false) {
                    // fin de ligne : définition des cellules
                    if !cell_blocks.is_empty() {
                        row_cells.push(std::mem::take(&mut cell_blocks));
                    }
                    let (centers, flags) = pap.cells.clone().unwrap_or_default();
                    let n = centers.len().saturating_sub(1).max(row_cells.len());
                    let widths: Vec<f32> = (0..n).map(|k| if k + 1 < centers.len() { (centers[k + 1] - centers[k]).max(0) as f32 / 20.0 } else { 72.0 }).collect();
                    if table_widths.is_empty() || table_widths.len() < widths.len() {
                        table_widths = widths.clone();
                    }
                    if pap.borders.is_some() {
                        table_borders = pap.borders.clone();
                    }
                    let tb = table_borders.clone().unwrap_or([Some(BorderLine::solid(0.5, Color::BLACK)), Some(BorderLine::solid(0.5, Color::BLACK)), Some(BorderLine::solid(0.5, Color::BLACK)), Some(BorderLine::solid(0.5, Color::BLACK)), Some(BorderLine::solid(0.5, Color::BLACK)), Some(BorderLine::solid(0.5, Color::BLACK))]);
                    let mut row = TableRow { height: pap.row_height.map(|h| h.unsigned_abs() as f32 / 20.0).unwrap_or(0.0), exact: pap.row_height.map(|h| h < 0).unwrap_or(false), ..Default::default() };
                    let mut cells = std::mem::take(&mut row_cells).into_iter();
                    let mut k = 0;
                    while k < n {
                        let blocks = cells.next().unwrap_or_default();
                        let f = flags.get(k).copied().unwrap_or(0);
                        let vmerge = if f & 0x20 != 0 {
                            if f & 0x40 != 0 {
                                VMerge::Restart
                            } else {
                                VMerge::Continue
                            }
                        } else {
                            VMerge::None
                        };
                        let cb = pap.cell_borders.get(k).cloned().unwrap_or([tb[0].clone(), tb[3].clone(), tb[2].clone(), tb[1].clone()]);
                        let cell = TableCell { span: 1, vmerge, rowspan: 1, blocks, fill: pap.cell_shading.get(k).copied().flatten(), borders: cb, valign: match (f >> 7) & 3 {
                            1 => VAlign::Center,
                            2 => VAlign::Bottom,
                            _ => VAlign::Top,
                        }, ..Default::default() };
                        // fusion horizontale (ancienne méthode)
                        if f & 2 != 0 && !row.cells.is_empty() {
                            if let Some(last) = row.cells.last_mut() {
                                last.span += 1;
                            }
                        } else {
                            row.cells.push(cell);
                        }
                        k += 1;
                    }
                    rows.push(row);
                    row_bounds.push(centers.clone());
                } else if ch == 0x07 {
                    cell_blocks.push(para);
                    row_cells.push(std::mem::take(&mut cell_blocks));
                } else {
                    cell_blocks.push(para);
                }
            } else {
                if !rows.is_empty() {
                    flush_table(&mut blocks, &mut rows, &mut table_widths, &mut table_borders, &mut row_bounds);
                }
                blocks.push(para);
            }
            // saut de section / de page
            if ch == 0x0C {
                let boundary = setups.get(sec_idx).map(|s| s.0).unwrap_or(u32::MAX);
                if cp + 1 >= boundary && sec_idx + 1 < setups.len() {
                    let (_, s, t) = setups[sec_idx].clone();
                    out.push((std::mem::take(&mut blocks), s, t));
                    sec_idx += 1;
                } else {
                    blocks.push(Block::PageBreak);
                }
            }
        }
        cp += 1;
    }
    if !cur.inlines.is_empty() {
        let mark = Arc::new(TextStyle::default());
        blocks.push(Block::Para(Paragraph { props: ParaProps::default(), inlines: std::mem::take(&mut cur.inlines), mark }));
    }
    if !rows.is_empty() {
        flush_table(&mut blocks, &mut rows, &mut table_widths, &mut table_borders, &mut row_bounds);
    }
    let (_, s, t) = setups.get(sec_idx).cloned().unwrap_or((0, PageSetup::default(), false));
    out.push((blocks, s, t));
    out
}

fn flush_table(blocks: &mut Vec<Block>, rows: &mut Vec<TableRow>, widths: &mut Vec<f32>, borders: &mut Option<[Option<BorderLine>; 6]>, bounds: &mut Vec<Vec<i16>>) {
    // grille commune : union des limites de cellules de toutes les lignes
    let mut grid: Vec<i16> = bounds.iter().flatten().copied().collect();
    grid.sort();
    grid.dedup_by(|a, b| (*a - *b).abs() <= 15);
    let mut w: Vec<f32> = Vec::new();
    if grid.len() >= 2 && bounds.len() == rows.len() {
        w = grid.windows(2).map(|p| (p[1] - p[0]).max(0) as f32 / 20.0).collect();
        let col_of = |x: i16| grid.iter().enumerate().min_by_key(|(_, g)| (**g - x).abs()).map(|(i, _)| i).unwrap_or(0);
        for (row, b) in rows.iter_mut().zip(bounds.iter()) {
            if b.len() < 2 {
                continue;
            }
            let first = col_of(b[0]);
            row.grid_before = first;
            for (k, cell) in row.cells.iter_mut().enumerate() {
                if k + 1 < b.len() {
                    cell.span = col_of(b[k + 1]).saturating_sub(col_of(b[k])).max(1);
                }
            }
        }
    }
    bounds.clear();
    widths.clear();
    let ncols = rows.iter().map(|r| r.cells.iter().map(|c| c.span).sum::<usize>() + r.grid_before).max().unwrap_or(1);
    if w.len() < ncols {
        w.resize(ncols, 72.0);
    }
    blocks.push(Block::Table(Table { col_widths: w, rows: std::mem::take(rows), indent: 0.0, align: Align::Left, cell_margins: [0.0, 5.4, 0.0, 5.4] }));
    *borders = None;
}

fn push_text(v: &mut Vec<Inline>, t: &str, st: &Arc<TextStyle>) {
    if let Some(Inline::Text(prev, pst)) = v.last_mut() {
        if Arc::ptr_eq(pst, st) || **pst == **st {
            prev.push_str(t);
            return;
        }
    }
    v.push(Inline::Text(t.to_string(), st.clone()));
}
