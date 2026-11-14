//! Accès aux paquets ZIP (OOXML, ODF), relations OPC et décodage d'images.

use crate::display::RasterImage;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::{Arc, Mutex};

pub struct Package {
    zip: Mutex<zip::ZipArchive<Cursor<Vec<u8>>>>,
    names: Vec<String>,
    images: Mutex<HashMap<String, Option<Arc<RasterImage>>>>,
}

impl Package {
    pub fn open(data: Vec<u8>) -> Result<Package, String> {
        let zip = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("Archive invalide : {e}"))?;
        let names = zip.file_names().filter_map(|s| s.ok().map(|s| s.to_string())).collect();
        Ok(Package { zip: Mutex::new(zip), names, images: Mutex::new(HashMap::new()) })
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn has(&self, name: &str) -> bool {
        self.find(name).is_some()
    }

    fn find(&self, name: &str) -> Option<String> {
        let n = name.trim_start_matches('/');
        if self.names.iter().any(|x| x == n) {
            return Some(n.to_string());
        }
        // les noms de parties OPC sont insensibles à la casse
        let lower = n.to_ascii_lowercase();
        self.names.iter().find(|x| x.to_ascii_lowercase() == lower).cloned()
    }

    pub fn read(&self, name: &str) -> Option<Vec<u8>> {
        let real = self.find(name)?;
        let mut zip = self.zip.lock().ok()?;
        let mut f = zip.by_name(&real).ok()?;
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    pub fn read_string(&self, name: &str) -> Option<String> {
        let data = self.read(name)?;
        Some(decode_xml_text(data))
    }

    /// Image décodée (mise en cache) ; `None` si le format n'est pas pris en charge.
    pub fn image(&self, name: &str) -> Option<Arc<RasterImage>> {
        let key = name.trim_start_matches('/').to_string();
        if let Some(v) = self.images.lock().unwrap().get(&key) {
            return v.clone();
        }
        let img = self.read(&key).and_then(|d| decode_image(&d));
        self.images.lock().unwrap().insert(key, img.clone());
        img
    }

    /// Relations OPC d'une partie : identifiant -> (cible résolue, type, externe).
    pub fn rels(&self, part: &str) -> HashMap<String, Rel> {
        let part = part.trim_start_matches('/');
        let (dir, file) = match part.rfind('/') {
            Some(i) => (&part[..i], &part[i + 1..]),
            None => ("", part),
        };
        let rels_name = if dir.is_empty() { format!("_rels/{file}.rels") } else { format!("{dir}/_rels/{file}.rels") };
        let mut out = HashMap::new();
        let Some(xml) = self.read_string(&rels_name) else { return out };
        let Ok(doc) = roxmltree::Document::parse(&xml) else { return out };
        for r in doc.root_element().children().filter(|n| n.is_element()) {
            let id = r.attribute("Id").unwrap_or("").to_string();
            let target = r.attribute("Target").unwrap_or("");
            let ty = r.attribute("Type").unwrap_or("");
            let external = r.attribute("TargetMode") == Some("External");
            let resolved = if external { target.to_string() } else { resolve_path(dir, target) };
            let short_type = ty.rsplit('/').next().unwrap_or("").to_string();
            out.insert(id, Rel { target: resolved, kind: short_type, external });
        }
        out
    }
}

#[derive(Clone, Debug)]
pub struct Rel {
    pub target: String,
    pub kind: String,
    pub external: bool,
}

/// Résout un chemin relatif OPC (« ../media/image1.png ») par rapport à un dossier.
pub fn resolve_path(dir: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for seg in target.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Décodage XML tolérant (UTF-8 avec BOM, UTF-16).
pub fn decode_xml_text(data: Vec<u8>) -> String {
    if data.starts_with(&[0xFF, 0xFE]) || data.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = if data[0] == 0xFF { encoding_rs::UTF_16LE.decode(&data) } else { encoding_rs::UTF_16BE.decode(&data) };
        return cow.trim_start_matches('\u{feff}').to_string();
    }
    let s = match String::from_utf8(data) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    let s = s.trim_start_matches('\u{feff}');
    // roxmltree refuse les DTD : on les retire si présentes
    if let Some(i) = s.find("<!DOCTYPE") {
        if let Some(j) = s[i..].find('>') {
            let mut out = String::with_capacity(s.len());
            out.push_str(&s[..i]);
            out.push_str(&s[i + j + 1..]);
            return out;
        }
    }
    s.to_string()
}

pub fn parse_xml(text: &str) -> Option<roxmltree::Document<'_>> {
    roxmltree::Document::parse_with_options(text, roxmltree::ParsingOptions { allow_dtd: true, nodes_limit: u32::MAX, ..Default::default() })
        .map_err(|e| log::warn!("XML invalide : {e}"))
        .ok()
}

