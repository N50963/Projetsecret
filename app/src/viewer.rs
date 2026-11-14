//! Visionneuse : pages (texte, diapositives) ou feuilles de calcul rendues en tuiles
//! par des threads de travail, avec zoom à deux doigts et défilement inertiel.

use bureau_core::display::Page;
use bureau_core::sheet::{Sheet, Workbook};
use bureau_core::{DocKind, Document};
use eframe::egui::{self, Color32, Pos2, Rect, Sense, Stroke, TextureHandle, Vec2};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};

const TILE: u32 = 512;
const MAX_TILES: usize = 140;
const PAGE_GAP: f32 = 14.0;

/// Contenu partagé avec les threads de rendu.
pub enum Content {
    Pages(Vec<Page>),
    Book(Workbook),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct TileKey {
    generation: u64,
    page: u32,
    level: i32,
    tx: i32,
    ty: i32,
    thumb: bool,
}

struct Job {
    key: TileKey,
    content: Arc<Content>,
}

pub struct TileResult {
    key: TileKey,
    size: [usize; 2],
    rgba: Vec<u8>,
}

#[derive(Default)]
struct Queue {
    waiting: Vec<Job>,
    running: HashSet<TileKey>,
}

/// Groupe de threads de rendu partagé par l'application.
pub struct TilePool {
    queue: Mutex<Queue>,
    cv: Condvar,
    results: Mutex<Receiver<TileResult>>,
}

static GENERATION: AtomicU64 = AtomicU64::new(1);

pub fn level_scale(level: i32) -> f32 {
    2f32.powf(level as f32 / 4.0)
}

fn render_job(job: &Job) -> Option<TileResult> {
    let k = job.key;
    match &*job.content {
        Content::Pages(pages) => {
            let page = pages.get(k.page as usize)?;
            if k.thumb {
                let scale = (320.0 / page.width.max(1.0)).min(1.0);
                let pm = bureau_core::render::render_page(page, scale)?;
                return Some(TileResult { key: k, size: [pm.width() as usize, pm.height() as usize], rgba: pm.take() });
            }
            let z = level_scale(k.level);
            let pw = (page.width * z).ceil() as i64;
            let ph = (page.height * z).ceil() as i64;
            let x0 = k.tx as i64 * TILE as i64;
            let y0 = k.ty as i64 * TILE as i64;
            let w = (pw - x0).clamp(1, TILE as i64) as u32;
            let h = (ph - y0).clamp(1, TILE as i64) as u32;
            let mut pm = tiny_skia::Pixmap::new(w, h)?;
            bureau_core::render::render_page_region(page, &mut pm, z, x0 as f32 / z, y0 as f32 / z);
            Some(TileResult { key: k, size: [w as usize, h as usize], rgba: pm.take() })
        }
        Content::Book(wb) => {
            let sheet = wb.sheets.get(k.page as usize)?;
            let z = level_scale(k.level);
            let pw = (sheet.width() * z).ceil() as i64;
            let ph = (sheet.height() * z).ceil() as i64;
            let x0 = k.tx as i64 * TILE as i64;
            let y0 = k.ty as i64 * TILE as i64;
            let w = (pw - x0).clamp(1, TILE as i64) as u32;
            let h = (ph - y0).clamp(1, TILE as i64) as u32;
            let mut pm = tiny_skia::Pixmap::new(w, h)?;
            sheet.render_region(&mut pm, z, x0 as f32 / z, y0 as f32 / z);
            Some(TileResult { key: k, size: [w as usize, h as usize], rgba: pm.take() })
        }
    }
}

impl TilePool {
    pub fn new(ctx: egui::Context) -> Arc<TilePool> {
        let (tx, rx) = channel::<TileResult>();
        let pool = Arc::new(TilePool { queue: Mutex::new(Queue::default()), cv: Condvar::new(), results: Mutex::new(rx) });
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 6) - 1;
        for i in 0..n.max(1) {
            let pool = pool.clone();
            let tx: Sender<TileResult> = tx.clone();
            let ctx = ctx.clone();
            std::thread::Builder::new()
                .name(format!("rendu-{i}"))
                .stack_size(8 * 1024 * 1024)
                .spawn(move || loop {
                    let job = {
                        let mut q = pool.queue.lock().unwrap();
                        while q.waiting.is_empty() {
                            q = pool.cv.wait(q).unwrap();
                        }
                        let job = q.waiting.remove(0);
                        q.running.insert(job.key);
                        job
                    };
                    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render_job(&job))).ok().flatten();
                    pool.queue.lock().unwrap().running.remove(&job.key);
                    if let Some(r) = res {
                        let _ = tx.send(r);
                    }
                    ctx.request_repaint();
                })
                .ok();
        }
        pool
    }

    /// Remplace la file d'attente par les tuiles nécessaires (les plus prioritaires d'abord).
    fn request(&self, jobs: Vec<Job>) {
        let mut q = self.queue.lock().unwrap();
        let running = q.running.clone();
        q.waiting = jobs.into_iter().filter(|j| !running.contains(&j.key)).collect();
        drop(q);
        self.cv.notify_all();
    }

    fn is_running(&self, k: &TileKey) -> bool {
        self.queue.lock().unwrap().running.contains(k)
    }

    fn drain(&self) -> Vec<TileResult> {
        let rx = self.results.lock().unwrap();
        rx.try_iter().collect()
    }
}

