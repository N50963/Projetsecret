//! Application : écran d'accueil (documents récents), chargement et visionneuse.

use crate::platform::Platform;
use crate::viewer::{FitMode, TilePool, Viewer};
use bureau_core::{DocKind, Document};
use eframe::egui::{self, Align, Color32, CornerRadius, Layout, Margin, RichText, Vec2};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;

const ACCENT: Color32 = Color32::from_rgb(30, 90, 168);

#[derive(Clone)]
struct Recent {
    uri: String,
    name: String,
    kind: String,
    time: u64,
}

struct Recents {
    path: Option<PathBuf>,
    items: Vec<Recent>,
}

impl Recents {
    fn load(dir: Option<PathBuf>) -> Recents {
        let path = dir.map(|d| d.join("recents.tsv"));
        let mut items = Vec::new();
        if let Some(p) = &path {
            if let Ok(s) = std::fs::read_to_string(p) {
                for line in s.lines() {
                    let f: Vec<&str> = line.split('\t').collect();
                    if f.len() >= 4 {
                        items.push(Recent { uri: f[0].into(), name: f[1].into(), kind: f[2].into(), time: f[3].parse().unwrap_or(0) });
                    }
                }
            }
        }
        Recents { path, items }
    }
    fn save(&self) {
        if let Some(p) = &self.path {
            let s: String = self.items.iter().map(|r| format!("{}\t{}\t{}\t{}\n", r.uri, r.name.replace('\t', " "), r.kind, r.time)).collect();
            let _ = std::fs::write(p, s);
        }
    }
    fn add(&mut self, uri: &str, name: &str, kind: &str) {
        self.items.retain(|r| r.uri != uri);
        let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.items.insert(0, Recent { uri: uri.into(), name: name.into(), kind: kind.into(), time });
        self.items.truncate(30);
        self.save();
    }
    fn remove(&mut self, uri: &str) {
        self.items.retain(|r| r.uri != uri);
        self.save();
    }
}

type LoadResult = Result<(Document, String, String), (String, String)>;

enum Screen {
    Home,
    Loading { name: String, rx: Receiver<LoadResult>, started: f64 },
    View(Box<Viewer>),
}

pub struct LecteurApp {
    platform: Arc<dyn Platform>,
    screen: Screen,
    recents: Recents,
    error: Option<String>,
    pool: Arc<TilePool>,
    insets: [f32; 4],
    frame: u64,
}

fn kind_label(k: DocKind) -> &'static str {
    match k {
        DocKind::Text => "texte",
        DocKind::Spreadsheet => "tableur",
        DocKind::Presentation => "présentation",
    }
}

fn badge(kind: &str) -> (&'static str, Color32) {
    match kind {
        "tableur" => ("X", Color32::from_rgb(30, 123, 69)),
        "présentation" => ("P", Color32::from_rgb(196, 71, 30)),
        _ => ("W", Color32::from_rgb(30, 90, 168)),
    }
}

pub fn setup_style(ctx: &egui::Context, ui_fonts: crate::UiFonts) {
    let mut fonts = egui::FontDefinitions::default();
    let (main, symbols) = ui_fonts;
    if let Some(bytes) = symbols {
        fonts.font_data.insert("symboles".into(), Arc::new(egui::FontData::from_owned(bytes)));
        for fam in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            if let Some(f) = fonts.families.get_mut(&fam) {
                f.insert(0, "symboles".into());
            }
        }
    }
    if let Some(bytes) = main {
        fonts.font_data.insert("ui".into(), Arc::new(egui::FontData::from_owned(bytes)));
        if let Some(f) = fonts.families.get_mut(&egui::FontFamily::Proportional) {
            f.insert(0, "ui".into());
        }
    }
    ctx.set_fonts(fonts);
    ctx.set_visuals(egui::Visuals::light());
    ctx.global_style_mut(|style| {
        use egui::{FontId, TextStyle};
        style.text_styles.insert(TextStyle::Body, FontId::proportional(17.0));
        style.text_styles.insert(TextStyle::Button, FontId::proportional(17.0));
        style.text_styles.insert(TextStyle::Heading, FontId::proportional(26.0));
        style.text_styles.insert(TextStyle::Small, FontId::proportional(13.5));
        style.text_styles.insert(TextStyle::Monospace, FontId::monospace(15.0));
        style.spacing.interact_size = Vec2::new(44.0, 40.0);
        style.spacing.button_padding = Vec2::new(12.0, 8.0);
        style.spacing.item_spacing = Vec2::new(10.0, 8.0);
        style.visuals.widgets.inactive.corner_radius = CornerRadius::same(10);
        style.visuals.widgets.hovered.corner_radius = CornerRadius::same(10);
        style.visuals.widgets.active.corner_radius = CornerRadius::same(10);
        style.visuals.selection.bg_fill = ACCENT;
        style.scroll_animation = egui::style::ScrollAnimation::none();
    });
}