const MAX_IMAGE_DIM: u32 = 2600;

pub fn decode_image(data: &[u8]) -> Option<Arc<RasterImage>> {
    let img = image::load_from_memory(data).ok()?;
    let mut rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    if w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM {
        let s = MAX_IMAGE_DIM as f32 / w.max(h) as f32;
        let nw = ((w as f32 * s) as u32).max(1);
        let nh = ((h as f32 * s) as u32).max(1);
        rgba = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle);
    }
    let (w, h) = rgba.dimensions();
    let mut data = rgba.into_raw();
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u16;
        if a < 255 {
            px[0] = ((px[0] as u16 * a + 127) / 255) as u8;
            px[1] = ((px[1] as u16 * a + 127) / 255) as u8;
            px[2] = ((px[2] as u16 * a + 127) / 255) as u8;
        }
    }
    let pm = tiny_skia::Pixmap::from_vec(data, tiny_skia::IntSize::from_wh(w, h)?)?;
    Some(Arc::new(RasterImage::new(pm)))
}

/// Raccourcis de navigation XML (par nom local, sans tenir compte de l'espace de noms).
pub trait NodeExt<'a, 'input> {
    fn child(&self, name: &str) -> Option<roxmltree::Node<'a, 'input>>;
    fn children_named<'s>(&'s self, name: &'s str) -> Box<dyn Iterator<Item = roxmltree::Node<'a, 'input>> + 's>;
    fn attr(&self, name: &str) -> Option<&'a str>;
    fn path(&self, names: &[&str]) -> Option<roxmltree::Node<'a, 'input>>;
    fn descendant(&self, name: &str) -> Option<roxmltree::Node<'a, 'input>>;
    fn local(&self) -> &str;
    /// Attribut de relation « r:id » (préfixé par un espace de noms).
    fn rid(&self) -> Option<&'a str>;
}

impl<'a, 'input: 'a> NodeExt<'a, 'input> for roxmltree::Node<'a, 'input> {
    fn child(&self, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
        self.children().find(|c| c.is_element() && c.tag_name().name() == name)
    }
    fn children_named<'s>(&'s self, name: &'s str) -> Box<dyn Iterator<Item = roxmltree::Node<'a, 'input>> + 's> {
        Box::new(self.children().filter(move |c| c.is_element() && c.tag_name().name() == name))
    }
    /// Attribut par nom local (ignore le préfixe d'espace de noms).
    fn attr(&self, name: &str) -> Option<&'a str> {
        self.attributes().find(|a| a.name() == name).map(|a| a.value())
    }
    fn path(&self, names: &[&str]) -> Option<roxmltree::Node<'a, 'input>> {
        let mut n = *self;
        for name in names {
            n = n.child(name)?;
        }
        Some(n)
    }
    fn descendant(&self, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
        self.descendants().find(|c| c.is_element() && c.tag_name().name() == name)
    }
    fn local(&self) -> &str {
        self.tag_name().name()
    }
    fn rid(&self) -> Option<&'a str> {
        self.attributes().find(|a| a.name() == "id" && a.namespace().is_some()).map(|a| a.value())
    }
}

pub fn parse_f32(s: Option<&str>) -> Option<f32> {
    s.and_then(|v| v.trim().parse::<f32>().ok())
}

pub fn parse_bool(s: Option<&str>, default: bool) -> bool {
    match s {
        None => default,
        Some(v) => !matches!(v.trim(), "0" | "false" | "off" | "none"),
    }
}

/// Longueur ODF/CSS (« 2.5cm », « 12pt », « 0.5in », « 10mm », « 96px »...) en points.
pub fn parse_length(s: &str) -> Option<f32> {
    let s = s.trim();
    let idx = s.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')).unwrap_or(s.len());
    let (num, unit) = s.split_at(idx);
    // « e » final appartient éventuellement à l'unité « em »
    let (num, unit) = if num.ends_with('e') || num.ends_with('E') { (&num[..num.len() - 1], &s[idx - 1..]) } else { (num, unit) };
    let v: f32 = num.parse().ok()?;
    Some(match unit.trim() {
        "pt" | "" => v,
        "cm" => v * 72.0 / 2.54,
        "mm" => v * 72.0 / 25.4,
        "in" | "inch" => v * 72.0,
        "pc" => v * 12.0,
        "px" => v * 0.75,
        "em" => v * 12.0,
        "twip" => v / 20.0,
        _ => v,
    })
}
