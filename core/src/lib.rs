//! Moteur de lecture de documents bureautiques (Microsoft Office et OpenDocument).

pub mod color;
pub mod display;
pub mod flow;
pub mod fonts;
pub mod legacy;
pub mod formula;
pub mod ooxml;
pub mod numfmt;
pub mod odf;
pub mod package;
pub mod render;
pub mod text;
pub mod document;
pub mod sheet;

pub use document::{detect, open, DocKind, Document, Format};
