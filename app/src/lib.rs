pub struct HelloApp;

impl eframe::App for HelloApp {
    fn ui(&mut self, ui: &mut eframe::egui::Ui, _frame: &mut eframe::Frame) {
        ui.heading("Lecteur Office");
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: winit::platform::android::activity::AndroidApp) {
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info));
    let options = eframe::NativeOptions { android_app: Some(app), ..Default::default() };
    let _ = eframe::run_native("Lecteur Office", options, Box::new(|_cc| Ok(Box::new(HelloApp))));
    std::process::exit(0);
}
