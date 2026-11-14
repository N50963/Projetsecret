//! Documents RTF (Rich Text Format).

use crate::color::Color;
use crate::display::{Item, Rect};
use crate::flow::*;
use crate::text::*;
use std::sync::Arc;

#[derive(Clone)]
struct CharState {
    font: usize,
    size: f32,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    color: usize,
    highlight: usize,
    vert: VertAlign,
    caps: bool,
    hidden: bool,
}

impl Default for CharState {
    fn default() -> Self {
        CharState { font: 0, size: 12.0, bold: false, italic: false, underline: false, strike: false, color: 0, highlight: 0, vert: VertAlign::Baseline, caps: false, hidden: false }
    }
}

#[derive(Clone, Default)]
struct ParaState {
    align: Align,
    left: f32,
    right: f32,
    first: f32,
    before: f32,
    after: f32,
    line: Option<(f32, bool)>,
    in_table: bool,
    tabs: Vec<TabStop>,
    keep_next: bool,
    page_break_before: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Dest {
    Normal,
    Skip,
    FontTable,
    ColorTable,
    Pict,
    FieldInst,
}

#[derive(Clone)]
struct Group {
    chr: CharState,
    dest: Dest,
    uc: usize,
}

struct Parser {
    fonts: Vec<(usize, String)>,
    colors: Vec<Option<Color>>,
    cur_color: [u8; 3],
    color_set: bool,
    stack: Vec<Group>,
    g: Group,
    para: ParaState,
    inlines: Vec<Inline>,
    blocks: Vec<Block>,
    // tableau
    cellx: Vec<f32>,
    cells: Vec<Vec<Block>>,
    cell_blocks: Vec<Block>,
    rows: Vec<TableRow>,
    table_widths: Vec<f32>,
    setup: PageSetup,
    pict: Vec<u8>,
    pict_hex: String,
    pict_size: (f32, f32, f32, f32), // picwgoal, pichgoal, scalex, scaley
    skip_chars: usize,
    font_name_buf: String,
    codepage: &'static encoding_rs::Encoding,
    /// Capture d'un en-tête / pied : (profondeur, en-tête ?, état sauvegardé)
    capture: Option<(usize, bool, Vec<Block>, Vec<Inline>, ParaState)>,
    /// Le résultat en cache du champ courant est remplacé par un champ dynamique.
    skip_result: bool,
    header: Option<Vec<Block>>,
    footer: Option<Vec<Block>>,
}

impl Parser {
    fn style(&self) -> Arc<TextStyle> {
        let c = &self.g.chr;
        let font = self.fonts.iter().find(|f| f.0 == c.font).map(|f| f.1.clone()).unwrap_or_else(|| "Times New Roman".into());
        Arc::new(TextStyle {
            font: Arc::from(font.as_str()),
            size: c.size,
            bold: c.bold,
            italic: c.italic,
            underline: c.underline,
            strike: c.strike,
            color: self.colors.get(c.color).copied().flatten().unwrap_or(Color::BLACK),
            highlight: if c.highlight > 0 { self.colors.get(c.highlight).copied().flatten() } else { None },
            vert: c.vert,
            caps: c.caps,
            hidden: c.hidden,
            ..Default::default()
        })
    }

    fn text(&mut self, s: &str) {
        match self.g.dest {
            Dest::Normal => {
                if s.is_empty() || self.g.chr.hidden {
                    return;
                }
                let st = self.style();
                if let Some(Inline::Text(prev, pst)) = self.inlines.last_mut() {
                    if **pst == *st {
                        prev.push_str(s);
                        return;
                    }
                }
                self.inlines.push(Inline::Text(s.to_string(), st));
            }
            Dest::FontTable => self.font_name_buf.push_str(s),
            _ => {}
        }
    }

    fn end_para(&mut self, cell_end: bool) {
        let p = &self.para;
        let props = ParaProps {
            align: p.align,
            ind_left: p.left,
            ind_right: p.right,
            ind_first: p.first,
            space_before: p.before,
            space_after: p.after,
            line: match p.line {
                Some((v, true)) => LineSpacing::Multiple(v / 240.0),
                Some((v, false)) if v < 0.0 => LineSpacing::Exact(-v / 20.0),
                Some((v, false)) if v > 0.0 => LineSpacing::AtLeast(v / 20.0),
                _ => LineSpacing::Multiple(1.0),
            },
            tabs: p.tabs.clone(),
            keep_next: p.keep_next,
            page_break_before: p.page_break_before,
            ..Default::default()
        };
        let mark = self.style();
        let para = Block::Para(Paragraph { props, inlines: std::mem::take(&mut self.inlines), mark });
        if self.para.in_table || cell_end {
            self.cell_blocks.push(para);
            if cell_end {
                let b = std::mem::take(&mut self.cell_blocks);
                self.cells.push(b);
            }
        } else {
            self.flush_table();
            self.blocks.push(para);
        }
    }

