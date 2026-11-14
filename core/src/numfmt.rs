//! Formats numériques Excel / LibreOffice (« # ##0,00 € », « jj/mm/aaaa », « 0,00 % »...).

use crate::color::Color;
use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// Choisit les conventions d'affichage (séparateurs, noms de mois).
pub fn set_english_locale(en: bool) {
    ENGLISH.store(en, Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

fn dec_sep() -> char {
    if is_english() {
        '.'
    } else {
        ','
    }
}

fn thousands_sep() -> char {
    if is_english() {
        ','
    } else {
        '\u{202F}'
    }
}

const MONTHS_FR: [&str; 12] = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_FR_SHORT: [&str; 12] = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTHS_EN: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_FR: [&str; 7] = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const DAYS_EN: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// Format intégré Excel (numFmtId) -> code.
pub fn builtin(id: u32) -> Option<&'static str> {
    let en = is_english();
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        5 => {
            if en {
                "\"$\"#,##0_);(\"$\"#,##0)"
            } else {
                "#,##0 \"€\";-#,##0 \"€\""
            }
        }
        6 => {
            if en {
                "\"$\"#,##0_);[Red](\"$\"#,##0)"
            } else {
                "#,##0 \"€\";[Red]-#,##0 \"€\""
            }
        }
        7 => {
            if en {
                "\"$\"#,##0.00_);(\"$\"#,##0.00)"
            } else {
                "#,##0.00 \"€\";-#,##0.00 \"€\""
            }
        }
        8 => {
            if en {
                "\"$\"#,##0.00_);[Red](\"$\"#,##0.00)"
            } else {
                "#,##0.00 \"€\";[Red]-#,##0.00 \"€\""
            }
        }
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => {
            if en {
                "m/d/yyyy"
            } else {
                "dd/mm/yyyy"
            }
        }
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => {
            if en {
                "m/d/yyyy h:mm"
            } else {
                "dd/mm/yyyy hh:mm"
            }
        }
        27..=36 | 50..=58 => {
            if en {
                "m/d/yyyy"
            } else {
                "dd/mm/yyyy"
            }
        }
        37 => "#,##0_);(#,##0)",
        38 => "#,##0_);[Red](#,##0)",
        39 => "#,##0.00_);(#,##0.00)",
        40 => "#,##0.00_);[Red](#,##0.00)",
        41 => "_(* #,##0_);_(* (#,##0);_(* \"-\"_);_(@_)",
        42 => "_(\"$\"* #,##0_);_(\"$\"* (#,##0);_(\"$\"* \"-\"_);_(@_)",
        43 => "_(* #,##0.00_);_(* (#,##0.00);_(* \"-\"??_);_(@_)",
        44 => "_(\"$\"* #,##0.00_);_(\"$\"* (#,##0.00);_(\"$\"* \"-\"??_);_(@_)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mm:ss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

/// Découpe un code en sections (séparées par « ; » hors guillemets/crochets).
fn sections(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut in_b = false;
    let mut esc = false;
    for ch in code.chars() {
        if esc {
            cur.push(ch);
            esc = false;
            continue;
        }
        match ch {
            '\\' => {
                cur.push(ch);
                esc = true;
            }
            '"' => {
                in_q = !in_q;
                cur.push(ch);
            }
            '[' if !in_q => {
                in_b = true;
                cur.push(ch);
            }
            ']' if !in_q => {
                in_b = false;
                cur.push(ch);
            }
            ';' if !in_q && !in_b => out.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    out.push(cur);
    out
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Lit(String),
    Digit(char), // 0 # ?
    Dot,
    Comma,
    Percent,
    Exp(String), // E+ / E-
    Slash,
    Text,     // @
    Date(String),
    AmPm(String),
    Elapsed(char, usize), // [h] [m] [s]
    Space(char),
}

struct Parsed {
    toks: Vec<Tok>,
    color: Option<Color>,
    cond: Option<(String, f64)>,
}

fn color_name(s: &str) -> Option<Color> {
    let l = s.to_ascii_lowercase();
    match l.as_str() {
        "black" | "noir" => Some(Color::BLACK),
        "red" | "rouge" => Some(Color::rgb(255, 0, 0)),
        "blue" | "bleu" => Some(Color::rgb(0, 0, 255)),
        "green" | "vert" => Some(Color::rgb(0, 128, 0)),
        "white" | "blanc" => Some(Color::WHITE),
        "yellow" | "jaune" => Some(Color::rgb(255, 255, 0)),
        "magenta" => Some(Color::rgb(255, 0, 255)),
        "cyan" => Some(Color::rgb(0, 255, 255)),
        _ => l.strip_prefix("color").and_then(|n| n.trim().parse::<usize>().ok()).and_then(|n| crate::color::excel_indexed(n.saturating_sub(1) + 8)),
    }
}

fn parse_section(s: &str) -> Parsed {
    let mut toks = Vec::new();
    let mut color = None;
    let mut cond = None;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let push_lit = |toks: &mut Vec<Tok>, t: &str| {
        if let Some(Tok::Lit(prev)) = toks.last_mut() {
            prev.push_str(t);
        } else {
            toks.push(Tok::Lit(t.to_string()));
        }
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                let mut j = i + 1;
                let mut lit = String::new();
                while j < chars.len() && chars[j] != '"' {
                    lit.push(chars[j]);
                    j += 1;
                }
                push_lit(&mut toks, &lit);
                i = j + 1;
                continue;
            }
            '\\' => {
                if i + 1 < chars.len() {
                    push_lit(&mut toks, &chars[i + 1].to_string());
                }
                i += 2;
                continue;
            }
            '_' => {
                if i + 1 < chars.len() {
                    toks.push(Tok::Space(chars[i + 1]));
                }
                i += 2;
                continue;
            }
            '*' => {
                i += 2;
                continue;
            }
            '[' => {
                let mut j = i + 1;
                let mut inner = String::new();
                while j < chars.len() && chars[j] != ']' {
                    inner.push(chars[j]);
                    j += 1;
                }
                i = j + 1;
                let lower = inner.to_ascii_lowercase();
                if let Some(rest) = inner.strip_prefix('$') {
                    // [$€-40C] : symbole monétaire
                    let sym = rest.split('-').next().unwrap_or("");
                    if !sym.is_empty() {
                        push_lit(&mut toks, sym);
                    }
                } else if lower == "h" || lower == "hh" || lower == "m" || lower == "mm" || lower == "s" || lower == "ss" {
                    toks.push(Tok::Elapsed(lower.chars().next().unwrap(), lower.len()));
                } else if inner.starts_with('<') || inner.starts_with('>') || inner.starts_with('=') {
                    let op: String = inner.chars().take_while(|c| "<>=".contains(*c)).collect();
                    let v: f64 = inner[op.len()..].trim().parse().unwrap_or(0.0);
                    cond = Some((op, v));
                } else if let Some(col) = color_name(&inner) {
                    color = Some(col);
                }
                continue;
            }
            '0' | '#' | '?' => toks.push(Tok::Digit(c)),
            '.' => toks.push(Tok::Dot),
            ',' => toks.push(Tok::Comma),
            '%' => toks.push(Tok::Percent),
            '/' => {
                // fraction si précédé de chiffres
                if toks.iter().any(|t| matches!(t, Tok::Digit(_))) && !toks.iter().any(|t| matches!(t, Tok::Date(_))) {
                    toks.push(Tok::Slash);
                } else {
                    push_lit(&mut toks, "/");
                }
            }
            '@' => toks.push(Tok::Text),
            'E' | 'e' if i + 1 < chars.len() && (chars[i + 1] == '+' || chars[i + 1] == '-') => {
                toks.push(Tok::Exp(chars[i + 1].to_string()));
                i += 2;
                continue;
            }
            'A' | 'a' if s[s.char_indices().nth(i).map(|x| x.0).unwrap_or(0)..].to_ascii_uppercase().starts_with("AM/PM") => {
                toks.push(Tok::AmPm("AM/PM".into()));
                i += 5;
                continue;
            }
            'A' | 'a' if s[s.char_indices().nth(i).map(|x| x.0).unwrap_or(0)..].to_ascii_uppercase().starts_with("A/P") => {
                toks.push(Tok::AmPm("A/P".into()));
                i += 3;
                continue;
            }
            'y' | 'Y' | 'm' | 'M' | 'd' | 'D' | 'h' | 'H' | 's' | 'S' | 'j' | 'J' | 'a' => {
                let lc = c.to_ascii_lowercase();
                let lc = match lc {
                    'j' => 'd', // jour (codes français)
                    'a' => 'y', // année (codes français « aaaa »)
                    x => x,
                };
                let mut j = i;
                while j < chars.len() && {
                    let x = chars[j].to_ascii_lowercase();
                    let x = match x {
                        'j' => 'd',
                        'a' => 'y',
                        o => o,
                    };
                    x == lc
                } {
                    j += 1;
                }
                let n = j - i;
                toks.push(Tok::Date(std::iter::repeat_n(lc, n).collect()));
                i = j;
                continue;
            }
            'G' | 'g' if s[s.char_indices().nth(i).map(|x| x.0).unwrap_or(0)..].to_ascii_lowercase().starts_with("general") => {
                toks.push(Tok::Lit("\u{1}GENERAL".into()));
                i += 7;
                continue;
            }
            ' ' => push_lit(&mut toks, " "),
            _ => push_lit(&mut toks, &c.to_string()),
        }
        i += 1;
    }
    Parsed { toks, color, cond }
}

/// Convertit un numéro de série Excel en (année, mois, jour, heure, minute, seconde, jour de semaine).
pub fn serial_to_datetime(v: f64, date1904: bool) -> (i64, u32, u32, u32, u32, f64, u32) {
    let mut days = v.floor() as i64;
    let mut frac = v - v.floor();
    if frac > 0.999_999_99 {
        days += 1;
        frac = 0.0;
    }
    let (y, m, d, wd) = if date1904 {
        let (y, m, d) = civil_from_days(days + days_from_civil(1904, 1, 1));
        (y, m, d, ((days + 5).rem_euclid(7)) as u32)
    } else if days == 60 {
        (1900, 2, 29, 3)
    } else {
        let adj = if days < 60 { days + 1 } else { days };
        let (y, m, d) = civil_from_days(adj + days_from_civil(1899, 12, 30));
        (y, m, d, ((days + 6).rem_euclid(7)) as u32)
    };
    let total = frac * 86400.0;
    let secs = total.round();
    let h = (secs / 3600.0).floor() as u32;
    let mi = ((secs - h as f64 * 3600.0) / 60.0).floor() as u32;
    let s = total - h as f64 * 3600.0 - mi as f64 * 60.0;
    (y, m, d, h, mi, s.max(0.0), wd)
}

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = (m as u64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Convertit une date ISO (« 2026-11-14T10:30:00 ») en numéro de série Excel.
pub fn iso_to_serial(s: &str) -> Option<f64> {
    let (date, time) = match s.find('T') {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let mut it = date.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next().unwrap_or("1").get(..2).unwrap_or("1").parse().ok()?;
    let days = days_from_civil(y, m, d) - days_from_civil(1899, 12, 30);
    let mut v = days as f64;
    if let Some(t) = time {
        let mut p = t.trim_end_matches('Z').split(':');
        let h: f64 = p.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
        let mi: f64 = p.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
        let se: f64 = p.next().and_then(|x| x.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.').parse().ok()).unwrap_or(0.0);
        v += (h * 3600.0 + mi * 60.0 + se) / 86400.0;
    }
    Some(v)
}

/// Format « Standard » : jusqu'à 10 chiffres significatifs.
pub fn general(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    if !v.is_finite() {
        return "#NOMBRE!".into();
    }
    let a = v.abs();
    let s = if !(1e-9..1e11).contains(&a) {
        let s = format!("{:.5E}", v);
        // 1.23450E11 -> 1,2345E+11
        let (mant, exp) = s.split_once('E').unwrap_or((&s, "0"));
        let mant = mant.trim_end_matches('0').trim_end_matches('.');
        let e: i32 = exp.parse().unwrap_or(0);
        format!("{}E{}{:02}", mant, if e < 0 { '-' } else { '+' }, e.abs())
    } else {
        let digits_before = if a >= 1.0 { a.log10().floor() as i32 + 1 } else { 1 };
        let decimals = (10 - digits_before).clamp(0, 10) as usize;
        let s = format!("{:.*}", decimals, v);
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            s
        }
    };
    s.replace('.', &dec_sep().to_string())
}

fn group_thousands(int_part: &str) -> String {
    let bytes: Vec<char> = int_part.chars().collect();
    let mut out = String::new();
    let n = bytes.len();
    for (i, c) in bytes.iter().enumerate() {
        out.push(*c);
        let rem = n - i - 1;
        if rem > 0 && rem % 3 == 0 {
            out.push(thousands_sep());
        }
    }
    out
}

fn format_number_section(v: f64, toks: &[Tok], show_minus: bool) -> String {
    // pourcentage, mise à l'échelle par virgules finales
    let mut v = v;
    let percents = toks.iter().filter(|t| **t == Tok::Percent).count();
    for _ in 0..percents {
        v *= 100.0;
    }
    // virgules de mise à l'échelle (après le dernier chiffre de la partie entière)
    let last_digit = toks.iter().rposition(|t| matches!(t, Tok::Digit(_)));
    let dot = toks.iter().position(|t| *t == Tok::Dot);
    let mut scale_commas = 0;
    if let Some(ld) = last_digit {
        let mut k = ld + 1;
        while k < toks.len() && toks[k] == Tok::Comma && dot.map(|d| k < d || d < ld).unwrap_or(true) {
            scale_commas += 1;
            k += 1;
        }
    }
    for _ in 0..scale_commas {
        v /= 1000.0;
    }
    let has_exp = toks.iter().position(|t| matches!(t, Tok::Exp(_)));
    let has_slash = toks.iter().position(|t| *t == Tok::Slash);
    let neg = v < 0.0;
    let a = v.abs();
    let int_end = dot.or(has_exp).or(has_slash).unwrap_or(toks.len());
    let int_digits: Vec<char> = toks[..int_end].iter().filter_map(|t| if let Tok::Digit(c) = t { Some(*c) } else { None }).collect();
    let thousands = toks[..int_end].iter().enumerate().any(|(i, t)| *t == Tok::Comma && toks[..i].iter().any(|x| matches!(x, Tok::Digit(_))) && toks[i + 1..int_end].iter().any(|x| matches!(x, Tok::Digit(_))));
    let frac_digits: Vec<char> = match dot {
        Some(d) => toks[d + 1..has_exp.unwrap_or(toks.len())].iter().filter_map(|t| if let Tok::Digit(c) = t { Some(*c) } else { None }).collect(),
        None => Vec::new(),
    };

    // fractions « # ?/? »
    if let Some(sl) = has_slash {
        let den_digits = toks[sl + 1..].iter().filter(|t| matches!(t, Tok::Digit(_))).count().max(1);
        let whole_part = toks[..sl].iter().any(|t| matches!(t, Tok::Lit(l) if l.contains(' ')));
        let (w, f) = if whole_part { (a.floor(), a - a.floor()) } else { (0.0, a) };
        let maxd = 10u64.pow(den_digits as u32) - 1;
        let (mut bn, mut bd, mut be) = (0u64, 1u64, f64::MAX);
        for d in 1..=maxd {
            let n = (f * d as f64).round() as u64;
            let e = (f - n as f64 / d as f64).abs();
            if e < be - 1e-12 {
                be = e;
                bn = n;
                bd = d;
            }
        }
        let mut s = String::new();
        if neg && show_minus {
            s.push('-');
        }
        if whole_part && w > 0.0 {
            s.push_str(&format!("{} ", w as i64));
        }
        if bn == 0 && whole_part && w > 0.0 {
            return s.trim_end().to_string();
        }
        s.push_str(&format!("{bn}/{bd}"));
        return s;
    }

    // notation scientifique
    let (mantissa, exponent) = if has_exp.is_some() {
        if a == 0.0 {
            (0.0, 0)
        } else {
            let int_n = int_digits.len().max(1) as i32;
            let mut e = a.log10().floor() as i32;
            // groupes d'exposant (##0.0E+0)
            if int_n > 1 && int_digits.contains(&'#') {
                e = (e as f64 / int_n as f64).floor() as i32 * int_n;
            } else {
                e -= int_n - 1;
            }
            (a / 10f64.powi(e), e)
        }
    } else {
        (a, 0)
    };
    let nfrac = frac_digits.len();
    let rounded = format!("{:.*}", nfrac, mantissa);
    let (ip, fp) = match rounded.split_once('.') {
        Some((i, f)) => (i.to_string(), f.to_string()),
        None => (rounded.clone(), String::new()),
    };
    // partie entière
    let min_int = int_digits.iter().filter(|c| **c == '0').count();
    let mut ip = ip.trim_start_matches('0').to_string();
    if ip.len() < min_int {
        ip = "0".repeat(min_int - ip.len()) + &ip;
    }
    if int_digits.is_empty() {
        ip.clear();
    }
    let qmarks = int_digits.iter().filter(|c| **c == '?').count();
    let ip = if thousands { group_thousands(&ip) } else { ip };
    let ip = if ip.is_empty() && qmarks > 0 { " ".repeat(qmarks) } else { ip };
    // partie décimale : on retire les zéros non obligatoires
    let mut fp: Vec<char> = fp.chars().collect();
    let mut k = fp.len();
    while k > 0 && frac_digits.get(k - 1).map(|c| *c != '0').unwrap_or(false) && fp[k - 1] == '0' {
        k -= 1;
        if frac_digits[k] == '?' {
            fp[k] = ' ';
        } else {
            fp.truncate(k);
        }
    }
    let fp: String = fp.into_iter().collect();

    // reconstruction avec les littéraux
    let mut out = String::new();
    if neg && show_minus && (a * 10f64.powi(nfrac as i32)).round() != 0.0 {
        out.push('-');
    }
    let mut int_written = false;
    let mut frac_written = false;
    let mut exp_written = false;
    for (idx, t) in toks.iter().enumerate() {
        match t {
            Tok::Lit(l) => out.push_str(l),
            Tok::Space(_) => out.push(' '),
            Tok::Percent => out.push('%'),
            Tok::Digit(_) => {
                if has_exp.map(|e| idx > e).unwrap_or(false) {
                    if !exp_written {
                        let ndig = toks[idx..].iter().filter(|t| matches!(t, Tok::Digit(_))).count();
                        out.push_str(&format!("{:0width$}", exponent.abs(), width = ndig));
                        exp_written = true;
                    }
                } else if dot.map(|d| idx > d).unwrap_or(false) {
                    if !frac_written {
                        out.push_str(&fp);
                        frac_written = true;
                    }
                } else if !int_written {
                    out.push_str(&ip);
                    int_written = true;
                }
            }
            Tok::Dot => {
                if !fp.trim().is_empty() || frac_digits.contains(&'0') || frac_digits.contains(&'?') {
                    out.push(dec_sep());
                }
            }
            Tok::Exp(sign) => {
                out.push('E');
                if exponent < 0 {
                    out.push('-');
                } else if sign == "+" {
                    out.push('+');
                }
            }
            Tok::Comma | Tok::Slash | Tok::Text | Tok::Date(_) | Tok::AmPm(_) | Tok::Elapsed(_, _) => {}
        }
    }
    out
}

fn format_date(v: f64, toks: &[Tok], date1904: bool) -> String {
    let has_ampm = toks.iter().any(|t| matches!(t, Tok::AmPm(_)));
    // précision des fractions de seconde
    let (y, mo, d, h, mi, s, wd) = serial_to_datetime(v, date1904);
    let en = is_english();
    let mut out = String::new();
    for (i, t) in toks.iter().enumerate() {
        match t {
            Tok::Lit(l) => out.push_str(l),
            Tok::Space(_) => out.push(' '),
            Tok::Date(code) => {
                let c = code.chars().next().unwrap();
                let n = code.len();
                match c {
                    'y' => {
                        if n <= 2 {
                            out.push_str(&format!("{:02}", y.rem_euclid(100)))
                        } else {
                            out.push_str(&format!("{y:04}"))
                        }
                    }
                    'm' => {
                        // minutes si précédé d'heures ou suivi de secondes
                        let prev_h = toks[..i].iter().rev().find(|t| matches!(t, Tok::Date(_) | Tok::Elapsed(_, _))).map(|t| matches!(t, Tok::Date(c) if c.starts_with('h')) || matches!(t, Tok::Elapsed('h', _))).unwrap_or(false);
                        let next_s = toks[i + 1..].iter().find(|t| matches!(t, Tok::Date(_))).map(|t| matches!(t, Tok::Date(c) if c.starts_with('s'))).unwrap_or(false);
                        if (prev_h || next_s) && n <= 2 {
                            out.push_str(&if n == 2 { format!("{mi:02}") } else { mi.to_string() });
                        } else {
                            let idx = (mo as usize).clamp(1, 12) - 1;
                            match n {
                                1 => out.push_str(&mo.to_string()),
                                2 => out.push_str(&format!("{mo:02}")),
                                3 => out.push_str(if en { &MONTHS_EN[idx][..3] } else { MONTHS_FR_SHORT[idx] }),
                                5 => out.push_str(&(if en { MONTHS_EN[idx] } else { MONTHS_FR[idx] })[..1].to_uppercase()),
                                _ => out.push_str(if en { MONTHS_EN[idx] } else { MONTHS_FR[idx] }),
                            }
                        }
                    }
                    'd' => match n {
                        1 => out.push_str(&d.to_string()),
                        2 => out.push_str(&format!("{d:02}")),
                        3 => {
                            let name = if en { DAYS_EN[wd as usize] } else { DAYS_FR[wd as usize] };
                            out.push_str(&name[..3]);
                            if !en {
                                out.push('.');
                            }
                        }
                        _ => out.push_str(if en { DAYS_EN[wd as usize] } else { DAYS_FR[wd as usize] }),
                    },
                    'h' => {
                        let hh = if has_ampm {
                            let x = h % 12;
                            if x == 0 {
                                12
                            } else {
                                x
                            }
                        } else {
                            h
                        };
                        out.push_str(&if n >= 2 { format!("{hh:02}") } else { hh.to_string() });
                    }
                    's' => {
                        let si = s.floor() as u32;
                        out.push_str(&if n >= 2 { format!("{si:02}") } else { si.to_string() });
                    }
                    _ => {}
                }
            }
            Tok::Dot => {
                // fractions de seconde
                let nd = toks[i + 1..].iter().take_while(|t| matches!(t, Tok::Digit('0'))).count();
                if nd > 0 {
                    let frac = s - s.floor();
                    let f = format!("{:.*}", nd, frac);
                    out.push(dec_sep());
                    out.push_str(f.split('.').nth(1).unwrap_or(""));
                } else {
                    out.push('.');
                }
            }
            Tok::Digit(_) => {}
            Tok::AmPm(k) => {
                let pm = h >= 12;
                out.push_str(match (k.as_str(), pm) {
                    ("A/P", false) => "A",
                    ("A/P", true) => "P",
                    (_, false) => "AM",
                    (_, true) => "PM",
                });
            }
            Tok::Elapsed(c, n) => {
                let total = v * 86400.0;
                let val = match c {
                    'h' => (total / 3600.0).floor() as i64,
                    'm' => (total / 60.0).floor() as i64,
                    _ => total.round() as i64,
                };
                out.push_str(&format!("{:0width$}", val, width = *n));
            }
            Tok::Percent => out.push('%'),
            Tok::Comma => out.push(','),
            _ => {}
        }
    }
    out
}

fn is_date_section(toks: &[Tok]) -> bool {
    toks.iter().any(|t| matches!(t, Tok::Date(_) | Tok::Elapsed(_, _) | Tok::AmPm(_)))
}

/// Indique si un code de format représente une date ou une heure.
pub fn is_date_format(code: &str) -> bool {
    let secs = sections(code);
    secs.first().map(|s| is_date_section(&parse_section(s).toks)).unwrap_or(false)
}

/// Formate une valeur numérique ; renvoie le texte et une éventuelle couleur.
pub fn format_value(v: f64, code: &str, date1904: bool) -> (String, Option<Color>) {
    let code = code.trim();
    if code.is_empty() || code.eq_ignore_ascii_case("general") || code.eq_ignore_ascii_case("standard") {
        return (general(v), None);
    }
    let secs: Vec<Parsed> = sections(code).iter().map(|s| parse_section(s)).collect();
    // choix de la section
    let has_conds = secs.iter().any(|p| p.cond.is_some());
    let (idx, show_minus) = if has_conds {
        let mut chosen = None;
        for (i, p) in secs.iter().enumerate() {
            if let Some((op, c)) = &p.cond {
                let ok = match op.as_str() {
                    "<" => v < *c,
                    "<=" => v <= *c,
                    ">" => v > *c,
                    ">=" => v >= *c,
                    "=" => v == *c,
                    "<>" => v != *c,
                    _ => false,
                };
                if ok {
                    chosen = Some(i);
                    break;
                }
            } else if chosen.is_none() {
                chosen = Some(i);
                break;
            }
        }
        (chosen.unwrap_or(0), true)
    } else if v < 0.0 && secs.len() >= 2 {
        (1, false)
    } else if v == 0.0 && secs.len() >= 3 {
        (2, true)
    } else {
        (0, true)
    };
    let p = &secs[idx.min(secs.len() - 1)];
    if p.toks.iter().any(|t| matches!(t, Tok::Lit(l) if l == "\u{1}GENERAL")) {
        let mut s = String::new();
        for t in &p.toks {
            match t {
                Tok::Lit(l) if l == "\u{1}GENERAL" => s.push_str(&general(if show_minus { v } else { v.abs() })),
                Tok::Lit(l) => s.push_str(l),
                Tok::Space(_) => s.push(' '),
                _ => {}
            }
        }
        return (s, p.color);
    }
    let text = if is_date_section(&p.toks) {
        if v < 0.0 {
            "#######".to_string()
        } else {
            format_date(v, &p.toks, date1904)
        }
    } else if !p.toks.iter().any(|t| matches!(t, Tok::Digit(_))) {
        // section purement littérale (« "-" »)
        let mut s = String::new();
        for t in &p.toks {
            match t {
                Tok::Lit(l) => s.push_str(l),
                Tok::Space(_) => s.push(' '),
                Tok::Percent => s.push('%'),
                _ => {}
            }
        }
        if s.trim().is_empty() && idx == 0 {
            general(v)
        } else {
            s
        }
    } else {
        format_number_section(v, &p.toks, show_minus)
    };
    (text, p.color)
}

/// Applique la section texte d'un format à une chaîne (« @ »).
pub fn format_text(s: &str, code: &str) -> String {
    let secs = sections(code);
    let sec = if secs.len() >= 4 {
        &secs[3]
    } else if secs.len() == 1 && secs[0].contains('@') {
        &secs[0]
    } else {
        return s.to_string();
    };
    let p = parse_section(sec);
    let mut out = String::new();
    for t in &p.toks {
        match t {
            Tok::Text => out.push_str(s),
            Tok::Lit(l) => out.push_str(l),
            Tok::Space(_) => out.push(' '),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats() {
        set_english_locale(false);
        assert_eq!(format_value(1234.5, "#,##0.00", false).0, "1\u{202F}234,50");
        assert_eq!(format_value(0.1234, "0.00%", false).0, "12,34%");
        assert_eq!(format_value(46340.0, "dd/mm/yyyy", false).0, "14/11/2026");
        assert_eq!(format_value(-5.0, "#,##0.00 \"€\";[Red]-#,##0.00 \"€\"", false).0, "-5,00 €");
        assert_eq!(format_value(12.5, "#,##0.00\\ \"€\"", false).0, "12,50 €");
        assert_eq!(format_value(0.5, "h:mm", false).0, "12:00");
        assert_eq!(format_value(1.5, "[h]:mm:ss", false).0, "36:00:00");
        assert_eq!(format_value(123456789.0, "General", false).0, "123456789");
        assert_eq!(format_value(0.333333333333, "General", false).0, "0,333333333");
        assert_eq!(format_value(1.0 / 3.0, "0.0", false).0, "0,3");
        assert_eq!(format_value(12345.678, "0.00E+00", false).0, "1,23E+04");
        assert_eq!(format_value(46340.0, "d mmmm yyyy", false).0, "14 novembre 2026");
        assert_eq!(format_value(1.25, "# ?/?", false).0, "1 1/4");
        assert_eq!(format_value(0.0, "#,##0.00;-#,##0.00;\"-\"", false).0, "-");
        assert_eq!(format_value(3.0, "000", false).0, "003");
    }
}
