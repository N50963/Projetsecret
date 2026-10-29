/**
 * Décodage des entités HTML, au comportement aligné sur `html.unescape` de Python (une seule passe).
 * Le libellé d'un produit sert de clé en base : le décodage doit donner exactement le même texte
 * que le parseur Python utilisé pour l'import initial (vérifié par test/parity.test.ts).
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", oelig: "œ",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", OElig: "Œ",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý",
  euro: "€", deg: "°", reg: "®", copy: "©", trade: "™", laquo: "«", raquo: "»", middot: "·", times: "×",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", frac12: "½",
  frac14: "¼", frac34: "¾", sup2: "²", micro: "µ", sect: "§", para: "¶", iexcl: "¡", iquest: "¿", cent: "¢",
  pound: "£", yen: "¥", shy: "­",
};

// Entités historiquement acceptées sans point-virgule (comme Python : ISO-8859-1 + amp/lt/gt/quot).
const LEGACY_NO_SEMICOLON = new Set([
  "amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "deg", "laquo", "raquo", "middot", "times", "micro", "sect",
  "para", "iexcl", "iquest", "cent", "pound", "yen", "shy", "frac12", "frac14", "frac34", "sup2", "szlig",
  ...Object.keys(NAMED).filter((k) => /^[A-Za-z]+(grave|acute|circ|tilde|uml|ring|cedil|lig|slash)$/.test(k) && k !== "oelig" && k !== "OElig"),
]);

// Python remplace les références numériques 0x80-0x9F par les caractères Windows-1252 correspondants.
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

const ENTITY = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

function numeric(code: number): string {
  if (code in CP1252) return CP1252[code] as string;
  if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "�";
  if (code === 0x00) return "�";
  if (code === 0x0d) return "\r";
  return String.fromCodePoint(code);
}

export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith("#")) {
      const digits = body.replace(/;$/, "");
      const code = digits[1] === "x" || digits[1] === "X" ? parseInt(digits.slice(2), 16) : parseInt(digits.slice(1), 10);
      return numeric(code);
    }
    if (body.endsWith(";")) {
      const name = body.slice(0, -1);
      if (name in NAMED) return NAMED[name] as string;
    }
    // Sans point-virgule : le plus long préfixe reconnu parmi les entités historiques (règle HTML5 / Python).
    for (let i = Math.min(body.length, 32); i > 1; i--) {
      const name = body.slice(0, i);
      if (LEGACY_NO_SEMICOLON.has(name) && name in NAMED) return (NAMED[name] as string) + body.slice(i);
    }
    return whole;
  });
}