impl LecteurApp {
    pub fn new(ctx: &egui::Context, platform: Arc<dyn Platform>) -> LecteurApp {
        let en = platform.locale().to_ascii_lowercase().starts_with("en");
        bureau_core::numfmt::set_english_locale(en);
        let recents = Recents::load(platform.data_dir());
        LecteurApp { pool: TilePool::new(ctx.clone()), platform, screen: Screen::Home, recents, error: None, insets: [0.0; 4], frame: 0 }
    }

    fn open_uri(&mut self, ctx: &egui::Context, uri: String) {
        let (tx, rx) = channel();
        let platform = self.platform.clone();
        let ctx2 = ctx.clone();
        let u = uri.clone();
        let name_guess = uri.rsplit('/').next().unwrap_or("document").to_string();
        std::thread::Builder::new()
            .name("chargement".into())
            .stack_size(32 * 1024 * 1024)
            .spawn(move || {
                let res = match platform.read(&u) {
                    Ok((name, data)) => {
                        let n2 = name.clone();
                        match std::panic::catch_unwind(move || bureau_core::open(data, &n2)) {
                            Ok(Ok(doc)) => Ok((doc, name, u)),
                            Ok(Err(e)) => Err((e, u)),
                            Err(_) => Err(("Erreur interne pendant la lecture du document.".to_string(), u)),
                        }
                    }
                    Err(e) => Err((e, u)),
                };
                let _ = tx.send(res);
                ctx2.request_repaint();
            })
            .ok();
        self.screen = Screen::Loading { name: name_guess, rx, started: ctx.input(|i| i.time) };
    }

    fn insets_dp(&self, ctx: &egui::Context) -> [f32; 4] {
        let ppp = ctx.pixels_per_point();
        [self.insets[0] / ppp, self.insets[1] / ppp, self.insets[2] / ppp, self.insets[3] / ppp]
    }

    fn back(&mut self) {
        match self.screen {
            Screen::View(_) | Screen::Loading { .. } => self.screen = Screen::Home,
            Screen::Home => self.platform.exit(),
        }
    }

