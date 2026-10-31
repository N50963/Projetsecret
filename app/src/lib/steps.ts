/**
 * Lecture des étapes d'une recette : durées à minuter et passages à mettre en évidence (durées, températures, feu).
 * Les étapes sont rédigées avec des durées explicites (« 5 min », « 8 à 10 min », « 2 h », « 30 secondes »).
 */

export interface StepTimer {
  /** Durée telle qu'affichée sur le bouton (« 8 min », « 1 h 30 »). */
  label: string;
  seconds: number;
  /** Ce que l'on minute, pour s'y retrouver quand plusieurs minuteurs tournent (« Cuire le riz », « Dorer les escalopes »). */
  subject: string;
}

export interface Segment {
  text: string;
  strong: boolean;
}

const WORD_END = "(?![a-zA-ZÀ-ÿ])";
// Ordre important : plage avant minute simple, heures avec minutes avant heures seules.
const DURATION = `(\\d+)\\s*à\\s*(\\d+)\\s*min(?:utes?)?${WORD_END}`
  + `|(\\d+)\\s*h(?:eures?)?\\s*(\\d{1,2})${WORD_END}(?!\\s*(?:°|cm|cl|g${WORD_END}))`
  + `|(\\d+)\\s*h(?:eures?)?${WORD_END}`
  + `|(\\d+)\\s*min(?:utes?)?${WORD_END}`
  + `|(\\d+)\\s*secondes?${WORD_END}`;
const TEMPERATURE = "\\d{2,3}\\s*°\\s*C";
const HEAT = "feu (?:très )?(?:doux|moyen-vif|moyen|vif)|position gril";

/**
 * Durées qui ne se minutent pas : rappels réguliers (« remuer toutes les 10 min ») et repères (« ajouter le maïs 5 min avant la fin »).
 */
const isReminder = (text: string, index: number, length: number) =>
  /toutes les\s*$/.test(text.slice(Math.max(0, index - 12), index)) || /^\s*avant\b/.test(text.slice(index + length, index + length + 8));

const minutesLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m / 60} h`);

interface Found {
  label: string;
  seconds: number;
  index: number;
}

function durations(text: string): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(new RegExp(DURATION, "gi"))) {
    const index = m.index ?? 0;
    if (isReminder(text, index, m[0].length)) continue;
    const n = (i: number) => Number(m[i]);
    let seconds: number;
    let label: string;
    if (m[1]) {
      seconds = n(1) * 60;
      label = `${n(1)} min`;
    } else if (m[3]) {
      seconds = (n(3) * 60 + n(4)) * 60;
      label = minutesLabel(n(3) * 60 + n(4));
    } else if (m[5]) {
      seconds = n(5) * 3600;
      label = `${n(5)} h`;
    } else if (m[6]) {
      seconds = n(6) * 60;
      label = minutesLabel(n(6));
    } else {
      seconds = n(7);
      label = `${n(7)} s`;
    }
    if (seconds > 0 && seconds <= 6 * 3600) found.push({ label, seconds, index });
  }
  return found;
}

const SUBJECT_MAX = 46;
const LETTER = "a-zà-ÿœæ";
const INFINITIVE = `[${LETTER}]*(?:[^i\\s]er|ir|uire|ttre|aire|[eo]ndre|oudre|aindre|eindre)`;
const CONNECTORS = /^(?:puis|et|ensuite|enfin|pendant ce temps|pendant la cuisson|dans le même temps|y)(?![a-zà-ÿ])\s*,?\s*/i;
/** Fin de proposition sans contenu (« … pendant 18 min », « … encore 5 min »). */
const TRAILING = /\s*(?:pendant|durant|environ|encore|pour)$/i;
/** Proposition qui n'est pas une action (« sans remuer », « en le retournant », « jusqu'à… »). */
const NOT_AN_ACTION = /^(?:en|sans|avec|jusqu|pour|à|au|dans|sur|si)(?![a-zà-ÿ])/i;
/** Pronom complément suivi d'un infinitif (« les cuire », « le saisir », « la faire dorer », « l'égoutter »). */
const PRONOUN_VERB = new RegExp(`^(?:(les|le|la)\\s+|(l['’]))(${INFINITIVE})(?![${LETTER}'’])`, "i");
const STARTS_WITH_ARTICLE = /^(?:les|le|la|des|du)\s|^l['’]/i;
const WORD = `[${LETTER}-]+(?![${LETTER}'’-])`;
const NOT_A_NOUN = `(?:à|au|aux|dans|de|du|des|en|et|avec|sur|sans|pour|jusqu|puis|ou|le|la|les|un|une)(?![${LETTER}'’])`;
/** Groupe nominal défini : article puis un à trois mots (« le riz basmati », « les pommes de terre »). */
const NOUN_PHRASE = new RegExp(`(^|[\\s(])(les|le|la|l['’]|des|du)\\s*((?:pommes de terre|${WORD})(?:\\s+(?!${NOT_A_NOUN})${WORD}){0,2})`, "gi");
const PREPOSITION = /\s(?:à|au|aux|dans|avec|sur|sans|pour|en|jusqu)(?![a-zà-ÿ])|\set\sd(?:e\s|['’])/i;
const ARTICLE = /(?:^|\s)(?:(?:le|la|les|du|des|un|une)\s|l['’])/i;

/** Texte sans mise en forme Markdown (« **5 min** ») que Mistral ajoute parfois. */
export const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s{2,}/g, " ").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function shorten(s: string): string {
  if (s.length <= SUBJECT_MAX) return s;
  const cut = s.slice(0, SUBJECT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 20 ? space : SUBJECT_MAX).replace(/[\s,;:]+$/, "")}…`;
}

/** Retire les compléments de lieu ou de manière quand l'action a déjà son ingrédient (« Dorer le poulet dans une cocotte » → « Dorer le poulet »). */
function trimComplements(action: string): string {
  const m = PREPOSITION.exec(action);
  if (!m) return action;
  const head = action.slice(0, m.index);
  // Il faut un ingrédient avant le complément (« Dorer le poulet », « Cuire 400 g de pâtes ») : pas « Remettre au four ».
  return words(head) >= 2 && (ARTICLE.test(head) || /\d|\sd(?:e|u|es)?(?:\s|['’])/i.test(head)) ? head : action;
}

/**
 * Groupe nominal auquel renvoie un pronom : le dernier complément d'objet défini qui précède, accordé en nombre et en genre
 * de préférence. Ne compte pas les compléments introduits par une préposition (« sur des plaques », « avec l'huile »).
 */
function antecedent(before: string, pronoun: string): string | null {
  const p = pronoun.toLowerCase().replace("’", "'");
  const accepts = (a: string) => (p === "les" ? a === "les" || a === "des"
    : p === "le" ? a === "le" || a === "du" || a === "l'"
      : p === "la" ? a === "la" || a === "l'" : a !== "les" && a !== "des");
  let best: string | null = null;
  let any: string | null = null;
  for (const m of before.matchAll(NOUN_PHRASE)) {
    const [, lead = "", art = "", words3 = ""] = m;
    const preceding = before.slice(0, (m.index ?? 0) + lead.length).trimEnd();
    const a = art.toLowerCase().replace("’", "'");
    // Début de proposition (« Les cuire »), gérondif (« en le retournant »), préposition (« sur des plaques »).
    if (!preceding || /[.,;:(]$/.test(preceding)) continue;
    if (/(?:^|\s)(?:en|à|au|aux|dans|avec|sur|sous|sans|pour|par|de|d['’]|vers|entre)$/i.test(preceding)) continue;
    // Pronom devant un verbe (« bien les laver »).
    if (!["des", "du"].includes(a) && new RegExp(`^${INFINITIVE}$`, "i").test(words3.split(/\s+/)[0] ?? "")) continue;
    const article = a === "des" ? "les" : a === "du" ? "le" : a;
    const noun = `${article}${article === "l'" ? "" : " "}${words3}`;
    any = noun;
    if (accepts(a)) best = noun;
  }
  // Sans accord possible (« le brocoli en fleurettes… les cuire »), le dernier complément.
  return best ?? any;
}

/** « les cuire entières » → « cuire les endives entières » ; « la faire dorer » → « faire dorer la viande ». */
function resolvePronoun(action: string, before: string): string {
  const m = PRONOUN_VERB.exec(action);
  if (!m) return action;
  const [all, pronoun = m[2] ?? "", , infinitive = ""] = m;
  const noun = antecedent(before, pronoun);
  const rest = action.slice(all.length).trim().split(/\s+/).filter(Boolean);
  const verb = [infinitive, ...(/^(?:faire|laisser)$/i.test(infinitive) && rest.length ? [rest.shift()!] : [])];
  return [...verb, ...(noun ? [noun] : []), ...rest].join(" ");
}

/** L'ingrédient d'une action (« Ajouter le brocoli » → « le brocoli »), ou null si elle n'en a pas (« Porter à ébullition »). */
function objectOf(action: string): string | null {
  const w = action.split(/\s+/);
  const rest = w.slice(/^(?:faire|laisser)$/i.test(w[0] ?? "") ? 2 : 1).join(" ");
  const m = PREPOSITION.exec(` ${rest}`);
  const object = (m ? ` ${rest}`.slice(0, m.index) : rest).trim();
  return object && !/\d/.test(object) && !NOT_AN_ACTION.test(object) && !/^d(?:e|u|es)?(?:\s|['’])/i.test(object) ? object : null;
}

/** Ce que concerne une durée : l'action qui la précède dans sa proposition, avec son ingrédient. */
function subjectAt(text: string, index: number, context: string): string {
  const before = text.slice(0, index).trimEnd();
  const resolve = (s: string) => {
    const at = before.lastIndexOf(s);
    return resolvePronoun(s, `${context} ${before.slice(0, at < 0 ? before.length : at)}`);
  };
  const sentence = before.slice(before.search(/[^.]*$/));
  const clauses = sentence.split(/[,;:()]/).map((c) => c.trim().replace(CONNECTORS, "").replace(TRAILING, "").trim());
  // Une énumération coupée par des virgules (« Faire revenir l'oignon, l'ail et le gingembre ») forme une seule action.
  const take = () => {
    let clause = clauses.pop() ?? "";
    while (STARTS_WITH_ARTICLE.test(clause) && !PRONOUN_VERB.test(clause) && clauses.length && !/\d/.test(clauses[clauses.length - 1] ?? "")) {
      clause = `${clauses.pop()}, ${clause}`;
    }
    return clause;
  };
  let clause = take();
  // « …, sans remuer, 4 à 5 min », « …, 2 min de chaque côté » : l'action est dans une proposition précédente.
  while ((!clause || NOT_AN_ACTION.test(clause)) && clauses.length) clause = take();

  const parts = clause.split(/\s+(?:et|puis)\s+/i);
  const last = (parts.pop() ?? "").replace(CONNECTORS, "").trim();
  let action: string;
  if (parts.length && words(last) === 1) {
    // Un verbe seul après « et » : « Couvrir et cuire », « Ajouter le poisson et cuire ».
    action = `${trimComplements(resolve(parts.join(" et ")))} et ${last}`;
  } else if (parts.length && STARTS_WITH_ARTICLE.test(last) && !PRONOUN_VERB.test(last)) {
    // Des ingrédients coordonnés : « Faire revenir l'oignon et le poivron ».
    action = trimComplements(resolve(clause));
  } else if (words(last) === 1 && clauses.length) {
    // Verbe seul après une virgule : « Ajouter le brocoli, mélanger 1 min » → « Mélanger le brocoli ».
    const previous = take();
    const object = objectOf(resolve(previous));
    action = object ? `${last} ${object}` : words(previous) <= 4 && !/\d/.test(previous) ? `${previous}, ${last}` : last;
  } else {
    action = trimComplements(resolve(last));
  }
  return shorten(capitalize(action.trim()));
}

/**
 * Le minuteur d'une étape (un seul par étape) : la durée la plus longue, celle de la cuisson principale ; pour une plage
 * (« 8 à 10 min »), la durée la plus courte, pour vérifier la cuisson. Null si l'étape n'a rien à minuter.
 * Le sujet (l'action et son ingrédient) distingue les minuteurs quand plusieurs tournent en même temps.
 */
export function stepTimer(step: string, previousSteps: readonly string[] = []): StepTimer | null {
  // Le sujet se lit sans la mise en forme ni les précisions entre parenthèses (« 2 cuillères d'huile (30 ml) »), sauf celles
  // qui donnent la durée (« Cuire les pâtes (10 min) »).
  const text = plain(step).replace(/\s*\(([^)]*)\)/g, (all, inside: string) => (new RegExp(DURATION, "i").test(inside) ? all : ""));
  const found = durations(text);
  if (!found.length) return null;
  const main = found.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  // Les étapes précédentes servent à retrouver l'ingrédient d'un pronom (« Le poser dans un plat et le cuire 20 min »).
  return { label: main.label, seconds: main.seconds, subject: subjectAt(text, main.index, plain(previousSteps.slice(-2).join(" "))) };
}

/** Découpe une étape en passages normaux et passages mis en évidence (durées, températures, intensité du feu). */
export function stepSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(`${DURATION}|${TEMPERATURE}|${HEAT}`, "gi"))) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), strong: false });
    out.push({ text: m[0], strong: true });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), strong: false });
  return out;
}

/** Temps restant au format minutes:secondes (ou h:mm:ss). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
