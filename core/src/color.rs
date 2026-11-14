//! Couleurs RGBA et transformations de couleurs utilisées par les formats Office
//! (luminance, teinte, ombre, saturation...).

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Default for Color {
    fn default() -> Self {
        Color::BLACK
    }
}

impl Color {
    pub const BLACK: Color = Color::rgb(0, 0, 0);
    pub const WHITE: Color = Color::rgb(255, 255, 255);
    pub const TRANSPARENT: Color = Color { r: 0, g: 0, b: 0, a: 0 };

    pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color { r, g, b, a: 255 }
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
        Color { r, g, b, a }
    }

    pub fn with_alpha(self, a: f32) -> Color {
        Color { a: ((self.a as f32) * a.clamp(0.0, 1.0)).round() as u8, ..self }
    }

    /// Analyse « RRGGBB », « #RRGGBB », « AARRGGBB » ou « RGB ».
    pub fn from_hex(s: &str) -> Option<Color> {
        let s = s.trim().trim_start_matches('#');
        let v = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
        match s.len() {
            6 => Some(Color::rgb(v(0)?, v(2)?, v(4)?)),
            8 => Some(Color::rgba(v(2)?, v(4)?, v(6)?, v(0)?)),
            3 => {
                let c = |i: usize| u8::from_str_radix(s.get(i..i + 1)?, 16).ok().map(|x| x * 17);
                Some(Color::rgb(c(0)?, c(1)?, c(2)?))
            }
            _ => None,
        }
    }

    pub fn is_transparent(&self) -> bool {
        self.a == 0
    }

    pub fn to_skia(self) -> tiny_skia::Color {
        tiny_skia::Color::from_rgba8(self.r, self.g, self.b, self.a)
    }

    pub fn luminance(&self) -> f32 {
        (0.299 * self.r as f32 + 0.587 * self.g as f32 + 0.114 * self.b as f32) / 255.0
    }

    pub fn to_hsl(self) -> (f32, f32, f32) {
        let r = self.r as f32 / 255.0;
        let g = self.g as f32 / 255.0;
        let b = self.b as f32 / 255.0;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let l = (max + min) / 2.0;
        if (max - min).abs() < 1e-6 {
            return (0.0, 0.0, l);
        }
        let d = max - min;
        let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
        let h = if max == r {
            (g - b) / d + if g < b { 6.0 } else { 0.0 }
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (h / 6.0, s, l)
    }

    pub fn from_hsl(h: f32, s: f32, l: f32, a: u8) -> Color {
        let (r, g, b) = if s <= 0.0 {
            (l, l, l)
        } else {
            let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
            let p = 2.0 * l - q;
            let f = |mut t: f32| {
                if t < 0.0 {
                    t += 1.0
                }
                if t > 1.0 {
                    t -= 1.0
                }
                if t < 1.0 / 6.0 {
                    p + (q - p) * 6.0 * t
                } else if t < 0.5 {
                    q
                } else if t < 2.0 / 3.0 {
                    p + (q - p) * (2.0 / 3.0 - t) * 6.0
                } else {
                    p
                }
            };
            (f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0))
        };
        let c = |x: f32| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
        Color::rgba(c(r), c(g), c(b), a)
    }

    /// Modulation de luminance (DrawingML lumMod / lumOff, valeurs en fraction).
    pub fn lum_mod_off(self, lum_mod: f32, lum_off: f32) -> Color {
        let (h, s, l) = self.to_hsl();
        Color::from_hsl(h, s, (l * lum_mod + lum_off).clamp(0.0, 1.0), self.a)
    }

    pub fn sat_mod(self, m: f32) -> Color {
        let (h, s, l) = self.to_hsl();
        Color::from_hsl(h, (s * m).clamp(0.0, 1.0), l, self.a)
    }

    /// Éclaircissement DrawingML « tint » (1.0 = couleur d'origine, 0.0 = blanc).
    pub fn tint(self, t: f32) -> Color {
        let f = |c: u8| {
            let lin = srgb_to_linear(c as f32 / 255.0);
            let v = lin * t + (1.0 - t);
            (linear_to_srgb(v) * 255.0).round().clamp(0.0, 255.0) as u8
        };
        Color::rgba(f(self.r), f(self.g), f(self.b), self.a)
    }

    /// Assombrissement DrawingML « shade » (1.0 = couleur d'origine, 0.0 = noir).
    pub fn shade(self, t: f32) -> Color {
        let f = |c: u8| {
            let lin = srgb_to_linear(c as f32 / 255.0);
            (linear_to_srgb(lin * t) * 255.0).round().clamp(0.0, 255.0) as u8
        };
        Color::rgba(f(self.r), f(self.g), f(self.b), self.a)
    }

    /// Teinte Excel / Word (« tint » de -1 à 1) appliquée en espace HSL.
    pub fn office_tint(self, tint: f32) -> Color {
        if tint == 0.0 {
            return self;
        }
        let (h, s, l) = self.to_hsl();
        let l2 = if tint < 0.0 { l * (1.0 + tint) } else { l * (1.0 - tint) + tint };
        Color::from_hsl(h, s, l2, self.a)
    }

    pub fn blend_over(self, bg: Color) -> Color {
        let a = self.a as f32 / 255.0;
        let m = |f: u8, b: u8| (f as f32 * a + b as f32 * (1.0 - a)).round() as u8;
        Color::rgb(m(self.r, bg.r), m(self.g, bg.g), m(self.b, bg.b))
    }

    pub fn mix(self, other: Color, t: f32) -> Color {
        let m = |a: u8, b: u8| (a as f32 * (1.0 - t) + b as f32 * t).round() as u8;
        Color::rgba(m(self.r, other.r), m(self.g, other.g), m(self.b, other.b), m(self.a, other.a))
    }
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// Couleurs nommées (CSS / VML / surlignage Word / prstClr DrawingML).
pub fn named_color(name: &str) -> Option<Color> {
    let n = name.trim().to_ascii_lowercase();
    let c = match n.as_str() {
        "black" => (0, 0, 0),
        "white" => (255, 255, 255),
        "red" => (255, 0, 0),
        "green" => (0, 255, 0),
        "lime" => (0, 255, 0),
        "blue" => (0, 0, 255),
        "yellow" => (255, 255, 0),
        "cyan" | "aqua" => (0, 255, 255),
        "magenta" | "fuchsia" => (255, 0, 255),
        "darkblue" | "navy" => (0, 0, 128),
        "darkcyan" | "teal" => (0, 128, 128),
        "darkgreen" => (0, 128, 0),
        "darkmagenta" | "purple" => (128, 0, 128),
        "darkred" | "maroon" => (128, 0, 0),
        "darkyellow" | "olive" => (128, 128, 0),
        "darkgray" | "darkgrey" => (128, 128, 128),
        "gray" | "grey" => (128, 128, 128),
        "lightgray" | "lightgrey" | "silver" => (192, 192, 192),
        "orange" => (255, 165, 0),
        "pink" => (255, 192, 203),
        "brown" => (165, 42, 42),
        "gold" => (255, 215, 0),
        "violet" => (238, 130, 238),
        "indigo" => (75, 0, 130),
        "beige" => (245, 245, 220),
        "coral" => (255, 127, 80),
        "crimson" => (220, 20, 60),
        "khaki" => (240, 230, 140),
        "lavender" => (230, 230, 250),
        "salmon" => (250, 128, 114),
        "tan" => (210, 180, 140),
        "turquoise" => (64, 224, 208),
        "skyblue" => (135, 206, 235),
        "steelblue" => (70, 130, 180),
        "royalblue" => (65, 105, 225),
        "lightblue" => (173, 216, 230),
        "lightgreen" => (144, 238, 144),
        "darkorange" => (255, 140, 0),
        "orangered" => (255, 69, 0),
        "dimgray" | "dimgrey" => (105, 105, 105),
        "whitesmoke" => (245, 245, 245),
        "gainsboro" => (220, 220, 220),
        "ltgray" => (192, 192, 192),
        "dkgray" => (128, 128, 128),
        _ => return None,
    };
    Some(Color::rgb(c.0, c.1, c.2))
}

