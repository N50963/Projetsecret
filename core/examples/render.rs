//! Rend chaque page d'un document en PNG : cargo run --release --example render -- fichier.docx sortie/ [échelle]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: render <document> <dossier-sortie> [échelle]");
        std::process::exit(1);
    }
    let path = &args[1];
    let out = std::path::Path::new(&args[2]);
    let scale: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1.5);
    std::fs::create_dir_all(out).unwrap();
    let data = std::fs::read(path).expect("lecture");
    let t0 = std::time::Instant::now();
    let doc = match bureau_core::open(data, path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Erreur : {e}");
            std::process::exit(2);
        }
    };
    let t1 = t0.elapsed();
    println!("{:?} : {} page(s) en {:?}", doc.format, doc.pages.len(), t1);
    for (i, p) in doc.pages.iter().enumerate() {
        let t = std::time::Instant::now();
        let pm = bureau_core::render::render_page(p, scale).unwrap();
        let f = out.join(format!("page-{:03}.png", i + 1));
        pm.save_png(&f).unwrap();
        println!("  page {} ({:.0}x{:.0} pt) rendue en {:?}", i + 1, p.width, p.height, t.elapsed());
    }
    if let Some(wb) = &doc.workbook {
        bureau_core::sheet::debug_render(wb, out, scale);
    }
}
