//! Ouverture d'un document : détection du format et conversion vers des pages.

use crate::display::Page;
use crate::package::Package;
use crate::sheet::Workbook;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocKind {
    Text,
    Spreadsheet,
    Presentation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Docx,
    Odt,
    Doc,
    Rtf,
    Xlsx,
    Xlsb,
    Ods,
    Xls,
    Csv,
    Pptx,
    Odp,
    Ppt,
}

impl Format {
    pub fn kind(self) -> DocKind {
        match self {
            Format::Docx | Format::Odt | Format::Doc | Format::Rtf => DocKind::Text,
            Format::Xlsx | Format::Xlsb | Format::Ods | Format::Xls | Format::Csv => DocKind::Spreadsheet,
            Format::Pptx | Format::Odp | Format::Ppt => DocKind::Presentation,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Format::Docx => "Word",
            Format::Odt => "OpenDocument Texte",
            Format::Doc => "Word 97-2003",
            Format::Rtf => "RTF",
            Format::Xlsx => "Excel",
            Format::Xlsb => "Excel binaire",
            Format::Ods => "OpenDocument Classeur",
            Format::Xls => "Excel 97-2003",
            Format::Csv => "CSV",
            Format::Pptx => "PowerPoint",
            Format::Odp => "OpenDocument Présentation",
            Format::Ppt => "PowerPoint 97-2003",
        }
    }
}

pub struct Document {
    pub format: Format,
    pub pages: Vec<Page>,
    pub workbook: Option<Workbook>,
}

impl Document {
    pub fn kind(&self) -> DocKind {
        self.format.kind()
    }
}

fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

/// Détermine le format à partir du contenu (et du nom en dernier recours).
pub fn detect(data: &[u8], name: &str) -> Result<Format, String> {
    let ext = ext_of(name);
    if data.starts_with(b"PK") {
        let pkg = Package::open(data.to_vec())?;
        if let Some(m) = pkg.read("mimetype") {
            let m = String::from_utf8_lossy(&m).trim().to_string();
            if m.contains("opendocument.text") {
                return Ok(Format::Odt);
            }
            if m.contains("opendocument.spreadsheet") {
                return Ok(Format::Ods);
            }
            if m.contains("opendocument.presentation") || m.contains("opendocument.graphics") {
                return Ok(Format::Odp);
            }
        }
        let names = pkg.names();
        let has = |p: &str| names.iter().any(|n| n.eq_ignore_ascii_case(p));
        if has("word/document.xml") || names.iter().any(|n| n.starts_with("word/")) {
            return Ok(Format::Docx);
        }
        if has("xl/workbook.bin") {
            return Ok(Format::Xlsb);
        }
        if names.iter().any(|n| n.starts_with("xl/")) {
            return Ok(Format::Xlsx);
        }
        if names.iter().any(|n| n.starts_with("ppt/")) {
            return Ok(Format::Pptx);
        }
        if has("content.xml") {
            let c = pkg.read_string("content.xml").unwrap_or_default();
            if c.contains("<office:text") {
                return Ok(Format::Odt);
            }
            if c.contains("<office:spreadsheet") {
                return Ok(Format::Ods);
            }
            if c.contains("<office:presentation") || c.contains("<office:drawing") {
                return Ok(Format::Odp);
            }
        }
        return Err("Archive ZIP non reconnue comme document bureautique.".into());
    }
    if data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        let comp = cfb::CompoundFile::open(std::io::Cursor::new(data)).map_err(|e| format!("Le fichier est endommagé ou incomplet (conteneur Office illisible : {e})."))?;
        let has = |n: &str| comp.exists(n);
        if has("/EncryptedPackage") || has("/EncryptionInfo") {
            return Err("Ce document est protégé par un mot de passe.".into());
        }
        if has("/WordDocument") {
            return Ok(Format::Doc);
        }
        if has("/Workbook") || has("/Book") {
            return Ok(Format::Xls);
        }
        if has("/PowerPoint Document") {
            return Ok(Format::Ppt);
        }
        return Err("Fichier Office 97-2003 non reconnu.".into());
    }
    let head = &data[..data.len().min(16)];
    if head.starts_with(b"{\\rtf") {
        return Ok(Format::Rtf);
    }
    match ext.as_str() {
        "csv" | "tsv" | "txt" | "tab" => Ok(Format::Csv),
        _ => Err("Format de fichier non pris en charge.".into()),
    }
}

/// Ouvre un document et le met en page.
pub fn open(data: Vec<u8>, name: &str) -> Result<Document, String> {
    let format = detect(&data, name)?;
    let mut doc = Document { format, pages: Vec::new(), workbook: None };
    match format {
        Format::Docx => {
            let pkg = Package::open(data)?;
            let flow = crate::ooxml::docx::load(&pkg)?;
            doc.pages = crate::flow::paginate(&flow);
        }
        Format::Xlsx => {
            let pkg = Package::open(data)?;
            doc.workbook = Some(crate::ooxml::xlsx::load(&pkg)?);
        }
        Format::Pptx => {
            let pkg = Package::open(data)?;
            doc.pages = crate::ooxml::pptx::load(&pkg)?;
        }
        Format::Odt => {
            let pkg = Package::open(data)?;
            let flow = crate::odf::odt::load(&pkg)?;
            doc.pages = crate::flow::paginate(&flow);
        }
        Format::Ods => {
            let pkg = Package::open(data)?;
            doc.workbook = Some(crate::odf::ods::load(&pkg)?);
        }
        Format::Odp => {
            let pkg = Package::open(data)?;
            doc.pages = crate::odf::odp::load(&pkg)?;
        }
        Format::Doc => {
            let flow = crate::legacy::doc::load(&data)?;
            doc.pages = crate::flow::paginate(&flow);
        }
        Format::Rtf => {
            let flow = crate::legacy::rtf::load(&data)?;
            doc.pages = crate::flow::paginate(&flow);
        }
        Format::Ppt => {
            doc.pages = crate::legacy::ppt::load(&data)?;
        }
        Format::Xls => {
            doc.workbook = Some(crate::legacy::xls::load(&data)?);
        }
        Format::Csv => {
            doc.workbook = Some(crate::legacy::csv::load(&data, name)?);
        }
        Format::Xlsb => {
            doc.workbook = Some(crate::legacy::xlsb_via_calamine(&data)?);
        }
    }
    if doc.pages.is_empty() && doc.workbook.is_none() {
        return Err("Le document est vide.".into());
    }
    Ok(doc)
}
