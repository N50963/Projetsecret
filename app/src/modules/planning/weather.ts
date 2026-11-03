/**
 * Météo et choix des menus (Rochefort-du-Gard) : un plat frais quand il fait chaud, un plat chaud et réconfortant quand
 * il fait froid ou qu'il pleut. Fonctions pures, sans réseau : la prévision est lue par `src/lib/weather.ts`.
 *
 * Repères (température maximale du jour du repas) :
 * - chaud : 28 °C et plus ; doux-chaud : 24 à 27 °C ;
 * - frais : 11 à 15 °C ; froid : 10 °C et moins ;
 * - pluie : 3 mm et plus dans la journée.
 */

import type { IsoDate } from "./types";

/** Prévision d'un jour. */
export interface DayWeather {
  date: IsoDate;
  /** Températures minimale et maximale (°C). */
  tMin: number;
  tMax: number;
  /** Pluie du jour (mm). */
  rainMm: number;
  /** Code temps présent de l'OMM (0 : ciel clair… 95 : orage). */
  code: number;
}

export const HOT = 28;
export const WARM = 24;
export const COOL = 15;
export const COLD = 10;
export const RAINY_MM = 3;

/** Nature d'un plat pour la météo. */
export type DishKind = "frais" | "reconfortant" | "neutre";

const FRESH = /^(salade|taboul|wraps?\b|carottes r[aâ]p[ée]es|bo bun|gaspacho|poke|ceviche|carpaccio|tomates? mozzarella|pan bagnat)/i;
const LIGHT = /\b(grill[ée]s?|brochettes|papillote|plancha)\b/i;
const COMFORT = new RegExp([
  "soupe", "velout[ée]", "minestrone", "potage", "gratin", "raclette", "tartiflette", "fondue", "pot-au-feu", "bourguignon",
  "blanquette", "b(œ|oe)uf carottes", "mijot", "daube", "navarin", "cassoulet", "choucroute", "pot[ée]e", "parmentier", "chili",
  "dahl", "lasagnes", "moussaka", "risotto", "brandade", "endives au jambon", "marengo", "pur[ée]e", "aux lentilles", "aligot",
].join("|"), "i");

/** Plat frais (salades, crudités, plats froids), réconfortant (soupes, gratins, mijotés, fromage fondu) ou neutre. */
export function dishKind(r: { name: string }): DishKind {
  if (FRESH.test(r.name)) return "frais";
  if (COMFORT.test(r.name)) return "reconfortant";
  return "neutre";
}

/** Plat léger d'été (grillades, papillotes) : bienvenu quand il fait chaud, sans être un plat froid. */
export const isLight = (r: { name: string }) => LIGHT.test(r.name);

/**
 * Cuisson longue (four ou mijotage d'une heure et quart ou plus) : à éviter les jours de forte chaleur. Le temps d'un plat
 * léger (brochettes) est surtout celui de la marinade : il ne compte pas.
 */
export const isLongCooking = (r: { name: string; totalMin: number }) => r.totalMin >= 75 && dishKind(r) !== "frais" && !isLight(r);

const degrees = (t: number) => `${Math.round(t)} °C`;

/**
 * Bonus ou malus d'un plat selon la météo du jour du repas, avec la raison à afficher quand la météo a pesé en sa faveur.
 */
export function weatherAdjustment(r: { name: string; totalMin: number }, day: DayWeather | undefined): { delta: number; note?: string } {
  if (!day) return { delta: 0 };
  const kind = dishKind(r);
  const rainy = day.rainMm >= RAINY_MM;
  let delta = 0;
  let note: string | undefined;
  if (day.tMax >= HOT) {
    if (kind === "frais") {
      delta += 4;
      note = `Plat frais : ${degrees(day.tMax)} prévus`;
    } else if (isLight(r)) {
      delta += 2;
      note = `Plat léger : ${degrees(day.tMax)} prévus`;
    }
    if (kind === "reconfortant") delta -= 5;
    if (isLongCooking(r)) delta -= 2;
  } else if (day.tMax >= WARM) {
    if (kind === "frais") {
      delta += 1.5;
      note = `Plat frais : ${degrees(day.tMax)} prévus`;
    }
    if (kind === "reconfortant") delta -= 1.5;
  } else if (day.tMax <= COLD) {
    if (kind === "reconfortant") {
      delta += 3;
      note = `Plat chaud et réconfortant : ${degrees(day.tMax)} au plus`;
    }
    if (kind === "frais") delta -= 3;
  } else if (day.tMax <= COOL) {
    if (kind === "reconfortant") {
      delta += 1;
      note = `Plat réconfortant : ${degrees(day.tMax)} au plus`;
    }
    if (kind === "frais") delta -= 1;
  }
  if (rainy && day.tMax < HOT) {
    if (kind === "reconfortant") {
      delta += 1.5;
      note ??= "Plat réconfortant : pluie prévue";
      if (!note.includes("pluie")) note += ", pluie";
    }
    if (kind === "frais") delta -= 1;
  }
  return { delta, note };
}

/** Temps présent lisible et icône (codes de l'OMM utilisés par Open-Meteo). */
export type WeatherIcon = "sun" | "cloudSun" | "cloud" | "fog" | "rain" | "snow" | "storm";
export function weatherText(code: number): { label: string; icon: WeatherIcon } {
  if (code === 0) return { label: "ensoleillé", icon: "sun" };
  if (code <= 2) return { label: "éclaircies", icon: "cloudSun" };
  if (code === 3) return { label: "couvert", icon: "cloud" };
  if (code <= 48) return { label: "brouillard", icon: "fog" };
  if (code <= 57) return { label: "bruine", icon: "rain" };
  if (code <= 67) return { label: "pluie", icon: "rain" };
  if (code <= 77) return { label: "neige", icon: "snow" };
  if (code <= 82) return { label: "averses", icon: "rain" };
  if (code <= 86) return { label: "averses de neige", icon: "snow" };
  return { label: "orage", icon: "storm" };
}

/** Consigne pour les idées de Mistral (début du brief, limité à 600 caractères côté serveur). */
export function weatherBrief(day: DayWeather | undefined): string {
  if (!day) return "";
  const at = `Météo à Rochefort-du-Gard : ${degrees(day.tMax)} au plus, ${weatherText(day.code).label}`;
  if (day.tMax >= HOT) return `${at} : plat frais ou léger, sans four ni longue cuisson. `;
  if (day.tMax >= WARM) return `${at} : plutôt un plat frais ou léger. `;
  if (day.tMax <= COLD || (day.rainMm >= RAINY_MM && day.tMax <= COOL)) return `${at} : plat chaud et réconfortant. `;
  return "";
}