    fn end_row(&mut self) {
        if !self.inlines.is_empty() || !self.cell_blocks.is_empty() {
            self.end_para(true);
        }
        let n = self.cellx.len().max(self.cells.len());
        let mut prev = 0.0;
        let widths: Vec<f32> = self.cellx.iter().map(|x| {
            let w = (x - prev).max(4.0);
            prev = *x;
            w
        }).collect();
        if self.table_widths.len() < widths.len() {
            self.table_widths = widths;
        }
        let b = Some(BorderLine::solid(0.5, Color::BLACK));
        let mut row = TableRow::default();
        let mut cells = std::mem::take(&mut self.cells).into_iter();
        for _ in 0..n {
            row.cells.push(TableCell { span: 1, rowspan: 1, blocks: cells.next().unwrap_or_default(), borders: [b.clone(), b.clone(), b.clone(), b.clone()], ..Default::default() });
        }
        self.rows.push(row);
    }

    fn flush_table(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        let n = self.rows.iter().map(|r| r.cells.len()).max().unwrap_or(1);
        let mut w = std::mem::take(&mut self.table_widths);
        w.resize(n, 72.0);
        self.blocks.push(Block::Table(Table { col_widths: w, rows: std::mem::take(&mut self.rows), cell_margins: [0.0, 5.4, 0.0, 5.4], ..Default::default() }));
    }

    fn picture(&mut self) {
        let hex: Vec<u8> = self.pict_hex.as_bytes().chunks(2).filter_map(|c| std::str::from_utf8(c).ok().and_then(|s| u8::from_str_radix(s, 16).ok())).collect();
        let data = if hex.is_empty() { std::mem::take(&mut self.pict) } else { hex };
        self.pict_hex.clear();
        let (w, h, sx, sy) = self.pict_size;
        let w = w / 20.0 * sx / 100.0;
        let h = h / 20.0 * sy / 100.0;
        let img = crate::package::decode_image(&data);
        let (w, h) = match &img {
            Some(i) if w <= 0.0 || h <= 0.0 => (i.width() as f32 * 0.75, i.height() as f32 * 0.75),
            _ => (w.max(1.0), h.max(1.0)),
        };
        let item = match img {
            Some(i) => Item::Image { rect: Rect::new(0.0, 0.0, w, h), image: i, crop: [0.0; 4], alpha: 1.0 },
            None => Item::Placeholder { rect: Rect::new(0.0, 0.0, w, h), label: "image".into() },
        };
        let st = self.style();
        self.inlines.push(Inline::Object { width: w, height: h, items: vec![item], style: st });
    }