struct Tile {
    tex: TextureHandle,
    size: [usize; 2],
    last_used: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FitMode {
    Width,
    Page,
}

pub struct Viewer {
    pub doc: Arc<Document>,
    pub name: String,
    content: Arc<Content>,
    generation: u64,
    pub sheet: usize,
    zoom: f32,
    offset: Vec2,
    fitted: Option<FitMode>,
    pub two_up: bool,
    layout: Vec<Rect>,
    layout_for: (f32, bool, usize),
    view: Rect,
    velocity: Vec2,
    tiles: HashMap<TileKey, Tile>,
    frame: u64,
    pub current_page: usize,
    last_view_size: Vec2,
}

impl Viewer {
    pub fn new(doc: Document, name: String) -> Viewer {
        // Le contenu dessinable est déplacé dans un Arc partagé avec les threads de rendu.
        let mut doc = doc;
        let content = match doc.workbook.take() {
            Some(wb) => Content::Book(wb),
            None => Content::Pages(std::mem::take(&mut doc.pages)),
        };
        let first_sheet = match &content {
            Content::Book(wb) => wb.sheets.iter().position(|s| !s.hidden).unwrap_or(0),
            _ => 0,
        };
        Viewer {
            doc: Arc::new(doc),
            name,
            content: Arc::new(content),
            generation: GENERATION.fetch_add(1, Ordering::Relaxed),
            sheet: first_sheet,
            zoom: 1.0,
            offset: Vec2::ZERO,
            fitted: None,
            two_up: false,
            layout: Vec::new(),
            layout_for: (0.0, false, usize::MAX),
            view: Rect::NOTHING,
            velocity: Vec2::ZERO,
            tiles: HashMap::new(),
            frame: 0,
            current_page: 0,
            last_view_size: Vec2::ZERO,
        }
    }

    pub fn kind(&self) -> DocKind {
        self.doc.format.kind()
    }

    pub fn page_count(&self) -> usize {
        match &*self.content {
            Content::Pages(p) => p.len(),
            Content::Book(_) => 1,
        }
    }

    pub fn sheets(&self) -> Vec<(usize, String, Option<bureau_core::color::Color>)> {
        match &*self.content {
            Content::Book(wb) => wb.sheets.iter().enumerate().filter(|(_, s)| !s.hidden).map(|(i, s)| (i, s.name.clone(), s.tab_color)).collect(),
            _ => Vec::new(),
        }
    }

