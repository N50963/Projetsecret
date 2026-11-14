//! Base de polices : polices embarquées métriquement compatibles avec les polices
//! Microsoft (Liberation ≈ Arial/Times/Courier, Carlito ≈ Calibri, Caladea ≈ Cambria)
//! et polices système de secours chargées à la demande (CJK, arabe, symboles...).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub type FontId = u16;

#[derive(Clone, Copy, Debug, Default)]
pub struct FontMetrics {
    /// Toutes les valeurs sont exprimées en fraction de la taille du corps (em).
    pub ascent: f32,
    pub descent: f32,
    pub line_gap: f32,
    pub underline_pos: f32,
    pub underline_thickness: f32,
    pub strike_pos: f32,
    pub strike_thickness: f32,
    pub x_height: f32,
    pub cap_height: f32,
}

impl FontMetrics {
    pub fn line_height(&self) -> f32 {
        self.ascent + self.descent + self.line_gap
    }
}

enum Source {
    Static(&'static [u8], u32),
    Lazy(PathBuf, u32),
}

struct FaceEntry {
    family: String,
    #[allow(dead_code)]
    bold: bool,
    #[allow(dead_code)]
    italic: bool,
    source: Source,
    face: OnceLock<Option<ttf_parser::Face<'static>>>,
    metrics: OnceLock<FontMetrics>,
    upem: OnceLock<f32>,
}

impl FaceEntry {
    fn face(&self) -> Option<&ttf_parser::Face<'static>> {
        self.face
            .get_or_init(|| match &self.source {
                Source::Static(data, idx) => ttf_parser::Face::parse(data, *idx).ok(),
                Source::Lazy(path, idx) => {
                    let data = std::fs::read(path).ok()?;
                    let data: &'static [u8] = Box::leak(data.into_boxed_slice());
                    ttf_parser::Face::parse(data, *idx).ok()
                }
            })
            .as_ref()
    }
}

#[derive(Clone, Copy, Default)]
struct Family {
    regular: Option<FontId>,
    bold: Option<FontId>,
    italic: Option<FontId>,
    bold_italic: Option<FontId>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedFont {
    pub id: FontId,
    pub synth_bold: bool,
    pub synth_italic: bool,
}

pub struct FontDb {
    faces: Vec<FaceEntry>,
    families: HashMap<String, Family>,
    /// Polices de secours générales (dans l'ordre).
    fallbacks: Vec<FontId>,
    /// Polices de secours par plage Unicode.
    script_fallbacks: Vec<(u32, u32, Vec<FontId>)>,
    fallback_cache: Mutex<HashMap<char, Option<(FontId, u16)>>>,
    default_family: String,
}

static DB: OnceLock<FontDb> = OnceLock::new();

/// Installe la base de polices globale (à appeler une fois au démarrage).
pub fn install(db: FontDb) {
    let _ = DB.set(db);
}

/// Base de polices globale ; si rien n'a été installé, charge les polices système du PC.
pub fn db() -> &'static FontDb {
    DB.get_or_init(|| {
        let mut b = FontDbBuilder::new();
        for dir in [
            "fonts",
            "../fonts",
            "/usr/share/fonts/truetype/liberation",
            "/usr/share/fonts/truetype/crosextra",
            "/usr/share/fonts/truetype/dejavu",
        ] {
            b.add_dir(Path::new(dir));
        }
        b.add_system_fallbacks();
        b.build()
    })
}

pub struct FontDbBuilder {
    db: FontDb,
}

impl Default for FontDbBuilder {
    fn default() -> Self {
        Self::new()
    }
}

fn face_names(face: &ttf_parser::Face) -> (String, bool, bool) {
    let mut family = None;
    let mut typo_family = None;
    for name in face.names() {
        if name.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY && typo_family.is_none() {
            typo_family = name.to_string();
        }
        if name.name_id == ttf_parser::name_id::FAMILY && family.is_none() {
            family = name.to_string();
        }
    }
    let family = typo_family.or(family).unwrap_or_else(|| "Unknown".to_string());
    (family, face.is_bold(), face.is_italic() || face.is_oblique())
}

