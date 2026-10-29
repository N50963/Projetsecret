/** Mise en forme en français : dates de repas, quantités, durées. */

import type { IsoDate } from "../modules/planning";

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export function dayLabel(date: IsoDate, today?: IsoDate): string {
  const d = new Date(`${date}T12:00:00`);
  if (today && date === today) return "Aujourd'hui";
  const label = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export const PROTEIN_LABEL: Record<string, string> = {
  volaille: "Volaille", boeuf: "Bœuf", porc: "Porc", poisson: "Poisson", fruits_de_mer: "Fruits de mer", oeuf: "Œufs",
  legumineuse: "Légumineuses", vegetarien: "Végétarien",
};

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