    fn sheet_ref(&self) -> Option<&Sheet> {
        match &*self.content {
            Content::Book(wb) => wb.sheets.get(self.sheet),
            _ => None,
        }
    }

    pub fn set_sheet(&mut self, i: usize) {
        if i != self.sheet {
            self.sheet = i;
            self.generation = GENERATION.fetch_add(1, Ordering::Relaxed);
            self.tiles.clear();
            self.offset = Vec2::ZERO;
            self.layout_for.2 = usize::MAX;
            self.fitted = None;
        }
    }

    /// En-têtes de feuille (lettres de colonnes, numéros de lignes) en points écran.
    fn header_size(&self) -> Vec2 {
        if self.sheet_ref().is_some() {
            Vec2::new(44.0, 24.0)
        } else {
            Vec2::ZERO
        }
    }

    fn page_sizes(&self) -> Vec<Vec2> {
        match &*self.content {
            Content::Pages(p) => p.iter().map(|p| Vec2::new(p.width, p.height)).collect(),
            Content::Book(wb) => wb.sheets.get(self.sheet).map(|s| vec![Vec2::new(s.width(), s.height())]).unwrap_or_default(),
        }
    }

    fn relayout(&mut self, view_w: f32) {
        let key = (view_w, self.two_up, self.sheet);
        if self.layout_for == key && !self.layout.is_empty() {
            return;
        }
        self.layout_for = key;
        let sizes = self.page_sizes();
        self.layout.clear();
        let is_sheet = self.sheet_ref().is_some();
        if is_sheet {
            if let Some(s) = sizes.first() {
                self.layout.push(Rect::from_min_size(Pos2::ZERO, *s));
            }
            return;
        }
        let gap = PAGE_GAP;
        let cols = if self.two_up && sizes.len() > 1 { 2 } else { 1 };
        let max_w = sizes.iter().map(|s| s.x).fold(0.0, f32::max);
        let row_w = max_w * cols as f32 + gap * (cols as f32 - 1.0);
        let mut y = gap;
        let mut i = 0;
        while i < sizes.len() {
            let row: Vec<usize> = (i..(i + cols).min(sizes.len())).collect();
            let row_h = row.iter().map(|&k| sizes[k].y).fold(0.0, f32::max);
            let total: f32 = row.iter().map(|&k| sizes[k].x).sum::<f32>() + gap * (row.len() as f32 - 1.0);
            let mut x = (row_w - total) / 2.0;
            for &k in &row {
                self.layout.push(Rect::from_min_size(Pos2::new(x, y + (row_h - sizes[k].y) / 2.0), sizes[k]));
                x += sizes[k].x + gap;
            }
            y += row_h + gap;
            i += cols;
        }
    }

    fn content_size(&self) -> Vec2 {
        let mut s = Vec2::ZERO;
        for r in &self.layout {
            s.x = s.x.max(r.max.x);
            s.y = s.y.max(r.max.y);
        }
        if self.sheet_ref().is_none() {
            s.x += 0.0;
            s.y += PAGE_GAP * 0.0;
        }
        s
    }

    fn fit_zoom(&self, mode: FitMode) -> f32 {
        let cs = self.content_size();
        let vw = self.view.width().max(10.0);
        let vh = self.view.height().max(10.0);
        if self.sheet_ref().is_some() {
            return 1.0;
        }
        let margin = 8.0;
        match mode {
            FitMode::Width => (vw - 2.0 * margin) / cs.x.max(1.0),
            FitMode::Page => {
                let first = self.layout.first().map(|r| r.size()).unwrap_or(Vec2::splat(100.0));
                let row_w = if self.two_up { cs.x } else { first.x };
                ((vw - 2.0 * margin) / row_w.max(1.0)).min((vh - 2.0 * margin) / (first.y + PAGE_GAP))
            }
        }
    }

