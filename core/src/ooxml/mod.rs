//! Formats Office Open XML (Word, Excel, PowerPoint).
pub mod chart;
pub mod docx;
pub mod drawingml;
pub mod pptx;
pub mod theme;
pub mod xlsx;

/// Twips (1/20 de point) -> points.
pub fn twips(v: Option<&str>) -> Option<f32> {
    v.and_then(|s| s.trim().parse::<f32>().ok()).map(|x| x / 20.0)
}
