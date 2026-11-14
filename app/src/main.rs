#[cfg(not(target_os = "android"))]
fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = lecteur::run_desktop(files) {
        eprintln!("Erreur : {e}");
    }
}

#[cfg(target_os = "android")]
fn main() {}