    pub fn fit(&mut self, mode: FitMode) {
        self.fitted = Some(mode);
        let z = self.fit_zoom(mode);
        let page = self.current_page;
        self.zoom = z;
        self.velocity = Vec2::ZERO;
        if let Some(r) = self.layout.get(page) {
            self.offset.y = r.min.y - PAGE_GAP;
        }
        self.clamp();
    }

    pub fn zoom_by(&mut self, f: f32, at: Pos2) {
        let (min_z, max_z) = self.zoom_limits();
        let nz = (self.zoom * f).clamp(min_z, max_z);
        if (nz - self.zoom).abs() < 1e-6 {
            return;
        }
        let origin = self.content_origin();
        let d = self.offset + (at - origin) / self.zoom;
        self.zoom = nz;
        self.offset = d - (at - origin) / self.zoom;
        self.fitted = None;
        self.clamp();
    }

    fn zoom_limits(&self) -> (f32, f32) {
        if self.sheet_ref().is_some() {
            (0.15, 6.0)
        } else {
            let fw = self.fit_zoom(FitMode::Width);
            ((fw * 0.25).min(0.1).max(0.05), (fw * 8.0).max(4.0))
        }
    }

    fn content_origin(&self) -> Pos2 {
        self.view.min + self.header_size()
    }

    fn clamp(&mut self) {
        let cs = self.content_size();
        let hs = self.header_size();
        let vw = (self.view.width() - hs.x) / self.zoom;
        let vh = (self.view.height() - hs.y) / self.zoom;
        if cs.x <= vw {
            self.offset.x = if self.sheet_ref().is_some() { 0.0 } else { -(vw - cs.x) / 2.0 };
        } else {
            self.offset.x = self.offset.x.clamp(0.0, cs.x - vw);
        }
        let extra = if self.sheet_ref().is_some() { 0.0 } else { PAGE_GAP };
        if cs.y + extra <= vh {
            self.offset.y = if self.sheet_ref().is_some() { 0.0 } else { -(vh - cs.y - extra) / 2.0 };
        } else {
            self.offset.y = self.offset.y.clamp(0.0, cs.y + extra - vh);
        }
    }

    pub fn go_to_page(&mut self, page: usize) {
        if let Some(r) = self.layout.get(page) {
            self.offset.y = r.min.y - PAGE_GAP;
            self.current_page = page;
            self.velocity = Vec2::ZERO;
            self.clamp();
        }
    }

    pub fn zoom_percent(&self) -> f32 {
        self.zoom * 100.0
    }

