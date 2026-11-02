// Génère src/lib/bundled.ts : photos des plats (assets/plats, version = date de l'image en ligne) et vignettes des
// ingrédients sur fond blanc (assets/ingredients) embarquées dans l'application, pour un affichage instantané.
// Images en WebP (python scripts/images-webp.py convertit un JPEG ajouté).
// Usage : python scripts/miniatures-plats.py, puis node scripts/photos-embarquees.mjs (après avoir mis à jour les images).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${root}assets/plats/manifest.json`, "utf8"));
const minis = new Set(readdirSync(`${root}assets/plats-mini`));
const dishes = Object.keys(manifest).sort().map((id) => {
  if (!minis.has(`${id}.webp`)) throw new Error(`Miniature absente : lancer scripts/miniatures-plats.py (${id})`);
  return `  "${id}": { asset: require("../../assets/plats/${id}.webp"), mini: require("../../assets/plats-mini/${id}.webp"), version: "${manifest[id]}" },`;
});
const ingredients = readdirSync(`${root}assets/ingredients`).filter((f) => f.endsWith(".webp")).sort()
  .map((f) => `  ${f.slice(0, -5)}: require("../../assets/ingredients/${f}"),`);
writeFileSync(`${root}src/lib/bundled.ts`, `/* eslint-disable */
// Généré par scripts/photos-embarquees.mjs : ne pas modifier à la main.
/**
 * Photos des plats embarquées dans l'application (640 px, et miniature de 240 px pour les petits affichages) ;
 * version : date de l'image en ligne au moment de l'embarquement.
 */
export const BUNDLED_DISHES: Record<string, { asset: number; mini: number; version: string }> = {
${dishes.join("\n")}
};

/** Vignettes des ingrédients sur fond blanc (détourées, ou photo telle quelle pour les graines et poudres). */
export const BUNDLED_INGREDIENTS: Record<string, number> = {
${ingredients.join("\n")}
};
`);
console.log(`${dishes.length} plats, ${ingredients.length} ingrédients`);