    fn home_ui(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let ins = self.insets_dp(ctx);
        let mut open_request: Option<String> = None;
        let mut remove: Option<String> = None;
        egui::CentralPanel::no_frame().frame(egui::Frame::new().fill(Color32::from_rgb(246, 247, 249)).inner_margin(Margin { left: (ins[0] + 18.0) as i8, right: (ins[2] + 18.0) as i8, top: (ins[1] + 14.0).min(120.0) as i8, bottom: (ins[3] + 10.0).min(120.0) as i8 })).show(ui, |ui| {
            let wide = ui.available_width() > 700.0;
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(46.0), egui::Sense::hover());
                draw_logo(ui.painter(), r);
                ui.vertical(|ui| {
                    ui.label(RichText::new("Lecteur Office").size(26.0).strong().color(Color32::from_rgb(25, 30, 40)));
                    ui.label(RichText::new("Word · Excel · PowerPoint · OpenDocument").size(14.5).color(Color32::from_gray(110)));
                });
            });
            ui.add_space(16.0);
            let btn_w = if wide { 360.0 } else { ui.available_width() };
            if self.platform.has_picker() {
                let b = egui::Button::new(RichText::new("+   Ouvrir un document").size(19.0).color(Color32::WHITE)).fill(ACCENT).corner_radius(14.0).min_size(Vec2::new(btn_w, 56.0));
                if ui.add(b).clicked() && !self.platform.open_picker() {
                    self.error = Some("Le sélecteur de fichiers n'est pas disponible.".into());
                }
            } else {
                ui.label(RichText::new("Glissez un fichier dans la fenêtre ou passez-le en argument.").color(Color32::from_gray(90)));
            }
            ui.add_space(18.0);
            ui.label(RichText::new("Documents récents").size(18.0).strong().color(Color32::from_rgb(40, 45, 55)));
            ui.add_space(4.0);
            if self.recents.items.is_empty() {
                ui.add_space(10.0);
                ui.label(RichText::new("Aucun document ouvert récemment.\n\nAstuce : dans « Mes fichiers », Gmail ou Drive, touchez un document puis « Ouvrir avec » puis « Lecteur Office ».").color(Color32::from_gray(110)));
            }
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                let items = self.recents.items.clone();
                let cols = if wide { 2 } else { 1 };
                let w = (ui.available_width() - (cols as f32 - 1.0) * 10.0) / cols as f32;
                for chunk in items.chunks(cols) {
                    ui.horizontal(|ui| {
                        for r in chunk {
                            let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 62.0), egui::Sense::click());
                            let p = ui.painter();
                            p.rect_filled(rect, 12.0, if resp.is_pointer_button_down_on() { Color32::from_rgb(228, 233, 242) } else { Color32::WHITE });
                            p.rect_stroke(rect, 12.0, egui::Stroke::new(1.0, Color32::from_rgb(226, 229, 234)), egui::StrokeKind::Inside);
                            let (letter, col) = badge(&r.kind);
                            let br = egui::Rect::from_center_size(egui::pos2(rect.min.x + 30.0, rect.center().y), Vec2::splat(34.0));
                            p.rect_filled(br, 8.0, col);
                            p.text(br.center(), egui::Align2::CENTER_CENTER, letter, egui::FontId::proportional(18.0), Color32::WHITE);
                            let text_rect = egui::Rect::from_min_max(egui::pos2(rect.min.x + 58.0, rect.min.y), egui::pos2(rect.max.x - 44.0, rect.max.y));
                            let tp = p.with_clip_rect(text_rect);
                            tp.text(egui::pos2(text_rect.min.x, rect.min.y + 20.0), egui::Align2::LEFT_CENTER, &r.name, egui::FontId::proportional(16.5), Color32::from_rgb(25, 30, 40));
                            tp.text(egui::pos2(text_rect.min.x, rect.min.y + 43.0), egui::Align2::LEFT_CENTER, format!("{} · {}", r.kind, format_time(r.time)), egui::FontId::proportional(13.0), Color32::from_gray(120));
                            let xr = egui::Rect::from_center_size(egui::pos2(rect.max.x - 24.0, rect.center().y), Vec2::splat(36.0));
                            let xresp = ui.interact(xr, resp.id.with("x"), egui::Sense::click());
                            p.text(xr.center(), egui::Align2::CENTER_CENTER, "✕", egui::FontId::proportional(15.0), if xresp.hovered() { Color32::from_gray(60) } else { Color32::from_gray(160) });
                            if xresp.clicked() {
                                remove = Some(r.uri.clone());
                            } else if resp.clicked() {
                                open_request = Some(r.uri.clone());
                            }
                        }
                    });
                    ui.add_space(4.0);
                }
                ui.add_space(14.0);
                ui.label(RichText::new("Formats pris en charge : .docx .doc .odt .rtf · .xlsx .xlsm .xls .ods .csv · .pptx .ppsx .ppt .odp").size(12.5).color(Color32::from_gray(140)));
            });
        });
        if let Some(u) = remove {
            self.recents.remove(&u);
        }
        if let Some(u) = open_request {
            self.open_uri(ctx, u);
        }
    }

    fn viewer_ui(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let ins = self.insets_dp(ctx);
        let Screen::View(viewer) = &mut self.screen else { return };
        let mut go_back = false;
        let bar_fill = Color32::from_rgb(250, 250, 252);
        egui::Panel::top("barre").frame(egui::Frame::new().fill(bar_fill).inner_margin(Margin { left: (ins[0] + 6.0) as i8, right: (ins[2] + 8.0) as i8, top: (ins[1] + 4.0).min(120.0) as i8, bottom: 4 }).stroke(egui::Stroke::new(1.0, Color32::from_rgb(220, 223, 228)))).show(ui, |ui| {
            ui.horizontal(|ui| {
                if ui.add(egui::Button::new(RichText::new("←").size(22.0)).frame(false).min_size(Vec2::splat(44.0))).clicked() {
                    go_back = true;
                }
                let n = viewer.page_count();
                let narrow = ui.available_width() < 520.0;
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let kind = viewer.kind();
                    if ui.add(egui::Button::new(RichText::new("↔").size(20.0)).min_size(Vec2::splat(42.0))).on_hover_text("Ajuster").clicked() {
                        viewer.fit(if kind == DocKind::Presentation { FitMode::Page } else { FitMode::Width });
                    }
                    if kind != DocKind::Spreadsheet && n > 1 && ui.available_width() > 300.0 {
                        let label = if viewer.two_up { "▯▯" } else { "▯" };
                        if ui.add(egui::Button::new(RichText::new(label).size(16.0)).min_size(Vec2::splat(42.0))).on_hover_text("Une ou deux pages").clicked() {
                            viewer.two_up = !viewer.two_up;
                            viewer.two_up_manual = true;
                            viewer.fit(FitMode::Width);
                        }
                    }
                    if !narrow {
                        ui.label(RichText::new(format!("{:.0} %", viewer.zoom_percent())).size(14.0).color(Color32::from_gray(110)));
                    }
                    if kind != DocKind::Spreadsheet {
                        ui.label(RichText::new(format!("{} / {}", viewer.current_page + 1, n)).size(15.5).color(Color32::from_gray(70)));
                    }
                    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                        ui.add(egui::Label::new(RichText::new(&viewer.name).size(16.5).strong().color(Color32::from_rgb(25, 30, 40))).truncate());
                    });
                });
            });
        });
        let sheets = viewer.sheets();
        if sheets.len() > 1 || viewer.kind() == DocKind::Spreadsheet {
            egui::Panel::bottom("feuilles").frame(egui::Frame::new().fill(bar_fill).inner_margin(Margin { left: (ins[0] + 6.0) as i8, right: (ins[2] + 6.0) as i8, top: 4, bottom: (ins[3] + 4.0).min(120.0) as i8 }).stroke(egui::Stroke::new(1.0, Color32::from_rgb(220, 223, 228)))).show(ui, |ui| {
                egui::ScrollArea::horizontal().show(ui, |ui| {
                    ui.horizontal(|ui| {
                        for (i, name, color) in &sheets {
                            let sel = *i == viewer.sheet;
                            let mut b = egui::Button::new(RichText::new(name).size(15.5).color(if sel { Color32::WHITE } else { Color32::from_rgb(40, 45, 55) })).min_size(Vec2::new(64.0, 38.0)).corner_radius(9.0);
                            b = b.fill(if sel { Color32::from_rgb(30, 123, 69) } else { Color32::from_rgb(232, 235, 239) });
                            if let Some(c) = color {
                                b = b.stroke(egui::Stroke::new(2.0, Color32::from_rgb(c.r, c.g, c.b)));
                            }
                            if ui.add(b).clicked() {
                                viewer.set_sheet(*i);
                            }
                        }
                    });
                });
            });
        } else if ins[3] > 0.0 {
            egui::Panel::bottom("marge").exact_size(ins[3]).frame(egui::Frame::new().fill(Color32::from_rgb(222, 225, 230))).show(ui, |_| {});
        }
        egui::CentralPanel::no_frame().show(ui, |ui| {
            let mut rect = ui.max_rect();
            rect.min.x += ins[0];
            rect.max.x -= ins[2];
            viewer.ui(ui, rect, &self.pool);
        });
        if go_back {
            self.screen = Screen::Home;
        }
    }
}