impl FontDbBuilder {
    pub fn new() -> Self {
        FontDbBuilder {
            db: FontDb {
                faces: Vec::new(),
                families: HashMap::new(),
                fallbacks: Vec::new(),
                script_fallbacks: Vec::new(),
                fallback_cache: Mutex::new(HashMap::new()),
                default_family: "liberation sans".into(),
            },
        }
    }

    /// Ajoute une police à partir d'octets (elle reste en mémoire jusqu'à la fin du programme).
    pub fn add_bytes(&mut self, data: Vec<u8>) -> Option<FontId> {
        let data: &'static [u8] = Box::leak(data.into_boxed_slice());
        self.add_static(data)
    }

    pub fn add_static(&mut self, data: &'static [u8]) -> Option<FontId> {
        let face = ttf_parser::Face::parse(data, 0).ok()?;
        let (family, bold, italic) = face_names(&face);
        let id = self.db.faces.len() as FontId;
        let key = family.to_lowercase();
        self.db.faces.push(FaceEntry {
            family,
            bold,
            italic,
            source: Source::Static(data, 0),
            face: OnceLock::from(Some(face)),
            metrics: OnceLock::new(),
            upem: OnceLock::new(),
        });
        let fam = self.db.families.entry(key).or_default();
        let slot = match (bold, italic) {
            (false, false) => &mut fam.regular,
            (true, false) => &mut fam.bold,
            (false, true) => &mut fam.italic,
            (true, true) => &mut fam.bold_italic,
        };
        if slot.is_none() {
            *slot = Some(id);
        }
        Some(id)
    }

