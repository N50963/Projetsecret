//! Formats binaires Office 97-2003 et formats texte (CSV, RTF).
pub mod csv;
pub mod doc;
pub mod xls;

/// Lit un flux d'un fichier composé OLE.
pub fn read_stream(data: &[u8], name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut comp = cfb::CompoundFile::open(std::io::Cursor::new(data)).ok()?;
    let mut s = comp.open_stream(name).ok()?;
    let mut out = Vec::new();
    s.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Classeurs binaires Excel 2007+ (.xlsb) : valeurs lues avec calamine.
pub fn xlsb_via_calamine(data: &[u8]) -> Result<crate::sheet::Workbook, String> {
    use calamine::{Data, Reader};
    use crate::sheet::*;
    let mut wb = calamine::Xlsb::new(std::io::Cursor::new(data.to_vec())).map_err(|e| format!("Classeur .xlsb invalide : {e}"))?;
    let styles = std::sync::Arc::new(vec![CellStyle::default()]);
    let mut sheets = Vec::new();
    for name in wb.sheet_names().to_vec() {
        let Ok(range) = wb.worksheet_range(&name) else { continue };
        let mut b = SheetBuilder::new(&name, styles.clone());
        let (r0, c0) = range.start().unwrap_or((0, 0));
        for (r, c, v) in range.used_cells() {
            let (text, kind) = match v {
                Data::Int(i) => (i.to_string(), CellKind::Number),
                Data::Float(f) => (crate::numfmt::general(*f), CellKind::Number),
                Data::String(s) => (s.clone(), CellKind::Text),
                Data::Bool(x) => (crate::ooxml::xlsx::bool_text(*x), CellKind::Bool),
                Data::DateTime(d) => (crate::numfmt::format_value(d.as_f64(), "dd/mm/yyyy", false).0, CellKind::Number),
                Data::DateTimeIso(s) | Data::DurationIso(s) => (s.clone(), CellKind::Text),
                Data::Error(e) => (format!("{e}"), CellKind::Error),
                Data::Empty => continue,
            };
            b.cells.push(((r as u32) + r0, Cell { col: (c as u32) + c0, text, kind, ..Default::default() }));
        }
        sheets.push(b.build());
    }
    if sheets.is_empty() {
        return Err("Classeur vide.".into());
    }
    Ok(Workbook { sheets })
}