    /// Dessine la visionneuse dans `rect` et gère les gestes.
    pub fn ui(&mut self, ui: &mut egui::Ui, rect: Rect, pool: &TilePool) {
        self.frame += 1;
        let ctx = ui.ctx().clone();
        let ppp = ctx.pixels_per_point();
        self.view = rect;
        let size_changed = (self.last_view_size - rect.size()).length() > 1.0;
        self.last_view_size = rect.size();
        self.relayout(rect.width());
        if self.fitted.is_none() && self.zoom == 1.0 && self.frame <= 2 {
            let mode = match self.kind() {
                DocKind::Presentation => FitMode::Page,
                _ => FitMode::Width,
            };
            if self.sheet_ref().is_some() {
                self.zoom = 1.0;
                self.fitted = None;
                self.clamp();
            } else {
                self.fit(mode);
                self.offset.y = -PAGE_GAP * 0.0;
                self.clamp();
            }
        } else if size_changed {
            // pliage / dépliage : on garde la même page visible
            let page = self.current_page;
            if let Some(m) = self.fitted {
                self.layout_for.0 = -1.0;
                self.relayout(rect.width());
                self.zoom = self.fit_zoom(m);
                self.go_to_page(page);
            }
            self.clamp();
        }

        // ---------------------------------------------------------------- gestes
        let resp = ui.allocate_rect(rect, Sense::click_and_drag());
        let (multi, zoom_delta, scroll, dt, pointer_vel, hover) = ctx.input(|i| (i.multi_touch(), i.zoom_delta(), i.smooth_scroll_delta(), i.stable_dt.min(0.05), i.pointer.velocity(), i.pointer.hover_pos()));
        let mut interacting = false;
        if let Some(mt) = multi.filter(|m| m.num_touches >= 2) {
            if (mt.zoom_delta - 1.0).abs() > 1e-4 {
                self.zoom_by(mt.zoom_delta, mt.center_pos);
            }
            self.offset -= mt.translation_delta / self.zoom;
            self.velocity = Vec2::ZERO;
            self.fitted = None;
            interacting = true;
        } else {
            if (zoom_delta - 1.0).abs() > 1e-4 {
                self.zoom_by(zoom_delta, hover.unwrap_or(rect.center()));
            }
            if resp.dragged() {
                let d = resp.drag_delta();
                self.offset -= d / self.zoom;
                self.velocity = Vec2::ZERO;
                interacting = true;
            }
            if resp.drag_stopped() {
                self.velocity = pointer_vel;
                if self.velocity.length() < 60.0 {
                    self.velocity = Vec2::ZERO;
                }
            }
            if scroll != Vec2::ZERO && resp.hovered() {
                self.offset -= scroll / self.zoom;
            }
        }
        if resp.double_clicked() {
            let at = resp.interact_pointer_pos().unwrap_or(rect.center());
            let fit = self.fit_zoom(FitMode::Width);
            if self.sheet_ref().is_some() {
                let f = if self.zoom < 1.4 { 2.0 / self.zoom } else { 1.0 / self.zoom };
                self.zoom_by(f, at);
            } else if self.zoom > fit * 1.3 {
                let f = fit / self.zoom;
                self.zoom_by(f, at);
                self.fitted = Some(FitMode::Width);
            } else {
                self.zoom_by(2.5 * fit / self.zoom, at);
            }
        }
        if !interacting && self.velocity != Vec2::ZERO {
            self.offset -= self.velocity * dt / self.zoom;
            self.velocity *= (-dt * 3.5).exp();
            if self.velocity.length() < 15.0 {
                self.velocity = Vec2::ZERO;
            }
            ctx.request_repaint();
        }
        self.clamp();

        // ---------------------------------------------------------------- dessin
        let painter = ui.painter_at(rect);
        let is_sheet = self.sheet_ref().is_some();
        painter.rect_filled(rect, 0.0, if is_sheet { Color32::WHITE } else { Color32::from_rgb(222, 225, 230) });
        let origin = self.content_origin();
        let to_screen = |p: Pos2, offset: Vec2, zoom: f32| origin + (p.to_vec2() - offset) * zoom;
        let view_doc = Rect::from_min_size(Pos2::ZERO + self.offset, (rect.size() - self.header_size()) / self.zoom);
        let level = ((self.zoom * ppp).log2() * 4.0).ceil().clamp(-12.0, 15.0) as i32;
        let z = level_scale(level);

        // résultats des threads de rendu
        for r in pool.drain() {
            if r.key.generation != self.generation {
                continue;
            }
            let img = egui::ColorImage::from_rgba_premultiplied(r.size, &r.rgba);
            let tex = ctx.load_texture(format!("t{:?}", r.key), img, egui::TextureOptions::LINEAR);
            self.tiles.insert(r.key, Tile { tex, size: r.size, last_used: self.frame });
        }

        let mut jobs: Vec<(f32, Job)> = Vec::new();
        let center = view_doc.center();
        let mut current = self.current_page;
        let mut best_dist = f32::MAX;
        let clip_rect = Rect::from_min_max(origin, rect.max);
        let painter_c = painter.with_clip_rect(clip_rect);
        let layout = self.layout.clone();
        for (pi, pr) in layout.iter().enumerate() {
            if !pr.intersects(view_doc.expand(40.0)) {
                continue;
            }
            let d = (pr.center().y - center.y).abs() - pr.height() / 2.0;
            if pr.contains(center) || d < best_dist {
                best_dist = if pr.contains(center) { f32::MIN } else { d };
                current = pi;
            }
            let sr = Rect::from_min_max(to_screen(pr.min, self.offset, self.zoom), to_screen(pr.max, self.offset, self.zoom));
            if !is_sheet {
                // ombre et fond de page
                painter_c.rect_filled(sr.translate(Vec2::new(1.5, 2.0)), 1.0, Color32::from_black_alpha(40));
                painter_c.rect_filled(sr, 0.0, Color32::WHITE);
                // miniature (repli pendant le rendu des tuiles)
                let tk = TileKey { generation: self.generation, page: pi as u32, level: 0, tx: 0, ty: 0, thumb: true };
                if let Some(t) = self.tiles.get_mut(&tk) {
                    t.last_used = self.frame;
                    painter_c.image(t.tex.id(), sr, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);
                } else if !pool.is_running(&tk) {
                    jobs.push((-1.0e9 + (pi as f32 - current as f32).abs(), Job { key: tk, content: self.content.clone() }));
                }
            }
            let page_idx = if is_sheet { self.sheet as u32 } else { pi as u32 };
            // tuiles d'autres niveaux déjà en cache (transition de zoom)
            let mut others: Vec<(TileKey, egui::TextureId, [usize; 2])> = self.tiles.iter().filter(|(k, _)| k.page == page_idx && !k.thumb && k.level != level).map(|(k, t)| (*k, t.tex.id(), t.size)).collect();
            others.sort_by_key(|(k, _, _)| (k.level - level).abs() * -1);
            for (k, tex, size) in others {
                let zk = level_scale(k.level);
                let tr = Rect::from_min_size(pr.min + Vec2::new(k.tx as f32 * TILE as f32 / zk, k.ty as f32 * TILE as f32 / zk), Vec2::new(size[0] as f32 / zk, size[1] as f32 / zk));
                if !tr.intersects(view_doc) {
                    continue;
                }
                let sr2 = Rect::from_min_max(to_screen(tr.min, self.offset, self.zoom), to_screen(tr.max, self.offset, self.zoom));
                painter_c.image(tex, sr2, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);
            }
            // tuiles du niveau courant
            let tile_doc = TILE as f32 / z;
            let vis = pr.intersect(view_doc);
            if vis.width() <= 0.0 || vis.height() <= 0.0 {
                continue;
            }
            let tx0 = ((vis.min.x - pr.min.x) / tile_doc).floor().max(0.0) as i32;
            let ty0 = ((vis.min.y - pr.min.y) / tile_doc).floor().max(0.0) as i32;
            let tx1 = ((vis.max.x - pr.min.x) / tile_doc).ceil() as i32;
            let ty1 = ((vis.max.y - pr.min.y) / tile_doc).ceil() as i32;
            for ty in ty0..ty1 {
                for tx in tx0..tx1 {
                    let key = TileKey { generation: self.generation, page: page_idx, level, tx, ty, thumb: false };
                    let trect_min = pr.min + Vec2::new(tx as f32 * tile_doc, ty as f32 * tile_doc);
                    match self.tiles.get_mut(&key) {
                        Some(t) => {
                            t.last_used = self.frame;
                            let tr = Rect::from_min_size(trect_min, Vec2::new(t.size[0] as f32 / z, t.size[1] as f32 / z));
                            let sr2 = Rect::from_min_max(to_screen(tr.min, self.offset, self.zoom), to_screen(tr.max, self.offset, self.zoom));
                            painter_c.image(t.tex.id(), sr2, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);
                        }
                        None => {
                            if !pool.is_running(&key) {
                                let c = trect_min + Vec2::splat(tile_doc / 2.0);
                                let dist = (c - center).length();
                                jobs.push((dist, Job { key, content: self.content.clone() }));
                            }
                        }
                    }
                }
            }
            if !is_sheet {
                painter_c.rect_stroke(sr, 0.0, Stroke::new(0.5, Color32::from_gray(190)), egui::StrokeKind::Outside);
            }
        }
        if !is_sheet {
            self.current_page = current;
        }
        // préchargement : tuiles des pages voisines au même niveau (faible priorité)
        jobs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        pool.request(jobs.into_iter().map(|j| j.1).collect());

        // en-têtes de feuille
        if let Some(sheet) = self.sheet_ref() {
            self.draw_sheet_headers(&painter, sheet, rect, view_doc);
        }

        // éviction LRU
        if self.tiles.len() > MAX_TILES {
            let mut v: Vec<(TileKey, u64)> = self.tiles.iter().map(|(k, t)| (*k, t.last_used)).collect();
            v.sort_by_key(|x| x.1);
            let n = self.tiles.len() - MAX_TILES;
            for (k, used) in v.into_iter().take(n) {
                if used + 2 < self.frame {
                    self.tiles.remove(&k);
                }
            }
        }
    }