    /// Ajoute toutes les polices .ttf/.otf d'un dossier.
    pub fn add_dir(&mut self, dir: &Path) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut files: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
        files.sort();
        for p in files {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext == "ttf" || ext == "otf" {
                if let Ok(data) = std::fs::read(&p) {
                    self.add_bytes(data);
                }
            }
        }
    }

    fn add_lazy(&mut self, path: PathBuf) -> FontId {
        if let Some(i) = self.db.faces.iter().position(|f| matches!(&f.source, Source::Lazy(p, _) if *p == path)) {
            return i as FontId;
        }
        let id = self.db.faces.len() as FontId;
        self.db.faces.push(FaceEntry {
            family: path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string(),
            bold: false,
            italic: false,
            source: Source::Lazy(path, 0),
            face: OnceLock::new(),
            metrics: OnceLock::new(),
            upem: OnceLock::new(),
        });
        id
    }

    /// Enregistre les polices système (Android : /system/fonts) comme polices de secours.
    pub fn add_system_fallbacks(&mut self) {
        let dirs = [
            "/system/fonts",
            "/product/fonts",
            "/usr/share/fonts/truetype/noto",
            "/usr/share/fonts/opentype/noto",
            "/usr/share/fonts/truetype/wqy",
            "/usr/share/fonts/truetype/dejavu",
            "/usr/share/fonts/truetype/freefont",
        ];
        let mut files: Vec<PathBuf> = Vec::new();
        for d in dirs {
            if let Ok(rd) = std::fs::read_dir(d) {
                for e in rd.flatten() {
                    let p = e.path();
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                    let lower = name.to_ascii_lowercase();
                    if !(lower.ends_with(".ttf") || lower.ends_with(".otf") || lower.ends_with(".ttc")) {
                        continue;
                    }
                    if lower.contains("emoji") {
                        continue; // polices bitmap couleur non vectorielles
                    }
                    files.push(p);
                }
            }
        }
        files.sort();
        let find = |prefixes: &[&str]| -> Vec<PathBuf> {
            let mut out = Vec::new();
            for pre in prefixes {
                let pre_l = pre.to_ascii_lowercase();
                for f in &files {
                    let n = f.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
                    let regular = !n.contains("bold") && !n.contains("italic") && !n.contains("light") && !n.contains("thin") && !n.contains("medium") && !n.contains("black");
                    if n.starts_with(&pre_l) && regular && !out.contains(f) {
                        out.push(f.clone());
                    }
                }
            }
            out
        };
        // Plages Unicode -> préfixes de fichiers de police à essayer.
        let scripts: &[(u32, u32, &[&str])] = &[
            (0x0590, 0x05FF, &["NotoSansHebrew", "NotoSerifHebrew", "FreeSans", "DejaVuSans"]),
            (0x0600, 0x06FF, &["NotoNaskhArabic", "NotoSansArabic", "FreeSerif", "DejaVuSans"]),
            (0x0750, 0x077F, &["NotoNaskhArabic", "NotoSansArabic"]),
            (0xFB50, 0xFDFF, &["NotoNaskhArabic", "NotoSansArabic"]),
            (0xFE70, 0xFEFF, &["NotoNaskhArabic", "NotoSansArabic"]),
            (0x0900, 0x097F, &["NotoSansDevanagari", "FreeSans"]),
            (0x0980, 0x09FF, &["NotoSansBengali"]),
            (0x0B80, 0x0BFF, &["NotoSansTamil"]),
            (0x0E00, 0x0E7F, &["NotoSansThai", "NotoSerifThai"]),
            (0x10A0, 0x10FF, &["NotoSansGeorgian", "DejaVuSans"]),
            (0x0530, 0x058F, &["NotoSansArmenian", "DejaVuSans"]),
            (0x1100, 0x11FF, &["NotoSansCJK", "NotoSansKR", "wqy"]),
            (0x2E80, 0x9FFF, &["NotoSansCJK", "NotoSerifCJK", "NotoSansSC", "NotoSansJP", "wqy", "DroidSansFallback"]),
            (0xAC00, 0xD7AF, &["NotoSansCJK", "NotoSansKR", "wqy"]),
            (0xF900, 0xFAFF, &["NotoSansCJK", "wqy"]),
            (0xFF00, 0xFFEF, &["NotoSansCJK", "wqy"]),
            (0x2200, 0x22FF, &["NotoSansMath", "DejaVuSans", "NotoSansSymbols"]),
            (0x2190, 0x21FF, &["DejaVuSans", "NotoSansSymbols", "NotoSansMath"]),
            (0x2300, 0x2BFF, &["DejaVuSans", "NotoSansSymbols", "NotoSansSymbols2", "FreeSerif"]),
            (0x1F000, 0x1FAFF, &["NotoSansSymbols2", "NotoSansSymbols", "DejaVuSans"]),
            (0x1D400, 0x1D7FF, &["NotoSansMath", "FreeSerif"]),
        ];
        for (lo, hi, prefixes) in scripts {
            let paths = find(prefixes);
            if paths.is_empty() {
                continue;
            }
            let ids: Vec<FontId> = paths.into_iter().map(|p| self.add_lazy(p)).collect();
            self.db.script_fallbacks.push((*lo, *hi, ids));
        }
        for p in find(&["Roboto-Regular", "DejaVuSans.ttf", "NotoSans-Regular", "NotoSansSymbols", "NotoSansSymbols2", "NotoSansMath", "FreeSans", "FreeSerif", "NotoSansCJK", "DroidSansFallback"]) {
            let id = self.add_lazy(p);
            if !self.db.fallbacks.contains(&id) {
                self.db.fallbacks.push(id);
            }
        }
    }

    pub fn build(mut self) -> FontDb {
        // Les polices embarquées « DejaVu Sans » servent de premier secours.
        let mut first = Vec::new();
        for fam in ["dejavu sans", "liberation sans", "liberation serif"] {
            if let Some(f) = self.db.families.get(fam) {
                if let Some(r) = f.regular {
                    first.push(r);
                }
            }
        }
        for id in self.db.fallbacks.drain(..).collect::<Vec<_>>() {
            if !first.contains(&id) {
                first.push(id);
            }
        }
        self.db.fallbacks = first;
        if !self.db.families.contains_key(&self.db.default_family) {
            if let Some(k) = self.db.families.keys().next() {
                self.db.default_family = k.clone();
            }
        }
        self.db
    }
}

