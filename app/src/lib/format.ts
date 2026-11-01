/** Mise en forme en français : dates de repas, quantités, durées. */

import type { IsoDate } from "../modules/planning";

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const FULL_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/**
 * Jour écrit en entier (« Samedi 1er novembre ») ; « Aujourd'hui » et « Demain » quand la date du jour est donnée.
 */
export function dayLabel(date: IsoDate, today?: IsoDate): string {
  const d = new Date(`${date}T12:00:00`);
  if (today && date === today) return "Aujourd'hui";
  if (today) {
    const t = new Date(`${today}T12:00:00`);
    t.setDate(t.getDate() + 1);
    if (t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth() && t.getDate() === d.getDate()) return "Demain";
  }
  const label = `${DAYS[d.getDay()]} ${d.getDate() === 1 ? "1er" : d.getDate()} ${FULL_MONTHS[d.getMonth()]}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export const PROTEIN_LABEL: Record<string, string> = {
  volaille: "Volaille", boeuf: "Bœuf", porc: "Porc", poisson: "Poisson", fruits_de_mer: "Fruits de mer", oeuf: "Œufs",
  legumineuse: "Légumineuses", vegetarien: "Végétarien",
};

/**
 * Protéine affichée sur les fiches et les cartes ; les plats végétariens ne sont pas signalés (chaîne vide). Le veau est
 * classé avec le bœuf pour l'équilibre de la semaine (viande de boucherie) mais s'affiche « Veau ».
 */
export const proteinLabel = (protein: string, name = "") =>
  protein === "vegetarien" ? "" : protein === "boeuf" && /\bveau\b/i.test(name) ? "Veau" : PROTEIN_LABEL[protein] ?? "";

export const mealLabel = (mealType: string) => (mealType === "dejeuner" ? "Déjeuner" : "Dîner");

export function minutes(total: number | null): string {
  if (total === null) return "Sans limite";
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", piece: "", cs: "c. à s.", cc: "c. à c.", pincee: "pincée" };

export function quantity(q: number | null, unit: string | null): string {
  if (q === null) return "";
  let value = q;
  let u = unit ?? "";
  if (u === "g" && q >= 1000) {
    value = q / 1000;
    u = "kg";
  } else if (u === "ml" && q >= 1000) {
    value = q / 1000;
    u = "l";
  }
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 1 : 0).replace(".", ",");
  const label = u === "kg" || u === "l" ? u : UNIT_LABEL[u] ?? u;
  if (u === "pincee" && value > 1) return `${shown} pincées`;
  return label ? `${shown} ${label}` : shown;
}

export function dateTime(iso: string | null): string {
  if (!iso) return "jamais";
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} à ${d.getHours()}h${String(d.getMinutes()).padStart(2, "0")}`;
}
