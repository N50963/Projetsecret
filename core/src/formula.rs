//! Évaluation de formules simples pour les classeurs enregistrés sans valeurs
//! calculées (fichiers générés par programme). Les valeurs en cache restent prioritaires.

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Num(f64),
    Str(String),
    Bool(bool),
    Err(String),
    Empty,
    List(Vec<V>),
}

impl V {
    pub fn num(&self) -> Option<f64> {
        match self {
            V::Num(n) => Some(*n),
            V::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            V::Empty => Some(0.0),
            V::Str(s) => s.trim().replace(',', ".").parse().ok(),
            V::List(l) => l.first().and_then(|v| v.num()),
            V::Err(_) => None,
        }
    }
    fn text(&self) -> String {
        match self {
            V::Num(n) => crate::numfmt::general(*n),
            V::Str(s) => s.clone(),
            V::Bool(b) => crate::ooxml::xlsx::bool_text(*b),
            V::Err(e) => e.clone(),
            V::Empty => String::new(),
            V::List(l) => l.first().map(|v| v.text()).unwrap_or_default(),
        }
    }
    fn truthy(&self) -> bool {
        match self {
            V::Bool(b) => *b,
            V::Str(s) => !s.is_empty(),
            other => other.num().map(|n| n != 0.0).unwrap_or(false),
        }
    }
    fn flatten(self, out: &mut Vec<V>) {
        match self {
            V::List(l) => {
                for v in l {
                    v.flatten(out);
                }
            }
            v => out.push(v),
        }
    }
}

/// Valeurs des cellules : feuille (minuscules) -> (ligne, colonne) -> valeur.
pub type Values = HashMap<String, HashMap<(u32, u32), V>>;

#[derive(Clone, Debug, PartialEq)]
enum T {
    Num(f64),
    Str(String),
    Ref(Option<String>, String),
    Name(String),
    Op(String),
    LParen,
    RParen,
    Comma,
}

