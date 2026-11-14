//! Classeurs Excel 97-2003 (.xls, BIFF8) avec leur mise en forme.

use crate::color::{excel_indexed, Color};
use crate::display::DashStyle;
use crate::numfmt;
use crate::sheet::*;
use crate::text::{BorderLine, TextStyle, VertAlign};
use std::collections::HashMap;
use std::sync::Arc;

fn u16le(b: &[u8], o: usize) -> u16 {
    b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]])).unwrap_or(0)
}
fn u32le(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])).unwrap_or(0)
}
fn f64le(b: &[u8], o: usize) -> f64 {
    b.get(o..o + 8).map(|x| f64::from_le_bytes([x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7]])).unwrap_or(0.0)
}

struct Rec<'a> {
    ty: u16,
    data: &'a [u8],
    #[allow(dead_code)]
    pos: usize,
}

fn records(stream: &[u8], start: usize) -> impl Iterator<Item = Rec<'_>> {
    let mut pos = start;
    std::iter::from_fn(move || {
        if pos + 4 > stream.len() {
            return None;
        }
        let ty = u16le(stream, pos);
        let len = u16le(stream, pos + 2) as usize;
        let end = (pos + 4 + len).min(stream.len());
        let r = Rec { ty, data: &stream[pos + 4..end], pos };
        pos = end;
        Some(r)
    })
}

/// Lecteur de chaînes Unicode BIFF8 pouvant franchir des enregistrements CONTINUE.
struct StrReader<'a> {
    parts: Vec<&'a [u8]>,
    part: usize,
    off: usize,
}

impl<'a> StrReader<'a> {
    fn byte(&mut self) -> Option<u8> {
        loop {
            let p = self.parts.get(self.part)?;
            if self.off < p.len() {
                let b = p[self.off];
                self.off += 1;
                return Some(b);
            }
            self.part += 1;
            self.off = 0;
        }
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes([self.byte()?, self.byte()?]))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes([self.byte()?, self.byte()?, self.byte()?, self.byte()?]))
    }
    fn skip(&mut self, mut n: usize) {
        while n > 0 {
            let Some(p) = self.parts.get(self.part) else { return };
            let avail = p.len() - self.off;
            if avail >= n {
                self.off += n;
                return;
            }
            n -= avail;
            self.part += 1;
            self.off = 0;
        }
    }
    fn string(&mut self) -> Option<String> {
        let cch = self.u16()? as usize;
        let flags = self.byte()?;
        let mut high = flags & 1 != 0;
        let runs = if flags & 8 != 0 { self.u16()? as usize } else { 0 };
        let ext = if flags & 4 != 0 { self.u32()? as usize } else { 0 };
        let mut s = String::with_capacity(cch);
        let mut units: Vec<u16> = Vec::with_capacity(cch);
        let mut read = 0;
        while read < cch {
            // début d'un enregistrement CONTINUE : nouvel octet d'options
            if self.part < self.parts.len() && self.off >= self.parts[self.part].len() {
                self.part += 1;
                self.off = 0;
                high = self.byte()? & 1 != 0;
            }
            if high {
                units.push(self.u16()?);
            } else {
                units.push(self.byte()? as u16);
            }
            read += 1;
        }
        s.push_str(&String::from_utf16_lossy(&units));
        self.skip(runs * 4 + ext);
        Some(s)
    }
}

fn short_string(b: &[u8], o: usize) -> String {
    let cch = *b.get(o).unwrap_or(&0) as usize;
    let high = b.get(o + 1).map(|f| f & 1 != 0).unwrap_or(false);
    decode_chars(b, o + 2, cch, high)
}

fn xl_string(b: &[u8], o: usize) -> String {
    let cch = u16le(b, o) as usize;
    let high = b.get(o + 2).map(|f| f & 1 != 0).unwrap_or(false);
    decode_chars(b, o + 3, cch, high)
}

fn decode_chars(b: &[u8], o: usize, cch: usize, high: bool) -> String {
    if high {
        let units: Vec<u16> = (0..cch).map(|i| u16le(b, o + 2 * i)).collect();
        String::from_utf16_lossy(&units)
    } else {
        // Latin-1 compressé
        b.get(o..(o + cch).min(b.len())).map(|s| s.iter().map(|&c| c as char).collect()).unwrap_or_default()
    }
}