/// Correspondances des polices courantes vers les polices embarquées.
fn alias(name: &str) -> Option<&'static str> {
    let n = name;
    let sans = "liberation sans";
    let serif = "liberation serif";
    let mono = "liberation mono";
    let carlito = "carlito";
    let caladea = "caladea";
    Some(match n {
        "calibri" | "calibri light" | "calibri (body)" | "calibri (corps)" | "candara" | "corbel" | "segoe ui light" => carlito,
        "cambria" | "cambria math" | "constantia" => caladea,
        "arial" | "helvetica" | "helvetica neue" | "arial unicode ms" | "verdana" | "tahoma" | "segoe ui" | "aptos"
        | "aptos display" | "aptos narrow" | "roboto" | "open sans" | "lato" | "noto sans" | "source sans pro"
        | "montserrat" | "century gothic" | "franklin gothic" | "franklin gothic book" | "franklin gothic medium"
        | "gill sans" | "gill sans mt" | "trebuchet ms" | "arial narrow" | "arial black" | "sans-serif" | "sans"
        | "swiss" | "ms sans serif" | "microsoft sans serif" | "lucida sans" | "lucida sans unicode" | "liberation sans narrow"
        | "arimo" | "dejavu sans condensed" | "inter" | "poppins" | "raleway" | "ubuntu" | "nunito" | "avenir"
        | "avenir next" | "futura" | "myriad pro" | "frutiger" | "univers" | "symbol" | "wingdings" | "wingdings 2"
        | "wingdings 3" | "webdings" | "opensymbol" | "starsymbol" | "ms gothic" | "ms mincho" | "simsun" | "mangal"
        | "leelawadee" | "nirmala ui" | "ebrima" | "gadugi" | "segoe ui semibold" | "segoe ui semilight" | "bahnschrift"
        | "dubai" | "selawik" | "grandview" | "seaford" | "tenorite" | "skeena" => sans,
        "times new roman" | "times" | "georgia" | "garamond" | "book antiqua" | "palatino linotype" | "palatino"
        | "century schoolbook" | "new century schoolbook" | "noto serif" | "serif" | "roman" | "bookman old style"
        | "baskerville" | "baskerville old face" | "tinos" | "dejavu serif" | "liberation serif" | "minion pro"
        | "sylfaen" | "century" | "perpetua" | "goudy old style" | "high tower text" | "californian fb"
        | "bell mt" | "calisto mt" | "rockwell" | "bodoni mt" | "didot" | "charter" | "linux libertine g"
        | "linux libertine" | "libertinus serif" | "source serif pro" | "merriweather" | "playfair display" => serif,
        "courier new" | "courier" | "consolas" | "lucida console" | "monospace" | "menlo" | "monaco" | "source code pro"
        | "cousine" | "dejavu sans mono" | "andale mono" | "fixedsys" | "modern" | "ocr a extended" | "cascadia code"
        | "cascadia mono" | "fira code" | "fira mono" | "jetbrains mono" | "ubuntu mono" | "roboto mono"
        | "noto mono" | "liberation mono" | "lucida sans typewriter" => mono,
        _ => return None,
    })
}

fn heuristic(name: &str) -> &'static str {
    if name.contains("mono") || name.contains("courier") || name.contains("code") || name.contains("consol") || name.contains("typewriter") {
        "liberation mono"
    } else if (name.contains("serif") && !name.contains("sans")) || name.contains("roman") || name.contains("times") || name.contains("garamond") || name.contains("book") || name.contains("antiqua") {
        "liberation serif"
    } else if name.contains("calibri") {
        "carlito"
    } else if name.contains("cambria") {
        "caladea"
    } else {
        "liberation sans"
    }
}

impl FontDb {
    pub fn face_count(&self) -> usize {
        self.faces.len()
    }

    pub fn family_name(&self, id: FontId) -> &str {
        &self.faces[id as usize].family
    }