/// Logo : feuille avec lignes de texte, grille et diapositive.
fn draw_logo(p: &egui::Painter, r: egui::Rect) {
    p.rect_filled(r, 12.0, ACCENT);
    let s = r.width() / 108.0 * 1.45;
    let o = r.center() - Vec2::new(55.0, 54.0) * s;
    let pt = |x: f32, y: f32| o + Vec2::new(x, y) * s;
    let rect = |x1: f32, y1: f32, x2: f32, y2: f32| egui::Rect::from_min_max(pt(x1, y1), pt(x2, y2));
    p.rect_filled(rect(36.0, 28.0, 74.0, 80.0), 2.0, Color32::WHITE);
    p.rect_filled(rect(41.0, 36.0, 62.0, 40.0), 0.0, ACCENT);
    p.rect_filled(rect(41.0, 44.0, 69.0, 48.0), 0.0, ACCENT);
    p.rect_filled(rect(41.0, 54.0, 54.0, 64.0), 0.0, Color32::from_rgb(30, 123, 69));
    p.rect_filled(rect(57.0, 54.0, 69.0, 64.0), 0.0, Color32::from_rgb(196, 71, 30));
    p.rect_filled(rect(41.0, 69.0, 64.0, 73.0), 0.0, ACCENT);
}

fn format_time(t: u64) -> String {
    if t == 0 {
        return String::new();
    }
    let days = (t / 86400) as i64;
    let (y, m, d) = bureau_core::numfmt::civil_from_days(days);
    format!("{d:02}/{m:02}/{y}")
}