fn tokenize(f: &str) -> Option<Vec<T>> {
    let c: Vec<char> = f.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && i + 1 < c.len() && c[i + 1].is_ascii_digit()) {
            let st = i;
            while i < c.len() && (c[i].is_ascii_digit() || c[i] == '.' || ((c[i] == 'E' || c[i] == 'e') && i + 1 < c.len() && (c[i + 1].is_ascii_digit() || c[i + 1] == '-' || c[i + 1] == '+'))) {
                if (c[i] == 'E' || c[i] == 'e') && (c[i + 1] == '-' || c[i + 1] == '+') {
                    i += 1;
                }
                i += 1;
            }
            out.push(T::Num(c[st..i].iter().collect::<String>().parse().ok()?));
            continue;
        }
        match ch {
            '"' => {
                let mut s = String::new();
                i += 1;
                while i < c.len() {
                    if c[i] == '"' {
                        if i + 1 < c.len() && c[i + 1] == '"' {
                            s.push('"');
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    s.push(c[i]);
                    i += 1;
                }
                i += 1;
                out.push(T::Str(s));
            }
            '(' => {
                out.push(T::LParen);
                i += 1;
            }
            ')' => {
                out.push(T::RParen);
                i += 1;
            }
            ',' | ';' => {
                out.push(T::Comma);
                i += 1;
            }
            '+' | '-' | '*' | '/' | '^' | '&' | '%' | '=' => {
                out.push(T::Op(ch.to_string()));
                i += 1;
            }
            '<' | '>' => {
                if i + 1 < c.len() && (c[i + 1] == '=' || (ch == '<' && c[i + 1] == '>')) {
                    out.push(T::Op(format!("{}{}", ch, c[i + 1])));
                    i += 2;
                } else {
                    out.push(T::Op(ch.to_string()));
                    i += 1;
                }
            }
            '\'' => {
                // 'Feuille 1'!A1
                let mut s = String::new();
                i += 1;
                while i < c.len() && c[i] != '\'' {
                    s.push(c[i]);
                    i += 1;
                }
                i += 1;
                if i < c.len() && c[i] == '!' {
                    i += 1;
                    let st = i;
                    while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '$' || c[i] == ':') {
                        i += 1;
                    }
                    out.push(T::Ref(Some(s), c[st..i].iter().collect()));
                } else {
                    return None;
                }
            }
            _ if ch.is_alphabetic() || ch == '_' || ch == '$' => {
                let st = i;
                while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_' || c[i] == '$' || c[i] == '.' || c[i] == ':') {
                    i += 1;
                }
                let word: String = c[st..i].iter().collect();
                if i < c.len() && c[i] == '!' {
                    i += 1;
                    let st2 = i;
                    while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '$' || c[i] == ':') {
                        i += 1;
                    }
                    out.push(T::Ref(Some(word), c[st2..i].iter().collect()));
                } else if is_ref(&word) {
                    out.push(T::Ref(None, word));
                } else {
                    out.push(T::Name(word.to_uppercase()));
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

fn is_ref(w: &str) -> bool {
    w.split(':').all(|p| crate::ooxml::xlsx::parse_ref(p).is_some())
}

struct Parser<'a> {
    t: Vec<T>,
    i: usize,
    vals: &'a Values,
    sheet: String,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&T> {
        self.t.get(self.i)
    }
    fn next(&mut self) -> Option<T> {
        let t = self.t.get(self.i).cloned();
        self.i += 1;
        t
    }
    fn lookup(&self, sheet: &str, r: &str) -> V {
        let s = sheet.to_lowercase();
        let Some(map) = self.vals.get(&s) else { return V::Err("#REF!".into()) };
        if let Some((a, b)) = r.split_once(':') {
            let (Some((r1, c1)), Some((r2, c2))) = (crate::ooxml::xlsx::parse_ref(a), crate::ooxml::xlsx::parse_ref(b)) else { return V::Err("#REF!".into()) };
            let mut out = Vec::new();
            for rr in r1.min(r2)..=r1.max(r2).min(r1.min(r2) + 100_000) {
                for cc in c1.min(c2)..=c1.max(c2).min(c1.min(c2) + 1000) {
                    out.push(map.get(&(rr, cc)).cloned().unwrap_or(V::Empty));
                }
            }
            return V::List(out);
        }
        match crate::ooxml::xlsx::parse_ref(r) {
            Some(k) => map.get(&k).cloned().unwrap_or(V::Empty),
            None => V::Err("#REF!".into()),
        }
    }
    fn expr(&mut self) -> V {
        self.depth += 1;
        if self.depth > 200 {
            return V::Err("#VALUE!".into());
        }
        let v = self.comparison();
        self.depth -= 1;
        v
    }
    fn comparison(&mut self) -> V {
        let mut a = self.concat();
        while let Some(T::Op(op)) = self.peek().cloned() {
            if !matches!(op.as_str(), "=" | "<>" | "<" | ">" | "<=" | ">=") {
                break;
            }
            self.next();
            let b = self.concat();
            let ord = match (a.num(), b.num(), &a, &b) {
                (_, _, V::Str(x), V::Str(y)) => x.to_lowercase().partial_cmp(&y.to_lowercase()),
                (Some(x), Some(y), _, _) => x.partial_cmp(&y),
                _ => a.text().partial_cmp(&b.text()),
            };
            let Some(o) = ord else { return V::Err("#VALUE!".into()) };
            use std::cmp::Ordering::*;
            a = V::Bool(match op.as_str() {
                "=" => o == Equal,
                "<>" => o != Equal,
                "<" => o == Less,
                ">" => o == Greater,
                "<=" => o != Greater,
                _ => o != Less,
            });
        }
        a
    }
    fn concat(&mut self) -> V {
        let mut a = self.additive();
        while self.peek() == Some(&T::Op("&".into())) {
            self.next();
            let b = self.additive();
            a = V::Str(a.text() + &b.text());
        }
        a
    }
    fn additive(&mut self) -> V {
        let mut a = self.term();
        while let Some(T::Op(op)) = self.peek().cloned() {
            if op != "+" && op != "-" {
                break;
            }
            self.next();
            let b = self.term();
            a = match (a.num(), b.num()) {
                (Some(x), Some(y)) => V::Num(if op == "+" { x + y } else { x - y }),
                _ => V::Err("#VALUE!".into()),
            };
        }
        a
    }
    fn term(&mut self) -> V {
        let mut a = self.power();
        while let Some(T::Op(op)) = self.peek().cloned() {
            if op != "*" && op != "/" {
                break;
            }
            self.next();
            let b = self.power();
            a = match (a.num(), b.num()) {
                (Some(_), Some(y)) if op == "/" && y == 0.0 => V::Err("#DIV/0!".into()),
                (Some(x), Some(y)) => V::Num(if op == "*" { x * y } else { x / y }),
                _ => V::Err("#VALUE!".into()),
            };
        }
        a
    }
    fn power(&mut self) -> V {
        let a = self.unary();
        if self.peek() == Some(&T::Op("^".into())) {
            self.next();
            let b = self.power();
            return match (a.num(), b.num()) {
                (Some(x), Some(y)) => V::Num(x.powf(y)),
                _ => V::Err("#VALUE!".into()),
            };
        }
        a
    }
    fn unary(&mut self) -> V {
        match self.peek() {
            Some(T::Op(o)) if o == "-" => {
                self.next();
                let v = self.unary();
                v.num().map(|n| V::Num(-n)).unwrap_or(V::Err("#VALUE!".into()))
            }
            Some(T::Op(o)) if o == "+" => {
                self.next();
                self.unary()
            }
            _ => {
                let v = self.primary();
                if self.peek() == Some(&T::Op("%".into())) {
                    self.next();
                    return v.num().map(|n| V::Num(n / 100.0)).unwrap_or(V::Err("#VALUE!".into()));
                }
                v
            }
        }
    }
    fn primary(&mut self) -> V {
        match self.next() {
            Some(T::Num(n)) => V::Num(n),
            Some(T::Str(s)) => V::Str(s),
            Some(T::Ref(sheet, r)) => {
                let s = sheet.unwrap_or_else(|| self.sheet.clone());
                self.lookup(&s, &r.replace('$', ""))
            }
            Some(T::LParen) => {
                let v = self.expr();
                self.next();
                v
            }
            Some(T::Name(n)) => {
                if self.peek() == Some(&T::LParen) {
                    self.next();
                    let mut args = Vec::new();
                    if self.peek() != Some(&T::RParen) {
                        loop {
                            if matches!(self.peek(), Some(T::Comma)) {
                                args.push(V::Empty);
                            } else {
                                args.push(self.expr());
                            }
                            match self.next() {
                                Some(T::Comma) => continue,
                                _ => break,
                            }
                        }
                    } else {
                        self.next();
                    }
                    call(&n, args)
                } else {
                    match n.as_str() {
                        "TRUE" | "VRAI" => V::Bool(true),
                        "FALSE" | "FAUX" => V::Bool(false),
                        _ => V::Err("#NAME?".into()),
                    }
                }
            }
            _ => V::Err("#VALUE!".into()),
        }
    }
}

fn nums(args: Vec<V>) -> Vec<f64> {
    let mut flat = Vec::new();
    for a in args {
        a.flatten(&mut flat);
    }
    flat.iter().filter_map(|v| if let V::Num(n) = v { Some(*n) } else { None }).collect()
}

fn round_to(x: f64, d: f64, mode: i8) -> f64 {
    let m = 10f64.powi(d as i32);
    // correction des erreurs binaires (2,345 × 100 = 234,4999…)
    let v = ((x * m) * 1e9).round() / 1e9;
    let r = match mode {
        0 => (v.abs() + 0.5).floor() * v.signum(),
        1 => v.abs().ceil() * v.signum(),
        _ => v.abs().floor() * v.signum(),
    };
    r / m
}

fn call(name: &str, args: Vec<V>) -> V {
    let name = name.trim_start_matches("_XLFN.");
    let arg = |i: usize| args.get(i).cloned().unwrap_or(V::Empty);
    if let Some(e) = args.iter().find(|a| matches!(a, V::Err(_))) {
        if !matches!(name, "IFERROR" | "ISERROR" | "IFNA") {
            return e.clone();
        }
    }
    match name {
        "SUM" | "SOMME" => V::Num(nums(args).iter().sum()),
        "AVERAGE" | "MOYENNE" => {
            let n = nums(args);
            if n.is_empty() {
                V::Err("#DIV/0!".into())
            } else {
                V::Num(n.iter().sum::<f64>() / n.len() as f64)
            }
        }
        "MIN" => V::Num(nums(args).into_iter().fold(f64::INFINITY, f64::min)).clean(),
        "MAX" => V::Num(nums(args).into_iter().fold(f64::NEG_INFINITY, f64::max)).clean(),
        "PRODUCT" | "PRODUIT" => V::Num(nums(args).iter().product()),
        "COUNT" | "NB" => V::Num(nums(args).len() as f64),
        "COUNTA" | "NBVAL" => {
            let mut flat = Vec::new();
            for a in args {
                a.flatten(&mut flat);
            }
            V::Num(flat.iter().filter(|v| !matches!(v, V::Empty)).count() as f64)
        }
        "IF" | "SI" => {
            if arg(0).truthy() {
                arg(1)
            } else if args.len() > 2 {
                arg(2)
            } else {
                V::Bool(false)
            }
        }
        "IFERROR" | "SIERREUR" => {
            if matches!(arg(0), V::Err(_)) {
                arg(1)
            } else {
                arg(0)
            }
        }
        "AND" | "ET" => {
            let mut flat = Vec::new();
            for a in args {
                a.flatten(&mut flat);
            }
            V::Bool(flat.iter().all(|v| v.truthy()))
        }
        "OR" | "OU" => {
            let mut flat = Vec::new();
            for a in args {
                a.flatten(&mut flat);
            }
            V::Bool(flat.iter().any(|v| v.truthy()))
        }
        "NOT" | "NON" => V::Bool(!arg(0).truthy()),
        "ROUND" | "ARRONDI" => V::Num(round_to(arg(0).num().unwrap_or(0.0), arg(1).num().unwrap_or(0.0), 0)),
        "ROUNDUP" | "ARRONDI.SUP" => V::Num(round_to(arg(0).num().unwrap_or(0.0), arg(1).num().unwrap_or(0.0), 1)),
        "ROUNDDOWN" | "ARRONDI.INF" | "TRUNC" | "TRONQUE" => V::Num(round_to(arg(0).num().unwrap_or(0.0), arg(1).num().unwrap_or(0.0), 2)),
        "INT" | "ENT" => V::Num(arg(0).num().unwrap_or(0.0).floor()),
        "ABS" => V::Num(arg(0).num().unwrap_or(0.0).abs()),
        "SQRT" | "RACINE" => V::Num(arg(0).num().unwrap_or(0.0).sqrt()),
        "POWER" | "PUISSANCE" => V::Num(arg(0).num().unwrap_or(0.0).powf(arg(1).num().unwrap_or(1.0))),
        "MOD" => {
            let (a, b) = (arg(0).num().unwrap_or(0.0), arg(1).num().unwrap_or(1.0));
            if b == 0.0 {
                V::Err("#DIV/0!".into())
            } else {
                V::Num(a - b * (a / b).floor())
            }
        }
        "PI" => V::Num(std::f64::consts::PI),
        "CONCATENATE" | "CONCAT" | "CONCATENER" => {
            let mut flat = Vec::new();
            for a in args {
                a.flatten(&mut flat);
            }
            V::Str(flat.iter().map(|v| v.text()).collect())
        }
        "LEN" | "NBCAR" => V::Num(arg(0).text().chars().count() as f64),
        "UPPER" | "MAJUSCULE" => V::Str(arg(0).text().to_uppercase()),
        "LOWER" | "MINUSCULE" => V::Str(arg(0).text().to_lowercase()),
        "TRIM" | "SUPPRESPACE" => V::Str(arg(0).text().split_whitespace().collect::<Vec<_>>().join(" ")),
        "LEFT" | "GAUCHE" => V::Str(arg(0).text().chars().take(arg(1).num().unwrap_or(1.0) as usize).collect()),
        "RIGHT" | "DROITE" => {
            let t: Vec<char> = arg(0).text().chars().collect();
            let n = (arg(1).num().unwrap_or(1.0) as usize).min(t.len());
            V::Str(t[t.len() - n..].iter().collect())
        }
        "MID" | "STXT" => {
            let t: Vec<char> = arg(0).text().chars().collect();
            let s = (arg(1).num().unwrap_or(1.0) as usize).saturating_sub(1).min(t.len());
            let n = arg(2).num().unwrap_or(0.0) as usize;
            V::Str(t[s..(s + n).min(t.len())].iter().collect())
        }
        "TODAY" | "AUJOURDHUI" | "NOW" | "MAINTENANT" => {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let days = secs / 86400.0 + 25569.0;
            V::Num(if name.starts_with("TODAY") || name.starts_with("AUJ") { days.floor() } else { days })
        }
        _ => V::Err("#NAME?".into()),
    }
}

impl V {
    fn clean(self) -> V {
        match self {
            V::Num(n) if !n.is_finite() => V::Num(0.0),
            v => v,
        }
    }
}

/// Évalue une formule (sans le « = » initial) dans le contexte d'une feuille.
pub fn eval(formula: &str, sheet: &str, vals: &Values) -> V {
    let f = formula.trim().trim_start_matches('=');
    let Some(t) = tokenize(f) else { return V::Err("#NAME?".into()) };
    let mut p = Parser { t, i: 0, vals, sheet: sheet.to_string(), depth: 0 };
    let v = p.expr();
    match v {
        V::List(l) => l.into_iter().next().unwrap_or(V::Empty),
        v => v,
    }
}

/// Résout une plage de cellules (syntaxe Excel « 'Feuille'!$A$1:$A$5 » ou
/// ODF « Feuille.A1:Feuille.A5 ») en liste de (nombre, texte).
pub fn resolve_range(vals: &Values, range: &str, default_sheet: &str) -> Option<Vec<(Option<f64>, String)>> {
    let r = range.trim().trim_start_matches('(').trim_end_matches(')').trim_start_matches('$');
    // plusieurs zones séparées par des virgules : on concatène
    if r.contains(',') && !r.starts_with('\'') {
        let mut out = Vec::new();
        for part in r.split(',') {
            out.extend(resolve_range(vals, part, default_sheet)?);
        }
        return Some(out);
    }
    let (sheet, cells) = if let Some((s, c)) = r.rsplit_once('!') {
        (s.trim_matches('\'').to_string(), c.to_string())
    } else if r.contains('.') {
        // ODF : Feuille.A1:Feuille.A5 ou 'Feuille 1'.$A$1:.$A$5
        let (a, b) = r.split_once(':').unwrap_or((r, ""));
        let (s, ca) = a.rsplit_once('.')?;
        let cb = b.rsplit_once('.').map(|x| x.1).unwrap_or(b);
        let c = if cb.is_empty() { ca.to_string() } else { format!("{ca}:{cb}") };
        (s.trim_start_matches('$').trim_matches('\'').to_string(), c)
    } else {
        (default_sheet.to_string(), r.to_string())
    };
    let cells = cells.replace('$', "");
    let map = vals.get(&sheet.to_lowercase())?;
    let (a, b) = cells.split_once(':').unwrap_or((&cells, &cells));
    let (r1, c1) = crate::ooxml::xlsx::parse_ref(a)?;
    let (r2, c2) = crate::ooxml::xlsx::parse_ref(b)?;
    let mut out = Vec::new();
    for rr in r1.min(r2)..=r1.max(r2).min(r1.min(r2) + 10_000) {
        for cc in c1.min(c2)..=c1.max(c2).min(c1.min(c2) + 500) {
            let v = map.get(&(rr, cc)).cloned().unwrap_or(V::Empty);
            let n = match &v {
                V::Num(n) => Some(*n),
                _ => None,
            };
            out.push((n, v.text()));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formules() {
        crate::numfmt::set_english_locale(false);
        let mut vals: Values = HashMap::new();
        let mut m = HashMap::new();
        m.insert((0, 0), V::Num(2.0));
        m.insert((1, 0), V::Num(3.0));
        m.insert((2, 0), V::Str("x".into()));
        vals.insert("ventes".into(), m);
        assert_eq!(eval("=SUM(A1:A3)*2", "Ventes", &vals), V::Num(10.0));
        assert_eq!(eval("=A1*A2+1", "Ventes", &vals), V::Num(7.0));
        assert_eq!(eval("=IF(A1>1,\"oui\",\"non\")", "Ventes", &vals), V::Str("oui".into()));
        assert_eq!(eval("='Ventes'!A2^2", "Autre", &vals), V::Num(9.0));
        assert_eq!(eval("=ROUND(2.345,2)", "Ventes", &vals), V::Num(2.35));
        assert_eq!(eval("=A1&\"-\"&A3", "Ventes", &vals), V::Str("2-x".into()));
        assert_eq!(resolve_range(&vals, "'Ventes'!$A$1:$A$2", "x").map(|v| v.len()), Some(2));
        assert_eq!(resolve_range(&vals, "Ventes.A1:Ventes.A2", "x").map(|v| v[1].0), Some(Some(3.0)));
    }
}