fn rk(v: u32) -> f64 {
    let mut n = if v & 2 != 0 { ((v as i32) >> 2) as f64 } else { f64::from_bits(((v & 0xFFFF_FFFC) as u64) << 32) };
    if v & 1 != 0 {
        n /= 100.0;
    }
    n
}

struct Font {
    style: TextStyle,
}

struct Xf {
    font: u16,
    fmt: u16,
    halign: u8,
    valign: u8,
    wrap: bool,
    indent: u8,
    border1: u32,
    border2: u32,
    fill: u16,
}

fn border(dg: u32, icv: u32, palette: &[Color]) -> Option<BorderLine> {
    let color = pal(icv as u16, palette).unwrap_or(Color::BLACK);
    let (width, dash, double) = match dg {
        0 => return None,
        1 => (0.75, DashStyle::Solid, false),
        2 => (1.5, DashStyle::Solid, false),
        3 => (0.75, DashStyle::Dash, false),
        4 => (0.75, DashStyle::Dot, false),
        5 => (2.25, DashStyle::Solid, false),
        6 => (0.75, DashStyle::Solid, true),
        7 => (0.5, DashStyle::Solid, false),
        8 => (1.5, DashStyle::Dash, false),
        9 | 11 => (0.75, DashStyle::DashDot, false),
        _ => (1.5, DashStyle::DashDot, false),
    };
    Some(BorderLine { width, color, double, dash, space: 0.0 })
}

fn pal(icv: u16, palette: &[Color]) -> Option<Color> {
    match icv {
        0..=7 => excel_indexed(icv as usize),
        8..=63 => palette.get(icv as usize - 8).copied().or_else(|| excel_indexed(icv as usize)),
        64 | 0x7FFF => Some(Color::BLACK),
        65 => Some(Color::WHITE),
        _ => None,
    }
}

