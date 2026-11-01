// Génère src/lib/bundled.ts : photos des plats (assets/plats, version = date de l'image en ligne) et vignettes des
// ingrédients sur fond blanc (assets/ingredients) embarquées dans l'application, pour un affichage instantané.
// Usage : node scripts/photos-embarquees.mjs (après avoir mis à jour les images des deux dossiers).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${root}assets/plats/manifest.json`, "utf8"));
const dishes = Object.keys(manifest).sort()
  .map((id) => `  "${id}": { asset: require("../../assets/plats/${id}.jpg"), version: "${manifest[id]}" },`);
const ingredients = readdirSync(`${root}assets/ingredients`).filter((f) => f.endsWith(".jpg")).sort()
  .map((f) => `  ${f.slice(0, -4)}: require("../../assets/ingredients/${f}"),`);
writeFileSync(`${root}src/lib/bundled.ts`, `/* eslint-disable */
// Généré par scripts/photos-embarquees.mjs : ne pas modifier à la main.
/** Photos des plats embarquées dans l'application ; version : date de l'image en ligne au moment de l'embarquement. */
export const BUNDLED_DISHES: Record<string, { asset: number; version: string }> = {
${dishes.join("\n")}
};

/** Vignettes des ingrédients sur fond blanc (détourées, ou photo telle quelle pour les graines et poudres). */
export const BUNDLED_INGREDIENTS: Record<string, number> = {
${ingredients.join("\n")}
};
`);
console.log(`${dishes.length} plats, ${ingredients.length} ingrédients`);