/// Palette indexée Excel par défaut (BIFF8 / SpreadsheetML).
pub const EXCEL_INDEXED: [u32; 64] = [
    0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x000000, 0xFFFFFF,
    0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x800000, 0x008000, 0x000080, 0x808000,
    0x800080, 0x008080, 0xC0C0C0, 0x808080, 0x9999FF, 0x993366, 0xFFFFCC, 0xCCFFFF, 0x660066, 0xFF8080,
    0x0066CC, 0xCCCCFF, 0x000080, 0xFF00FF, 0xFFFF00, 0x00FFFF, 0x800080, 0x800000, 0x008080, 0x0000FF,
    0x00CCFF, 0xCCFFFF, 0xCCFFCC, 0xFFFF99, 0x99CCFF, 0xFF99CC, 0xCC99FF, 0xFFCC99, 0x3366FF, 0x33CCCC,
    0x99CC00, 0xFFCC00, 0xFF9900, 0xFF6600, 0x666699, 0x969696, 0x003366, 0x339966, 0x003300, 0x333300,
    0x993300, 0x993366, 0x333399, 0x333333,
];

pub fn excel_indexed(i: usize) -> Option<Color> {
    match i {
        64 => Some(Color::BLACK),  // couleur système de premier plan
        65 => Some(Color::WHITE),  // couleur système d'arrière-plan
        _ => EXCEL_INDEXED.get(i).map(|&v| Color::rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)),
    }
}

/// Couleurs de surlignage Word (w:highlight).
pub fn highlight_color(name: &str) -> Option<Color> {
    match name {
        "none" => None,
        "darkYellow" => Some(Color::rgb(128, 128, 0)),
        "lightGray" => Some(Color::rgb(192, 192, 192)),
        "darkGray" => Some(Color::rgb(128, 128, 128)),
        _ => named_color(name),
    }
}
