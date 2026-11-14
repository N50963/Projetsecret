//! Fichiers CSV / TSV (séparateur et encodage détectés automatiquement).

use crate::sheet::*;
use std::sync::Arc;

fn decode(data: &[u8]) -> String {
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&data[3..]).into_owned();
    }
    if data.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode(data).0.into_owned();
    }
    if data.starts_with(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE.decode(data).0.into_owned();
    }
    match std::str::from_utf8(data) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(data).0.into_owned(),
    }
}

fn split_records(text: &str, sep: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            c if c == sep => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

pub fn load(data: &[u8], name: &str) -> Result<Workbook, String> {
    let text = decode(data);
    let sample: String = text.lines().take(20).collect::<Vec<_>>().join("\n");
    let sep = [';', ',', '\t', '|'].into_iter().max_by_key(|s| sample.matches(*s).count()).unwrap_or(',');
    let sep = if name.to_ascii_lowercase().ends_with(".tsv") { '\t' } else { sep };
    let rows = split_records(&text, sep);
    let styles = Arc::new(vec![CellStyle { font: Arc::new(crate::text::TextStyle { font: Arc::from("Liberation Sans"), size: 10.0, ..Default::default() }), ..Default::default() }]);
    let title = std::path::Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("CSV").to_string();
    let mut b = SheetBuilder::new(&title, styles);
    b.default_col_width = 72.0;
    b.default_row_height = 13.0;
    let mut widths: Vec<usize> = Vec::new();
    for (r, row) in rows.iter().enumerate().take(1_000_000) {
        for (c, f) in row.iter().enumerate().take(16384) {
            if f.is_empty() {
                continue;
            }
            let numeric = f.trim().replace(['\u{a0}', ' '], "").replace(',', ".").parse::<f64>().is_ok() && sep != ',' || f.trim().parse::<f64>().is_ok();
            if widths.len() <= c {
                widths.resize(c + 1, 0);
            }
            widths[c] = widths[c].max(f.chars().count());
            b.cells.push((r as u32, Cell { col: c as u32, text: f.clone(), kind: if numeric { CellKind::Number } else { CellKind::Text }, ..Default::default() }));
        }
    }
    for (c, w) in widths.iter().enumerate() {
        let pt = (*w as f32 * 5.6 + 8.0).clamp(40.0, 300.0);
        b.col_widths.push((c as u32, c as u32, pt, false));
    }
    Ok(Workbook { sheets: vec![b.build()] })
}
