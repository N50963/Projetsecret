//! Lecteur Office : visionneuse de documents Word, Excel, PowerPoint et OpenDocument
//! pour Android (Samsung Galaxy Z Fold 7) — entièrement en Rust.

pub mod app;
pub mod platform;
pub mod viewer;

use std::sync::Arc;

/// Polices d'interface : (principale, secours pour les symboles).
pub type UiFonts = (Option<Vec<u8>>, Option<Vec<u8>>);

/// Installe les polices embarquées (octets) et les polices système de secours.
pub fn install_fonts(fonts: Vec<Vec<u8>>) -> UiFonts {
    let mut b = bureau_core::fonts::FontDbBuilder::new();
    let mut ui_font = None;
    let mut symbols = None;
    for data in fonts {
        if let Ok(face) = ttf_parser::Face::parse(&data, 0) {
            let family = face.names().into_iter().filter(|n| n.name_id == ttf_parser::name_id::FAMILY).find_map(|n| n.to_string()).unwrap_or_default();
            let regular = !face.is_bold() && !face.is_italic();
            if regular && family == "Carlito" && ui_font.is_none() {
                ui_font = Some(data.clone());
            }
            if regular && family == "DejaVu Sans" && symbols.is_none() {
                symbols = Some(data.clone());
            }
        }
        b.add_bytes(data);
    }
    b.add_system_fallbacks();
    bureau_core::fonts::install(b.build());
    (ui_font, symbols)
}

#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: winit::platform::android::activity::AndroidApp) {
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("lecteur"));
    std::panic::set_hook(Box::new(|info| {
        log::error!("panique : {info}");
    }));
    // polices embarquées dans les assets de l'APK
    let mut fonts = Vec::new();
    {
        let am = app.asset_manager();
        if let Some(dir) = am.open_dir(c"fonts") {
            for name in dir {
                let path = format!("fonts/{}", name.to_string_lossy());
                if let Ok(cpath) = std::ffi::CString::new(path) {
                    if let Some(mut asset) = am.open(&cpath) {
                        if let Ok(buf) = asset.buffer() {
                            fonts.push(buf.to_vec());
                        }
                    }
                }
            }
        }
    }
    let ui_font = install_fonts(fonts);
    let platform: Arc<dyn platform::Platform> = match platform::android::AndroidPlatform::new(&app) {
        Some(p) => Arc::new(p),
        None => {
            log::error!("JNI indisponible");
            return;
        }
    };
    let options = eframe::NativeOptions { android_app: Some(app), ..Default::default() };
    let res = eframe::run_native(
        "Lecteur Office",
        options,
        Box::new(move |cc| {
            app::setup_style(&cc.egui_ctx, ui_font);
            Ok(Box::new(app::LecteurApp::new(&cc.egui_ctx, platform)))
        }),
    );
    if let Err(e) = res {
        log::error!("eframe : {e}");
    }
    // winit ne peut pas recréer sa boucle d'événements : on termine proprement le processus.
    std::process::exit(0);
}

/// Point d'entrée bureau (tests).
#[cfg(not(target_os = "android"))]
pub fn run_desktop(files: Vec<String>) -> eframe::Result<()> {
    let mut fonts = Vec::new();
    for dir in ["fonts", "../fonts", concat!(env!("CARGO_MANIFEST_DIR"), "/../fonts")] {
        if let Ok(rd) = std::fs::read_dir(dir) {
            let mut paths: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "ttf").unwrap_or(false)).collect();
            paths.sort();
            for p in paths {
                if let Ok(d) = std::fs::read(p) {
                    fonts.push(d);
                }
            }
            break;
        }
    }
    let ui_font = install_fonts(fonts);
    let platform: Arc<dyn platform::Platform> = Arc::new(platform::DesktopPlatform { pending: std::sync::Mutex::new(files) });
    let options = eframe::NativeOptions { viewport: eframe::egui::ViewportBuilder::default().with_inner_size([900.0, 1000.0]).with_title("Lecteur Office"), ..Default::default() };
    eframe::run_native(
        "Lecteur Office",
        options,
        Box::new(move |cc| {
            app::setup_style(&cc.egui_ctx, ui_font);
            Ok(Box::new(app::LecteurApp::new(&cc.egui_ctx, platform)))
        }),
    )
}