pub fn load(data: &[u8]) -> Result<Workbook, String> {
    let mut comp = cfb::CompoundFile::open(std::io::Cursor::new(data)).map_err(|e| format!("Le fichier est endommagé ou incomplet (classeur illisible : {e})."))?;
    let name = if comp.exists("/Workbook") { "/Workbook" } else { "/Book" };
    let mut stream = Vec::new();
    {
        use std::io::Read;
        let mut s = comp.open_stream(name).map_err(|e| format!("Flux Workbook illisible : {e}"))?;
        s.read_to_end(&mut stream).map_err(|e| e.to_string())?;
    }
    if u16le(&stream, 0) != 0x0809 {
        return Err("Seuls les classeurs Excel 97-2003 (BIFF8) sont pris en charge.".into());
    }
    if u16le(&stream, 4) < 0x0600 {
        return Err("Classeur Excel 5/95 non pris en charge.".into());
    }
    // ---------------------------------------------------------- globaux
    let mut sheets_info: Vec<(u32, u8, u8, String)> = Vec::new();
    let mut sst: Vec<String> = Vec::new();
    let mut fonts: Vec<Font> = Vec::new();
    let mut formats: HashMap<u16, String> = HashMap::new();
    let mut xfs: Vec<Xf> = Vec::new();
    let mut palette: Vec<Color> = (8..64).filter_map(excel_indexed).collect();
    let mut date1904 = false;
    let mut font_records: Vec<Vec<u8>> = Vec::new();
    let recs: Vec<Rec> = records(&stream, 0).collect();
    let mut i = 0;
    while i < recs.len() {
        let r = &recs[i];
        match r.ty {
            0x0085 => sheets_info.push((u32le(r.data, 0), r.data.get(4).copied().unwrap_or(0), r.data.get(5).copied().unwrap_or(0), short_string(r.data, 6))),
            0x00FC => {
                // SST + enregistrements CONTINUE
                let mut parts = vec![&r.data[8.min(r.data.len())..]];
                let mut j = i + 1;
                while j < recs.len() && recs[j].ty == 0x003C {
                    parts.push(recs[j].data);
                    j += 1;
                }
                let count = u32le(r.data, 4) as usize;
                let mut rd = StrReader { parts, part: 0, off: 0 };
                for _ in 0..count.min(2_000_000) {
                    match rd.string() {
                        Some(s) => sst.push(s),
                        None => break,
                    }
                }
            }
            0x0031 => font_records.push(r.data.to_vec()),
            0x041E => {
                formats.insert(u16le(r.data, 0), xl_string(r.data, 2));
            }
            0x00E0 => xfs.push(Xf {
                font: u16le(r.data, 0),
                fmt: u16le(r.data, 2),
                halign: r.data.get(6).map(|b| b & 7).unwrap_or(0),
                wrap: r.data.get(6).map(|b| b & 8 != 0).unwrap_or(false),
                valign: r.data.get(6).map(|b| (b >> 4) & 7).unwrap_or(2),
                indent: r.data.get(8).map(|b| b & 15).unwrap_or(0),
                border1: u32le(r.data, 10),
                border2: u32le(r.data, 14),
                fill: u16le(r.data, 18),
            }),
            0x0092 => {
                let n = u16le(r.data, 0) as usize;
                palette = (0..n).map(|k| Color::rgb(r.data.get(2 + k * 4).copied().unwrap_or(0), r.data.get(3 + k * 4).copied().unwrap_or(0), r.data.get(4 + k * 4).copied().unwrap_or(0))).collect();
            }
            0x0022 => date1904 = u16le(r.data, 0) == 1,
            0x000A => break,
            _ => {}
        }
        i += 1;
    }
    for f in &font_records {
        let height = u16le(f, 0) as f32 / 20.0;
        let grbit = u16le(f, 2);
        let icv = u16le(f, 4);
        let bls = u16le(f, 6);
        let sss = u16le(f, 8);
        let uls = f.get(10).copied().unwrap_or(0);
        let name = short_string(f, 14);
        fonts.push(Font {
            style: TextStyle {
                font: Arc::from(if name.is_empty() { "Arial" } else { name.as_str() }),
                size: if height > 0.0 { height } else { 10.0 },
                bold: bls >= 600,
                italic: grbit & 2 != 0,
                strike: grbit & 8 != 0,
                underline: uls == 1 || uls == 0x21,
                double_underline: uls == 2 || uls == 0x22,
                color: pal(icv, &palette).unwrap_or(Color::BLACK),
                vert: match sss {
                    1 => VertAlign::Super,
                    2 => VertAlign::Sub,
                    _ => VertAlign::Baseline,
                },
                ..Default::default()
            },
        });
    }
    let font_at = |ifnt: u16| -> TextStyle {
        // l'index 4 n'existe pas dans BIFF
        let idx = if ifnt >= 4 { ifnt as usize - 1 } else { ifnt as usize };
        fonts.get(idx).map(|f| f.style.clone()).unwrap_or_else(|| TextStyle { font: Arc::from("Arial"), size: 10.0, ..Default::default() })
    };
    let default_font = font_at(0);
    let mut cell_styles = Vec::with_capacity(xfs.len());
    let mut num_fmts = Vec::with_capacity(xfs.len());
    for x in &xfs {
        let b1 = x.border1;
        let b2 = x.border2;
        let fls = (b2 >> 26) & 0x3F;
        let fore = pal(x.fill & 0x7F, &palette);
        let back = pal((x.fill >> 7) & 0x7F, &palette);
        let fill = match fls {
            0 => None,
            1 => fore,
            _ => Some(fore.unwrap_or(Color::BLACK).mix(back.unwrap_or(Color::WHITE), 0.5)),
        };
        cell_styles.push(CellStyle {
            font: Arc::new(font_at(x.font)),
            fill,
            borders: [border((b1 >> 8) & 15, b2 & 0x7F, &palette), border((b1 >> 4) & 15, (b1 >> 23) & 0x7F, &palette), border((b1 >> 12) & 15, (b2 >> 7) & 0x7F, &palette), border(b1 & 15, (b1 >> 16) & 0x7F, &palette)],
            halign: match x.halign {
                1 => HAlign::Left,
                2 => HAlign::Center,
                3 => HAlign::Right,
                4 => HAlign::Fill,
                5 | 7 => HAlign::Justify,
                6 => HAlign::CenterAcross,
                _ => HAlign::General,
            },
            valign: match x.valign {
                0 => VAlign::Top,
                1 | 3 | 4 => VAlign::Center,
                _ => VAlign::Bottom,
            },
            wrap: x.wrap,
            indent: x.indent as f32 * 9.0,
            rotation: 0,
            shrink: false,
        });
        num_fmts.push(formats.get(&x.fmt).cloned().or_else(|| numfmt::builtin(x.fmt as u32).map(String::from)).unwrap_or_else(|| "General".into()));
    }
    if cell_styles.is_empty() {
        cell_styles.push(CellStyle { font: Arc::new(default_font.clone()), ..Default::default() });
        num_fmts.push("General".into());
    }
    let styles = Arc::new(cell_styles);
    // largeur du chiffre le plus large
    let db = crate::fonts::db();
    let rf = default_font.resolved();
    let px = default_font.size * 96.0 / 72.0;
    let mdw = ('0'..='9').map(|d| {
        let (f, g) = db.glyph(rf.id, d);
        db.advance(f, g) * px
    });
    let mdw = mdw.fold(0.0f32, f32::max).round().max(5.0);

    // ---------------------------------------------------------- feuilles
    let mut out = Vec::new();
    for (pos, state, dt, name) in sheets_info {
        if dt != 0 {
            continue;
        }
        let mut b = SheetBuilder::new(&name, styles.clone());
        b.hidden = state != 0;
        b.default_row_height = (crate::text::single_line_height(&default_font) + 2.0).round();
        b.default_col_width = ((8.0 * mdw + 5.0) / 8.0).ceil() * 8.0 * 0.75;
        let fmt_of = |ixfe: u16| -> &str { num_fmts.get(ixfe as usize).map(|s| s.as_str()).unwrap_or("General") };
        let push_num = |b: &mut SheetBuilder, r: u16, c: u16, ixfe: u16, v: f64| {
            let (t, col) = numfmt::format_value(v, fmt_of(ixfe), date1904);
            b.cells.push((r as u32, Cell { col: c as u32, text: t, kind: CellKind::Number, style: ixfe as u32, color: col, rich: None }));
        };
        let mut pending_formula: Option<(u16, u16, u16)> = None;
        for r in records(&stream, pos as usize).skip(1) {
            let d = r.data;
            match r.ty {
                0x000A => break,
                0x0055 => {
                    let cch = u16le(d, 0) as f32;
                    b.default_col_width = ((cch * mdw + 5.0) / 8.0).ceil() * 8.0 * 0.75;
                }
                0x0225 => {
                    let h = u16le(d, 2) as f32 / 20.0;
                    if h > 0.0 {
                        b.default_row_height = h;
                    }
                }
                0x007D => {
                    let first = u16le(d, 0) as u32;
                    let last = (u16le(d, 2) as u32).min(16383);
                    let w = u16le(d, 4) as f32 / 256.0;
                    let hidden = u16le(d, 8) & 1 != 0;
                    b.col_widths.push((first, last, (w * mdw).round() * 0.75, hidden));
                }
                0x0208 => {
                    let rw = u16le(d, 0) as u32;
                    let miy = u16le(d, 6);
                    let flags = u32le(d, 12);
                    let hidden = flags & 0x20 != 0;
                    let custom = flags & 0x40 != 0;
                    let h = (miy & 0x7FFF) as f32 / 20.0;
                    if custom || hidden || miy & 0x8000 == 0 {
                        b.row_heights.push((rw, if hidden { 0.0 } else { h }, hidden));
                    }
                }
                0x00FD => {
                    let (rw, c, x) = (u16le(d, 0), u16le(d, 2), u16le(d, 4));
                    let s = sst.get(u32le(d, 6) as usize).cloned().unwrap_or_default();
                    b.cells.push((rw as u32, Cell { col: c as u32, text: numfmt::format_text(&s, fmt_of(x)), kind: CellKind::Text, style: x as u32, color: None, rich: None }));
                }
                0x0204 => {
                    let (rw, c, x) = (u16le(d, 0), u16le(d, 2), u16le(d, 4));
                    b.cells.push((rw as u32, Cell { col: c as u32, text: xl_string(d, 6), kind: CellKind::Text, style: x as u32, color: None, rich: None }));
                }
                0x0203 => push_num(&mut b, u16le(d, 0), u16le(d, 2), u16le(d, 4), f64le(d, 6)),
                0x027E => push_num(&mut b, u16le(d, 0), u16le(d, 2), u16le(d, 4), rk(u32le(d, 6))),
                0x00BD => {
                    let rw = u16le(d, 0);
                    let first = u16le(d, 2);
                    let n = (d.len().saturating_sub(6)) / 6;
                    for k in 0..n {
                        push_num(&mut b, rw, first + k as u16, u16le(d, 4 + k * 6), rk(u32le(d, 6 + k * 6)));
                    }
                }
                0x0201 => {
                    b.cells.push((u16le(d, 0) as u32, Cell { col: u16le(d, 2) as u32, style: u16le(d, 4) as u32, ..Default::default() }));
                }
                0x00BE => {
                    let rw = u16le(d, 0);
                    let first = u16le(d, 2);
                    let n = (d.len().saturating_sub(6)) / 2;
                    for k in 0..n {
                        b.cells.push((rw as u32, Cell { col: (first as usize + k) as u32, style: u16le(d, 4 + k * 2) as u32, ..Default::default() }));
                    }
                }
                0x0205 => {
                    let (rw, c, x) = (u16le(d, 0), u16le(d, 2), u16le(d, 4));
                    let v = d.get(6).copied().unwrap_or(0);
                    let is_err = d.get(7).copied().unwrap_or(0) != 0;
                    let (text, kind) = if is_err { (crate::ooxml::xlsx::error_text(err_code(v)), CellKind::Error) } else { (crate::ooxml::xlsx::bool_text(v != 0), CellKind::Bool) };
                    b.cells.push((rw as u32, Cell { col: c as u32, text, kind, style: x as u32, color: None, rich: None }));
                }
                0x0006 => {
                    let (rw, c, x) = (u16le(d, 0), u16le(d, 2), u16le(d, 4));
                    if u16le(d, 12) == 0xFFFF {
                        match d.get(6).copied().unwrap_or(3) {
                            0 => pending_formula = Some((rw, c, x)),
                            1 => b.cells.push((rw as u32, Cell { col: c as u32, text: crate::ooxml::xlsx::bool_text(d.get(8).copied().unwrap_or(0) != 0), kind: CellKind::Bool, style: x as u32, color: None, rich: None })),
                            2 => b.cells.push((rw as u32, Cell { col: c as u32, text: crate::ooxml::xlsx::error_text(err_code(d.get(8).copied().unwrap_or(0x2A))), kind: CellKind::Error, style: x as u32, color: None, rich: None })),
                            _ => b.cells.push((rw as u32, Cell { col: c as u32, style: x as u32, ..Default::default() })),
                        }
                    } else {
                        push_num(&mut b, rw, c, x, f64le(d, 6));
                    }
                }
                0x0207 => {
                    if let Some((rw, c, x)) = pending_formula.take() {
                        b.cells.push((rw as u32, Cell { col: c as u32, text: xl_string(d, 0), kind: CellKind::Text, style: x as u32, color: None, rich: None }));
                    }
                }
                0x00E5 => {
                    let n = u16le(d, 0) as usize;
                    for k in 0..n {
                        let o = 2 + k * 8;
                        b.merges.push(Merge { r1: u16le(d, o) as u32, r2: u16le(d, o + 2) as u32, c1: u16le(d, o + 4) as u32, c2: u16le(d, o + 6) as u32 });
                    }
                }
                0x023E => {
                    let g = u16le(d, 0);
                    b.show_grid = g & 2 != 0;
                }
                0x0041 => {
                    b.frozen_cols = u16le(d, 0) as u32;
                    b.frozen_rows = u16le(d, 2) as u32;
                }
                _ => {}
            }
        }
        out.push(b.build());
    }
    if out.is_empty() {
        return Err("Aucune feuille de calcul dans le classeur.".into());
    }
    Ok(Workbook { sheets: out })
}

fn err_code(v: u8) -> &'static str {
    match v {
        0x00 => "#NULL!",
        0x07 => "#DIV/0!",
        0x0F => "#VALUE!",
        0x17 => "#REF!",
        0x1D => "#NAME?",
        0x24 => "#NUM!",
        _ => "#N/A",
    }
}
