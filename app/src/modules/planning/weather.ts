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

/** Plats d'hiver par excellence : soupes, fromage fondu, grands mijotés. */
const WINTER = new RegExp([
  "soupe", "velout[ée]", "minestrone", "potage", "raclette", "tartiflette", "fondue", "pot-au-feu", "bourguignon",
  "b(œ|oe)uf carottes", "blanquette", "marengo", "daube", "navarin", "cassoulet", "choucroute", "pot[ée]e", "aligot",
].join("|"), "i");

/**
 * Temps pour lequel proposer un plat : -2 temps froid, -1 plutôt froid, 0 tout temps, 1 plutôt chaud, 2 temps chaud.
 * Le foyer le choisit pour chaque recette (Profil › Recettes selon la météo) ; sans choix, il est déduit du nom du plat.
 */
export type WeatherLevel = -2 | -1 | 0 | 1 | 2;
export const WEATHER_LEVELS: Array<{ value: WeatherLevel; label: string }> = [
  { value: -2, label: "Temps froid" }, { value: -1, label: "Plutôt froid" }, { value: 0, label: "Tout temps" },
  { value: 1, label: "Plutôt chaud" }, { value: 2, label: "Temps chaud" },
];

/** Classement proposé d'après le nom : salades et crudités par temps chaud, soupes et mijotés par temps froid. */
export function autoLevel(r: { name: string }): WeatherLevel {
  const kind = dishKind(r);
  if (kind === "frais") return 2;
  if (kind === "reconfortant") return WINTER.test(r.name) ? -2 : -1;
  return isLight(r) ? 1 : 0;
}

/**
 * Cuisson longue (four ou mijotage d'une heure et quart ou plus) : à éviter les jours de forte chaleur. Le temps d'un plat
 * léger (brochettes) est surtout celui de la marinade : il ne compte pas.
 */
export const isLongCooking = (r: { name: string; totalMin: number }) => r.totalMin >= 75 && dishKind(r) !== "frais" && !isLight(r);

const degrees = (t: number) => `${Math.round(t)} °C`;

/** Bonus ou malus selon le classement du plat (de -2 à 2), pour chaque type de temps. */
const BONUS: Record<"hot" | "warm" | "cool" | "cold" | "rain", Record<WeatherLevel, number>> = {
  hot: { [-2]: -5, [-1]: -3, 0: 0, 1: 2, 2: 4 },
  warm: { [-2]: -1.5, [-1]: -1, 0: 0, 1: 1, 2: 1.5 },
  cool: { [-2]: 1.5, [-1]: 1, 0: 0, 1: -0.5, 2: -1 },
  cold: { [-2]: 3, [-1]: 2, 0: 0, 1: -1.5, 2: -3 },
  rain: { [-2]: 1.5, [-1]: 1, 0: 0, 1: 0, 2: -1 },
};

/**
 * Bonus ou malus d'un plat selon la météo du jour du repas et son classement (celui du foyer, sinon celui déduit du nom),
 * avec la raison à afficher quand la météo a pesé en sa faveur.
 */
export function weatherAdjustment(r: { name: string; totalMin: number }, day: DayWeather | undefined, chosen?: WeatherLevel | null): { delta: number; note?: string } {
  if (!day) return { delta: 0 };
  const level = chosen ?? autoLevel(r);
  const t = day.tMax;
  let delta = 0;
  let note: string | undefined;
  if (t >= WARM) {
    delta += BONUS[t >= HOT ? "hot" : "warm"][level];
    if (level >= 1) note = `${level === 2 ? "Plat frais" : "Plat léger"} : ${degrees(t)} prévus`;
    if (t >= HOT && level <= 0 && isLongCooking(r)) delta -= 2;
  } else if (t <= COOL) {
    delta += BONUS[t <= COLD ? "cold" : "cool"][level];
    if (level <= -1) note = `${level === -2 && t <= COLD ? "Plat chaud et réconfortant" : "Plat réconfortant"} : ${degrees(t)} au plus`;
  }
  if (day.rainMm >= RAINY_MM && t < HOT) {
    delta += BONUS.rain[level];
    if (level <= -1) note = note ? `${note}, pluie` : "Plat réconfortant : pluie prévue";
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