    pub fn face(&self, id: FontId) -> Option<&ttf_parser::Face<'static>> {
        self.faces.get(id as usize)?.face()
    }

    pub fn units_per_em(&self, id: FontId) -> f32 {
        let e = &self.faces[id as usize];
        *e.upem.get_or_init(|| e.face().map(|f| f.units_per_em() as f32).unwrap_or(1000.0))
    }

    pub fn metrics(&self, id: FontId) -> FontMetrics {
        let e = &self.faces[id as usize];
        *e.metrics.get_or_init(|| {
            let Some(f) = e.face() else {
                return FontMetrics { ascent: 0.9, descent: 0.25, line_gap: 0.0, underline_pos: -0.1, underline_thickness: 0.05, strike_pos: 0.3, strike_thickness: 0.05, x_height: 0.5, cap_height: 0.7 };
            };
            let upem = f.units_per_em() as f32;
            let asc = f.ascender() as f32 / upem;
            let desc = -(f.descender() as f32) / upem;
            let gap = f.line_gap() as f32 / upem;
            let ul = f.underline_metrics();
            let st = f.strikeout_metrics();
            let x_height = f.x_height().map(|v| v as f32 / upem).unwrap_or(0.5);
            let cap = f.capital_height().map(|v| v as f32 / upem).unwrap_or(0.7);
            FontMetrics {
                ascent: asc,
                descent: desc,
                line_gap: gap.max(0.0),
                underline_pos: ul.map(|u| u.position as f32 / upem).unwrap_or(-0.1),
                underline_thickness: ul.map(|u| (u.thickness as f32 / upem).max(0.03)).unwrap_or(0.05),
                strike_pos: st.map(|u| u.position as f32 / upem).unwrap_or(x_height * 0.55),
                strike_thickness: st.map(|u| (u.thickness as f32 / upem).max(0.03)).unwrap_or(0.05),
                x_height,
                cap_height: cap,
            }
        })
    }

    fn family_for(&self, name: &str) -> Option<&Family> {
        let key = name.trim().trim_matches('\'').trim_matches('"').to_lowercase();
        if let Some(f) = self.families.get(&key) {
            return Some(f);
        }
        let target = alias(&key).unwrap_or_else(|| heuristic(&key));
        self.families.get(target).or_else(|| self.families.get(&self.default_family))
    }

    /// Choisit la meilleure police embarquée pour une famille et un style.
    pub fn resolve(&self, family: &str, bold: bool, italic: bool) -> ResolvedFont {
        let fam = self
            .family_for(family)
            .copied()
            .or_else(|| self.families.values().next().copied())
            .unwrap_or_default();
        let pick = |b: bool, i: bool| match (b, i) {
            (false, false) => fam.regular,
            (true, false) => fam.bold,
            (false, true) => fam.italic,
            (true, true) => fam.bold_italic,
        };
        if let Some(id) = pick(bold, italic) {
            return ResolvedFont { id, synth_bold: false, synth_italic: false };
        }
        if bold && italic {
            if let Some(id) = fam.bold {
                return ResolvedFont { id, synth_bold: false, synth_italic: true };
            }
            if let Some(id) = fam.italic {
                return ResolvedFont { id, synth_bold: true, synth_italic: false };
            }
        }
        let id = fam.regular.or(fam.bold).or(fam.italic).or(fam.bold_italic).unwrap_or(0);
        ResolvedFont { id, synth_bold: bold && fam.bold.is_none(), synth_italic: italic && fam.italic.is_none() }
    }

    /// Glyphe pour un caractère, avec recherche dans les polices de secours si nécessaire.
    pub fn glyph(&self, id: FontId, ch: char) -> (FontId, u16) {
        if let Some(face) = self.face(id) {
            if let Some(g) = face.glyph_index(ch) {
                if g.0 != 0 {
                    return (id, g.0);
                }
            }
        }
        if let Some(r) = self.fallback_cache.lock().unwrap().get(&ch) {
            return r.unwrap_or((id, 0));
        }
        let found = self.find_fallback(ch);
        self.fallback_cache.lock().unwrap().insert(ch, found);
        found.unwrap_or((id, 0))
    }

    fn find_fallback(&self, ch: char) -> Option<(FontId, u16)> {
        let cp = ch as u32;
        let try_font = |fid: FontId| -> Option<(FontId, u16)> {
            let face = self.face(fid)?;
            let g = face.glyph_index(ch)?;
            (g.0 != 0).then_some((fid, g.0))
        };
        for (lo, hi, ids) in &self.script_fallbacks {
            if cp >= *lo && cp <= *hi {
                for &fid in ids {
                    if let Some(r) = try_font(fid) {
                        return Some(r);
                    }
                }
            }
        }
        for &fid in &self.fallbacks {
            if let Some(r) = try_font(fid) {
                return Some(r);
            }
        }
        None
    }

    /// Avance horizontale d'un glyphe, en em.
    pub fn advance(&self, id: FontId, gid: u16) -> f32 {
        let Some(face) = self.face(id) else { return 0.5 };
        face.glyph_hor_advance(ttf_parser::GlyphId(gid)).unwrap_or(0) as f32 / self.units_per_em(id)
    }

    /// Largeur d'une chaîne (en points) pour une police et une taille données.
    pub fn measure(&self, font: ResolvedFont, size: f32, text: &str) -> f32 {
        let mut w = 0.0;
        for ch in text.chars() {
            let (fid, g) = self.glyph(font.id, ch);
            w += self.advance(fid, g) * size;
        }
        if font.synth_bold {
            w += size * 0.02 * text.chars().count() as f32;
        }
        w
    }
}

