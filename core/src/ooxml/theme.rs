//! Thème Office (couleurs, polices, styles de remplissage) partagé par DOCX, XLSX et PPTX.

use crate::color::Color;
use crate::package::{parse_xml, NodeExt, Package};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Theme {
    pub colors: HashMap<String, Color>,
    pub major_font: String,
    pub minor_font: String,
    /// XML brut des listes de styles (fillStyleLst, lnStyleLst, bgFillStyleLst)
    pub fill_styles: Vec<String>,
    pub line_styles: Vec<String>,
    pub bg_fill_styles: Vec<String>,
}

impl Default for Theme {
    fn default() -> Self {
        let mut colors = HashMap::new();
        for (k, v) in [
            ("dk1", "000000"),
            ("lt1", "FFFFFF"),
            ("dk2", "44546A"),
            ("lt2", "E7E6E6"),
            ("accent1", "4472C4"),
            ("accent2", "ED7D31"),
            ("accent3", "A5A5A5"),
            ("accent4", "FFC000"),
            ("accent5", "5B9BD5"),
            ("accent6", "70AD47"),
            ("hlink", "0563C1"),
            ("folHlink", "954F72"),
        ] {
            colors.insert(k.to_string(), Color::from_hex(v).unwrap());
        }
        Theme { colors, major_font: "Calibri Light".into(), minor_font: "Calibri".into(), fill_styles: Vec::new(), line_styles: Vec::new(), bg_fill_styles: Vec::new() }
    }
}

impl Theme {
    pub fn load(pkg: &Package, path: &str) -> Theme {
        let mut t = Theme::default();
        let Some(xml) = pkg.read_string(path) else { return t };
        let Some(doc) = parse_xml(&xml) else { return t };
        let root = doc.root_element();
        if let Some(scheme) = root.descendant("clrScheme") {
            for c in scheme.children().filter(|c| c.is_element()) {
                let name = c.local().to_string();
                if let Some(v) = c.children().find(|x| x.is_element()) {
                    let col = match v.local() {
                        "srgbClr" => v.attr("val").and_then(Color::from_hex),
                        "sysClr" => v.attr("lastClr").and_then(Color::from_hex).or_else(|| match v.attr("val") {
                            Some("windowText") => Some(Color::BLACK),
                            Some("window") => Some(Color::WHITE),
                            _ => None,
                        }),
                        _ => None,
                    };
                    if let Some(col) = col {
                        t.colors.insert(name, col);
                    }
                }
            }
        }
        if let Some(fs) = root.descendant("fontScheme") {
            if let Some(f) = fs.child("majorFont").and_then(|m| m.child("latin")).and_then(|l| l.attr("typeface")) {
                if !f.is_empty() {
                    t.major_font = f.to_string();
                }
            }
            if let Some(f) = fs.child("minorFont").and_then(|m| m.child("latin")).and_then(|l| l.attr("typeface")) {
                if !f.is_empty() {
                    t.minor_font = f.to_string();
                }
            }
        }
        if let Some(fmt) = root.descendant("fmtScheme") {
            let grab = |name: &str| -> Vec<String> {
                fmt.child(name)
                    .map(|l| l.children().filter(|c| c.is_element()).map(|c| xml[c.range()].to_string()).collect())
                    .unwrap_or_default()
            };
            t.fill_styles = grab("fillStyleLst");
            t.line_styles = grab("lnStyleLst");
            t.bg_fill_styles = grab("bgFillStyleLst");
        }
        t
    }

    pub fn color(&self, name: &str) -> Option<Color> {
        let key = match name {
            "bg1" | "background1" => "lt1",
            "tx1" | "text1" => "dk1",
            "bg2" | "background2" => "lt2",
            "tx2" | "text2" => "dk2",
            "dark1" => "dk1",
            "light1" => "lt1",
            "dark2" => "dk2",
            "light2" => "lt2",
            "hyperlink" => "hlink",
            "followedHyperlink" => "folHlink",
            other => other,
        };
        self.colors.get(key).copied()
    }

    /// Police de thème : « +mj-lt », « majorHAnsi », « minorAscii »...
    pub fn font(&self, name: &str) -> Option<&str> {
        let n = name.to_ascii_lowercase();
        if n.starts_with("+mj") || n.starts_with("major") {
            Some(&self.major_font)
        } else if n.starts_with("+mn") || n.starts_with("minor") {
            Some(&self.minor_font)
        } else {
            None
        }
    }
}
