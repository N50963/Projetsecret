/**
 * Lecture des étapes d'une recette : durées à minuter et passages à mettre en évidence (durées, températures, feu).
 * Les étapes sont rédigées avec des durées explicites (« 5 min », « 8 à 10 min », « 2 h », « 30 secondes »).
 */

export interface StepTimer {
  /** Durée telle qu'affichée sur le bouton (« 8 min », « 1 h 30 »). */
  label: string;
  seconds: number;
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

/** Les rappels réguliers (« remuer toutes les 10 min ») ne sont pas des durées de cuisson. */
const isReminder = (text: string, index: number) => /toutes les\s*$/.test(text.slice(Math.max(0, index - 12), index));

const minutesLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m / 60} h`);

/** Minuteurs d'une étape, sans doublon ; pour une plage (« 8 à 10 min »), la durée la plus courte, pour vérifier la cuisson. */
export function stepTimers(text: string): StepTimer[] {
  const found: StepTimer[] = [];
  for (const m of text.matchAll(new RegExp(DURATION, "gi"))) {
    if (isReminder(text, m.index ?? 0)) continue;
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
    if (seconds > 0 && seconds <= 6 * 3600 && !found.some((t) => t.seconds === seconds)) found.push({ label, seconds });
  }
  return found;
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