    fn control(&mut self, word: &str, param: Option<i32>) {
        let p = param.unwrap_or(1);
        let on = param.map(|v| v != 0).unwrap_or(true);
        let dest = self.g.dest;
        match word {
            // destinations
            "fonttbl" => self.g.dest = Dest::FontTable,
            "colortbl" => {
                self.g.dest = Dest::ColorTable;
                self.colors.clear();
            }
            "header" | "headerr" | "footer" | "footerr" if dest == Dest::Normal && self.capture.is_none() => {
                let is_header = word.starts_with("header");
                self.capture = Some((self.stack.len(), is_header, std::mem::take(&mut self.blocks), std::mem::take(&mut self.inlines), std::mem::take(&mut self.para)));
            }
            "stylesheet" | "info" | "header" | "footer" | "headerl" | "headerr" | "headerf" | "footerl" | "footerr" | "footerf" | "footnote" | "annotation" | "xmlnstbl" | "listtable" | "listoverridetable" | "rsidtbl" | "generator" | "themedata" | "colorschememapping" | "latentstyles" | "datastore" | "pgdsctbl" | "object" | "nonshppict" | "bkmkstart" | "bkmkend" | "revtbl" | "mmathPr" | "filetbl" | "pnseclvl" => self.g.dest = Dest::Skip,
            "fldinst" => self.g.dest = Dest::FieldInst,
            "fldrslt" => {
                if self.skip_result {
                    self.g.dest = Dest::Skip;
                    self.skip_result = false;
                }
            }
            "pict" => {
                self.g.dest = Dest::Pict;
                self.pict_size = (0.0, 0.0, 100.0, 100.0);
                self.pict_hex.clear();
            }
            "picwgoal" => self.pict_size.0 = p as f32,
            "pichgoal" => self.pict_size.1 = p as f32,
            "picscalex" => self.pict_size.2 = p as f32,
            "picscaley" => self.pict_size.3 = p as f32,
            "red" if dest == Dest::ColorTable => {
                self.cur_color[0] = p as u8;
                self.color_set = true;
            }
            "green" if dest == Dest::ColorTable => {
                self.cur_color[1] = p as u8;
                self.color_set = true;
            }
            "blue" if dest == Dest::ColorTable => {
                self.cur_color[2] = p as u8;
                self.color_set = true;
            }
            "f" if dest == Dest::FontTable => {
                if !self.font_name_buf.is_empty() {
                    self.font_name_buf.clear();
                }
                self.fonts.push((p.max(0) as usize, String::new()));
            }
            "ansicpg" => {
                if let Some(e) = encoding_rs::Encoding::for_label(format!("windows-{p}").as_bytes()) {
                    self.codepage = e;
                }
            }
            "uc" => self.g.uc = p.max(0) as usize,
            _ if dest != Dest::Normal => {}
            // caractères
            "plain" => self.g.chr = CharState { font: self.g.chr.font.min(0), ..CharState::default() },
            "f" => self.g.chr.font = p.max(0) as usize,
            "fs" => self.g.chr.size = p as f32 / 2.0,
            "b" => self.g.chr.bold = on,
            "i" => self.g.chr.italic = on,
            "ul" => self.g.chr.underline = on,
            "uldb" | "ulw" | "uld" | "uldash" => self.g.chr.underline = on,
            "ulnone" => self.g.chr.underline = false,
            "strike" | "striked" => self.g.chr.strike = on,
            "cf" => self.g.chr.color = p.max(0) as usize,
            "highlight" | "cb" | "chcbpat" => self.g.chr.highlight = p.max(0) as usize,
            "super" => self.g.chr.vert = VertAlign::Super,
            "sub" => self.g.chr.vert = VertAlign::Sub,
            "nosupersub" => self.g.chr.vert = VertAlign::Baseline,
            "caps" => self.g.chr.caps = on,
            "v" => self.g.chr.hidden = on,
            // paragraphes
            "pard" => {
                let in_table = false;
                self.para = ParaState { in_table, ..Default::default() };
            }
            "ql" => self.para.align = Align::Left,
            "qc" => self.para.align = Align::Center,
            "qr" => self.para.align = Align::Right,
            "qj" | "qd" => self.para.align = Align::Justify,
            "li" | "lin" => self.para.left = p as f32 / 20.0,
            "ri" | "rin" => self.para.right = p as f32 / 20.0,
            "fi" => self.para.first = p as f32 / 20.0,
            "sb" => self.para.before = p as f32 / 20.0,
            "sa" => self.para.after = p as f32 / 20.0,
            "sl" => self.para.line = Some((p as f32, self.para.line.map(|l| l.1).unwrap_or(false))),
            "slmult" => {
                if let Some(l) = self.para.line.as_mut() {
                    l.1 = p == 1;
                }
            }
            "keepn" => self.para.keep_next = true,
            "pagebb" => self.para.page_break_before = true,
            "tx" => self.para.tabs.push(TabStop { pos: p as f32 / 20.0, kind: TabKind::Left, leader: None }),
            "tqr" => self.para.tabs.push(TabStop { pos: 0.0, kind: TabKind::Right, leader: None }),
            "intbl" => self.para.in_table = true,
            "par" => self.end_para(false),
            "line" => {
                let st = self.style();
                self.inlines.push(Inline::LineBreak(st));
            }
            "tab" => {
                let st = self.style();
                self.inlines.push(Inline::Tab(st));
            }
            "page" => {
                if !self.inlines.is_empty() {
                    self.end_para(false);
                }
                self.flush_table();
                self.blocks.push(Block::PageBreak);
            }
            "cell" => self.end_para(true),
            "trowd" => self.cellx.clear(),
            "cellx" => self.cellx.push(p as f32 / 20.0),
            "row" => self.end_row(),
            "emdash" => self.text("—"),
            "endash" => self.text("–"),
            "bullet" => self.text("•"),
            "lquote" => self.text("‘"),
            "rquote" => self.text("’"),
            "ldblquote" => self.text("“"),
            "rdblquote" => self.text("”"),
            "~" => self.text("\u{a0}"),
            "-" => {}
            "_" => self.text("\u{2011}"),
            // mise en page
            "paperw" => self.setup.width = p as f32 / 20.0,
            "paperh" => self.setup.height = p as f32 / 20.0,
            "margl" => self.setup.margin_left = p as f32 / 20.0,
            "margr" => self.setup.margin_right = p as f32 / 20.0,
            "margt" => self.setup.margin_top = p as f32 / 20.0,
            "margb" => self.setup.margin_bottom = p as f32 / 20.0,
            _ => {}
        }
    }
}

pub fn load(data: &[u8]) -> Result<FlowDoc, String> {
    let src = data;
    let mut ps = Parser {
        fonts: Vec::new(),
        colors: vec![None],
        cur_color: [0; 3],
        color_set: false,
        stack: Vec::new(),
        g: Group { chr: CharState::default(), dest: Dest::Normal, uc: 1 },
        para: ParaState::default(),
        inlines: Vec::new(),
        blocks: Vec::new(),
        cellx: Vec::new(),
        cells: Vec::new(),
        cell_blocks: Vec::new(),
        rows: Vec::new(),
        table_widths: Vec::new(),
        setup: PageSetup { width: 612.0, height: 792.0, margin_top: 72.0, margin_bottom: 72.0, margin_left: 90.0, margin_right: 90.0, header_dist: 36.0, footer_dist: 36.0, columns: 1, col_gap: 36.0 },
        pict: Vec::new(),
        pict_hex: String::new(),
        pict_size: (0.0, 0.0, 100.0, 100.0),
        skip_chars: 0,
        font_name_buf: String::new(),
        codepage: encoding_rs::WINDOWS_1252,
        capture: None,
        skip_result: false,
        header: None,
        footer: None,
    };
    let mut i = 0;
    let mut text = String::new();
    let mut bytes_buf: Vec<u8> = Vec::new();
    let flush_bytes = |ps: &mut Parser, bytes: &mut Vec<u8>, text: &mut String| {
        if !bytes.is_empty() {
            text.push_str(&ps.codepage.decode(bytes).0);
            bytes.clear();
        }
    };
    let flush_text = |ps: &mut Parser, text: &mut String| {
        if !text.is_empty() {
            let t = std::mem::take(text);
            if ps.g.dest == Dest::FontTable {
                ps.font_name_buf.push_str(&t);
                // fin de nom de police : « ; »
                if let Some(pos) = ps.font_name_buf.find(';') {
                    let name = ps.font_name_buf[..pos].trim().to_string();
                    if let Some(f) = ps.fonts.last_mut() {
                        if f.1.is_empty() {
                            f.1 = name;
                        }
                    }
                    ps.font_name_buf.clear();
                }
            } else if ps.g.dest == Dest::ColorTable {
                for _ in t.matches(';') {
                    let c = if ps.color_set { Some(Color::rgb(ps.cur_color[0], ps.cur_color[1], ps.cur_color[2])) } else { None };
                    ps.colors.push(c);
                    ps.cur_color = [0; 3];
                    ps.color_set = false;
                }
            } else if ps.g.dest == Dest::FieldInst {
                let instr = t.trim().to_uppercase();
                let st = ps.style();
                if instr.starts_with("PAGE") && !instr.starts_with("PAGEREF") {
                    ps.inlines.push(Inline::Field(Field::PageNumber, st));
                    ps.skip_result = true;
                } else if instr.starts_with("NUMPAGES") {
                    ps.inlines.push(Inline::Field(Field::PageCount, st));
                    ps.skip_result = true;
                }
            } else if ps.g.dest == Dest::Pict {
                ps.pict_hex.extend(t.chars().filter(|c| c.is_ascii_hexdigit()));
            } else {
                ps.text(&t);
            }
        }
    };
    while i < src.len() {
        let c = src[i];
        match c {
            b'{' => {
                flush_bytes(&mut ps, &mut bytes_buf, &mut text);
                flush_text(&mut ps, &mut text);
                ps.stack.push(ps.g.clone());
                i += 1;
            }
            b'}' => {
                flush_bytes(&mut ps, &mut bytes_buf, &mut text);
                flush_text(&mut ps, &mut text);
                if ps.g.dest == Dest::Pict && ps.stack.last().map(|g| g.dest != Dest::Pict).unwrap_or(true) {
                    ps.picture();
                }
                if let Some(g) = ps.stack.pop() {
                    ps.g = g;
                }
                // fin d'un en-tête ou pied de page
                if ps.capture.as_ref().map(|c| ps.stack.len() + 1 == c.0).unwrap_or(false) {
                    if !ps.inlines.is_empty() {
                        ps.end_para(false);
                    }
                    let (_, is_header, blocks, inlines, para) = ps.capture.take().unwrap();
                    let captured = std::mem::replace(&mut ps.blocks, blocks);
                    ps.inlines = inlines;
                    ps.para = para;
                    if !captured.is_empty() {
                        if is_header {
                            ps.header = Some(captured);
                        } else {
                            ps.footer = Some(captured);
                        }
                    }
                }
                i += 1;
            }
            b'\\' => {
                i += 1;
                let Some(&n) = src.get(i) else { break };
                if n == b'\'' {
                    // caractère hexadécimal dans la page de code
                    if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&src[(i + 1).min(src.len())..(i + 3).min(src.len())]).unwrap_or("3f"), 16) {
                        if ps.skip_chars > 0 {
                            ps.skip_chars -= 1;
                        } else {
                            bytes_buf.push(v);
                        }
                    }
                    i += 3;
                    continue;
                }
                flush_bytes(&mut ps, &mut bytes_buf, &mut text);
                if n.is_ascii_alphabetic() {
                    let st = i;
                    while i < src.len() && src[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = std::str::from_utf8(&src[st..i]).unwrap_or("").to_string();
                    let ps_ = i;
                    if i < src.len() && (src[i] == b'-' || src[i].is_ascii_digit()) {
                        i += 1;
                        while i < src.len() && src[i].is_ascii_digit() {
                            i += 1;
                        }
                    }
                    let param = if i > ps_ { std::str::from_utf8(&src[ps_..i]).ok().and_then(|s| s.parse::<i32>().ok()) } else { None };
                    if i < src.len() && src[i] == b' ' {
                        i += 1;
                    }
                    if word == "u" {
                        if let Some(v) = param {
                            let cp = if v < 0 { (v + 65536) as u32 } else { v as u32 };
                            if let Some(ch) = char::from_u32(cp) {
                                text.push(ch);
                            }
                            ps.skip_chars = ps.g.uc;
                        }
                        continue;
                    }
                    flush_text(&mut ps, &mut text);
                    if word == "bin" {
                        let n = param.unwrap_or(0).max(0) as usize;
                        if ps.g.dest == Dest::Pict {
                            ps.pict = src[i.min(src.len())..(i + n).min(src.len())].to_vec();
                        }
                        i += n;
                        continue;
                    }
                    ps.control(&word, param);
                } else {
                    i += 1;
                    match n {
                        b'*' => {
                            flush_text(&mut ps, &mut text);
                            // destination facultative : ignorée sauf exceptions
                            let rest = std::str::from_utf8(&src[i..(i + 20).min(src.len())]).unwrap_or("");
                            if !(rest.starts_with("\\fldinst") || rest.starts_with("\\shppict") || rest.starts_with("\\blipuid")) {
                                ps.g.dest = Dest::Skip;
                            }
                        }
                        b'\\' | b'{' | b'}' => text.push(n as char),
                        b'~' => text.push('\u{a0}'),
                        b'-' => {}
                        b'_' => text.push('\u{2011}'),
                        b'\n' | b'\r' => {
                            flush_text(&mut ps, &mut text);
                            ps.control("par", None);
                        }
                        b'|' | b':' => {}
                        _ => {}
                    }
                }
            }
            b'\r' | b'\n' => i += 1,
            _ => {
                if ps.skip_chars > 0 {
                    ps.skip_chars -= 1;
                } else if c < 0x80 {
                    flush_bytes(&mut ps, &mut bytes_buf, &mut text);
                    text.push(c as char);
                } else {
                    bytes_buf.push(c);
                }
                i += 1;
            }
        }
    }
    flush_bytes(&mut ps, &mut bytes_buf, &mut text);
    flush_text(&mut ps, &mut text);
    if !ps.inlines.is_empty() {
        ps.end_para(false);
    }
    ps.flush_table();
    if ps.blocks.is_empty() {
        return Err("Document RTF vide ou illisible.".into());
    }
    let mut sec = Section { setup: ps.setup.clone(), blocks: ps.blocks, ..Default::default() };
    sec.header.default = ps.header;
    sec.footer.default = ps.footer;
    Ok(FlowDoc { sections: vec![sec], background: None, even_and_odd_headers: false })
}