    fn draw_sheet_headers(&self, painter: &egui::Painter, sheet: &Sheet, rect: Rect, view_doc: Rect) {
        let hs = self.header_size();
        let bg = Color32::from_rgb(242, 243, 245);
        let line = Color32::from_rgb(200, 203, 208);
        let text = Color32::from_rgb(70, 74, 80);
        let font = egui::FontId::proportional(12.0);
        // bandeau des colonnes
        let top = Rect::from_min_max(Pos2::new(rect.min.x + hs.x, rect.min.y), Pos2::new(rect.max.x, rect.min.y + hs.y));
        let left = Rect::from_min_max(Pos2::new(rect.min.x, rect.min.y + hs.y), Pos2::new(rect.min.x + hs.x, rect.max.y));
        painter.rect_filled(top, 0.0, bg);
        painter.rect_filled(left, 0.0, bg);
        painter.rect_filled(Rect::from_min_size(rect.min, hs), 0.0, Color32::from_rgb(230, 232, 236));
        let pt = painter.with_clip_rect(top);
        let c0 = sheet.col_at(view_doc.min.x);
        let c1 = sheet.col_at(view_doc.max.x);
        for c in c0..=c1 {
            let x1 = top.min.x + (sheet.col_x(c) - self.offset.x) * self.zoom;
            let x2 = top.min.x + (sheet.col_x(c + 1) - self.offset.x) * self.zoom;
            if x2 - x1 < 1.0 {
                continue;
            }
            pt.line_segment([Pos2::new(x2, top.min.y), Pos2::new(x2, top.max.y)], Stroke::new(1.0, line));
            if x2 - x1 > 14.0 {
                pt.text(Pos2::new((x1 + x2) / 2.0, top.center().y), egui::Align2::CENTER_CENTER, Sheet::col_name(c), font.clone(), text);
            }
        }
        let pl = painter.with_clip_rect(left);
        let r0 = sheet.row_at(view_doc.min.y);
        let r1 = sheet.row_at(view_doc.max.y);
        for r in r0..=r1 {
            let y1 = left.min.y + (sheet.row_y(r) - self.offset.y) * self.zoom;
            let y2 = left.min.y + (sheet.row_y(r + 1) - self.offset.y) * self.zoom;
            if y2 - y1 < 1.0 {
                continue;
            }
            pl.line_segment([Pos2::new(left.min.x, y2), Pos2::new(left.max.x, y2)], Stroke::new(1.0, line));
            if y2 - y1 > 9.0 {
                pl.text(Pos2::new(left.center().x, (y1 + y2) / 2.0), egui::Align2::CENTER_CENTER, (r + 1).to_string(), font.clone(), text);
            }
        }
        painter.line_segment([Pos2::new(top.min.x, top.max.y), Pos2::new(top.max.x, top.max.y)], Stroke::new(1.0, line));
        painter.line_segment([Pos2::new(left.max.x, left.min.y), Pos2::new(left.max.x, left.max.y)], Stroke::new(1.0, line));
    }

    pub fn is_animating(&self) -> bool {
        self.velocity != Vec2::ZERO
    }
}