impl eframe::App for LecteurApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.frame += 1;
        if self.frame == 1 || self.frame % 30 == 0 {
            self.insets = self.platform.insets();
        }
        // documents demandés par le système
        if self.frame % 6 == 1 {
            if let Some(uri) = self.platform.take_pending() {
                self.open_uri(&ctx, uri);
            }
        }
        // glisser-déposer (bureau)
        let dropped: Vec<String> = ctx.input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_string_lossy().to_string()).filter(|p| !p.is_empty()).collect());
        if let Some(p) = dropped.into_iter().next() {
            self.open_uri(&ctx, p);
        }
        // bouton retour Android
        let back = ctx.input(|i| i.key_pressed(egui::Key::BrowserBack) || i.key_pressed(egui::Key::Escape));
        if back {
            if self.error.is_some() {
                self.error = None;
            } else {
                self.back();
            }
        }
        // fin de chargement
        if let Screen::Loading { rx, .. } = &self.screen {
            if let Ok(res) = rx.try_recv() {
                match res {
                    Ok((doc, name, uri)) => {
                        self.recents.add(&uri, &name, kind_label(doc.format.kind()));
                        self.screen = Screen::View(Box::new(Viewer::new(doc, name)));
                    }
                    Err((e, _uri)) => {
                        self.error = Some(e);
                        self.screen = Screen::Home;
                    }
                }
            }
        }
        match &self.screen {
            Screen::Home => self.home_ui(ui, &ctx),
            Screen::Loading { name, started, .. } => {
                let name = name.clone();
                let started = *started;
                egui::CentralPanel::no_frame().frame(egui::Frame::new().fill(Color32::from_rgb(246, 247, 249))).show(ui, |ui| {
                    ui.vertical_centered(|ui| {
                        ui.add_space(ui.available_height() * 0.38);
                        ui.add(egui::Spinner::new().size(42.0).color(ACCENT));
                        ui.add_space(14.0);
                        ui.label(RichText::new("Ouverture du document…").size(18.0));
                        ui.label(RichText::new(name).size(14.0).color(Color32::from_gray(120)));
                        let t = ctx.input(|i| i.time) - started;
                        if t > 4.0 {
                            ui.label(RichText::new("Les documents volumineux peuvent prendre quelques secondes.").size(13.0).color(Color32::from_gray(140)));
                        }
                    });
                });
                ctx.request_repaint_after(std::time::Duration::from_millis(100));
            }
            Screen::View(_) => self.viewer_ui(ui, &ctx),
        }
        // message d'erreur
        if let Some(e) = self.error.clone() {
            let mut close = false;
            egui::Modal::new(egui::Id::unique("erreur")).show(&ctx, |ui| {
                ui.set_max_width(420.0);
                ui.label(RichText::new("Impossible d'ouvrir le document").size(19.0).strong());
                ui.add_space(8.0);
                ui.label(e);
                ui.add_space(12.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui.add(egui::Button::new(RichText::new("OK").color(Color32::WHITE)).fill(ACCENT).min_size(Vec2::new(90.0, 42.0))).clicked() {
                        close = true;
                    }
                });
            });
            if close {
                self.error = None;
            }
        }
        // repeindre périodiquement pour interroger le système (intents)
        ctx.request_repaint_after(std::time::Duration::from_millis(700));
    }
}