/// Convertit les caractères des polices de symboles (Symbol, Wingdings) en Unicode.
pub fn map_symbol_char(font: &str, ch: char) -> char {
    let f = font.to_ascii_lowercase();
    let mut c = ch as u32;
    if (0xF000..=0xF0FF).contains(&c) {
        c -= 0xF000;
    } else if !(f.contains("symbol") || f.contains("wingding") || f.contains("webding")) {
        return ch;
    }
    let mapped: u32 = if f.contains("wingdings") {
        match c {
            0x6C => 0x25CF, // ●
            0x6E => 0x25A0, // ■
            0x6F => 0x25A1, // □
            0x71 => 0x2751, // ❑
            0x75 => 0x25C6, // ◆
            0x76 => 0x2756, // ❖
            0x77 => 0x2B25,
            0xA7 => 0x25AA, // ▪
            0xA8 => 0x25FB,
            0x9F => 0x2022,
            0xD8 => 0x27A2, // ➢
            0xE0 => 0x2192,
            0xE8 => 0x2794, // ➔
            0xF0 => 0x21E8,
            0xFC => 0x2713, // ✓
            0xFB => 0x2717, // ✗
            0xFE => 0x2611, // ☑
            0x4A => 0x263A, // ☺
            0x4C => 0x2639,
            0x2A => 0x2709, // ✉
            0x28 => 0x260E, // ☎
            0x3F => 0x270D,
            0x41 => 0x270C,
            0x43 => 0x261D,
            0x46 => 0x261E,
            0xAB => 0x2605, // ★
            0xB2 => 0x2727,
            0x7A => 0x2318,
            _ => 0x2022,
        }
    } else if f.contains("symbol") {
        match c {
            0xB7 => 0x2022, // •
            0xA8 => 0x2666,
            0xA9 => 0x2665,
            0xAA => 0x2660,
            0xA7 => 0x2663,
            0xAE => 0x2192,
            0xAC => 0x2190,
            0xAD => 0x2191,
            0xAF => 0x2193,
            0xB0 => 0x00B0,
            0xB1 => 0x00B1,
            0xB4 => 0x00D7,
            0xB8 => 0x00F7,
            0xA3 => 0x2264,
            0xB3 => 0x2265,
            0xB9 => 0x2260,
            0xBB => 0x2248,
            0xA5 => 0x221E,
            0xD6 => 0x221A,
            0xE5 => 0x2211,
            0xF2 => 0x222B,
            0x2D => 0x2212,
            0x61 => 0x03B1,
            0x62 => 0x03B2,
            0x63 => 0x03C7,
            0x64 => 0x03B4,
            0x65 => 0x03B5,
            0x66 => 0x03C6,
            0x67 => 0x03B3,
            0x68 => 0x03B7,
            0x69 => 0x03B9,
            0x6B => 0x03BA,
            0x6C => 0x03BB,
            0x6D => 0x03BC,
            0x6E => 0x03BD,
            0x6F => 0x03BF,
            0x70 => 0x03C0,
            0x71 => 0x03B8,
            0x72 => 0x03C1,
            0x73 => 0x03C3,
            0x74 => 0x03C4,
            0x75 => 0x03C5,
            0x77 => 0x03C9,
            0x78 => 0x03BE,
            0x79 => 0x03C8,
            0x7A => 0x03B6,
            0x44 => 0x0394,
            0x46 => 0x03A6,
            0x47 => 0x0393,
            0x4C => 0x039B,
            0x50 => 0x03A0,
            0x51 => 0x0398,
            0x53 => 0x03A3,
            0x57 => 0x03A9,
            0x20..=0x7E => c,
            _ => 0x2022,
        }
    } else {
        0x2022
    };
    char::from_u32(mapped).unwrap_or('•')
}
